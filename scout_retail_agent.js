#!/usr/bin/env node
/**
 * SCOUT — Retail Backlog Agent
 * Queries DCO_ORDER for Retail (store replen) order progress by wave date.
 * Wave-based: one wave per week, date bucketing used as wave identifier.
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

// Convert a PDT date string (YYYY-MM-DD) to UTC window for querying.
// PDT = UTC-7. Fix to UTC-8 (PST) ~Oct 25 2026 when DST ends.
function pdtDateToUtcWindow(pdtDate) {
  const [y, m, d] = pdtDate.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d, 7, 0, 0)); // midnight PDT = 07:00 UTC
  const end   = new Date(Date.UTC(y, m - 1, d + 1, 7, 0, 0));
  const fmt   = dt => dt.toISOString().replace('T', ' ').slice(0, 19);
  return { start: fmt(start), end: fmt(end) };
}

function lookbackUtc() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - LOOKBACK_DAYS);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

// ── queries ────────────────────────────────────────────────────────────────────

// Step 0: Get retail wave run IDs from the planning run table.
// ORDER_PLANNING_RUN_ID format: W{MMDDYYYY}{seq} — e.g. W09222026000000000005
// One retail run per week — date bucket matches wave_date from DCO_ORDER.
function sqlWaveRunIds(since) {
  return `
SELECT
  ORDER_PLANNING_RUN_ID AS run_id,
  DATE_FORMAT(CONVERT_TZ(CREATED_TIMESTAMP, '+00:00', '-07:00'), '%Y-%m-%d') AS run_date
FROM default_dcorder.DCO_ORDER_PLAN_RUN_STRATEGY
WHERE FACILITY_ID = '${FACILITY}'
  AND PLANNING_STRATEGY_ID = 'NRDR_CORE_RETAIL_ORDER_PLANNING_STRATEGY'
  AND CREATED_TIMESTAMP >= '${since}'
ORDER BY CREATED_TIMESTAMP DESC
`.trim();
}

// Step 1: Get all wave dates that still have active (non-shipped) orders.
function sqlActiveWaveDates(since) {
  return `
SELECT
  DATE_FORMAT(CONVERT_TZ(CREATED_TIMESTAMP, '+00:00', '-07:00'), '%Y-%m-%d') AS wave_date,
  COUNT(DISTINCT ORDER_ID) AS active_orders
FROM default_dcorder.DCO_ORDER
WHERE FACILITY_ID = '${FACILITY}'
  AND ORDER_TYPE = 'RETAIL'
  AND CANCELLED = 0
  AND MAXIMUM_STATUS NOT IN ('8000', '9000')
  AND CREATED_TIMESTAMP >= '${since}'
GROUP BY wave_date
ORDER BY wave_date DESC
`.trim();
}

// Step 2: Status breakdown for one wave date window.
// Bucket by MINIMUM_STATUS (where the order is blocked) not MAXIMUM_STATUS.
// An order with min=Allocated, max=Packed still has open allocated lines — it belongs in Allocated.
// MAXIMUM_STATUS filter still excludes fully shipped/cancelled orders.
function sqlStatusBreakdown(utcStart, utcEnd) {
  return `
SELECT
  MINIMUM_STATUS,
  COUNT(DISTINCT ORDER_ID) AS orders
FROM default_dcorder.DCO_ORDER
WHERE FACILITY_ID = '${FACILITY}'
  AND ORDER_TYPE = 'RETAIL'
  AND CANCELLED = 0
  AND CREATED_TIMESTAMP >= '${utcStart}'
  AND CREATED_TIMESTAMP < '${utcEnd}'
  AND MAXIMUM_STATUS NOT IN ('8000', '9000')
GROUP BY MINIMUM_STATUS
ORDER BY MINIMUM_STATUS
`.trim();
}

// Step 3: Store (destination facility) breakdown for one wave date window.
function sqlStoreBreakdown(utcStart, utcEnd) {
  return `
SELECT
  DESTINATION_FACILITY_ID AS store_id,
  COUNT(DISTINCT ORDER_ID) AS orders
FROM default_dcorder.DCO_ORDER
WHERE FACILITY_ID = '${FACILITY}'
  AND ORDER_TYPE = 'RETAIL'
  AND CANCELLED = 0
  AND CREATED_TIMESTAMP >= '${utcStart}'
  AND CREATED_TIMESTAMP < '${utcEnd}'
  AND MAXIMUM_STATUS NOT IN ('8000', '9000')
GROUP BY DESTINATION_FACILITY_ID
ORDER BY orders DESC
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

  // Step 0: Get wave run IDs for wave number labeling (best-effort)
  let waveNumMap = {};
  try {
    const resp = await mcpQuery(accessToken, sqlWaveRunIds(since));
    waveNumMap = buildWaveNumMap(resp.rows || []);
    console.log(`[${ts()}] Wave run IDs loaded: ${Object.keys(waveNumMap).length} dates`);
  } catch (e) {
    console.warn(`[${ts()}] Wave run ID query failed (non-fatal):`, e.message);
  }

  // Step 1: Get active wave dates
  let waveDates = [];
  try {
    const resp = await mcpQuery(accessToken, sqlActiveWaveDates(since));
    waveDates = (resp.rows || []).map(r => r.wave_date);
    console.log(`[${ts()}] Active waves found: ${waveDates.join(', ') || 'none'}`);
  } catch (e) {
    console.error(`[${ts()}] Wave date query failed:`, e.message);
    return;
  }

  if (!waveDates.length) {
    const output = {
      generated: new Date().toISOString(),
      facility: FACILITY,
      waves: [],
    };
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
    console.log(`[${ts()}] ✓ retail_backlog_live.json written — no active waves`);
    return;
  }

  // Steps 2+3: For each wave, fire status + store queries in parallel
  const waves = await Promise.all(waveDates.map(async (waveDate) => {
    const { start, end } = pdtDateToUtcWindow(waveDate);
    try {
      const [statusResp, storeResp] = await Promise.all([
        mcpQuery(accessToken, sqlStatusBreakdown(start, end)),
        mcpQuery(accessToken, sqlStoreBreakdown(start, end)),
      ]);

      const statusCounts = {};
      let totalActive = 0;
      for (const row of (statusResp.rows || [])) {
        statusCounts[row.MINIMUM_STATUS] = Number(row.orders);
        totalActive += Number(row.orders);
      }

      const stores = (storeResp.rows || []).map(r => ({
        store_id: r.store_id,
        orders: Number(r.orders),
      }));

      const waveNum = waveNumMap[waveDate] || null;
      console.log(`[${ts()}] Wave ${waveDate}${waveNum ? ` (${waveNum})` : ''}: ${totalActive} active orders, ${stores.length} stores`);
      return { wave_date: waveDate, wave_number: waveNum, total_active_orders: totalActive, status_counts: statusCounts, stores };
    } catch (e) {
      console.error(`[${ts()}] Wave ${waveDate} queries failed:`, e.message);
      return { wave_date: waveDate, wave_number: waveNumMap[waveDate] || null, total_active_orders: null, status_counts: {}, stores: [], error: true };
    }
  }));

  const output = {
    generated: new Date().toISOString(),
    facility: FACILITY,
    status_labels: STATUS_LABELS,
    waves,
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
    setInterval(async () => {
      try {
        const t = await getAccessTokenSilent();
        await fetchRetailBacklog(t);
      } catch (e) {
        console.error(`[${ts()}] Error:`, e.message);
      }
    }, INTERVAL);
    return;
  }

  const token = await getAccessToken();
  await fetchRetailBacklog(token);
}

main().catch(e => { console.error(e.message); process.exit(1); });
