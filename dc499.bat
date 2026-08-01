@echo off
chcp 65001 >nul

:: Locate Node — prefer the bundled copy, fall back to system PATH
set "NODE_EXE=C:\Users\JLEO\OneDrive - Nordstrom\node\node-v24.18.0-win-x64\node.exe"
if not exist "%NODE_EXE%" (
    where node >nul 2>&1
    if errorlevel 1 (
        echo ERROR: Node.js not found. Install Node from nodejs.org or restore the bundled copy.
        pause
        exit /b 1
    )
    set "NODE_EXE=node"
)

echo DC499 Reporter
echo ──────────────────────────────
echo  1  Refresh data only (one-shot)
echo  2  Start live server
echo  3  Start live server + open Receiving Live
echo  4  First-time auth
echo ──────────────────────────────
echo  5  Ecom Live - one-shot refresh
echo  6  Ecom Live - start auto-refresh (every 30 min)
echo  7  Ecom Live - auth
echo ──────────────────────────────
set /p choice="Select: "

if "%choice%"=="1" (
    echo.
    echo Running one-shot refresh...
    "%NODE_EXE%" "%~dp0dc499_refresh.js"
    pause
    exit /b
)
if "%choice%"=="2" (
    echo.
    echo Starting live server on :3001...
    "%NODE_EXE%" "%~dp0dc499_refresh.js" --serve
    pause
    exit /b
)
if "%choice%"=="3" (
    echo.
    echo Starting live server + opening Receiving Live...
    "%NODE_EXE%" "%~dp0dc499_refresh.js" --serve --open=Receiving_live.html
    pause
    exit /b
)
if "%choice%"=="4" (
    echo.
    echo Starting auth flow...
    "%NODE_EXE%" "%~dp0dc499_refresh.js" --auth
    pause
    exit /b
)
if "%choice%"=="5" (
    echo.
    echo Running Ecom Live one-shot refresh...
    "%NODE_EXE%" "%~dp0scout_ecom_agent.js"
    pause
    exit /b
)
if "%choice%"=="6" (
    echo.
    echo Starting Ecom Live auto-refresh every 5 min...
    "%NODE_EXE%" "%~dp0scout_ecom_agent.js" --serve --interval=5
    pause
    exit /b
)
if "%choice%"=="7" (
    echo.
    echo Starting Ecom Live auth flow...
    "%NODE_EXE%" "%~dp0scout_ecom_agent.js" --auth
    pause
    exit /b
)

echo Invalid selection.
pause
