@echo off
chcp 65001 >nul

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

echo DC499 EOS Report Agent
echo --------------------------------
echo  1  Capture SOS snapshot - run at 2:10 PM
echo  2  Capture EOS + finalize - run at shift end
echo  3  Reconstruct SOS from history - if you missed start of shift
echo  4  First-time auth
echo --------------------------------
set /p choice="Select: "

if "%choice%"=="1" (
    echo.
    echo Capturing SOS snapshot...
    "%NODE_EXE%" "%~dp0eos_agent.js" --sos
    pause
    exit /b
)
if "%choice%"=="2" (
    echo.
    echo Capturing EOS and writing final report...
    "%NODE_EXE%" "%~dp0eos_agent.js" --eos
    pause
    exit /b
)
if "%choice%"=="3" (
    echo.
    echo Reconstructing SOS from history...
    echo Default anchor time is 2:10 PM today. Press Enter to use default,
    echo or type a custom time like 2026-07-24 14:10:00 and press Enter.
    set /p customtime="Anchor time (or Enter for default): "
    if "%customtime%"=="" (
        "%NODE_EXE%" "%~dp0eos_agent.js" --sos-reconstruct
    ) else (
        "%NODE_EXE%" "%~dp0eos_agent.js" --sos-reconstruct "--time=%customtime%"
    )
    pause
    exit /b
)
if "%choice%"=="4" (
    echo.
    echo Starting auth flow...
    "%NODE_EXE%" "%~dp0eos_agent.js" --auth
    pause
    exit /b
)

echo Invalid selection.
pause
