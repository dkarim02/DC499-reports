#!/usr/bin/env node
/**
 * SCOUT — Shipping Live Agent
 * Queries TSK_ACTIVITY_TRACKING for NRDR CORE PALLETIZE OLPN + FLOOR LOAD PALLETIZE OLPN.
 * Deduplicates by Employee + Container ID, buckets into shift hours, writes shipping_live.json.
 *
 * Usage:
 *   node scout_shipping_agent.js            one-shot refresh
 *   node scout_shipping_agent.js --auth     first-time auth / re-auth
 *   node scout_shipping_agent.js --serve    auto-refresh every 5 min
 *   node scout_shipping_agent.js --serve --interval=5
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
const OUTPUT_FILE   = path.join(__dirname, 'shipping_live.json');
const CLIENT_ID     = 'https://claude.ai/oauth/claude-code-client-metadata';
const REDIRECT_PORT = 3120;
const REDIRECT_URI  = `http://localhost:${REDIRECT_PORT}/callback`;
const FACILITY      = '499';

// Shift window: 2:15 PM PDT = 21:15 UTC
const SHIFT_START_HOUR_PDT = 14; // 2 PM
const SHIFT_START_MIN_PDT  = 15;
const HOURLY_TARGET        = 80; // containers per person per hour

const SHIPPING_TX = [
  'NRDR CORE PALLETIZE OLPN',
  'FLOOR LOAD PALLETIZE OLPN',
];

const args       = process.argv.slice(2);
const MODE_AUTH  = args.includes('--auth');
const MODE_SERVE = args.includes('--serve');
const INTERVAL   = (() => {
  const f = args.find(a => a.startsWith('--interval='));
  return f ? parseInt(f.split('=')[1]) * 60 * 1000 : 5 * 60 * 1000; // default 5 min
})();

// ── OAuth (shared pattern) ─────────────────────────────────────────────────────
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
  // 2nd shift: 2:15 PM PDT = 21:15 UTC
  // 1st shift: not in scope for shipping — but keep consistent boundary
  const is1st = h >= 10 && h < 21;
  const start = new Date(nowUtc);
  if (is1st) {
    start.setUTCHours(10, 0, 0, 0);
  } else {
    start.setUTCHours(21, 15, 0, 0);
    if (h < 10) start.setUTCDate(start.getUTCDate() - 1);
  }
  return {
    utc: start.toISOString().replace('T', ' ').slice(0, 19),
    label: is1st ? '1st' : '2nd',
    // PDT hour the shift starts (for hour-bucket headers)
    pdtHour: is1st ? 10 : 14,
  };
}

// ── SQL ────────────────────────────────────────────────────────────────────────
function buildSql(shiftStart) {
  const txList = SHIPPING_TX.map(t => `'${t.replace(/'/g, "''")}'`).join(',');
  return `
SELECT
  t.USER_ID                                              AS \`Employee\`,
  t.TRANSACTION_ID                                       AS \`Transaction ID\`,
  CONVERT_TZ(t.ACTIVITY_DATE_TIME, '+00:00', '-07:00')   AS \`Activity Datetime\`,
  t.CONTAINER_ID                                         AS \`Container ID\`
FROM default_task.TSK_ACTIVITY_TRACKING t
WHERE t.FACILITY_ID = '${FACILITY}'
  AND t.CREATED_TIMESTAMP >= '${shiftStart}'
  AND t.TRANSACTION_ID IN (${txList})
ORDER BY t.ACTIVITY_DATE_TIME ASC`.trim();
}

// ── process rows into per-employee hourly buckets ──────────────────────────────
function processRows(rows, shiftPdtHour) {
  // Dedup: each Employee + Container ID pair counts once, attributed to the earliest hour seen
  const earliest = {}; // key: `employee|containerID` → PDT hour integer
  for (const row of rows) {
    const emp = (row['Employee'] || '').trim();
    const cid = (row['Container ID'] || '').trim();
    if (!emp || !cid) continue;
    const dtStr = row['Activity Datetime'];
    if (!dtStr) continue;
    // Parse PDT hour from the already-converted timestamp string
    const dt = new Date(String(dtStr).replace(' ', 'T') + '-07:00');
    if (isNaN(dt.getTime())) continue;
    const pdtHour = dt.getHours(); // 0–23 PDT
    const key = `${emp}|${cid}`;
    if (earliest[key] === undefined || pdtHour < earliest[key]) {
      earliest[key] = pdtHour;
    }
  }

  // Build per-employee buckets
  // Shift hours 2 PM–10 PM PDT = hours 14..21 (9 possible hours on display)
  const HOURS = [14, 15, 16, 17, 18, 19, 20, 21];
  const empMap = {}; // employee -> { hourBuckets: {14:n, 15:n,...}, total: n }

  for (const [key, pdtHour] of Object.entries(earliest)) {
    const emp = key.split('|')[0];
    if (!empMap[emp]) {
      empMap[emp] = { hours: {}, total: 0 };
      for (const h of HOURS) empMap[emp].hours[h] = 0;
    }
    if (empMap[emp].hours[pdtHour] !== undefined) {
      empMap[emp].hours[pdtHour]++;
    }
    empMap[emp].total++;
  }

  // Sort employees by total desc
  const employees = Object.entries(empMap)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([emp, data]) => ({
      employee: emp,
      hours: data.hours,
      total: data.total,
    }));

  // Team totals row
  const teamHours = {};
  for (const h of HOURS) {
    teamHours[h] = employees.reduce((s, e) => s + (e.hours[h] || 0), 0);
  }
  const teamTotal = employees.reduce((s, e) => s + e.total, 0);

  return { employees, teamHours, teamTotal, hours: HOURS };
}

// ── main fetch ─────────────────────────────────────────────────────────────────
async function fetchShippingLive(accessToken) {
  const { utc: shiftStart, label: shift, pdtHour: shiftPdtHour } = shiftStartUtc();

  console.log(`[${ts()}] Querying shipping transactions since ${shiftStart}...`);
  const resp = await mcpQuery(accessToken, buildSql(shiftStart));
  const rows = resp.rows || [];
  console.log(`[${ts()}] ${rows.length} rows`);
  if (rows.length >= 9500) console.warn(`[${ts()}] ⚠ Hit row cap — data may be truncated`);

  const { employees, teamHours, teamTotal, hours } = processRows(rows, shiftPdtHour);

  const output = {
    generated:     new Date().toISOString(),
    shift,
    shift_start:   shiftStart,
    facility:      FACILITY,
    row_count:     rows.length,
    truncated:     rows.length >= 9500,
    hourly_target: HOURLY_TARGET,
    hours,          // array of PDT hour integers shown as columns
    employees,      // [{employee, hours:{14:n,...}, total}]
    team_hours:    teamHours,
    team_total:    teamTotal,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`[${ts()}] ✓ shipping_live.json written (${employees.length} associates, ${shift} shift)`);

  try {
    execSync('git stash',                      { cwd: __dirname, stdio: 'pipe' });
    execSync('git pull --rebase origin main',  { cwd: __dirname, stdio: 'pipe' });
    execSync('git stash pop',                  { cwd: __dirname, stdio: 'pipe' });
    execSync('git add shipping_live.json',     { cwd: __dirname, stdio: 'pipe' });
    execSync('git commit -m "Shipping live update -- ' + new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }) + '"', { cwd: __dirname, stdio: 'pipe' });
    execSync('git push origin main',           { cwd: __dirname, stdio: 'pipe' });
    console.log(`[${ts()}] ✓ shipping_live.json pushed to GitHub`);
  } catch (e) {
    const msg = e.stderr ? e.stderr.toString() : e.message;
    if (msg.includes('nothing to commit') || msg.includes('no changes')) {
      console.log(`[${ts()}] No changes to push`);
    } else {
      console.warn(`[${ts()}] Git push warning:`, msg.slice(0, 200));
    }
  }

  return employees.length;
}

// ── entry point ────────────────────────────────────────────────────────────────
async function main() {
  if (MODE_AUTH) {
    await doAuthFlow();
    return;
  }

  if (MODE_SERVE) {
    console.log(`[${ts()}] SCOUT Shipping Agent — serve mode, interval ${INTERVAL / 60000} min`);
    const token = await getAccessTokenSilent().catch(async e => {
      if (e instanceof AuthError) return doAuthFlow();
      throw e;
    });
    await fetchShippingLive(token);
    setInterval(async () => {
      try {
        const t = await getAccessTokenSilent();
        await fetchShippingLive(t);
      } catch (e) {
        console.error(`[${ts()}] Error:`, e.message);
      }
    }, INTERVAL);
    return;
  }

  const token = await getAccessToken();
  await fetchShippingLive(token);
}

main().catch(e => { console.error(e.message); process.exit(1); });
