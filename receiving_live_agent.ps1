<#
.SYNOPSIS
    Polls MAWM for live 2nd-shift receiving data at facility 499,
    writes receiving_live.json, and commits/pushes it every 60 minutes.

.NOTES
    Requires: claude CLI on PATH with mawm-data-http-prod MCP configured.
    Run from any directory -- paths are resolved relative to this script.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# -- Config -------------------------------------------------------------------
$REPO_DIR    = $PSScriptRoot
$OUTPUT_FILE = Join-Path $REPO_DIR 'receiving_live.json'
$FACILITY    = '499'
$INTERVAL    = 60   # minutes

# Roster filtering removed -- HTML handles on/off roster client-side.
# All 2nd-shift associates are written to the JSON.

$SQL = @"
SELECT CREATED_BY,
       COUNT(*) AS lpns,
       MIN(CREATED_TIMESTAMP) AS first_scan,
       MAX(CREATED_TIMESTAMP) AS last_scan
FROM default_receiving.RCV_LPN
WHERE FACILITY_ID = '$FACILITY'
  AND DATE(CREATED_TIMESTAMP) = CURDATE()
  AND CREATED_BY != 'system-msg-user@$FACILITY'
  AND TIME(CREATED_TIMESTAMP) >= '12:00:00'
GROUP BY CREATED_BY
ORDER BY lpns DESC
"@

# -- Helpers ------------------------------------------------------------------
function Invoke-MawmQuery {
    param([string]$Query)

    # Prompt must be piped via stdin -- this CLI version does not accept a prompt argument with --print.
    # --output-format json wraps the response in an envelope: {type, result, ...}
    # --allowedTools whitelists the MCP tool so Claude can call it without prompting.
    $prompt = "Call the mawm-data-http-prod MCP tool query_database with this exact SQL and return ONLY the raw JSON result object, no other text: $Query"

    $raw = $prompt | claude --print `
                            --output-format json `
                            --allowedTools 'mcp__mawm-data-http-prod__query_database' 2>&1

    if ($LASTEXITCODE -ne 0) {
        throw "claude CLI returned exit code ${LASTEXITCODE}: $raw"
    }

    # Filter out the pre-flight banner lines, keep only the JSON envelope line.
    $jsonLine = ($raw | Where-Object { $_ -match '^\{"type"' }) -join ''
    if (-not $jsonLine) {
        throw "No JSON envelope found in claude output: $raw"
    }

    # The envelope .result field contains the MCP response, possibly in a ```json ... ``` code fence.
    $envelope   = $jsonLine | ConvertFrom-Json
    $resultText = $envelope.result

    # Strip optional markdown code fence, then extract the first {...} JSON block.
    $resultText = $resultText -replace '```json\s*', '' -replace '```\s*', ''
    if ($resultText -match '(\{[\s\S]*\})') {
        return $Matches[1] | ConvertFrom-Json
    }
    throw "Could not extract JSON from claude response: $resultText"
}

function Format-HHmm {
    param([string]$ts)
    if ([string]::IsNullOrWhiteSpace($ts)) { return $null }
    try { return ([datetime]$ts).ToString('HH:mm') }
    catch { return $ts }
}

function Get-ShiftLabel {
    $hour = (Get-Date).Hour
    if ($hour -ge 6  -and $hour -lt 14) { return '1st' }
    if ($hour -ge 14 -and $hour -lt 22) { return '2nd' }
    return '3rd'
}

# -- Main loop ----------------------------------------------------------------
Write-Host 'receiving_live_agent started -- polling every 60 min. Press Ctrl+C to stop.'

while ($true) {
    $cycleStart = Get-Date
    Write-Host ("`n[" + $cycleStart.ToString('HH:mm:ss') + "] Starting cycle...")

    try {
        # 1. Query MAWM
        Write-Host '  Querying MAWM connector...'
        $response = Invoke-MawmQuery -Query $SQL

        if (-not $response.success) {
            throw "Query failed: $($response.error)"
        }

        # 2. Map all rows -- no roster filter, HTML handles that client-side
        $associates = @()
        foreach ($row in $response.rows) {
            $associates += [ordered]@{
                name       = ($row.CREATED_BY.ToLower() -split '@')[0]
                lpns       = [int]$row.lpns
                first_scan = Format-HHmm $row.first_scan
                last_scan  = Format-HHmm $row.last_scan
            }
        }

        Write-Host "  $($associates.Count) associates in results."

        # 3. Write receiving_live.json
        $payload = [ordered]@{
            generated  = $cycleStart.ToString('yyyy-MM-ddTHH:mm:ss')
            shift      = Get-ShiftLabel
            facility   = $FACILITY
            associates = $associates
        }

        $payload | ConvertTo-Json -Depth 4 | Set-Content -Path $OUTPUT_FILE -Encoding UTF8
        Write-Host "  Written: $OUTPUT_FILE"

        # 4. Git commit and push (only receiving_live.json)
        Push-Location $REPO_DIR
        try {
            $timestamp = $cycleStart.ToString('yyyy-MM-dd HH:mm')
            git add receiving_live.json
            git commit -m "Live receiving update -- $timestamp"
            git push
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

    # 5. Sleep until next cycle
    $elapsed     = (Get-Date) - $cycleStart
    $waitSecs    = [Math]::Max(0, ($INTERVAL * 60) - [int]$elapsed.TotalSeconds)
    $waitMins    = [int]($waitSecs / 60)
    $waitRemSecs = $waitSecs % 60
    Write-Host "  Next cycle in $waitMins min $waitRemSecs sec."
    Start-Sleep -Seconds $waitSecs
}
