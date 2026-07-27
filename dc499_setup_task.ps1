# DC499 Auto-Refresh — Task Scheduler Setup
# Run this ONCE as the current user (no admin needed).
# It registers a scheduled task that fires dc499_autorefresh.bat every 20 hours
# so the refresh token stays alive even when you're off for the weekend.
#
# Usage:  Right-click dc499_setup_task.ps1 -> Run with PowerShell
#   OR:   In a terminal: powershell -ExecutionPolicy Bypass -File dc499_setup_task.ps1

$TaskName   = "DC499 Auto-Refresh"
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Definition
$BatFile    = Join-Path $ScriptDir "dc499_autorefresh.bat"

if (-not (Test-Path $BatFile)) {
    Write-Host "ERROR: dc499_autorefresh.bat not found at $BatFile" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# Remove existing task if it exists (clean re-register)
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

# Action: run the bat file via cmd so it has a proper window context
$Action = New-ScheduledTaskAction `
    -Execute "cmd.exe" `
    -Argument "/c `"$BatFile`"" `
    -WorkingDirectory $ScriptDir

# Trigger: every 20 hours starting now
$Trigger = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Hours 20) -Once -At (Get-Date)

# Settings: run whether logged on or not is NOT used here (we need the locked session).
# RunOnlyIfLoggedOn = false would require admin + stored credentials.
# Instead: OnlyRunIfIdle=false, wake-to-run=false, run only if logged on (default) — works on locked screen.
$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

# Register under current user — no admin, no password prompt on locked screen
Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -RunLevel Limited `
    -Force | Out-Null

Write-Host ""
Write-Host "Task registered: '$TaskName'" -ForegroundColor Green
Write-Host "  Runs every 20 hours from now"
Write-Host "  Logs to: $(Join-Path $ScriptDir 'dc499_autorefresh.log')"
Write-Host ""
Write-Host "IMPORTANT: This only works if your PC stays locked (not logged out)."
Write-Host "Check Windows Update settings — disable auto-restart on weekends."
Write-Host ""

# Show next run time
$Task = Get-ScheduledTask -TaskName $TaskName
$Info = $Task | Get-ScheduledTaskInfo
Write-Host "Next run: $($Info.NextRunTime)" -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter to close"
