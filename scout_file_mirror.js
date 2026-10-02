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
const shareOn = () => { try { return fs.statSync(SHARE_DIR).isDirectory(); } catch { return false; } };

function writeAtomic(out, text) {
  const tmp = out + '.tmp';
  realWrite(tmp, text);
  try { fs.renameSync(tmp, out); }
  catch { realWrite(out, text); try { fs.unlinkSync(tmp); } catch {} }  // OneDrive can hold the file open
}

// Copy pages/assets that are new or changed (size or modified time). Cheap — a few
// dozen stats — so the live cycle can call it every time.
function syncSharePages() {
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
    const js   = 'window.SCOUT_FILE_DATA=window.SCOUT_FILE_DATA||{};'
               + 'window.SCOUT_FILE_DATA[' + JSON.stringify(name) + ']=' + body + ';\n';
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
