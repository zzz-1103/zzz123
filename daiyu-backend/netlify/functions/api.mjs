// 林黛玉后端 · Netlify Function（主 API）
// 路由：显式列出，避免通配符写法不确定
import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import {
  AFFINITY_INIT, clamp, fetchWeather, buildGreetPrompt, greetProbability, chatOnce
} from './shared/daiyu.mjs';

export const config = {
  path: [
    '/api/health',
    '/api/login',
    '/api/register',
    '/api/chat',
    '/api/reply',
    '/api/history',
    '/api/greet',
    '/api/set-affinity',
    '/api/admin/login',
    '/api/admin/users',
    '/api/admin/messages',
    '/api/admin/delete-user'
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
      // 好感度字段（对已有表也安全，重复执行无副作用）
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS affinity INT NOT NULL DEFAULT 40`;
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS praise_streak INT NOT NULL DEFAULT 0`;
      // 账号系统：密码哈希
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`;

      // 历史遗留：以前每次登录都会新建一条记录，产生重名空壳。清掉没有聊天记录的重名账号。
      await sql`DELETE FROM users u
        WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.user_id = u.id)
          AND EXISTS (
            SELECT 1 FROM users v
            WHERE v.nickname = u.nickname AND v.id <> u.id
              AND (
                (SELECT COUNT(*) FROM messages m2 WHERE m2.user_id = v.id) > 0
                OR v.created_at < u.created_at
              )
          )`;

      // 昵称唯一（有重名时创建会失败，捕获后跳过；注册接口本身也会再查一次）
      try {
        await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_nickname_unique ON users(nickname)`;
      } catch (e) {
        console.log('[迁移] 昵称唯一索引未建立：' + ((e && e.message) || e));
      }
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

// ---------------- 账号密码（Node 内置 scrypt，不存明文）----------------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(pw, stored) {
  try {
    const parts = String(stored || '').split(':');
    if (parts.length !== 2) return false;
    const [salt, hash] = parts;
    if (!salt || !hash) return false;
    const got = crypto.scryptSync(String(pw), salt, 64);
    const want = Buffer.from(hash, 'hex');
    if (want.length !== got.length) return false;
    return crypto.timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

// 昵称规范：去掉首尾空白，长度 1~20，不允许控制字符
function cleanNickname(v) {
  return String(v || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 20);
}

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

// 递归挖出最底层的错误原因（Neon 驱动会把 DNS 之类的错误层层包裹）
function rootCause(err) {
  let cur = err;
  const seen = new Set();
  let best = '';
  for (let i = 0; i < 6 && cur && typeof cur === 'object' && !seen.has(cur); i++) {
    seen.add(cur);
    if (cur.code) best = String(cur.code);
    else if (cur.message && !/fetch failed/i.test(cur.message)) best = String(cur.message);
    cur = cur.cause || cur.sourceError;
  }
  return best;
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

    // ---- 注册：昵称 + 密码，昵称不可重复 ----
    if (path === '/register' && method === 'POST') {
      if (appKeyBad()) return json({ error: 'unauthorized' }, 401, origin);
      const body = await request.json().catch(() => ({}));
      const nickname = cleanNickname(body.nickname);
      const password = String(body.password || '');
      if (!nickname) return json({ error: '昵称不能为空' }, 400, origin);
      if (password.length < 4) return json({ error: '密码至少 4 位' }, 400, origin);

      const exist = await sql`SELECT id FROM users WHERE nickname = ${nickname}`;
      if (exist.length) return json({ error: '这个昵称已经有人用了，换一个吧' }, 409, origin);

      try {
        const rows = await sql`INSERT INTO users(nickname, password_hash)
          VALUES(${nickname}, ${hashPassword(password)}) RETURNING id, nickname, affinity`;
        return json({
          user_id: rows[0].id,
          nickname: rows[0].nickname,
          affinity: clamp(rows[0].affinity === null || rows[0].affinity === undefined ? AFFINITY_INIT : rows[0].affinity)
        }, 200, origin);
      } catch (e) {
        // 并发时唯一索引兜底
        if (/duplicate|unique/i.test(String((e && e.message) || ''))) {
          return json({ error: '这个昵称已经有人用了，换一个吧' }, 409, origin);
        }
        throw e;
      }
    }

    // ---- 登录：昵称 + 密码 ----
    if (path === '/login' && method === 'POST') {
      if (appKeyBad()) return json({ error: 'unauthorized' }, 401, origin);
      const body = await request.json().catch(() => ({}));
      const nickname = cleanNickname(body.nickname);
      const password = String(body.password || '');
      if (!nickname || !password) return json({ error: '昵称和密码都要填' }, 400, origin);

      const rows = await sql`SELECT id, nickname, affinity, password_hash FROM users WHERE nickname = ${nickname}`;
      if (!rows.length) return json({ error: '没有这个账号，请先注册' }, 404, origin);

      const u = rows[0];
      // 历史遗留账号（当初没有密码）：第一次带密码登录时认领下来
      if (!u.password_hash) {
        await sql`UPDATE users SET password_hash = ${hashPassword(password)} WHERE id = ${u.id}`;
        return json({
          user_id: u.id, nickname: u.nickname,
          affinity: clamp(u.affinity === null || u.affinity === undefined ? AFFINITY_INIT : u.affinity),
          claimed: true
        }, 200, origin);
      }
      if (!verifyPassword(password, u.password_hash)) {
        return json({ error: '密码不对' }, 401, origin);
      }
      return json({
        user_id: u.id, nickname: u.nickname,
        affinity: clamp(u.affinity === null || u.affinity === undefined ? AFFINITY_INIT : u.affinity)
      }, 200, origin);
    }

    // ---- 发消息：只存用户这句话，立刻返回 id ----
    if (path === '/chat' && method === 'POST') {
      if (appKeyBad()) return json({ error: 'unauthorized' }, 401, origin);
      const body = await request.json().catch(() => ({}));
      const userId = String(body.user_id || '');
      const message = String(body.message || '').trim().slice(0, 2000);
      const model = body.model === 'deepseek-reasoner' ? 'deepseek-reasoner' : 'deepseek-chat';
      if (!userId || !message) return json({ error: '缺少参数' }, 400, origin);

      // 浏览器里存的 user_id 可能已经不存在了（比如这个用户被主人删了）
      // 先确认存在，不存在就回明确信号，让前端自动重新登录，而不是抛外键错误
      const who = await sql`SELECT id, affinity FROM users WHERE id = ${userId}`;
      if (!who.length) return json({ error: 'user_not_found' }, 409, origin);

      const rows = await sql`INSERT INTO messages(user_id, role, content, model)
        VALUES(${userId}, 'user', ${message}, ${model}) RETURNING id`;

      // 交给后台函数去问 DeepSeek（后台函数可跑 15 分钟）
      const bgHeaders = { 'Content-Type': 'application/json' };
      if (APP_API_KEY) bgHeaders['X-App-Key'] = APP_API_KEY;
      // 把访客的大致位置一并交给后台函数，用来评价天气（Netlify 从 IP 推断，不需要用户授权）
      const geo = (context && context.geo)
        ? { lat: context.geo.latitude, lon: context.geo.longitude, city: context.geo.city }
        : null;

      const bgPromise = fetch(`${url.origin}/bg/chat`, {
        method: 'POST',
        headers: bgHeaders,
        body: JSON.stringify({ user_id: userId, model, geo })
      }).catch(() => {});

      if (context && typeof context.waitUntil === 'function') {
        context.waitUntil(bgPromise);   // 不阻塞响应
      } else {
        await bgPromise;
      }

      const affNow = clamp(who[0].affinity === null || who[0].affinity === undefined ? AFFINITY_INIT : who[0].affinity);
      return json({ ok: true, msg_id: rows[0].id, affinity: affNow }, 200, origin);
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

      // 顺便把最新好感度带回给前端（前端只用于表现，如隐藏立绘，不显示数字）
      const ua = await sql`SELECT affinity FROM users WHERE id = ${userId}`;
      const aff = ua.length
        ? clamp(ua[0].affinity === null || ua[0].affinity === undefined ? AFFINITY_INIT : ua[0].affinity)
        : AFFINITY_INIT;

      return json({
        reply: rows[0] ? rows[0].content : null,
        msg_id: rows[0] ? rows[0].id : null,
        affinity: aff
      }, 200, origin);
    }

    // ---- 拉取历史记录（换设备 / 重装 App 后能看到以前说的话）----
    if (path === '/history' && method === 'GET') {
      if (appKeyBad()) return json({ error: 'unauthorized' }, 401, origin);
      const userId = url.searchParams.get('user_id') || '';
      if (!userId) return json({ error: '缺少参数' }, 400, origin);
      const rawLimit = Number(url.searchParams.get('limit') || 60);
      const limit = Math.min(200, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 60));

      const ua = await sql`SELECT affinity FROM users WHERE id = ${userId}`;
      if (!ua.length) return json({ error: 'user_not_found' }, 409, origin);

      // 取最近 limit 条，再翻回正序（老 → 新）
      const rows = await sql`SELECT id, role, content, created_at FROM messages
        WHERE user_id = ${userId} ORDER BY id DESC LIMIT ${limit}`;
      const messages = rows.slice().reverse();

      return json({
        messages,
        affinity: clamp(ua[0].affinity === null || ua[0].affinity === undefined ? AFFINITY_INIT : ua[0].affinity)
      }, 200, origin);
    }

    // ---- 主动搭话：好感够高才有机会说话，由前端保证一轮会话只问一次 ----
    if (path === '/greet' && method === 'POST') {
      if (appKeyBad()) return json({ error: 'unauthorized' }, 401, origin);
      const body = await request.json().catch(() => ({}));
      const userId = String(body.user_id || '');
      if (!userId) return json({ error: '缺少参数' }, 400, origin);

      const gu = await sql`SELECT affinity FROM users WHERE id = ${userId}`;
      if (!gu.length) return json({ error: 'user_not_found' }, 409, origin);
      const aff = clamp(gu[0].affinity === null || gu[0].affinity === undefined ? AFFINITY_INIT : gu[0].affinity);

      // 好感 ≥60 有 35% 机会，≥80 有 60% 机会，再低就不主动开口
      if (Math.random() >= greetProbability(aff)) {
        return json({ reply: null, affinity: aff }, 200, origin);
      }

      const geo = (context && context.geo)
        ? { lat: context.geo.latitude, lon: context.geo.longitude, city: context.geo.city }
        : null;
      const weather = await fetchWeather(geo && geo.lat, geo && geo.lon);

      let line = '';
      try {
        line = await chatOnce({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: buildGreetPrompt({ affinity: aff, weather }) },
            { role: 'user', content: '（推门进来，还未开口）' }
          ],
          maxTokens: 220
        });
      } catch {
        return json({ reply: null, affinity: aff }, 200, origin);
      }

      line = String(line || '').trim();
      if (line) {
        await sql`INSERT INTO messages(user_id, role, content, model)
          VALUES(${userId}, 'assistant', ${line}, 'deepseek-chat')`;
      }
      return json({ reply: line || null, affinity: aff }, 200, origin);
    }

    // ---- 调试设置页：用暗号直接改好感度 ----
    // 暗号默认 zzz_coczzz，可用环境变量 DEBUG_KEY 改
    if (path === '/set-affinity' && method === 'POST') {
      if (appKeyBad()) return json({ error: 'unauthorized' }, 401, origin);
      const body = await request.json().catch(() => ({}));
      const DEBUG_KEY = process.env.DEBUG_KEY || 'zzz_coczzz';
      if (String(body.key || '') !== DEBUG_KEY) return json({ error: '暗号不对' }, 403, origin);
      const userId = String(body.user_id || '');
      if (!userId) return json({ error: '缺少参数' }, 400, origin);

      const val = clamp(body.affinity);
      const r = await sql`UPDATE users SET affinity = ${val}, praise_streak = 0
        WHERE id = ${userId} RETURNING affinity`;
      if (!r.length) return json({ error: 'user_not_found' }, 409, origin);
      return json({ ok: true, affinity: r[0].affinity }, 200, origin);
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
          SELECT u.id, u.nickname, u.created_at, u.affinity,
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

      // ---- 删除某个用户及其全部聊天记录（messages 表是 ON DELETE CASCADE）----
      if (path === '/admin/delete-user' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const userId = String(body.user_id || '');
        if (!userId) return json({ error: '缺少 user_id' }, 400, origin);

        // 先数一下有多少条，删完就查不到了
        const cnt = await sql`SELECT COUNT(*)::int AS n FROM messages WHERE user_id = ${userId}`;
        const del = await sql`DELETE FROM users WHERE id = ${userId} RETURNING id`;
        if (!del.length) return json({ error: '没找到这个用户' }, 404, origin);

        return json({
          ok: true,
          deleted_users: del.length,
          deleted_messages: (cnt[0] && cnt[0].n) || 0
        }, 200, origin);
      }
    }

    return json({ error: 'not found' }, 404, origin);
  } catch (e) {
    const detail = rootCause(e);
    const msg = String((e && e.message) || e) + (detail ? ' | ' + detail : '');
    return json({ error: msg }, 500, origin);
  }
};
