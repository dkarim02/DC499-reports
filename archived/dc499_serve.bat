@echo off
echo Starting DC499 Live Server on :3001...
echo.
"C:\Users\JLEO\OneDrive - Nordstrom\node\node-v24.18.0-win-x64\node.exe" "%~dp0dc499_refresh.js" --serve %*
pause
