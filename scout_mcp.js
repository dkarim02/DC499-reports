// scout_mcp.js — shared MAWM MCP login + query code for every agent.
//
// Usage (top of an agent, after REDIRECT_PORT is set):
//   const { getAccessToken, getAccessTokenSilent, doAuthFlow, AuthError, jsonPost, mcpQuery }
//     = require('./scout_mcp')({ redirectPort: REDIRECT_PORT });
//
// What this coordinates across all agent processes (they share .mcp_token.json):
// - Token refresh: one process at a time (.mcp_token.json.lock). Every path — serve,
//   one-shot, scheduled task — goes through the lock, so nobody burns the shared refresh
//   token out from under the others.
// - Query slots: at most POOL_SLOTS MCP queries in flight across ALL agents together
//   (.mcp_slot_N.lock files). Used to be 2 for dc499_refresh + 1 shared by every sub-agent,
//   uncoordinated — up to 3 at once anyway, with sub-agents stuck in single file.
// - Time limits: a hung query is dropped after QUERY_TIMEOUT_MS so it can't hold a slot.
// - Locks are only ever removed by their owner, or when stale (owner process gone / too old).

const fs     = require('fs');
const path   = require('path');
const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const { execSync } = require('child_process');

const DIR        = process.env.SCOUT_MCP_DIR || __dirname;   // override only for tests
const MCP_BASE   = 'https://mawm-data-mcp.nordstromaws.app';
const CLIENT_ID  = 'https://claude.ai/oauth/claude-code-client-metadata';
const TOKEN_FILE = path.join(DIR, '.mcp_token.json');
const LOCK_FILE  = TOKEN_FILE + '.lock';
const TOKEN_TTL  = 55 * 60 * 1000;   // fallback if the token has no expires_in

// 3 = the most the old setup already hit at peak (refresh 2 + sub-agents 1). More than that
// has caused empty responses. Override with SCOUT_MCP_SLOTS for testing.
const POOL_SLOTS       = Math.max(1, parseInt(process.env.SCOUT_MCP_SLOTS, 10) || 3);
const QUERY_TIMEOUT_MS = 4 * 60 * 1000;        // drop a query that hasn't answered in 4 min
const POST_TIMEOUT_MS  = 30 * 1000;            // token / webhook calls
const SLOT_STALE_MS    = QUERY_TIMEOUT_MS + 60 * 1000;
const SLOT_WAIT_MS     = 5 * 60 * 1000;        // give up (query fails) after waiting this long
const TOKEN_LOCK_STALE_MS = 60 * 1000;

class AuthError extends Error {}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function pidAlive(pid) {
  if (!pid) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }   // EPERM = exists, just not ours
}

// ── Cross-process lock files ──────────────────────────────────────────────────
// Each lock file holds {id, pid, at}. Only the owner (matching id) deletes it on release.
function tryLock(file) {
  const id = process.pid + ':' + crypto.randomBytes(4).toString('hex');
  try {
    fs.writeFileSync(file, JSON.stringify({ id, pid: process.pid, at: Date.now() }), { flag: 'wx' });
    return id;
  } catch { return null; }
}
function unlockIfOwner(file, id) {
  try {
    const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cur.id === id) fs.unlinkSync(file);
  } catch {}
}
function clearIfStale(file, staleMs) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return; }   // already gone
  let cur = null;
  try { cur = JSON.parse(raw); } catch {}
  if (!cur || typeof cur !== 'object') {
    // Old-format lock (plain PID) or a half-written file
    const pid = parseInt(raw, 10);
    let age = 0; try { age = Date.now() - fs.statSync(file).mtimeMs; } catch {}
    if ((pid && !pidAlive(pid)) || age > staleMs) { try { fs.unlinkSync(file); } catch {} }
    return;
  }
  if (!pidAlive(cur.pid) || Date.now() - cur.at > staleMs) {
    // Re-check it's still the same lock right before removing it
    try {
      const again = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (again.id === cur.id) {
        fs.unlinkSync(file);
        console.warn(`[scout_mcp] cleared stale lock ${path.basename(file)} (pid ${cur.pid})`);
      }
    } catch {}
  }
}

// ── Query slot pool ───────────────────────────────────────────────────────────
// In-process queue first (so 20 queued queries don't all poll the disk), then a file slot.
let _localActive = 0;
const _localQueue = [];
function _localAcquire() {
  return new Promise(resolve => {
    if (_localActive < POOL_SLOTS) { _localActive++; resolve(); }
    else _localQueue.push(resolve);
  });
}
function _localRelease() {
  if (_localQueue.length) _localQueue.shift()();
  else _localActive--;
}
const slotFile = i => path.join(DIR, `.mcp_slot_${i}.lock`);

async function acquireSlot() {
  await _localAcquire();
  const deadline = Date.now() + SLOT_WAIT_MS;
  const start = Math.floor(Math.random() * POOL_SLOTS);
  while (true) {
    for (let k = 0; k < POOL_SLOTS; k++) {
      const file = slotFile((start + k) % POOL_SLOTS);
      const id = tryLock(file);
      if (id) return { file, id };
      clearIfStale(file, SLOT_STALE_MS);
    }
    if (Date.now() > deadline) {
      _localRelease();
      throw new Error(`No free MCP query slot after ${SLOT_WAIT_MS / 60000} min`);
    }
    await sleep(150 + Math.random() * 250);
  }
}
function releaseSlot(slot) {
  unlockIfOwner(slot.file, slot.id);
  _localRelease();
}

// ── Token storage ─────────────────────────────────────────────────────────────
function loadToken() {
  // Try primary, fall back to backup
  for (const f of [TOKEN_FILE, TOKEN_FILE + '.bak']) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  }
  return null;
}
function saveToken(t) {
  // Backup existing, then write new via temp + rename so a reader never sees half a file
  const out = JSON.stringify({ ...t, _saved_at: Date.now() }, null, 2);
  try { if (fs.existsSync(TOKEN_FILE)) fs.copyFileSync(TOKEN_FILE, TOKEN_FILE + '.bak'); } catch {}
  const tmp = TOKEN_FILE + '.tmp';
  try { fs.writeFileSync(tmp, out); fs.renameSync(tmp, TOKEN_FILE); }
  catch { fs.writeFileSync(TOKEN_FILE, out); try { fs.unlinkSync(tmp); } catch {} }
}
function isTokenFresh(stored) {
  const ttl = stored?.expires_in ? stored.expires_in * 900 : TOKEN_TTL;   // 90% of lifetime
  return stored?.access_token && stored._saved_at && (Date.now() - stored._saved_at) < ttl;
}
async function acquireLock() {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const id = tryLock(LOCK_FILE);
    if (id) return id;
    clearIfStale(LOCK_FILE, TOKEN_LOCK_STALE_MS);
    await sleep(150);
  }
  return null;
}
function releaseLock(id) { if (id) unlockIfOwner(LOCK_FILE, id); }

// ── HTTP ──────────────────────────────────────────────────────────────────────
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
function jsonPost(url, body, headers = {}, timeoutMs = POST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    const req = https.request({
      hostname: u.hostname, port: u.port || 443,
      path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Length': Buffer.byteLength(body), ...headers },
    }, res => {
      let d = '';
      function tryResolve() {
        if (settled) return;
        const trimmed = d.trimStart();
        // Plain JSON (non-SSE response)
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try { const v = JSON.parse(trimmed); done(resolve, v); return; } catch {}
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
            try { const v = JSON.parse(json); done(resolve, v); res.destroy(); return; }
            catch(e) { /* bad JSON in this block, try next */ }
          }
        }
      }
      res.on('data', c => { d += c; tryResolve(); });
      res.on('end', () => {
        if (settled) return;
        const hasData = d.replace(/\r\n/g, '\n').split('\n').some(l => /^data:/.test(l));
        if (hasData) done(reject, new Error(`Unexpected: ${d.slice(0, 300)}`));
        else done(resolve, null);
      });
      res.on('error', e => done(reject, e));
    });
    // Absolute limit — the server's keep-alive pings would reset an idle timeout
    const timer = setTimeout(() => {
      req.destroy();
      done(reject, new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    req.on('error', e => done(reject, e));
    req.write(body);
    req.end();
  });
}

// ── Agent-facing API ──────────────────────────────────────────────────────────
module.exports = function createMcp({ redirectPort }) {
  const REDIRECT_URI = `http://localhost:${redirectPort}/callback`;

  async function refreshAccessToken(rt) {
    return jsonPost(`${MCP_BASE}/token`, new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: rt, client_id: CLIENT_ID,
    }).toString(), { 'Content-Type': 'application/x-www-form-urlencoded' });
  }

  function waitForCode(expectedState) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url  = new URL(req.url, `http://localhost:${redirectPort}`);
        const code = url.searchParams.get('code');
        const st   = url.searchParams.get('state');
        if (!code) { res.end('No code'); return; }
        if (st !== expectedState) { res.end('State mismatch'); reject(new Error('state mismatch')); return; }
        res.end('<script>window.close()</script><p>Authorized! You can close this tab.</p>');
        server.close();
        resolve(code);
      });
      server.listen(redirectPort);
      server.on('error', reject);
      setTimeout(() => { server.close(); reject(new Error('Auth timeout')); }, 120000);
    });
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

  // Never opens a browser; throws AuthError when the token can't be refreshed.
  async function getAccessTokenSilent() {
    // Fast path: token still fresh, no refresh needed
    const quick = loadToken();
    if (isTokenFresh(quick)) return quick.access_token;

    // Only one process refreshes at a time
    const lockId = await acquireLock();
    try {
      // Re-read after acquiring lock — another process may have just refreshed
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
          if (!fresh?.access_token) throw new Error('no access_token in refresh response');
          saveToken({ ...stored, ...fresh });
          return fresh.access_token;
        } catch (e) { lastErr = e; }
      }
      throw new AuthError('Token refresh failed: ' + lastErr.message);
    } finally {
      releaseLock(lockId);
    }
  }

  // One-shot runs: same locked path as serve mode, browser sign-in only if that fails.
  async function getAccessToken() {
    try { return await getAccessTokenSilent(); }
    catch (e) {
      if (!(e instanceof AuthError)) throw e;
      console.warn('Token refresh failed, re-authing:', e.message);
      return doAuthFlow();
    }
  }

  async function mcpQuery(accessToken, sql) {
    const slot = await acquireSlot();
    try {
      const result = await jsonPost(`${MCP_BASE}/mcp`, JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'query_database', arguments: { query: sql } },
      }), {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': `Bearer ${accessToken}`,
      }, QUERY_TIMEOUT_MS);
      if (!result) throw new Error('MCP returned no data (ping-only stream)');
      if (result.error) throw new Error(JSON.stringify(result.error));
      const text = result?.result?.content?.[0]?.text;
      if (!text) throw new Error('Empty MCP response');
      return JSON.parse(text);
    } finally {
      releaseSlot(slot);
    }
  }

  return {
    MCP_BASE, CLIENT_ID, TOKEN_FILE, REDIRECT_URI, AuthError,
    b64url, loadToken, saveToken, isTokenFresh, refreshAccessToken,
    waitForCode, doAuthFlow, getAccessToken, getAccessTokenSilent,
    jsonPost, mcpQuery,
  };
};

module.exports.AuthError = AuthError;
module.exports._internals = { acquireSlot, releaseSlot, acquireLock, releaseLock, jsonPost, slotFile, POOL_SLOTS };   // tests
