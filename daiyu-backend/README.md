# 林黛玉网页版 · 后端部署教程

这套后端干三件事：
1. **代理 DeepSeek**——API key 藏在服务器环境变量里，前端再也看不到；
2. **存聊天记录**——每个人用昵称登录，说的话全部存进数据库；
3. **管理后台**——带密码，按人查聊天记录、导出 CSV。

架构：`Netlify（网站）` → `Render（Node 后端 + PostgreSQL 数据库）` → `DeepSeek`。

---

## 一、准备三个免费账号

| 账号 | 网址 | 用途 |
|---|---|---|
| Neon | https://neon.tech | 免费 PostgreSQL 数据库（存聊天记录） |
| Render | https://render.com | 免费部署后端 |
| GitHub | https://github.com | 放后端代码，Render 从这拉取 |

- **Neon**：注册 → Create project → 记下它给的 Connection string（形如 `postgres://...`）。
- **Render**：用 GitHub 账号登录即可。
- **GitHub**：装好 Git（https://git-scm.com 下载安装）。

---

## 二、代码已经在 GitHub 上（不用你做）

后端代码已推送到 `https://github.com/zzz-1103/zzz123` 仓库的 **`daiyu-backend/`** 子文件夹里。

以后改了后端代码要同步上去：在 `D:\DaiyuApp\backend` 里**双击 `一键同步.bat`** 即可（自动拉取 → 覆盖 → 推送）。

> 注意：真实 key 只放在环境变量里，`.env` 已被 `.gitignore` 忽略，不会上传。

---

## 三、在 Render 部署后端

1. Render 控制台 → **New → Web Service** → 连接 GitHub → 选 `zzz123` 仓库。
2. **Root Directory 填 `daiyu-backend`**（重要！代码在这个子文件夹里，不填会部署失败），再填两行命令：
   - **Build Command**：`npm install`
   - **Start Command**：`npm start`
3. 在 **Environment Variables** 里添加（点 Add Environment Variable）：

| Key | Value |
|---|---|
| `DATABASE_URL` | Neon 的 `postgres://...` 连接串 |
| `DEEPSEEK_API_KEY` | `sk-你的真实key` |
| `ADMIN_PASSWORD` | 你自己设的管理密码 |
| `ALLOWED_ORIGIN` | `https://lindaiyu.netlify.app` |
| `APP_API_KEY`（可选） | 随便一串难猜的，比如 `daiyu-2026-xyz` |

4. 实例选 **Free** → **Deploy**。等 2~4 分钟，拿到网址 `https://xxx.onrender.com`。
5. 验证：浏览器打开 `https://xxx.onrender.com/api/health`，看到 `{"ok":true}` 就成功。

> 数据库表**不用手动建**：后端启动时会自动创建。`schema.sql` 只是备查。

---

## 四、改前端，重新部署到 Netlify

1. 用记事本/VSCode 打开 `D:\DaiyuApp\index.html`，找到顶部这行：

```js
const BACKEND = 'https://YOUR-BACKEND.onrender.com'; // TODO 改成你的后端网址
```

把网址改成你第三步拿到的 `https://xxx.onrender.com`。如果后端设了 `APP_API_KEY`，把下面的 `APP_KEY` 也填成一样的值。

2. 重新打包（把图片重新内嵌进单文件）：

```powershell
cd D:\DaiyuApp
python pack.py
```

3. 把新生成的 `D:\DaiyuApp\黛玉.html` 拖到 https://app.netlify.com/drop 覆盖部署。

---

## 五、查看聊天记录

1. 浏览器打开 `https://xxx.onrender.com/admin`。
2. 输入 `ADMIN_PASSWORD` 登录。
3. 左边是聊过的人，点进去看完整聊天；右上角可**导出 CSV**。

---

## 六、防止后端休眠（重要）

Render 免费版 **15 分钟没人访问就休眠**，之后第一次点会慢 20~50 秒。

用 **UptimeRobot**（免费）唤醒：https://uptimerobot.com → **New monitor** → 类型选 HTTP(s) → URL 填 `https://xxx.onrender.com/api/health` → 检查间隔 5 分钟。这样后端一直醒着。

---

## 常见问题

- **登录/聊天失败**：确认 `index.html` 的 `BACKEND` 没写错、后端已部署、`ALLOWED_ORIGIN` 里有 `https://lindaiyu.netlify.app`。
- **后端起不来**：去 Render 的 Logs 看报错，多半是 `DATABASE_URL` 或 `DEEPSEEK_API_KEY` 没填对。
- **想本地先试**：在 `backend` 目录把 `.env.example` 复制成 `.env` 并填好，然后 `npm install` + `npm start`，再把 `index.html` 的 `BACKEND` 改成 `http://localhost:3000`。
- **安全提醒**：后端 key 藏起来了，但仍建议去 DeepSeek 后台设**消费上限**；管理后台密码设复杂点。
