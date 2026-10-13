// 林黛玉后端 · Netlify Function（主 API）
// 路由：显式列出，避免通配符写法不确定
import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';

export const config = {
  path: [
    '/api/health',
    '/api/login',
    '/api/chat',
    '/api/reply',
    '/api/admin/login',
    '/api/admin/users',
    '/api/admin/messages'
  ]
};

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_SECRET = process.env.ADMIN_SECRET || ADMIN_PASSWORD || 'daiyu-change-me';
const APP_API_KEY = process.env.APP_API_KEY || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'https://lindaiyu.netlify.app')
  .split(',').map(s => s.trim()).filter(Boolean);

// 允许的跨域来源：配置里列出的 + 任意 netlify.app 站点（前端站改名/预览部署也不怕）
function originAllowed(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.netlify\.app$/.test(origin)) return true;
  if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return true;
  if (/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return true;
  return false;
}

let _sql = null;
function db() {
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}

// 冷启动时确保表存在（同一实例内只跑一次）
let _schema = null;
function ensureSchema() {
  if (!_schema) {
    _schema = (async () => {
      const sql = db();
      await sql`CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        nickname TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS messages (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user','assistant')),
        content TEXT NOT NULL,
        model TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages(user_id, created_at)`;
    })().catch(e => { _schema = null; throw e; });
  }
  return _schema;
}

function makeHeaders(origin, extra) {
  const h = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
  if (originAllowed(origin)) {
    h.set('Access-Control-Allow-Origin', origin);
    h.set('Vary', 'Origin');
    h.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-App-Key');
    h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (extra) for (const k of Object.keys(extra)) h.set(k, extra[k]);
  return h;
}

function json(obj, status, origin, extra) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: makeHeaders(origin, extra) });
}

function hmac(v) { return crypto.createHmac('sha256', ADMIN_SECRET).update(v).digest('hex'); }

function issueAdminToken() {
  const exp = Date.now() + 1000 * 60 * 60 * 24 * 7; // 7 天
  const payload = `admin:${exp}`;
  return `${payload}.${hmac(payload)}`;
}

function checkAdminToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const [role, exp] = payload.split(':');
  if (role !== 'admin' || !exp) return false;
  if (Date.now() > Number(exp)) return false;
  return hmac(payload) === sig;
}

export default async (request, context) => {
  const origin = request.headers.get('origin') || '';
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: makeHeaders(origin) });
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '') || '/';

  const appKeyBad = () => APP_API_KEY && request.headers.get('x-app-key') !== APP_API_KEY;

  try {
    await ensureSchema();
    const sql = db();

    // ---- 健康检查 ----
    if (path === '/health') return json({ ok: true }, 200, origin);

    // ---- 昵称登录 ----
    if (path === '/login' && method === 'POST') {
      if (appKeyBad()) return json({ error: 'unauthorized' }, 401, origin);
      const body = await request.json().catch(() => ({}));
      const nickname = String(body.nickname || '').trim().slice(0, 30);
      if (!nickname) return json({ error: '昵称不能为空' }, 400, origin);
      const rows = await sql`INSERT INTO users(nickname) VALUES(${nickname}) RETURNING id, nickname`;
      return json({ user_id: rows[0].id, nickname: rows[0].nickname }, 200, origin);
    }

    // ---- 发消息：只存用户这句话，立刻返回 id ----
    if (path === '/chat' && method === 'POST') {
      if (appKeyBad()) return json({ error: 'unauthorized' }, 401, origin);
      const body = await request.json().catch(() => ({}));
      const userId = String(body.user_id || '');
      const message = String(body.message || '').trim().slice(0, 2000);
      const model = body.model === 'deepseek-reasoner' ? 'deepseek-reasoner' : 'deepseek-chat';
      if (!userId || !message) return json({ error: '缺少参数' }, 400, origin);

      const rows = await sql`INSERT INTO messages(user_id, role, content, model)
        VALUES(${userId}, 'user', ${message}, ${model}) RETURNING id`;

      // 交给后台函数去问 DeepSeek（后台函数可跑 15 分钟）
      const bgHeaders = { 'Content-Type': 'application/json' };
      if (APP_API_KEY) bgHeaders['X-App-Key'] = APP_API_KEY;
      const bgPromise = fetch(`${url.origin}/bg/chat`, {
        method: 'POST',
        headers: bgHeaders,
        body: JSON.stringify({ user_id: userId, model })
      }).catch(() => {});

      if (context && typeof context.waitUntil === 'function') {
        context.waitUntil(bgPromise);   // 不阻塞响应
      } else {
        await bgPromise;
      }

      return json({ ok: true, msg_id: rows[0].id }, 200, origin);
    }

    // ---- 轮询取回复 ----
    if (path === '/reply' && method === 'GET') {
      if (appKeyBad()) return json({ error: 'unauthorized' }, 401, origin);
      const userId = url.searchParams.get('user_id') || '';
      const after = Number(url.searchParams.get('after') || 0);
      if (!userId) return json({ error: '缺少参数' }, 400, origin);
      const rows = await sql`SELECT id, content FROM messages
        WHERE user_id = ${userId} AND role = 'assistant' AND id > ${after}
        ORDER BY id ASC LIMIT 1`;
      return json({
        reply: rows[0] ? rows[0].content : null,
        msg_id: rows[0] ? rows[0].id : null
      }, 200, origin);
    }

    // ---- 管理后台登录 ----
    if (path === '/admin/login' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (!ADMIN_PASSWORD) return json({ error: '后端没配置 ADMIN_PASSWORD' }, 500, origin);
      if (String(body.password || '') !== ADMIN_PASSWORD) return json({ error: '密码不对' }, 401, origin);
      return json({ token: issueAdminToken() }, 200, origin);
    }

    // ---- 以下都需要管理员令牌 ----
    if (path.startsWith('/admin/')) {
      const auth = request.headers.get('authorization') || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!checkAdminToken(token)) return json({ error: '请先登录管理后台' }, 401, origin);

      if (path === '/admin/users' && method === 'GET') {
        const rows = await sql`
          SELECT u.id, u.nickname, u.created_at,
                 COUNT(m.id)::int AS msg_count,
                 MAX(m.created_at) AS last_active
          FROM users u LEFT JOIN messages m ON m.user_id = u.id
          GROUP BY u.id
          ORDER BY last_active DESC NULLS LAST`;
        return json({ users: rows }, 200, origin);
      }

      if (path === '/admin/messages' && method === 'GET') {
        const userId = url.searchParams.get('user_id') || '';
        const rows = userId
          ? await sql`SELECT m.id, m.role, m.content, m.model, m.created_at, u.nickname
              FROM messages m LEFT JOIN users u ON u.id = m.user_id
              WHERE m.user_id = ${userId} ORDER BY m.created_at ASC LIMIT 5000`
          : await sql`SELECT m.id, m.role, m.content, m.model, m.created_at, u.nickname
              FROM messages m LEFT JOIN users u ON u.id = m.user_id
              ORDER BY m.created_at DESC LIMIT 500`;

        if (url.searchParams.get('format') === 'csv') {
          const lines = rows.map(r => {
            const c = String(r.content || '').replace(/"/g, '""');
            return `${new Date(r.created_at).toISOString()},"${r.nickname || ''}","${r.role}","${c}","${r.model || ''}"`;
          });
          const csv = '\ufeff' + '时间,昵称,角色,内容,模型\n' + lines.join('\n');
          return new Response(csv, {
            status: 200,
            headers: makeHeaders(origin, {
              'Content-Type': 'text/csv; charset=utf-8',
              'Content-Disposition': 'attachment; filename="daiyu_chat.csv"'
            })
          });
        }
        return json({ messages: rows }, 200, origin);
      }
    }

    return json({ error: 'not found' }, 404, origin);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500, origin);
  }
};
