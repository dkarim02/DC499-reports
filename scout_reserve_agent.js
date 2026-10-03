#!/usr/bin/env node
/**
 * SCOUT — Reserve Live Agent
 * Queries TSK_ACTIVITY_TRACKING for Reserve Stock transaction data and writes reserve_live.json.
 * Uses pre-aggregated GROUP BY queries — immune to the ~10k row cap regardless of shift volume.
 *
 * Usage:
 *   node scout_reserve_agent.js            one-shot refresh
 *   node scout_reserve_agent.js --auth     first-time auth / re-auth
 *   node scout_reserve_agent.js --serve    auto-refresh every 30 min
 *   node scout_reserve_agent.js --serve --interval=15
 */

const fs     = require('fs');
const path   = require('path');
require('./scout_file_mirror');  // also writes filedata/*.js so pages work from OneDrive (file://)
const { SQL_TZ, currentShift } = require('./scout_tz');  // DST-aware local time
const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const { execSync } = require('child_process');

// ── config ─────────────────────────────────────────────────────────────────────
const MCP_BASE      = 'https://mawm-data-mcp.nordstromaws.app';
const TOKEN_FILE    = path.join(__dirname, '.mcp_token.json');
const OUTPUT_FILE        = path.join(__dirname, 'reserve_live.json');
const PUTAWAY_WIP_FILE   = path.join(__dirname, 'putaway_live.json');
const CLIENT_ID     = 'https://claude.ai/oauth/claude-code-client-metadata';
const REDIRECT_PORT = 3120; // distinct from dc499_refresh (3118) and ecom agent (3119)
const REDIRECT_URI  = `http://localhost:${REDIRECT_PORT}/callback`;
const FACILITY      = '499';

const args       = process.argv.slice(2);
const MODE_AUTH  = args.includes('--auth');
const MODE_SERVE = args.includes('--serve');
const INTERVAL   = (() => {
  const f = args.find(a => a.startsWith('--interval='));
  return f ? parseInt(f.split('=')[1]) * 60 * 1000 : 5 * 60 * 1000;
})();

// ── Reserve groups ─────────────────────────────────────────────────────────────
// GROUP BY aggregation means result rows = distinct employees, never hits 10k cap.
// Zone H filter (3rd char of TARGET_LOCATION_ID = 'H') applied in SQL for replen/putaway.
const RS_GROUPS = [
  {
    key:    'pick_f1',
    label:  'Pick F1',
    txIds:  ['Non Haz Retail Pick To oLPN Cart'],
    metric: 'QUANTITY',
    zoneH:  false,
  },
  {
    key:    'pick_f2',
    label:  'Pick F2',
    txIds:  ['Non Haz Retail Pick To oLPN Cart Floor 2'],
    metric: 'QUANTITY',
    zoneH:  false,
  },
  {
    key:    'replen',
    label:  'Replenishment',
    txIds:  ['iLPN Replen Fill', 'iLPN Replen Fill Large'],
    metric: 'COMPLETED_QUANTITY',
    zoneH:  true,
    containerCount: true,
  },
  {
    key:    'putaway',
    label:  'Putaway',
    txIds:  ['System Directed Putaway', 'User Directed Putaway'],
    metric: 'COMPLETED_QUANTITY',
    zoneH:  true,
  },
  {
    key:    'bulk_lpn',
    label:  'Full LPN Pick',
    txIds:  ['RETAIL_BULK_LPN_PICK', 'Retail Full LPN Pick', 'Retail Full LPN Pick Floor 2'],
    metric: 'QUANTITY',
    zoneH:  false,
  },
];

// ── MCP login + queries — shared by every agent, see scout_mcp.js ─────────────
const mcp = require('./scout_mcp')({ redirectPort: REDIRECT_PORT });
const { doAuthFlow, getAccessToken, AuthError, getAccessTokenSilent, mcpQuery } = mcp;

// ── helpers ────────────────────────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
}

// Hourly buckets use DC499 local time via SQL_TZ (scout_tz.js) — DST-aware, nothing to flip.

function shiftStartUtc(now = new Date()) {
  // 1st 3:00 AM–2:10 PM local, 2nd from 2:10 PM local (DST-aware)
  const sh = currentShift({ firstFrom: 3, secondFrom: [14, 10], firstStart: [3, 0], secondStart: [14, 10] }, now);
  return { utc: sh.startSql, label: sh.label };
}

// ── SQL builder ────────────────────────────────────────────────────────────────
// Per-employee, per-PDT-hour sums. Shift totals are rolled up from these rows in Node,
// so each associate's hourly values always add up to their total.
function buildGroupSql(shiftStart, group) {
  const txList = group.txIds.map(t => `'${t.replace(/'/g, "''")}'`).join(', ');
  const zoneFilter = group.zoneH ? `  AND SUBSTR(TARGET_LOCATION_ID, 3, 1) = 'H'\n` : '';
  return [
    `SELECT CREATED_BY AS Employee,`,
    `  DATE_FORMAT(CONVERT_TZ(CREATED_TIMESTAMP, '+00:00', ${SQL_TZ}), '%H') AS pdt_hr,`,
    `  SUM(${group.metric}) AS total_qty`,
    `FROM default_task.TSK_ACTIVITY_TRACKING`,
    `WHERE FACILITY_ID = '${FACILITY}'`,
    `  AND TRANSACTION_ID IN (${txList})`,
    `  AND CREATED_TIMESTAMP >= '${shiftStart}'`,
    zoneFilter + `GROUP BY CREATED_BY, pdt_hr`,
  ].join('\n');
}

// Distinct containers can't be summed across hours, so replen containers keep a shift-level query.
function buildContainerSql(shiftStart, group) {
  const txList = group.txIds.map(t => `'${t.replace(/'/g, "''")}'`).join(', ');
  const zoneFilter = group.zoneH ? `  AND SUBSTR(TARGET_LOCATION_ID, 3, 1) = 'H'\n` : '';
  return [
    `SELECT CREATED_BY AS Employee,`,
    `  COUNT(DISTINCT CASE WHEN COMPLETED_QUANTITY > 0 THEN CONTAINER_ID END) AS container_count`,
    `FROM default_task.TSK_ACTIVITY_TRACKING`,
    `WHERE FACILITY_ID = '${FACILITY}'`,
    `  AND TRANSACTION_ID IN (${txList})`,
    `  AND CREATED_TIMESTAMP >= '${shiftStart}'`,
    zoneFilter + `GROUP BY CREATED_BY`,
  ].join('\n');
}

// ── main fetch ─────────────────────────────────────────────────────────────────
async function fetchReserveLive(accessToken) {
  const { utc: shiftStart, label: shift } = shiftStartUtc();
  console.log(`[${ts()}] Reserve Live — ${shift} shift, since ${shiftStart}`);

  const associates = {};
  const totals     = { pick_f1: 0, pick_f2: 0, replen: 0, putaway: 0, bulk_lpn: 0, replen_containers: 0 };
  const rowCounts  = { pick_f1: 0, pick_f2: 0, replen: 0, putaway: 0, bulk_lpn: 0 };

  console.log(`[${ts()}] Querying all groups in parallel...`);
  const runQuery = async (label, sql) => {
    try {
      const resp = await mcpQuery(accessToken, sql);
      return resp.rows || [];
    } catch (e) {
      console.error(`[${ts()}] ${label} query failed:`, e.message);
      return [];
    }
  };
  const containerGroup = RS_GROUPS.find(g => g.containerCount);
  const [results, containerRows] = await Promise.all([
    Promise.all(RS_GROUPS.map(async group => ({
      group, rows: await runQuery(group.label, buildGroupSql(shiftStart, group)),
    }))),
    runQuery(`${containerGroup.label} containers`, buildContainerSql(shiftStart, containerGroup)),
  ]);

  const newAssoc = () => ({ pick_f1: 0, pick_f2: 0, replen: 0, putaway: 0, bulk_lpn: 0, hourly: {} });
  for (const { group, rows } of results) {
    const emps = new Set();
    for (const row of rows) {
      const emp = row.Employee;
      const hr  = String(Number(row.pdt_hr));   // "05" → "5" (PDT hour 0–23)
      const qty = Math.round(Number(row.total_qty) || 0);
      emps.add(emp);
      if (!associates[emp]) associates[emp] = newAssoc();
      const a = associates[emp];
      if (!a.hourly[hr]) a.hourly[hr] = { pick_f1: 0, pick_f2: 0, replen: 0, putaway: 0, bulk_lpn: 0 };
      a.hourly[hr][group.key] += qty;
      a[group.key] += qty;
      totals[group.key] += qty;
    }
    console.log(`[${ts()}] ${group.label}: ${emps.size} associates`);
    rowCounts[group.key] = emps.size;
  }

  for (const row of containerRows) {
    const emp = row.Employee;
    const cCount = Math.round(Number(row.container_count) || 0);
    if (!associates[emp]) associates[emp] = newAssoc();
    associates[emp].replen_containers = cCount;
    totals.replen_containers += cCount;
  }

  const output = {
    generated:  new Date().toISOString(),
    shift,
    shift_start: shiftStart,
    facility:    FACILITY,
    associates,
    totals,
    row_counts:  rowCounts,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`[${ts()}] ✓ reserve_live.json written`);
  console.log(`[${ts()}]   Pick F1: ${totals.pick_f1}  Pick F2: ${totals.pick_f2}  Replen: ${totals.replen}  Putaway: ${totals.putaway}  Bulk LPN: ${totals.bulk_lpn}`);

  // Git push handled by dc499_refresh.js (single coordinator — avoids concurrent push collisions)
  console.log(`[${ts()}] reserve_live.json ready — dc499_refresh will push on next cycle`);
}

// ── putaway WIP fetch ──────────────────────────────────────────────────────────
// Queries DCI_ILPN → DCI_INVENTORY → ITE_ITEM → RCV_RECEIPT for retail LPNs
// in pending putaway status (STATUS=3000) at inbound staging locations.
// Excludes: Z1Z (lost), shelf locations (R1H/R2H/R1B/R1C/R1D/R1E/R1F), 60-day cutoff.
async function fetchPutawayWip(accessToken) {
  console.log(`[${ts()}] Putaway WIP — querying retail pending putaway...`);

  const nowUtc   = new Date();
  const cutoff   = new Date(nowUtc.getTime() - 60 * 24 * 60 * 60 * 1000);
  const cutoffStr = cutoff.toISOString().replace('T', ' ').slice(0, 19);
  const nowStr    = nowUtc.toISOString().replace('T', ' ').slice(0, 19);

  const sql = `
SELECT
  il.ILPN_ID                                                       AS carton_id,
  il.CURRENT_LOCATION_ID                                           AS location,
  il.CREATED_TIMESTAMP                                             AS received_utc,
  TIMESTAMPDIFF(SECOND, il.CREATED_TIMESTAMP, '${nowStr}') / 86400.0 AS age_days,
  SUM(inv.ON_HAND)                                                 AS units,
  MIN(inv.ITEM_ID)                                                 AS item_id,
  MIN(i.EXT_SUBDIVISION)                                          AS subdivision,
  (SELECT r.PURCHASE_ORDER_ID FROM default_receiving.RCV_RECEIPT r
   WHERE r.LPN_ID = il.ILPN_ID AND r.FACILITY_ID = il.FACILITY_ID
   AND r.PURCHASE_ORDER_ID IS NOT NULL LIMIT 1)                    AS po_number
FROM default_dcinventory.DCI_ILPN il
JOIN default_dcinventory.DCI_INVENTORY inv
  ON inv.ILPN_ID = il.ILPN_ID AND inv.FACILITY_ID = il.FACILITY_ID
JOIN default_item_master.ITE_ITEM i
  ON i.ITEM_ID = inv.ITEM_ID
WHERE il.FACILITY_ID = '${FACILITY}'
  AND il.STATUS = '3000'
  AND il.IS_CLOSED = 0
  AND i.EXT_SUBDIVISION NOT IN ('740','750')
  AND il.CREATED_TIMESTAMP >= '${cutoffStr}'
  AND (il.CURRENT_LOCATION_ID IS NULL
    OR (il.CURRENT_LOCATION_ID NOT LIKE 'R1H%'
    AND il.CURRENT_LOCATION_ID NOT LIKE 'R2H%'
    AND il.CURRENT_LOCATION_ID NOT LIKE 'R1B%'
    AND il.CURRENT_LOCATION_ID NOT LIKE 'R1C%'
    AND il.CURRENT_LOCATION_ID NOT LIKE 'R1D%'
    AND il.CURRENT_LOCATION_ID NOT LIKE 'R1E%'
    AND il.CURRENT_LOCATION_ID NOT LIKE 'R1F%'
    AND il.CURRENT_LOCATION_ID NOT LIKE 'R1-SR%'
    AND il.CURRENT_LOCATION_ID != 'Z1-Z-0499Z01'))
GROUP BY il.ILPN_ID, il.CURRENT_LOCATION_ID, il.CREATED_TIMESTAMP
ORDER BY il.CREATED_TIMESTAMP ASC
`.trim();

  let lpns = [];
  let truncated = false;
  try {
    const resp = await mcpQuery(accessToken, sql);
    lpns = (resp.rows || []).map(r => ({
      carton_id:   r.carton_id,
      location:    r.location || null,
      received_utc: r.received_utc,
      age_days:    Math.round(Number(r.age_days) * 100) / 100,
      units:       Math.round(Number(r.units) || 0),
      item_id:     r.item_id,
      subdivision: r.subdivision,
      po_number:   r.po_number || null,
    }));
    if ((resp.row_count || lpns.length) >= 9500) truncated = true;
  } catch (e) {
    console.error(`[${ts()}] Putaway WIP query failed:`, e.message);
  }

  const over5     = lpns.filter(l => l.age_days >= 5).length;
  const totalUnits = lpns.reduce((s, l) => s + l.units, 0);
  const oldestAge  = lpns.length ? Math.max(...lpns.map(l => l.age_days)) : 0;

  const SUBDIV_LABEL = {
    '702': 'Footwear', '705': 'Footwear', '707': 'Footwear', '710': 'Footwear',
    '775': 'Apparel',  '780': 'Apparel',  '782': 'Apparel',  '787': 'Apparel', '795': 'Apparel',
  };

  const output = {
    generated:   nowUtc.toISOString(),
    facility:    FACILITY,
    summary: {
      total_lpns:  lpns.length,
      total_units: totalUnits,
      over_5_days: over5,
      oldest_age_days: Math.round(oldestAge * 10) / 10,
    },
    truncated,
    lpns: lpns.map(l => ({
      ...l,
      category: SUBDIV_LABEL[l.subdivision] || 'Other',
      location_label: l.location
        ? (l.location.startsWith('L1IB') ? 'Inbound Bay'
          : l.location.startsWith('L1IP') ? 'Inbound Processing'
          : l.location.startsWith('L2IP') ? 'L2 Inbound Processing'
          : l.location.match(/^\d+$/)     ? `Dock Door ${l.location}`
          : l.location.startsWith('S1-D') ? 'Staging'
          : l.location.startsWith('P1-QA') ? 'QA Hold'
          : l.location)
        : 'Unplaced',
    })),
  };

  fs.writeFileSync(PUTAWAY_WIP_FILE, JSON.stringify(output, null, 2));
  console.log(`[${ts()}] ✓ putaway_live.json written — ${lpns.length} LPNs, ${over5} over 5 days`);
  console.log(`[${ts()}] putaway_live.json ready — dc499_refresh will push on next cycle`);
}

// ── entry point ────────────────────────────────────────────────────────────────
async function main() {
  if (MODE_AUTH) {
    await doAuthFlow();
    return;
  }

  if (MODE_SERVE) {
    console.log(`[${ts()}] SCOUT Reserve Agent — serve mode, interval ${INTERVAL / 60000} min`);
    const token = await getAccessTokenSilent().catch(async e => {
      if (e instanceof AuthError) return doAuthFlow();
      throw e;
    });
    console.log(`[${ts()}] Priming reserve_live + putaway_live in parallel...`);
    await Promise.all([fetchReserveLive(token), fetchPutawayWip(token)]);
    let busy = false;
    setInterval(async () => {
      // Skip if the last cycle is still running, so cycles never stack up
      if (busy) { console.log(`[${ts()}] Previous cycle still running — skipping this tick`); return; }
      busy = true;
      try {
        const t = await getAccessTokenSilent();
        console.log(`[${ts()}] Refreshing reserve_live + putaway_live in parallel...`);
        await Promise.all([fetchReserveLive(t), fetchPutawayWip(t)]);
      } catch (e) {
        console.error(`[${ts()}] Error:`, e.message);
      } finally {
        busy = false;
      }
    }, INTERVAL);
    return;
  }

  const token = await getAccessToken();
  console.log(`[${ts()}] Priming reserve_live + putaway_live in parallel...`);
  await Promise.all([fetchReserveLive(token), fetchPutawayWip(token)]);
}

main().catch(e => { console.error(e.message); process.exit(1); });
