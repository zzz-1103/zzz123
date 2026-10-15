// 林黛玉后端 · Netlify 后台函数
// 路由：/bg/chat   后台运行，最长 15 分钟，客户端立刻收到 202
import { neon } from '@neondatabase/serverless';
import {
  AFFINITY_INIT, clamp, computeDelta, classify, fetchWeather,
  buildSystemPrompt, chatOnce
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
    if (!userId) return new Response('bad request', { status: 400 });

    const sql = db();

    // ---------- 1. 读这个人的好感度 ----------
    const u = await sql`SELECT affinity, praise_streak FROM users WHERE id = ${userId}`;
    if (!u.length) return new Response('user_not_found', { status: 404 });
    const raw = u[0].affinity;
    const affinity = clamp(raw === null || raw === undefined ? AFFINITY_INIT : raw);
    const streak = Number(u[0].praise_streak) || 0;

    // ---------- 2. 取最近历史（用户刚说的那句已经存进去了）----------
    const hist = await sql`SELECT role, content FROM messages
      WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 20`;
    const history = hist.slice().reverse().map(r => ({ role: r.role, content: r.content }));
    const lastUser = [...history].reverse().find(m => m.role === 'user');

    // ---------- 3. 取当地天气（拿不到就不提天气）----------
    const weather = await fetchWeather(geo && geo.lat, geo && geo.lon);

    // ---------- 4. 并发：生成黛玉的话 + 判定这句话的情绪 ----------
    const [reply, senti] = await Promise.all([
      chatOnce({
        model,
        messages: [{ role: 'system', content: buildSystemPrompt({ affinity, weather }) }, ...history],
        maxTokens: 500
      }),
      classify(lastUser ? lastUser.content : '', process.env.DEEPSEEK_API_KEY || '')
    ]);

    // ---------- 5. 结算好感度（锁死 0~100，重复夸奖收益递减）----------
    const { delta, nextStreak } = computeDelta(senti.level, senti.intensity, streak);
    const newAffinity = clamp(affinity + delta);
    console.log(`[好感度] ${affinity} -> ${newAffinity}  (判定=${senti.level}/${senti.intensity} 增减=${delta > 0 ? '+' + delta : delta} 连夸=${streak}->${nextStreak})`);

    // ---------- 6. 存回复 + 更新好感度 ----------
    const ins = await sql`INSERT INTO messages(user_id, role, content, model)
      VALUES(${userId}, 'assistant', ${reply}, ${model}) RETURNING id`;
    await sql`UPDATE users SET affinity = ${newAffinity}, praise_streak = ${nextStreak} WHERE id = ${userId}`;

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
