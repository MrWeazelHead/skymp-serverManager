@echo off
title Skymp Server Manager Panel
cd /d "%~dp0"
echo.
echo   Starting Skymp Server Manager Panel...
echo   Close this window to stop the panel.
echo.
node server.js
pause
