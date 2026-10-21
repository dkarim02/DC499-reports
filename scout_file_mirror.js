// scout_file_mirror.js — OneDrive / file:// fallback
//
// Browsers block fetch() of local .json files when a page is opened straight
// from disk (file://). To keep the reporter working over OneDrive sync without
// GitHub Pages or the :3001 server, every data JSON an agent writes in this
// folder is also written as filedata/<name>.js, which pages can load with a
// <script> tag. scout_file_mode.js (browser side) does the loading.
//
// Usage: require('./scout_file_mirror') near the top of an agent. It wraps
// fs.writeFileSync, so no other agent code changes. Mirror failures are
// logged and swallowed — they never break the agent.

const fs   = require('fs');
const path = require('path');

const DIR        = __dirname;
const MIRROR_DIR = path.join(DIR, 'filedata');
const realWrite  = fs.writeFileSync;

// Share folder — a small copy of just the pages + data for the team to sync through
// OneDrive (this folder is too big to share: .git history, plus the token and code).
// Only used if the folder exists. syncSharePages() copies changed pages; mirror() also
// writes each data file into <share>/filedata.
const SHARE_DIR    = process.env.SCOUT_SHARE_DIR || path.join(path.dirname(DIR), 'SCOUT Live');
const SHARE_DATA   = path.join(SHARE_DIR, 'filedata');
const SHARE_ASSETS = ['favicon.svg', 'scout_file_mode.js', 'remi.mp4'];
// Share hand-off (2026-10-19): while SCOUT Live\.share_owner exists, another writer keeps the
// share up to date, so this PC stops writing pages and data into it (GitHub pushes and this
// folder's filedata/ carry on). Checked at most every 30 s.
// Fallback (2026-10-20): the other writer keeps SCOUT Live\.share_heartbeat fresh (JSON {at}) while
// its data is current. If the heartbeat that reaches THIS PC is older than FALLBACK_MS — writer
// stopped, asleep, or its OneDrive stuck (10/20: 80 min unnoticed) — this PC writes the share
// again on its own, and steps back as soon as fresh heartbeats arrive. Transitions are logged.
const OWNER_MARKER = path.join(SHARE_DIR, '.share_owner');
const HEARTBEAT    = path.join(SHARE_DIR, '.share_heartbeat');
const FALLBACK_MS  = 10 * 60 * 1000;
let _ownerAt = 0, _ownerVal = false, _fallback = false;
function heartbeatAgeMs() {
  try { return Date.now() - Date.parse(JSON.parse(fs.readFileSync(HEARTBEAT, 'utf8')).at); }
  catch { return Infinity; }
}
function shareHandedOff() {
  if (Date.now() - _ownerAt > 30000) {
    _ownerAt = Date.now();
    const marker = fs.existsSync(OWNER_MARKER);
    const age = marker ? heartbeatAgeMs() : 0;
    const fallback = marker && !(age <= FALLBACK_MS);
    if (fallback !== _fallback) {
      const line = fallback
        ? `Share: other writer quiet for ${isFinite(age) ? Math.round(age / 60000) + ' min' : 'a while (no heartbeat)'} — this PC is keeping SCOUT Live updated`
        : 'Share: other writer is back — this PC stepped back from SCOUT Live';
      console.log(`  ${line}`);
      try { fs.appendFileSync(path.join(require('os').homedir(), 'SCOUT-local', 'share_fallback.log'), `${new Date().toISOString()}  ${line}\n`); } catch {}
      _fallback = fallback;
    }
    _ownerVal = marker && !fallback;
  }
  return _ownerVal;
}
const shareOn = () => { try { return fs.statSync(SHARE_DIR).isDirectory() && !shareHandedOff(); } catch { return false; } };

function writeAtomic(out, text) {
  const tmp = out + '.tmp';
  realWrite(tmp, text);
  try { fs.renameSync(tmp, out); }
  catch { realWrite(out, text); try { fs.unlinkSync(tmp); } catch {} }  // OneDrive can hold the file open
}

// Copy pages/assets that are new or changed (size or modified time). Cheap — a few
// dozen stats — so the live cycle can call it every time.
// OneDrive "kept both" copies ("<name>-<COMPUTER>.js", "-<COMPUTER>-2.js") left when two machines
// wrote the same share file close together (10/20). Pages never load them. Real data files are
// lowercase_with_underscores, so this pattern can't match one. Runs every live cycle.
const CONFLICT_COPY = /-[A-Z]-[A-Z0-9]{5,}(-\d+)?\.js$/;
function cleanShareConflicts() {
  try { for (const f of fs.readdirSync(SHARE_DATA)) if (CONFLICT_COPY.test(f)) { try { fs.unlinkSync(path.join(SHARE_DATA, f)); } catch {} } } catch {}
}

function syncSharePages() {
  cleanShareConflicts();
  if (!shareOn()) return 0;
  let copied = 0;
  let names;
  try { names = fs.readdirSync(DIR).filter(n => n.endsWith('.html')).concat(SHARE_ASSETS); }
  catch (e) { console.warn(`  Share sync skipped: ${e.message}`); return 0; }
  for (const name of names) {
    try {
      const src = path.join(DIR, name), dst = path.join(SHARE_DIR, name);
      const a = fs.statSync(src);
      let b = null; try { b = fs.statSync(dst); } catch {}
      if (b && b.size === a.size && b.mtimeMs >= a.mtimeMs) continue;
      fs.copyFileSync(src, dst);
      copied++;
    } catch (e) { console.warn(`  Share copy skipped for ${name}: ${e.message}`); }
  }
  // Pages renamed or retired here (e.g. a version bump) come out of the share too,
  // so nobody opens a stale copy. Only *.html — data, assets and README.txt are left alone.
  try {
    for (const name of fs.readdirSync(SHARE_DIR)) {
      if (!name.endsWith('.html') || names.includes(name)) continue;
      try { fs.unlinkSync(path.join(SHARE_DIR, name)); copied++; console.log(`  Share: removed retired page ${name}`); }
      catch (e) { console.warn(`  Share remove skipped for ${name}: ${e.message}`); }
    }
  } catch {}
  return copied;
}

function isDataJson(file) {
  if (typeof file !== 'string') return false;
  const abs  = path.resolve(file);
  const base = path.basename(abs);
  return path.dirname(abs) === DIR
    && base.endsWith('.json')
    && !base.startsWith('.')          // .mcp_token.json, .sent_batches.json
    && !base.endsWith('_export.json');
}

function mirror(file, data) {
  try {
    const name = path.basename(file);
    const text = typeof data === 'string' ? data : data.toString();
    const body = JSON.stringify(JSON.parse(text));   // compact — smaller sync
    // SCOUT_FILE_SRC = which machine wrote this copy and when — scout_file_mode.js shows it as a
    // colored pill on the page (2026-10-20), so it's clear which feed the team is looking at.
    const js   = 'window.SCOUT_FILE_DATA=window.SCOUT_FILE_DATA||{};'
               + 'window.SCOUT_FILE_DATA[' + JSON.stringify(name) + ']=' + body + ';'
               + 'window.SCOUT_FILE_SRC=window.SCOUT_FILE_SRC||{};'
               + 'window.SCOUT_FILE_SRC[' + JSON.stringify(name) + ']={by:"pc",at:' + JSON.stringify(new Date().toISOString()) + '};\n';
    const jsName = name.replace(/\.json$/, '.js');
    if (!fs.existsSync(MIRROR_DIR)) fs.mkdirSync(MIRROR_DIR);
    writeAtomic(path.join(MIRROR_DIR, jsName), js);
    if (shareOn()) {
      try {
        if (!fs.existsSync(SHARE_DATA)) fs.mkdirSync(SHARE_DATA);
        writeAtomic(path.join(SHARE_DATA, jsName), js);
      } catch (e) { console.warn(`  Share copy skipped for ${jsName}: ${e.message}`); }
    }
  } catch (e) {
    console.warn(`  File mirror skipped for ${path.basename(file)}: ${e.message}`);
  }
}

fs.writeFileSync = function (file, data, ...rest) {
  const r = realWrite.call(fs, file, data, ...rest);
  if (isDataJson(file)) mirror(file, data);
  return r;
};

module.exports = { mirror, MIRROR_DIR, SHARE_DIR, syncSharePages };
