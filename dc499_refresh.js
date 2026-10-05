#!/usr/bin/env node
/**
 * DC499 Reporter — Direct MCP Refresher
 * Writes totes_live.json, backlog_live.json, and more without using Claude tokens.
 *
 * node dc499_refresh.js --auth       first-time auth
 * node dc499_refresh.js              one-shot refresh
 * node dc499_refresh.js --serve      live server on :3001, auto-refresh every 60 min
 * node dc499_refresh.js --serve --port=3002 --interval=30
 */

const fs     = require('fs');
const path   = require('path');
const { syncSharePages } = require('./scout_file_mirror');  // also writes filedata/*.js so pages work from OneDrive (file://)
const { SQL_TZ, currentShift, pacificMidnightSql, pacificShifted, parsePacific } = require('./scout_tz');  // DST-aware local time
const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const { execSync } = require('child_process');

// ── config ─────────────────────────────────────────────────────────────────────
const MCP_BASE      = 'https://mawm-data-mcp.nordstromaws.app';
const TOKEN_FILE    = path.join(__dirname, '.mcp_token.json');
const REPORT_DIR    = __dirname;
const RECV_FILE     = path.join(REPORT_DIR, 'receiving_live.json');
const TOTES_FILE    = path.join(REPORT_DIR, 'totes_live.json');
const BACKLOG_FILE  = path.join(REPORT_DIR, 'backlog_live.json');
const BATCH_STATUS_FILE = path.join(REPORT_DIR, 'batch_status.json');
const RETAIL_REPLEN_FILE = path.join(REPORT_DIR, 'retail_replen.json');
const TASKS_FILE         = path.join(REPORT_DIR, 'tasks_live.json');
const SHIPPED_FILE       = path.join(REPORT_DIR, 'shipped_live.json');
const EXPEDITE_FILE      = path.join(REPORT_DIR, 'expedite_live.json'); // written by scout_expedite_agent.js
const CLIENT_ID     = 'https://claude.ai/oauth/claude-code-client-metadata';
const REDIRECT_PORT = 3118;
const REDIRECT_URI  = `http://localhost:${REDIRECT_PORT}/callback`;
const FACILITY      = '499';

// ── MCP login + queries — shared by every agent, see scout_mcp.js ─────────────
// priority: the live 2-min cycle gets first claim on query slots over the sub-agents
const mcp = require('./scout_mcp')({ redirectPort: REDIRECT_PORT, priority: true });
const { doAuthFlow, getAccessToken, AuthError, getAccessTokenSilent, jsonPost, mcpQuery, takeStats } = mcp;

// ── helpers ────────────────────────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
}

function nowPdt() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
}

// Receiving moved to scout_receiving_agent.js (2026-10-05) — this file still serves + pushes receiving_live.json.


// ── open totes query ──────────────────────────────────────────────────────────
async function fetchTotes(accessToken) {
  // Two separate single-schema queries joined in JS to avoid cross-schema join overhead.
  // Query A: all open T0% totes from DCI_ILPN (default_dcinventory only)
  // Query B: pick task summary per tote from TSK_TASK_DETAIL (default_task only)
  //
  // Case classification:
  //   Case 3 — tote has a CURRENT_LOCATION_ID (at drop zone, aging)
  //   Case 2 — no location, all pick detail rows STATUS='9000' (pick done, never dropped)
  //   Case 1 — no location, any pick detail rows STATUS!='9000' (pick still active/idle)
  //
  // S/M source: PLANNED_TOTE_TYPE_ID on TSK_TASK_DETAIL — more reliable than SINGLE_ITEM_LPN
  //   singles = "Pick tote single" | "Pick tote chase single"
  //   multis  = everything else

  const sqlIlpn = `
SELECT
  i.ILPN_ID,
  i.CURRENT_LOCATION_ID,
  i.CURRENT_LOCATION_TYPE_ID,
  CONVERT_TZ(i.CREATED_TIMESTAMP, '+00:00', ${SQL_TZ}) AS created_pdt,
  CONVERT_TZ(i.UPDATED_TIMESTAMP, '+00:00', ${SQL_TZ}) AS updated_pdt,
  COALESCE(SUM(inv.ON_HAND), 0)                        AS on_hand_qty
FROM default_dcinventory.DCI_ILPN i
LEFT JOIN default_dcinventory.DCI_INVENTORY inv
  ON  inv.ILPN_ID     = i.ILPN_ID
 AND  inv.FACILITY_ID = '${FACILITY}'
WHERE i.FACILITY_ID = '${FACILITY}'
  AND i.ILPN_ID LIKE 'T0%'
  AND i.STATUS = '5000'
  AND i.IS_CLOSED = 0
GROUP BY i.ILPN_ID, i.CURRENT_LOCATION_ID, i.CURRENT_LOCATION_TYPE_ID,
         i.CREATED_TIMESTAMP, i.UPDATED_TIMESTAMP`.trim();

  // 2-day window is sufficient for open totes (status=5000, is_closed=0 are live now).
  // Shorter window = far fewer rows scanned in TSK_TASK_DETAIL.
  const sqlTasks = `
SELECT
  td.TARGET_CONTAINER_ID                                              AS tote_id,
  MAX(td.PLANNED_TOTE_TYPE_ID)                                       AS tote_type,
  SUM(CASE WHEN td.STATUS != '9000' THEN 1 ELSE 0 END)              AS active_lines,
  SUM(CASE WHEN td.STATUS  = '9000' THEN 1 ELSE 0 END)              AS done_lines,
  MAX(CONVERT_TZ(t.ACTUAL_END_TIME, '+00:00', ${SQL_TZ}))             AS task_ended_pdt
FROM default_task.TSK_TASK_DETAIL td
JOIN default_task.TSK_TASK t
  ON  t.TASK_ID             = td.TASK_ID
 AND  t.FACILITY_ID         = '${FACILITY}'
 AND  t.TRANSACTION_TYPE_ID = 'Pick'
JOIN (
  SELECT TARGET_CONTAINER_ID, MAX(TASK_ID) AS latest_task_id
  FROM   default_task.TSK_TASK_DETAIL
  WHERE  FACILITY_ID             = '${FACILITY}'
    AND  TARGET_CONTAINER_ID LIKE 'T0%'
    AND  CREATED_TIMESTAMP    >= NOW() - INTERVAL 2 DAY
  GROUP BY TARGET_CONTAINER_ID
) latest
  ON  latest.TARGET_CONTAINER_ID = td.TARGET_CONTAINER_ID
 AND  latest.latest_task_id      = td.TASK_ID
WHERE td.FACILITY_ID            = '${FACILITY}'
  AND td.TARGET_CONTAINER_ID LIKE 'T0%'
  AND td.CREATED_TIMESTAMP   >= NOW() - INTERVAL 2 DAY
GROUP BY td.TARGET_CONTAINER_ID`.trim();

  // Query HP: individual oLPNs sitting at H1-PW-01 cubbies — powers Hospital PW tab in Backlog_live.
  const sqlHpOlpns = `
SELECT
  o.LPN_ID                                                          AS olpn_id,
  o.ORDER_ID                                                        AS order_id,
  o.CURRENT_LOCATION_ID                                             AS cubby,
  o.STATUS                                                          AS status_code,
  CONVERT_TZ(o.CREATED_TIMESTAMP, '+00:00', '+00:00')               AS created_utc,
  CONVERT_TZ(o.UPDATED_TIMESTAMP, '+00:00', ${SQL_TZ})               AS updated_pdt
FROM default_pickpack.PPK_OLPN o
WHERE o.FACILITY_ID        = '${FACILITY}'
  AND o.CURRENT_LOCATION_ID LIKE 'H1-PW-01%'
  AND o.STATUS NOT IN ('8000','9000')
ORDER BY o.CREATED_TIMESTAMP ASC`.trim();

  // Query A: true total oLPN count per putwall — ungrouped by tote so every oLPN is counted.
  const sqlPwOlpn = `
SELECT
  CASE
    WHEN LOCATION_ID LIKE 'S1-PW-%' THEN SUBSTRING(LOCATION_ID, 1, 9)
    ELSE SUBSTRING(LOCATION_ID, 1, 8)
  END                        AS pw_prefix,
  COUNT(DISTINCT LPN_ID)     AS olpn_count
FROM default_pickpack.SLA_LPN_LOCATION_ASSIGNMENT
WHERE FACILITY_ID = '${FACILITY}'
  AND (LOCATION_ID LIKE 'S1-PW-%' OR LOCATION_ID LIKE 'H1-PW-%')
  AND UPDATED_TIMESTAMP >= NOW() - INTERVAL 12 HOUR
GROUP BY pw_prefix`.trim();

  // Query B: active drop-zone detection — which tote is feeding each wall right now.
  const sqlPwActiveDz = `
SELECT
  CASE
    WHEN sla.LOCATION_ID LIKE 'S1-PW-%' THEN SUBSTRING(sla.LOCATION_ID, 1, 9)
    ELSE SUBSTRING(sla.LOCATION_ID, 1, 8)
  END                        AS pw_prefix,
  td.SOURCE_CONTAINER_ID     AS tote_id,
  COUNT(DISTINCT sla.LPN_ID) AS dz_count
FROM default_pickpack.SLA_LPN_LOCATION_ASSIGNMENT sla
JOIN default_pickpack.TSK_TASK_DETAIL td
  ON  td.OLPN_ID             = sla.LPN_ID
 AND  td.FACILITY_ID         = '${FACILITY}'
 AND  td.SOURCE_CONTAINER_ID LIKE 'T0%'
 AND  td.CREATED_TIMESTAMP  >= NOW() - INTERVAL 1 DAY
WHERE sla.FACILITY_ID = '${FACILITY}'
  AND (sla.LOCATION_ID LIKE 'S1-PW-%' OR sla.LOCATION_ID LIKE 'H1-PW-%')
  AND sla.UPDATED_TIMESTAMP >= NOW() - INTERVAL 12 HOUR
GROUP BY pw_prefix, td.SOURCE_CONTAINER_ID
ORDER BY pw_prefix, dz_count DESC`.trim();

  const [respIlpn, respTasks, respPwOlpn, respPwActiveDz, respHpOlpns] = await Promise.all([
    mcpQuery(accessToken, sqlIlpn),
    mcpQuery(accessToken, sqlTasks),
    mcpQuery(accessToken, sqlPwOlpn),
    mcpQuery(accessToken, sqlPwActiveDz),
    mcpQuery(accessToken, sqlHpOlpns),
  ]);

  // Build task lookup keyed by tote_id
  const taskMap = {};
  for (const r of (respTasks.rows || [])) {
    taskMap[r.tote_id] = r;
  }

  const nowMs    = Date.now();
  const sevOrder = { red: 0, yellow: 1, green: 2 };
  const totes    = [];

  for (const r of (respIlpn.rows || [])) {
    const task       = taskMap[r.ILPN_ID] || null;
    const units      = Math.round(Number(r.on_hand_qty) || 0);
    const toteType   = task ? (task.tote_type || '') : '';
    const isSingles  = /single/i.test(toteType);
    const updatedMs  = new Date(r.updated_pdt).getTime();
    const idleMin    = Math.round((nowMs - updatedMs) / 60000);

    let caseNum, timerMin;
    if (r.CURRENT_LOCATION_ID) {
      // Case 3 — at a drop location, timer = time since last update at that location
      caseNum  = 3;
      timerMin = idleMin;
    } else if (task && task.task_ended_pdt && !isNaN(new Date(task.task_ended_pdt))
               && new Date(task.task_ended_pdt).getTime() > new Date(r.created_pdt).getTime()) {
      // Case 2 — pick task ended AFTER this iLPN was created (guards against stale tasks
      // from a previous wave on a reused tote ID being used for a newly created tote)
      caseNum  = 2;
      timerMin = Math.round((nowMs - new Date(task.task_ended_pdt).getTime()) / 60000);
    } else {
      // Case 1 — pick still active or no task record yet, idle since last scan
      caseNum  = 1;
      timerMin = idleMin;
    }

    if (caseNum !== 2 && timerMin < 5) continue;

    let severity;
    if (caseNum === 3) {
      severity = timerMin < 30 ? 'green' : timerMin < 60 ? 'yellow' : 'red';
    } else if (caseNum === 2) {
      severity = timerMin < 15 ? 'green' : timerMin < 30 ? 'yellow' : 'red';
    } else {
      severity = timerMin < 10 ? 'green' : timerMin < 20 ? 'yellow' : 'red';
    }

    totes.push({
      olpn:      r.ILPN_ID,
      type:      isSingles ? 'S' : 'M',
      units,
      case:      caseNum,
      location:  r.CURRENT_LOCATION_ID      || null,
      loc_type:  r.CURRENT_LOCATION_TYPE_ID || null,
      created:   r.created_pdt ? r.created_pdt.slice(11, 16) : null,
      timer_min: timerMin,
      severity,
    });
  }

  const byCase = { 1: [], 2: [], 3: [] };
  for (const t of totes) byCase[t.case].push(t);
  for (const c of [1, 2, 3]) {
    byCase[c].sort((a, b) =>
      sevOrder[a.severity] - sevOrder[b.severity] || b.timer_min - a.timer_min
    );
  }

  // ── Build putwall data ──────────────────────────────────────────────────────
  // Fixed pairing: PW index (1-8) → dz1 (D1-PW-0N), dz2 (D1-PW-0(N+8))
  // H1-PW-01 is the hospital putwall with its own drop zone D1-HP-01.
  const PW_META = [
    { pw:'PW1', mawm_prefix:'S1-PW-010', dz1:'D1-PW-01', dz2:'D1-PW-09' },
    { pw:'PW2', mawm_prefix:'S1-PW-020', dz1:'D1-PW-02', dz2:'D1-PW-10' },
    { pw:'PW3', mawm_prefix:'S1-PW-030', dz1:'D1-PW-03', dz2:'D1-PW-11' },
    { pw:'PW4', mawm_prefix:'S1-PW-040', dz1:'D1-PW-04', dz2:'D1-PW-12' },
    { pw:'PW5', mawm_prefix:'S1-PW-050', dz1:'D1-PW-05', dz2:'D1-PW-13' },
    { pw:'PW6', mawm_prefix:'S1-PW-060', dz1:'D1-PW-06', dz2:'D1-PW-14' },
    { pw:'PW7', mawm_prefix:'S1-PW-070', dz1:'D1-PW-07', dz2:'D1-PW-15' },
    { pw:'PW8', mawm_prefix:'S1-PW-080', dz1:'D1-PW-08', dz2:'D1-PW-16' },
    { pw:'H1',  mawm_prefix:'H1-PW-01',  dz1:'D1-HP-01', dz2:null        },
  ];

  // Build putwall maps from the combined query result.
  // Rows are ordered by pw_prefix, dz_count DESC — first row per prefix wins for active_dz.
  const pwCountMap  = {};
  const pwActiveDzMap = {};

  // Build ilpnLocMap for drop zone tote counts (still needed from DCI_ILPN rows)
  const ilpnLocMap  = {};
  const dzToteCount = {};
  for (const r of (respIlpn.rows || [])) {
    if (!r.CURRENT_LOCATION_ID) continue;
    ilpnLocMap[r.ILPN_ID] = r.CURRENT_LOCATION_ID;
    dzToteCount[r.CURRENT_LOCATION_ID] = (dzToteCount[r.CURRENT_LOCATION_ID] || 0) + 1;
  }

  // Build true oLPN counts from the dedicated count query
  for (const r of (respPwOlpn.rows || [])) {
    pwCountMap[r.pw_prefix] = Number(r.olpn_count || 0);
  }

  // Build active DZ map from the separate active-DZ query — first row per prefix wins (ordered by dz_count DESC)
  for (const r of (respPwActiveDz.rows || [])) {
    if (!pwActiveDzMap[r.pw_prefix] && r.tote_id) {
      const loc = ilpnLocMap[r.tote_id];
      if (loc && loc.startsWith('D1-')) pwActiveDzMap[r.pw_prefix] = loc;
    }
  }

  const putwalls = PW_META.map(m => ({
    pw:          m.pw,
    mawm_prefix: m.mawm_prefix,
    olpn_count:  pwCountMap[m.mawm_prefix] || 0,
    dz1:         m.dz1,
    dz2:         m.dz2,
    active_dz:   pwActiveDzMap[m.mawm_prefix] || null,
    dz1_totes:   dzToteCount[m.dz1] || 0,
    dz2_totes:   m.dz2 ? (dzToteCount[m.dz2] || 0) : 0,
  }));

  const OLPN_STATUS_LABELS = {
    '1000': 'Created', '7100': 'Packing', '7200': 'Packed',
    '7600': 'Manifested', '7800': 'Loaded', '8000': 'Shipped', '9000': 'Cancelled',
  };
  const hospital_olpns = (respHpOlpns.rows || []).map(r => {
    const updMs   = r.updated_pdt ? new Date(r.updated_pdt).getTime() : null;
    const age_min = updMs ? Math.round((nowMs - updMs) / 60000) : null;
    return {
      olpn:        r.olpn_id,
      order_id:    r.order_id || null,
      cubby:       r.cubby    || null,
      status_code: r.status_code,
      status:      OLPN_STATUS_LABELS[r.status_code] || r.status_code,
      created_utc: r.created_utc || null,
      age_min,
      updated:     r.updated_pdt ? r.updated_pdt.slice(11, 16) : null,
    };
  });

  return {
    generated: new Date().toISOString().slice(0, 19),
    facility:  FACILITY,
    summary: {
      total: totes.length,
      case1: byCase[1].length,
      case2: byCase[2].length,
      case3: byCase[3].length,
      red:   totes.filter(t => t.severity === 'red').length,
    },
    case1: byCase[1],
    case2: byCase[2],
    case3: byCase[3],
    putwalls,
    hospital_olpns,
  };
}

// ── backlog query ──────────────────────────────────────────────────────────────
async function fetchBacklog(accessToken) {
  const pdt = nowPdt();

  // Date strings in PDT (YYYY-MM-DD)
  const todayDate       = new Date(pdt); todayDate.setHours(0, 0, 0, 0);
  const tomorrowDate    = new Date(todayDate); tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const sevenDaysAgoDate = new Date(todayDate); sevenDaysAgoDate.setDate(sevenDaysAgoDate.getDate() - 7);
  const todayStr        = todayDate.toLocaleDateString('en-CA');
  const tomorrowStr     = tomorrowDate.toLocaleDateString('en-CA');
  const sevenDaysAgoStr = sevenDaysAgoDate.toLocaleDateString('en-CA');

  // Local midnight of each date, in UTC for the WHERE clause (DST-aware: 07:00 in PDT, 08:00 in PST)
  const lookbackUtcStart = pacificMidnightSql(sevenDaysAgoStr);
  const todayUtcStart    = pacificMidnightSql(todayStr);
  const todayUtcEnd      = pacificMidnightSql(tomorrowStr);

  // DATE_FORMAT used instead of DATE() — the MCP connector serializes DATE() as a JS Date
  // object, so .slice(0,10) produces garbage. DATE_FORMAT guarantees a plain YYYY-MM-DD string.

  // Query 1: open order detail for drill-down (bucket totals derived from this in Node, not SQL)
  const sqlOrders = `
SELECT
  DATE_FORMAT(CONVERT_TZ(CREATED_TIMESTAMP, '+00:00', ${SQL_TZ}), '%Y-%m-%d') AS line_date,
  ORDER_ID,
  STATUS,
  COUNT(*) AS line_count,
  MIN(CREATED_TIMESTAMP) AS oldest_line_utc
FROM default_dcorder.DCO_ORDER_LINE
WHERE FACILITY_ID = '${FACILITY}'
  AND ORDER_TYPE  = 'ECOM'
  AND CANCELLED   = 0
  AND STATUS NOT IN ('SHIPPED')
  AND CREATED_TIMESTAMP >= '${lookbackUtcStart}'
  AND CREATED_TIMESTAMP <  '${todayUtcEnd}'
GROUP BY line_date, ORDER_ID, STATUS
ORDER BY line_date DESC, ORDER_ID`.trim();

  // Query 2: line counts by PDT date + hour over the 7 days, with shipped counted alongside.
  // Replaces three separate scans of the same lines (shipped per date, total per date, today
  // by hour) — on 10/2 those took 135s + 66s at a slow moment; this one scan runs ~8s.
  // Shipped / daily totals / hourly rows are rebuilt from it below in their old shapes.
  const sqlLineCounts = `
SELECT
  DATE_FORMAT(CONVERT_TZ(CREATED_TIMESTAMP, '+00:00', ${SQL_TZ}), '%Y-%m-%d') AS line_date,
  HOUR(CONVERT_TZ(CREATED_TIMESTAMP, '+00:00', ${SQL_TZ})) AS hour_pdt,
  COUNT(*) AS line_count,
  SUM(CASE WHEN STATUS = 'SHIPPED' THEN 1 ELSE 0 END) AS shipped_count
FROM default_dcorder.DCO_ORDER_LINE
WHERE FACILITY_ID = '${FACILITY}'
  AND ORDER_TYPE  = 'ECOM'
  AND CANCELLED   = 0
  AND CREATED_TIMESTAMP >= '${lookbackUtcStart}'
  AND CREATED_TIMESTAMP <  '${todayUtcEnd}'
GROUP BY line_date, hour_pdt`.trim();

  // Query 5: wave runs this shift
  // 1st shift from 3:00 AM, 2nd from 1:40 PM local (DST-aware)
  const waveShift    = currentShift({ firstFrom: 3, secondFrom: [13, 40], firstStart: [3, 0], secondStart: [13, 40] });
  const is1st        = waveShift.is1st;
  const waveStartStr = waveShift.startSql;

  const sqlWaves = `
SELECT
  PLANNING_STRATEGY_ID,
  CHASE_MODE,
  COUNT(*) AS wave_runs
FROM default_dcorder.DCO_ORDER_PLAN_RUN_STRATEGY
WHERE FACILITY_ID = '${FACILITY}'
  AND CREATED_TIMESTAMP >= '${waveStartStr}'
GROUP BY PLANNING_STRATEGY_ID, CHASE_MODE
ORDER BY wave_runs DESC`.trim();

  // Query 6: hazmat indicator per open order today — join order lines to item master
  // EXT_HAZMATINDICATOR values: 'YES' → Y, 'EXEMPT' → E
  // EXT_LITHIUMBATTERYINDICATOR = 1 → LIT (separate column)
  const sqlHazmat = `
SELECT
  ol.ORDER_ID,
  MAX(CASE
    WHEN i.EXT_HAZMATINDICATOR = 'YES'    THEN 'Y'
    WHEN i.EXT_LITHIUMBATTERYINDICATOR = 1 THEN 'LIT'
    WHEN i.EXT_HAZMATINDICATOR = 'EXEMPT' THEN 'E'
  END) AS hazmat_indicator,
  COUNT(*) AS haz_lines
FROM default_dcorder.DCO_ORDER_LINE ol
JOIN default_item_master.ITE_ITEM i ON i.ITEM_ID = ol.ITEM_ID
WHERE ol.FACILITY_ID = '${FACILITY}'
  AND ol.ORDER_TYPE  = 'ECOM'
  AND ol.CANCELLED   = 0
  AND ol.STATUS NOT IN ('SHIPPED')
  AND ol.CREATED_TIMESTAMP >= '${todayUtcStart}'
  AND ol.CREATED_TIMESTAMP <  '${todayUtcEnd}'
  AND (i.EXT_HAZMATINDICATOR IN ('YES','EXEMPT') OR i.EXT_LITHIUMBATTERYINDICATOR = 1)
GROUP BY ol.ORDER_ID`.trim();

  // Query 7: units in allocated iLPNs at D1-SN-01 (picked, staged, ready to pack). STATUS 5000 = allocated/active.
  // Split by T0 (single) vs S1 (multi) iLPN prefix.
  const sqlRfp = `
SELECT
  SUM(inv.ON_HAND) AS unit_count,
  SUM(CASE WHEN ilpn.ILPN_ID LIKE 'T0%' THEN inv.ON_HAND ELSE 0 END) AS single_units,
  SUM(CASE WHEN ilpn.ILPN_ID LIKE 'S1%' THEN inv.ON_HAND ELSE 0 END) AS multi_units
FROM default_dcinventory.DCI_ILPN ilpn
JOIN default_dcinventory.DCI_INVENTORY inv ON inv.ILPN_ID = ilpn.ILPN_ID AND inv.FACILITY_ID = ilpn.FACILITY_ID
WHERE ilpn.FACILITY_ID = '${FACILITY}'
  AND ilpn.CURRENT_LOCATION_ID = 'D1-SN-01'
  AND ilpn.STATUS = '5000'`.trim();

  // Query 8: top 10 Ecom items by ordered quantity today — for replen sniping card
  const sqlTopItems = `
SELECT
  ITEM_ID,
  DESCRIPTION,
  SUM(ORDERED_QUANTITY) AS units_ordered,
  COUNT(DISTINCT ORDER_ID) AS order_count
FROM default_dcorder.DCO_ORDER_LINE
WHERE FACILITY_ID = '${FACILITY}'
  AND ORDER_TYPE = 'ECOM'
  AND CANCELLED = 0
  AND DESCRIPTION NOT LIKE '%DUMMY%'
  AND CREATED_TIMESTAMP >= '${todayUtcStart}'
  AND CREATED_TIMESTAMP <  '${todayUtcEnd}'
GROUP BY ITEM_ID, DESCRIPTION
ORDER BY units_ordered DESC
LIMIT 10`.trim();

  const [respOrders, respLineCounts, respWaves, respHazmat, respRfp, respTopItems] = await Promise.all([
    mcpQuery(accessToken, sqlOrders),
    mcpQuery(accessToken, sqlLineCounts),
    mcpQuery(accessToken, sqlWaves),
    mcpQuery(accessToken, sqlHazmat).catch(() => ({ rows: [] })),
    mcpQuery(accessToken, sqlRfp),
    mcpQuery(accessToken, sqlTopItems).catch(() => ({ rows: [] })),
  ]);

  // Rebuild the old per-date shipped / per-date total / today-by-hour rows from the one scan
  const shippedByDate = {}, totalByDate = {}, todayByHour = {};
  for (const r of (respLineCounts.rows || [])) {
    const d = String(r.line_date || '').slice(0, 10);
    if (d.length < 10) continue;
    totalByDate[d]   = (totalByDate[d]   || 0) + Number(r.line_count || 0);
    shippedByDate[d] = (shippedByDate[d] || 0) + Number(r.shipped_count || 0);
    if (d === todayStr) todayByHour[Number(r.hour_pdt)] = (todayByHour[Number(r.hour_pdt)] || 0) + Number(r.line_count || 0);
  }
  const byDateDesc = m => Object.keys(m).sort().reverse().map(d => ({ line_date: d, line_count: m[d] }));
  const respShipped     = { rows: byDateDesc(shippedByDate).filter(r => r.line_count > 0) };
  const respDailyTotals = { rows: byDateDesc(totalByDate) };
  const respHourly      = { rows: Object.keys(todayByHour).map(Number).sort((x, y) => x - y).map(h => ({ hour_pdt: h, line_count: todayByHour[h] })) };

  const rowCounts = [respOrders, respShipped, respDailyTotals, respHourly, respWaves, respHazmat, respRfp, respTopItems]
    .map(r => (r?.rows || []).length);
  console.log(`[${ts()}]   backlog row counts [orders,shipped,totals,hourly,waves,hazmat,rfp,topitems]: ${rowCounts.join(',')}`);

  // If the three core queries all came back empty, the MCP server throttled us — bail out
  // so we don't overwrite a good backlog_live.json with zeros.
  if (rowCounts[0] === 0 && rowCounts[1] === 0 && rowCounts[2] === 0) {
    throw new Error('Backlog queries returned empty rows — likely throttled; skipping write');
  }

  // Build hazmat map: ORDER_ID → highest-priority indicator (Y > LIT > E)
  const HAZ_RANK = { 'Y': 3, 'LIT': 2, 'E': 1 };
  const hazMap = {};
  for (const r of (respHazmat.rows || [])) {
    const ind = (r.hazmat_indicator || '').toUpperCase();
    if (!HAZ_RANK[ind]) continue;
    if (!hazMap[r.ORDER_ID] || HAZ_RANK[ind] > HAZ_RANK[hazMap[r.ORDER_ID]]) {
      hazMap[r.ORDER_ID] = ind;
    }
  }

  // Build a map of ORDER_ID → earliest line_date across open (non-packed, non-shipped) lines.
  // This pools all READY/RELEASED/ALLOCATED lines for the same order under its oldest date.
  const OPEN_STATUSES = new Set(['READY', 'RELEASED', 'ALLOCATED']);
  const minDateByOrder = {};
  for (const r of (respOrders.rows || [])) {
    const status  = (r.STATUS || '').toUpperCase();
    if (!OPEN_STATUSES.has(status)) continue;
    const dateStr = String(r.line_date || '').slice(0, 10);
    if (dateStr.length < 10) continue;
    const orderId = r.ORDER_ID;
    if (!minDateByOrder[orderId] || dateStr < minDateByOrder[orderId]) {
      minDateByOrder[orderId] = dateStr;
    }
  }

  // Build buckets dynamically from whatever dates the DB returns — no hardcoded date list.
  const buckets = {};
  function ensureBucket(dateStr) {
    if (!buckets[dateStr]) buckets[dateStr] = { date: dateStr, ready: 0, allocated: 0, packed: 0, shipped: 0, orders: [] };
    return buckets[dateStr];
  }

  for (const r of (respOrders.rows || [])) {
    const rawDate = String(r.line_date || '').slice(0, 10);
    if (rawDate.length < 10) continue;
    const status  = (r.STATUS || '').toUpperCase();
    // Open lines pool to the order's earliest date; packed/shipped keep their own date.
    const dateStr = OPEN_STATUSES.has(status) ? (minDateByOrder[r.ORDER_ID] || rawDate) : rawDate;
    const b = ensureBucket(dateStr);
    b.orders.push({
      order_id:        r.ORDER_ID,
      status,
      line_count:      Number(r.line_count),
      oldest_line_utc: r.oldest_line_utc || null,
      hazmat:          hazMap[r.ORDER_ID] || null,
    });
  }

  // Derive bucket totals from the pooled orders array (replaces the separate sqlCounts query).
  for (const b of Object.values(buckets)) {
    for (const o of b.orders) {
      switch (o.status) {
        case 'READY':
        case 'RELEASED':  b.ready     += o.line_count; break;
        case 'ALLOCATED': b.allocated += o.line_count; break;
        case 'PACKED':    b.packed    += o.line_count; break;
        case 'SHIPPED':   b.shipped   += o.line_count; break;
      }
    }
  }

  // Inject shipped counts from dedicated shipped query (by creation date, not pooled)
  for (const r of (respShipped.rows || [])) {
    const dateStr = String(r.line_date || '').slice(0, 10);
    if (dateStr.length < 10) continue;
    const b = ensureBucket(dateStr);
    b.shipped = Number(r.line_count);
  }

  // Build date → total map from raw daily totals query (unaffected by pooling)
  const dailyTotalMap = {};
  for (const r of (respDailyTotals.rows || [])) {
    const dateStr = String(r.line_date || '').slice(0, 10);
    if (dateStr.length === 10) dailyTotalMap[dateStr] = Number(r.line_count);
  }
  // Attach daily_total to each bucket
  for (const b of Object.values(buckets)) {
    b.daily_total = dailyTotalMap[b.date] || 0;
  }

  const hourly = (respHourly.rows || []).map(r => ({
    hour:  Number(r.hour_pdt),
    lines: Number(r.line_count),
  }));
  // Fill any gaps between the first data hour and the current PDT hour with 0
  const nowPdtForHourly = nowPdt();
  const currentHourPdt  = nowPdtForHourly.getHours();
  const hourSet = new Set(hourly.map(h => h.hour));
  const firstHour = hourly.length ? hourly[0].hour : currentHourPdt;
  for (let h = firstHour; h <= currentHourPdt; h++) {
    if (!hourSet.has(h)) hourly.push({ hour: h, lines: 0 });
  }
  hourly.sort((a, b) => a.hour - b.hour);

  function waveLabel(sid, chase) {
    if (sid === 'NRDR_CORE_REPLEN_ORDER_PLANNING_STRATEGY')         return 'Replen';
    if (sid === 'NRDR_CORE_RETAIL_ORDER_PLANNING_STRATEGY')         return null;
    if (sid === 'SINGLE_CHASE_ORDER_PLANNING_STRATEGY')             return 'Single Chase';
    if (sid === 'MULTI_CHASE_ORDER_PLANNING_STRATEGY')              return 'Multi Chase';
    if (sid === 'NRDR_NEW_PIPELINE_CHASE_ORDER_PLANNING_STRATEGY') {
      if (chase === 'CHASE_ONLY') return 'Single Chase';
      return 'Multi Chase';
    }
    if (sid && sid.includes('RTV'))  return 'RTV/RTI';
    if (sid && sid.includes('FILL')) return 'Fill/Kill';
    return 'Ecom';
  }
  const waveCounts = {};
  for (const r of (respWaves.rows || [])) {
    const label = waveLabel(r.PLANNING_STRATEGY_ID, r.CHASE_MODE);
    if (!label) continue;
    waveCounts[label] = (waveCounts[label] || 0) + Number(r.wave_runs);
  }
  const waveOrder = ['Ecom','Replen','Single Chase','Multi Chase','Fill/Kill','RTV/RTI'];
  const waves = waveOrder
    .filter(t => waveCounts[t] > 0)
    .map(t => ({ type: t, count: waveCounts[t] }));
  const waveTotal = Object.values(waveCounts).reduce((a,b) => a+b, 0);
  if (waveTotal > 0) waves.push({ type: 'Total', count: waveTotal });

  // Only show dates with open work (ready/allocated/packed) — shipped-only dates are clear.
  // Always include today even if empty so the page always has a "today" row.
  const datesArr = Object.values(buckets)
    .filter(b => b.date === todayStr || (b.ready + b.allocated + b.packed) > 0)
    .sort((a, b) => b.date.localeCompare(a.date));

  const rfpRow   = (respRfp.rows || [])[0] || {};
  const rfpUnits = Number(rfpRow.unit_count  || 0);
  const rfpSingle = Number(rfpRow.single_units || 0);
  const rfpMulti  = Number(rfpRow.multi_units  || 0);

  // Hazmat summary — count unique hazmat orders and their lines across today's open orders
  const hazBreakdown = {};
  let hazOrderCount = 0, hazLineCount = 0;
  const todayBucket = buckets[todayStr];
  if (todayBucket) {
    const seenHazOrders = new Set();
    for (const o of todayBucket.orders) {
      if (!o.hazmat) continue;
      if (seenHazOrders.has(o.order_id)) continue;
      seenHazOrders.add(o.order_id);
      hazOrderCount++;
      hazLineCount += o.line_count;
      hazBreakdown[o.hazmat] = (hazBreakdown[o.hazmat] || 0) + 1;
    }
  }

  const GWP_PATTERNS = [/gift with purchase/i, /\bgwp\b/i];
  const topItems = (respTopItems.rows || []).map(r => ({
    item_id:      r.ITEM_ID || '',
    description:  r.DESCRIPTION || '',
    units:        Number(r.units_ordered),
    orders:       Number(r.order_count),
    gwp:          GWP_PATTERNS.some(re => re.test(r.DESCRIPTION || '')),
  }));

  return {
    generated:         new Date().toISOString().slice(0, 19),
    facility:          FACILITY,
    today:             todayStr,
    dates:             datesArr,
    hourly,
    waves,
    rfp_units:         rfpUnits,
    rfp_single:        rfpSingle,
    rfp_multi:         rfpMulti,
    shift_label:       is1st ? '1st shift' : '2nd shift',
    hazmat_orders:     hazOrderCount,
    hazmat_lines:      hazLineCount,
    hazmat_breakdown:  hazBreakdown,
    top_items:         topItems,
  };
}

// ── retail replen query ────────────────────────────────────────────────────────
async function fetchRetailReplen(accessToken) {
  const pdt = nowPdt();
  const todayDate    = new Date(pdt); todayDate.setHours(0, 0, 0, 0);
  const yestDate     = new Date(todayDate); yestDate.setDate(yestDate.getDate() - 1);
  const tomorrowDate = new Date(todayDate); tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const todayStr     = todayDate.toLocaleDateString('en-CA');
  const yestStr      = yestDate.toLocaleDateString('en-CA');
  const tomorrowStr  = tomorrowDate.toLocaleDateString('en-CA');
  const yestUtcStart   = pacificMidnightSql(yestStr);      // local midnight, DST-aware
  const todayUtcEnd    = pacificMidnightSql(tomorrowStr);

  // Q1: open ecom order lines (yesterday + today) grouped by item — matches backlog date window
  const sqlOrders = `
SELECT
  ol.ITEM_ID,
  COUNT(DISTINCT ol.ORDER_ID)          AS order_count,
  SUM(ol.ORDERED_QUANTITY)             AS units_needed,
  MIN(ol.CREATED_TIMESTAMP)            AS oldest_order_utc,
  GROUP_CONCAT(DISTINCT ol.ORDER_ID ORDER BY ol.ORDER_ID SEPARATOR ',') AS order_ids
FROM default_dcorder.DCO_ORDER_LINE ol
WHERE ol.FACILITY_ID = '${FACILITY}'
  AND ol.ORDER_TYPE  = 'ECOM'
  AND ol.CANCELLED   = 0
  AND ol.STATUS IN ('READY','ALLOCATED')
  AND ol.CREATED_TIMESTAMP >= '${yestUtcStart}'
  AND ol.CREATED_TIMESTAMP <  '${todayUtcEnd}'
GROUP BY ol.ITEM_ID`.trim();

  // Q2: active face inventory per item (F1H, F2H, P1H, P2H)
  const sqlFaceInv = `
SELECT
  ITEM_ID,
  SUM(ON_HAND) AS face_on_hand
FROM default_dcinventory.DCI_INVENTORY
WHERE FACILITY_ID = '${FACILITY}'
  AND (
    LOCATION_ID LIKE 'F1H%' OR LOCATION_ID LIKE 'F2H%' OR
    LOCATION_ID LIKE 'P1H%' OR LOCATION_ID LIKE 'P2H%'
  )
GROUP BY ITEM_ID`.trim();

  // Q3: retail source inventory per item (R1H, R2H)
  const sqlSourceInv = `
SELECT
  ITEM_ID,
  SUM(ON_HAND) AS source_on_hand
FROM default_dcinventory.DCI_INVENTORY
WHERE FACILITY_ID = '${FACILITY}'
  AND (LOCATION_ID LIKE 'R1H%' OR LOCATION_ID LIKE 'R2H%')
GROUP BY ITEM_ID`.trim();

  // Q4: open retail replen tasks per item (not done/cancelled)
  const sqlTasks = `
SELECT
  td.ITEM_ID,
  t.TASK_ID,
  t.STATUS,
  t.SOURCE_LOCATION_ID,
  t.TARGET_LOCATION_ID,
  t.CREATED_TIMESTAMP
FROM default_task.TSK_TASK t
JOIN default_task.TSK_TASK_DETAIL td
  ON  td.TASK_ID      = t.TASK_ID
  AND td.FACILITY_ID  = '${FACILITY}'
  AND td.CREATED_TIMESTAMP >= NOW() - INTERVAL 3 DAY
WHERE t.FACILITY_ID     = '${FACILITY}'
  AND t.TRANSACTION_ID  = 'Retail iLPN Replen Pull'
  AND t.STATUS NOT IN ('8000','9000')
  AND t.CREATED_TIMESTAMP >= NOW() - INTERVAL 3 DAY`.trim();

  const [respOrders, respFace, respSource, respTasks] = await Promise.all([
    mcpQuery(accessToken, sqlOrders),
    mcpQuery(accessToken, sqlFaceInv),
    mcpQuery(accessToken, sqlSourceInv),
    mcpQuery(accessToken, sqlTasks),
  ]);

  // Build lookup maps
  const faceMap   = {};
  for (const r of (respFace.rows   || [])) faceMap[r.ITEM_ID]   = Number(r.face_on_hand   || 0);
  const sourceMap = {};
  for (const r of (respSource.rows || [])) sourceMap[r.ITEM_ID] = Number(r.source_on_hand || 0);

  // Group tasks by item_id — dedupe task IDs (multiple detail rows per task)
  const taskMap = {};
  const statusLabel = { '3000':'Queued', '5000':'Assigned', '7000':'In Progress' };
  for (const r of (respTasks.rows || [])) {
    if (!r.ITEM_ID) continue;
    if (!taskMap[r.ITEM_ID]) taskMap[r.ITEM_ID] = {};
    if (!taskMap[r.ITEM_ID][r.TASK_ID]) {
      taskMap[r.ITEM_ID][r.TASK_ID] = {
        task_id: r.TASK_ID,
        status:  statusLabel[String(r.STATUS)] || String(r.STATUS),
        source:  r.SOURCE_LOCATION_ID || null,
        target:  r.TARGET_LOCATION_ID || null,
      };
    }
  }

  const nowMs = Date.now();
  const items = [];
  const riskOrderIds = new Set();

  for (const r of (respOrders.rows || [])) {
    const itemId      = r.ITEM_ID;
    const unitsNeeded = Math.round(Number(r.units_needed || 0));
    const faceStock   = faceMap[itemId]   || 0;
    const sourceStock = sourceMap[itemId] || 0;
    const gap         = faceStock - unitsNeeded;
    const tasks       = taskMap[itemId] ? Object.values(taskMap[itemId]) : [];

    // Only retail items: must have R1H/R2H reserve stock OR an open replen task
    const isRetailItem = sourceStock > 0 || tasks.length > 0;
    if (!isRetailItem) continue;

    // Only surface items where face stock can't cover demand
    if (gap >= 0) continue;

    const oldestUtc  = r.oldest_order_utc;
    const ageHrs     = oldestUtc
      ? Math.round((nowMs - new Date(String(oldestUtc).replace(' ','T') + 'Z').getTime()) / 36000) / 100
      : null;
    const ageSeverity = ageHrs === null ? 'green'
      : ageHrs >= 28.8 ? 'red'
      : ageHrs >= 15   ? 'yellow'
      : 'green';

    const orderIds = (r.order_ids || '').split(',').filter(Boolean);
    orderIds.forEach(o => riskOrderIds.add(o));

    items.push({
      item_id:       itemId,
      order_count:   Number(r.order_count),
      units_needed:  unitsNeeded,
      face_stock:    Math.round(faceStock),
      source_stock:  Math.round(sourceStock),
      gap:           Math.round(gap),
      order_ids:     orderIds,
      oldest_order_utc: oldestUtc || null,
      age_hrs:       ageHrs,
      age_severity:  ageSeverity,
      tasks,
    });
  }

  // Sort: red first, then yellow, then by age desc
  const sevOrder = { red: 0, yellow: 1, green: 2 };
  items.sort((a, b) =>
    sevOrder[a.age_severity] - sevOrder[b.age_severity] ||
    (b.age_hrs || 0) - (a.age_hrs || 0)
  );

  const totalOrders = riskOrderIds.size; // unique order IDs across all flagged items
  const totalTasks  = items.reduce((s, i) => s + i.tasks.length, 0);
  const oldestItem  = items.length ? items.reduce((a, b) => (b.age_hrs || 0) > (a.age_hrs || 0) ? b : a) : null;

  return {
    generated:    new Date().toISOString().slice(0,19),
    facility:     FACILITY,
    summary: {
      flagged_items:     items.length,
      orders_at_risk:    totalOrders,
      open_replen_tasks: totalTasks,
      oldest_age_hrs:    oldestItem ? oldestItem.age_hrs : null,
    },
    items,
  };
}



// ── batch status query ─────────────────────────────────────────────────────────
// Status codes: 5000=Released, 5200=Released(picking assigned),
//               5400=Picking Completed, 5600=Work Started, 5800=Cleared
const BATCH_STATUS_LABELS = {
  '5000': 'Released',
  '5200': 'Picking Started',
  '5400': 'Picking Completed',
  '5600': 'Work Started',
  '5800': 'Cleared',
};

async function fetchBatchStatus(accessToken) {
  const nowUtc = new Date();
  // 1st shift: 3:00 AM – 1:59 PM local; 2nd shift: 2:00 PM – 2:59 AM local (DST-aware)
  const batchShift   = currentShift({ firstFrom: 3, secondFrom: 14, firstStart: [3, 0], secondStart: [14, 0] }, nowUtc);
  const is1stShift   = batchShift.is1st;
  const shiftLabel   = is1stShift ? '1st shift' : '2nd shift';
  const startStr     = batchShift.startSql;

  // Lookback: 72h covers Friday-afternoon batches still open on Sunday-morning 1st shift
  const lookbackStart = new Date(nowUtc.getTime() - 72 * 3600000)
    .toISOString().replace('T',' ').slice(0,19);

  // One row per BATCH_ID — that is the friendly batch name (B_000...)
  // WORK_RELEASE_BATCH_ID groups batches released together (used for interval calc)
  // Three inclusion arms:
  //   1. Created this shift (born on 2nd shift)
  //   2. Cleared this shift (1st-shift batch that finished on 2nd shift)
  //   3. Still active (not cleared) but created within 14h — 1st-shift carryovers
  const sql = `
SELECT
  BATCH_ID,
  WORK_RELEASE_BATCH_ID,
  STATUS_ID,
  TOTAL_ORDERS,
  TOTAL_OLPNS,
  TOTAL_NUMBER_OF_TASKS,
  TOTAL_NUMBER_OF_TASKS_DETAILS,
  CREATED_TIMESTAMP,
  UPDATED_TIMESTAMP
FROM default_workrelease.WR_BATCH
WHERE FACILITY_ID = '${FACILITY}'
  AND (
    CREATED_TIMESTAMP >= '${startStr}'
    OR (STATUS_ID = 5800 AND UPDATED_TIMESTAMP >= '${startStr}')
    OR (STATUS_ID != 5800 AND CREATED_TIMESTAMP >= '${lookbackStart}')
  )
ORDER BY CREATED_TIMESTAMP ASC, BATCH_ID ASC`.trim();

  // Queued orders = waved multi-line orders not yet absorbed into an active batch.
  // Formula: COUNT(DISTINCT waved multis) - SUM(TOTAL_ORDERS of active batches).
  // Batches only contain multi-line orders; singles go through a separate path.
  // WR_ALLOCATION (the direct staging table) is ephemeral and always empty by query time.
  // Direct count: waved multi-line orders (status 2090) that have no task
  // detail row tied to any batch this shift = truly queued, not yet released.
  const sqlQueued = `
SELECT COUNT(DISTINCT o.ORDER_ID) AS queued_orders
FROM default_dcorder.DCO_ORDER o
WHERE o.FACILITY_ID     = '${FACILITY}'
  AND o.ORDER_TYPE      = 'ECOM'
  AND o.CANCELLED       = 0
  AND o.SINGLE_LINE_ORDER = 0
  AND o.MAXIMUM_STATUS  = '2090'
  AND NOT EXISTS (
    SELECT 1
    FROM default_task.TSK_TASK_DETAIL td
    WHERE td.FACILITY_ID         = '${FACILITY}'
      AND td.ORDER_ID            = o.ORDER_ID
      AND td.RESOURCE_BATCH_ID   IS NOT NULL
      AND td.CREATED_TIMESTAMP   >= '${lookbackStart}'
  )`.trim();

  const sqlQueuedUnits = `
SELECT SUM(ol.ORDERED_QUANTITY) AS queued_units
FROM default_dcorder.DCO_ORDER o
JOIN default_dcorder.DCO_ORDER_LINE ol
  ON ol.ORDER_ID    = o.ORDER_ID
 AND ol.FACILITY_ID = o.FACILITY_ID
 AND ol.CANCELLED   = 0
WHERE o.FACILITY_ID     = '${FACILITY}'
  AND o.ORDER_TYPE      = 'ECOM'
  AND o.CANCELLED       = 0
  AND o.SINGLE_LINE_ORDER = 0
  AND o.MAXIMUM_STATUS  = '2090'
  AND NOT EXISTS (
    SELECT 1
    FROM default_task.TSK_TASK_DETAIL td
    WHERE td.FACILITY_ID         = '${FACILITY}'
      AND td.ORDER_ID            = o.ORDER_ID
      AND td.RESOURCE_BATCH_ID   IS NOT NULL
      AND td.CREATED_TIMESTAMP   >= '${lookbackStart}'
  )`.trim();

  const resp = await mcpQuery(accessToken, sql);
  const rows = resp.rows || [];

  // Run queued orders + units queries after batch query to avoid parallel timeout
  let queuedOrders = null;
  let queuedUnits  = null;
  try {
    const respQueued = await mcpQuery(accessToken, sqlQueued);
    queuedOrders = Math.round(Number(respQueued.rows?.[0]?.queued_orders || 0));
  } catch(e) {
    console.warn(`  Queued orders query failed: ${e.message}`);
  }
  try {
    const respUnits = await mcpQuery(accessToken, sqlQueuedUnits);
    queuedUnits = Math.round(Number(respUnits.rows?.[0]?.queued_units || 0));
  } catch(e) {
    console.warn(`  Queued units query failed: ${e.message}`);
  }

  // MAWM timestamps have no timezone marker — always force UTC before converting
  const forceUtc = d => { const s = String(d).replace(' ','T'); return (s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s)) ? s : s + 'Z'; };
  const toPdt = d => {
    if (!d) return null;
    // Shift to DC499 local wall time (DST-aware) and read the UTC fields
    const pdt = pacificShifted(new Date(forceUtc(d)));
    const h = pdt.getUTCHours(), m = pdt.getUTCMinutes();
    return (h % 12 || 12) + ':' + String(m).padStart(2, '0') + ' ' + (h >= 12 ? 'PM' : 'AM');
  };

  // Build release events — group by WORK_RELEASE_BATCH_ID to get interval timestamps
  const releaseGroups = {};
  for (const r of rows) {
    const wrId = r.WORK_RELEASE_BATCH_ID;
    if (!releaseGroups[wrId]) releaseGroups[wrId] = r.CREATED_TIMESTAMP;
    else if (r.CREATED_TIMESTAMP < releaseGroups[wrId]) releaseGroups[wrId] = r.CREATED_TIMESTAMP;
  }
  const releaseOrder = Object.entries(releaseGroups)
    .sort((a, b) => a[1] < b[1] ? -1 : 1);

  // Map each WORK_RELEASE_BATCH_ID to its interval since the prior release
  const intervalMap = {};
  for (let i = 1; i < releaseOrder.length; i++) {
    const prev = new Date(forceUtc(releaseOrder[i-1][1]));
    const curr = new Date(forceUtc(releaseOrder[i][1]));
    intervalMap[releaseOrder[i][0]] = Math.round((curr - prev) / 60000);
  }

  const batches = rows.map((r, i) => {
    const statusCode  = String(r.STATUS_ID || '').split('.')[0];
    const isCleared   = statusCode === '5800';
    const releasedUtc = r.CREATED_TIMESTAMP;
    const clearedUtc  = isCleared ? r.UPDATED_TIMESTAMP : null;
    const minsToClear = (releasedUtc && clearedUtc)
      ? Math.round((new Date(forceUtc(clearedUtc)) - new Date(forceUtc(releasedUtc))) / 60000)
      : null;

    return {
      batch_num:              i + 1,
      batch_id:               r.BATCH_ID,
      work_release_batch_id:  r.WORK_RELEASE_BATCH_ID,
      total_orders:           Number(r.TOTAL_ORDERS),
      total_olpns:            Number(r.TOTAL_OLPNS),
      open_tasks:             null,
      total_tasks:            Number(r.TOTAL_NUMBER_OF_TASKS),
      total_task_details:     Number(r.TOTAL_NUMBER_OF_TASKS_DETAILS),
      status_code:            statusCode,
      status_label:           BATCH_STATUS_LABELS[statusCode] || statusCode,
      released_pdt:           toPdt(releasedUtc),
      cleared_pdt:            toPdt(clearedUtc),
      released_utc:           releasedUtc,
      cleared_utc:            clearedUtc,
      mins_to_clear:          minsToClear,
      is_cleared:             isCleared,
      mins_since_prev_release: intervalMap[r.WORK_RELEASE_BATCH_ID] ?? null,
      status_updated_utc:     r.UPDATED_TIMESTAMP || null,
    };
  });

  const cleared     = batches.filter(b => b.is_cleared);
  // Only average batches released this shift (CREATED >= shiftStart) so lingering
  // cross-midnight batches don't skew the number.
  const clearedThisShift = cleared.filter(b =>
    b.released_utc && new Date(forceUtc(b.released_utc)) >= batchShift.start
  );
  const avgClear    = clearedThisShift.length
    ? Math.round(clearedThisShift.reduce((s,b) => s + b.mins_to_clear, 0) / clearedThisShift.length)
    : null;
  const intervals   = Object.values(intervalMap);
  const avgInterval = intervals.length
    ? Math.round(intervals.reduce((s,v) => s+v, 0) / intervals.length)
    : null;

  return {
    generated:        new Date().toISOString().slice(0,19),
    facility:         FACILITY,
    shift_label:      shiftLabel,
    shift_start_utc:  startStr,
    summary: {
      total_batches:             batches.length,
      cleared_batches:           cleared.length,
      active_batches:            batches.length - cleared.length,
      avg_mins_to_clear:         avgClear,
      avg_release_interval_mins: avgInterval,
      queued_orders:             queuedOrders,
      queued_units:              queuedUnits,
      batch_threshold:           36,
    },
    batches,
  };
}

// ── Teams: cleared batch notifier ─────────────────────────────────────────────
const AUTH_PIN = '020405';
const TEAMS_WEBHOOK_AUTH_ALERT = 'https://defaultc291be2656fe41058955fec9bd564d.a1.environment.api.powerplatform.com:443/powerautomate/automations/direct/cu/30/workflows/db4396647efa46f783e0ed9a5d09e32f/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=cc2r54fuKyh7imNXiOuF9NmPNVpqWF5j8s6ojHAEVxI';

const TEAMS_WEBHOOKS_BATCHES = {
  '1st': 'https://defaultc291be2656fe41058955fec9bd564d.a1.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/a26c40b1c9ee4739abd0269aedbef04b/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=mkz_8DUX8eAfH1clRiMjPNXFz-zCT0bwAJeEMxkZwHY',
  '2nd': 'https://defaultc291be2656fe41058955fec9bd564d.a1.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/d4415440c8004523a34336a1a21e6dae/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=3rc4Q7Kri1_ckmNi8w2a0-l-vdH6Culds71BHgP8Pvk',
};
function getShiftLabel() {
  const h = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })).getHours();
  if (h >= 6  && h < 14) return '1st';
  if (h >= 14 && h < 22) return '2nd';
  return '3rd';
}
const SENT_BATCHES_FILE = path.join(REPORT_DIR, '.sent_batches.json');

function loadSentBatches() {
  try { return new Set(JSON.parse(fs.readFileSync(SENT_BATCHES_FILE, 'utf8'))); }
  catch { return new Set(); }
}
function saveSentBatches(set) {
  try { fs.writeFileSync(SENT_BATCHES_FILE, JSON.stringify([...set])); } catch {}
}

async function notifyNewCleared(batchStatusData) {
  if (!batchStatusData?.batches) return;
  const cleared = batchStatusData.batches.filter(b => b.is_cleared);
  if (!cleared.length) return;

  const sent    = loadSentBatches();
  const newOnes = cleared.filter(b => !sent.has(b.batch_id));
  if (!newOnes.length) return;

  const s          = batchStatusData.summary || {};
  const shiftLabel = batchStatusData.shift_label || '2nd shift';
  const tsPdt = pacificShifted(new Date());   // local wall time, DST-aware
  const tsStr = (tsPdt.getUTCHours() % 12 || 12) + ':' +
                String(tsPdt.getUTCMinutes()).padStart(2,'0') + ' ' +
                (tsPdt.getUTCHours() >= 12 ? 'PM' : 'AM');

  const batchCards = newOnes.map((b, i) => ({
    type: 'Container',
    separator: i > 0,
    spacing: i > 0 ? 'Small' : 'None',
    items: [
      { type: 'ColumnSet', spacing: 'Small', columns: [
        { type: 'Column', width: 'stretch', items: [
          { type: 'TextBlock', text: `✅  ${b.batch_id || '—'}`, weight: 'Bolder', size: 'Medium', color: 'Good', wrap: false },
          { type: 'TextBlock', text: `Released  ${b.released_pdt || '—'}   →   Cleared  ${b.cleared_pdt || '—'}`, size: 'Small', isSubtle: true, spacing: 'None', wrap: true },
        ]},
        { type: 'Column', width: 'auto', verticalContentAlignment: 'Center', items: [
          { type: 'TextBlock', text: b.mins_to_clear != null ? `${b.mins_to_clear} min` : '—', weight: 'Bolder', size: 'ExtraLarge', color: 'Good', horizontalAlignment: 'Right', spacing: 'None' },
          { type: 'TextBlock', text: `${b.total_olpns || '—'} oLPNs`, size: 'Small', isSubtle: true, spacing: 'None', horizontalAlignment: 'Right' },
        ]},
      ]},
    ],
  }));

  const card = {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard', version: '1.4',
        body: [
          { type: 'Container', style: 'attention', items: [{ type: 'ColumnSet', columns: [
            { type: 'Column', width: 'auto',    items: [{ type: 'TextBlock', text: 'DC499 · Batches', weight: 'Bolder', size: 'Medium', color: 'Light' }] },
            { type: 'Column', width: 'stretch', items: [{ type: 'TextBlock', text: `${shiftLabel} · ${tsStr}`, color: 'Light', isSubtle: true, horizontalAlignment: 'Right' }] },
          ]}]},
          { type: 'Container', spacing: 'Medium', items: [{ type: 'ColumnSet', columns: [
            { type: 'Column', width: 'stretch', items: [{ type: 'TextBlock', text: 'Total',    size: 'Small', isSubtle: true, weight: 'Bolder' }, { type: 'TextBlock', text: String(s.total_batches   || 0), size: 'ExtraLarge', weight: 'Bolder', spacing: 'None' }] },
            { type: 'Column', width: 'stretch', items: [{ type: 'TextBlock', text: 'Cleared',  size: 'Small', isSubtle: true, weight: 'Bolder' }, { type: 'TextBlock', text: String(s.cleared_batches || 0), size: 'ExtraLarge', weight: 'Bolder', spacing: 'None', color: 'Good'    }] },
            { type: 'Column', width: 'stretch', items: [{ type: 'TextBlock', text: 'Active',   size: 'Small', isSubtle: true, weight: 'Bolder' }, { type: 'TextBlock', text: String(s.active_batches  || 0), size: 'ExtraLarge', weight: 'Bolder', spacing: 'None', color: 'Warning' }] },
            { type: 'Column', width: 'stretch', items: [{ type: 'TextBlock', text: 'Avg Clear',size: 'Small', isSubtle: true, weight: 'Bolder' }, { type: 'TextBlock', text: s.avg_mins_to_clear != null ? `${s.avg_mins_to_clear} min` : '—', size: 'ExtraLarge', weight: 'Bolder', spacing: 'None' }] },
          ]}]},
          { type: 'Container', separator: true, spacing: 'Medium', style: 'emphasis', items: [
            { type: 'TextBlock', text: `Newly Cleared  ·  ${newOnes.length} batch${newOnes.length > 1 ? 'es' : ''}`, weight: 'Bolder', size: 'Small', spacing: 'Small', color: 'Good', isSubtle: false },
            ...batchCards,
          ]},
        ],
      },
    }],
  };

  // Write sent list BEFORE posting so a concurrent process sees it and skips
  saveSentBatches(new Set([...sent, ...newOnes.map(b => b.batch_id)]));
  try {
    const webhook = TEAMS_WEBHOOKS_BATCHES[getShiftLabel()] || TEAMS_WEBHOOKS_BATCHES['2nd'];
    await jsonPost(webhook, JSON.stringify(card), { 'Content-Type': 'application/json' });
    console.log(`[${ts()}] ✓ Teams — notified ${newOnes.length} newly cleared batch(es)`);
  } catch (e) {
    console.warn(`[${ts()}]   Teams batch notify failed: ${e.message}`);
  }
}

async function notifyAuthExpired() {
  const tsPdt = pacificShifted(new Date());   // local wall time, DST-aware
  const tsStr = (tsPdt.getUTCHours() % 12 || 12) + ':' +
                String(tsPdt.getUTCMinutes()).padStart(2,'0') + ' ' +
                (tsPdt.getUTCHours() >= 12 ? 'PM' : 'AM');
  const body = {
    text: `DC499 Live Server — Auth token expired at ${tsStr}. The server cannot query MAWM until re-authed. To restore: open Chrome on the server PC and go to localhost:3001/auth?pin=020405 — page closes automatically when done.`,
  };
  try {
    await jsonPost(TEAMS_WEBHOOK_AUTH_ALERT, JSON.stringify(body), { 'Content-Type': 'application/json' });
    console.log(`[${ts()}] ✓ Teams — auth-expired notification sent`);
  } catch (e) {
    console.warn(`[${ts()}]   Teams auth notify failed: ${e.message}`);
  }
}

// ── git push ───────────────────────────────────────────────────────────────────
// Where git keeps its files. Since 10/2 the history lives outside OneDrive
// (C:\Users\JLEO\SCOUT-git) and .git here is a one-line pointer file, so ask git.
let _gitDir = null;
function gitDir() {
  if (!_gitDir) {
    try { _gitDir = execSync('git rev-parse --absolute-git-dir', { cwd: REPORT_DIR, stdio: 'pipe' }).toString().trim(); }
    catch { return path.join(REPORT_DIR, '.git'); }
  }
  return _gitDir;
}

function gitPush() {
  const stamp = new Date().toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
  try {
    // Remove stale index.lock left by a killed/crashed prior cycle
    try { fs.unlinkSync(path.join(gitDir(), 'index.lock')); } catch {}
    execSync('git add receiving_live.json totes_live.json backlog_live.json batch_status.json retail_replen.json shipped_live.json tasks_live.json ecom_live.json ecom_history.json shipping_live.json reserve_live.json putaway_live.json expedite_live.json retail_backlog_live.json container_watch_live.json untasked_live.json dead_shelves_live.json empty_locations_live.json',  { cwd: REPORT_DIR, stdio: 'pipe' });
    const staged = execSync('git diff --cached --name-only', { cwd: REPORT_DIR, stdio: 'pipe' }).toString().trim().split('\n').filter(Boolean);
    const LABELS = { 'receiving_live.json': 'receiving', 'ecom_live.json': 'ecom', 'shipping_live.json': 'shipping', 'reserve_live.json': 'reserve', 'putaway_live.json': 'putaway', 'expedite_live.json': 'expedite', 'retail_backlog_live.json': 'retail', 'container_watch_live.json': 'watch', 'untasked_live.json': 'untasked', 'dead_shelves_live.json': 'dead', 'empty_locations_live.json': 'empty' };
    const extras = staged.map(f => LABELS[f]).filter(Boolean);
    const suffix = extras.length ? ` [+${extras.join(', ')}]` : '';
    execSync(`git commit -m "Live update -- ${stamp}${suffix}"`,    { cwd: REPORT_DIR, stdio: 'pipe' });
    execSync('git fetch origin main',                               { cwd: REPORT_DIR, stdio: 'pipe', timeout: 60000 });
    execSync('git rebase --autostash origin/main',                  { cwd: REPORT_DIR, stdio: 'pipe' });
    execSync('git push origin main',                                { cwd: REPORT_DIR, stdio: 'pipe', timeout: 60000 });
    console.log(`[${ts()}] ✓ Pushed to git${suffix}`);
  } catch (e) {
    const msg = e.stderr?.toString() || e.stdout?.toString() || e.message;
    if (msg.includes('nothing to commit') || msg.includes('nothing added')) {
      console.log(`[${ts()}]   Git: nothing new to commit`);
    } else {
      console.warn(`[${ts()}]   Git push failed: ${msg.slice(0, 200)}`);
    }
  }
}

// ── shipped oLPNs query ────────────────────────────────────────────────────────
async function fetchShipped(accessToken) {
  // 1st shift counts from 6:00 AM, 2nd from 2:10 PM local (matches Ecom Live); DST-aware
  const shippedShift  = currentShift({ firstFrom: 3, secondFrom: 14, firstStart: [6, 0], secondStart: [14, 10] });
  const is1st         = shippedShift.is1st;
  const shiftStartStr = shippedShift.startSql;

  // TSK_ACTIVITY_TRACKING gives per-scan real-time counts — PPK_OLPN only updates in batches
  // 2nd shift: OB Putaway By Ship Via (ship-via scan). 1st shift adds NRDR Load Parcel Packages.
  const txIds = is1st
    ? `'OB Putaway By Ship Via','NRDR Load Parcel Packages'`
    : `'OB Putaway By Ship Via'`;

  const sql = `
SELECT
  COUNT(DISTINCT CONTAINER_ID) AS shipped_olpns,
  SUM(QUANTITY)                AS shipped_units
FROM default_task.TSK_ACTIVITY_TRACKING
WHERE FACILITY_ID = '${FACILITY}'
  AND CREATED_TIMESTAMP >= '${shiftStartStr}'
  AND TRANSACTION_ID IN (${txIds})`.trim();

  const resp = await mcpQuery(accessToken, sql);
  const row  = (resp.rows || [])[0] || {};
  return {
    generated:     new Date().toISOString().slice(0, 19),
    facility:      FACILITY,
    shift:         is1st ? '1st' : '2nd',
    shift_start:   shiftStartStr,
    shipped_olpns: Number(row.shipped_olpns || 0),
    shipped_units: Number(row.shipped_units || 0),
  };
}

// ── ecom tasks query ───────────────────────────────────────────────────────────
async function fetchTaskData(accessToken) {
  // 1st 3:00 AM, 2nd 2:00 PM local (DST-aware)
  const taskShift  = currentShift({ firstFrom: 3, secondFrom: 14, firstStart: [3, 0], secondStart: [14, 0] });
  const is1st      = taskShift.is1st;
  const shiftLabel = is1st ? '1st' : '2nd';
  const startStr   = taskShift.startSql;

  // Two separate queries — ASSIGNED_USER_ID and PLANNED_START_TIME crash the connector (likely PII gate)
  // Safe columns only: TASK_ID, STATUS, TRANSACTION_ID, LABOR_ACTIVITY_ID, SOURCE_LOCATION_ID, TARGET_LOCATION_ID, CREATED_TIMESTAMP
  // Filter on TRANSACTION_ID not LABOR_ACTIVITY_ID — many tasks have 'Default Picking Activity' in LABOR_ACTIVITY_ID
  // but always have the correct ecom pick transaction name in TRANSACTION_ID
  const sqlPick = `
SELECT TASK_ID, STATUS, TRANSACTION_ID, LABOR_ACTIVITY_ID, SOURCE_LOCATION_ID,
  CONVERT_TZ(CREATED_TIMESTAMP, '+00:00', ${SQL_TZ}) AS created_pdt
FROM default_task.TSK_TASK
WHERE FACILITY_ID = '${FACILITY}'
  AND STATUS != '9000'
  AND TRANSACTION_ID IN ('Ecom Mezz Pick To Putwall Cart','Ecom Non-Mezz Pick To Putwall Cart')
  AND (
    CREATED_TIMESTAMP >= '${startStr}'
    OR (STATUS IN ('3000','5000','7000') AND CREATED_TIMESTAMP >= NOW() - INTERVAL 2 DAY)
  )
ORDER BY CREATED_TIMESTAMP ASC`.trim();

  const sqlReplen = `
SELECT TASK_ID, STATUS, LABOR_ACTIVITY_ID, SOURCE_LOCATION_ID, TARGET_LOCATION_ID,
  CONVERT_TZ(CREATED_TIMESTAMP, '+00:00', ${SQL_TZ}) AS created_pdt
FROM default_task.TSK_TASK
WHERE FACILITY_ID = '${FACILITY}'
  AND STATUS != '9000'
  AND LEFT(SOURCE_LOCATION_ID, 3) IN ('R1B','R1C','R1D','R1E','R1F')
  AND TRANSACTION_ID IN ('iLPN Replen Pull','iLPN Replen Pull Large','iLPN Replen Fill','iLPN Replen Fill Large')
  AND TASK_ID NOT LIKE 'CC%'
  AND (
    CREATED_TIMESTAMP >= '${startStr}'
    OR (STATUS IN ('3000','5000','7000') AND CREATED_TIMESTAMP >= NOW() - INTERVAL 2 DAY)
  )
ORDER BY CREATED_TIMESTAMP ASC`.trim();

  const sqlPickDrop = `
SELECT
  i.ILPN_ID,
  i.CURRENT_LOCATION_ID AS location,
  COALESCE(SUM(inv.ON_HAND), 0) AS on_hand,
  CONVERT_TZ(i.UPDATED_TIMESTAMP, '+00:00', ${SQL_TZ}) AS updated_pst
FROM default_dcinventory.DCI_ILPN i
LEFT JOIN default_dcinventory.DCI_INVENTORY inv
  ON  inv.ILPN_ID     = i.ILPN_ID
  AND inv.FACILITY_ID = '${FACILITY}'
WHERE i.FACILITY_ID         = '${FACILITY}'
  AND i.CURRENT_LOCATION_ID LIKE 'P1-PK%'
  AND i.STATUS             != '9000'
  AND i.IS_CLOSED           = 0
GROUP BY i.ILPN_ID, i.CURRENT_LOCATION_ID, i.UPDATED_TIMESTAMP
ORDER BY i.CURRENT_LOCATION_ID, i.UPDATED_TIMESTAMP`.trim();

  const sqlFlowCarts = `
SELECT
  i.ILPN_ID,
  i.CURRENT_LOCATION_ID AS location,
  COALESCE(SUM(inv.ON_HAND), 0) AS on_hand,
  CONVERT_TZ(i.UPDATED_TIMESTAMP, '+00:00', ${SQL_TZ}) AS updated_pst
FROM default_dcinventory.DCI_ILPN i
LEFT JOIN default_dcinventory.DCI_INVENTORY inv
  ON  inv.ILPN_ID     = i.ILPN_ID
  AND inv.FACILITY_ID = '${FACILITY}'
WHERE i.FACILITY_ID         = '${FACILITY}'
  AND i.CURRENT_LOCATION_ID LIKE 'P1-FC%'
  AND i.STATUS             != '9000'
  AND i.IS_CLOSED           = 0
GROUP BY i.ILPN_ID, i.CURRENT_LOCATION_ID, i.UPDATED_TIMESTAMP
ORDER BY i.CURRENT_LOCATION_ID, i.UPDATED_TIMESTAMP`.trim();

  const [pickResp, replenResp, pickDropResp, flowCartsResp] = await Promise.all([
    mcpQuery(accessToken, sqlPick),
    mcpQuery(accessToken, sqlReplen),
    mcpQuery(accessToken, sqlPickDrop).catch(e => { console.warn(`  Pick-drop query failed: ${e.message}`); return { rows: [] }; }),
    mcpQuery(accessToken, sqlFlowCarts).catch(e => { console.warn(`  Flow-carts query failed: ${e.message}`); return { rows: [] }; }),
  ]);

  const STATUS_LABEL = { '3000':'Ready to Assign', '5000':'Assigned', '7000':'In Progress', '8000':'Completed' };
  function statusLabel(s) { return STATUS_LABEL[String(s)] || String(s); }

  function mapTask(r, type) {
    return {
      task_id:      r.TASK_ID,
      subtype:      r.TRANSACTION_ID === 'Ecom Mezz Pick To Putwall Cart' ? 'MEZZ' :
                    r.TRANSACTION_ID === 'Ecom Non-Mezz Pick To Putwall Cart' ? 'NON MEZZ' : r.LABOR_ACTIVITY_ID || 'REPLEN',
      status:       String(r.STATUS),
      status_label: statusLabel(r.STATUS),
      source:       r.SOURCE_LOCATION_ID || null,
      target:       r.TARGET_LOCATION_ID || null,
      created_pdt:  r.created_pdt || null,
    };
  }

  const pickTasks   = (pickResp.rows   || []).map(r => mapTask(r, 'pick'));
  const replenTasks = (replenResp.rows || []).map(r => mapTask(r, 'replen'));

  // Fetch detail counts per task using small TASK_ID batches (broad filters time out on this table)
  const allTasks   = [...pickTasks, ...replenTasks];
  const openIds    = [...new Set(allTasks.filter(t => t.status !== '8000').map(t => t.task_id))];
  const BATCH_SZ   = 15;
  const detailMap  = {};
  // Batches run side by side — the shared query slots in scout_mcp.js cap how many hit MAWM at once
  const batchStarts = [];
  for (let i = 0; i < openIds.length; i += BATCH_SZ) batchStarts.push(i);
  await Promise.all(batchStarts.map(async i => {
    const batchIds = openIds.slice(i, i + BATCH_SZ).map(id => `'${id}'`).join(',');
    const sqlDetail = `SELECT TASK_ID, COUNT(*) AS detail_count FROM default_task.TSK_TASK_DETAIL WHERE FACILITY_ID = '${FACILITY}' AND TASK_ID IN (${batchIds}) GROUP BY TASK_ID`;
    try {
      const dr = await mcpQuery(accessToken, sqlDetail);
      for (const r of (dr.rows || [])) detailMap[r.TASK_ID] = Number(r.detail_count);
      console.log(`[${ts()}]   task detail batch ${Math.floor(i/BATCH_SZ)+1}: ${(dr.rows||[]).length} rows`);
    } catch (e) {
      console.warn(`  Task detail batch ${Math.floor(i/BATCH_SZ)+1} failed: ${e.message}`);
    }
  }));
  for (const t of allTasks) {
    t.detail_count = detailMap[t.task_id] ?? null;
  }

  function summarize(tasks) {
    const counts = { queued:0, assigned:0, in_progress:0, completed:0, total_open:0 };
    for (const t of tasks) {
      if      (t.status === '8000') counts.completed++;
      else if (t.status === '7000') { counts.in_progress++; counts.total_open++; }
      else if (t.status === '5000') { counts.assigned++;    counts.total_open++; }
      else                          { counts.queued++;      counts.total_open++; }
    }
    return counts;
  }

  function buildCartMap(rows) {
    const map = {};
    for (const r of (rows || [])) {
      const loc = r.location;
      if (!map[loc]) map[loc] = { location: loc, ilpns: [], total_units: 0 };
      const ageMin = r.updated_pst ? Math.round((Date.now() - parsePacific(r.updated_pst).getTime()) / 60000) : null;
      map[loc].ilpns.push({ ilpn_id: r.ILPN_ID, on_hand: Number(r.on_hand) || 0, updated_pst: r.updated_pst, age_min: ageMin });
      map[loc].total_units += Number(r.on_hand) || 0;
    }
    const carts = Object.values(map).sort((a, b) => a.location.localeCompare(b.location));
    for (const cart of carts) {
      cart.oldest_min = cart.ilpns.reduce((mx, i) => i.age_min != null && i.age_min > mx ? i.age_min : mx, 0);
    }
    return carts;
  }

  const pick_drop_carts = buildCartMap(pickDropResp.rows);
  const flow_carts      = buildCartMap(flowCartsResp.rows);

  return {
    generated:   new Date().toISOString(),
    shift:       shiftLabel,
    shift_start: startStr,
    facility:    FACILITY,
    picking:  { ...summarize(pickTasks),   tasks: pickTasks   },
    replen:   { ...summarize(replenTasks), tasks: replenTasks },
    pick_drop_carts,
    flow_carts,
  };
}

// ── core: query + write ────────────────────────────────────────────────────────
async function queryAndWrite(accessToken) {
  console.log(`[${ts()}] Querying...`);
  // All 6 fetch functions start together. (Receiving moved to scout_receiving_agent.js 2026-10-05.) scout_mcp.js caps MAWM queries in flight across
  // every agent (and gives this cycle first claim), so starting them all at once is safe.
  const cycleStart = Date.now();
  takeStats();   // reset per-query timing for this cycle
  const sectionMs = {};
  const timed = (name, p) => p.then(
    v => { sectionMs[name] = Date.now() - cycleStart; return v; },
    e => { sectionMs[name] = Date.now() - cycleStart; console.warn(`  ${name} query failed: ${e.message}`); return null; });
  const [backlogData, batchStatusData, retailReplenData, totesData, shippedData, tasksData] = await Promise.all([
    timed('Backlog',       fetchBacklog(accessToken)),
    timed('Batch status',  fetchBatchStatus(accessToken)),
    timed('Retail replen', fetchRetailReplen(accessToken)),
    timed('Totes',         fetchTotes(accessToken)),
    timed('Shipped',       fetchShipped(accessToken)),
    timed('Tasks',         fetchTaskData(accessToken)),
  ]);
  const queryMs = Date.now() - cycleStart;
  const qs = takeStats();

  if (totesData) {
    fs.writeFileSync(TOTES_FILE, JSON.stringify(totesData, null, 4));
    console.log(`[${ts()}] ✓ totes_live.json — ${totesData.summary.total} open totes`);
  }

  if (backlogData) {
    fs.writeFileSync(BACKLOG_FILE, JSON.stringify(backlogData, null, 4));
    const today = backlogData.dates[0];
    const open = today.ready + today.allocated + today.packed;
    console.log(`[${ts()}] ✓ backlog_live.json — ${open} open lines today`);
  }

  if (batchStatusData) {
    fs.writeFileSync(BATCH_STATUS_FILE, JSON.stringify(batchStatusData, null, 4));
    console.log(`[${ts()}] ✓ batch_status.json — ${batchStatusData.summary.total_batches} batches, ${batchStatusData.summary.cleared_batches} cleared`);
    await notifyNewCleared(batchStatusData);
  }

  if (retailReplenData) {
    fs.writeFileSync(RETAIL_REPLEN_FILE, JSON.stringify(retailReplenData, null, 4));
    console.log(`[${ts()}] ✓ retail_replen.json — ${retailReplenData.summary.flagged_items} items flagged, ${retailReplenData.summary.orders_at_risk} orders at risk`);
  }

  if (tasksData) {
    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasksData, null, 4));
    const pOpen = tasksData.picking.total_open, rOpen = tasksData.replen.total_open;
    console.log(`[${ts()}] ✓ tasks_live.json — pick open:${pOpen} replen open:${rOpen}`);
  }

  if (shippedData) {
    fs.writeFileSync(SHIPPED_FILE, JSON.stringify(shippedData, null, 4));
    console.log(`[${ts()}] ✓ shipped_live.json — ${shippedData.shipped_olpns} oLPNs, ${shippedData.shipped_units} units`);
  }

  // Keep the team's OneDrive share folder (SCOUT Live) up to date with any page edits
  const shared = syncSharePages();
  if (shared) console.log(`[${ts()}] ✓ Share folder — ${shared} page file(s) updated`);

  const gitStart = Date.now();
  gitPush();
  const gitMs = Date.now() - gitStart;
  // One line per cycle so slow spots are easy to see in the window
  const sec = ms => (ms / 1000).toFixed(1) + 's';
  const last = Object.entries(sectionMs).sort((a, b) => b[1] - a[1])[0];
  console.log(`[${ts()}] ⏱ cycle ${sec(Date.now() - cycleStart)} — queries ${sec(queryMs)} (last to finish: ${last ? last[0] : '-'}), git ${sec(gitMs)} · ${qs.n} queries${qs.failed ? ` (${qs.failed} failed)` : ''}, longest slot wait ${sec(qs.waitMax)}, slowest: ${qs.slow.map(q => q.label + ' ' + sec(q.runMs)).join(', ') || '-'}`);
  return { totesData, backlogData, batchStatusData, retailReplenData, tasksData, shippedData };
}

// ── serve mode ─────────────────────────────────────────────────────────────────
async function serveMode(port, intervalMin, accessToken, openPage) {
  // Detect local IP once at startup for use in auth notifications
  let localIp = 'localhost';
  try {
    const { networkInterfaces } = require('os');
    for (const ifaces of Object.values(networkInterfaces())) {
      for (const i of ifaces) {
        if (i.family === 'IPv4' && !i.internal) { localIp = i.address; break; }
      }
    }
  } catch {}

  let cache          = null;
  let authNeeded     = false;
  let reauthing      = false;
  let authNotified   = false;

  let refreshing     = false;

  async function refresh() {
    // Skip if the previous cycle is still running — overlapping cycles share the 2-slot
    // query semaphore, slow each other down, and pile up (data landed 6–11 min stale).
    if (refreshing) { console.log(`[${ts()}] Previous cycle still running — skipping this tick`); return; }
    refreshing = true;
    try {
      try {
        accessToken = await getAccessTokenSilent();
        authNeeded   = false;
        authNotified = false; // clear flag so next expiry re-alerts
      } catch (e) {
        if (e instanceof AuthError) {
          authNeeded = true;
          if (!authNotified) {
            authNotified = true;
            console.log(`\n[${ts()}] Token expired — sending Teams alert...`);
            notifyAuthExpired().catch(() => {});
          }
          return; // skip this cycle, retry next interval
        }
        throw e;
      }
      cache = await queryAndWrite(accessToken);
      console.log(`[${ts()}] ✓ Cache updated`);
    } catch (e) {
      console.error(`[${ts()}] Refresh failed: ${e.message}`);
    } finally {
      refreshing = false;
    }
  }


  console.log(`[${ts()}] Starting initial query...`);
  await refresh();

  const intervalMs = intervalMin * 60 * 1000;
  setInterval(refresh, intervalMs);
  console.log(`[${ts()}] Auto-refresh every ${intervalMin} min`);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (url.pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({
        generated:   cache?.backlogData?.generated || null,
        nextRefresh: new Date(Date.now() + intervalMs).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles' }),
        auth_needed: authNeeded,
      }));
      return;
    }

    if (url.pathname === '/api/refresh') {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'refreshing' }));
      refresh();
      return;
    }

    if (url.pathname === '/auth') {
      if (url.searchParams.get('pin') !== AUTH_PIN) {
        res.writeHead(403, { 'Content-Type': 'text/html' });
        res.end('<h2>403 Forbidden</h2>');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>DC499 Re-Auth</title>
<style>body{font-family:sans-serif;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}
h2{color:#8ee8de}p{color:#aaa}</style></head>
<body><div><h2>Re-authenticating...</h2><p>Browser will open on the server PC.<br>This tab will close automatically.</p>
<script>setTimeout(()=>window.close(),4000)</script></div></body></html>`);
      if (!reauthing) {
        reauthing = true;
        console.log(`\n[${ts()}] /auth triggered remotely — opening browser for re-auth...`);
        doAuthFlow().then(tok => {
          accessToken  = tok;
          authNeeded   = false;
          reauthing    = false;
          authNotified = false;
          console.log(`[${ts()}] ✓ Re-authenticated via /auth endpoint`);
        }).catch(err => {
          reauthing = false;
          console.error(`[${ts()}] /auth re-auth failed: ${err.message}`);
        });
      }
      return;
    }

    // serve JSON files
    if (url.pathname === '/receiving_live.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(fs.existsSync(RECV_FILE) ? fs.readFileSync(RECV_FILE) : '{}');  // written by scout_receiving_agent.js
      return;
    }
    if (url.pathname === '/totes_live.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(cache?.totesData || {}));
      return;
    }
    if (url.pathname === '/backlog_live.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(cache?.backlogData || {}));
      return;
    }
    if (url.pathname === '/batch_status.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(cache?.batchStatusData || {}));
      return;
    }
    if (url.pathname === '/retail_replen.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(cache?.retailReplenData || {}));
      return;
    }
    if (url.pathname === '/tasks_live.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      const tasksPayload = cache?.tasksData || (fs.existsSync(TASKS_FILE) ? JSON.parse(fs.readFileSync(TASKS_FILE,'utf8')) : {});
      res.end(JSON.stringify(tasksPayload));
      return;
    }
    if (url.pathname === '/shipped_live.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(cache?.shippedData || {}));
      return;
    }
    if (url.pathname === '/expedite_live.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(fs.existsSync(EXPEDITE_FILE) ? fs.readFileSync(EXPEDITE_FILE) : '{}');
      return;
    }
    if (url.pathname === '/ecom_live.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      const ecomFile = path.join(REPORT_DIR, 'ecom_live.json');
      res.end(fs.existsSync(ecomFile) ? fs.readFileSync(ecomFile) : '{}');
      return;
    }
    if (url.pathname === '/reserve_live.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      const reserveFile = path.join(REPORT_DIR, 'reserve_live.json');
      res.end(fs.existsSync(reserveFile) ? fs.readFileSync(reserveFile) : '{}');
      return;
    }
    if (url.pathname === '/putaway_live.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      const putawayFile = path.join(REPORT_DIR, 'putaway_live.json');
      res.end(fs.existsSync(putawayFile) ? fs.readFileSync(putawayFile) : '{}');
      return;
    }

    // serve HTML files
    const fileMap = {
      '/':                    'index.html',
      '/index.html':          'index.html',
      '/Receiving_live.html': 'Receiving_live.html',
      '/Totes_live.html':     'Totes_live.html',
      '/Backlog_live.html':   'Backlog_live.html',
      '/Batches_live.html':   'Batches_live.html',
      '/Ecom_v3.html':        'Ecom_v3.html',
      '/RetailReplen_live.html': 'RetailReplen_live.html',
      '/MegaDash_v1.2.html':  'MegaDash_v1.2.html',
      '/Menu_v1.6.html':      'Menu_v1.6.html',
      '/Changelog.html':      'Changelog.html',
      '/Reserve_v1_7.html':      'Reserve_v1_7.html',
      '/Reserve_putaway.html':   'Reserve_putaway.html',
      '/Shipping_live.html':     'Shipping_live.html',
    };
    const file = fileMap[url.pathname];
    if (file) {
      const filePath = path.join(REPORT_DIR, file);
      if (fs.existsSync(filePath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(filePath));
        return;
      }
    }

    res.writeHead(404); res.end('Not found');
  });

  server.listen(port, () => {
    console.log(`\n┌────────────────────────────────────────────────────────┐`);
    console.log(`│  DC499 Reporter Live Server                            │`);
    console.log(`│                                                        │`);
    console.log(`│  Local:   http://localhost:${port}                       │`);
    console.log(`│  Network: http://${localIp}:${port}                  │`);
    console.log(`│                                                        │`);
    console.log(`│  Refresh: every ${String(intervalMin).padEnd(2)} min  (/api/refresh to force)  │`);
    console.log(`│  Ctrl+C to stop                                        │`);
    console.log(`└────────────────────────────────────────────────────────┘\n`);
    if (openPage) {
      const url = `http://localhost:${port}/${openPage}`;
      console.log(`[${ts()}] Opening ${url}`);
      const opener = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      try { execSync(`${opener} "${url}"`); } catch {}
    }
  });
}

// ── main ───────────────────────────────────────────────────────────────────────
async function main() {
  const isAuth  = process.argv.includes('--auth');
  const isServe = process.argv.includes('--serve');
  const port    = parseInt(process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || '3001');
  const ivMin   = parseInt(process.argv.find(a => a.startsWith('--interval='))?.split('=')[1] || '2');
  const openArg = process.argv.find(a => a.startsWith('--open='))?.split('=').slice(1).join('=') || null;

  console.log('DC499 Reporter Refresher');
  console.log('────────────────────────');

  let accessToken;
  if (isAuth) {
    console.log('Starting auth flow...');
    accessToken = await doAuthFlow();
  } else if (isServe) {
    // In serve mode, never open a browser — try silent refresh up to 3 times,
    // then start the server anyway so the loop can keep retrying every cycle.
    console.log('Getting access token (silent)...');
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        accessToken = await getAccessTokenSilent();
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < 3) {
          console.warn(`  Attempt ${attempt} failed: ${e.message} — retrying in 10s`);
          await new Promise(r => setTimeout(r, 10000));
        }
      }
    }
    if (!accessToken) {
      console.error(`⚠  Token refresh failed at startup: ${lastErr.message}`);
      console.error('   Server will start anyway and retry every cycle.');
      console.error('   To fix: run dc499.bat → option 4 (auth).');
      notifyAuthExpired().catch(() => {});
    }
  } else {
    console.log('Getting access token...');
    try {
      accessToken = await getAccessToken();
    } catch (e) {
      console.error('Error:', e.message);
      console.error('Token expired — sending Teams alert...');
      await notifyAuthExpired().catch(() => {});
      process.exit(1);
    }
  }
  if (accessToken) console.log('✓ Authenticated');

  if (isServe) {
    await serveMode(port, ivMin, accessToken || null, openArg);
    return;
  }

  // one-shot
  await queryAndWrite(accessToken);
  console.log('\nDone.');
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
