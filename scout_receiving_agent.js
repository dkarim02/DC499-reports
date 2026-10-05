#!/usr/bin/env node
/**
 * SCOUT — Receiving Live Agent
 * Queries RCV_RECEIPT for associate scans this shift and writes receiving_live.json.
 * Moved out of dc499_refresh.js 2026-10-05 — its 3 RCV_RECEIPT queries were the slowest
 * part of the 2-min live cycle. dc499_refresh still serves + pushes the file.
 *
 * Usage:
 *   node scout_receiving_agent.js            one-shot refresh
 *   node scout_receiving_agent.js --once     one-shot, silent token only (never opens a browser)
 *   node scout_receiving_agent.js --auth     first-time auth / re-auth
 *   node scout_receiving_agent.js --serve    auto-refresh every 3 min
 *   node scout_receiving_agent.js --serve --interval=3
 */

const fs     = require('fs');
const path   = require('path');
require('./scout_file_mirror');  // also writes filedata/*.js so pages work from OneDrive (file://)
const { SQL_TZ, currentShift } = require('./scout_tz');  // DST-aware local time

// ── config ─────────────────────────────────────────────────────────────────────
const OUTPUT_FILE   = path.join(__dirname, 'receiving_live.json');
const REDIRECT_PORT = 3127;
const FACILITY      = '499';

const args       = process.argv.slice(2);
const MODE_AUTH  = args.includes('--auth');
const MODE_SERVE = args.includes('--serve');
const INTERVAL   = (() => {
  const f = args.find(a => a.startsWith('--interval='));
  return f ? parseInt(f.split('=')[1]) * 60 * 1000 : 3 * 60 * 1000; // default 3 min
})();

// ── MCP login + queries — shared by every agent, see scout_mcp.js ─────────────
const mcp = require('./scout_mcp')({ redirectPort: REDIRECT_PORT });
const { doAuthFlow, getAccessToken, AuthError, getAccessTokenSilent, mcpQuery } = mcp;

// ── helpers ────────────────────────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
}

function fmtHHmm(ts) {
  if (!ts) return null;
  try {
    const d = new Date(ts);
    return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
  } catch { return ts; }
}

function shiftLabel() {
  const h = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })).getHours();
  if (h >= 6  && h < 14) return '1st';
  if (h >= 14 && h < 22) return '2nd';
  return '3rd';
}

// ── receiving query ────────────────────────────────────────────────────────────
async function fetchReceiving(accessToken) {
  // 1st 6:00 AM–1:59 PM, 2nd from 2:00 PM local (DST-aware); before 6 AM = yesterday's 2nd
  const rcvShift = currentShift({ firstFrom: 6, secondFrom: 14, firstStart: [6, 0], secondStart: [14, 0] });
  const shiftStartUtc = rcvShift.startSql;

  const sqlAssociates = `
SELECT
    CREATED_BY,
    COUNT(DISTINCT LPN_ID) AS lpns,
    SUM(CASE WHEN PROCESS = '/lpn/receive' THEN QUANTITY ELSE 0 END) AS units,
    MIN(CONVERT_TZ(CREATED_TIMESTAMP, '+00:00', ${SQL_TZ})) AS first_scan,
    MAX(CONVERT_TZ(CREATED_TIMESTAMP, '+00:00', ${SQL_TZ})) AS last_scan
FROM default_receiving.RCV_RECEIPT
WHERE FACILITY_ID = '${FACILITY}'
  AND CREATED_TIMESTAMP >= '${shiftStartUtc}'
  AND CREATED_BY != 'system-msg-user@${FACILITY}'
GROUP BY CREATED_BY
ORDER BY lpns DESC`.trim();

  const sqlHourly = `
SELECT
    HOUR(CONVERT_TZ(CREATED_TIMESTAMP, '+00:00', ${SQL_TZ})) AS hr,
    COUNT(DISTINCT LPN_ID) AS lpns,
    SUM(CASE WHEN PROCESS = '/lpn/receive' THEN QUANTITY ELSE 0 END) AS units
FROM default_receiving.RCV_RECEIPT
WHERE FACILITY_ID = '${FACILITY}'
  AND CREATED_TIMESTAMP >= '${shiftStartUtc}'
  AND CREATED_BY != 'system-msg-user@${FACILITY}'
GROUP BY hr
ORDER BY hr ASC`.trim();

  const sqlAssocHourly = `
SELECT
    CREATED_BY,
    HOUR(CONVERT_TZ(CREATED_TIMESTAMP, '+00:00', ${SQL_TZ})) AS hr,
    COUNT(DISTINCT LPN_ID) AS lpns
FROM default_receiving.RCV_RECEIPT
WHERE FACILITY_ID = '${FACILITY}'
  AND CREATED_TIMESTAMP >= '${shiftStartUtc}'
  AND CREATED_BY != 'system-msg-user@${FACILITY}'
GROUP BY CREATED_BY, hr
ORDER BY CREATED_BY, hr ASC`.trim();

  const [resp, respHourly, respAssocHourly] = await Promise.all([
    mcpQuery(accessToken, sqlAssociates),
    mcpQuery(accessToken, sqlHourly),
    mcpQuery(accessToken, sqlAssocHourly),
  ]);

  // Per-associate hourly map: name -> { hr: lpns }
  const assocHourMap = {};
  for (const r of (respAssocHourly.rows || [])) {
    const name = r.CREATED_BY.toLowerCase().split('@')[0];
    if (!assocHourMap[name]) assocHourMap[name] = {};
    assocHourMap[name][Number(r.hr)] = Number(r.lpns);
  }

  const associates = (resp.rows || []).map(r => {
    const name = r.CREATED_BY.toLowerCase().split('@')[0];
    return {
      name,
      lpns:       Number(r.lpns),
      units:      Math.round(Number(r.units)),
      first_scan: fmtHHmm(r.first_scan),
      last_scan:  fmtHHmm(r.last_scan),
      hours:      assocHourMap[name] || {},
    };
  });

  const hourly = (respHourly.rows || []).map(r => ({
    hour:  Number(r.hr),
    lpns:  Number(r.lpns),
    units: Math.round(Number(r.units)),
  }));

  const hours = hourly.map(h => h.hour);

  return {
    generated:  new Date().toISOString().slice(0, 19),
    shift:      shiftLabel(),
    facility:   FACILITY,
    associates,
    hourly,
    hours,
  };
}

async function runOnce(accessToken) {
  const start = Date.now();
  const data = await fetchReceiving(accessToken);
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 4));
  console.log(`[${ts()}] ✓ receiving_live.json — ${data.associates.length} associates (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  // Git push handled by dc499_refresh.js (single coordinator — avoids concurrent push collisions)
}

// ── entry point ────────────────────────────────────────────────────────────────
async function main() {
  if (MODE_AUTH) {
    await doAuthFlow();
    return;
  }

  if (MODE_SERVE) {
    console.log(`[${ts()}] SCOUT Receiving Agent — serve mode, interval ${INTERVAL / 60000} min`);
    const token = await getAccessTokenSilent().catch(async e => {
      if (e instanceof AuthError) return doAuthFlow();
      throw e;
    });
    await runOnce(token).catch(e => console.error(`[${ts()}] Error:`, e.message));
    let busy = false;
    setInterval(async () => {
      // Skip if the last cycle is still running, so cycles never stack up
      if (busy) { console.log(`[${ts()}] Previous cycle still running — skipping this tick`); return; }
      busy = true;
      try {
        const t = await getAccessTokenSilent();
        await runOnce(t);
      } catch (e) {
        console.error(`[${ts()}] Error:`, e.message);
      } finally {
        busy = false;
      }
    }, INTERVAL);
    return;
  }

  // --once = silent token only (safe to run from Claude Code while serve agents run)
  const token = args.includes('--once') ? await getAccessTokenSilent() : await getAccessToken();
  await runOnce(token);
}

main().catch(e => { console.error(e.message); process.exit(1); });
