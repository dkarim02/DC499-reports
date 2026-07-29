$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$NodeExe   = Join-Path $ScriptDir "..\node\node-v24.18.0-win-x64\node.exe"
if (-not (Test-Path $NodeExe)) { $NodeExe = "node" }
$AgentJs   = Join-Path $ScriptDir "dc499_refresh.js"
$LogFile   = Join-Path $ScriptDir "dc499_watchdog.log"

function Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $LogFile -Value "[$ts] $msg"
}

# Trim log to last 500 lines so it doesn't grow forever
try {
    $lines = Get-Content $LogFile -ErrorAction SilentlyContinue
    if ($lines.Count -gt 500) {
        $lines | Select-Object -Last 500 | Set-Content $LogFile
    }
} catch {}

# Check if the serve process is already running
$running = Get-WmiObject Win32_Process -Filter "Name='node.exe'" |
           Where-Object { $_.CommandLine -like "*dc499_refresh*" -and $_.CommandLine -like "*serve*" }

if ($running) {
    Log "OK — server running (PID $($running[0].ProcessId))"
    exit 0
}

Log "Server not running — restarting..."

# Start a new visible cmd window so the server output is visible when you return to the PC
$nodeArg = "`"$NodeExe`" `"$AgentJs`" --serve"
Start-Process "cmd.exe" -ArgumentList "/k title DC499 Live Server && $nodeArg" -WorkingDirectory $ScriptDir

Log "Server window launched"
