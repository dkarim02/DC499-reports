#!/usr/bin/env node
/**
 * SCOUT — Ecom Untasked Orders Agent
 * Finds Ecom orders that are allocated but have no pick task, and says why:
 *   short_shelf   — the pick shelf doesn't have enough stock, so the whole order waits
 *                   (work release only tasks stock that is physically on the shelf)
 *   replen_loop   — same, but the replen for that shelf keeps getting cancelled
 *   has_stock     — every shelf has stock and there's still no task after the grace period
 *   ghost         — order already shipped/cancelled but still holds stock on the shelf
 *   no_task_made  — allocation was released but a task was never created (system glitch)
 * Allocations newer than GRACE_MIN are normal (waiting for the next batch release) — counted, not flagged.
 * Writes untasked_live.json.
 *
 * Method from Shubham Dalal's retail dashboard (open_orders.py): DCI_ALLOCATION STATUS 3000 =
 * allocated, no task yet; 5000 = released. STATUS is stored as '3000.0' — always use IN ('3000','3000.0').
 *
 * Usage:
 *   node scout_untasked_agent.js            one-shot refresh
 *   node scout_untasked_agent.js --once     one-shot using the token lock (safe while other agents run)
 *   node scout_untasked_agent.js --auth     first-time auth / re-auth
 *   node scout_untasked_agent.js --serve    auto-refresh (default 5 min)
 *   node scout_untasked_agent.js --serve --interval=10
 */

const fs     = require('fs');
const path   = require('path');
require('./scout_file_mirror');  // also writes filedata/*.js so pages work from OneDrive (file://)
const { pacificMinOfDay } = require('./scout_tz');  // DST-aware local time
const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const { execSync } = require('child_process');

// ── config ─────────────────────────────────────────────────────────────────────
const MCP_BASE      = 'https://mawm-data-mcp.nordstromaws.app';
const TOKEN_FILE    = path.join(__dirname, '.mcp_token.json');
const OUTPUT_FILE   = path.join(__dirname, 'untasked_live.json');
const CLIENT_ID     = 'https://claude.ai/oauth/claude-code-client-metadata';
const REDIRECT_PORT = 3125;
const REDIRECT_URI  = `http://localhost:${REDIRECT_PORT}/callback`;
const FACILITY      = '499';
const GRACE_MIN     = 60;    // untasked this long = normal batch-release wait, not flagged
const REPLEN_HRS    = 24;    // replen history looked at per shelf
const LOOP_HRS      = 12;    // cancelled replens in this window …
const LOOP_MIN      = 2;     // … at least this many = replen loop
const RESERVE_AREAS = ['R1B', 'R1C', 'R1D', 'R1E', 'R1F'];   // Ecom reserve (replen source)
// Stock-but-no-task reasons. Multis only release with a putwall batch (WR_BATCH, every ~35–105 min);
// singles release every 5 min. Observed 9/30–10/1: last batch of the night ~9:20 PM, first ~5:10 AM.
const NIGHT_START_MIN  = 21 * 60 + 30;   // 9:30 PM PDT — after this, no more batches tonight
const NIGHT_END_MIN    = 5 * 60;         // 5:00 AM PDT — first batch of the morning
const SINGLE_GRACE_MIN = 15;      // singles should task within a few 5-min cycles
const ALLOC_3000    = "'3000','3000.0'";
const ALLOC_5000    = "'5000','5000.0'";

// Dead shelves — items on Ecom pick shelves nothing has picked lately (idea from Shubham's dead_faces.py).
// Heavy (~50 queries), so it runs every DEAD_EVERY_HRS into its own file, not every cycle.
const DEAD_FILE       = path.join(__dirname, 'dead_shelves_live.json');
const DEAD_EVERY_HRS  = 6;
const DEAD_IDLE_DAYS  = 30;   // no completed pick from this shelf for this item in 30 days
const DEAD_FRESH_DAYS = 7;    // stocked onto the shelf this recently = no history yet, never called dead
// Pick areas split so no answer nears the 10k-row cap (largest, F2C03, is ~4k stocked pairs)
const DEAD_CHUNKS     = ['F1A', 'F1B', 'F1D0', 'F1D1', 'F2C01', 'F2C02', 'F2C03', 'F2C04', 'P1C'];
const ROW_CAP_WARN    = 9500;
// Pick history in TSK_TASK_DETAIL starts here (checked 10/2) — "never picked" = none since this date
const DEAD_HISTORY_FROM = '2025-10-07';
// Bump when the file's shape changes — an older file is rebuilt at once instead of waiting out DEAD_EVERY_HRS
const DEAD_FORMAT = 3;   // 2 = rows carry last_pick (10/2), 3 = + UPC and a reserve spot per item (10/5)

// Empty locations — Ecom pick locations with nothing on hand, per pick execution zone + aisle. Hourly.
// DCI_LOCATION only filters well on `LOCATION_ID LIKE 'X%'` — LEFT() in WHERE/GROUP BY on that
// table fails ("Operation failed"), so group by PEZ and do aisles in Node.
const EMPTY_FILE      = path.join(__dirname, 'empty_locations_live.json');
const EMPTY_EVERY_HRS = 1;
const EMPTY_FORMAT    = 4;   // 2 = partly-full shelves, 3 = mixed cartons (10/2), 4 = items on partly-full shelves carry units/UPC (10/5)
const EMPTY_AREAS     = ['F1A', 'F1B', 'F1D', 'F2C', 'P1C'];
const EMPTY_CHUNKS    = ['F1A', 'F1B', 'F1D', 'F2C01', 'F2C02', 'F2C03', 'F2C04', 'P1C'];   // F2C ≈ 8k empties

const args       = process.argv.slice(2);
const MODE_AUTH  = args.includes('--auth');
const MODE_SERVE = args.includes('--serve');
const MODE_ONCE  = args.includes('--once');   // one-shot using the shared-token lock (safe alongside serve agents)
const INTERVAL   = (() => {
  const f = args.find(a => a.startsWith('--interval='));
  return f ? parseInt(f.split('=')[1]) * 60 * 1000 : 5 * 60 * 1000;
})();

// ── MCP login + queries — shared by every agent, see scout_mcp.js ─────────────
const mcp = require('./scout_mcp')({ redirectPort: REDIRECT_PORT });
const { doAuthFlow, getAccessToken, AuthError, getAccessTokenSilent } = mcp;
// This agent also treats {success:false} as a failed query
async function mcpQuery(accessToken, sql) {
  const parsed = await mcp.mcpQuery(accessToken, sql);
  if (parsed && parsed.success === false) throw new Error(parsed.error || 'query failed');
  return parsed;
}

// ── helpers ────────────────────────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
}
const fmtUtc   = d => d.toISOString().replace('T', ' ').slice(0, 19);
const utcAgo   = hrs => fmtUtc(new Date(Date.now() - hrs * 36e5));
const toIso    = s => s ? new Date(String(s).replace(' ', 'T') + (/(Z|[+-]\d{2}:\d{2})$/.test(String(s)) ? '' : 'Z')).toISOString() : null;
const minsSince = s => s ? Math.round((Date.now() - new Date(toIso(s)).getTime()) / 6e4) : null;
const num      = v => Number(v || 0);
const sqlList  = ids => ids.map(id => `'${String(id).replace(/'/g, "''")}'`).join(',');
const isGwp    = d => /gift with purchase/i.test(d || '') || /\bgwp\b/i.test(d || '');
const svcLabel = s => s === '11' ? '1DD' : s === '42' ? '2DD' : 'STD';
const SVC_RANK = { '1DD': 0, '2DD': 1, STD: 2 };
const bySvcThenAge = (a, b) => SVC_RANK[a.svc] - SVC_RANK[b.svc] || b.mins - a.mins;   // expedite first, oldest first
const shelfKey = (loc, item) => `${loc}|${item}`;
function chunks(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

// Batched queries (small-batch iteration pattern) — one failed batch doesn't sink the cycle
async function batched(token, ids, size, sqlFn, label) {
  const rows = [];
  for (const part of chunks(ids, size)) {
    try {
      const r = await mcpQuery(token, sqlFn(part));
      rows.push(...(r.rows || []));
    } catch (e) {
      console.warn(`[${ts()}]   ${label} batch failed (non-fatal): ${e.message}`);
    }
  }
  return rows;
}

// ── queries ────────────────────────────────────────────────────────────────────
// Every untasked Ecom allocation, any order status (shipped/cancelled ones = ghosts).
// No date bound on purpose: STATUS is indexed and 3000 drains fast, so the set stays small —
// a window could only hide the aged ones we're looking for.
function sqlUntasked() {
  return `
SELECT a.ALLOCATION_ID, a.ORDER_ID, a.TYPE_ID, a.ITEM_ID, a.LOCATION_ID, a.QUANTITY, a.CREATED_TIMESTAMP, a.UPDATED_TIMESTAMP,
  o.MINIMUM_STATUS, o.MAXIMUM_STATUS, o.CANCELLED AS order_cancelled, o.SINGLE_LINE_ORDER,
  o.DESIGNATED_SERVICE_LEVEL_ID AS svc, ol.DESCRIPTION,
  COALESCE((SELECT SUM(i.ON_HAND) FROM default_dcinventory.DCI_INVENTORY i
             WHERE i.FACILITY_ID='${FACILITY}' AND i.LOCATION_ID=a.LOCATION_ID AND i.ITEM_ID=a.ITEM_ID),0) AS loc_oh,
  COALESCE((SELECT SUM(i.ALLOCATED) FROM default_dcinventory.DCI_INVENTORY i
             WHERE i.FACILITY_ID='${FACILITY}' AND i.LOCATION_ID=a.LOCATION_ID AND i.ITEM_ID=a.ITEM_ID),0) AS loc_alloc
FROM default_dcinventory.DCI_ALLOCATION a
JOIN default_dcorder.DCO_ORDER o ON o.ORDER_ID=a.ORDER_ID AND o.FACILITY_ID='${FACILITY}'
LEFT JOIN default_dcorder.DCO_ORDER_LINE ol ON ol.ORDER_LINE_ID=a.ORDER_LINE_ID AND ol.FACILITY_ID='${FACILITY}'
WHERE a.FACILITY_ID='${FACILITY}' AND a.STATUS IN (${ALLOC_3000}) AND o.ORDER_TYPE='ECOM'`.trim();
}

// Released allocations on open orders with no task row at all — not even a cancelled one.
// (A cancelled-only task = short-pick leftover, which re-allocates on its own; not flagged.)
function sqlNoTaskMade(cutoff) {
  return `
SELECT a.ALLOCATION_ID, a.ORDER_ID, a.TYPE_ID, a.ITEM_ID, a.LOCATION_ID, a.QUANTITY, a.UPDATED_TIMESTAMP,
  o.MINIMUM_STATUS, o.MAXIMUM_STATUS, o.SINGLE_LINE_ORDER, o.DESIGNATED_SERVICE_LEVEL_ID AS svc, ol.DESCRIPTION
FROM default_dcinventory.DCI_ALLOCATION a
JOIN default_dcorder.DCO_ORDER o ON o.ORDER_ID=a.ORDER_ID AND o.FACILITY_ID='${FACILITY}'
LEFT JOIN default_dcorder.DCO_ORDER_LINE ol ON ol.ORDER_LINE_ID=a.ORDER_LINE_ID AND ol.FACILITY_ID='${FACILITY}'
WHERE a.FACILITY_ID='${FACILITY}' AND a.STATUS IN (${ALLOC_5000})
  AND o.ORDER_TYPE='ECOM' AND o.CANCELLED=0 AND o.MAXIMUM_STATUS NOT IN ('8000','9000')
  AND a.UPDATED_TIMESTAMP < '${cutoff}'
  AND NOT EXISTS (SELECT 1 FROM default_task.TSK_TASK_DETAIL td
                  WHERE td.ALLOCATION_ID=a.ALLOCATION_ID AND td.FACILITY_ID='${FACILITY}')`.trim();
}

function sqlReplens(locs, since) {
  return `
SELECT d.TARGET_LOCATION_ID, d.ITEM_ID, d.STATUS, d.QUANTITY, d.CREATED_TIMESTAMP, d.UPDATED_TIMESTAMP
FROM default_task.TSK_TASK_DETAIL d
WHERE d.FACILITY_ID='${FACILITY}' AND d.TYPE_ID='REPLENISHMENT'
  AND d.TARGET_LOCATION_ID IN (${sqlList(locs)})
  AND d.CREATED_TIMESTAMP >= '${since}'`.trim();
}

// ── shelf detail (blocking shelves only) ───────────────────────────────────────
// Replen allocations aimed at a shelf. STATUS 1000 = Deferred For Capacity: the whole carton
// (FULL_CONTAINER_ALLOCATED=1) won't fit, and re-firing the replen just defers again.
// LOCATION_ID is the reserve SOURCE, TO_LOCATION_ID is the shelf — easy to invert.
function sqlReplenAllocs(locs) {
  return `
SELECT a.TO_LOCATION_ID, a.ITEM_ID, a.STATUS, a.INVENTORY_CONTAINER_ID, a.LOCATION_ID AS SRC, a.QUANTITY, a.CREATED_TIMESTAMP
FROM default_dcinventory.DCI_ALLOCATION a
WHERE a.FACILITY_ID='${FACILITY}' AND a.TYPE_ID='REPLENISHMENT'
  AND a.STATUS IN ('1000','1000.0','5000','5000.0')
  AND a.TO_LOCATION_ID IN (${sqlList(locs)})`.trim();
}
// Everything on the shelf — Ecom shelves hold up to MAX_ITEMS (3) different items
function sqlShelfInv(locs) {
  return `
SELECT i.LOCATION_ID, i.ITEM_ID, SUM(i.ON_HAND) AS oh, SUM(COALESCE(i.ALLOCATED,0)) AS alloc
FROM default_dcinventory.DCI_INVENTORY i
WHERE i.FACILITY_ID='${FACILITY}' AND i.LOCATION_ID IN (${sqlList(locs)})
GROUP BY i.LOCATION_ID, i.ITEM_ID`.trim();
}
function sqlShelfCap(locs) {
  return `
SELECT LOCATION_ID, MAX_VOLUME, MAX_ITEMS FROM default_dcinventory.DCI_LOCATION
WHERE PROFILE_ID='${FACILITY}' AND LOCATION_ID IN (${sqlList(locs)})`.trim();
}
// Unit cube. default_item_master (default_item.ITE_ITEM is rejected). VOLUME is cuft;
// ORIGINAL_VOLUME is cubic inches — never use it.
function sqlItemCube(items) {
  return `
SELECT ITEM_ID, VOLUME, VOLUME_UOM_ID FROM default_item_master.ITE_ITEM
WHERE ITEM_ID IN (${sqlList(items)})`.trim();
}
// Open work sourced from the shelf: queued picks a lead can assign, and open cycle counts
function sqlShelfTasks(locs, since) {
  return `
SELECT td.SOURCE_LOCATION_ID, td.ITEM_ID, td.TASK_ID, td.QUANTITY, td.CREATED_TIMESTAMP, t.STATUS AS task_status, t.TRANSACTION_ID
FROM default_task.TSK_TASK_DETAIL td
JOIN default_task.TSK_TASK t ON t.TASK_ID = td.TASK_ID
WHERE td.FACILITY_ID='${FACILITY}' AND td.SOURCE_LOCATION_ID IN (${sqlList(locs)})
  AND td.STATUS NOT IN ('8000','9000') AND td.TYPE_ID <> 'REPLENISHMENT'
  AND td.CREATED_TIMESTAMP >= '${since}'`.trim();
}

// Putwall batch releases in the last day — multis only get a task when one of these fires
function sqlBatchReleases(since) {
  return `
SELECT WORK_RELEASE_BATCH_ID, MIN(CREATED_TIMESTAMP) AS released, SUM(TOTAL_ORDERS) AS orders
FROM default_workrelease.WR_BATCH
WHERE FACILITY_ID='${FACILITY}' AND CREATED_TIMESTAMP >= '${since}'
GROUP BY WORK_RELEASE_BATCH_ID`.trim();
}

function sqlReserve(items) {
  return `
SELECT i.ITEM_ID, SUM(i.ON_HAND) AS oh, SUM(COALESCE(i.ALLOCATED,0)) AS alloc,
  SUBSTRING_INDEX(GROUP_CONCAT(i.LOCATION_ID ORDER BY i.ON_HAND DESC), ',', 1) AS top_loc
FROM default_dcinventory.DCI_INVENTORY i
WHERE i.FACILITY_ID='${FACILITY}' AND i.ITEM_ID IN (${sqlList(items)})
  AND LEFT(i.LOCATION_ID,3) IN (${sqlList(RESERVE_AREAS)})
GROUP BY i.ITEM_ID`.trim();
}

// ── dead shelves ───────────────────────────────────────────────────────────────
// Stocked, no open orders, not stocked recently, and no completed pick of THIS item from THIS
// shelf in the window. Location × item grain: Ecom shelves hold up to 3 items, and a dead item
// sharing a shelf with a live one is exactly the space hog we want.
function sqlDeadPairs(prefix, idleSince, freshBefore) {
  return `
SELECT i.LOCATION_ID, i.ITEM_ID, SUM(i.ON_HAND) AS oh, MAX(i.LAST_LOCATED_DATE_TIME) AS last_located, MAX(i.PRIMARY_BAR_CODE) AS upc,
  (SELECT MAX(td.CREATED_TIMESTAMP) FROM default_task.TSK_TASK_DETAIL td
    WHERE td.SOURCE_LOCATION_ID = i.LOCATION_ID AND td.ITEM_ID = i.ITEM_ID AND td.FACILITY_ID='${FACILITY}'
      AND td.STATUS='8000' AND td.TYPE_ID='PICK/PACK') AS last_pick
FROM default_dcinventory.DCI_INVENTORY i
WHERE i.FACILITY_ID='${FACILITY}' AND i.ON_HAND > 0 AND i.ILPN_ID IS NULL AND COALESCE(i.ALLOCATED,0) = 0
  AND i.LOCATION_ID LIKE '${prefix}%'
  AND NOT EXISTS (SELECT 1 FROM default_task.TSK_TASK_DETAIL td
                  WHERE td.SOURCE_LOCATION_ID = i.LOCATION_ID AND td.ITEM_ID = i.ITEM_ID AND td.FACILITY_ID='${FACILITY}'
                    AND td.STATUS='8000' AND td.TYPE_ID='PICK/PACK' AND td.CREATED_TIMESTAMP >= '${idleSince}')
GROUP BY i.LOCATION_ID, i.ITEM_ID
HAVING MAX(i.LAST_LOCATED_DATE_TIME) IS NULL OR MAX(i.LAST_LOCATED_DATE_TIME) < '${freshBefore}'`.trim();
}
// Everything stocked in the area — tells us what else shares each dead item's shelf
function sqlAreaStock(prefix) {
  return `
SELECT LOCATION_ID, ITEM_ID, SUM(ON_HAND) AS oh, MAX(PRIMARY_BAR_CODE) AS upc
FROM default_dcinventory.DCI_INVENTORY
WHERE FACILITY_ID='${FACILITY}' AND ON_HAND > 0 AND ILPN_ID IS NULL AND LOCATION_ID LIKE '${prefix}%'
GROUP BY LOCATION_ID, ITEM_ID`.trim();
}
function sqlItemInfo(items) {
  return `
SELECT ITEM_ID, VOLUME, VOLUME_UOM_ID, DESCRIPTION, STORE_DEPARTMENT FROM default_item_master.ITE_ITEM
WHERE ITEM_ID IN (${sqlList(items)})`.trim();
}

async function fetchDeadShelves(token) {
  const t0 = Date.now();
  console.log(`[${ts()}] Fetching dead shelves (every ${DEAD_EVERY_HRS} hrs)...`);
  const idleSince = utcAgo(DEAD_IDLE_DAYS * 24), freshBefore = utcAgo(DEAD_FRESH_DAYS * 24);
  const dead = [], stock = [], truncated = [];
  for (const p of DEAD_CHUNKS) {
    // Dead list is required; a failed chunk is reported, not silently dropped
    const d = await mcpQuery(token, sqlDeadPairs(p, idleSince, freshBefore));
    const s = await mcpQuery(token, sqlAreaStock(p));
    if ((d.rows || []).length >= ROW_CAP_WARN || (s.rows || []).length >= ROW_CAP_WARN) truncated.push(p);
    dead.push(...(d.rows || []));
    stock.push(...(s.rows || []));
  }

  const deadKey = new Set(dead.map(r => shelfKey(r.LOCATION_ID, r.ITEM_ID)));
  const shelfLocs = [...new Set(dead.map(r => r.LOCATION_ID))];
  const onShelf = new Map();      // shelf → items stocked on it
  const shelfSet = new Set(shelfLocs);
  for (const r of stock) {
    if (!shelfSet.has(r.LOCATION_ID)) continue;
    if (!onShelf.has(r.LOCATION_ID)) onShelf.set(r.LOCATION_ID, []);
    onShelf.get(r.LOCATION_ID).push(r);
  }
  const items = [...new Set([...onShelf.values()].flat().map(r => r.ITEM_ID))];
  const deadItems = [...new Set(dead.map(r => r.ITEM_ID))];
  const deadItemSet = new Set(deadItems);

  const [capRows, infoRows, resRows] = [
    await batched(token, shelfLocs, 400, sqlShelfCap, 'dead shelf size'),
    await batched(token, items, 400, sqlItemInfo, 'dead item info'),
    await batched(token, deadItems, 400, sqlReserve, 'dead reserve'),
  ];
  const cap = {};  for (const r of capRows) cap[r.LOCATION_ID] = num(r.MAX_VOLUME) || null;
  const info = {}; for (const r of infoRows) info[r.ITEM_ID] = {
    cube: String(r.VOLUME_UOM_ID).toLowerCase() === 'cuft' && num(r.VOLUME) > 0 ? num(r.VOLUME) : null,
    desc: r.DESCRIPTION || '', dept: r.STORE_DEPARTMENT || '' };
  const res = {}, resLoc = {};
  for (const r of resRows) { res[r.ITEM_ID] = Math.max(0, num(r.oh) - num(r.alloc)); resLoc[r.ITEM_ID] = r.top_loc || null; }
  const r3 = v => v == null ? null : Math.round(v * 1000) / 1000;

  // Compact output: shelves hold contents once; items hold description/cube/reserve once.
  //   shelves[loc] = { max, items: [[item, on_hand, cuft, dead 0/1]] }
  //   rows         = [[loc, item, on_hand, cuft, pct_of_shelf, stocked_iso, last_pick_iso or null = never, upc]]
  //   history_from = oldest pick on record — "never" means none since then
  //   items[item]  = [description, unit_cuft, reserve_free, gwp 0/1, store_dept, reserve_loc_with_most (dead items only)]
  const shelvesOut = {};
  for (const loc of shelfLocs) {
    const max = cap[loc];
    shelvesOut[loc] = { max: r3(max), items: (onShelf.get(loc) || []).map(r => {
      const cf = info[r.ITEM_ID] && info[r.ITEM_ID].cube ? num(r.oh) * info[r.ITEM_ID].cube : null;
      return [r.ITEM_ID, num(r.oh), r3(cf), deadKey.has(shelfKey(loc, r.ITEM_ID)) ? 1 : 0];
    }) };
  }
  const rows = dead.map(r => {
    const i = info[r.ITEM_ID] || {}, max = cap[r.LOCATION_ID];
    const cf = i.cube ? num(r.oh) * i.cube : null;
    return [r.LOCATION_ID, r.ITEM_ID, num(r.oh), r3(cf), (cf != null && max) ? Math.round(100 * cf / max) : null, toIso(r.last_located), toIso(r.last_pick), r.upc || null];
  });
  const itemsOut = {};
  for (const it of items) {
    const i = info[it] || {};
    itemsOut[it] = [i.desc || '', i.cube == null ? null : Math.round(i.cube * 1e6) / 1e6, deadItemSet.has(it) ? (res[it] ?? 0) : null, isGwp(i.desc) ? 1 : 0, i.dept || '', deadItemSet.has(it) ? (resLoc[it] || null) : null];
  }

  const output = {
    generated: new Date().toISOString(), facility: FACILITY,
    idle_days: DEAD_IDLE_DAYS, fresh_days: DEAD_FRESH_DAYS, areas: DEAD_CHUNKS, truncated,
    format: DEAD_FORMAT, history_from: DEAD_HISTORY_FROM,
    summary: { pairs: rows.length, shelves: shelfLocs.length, units: rows.reduce((t, r) => t + r[2], 0),
               gwp_pairs: rows.filter(r => isGwp((info[r[1]] || {}).desc)).length,
               never_picked: rows.filter(r => !r[6]).length,
               cuft: r3(rows.reduce((t, r) => t + (r[3] || 0), 0)) },
    rows, shelves: shelvesOut, items: itemsOut,
  };
  fs.writeFileSync(DEAD_FILE, JSON.stringify(output));
  console.log(`[${ts()}] ✓ dead_shelves_live.json written in ${Math.round((Date.now() - t0) / 1000)}s — ` +
    `${output.summary.pairs} idle items on ${output.summary.shelves} shelves, ${output.summary.units} units` +
    (truncated.length ? ` · ⚠ near row cap: ${truncated.join(', ')}` : ''));
}

// Run the dead-shelves pass only when its file is older than DEAD_EVERY_HRS (survives restarts)
async function maybeFetchDeadShelves(token) {
  let age = Infinity, format = 0;
  try {
    const j = JSON.parse(fs.readFileSync(DEAD_FILE, 'utf8'));
    age = Date.now() - new Date(j.generated).getTime();
    format = j.format || 0;
  } catch {}
  if (format >= DEAD_FORMAT && age < DEAD_EVERY_HRS * 36e5) return;
  try { await fetchDeadShelves(token); }
  catch (e) { console.warn(`[${ts()}] Dead shelves failed (non-fatal, retries next cycle): ${e.message}`); }
}

// ── empty locations ────────────────────────────────────────────────────────────
// kind: free = no inventory record at all · waiting = record with allocation / to-be-filled
// (stock promised but not there) · assigned = record left behind with nothing on it
function sqlEmptyLocs(prefix) {
  const inv = `default_dcinventory.DCI_INVENTORY i WHERE i.FACILITY_ID='${FACILITY}' AND i.LOCATION_ID=l.LOCATION_ID`;
  return `
SELECT l.LOCATION_ID, l.PICK_EXECUTION_ZONE_ID AS pez, l.IS_ACTIVE, l.MAX_VOLUME,
  CASE WHEN NOT EXISTS (SELECT 1 FROM ${inv}) THEN 'free'
       WHEN EXISTS (SELECT 1 FROM ${inv} AND (COALESCE(i.ALLOCATED,0)>0 OR COALESCE(i.TO_BE_FILLED,0)>0)) THEN 'waiting'
       ELSE 'assigned' END AS kind
FROM default_dcinventory.DCI_LOCATION l
WHERE l.PROFILE_ID='${FACILITY}' AND l.LOCATION_ID LIKE '${prefix}%'
  AND NOT EXISTS (SELECT 1 FROM ${inv} AND i.ON_HAND > 0)`.trim();
}
function sqlZoneTotals(prefix) {
  return `
SELECT PICK_EXECUTION_ZONE_ID AS pez, IS_ACTIVE, COUNT(*) AS n FROM default_dcinventory.DCI_LOCATION
WHERE PROFILE_ID='${FACILITY}' AND LOCATION_ID LIKE '${prefix}%'
GROUP BY PICK_EXECUTION_ZONE_ID, IS_ACTIVE`.trim();
}
// Stocked locations per aisle (LEFT() is fine on DCI_INVENTORY) — aisle total = stocked + empty
function sqlStockedByAisle() {
  return `
SELECT LEFT(LOCATION_ID,5) AS aisle, COUNT(DISTINCT LOCATION_ID) AS n FROM default_dcinventory.DCI_INVENTORY
WHERE FACILITY_ID='${FACILITY}' AND ON_HAND > 0 AND ILPN_ID IS NULL AND LEFT(LOCATION_ID,3) IN (${sqlList(EMPTY_AREAS)})
GROUP BY LEFT(LOCATION_ID,5)`.trim();
}

// ── partly-full locations (multi-item shelves) ─────────────────────────────────
// F1A and F1D shelves allow MAX_ITEMS = 3 different items; F1B, P1C and the Mezz allow 1, so
// for them "empty" is the whole story. A partly-full shelf has open item slots, and the cube
// math says whether there's actually room on it.
// Shelf settings and item cube barely change, so they're kept in memory for a day: after the
// first pass each hourly run only re-reads what's on the shelves (3 queries).
const PARTIAL_AREAS  = ['F1A', 'F1D'];
const PARTIAL_STOCK_CHUNKS = ['F1A', 'F1D0', 'F1D1'];   // F1D ≈ 9k stocked pairs — split under the row cap
const CACHE_HRS      = 24;
const shelfCache = { at: 0, byLoc: {} };   // loc → { max_items, max_cuft, pez, active }
const cubeCache  = { at: 0, byItem: {}, desc: {} };  // item → unit cuft (null = unknown), item → description

function sqlShelfSettings(prefix) {
  return `
SELECT LOCATION_ID, MAX_ITEMS, MAX_VOLUME, PICK_EXECUTION_ZONE_ID AS pez, IS_ACTIVE
FROM default_dcinventory.DCI_LOCATION WHERE PROFILE_ID='${FACILITY}' AND LOCATION_ID LIKE '${prefix}%'`.trim();
}

async function fetchPartialLocations(token) {
  if (Date.now() - shelfCache.at > CACHE_HRS * 36e5) {
    const byLoc = {};
    for (const a of PARTIAL_AREAS) for (const r of ((await mcpQuery(token, sqlShelfSettings(a))).rows || []))
      byLoc[r.LOCATION_ID] = { max_items: num(r.MAX_ITEMS) || 1, max_cuft: num(r.MAX_VOLUME) || null, pez: r.pez || 'NONE', active: num(r.IS_ACTIVE) ? 1 : 0 };
    shelfCache.byLoc = byLoc; shelfCache.at = Date.now();
  }
  const stock = [];
  for (const p of PARTIAL_STOCK_CHUNKS) stock.push(...((await mcpQuery(token, sqlAreaStock(p))).rows || []));

  // Item cube: refresh all once a day, otherwise only look up items we haven't seen
  if (Date.now() - cubeCache.at > CACHE_HRS * 36e5) { cubeCache.byItem = {}; cubeCache.desc = {}; cubeCache.at = Date.now(); }
  const need = [...new Set(stock.map(r => r.ITEM_ID))].filter(it => !(it in cubeCache.byItem));
  if (need.length) {
    for (const r of await batched(token, need, 400, sqlItemInfo, 'partial item cube')) {
      cubeCache.byItem[r.ITEM_ID] = String(r.VOLUME_UOM_ID).toLowerCase() === 'cuft' && num(r.VOLUME) > 0 ? num(r.VOLUME) : null;
      cubeCache.desc[r.ITEM_ID] = r.DESCRIPTION || '';
    }
    for (const it of need) if (!(it in cubeCache.byItem)) cubeCache.byItem[it] = null;
  }

  const onShelf = new Map();
  for (const r of stock) {
    if (!onShelf.has(r.LOCATION_ID)) onShelf.set(r.LOCATION_ID, []);
    onShelf.get(r.LOCATION_ID).push(r);
  }
  // Compact rows: [location, pez, active 0/1, items_used, max_items, free_cuft|null, [item ids]]
  const out = [];
  for (const [loc, rows] of onShelf) {
    const s = shelfCache.byLoc[loc];
    if (!s || s.max_items < 2) continue;
    const used = rows.length;
    if (used === s.max_items) continue;                       // full on items — not interesting here
    const allCubed = rows.every(r => cubeCache.byItem[r.ITEM_ID]);
    const usedCuft = rows.reduce((t, r) => t + num(r.oh) * (cubeCache.byItem[r.ITEM_ID] || 0), 0);
    const free = (s.max_cuft && allCubed) ? Math.round(Math.max(0, s.max_cuft - usedCuft) * 100) / 100 : null;
    out.push([loc, s.pez, s.active, used, s.max_items, free, rows.map(r => [r.ITEM_ID, num(r.oh), r.upc || null])]);
  }
  return out;
}

// ── mixed-item cartons in Ecom reserve ─────────────────────────────────────────
// A reserve carton should hold one item. Replen moves the whole carton, so a mixed one drops
// every item onto one pick shelf. Rare (1 on 10/2) — shown as a section of Stuck orders.
// The list is every carton living in an R1B–R1F stock location; the replen lookup only adds a
// note when a replen is already pointed at the carton. Reserve LOCATIONS holding many items are normal (pallet
// positions with many single-item cartons) and are not flagged.
const MIXED_CHUNKS = ['R1B', 'R1C', 'R1D', 'R1E', 'R1F'];
function sqlMixedCartons(prefix) {
  return `
SELECT i.ILPN_ID, i.LOCATION_ID, i.ITEM_ID, SUM(i.ON_HAND) AS oh, SUM(COALESCE(i.ALLOCATED,0)) AS alloc
FROM default_dcinventory.DCI_INVENTORY i
WHERE i.FACILITY_ID='${FACILITY}' AND i.ON_HAND > 0 AND i.LOCATION_ID LIKE '${prefix}%' AND i.ILPN_ID IN (
  SELECT ILPN_ID FROM default_dcinventory.DCI_INVENTORY
  WHERE FACILITY_ID='${FACILITY}' AND ON_HAND > 0 AND ILPN_ID IS NOT NULL AND LOCATION_ID LIKE '${prefix}%'
  GROUP BY ILPN_ID HAVING COUNT(DISTINCT ITEM_ID) > 1)
GROUP BY i.ILPN_ID, i.LOCATION_ID, i.ITEM_ID`.trim();
}
function sqlCartonInfo(ilpns) {
  return `
SELECT ILPN_ID, STATUS, CREATED_TIMESTAMP, ASN_ID, PURCHASE_ORDER_ID FROM default_dcinventory.DCI_ILPN
WHERE FACILITY_ID='${FACILITY}' AND ILPN_ID IN (${sqlList(ilpns)})`.trim();
}
function sqlCartonReplens(ilpns) {
  return `
SELECT INVENTORY_CONTAINER_ID AS ilpn, TO_LOCATION_ID, STATUS, CREATED_TIMESTAMP FROM default_dcinventory.DCI_ALLOCATION
WHERE FACILITY_ID='${FACILITY}' AND TYPE_ID='REPLENISHMENT' AND STATUS IN ('1000','1000.0','5000','5000.0')
  AND INVENTORY_CONTAINER_ID IN (${sqlList(ilpns)})`.trim();
}
async function fetchMixedCartons(token) {
  const rows = [];
  for (const p of MIXED_CHUNKS) rows.push(...((await mcpQuery(token, sqlMixedCartons(p))).rows || []));
  const ilpns = [...new Set(rows.map(r => r.ILPN_ID))];
  const items = [...new Set(rows.map(r => r.ITEM_ID))];
  const [infoRows, replenRows, itemRows] = ilpns.length ? [
    await batched(token, ilpns, 200, sqlCartonInfo, 'mixed carton info'),
    await batched(token, ilpns, 200, sqlCartonReplens, 'mixed carton replen'),
    await batched(token, items, 400, sqlItemInfo, 'mixed carton items'),
  ] : [[], [], []];

  const info = {}; for (const r of infoRows) info[r.ILPN_ID] = r;
  const desc = {}; for (const r of itemRows) desc[r.ITEM_ID] = r.DESCRIPTION || '';
  const cartons = ilpns.map(id => {
    const mine = rows.filter(r => r.ILPN_ID === id), i = info[id] || {};
    const rp = replenRows.filter(r => r.ilpn === id).map(r => ({
      target: r.TO_LOCATION_ID, status: String(r.STATUS).split('.')[0] === '1000' ? 'deferred' : 'released', since: toIso(r.CREATED_TIMESTAMP) }));
    return {
      ilpn: id, loc: mine[0].LOCATION_ID, received: toIso(i.CREATED_TIMESTAMP), asn: i.ASN_ID || null, po: i.PURCHASE_ORDER_ID || null,
      units: mine.reduce((t, r) => t + num(r.oh), 0), held: mine.reduce((t, r) => t + num(r.alloc), 0),
      items: mine.map(r => [r.ITEM_ID, num(r.oh), desc[r.ITEM_ID] || '', isGwp(desc[r.ITEM_ID]) ? 1 : 0]).sort((a, b) => b[1] - a[1]),
      replen: rp,
    };
  }).sort((a, b) => (a.received || '') < (b.received || '') ? -1 : 1);
  return { checked: MIXED_CHUNKS, cartons };
}

async function fetchEmptyLocations(token) {
  const t0 = Date.now();
  const empties = [], totals = [], truncated = [];
  for (const p of EMPTY_CHUNKS) {
    const r = await mcpQuery(token, sqlEmptyLocs(p));
    if ((r.rows || []).length >= ROW_CAP_WARN) truncated.push(p);
    empties.push(...(r.rows || []));
  }
  for (const a of EMPTY_AREAS) totals.push(...((await mcpQuery(token, sqlZoneTotals(a))).rows || []));
  const stocked = (await mcpQuery(token, sqlStockedByAisle())).rows || [];

  const zones = {};
  const zone = pez => zones[pez] || (zones[pez] = { pez, active: 0, inactive: 0, empty: 0, waiting: 0, assigned: 0, inactive_empty: 0 });
  for (const r of totals) { const z = zone(r.pez || 'NONE'); if (num(r.IS_ACTIVE)) z.active += num(r.n); else z.inactive += num(r.n); }
  // Compact rows: [location, pez, active 0/1, max_cuft, kind]
  const locs = empties.map(r => {
    const z = zone(r.pez || 'NONE'), active = num(r.IS_ACTIVE) ? 1 : 0;
    if (active) { z.empty++; if (r.kind === 'waiting') z.waiting++; if (r.kind === 'assigned') z.assigned++; }
    else z.inactive_empty++;
    return [r.LOCATION_ID, r.pez || 'NONE', active, num(r.MAX_VOLUME) || null, r.kind];
  });
  const stockedByAisle = {};
  for (const r of stocked) stockedByAisle[r.aisle] = num(r.n);

  // Mixed-item cartons in reserve — non-fatal too
  let mixed = null;
  try { mixed = await fetchMixedCartons(token); }
  catch (e) { console.warn(`[${ts()}]   mixed-carton pass failed (non-fatal): ${e.message}`); }

  // Partly-full multi-item shelves — non-fatal, the empty list still ships without it
  let partial = [];
  try { partial = await fetchPartialLocations(token); }
  catch (e) { console.warn(`[${ts()}]   partly-full pass failed (non-fatal): ${e.message}`); }
  for (const p of partial) {
    if (!p[2]) continue;
    const z = zone(p[1]);
    z.partial = z.partial || 0; z.open_slots = z.open_slots || 0; z.over = z.over || 0;
    if (p[3] > p[4]) z.over++;
    else { z.partial++; z.open_slots += p[4] - p[3]; }
  }

  const output = {
    generated: new Date().toISOString(), facility: FACILITY, areas: EMPTY_AREAS, truncated,
    zones: Object.values(zones).sort((a, b) => a.pez < b.pez ? -1 : 1),
    stocked_by_aisle: stockedByAisle, locs,
    format: EMPTY_FORMAT, partial_areas: PARTIAL_AREAS, partial, mixed,
    // item → [description, gwp 0/1] for every item on a partly-full shelf (print sheets)
    item_desc: Object.fromEntries([...new Set(partial.flatMap(p => p[6].map(x => x[0])))].map(it => [it, [cubeCache.desc[it] || '', isGwp(cubeCache.desc[it]) ? 1 : 0]])),
  };
  fs.writeFileSync(EMPTY_FILE, JSON.stringify(output));
  const act = output.zones.reduce((t, z) => t + z.empty, 0);
  console.log(`[${ts()}] ✓ empty_locations_live.json written in ${Math.round((Date.now() - t0) / 1000)}s — ` +
    `${act} empty active locations in ${output.zones.length} zones · ${partial.filter(p => p[2] && p[3] < p[4]).length} partly full · ${mixed ? mixed.cartons.length : '?'} mixed cartons in reserve` + (truncated.length ? ` · ⚠ near row cap: ${truncated.join(', ')}` : ''));
}

// Same age check as dead shelves; both side passes share one helper
async function maybeRun(file, everyHrs, label, fn, token, format) {
  let age = Infinity, have = 0;
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); age = Date.now() - new Date(j.generated).getTime(); have = j.format || 0; } catch {}
  // A newer file (from a newer agent) is never overwritten by an older one
  if (age < everyHrs * 36e5 && (!format || have >= format)) return;
  try { await fn(token); }
  catch (e) { console.warn(`[${ts()}] ${label} failed (non-fatal, retries next cycle): ${e.message}`); }
}

// ── stock-but-no-task reasoning ────────────────────────────────────────────────
const pdtMinOfDay = ms => pacificMinOfDay(new Date(ms));   // local minutes since midnight, DST-aware
const isNight     = ms => { const m = pdtMinOfDay(ms); return m >= NIGHT_START_MIN || m < NIGHT_END_MIN; };

// Every shelf can cover the order, so the hold-up is the release, not the stock. Say which part.
//   single_skipped     — singles release every 5 min; this one has been ready 15+ min
//   single_waiting     — single, ready < 15 min (next 5-min cycle)
//   missed_batch       — multi was ready before the last putwall batch but wasn't put in it
//   release_late       — multi ready after the last batch, and no batch for 2+ hrs during the shift
//   next_batch         — multi ready after the last batch; next one should pick it up
//   after_last_release — multi ready after tonight's last batch; first batch is ~5 AM
function stockReason(o, last, now) {
  const readyMs   = new Date(o.ready).getTime();
  const readyMins = Math.max(0, Math.round((now - readyMs) / 6e4));
  const base = { ready_at: o.ready, ready_mins: readyMins, last_release: last ? last.at : null };
  if (o.single) return { ...base, stock_reason: readyMins >= SINGLE_GRACE_MIN ? 'single_skipped' : 'single_waiting' };
  if (!last) return { ...base, stock_reason: 'next_batch' };
  const lastMs = new Date(last.at).getTime();
  if (readyMs <= lastMs) return { ...base, stock_reason: 'missed_batch', last_release_orders: last.orders };
  if (isNight(now)) return { ...base, stock_reason: 'after_last_release' };
  if (now - lastMs > 120 * 6e4) return { ...base, stock_reason: 'release_late' };
  return { ...base, stock_reason: 'next_batch' };
}

// ── main fetch ─────────────────────────────────────────────────────────────────
async function fetchUntasked(token) {
  const t0 = Date.now();
  console.log(`[${ts()}] Fetching untasked Ecom allocations...`);

  const nonFatal = label => e => { console.warn(`[${ts()}]   ${label} query failed (non-fatal): ${e.message}`); return { rows: [] }; };
  const [respU, respN, respB] = await Promise.all([
    mcpQuery(token, sqlUntasked()),
    mcpQuery(token, sqlNoTaskMade(utcAgo(GRACE_MIN / 60))).catch(nonFatal('no-task-made')),
    mcpQuery(token, sqlBatchReleases(utcAgo(24))).catch(nonFatal('batch release')),
  ]);
  const releases = (respB.rows || []).map(r => ({ at: toIso(r.released), orders: num(r.orders) })).sort((a, b) => a.at < b.at ? -1 : 1);
  const lastRelease = releases.length ? releases[releases.length - 1] : null;
  const rows = respU.rows || [];

  // Split: ghosts (order done) vs open orders
  const isDone = r => num(r.order_cancelled) === 1 || ['8000', '9000'].includes(String(r.MAXIMUM_STATUS));
  const ghostRows = rows.filter(isDone);
  const openRows  = rows.filter(r => !isDone(r));

  // Untasked demand per shelf (all open orders) vs what's on it
  const shelves = new Map();
  for (const r of openRows) {
    if (!r.LOCATION_ID) continue;
    const k = shelfKey(r.LOCATION_ID, r.ITEM_ID);
    let s = shelves.get(k);
    if (!s) {
      s = { loc: r.LOCATION_ID, item: r.ITEM_ID, desc: r.DESCRIPTION || '', gwp: isGwp(r.DESCRIPTION),
            on_hand: num(r.loc_oh), allocated: num(r.loc_alloc), need: 0, orders: new Set() };
      shelves.set(k, s);
    }
    s.need += num(r.QUANTITY);
    s.orders.add(r.ORDER_ID);
  }
  // Short = shelf can't cover what's promised from it. ALLOCATED counts tasked + untasked picks,
  // so a shelf whose stock is all tied up in other picks reads short even if need < on_hand.
  for (const s of shelves.values()) s.short = s.on_hand < Math.max(s.need, s.allocated);

  // Group open rows into orders
  const orders = new Map();
  for (const r of openRows) {
    let o = orders.get(r.ORDER_ID);
    if (!o) {
      o = { order_id: r.ORDER_ID, svc: svcLabel(r.svc), single: num(r.SINGLE_LINE_ORDER) === 1,
            min_status: String(r.MINIMUM_STATUS), since: null, ready: null, lines: new Map() };
      orders.set(r.ORDER_ID, o);
    }
    const created = toIso(r.CREATED_TIMESTAMP);
    if (!o.since || created < o.since) o.since = created;
    // Last time any allocation changed (MA re-points allocations when a replen lands)
    const updated = toIso(r.UPDATED_TIMESTAMP) || created;
    if (!o.ready || updated > o.ready) o.ready = updated;
    const k = r.LOCATION_ID ? shelfKey(r.LOCATION_ID, r.ITEM_ID) : `none|${r.ITEM_ID}`;
    let l = o.lines.get(k);
    if (!l) {
      const s = shelves.get(k);
      l = { item: r.ITEM_ID, desc: r.DESCRIPTION || '', gwp: isGwp(r.DESCRIPTION), loc: r.LOCATION_ID || null,
            units: 0, on_hand: s ? s.on_hand : 0, short: s ? s.short : true };
      o.lines.set(k, l);
    }
    l.units += num(r.QUANTITY);
  }

  const now = Date.now();
  const ageMin = iso => Math.round((now - new Date(iso).getTime()) / 6e4);
  const flagged = [...orders.values()].filter(o => ageMin(o.since) >= GRACE_MIN);
  const waiting = orders.size - flagged.length;

  // Shelves that are actually holding up a flagged order
  const blockingKeys = new Set();
  for (const o of flagged) for (const [k, l] of o.lines) if (l.short && l.loc) blockingKeys.add(k);
  const blocking = [...blockingKeys].map(k => shelves.get(k));

  // Replen history + reserve stock, only for blocking shelves
  const replenRows = blocking.length
    ? await batched(token, [...new Set(blocking.map(s => s.loc))], 15, locs => sqlReplens(locs, utcAgo(REPLEN_HRS)), 'replen')
    : [];
  const reserveRows = blocking.length
    ? await batched(token, [...new Set(blocking.map(s => s.item))], 25, sqlReserve, 'reserve')
    : [];
  const reserveFree = {};
  for (const r of reserveRows) reserveFree[r.ITEM_ID] = Math.max(0, num(r.oh) - num(r.alloc));

  // Shelf detail: replen allocations (deferred?), what's on the shelf, its size, item cube, open work
  const blockLocs = [...new Set(blocking.map(s => s.loc))];
  const [allocRows, invRows, capRows, taskRows] = blockLocs.length ? await Promise.all([
    batched(token, blockLocs, 15, sqlReplenAllocs, 'replen allocation'),
    batched(token, blockLocs, 15, sqlShelfInv, 'shelf inventory'),
    batched(token, blockLocs, 25, sqlShelfCap, 'shelf size'),
    batched(token, blockLocs, 15, locs => sqlShelfTasks(locs, utcAgo(72)), 'shelf tasks'),
  ]) : [[], [], [], []];
  const cubeItems = [...new Set([...invRows.map(r => r.ITEM_ID), ...allocRows.map(r => r.ITEM_ID)])];
  const cubeRows  = cubeItems.length ? await batched(token, cubeItems, 25, sqlItemCube, 'item cube') : [];
  const cube = {};
  for (const r of cubeRows) if (String(r.VOLUME_UOM_ID).toLowerCase() === 'cuft' && num(r.VOLUME) > 0) cube[r.ITEM_ID] = num(r.VOLUME);
  const cap = {};
  for (const r of capRows) cap[r.LOCATION_ID] = { max: num(r.MAX_VOLUME) || null, max_items: num(r.MAX_ITEMS) || null };
  const r3 = v => v == null ? null : Math.round(v * 1000) / 1000;

  const loopCut = new Date(now - LOOP_HRS * 36e5).toISOString();
  for (const s of blocking) {
    const rs = replenRows.filter(r => r.TARGET_LOCATION_ID === s.loc && r.ITEM_ID === s.item);
    const st = r => String(r.STATUS).split('.')[0];
    s.replen_open      = rs.filter(r => !['8000', '9000'].includes(st(r))).length;
    s.replen_cancelled = rs.filter(r => st(r) === '9000' && toIso(r.UPDATED_TIMESTAMP || r.CREATED_TIMESTAMP) >= loopCut).length;
    const done = rs.filter(r => st(r) === '8000').map(r => toIso(r.UPDATED_TIMESTAMP)).sort();
    s.last_replen_done = done.length ? done[done.length - 1] : null;
    s.reserve_free     = reserveFree[s.item] ?? 0;

    // Shelf space: used = on-hand × unit cube for every item on it
    const inv  = invRows.filter(r => r.LOCATION_ID === s.loc && num(r.oh) > 0);
    const c    = cap[s.loc] || {};
    const allCubed = inv.every(r => cube[r.ITEM_ID]);
    const used = inv.reduce((t, r) => t + num(r.oh) * (cube[r.ITEM_ID] || 0), 0);
    s.max_cuft  = r3(c.max);
    s.used_cuft = allCubed ? r3(used) : null;
    s.free_cuft = (c.max && allCubed) ? r3(Math.max(0, c.max - used)) : null;
    s.max_items = c.max_items;
    s.others = inv.filter(r => r.ITEM_ID !== s.item).map(r => {
      const cf = cube[r.ITEM_ID] ? num(r.oh) * cube[r.ITEM_ID] : null;
      return { item: r.ITEM_ID, on_hand: num(r.oh), cuft: r3(cf), pct: (cf != null && c.max) ? Math.round(100 * cf / c.max) : null,
               has_orders: num(r.alloc) > 0 };
    }).sort((a, b) => (b.cuft || 0) - (a.cuft || 0));

    // Deferred cartons for this item → why they won't fit
    s.deferred = allocRows.filter(r => r.TO_LOCATION_ID === s.loc && r.ITEM_ID === s.item && st(r) === '1000').map(r => ({
      ilpn: r.INVENTORY_CONTAINER_ID, src: r.SRC, units: num(r.QUANTITY), since: toIso(r.CREATED_TIMESTAMP),
      cuft: cube[s.item] ? r3(num(r.QUANTITY) * cube[s.item]) : null,
    }));
    if (s.deferred.length) {
      const sizes = s.deferred.map(d => d.cuft).filter(v => v != null);
      const biggest = sizes.length ? Math.max(...sizes) : null, smallest = sizes.length ? Math.min(...sizes) : null;
      s.fit = biggest == null || s.max_cuft == null ? 'unknown'
        : biggest > s.max_cuft ? 'too_big'                                  // bigger than the empty shelf → re-slot
        : (s.free_cuft != null && smallest > s.free_cuft) ? 'needs_space'   // fits empty, not the space left → make room
        : 'fits_now';                                                       // room opened up → lands next replen
      s.deferred_since = s.deferred.map(d => d.since).sort()[0];
    }

    // Open work on the shelf
    const tasks = taskRows.filter(r => r.SOURCE_LOCATION_ID === s.loc);
    const isCount = r => /COUNT/i.test(r.TRANSACTION_ID || '');
    s.picks_queued = tasks.filter(r => !isCount(r)).map(r => ({
      task_id: r.TASK_ID, item: r.ITEM_ID, units: num(r.QUANTITY), status: String(r.task_status).split('.')[0],
    }));
    const counts = tasks.filter(isCount).map(r => toIso(r.CREATED_TIMESTAMP)).sort();
    s.count_open_since = counts.length ? counts[0] : null;

    s.state = s.deferred.length ? 'wont_fit'
      : s.replen_cancelled >= LOOP_MIN ? 'replen_loop' : s.replen_open ? 'replen_open' : 'no_replen';
  }

  // Classify flagged orders
  const outOrders = flagged.map(o => {
    const lines = [...o.lines.entries()].map(([k, l]) => {
      const s = shelves.get(k);
      return { ...l, state: l.short && s ? s.state : (l.short ? 'no_shelf' : 'ok') };
    }).sort((a, b) => (b.short - a.short) || (b.units - a.units));
    const short = lines.filter(l => l.short);
    const category = !short.length ? 'has_stock'
      : short.some(l => l.state === 'wont_fit') ? 'wont_fit'
      : short.some(l => l.state === 'replen_loop') ? 'replen_loop' : 'short_shelf';
    const out = {
      order_id: o.order_id, svc: o.svc, single: o.single, category,
      untasked_since: o.since, mins: ageMin(o.since),
      units: lines.reduce((t, l) => t + l.units, 0),
      lines,
    };
    if (category === 'has_stock') Object.assign(out, stockReason(o, lastRelease, now));
    return out;
  }).sort(bySvcThenAge);

  const outShelves = blocking.map(s => ({
    loc: s.loc, item: s.item, desc: s.desc, gwp: s.gwp, on_hand: s.on_hand, need: s.need,
    orders: s.orders.size, state: s.state, replen_open: s.replen_open, replen_cancelled: s.replen_cancelled,
    last_replen_done: s.last_replen_done, reserve_free: s.reserve_free,
    max_cuft: s.max_cuft, used_cuft: s.used_cuft, free_cuft: s.free_cuft, max_items: s.max_items, others: s.others,
    deferred: s.deferred, fit: s.fit || null, deferred_since: s.deferred_since || null,
    picks_queued: s.picks_queued, count_open_since: s.count_open_since,
  })).sort((a, b) => b.orders - a.orders || b.need - a.need);

  // Ghosts: done orders still holding untasked stock on a shelf
  const ghostMap = new Map();
  for (const r of ghostRows) {
    let g = ghostMap.get(r.ORDER_ID);
    if (!g) {
      g = { order_id: r.ORDER_ID, status: num(r.order_cancelled) === 1 || String(r.MAXIMUM_STATUS) === '9000' ? 'Cancelled' : 'Shipped',
            since: toIso(r.CREATED_TIMESTAMP), lines: [] };
      ghostMap.set(r.ORDER_ID, g);
    }
    const c = toIso(r.CREATED_TIMESTAMP);
    if (c < g.since) g.since = c;
    g.lines.push({ item: r.ITEM_ID, desc: r.DESCRIPTION || '', gwp: isGwp(r.DESCRIPTION), loc: r.LOCATION_ID || null,
                   units: num(r.QUANTITY), on_hand: num(r.loc_oh), allocated: num(r.loc_alloc) });
  }
  const ghosts = [...ghostMap.values()].map(g => ({ ...g, mins: ageMin(g.since) })).sort((a, b) => b.mins - a.mins);

  // No task made: released, never tasked
  const ntmMap = new Map();
  for (const r of (respN.rows || [])) {
    let n = ntmMap.get(r.ORDER_ID);
    if (!n) {
      n = { order_id: r.ORDER_ID, svc: svcLabel(r.svc), single: num(r.SINGLE_LINE_ORDER) === 1,
            released: toIso(r.UPDATED_TIMESTAMP), lines: [] };
      ntmMap.set(r.ORDER_ID, n);
    }
    const u = toIso(r.UPDATED_TIMESTAMP);
    if (u < n.released) n.released = u;
    n.lines.push({ item: r.ITEM_ID, desc: r.DESCRIPTION || '', gwp: isGwp(r.DESCRIPTION), loc: r.LOCATION_ID || null,
                   units: num(r.QUANTITY), type: r.TYPE_ID });
  }
  const noTaskMade = [...ntmMap.values()].map(n => ({ ...n, mins: ageMin(n.released) })).sort(bySvcThenAge);

  const cat = c => outOrders.filter(o => o.category === c);
  const output = {
    generated: new Date().toISOString(),
    facility: FACILITY,
    grace_min: GRACE_MIN,
    last_release: lastRelease ? { at: lastRelease.at, orders: lastRelease.orders, mins_ago: ageMin(lastRelease.at) } : null,
    night: isNight(now),
    summary: {
      short_shelf: cat('short_shelf').length,
      short_shelf_units: cat('short_shelf').reduce((t, o) => t + o.units, 0),
      wont_fit: cat('wont_fit').length,
      wont_fit_shelves: outShelves.filter(s => s.state === 'wont_fit').length,
      replen_loop: cat('replen_loop').length,
      loop_shelves: outShelves.filter(s => s.state === 'replen_loop').length,
      has_stock: cat('has_stock').length,
      ghosts: ghosts.length,
      ghost_units: ghosts.reduce((t, g) => t + g.lines.reduce((u, l) => u + l.units, 0), 0),
      no_task_made: noTaskMade.length,
      waiting,
      oldest_mins: Math.max(0, ...outOrders.map(o => o.mins), ...noTaskMade.map(n => n.mins)),
      expedite: outOrders.filter(o => o.svc !== 'STD').length + noTaskMade.filter(n => n.svc !== 'STD').length,
    },
    orders: outOrders,
    shelves: outShelves,
    ghosts,
    no_task_made: noTaskMade,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output));
  const s = output.summary;
  console.log(`[${ts()}] ✓ untasked_live.json written in ${Math.round((Date.now() - t0) / 1000)}s — ` +
    `short shelf ${s.short_shelf} · won't fit ${s.wont_fit} · replen loop ${s.replen_loop} · has stock ${s.has_stock} · ` +
    `ghosts ${s.ghosts} · no task made ${s.no_task_made} · waiting ${s.waiting}`);
  console.log(`[${ts()}] untasked_live.json ready — dc499_refresh will push on next cycle`);
}

// ── entry point ────────────────────────────────────────────────────────────────
async function main() {
  if (MODE_AUTH) {
    await doAuthFlow();
    return;
  }

  if (MODE_SERVE) {
    console.log(`[${ts()}] SCOUT Untasked Orders Agent — serve mode, interval ${INTERVAL / 60000} min`);
    const token = await getAccessTokenSilent().catch(async e => {
      if (e instanceof AuthError) return doAuthFlow();
      throw e;
    });
    await fetchUntasked(token);
    await maybeFetchDeadShelves(token);
    await maybeRun(EMPTY_FILE, EMPTY_EVERY_HRS, 'Empty locations', fetchEmptyLocations, token, EMPTY_FORMAT);
    let busy = false;
    setInterval(async () => {
      // Skip if the last cycle is still running, so cycles never stack up
      if (busy) { console.log(`[${ts()}] Previous cycle still running — skipping this tick`); return; }
      busy = true;
      try {
        const t = await getAccessTokenSilent();
        await fetchUntasked(t);
        await maybeFetchDeadShelves(t);
        await maybeRun(EMPTY_FILE, EMPTY_EVERY_HRS, 'Empty locations', fetchEmptyLocations, t, EMPTY_FORMAT);
      } catch (e) {
        console.error(`[${ts()}] Error:`, e.message);
      } finally {
        busy = false;
      }
    }, INTERVAL);
    return;
  }

  const token = await getAccessToken();
  await fetchUntasked(token);
  if (args.includes('--dead')) await fetchDeadShelves(token);   // force a dead-shelves pass
  else await maybeFetchDeadShelves(token);
  if (args.includes('--empty')) await fetchEmptyLocations(token);   // force an empty-locations pass
  else await maybeRun(EMPTY_FILE, EMPTY_EVERY_HRS, 'Empty locations', fetchEmptyLocations, token, EMPTY_FORMAT);
}

main().catch(e => { console.error(e.message); process.exit(1); });
