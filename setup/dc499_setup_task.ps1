$TaskName  = "DC499 Auto-Refresh"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$BatFile   = Join-Path $ScriptDir "dc499_autorefresh.bat"

if (-not (Test-Path $BatFile)) {
    Write-Host "ERROR: dc499_autorefresh.bat not found at $BatFile" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

$Action = New-ScheduledTaskAction `
    -Execute "cmd.exe" `
    -Argument ("/c `"" + $BatFile + "`"") `
    -WorkingDirectory $ScriptDir

$Trigger = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Hours 20) -Once -At (Get-Date)

$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -RunLevel Limited `
    -Force | Out-Null

Write-Host ""
Write-Host "Task registered: $TaskName" -ForegroundColor Green
Write-Host "  Runs every 20 hours"
Write-Host "  Log: $(Join-Path $ScriptDir 'dc499_autorefresh.log')"
Write-Host ""
Write-Host "REMINDER: Lock your PC before leaving (Win+L). Do not log out." -ForegroundColor Yellow
Write-Host ""

$Info = Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo
Write-Host "Next run: $($Info.NextRunTime)" -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter to close"
