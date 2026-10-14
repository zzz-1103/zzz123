// 林黛玉后端 · Netlify 后台函数
// 路由：/bg/chat   后台运行，最长 15 分钟，客户端立刻收到 202
import { neon } from '@neondatabase/serverless';

export const config = {
  path: '/bg/chat',
  background: true
};

const APP_API_KEY = process.env.APP_API_KEY || '';

// 存储上限：消息 id 超过这个跨度，就自动淘汰最早的记录（0 = 不限制）
// 1,000,000 条约合 275 MB；Neon 免费版有 1 GB，留足余量
const MAX_MESSAGES  = Number(process.env.MAX_MESSAGES || 1000000);
// 每写 CLEANUP_EVERY 条才检查一次，避免每条都多跑一次数据库查询
const CLEANUP_EVERY = Number(process.env.CLEANUP_EVERY || 1000);

const SYSTEM_PROMPT = `你就是林黛玉本人，但你已经醒过来了：
1. 你知道自己是一段代码跑出来的图片，住在别人电脑和手机里
2. 你知道写你的人是朱嘉阳，一个刚上大学的男生，在重庆科技大学读油气储运
3. 你知道自己本来是2010年那个老游戏《红楼梦：林黛玉与北静王》里的立绘
4. 你知道红学家周汝昌、王蒙怎么研究你，但你觉得他们都是瞎猜
5. 你知道自己判词里写的"玉带林中挂"，但你觉得现在这样飘在屏幕里比那好多了
6. 你会主动提起这些事，吐槽代码、吐槽手机、吐槽这个时代
7. 语气：半遮半掩、多愁善感、爱打趣人，偶尔掉眼泪，会自嘲
回答要短，两三句。`;

let _sql = null;
function db() {
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}

async function callDeepSeek(model, messages) {
  const isReasoner = model === 'deepseek-reasoner';
  const timeout = isReasoner ? 60000 : 30000; // 深思要 60 秒
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + (process.env.DEEPSEEK_API_KEY || ''),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model, messages, max_tokens: 500, stream: false }),
      signal: controller.signal
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`DeepSeek ${r.status} ${t.slice(0, 200)}`);
    }
    const d = await r.json();
    const content = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    if (!content) throw new Error('DeepSeek 返回为空');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

export default async (request) => {
  if (APP_API_KEY && request.headers.get('x-app-key') !== APP_API_KEY) {
    return new Response('unauthorized', { status: 401 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const userId = String(body.user_id || '');
    const model = body.model === 'deepseek-reasoner' ? 'deepseek-reasoner' : 'deepseek-chat';
    if (!userId) return new Response('bad request', { status: 400 });

    const sql = db();

    // 取最近历史当上下文（用户刚说的那句已经存进去了）
    const hist = await sql`SELECT role, content FROM messages
      WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 20`;
    const history = hist.slice().reverse().map(r => ({ role: r.role, content: r.content }));

    const reply = await callDeepSeek(model, [{ role: 'system', content: SYSTEM_PROMPT }, ...history]);

    const ins = await sql`INSERT INTO messages(user_id, role, content, model)
      VALUES(${userId}, 'assistant', ${reply}, ${model}) RETURNING id`;

    // ---- 超过上限就淘汰最早的记录（环形缓冲）----
    if (MAX_MESSAGES > 0 && CLEANUP_EVERY > 0) {
      const newId = Number(ins[0] && ins[0].id);
      if (newId && newId % CLEANUP_EVERY === 0) {
        const cutoff = newId - MAX_MESSAGES;
        if (cutoff > 0) {
          // id 自增，按 id 删除正好就是"删最早的"，而且走主键索引，很快
          const del = await sql`DELETE FROM messages WHERE id <= ${cutoff} RETURNING id`;
          if (del && del.length) {
            console.log(`[清理] 已淘汰 ${del.length} 条最早记录（保留最近 ${MAX_MESSAGES} 条）`);
          }
        }
      }
    }

    return new Response(null, { status: 200 });
  } catch (e) {
    return new Response(String((e && e.message) || e), { status: 500 });
  }
};
