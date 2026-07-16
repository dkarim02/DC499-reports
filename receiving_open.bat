@echo off
echo Starting DC499 Receiving Live...
echo.
"C:\Users\JLEO\OneDrive - Nordstrom\node\node-v24.18.0-win-x64\node.exe" "%~dp0dc499_refresh.js" --serve --open=Receiving_live.html %*
pause
