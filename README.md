# 实时报名人数网页

这是一个能运行的网页项目，使用 Python 标准库 + SQLite，不需要额外安装第三方 Python 包。

## 本地运行

1. 安装 Python 3.9 或更新版本。
2. 将 `server.py` 和 `index.html` 放在同一个文件夹。
3. 在该文件夹打开终端，运行：

   ```bash
   python server.py
   ```

4. 浏览器打开 `http://127.0.0.1:8000`。

默认端口是 8000。更改端口可通过环境变量 `PORT` 设置，例如：

- Windows CMD：`set PORT=8080` 然后运行 `python server.py`
- macOS/Linux：`PORT=8080 python3 server.py`

## 怎样让所有人都能看到同一个实时人数

必须将整个项目部署到公网服务器或支持 Python 的托管平台。不能只把 `index.html` 发给别人，因为那样每个人都会在自己的浏览器中打开独立页面，无法共享数据库。

部署时需要满足：

- 所有访问者访问同一个运行中的服务；
- SQLite 数据文件 `registrations.sqlite3` 放在持久化磁盘上，不能在每次重启/重新部署时被清空；
- 若托管平台会把请求分发到多个实例，不要让每个实例使用各自独立的 SQLite 文件，应换成共享 PostgreSQL 等数据库；
- 正式公网部署应启用 HTTPS，并设置 `COOKIE_SECURE=1`。如果使用平台反向代理，应按平台要求配置启动命令和端口。

## 计数规则与限制

- 点击报名后写入服务器数据库；所有访客看到同一个总数。
- 同一个浏览器在保留 Cookie 的情况下重复点击不会重复计数。
- 这并不能证明是一位真实自然人：清除 Cookie、换浏览器或换设备都可能再次报名。若业务要求“一个人只能报名一次”，应增加登录、手机号验证码或其他身份核验，并遵守适用的隐私保护要求。
- 页面约每 2 秒读取一次服务器状态，所以通常会在 2 秒左右同步显示更新；它不是严格的 WebSocket 推送。


## Render 一键部署（公网演示版）

仓库根目录已提供 `render.yaml`，其中定义了 Python Web Service 和 PostgreSQL 数据库。

1. 登录 [Render Dashboard](https://dashboard.render.com/)。
2. 点击 **New → Blueprint**，连接 GitHub 仓库 `zzz-1103/zzz123`，选择 `main` 分支。
3. 检查将要创建的资源：`zzz123-signup` Web Service 和 `zzz123-signup-db` PostgreSQL 数据库。
4. 点击 **Deploy Blueprint**，等待 Web Service 和数据库部署成功。
5. 在 Render 的 Web Service 页面打开它提供的 `onrender.com` 网址；可再访问 `/health` 检查服务器状态。

配置说明：
- 启动命令：`python server.py`
- 构建命令：`pip install -r requirements.txt`
- 数据库连接由 Blueprint 安全地注入 `DATABASE_URL`，应用会自动使用 PostgreSQL。
- `COOKIE_SECURE=1` 会让浏览器只通过 HTTPS 发送报名 Cookie。

**免费方案限制：** Render 免费 Web Service 在闲置 15 分钟后会休眠，唤醒可能需要约一分钟；免费 PostgreSQL 数据库会在创建 30 天后过期，并且没有备份。因此这个 Blueprint 适合先验证部署流程或短期演示，不适合作为长期正式报名系统。活动报名开始前，请先考虑将 Web Service 和数据库升级为合适的付费方案，并建立数据库备份/导出流程。免费数据库到期可能影响访问和数据保留。

## 功能限制

目前以长期 Cookie 标识浏览器，能防止同一浏览器重复点击，但不能证明一个自然人只报名一次。清理 Cookie 或换设备可能再次报名。正式活动如需一人一报，需增加身份核验及相应隐私告知。
