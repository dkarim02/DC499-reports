#!/usr/bin/env node
/**
 * SCOUT — Expedite Live Agent
 * Queries DCO_ORDER for expedite orders (DESIGNATED_SERVICE_LEVEL_ID = '11') and
 * enriches with PPK_OLPN location/carrier data. Writes expedite_live.json locally;
 * dc499_refresh.js pushes to GitHub on its next 2-min cycle.
 *
 * Usage:
 *   node scout_expedite_agent.js            one-shot refresh
 *   node scout_expedite_agent.js --auth     first-time auth / re-auth
 *   node scout_expedite_agent.js --serve    auto-refresh (default 3 min)
 *   node scout_expedite_agent.js --serve --interval=5
 */

const fs     = require('fs');
const path   = require('path');
require('./scout_file_mirror');  // also writes filedata/*.js so pages work from OneDrive (file://)
const { SQL_TZ, currentShift, pacificParts, pacificDateStr, utcFromPacific, addDays, sqlUtc, pacificMidnightSql } = require('./scout_tz');  // DST-aware local time
const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const { execSync } = require('child_process');

// ── config ─────────────────────────────────────────────────────────────────────
const MCP_BASE      = 'https://mawm-data-mcp.nordstromaws.app';
const TOKEN_FILE    = path.join(__dirname, '.mcp_token.json');
const OUTPUT_FILE   = path.join(__dirname, 'expedite_live.json');
const CLIENT_ID     = 'https://claude.ai/oauth/claude-code-client-metadata';
const REDIRECT_PORT = 3122;
const REDIRECT_URI  = `http://localhost:${REDIRECT_PORT}/callback`;
const FACILITY      = '499';
const LOOKBACK_DAYS = 5;    // open 1DD/2DD orders placed in the last 5 days (Dean, 10/12)
const OLPN_BATCH    = 200;  // order IDs per oLPN lookup
const SCAN_BATCH    = 200;  // oLPN IDs per pack/palletize scan lookup
const HOLD_MIN      = 60;   // 1DD oLPN packed this long with no pallet = held

// 1DD cutoff (verified vs EXT_ESTIMATEDSHIPBYDATETIME 10/14): placed 12:00 PM → 11:59 AM next day
// = due 12:00 PM PT that next day. Always earlier than placed + 24 hrs.
const CUTOFF_HR     = 12;
const PACK_TX       = ['NRDR CORE PACK FOR ECOM PACK STATION', 'CUSTOM PACK STATION'];
const PALLET_TX     = ['OB Putaway By Ship Via', 'NRDR CORE PALLETIZE OLPN', 'FLOOR LOAD PALLETIZE OLPN'];

// Splits tab (10/14): Ecom orders packed into 2+ oLPNs. The packer makes the extra boxes at the
// pack station (same CREATED_BY, ms apart) — the system doesn't plan them.
const SPLIT_DAYS    = 14;   // trend window
const SPLIT_LIST_DAYS = 7;  // orders listed in the table
const SPLIT_FILL    = 0.85; // a box counts as able to hold the order at 85% of its volume
const SPLIT_MAX_BOX = 'MD3';// "fits a bigger box" only up to this size
// Box volume (cu ft) by CONTAINER_SIZE_ID. PPK_OLPN.VOLUME doesn't always match the size, so use this.
const BOX_VOL = { XS1: 0.1004, PM2: 0.1875, SM1: 0.2513, PM5: 0.3125, SM5: 0.3242, SM3: 0.3653, PM6: 0.4388,
                  MD1: 0.5492, MD3: 0.9903, MD5: 1.2421, MD7: 1.3987, LG1: 1.5480, BT1: 1.6272, LG3: 1.8556,
                  LG5: 2.7778, LG7: 3.3367, XL1: 3.9976, XL3: 6.0447 };
const BOX_SIZES = ['XS1', 'SM1', 'SM5', 'SM3', 'MD1', 'MD3'];  // boxes (not mailers) we suggest, smallest first
const splitCache = {};      // ORDER_ID -> { svc, units, item_vol, items } for orders whose boxes are settled

const args       = process.argv.slice(2);
const MODE_AUTH  = args.includes('--auth');
const MODE_SERVE = args.includes('--serve');
const INTERVAL   = (() => {
  const f = args.find(a => a.startsWith('--interval='));
  return f ? parseInt(f.split('=')[1]) * 60 * 1000 : 3 * 60 * 1000;
})();

// ── MCP login + queries — shared by every agent, see scout_mcp.js ─────────────
const mcp = require('./scout_mcp')({ redirectPort: REDIRECT_PORT });
const { doAuthFlow, AuthError, getAccessTokenSilent, getAccessToken, mcpQuery } = mcp;

// ── helpers ────────────────────────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
}
// MAWM UTC string ('2026-10-14T18:34:18.181' / '2026-10-14 18:34:18') → ms
function utcMs(str) {
  if (!str) return NaN;
  let s = String(str).replace(' ', 'T');
  if (!/Z$|[+-]\d{2}:\d{2}$/.test(s)) s += 'Z';
  return new Date(s).getTime();
}
// 1DD due time: the next 12:00 PM PT at or after the order was placed (12:00:00 sharp → next day)
function dueCutoff(placedMs) {
  const d = new Date(placedMs);
  const ymd = pacificDateStr(d);
  return utcFromPacific(pacificParts(d).hour >= CUTOFF_HR ? addDays(ymd, 1) : ymd, CUTOFF_HR, 0).getTime();
}
const isoUtc = ms => isNaN(ms) ? null : new Date(ms).toISOString().slice(0, 19);

// ── main fetch ─────────────────────────────────────────────────────────────────
async function fetchExpedite(accessToken) {
  const nowUtc     = new Date();
  // Shift start — 1st 3:00 AM, 2nd 2:00 PM local (DST-aware); before 3 AM = yesterday's 2nd
  const sh         = currentShift({ firstFrom: 3, secondFrom: 14, firstStart: [3, 0], secondStart: [14, 0] }, nowUtc);
  const is1st      = sh.is1st;
  const shiftStart = sh.start;
  const shiftStartStr = sh.startSql;
  // Open orders: look back LOOKBACK_DAYS, not just this shift — before 10/12 the tab started empty
  // every shift while hundreds of 1DD/2DD orders from earlier shifts were still open.
  const lookbackStr = new Date(nowUtc.getTime() - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 19).replace('T', ' ');

  console.log(`[${ts()}] Expedite Live — ${is1st ? '1st' : '2nd'} shift, since ${shiftStartStr} UTC`);

  // Q1: not-yet-shipped 1DD + 2DD orders from the last LOOKBACK_DAYS
  const sqlOpen = `
SELECT
  o.ORDER_ID,
  o.MAXIMUM_STATUS,
  o.DESIGNATED_SERVICE_LEVEL_ID AS service_level_id,
  o.ORDER_PLACED_DATE_TIME AS placed_utc,
  o.EXT_ESTIMATEDSHIPBYDATETIME AS ship_by_utc,
  o.DELIVERY_END_DATE_TIME AS deliver_by_utc
FROM default_dcorder.DCO_ORDER o
WHERE o.FACILITY_ID = '${FACILITY}'
  AND o.ORDER_TYPE = 'ECOM'
  AND o.CANCELLED = 0
  AND o.DESIGNATED_SERVICE_LEVEL_ID IN ('11','42')
  AND o.MAXIMUM_STATUS NOT IN ('8000','9000')
  AND o.CREATED_TIMESTAMP >= '${lookbackStr}'
ORDER BY o.EXT_ESTIMATEDSHIPBYDATETIME ASC
LIMIT 3000`.trim();

  // Q2: shipped counts per service level this shift — orders that reached 8000 since shift start
  // (UPDATED_TIMESTAMP), placed in the lookback window. Before 10/12 = orders *created* this shift that shipped.
  const sqlShipped = `
SELECT DESIGNATED_SERVICE_LEVEL_ID AS svc, COUNT(*) AS shipped_count
FROM default_dcorder.DCO_ORDER
WHERE FACILITY_ID = '${FACILITY}'
  AND ORDER_TYPE = 'ECOM'
  AND CANCELLED = 0
  AND DESIGNATED_SERVICE_LEVEL_ID IN ('11','42')
  AND MAXIMUM_STATUS = '8000'
  AND CREATED_TIMESTAMP >= '${lookbackStr}'
  AND UPDATED_TIMESTAMP >= '${shiftStartStr}'
GROUP BY DESIGNATED_SERVICE_LEVEL_ID`.trim();

  // Q3: order line counts (Ecom = 1 unit/line, so line count = unit count)
  const sqlLines = `
SELECT ol.ORDER_ID, COUNT(*) AS line_count
FROM default_dcorder.DCO_ORDER_LINE ol
JOIN default_dcorder.DCO_ORDER o ON o.ORDER_ID = ol.ORDER_ID AND o.FACILITY_ID = ol.FACILITY_ID
WHERE ol.FACILITY_ID = '${FACILITY}'
  AND ol.CANCELLED = 0
  AND o.ORDER_TYPE = 'ECOM'
  AND o.DESIGNATED_SERVICE_LEVEL_ID IN ('11','42')
  AND o.MAXIMUM_STATUS NOT IN ('8000','9000')
  AND o.CREATED_TIMESTAMP >= '${lookbackStr}'
GROUP BY ol.ORDER_ID`.trim();

  // Q4: pick task status per order — used to show sub-stage for allocated orders (2090)
  // GROUP BY ORDER_ID, take the highest-status task per order (MAX numeric status)
  const sqlPickStage = `
SELECT td.ORDER_ID, MAX(t.STATUS) AS task_status
FROM default_task.TSK_TASK t
JOIN default_task.TSK_TASK_DETAIL td
  ON  td.TASK_ID     = t.TASK_ID
  AND td.FACILITY_ID = '${FACILITY}'
  AND td.CREATED_TIMESTAMP >= '${lookbackStr}'
WHERE t.FACILITY_ID = '${FACILITY}'
  AND t.TRANSACTION_ID IN ('Ecom Mezz Pick To Putwall Cart','Ecom Non-Mezz Pick To Putwall Cart')
  AND t.STATUS NOT IN ('8000','9000')
  AND t.CREATED_TIMESTAMP >= '${lookbackStr}'
GROUP BY td.ORDER_ID`.trim();

  const [respOpen, respShipped, respLines, respPickStage] = await Promise.all([
    mcpQuery(accessToken, sqlOpen),
    mcpQuery(accessToken, sqlShipped).catch(() => ({ rows: [] })),
    mcpQuery(accessToken, sqlLines).catch(() => ({ rows: [] })),
    mcpQuery(accessToken, sqlPickStage).catch(() => ({ rows: [] })),
  ]);

  const openOrders = respOpen.rows || [];

  // line count map: ORDER_ID -> unit count
  const lineMap = {};
  for (const r of (respLines.rows || [])) lineMap[r.ORDER_ID] = Number(r.line_count || 0);

  // shipped counts broken out by service level
  const shippedMap = {};
  for (const r of (respShipped.rows || [])) shippedMap[r.svc] = Number(r.shipped_count || 0);
  const shippedCount = (shippedMap['11'] || 0) + (shippedMap['42'] || 0);

  // pick stage map: ORDER_ID -> highest task STATUS code string
  const pickStageMap = {};
  for (const r of (respPickStage.rows || [])) pickStageMap[r.ORDER_ID] = String(r.task_status || '').split('.')[0];

  // oLPN enrichment — direct PPK_OLPN query by ORDER_ID
  // Must list columns explicitly — SELECT * is blocked by PII filter
  let olpnMap = {}; // ORDER_ID -> array of olpn objects
  for (let i = 0; i < openOrders.length; i += OLPN_BATCH) {
    const orderIds = openOrders.slice(i, i + OLPN_BATCH).map(r => `'${r.ORDER_ID}'`).join(',');
    try {
      const respOlpn = await mcpQuery(accessToken, `
SELECT OLPN_ID, ORDER_ID, STATUS AS olpn_status, CURRENT_LOCATION_ID, CARRIER_ID, SERVICE_LEVEL_ID, TRACKING_NUMBER, PALLET_ID
FROM default_pickpack.PPK_OLPN
WHERE FACILITY_ID = '${FACILITY}'
  AND ORDER_ID IN (${orderIds})
  AND STATUS NOT IN ('9000')`.trim());
      for (const r of (respOlpn.rows || [])) {
        if (!olpnMap[r.ORDER_ID]) olpnMap[r.ORDER_ID] = [];
        olpnMap[r.ORDER_ID].push(r);
      }
    } catch(e) {
      console.warn(`[${ts()}] oLPN enrichment failed (orders ${i + 1}–${i + OLPN_BATCH}): ${e.message}`);
    }
  }

  const SVC_LABEL = { '11': '1DD', '42': '2DD' };

  const orders = openOrders.map(r => {
    const olpns = olpnMap[r.ORDER_ID] || [];
    const topOlpn = olpns.reduce((best, o) =>
      (!best || Number(o.olpn_status) > Number(best.olpn_status)) ? o : best, null);
    return {
      order_id:      r.ORDER_ID,
      order_status:  r.MAXIMUM_STATUS,
      service_level: SVC_LABEL[r.service_level_id] || r.service_level_id,
      placed_utc:    r.placed_utc,
      ship_by_utc:   r.ship_by_utc,
      deliver_by_utc: r.deliver_by_utc,
      quantity:      lineMap[r.ORDER_ID] || null,
      olpns:         olpns.map(o => o.OLPN_ID).filter(Boolean),
      olpn_status:   topOlpn?.olpn_status         || null,
      olpn_location: topOlpn?.CURRENT_LOCATION_ID || null,
      olpn_pallet:   topOlpn?.PALLET_ID           || null,
      olpn_svc:      topOlpn?.SERVICE_LEVEL_ID    || null,
      carrier:       topOlpn?.CARRIER_ID          || null,
      pick_stage:    pickStageMap[r.ORDER_ID]     || null,
      due_utc:       r.service_level_id === '11' && r.placed_utc ? isoUtc(dueCutoff(utcMs(r.placed_utc))) : null,
    };
  });

  const [oneDD, splits] = await Promise.all([
    fetchOneDD(accessToken, openOrders, olpnMap, shiftStart, nowUtc).catch(e => {
      console.warn(`[${ts()}] 1DD focus failed: ${e.message}`);
      return null;
    }),
    fetchSplits(accessToken, shiftStart, nowUtc).catch(e => {
      console.warn(`[${ts()}] Splits failed: ${e.message}`);
      return null;
    }),
  ]);

  const output = {
    generated:     new Date().toISOString().slice(0,19),
    facility:      FACILITY,
    shift_label:   is1st ? '1st shift' : '2nd shift',
    shift_start:   shiftStartStr,
    open_count:    openOrders.length,
    open_1dd:      openOrders.filter(r => r.service_level_id === '11').length,
    open_2dd:      openOrders.filter(r => r.service_level_id === '42').length,
    shipped_count: shippedCount,
    shipped_1dd:   shippedMap['11'] || 0,
    shipped_2dd:   shippedMap['42'] || 0,
    one_dd:        oneDD,
    splits,
    orders,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`[${ts()}] ✓ expedite_live.json — ${output.open_count} open, ${output.shipped_count} shipped`);
  console.log(`[${ts()}] expedite_live.json ready — dc499_refresh will push on next cycle`);
}

// ── 1DD focus: last cutoff on-time, pack → pallet time, held oLPNs ─────────────
async function fetchOneDD(accessToken, openOrders, olpnMap, shiftStart, nowUtc) {
  const now = nowUtc.getTime();
  const nextCutoff = dueCutoff(now);
  const lastCutoff = utcFromPacific(addDays(pacificDateStr(new Date(nextCutoff)), -1), CUTOFF_HR, 0).getTime();
  // Orders due at the last cutoff were placed from (last cutoff − 1 day); +2 hrs slack for CREATED vs PLACED
  const sinceStr = sqlUtc(lastCutoff - 26 * 3600000);

  // Q5: every 1DD order (shipped too) since then, with its oLPNs. LEFT JOIN so orders with no oLPN yet count.
  const resp = await mcpQuery(accessToken, `
SELECT o.ORDER_ID, o.ORDER_PLACED_DATE_TIME AS placed_utc, o.MAXIMUM_STATUS,
  p.OLPN_ID, p.STATUS AS olpn_status, p.SHIPPED_DATE_TIME, p.PALLET_ID, p.CURRENT_LOCATION_ID
FROM default_dcorder.DCO_ORDER o
LEFT JOIN default_pickpack.PPK_OLPN p
  ON p.ORDER_ID = o.ORDER_ID AND p.FACILITY_ID = '${FACILITY}' AND p.STATUS <> '9000'
WHERE o.FACILITY_ID = '${FACILITY}'
  AND o.ORDER_TYPE = 'ECOM'
  AND o.CANCELLED = 0
  AND o.DESIGNATED_SERVICE_LEVEL_ID = '11'
  AND o.CREATED_TIMESTAMP >= '${sinceStr}'
LIMIT 5000`.trim());
  const rows = resp.rows || [];

  // oLPN list: Q5 + the oLPNs of older still-open 1DD orders from Q1
  const olpns = {};   // OLPN_ID -> { order_id, status, shipped, pallet, location }
  const addOlpn = (orderId, r) => {
    if (!r.OLPN_ID || olpns[r.OLPN_ID]) return;
    olpns[r.OLPN_ID] = { order_id: orderId, status: String(r.olpn_status || ''), shipped: r.SHIPPED_DATE_TIME || null,
                         pallet: r.PALLET_ID || null, location: r.CURRENT_LOCATION_ID || null };
  };
  for (const r of rows) addOlpn(r.ORDER_ID, r);
  for (const o of openOrders) if (o.service_level_id === '11') for (const r of (olpnMap[o.ORDER_ID] || [])) addOlpn(o.ORDER_ID, r);

  // Q6: first pack + first palletize scan per oLPN
  const ids = Object.keys(olpns);
  const txList = [...PACK_TX, ...PALLET_TX].map(t => `'${t}'`).join(',');
  for (let i = 0; i < ids.length; i += SCAN_BATCH) {
    const inList = ids.slice(i, i + SCAN_BATCH).map(id => `'${id}'`).join(',');
    try {
      const r = await mcpQuery(accessToken, `
SELECT CONTAINER_ID, TRANSACTION_ID, MIN(CREATED_TIMESTAMP) AS first_ts
FROM default_task.TSK_ACTIVITY_TRACKING
WHERE CONTAINER_ID IN (${inList})
  AND TRANSACTION_ID IN (${txList})
GROUP BY CONTAINER_ID, TRANSACTION_ID`.trim());
      for (const s of (r.rows || [])) {
        const o = olpns[s.CONTAINER_ID]; if (!o) continue;
        const t = utcMs(s.first_ts);
        const key = PACK_TX.includes(s.TRANSACTION_ID) ? 'packMs' : 'palletMs';
        if (!o[key] || t < o[key]) o[key] = t;
      }
    } catch (e) {
      console.warn(`[${ts()}] 1DD scan lookup failed (oLPNs ${i + 1}–${i + SCAN_BATCH}): ${e.message}`);
    }
  }

  // Last cutoff: orders placed in [last − 1 day, last). Out = every oLPN shipped; on time = last ship ≤ cutoff.
  const byOrder = {};
  for (const r of rows) {
    const placed = utcMs(r.placed_utc);
    if (!(placed >= lastCutoff - 86400000 && placed < lastCutoff)) continue;
    const b = byOrder[r.ORDER_ID] || (byOrder[r.ORDER_ID] = { done: String(r.MAXIMUM_STATUS) === '8000', any: false, open: false, lastShip: 0 });
    if (!r.OLPN_ID) continue;
    b.any = true;
    const sh = utcMs(r.SHIPPED_DATE_TIME);
    if (isNaN(sh)) b.open = true; else b.lastShip = Math.max(b.lastShip, sh);
  }
  const last = { due: 0, on_time: 0, shipped_late: 0, not_shipped: 0 };
  for (const b of Object.values(byOrder)) {
    last.due++;
    if (!b.any || b.open) { if (b.done) last.on_time++; else last.not_shipped++; }  // shipped with no oLPN time = trust the order status
    else if (b.lastShip <= lastCutoff) last.on_time++;
    else last.shipped_late++;
  }

  // Pack → pallet: oLPNs palletized this shift
  const waits = [];
  const held = [];
  for (const [id, o] of Object.entries(olpns)) {
    if (o.palletMs >= shiftStart.getTime() && o.packMs && o.palletMs >= o.packMs) waits.push((o.palletMs - o.packMs) / 60000);
    const open = !o.shipped && !['8000', '9000'].includes(o.status);
    if (open && o.packMs && !o.palletMs && !o.pallet && now - o.packMs >= HOLD_MIN * 60000) {
      held.push({ olpn_id: id, order_id: o.order_id, packed_utc: isoUtc(o.packMs), location: o.location, olpn_status: o.status });
    }
  }
  held.sort((a, b) => a.packed_utc.localeCompare(b.packed_utc));
  const avg = waits.length ? Math.round(waits.reduce((s, v) => s + v, 0) / waits.length) : null;
  const med = waits.length ? Math.round(waits.slice().sort((x, y) => x - y)[waits.length >> 1]) : null;

  console.log(`[${ts()}] 1DD — last cutoff ${last.on_time}/${last.due} on time · pack→pallet avg ${avg ?? '—'} / median ${med ?? '—'} min (${waits.length}) · held ${held.length}`);
  return {
    next_cutoff_utc: isoUtc(nextCutoff),
    last_cutoff_utc: isoUtc(lastCutoff),
    last_cutoff:     last,
    pallet_avg_min:  avg,
    pallet_median_min: med,
    pallet_count:    waits.length,
    hold_min:        HOLD_MIN,
    held,
  };
}

// ── Splits: Ecom orders packed into 2+ boxes, and whether one box would have held them ──
async function fetchSplits(accessToken, shiftStart, nowUtc) {
  const now = nowUtc.getTime();
  const sinceStr = pacificMidnightSql(addDays(pacificDateStr(nowUtc), -(SPLIT_DAYS - 1)));
  const shiftStr = sqlUtc(shiftStart);
  // Pack date = Pacific date of the order's first oLPN
  const inner = `
SELECT ORDER_ID, MIN(CREATED_TIMESTAMP) AS first_ts, MAX(CREATED_TIMESTAMP) AS last_ts, COUNT(*) AS n
FROM default_pickpack.PPK_OLPN
WHERE FACILITY_ID = '${FACILITY}'
  AND ORDER_TYPE = 'ECOM'
  AND STATUS <> '9000'
  AND CREATED_TIMESTAMP >= '${sinceStr}'
GROUP BY ORDER_ID`;

  // QS1: packed orders + split orders per day (and this shift)
  const sqlDays = `
SELECT DATE_FORMAT(CONVERT_TZ(t.first_ts, '+00:00', ${SQL_TZ}), '%Y-%m-%d') AS d,
  COUNT(*) AS orders, SUM(t.n > 1) AS split_orders, SUM(CASE WHEN t.n > 1 THEN t.n - 1 ELSE 0 END) AS extra_boxes,
  SUM(t.first_ts >= '${shiftStr}') AS shift_orders
FROM (${inner}) t
GROUP BY d`.trim();

  // QS2: the split orders, with each box (oLPN | size) in pack order
  const sqlList = `
SELECT ORDER_ID, MIN(CREATED_TIMESTAMP) AS first_ts, MAX(CREATED_TIMESTAMP) AS last_ts, COUNT(*) AS n,
  GROUP_CONCAT(CONCAT(OLPN_ID, '|', IFNULL(CONTAINER_SIZE_ID, '')) ORDER BY CREATED_TIMESTAMP SEPARATOR ',') AS boxes
FROM default_pickpack.PPK_OLPN
WHERE FACILITY_ID = '${FACILITY}'
  AND ORDER_TYPE = 'ECOM'
  AND STATUS <> '9000'
  AND CREATED_TIMESTAMP >= '${sinceStr}'
GROUP BY ORDER_ID
HAVING COUNT(*) > 1`.trim();

  const [respDays, respList] = await Promise.all([mcpQuery(accessToken, sqlDays), mcpQuery(accessToken, sqlList)]);
  const splitRows = respList.rows || [];

  // QS3 + QS4: items per box + service level, only for orders not cached yet
  const need = splitRows.map(r => r.ORDER_ID).filter(id => !splitCache[id]);
  const fresh = {};   // ORDER_ID -> { svc, boxes: { OLPN_ID: [[descr, qty, unitVol]] } }
  for (let i = 0; i < need.length; i += OLPN_BATCH) {
    const inList = need.slice(i, i + OLPN_BATCH).map(id => `'${id}'`).join(',');
    try {
      const [det, svc] = await Promise.all([
        mcpQuery(accessToken, `
SELECT ORDER_ID, OLPN_ID, ITEM_ID, MAX(ITEM_DESCRIPTION) AS descr, SUM(PACKED_QUANTITY) AS qty, MAX(UNIT_VOLUME) AS unit_vol
FROM default_pickpack.PPK_OLPN_DETAIL
WHERE FACILITY_ID = '${FACILITY}'
  AND ORDER_ID IN (${inList})
GROUP BY ORDER_ID, OLPN_ID, ITEM_ID`.trim()),
        mcpQuery(accessToken, `
SELECT ORDER_ID, DESIGNATED_SERVICE_LEVEL_ID AS svc
FROM default_dcorder.DCO_ORDER
WHERE FACILITY_ID = '${FACILITY}'
  AND ORDER_ID IN (${inList})`.trim()),
      ]);
      for (const r of (det.rows || [])) {
        const f = fresh[r.ORDER_ID] || (fresh[r.ORDER_ID] = { svc: null, boxes: {} });
        (f.boxes[r.OLPN_ID] || (f.boxes[r.OLPN_ID] = [])).push([String(r.descr || r.ITEM_ID || '').slice(0, 40), Number(r.qty || 0), Number(r.unit_vol || 0)]);
      }
      for (const r of (svc.rows || [])) {
        const f = fresh[r.ORDER_ID] || (fresh[r.ORDER_ID] = { svc: null, boxes: {} });
        f.svc = r.svc === '11' ? '1DD' : r.svc === '42' ? '2DD' : null;
      }
    } catch (e) {
      console.warn(`[${ts()}] Splits item lookup failed (orders ${i + 1}–${i + OLPN_BATCH}): ${e.message}`);
    }
  }

  const listFrom = utcFromPacific(addDays(pacificDateStr(nowUtc), -(SPLIT_LIST_DAYS - 1)), 0, 0).getTime();
  const fitByDay = {}, list = [];
  const shiftTot = { split_orders: 0, extra_boxes: 0, fit_orders: 0, svc_split: 0 };
  for (const r of splitRows) {
    const boxes = String(r.boxes || '').split(',').map(s => { const [id, size] = s.split('|'); return { olpn_id: id, size: size || null }; });
    let c = splitCache[r.ORDER_ID];
    if (!c) {
      const f = fresh[r.ORDER_ID];
      if (!f) continue;   // item lookup failed this cycle — try again next cycle
      let units = 0, vol = 0, skus = new Set();
      const items = {};
      for (const b of boxes) {
        items[b.olpn_id] = (f.boxes[b.olpn_id] || []).map(([d, q, v]) => { units += q; vol += q * v; if (q) skus.add(d); return [d, q]; });
      }
      c = { svc: f.svc, units, skus: skus.size, item_vol: Math.round(vol * 1000) / 1000, items };
      // Boxes are settled once every box has packed units and the last one is 2+ hrs old
      const settled = now - utcMs(r.last_ts) > 2 * 3600000 && boxes.every(b => (items[b.olpn_id] || []).some(x => x[1] > 0));
      if (settled) splitCache[r.ORDER_ID] = c;
    }

    // Would one box have held it? Compare item volume (at SPLIT_FILL) with the boxes.
    let fit = null, suggest = null;
    if (c.units > 0) {
      const needVol = c.item_vol / SPLIT_FILL;
      const bigUsed = Math.max(0, ...boxes.map(b => BOX_VOL[b.size] || 0));
      suggest = BOX_SIZES.find(s => BOX_VOL[s] >= needVol) || null;
      fit = needVol <= bigUsed ? 'used' : needVol <= BOX_VOL[SPLIT_MAX_BOX] ? 'bigger' : 'needed';
    }

    const firstMs = utcMs(r.first_ts);
    const day = pacificDateStr(new Date(firstMs));
    if (fit === 'used' || fit === 'bigger') fitByDay[day] = (fitByDay[day] || 0) + 1;
    if (firstMs >= shiftStart.getTime()) {
      shiftTot.split_orders++;
      shiftTot.extra_boxes += boxes.length - 1;
      if (fit === 'used' || fit === 'bigger') shiftTot.fit_orders++;
      if (c.svc) shiftTot.svc_split++;
    }
    if (firstMs >= listFrom) {
      list.push({
        order_id: r.ORDER_ID, svc: c.svc, packed_utc: isoUtc(firstMs), units: c.units, skus: c.skus, item_vol: c.item_vol,
        fit, suggest,
        boxes: boxes.map(b => ({ olpn_id: b.olpn_id, size: b.size, items: c.items[b.olpn_id] || [] })),
      });
    }
  }
  list.sort((a, b) => b.packed_utc.localeCompare(a.packed_utc));

  const days = (respDays.rows || []).map(r => ({
    date: r.d, orders: Number(r.orders || 0), split_orders: Number(r.split_orders || 0),
    extra_boxes: Number(r.extra_boxes || 0), fit_orders: fitByDay[r.d] || 0,
  })).sort((a, b) => a.date.localeCompare(b.date));
  const shiftOrders = (respDays.rows || []).reduce((s, r) => s + Number(r.shift_orders || 0), 0);

  // Drop cache entries that fell out of the window
  const keep = new Set(splitRows.map(r => r.ORDER_ID));
  for (const id of Object.keys(splitCache)) if (!keep.has(id)) delete splitCache[id];

  console.log(`[${ts()}] Splits — this shift ${shiftTot.split_orders} of ${shiftOrders} orders split, ${shiftTot.fit_orders} would have fit 1 box · ${splitRows.length} split in ${SPLIT_DAYS} days`);
  return {
    fill: SPLIT_FILL,
    max_box: SPLIT_MAX_BOX,
    list_days: SPLIT_LIST_DAYS,
    shift: { orders: shiftOrders, ...shiftTot },
    days,
    list,
  };
}

// ── entry point ────────────────────────────────────────────────────────────────
async function main() {
  if (MODE_AUTH) {
    await doAuthFlow();
    return;
  }

  if (MODE_SERVE) {
    console.log(`[${ts()}] SCOUT Expedite Agent — serve mode, interval ${INTERVAL / 60000} min`);
    const token = await getAccessTokenSilent().catch(async e => {
      if (e instanceof AuthError) return doAuthFlow();
      throw e;
    });
    await fetchExpedite(token);
    let busy = false;
    setInterval(async () => {
      // Skip if the last cycle is still running, so cycles never stack up
      if (busy) { console.log(`[${ts()}] Previous cycle still running — skipping this tick`); return; }
      busy = true;
      try {
        const t = await getAccessTokenSilent();
        await fetchExpedite(t);
      } catch (e) {
        console.error(`[${ts()}] Error:`, e.message);
      } finally {
        busy = false;
      }
    }, INTERVAL);
    return;
  }

  const token = await getAccessToken();
  await fetchExpedite(token);
}

main().catch(e => { console.error(e.message); process.exit(1); });
