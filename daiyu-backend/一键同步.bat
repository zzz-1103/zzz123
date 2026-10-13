@echo off
chcp 65001 >nul
echo 正在把后端代码同步到 GitHub...
powershell -ExecutionPolicy Bypass -File "%~dp0push.ps1"
echo.
pause
