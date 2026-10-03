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
const { currentShift } = require('./scout_tz');  // DST-aware local time
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

// ── main fetch ─────────────────────────────────────────────────────────────────
async function fetchExpedite(accessToken) {
  const nowUtc     = new Date();
  // Shift start — 1st 3:00 AM, 2nd 2:00 PM local (DST-aware); before 3 AM = yesterday's 2nd
  const sh         = currentShift({ firstFrom: 3, secondFrom: 14, firstStart: [3, 0], secondStart: [14, 0] }, nowUtc);
  const is1st      = sh.is1st;
  const shiftStart = sh.start;
  const shiftStartStr = sh.startSql;

  console.log(`[${ts()}] Expedite Live — ${is1st ? '1st' : '2nd'} shift, since ${shiftStartStr} UTC`);

  // Q1: not-yet-shipped 1DD + 2DD orders this shift
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
  AND o.CREATED_TIMESTAMP >= '${shiftStartStr}'
ORDER BY o.EXT_ESTIMATEDSHIPBYDATETIME ASC
LIMIT 500`.trim();

  // Q2: shipped counts per service level this shift
  const sqlShipped = `
SELECT DESIGNATED_SERVICE_LEVEL_ID AS svc, COUNT(*) AS shipped_count
FROM default_dcorder.DCO_ORDER
WHERE FACILITY_ID = '${FACILITY}'
  AND ORDER_TYPE = 'ECOM'
  AND CANCELLED = 0
  AND DESIGNATED_SERVICE_LEVEL_ID IN ('11','42')
  AND MAXIMUM_STATUS = '8000'
  AND CREATED_TIMESTAMP >= '${shiftStartStr}'
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
  AND o.CREATED_TIMESTAMP >= '${shiftStartStr}'
GROUP BY ol.ORDER_ID`.trim();

  // Q4: pick task status per order — used to show sub-stage for allocated orders (2090)
  // GROUP BY ORDER_ID, take the highest-status task per order (MAX numeric status)
  const sqlPickStage = `
SELECT td.ORDER_ID, MAX(t.STATUS) AS task_status
FROM default_task.TSK_TASK t
JOIN default_task.TSK_TASK_DETAIL td
  ON  td.TASK_ID     = t.TASK_ID
  AND td.FACILITY_ID = '${FACILITY}'
  AND td.CREATED_TIMESTAMP >= '${shiftStartStr}'
WHERE t.FACILITY_ID = '${FACILITY}'
  AND t.TRANSACTION_ID IN ('Ecom Mezz Pick To Putwall Cart','Ecom Non-Mezz Pick To Putwall Cart')
  AND t.STATUS NOT IN ('8000','9000')
  AND t.CREATED_TIMESTAMP >= '${shiftStartStr}'
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
  if (openOrders.length > 0) {
    const orderIds = openOrders.map(r => `'${r.ORDER_ID}'`).join(',');
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
      console.warn(`[${ts()}] oLPN enrichment failed: ${e.message}`);
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
    };
  });

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
    orders,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`[${ts()}] ✓ expedite_live.json — ${output.open_count} open, ${output.shipped_count} shipped`);
  console.log(`[${ts()}] expedite_live.json ready — dc499_refresh will push on next cycle`);
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
