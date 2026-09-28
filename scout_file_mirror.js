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
    if (!fs.existsSync(MIRROR_DIR)) fs.mkdirSync(MIRROR_DIR);
    const out = path.join(MIRROR_DIR, name.replace(/\.json$/, '.js'));
    const tmp = out + '.tmp';
    realWrite(tmp, js);
    try { fs.renameSync(tmp, out); }
    catch { realWrite(out, js); try { fs.unlinkSync(tmp); } catch {} }  // OneDrive can hold the file open
  } catch (e) {
    console.warn(`  File mirror skipped for ${path.basename(file)}: ${e.message}`);
  }
}

fs.writeFileSync = function (file, data, ...rest) {
  const r = realWrite.call(fs, file, data, ...rest);
  if (isDataJson(file)) mirror(file, data);
  return r;
};

module.exports = { mirror, MIRROR_DIR };
