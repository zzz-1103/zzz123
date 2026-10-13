@echo off
chcp 65001 >nul
powershell -ExecutionPolicy Bypass -File "%~dp0push.ps1"
echo.
pause
