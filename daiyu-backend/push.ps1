# 一键把 D:\DaiyuApp\backend 的后端代码同步到 GitHub
# 目标：zzz123 仓库的 daiyu-backend 子文件夹 + 根目录 netlify.toml（供 Netlify 构建）
# 用法：双击同目录的「一键同步.bat」

$ErrorActionPreference = 'Stop'

$GIT    = 'D:\新建文件夹\Git\cmd\git.exe'
$SRC    = 'D:\DaiyuApp\backend'
$REPO   = 'https://github.com/zzz-1103/zzz123.git'
$SUBDIR = 'daiyu-backend'
$TMP    = Join-Path $env:TEMP ('daiyu-push-' + (Get-Random))

$ROOT_NETLIFY = @'
# 林黛玉后端（代码在 daiyu-backend/ 子文件夹）
[build]
  base = "daiyu-backend"
  functions = "netlify/functions"
  publish = "public"

[[redirects]]
  from = "/"
  to = "/admin.html"
  status = 200

[[redirects]]
  from = "/admin"
  to = "/admin.html"
  status = 200
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

Write-Host '[2/4] 镜像后端代码 + 写根目录 netlify.toml...'
$DST = Join-Path $TMP $SUBDIR
# 先整个删掉再拷，保证远程不会残留旧文件
if (Test-Path $DST) { Remove-Item $DST -Recurse -Force }
New-Item -ItemType Directory -Force -Path $DST | Out-Null
Get-ChildItem -Path $SRC -Force |
    Where-Object { $_.Name -notin @('.git', 'node_modules', '.env') } |
    ForEach-Object { Copy-Item $_.FullName -Destination $DST -Recurse -Force }

# 清掉之前给别的平台准备的根目录 Dockerfile
$staleDockerfile = Join-Path $TMP 'Dockerfile'
if (Test-Path $staleDockerfile) { Remove-Item $staleDockerfile -Force }

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $TMP 'netlify.toml'), $ROOT_NETLIFY, $utf8NoBom)

Write-Host '[3/4] 提交并推送...'
Set-Location $TMP
& $GIT add -A

# ---- 防坑检查：有没有文件被仓库的 .gitignore 悄悄忽略了 ----
$staged = @(& $GIT diff --cached --name-only)
$expect = @()
Get-ChildItem -Path $SRC -Recurse -File -Force |
    Where-Object { $_.FullName -notmatch '\\node_modules\\' -and $_.Name -ne '.env' } |
    ForEach-Object { $expect += ($SUBDIR + '/' + $_.FullName.Replace("$SRC\", '').Replace('\', '/')) }
$missed = @($expect | Where-Object { $staged -notcontains $_ })
if ($missed.Count) {
    Write-Host ''
    Write-Host '⚠️  这些文件被仓库的 .gitignore 忽略了，没能提交：' -ForegroundColor Yellow
    $missed | ForEach-Object { Write-Host "      $_" -ForegroundColor Yellow }
    Write-Host '    → 请换个目录名（例如用 shared/ 而不是 lib/）' -ForegroundColor Yellow
    Write-Host ''
}

& $GIT -c user.name='zzz-1103' -c user.email='zzz-1103@users.noreply.github.com' commit -m '更新黛玉后端'
& $GIT push
if ($LASTEXITCODE -ne 0) {
    Fail '推送失败：请检查网络后重试（GitHub 有时会拒绝连接）。'
}

Write-Host '[4/4] 清理临时文件...'
Set-Location $SRC
Remove-Item $TMP -Recurse -Force

Write-Host '✅ 同步完成！' -ForegroundColor Green
