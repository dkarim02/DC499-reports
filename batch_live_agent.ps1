<#
.SYNOPSIS
    Polls MAWM for live 2nd-shift ecom batch status at facility 499,
    writes batch_live.json, and commits/pushes it every 60 minutes.
.NOTES
    Requires: claude CLI on PATH with mawm-data-http-prod MCP configured.
    Source: default_pickpack.TSK_TASK_DETAIL, RESOURCE_BATCH_ID column (B_ format).
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
        # 2nd shift window in UTC: 2pm PDT = 21:00 UTC, runs 10 hours
        $nowUtc       = (Get-Date).ToUniversalTime()
        $shiftHourUtc = 21
        if ($nowUtc.Hour -lt $shiftHourUtc) {
            $shiftStartUtc = [datetime]::new($nowUtc.Year, $nowUtc.Month, $nowUtc.Day, $shiftHourUtc, 0, 0).AddDays(-1)
        } else {
            $shiftStartUtc = [datetime]::new($nowUtc.Year, $nowUtc.Month, $nowUtc.Day, $shiftHourUtc, 0, 0)
        }
        $startStr = $shiftStartUtc.ToString('yyyy-MM-dd HH:mm:ss')

        # Query real MAWM batch data from TSK_TASK_DETAIL using RESOURCE_BATCH_ID (B_ format)
        # Status codes: 1000=pending, 8000=in_progress, 9000=completed
        $SQL = @"
SELECT
    RESOURCE_BATCH_ID,
    COUNT(DISTINCT ORDER_ID)   AS total_orders,
    COUNT(DISTINCT OLPN_ID)    AS total_olpns,
    COUNT(*)                   AS total_task_details,
    COUNT(DISTINCT CASE WHEN STATUS = '9000' THEN OLPN_ID END) AS completed_olpns,
    COUNT(DISTINCT CASE WHEN STATUS = '8000' THEN OLPN_ID END) AS in_progress_olpns,
    COUNT(DISTINCT CASE WHEN STATUS = '1000' THEN OLPN_ID END) AS pending_olpns,
    GROUP_CONCAT(DISTINCT CURRENT_USER_ID ORDER BY CURRENT_USER_ID SEPARATOR ',') AS workers,
    MIN(CREATED_TIMESTAMP) AS batch_created_utc
FROM default_pickpack.TSK_TASK_DETAIL
WHERE FACILITY_ID = '$FACILITY'
  AND RESOURCE_BATCH_ID IS NOT NULL
  AND RESOURCE_BATCH_ID NOT LIKE 'B_00000000000%'
  AND CREATED_TIMESTAMP >= '$startStr'
GROUP BY RESOURCE_BATCH_ID
ORDER BY batch_created_utc DESC
"@

        Write-Host '  Querying MAWM connector...'
        $response = Invoke-MawmQuery -Query $SQL

        if (-not $response.success) {
            throw "Query failed: $($response.error)"
        }

        $batches = @()
        foreach ($row in $response.rows) {
            $total     = [int]$row.total_olpns
            $completed = [int]$row.completed_olpns
            $inProg    = [int]$row.in_progress_olpns
            $pending   = [int]$row.pending_olpns
            $pct       = if ($total -gt 0) { [Math]::Round(($completed / $total) * 100) } else { 0 }

            # Parse workers list, strip email domain
            $workerList = [System.Collections.Generic.List[string]]::new()
            if ($row.workers) {
                foreach ($w in ($row.workers -split ',')) {
                    $wname = ($w.Trim().ToLower() -split '@')[0]
                    if ($wname) { $workerList.Add($wname) }
                }
            }

            # Determine batch status label
            $statusLabel = if ($completed -eq $total -and $total -gt 0) { 'Complete' }
                           elseif ($inProg -gt 0) { 'Work Started' }
                           elseif ($pending -eq $total) { 'Released' }
                           else { 'In Progress' }

            $batches += [ordered]@{
                batch_id         = $row.RESOURCE_BATCH_ID
                status           = $statusLabel
                total_orders     = [int]$row.total_orders
                total_olpns      = $total
                task_details     = [int]$row.total_task_details
                completed_olpns  = $completed
                in_progress_olpns= $inProg
                pending_olpns    = $pending
                pct              = $pct
                created_utc      = $row.batch_created_utc
                workers          = $workerList.ToArray()
            }
        }

        $totalOrders    = 0; $totalOlpns = 0; $completedOlpns = 0; $activeBatches = 0
        foreach ($b in $batches) {
            $totalOrders    += $b.total_orders
            $totalOlpns     += $b.total_olpns
            $completedOlpns += $b.completed_olpns
            if ($b.in_progress_olpns -gt 0 -or $b.pending_olpns -gt 0) { $activeBatches++ }
        }
        $overallPct = if ($totalOlpns -gt 0) { [Math]::Round(($completedOlpns / $totalOlpns) * 100) } else { 0 }

        Write-Host "  $($batches.Count) batches, $totalOrders orders, $totalOlpns oLPNs, $overallPct% complete."

        $payload = [ordered]@{
            generated       = $cycleStart.ToString('yyyy-MM-ddTHH:mm:ss')
            facility        = $FACILITY
            shift           = Get-ShiftLabel
            shift_start_utc = $startStr
            summary         = [ordered]@{
                total_batches    = $batches.Count
                active_batches   = $activeBatches
                total_orders     = $totalOrders
                total_olpns      = $totalOlpns
                completed_olpns  = $completedOlpns
                completion_pct   = $overallPct
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
