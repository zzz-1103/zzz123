# 林黛玉后端

Netlify Functions + Neon PostgreSQL。

- 主 API：`/api/*`（昵称登录、发消息、轮询回复、管理后台）
- 后台函数：`/bg/chat`（问 DeepSeek，最长 15 分钟）
- 管理后台页面：`/admin`

## 环境变量（在 Netlify 站点设置里配）

| 名称 | 说明 |
|---|---|
| `DATABASE_URL` | Neon PostgreSQL 连接串 |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `ADMIN_PASSWORD` | 管理后台登录密码 |
| `ALLOWED_ORIGIN` | 允许访问的前端域名 |
| `APP_API_KEY` | 可选，前后端暗号 |

## 为什么要有"后台函数"

Netlify 的同步函数最多跑 **26 秒**，而"深思"模式（deepseek-reasoner）需要 **60 秒**。
所以流程拆成三步：

1. 前端 `POST /api/chat` → 只把用户那句话存进数据库，立刻返回 `msg_id`
2. 主函数在后台触发 `/bg/chat`（后台函数，可跑 15 分钟）→ 它去问 DeepSeek 并存下回复
3. 前端每 2 秒 `GET /api/reply` 轮询，拿到回复就显示

详细部署步骤见 `部署教程.md`。
