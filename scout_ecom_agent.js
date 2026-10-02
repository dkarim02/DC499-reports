#!/usr/bin/env node
/**
 * SCOUT — Ecom Live Agent
 * Queries LMC_EVENT_SUMMARY_HEADER for Ecom transaction data and writes ecom_live.json.
 * Rows are aliased to match the CSV column names that Ecom_v3.html expects, so
 * processData() can consume them with zero changes.
 *
 * Usage:
 *   node scout_ecom_agent.js            one-shot refresh
 *   node scout_ecom_agent.js --auth     first-time auth / re-auth
 *   node scout_ecom_agent.js --serve    auto-refresh every 30 min
 *   node scout_ecom_agent.js --serve --interval=15
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
const OUTPUT_FILE   = path.join(__dirname, 'ecom_live.json');
const HISTORY_FILE  = path.join(__dirname, 'ecom_history.json');
const HISTORY_MAX   = 14; // 6 days × 2 shifts + buffer
const CLIENT_ID     = 'https://claude.ai/oauth/claude-code-client-metadata';
const REDIRECT_PORT = 3119; // different port from dc499_refresh.js (3118)
const REDIRECT_URI  = `http://localhost:${REDIRECT_PORT}/callback`;
const FACILITY      = '499';

const args       = process.argv.slice(2);
const MODE_AUTH  = args.includes('--auth');
const MODE_SERVE = args.includes('--serve');
const INTERVAL   = (() => {
  const f = args.find(a => a.startsWith('--interval='));
  return f ? parseInt(f.split('=')[1]) * 60 * 1000 : 30 * 60 * 1000; // default 30 min
})();

// ── Ecom transaction IDs — five groups to stay under MCP ~10k row cap ───────────
// Group A: replen + putaway        (~2k rows typical)
// Group B: picking                 (~4k rows typical)
// Group C: packing alone           (~3k rows typical)
// Group D: shipping only           (~3k rows typical)
// Group E: sorting only            (~4k rows typical on busy days)
const ECOM_TX_A = [
  'iLPN Replen Fill',
  'iLPN Replen Pull',
  'iLPN Replen Fill Large',
  'iLPN Replen Pull Large',
  'System Directed Putaway',
  'User Directed Putaway',
];
const ECOM_TX_B = [
  'Ecom Mezz Pick To Putwall Cart',
  'Ecom Non-Mezz Pick To Putwall Cart',
  'Ecom Singles Bulk LPN Pick',
];
const ECOM_TX_C = [
  'NRDR CORE PACK FOR ECOM PACK STATION',
];
const ECOM_TX_D = [
  'OB Putaway By Ship Via',
  'NRDR Load Parcel Packages',
];
const ECOM_TX_E = [
  'OB Sort To Putwall Cubby',
];

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
  // 1st shift: 3:00 AM–2:00 PM PDT = 10:00–21:00 UTC
  // 2nd shift: 2:10 PM–2:00 AM PDT = 21:10 UTC (next UTC day before 10:00)
  const is1st = h >= 10 && h < 21;
  const start = new Date(nowUtc);
  if (is1st) {
    start.setUTCHours(10, 0, 0, 0);
  } else {
    start.setUTCHours(21, 10, 0, 0);
    if (h < 10) start.setUTCDate(start.getUTCDate() - 1);
  }
  return {
    utc: start.toISOString().replace('T', ' ').slice(0, 19),
    label: is1st ? '1st' : '2nd',
  };
}

// ── SQL builder ────────────────────────────────────────────────────────────────
function buildSql(shiftStart, txGroup, criteriaFilter = null) {
  const txList = txGroup.map(t => `'${t.replace(/'/g, "''")}'`).join(',');
  const criteriaClause = criteriaFilter ? `\n  AND t.CRITERIA_ID = '${criteriaFilter}'` : '';
  return `
SELECT
  t.USER_ID                                              AS \`Employee\`,
  t.TRANSACTION_ID                                       AS \`Transaction ID\`,
  CONVERT_TZ(t.ACTIVITY_DATE_TIME, '+00:00', '-07:00')   AS \`Activity Datetime\`,
  t.QUANTITY                                             AS \`Quantity\`,
  t.COMPLETED_QUANTITY                                   AS \`Completed Quantity\`,
  t.TRACE_ID                                             AS \`CP Trace Id\`,
  t.CONTAINER_ID                                         AS \`Container ID\`,
  t.SOURCE_LOCATION_ID                                   AS \`Current Location\`,
  ''                                                     AS \`Previous Location\`,
  t.TARGET_LOCATION_ID                                   AS \`Target Location\`,
  t.CRITERIA_ID                                          AS \`Criteria\`
FROM default_task.TSK_ACTIVITY_TRACKING t
WHERE t.FACILITY_ID = '${FACILITY}'
  AND t.CREATED_TIMESTAMP >= '${shiftStart}'
  AND t.TRANSACTION_ID IN (${txList})${criteriaClause}
ORDER BY t.ACTIVITY_DATE_TIME ASC`.trim();
}

// ── history snapshot ───────────────────────────────────────────────────────────
function updateEcomHistory(rows, shift, shiftStartUtcStr) {
  const SORT_CRITERIA = 'NRDR_SORT_TO_PUTWALL_CUBBIES_CRITERIA';
  const SHIPPING_2ND = 'OB Putaway By Ship Via';
  const SHIPPING_1ST = 'NRDR Load Parcel Packages';
  const shippingTx = shift === '1st' ? SHIPPING_1ST : SHIPPING_2ND;

  // Build per-associate totals
  const empMap = {};
  const shippingContainers = {}; // emp -> Set<containerID>

  function emp(r) { return (r['Employee'] || '').trim().toLowerCase(); }

  rows.forEach(r => {
    const e = emp(r);
    if (!e) return;
    const tx = (r['Transaction ID'] || '').trim();
    if (!empMap[e]) empMap[e] = { replen:0, putaway:0, picking:0, packing:0, shipping:0, sorting:0 };
    const m = empMap[e];

    if (tx === 'iLPN Replen Fill' || tx === 'iLPN Replen Fill Large') {
      const curLoc = (r['Current Location'] || '').trim();
      if (!/^P1-PK/i.test(curLoc)) m.replen += parseFloat(r['Completed Quantity']) || 0;
    } else if (tx === 'System Directed Putaway' || tx === 'User Directed Putaway') {
      m.putaway += 1;
    } else if (tx === 'Ecom Mezz Pick To Putwall Cart' || tx === 'Ecom Non-Mezz Pick To Putwall Cart' || tx === 'Ecom Singles Bulk LPN Pick') {
      m.picking += parseFloat(r['Quantity']) || 0;
    } else if (tx === 'NRDR CORE PACK FOR ECOM PACK STATION') {
      const cid = (r['Container ID'] || '').trim();
      if (!cid.startsWith('T')) m.packing += parseFloat(r['Quantity']) || 0;
    } else if (tx === shippingTx) {
      const cid = (r['Container ID'] || '').trim();
      if (cid) {
        if (!shippingContainers[e]) shippingContainers[e] = new Set();
        shippingContainers[e].add(cid);
      }
    } else if (tx === 'OB Sort To Putwall Cubby' && (r['Criteria'] || '').trim() === SORT_CRITERIA) {
      m.sorting += parseFloat(r['Quantity']) || 0;
    }
  });

  // Merge shipping container counts
  Object.keys(shippingContainers).forEach(e => {
    if (!empMap[e]) empMap[e] = { replen:0, putaway:0, picking:0, packing:0, shipping:0, sorting:0 };
    empMap[e].shipping = shippingContainers[e].size;
  });

  // Build associates array, skip zeros
  const associates = Object.entries(empMap)
    .map(([email, d]) => {
      const total = d.replen + d.putaway + d.picking + d.packing + d.shipping + d.sorting;
      return { email, ...d, total };
    })
    .filter(a => a.total > 0)
    .sort((a, b) => b.total - a.total);

  // Derive PDT date string from shift start UTC
  const shiftStartDate = new Date(shiftStartUtcStr.replace(' ', 'T') + '-07:00');
  const date = shiftStartDate.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

  const snapshot = { date, shift, generated: new Date().toISOString(), associates };

  // Load existing history, upsert, trim, save
  let history = [];
  try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch {}
  const idx = history.findIndex(e => e.date === date && e.shift === shift);
  if (idx !== -1) history[idx] = snapshot;
  else history.push(snapshot);

  // Sort newest first, trim to max
  history.sort((a, b) => {
    const cmp = b.date.localeCompare(a.date);
    if (cmp !== 0) return cmp;
    return b.shift.localeCompare(a.shift); // '2nd' > '1st'
  });
  history = history.slice(0, HISTORY_MAX);

  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  console.log(`[${ts()}] ✓ ecom_history.json updated — ${date} ${shift} (${associates.length} associates)`);
}

// ── main fetch ─────────────────────────────────────────────────────────────────
async function fetchEcomLive(accessToken) {
  const { utc: shiftStart, label: shift } = shiftStartUtc();

  console.log(`[${ts()}] Querying Groups A-E in parallel since ${shiftStart}...`);
  const [respA, respB, respC, respD, respE] = await Promise.all([
    mcpQuery(accessToken, buildSql(shiftStart, ECOM_TX_A)),
    mcpQuery(accessToken, buildSql(shiftStart, ECOM_TX_B)),
    mcpQuery(accessToken, buildSql(shiftStart, ECOM_TX_C)),
    mcpQuery(accessToken, buildSql(shiftStart, ECOM_TX_D)),
    mcpQuery(accessToken, buildSql(shiftStart, ECOM_TX_E, 'NRDR_SORT_TO_PUTWALL_CUBBIES_CRITERIA')),
  ]);
  const rowsA = respA.rows || [];
  const rowsB = respB.rows || [];
  const rowsC = respC.rows || [];
  const rowsD = respD.rows || [];
  const rowsE = respE.rows || [];
  console.log(`[${ts()}] Group A: ${rowsA.length}  B: ${rowsB.length}  C: ${rowsC.length}  D: ${rowsD.length}  E: ${rowsE.length}`);
  if (rowsA.length >= 9500) console.warn(`[${ts()}] ⚠ Group A hit row cap — replen/putaway may be truncated`);
  if (rowsB.length >= 9500) console.warn(`[${ts()}] ⚠ Group B hit row cap — picking may be truncated`);
  if (rowsC.length >= 9500) console.warn(`[${ts()}] ⚠ Group C hit row cap — packing may be truncated`);
  if (rowsD.length >= 9500) console.warn(`[${ts()}] ⚠ Group D hit row cap — shipping may be truncated`);
  if (rowsE.length >= 9500) console.warn(`[${ts()}] ⚠ Group E hit row cap — sorting (criteria-filtered) may be truncated`);

  const rows = rowsA.concat(rowsB, rowsC, rowsD, rowsE);
  const truncated = rowsA.length >= 9500 || rowsB.length >= 9500 || rowsC.length >= 9500 || rowsD.length >= 9500 || rowsE.length >= 9500;
  console.log(`[${ts()}] Total: ${rows.length} rows combined${truncated ? ' ⚠ (truncated)' : ''}`);

  const output = {
    generated:   new Date().toISOString(),
    shift:        shift,
    shift_start:  shiftStart,
    facility:     FACILITY,
    row_count:    rows.length,
    truncated:    truncated,
    rows:         rows,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`[${ts()}] ✓ ecom_live.json written (${rows.length} rows, ${shift} shift)`);

  // 2nd shift: only snapshot after 7h in (~9:10 PM PDT) to avoid saving mid-shift numbers
  // 1st shift: always snapshot — agent runs at shift transition so numbers are already complete
  const shiftStartDate = new Date(shiftStart.replace(' ', 'T') + 'Z');
  const minsIntoShift = (new Date() - shiftStartDate) / 60000;
  const historyReady = shift === '1st' || minsIntoShift >= 7 * 60;
  if (historyReady) {
    try { updateEcomHistory(rows, shift, shiftStart); }
    catch (e) { console.error(`[${ts()}] ⚠ ecom_history.json update failed: ${e.message}`); }
  } else {
    console.log(`[${ts()}] history snapshot skipped — 2nd shift, ${Math.round(minsIntoShift)}min in (gate: ≥420min)`);
  }

  // Git push handled by dc499_refresh.js (single coordinator — avoids concurrent push collisions)
  console.log(`[${ts()}] ecom_live.json ready — dc499_refresh will push on next cycle`);

  return rows.length;
}

// ── entry point ────────────────────────────────────────────────────────────────
async function main() {
  if (MODE_AUTH) {
    await doAuthFlow();
    return;
  }

  if (MODE_SERVE) {
    console.log(`[${ts()}] SCOUT Ecom Agent — serve mode, interval ${INTERVAL / 60000} min`);
    const token = await getAccessTokenSilent().catch(async e => {
      if (e instanceof AuthError) { return doAuthFlow(); }
      throw e;
    });
    await fetchEcomLive(token);
    let busy = false;
    setInterval(async () => {
      // Skip if the last cycle is still running, so cycles never stack up
      if (busy) { console.log(`[${ts()}] Previous cycle still running — skipping this tick`); return; }
      busy = true;
      try {
        const t = await getAccessTokenSilent();
        await fetchEcomLive(t);
      } catch (e) {
        console.error(`[${ts()}] Error:`, e.message);
      } finally {
        busy = false;
      }
    }, INTERVAL);
    return;
  }

  // One-shot
  const token = await getAccessToken();
  await fetchEcomLive(token);
}

main().catch(e => { console.error(e.message); process.exit(1); });
