# 一键把 D:\DaiyuApp\backend 的后端代码同步到 GitHub
# 目标：zzz123 仓库的 daiyu-backend 子文件夹 + 根目录 Dockerfile（供 Back4App 构建）
# 用法：双击同目录的「一键同步.bat」

$ErrorActionPreference = 'Stop'

$GIT    = 'D:\新建文件夹\Git\cmd\git.exe'
$SRC    = 'D:\DaiyuApp\backend'
$REPO   = 'https://github.com/zzz-1103/zzz123.git'
$SUBDIR = 'daiyu-backend'
$TMP    = Join-Path $env:TEMP ('daiyu-push-' + (Get-Random))

$ROOT_DOCKERFILE = @'
# 林黛玉后端（代码在 daiyu-backend/ 子文件夹）
FROM node:20-alpine

WORKDIR /app

COPY daiyu-backend/package.json ./
RUN npm install --omit=dev

COPY daiyu-backend/ ./

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
'@

function Fail($msg) {
    Set-Location $SRC
    if (Test-Path $TMP) { Remove-Item $TMP -Recurse -Force -ErrorAction SilentlyContinue }
    Write-Host ""
    Write-Host "❌ $msg" -ForegroundColor Red
    exit 1
}

Write-Host '[1/4] 拉取远程仓库...'
& $GIT clone --depth 1 $REPO $TMP
if (-not (Test-Path (Join-Path $TMP '.git'))) {
    Fail '拉取失败：连不上 GitHub（网络被重置）。请过一会儿再双击重试。'
}

Write-Host '[2/4] 复制后端代码 + 写根目录 Dockerfile...'
$DST = Join-Path $TMP $SUBDIR
New-Item -ItemType Directory -Force -Path $DST | Out-Null
Get-ChildItem -Path $SRC -Force |
    Where-Object { $_.Name -notin @('.git', 'node_modules', '.env') } |
    ForEach-Object { Copy-Item $_.FullName -Destination $DST -Recurse -Force }

# 根目录也放一个 Dockerfile（Back4App 从仓库根构建时用），写成无 BOM 的 UTF-8
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $TMP 'Dockerfile'), $ROOT_DOCKERFILE, $utf8NoBom)

Write-Host '[3/4] 提交并推送...'
Set-Location $TMP
& $GIT add -A
& $GIT -c user.name='zzz-1103' -c user.email='zzz-1103@users.noreply.github.com' commit -m '更新黛玉后端'
& $GIT push
if ($LASTEXITCODE -ne 0) {
    Fail '推送失败：请检查网络后重试（GitHub 有时会拒绝连接）。'
}

Write-Host '[4/4] 清理临时文件...'
Set-Location $SRC
Remove-Item $TMP -Recurse -Force

Write-Host '✅ 同步完成！' -ForegroundColor Green
