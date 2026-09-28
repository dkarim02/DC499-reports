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

  function loadSidecar(name) {
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = 'filedata/' + name.replace(/\.json$/, '.js') + '?t=' + Date.now();
      s.onload  = function () { s.remove(); resolve(DATA[name]); };
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
