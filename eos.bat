@echo off
chcp 65001 >nul
echo DC499 EOS Report Agent
echo --------------------------------
echo  1  Capture SOS snapshot - run at 2:10 PM
echo  2  Capture EOS + finalize - run at shift end
echo  3  First-time auth
echo --------------------------------
set /p choice="Select: "

if "%choice%"=="1" (
    echo.
    echo Capturing SOS snapshot...
    "C:\Users\JLEO\OneDrive - Nordstrom\node\node-v24.18.0-win-x64\node.exe" "%~dp0eos_agent.js" --sos
    pause
    exit /b
)
if "%choice%"=="2" (
    echo.
    echo Capturing EOS and writing final report...
    "C:\Users\JLEO\OneDrive - Nordstrom\node\node-v24.18.0-win-x64\node.exe" "%~dp0eos_agent.js" --eos
    pause
    exit /b
)
if "%choice%"=="3" (
    echo.
    echo Starting auth flow...
    "C:\Users\JLEO\OneDrive - Nordstrom\node\node-v24.18.0-win-x64\node.exe" "%~dp0eos_agent.js" --auth
    pause
    exit /b
)

echo Invalid selection.
pause
