# 实时报名人数网页

报名页面公开后，所有访问者使用同一个 Cloudflare D1 数据库，看到共享的报名总人数。

## 推荐部署：Cloudflare Pages + D1（不使用 Render）

仓库已准备好 Cloudflare Pages 所需文件：
- `public/index.html`：网页界面
- `functions/api/state.js`：读取报名人数
- `functions/api/register.js`：记录报名
- `schema.sql`：创建 D1 数据表

### 第一步：在 Cloudflare Pages 连接 GitHub

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/) 并登录。
2. 进入 **Workers & Pages**，选择创建应用（Create application），再选择 Pages / Connect to Git。
3. 连接 GitHub，选择仓库 `zzz-1103/zzz123`，分支选择 `main`。
4. 构建设置：
   - Framework preset：`None`
   - Build command：留空
   - Build output directory：`public`
   - Root directory：保持仓库根目录（不要填 `public`）
5. 点击保存并部署，等待生成 `pages.dev` 网站地址。

### 第二步：创建 D1 数据库

1. 在 Cloudflare 控制台的 **Workers & Pages → D1 SQL Database** 中创建数据库，名称可用 `signup-db`。
2. 打开该数据库的 Console / SQL 控制台。
3. 打开本仓库的 `schema.sql`，复制其中 SQL 代码并执行。这会创建 `registrations` 表。

SQL 内容：

```sql
CREATE TABLE IF NOT EXISTS registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS registration_stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  total_count INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO registration_stats (id, total_count)
SELECT 1, COUNT(*) FROM registrations;

CREATE TRIGGER IF NOT EXISTS registrations_count_after_insert
AFTER INSERT ON registrations
BEGIN
  UPDATE registration_stats
  SET total_count = total_count + 1
  WHERE id = 1;
END;
```

### 第三步：把数据库绑定到网站

1. 打开刚创建的 Pages 项目。
2. 进入 **Settings → Bindings**，选择 **Add → D1 database binding**。
3. Variable name 必须填写为 `DB`。
4. 在 D1 database 一栏选择 `signup-db`，保存设置。
5. 重新部署项目，让函数读取新绑定。

### 第四步：验证

- 打开 Pages 提供的 `https://…pages.dev` 地址，应该看到报名网页。
- 打开 `https://…pages.dev/api/state`，应返回 JSON，其中有 `count` 和 `registered` 字段。
- 在网页点一次「立即报名」，人数应增加 1；用另一个浏览器打开页面，应能看到相同总人数。

## 免费额度与数据

这条路线改用 Cloudflare D1 免费方案，不再使用 Render 的数据库，因此不受 Render“创建 30 天后到期”的规则约束。但 Cloudflare 仍有自己的每日额度和存储限制；不同账户可能出现额外验证要求，无法保证每个新账户都完全不需要验证。官方当前列出的 D1 Free 配额包括每天 500 万行读取、每天 10 万行写入、每个账户总计 5GB 存储，单个数据库最多 500MB；Workers / Pages Functions 也有每天 100,000 次请求的免费额度。超过每日 D1 读写额度时，查询会暂时失败直到 UTC 午夜重置，数据本身不会因为达到额度而被删除。使用前请在控制台查看最新额度并监测使用量。

注意：如果大量用户一直开着页面，实时刷新会持续消耗请求额度。正式活动应监控用量；如访问量较高，可以降低轮询频率或考虑适合的付费方案。

## 报名去重与隐私说明

系统以长期 Cookie 的哈希值识别同一浏览器，能防止同一浏览器重复点击，但不能确认真实自然人身份。清除浏览器数据、换设备或使用另一个浏览器仍可能再次报名。若要求严格一人一报，应增加账号或手机号验证，并提供适当的隐私说明。

页面只保存随机浏览器标识的哈希和报名时间，不收集姓名或手机号。

## 本地运行（原 Python 版本）

仓库根目录的 `server.py` 使用 Python 和 SQLite，可在本地运行：

```bash
python server.py
```

浏览器打开 `http://127.0.0.1:8000`。Cloudflare 部署时则使用 `public/` 和 `functions/` 中的 Pages 版本，不要在 Render 上创建服务。

## 许可

MIT License。若公开分享、修改或再发布，请保留许可文件。
