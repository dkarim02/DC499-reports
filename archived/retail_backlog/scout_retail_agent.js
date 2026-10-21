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
const { SQL_TZ, currentShift: tzShift, pacificMidnightSql, addDays } = require('./scout_tz');  // DST-aware local time
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

// Local date string (YYYY-MM-DD) → UTC window for querying, midnight to midnight local (DST-aware)
function pdtDateToUtcWindow(pdtDate) {
  return { start: pacificMidnightSql(pdtDate), end: pacificMidnightSql(addDays(pdtDate, 1)) };
}

// Local date (YYYY-MM-DD) of a UTC 'YYYY-MM-DD HH:MM:SS' string
function pacificDateOf(utcSql) {
  return new Date(utcSql.replace(' ', 'T') + 'Z').toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function lookbackUtc() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - LOOKBACK_DAYS);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

// Shift start: 1st 3:00 AM, 2nd 2:10 PM local (same as Reserve); 2nd is detected from 3 PM. DST-aware.
function currentShift(now = new Date()) {
  const sh = tzShift({ firstFrom: 3, secondFrom: 15, firstStart: [3, 0], secondStart: [14, 10] }, now);
  return { shift: sh.label, start: sh.startSql };
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
  DATE_FORMAT(CONVERT_TZ(CREATED_TIMESTAMP, '+00:00', ${SQL_TZ}), '%Y-%m-%d') AS run_date
FROM default_dcorder.DCO_ORDER_PLAN_RUN_STRATEGY
WHERE FACILITY_ID = '${FACILITY}'
  AND PLANNING_STRATEGY_ID = 'NRDR_CORE_RETAIL_ORDER_PLANNING_STRATEGY'
  AND CREATED_TIMESTAMP >= '${since}'
ORDER BY CREATED_TIMESTAMP DESC
`.trim();
}

// DCO_ORDER has no index on CREATED_TIMESTAMP, so every query here reads the whole order table
// (~3.5M rows, 8–16 s). Until 2026-10-19 this ran 4 queries PER WAVE plus a wave-date query —
// 21 full reads (~64 s for 5 waves). Now 3 reads cover every wave at once, grouped by wave date
// (the local date of CREATED_TIMESTAMP — same midnight-to-midnight window as before), and all
// start together. Same output, checked old vs new at the same moment.
//
// The lower bound is local midnight of the lookback day, so the oldest wave day is counted in
// full, as the old per-wave windows did. A day only counts as a wave if it has an active order
// created inside the lookback itself (`recent`), as the old wave-date query did.

// Wave days + order counts by MINIMUM_STATUS and by store, in one read.
// Bucket by MINIMUM_STATUS (where the order is blocked) not MAXIMUM_STATUS.
// An order with min=Allocated, max=Packed still has open allocated lines — it belongs in Allocated.
// MAXIMUM_STATUS filter still excludes fully shipped/cancelled orders.
function sqlWaveOrders(dayStart, since) {
  return `
SELECT
  DATE_FORMAT(CONVERT_TZ(CREATED_TIMESTAMP, '+00:00', ${SQL_TZ}), '%Y-%m-%d') AS wave_date,
  MINIMUM_STATUS,
  DESTINATION_FACILITY_ID AS store_id,
  COUNT(DISTINCT ORDER_ID) AS orders,
  SUM(CASE WHEN CREATED_TIMESTAMP >= '${since}' THEN 1 ELSE 0 END) AS recent
FROM default_dcorder.DCO_ORDER
WHERE FACILITY_ID = '${FACILITY}'
  AND ORDER_TYPE = 'RETAIL'
  AND CANCELLED = 0
  AND MAXIMUM_STATUS NOT IN ('8000', '9000')
  AND CREATED_TIMESTAMP >= '${dayStart}'
GROUP BY wave_date, MINIMUM_STATUS, store_id
`.trim();
}

// Unit counts by line STATUS, per wave day.
// MAWM retail: ALLOCATED/PACKED/MANIFESTED_QUANTITY columns mirror ORDERED_QUANTITY (set once, never decremented).
// Correct approach: sum ORDERED_QUANTITY grouped by line STATUS, then bucket by status string.
// STATUS strings: READY, ALLOCATED, PACKING, PACKED, LOADED, MANIFESTED, SHIPPED
// READY = line not given stock yet. Before 10/12 it was left out of every bucket and of ordered.
function sqlUnitCounts(dayStart) {
  return `
SELECT
  DATE_FORMAT(CONVERT_TZ(o.CREATED_TIMESTAMP, '+00:00', ${SQL_TZ}), '%Y-%m-%d') AS wave_date,
  ol.STATUS AS line_status,
  SUM(ol.ORDERED_QUANTITY) AS units
FROM default_dcorder.DCO_ORDER o
JOIN default_dcorder.DCO_ORDER_LINE ol
  ON ol.ORDER_ID = o.ORDER_ID AND ol.FACILITY_ID = o.FACILITY_ID
WHERE o.FACILITY_ID = '${FACILITY}'
  AND o.ORDER_TYPE = 'RETAIL'
  AND o.CANCELLED = 0
  AND o.CREATED_TIMESTAMP >= '${dayStart}'
  AND o.MAXIMUM_STATUS NOT IN ('8000', '9000')
  AND ol.CANCELLED = 0
GROUP BY wave_date, ol.STATUS
`.trim();
}

// Allocated order list, per wave day.
// Orders blocked at Allocated (MINIMUM_STATUS 2090) with their still-allocated lines/units — what's left to pick.
function sqlAllocatedOrders(dayStart) {
  return `
SELECT
  DATE_FORMAT(CONVERT_TZ(o.CREATED_TIMESTAMP, '+00:00', ${SQL_TZ}), '%Y-%m-%d') AS wave_date,
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
  AND o.CREATED_TIMESTAMP >= '${dayStart}'
  AND o.MAXIMUM_STATUS NOT IN ('8000', '9000')
  AND o.MINIMUM_STATUS = '2090'
  AND ol.CANCELLED = 0
  AND ol.STATUS = 'ALLOCATED'
GROUP BY wave_date, o.ORDER_ID, o.DESTINATION_FACILITY_ID
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
  const dayStart = pacificMidnightSql(pacificDateOf(since));

  // Everything starts together — scout_mcp.js caps queries in flight across all agents.
  // Zone workload, wave numbers, units and the allocated list are best-effort, as before.
  const [zoneWork, runResp, waveResp, unitResp, allocResp] = await Promise.all([
    fetchZoneWork(accessToken).catch(e => { console.warn(`[${ts()}] Zone work query failed (non-fatal):`, e.message); return null; }),
    mcpQuery(accessToken, sqlWaveRunIds(since)).catch(e => { console.warn(`[${ts()}] Wave run ID query failed (non-fatal):`, e.message); return null; }),
    mcpQuery(accessToken, sqlWaveOrders(dayStart, since)).catch(e => { console.error(`[${ts()}] Wave date query failed:`, e.message); return null; }),
    mcpQuery(accessToken, sqlUnitCounts(dayStart)).catch(e => ({ error: e })),
    mcpQuery(accessToken, sqlAllocatedOrders(dayStart)).catch(e => ({ error: e })),
  ]);

  // Step 0: wave run IDs for wave number labeling
  const waveNumMap = runResp ? buildWaveNumMap(runResp.rows || []) : {};
  if (runResp) console.log(`[${ts()}] Wave run IDs loaded: ${Object.keys(waveNumMap).length} dates`);

  // Step 1: active wave dates (newest first) — without them there is nothing to write
  if (!waveResp) return;
  const byDate = {};
  for (const r of (waveResp.rows || [])) {
    const d = (byDate[r.wave_date] ||= { recent: 0, status: {}, stores: {} });
    const n = Number(r.orders) || 0;
    d.recent += Number(r.recent) || 0;
    d.status[r.MINIMUM_STATUS] = (d.status[r.MINIMUM_STATUS] || 0) + n;
    d.stores[r.store_id] = (d.stores[r.store_id] || 0) + n;
  }
  const waveDates = Object.keys(byDate).filter(d => byDate[d].recent > 0).sort().reverse();
  console.log(`[${ts()}] Active waves found: ${waveDates.join(', ') || 'none'}`);

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

  // Steps 2–5: build each wave from the shared reads
  const unitsByDate = {};
  if (!unitResp.error) for (const r of (unitResp.rows || [])) {
    (unitsByDate[r.wave_date] ||= {})[r.line_status] = Math.round(Number(r.units) || 0);
  }
  const allocByDate = {};
  if (allocResp.error) console.warn(`[${ts()}] Allocated order list failed (non-fatal):`, allocResp.error.message);
  else for (const r of (allocResp.rows || [])) {
    (allocByDate[r.wave_date] ||= []).push({
      order_id: r.ORDER_ID,
      store_id: r.store_id,
      lines:    Number(r.line_count) || 0,
      units:    Math.round(Number(r.units) || 0),
    });
  }

  const waves = waveDates.map(waveDate => {
    const waveNum = waveNumMap[waveDate] || null;
    if (unitResp.error) {
      console.error(`[${ts()}] Wave ${waveDate} queries failed:`, unitResp.error.message);
      return { wave_date: waveDate, wave_number: waveNum, total_active_orders: null, status_counts: {}, stores: [], error: true };
    }
    const d = byDate[waveDate];

    const statusCounts = {};
    let totalActive = 0;
    for (const st of Object.keys(d.status).sort()) {
      statusCounts[st] = d.status[st];
      totalActive += d.status[st];
    }

    // Map line STATUS strings → unit buckets
    // ALLOCATED_QUANTITY etc. mirror ORDERED_QUANTITY in MAWM retail — use STATUS grouping instead
    const unitByStatus = unitsByDate[waveDate] || {};
    const ready      = unitByStatus['READY']      || 0;
    const allocated  = (unitByStatus['ALLOCATED']  || 0) + (unitByStatus['PACKING'] || 0);
    const packed     = unitByStatus['PACKED']     || 0;
    const manifested = unitByStatus['MANIFESTED'] || 0;
    const shipped    = unitByStatus['SHIPPED']    || 0;
    const loaded     = unitByStatus['LOADED']     || 0;
    const ordered    = ready + allocated + packed + manifested + shipped + loaded;
    const unitCounts = { ordered, ready, allocated, packed, manifested, shipped, loaded };

    // Most orders first (ties by store id, so the order is stable between refreshes)
    const stores = Object.entries(d.stores)
      .map(([store_id, orders]) => ({ store_id, orders }))
      .sort((a, b) => b.orders - a.orders || String(a.store_id).localeCompare(String(b.store_id)));

    // Most units first (ties by order id)
    const allocatedOrders = allocResp.error ? null : (allocByDate[waveDate] || [])
      .sort((a, b) => b.units - a.units || String(a.order_id).localeCompare(String(b.order_id)));

    console.log(`[${ts()}] Wave ${waveDate}${waveNum ? ` (${waveNum})` : ''}: ${totalActive} active orders, ${unitCounts.ordered} ordered units, ${stores.length} stores`);
    return { wave_date: waveDate, wave_number: waveNum, total_active_orders: totalActive, status_counts: statusCounts, unit_counts: unitCounts, stores, allocated_orders: allocatedOrders };
  });

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
