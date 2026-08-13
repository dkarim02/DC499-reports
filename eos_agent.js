#!/usr/bin/env node
/**
 * DC499 EOS Report Agent
 * node eos_agent.js --sos     capture SOS snapshot (run at 2:10 PM)
 * node eos_agent.js --eos     capture EOS + merge with SOS (run at shift end)
 * node eos_agent.js --auth    first-time auth
 */

const fs   = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execSync } = require('child_process');

const MCP_BASE      = 'https://mawm-data-mcp.nordstromaws.app';
const TOKEN_FILE    = path.join(__dirname, '.mcp_token.json');
const REPORT_DIR    = __dirname;
const SOS_FILE      = path.join(REPORT_DIR, 'eos_sos_snapshot.json');
const REPORT_FILE   = path.join(REPORT_DIR, 'eos_report.json');
const CLIENT_ID     = 'https://claude.ai/oauth/claude-code-client-metadata';
const REDIRECT_PORT = 3118;
const REDIRECT_URI  = `http://localhost:${REDIRECT_PORT}/callback`;
const FACILITY      = '499';

// ── OAuth (shared pattern) ────────────────────────────────────────────────────
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
function loadToken()    { try { return JSON.parse(fs.readFileSync(TOKEN_FILE,'utf8')); } catch { return null; } }
function saveToken(t)   { fs.writeFileSync(TOKEN_FILE, JSON.stringify(t,null,2)); }

async function refreshAccessToken(rt) {
  return jsonPost(`${MCP_BASE}/token`, new URLSearchParams({
    grant_type:'refresh_token', refresh_token:rt, client_id:CLIENT_ID,
  }).toString(), {'Content-Type':'application/x-www-form-urlencoded'});
}

async function doAuthFlow() {
  const verifier  = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state     = b64url(crypto.randomBytes(16));
  const authUrl   = `${MCP_BASE}/authorize?` + new URLSearchParams({
    response_type:'code', client_id:CLIENT_ID,
    code_challenge:challenge, code_challenge_method:'S256',
    redirect_uri:REDIRECT_URI, state,
    scope:'openid offline_access', prompt:'consent',
    resource:`${MCP_BASE}/mcp`,
  });
  const opener = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try { execSync(`${opener} "${authUrl}"`); } catch {}
  console.log('Browser opened. Waiting for callback...');
  const code = await waitForCode(state);
  const tokens = await jsonPost(`${MCP_BASE}/token`, new URLSearchParams({
    grant_type:'authorization_code', code,
    redirect_uri:REDIRECT_URI, client_id:CLIENT_ID, code_verifier:verifier,
  }).toString(), {'Content-Type':'application/x-www-form-urlencoded'});
  saveToken(tokens);
  console.log('✓ Authenticated.');
  return tokens.access_token;
}

function waitForCode(expectedState) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      const code = url.searchParams.get('code');
      const st   = url.searchParams.get('state');
      if (!code) { res.end('No code'); return; }
      if (st !== expectedState) { res.end('State mismatch'); reject(new Error('state mismatch')); return; }
      res.end('<script>window.close()</script><p>Authorized!</p>');
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
  } catch {
    return doAuthFlow();
  }
}

// ── HTTP / MCP ────────────────────────────────────────────────────────────────
function jsonPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname:u.hostname, port:u.port||443,
      path:u.pathname+u.search, method:'POST',
      headers:{'Content-Length':Buffer.byteLength(body), ...headers},
    }, res => {
      let d = ''; let resolved = false;
      function tryResolve() {
        if (resolved) return;
        const trimmed = d.trimStart();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try { resolved = true; resolve(JSON.parse(trimmed)); return; } catch {}
        }
        const norm = d.replace(/\r\n/g,'\n');
        let pos = 0;
        while (true) {
          const evEnd = norm.indexOf('\n\n', pos);
          if (evEnd === -1) return;
          const block = norm.slice(pos, evEnd);
          const dataLines = block.split('\n').filter(l => /^data:/.test(l));
          pos = evEnd + 2;
          if (!dataLines.length) continue;
          const json = dataLines.map(l => l.replace(/^data:\s*/,'')).join('');
          if (json) { try { resolved = true; resolve(JSON.parse(json)); res.destroy(); return; } catch {} }
        }
      }
      res.on('data', c => { d += c; tryResolve(); });
      res.on('end', () => { if (!resolved) { resolved = true; resolve(null); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function mcpQuery(token, sql) {
  const result = await jsonPost(`${MCP_BASE}/mcp`, JSON.stringify({
    jsonrpc:'2.0', id:1, method:'tools/call',
    params:{ name:'query_database', arguments:{ query:sql } },
  }), {
    'Content-Type':'application/json',
    'Accept':'application/json, text/event-stream',
    'Authorization':`Bearer ${token}`,
  });
  if (!result) throw new Error('MCP returned no data');
  if (result.error) throw new Error(JSON.stringify(result.error));
  const text = result?.result?.content?.[0]?.text;
  if (!text) throw new Error('Empty MCP response');
  return JSON.parse(text);
}

// ── helpers ───────────────────────────────────────────────────────────────────
function nowPdt() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
}
function ts() {
  return nowPdt().toTimeString().slice(0,8);
}
function fmtTime(dt) {
  const d = nowPdt();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function pdtToUtc(pdtStr) {
  // PDT = UTC-7; converts '2026-07-24 14:10:00' → '2026-07-24 21:10:00'
  return new Date(pdtStr.replace(' ', 'T') + '-07:00').toISOString().slice(0, 19).replace('T', ' ');
}
function num(v) { return Math.round(Number(v) || 0); }

// ── queries ───────────────────────────────────────────────────────────────────
async function captureSnapshot(token) {
  const pdt     = nowPdt();
  const dateStr = pdt.toLocaleDateString('en-CA'); // YYYY-MM-DD
  // MAWM stores timestamps in UTC. 2:15 PM PDT = 21:15 UTC.
  const shiftStart = pdtToUtc(`${dateStr} 14:15:00`);  // 2:15 PM PDT → UTC
  const lookback60 = `${dateStr} 07:00:00`; // UTC midnight PDT = 07:00 UTC

  // Q1: DCO_ORDER — open orders + orders not released in one pass
  const sqlOrders = `
SELECT
  COUNT(DISTINCT ORDER_ID)                                          AS open_orders,
  SUM(CASE WHEN MAXIMUM_STATUS = '1000' THEN 1 ELSE 0 END)         AS not_released
FROM default_dcorder.DCO_ORDER
WHERE FACILITY_ID = '${FACILITY}'
  AND ORDER_TYPE  = 'ECOM'
  AND MAXIMUM_STATUS NOT IN ('8000','9000')`.trim();

  // Q2: DCO_ORDER_LINE — open units (today only to keep scan tight)
  const sqlUnits = `
SELECT SUM(QUANTITY) AS open_units
FROM default_dcorder.DCO_ORDER_LINE
WHERE FACILITY_ID = '${FACILITY}'
  AND ORDER_TYPE  = 'ECOM'
  AND CANCELLED   = 0
  AND STATUS     != 'SHIPPED'
  AND CREATED_TIMESTAMP >= '${lookback60}'`.trim();

  // Q3: PPK_OLPN — hospital orders + packed not shipped + loaded, all in one pass
  const sqlOlpn = `
SELECT
  SUM(CASE WHEN CURRENT_LOCATION_ID LIKE 'H1-PW-01%'
            AND STATUS NOT IN ('8000','9000')           THEN 1 ELSE 0 END) AS hospital_olpns,
  COUNT(DISTINCT CASE WHEN CURRENT_LOCATION_ID LIKE 'H1-PW-01%'
            AND STATUS NOT IN ('8000','9000')           THEN ORDER_ID END) AS hospital_orders,
  SUM(CASE WHEN STATUS = '7200'                         THEN 1 ELSE 0 END) AS packed_not_shipped,
  SUM(CASE WHEN STATUS = '7200'                         THEN TOTAL_LPN_QTY ELSE 0 END) AS packed_units,
  SUM(CASE WHEN STATUS IN ('7800','8000')
            AND CREATED_TIMESTAMP >= '${shiftStart}'   THEN 1 ELSE 0 END) AS loaded_virtually
FROM default_pickpack.PPK_OLPN
WHERE FACILITY_ID = '${FACILITY}'
  AND ORDER_TYPE  = 'ECOM'`.trim();

  // Q4: TSK_TASK — pick + replen + putaway open/done in one GROUP BY
  const sqlTasks = `
SELECT
  TYPE_ID,
  STATUS,
  COUNT(*) AS cnt
FROM default_task.TSK_TASK
WHERE FACILITY_ID = '${FACILITY}'
  AND TYPE_ID IN ('PICK/PACK','REPLENISHMENT','PUTAWAY')
  AND CREATED_DATE_TIME >= '${shiftStart}'
GROUP BY TYPE_ID, STATUS`.trim();

  // Q5: DCO_ORDER_PLAN_RUN_STRATEGY — wave type counts only
  const sqlWaves = `
SELECT
  PLANNING_STRATEGY_ID,
  CHASE_MODE,
  COUNT(*) AS wave_runs
FROM default_dcorder.DCO_ORDER_PLAN_RUN_STRATEGY
WHERE FACILITY_ID = '${FACILITY}'
  AND CREATED_TIMESTAMP >= '${shiftStart}'
GROUP BY PLANNING_STRATEGY_ID, CHASE_MODE
ORDER BY wave_runs DESC`.trim();

  // Q6: WR_BATCH — actual work-release batches (up to 120 orders each, one per putwall)
  const sqlBatches = `
SELECT
  STATUS_ID,
  COUNT(*) AS cnt
FROM default_workrelease.WR_BATCH
WHERE FACILITY_ID = '${FACILITY}'
  AND CREATED_TIMESTAMP >= '${shiftStart}'
GROUP BY STATUS_ID`.trim();

  // Q7: avg batch release interval — LAG over WR_BATCH.CREATED_TIMESTAMP
  const sqlInterval = `
SELECT ROUND(AVG(diff_min), 1) AS avg_interval_min
FROM (
  SELECT TIMESTAMPDIFF(MINUTE,
    LAG(CREATED_TIMESTAMP) OVER (ORDER BY CREATED_TIMESTAMP),
    CREATED_TIMESTAMP) AS diff_min
  FROM default_workrelease.WR_BATCH
  WHERE FACILITY_ID = '${FACILITY}'
    AND CREATED_TIMESTAMP >= '${shiftStart}'
) t
WHERE diff_min IS NOT NULL`.trim();

  console.log(`[${ts()}] Running 7 queries in parallel...`);
  const [rOrders, rUnits, rOlpn, rTasks, rWaves, rBatches, rInterval] = await Promise.all([
    mcpQuery(token, sqlOrders),
    mcpQuery(token, sqlUnits),
    mcpQuery(token, sqlOlpn),
    mcpQuery(token, sqlTasks),
    mcpQuery(token, sqlWaves),
    mcpQuery(token, sqlBatches),
    mcpQuery(token, sqlInterval),
  ]);

  // Task rollup — one loop covers all three TYPE_IDs
  const tasks = { 'PICK/PACK': {open:0,done:0}, 'REPLENISHMENT': {open:0,done:0}, 'PUTAWAY': {open:0,done:0} };
  for (const r of (rTasks.rows || [])) {
    const t = tasks[r.TYPE_ID];
    if (!t) continue;
    const s = String(r.STATUS);
    const c = num(r.cnt);
    if (['3000','5000','7000'].includes(s)) t.open += c;
    else if (s === '8000') t.done += c;
  }

  // Wave type mapping — waves only, no batch logic here
  function waveLabel(sid, chase) {
    const s = (sid || '').toUpperCase();
    if (s.includes('REPLEN'))                                                         return 'Replen';
    if (s.includes('FILL_KILL') || s.includes('FILLKILL'))                           return 'Fill/Kill';
    if (s.includes('RTV') || s.includes('RTI'))                                      return 'RTV/RTI';
    if (s.includes('MULTI_CHASE') || (s.includes('MULTI') && s.includes('CHASE')))  return 'Multi Chase';
    if (s.includes('SINGLE_CHASE') || (s.includes('SINGLE') && s.includes('CHASE'))) return 'Single Chase';
    if (s.includes('CHASE')) return chase === 'CHASE_ONLY' ? 'Single Chase' : 'Multi Chase';
    if (s.includes('MULTI'))                                                          return 'Multi';
    return 'Ecom';
  }

  const waveCounts = {};
  for (const r of (rWaves.rows || [])) {
    const label = waveLabel(r.PLANNING_STRATEGY_ID, r.CHASE_MODE);
    waveCounts[label] = (waveCounts[label] || 0) + num(r.wave_runs);
  }

  // Batch rollup from WR_BATCH — 5800 = cleared, 5600 = still active (in queue)
  let batches_total = 0, batches_cleared = 0;
  for (const r of (rBatches.rows || [])) {
    const c = num(r.cnt);
    batches_total += c;
    if (String(r.STATUS_ID).startsWith('5800')) batches_cleared += c;
  }

  const waveOrder = ['Ecom','Replen','Single Chase','Multi Chase','Fill/Kill','Multi','RTV/RTI'];
  const waves = waveOrder.map(t => ({ type: t, count: waveCounts[t] || 0 }));
  waves.push({ type: 'Total', count: Object.values(waveCounts).reduce((a,b) => a+b, 0) });

  const ordRow  = rOrders.rows?.[0] || {};
  const olpnRow = rOlpn.rows?.[0]   || {};

  return {
    captured_at:          fmtTime(),
    date:                 dateStr,
    open_orders:          num(ordRow.open_orders),
    open_units:           num(rUnits.rows?.[0]?.open_units),
    hospital_orders:      num(olpnRow.hospital_orders),
    hospital_olpns:       num(olpnRow.hospital_olpns),
    pick_open:            tasks['PICK/PACK'].open,
    pick_done:            tasks['PICK/PACK'].done,
    replen_open:          tasks['REPLENISHMENT'].open,
    replen_done:          tasks['REPLENISHMENT'].done,
    putaway_open:         tasks['PUTAWAY'].open,
    putaway_done:         tasks['PUTAWAY'].done,
    batches_in_queue:     batches_total - batches_cleared,
    batches_cleared:      batches_cleared,
    avg_release_interval: rInterval.rows?.[0]?.avg_interval_min != null
                            ? Number(rInterval.rows[0].avg_interval_min)
                            : null,
    orders_not_released:  num(ordRow.not_released),
    packed_not_shipped:   num(olpnRow.packed_not_shipped),
    packed_units:         num(olpnRow.packed_units),
    loaded_virtually:     num(olpnRow.loaded_virtually),
    waves,
  };
}

// ── SOS reconstruction (point-in-time as of shift start) ─────────────────────
// Uses timestamp logic instead of current state — works any time after shift start.
// Fields that cannot be reconstructed (order/unit status, hospital location) are
// marked null so the HTML shows "cannot reconstruct" rather than wrong data.
async function captureReconstructedSOS(token, sosTime) {
  // sosTime: 'YYYY-MM-DD HH:MM:SS' in PDT — default to 2:10 PM shift start
  const dateStr  = sosTime.slice(0, 10);
  const shiftStart = pdtToUtc(`${dateStr} 14:15:00`); // 2:15 PM PDT → UTC
  const sosTimeUtc = pdtToUtc(sosTime);               // anchor time → UTC

  console.log(`[${ts()}] Reconstructing SOS as of: ${sosTime} (UTC: ${sosTimeUtc})`);

  // Q1: TSK_TASK — open at sosTime means:
  //   created before sosTime AND (no end time OR end time after sosTime)
  const sqlTasks = `
SELECT
  TYPE_ID,
  SUM(CASE WHEN ACTUAL_END_TIME IS NULL OR ACTUAL_END_TIME > '${sosTimeUtc}' THEN 1 ELSE 0 END) AS open_at_sos,
  SUM(CASE WHEN ACTUAL_END_TIME IS NOT NULL AND ACTUAL_END_TIME <= '${sosTimeUtc}' THEN 1 ELSE 0 END) AS done_at_sos
FROM default_task.TSK_TASK
WHERE FACILITY_ID = '${FACILITY}'
  AND TYPE_ID IN ('PICK/PACK','REPLENISHMENT','PUTAWAY')
  AND CREATED_DATE_TIME >= '${shiftStart}'
  AND CREATED_DATE_TIME <  '${sosTimeUtc}'
GROUP BY TYPE_ID`.trim();

  // Q2: Waves run before sosTime — type counts only
  const sqlWaves = `
SELECT
  PLANNING_STRATEGY_ID,
  CHASE_MODE,
  COUNT(*) AS wave_runs
FROM default_dcorder.DCO_ORDER_PLAN_RUN_STRATEGY
WHERE FACILITY_ID = '${FACILITY}'
  AND CREATED_TIMESTAMP >= '${shiftStart}'
  AND CREATED_TIMESTAMP <  '${sosTimeUtc}'
GROUP BY PLANNING_STRATEGY_ID, CHASE_MODE
ORDER BY wave_runs DESC`.trim();

  // Q3: WR_BATCH — actual work-release batches at sosTime
  const sqlBatches = `
SELECT
  STATUS_ID,
  COUNT(*) AS cnt
FROM default_workrelease.WR_BATCH
WHERE FACILITY_ID = '${FACILITY}'
  AND CREATED_TIMESTAMP >= '${shiftStart}'
  AND CREATED_TIMESTAMP <  '${sosTimeUtc}'
GROUP BY STATUS_ID`.trim();

  // Q4: Orders not released at sosTime
  const sqlNotReleased = `
SELECT COUNT(DISTINCT ORDER_ID) AS not_released
FROM default_dcorder.DCO_ORDER
WHERE FACILITY_ID = '${FACILITY}'
  AND ORDER_TYPE = 'ECOM'
  AND MAXIMUM_STATUS = '1000'
  AND CREATED_TIMESTAMP < '${sosTimeUtc}'`.trim();

  // Q5: Avg batch release interval up to sosTime — LAG on WR_BATCH
  const sqlInterval = `
SELECT ROUND(AVG(diff_min), 1) AS avg_interval_min
FROM (
  SELECT TIMESTAMPDIFF(MINUTE,
    LAG(CREATED_TIMESTAMP) OVER (ORDER BY CREATED_TIMESTAMP),
    CREATED_TIMESTAMP) AS diff_min
  FROM default_workrelease.WR_BATCH
  WHERE FACILITY_ID = '${FACILITY}'
    AND CREATED_TIMESTAMP >= '${shiftStart}'
    AND CREATED_TIMESTAMP <  '${sosTimeUtc}'
) t
WHERE diff_min IS NOT NULL`.trim();

  console.log(`[${ts()}] Running 5 reconstruction queries...`);
  const [rTasks, rWaves, rBatches, rNotRel, rInterval] = await Promise.all([
    mcpQuery(token, sqlTasks),
    mcpQuery(token, sqlWaves),
    mcpQuery(token, sqlBatches),
    mcpQuery(token, sqlNotReleased),
    mcpQuery(token, sqlInterval),
  ]);

  // Task rollup
  const tasks = { 'PICK/PACK':{open:0,done:0}, 'REPLENISHMENT':{open:0,done:0}, 'PUTAWAY':{open:0,done:0} };
  for (const r of (rTasks.rows||[])) {
    const t = tasks[r.TYPE_ID];
    if (!t) continue;
    t.open += num(r.open_at_sos);
    t.done += num(r.done_at_sos);
  }

  // Wave label mapping (same as captureSnapshot)
  function waveLabel(sid, chase) {
    const s = (sid||'').toUpperCase();
    if (s.includes('REPLEN'))                                                         return 'Replen';
    if (s.includes('FILL_KILL') || s.includes('FILLKILL'))                           return 'Fill/Kill';
    if (s.includes('RTV') || s.includes('RTI'))                                      return 'RTV/RTI';
    if (s.includes('MULTI_CHASE') || (s.includes('MULTI') && s.includes('CHASE')))  return 'Multi Chase';
    if (s.includes('SINGLE_CHASE') || (s.includes('SINGLE') && s.includes('CHASE'))) return 'Single Chase';
    if (s.includes('CHASE')) return chase === 'CHASE_ONLY' ? 'Single Chase' : 'Multi Chase';
    if (s.includes('MULTI'))                                                          return 'Multi';
    return 'Ecom';
  }

  const waveCounts = {};
  for (const r of (rWaves.rows||[])) {
    const label = waveLabel(r.PLANNING_STRATEGY_ID, r.CHASE_MODE);
    waveCounts[label] = (waveCounts[label]||0) + num(r.wave_runs);
  }
  const waveOrder = ['Ecom','Replen','Single Chase','Multi Chase','Fill/Kill','Multi','RTV/RTI'];
  const waves = waveOrder.map(t => ({ type:t, count: waveCounts[t]||0 }));
  waves.push({ type:'Total', count: Object.values(waveCounts).reduce((a,b)=>a+b,0) });

  let batches_total = 0, batches_cleared = 0;
  for (const r of (rBatches.rows||[])) {
    const c = num(r.cnt);
    batches_total += c;
    if (String(r.STATUS_ID).startsWith('5800')) batches_cleared += c;
  }

  return {
    captured_at:          sosTime.slice(11,16),
    date:                 dateStr,
    reconstructed:        true,
    reconstructed_as_of:  sosTime,
    // These cannot be reconstructed from available history — show null
    open_orders:          null,
    open_units:           null,
    hospital_orders:      null,
    hospital_olpns:       null,
    packed_not_shipped:   null,
    packed_units:         null,
    loaded_virtually:     null,
    // These are reconstructed from timestamps
    pick_open:            tasks['PICK/PACK'].open,
    pick_done:            tasks['PICK/PACK'].done,
    replen_open:          tasks['REPLENISHMENT'].open,
    replen_done:          tasks['REPLENISHMENT'].done,
    putaway_open:         tasks['PUTAWAY'].open,
    putaway_done:         tasks['PUTAWAY'].done,
    batches_in_queue:     batches_total - batches_cleared,
    batches_cleared:      batches_cleared,
    avg_release_interval: rInterval.rows?.[0]?.avg_interval_min != null
                            ? Number(rInterval.rows[0].avg_interval_min)
                            : null,
    orders_not_released:  num(rNotRel.rows?.[0]?.not_released),
    waves,
  };
}

// ── git push ──────────────────────────────────────────────────────────────────
function gitPush(files, message) {
  try {
    execSync(`git add ${files.join(' ')}`,              { cwd: REPORT_DIR, stdio: 'pipe' });
    execSync(`git commit -m "${message}"`,              { cwd: REPORT_DIR, stdio: 'pipe' });
    execSync('git pull --rebase --autostash origin main', { cwd: REPORT_DIR, stdio: 'pipe' });
    execSync('git push origin main',                    { cwd: REPORT_DIR, stdio: 'pipe' });
    console.log(`[${ts()}] ✓ Pushed to git`);
  } catch (e) {
    const msg = e.stderr?.toString() || e.message;
    if (msg.includes('nothing to commit')) console.log(`[${ts()}]   Nothing to commit`);
    else console.warn(`[${ts()}]   Git push failed: ${msg.slice(0,200)}`);
  }
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const isSOS         = process.argv.includes('--sos');
  const isEOS         = process.argv.includes('--eos');
  const isAuth        = process.argv.includes('--auth');
  const isReconstruct = process.argv.includes('--sos-reconstruct');
  // Optional: --time="2026-07-24 14:10:00" overrides the default 2:10 PM anchor
  const timeArg = process.argv.find(a => a.startsWith('--time='))?.split('=').slice(1).join('=') || null;

  console.log('DC499 EOS Report Agent');
  console.log('----------------------');

  let token;
  if (isAuth) { await doAuthFlow(); return; }
  token = await getAccessToken();
  console.log('✓ Authenticated');

  if (isSOS) {
    console.log(`[${ts()}] Capturing SOS snapshot...`);
    const snap = await captureSnapshot(token);
    const out = { generated: new Date().toISOString().slice(0,19), mode: 'sos', ...snap };
    fs.writeFileSync(SOS_FILE, JSON.stringify(out, null, 2));
    console.log(`[${ts()}] ✓ eos_sos_snapshot.json written`);

    // If eos_report.json is from a prior date, remove it so EOS_live.html
    // falls back to today's SOS snapshot instead of showing stale EOS data.
    const filesToPush = ['eos_sos_snapshot.json'];
    if (fs.existsSync(REPORT_FILE)) {
      try {
        const prev = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
        if (prev.date && prev.date !== snap.date) {
          fs.unlinkSync(REPORT_FILE);
          filesToPush.push('eos_report.json');
          console.log(`[${ts()}]   Cleared stale eos_report.json (was ${prev.date})`);
        }
      } catch { /* ignore — file may already be untracked */ }
    }

    gitPush(filesToPush, `EOS SOS snapshot -- ${snap.date} ${snap.captured_at}`);
    return;
  }

  if (isReconstruct) {
    // Default anchor: today 2:10 PM PDT
    const pdt = nowPdt();
    const dateStr = pdt.toLocaleDateString('en-CA');
    const sosTime = timeArg || `${dateStr} 14:10:00`;
    console.log(`[${ts()}] Reconstructing SOS snapshot as of ${sosTime}...`);
    const snap = await captureReconstructedSOS(token, sosTime);
    const out = { generated: new Date().toISOString().slice(0,19), mode: 'sos-reconstructed', ...snap };
    fs.writeFileSync(SOS_FILE, JSON.stringify(out, null, 2));
    console.log(`[${ts()}] ✓ eos_sos_snapshot.json written (reconstructed)`);
    console.log(`[${ts()}]   Note: open_orders, open_units, hospital, packed fields are null (current-state only)`);
    // If eos_report.json exists, patch its SOS so the HTML doesn't load stale data
    const filesToPush = ['eos_sos_snapshot.json'];
    if (fs.existsSync(REPORT_FILE)) {
      try {
        const report = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
        report.sos = out;
        fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
        filesToPush.push('eos_report.json');
        console.log(`[${ts()}] ✓ eos_report.json SOS patched`);
      } catch (e) {
        console.warn(`[${ts()}]   Could not patch eos_report.json: ${e.message}`);
      }
    }
    gitPush(filesToPush, `EOS SOS reconstructed -- ${snap.date} ${snap.captured_at}`);
    return;
  }

  if (isEOS) {
    console.log(`[${ts()}] Capturing EOS snapshot...`);
    const eos = await captureSnapshot(token);

    // Load SOS snapshot if it exists
    let sos = null;
    if (fs.existsSync(SOS_FILE)) {
      try { sos = JSON.parse(fs.readFileSync(SOS_FILE, 'utf8')); } catch {}
    }

    const report = {
      generated:   new Date().toISOString().slice(0,19),
      shift:       '2nd',
      date:        eos.date,
      facility:    FACILITY,
      sos:         sos || null,
      eos:         { ...eos, mode: 'eos' },
      waves:       eos.waves,
    };
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
    console.log(`[${ts()}] ✓ eos_report.json written`);
    gitPush(['eos_report.json'], `EOS Report -- ${eos.date} ${eos.captured_at}`);
    return;
  }

  console.log('Usage:');
  console.log('  node eos_agent.js --sos                      Capture live SOS snapshot (run at 2:10 PM)');
  console.log('  node eos_agent.js --sos-reconstruct          Reconstruct SOS from history (missed start)');
  console.log('  node eos_agent.js --sos-reconstruct --time="2026-07-24 14:10:00"   Custom anchor time');
  console.log('  node eos_agent.js --eos                      Capture EOS + write final report');
  console.log('  node eos_agent.js --auth                     First-time authentication');
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
