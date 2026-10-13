# 林黛玉后端

DeepSeek 代理 + 聊天记录存储 + 管理后台。

- 健康检查：`/api/health`
- 管理后台：`/admin`

## 环境变量

| 名称 | 说明 |
|---|---|
| `DATABASE_URL` | Neon PostgreSQL 连接串 |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `ADMIN_PASSWORD` | 管理后台登录密码 |
| `ALLOWED_ORIGIN` | 允许访问的前端域名 |
| `APP_API_KEY` | 可选，前后端暗号 |

## 部署

平台：**Back4App Containers**（免费、不需要银行卡、从 GitHub 构建 Docker 容器）

详细步骤见 `部署教程.md`。
