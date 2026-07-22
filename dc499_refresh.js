#!/usr/bin/env node
/**
 * DC499 Reporter — Direct MCP Refresher
 * Writes receiving_live.json and batch_live.json without using Claude tokens.
 *
 * node dc499_refresh.js --auth       first-time auth
 * node dc499_refresh.js              one-shot refresh
 * node dc499_refresh.js --serve      live server on :3001, auto-refresh every 60 min
 * node dc499_refresh.js --serve --port=3002 --interval=30
 */

const fs     = require('fs');
const path   = require('path');
const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const { execSync } = require('child_process');

// ── config ─────────────────────────────────────────────────────────────────────
const MCP_BASE      = 'https://mawm-data-mcp.nordstromaws.app';
const TOKEN_FILE    = path.join('C:\\projects\\test', '.mcp_token.json'); // shared with ecom reporter
const REPORT_DIR    = __dirname;
const RECV_FILE     = path.join(REPORT_DIR, 'receiving_live.json');
const BATCH_FILE    = path.join(REPORT_DIR, 'batch_live.json');
const DOCK_FILE     = path.join(REPORT_DIR, 'dock_live.json');
const TOTES_FILE    = path.join(REPORT_DIR, 'totes_live.json');
const CLIENT_ID     = 'https://claude.ai/oauth/claude-code-client-metadata';
const REDIRECT_PORT = 3118;
const REDIRECT_URI  = `http://localhost:${REDIRECT_PORT}/callback`;
const FACILITY      = '499';

// ── OAuth ──────────────────────────────────────────────────────────────────────
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
function loadToken() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { return null; }
}
function saveToken(t) { fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2)); }

async function refreshAccessToken(rt) {
  return jsonPost(`${MCP_BASE}/token`, new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: rt, client_id: CLIENT_ID,
  }).toString(), { 'Content-Type': 'application/x-www-form-urlencoded' });
}

async function doAuthFlow() {
  const verifier  = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state     = b64url(crypto.randomBytes(16));
  const authUrl   = `${MCP_BASE}/authorize?` + new URLSearchParams({
    response_type: 'code', client_id: CLIENT_ID,
    code_challenge: challenge, code_challenge_method: 'S256',
    redirect_uri: REDIRECT_URI, state,
    scope: 'openid offline_access', prompt: 'consent',
    resource: `${MCP_BASE}/mcp`,
  });
  const opener = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try { execSync(`${opener} "${authUrl}"`); } catch {}
  console.log('\nBrowser opened. Waiting for callback...');
  const code = await waitForCode(state);
  const tokens = await jsonPost(`${MCP_BASE}/token`, new URLSearchParams({
    grant_type: 'authorization_code', code,
    redirect_uri: REDIRECT_URI, client_id: CLIENT_ID, code_verifier: verifier,
  }).toString(), { 'Content-Type': 'application/x-www-form-urlencoded' });
  saveToken(tokens);
  console.log('✓ Authenticated. Token stored.');
  return tokens.access_token;
}

function waitForCode(expectedState) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url  = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      const code = url.searchParams.get('code');
      const st   = url.searchParams.get('state');
      if (!code) { res.end('No code'); return; }
      if (st !== expectedState) { res.end('State mismatch'); reject(new Error('state mismatch')); return; }
      res.end('<script>window.close()</script><p>Authorized! You can close this tab.</p>');
      server.close();
      resolve(code);
    });
    server.listen(REDIRECT_PORT);
    server.on('error', reject);
    setTimeout(() => { server.close(); reject(new Error('Auth timeout')); }, 120000);
  });
}

async function getAccessToken() {
  const stored = loadToken();
  if (!stored?.refresh_token) return doAuthFlow();
  try {
    const fresh = await refreshAccessToken(stored.refresh_token);
    saveToken({ ...stored, ...fresh });
    return fresh.access_token;
  } catch (e) {
    console.warn('Token refresh failed, re-authing:', e.message);
    return doAuthFlow();
  }
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────
function jsonPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: u.port || 443,
      path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Length': Buffer.byteLength(body), ...headers },
    }, res => {
      let d = ''; let resolved = false;
      function tryResolve() {
        if (resolved) return;
        const trimmed = d.trimStart();
        // Plain JSON (non-SSE response)
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try { resolved = true; resolve(JSON.parse(trimmed)); return; } catch {}
        }
        // SSE: server uses CRLF — normalize before splitting on \n\n
        const norm = d.replace(/\r\n/g, '\n');
        let pos = 0;
        while (true) {
          const evEnd = norm.indexOf('\n\n', pos);
          if (evEnd === -1) return; // incomplete block, wait for more data
          const block = norm.slice(pos, evEnd);
          const dataLines = block.split('\n').filter(l => /^data:/.test(l));
          pos = evEnd + 2;
          if (!dataLines.length) continue; // ping / event: / id: lines — skip
          const json = dataLines.map(l => l.replace(/^data:\s*/, '')).join('');
          if (json) {
            try { resolved = true; resolve(JSON.parse(json)); res.destroy(); return; }
            catch(e) { /* bad JSON in this block, try next */ }
          }
        }
      }
      res.on('data', c => { d += c; tryResolve(); });
      res.on('end', () => {
        if (resolved) return;
        const hasData = d.replace(/\r\n/g, '\n').split('\n').some(l => /^data:/.test(l));
        if (hasData) reject(new Error(`Unexpected: ${d.slice(0, 300)}`));
        else { resolved = true; resolve(null); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function mcpQuery(accessToken, sql) {
  const result = await jsonPost(`${MCP_BASE}/mcp`, JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'query_database', arguments: { query: sql } },
  }), {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': `Bearer ${accessToken}`,
  });
  if (!result) throw new Error('MCP returned no data (ping-only stream)');
  if (result.error) throw new Error(JSON.stringify(result.error));
  const text = result?.result?.content?.[0]?.text;
  if (!text) throw new Error('Empty MCP response');
  return JSON.parse(text);
}

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

function nowPdt() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
}

// ── receiving query ────────────────────────────────────────────────────────────
async function fetchReceiving(accessToken) {
  const today = nowPdt().toLocaleDateString('en-CA'); // YYYY-MM-DD in PDT

  const sqlAssociates = `
SELECT
    CREATED_BY,
    COUNT(DISTINCT LPN_ID) AS lpns,
    SUM(CASE WHEN PROCESS = '/lpn/receive' THEN QUANTITY ELSE 0 END) AS units,
    MIN(CONVERT_TZ(CREATED_TIMESTAMP, '+00:00', '-07:00')) AS first_scan,
    MAX(CONVERT_TZ(CREATED_TIMESTAMP, '+00:00', '-07:00')) AS last_scan
FROM default_receiving.RCV_RECEIPT
WHERE FACILITY_ID = '${FACILITY}'
  AND DATE(CONVERT_TZ(CREATED_TIMESTAMP, '+00:00', '-07:00')) = '${today}'
  AND CREATED_BY != 'system-msg-user@${FACILITY}'
  AND TIME(CONVERT_TZ(CREATED_TIMESTAMP, '+00:00', '-07:00')) >= '06:00:00'
GROUP BY CREATED_BY
ORDER BY lpns DESC`.trim();

  const sqlHourly = `
SELECT
    HOUR(CONVERT_TZ(CREATED_TIMESTAMP, '+00:00', '-07:00')) AS hr,
    COUNT(DISTINCT LPN_ID) AS lpns,
    SUM(CASE WHEN PROCESS = '/lpn/receive' THEN QUANTITY ELSE 0 END) AS units
FROM default_receiving.RCV_RECEIPT
WHERE FACILITY_ID = '${FACILITY}'
  AND DATE(CONVERT_TZ(CREATED_TIMESTAMP, '+00:00', '-07:00')) = '${today}'
  AND CREATED_BY != 'system-msg-user@${FACILITY}'
  AND TIME(CONVERT_TZ(CREATED_TIMESTAMP, '+00:00', '-07:00')) >= '06:00:00'
GROUP BY hr
ORDER BY hr ASC`.trim();

  const [resp, respHourly] = await Promise.all([
    mcpQuery(accessToken, sqlAssociates),
    mcpQuery(accessToken, sqlHourly),
  ]);

  const associates = (resp.rows || []).map(r => ({
    name:       (r.CREATED_BY.toLowerCase().split('@')[0]),
    lpns:       Number(r.lpns),
    units:      Math.round(Number(r.units)),
    first_scan: fmtHHmm(r.first_scan),
    last_scan:  fmtHHmm(r.last_scan),
  }));

  const hourly = (respHourly.rows || []).map(r => ({
    hour:  Number(r.hr),
    lpns:  Number(r.lpns),
    units: Math.round(Number(r.units)),
  }));

  return {
    generated:  new Date().toISOString().slice(0, 19),
    shift:      shiftLabel(),
    facility:   FACILITY,
    associates,
    hourly,
  };
}

// ── batch queries ──────────────────────────────────────────────────────────────
async function fetchBatch(accessToken) {
  // shift start in UTC — 2pm PDT = 21:00 UTC
  const nowUtc = new Date();
  const shiftHourUtc = 21;
  let shiftStart = new Date(nowUtc);
  shiftStart.setUTCHours(shiftHourUtc, 0, 0, 0);
  if (nowUtc.getUTCHours() < shiftHourUtc) shiftStart.setUTCDate(shiftStart.getUTCDate() - 1);
  const startStr = shiftStart.toISOString().replace('T',' ').slice(0, 19);

  const sql1 = `
SELECT
    RESOURCE_BATCH_ID,
    COUNT(DISTINCT ORDER_ID)   AS total_orders,
    COUNT(DISTINCT OLPN_ID)    AS total_olpns,
    COUNT(*)                   AS total_task_details,
    COUNT(DISTINCT CASE WHEN STATUS = '9000' THEN OLPN_ID END) AS completed_olpns,
    COUNT(DISTINCT CASE WHEN STATUS = '8000' THEN OLPN_ID END) AS in_progress_olpns,
    COUNT(DISTINCT CASE WHEN STATUS = '1000' THEN OLPN_ID END) AS pending_olpns,
    GROUP_CONCAT(DISTINCT CURRENT_USER_ID ORDER BY CURRENT_USER_ID SEPARATOR ',') AS workers,
    MIN(CREATED_TIMESTAMP) AS batch_created_utc
FROM default_pickpack.TSK_TASK_DETAIL
WHERE FACILITY_ID = '${FACILITY}'
  AND RESOURCE_BATCH_ID IS NOT NULL
  AND RESOURCE_BATCH_ID NOT LIKE 'B_00000000000%'
  AND CREATED_TIMESTAMP >= '${startStr}'
GROUP BY RESOURCE_BATCH_ID
ORDER BY batch_created_utc DESC`.trim();

  const resp1 = await mcpQuery(accessToken, sql1);
  const summaryRows = resp1.rows || [];

  if (!summaryRows.length) {
    return {
      generated: new Date().toISOString().slice(0, 19),
      facility: FACILITY, shift: shiftLabel(), shift_start_utc: startStr,
      summary: { total_batches:0, active_batches:0, total_orders:0, total_olpns:0, completed_olpns:0, completion_pct:0 },
      batches: [],
    };
  }

  // query 2: detail for all batches found
  const batchIds = summaryRows.map(r => `'${r.RESOURCE_BATCH_ID}'`).join(',');
  const sql2 = `
SELECT
    RESOURCE_BATCH_ID,
    STATUS,
    CURRENT_USER_ID,
    COUNT(*)  AS task_count,
    GROUP_CONCAT(DISTINCT NULLIF(WORKING_LOCATION_ID,'') ORDER BY WORKING_LOCATION_ID SEPARATOR ',') AS locations,
    GROUP_CONCAT(DISTINCT ITEM_ID ORDER BY ITEM_ID SEPARATOR ',') AS items
FROM default_pickpack.TSK_TASK_DETAIL
WHERE FACILITY_ID = '${FACILITY}'
  AND RESOURCE_BATCH_ID IN (${batchIds})
  AND STATUS IN ('1000','8000')
  AND CREATED_TIMESTAMP >= '${startStr}'
GROUP BY RESOURCE_BATCH_ID, STATUS, CURRENT_USER_ID
ORDER BY RESOURCE_BATCH_ID, STATUS DESC, task_count DESC`.trim();

  const resp2 = await mcpQuery(accessToken, sql2);
  const detailRows = resp2.rows || [];

  // index detail by batch_id
  const detailByBatch = {};
  for (const r of detailRows) {
    const bid = r.RESOURCE_BATCH_ID;
    if (!detailByBatch[bid]) detailByBatch[bid] = { in_progress: [], pending: [] };
    const locs = r.locations ? r.locations.split(',').filter(Boolean) : [];
    if (r.STATUS === '8000') {
      detailByBatch[bid].in_progress.push({
        worker:      r.CURRENT_USER_ID ? r.CURRENT_USER_ID.toLowerCase().split('@')[0] : 'unassigned',
        task_count:  Number(r.task_count),
        putwalls:    locs.filter(l => /^S\d+-PW-/.test(l)),
        workbenches: locs.filter(l => !/^S\d+-PW-/.test(l)),
      });
    } else if (r.STATUS === '1000') {
      detailByBatch[bid].pending.push({
        task_count: Number(r.task_count),
        items:      r.items ? r.items.split(',').filter(Boolean) : [],
      });
    }
  }

  // build batch objects
  const batches = summaryRows.map(r => {
    const bid  = r.RESOURCE_BATCH_ID;
    const tot  = Number(r.total_olpns);
    const comp = Number(r.completed_olpns);
    const inp  = Number(r.in_progress_olpns);
    const pend = Number(r.pending_olpns);
    const pct  = tot > 0 ? Math.round((comp / tot) * 100) : 0;
    const workers = r.workers
      ? r.workers.split(',').map(w => w.trim().toLowerCase().split('@')[0]).filter(Boolean)
      : [];
    const statusLabel = comp === tot && tot > 0 ? 'Complete'
                      : inp > 0                  ? 'Work Started'
                      : pend === tot             ? 'Released'
                      :                           'In Progress';
    return {
      batch_id:          bid,
      status:            statusLabel,
      total_orders:      Number(r.total_orders),
      total_olpns:       tot,
      task_details:      Number(r.total_task_details),
      completed_olpns:   comp,
      in_progress_olpns: inp,
      pending_olpns:     pend,
      pct,
      created_utc:       r.batch_created_utc,
      workers,
      detail:            detailByBatch[bid] || { in_progress: [], pending: [] },
    };
  });

  let totalOrders = 0, totalOlpns = 0, completedOlpns = 0, activeBatches = 0;
  for (const b of batches) {
    totalOrders    += b.total_orders;
    totalOlpns     += b.total_olpns;
    completedOlpns += b.completed_olpns;
    if (b.in_progress_olpns > 0 || b.pending_olpns > 0) activeBatches++;
  }
  const overallPct = totalOlpns > 0 ? Math.round((completedOlpns / totalOlpns) * 100) : 0;

  return {
    generated:       new Date().toISOString().slice(0, 19),
    facility:        FACILITY,
    shift:           shiftLabel(),
    shift_start_utc: startStr,
    summary: {
      total_batches:   batches.length,
      active_batches:  activeBatches,
      total_orders:    totalOrders,
      total_olpns:     totalOlpns,
      completed_olpns: completedOlpns,
      completion_pct:  overallPct,
    },
    batches,
  };
}

// ── dock door query ────────────────────────────────────────────────────────────
async function fetchDock(accessToken) {
  const sqlDoors = `
SELECT
  d.DOCK_DOOR_ID,
  d.DOCK_ID,
  d.TRAILER_ID,
  d.CARRIER_ID,
  d.DOCK_DOOR_STATUS_ID,
  a.APPOINTMENT_ID,
  a.APPOINTMENT_TYPE_ID,
  a.APPOINTMENT_STATUS_ID,
  CONVERT_TZ(a.WINDOW_START_DATE_TIME, '+00:00', '-07:00') AS appt_start,
  CONVERT_TZ(a.ARRIVAL_DATE_TIME,      '+00:00', '-07:00') AS arrived
FROM default_dcinventory.DCI_DOCK_DOOR d
LEFT JOIN default_appointment.APT_APPOINTMENT a
  ON a.FACILITY_ID = '${FACILITY}'
  AND a.TRAILER_ID = d.TRAILER_ID
  AND a.TRAILER_ID IS NOT NULL
  AND a.TRAILER_ID != ''
  AND DATE(CONVERT_TZ(a.WINDOW_START_DATE_TIME, '+00:00', '-07:00'))
      BETWEEN DATE(CONVERT_TZ(NOW(), '+00:00', '-07:00')) - INTERVAL 1 DAY
          AND DATE(CONVERT_TZ(NOW(), '+00:00', '-07:00')) + INTERVAL 1 DAY
WHERE d.FACILITY_ID = '${FACILITY}'
ORDER BY d.DOCK_DOOR_ID`.trim();

  // Pull active ASNs for the last 3 days — status 3000 = In Receiving
  const sqlAsn = `
SELECT
  TRAILER_ID,
  ASN_ID,
  ASN_STATUS,
  SHIPPED_LPNS,
  RECEIVED_LPNS,
  CONVERT_TZ(FIRST_RECEIPT_DATE, '+00:00', '-07:00') AS first_receipt,
  CONVERT_TZ(LAST_RECEIPT_DATE,  '+00:00', '-07:00') AS last_receipt
FROM default_receiving.RCV_ASN
WHERE FACILITY_ID = '${FACILITY}'
  AND TRAILER_ID IS NOT NULL
  AND TRAILER_ID != ''
  AND ASN_STATUS = '3000'
  AND LAST_RECEIPT_DATE >= NOW() - INTERVAL 3 DAY`.trim();

  const [respDoors, respAsn] = await Promise.all([
    mcpQuery(accessToken, sqlDoors),
    mcpQuery(accessToken, sqlAsn),
  ]);

  function fmtTime(ts) {
    if (!ts) return null;
    try {
      const d = new Date(ts);
      return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
    } catch { return null; }
  }

  // Build ASN lookup — key by normalized uppercase trailer ID
  // Also build a suffix map for fuzzy matching (e.g. "151899" matches "SWFZ151899")
  const asnByTrailer = {};
  for (const r of (respAsn.rows || [])) {
    const key = r.TRAILER_ID.toUpperCase();
    if (!asnByTrailer[key]) asnByTrailer[key] = r; // keep most recent if dupes
  }

  function findAsn(trailerId) {
    if (!trailerId) return null;
    const norm = trailerId.toUpperCase();
    // Exact match first
    if (asnByTrailer[norm]) return asnByTrailer[norm];
    // Suffix match: door "151899" → ASN "SWFZ151899"
    for (const [key, row] of Object.entries(asnByTrailer)) {
      if (key.endsWith(norm) || norm.endsWith(key)) return row;
    }
    return null;
  }

  const doors = (respDoors.rows || []).map(r => {
    const asn = findAsn(r.TRAILER_ID);
    return {
      door:           r.DOCK_DOOR_ID,
      dock:           r.DOCK_ID,
      trailer:        r.TRAILER_ID            || null,
      carrier:        r.CARRIER_ID            || null,
      status:         r.DOCK_DOOR_STATUS_ID,
      appt_id:        r.APPOINTMENT_ID        || null,
      appt_type:      r.APPOINTMENT_TYPE_ID   || null,
      appt_status:    r.APPOINTMENT_STATUS_ID || null,
      appt_start:     fmtTime(r.appt_start),
      arrived:        fmtTime(r.arrived),
      asn_id:         asn ? asn.ASN_ID                         : null,
      asn_status:     asn ? asn.ASN_STATUS                     : null,
      shipped_lpns:   asn ? Math.round(Number(asn.SHIPPED_LPNS))  : null,
      received_lpns:  asn ? Math.round(Number(asn.RECEIVED_LPNS)) : null,
      first_receipt:  asn ? fmtTime(asn.first_receipt)         : null,
      last_receipt:   asn ? fmtTime(asn.last_receipt)          : null,
    };
  });

  return {
    generated: new Date().toISOString().slice(0, 19),
    facility:  FACILITY,
    doors,
  };
}

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
  CONVERT_TZ(i.CREATED_TIMESTAMP, '+00:00', '-07:00') AS created_pdt,
  CONVERT_TZ(i.UPDATED_TIMESTAMP, '+00:00', '-07:00') AS updated_pdt,
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

  // Subquery isolates the most recent TASK_ID per tote so COMPLETED_QUANTITY
  // is not inflated by historical reuse across the 15-day window.
  const sqlTasks = `
SELECT
  td.TARGET_CONTAINER_ID                                              AS tote_id,
  MAX(td.PLANNED_TOTE_TYPE_ID)                                       AS tote_type,
  SUM(CASE WHEN td.STATUS != '9000' THEN 1 ELSE 0 END)              AS active_lines,
  SUM(CASE WHEN td.STATUS  = '9000' THEN 1 ELSE 0 END)              AS done_lines,
  MAX(CONVERT_TZ(t.ACTUAL_END_TIME, '+00:00', '-07:00'))             AS task_ended_pdt
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
    AND  CREATED_TIMESTAMP    >= NOW() - INTERVAL 15 DAY
  GROUP BY TARGET_CONTAINER_ID
) latest
  ON  latest.TARGET_CONTAINER_ID = td.TARGET_CONTAINER_ID
 AND  latest.latest_task_id      = td.TASK_ID
WHERE td.FACILITY_ID            = '${FACILITY}'
  AND td.TARGET_CONTAINER_ID LIKE 'T0%'
  AND td.CREATED_TIMESTAMP   >= NOW() - INTERVAL 15 DAY
GROUP BY td.TARGET_CONTAINER_ID`.trim();

  // Live oLPN count per putwall — filter SLA by UPDATED_TIMESTAMP within the
  // last 12 hours so stale phantom rows from prior shifts are excluded.
  // No join needed for the count — SLA is the authoritative "in cubby" table.
  const sqlPwCount = `
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

  // Active drop zone per putwall: same 12-hour SLA filter, join TSK_TASK_DETAIL
  // to get SOURCE_CONTAINER_ID (tote → drop zone lookup in JS via ilpnLocMap).
  const sqlPwDzSrc = `
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

  const [respIlpn, respTasks, respPwCount, respPwDzSrc] = await Promise.all([
    mcpQuery(accessToken, sqlIlpn),
    mcpQuery(accessToken, sqlTasks),
    mcpQuery(accessToken, sqlPwCount),
    mcpQuery(accessToken, sqlPwDzSrc),
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
    } else if (task && Number(task.active_lines) === 0 && Number(task.done_lines) > 0) {
      // Case 2 — all pick lines done (td.STATUS=9000), tote never dropped
      caseNum  = 2;
      timerMin = (task.task_ended_pdt && !isNaN(new Date(task.task_ended_pdt)))
        ? Math.round((nowMs - new Date(task.task_ended_pdt).getTime()) / 60000)
        : idleMin;
    } else {
      // Case 1 — pick still active or no task record yet, idle since last scan
      caseNum  = 1;
      timerMin = idleMin;
    }

    if (caseNum !== 2 && timerMin < 5) continue;

    let severity;
    if (caseNum === 3) {
      severity = timerMin < 15 ? 'green' : timerMin < 30 ? 'yellow' : 'red';
    } else if (caseNum === 2) {
      severity = timerMin < 10 ? 'green' : timerMin < 20 ? 'yellow' : 'red';
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

  // Build olpn count map: pw_prefix -> olpn_count
  const pwCountMap = {};
  for (const r of (respPwCount.rows || [])) {
    pwCountMap[r.pw_prefix] = Number(r.olpn_count) || 0;
  }

  // Build a location lookup and drop zone tote count from DCI_ILPN rows
  const ilpnLocMap  = {};
  const dzToteCount = {};
  for (const r of (respIlpn.rows || [])) {
    if (!r.CURRENT_LOCATION_ID) continue;
    ilpnLocMap[r.ILPN_ID] = r.CURRENT_LOCATION_ID;
    dzToteCount[r.CURRENT_LOCATION_ID] = (dzToteCount[r.CURRENT_LOCATION_ID] || 0) + 1;
  }

  // Active drop zone per putwall: highest dz_count row per prefix wins.
  // Resolve tote_id → CURRENT_LOCATION_ID using ilpnLocMap (no extra query).
  const pwActiveDzMap = {};
  for (const r of (respPwDzSrc.rows || [])) {
    if (pwActiveDzMap[r.pw_prefix]) continue; // already have highest-count row
    const loc = ilpnLocMap[r.tote_id];
    if (loc && loc.startsWith('D1-')) pwActiveDzMap[r.pw_prefix] = loc;
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
  };
}

// ── git push ───────────────────────────────────────────────────────────────────
function gitPush() {
  const stamp = new Date().toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
  try {
    execSync('git add receiving_live.json batch_live.json dock_live.json totes_live.json',  { cwd: REPORT_DIR, stdio: 'pipe' });
    execSync(`git commit -m "Live update -- ${stamp}"`,      { cwd: REPORT_DIR, stdio: 'pipe' });
    execSync('git pull --rebase --autostash origin main',    { cwd: REPORT_DIR, stdio: 'pipe' });
    execSync('git push origin main',                         { cwd: REPORT_DIR, stdio: 'pipe' });
    console.log(`[${ts()}] ✓ Pushed to git`);
  } catch (e) {
    const msg = e.stderr?.toString() || e.stdout?.toString() || e.message;
    if (msg.includes('nothing to commit') || msg.includes('nothing added')) {
      console.log(`[${ts()}]   Git: nothing new to commit`);
    } else {
      console.warn(`[${ts()}]   Git push failed: ${msg.slice(0, 200)}`);
    }
  }
}

// ── core: query + write ────────────────────────────────────────────────────────
async function queryAndWrite(accessToken) {
  console.log(`[${ts()}] Querying receiving...`);
  const [recvData, batchData, dockData, totesData] = await Promise.all([
    fetchReceiving(accessToken),
    fetchBatch(accessToken).catch(e => { console.warn(`  Batch query failed: ${e.message}`); return null; }),
    fetchDock(accessToken).catch(e => { console.warn(`  Dock query failed: ${e.message}`); return null; }),
    fetchTotes(accessToken).catch(e => { console.warn(`  Totes query failed: ${e.message}`); return null; }),
  ]);

  fs.writeFileSync(RECV_FILE,  JSON.stringify(recvData,  null, 4));
  console.log(`[${ts()}] ✓ receiving_live.json — ${recvData.associates.length} associates`);

  if (batchData) {
    fs.writeFileSync(BATCH_FILE, JSON.stringify(batchData, null, 4));
    console.log(`[${ts()}] ✓ batch_live.json — ${batchData.batches.length} batches, ${batchData.summary.completion_pct}% complete`);
  }

  if (dockData) {
    fs.writeFileSync(DOCK_FILE, JSON.stringify(dockData, null, 4));
    console.log(`[${ts()}] ✓ dock_live.json — ${dockData.doors.length} doors`);
  }

  if (totesData) {
    fs.writeFileSync(TOTES_FILE, JSON.stringify(totesData, null, 4));
    console.log(`[${ts()}] ✓ totes_live.json — ${totesData.summary.total} open totes`);
  }

  gitPush();
  return { recvData, batchData, dockData, totesData };
}

// ── serve mode ─────────────────────────────────────────────────────────────────
async function serveMode(port, intervalMin, accessToken, openPage) {
  let cache = null;

  async function refresh() {
    try {
      try { accessToken = await getAccessToken(); } catch {}
      cache = await queryAndWrite(accessToken);
      console.log(`[${ts()}] ✓ Cache updated`);
    } catch (e) {
      console.error(`[${ts()}] Refresh failed: ${e.message}`);
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
        generated:    cache?.recvData?.generated || null,
        associates:   cache?.recvData?.associates?.length || 0,
        batches:      cache?.batchData?.batches?.length || 0,
        completionPct: cache?.batchData?.summary?.completion_pct || 0,
        nextRefresh:  new Date(Date.now() + intervalMs).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles' }),
      }));
      return;
    }

    if (url.pathname === '/api/refresh') {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'refreshing' }));
      refresh();
      return;
    }

    // serve JSON files
    if (url.pathname === '/receiving_live.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(cache?.recvData || {}));
      return;
    }
    if (url.pathname === '/batch_live.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(cache?.batchData || {}));
      return;
    }
    if (url.pathname === '/dock_live.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(cache?.dockData || {}));
      return;
    }
    if (url.pathname === '/totes_live.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(cache?.totesData || {}));
      return;
    }

    // serve HTML files
    const fileMap = {
      '/':                    'index.html',
      '/index.html':          'index.html',
      '/Receiving_live.html': 'Receiving_live.html',
      '/Totes_live.html':     'Totes_live.html',
      '/MegaDash_v1.2.html':  'MegaDash_v1.2.html',
      '/Menu_v1.6.html':      'Menu_v1.6.html',
      '/Changelog.html':      'Changelog.html',
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
    const { networkInterfaces } = require('os');
    let localIp = 'your-ip';
    for (const ifaces of Object.values(networkInterfaces())) {
      for (const i of ifaces) {
        if (i.family === 'IPv4' && !i.internal) { localIp = i.address; break; }
      }
    }
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
  const ivMin   = parseInt(process.argv.find(a => a.startsWith('--interval='))?.split('=')[1] || '5');
  const openArg = process.argv.find(a => a.startsWith('--open='))?.split('=').slice(1).join('=') || null;

  console.log('DC499 Reporter Refresher');
  console.log('────────────────────────');

  let accessToken;
  if (isAuth) {
    console.log('Starting auth flow...');
    accessToken = await doAuthFlow();
  } else {
    console.log('Getting access token...');
    accessToken = await getAccessToken();
  }
  console.log('✓ Authenticated');

  if (isServe) {
    await serveMode(port, ivMin, accessToken, openArg);
    return;
  }

  // one-shot
  await queryAndWrite(accessToken);
  console.log('\nDone.');
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
