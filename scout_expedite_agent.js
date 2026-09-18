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

// ── main fetch ─────────────────────────────────────────────────────────────────
async function fetchExpedite(accessToken) {
  const nowUtc     = new Date();
  const nowUtcHour = nowUtc.getUTCHours();
  const is1st      = nowUtcHour >= 10 && nowUtcHour < 21;

  // Shift start in UTC — 2nd = 21:00 (prev day if h<21), 1st = 10:00 today
  const shiftStart = new Date(nowUtc);
  if (is1st) {
    shiftStart.setUTCHours(10, 0, 0, 0);
  } else {
    shiftStart.setUTCHours(21, 0, 0, 0);
    if (nowUtcHour < 21) shiftStart.setUTCDate(shiftStart.getUTCDate() - 1);
  }
  const shiftStartStr = shiftStart.toISOString().replace('T',' ').slice(0,19);

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

  const [respOpen, respShipped, respLines] = await Promise.all([
    mcpQuery(accessToken, sqlOpen),
    mcpQuery(accessToken, sqlShipped).catch(() => ({ rows: [] })),
    mcpQuery(accessToken, sqlLines).catch(() => ({ rows: [] })),
  ]);

  const openOrders = respOpen.rows || [];

  // line count map: ORDER_ID -> unit count
  const lineMap = {};
  for (const r of (respLines.rows || [])) lineMap[r.ORDER_ID] = Number(r.line_count || 0);

  // shipped counts broken out by service level
  const shippedMap = {};
  for (const r of (respShipped.rows || [])) shippedMap[r.svc] = Number(r.shipped_count || 0);
  const shippedCount = (shippedMap['11'] || 0) + (shippedMap['42'] || 0);

  // oLPN enrichment — direct PPK_OLPN query by ORDER_ID
  // Must list columns explicitly — SELECT * is blocked by PII filter
  let olpnMap = {}; // ORDER_ID -> array of olpn objects
  if (openOrders.length > 0) {
    const orderIds = openOrders.map(r => `'${r.ORDER_ID}'`).join(',');
    try {
      const respOlpn = await mcpQuery(accessToken, `
SELECT OLPN_ID, ORDER_ID, STATUS AS olpn_status, CURRENT_LOCATION_ID, CARRIER_ID, SERVICE_LEVEL_ID, TRACKING_NUMBER
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
      olpn_status:   topOlpn?.olpn_status   || null,
      olpn_location: topOlpn?.CURRENT_LOCATION_ID || null,
      carrier:       topOlpn?.CARRIER_ID    || null,
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
    setInterval(async () => {
      try {
        const t = await getAccessTokenSilent();
        await fetchExpedite(t);
      } catch (e) {
        console.error(`[${ts()}] Error:`, e.message);
      }
    }, INTERVAL);
    return;
  }

  const token = await getAccessToken();
  await fetchExpedite(token);
}

main().catch(e => { console.error(e.message); process.exit(1); });
