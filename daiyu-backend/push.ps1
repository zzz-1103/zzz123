# 一键把 D:\DaiyuApp\backend 的后端代码同步到 GitHub
# 目标是 zzz123 仓库的 daiyu-backend 子文件夹
# 用法：右键本文件 → 使用 PowerShell 运行

$ErrorActionPreference = 'Stop'

$GIT    = 'D:\新建文件夹\Git\cmd\git.exe'
$SRC    = 'D:\DaiyuApp\backend'
$REPO   = 'https://github.com/zzz-1103/zzz123.git'
$SUBDIR = 'daiyu-backend'
$TMP    = Join-Path $env:TEMP ('daiyu-push-' + (Get-Random))

Write-Host '[1/4] 拉取远程仓库...'
& $GIT clone --depth 1 $REPO $TMP

Write-Host '[2/4] 复制后端代码到 daiyu-backend\ ...'
$DST = Join-Path $TMP $SUBDIR
New-Item -ItemType Directory -Force -Path $DST | Out-Null
Get-ChildItem -Path $SRC -Force |
    Where-Object { $_.Name -notin @('.git', 'node_modules', '.env') } |
    ForEach-Object { Copy-Item $_.FullName -Destination $DST -Recurse -Force }

Write-Host '[3/4] 提交并推送...'
Set-Location $TMP
& $GIT add $SUBDIR
& $GIT -c user.name='zzz-1103' -c user.email='zzz-1103@users.noreply.github.com' commit -m '更新黛玉后端'
& $GIT push

Write-Host '[4/4] 清理临时文件...'
Set-Location $SRC
Remove-Item $TMP -Recurse -Force

Write-Host '同步完成！' -ForegroundColor Green
