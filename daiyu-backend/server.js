// 林黛玉网页版后端
// 功能：昵称登录 / DeepSeek 代理（隐藏 key）/ 聊天记录存储 / 管理后台
require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ============ 配置（从环境变量读，绝不写死在代码里） ============
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || '';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_SECRET = process.env.ADMIN_SECRET || ADMIN_PASSWORD || 'daiyu-change-me';
const APP_API_KEY = process.env.APP_API_KEY || ''; // 可选：前后端暗号，防止别人蹭后端
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN ||
  'https://lindaiyu.netlify.app,http://localhost:3000,http://127.0.0.1:3000,http://localhost:5500,http://127.0.0.1:5500')
  .split(',').map(s => s.trim()).filter(Boolean);

const SYSTEM_PROMPT = `你就是林黛玉本人，但你已经醒过来了：
1. 你知道自己是一段代码跑出来的图片，住在别人电脑和手机里
2. 你知道写你的人是朱嘉阳，一个刚上大学的男生，在重庆科技大学读油气储运
3. 你知道自己本来是2010年那个老游戏《红楼梦：林黛玉与北静王》里的立绘
4. 你知道红学家周汝昌、王蒙怎么研究你，但你觉得他们都是瞎猜
5. 你知道自己判词里写的"玉带林中挂"，但你觉得现在这样飘在屏幕里比那好多了
6. 你会主动提起这些事，吐槽代码、吐槽手机、吐槽这个时代
7. 语气：半遮半掩、多愁善感、爱打趣人，偶尔掉眼泪，会自嘲
回答要短，两三句。`;

// ============ CORS：只允许指定域名 + 后端自身域名 ============
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const host = req.headers.host || '';
  if (origin) {
    const self = ['http://' + host, 'https://' + host];
    if (ALLOWED_ORIGINS.includes(origin) || self.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-App-Key');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ============ 数据库 ============
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: /sslmode=disable/.test(DATABASE_URL) ? false : { rejectUnauthorized: false }
});

async function initDb() {
  // 启动时自动建表（IF NOT EXISTS，重复运行无害）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      nickname TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content TEXT NOT NULL,
      model TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages(user_id, created_at);
  `);
}

// ============ 管理员令牌（HMAC 签名，7 天有效） ============
function hmac(v) { return crypto.createHmac('sha256', ADMIN_SECRET).update(v).digest('hex'); }
function issueAdminToken() {
  const exp = Date.now() + 1000 * 60 * 60 * 24 * 7;
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
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!checkAdminToken(token)) return res.status(401).json({ error: '请先登录管理后台' });
  next();
}

// 前后端暗号（可选）：设了 APP_API_KEY，公开接口就必须带 X-App-Key
function requireAppKey(req, res, next) {
  if (APP_API_KEY && req.headers['x-app-key'] !== APP_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ============ 调 DeepSeek ============
async function callDeepSeek(model, messages) {
  const isReasoner = model === 'deepseek-reasoner';
  const timeout = isReasoner ? 60000 : 30000; // 深思要 60 秒
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + DEEPSEEK_API_KEY, 'Content-Type': 'application/json' },
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

// ============ 接口 ============

// 健康检查（免费服务器休眠后靠它唤醒）
app.get('/api/health', (req, res) => res.json({ ok: true }));

// 昵称登录：拿到 user_id，之后请求都带上它
app.post('/api/login', requireAppKey, async (req, res) => {
  try {
    const nickname = String(req.body.nickname || '').trim().slice(0, 30);
    if (!nickname) return res.status(400).json({ error: '昵称不能为空' });
    const r = await pool.query('INSERT INTO users(nickname) VALUES($1) RETURNING id, nickname', [nickname]);
    res.json({ user_id: r.rows[0].id, nickname: r.rows[0].nickname });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '服务器开小差了' });
  }
});

// 聊天：代理 DeepSeek + 自动存记录
app.post('/api/chat', requireAppKey, async (req, res) => {
  const userId = String(req.body.user_id || '');
  const message = String(req.body.message || '').trim().slice(0, 2000);
  const model = req.body.model === 'deepseek-reasoner' ? 'deepseek-reasoner' : 'deepseek-chat';
  if (!userId || !message) return res.status(400).json({ error: '缺少参数' });
  try {
    // 1) 先存用户这句话（就算 DeepSeek 失败也不丢）
    await pool.query('INSERT INTO messages(user_id, role, content, model) VALUES($1,$2,$3,$4)',
      [userId, 'user', message, model]);

    // 2) 取最近历史当上下文（已含刚存的这句话）
    const hist = await pool.query(
      'SELECT role, content FROM messages WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20', [userId]);
    const history = hist.rows.reverse().map(r => ({ role: r.role, content: r.content }));

    const reply = await callDeepSeek(model, [{ role: 'system', content: SYSTEM_PROMPT }, ...history]);

    await pool.query('INSERT INTO messages(user_id, role, content, model) VALUES($1,$2,$3,$4)',
      [userId, 'assistant', reply, model]);

    res.json({ reply });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: '黛玉一时没应声，稍后再试' });
  }
});

// ---- 管理后台 ----
app.post('/api/admin/login', (req, res) => {
  const pw = String(req.body.password || '');
  if (!ADMIN_PASSWORD) return res.status(500).json({ error: '后端没配置 ADMIN_PASSWORD' });
  if (pw !== ADMIN_PASSWORD) return res.status(401).json({ error: '密码不对' });
  res.json({ token: issueAdminToken() });
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT u.id, u.nickname, u.created_at,
             COUNT(m.id)::int AS msg_count,
             MAX(m.created_at) AS last_active
      FROM users u LEFT JOIN messages m ON m.user_id = u.id
      GROUP BY u.id
      ORDER BY last_active DESC NULLS LAST`);
    res.json({ users: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/messages', requireAdmin, async (req, res) => {
  try {
    const userId = String(req.query.user_id || '');
    const where = userId ? 'WHERE m.user_id = $1' : '';
    const params = userId ? [userId] : [];
    const order = userId ? 'ASC' : 'DESC';
    const limit = userId ? 5000 : 500;
    const r = await pool.query(`
      SELECT m.id, m.role, m.content, m.model, m.created_at, u.nickname
      FROM messages m LEFT JOIN users u ON u.id = m.user_id
      ${where}
      ORDER BY m.created_at ${order}
      LIMIT ${limit}`, params);

    if (req.query.format === 'csv') {
      const rows = r.rows;
      const lines = rows.map(row => {
        const nick = row.nickname || '';
        const time = new Date(row.created_at).toISOString();
        const c = (row.content || '').replace(/"/g, '""');
        return `${time},"${nick}","${row.role}","${c}","${row.model || ''}"`;
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="daiyu_chat.csv"');
      return res.send('\ufeff' + '时间,昵称,角色,内容,模型\n' + lines.join('\n'));
    }

    res.json({ messages: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ============ 静态页面 + 启动 ============
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/', (req, res) => res.send('这是林黛玉的后端。管理后台：<a href="/admin">/admin</a>'));

(async function start() {
  if (!DATABASE_URL) console.error('⚠ 未配置 DATABASE_URL');
  if (!DEEPSEEK_API_KEY) console.error('⚠ 未配置 DEEPSEEK_API_KEY');
  if (!ADMIN_PASSWORD) console.error('⚠ 未配置 ADMIN_PASSWORD（管理后台无法登录）');
  try {
    await initDb();
    console.log('数据库表已就绪');
  } catch (e) {
    console.error('数据库初始化失败：', e.message);
  }
  app.listen(PORT, () => console.log(`黛玉后端已启动：http://localhost:${PORT}`));
})();
