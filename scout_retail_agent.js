#!/usr/bin/env node
/**
 * SCOUT — Retail Backlog Agent
 * Queries DCO_ORDER for Retail (store replen) order progress by wave date.
 * Wave-based: one wave per week, date bucketing used as wave identifier.
 * Also writes zone workload (open/done pick + replen units per Pick Execution Zone, zone H).
 * Writes retail_backlog_live.json.
 *
 * Usage:
 *   node scout_retail_agent.js            one-shot refresh
 *   node scout_retail_agent.js --auth     first-time auth / re-auth
 *   node scout_retail_agent.js --serve    auto-refresh (default 5 min)
 *   node scout_retail_agent.js --serve --interval=10
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
const OUTPUT_FILE   = path.join(__dirname, 'retail_backlog_live.json');
const CLIENT_ID     = 'https://claude.ai/oauth/claude-code-client-metadata';
const REDIRECT_PORT = 3123;
const REDIRECT_URI  = `http://localhost:${REDIRECT_PORT}/callback`;
const FACILITY      = '499';
const LOOKBACK_DAYS = 90;

// Active statuses only — shipped (8000) and cancelled (9000) excluded
const ACTIVE_STATUSES = ['1000', '2090', '7100', '7200', '7800'];

const STATUS_LABELS = {
  '1000': 'Ready',
  '2090': 'Allocated',
  '7100': 'Packing',
  '7200': 'Packed',
  '7800': 'Loaded',
};

const args       = process.argv.slice(2);
const MODE_AUTH  = args.includes('--auth');
const MODE_SERVE = args.includes('--serve');
const INTERVAL   = (() => {
  const f = args.find(a => a.startsWith('--interval='));
  return f ? parseInt(f.split('=')[1]) * 60 * 1000 : 5 * 60 * 1000;
})();

// ── MCP login + queries — shared by every agent, see scout_mcp.js ─────────────
const mcp = require('./scout_mcp')({ redirectPort: REDIRECT_PORT });
const { doAuthFlow, getAccessToken, AuthError, getAccessTokenSilent, mcpQuery } = mcp;

// ── helpers ────────────────────────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
}

// Convert a PDT date string (YYYY-MM-DD) to UTC window for querying.
// PDT = UTC-7. Fix to UTC-8 (PST) ~Oct 25 2026 when DST ends.
function pdtDateToUtcWindow(pdtDate) {
  const [y, m, d] = pdtDate.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d, 7, 0, 0)); // midnight PDT = 07:00 UTC
  const end   = new Date(Date.UTC(y, m - 1, d + 1, 7, 0, 0));
  const fmt   = dt => dt.toISOString().replace('T', ' ').slice(0, 19);
  return { start: fmt(start), end: fmt(end) };
}

function lookbackUtc() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - LOOKBACK_DAYS);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

// Shift boundaries match scout_reserve_agent.js: 1st = 10:00 UTC, 2nd = 21:10 UTC (prev day if before 10:00).
function currentShift() {
  const now = new Date();
  const h   = now.getUTCHours();
  const is1st = h >= 10 && h < 22;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), is1st ? 10 : 21, is1st ? 0 : 10, 0));
  if (!is1st && h < 10) start.setUTCDate(start.getUTCDate() - 1);
  return { shift: is1st ? '1st' : '2nd', start: start.toISOString().replace('T', ' ').slice(0, 19) };
}

// ── zone work (Pick Execution Zones, zone H) ─────────────────────────────────
// Open work looks back 48 hrs so carryover lines still count. Done = completed this shift.
const ZONE_LOOKBACK_HRS = 48;

function sqlZoneWork(since, shiftStart) {
  const done = `STATUS = '8000' AND ACTUAL_END_TIME >= '${shiftStart}'`;
  return `
SELECT
  PICK_EXECUTION_ZONE_ID AS zone,
  SUM(CASE WHEN STATUS NOT IN ('8000','9000') THEN 1 ELSE 0 END)        AS open_lines,
  SUM(CASE WHEN STATUS NOT IN ('8000','9000') THEN QUANTITY ELSE 0 END) AS open_units,
  SUM(CASE WHEN ${done} THEN 1 ELSE 0 END)                              AS done_lines,
  SUM(CASE WHEN ${done} THEN COMPLETED_QUANTITY ELSE 0 END)             AS done_units
FROM default_task.TSK_TASK_DETAIL
WHERE FACILITY_ID = '${FACILITY}'
  AND CREATED_TIMESTAMP >= '${since}'
  AND PICK_EXECUTION_ZONE_ID LIKE 'PEZ_RTL%'
GROUP BY PICK_EXECUTION_ZONE_ID
`.trim();
}

function sqlZoneLocations() {
  return `
SELECT
  PICK_EXECUTION_ZONE_ID AS zone,
  LEFT(LOCATION_ID, 3) AS area,
  MIN(AISLE) AS a1, MAX(AISLE) AS a2,
  MIN(BAY)   AS b1, MAX(BAY)   AS b2,
  COUNT(*)   AS locs
FROM default_dcinventory.DCI_LOCATION
WHERE PROFILE_ID = '${FACILITY}'
  AND IS_ACTIVE = 1
  AND PICK_EXECUTION_ZONE_ID LIKE 'PEZ_RTL%'
GROUP BY PICK_EXECUTION_ZONE_ID, LEFT(LOCATION_ID, 3)
`.trim();
}

// PEZ_RTL_ZONE_3 → "Zone 3" · PEZ_RTL_ZONE_3_R1H → "R1H Zone 3" · PEZ_RTL_ZONE_F2H → "F2H Zone"
function zoneName(id) {
  let m;
  if ((m = id.match(/^PEZ_RTL_ZONE_(\d+)_([A-Z]\dH)$/))) return `${m[2]} Zone ${Number(m[1])}`;
  if ((m = id.match(/^PEZ_RTL_ZONE_(\d+)$/)))            return `Zone ${Number(m[1])}`;
  if ((m = id.match(/^PEZ_RTL_ZONE_([A-Z]\dH)$/)))       return `${m[1]} Zone`;
  return id.replace(/^PEZ_/, '').replace(/_/g, ' ');
}

// Replen zones pull from reserve shelving (R1H/R2H); everything else is picking.
function zoneKind(id, areas) {
  if (areas.length) return areas.every(a => a[0] === 'R') ? 'replen' : 'picks';
  return /_R\dH$/.test(id) ? 'replen' : 'picks';
}

function range(a, b) { return a === b ? a : `${a}–${b}`; }

async function fetchZoneWork(accessToken) {
  const { shift, start } = currentShift();
  const since = new Date(Date.now() - ZONE_LOOKBACK_HRS * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  const [workResp, locResp] = await Promise.all([
    mcpQuery(accessToken, sqlZoneWork(since, start)),
    mcpQuery(accessToken, sqlZoneLocations()),
  ]);

  const zones = {};
  const get = id => zones[id] || (zones[id] = { zone_id: id, areas: [], locations: 0, open_lines: 0, open_units: 0, done_lines: 0, done_units: 0 });

  for (const r of (locResp.rows || [])) {
    const z = get(r.zone);
    z.areas.push({ area: r.area, a1: r.a1, a2: r.a2, b1: r.b1, b2: r.b2 });
    z.locations += Number(r.locs) || 0;
  }
  for (const r of (workResp.rows || [])) {
    const z = get(r.zone);
    z.open_lines = Number(r.open_lines) || 0;
    z.open_units = Math.round(Number(r.open_units) || 0);
    z.done_lines = Number(r.done_lines) || 0;
    z.done_units = Math.round(Number(r.done_units) || 0);
  }

  const out = { shift, shift_start_utc: start, lookback_hours: ZONE_LOOKBACK_HRS, picks: [], replen: [] };
  for (const z of Object.values(zones)) {
    // Retired zones: no locations and no work — skip
    if (!z.locations && !z.open_lines && !z.done_lines) continue;
    const areaIds = z.areas.map(a => a.area).sort();
    const kind    = zoneKind(z.zone_id, areaIds);
    const where   = z.areas
      .sort((a, b) => a.area.localeCompare(b.area))
      .map(a => kind === 'replen'
        ? `${a.area} aisles ${range(a.a1, a.a2)} · bays ${range(a.b1, a.b2)}`
        : `${a.area} ${range(a.a1, a.a2)}`)
      .join(' + ');
    const floorSrc = areaIds[0] || (z.zone_id.match(/([A-Z]\dH)$/) || [])[1] || '';
    out[kind].push({
      zone_id:    z.zone_id,
      name:       zoneName(z.zone_id),
      where:      where || '—',
      floor:      Number(floorSrc[1]) || null,
      locations:  z.locations,
      open_lines: z.open_lines,
      open_units: z.open_units,
      done_lines: z.done_lines,
      done_units: z.done_units,
    });
  }
  const sum = (arr, k) => arr.reduce((s, z) => s + z[k], 0);
  console.log(`[${ts()}] Zones — picks: ${sum(out.picks, 'open_units')} open / ${sum(out.picks, 'done_units')} done · replen: ${sum(out.replen, 'open_units')} open / ${sum(out.replen, 'done_units')} done`);
  return out;
}

// ── queries ────────────────────────────────────────────────────────────────────

// Step 0: Get retail wave run IDs from the planning run table.
// ORDER_PLANNING_RUN_ID format: W{MMDDYYYY}{seq} — e.g. W09222026000000000005
// One retail run per week — date bucket matches wave_date from DCO_ORDER.
function sqlWaveRunIds(since) {
  return `
SELECT
  ORDER_PLANNING_RUN_ID AS run_id,
  DATE_FORMAT(CONVERT_TZ(CREATED_TIMESTAMP, '+00:00', '-07:00'), '%Y-%m-%d') AS run_date
FROM default_dcorder.DCO_ORDER_PLAN_RUN_STRATEGY
WHERE FACILITY_ID = '${FACILITY}'
  AND PLANNING_STRATEGY_ID = 'NRDR_CORE_RETAIL_ORDER_PLANNING_STRATEGY'
  AND CREATED_TIMESTAMP >= '${since}'
ORDER BY CREATED_TIMESTAMP DESC
`.trim();
}

// Step 1: Get all wave dates that still have active (non-shipped) orders.
function sqlActiveWaveDates(since) {
  return `
SELECT
  DATE_FORMAT(CONVERT_TZ(CREATED_TIMESTAMP, '+00:00', '-07:00'), '%Y-%m-%d') AS wave_date,
  COUNT(DISTINCT ORDER_ID) AS active_orders
FROM default_dcorder.DCO_ORDER
WHERE FACILITY_ID = '${FACILITY}'
  AND ORDER_TYPE = 'RETAIL'
  AND CANCELLED = 0
  AND MAXIMUM_STATUS NOT IN ('8000', '9000')
  AND CREATED_TIMESTAMP >= '${since}'
GROUP BY wave_date
ORDER BY wave_date DESC
`.trim();
}

// Step 2: Status breakdown for one wave date window.
// Bucket by MINIMUM_STATUS (where the order is blocked) not MAXIMUM_STATUS.
// An order with min=Allocated, max=Packed still has open allocated lines — it belongs in Allocated.
// MAXIMUM_STATUS filter still excludes fully shipped/cancelled orders.
function sqlStatusBreakdown(utcStart, utcEnd) {
  return `
SELECT
  MINIMUM_STATUS,
  COUNT(DISTINCT ORDER_ID) AS orders
FROM default_dcorder.DCO_ORDER
WHERE FACILITY_ID = '${FACILITY}'
  AND ORDER_TYPE = 'RETAIL'
  AND CANCELLED = 0
  AND CREATED_TIMESTAMP >= '${utcStart}'
  AND CREATED_TIMESTAMP < '${utcEnd}'
  AND MAXIMUM_STATUS NOT IN ('8000', '9000')
GROUP BY MINIMUM_STATUS
ORDER BY MINIMUM_STATUS
`.trim();
}

// Step 3: Unit counts by line STATUS for one wave date window.
// MAWM retail: ALLOCATED/PACKED/MANIFESTED_QUANTITY columns mirror ORDERED_QUANTITY (set once, never decremented).
// Correct approach: sum ORDERED_QUANTITY grouped by line STATUS, then bucket by status string.
// STATUS strings: ALLOCATED, PACKING, PACKED, LOADED, SHIPPED
function sqlUnitCounts(utcStart, utcEnd) {
  return `
SELECT
  ol.STATUS AS line_status,
  SUM(ol.ORDERED_QUANTITY) AS units
FROM default_dcorder.DCO_ORDER o
JOIN default_dcorder.DCO_ORDER_LINE ol
  ON ol.ORDER_ID = o.ORDER_ID AND ol.FACILITY_ID = o.FACILITY_ID
WHERE o.FACILITY_ID = '${FACILITY}'
  AND o.ORDER_TYPE = 'RETAIL'
  AND o.CANCELLED = 0
  AND o.CREATED_TIMESTAMP >= '${utcStart}'
  AND o.CREATED_TIMESTAMP < '${utcEnd}'
  AND o.MAXIMUM_STATUS NOT IN ('8000', '9000')
  AND ol.CANCELLED = 0
GROUP BY ol.STATUS
`.trim();
}

// Step 5: Allocated order list for one wave date window.
// Orders blocked at Allocated (MINIMUM_STATUS 2090) with their still-allocated lines/units — what's left to pick.
function sqlAllocatedOrders(utcStart, utcEnd) {
  return `
SELECT
  o.ORDER_ID,
  o.DESTINATION_FACILITY_ID AS store_id,
  COUNT(ol.ORDER_LINE_ID) AS line_count,
  SUM(ol.ORDERED_QUANTITY) AS units
FROM default_dcorder.DCO_ORDER o
JOIN default_dcorder.DCO_ORDER_LINE ol
  ON ol.ORDER_ID = o.ORDER_ID AND ol.FACILITY_ID = o.FACILITY_ID
WHERE o.FACILITY_ID = '${FACILITY}'
  AND o.ORDER_TYPE = 'RETAIL'
  AND o.CANCELLED = 0
  AND o.CREATED_TIMESTAMP >= '${utcStart}'
  AND o.CREATED_TIMESTAMP < '${utcEnd}'
  AND o.MAXIMUM_STATUS NOT IN ('8000', '9000')
  AND o.MINIMUM_STATUS = '2090'
  AND ol.CANCELLED = 0
  AND ol.STATUS = 'ALLOCATED'
GROUP BY o.ORDER_ID, o.DESTINATION_FACILITY_ID
ORDER BY units DESC
`.trim();
}

// Step 4: Store (destination facility) breakdown for one wave date window.
function sqlStoreBreakdown(utcStart, utcEnd) {
  return `
SELECT
  DESTINATION_FACILITY_ID AS store_id,
  COUNT(DISTINCT ORDER_ID) AS orders
FROM default_dcorder.DCO_ORDER
WHERE FACILITY_ID = '${FACILITY}'
  AND ORDER_TYPE = 'RETAIL'
  AND CANCELLED = 0
  AND CREATED_TIMESTAMP >= '${utcStart}'
  AND CREATED_TIMESTAMP < '${utcEnd}'
  AND MAXIMUM_STATUS NOT IN ('8000', '9000')
GROUP BY DESTINATION_FACILITY_ID
ORDER BY orders DESC
`.trim();
}

// Build a map of PDT date → full ORDER_PLANNING_RUN_ID from the planning run table.
// If multiple runs hit the same date, take the one with the highest sequence suffix.
function buildWaveNumMap(rows) {
  const map = {};
  for (const r of rows) {
    if (!r.run_id) continue;
    const seq = parseInt(r.run_id.slice(9), 10) || 0;
    const existing = map[r.run_date];
    const existingSeq = existing ? parseInt(existing.slice(9), 10) || 0 : -1;
    if (seq > existingSeq) map[r.run_date] = r.run_id;
  }
  return map;
}

// ── main fetch ─────────────────────────────────────────────────────────────────
async function fetchRetailBacklog(accessToken) {
  console.log(`[${ts()}] Retail Backlog — fetching active waves...`);
  const since = lookbackUtc();

  // Zone workload is best-effort — a failure here shouldn't block the wave data
  let zoneWork = null;
  try {
    zoneWork = await fetchZoneWork(accessToken);
  } catch (e) {
    console.warn(`[${ts()}] Zone work query failed (non-fatal):`, e.message);
  }

  // Step 0: Get wave run IDs for wave number labeling (best-effort)
  let waveNumMap = {};
  try {
    const resp = await mcpQuery(accessToken, sqlWaveRunIds(since));
    waveNumMap = buildWaveNumMap(resp.rows || []);
    console.log(`[${ts()}] Wave run IDs loaded: ${Object.keys(waveNumMap).length} dates`);
  } catch (e) {
    console.warn(`[${ts()}] Wave run ID query failed (non-fatal):`, e.message);
  }

  // Step 1: Get active wave dates
  let waveDates = [];
  try {
    const resp = await mcpQuery(accessToken, sqlActiveWaveDates(since));
    waveDates = (resp.rows || []).map(r => r.wave_date);
    console.log(`[${ts()}] Active waves found: ${waveDates.join(', ') || 'none'}`);
  } catch (e) {
    console.error(`[${ts()}] Wave date query failed:`, e.message);
    return;
  }

  if (!waveDates.length) {
    const output = {
      generated: new Date().toISOString(),
      facility: FACILITY,
      waves: [],
      zones: zoneWork,
    };
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
    console.log(`[${ts()}] ✓ retail_backlog_live.json written — no active waves`);
    return;
  }

  // Steps 2–5: For each wave, fire status + units + store + allocated-order queries in parallel
  const waves = await Promise.all(waveDates.map(async (waveDate) => {
    const { start, end } = pdtDateToUtcWindow(waveDate);
    try {
      const [statusResp, unitResp, storeResp] = await Promise.all([
        mcpQuery(accessToken, sqlStatusBreakdown(start, end)),
        mcpQuery(accessToken, sqlUnitCounts(start, end)),
        mcpQuery(accessToken, sqlStoreBreakdown(start, end)),
      ]);

      // Allocated order list is best-effort — a failure here shouldn't drop the wave
      let allocatedOrders = null;
      try {
        const allocResp = await mcpQuery(accessToken, sqlAllocatedOrders(start, end));
        allocatedOrders = (allocResp.rows || []).map(r => ({
          order_id: r.ORDER_ID,
          store_id: r.store_id,
          lines:    Number(r.line_count) || 0,
          units:    Math.round(Number(r.units) || 0),
        }));
      } catch (e) {
        console.warn(`[${ts()}] Wave ${waveDate} allocated order list failed (non-fatal):`, e.message);
      }

      const statusCounts = {};
      let totalActive = 0;
      for (const row of (statusResp.rows || [])) {
        statusCounts[row.MINIMUM_STATUS] = Number(row.orders);
        totalActive += Number(row.orders);
      }

      // Map line STATUS strings → unit buckets
      // ALLOCATED_QUANTITY etc. mirror ORDERED_QUANTITY in MAWM retail — use STATUS grouping instead
      const unitByStatus = {};
      for (const row of (unitResp.rows || [])) {
        unitByStatus[row.line_status] = Math.round(Number(row.units) || 0);
      }
      const allocated  = (unitByStatus['ALLOCATED']  || 0) + (unitByStatus['PACKING'] || 0);
      const packed     = unitByStatus['PACKED']     || 0;
      const manifested = unitByStatus['MANIFESTED'] || 0;
      const shipped    = unitByStatus['SHIPPED']    || 0;
      const loaded     = unitByStatus['LOADED']     || 0;
      const ordered    = allocated + packed + manifested + shipped + loaded;
      const unitCounts = { ordered, allocated, packed, manifested, shipped, loaded };

      const stores = (storeResp.rows || []).map(r => ({
        store_id: r.store_id,
        orders: Number(r.orders),
      }));

      const waveNum = waveNumMap[waveDate] || null;
      console.log(`[${ts()}] Wave ${waveDate}${waveNum ? ` (${waveNum})` : ''}: ${totalActive} active orders, ${unitCounts.ordered} ordered units, ${stores.length} stores`);
      return { wave_date: waveDate, wave_number: waveNum, total_active_orders: totalActive, status_counts: statusCounts, unit_counts: unitCounts, stores, allocated_orders: allocatedOrders };
    } catch (e) {
      console.error(`[${ts()}] Wave ${waveDate} queries failed:`, e.message);
      return { wave_date: waveDate, wave_number: waveNumMap[waveDate] || null, total_active_orders: null, status_counts: {}, stores: [], error: true };
    }
  }));

  const output = {
    generated: new Date().toISOString(),
    facility: FACILITY,
    status_labels: STATUS_LABELS,
    waves,
    zones: zoneWork,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`[${ts()}] ✓ retail_backlog_live.json written — ${waves.length} wave(s)`);
  console.log(`[${ts()}] retail_backlog_live.json ready — dc499_refresh will push on next cycle`);
}

// ── entry point ────────────────────────────────────────────────────────────────
async function main() {
  if (MODE_AUTH) {
    await doAuthFlow();
    return;
  }

  if (MODE_SERVE) {
    console.log(`[${ts()}] SCOUT Retail Backlog Agent — serve mode, interval ${INTERVAL / 60000} min`);
    const token = await getAccessTokenSilent().catch(async e => {
      if (e instanceof AuthError) return doAuthFlow();
      throw e;
    });
    await fetchRetailBacklog(token);
    let busy = false;
    setInterval(async () => {
      // Skip if the last cycle is still running, so cycles never stack up
      if (busy) { console.log(`[${ts()}] Previous cycle still running — skipping this tick`); return; }
      busy = true;
      try {
        const t = await getAccessTokenSilent();
        await fetchRetailBacklog(t);
      } catch (e) {
        console.error(`[${ts()}] Error:`, e.message);
      } finally {
        busy = false;
      }
    }, INTERVAL);
    return;
  }

  const token = await getAccessToken();
  await fetchRetailBacklog(token);
}

main().catch(e => { console.error(e.message); process.exit(1); });
