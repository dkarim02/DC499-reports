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
// One writer per OneDrive folder (2026-10-20): this PC is the only writer of SCOUT Live. The
// 10/19–10/20 hand-off (a second machine writing this share, with a heartbeat fallback) was
// removed — two writers on one folder caused OneDrive conflict copies and blank pages.
const shareOn = () => { try { return fs.statSync(SHARE_DIR).isDirectory(); } catch { return false; } };

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

// Menu "Retail Board" chip (2026-10-20) opens Retail board/dc499-board.html. Here that file is a
// tiny redirect to the retail board's own live page in its shared OneDrive folder (a sibling
// folder ending in "DC499_Retail_Dashboard") — nothing big is copied or uploaded from this PC.
function retailBoardLink() {
  try {
    const parent = path.dirname(SHARE_DIR);
    const name = fs.readdirSync(parent).find(n => /DC499_Retail_Dashboard$/.test(n));
    if (!name) return 0;
    const parts = [name, 'DC499_Retail-main', 'live', 'dc499-board.html'];
    if (!fs.existsSync(path.join(parent, ...parts))) return 0;
    const href = '../../' + parts.map(encodeURIComponent).join('/');
    const html = `<!DOCTYPE html><meta charset="utf-8"><title>Retail Board</title>`
               + `<meta http-equiv="refresh" content="0;url=${href}"><a href="${href}">Open the Retail Board</a>\n`;
    const dir = path.join(SHARE_DIR, 'Retail board'), out = path.join(dir, 'dc499-board.html');
    try { if (fs.readFileSync(out, 'utf8') === html) return 0; } catch {}
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    writeAtomic(out, html);
    return 1;
  } catch (e) { console.warn(`  Retail Board link skipped: ${e.message}`); return 0; }
}

function syncSharePages() {
  cleanShareConflicts();
  if (!shareOn()) return 0;
  let copied = retailBoardLink();
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
    // This folder's own filedata/ (for opening the reporter pages straight from disk) is off by
    // default since 2026-10-20: the team opens SCOUT Live instead, and these ~13 files / ~6 MB per
    // cycle kept this PC's OneDrive from ever finishing a sync. SCOUT_LOCAL_FILEDATA=1 turns it on.
    if (process.env.SCOUT_LOCAL_FILEDATA === '1') {
      if (!fs.existsSync(MIRROR_DIR)) fs.mkdirSync(MIRROR_DIR);
      writeAtomic(path.join(MIRROR_DIR, jsName), js);
    }
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
