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
const PDT_OFFSET_HRS   = -7;      // DST: change to -8 ~Oct 25 (see DST fix memory)
const NIGHT_START_MIN  = 21 * 60 + 30;   // 9:30 PM PDT — after this, no more batches tonight
const NIGHT_END_MIN    = 5 * 60;         // 5:00 AM PDT — first batch of the morning
const SINGLE_GRACE_MIN = 15;      // singles should task within a few 5-min cycles
const ALLOC_3000    = "'3000','3000.0'";
const ALLOC_5000    = "'5000','5000.0'";

const args       = process.argv.slice(2);
const MODE_AUTH  = args.includes('--auth');
const MODE_SERVE = args.includes('--serve');
const MODE_ONCE  = args.includes('--once');   // one-shot using the shared-token lock (safe alongside serve agents)
const INTERVAL   = (() => {
  const f = args.find(a => a.startsWith('--interval='));
  return f ? parseInt(f.split('=')[1]) * 60 * 1000 : 5 * 60 * 1000;
})();

// ── OAuth ───────────────────────────────────────────────────────────────────────
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
const LOCK_FILE       = TOKEN_FILE + '.lock';
const QUERY_LOCK_FILE = TOKEN_FILE + '.query_lock';
const TOKEN_TTL       = 55 * 60 * 1000;

function loadToken() {
  for (const f of [TOKEN_FILE, TOKEN_FILE + '.bak']) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  }
  return null;
}
function saveToken(t) {
  const out = { ...t, _saved_at: Date.now() };
  try { if (fs.existsSync(TOKEN_FILE)) fs.copyFileSync(TOKEN_FILE, TOKEN_FILE + '.bak'); } catch {}
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(out, null, 2));
}
function isTokenFresh(stored) {
  const ttl = stored?.expires_in ? stored.expires_in * 900 : TOKEN_TTL;
  return stored?.access_token && stored._saved_at && (Date.now() - stored._saved_at) < ttl;
}
async function acquireLock() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' }); return true; } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}
function releaseLock() { try { fs.unlinkSync(LOCK_FILE); } catch {} }
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
class AuthError extends Error {}
async function getAccessTokenSilent() {
  const quick = loadToken();
  if (isTokenFresh(quick)) return quick.access_token;

  const locked = await acquireLock();
  try {
    const stored = loadToken();
    if (!stored?.refresh_token) throw new AuthError('No refresh token — run --auth first');
    if (isTokenFresh(stored)) return stored.access_token;

    const candidates = [stored.refresh_token];
    try {
      const bak = JSON.parse(fs.readFileSync(TOKEN_FILE + '.bak', 'utf8'));
      if (bak?.refresh_token && bak.refresh_token !== stored.refresh_token) candidates.push(bak.refresh_token);
    } catch {}
    let lastErr;
    for (const rt of candidates) {
      try {
        const fresh = await refreshAccessToken(rt);
        saveToken({ ...stored, ...fresh });
        return fresh.access_token;
      } catch (e) { lastErr = e; }
    }
    throw new AuthError('Token refresh failed: ' + lastErr.message);
  } finally {
    if (locked) releaseLock();
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
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try { resolved = true; resolve(JSON.parse(trimmed)); return; } catch {}
        }
        const norm = d.replace(/\r\n/g, '\n');
        let pos = 0;
        while (true) {
          const evEnd = norm.indexOf('\n\n', pos);
          if (evEnd === -1) return;
          const block = norm.slice(pos, evEnd);
          const dataLines = block.split('\n').filter(l => /^data:/.test(l));
          pos = evEnd + 2;
          if (!dataLines.length) continue;
          const json = dataLines.map(l => l.replace(/^data:\s*/, '')).join('');
          if (json) {
            try { resolved = true; resolve(JSON.parse(json)); res.destroy(); return; }
            catch(e) { /* try next block */ }
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
async function acquireQueryLock() {
  // Clear stale lock left by a previously killed process
  try {
    const pid = parseInt(fs.readFileSync(QUERY_LOCK_FILE, 'utf8'));
    if (pid && pid !== process.pid) {
      try { process.kill(pid, 0); } catch { fs.unlinkSync(QUERY_LOCK_FILE); } // process gone — clear it
    }
  } catch {}
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try { fs.writeFileSync(QUERY_LOCK_FILE, String(process.pid), { flag: 'wx' }); return true; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}
function releaseQueryLock() { try { fs.unlinkSync(QUERY_LOCK_FILE); } catch {} }

async function mcpQuery(accessToken, sql) {
  await acquireQueryLock();
  try {
    const result = await jsonPost(`${MCP_BASE}/mcp`, JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'query_database', arguments: { query: sql } },
    }), {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${accessToken}`,
    });
    if (!result) throw new Error('MCP returned no data');
    if (result.error) throw new Error(JSON.stringify(result.error));
    const text = result?.result?.content?.[0]?.text;
    if (!text) throw new Error('Empty MCP response');
    const parsed = JSON.parse(text);
    if (parsed && parsed.success === false) throw new Error(parsed.error || 'query failed');
    return parsed;
  } finally {
    releaseQueryLock();
  }
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
SELECT i.ITEM_ID, SUM(i.ON_HAND) AS oh, SUM(COALESCE(i.ALLOCATED,0)) AS alloc
FROM default_dcinventory.DCI_INVENTORY i
WHERE i.FACILITY_ID='${FACILITY}' AND i.ITEM_ID IN (${sqlList(items)})
  AND LEFT(i.LOCATION_ID,3) IN (${sqlList(RESERVE_AREAS)})
GROUP BY i.ITEM_ID`.trim();
}

// ── stock-but-no-task reasoning ────────────────────────────────────────────────
const pdtMinOfDay = ms => ((Math.floor(ms / 6e4) + PDT_OFFSET_HRS * 60) % 1440 + 1440) % 1440;
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
    setInterval(async () => {
      try {
        const t = await getAccessTokenSilent();
        await fetchUntasked(t);
      } catch (e) {
        console.error(`[${ts()}] Error:`, e.message);
      }
    }, INTERVAL);
    return;
  }

  const token = MODE_ONCE ? await getAccessTokenSilent() : await getAccessToken();
  await fetchUntasked(token);
}

main().catch(e => { console.error(e.message); process.exit(1); });
