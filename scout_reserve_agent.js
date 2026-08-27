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
];

// ── OAuth ───────────────────────────────────────────────────────────────────────
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
const LOCK_FILE = TOKEN_FILE + '.lock';
const QUERY_LOCK_FILE = TOKEN_FILE + '.query_lock';
const TOKEN_TTL = 55 * 60 * 1000;

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
    return JSON.parse(text);
  } finally {
    releaseQueryLock();
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
}

function shiftStartUtc() {
  const nowUtc = new Date();
  const h = nowUtc.getUTCHours();
  const is1st = h >= 10 && h < 21;
  const start = new Date(nowUtc);
  if (is1st) {
    start.setUTCHours(10, 0, 0, 0);
  } else {
    start.setUTCHours(21, 10, 0, 0);
    if (h < 10) start.setUTCDate(start.getUTCDate() - 1);
  }
  return {
    utc: start.toISOString().replace('T', ' ').slice(0, 19),
    label: is1st ? '1st' : '2nd',
  };
}

// ── SQL builder ────────────────────────────────────────────────────────────────
function buildGroupSql(shiftStart, group) {
  const txList = group.txIds.map(t => `'${t.replace(/'/g, "''")}'`).join(', ');
  const zoneFilter = group.zoneH ? `  AND SUBSTR(TARGET_LOCATION_ID, 3, 1) = 'H'\n` : '';
  const containerCol = group.containerCount
    ? `,\n  COUNT(DISTINCT CASE WHEN COMPLETED_QUANTITY > 0 THEN CONTAINER_ID END) AS container_count`
    : '';
  return [
    `SELECT CREATED_BY AS Employee, SUM(${group.metric}) AS total_qty${containerCol}`,
    `FROM default_task.TSK_ACTIVITY_TRACKING`,
    `WHERE FACILITY_ID = '${FACILITY}'`,
    `  AND TRANSACTION_ID IN (${txList})`,
    `  AND CREATED_TIMESTAMP >= '${shiftStart}'`,
    zoneFilter + `GROUP BY CREATED_BY`,
    `ORDER BY total_qty DESC`,
  ].join('\n');
}

// ── main fetch ─────────────────────────────────────────────────────────────────
async function fetchReserveLive(accessToken) {
  const { utc: shiftStart, label: shift } = shiftStartUtc();
  console.log(`[${ts()}] Reserve Live — ${shift} shift, since ${shiftStart}`);

  const associates = {};
  const totals     = { pick_f1: 0, pick_f2: 0, replen: 0, putaway: 0, replen_containers: 0 };
  const rowCounts  = { pick_f1: 0, pick_f2: 0, replen: 0, putaway: 0 };

  console.log(`[${ts()}] Querying all groups in parallel...`);
  const results = await Promise.all(RS_GROUPS.map(async group => {
    try {
      const resp = await mcpQuery(accessToken, buildGroupSql(shiftStart, group));
      return { group, rows: resp.rows || [] };
    } catch (e) {
      console.error(`[${ts()}] ${group.label} query failed:`, e.message);
      return { group, rows: [] };
    }
  }));

  for (const { group, rows } of results) {
    console.log(`[${ts()}] ${group.label}: ${rows.length} associates`);
    rowCounts[group.key] = rows.length;
    for (const row of rows) {
      const emp = row.Employee;
      const qty = Math.round(Number(row.total_qty) || 0);
      if (!associates[emp]) associates[emp] = { pick_f1: 0, pick_f2: 0, replen: 0, putaway: 0 };
      associates[emp][group.key] = qty;
      totals[group.key] += qty;
      if (group.containerCount) {
        const cCount = Math.round(Number(row.container_count) || 0);
        associates[emp].replen_containers = cCount;
        totals.replen_containers += cCount;
      }
    }
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
  console.log(`[${ts()}]   Pick F1: ${totals.pick_f1}  Pick F2: ${totals.pick_f2}  Replen: ${totals.replen}  Putaway: ${totals.putaway}`);

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
    setInterval(async () => {
      try {
        const t = await getAccessTokenSilent();
        console.log(`[${ts()}] Refreshing reserve_live + putaway_live in parallel...`);
        await Promise.all([fetchReserveLive(t), fetchPutawayWip(t)]);
      } catch (e) {
        console.error(`[${ts()}] Error:`, e.message);
      }
    }, INTERVAL);
    return;
  }

  const token = await getAccessToken();
  console.log(`[${ts()}] Priming reserve_live + putaway_live in parallel...`);
  await Promise.all([fetchReserveLive(token), fetchPutawayWip(token)]);
}

main().catch(e => { console.error(e.message); process.exit(1); });
