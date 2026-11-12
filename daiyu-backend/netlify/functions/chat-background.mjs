// 林黛玉后端 · Netlify 后台函数
// 路由：/bg/chat   后台运行，最长 15 分钟，客户端立刻收到 202
import { neon } from '@neondatabase/serverless';
import {
  AFFINITY_INIT, clamp, computeDelta, classify, fetchWeather,
  buildSystemPrompt, chatOnce,
  normPersona, updatePersona, pickMemories, extractMemories,
  MEMORY_MAX, EXTRACT_EVERY
} from './shared/daiyu.mjs';

export const config = {
  path: '/bg/chat',
  background: true
};

const APP_API_KEY = process.env.APP_API_KEY || '';

// 存储上限：消息 id 跨度超过这个值，就自动淘汰最早的记录（0 = 不限制）
// 1,000,000 条约合 275 MB；Neon 免费版有 1 GB，留足余量
const MAX_MESSAGES  = Number(process.env.MAX_MESSAGES || 1000000);
// 每写 CLEANUP_EVERY 条才检查一次，避免每条都多跑一次数据库查询
const CLEANUP_EVERY = Number(process.env.CLEANUP_EVERY || 1000);

let _sql = null;
function db() {
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}

export default async (request) => {
  if (APP_API_KEY && request.headers.get('x-app-key') !== APP_API_KEY) {
    return new Response('unauthorized', { status: 401 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const userId = String(body.user_id || '');
    const model = body.model === 'deepseek-reasoner' ? 'deepseek-reasoner' : 'deepseek-chat';
    const geo = body.geo || null;
    const device = body.device || null;
    if (!userId) return new Response('bad request', { status: 400 });

    const sql = db();

    // ---------- 1. 读这个人的好感度、性格、抽取进度 ----------
    const u = await sql`SELECT affinity, praise_streak, persona, mem_extract_at FROM users WHERE id = ${userId}`;
    if (!u.length) return new Response('user_not_found', { status: 404 });
    const raw = u[0].affinity;
    const affinity = clamp(raw === null || raw === undefined ? AFFINITY_INIT : raw);
    const streak = Number(u[0].praise_streak) || 0;
    const persona = normPersona(u[0].persona);
    const lastExtract = Number(u[0].mem_extract_at) || 0;

    // ---------- 2. 取最近历史（用户刚说的那句已经存进去了）----------
    const hist = await sql`SELECT role, content FROM messages
      WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 20`;
    const history = hist.slice().reverse().map(r => ({ role: r.role, content: r.content }));
    const lastUser = [...history].reverse().find(m => m.role === 'user');

    // ---------- 3. 取当地天气（拿不到就不提天气）----------
    const weather = await fetchWeather(geo && geo.lat, geo && geo.lon);

    // ---------- 3.5 取记忆（每个账号一份，最多 200 条）----------
    let memRows = [];
    try {
      memRows = await sql`SELECT id, kind, content, weight, created_at FROM memories
        WHERE user_id = ${userId} ORDER BY weight DESC, created_at DESC LIMIT 200`;
    } catch (e) {
      console.log('[记忆] 读取失败（表可能还没建好）：' + ((e && e.message) || e));
    }
    const picked = pickMemories(memRows, lastUser ? lastUser.content : '', 30, 5);

    // ---------- 4. 并发：生成黛玉的话 + 判定这句话的情绪 ----------
    const [reply, senti] = await Promise.all([
      chatOnce({
        model,
        messages: [{
          role: 'system',
          content: buildSystemPrompt({ affinity, weather, device, memories: picked, persona })
        }, ...history],
        maxTokens: 500
      }),
      classify(lastUser ? lastUser.content : '', process.env.DEEPSEEK_API_KEY || '')
    ]);

    // ---------- 5. 结算好感度（锁死 0~100，重复夸奖收益递减）----------
    const { delta, nextStreak } = computeDelta(senti.level, senti.intensity, streak);
    const newAffinity = clamp(affinity + delta);

    // ---------- 5.5 结算性格（熟悉度只涨；温柔度/娇嗔度慢慢漂移）----------
    const totalMsgs = Number((await sql`SELECT COUNT(*)::int AS n FROM messages
      WHERE user_id = ${userId} AND role = 'user'`)[0].n) || 0;
    const newPersona = updatePersona(persona, {
      level: senti.level, playful: senti.playful, totalUserMsgs: totalMsgs
    });
    console.log(`[好感度] ${affinity} -> ${newAffinity}  (${senti.level}/${senti.intensity} 贫嘴=${senti.playful})`);
    console.log(`[性格] 熟悉${newPersona.familiarity} 温柔${newPersona.warmth} 娇嗔${newPersona.playfulness}`);

    // ---------- 6. 存回复 + 更新好感度与性格 ----------
    const ins = await sql`INSERT INTO messages(user_id, role, content, model)
      VALUES(${userId}, 'assistant', ${reply}, ${model}) RETURNING id`;
    await sql`UPDATE users SET affinity = ${newAffinity}, praise_streak = ${nextStreak},
      persona = ${JSON.stringify(newPersona)}::jsonb WHERE id = ${userId}`;

    // ---------- 6.5 攒够 20 条用户消息就抽一次记忆 ----------
    try {
      const fresh = await sql`SELECT role, content FROM messages
        WHERE user_id = ${userId} AND id > ${lastExtract} ORDER BY id ASC LIMIT 60`;
      const freshUser = fresh.filter(r => r.role === 'user').length;
      if (freshUser >= EXTRACT_EVERY) {
        const got = await extractMemories(fresh, process.env.DEEPSEEK_API_KEY || '');
        const newestId = Number(ins[0] && ins[0].id) || lastExtract;
        for (const m of got) {
          // 完全重复的不再存
          const dup = await sql`SELECT id FROM memories
            WHERE user_id = ${userId} AND content = ${m.content} LIMIT 1`;
          if (dup.length) continue;
          await sql`INSERT INTO memories(user_id, kind, content, weight)
            VALUES(${userId}, ${m.kind}, ${m.content}, ${m.weight})`;
        }
        await sql`UPDATE users SET mem_extract_at = ${newestId} WHERE id = ${userId}`;
        console.log(`[记忆] 抽取完成，新增 ${got.length} 条（本次看了 ${freshUser} 条用户消息）`);

        // 超过 200 条就淘汰：先淘汰权重最低的，同权重淘汰最旧的
        const cnt = Number((await sql`SELECT COUNT(*)::int AS n FROM memories
          WHERE user_id = ${userId}`)[0].n) || 0;
        if (cnt > MEMORY_MAX) {
          const del = await sql`DELETE FROM memories WHERE id IN (
            SELECT id FROM memories WHERE user_id = ${userId}
            ORDER BY weight ASC, created_at ASC LIMIT ${cnt - MEMORY_MAX}
          ) RETURNING id`;
          console.log(`[记忆] 超出上限，淘汰 ${del.length} 条`);
        }
      }
    } catch (e) {
      console.log('[记忆] 抽取失败（不影响回复）：' + ((e && e.message) || e));
    }

    // ---------- 7. 超过上限就淘汰最早的记录（环形缓冲）----------
    if (MAX_MESSAGES > 0 && CLEANUP_EVERY > 0) {
      const newId = Number(ins[0] && ins[0].id);
      if (newId && newId % CLEANUP_EVERY === 0) {
        const cutoff = newId - MAX_MESSAGES;
        if (cutoff > 0) {
          const del = await sql`DELETE FROM messages WHERE id <= ${cutoff} RETURNING id`;
          if (del && del.length) {
            console.log(`[清理] 已淘汰 ${del.length} 条最早记录（保留最近 ${MAX_MESSAGES} 条）`);
          }
        }
      }
    }

    return new Response(null, { status: 200 });
  } catch (e) {
    const cause = e && (e.cause || e.sourceError);
    const detail = cause ? (cause.code || cause.message || '') : '';
    return new Response(String((e && e.message) || e) + (detail ? ' | ' + detail : ''), { status: 500 });
  }
};
