@echo off
echo DC499 Reporter
echo ──────────────────────────────
echo  1  Refresh data only (one-shot)
echo  2  Start live server
echo  3  Start live server + open Receiving Live
echo  4  First-time auth
echo ──────────────────────────────
set /p choice="Select: "

if "%choice%"=="1" (
    echo.
    echo Running one-shot refresh...
    "C:\Users\JLEO\OneDrive - Nordstrom\node\node-v24.18.0-win-x64\node.exe" "%~dp0dc499_refresh.js"
    pause
    exit /b
)
if "%choice%"=="2" (
    echo.
    echo Starting live server on :3001...
    "C:\Users\JLEO\OneDrive - Nordstrom\node\node-v24.18.0-win-x64\node.exe" "%~dp0dc499_refresh.js" --serve
    pause
    exit /b
)
if "%choice%"=="3" (
    echo.
    echo Starting live server + opening Receiving Live...
    "C:\Users\JLEO\OneDrive - Nordstrom\node\node-v24.18.0-win-x64\node.exe" "%~dp0dc499_refresh.js" --serve --open=Receiving_live.html
    pause
    exit /b
)
if "%choice%"=="4" (
    echo.
    echo Starting auth flow...
    "C:\Users\JLEO\OneDrive - Nordstrom\node\node-v24.18.0-win-x64\node.exe" "%~dp0dc499_refresh.js" --auth
    pause
    exit /b
)

echo Invalid selection.
pause
