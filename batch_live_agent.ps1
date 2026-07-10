<#
.SYNOPSIS
    Polls MAWM for live 2nd-shift ecom batch status at facility 499,
    writes batch_live.json, and commits/pushes it every 60 minutes.
.NOTES
    Requires: claude CLI on PATH with mawm-data-http-prod MCP configured.
    Run from any directory -- paths are resolved relative to this script.
#>
param(
    [switch]$RunOnce
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$REPO_DIR    = $PSScriptRoot
$OUTPUT_FILE = Join-Path $REPO_DIR 'batch_live.json'
$FACILITY    = '499'
$INTERVAL    = 60   # minutes

function Invoke-MawmQuery {
    param([string]$Query)
    $prompt = "Call the mawm-data-http-prod MCP tool query_database with this exact SQL and return ONLY the raw JSON result object, no other text: $Query"
    $raw = $prompt | claude --print `
                            --output-format json `
                            --allowedTools 'mcp__mawm-data-http-prod__query_database' 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "claude CLI returned exit code ${LASTEXITCODE}: $raw"
    }
    $jsonLine = ($raw | Where-Object { $_ -match '^\{"type"' }) -join ''
    if (-not $jsonLine) {
        throw "No JSON envelope found in claude output: $raw"
    }
    $envelope   = $jsonLine | ConvertFrom-Json
    $resultText = $envelope.result
    $resultText = $resultText -replace '```json\s*', '' -replace '```\s*', ''
    if ($resultText -match '(\{[\s\S]*\})') {
        return $Matches[1] | ConvertFrom-Json
    }
    throw "Could not extract JSON from claude response: $resultText"
}

function Get-ShiftLabel {
    $hour = (Get-Date).Hour
    if ($hour -ge 6  -and $hour -lt 14) { return '1st' }
    if ($hour -ge 14 -and $hour -lt 22) { return '2nd' }
    return '3rd'
}

Write-Host 'batch_live_agent started -- polling every 60 min. Press Ctrl+C to stop.'

while ($true) {
    $cycleStart = Get-Date

    # Time-window guard: only run 13:59 - 23:59 PDT (UTC-7)
    $nowPdt      = (Get-Date).ToUniversalTime().AddHours(-7)
    $windowStart = [datetime]::new($nowPdt.Year, $nowPdt.Month, $nowPdt.Day, 13, 59, 0)
    $windowEnd   = [datetime]::new($nowPdt.Year, $nowPdt.Month, $nowPdt.Day, 23, 59, 0)
    if (-not $RunOnce -and ($nowPdt -lt $windowStart -or $nowPdt -gt $windowEnd)) {
        $sleepTarget = if ($nowPdt -lt $windowStart) { $windowStart } else { $windowStart.AddDays(1) }
        $sleepSecs   = [Math]::Max(60, [int]($sleepTarget - $nowPdt).TotalSeconds)
        Write-Host ("  Outside shift window. Sleeping until " + $sleepTarget.ToString('HH:mm') + " PDT (" + [int]($sleepSecs/60) + " min).")
        Start-Sleep -Seconds $sleepSecs
        continue
    }

    Write-Host ("`n[" + $cycleStart.ToString('HH:mm:ss') + "] Starting cycle...")

    try {
        # Compute 2nd shift window in UTC: 2pm PDT = 21:00 UTC, runs 10 hours
        $nowUtc       = (Get-Date).ToUniversalTime()
        $shiftHourUtc = 21
        if ($nowUtc.Hour -lt $shiftHourUtc) {
            $shiftStartUtc = [datetime]::new($nowUtc.Year, $nowUtc.Month, $nowUtc.Day, $shiftHourUtc, 0, 0).AddDays(-1)
        } else {
            $shiftStartUtc = [datetime]::new($nowUtc.Year, $nowUtc.Month, $nowUtc.Day, $shiftHourUtc, 0, 0)
        }
        $shiftEndUtc = $shiftStartUtc.AddHours(10)
        $startStr    = $shiftStartUtc.ToString('yyyy-MM-dd HH:mm:ss')
        $endStr      = $shiftEndUtc.ToString('yyyy-MM-dd HH:mm:ss')

        $SQL = @"
SELECT
    WORK_RELEASE_BATCH_ID,
    TYPE_ID,
    COUNT(*) AS total_tasks,
    SUM(CASE WHEN STATUS = '7000' THEN 1 ELSE 0 END) AS completed,
    SUM(CASE WHEN STATUS = '3000' THEN 1 ELSE 0 END) AS in_progress,
    SUM(CASE WHEN STATUS = '8000' THEN 1 ELSE 0 END) AS pending,
    MIN(CREATED_DATE_TIME) AS batch_released,
    MAX(UPDATED_TIMESTAMP) AS last_updated,
    GROUP_CONCAT(DISTINCT CURRENT_USER_ID ORDER BY CURRENT_USER_ID SEPARATOR ',') AS workers
FROM default_task.TSK_TASK
WHERE FACILITY_ID = '$FACILITY'
  AND WORK_RELEASE_BATCH_ID IS NOT NULL
  AND CREATED_DATE_TIME >= '$startStr'
  AND CREATED_DATE_TIME < '$endStr'
  AND TYPE_ID IN ('PICK/PACK', 'SINGLES_PICK', 'REPLENISHMENT')
GROUP BY WORK_RELEASE_BATCH_ID, TYPE_ID
ORDER BY batch_released DESC
"@

        Write-Host '  Querying MAWM connector...'
        $response = Invoke-MawmQuery -Query $SQL

        if (-not $response.success) {
            throw "Query failed: $($response.error)"
        }

        # Aggregate rows into per-batch objects (multiple TYPE_IDs share one batch_id)
        $byBatch = [ordered]@{}
        foreach ($row in $response.rows) {
            $bid = $row.WORK_RELEASE_BATCH_ID
            if (-not $byBatch.Contains($bid)) {
                $byBatch[$bid] = @{
                    batch_id     = $bid
                    released_utc = $row.batch_released
                    types        = [System.Collections.Generic.List[string]]::new()
                    total        = 0
                    completed    = 0
                    in_progress  = 0
                    pending      = 0
                    workers      = [System.Collections.Generic.List[string]]::new()
                }
            }
            $b = $byBatch[$bid]
            if ($row.TYPE_ID -and -not $b.types.Contains($row.TYPE_ID)) {
                $b.types.Add($row.TYPE_ID)
            }
            $b.total       += [int]$row.total_tasks
            $b.completed   += [int]$row.completed
            $b.in_progress += [int]$row.in_progress
            $b.pending     += [int]$row.pending
            if ($row.workers) {
                foreach ($w in ($row.workers -split ',')) {
                    $wname = ($w.Trim().ToLower() -split '@')[0]
                    if ($wname -and -not $b.workers.Contains($wname)) {
                        $b.workers.Add($wname)
                    }
                }
            }
        }

        $batches = @()
        foreach ($bid in $byBatch.Keys) {
            $b   = $byBatch[$bid]
            $pct = if ($b.total -gt 0) { [Math]::Round(($b.completed / $b.total) * 100) } else { 0 }
            $batches += [ordered]@{
                batch_id     = $b.batch_id
                released_utc = $b.released_utc
                types        = $b.types.ToArray()
                total        = $b.total
                completed    = $b.completed
                in_progress  = $b.in_progress
                pending      = $b.pending
                pct          = $pct
                workers      = $b.workers.ToArray()
            }
        }

        $totalTasks     = 0; $completedTasks = 0; $activeBatches = 0
        foreach ($b in $batches) {
            $totalTasks     += $b.total
            $completedTasks += $b.completed
            if ($b.in_progress -gt 0 -or $b.pending -gt 0) { $activeBatches++ }
        }
        $overallPct = if ($totalTasks -gt 0) { [Math]::Round(($completedTasks / $totalTasks) * 100) } else { 0 }

        Write-Host "  $($batches.Count) batches, $totalTasks total tasks, $overallPct% complete."

        $payload = [ordered]@{
            generated       = $cycleStart.ToString('yyyy-MM-ddTHH:mm:ss')
            facility        = $FACILITY
            shift           = Get-ShiftLabel
            shift_start_utc = $startStr
            summary         = [ordered]@{
                total_batches   = $batches.Count
                active_batches  = $activeBatches
                total_tasks     = $totalTasks
                completed_tasks = $completedTasks
                completion_pct  = $overallPct
            }
            batches = $batches
        }

        $payload | ConvertTo-Json -Depth 5 | Set-Content -Path $OUTPUT_FILE -Encoding UTF8
        Write-Host "  Written: $OUTPUT_FILE"

        Push-Location $REPO_DIR
        try {
            $timestamp = $cycleStart.ToString('yyyy-MM-dd HH:mm')
            git stash
            git pull --rebase origin main
            git stash pop
            git add batch_live.json
            git commit -m "Batch status update -- $timestamp"
            git push origin main
            Write-Host '  Committed and pushed.'
        }
        catch {
            Write-Warning "  Git step failed: $_"
        }
        finally {
            Pop-Location
        }
    }
    catch {
        Write-Warning "  Cycle error: $_"
    }

    if ($RunOnce) { break }

    $elapsed     = (Get-Date) - $cycleStart
    $waitSecs    = [Math]::Max(0, ($INTERVAL * 60) - [int]$elapsed.TotalSeconds)
    $waitMins    = [int]($waitSecs / 60)
    $waitRemSecs = $waitSecs % 60
    Write-Host "  Next cycle in $waitMins min $waitRemSecs sec."
    Start-Sleep -Seconds $waitSecs
}
