#!/usr/bin/env node
/**
 * SCOUT — Shipping Live Agent
 * Queries TSK_ACTIVITY_TRACKING for NRDR CORE PALLETIZE OLPN + FLOOR LOAD PALLETIZE OLPN.
 * Deduplicates by Employee + Container ID, buckets into shift hours, writes shipping_live.json.
 *
 * Usage:
 *   node scout_shipping_agent.js            one-shot refresh
 *   node scout_shipping_agent.js --auth     first-time auth / re-auth
 *   node scout_shipping_agent.js --serve    auto-refresh every 5 min
 *   node scout_shipping_agent.js --serve --interval=5
 */

const fs     = require('fs');
const path   = require('path');
require('./scout_file_mirror');  // also writes filedata/*.js so pages work from OneDrive (file://)
const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const { execSync } = require('child_process');

// ── config ─────────────────────────────────────────────────────────────────────
const MCP_BASE      = 'https://mawm-data-mcp.nordstromaws.app';
const TOKEN_FILE    = path.join(__dirname, '.mcp_token.json');
const OUTPUT_FILE   = path.join(__dirname, 'shipping_live.json');
const CLIENT_ID     = 'https://claude.ai/oauth/claude-code-client-metadata';
const REDIRECT_PORT = 3126;
const REDIRECT_URI  = `http://localhost:${REDIRECT_PORT}/callback`;
const FACILITY      = '499';

// Shift window: 2:15 PM PDT = 21:15 UTC
const SHIFT_START_HOUR_PDT = 14; // 2 PM
const SHIFT_START_MIN_PDT  = 15;
const HOURLY_TARGET        = 80; // containers per person per hour

const SHIPPING_TX = [
  'NRDR CORE PALLETIZE OLPN',
  'FLOOR LOAD PALLETIZE OLPN',
];

const args       = process.argv.slice(2);
const MODE_AUTH  = args.includes('--auth');
const MODE_SERVE = args.includes('--serve');
const INTERVAL   = (() => {
  const f = args.find(a => a.startsWith('--interval='));
  return f ? parseInt(f.split('=')[1]) * 60 * 1000 : 5 * 60 * 1000; // default 5 min
})();

// ── MCP login + queries — shared by every agent, see scout_mcp.js ─────────────
const mcp = require('./scout_mcp')({ redirectPort: REDIRECT_PORT });
const { doAuthFlow, getAccessToken, AuthError, getAccessTokenSilent, mcpQuery } = mcp;

// ── helpers ────────────────────────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
}

function shiftStartUtc() {
  const nowUtc = new Date();
  const h = nowUtc.getUTCHours();
  // 1st shift: 5 AM PST = 13:00 UTC (OT can start 3–4 AM PST = 11:00 UTC)
  //            Use 11:00 UTC so OT hours are captured; 3 AM PDT = hour 3 PDT
  // 2nd shift: 2:15 PM PST = 22:15 UTC
  const is1st = h >= 11 && h < 22;
  const start = new Date(nowUtc);
  if (is1st) {
    start.setUTCHours(11, 0, 0, 0);  // 3 AM PST — covers OT starts
  } else {
    start.setUTCHours(22, 15, 0, 0); // 2:15 PM PST
    if (h < 11) start.setUTCDate(start.getUTCDate() - 1);
  }
  return {
    utc: start.toISOString().replace('T', ' ').slice(0, 19),
    label: is1st ? '1st' : '2nd',
    pdtHour: is1st ? 3 : 14,  // earliest display hour for each shift
  };
}

// ── SQL ────────────────────────────────────────────────────────────────────────
function buildSql(shiftStart) {
  const txList = SHIPPING_TX.map(t => `'${t.replace(/'/g, "''")}'`).join(',');
  return `
SELECT
  t.USER_ID                                              AS \`Employee\`,
  t.TRANSACTION_ID                                       AS \`Transaction ID\`,
  CONVERT_TZ(t.ACTIVITY_DATE_TIME, '+00:00', '-07:00')   AS \`Activity Datetime\`,
  t.CONTAINER_ID                                         AS \`Container ID\`
FROM default_task.TSK_ACTIVITY_TRACKING t
WHERE t.FACILITY_ID = '${FACILITY}'
  AND t.CREATED_TIMESTAMP >= '${shiftStart}'
  AND t.TRANSACTION_ID IN (${txList})
ORDER BY t.ACTIVITY_DATE_TIME ASC`.trim();
}

// ── process rows into per-employee hourly buckets ──────────────────────────────
function processRows(rows, shiftPdtHour, is1st) {
  // Dedup: each Employee + Container ID pair counts once, attributed to the earliest hour seen
  const earliest = {}; // key: `employee|containerID` → local hour integer
  for (const row of rows) {
    const emp = (row['Employee'] || '').trim();
    const cid = (row['Container ID'] || '').trim();
    if (!emp || !cid) continue;
    const dtStr = row['Activity Datetime'];
    if (!dtStr) continue;
    // Parse local hour from the already-converted timestamp string (PST = -08:00)
    const dt = new Date(String(dtStr).replace(' ', 'T') + '-08:00');
    if (isNaN(dt.getTime())) continue;
    const localHour = dt.getHours(); // 0–23 PST
    const key = `${emp}|${cid}`;
    if (earliest[key] === undefined || localHour < earliest[key]) {
      earliest[key] = localHour;
    }
  }

  // Build per-employee buckets
  // 1st shift: 3 AM–2 PM PST = hours 3..13
  // 2nd shift: 2 PM–10 PM PST = hours 14..21
  const HOURS = is1st ? [3,4,5,6,7,8,9,10,11,12,13] : [14,15,16,17,18,19,20,21];
  const empMap = {}; // employee -> { hourBuckets: {14:n, 15:n,...}, total: n }

  for (const [key, pdtHour] of Object.entries(earliest)) {
    const emp = key.split('|')[0];
    if (!empMap[emp]) {
      empMap[emp] = { hours: {}, total: 0 };
      for (const h of HOURS) empMap[emp].hours[h] = 0;
    }
    if (empMap[emp].hours[pdtHour] !== undefined) {
      empMap[emp].hours[pdtHour]++;
    }
    empMap[emp].total++;
  }

  // Sort employees by total desc
  const employees = Object.entries(empMap)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([emp, data]) => ({
      employee: emp,
      hours: data.hours,
      total: data.total,
    }));

  // Team totals row
  const teamHours = {};
  for (const h of HOURS) {
    teamHours[h] = employees.reduce((s, e) => s + (e.hours[h] || 0), 0);
  }
  const teamTotal = employees.reduce((s, e) => s + e.total, 0);

  return { employees, teamHours, teamTotal, hours: HOURS };
}

// ── main fetch ─────────────────────────────────────────────────────────────────
async function fetchShippingLive(accessToken) {
  const { utc: shiftStart, label: shift, pdtHour: shiftPdtHour } = shiftStartUtc();
  const is1st = shift === '1st';

  console.log(`[${ts()}] Querying shipping transactions since ${shiftStart}...`);
  const resp = await mcpQuery(accessToken, buildSql(shiftStart));
  const rows = resp.rows || [];
  console.log(`[${ts()}] ${rows.length} rows`);
  if (rows.length >= 9500) console.warn(`[${ts()}] ⚠ Hit row cap — data may be truncated`);

  const { employees, teamHours, teamTotal, hours } = processRows(rows, shiftPdtHour, is1st);

  const output = {
    generated:     new Date().toISOString(),
    shift,
    shift_start:   shiftStart,
    facility:      FACILITY,
    row_count:     rows.length,
    truncated:     rows.length >= 9500,
    hourly_target: HOURLY_TARGET,
    hours,          // array of PDT hour integers shown as columns
    employees,      // [{employee, hours:{14:n,...}, total}]
    team_hours:    teamHours,
    team_total:    teamTotal,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`[${ts()}] ✓ shipping_live.json written (${employees.length} associates, ${shift} shift)`);

  // Git push handled by dc499_refresh.js (single coordinator — avoids concurrent push collisions)
  console.log(`[${ts()}] shipping_live.json ready — dc499_refresh will push on next cycle`);

  return employees.length;
}

// ── entry point ────────────────────────────────────────────────────────────────
async function main() {
  if (MODE_AUTH) {
    await doAuthFlow();
    return;
  }

  if (MODE_SERVE) {
    console.log(`[${ts()}] SCOUT Shipping Agent — serve mode, interval ${INTERVAL / 60000} min`);
    const token = await getAccessTokenSilent().catch(async e => {
      if (e instanceof AuthError) return doAuthFlow();
      throw e;
    });
    await fetchShippingLive(token);
    let busy = false;
    setInterval(async () => {
      // Skip if the last cycle is still running, so cycles never stack up
      if (busy) { console.log(`[${ts()}] Previous cycle still running — skipping this tick`); return; }
      busy = true;
      try {
        const t = await getAccessTokenSilent();
        await fetchShippingLive(t);
      } catch (e) {
        console.error(`[${ts()}] Error:`, e.message);
      } finally {
        busy = false;
      }
    }, INTERVAL);
    return;
  }

  const token = await getAccessToken();
  await fetchShippingLive(token);
}

main().catch(e => { console.error(e.message); process.exit(1); });
