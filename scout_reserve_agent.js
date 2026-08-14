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
const OUTPUT_FILE   = path.join(__dirname, 'reserve_live.json');
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
  return [
    `SELECT CREATED_BY AS Employee, SUM(${group.metric}) AS total_qty`,
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
  const totals     = { pick_f1: 0, pick_f2: 0, replen: 0, putaway: 0 };
  const rowCounts  = { pick_f1: 0, pick_f2: 0, replen: 0, putaway: 0 };

  for (const group of RS_GROUPS) {
    console.log(`[${ts()}] Querying ${group.label}...`);
    try {
      const resp = await mcpQuery(accessToken, buildGroupSql(shiftStart, group));
      const rows = resp.rows || [];
      console.log(`[${ts()}] ${group.label}: ${rows.length} associates`);
      rowCounts[group.key] = rows.length;

      for (const row of rows) {
        const emp = row.Employee;
        const qty = Math.round(Number(row.total_qty) || 0);
        if (!associates[emp]) associates[emp] = { pick_f1: 0, pick_f2: 0, replen: 0, putaway: 0 };
        associates[emp][group.key] = qty;
        totals[group.key] += qty;
      }
    } catch (e) {
      console.error(`[${ts()}] ${group.label} query failed:`, e.message);
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

  try {
    execSync('git stash',                    { cwd: __dirname, stdio: 'pipe' });
    execSync('git fetch origin main',        { cwd: __dirname, stdio: 'pipe' });
    execSync('git rebase origin/main',       { cwd: __dirname, stdio: 'pipe' });
    execSync('git stash pop',                { cwd: __dirname, stdio: 'pipe' });
    execSync('git add reserve_live.json',     { cwd: __dirname, stdio: 'pipe' });
    execSync(`git commit -m "Reserve live update -- ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}"`, { cwd: __dirname, stdio: 'pipe' });
    execSync('git push origin main',          { cwd: __dirname, stdio: 'pipe' });
    console.log(`[${ts()}] ✓ reserve_live.json pushed to GitHub`);
  } catch (e) {
    const msg = e.stderr ? e.stderr.toString() : e.message;
    if (msg.includes('nothing to commit') || msg.includes('no changes')) {
      console.log(`[${ts()}] No changes to push`);
    } else {
      console.warn(`[${ts()}] Git push warning:`, msg.slice(0, 200));
    }
  }
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
    await fetchReserveLive(token);
    setInterval(async () => {
      try {
        const t = await getAccessTokenSilent();
        await fetchReserveLive(t);
      } catch (e) {
        console.error(`[${ts()}] Error:`, e.message);
      }
    }, INTERVAL);
    return;
  }

  const token = await getAccessToken();
  await fetchReserveLive(token);
}

main().catch(e => { console.error(e.message); process.exit(1); });
