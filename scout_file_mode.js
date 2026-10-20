// scout_file_mode.js — lets every report run straight from the OneDrive folder
//
// When a page is opened as a file (file://), browsers block fetch() of local
// .json files, and localhost:3001 / GitHub Pages may not be reachable. This
// shim catches GET requests for data JSON (relative, localhost:3001, or the
// GitHub Pages URL) and serves them from filedata/<name>.js instead — those
// sidecar files are written by the agents (scout_file_mirror.js) and sync
// through OneDrive like everything else.
//
// On GitHub Pages or localhost this file does nothing.
// Must be loaded before any page script that fetches data.
(function () {
  if (location.protocol !== 'file:' || !window.fetch) return;

  var realFetch = window.fetch.bind(window);
  var DATA = window.SCOUT_FILE_DATA = window.SCOUT_FILE_DATA || {};
  var DATA_URL = /^(?:https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/|https:\/\/dkarim02\.github\.io\/DC499-reports\/|\.?\/)?([\w\-]+\.json)(?:[?#].*)?$/;

  // ── Source pill (2026-10-20) ────────────────────────────────────────────────
  // Bottom-right: which machine wrote the newest data this page loaded, and how old it is.
  // Green = Laptop, blue = PC, red = newest data over 10 min old (whoever wrote it).
  // Data files carry SCOUT_FILE_SRC[name] = {by, at}; older files without it show nothing.
  var SRC = window.SCOUT_FILE_SRC = window.SCOUT_FILE_SRC || {};
  var STALE_MS = 10 * 60 * 1000;
  var pill = null, newest = null;
  function drawPill() {
    if (!newest) return;
    if (!pill) {
      pill = document.createElement('div');
      pill.style.cssText = 'position:fixed;bottom:6px;right:8px;z-index:99999;font:600 11px system-ui,sans-serif;' +
        'padding:3px 9px;border-radius:10px;color:#fff;opacity:.9;pointer-events:none;box-shadow:0 1px 3px rgba(0,0,0,.25)';
      document.documentElement.appendChild(pill);   // not <body>: its entrance animation pins fixed children
    }
    var age = Date.now() - Date.parse(newest.at);
    var mins = Math.max(0, Math.round(age / 60000));
    var who = newest.by === 'laptop' ? 'Laptop' : newest.by === 'pc' ? 'PC' : newest.by;
    var stale = !(age <= STALE_MS);
    pill.style.background = stale ? '#c0392b' : (newest.by === 'laptop' ? '#15803d' : '#1d4ed8');
    pill.textContent = '● ' + (stale ? 'Stale · ' + who + ' · ' + mins + ' min old' : who + ' · ' + (mins ? mins + ' min ago' : 'just now'));
    pill.title = 'Data written by the ' + who + ' at ' + new Date(newest.at).toLocaleTimeString();
  }
  function noteSource(name) {
    var s = SRC[name];
    if (!s || !s.at) return;
    if (!newest || Date.parse(s.at) > Date.parse(newest.at)) newest = s;
    drawPill();
  }
  setInterval(drawPill, 30000);

  function loadSidecar(name) {
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = 'filedata/' + name.replace(/\.json$/, '.js') + '?t=' + Date.now();
      s.onload  = function () { s.remove(); noteSource(name); resolve(DATA[name]); };
      s.onerror = function () { s.remove(); resolve(undefined); };
      (document.head || document.documentElement).appendChild(s);
    });
  }

  window.fetch = function (input, init) {
    var url    = typeof input === 'string' ? input : (input && input.url) || String(input);
    var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    var m      = method === 'GET' && DATA_URL.exec(url);
    if (!m) return realFetch(input, init);   // Teams webhooks, CDNs, etc. pass through
    var name = m[1];
    return loadSidecar(name).then(function (d) {
      if (d === undefined) return new Response('Not found: ' + name, { status: 404, statusText: 'Not Found' });
      return new Response(JSON.stringify(d), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
  };

  window.SCOUT_FILE_MODE = true;
})();
