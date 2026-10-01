@echo off
chcp 65001 >nul
echo DC499 Watchdog Setup
echo ──────────────────────────────
echo Registering scheduled task (runs every 30 min under your user account)...
echo.

set "TASK_NAME=DC499 Watchdog"
:: Lives in setup - the watchdog script sits one level up in the main folder
for %%I in ("%~dp0..") do set "ROOT=%%~fI\"
set "PS1=%ROOT%dc499_watchdog.ps1"

schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1

schtasks /create ^
  /tn "%TASK_NAME%" ^
  /tr "powershell.exe -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File \"%PS1%\"" ^
  /sc minute ^
  /mo 30 ^
  /ru "%USERNAME%" ^
  /it ^
  /f >nul

if errorlevel 1 (
    echo ERROR: Task registration failed.
    pause
    exit /b 1
)

echo  Task registered: %TASK_NAME%
echo  Runs every 30 minutes
echo  Log: %ROOT%dc499_watchdog.log
echo.
echo  IMPORTANT: The watchdog only restarts the server if it crashes.
echo  Start the server manually first with dc499.bat option 2 or 3.
echo  Lock the PC before leaving (Win+L) -- do NOT log out.
echo.
pause
