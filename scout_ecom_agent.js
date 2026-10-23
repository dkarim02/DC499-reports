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
const { SQL_TZ, currentShift, pacificDateStr } = require('./scout_tz');  // DST-aware local time
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

function shiftStartUtc(now = new Date()) {
  // 1st shift: 3:00 AM–2:00 PM local; 2nd shift: 2:10 PM–3:00 AM local (DST-aware)
  const sh = currentShift({ firstFrom: 3, secondFrom: 14, firstStart: [3, 0], secondStart: [14, 10] }, now);
  return { utc: sh.startSql, label: sh.label };
}

// ── SQL builder ────────────────────────────────────────────────────────────────
// Location columns follow the MAWM CSV export: Current = where the scan went (target),
// Previous = where it came from (source). Ecom_v3.html's P1-PK replen rule reads Current.
//
// withOwner (Group A only): adds an `Owner` column = which dept the shelf belongs to, read from
// the shelf's pick allocation zone in DCI_LOCATION (target shelf first, source as fallback).
// 'Retail' = PAZ_*RETAIL* (F1H/P1H/F2H/P2H/R1H/R2H + A1A0101A01), 'Ecom' = PAZ_*ECOM* / PAZ_ReplenArea*,
// 'Other' = RTV / Unallocated, null = no zone (staging, P1-PK, Z1). Ecom_v3.html drops only 'Retail'
// rows; scout_reserve_agent.js counts only 'Retail' — same rule on both sides. Replaced the
// "3rd character = H" guess 2026-10-19; checked 10/16–10/19, both rules matched on every replen row.
// LOCATION_ID is unique per PROFILE_ID, so the joins never add rows.
const OWNER_SQL = `CASE
    WHEN COALESCE(lt.PICK_ALLOCATION_ZONE_ID, ls.PICK_ALLOCATION_ZONE_ID) LIKE '%RETAIL%' THEN 'Retail'
    WHEN COALESCE(lt.PICK_ALLOCATION_ZONE_ID, ls.PICK_ALLOCATION_ZONE_ID) LIKE '%ECOM%'
      OR COALESCE(lt.PICK_ALLOCATION_ZONE_ID, ls.PICK_ALLOCATION_ZONE_ID) LIKE 'PAZ_ReplenArea%' THEN 'Ecom'
    WHEN COALESCE(lt.PICK_ALLOCATION_ZONE_ID, ls.PICK_ALLOCATION_ZONE_ID) IS NOT NULL THEN 'Other'
  END`;
function buildSql(shiftStart, txGroup, criteriaFilter = null, withOwner = false) {
  const txList = txGroup.map(t => `'${t.replace(/'/g, "''")}'`).join(',');
  const criteriaClause = criteriaFilter ? `\n  AND t.CRITERIA_ID = '${criteriaFilter}'` : '';
  const ownerCol  = withOwner ? `,\n  ${OWNER_SQL}                                            AS \`Owner\`` : '';
  const ownerJoin = withOwner ? `
LEFT JOIN default_dcinventory.DCI_LOCATION lt ON lt.LOCATION_ID = t.TARGET_LOCATION_ID AND lt.PROFILE_ID = '${FACILITY}'
LEFT JOIN default_dcinventory.DCI_LOCATION ls ON ls.LOCATION_ID = t.SOURCE_LOCATION_ID AND ls.PROFILE_ID = '${FACILITY}'` : '';
  return `
SELECT
  t.USER_ID                                              AS \`Employee\`,
  t.TRANSACTION_ID                                       AS \`Transaction ID\`,
  CONVERT_TZ(t.ACTIVITY_DATE_TIME, '+00:00', ${SQL_TZ}) AS \`Activity Datetime\`,
  t.QUANTITY                                             AS \`Quantity\`,
  t.COMPLETED_QUANTITY                                   AS \`Completed Quantity\`,
  t.TRACE_ID                                             AS \`CP Trace Id\`,
  t.CONTAINER_ID                                         AS \`Container ID\`,
  t.TARGET_LOCATION_ID                                   AS \`Current Location\`,
  t.SOURCE_LOCATION_ID                                   AS \`Previous Location\`,
  t.TARGET_LOCATION_ID                                   AS \`Target Location\`,
  t.CRITERIA_ID                                          AS \`Criteria\`${ownerCol}
FROM default_task.TSK_ACTIVITY_TRACKING t${ownerJoin}
WHERE t.FACILITY_ID = '${FACILITY}'
  AND t.CREATED_TIMESTAMP >= '${shiftStart}'
  AND t.TRANSACTION_ID IN (${txList})${criteriaClause}
ORDER BY t.ACTIVITY_DATE_TIME ASC`.trim();
}

// ── flow queues ("Where to put people now", 2026-10-22) ──────────────────────
// Work waiting at each Ecom step. The page divides it by the step's last-60-min rate (from the
// rows above) to get hours behind. Idea from Shubham's retail staffing card, built for the
// Ecom flow: replen → pick → sort → pack.
// Pick + replen = open task lines (detail STATUS 1000 = not done). The task's TRANSACTION_ID decides,
// not the shelf: reserve also holds RTV LPN PICK work on Ecom shelves (250 u on 10/22). Replen =
// the iLPN Replen Pull leg into an Ecom-owned shelf (same OWNER_SQL rule as the tiles).
// Sort = units in totes at the putwall drop zones (D1-PW-*), pack = units at D1-SN-* (Ready for Pack).
// Released work only: orders waiting for a batch are not counted.
const FLOW_PICK_TX   = ['Ecom Mezz Pick To Putwall Cart', 'Ecom Non-Mezz Pick To Putwall Cart'];
const FLOW_REPLEN_TX = ['iLPN Replen Pull', 'iLPN Replen Pull Large'];
const FLOW_OPEN_DAYS = 30;
function sqlFlowTasks() {
  const tx = FLOW_PICK_TX.concat(FLOW_REPLEN_TX).map(t => `'${t}'`).join(',');
  const pick = FLOW_PICK_TX.map(t => `'${t}'`).join(',');
  return `
SELECT CASE WHEN k.TRANSACTION_ID IN (${pick}) THEN 'pick' ELSE 'replen' END AS step,
  ${OWNER_SQL} AS owner,
  SUM(d.QUANTITY) AS units, COUNT(*) AS line_ct, MIN(d.CREATED_TIMESTAMP) AS oldest_utc
FROM default_pickpack.TSK_TASK_DETAIL d
JOIN default_task.TSK_TASK k ON k.TASK_ID = d.TASK_ID AND k.FACILITY_ID = d.FACILITY_ID
LEFT JOIN default_dcinventory.DCI_LOCATION lt ON lt.LOCATION_ID = d.TARGET_LOCATION_ID AND lt.PROFILE_ID = '${FACILITY}'
LEFT JOIN default_dcinventory.DCI_LOCATION ls ON ls.LOCATION_ID = d.SOURCE_LOCATION_ID AND ls.PROFILE_ID = '${FACILITY}'
WHERE d.FACILITY_ID = '${FACILITY}' AND d.STATUS = '1000'
  AND d.TYPE_ID IN ('PICK/PACK','REPLENISHMENT')
  AND d.CREATED_TIMESTAMP >= NOW() - INTERVAL ${FLOW_OPEN_DAYS} DAY
  AND k.TRANSACTION_ID IN (${tx})
GROUP BY 1, 2`.trim();
}
function sqlFlowStaged() {
  return `
SELECT CASE WHEN il.CURRENT_LOCATION_ID LIKE 'D1-PW%' THEN 'sort' ELSE 'pack' END AS step,
  COUNT(DISTINCT il.ILPN_ID) AS lpns, SUM(inv.ON_HAND) AS units, MIN(il.UPDATED_TIMESTAMP) AS oldest_utc
FROM default_dcinventory.DCI_ILPN il
JOIN default_dcinventory.DCI_INVENTORY inv ON inv.ILPN_ID = il.ILPN_ID AND inv.FACILITY_ID = il.FACILITY_ID
WHERE il.FACILITY_ID = '${FACILITY}'
  AND (il.CURRENT_LOCATION_ID LIKE 'D1-PW%' OR il.CURRENT_LOCATION_ID LIKE 'D1-SN%')
  AND inv.ON_HAND > 0
GROUP BY 1`.trim();
}
// Break windows from the LMS schedule (LMC_SCHEDULED_EVENT, 2026-10-22). Shift IDs start with the
// shift number (1MALLA/1SALLC, 2MALLB/2SALLD; same times every day). Each row is a WINDOW in which
// each person takes MAXIMUM_DURATION minutes (breaks are staggered). Times sit on a 1970 date in UTC
// and were entered in PST: 2nd-shift lunch 02:15 UTC = 6:15 PM, the lunch the Ecom page already used.
// So local = UTC - 8 h, fixed (no DST shift). Read once per BREAKS_TTL_MS; on failure the old value
// stays (and the page falls back to its 6:15-6:45 PM lunch).
const BREAKS_TTL_MS = 6 * 3600e3;
let breaksCache = { at: 0, rows: null };
async function fetchBreaks(accessToken) {
  if (breaksCache.rows && Date.now() - breaksCache.at < BREAKS_TTL_MS) return breaksCache.rows;
  try {
    const r = await mcpQuery(accessToken, `
SELECT DISTINCT LEFT(SHIFT_ID,1) AS shift, ACTIVITY_ID AS activity,
  TIME_FORMAT(START_TIME,'%H:%i') AS start_utc, TIME_FORMAT(END_TIME,'%H:%i') AS end_utc,
  MAXIMUM_DURATION AS max_min
FROM default_lmcore.LMC_SCHEDULED_EVENT
WHERE PROFILE_ID = '${FACILITY}' AND ACTIVITY_ID IN ('Paid Break','Unpaid Break')
  AND (EFFECTIVE_END_DATETIME IS NULL OR EFFECTIVE_END_DATETIME > NOW())`.trim());
    const pst = hm => { const [h, m] = hm.split(':').map(Number); const t = (h * 60 + m - 480 + 1440) % 1440;
      return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };
    const rows = (r.rows || []).filter(x => x.start_utc && x.end_utc && /^[12]$/.test(x.shift))
      .map(x => ({ shift: x.shift === '1' ? '1st' : '2nd', kind: x.activity === 'Unpaid Break' ? 'lunch' : 'break',
                   start: pst(x.start_utc), end: pst(x.end_utc), max_min: Number(x.max_min) || 0 }));
    if (rows.length) breaksCache = { at: Date.now(), rows };
  } catch (e) {
    console.warn(`[${ts()}] ⚠ break schedule read failed (keeping last): ${e.message}`);
  }
  return breaksCache.rows;
}

// {generated, steps:{replen|pick|sort|pack: {units, lines|lpns, oldest_utc}}, breaks:[...]}. Fail-soft: null.
async function fetchFlow(accessToken) {
  try {
    const [rt, rs, breaks] = await Promise.all([
      mcpQuery(accessToken, sqlFlowTasks()),
      mcpQuery(accessToken, sqlFlowStaged()),
      fetchBreaks(accessToken),
    ]);
    const steps = {};
    const add = (k, units, cnt, cntKey, oldest) => {
      const s = steps[k] || (steps[k] = { units: 0, [cntKey]: 0, oldest_utc: null });
      s.units += Math.round(Number(units) || 0);
      s[cntKey] += Number(cnt) || 0;
      if (oldest && (!s.oldest_utc || String(oldest) < s.oldest_utc)) s.oldest_utc = String(oldest);
    };
    for (const r of rt.rows || []) {
      if (r.step === 'replen' && r.owner === 'Retail') continue;   // Retail shelf = Reserve's replen
      add(r.step, r.units, r.line_ct, 'lines', r.oldest_utc);
    }
    for (const r of rs.rows || []) add(r.step, r.units, r.lpns, 'lpns', r.oldest_utc);
    for (const k of ['replen', 'pick']) steps[k] = steps[k] || { units: 0, lines: 0, oldest_utc: null };
    for (const k of ['sort', 'pack'])   steps[k] = steps[k] || { units: 0, lpns: 0, oldest_utc: null };
    console.log(`[${ts()}] Flow queues: replen ${steps.replen.units} · pick ${steps.pick.units} · sort ${steps.sort.units} · pack ${steps.pack.units} u`);
    return { generated: new Date().toISOString(), steps, breaks };
  } catch (e) {
    console.warn(`[${ts()}] ⚠ flow queues failed (card will say unavailable): ${e.message}`);
    return null;
  }
}

// ── history snapshot ───────────────────────────────────────────────────────────
// Retail shelf? Uses the Owner column from the query (see OWNER_SQL). Rows without it fall back
// to the old guess: zone H (3rd character 'H') in any location field.
function isRetailRow(r) {
  if ('Owner' in r) return r['Owner'] === 'Retail';
  return ['Current Location', 'Previous Location', 'Target Location']
    .some(k => { const l = (r[k] || '').trim(); return l.length >= 3 && l[2].toUpperCase() === 'H'; });
}

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
      // Same rule as Ecom_v3.html replenRowCounts(): no P1-PK drops, no Retail-shelf fills.
      // Added 2026-10-19; history before that counted Retail fills (also on Reserve) as Ecom replen.
      if (!/^P1-PK/i.test(curLoc) && !isRetailRow(r)) m.replen += parseFloat(r['Completed Quantity']) || 0;
    } else if (tx === 'System Directed Putaway' || tx === 'User Directed Putaway') {
      // Putaway into Retail shelves (R1H/R2H/F2H/P2H…) is Reserve's work — excluded from 2026-10-19 (v3.4)
      if (!isRetailRow(r)) m.putaway += 1;
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

  // Local date the shift started on
  const date = pacificDateStr(new Date(shiftStartUtcStr.replace(' ', 'T') + 'Z'));

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
  const [respA, respB, respC, respD, respE, flow] = await Promise.all([
    mcpQuery(accessToken, buildSql(shiftStart, ECOM_TX_A, null, true)),
    mcpQuery(accessToken, buildSql(shiftStart, ECOM_TX_B)),
    mcpQuery(accessToken, buildSql(shiftStart, ECOM_TX_C)),
    mcpQuery(accessToken, buildSql(shiftStart, ECOM_TX_D)),
    mcpQuery(accessToken, buildSql(shiftStart, ECOM_TX_E, 'NRDR_SORT_TO_PUTWALL_CUBBIES_CRITERIA')),
    fetchFlow(accessToken),
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
    flow:         flow,
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
