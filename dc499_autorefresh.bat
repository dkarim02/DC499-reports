@echo off
:: DC499 Auto-Refresh — runs silently via Windows Task Scheduler.
:: No menu, no pause. Logs output to dc499_autorefresh.log in the same folder.

set "SCRIPT_DIR=%~dp0"
set "LOG_FILE=%SCRIPT_DIR%dc499_autorefresh.log"
set "NODE_EXE=C:\Users\JLEO\OneDrive - Nordstrom\node\node-v24.18.0-win-x64\node.exe"

if not exist "%NODE_EXE%" (
    where node >nul 2>&1
    if errorlevel 1 (
        echo %DATE% %TIME% ERROR: Node.js not found >> "%LOG_FILE%"
        exit /b 1
    )
    set "NODE_EXE=node"
)

echo %DATE% %TIME% Starting auto-refresh >> "%LOG_FILE%"
"%NODE_EXE%" "%SCRIPT_DIR%dc499_refresh.js" >> "%LOG_FILE%" 2>&1
echo %DATE% %TIME% Done >> "%LOG_FILE%"
