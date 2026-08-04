#!/usr/bin/env node
/**
 * SCOUT — Ecom Live Agent
 * Queries LMC_EVENT_SUMMARY_HEADER for Ecom transaction data and writes ecom_live.json.
 * Rows are aliased to match the CSV column names that Ecom_v3.html expects, so
 * processData() can consume them with zero changes.
 *
 * Usage:
 *   node scout_ecom_agent.js            one-shot refresh
 *   node scout_ecom_agent.js --auth     first-time auth / re-auth
 *   node scout_ecom_agent.js --serve    auto-refresh every 30 min
 *   node scout_ecom_agent.js --serve --interval=15
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
const OUTPUT_FILE   = path.join(__dirname, 'ecom_live.json');
const CLIENT_ID     = 'https://claude.ai/oauth/claude-code-client-metadata';
const REDIRECT_PORT = 3119; // different port from dc499_refresh.js (3118)
const REDIRECT_URI  = `http://localhost:${REDIRECT_PORT}/callback`;
const FACILITY      = '499';

const args       = process.argv.slice(2);
const MODE_AUTH  = args.includes('--auth');
const MODE_SERVE = args.includes('--serve');
const INTERVAL   = (() => {
  const f = args.find(a => a.startsWith('--interval='));
  return f ? parseInt(f.split('=')[1]) * 60 * 1000 : 30 * 60 * 1000; // default 30 min
})();

// ── Ecom transaction IDs — four groups to stay under MCP ~10k row cap ───────────
// Group A: replen + putaway        (~2k rows typical)
// Group B: picking                 (~4k rows typical)
// Group C: packing alone           (~3k rows typical)
// Group D: shipping + sorting      (~3k rows typical)
const ECOM_TX_A = [
  'iLPN Replen Fill',
  'Retail iLPN Replen Pull',
  'iLPN Replen Pull',
  'iLPN Replen Fill Large',
  'iLPN Replen Pull Large',
  'System Directed Putaway',
  'User Directed Putaway',
];
const ECOM_TX_B = [
  'Ecom Mezz Pick To Putwall Cart',
  'Ecom Non-Mezz Pick To Putwall Cart',
];
const ECOM_TX_C = [
  'NRDR CORE PACK FOR ECOM PACK STATION',
];
const ECOM_TX_D = [
  'OB Putaway By Ship Via',
  'NRDR Load Parcel Packages',
  'OB Sort To Putwall Cubby',
];

// ── OAuth (copied from dc499_refresh.js) ───────────────────────────────────────
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
function loadToken() {
  for (const f of [TOKEN_FILE, TOKEN_FILE + '.bak']) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  }
  return null;
}
function saveToken(t) {
  try { if (fs.existsSync(TOKEN_FILE)) fs.copyFileSync(TOKEN_FILE, TOKEN_FILE + '.bak'); } catch {}
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2));
}
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
  const stored = loadToken();
  if (!stored?.refresh_token) throw new AuthError('No refresh token — run --auth first');
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
async function mcpQuery(accessToken, sql) {
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
}

// ── helpers ────────────────────────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
}

function shiftStartUtc() {
  const nowUtc = new Date();
  const h = nowUtc.getUTCHours();
  // 1st shift: 3:00 AM–2:00 PM PDT = 10:00–21:00 UTC
  // 2nd shift: 2:10 PM–2:00 AM PDT = 21:10 UTC (next UTC day before 10:00)
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
function buildSql(shiftStart, txGroup) {
  const txList = txGroup.map(t => `'${t.replace(/'/g, "''")}'`).join(',');
  return `
SELECT
  t.USER_ID                                              AS \`Employee\`,
  t.TRANSACTION_ID                                       AS \`Transaction ID\`,
  CONVERT_TZ(t.ACTIVITY_DATE_TIME, '+00:00', '-07:00')   AS \`Activity Datetime\`,
  t.QUANTITY                                             AS \`Quantity\`,
  t.COMPLETED_QUANTITY                                   AS \`Completed Quantity\`,
  t.TRACE_ID                                             AS \`CP Trace Id\`,
  t.CONTAINER_ID                                         AS \`Container ID\`,
  t.SOURCE_LOCATION_ID                                   AS \`Current Location\`,
  ''                                                     AS \`Previous Location\`,
  t.CRITERIA_ID                                          AS \`Criteria\`
FROM default_task.TSK_ACTIVITY_TRACKING t
WHERE t.FACILITY_ID = '${FACILITY}'
  AND t.CREATED_TIMESTAMP >= '${shiftStart}'
  AND t.TRANSACTION_ID IN (${txList})
ORDER BY t.ACTIVITY_DATE_TIME ASC`.trim();
}

// ── main fetch ─────────────────────────────────────────────────────────────────
async function fetchEcomLive(accessToken) {
  const { utc: shiftStart, label: shift } = shiftStartUtc();

  console.log(`[${ts()}] Querying Group A (replen/putaway) since ${shiftStart}...`);
  const respA = await mcpQuery(accessToken, buildSql(shiftStart, ECOM_TX_A));
  const rowsA = respA.rows || [];
  console.log(`[${ts()}] Group A: ${rowsA.length} rows`);
  if (rowsA.length >= 9500) console.warn(`[${ts()}] ⚠ Group A hit row cap — replen/putaway may be truncated`);

  console.log(`[${ts()}] Querying Group B (picking)...`);
  const respB = await mcpQuery(accessToken, buildSql(shiftStart, ECOM_TX_B));
  const rowsB = respB.rows || [];
  console.log(`[${ts()}] Group B: ${rowsB.length} rows`);
  if (rowsB.length >= 9500) console.warn(`[${ts()}] ⚠ Group B hit row cap — picking may be truncated`);

  console.log(`[${ts()}] Querying Group C (packing)...`);
  const respC = await mcpQuery(accessToken, buildSql(shiftStart, ECOM_TX_C));
  const rowsC = respC.rows || [];
  console.log(`[${ts()}] Group C: ${rowsC.length} rows`);
  if (rowsC.length >= 9500) console.warn(`[${ts()}] ⚠ Group C hit row cap — packing may be truncated`);

  console.log(`[${ts()}] Querying Group D (shipping/sorting)...`);
  const respD = await mcpQuery(accessToken, buildSql(shiftStart, ECOM_TX_D));
  const rowsD = respD.rows || [];
  console.log(`[${ts()}] Group D: ${rowsD.length} rows`);
  if (rowsD.length >= 9500) console.warn(`[${ts()}] ⚠ Group D hit row cap — shipping/sorting may be truncated`);

  const rows = rowsA.concat(rowsB, rowsC, rowsD);
  const truncated = rowsA.length >= 9500 || rowsB.length >= 9500 || rowsC.length >= 9500 || rowsD.length >= 9500;
  console.log(`[${ts()}] Total: ${rows.length} rows combined${truncated ? ' ⚠ (truncated)' : ''}`);

  const output = {
    generated:   new Date().toISOString(),
    shift:        shift,
    shift_start:  shiftStart,
    facility:     FACILITY,
    row_count:    rows.length,
    truncated:    truncated,
    rows:         rows,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`[${ts()}] ✓ ecom_live.json written (${rows.length} rows, ${shift} shift)`);

  // Push to GitHub so GitHub Pages can serve it
  try {
    execSync('git stash',                                        { cwd: __dirname, stdio: 'pipe' });
    execSync('git pull --rebase origin main',                   { cwd: __dirname, stdio: 'pipe' });
    execSync('git stash pop',                                    { cwd: __dirname, stdio: 'pipe' });
    execSync('git add ecom_live.json',                           { cwd: __dirname, stdio: 'pipe' });
    execSync('git commit -m "Ecom live update -- ' + new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }) + '"', { cwd: __dirname, stdio: 'pipe' });
    execSync('git push origin main',                             { cwd: __dirname, stdio: 'pipe' });
    console.log(`[${ts()}] ✓ ecom_live.json pushed to GitHub`);
  } catch (e) {
    // Commit may fail if nothing changed — not an error
    const msg = e.stderr ? e.stderr.toString() : e.message;
    if (msg.includes('nothing to commit') || msg.includes('no changes')) {
      console.log(`[${ts()}] No changes to push`);
    } else {
      console.warn(`[${ts()}] Git push warning:`, msg.slice(0, 200));
    }
  }

  return rows.length;
}

// ── entry point ────────────────────────────────────────────────────────────────
async function main() {
  if (MODE_AUTH) {
    await doAuthFlow();
    return;
  }

  if (MODE_SERVE) {
    console.log(`[${ts()}] SCOUT Ecom Agent — serve mode, interval ${INTERVAL / 60000} min`);
    const token = await getAccessTokenSilent().catch(async e => {
      if (e instanceof AuthError) { return doAuthFlow(); }
      throw e;
    });
    await fetchEcomLive(token);
    setInterval(async () => {
      try {
        const t = await getAccessTokenSilent();
        await fetchEcomLive(t);
      } catch (e) {
        console.error(`[${ts()}] Error:`, e.message);
      }
    }, INTERVAL);
    return;
  }

  // One-shot
  const token = await getAccessToken();
  await fetchEcomLive(token);
}

main().catch(e => { console.error(e.message); process.exit(1); });
