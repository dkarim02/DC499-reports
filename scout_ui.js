/* scout_ui.js — shared top bar + one theme for every SCOUT page.
 *
 * A page calls, after its markup:
 *   SCOUT_UI.bar({
 *     mount:   'scout-bar',            // id of an empty <div> where the bar goes
 *     dept:    'Shipping',             // small line above the title
 *     title:   'Shipping Live',
 *     version: 'v1.3',
 *     sub:     'run-info',             // optional: id of the page's status line, moved under the title
 *     actions: ['refresh-btn'],        // optional: ids of the page's own buttons, moved to the right side
 *     settings: openSettings,          // optional: ⚙ button
 *     applyTheme: function (t) { ... } // the page's own way of switching colors
 *     menu:    '../Menu_v2.0.html'     // optional: menu link for a page in a subfolder
 *   });
 *   SCOUT_UI.updated(new Date(data.generated));   // after each data load
 *
 * Theme: one key for the whole site (the menu's). A page's old key is read once, the first time.
 * A theme picked in one tab switches every other open SCOUT tab too.
 */
(function () {
  'use strict';

  var THEME_KEY = 'dc499_theme_v1';
  var MENU_PAGE = 'Menu_v2.0.html';          // update here on a menu version bump
  var THEMES = [
    ['dark', 'Dark'], ['solid', 'Solid'], ['pastel', 'Pastel'], ['starr', 'Starr ⭐'],
    ['carrie', 'Carrie ☁'], ['remi', 'Rem 🧙'], ['scout', '✦ Scout'], ['light', 'Light']
  ];
  var LIGHT_THEMES = { light: 1, carrie: 1, starr: 1 };
  var FRESH_MIN = 10, OLD_MIN = 30;          // freshness dot: green / amber / red

  var opts = null, barEl = null, lastUpdated = null;

  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  function valid(t) { return THEMES.some(function (x) { return x[0] === t; }); }
  function label(t) { for (var i = 0; i < THEMES.length; i++) if (THEMES[i][0] === t) return THEMES[i][1]; return t; }

  function getTheme(oldKey) {
    var t = store(THEME_KEY);
    if (!valid(t) && oldKey) {
      t = store(oldKey);
      t = { mixed: 'pastel', candy: 'starr' }[t] || t;     // old names on some pages
      if (valid(t)) store(THEME_KEY, t);
    }
    return valid(t) ? t : 'dark';
  }

  // light or dark from the page's real background (themes differ a little page to page)
  function pageIsLight() {
    var els = [document.body, document.documentElement];
    for (var i = 0; i < els.length; i++) {
      var m = (getComputedStyle(els[i]).backgroundColor || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
      if (m && (m[4] === undefined || Number(m[4]) > 0.1)) return (0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3]) > 150;
    }
    return null;
  }

  function applyTheme(t, save) {
    if (!valid(t)) t = 'dark';
    if (save) store(THEME_KEY, t);
    if (opts && opts.applyTheme) { try { opts.applyTheme(t); } catch (e) { console.warn('[scout_ui] applyTheme', e); } }
    if (barEl) {
      var light = pageIsLight();
      barEl.classList.toggle('sui-light', light == null ? !!LIGHT_THEMES[t] : light);
      var lbl = barEl.querySelector('.sui-theme-label');
      if (lbl) lbl.textContent = label(t);
      var items = barEl.querySelectorAll('.sui-theme-opt');
      for (var i = 0; i < items.length; i++) items[i].classList.toggle('active', items[i].getAttribute('data-t') === t);
    }
  }

  // ── clock + shift (Pacific time, whatever the PC's clock zone is) ──
  function pacificParts(d) {
    var p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', hour12: true })
      .formatToParts(d), o = {};
    p.forEach(function (x) { o[x.type] = x.value; });
    var h24 = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' }).format(d));
    return { text: o.hour + ':' + o.minute + ' ' + o.dayPeriod, h24: h24 };
  }
  function tickClock() {
    if (!barEl) return;
    var p = pacificParts(new Date());
    barEl.querySelector('.sui-clock').textContent = p.text;
    barEl.querySelector('.sui-shift').textContent = (p.h24 >= 14 && p.h24 < 22) ? '2nd shift' : '1st shift';
    renderUpdated();
  }

  // ── data freshness (no animation — just a colored dot) ──
  function renderUpdated() {
    if (!barEl) return;
    var el = barEl.querySelector('.sui-fresh');
    if (!lastUpdated || isNaN(lastUpdated)) { el.style.display = 'none'; return; }
    var mins = (Date.now() - lastUpdated.getTime()) / 60000;
    var cls = mins <= FRESH_MIN ? 'ok' : mins <= OLD_MIN ? 'warn' : 'old';
    el.style.display = '';
    el.className = 'sui-chip sui-fresh sui-' + cls;
    el.querySelector('.sui-fresh-text').textContent = 'Updated ' + pacificParts(lastUpdated).text +
      (mins > FRESH_MIN ? ' · ' + Math.round(mins) + ' min ago' : '');
    el.title = cls === 'ok' ? 'Data is up to date' : 'Data is ' + Math.round(mins) + ' minutes old';
  }

  // ── styles (own neutral colors, so the bar looks the same on every page) ──
  var CSS = [
    '.sui-bar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:0 0 1.1rem;padding:10px 14px;',
    ' border-radius:12px;background:rgba(255,255,255,0.035);border:1px solid rgba(255,255,255,0.08);',
    ' font-family:inherit;color:inherit;box-sizing:border-box;position:relative;z-index:50;}',
    '.sui-bar.sui-light{background:rgba(255,255,255,0.7);border-color:rgba(0,0,0,0.09);}',
    '.sui-bar *{box-sizing:border-box;}',
    '.sui-menu{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:8px;',
    ' font-size:12px;font-weight:600;letter-spacing:0.02em;text-decoration:none;color:inherit;opacity:0.8;',
    ' border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.04);white-space:nowrap;}',
    '.sui-light .sui-menu{border-color:rgba(0,0,0,0.12);background:rgba(0,0,0,0.03);}',
    '.sui-menu:hover{opacity:1;background:rgba(255,255,255,0.09);}',
    '.sui-light .sui-menu:hover{background:rgba(0,0,0,0.07);}',
    '.sui-divider{width:1px;align-self:stretch;background:rgba(255,255,255,0.1);}',
    '.sui-light .sui-divider{background:rgba(0,0,0,0.1);}',
    '.sui-id{display:flex;flex-direction:column;gap:1px;flex:1 1 0;min-width:min-content;}',   // never narrower than the title
    '.sui-title{white-space:nowrap;}',
    '.sui-dept{font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;opacity:0.55;}',
    '.sui-title{display:flex;align-items:baseline;gap:8px;font-size:18px;font-weight:700;line-height:1.2;}',
    '.sui-ver{font-size:10px;font-weight:700;letter-spacing:0.04em;padding:2px 7px;border-radius:20px;',
    ' background:rgba(14,158,142,0.16);color:#3cc7b5;}',
    '.sui-light .sui-ver{background:rgba(14,158,142,0.12);color:#0a7a6d;}',
    '.sui-sub{font-size:12px;opacity:0.7;margin-top:1px;}',
    '.sui-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-left:auto;}',
    '.sui-chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:20px;',
    ' font-size:11px;font-weight:600;white-space:nowrap;font-variant-numeric:tabular-nums;',
    ' background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.09);}',
    '.sui-light .sui-chip{background:rgba(0,0,0,0.03);border-color:rgba(0,0,0,0.09);}',
    '.sui-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;}',
    '.sui-ok .sui-dot{background:#22c55e;} .sui-warn .sui-dot{background:#eab308;} .sui-old .sui-dot{background:#ef4444;}',
    '.sui-old{color:#f87171;} .sui-light.sui-bar .sui-old{color:#b91c1c;}',
    '.sui-time .sui-shift{opacity:0.6;}',
    '.sui-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:32px;min-width:32px;padding:0 10px;',
    ' border-radius:8px;font:inherit;font-size:12px;font-weight:600;color:inherit;cursor:pointer;',
    ' background:none;border:1px solid rgba(255,255,255,0.12);}',
    '.sui-light .sui-btn{border-color:rgba(0,0,0,0.12);}',
    '.sui-btn:hover{background:rgba(255,255,255,0.08);} .sui-light .sui-btn:hover{background:rgba(0,0,0,0.06);}',
    '.sui-theme{position:relative;}',
    '.sui-theme-menu{display:none;position:absolute;right:0;top:calc(100% + 6px);min-width:140px;padding:4px;',
    ' border-radius:10px;background:#1d1f27;border:1px solid rgba(255,255,255,0.12);box-shadow:0 8px 24px rgba(0,0,0,0.35);}',
    '.sui-light .sui-theme-menu{background:#fff;border-color:rgba(0,0,0,0.12);box-shadow:0 8px 24px rgba(0,0,0,0.12);}',
    '.sui-theme.open .sui-theme-menu{display:block;}',
    '.sui-theme-opt{padding:7px 10px;border-radius:7px;font-size:12px;cursor:pointer;white-space:nowrap;color:#e6e6e4;}',
    '.sui-light .sui-theme-opt{color:#1a1a1a;}',
    '.sui-theme-opt:hover{background:rgba(255,255,255,0.08);} .sui-light .sui-theme-opt:hover{background:rgba(0,0,0,0.05);}',
    '.sui-theme-opt.active{font-weight:700;color:#3cc7b5;} .sui-light .sui-theme-opt.active{color:#0a7a6d;}',
    '@media print{.sui-bar .sui-right,.sui-menu,.sui-divider{display:none !important;}}'
  ].join('\n');

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function bar(o) {
    opts = o || {};
    var mount = document.getElementById(opts.mount || 'scout-bar');
    if (!mount) { console.warn('[scout_ui] no mount element'); return; }
    if (!document.getElementById('sui-css')) { var s = el('style'); s.id = 'sui-css'; s.textContent = CSS; document.head.appendChild(s); }

    barEl = el('header', 'sui-bar');
    var menu = el('a', 'sui-menu', '← Menu'); menu.href = opts.menu || MENU_PAGE; menu.title = 'Back to the SCOUT menu';
    barEl.appendChild(menu);
    barEl.appendChild(el('div', 'sui-divider'));

    var id = el('div', 'sui-id');
    id.appendChild(el('div', 'sui-dept', 'DC499 · ' + (opts.dept || '')));
    var title = el('div', 'sui-title'); title.appendChild(el('span', null, opts.title || document.title));
    if (opts.version) title.appendChild(el('span', 'sui-ver', opts.version));
    id.appendChild(title);
    var sub = opts.sub && document.getElementById(opts.sub);
    if (sub) { sub.classList.add('sui-sub'); id.appendChild(sub); }
    barEl.appendChild(id);

    var right = el('div', 'sui-right');
    (opts.actions || []).forEach(function (aid) { var a = document.getElementById(aid); if (a) right.appendChild(a); });
    var fresh = el('span', 'sui-chip sui-fresh'); fresh.style.display = 'none';
    fresh.appendChild(el('span', 'sui-dot')); fresh.appendChild(el('span', 'sui-fresh-text'));
    right.appendChild(fresh);
    var time = el('span', 'sui-chip sui-time'); time.appendChild(el('span', 'sui-clock')); time.appendChild(el('span', 'sui-shift'));
    right.appendChild(time);

    var fb = el('button', 'sui-btn', '🔍'); fb.type = 'button'; fb.title = 'Find an order, LPN, tote, task or page (Ctrl+K)';
    fb.onclick = function () { openPalette(); }; right.appendChild(fb);

    var th = el('div', 'sui-theme');
    var tb = el('button', 'sui-btn'); tb.type = 'button'; tb.title = 'Colors (same on every page)';
    tb.appendChild(el('span', 'sui-theme-label')); tb.appendChild(el('span', null, '▾'));
    tb.onclick = function (e) { e.stopPropagation(); th.classList.toggle('open'); };
    var tm = el('div', 'sui-theme-menu');
    THEMES.forEach(function (x) {
      var it = el('div', 'sui-theme-opt', x[1]); it.setAttribute('data-t', x[0]);
      it.onclick = function () { applyTheme(x[0], true); th.classList.remove('open'); };
      tm.appendChild(it);
    });
    th.appendChild(tb); th.appendChild(tm); right.appendChild(th);
    document.addEventListener('click', function (e) { if (!th.contains(e.target)) th.classList.remove('open'); });

    if (typeof opts.settings === 'function') {
      var gear = el('button', 'sui-btn', '⚙'); gear.type = 'button'; gear.title = 'Settings';
      gear.onclick = opts.settings; right.appendChild(gear);
    }
    barEl.appendChild(right);
    mount.parentNode.replaceChild(barEl, mount);

    applyTheme(getTheme(opts.oldThemeKey), true);
    tickClock(); setInterval(tickClock, 30000);
    initFind();
  }

  // ── count-up numbers ──
  // Big numbers roll to a new value (~0.5 s) instead of jumping. Two ways in:
  //   SCOUT_UI.countUp(['m-ready', ...])  — elements the page updates in place (textContent). A watcher
  //                                         catches the change before it is drawn.
  //   <div data-sui-count="ecom-replen">  — pages that rebuild their tiles (innerHTML): after each redraw
  //   SCOUT_UI.countKeys(rootEl)            call this; it rolls each tagged number from its last value.
  // A number may have words after it ("37 total flagged") — it rolls only if the words stay the same.
  // Instant (no roll) when: first value, not a number, 0 on either side, more than 2× / less than ½
  // (e.g. a units ↔ orders switch, a new shift), tab hidden, or Windows "reduce motion" is on.
  var COUNT_MS = 500;
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  function parseNum(t) {
    var m = String(t == null ? '' : t).match(/^\s*(-?[\d,]+(?:\.\d+)?)([\s\S]*)$/);
    if (!m || !/\d/.test(m[1])) return null;
    return { n: Number(m[1].replace(/,/g, '')), num: m[1], rest: m[2] };
  }
  function fmtLike(n, sample, commas) {
    var dec = (String(sample).split('.')[1] || '').length;
    var s = n.toFixed(dec);
    if (commas) { var parts = s.split('.'); parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ','); s = parts.join('.'); }
    return s;
  }
  function shouldRoll(a, b) {
    return a && b && a.rest === b.rest && a.n !== b.n && a.n !== 0 && b.n !== 0 &&
           b.n / a.n <= 2 && b.n / a.n >= 0.5 && !document.hidden && !(reduceMotion && reduceMotion.matches);
  }
  // roll node's text from fromText to toText; write(txt) does the actual write; st keeps timers
  function roll(st, fromText, toText, write) {
    if (st.raf) { cancelAnimationFrame(st.raf); st.raf = 0; }
    clearTimeout(st.safety);
    var a = parseNum(fromText), b = parseNum(toText);
    if (!shouldRoll(a, b)) { st.shown = toText; return false; }
    var commas = /,/.test(a.num + b.num), t0 = null;
    st.safety = setTimeout(function () {         // if the browser pauses frames, the real number still lands
      if (st.raf) { cancelAnimationFrame(st.raf); st.raf = 0; }
      st.shown = toText; write(toText);
    }, COUNT_MS + 150);
    function step(ts) {
      if (t0 == null) t0 = ts;
      var k = Math.min(1, (ts - t0) / COUNT_MS), e = 1 - Math.pow(1 - k, 3);   // ease-out
      if (k < 1) { st.shown = fmtLike(a.n + (b.n - a.n) * e, b.num, commas) + b.rest; write(st.shown); st.raf = requestAnimationFrame(step); }
      else { st.raf = 0; clearTimeout(st.safety); st.shown = toText; write(toText); }
    }
    st.shown = fromText; write(fromText);         // put the old number back before it is drawn
    st.raf = requestAnimationFrame(step);
    return true;
  }
  function watchCount(node) {
    if (!node || node._suiCount) return;
    var st = node._suiCount = { shown: node.textContent, raf: 0 };
    var obs = new MutationObserver(function () {
      var target = node.textContent;
      roll(st, st.shown, target, function (txt) { node.textContent = txt; obs.takeRecords(); });  // own writes ≠ new values
    });
    obs.observe(node, { childList: true, characterData: true, subtree: true });
  }
  function countUp(ids) {
    (ids || []).forEach(function (id) { watchCount(typeof id === 'string' ? document.getElementById(id) : id); });
  }
  var keyState = {};                               // data-sui-count name → {shown, raf, safety}
  function countKeys(root) {
    var els = (root || document).querySelectorAll('[data-sui-count]');
    for (var i = 0; i < els.length; i++) (function (el) {
      var key = el.getAttribute('data-sui-count'), target = el.textContent;
      var st = keyState[key] || (keyState[key] = { shown: null, raf: 0 });
      var from = st.shown;
      if (from == null) { st.shown = target; return; }            // first time this number is seen
      roll(st, from, target, function (txt) { if (el.isConnected) el.textContent = txt; });
    })(els[i]);
  }

  // ── quick find (Ctrl+K or 🔍) ──
  // Paste an order #, oLPN, iLPN / case / LPN…, tote or task ID and jump straight to where SCOUT shows it.
  // Searches only what SCOUT already has (the agents' data files) — late, stuck or flagged things.
  // A page gets routed to with ?sui_find=<id>&sui_go=<route>; the page's own find(route, id) hook
  // (SCOUT_UI.bar option) opens the right tab and returns the element to outline.
  // Never shows associate names (Container Watch rows carry them; they stay in the page's detail).
  var FIND_SOURCES = ['backlog_live.json', 'expedite_live.json', 'untasked_live.json',
                      'container_watch_live.json', 'totes_live.json', 'tasks_live.json'];
  // Pages by name AND by the work they show (10/22, Dean: "picking" should list every picking page).
  // words = what you might type; what = the line shown under the result. Word forms match by prefix
  // (pick / picks / picking, replen / replenishment), see pageScore(). go/key = open a Backlog tab.
  // fileOnly = OneDrive only (Shubham's boards are never on Pages; each sits in its own subfolder).
  var PAGES = [
    { name: 'Menu', file: MENU_PAGE, words: 'home start', what: 'All SCOUT reports' },
    { name: 'Ecom', file: 'Ecom_v3.html', tracks: 'replen putaway picking packing sorting shipping pph', words: 'throughput pace associates staffing people hours behind nail',
      what: 'Ecom throughput by associate: replen, putaway, picking, packing, sorting, shipping · PPH · where to put people now' },
    { name: 'Ecom Backlog', file: 'Backlog_live.html', words: 'orders lines waves allocated ready pack rfp hazmat top items visuals dropped packed palletized',
      what: 'Ecom order backlog by day: allocated, ready for pack, waves, top items' },
    { name: 'Ecom Backlog · Batches', file: 'Backlog_live.html', go: 'tab', key: 'batches', words: 'batches putwall release cleared queued',
      what: 'Putwall batches: released, picking, cleared' },
    { name: 'Ecom Backlog · Tasks', file: 'Backlog_live.html', go: 'tab', key: 'tasks', words: 'tasks picking replen carts pick zone queued assigned',
      what: 'Open Ecom pick and replen tasks, carts, replen by pick zone' },
    { name: 'Ecom Backlog · Expedite', file: 'Backlog_live.html', go: 'tab', key: 'expedite', words: 'expedite 1dd 2dd late held cutoff splits boxes olpn pallet',
      what: '1DD / 2DD orders: late, at risk, held, split boxes' },
    { name: 'Ecom Backlog · Floor Check', file: 'Backlog_live.html', go: 'tab', key: 'untasked', words: 'floor check no task untasked short shelf replen ghost allocation case pick stuck',
      what: 'Ecom orders allocated with no pick task, and why' },
    { name: 'Open Totes', file: 'Totes_live.html', words: 'totes putwall sorting hospital mixed olpn',
      what: 'Open totes and putwalls, how long they have waited' },
    { name: 'Shipping', file: 'Shipping_live.html', tracks: 'shipping palletize floor load', words: 'containers outbound trailer',
      what: 'Shipping throughput: palletize and floor load by associate' },
    { name: 'Receiving', file: 'Receiving_live.html', tracks: 'receiving receive', words: 'inbound dock lpn small parcel rcv',
      what: 'Receiving throughput: LPN and small parcel receive by associate' },
    { name: 'Retail', file: 'Reserve_v1_7.html', tracks: 'picking replen putaway', words: 'reserve stock throughput full lpn hourly associates nail',
      what: 'Retail throughput by associate: picking F1 / F2, replen, putaway, full LPN pick' },
    { name: 'Retail Weekly Recap', file: 'Reserve_weekly.html', tracks: 'picking replen putaway', words: 'weekly recap week',
      what: 'Retail throughput for the week, by day and associate' },
    { name: 'Item Prep', file: 'ItemPrep_v2.0.html', tracks: 'receive condition code', words: 'item level crossdock',
      what: 'Item Prep throughput: item level receive, condition code removal' },
    { name: 'Container Watch', file: 'Container_watch.html', words: 'cup lost missing staging splits ghost found freight p1-fc p1-pk',
      what: 'Containers at risk of going missing: staging, Item Prep splits, found freight' },
    { name: 'CC Pick List', file: 'CustomerCare_live.html', words: 'customer care gwp pick list',
      what: 'Customer Care pick list from an upload' },
    { name: 'Change log', file: 'Changelog.html', words: 'changelog notes updates what changed',
      what: 'What changed in SCOUT, by day' },
    { name: 'Retail Board', file: 'Retail%20board/dc499-board.html', fileOnly: true,
      tracks: 'picking replen', words: 'shubham ops ie open orders pick zones pez staffing people waves bridge dead shelves olpn blocking location',
      what: "Shubham's Retail Board: open orders by pick zone, replen, where to put people, waves" },
    { name: 'Item Prep Board', file: 'Item%20Prep%20board/itemprep-board.html', fileOnly: true,
      tracks: 'sla', words: 'shubham lanes aging past retail ticketing l2ip splits',
      what: "Shubham's Item Prep SLA Board: lanes, aging, past SLA" }
  ];
  // 0 = no match. Every typed word must match the page's name, the work it measures (tracks) or a word
  // it shows (words). Same word = 4+ letters in common, allowing a 2-letter ending (pick / picks /
  // picking, packed / packing, replen / replenishment); 2-3 letters typed = start of a word only.
  // Score per word: name 3, measures 2, shows 1 — so "picking" lists Ecom and Retail (they measure
  // picking) before pages that only show pick tasks. Ties keep the list order.
  function pageScore(p, q) {
    var toks = String(q).toLowerCase().split(/[^a-z0-9-]+/).filter(function (t) { return t.length >= 2; });
    if (!toks.length) return 0;
    var sp = function (s) { return String(s || '').toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean); };
    var nameW = sp(p.name), trackW = sp(p.tracks), workW = sp(p.words);
    var same = function (t, w) {
      if (t.length < 4 || w.length < 4) return w.indexOf(t) === 0;
      var n = 0; while (n < t.length && n < w.length && t[n] === w[n]) n++;
      return n >= 4 && n >= Math.min(t.length, w.length) - 2 || (n >= 4 && n === Math.min(t.length, w.length));
    };
    var any = function (t, list) { return list.some(function (w) { return same(t, w); }); };
    var score = 0;
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (nameW.some(function (w) { return w.indexOf(t) === 0; })) score += 3;   // typed the start of a name word
      else if (any(t, nameW)) score += 2;                                          // other form of a name word
      else if (any(t, trackW)) score += 2;
      else if (any(t, workW)) score += 1;
      else return 0;
    }
    return score;
  }
  var findIdx = null, findAt = 0, findLoading = null;
  var pageText = '';   // the page's visible text, read once each time the palette opens (before it shows)

  // A page in a subfolder (Shubham's boards in SCOUT Team: "Retail board/…", menu '../Menu_v2.0.html')
  // reads SCOUT's data and opens results one folder up. Before 10/22 it looked for filedata/ next to
  // itself, found nothing, and every search came back "not on any SCOUT list".
  function root() { var m = opts && opts.menu; return m && /\//.test(m) ? m.replace(/[^\/]*$/, '') : ''; }

  function loadData(name) {
    if (location.protocol === 'file:' && (!window.SCOUT_FILE_MODE || root())) {   // no shim, or shim looks in the wrong folder
      return new Promise(function (res) {
        var s = document.createElement('script');
        s.src = root() + 'filedata/' + name.replace(/\.json$/, '.js') + '?t=' + Date.now();
        s.onload = function () { s.remove(); res((window.SCOUT_FILE_DATA || {})[name] || null); };
        s.onerror = function () { s.remove(); res(null); };
        document.head.appendChild(s);
      });
    }
    return fetch(root() + name + '?t=' + Date.now()).then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }
  var XPD_ST = { '1000': 'Ready', '2090': 'Allocated', '7100': 'Packing', '7200': 'Packed', '7600': 'Manifested' };
  var UT_CAT = { short_shelf: 'Short shelf', wont_fit: "Replen won't fit", count_open_since: 'Count open',
                 replen_loop: 'Replen loop', has_stock: 'Has stock, no task' };
  function shortDate(s) { var d = new Date(String(s).replace(' ', 'T') + (/Z|[+-]\d\d:\d\d$/.test(s) ? '' : 'Z'));
    return isNaN(d) ? '' : d.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric' }); }
  function buildIndex(D) {
    var out = [];
    function add(id, kind, where, detail, page, go, key) {
      if (id) out.push({ id: String(id), kind: kind, where: where, detail: detail || '', page: page, go: go, key: String(key || id) });
    }
    var bl = D['backlog_live.json'];
    (bl && bl.dates || []).forEach(function (d) { (d.orders || []).forEach(function (o) {
      add(o.order_id, 'Order', 'Ecom Backlog', [o.status && o.status.charAt(0) + o.status.slice(1).toLowerCase(),
        'from ' + shortDate(d.date + 'T12:00:00Z'), (o.line_count || 0) + ' line' + (o.line_count === 1 ? '' : 's'),
        o.hazmat === 'Y' ? 'Hazmat' : ''].filter(Boolean).join(' · '), 'Backlog_live.html', 'bl-order');
    }); });
    var x = D['expedite_live.json'];
    (x && x.orders || []).forEach(function (o) {
      var det = [XPD_ST[o.order_status] || o.order_status, o.olpn_location || '', o.quantity ? o.quantity + ' u' : ''].filter(Boolean).join(' · ');
      add(o.order_id, 'Order', 'Expedite · ' + (o.service_level || ''), det, 'Backlog_live.html', 'xpd');
      (o.olpns || []).forEach(function (l) { add(l, 'oLPN', 'Expedite · ' + (o.service_level || ''), 'order ' + o.order_id + ' · ' + det, 'Backlog_live.html', 'xpd', o.order_id); });
    });
    (x && x.splits && x.splits.list || []).forEach(function (o) {
      var det = (o.boxes || []).length + ' boxes' + (o.fit === 'used' ? ' · would have fit one box' : '');
      add(o.order_id, 'Order', 'Expedite · Splits', det, 'Backlog_live.html', 'xpd-splits');
      (o.boxes || []).forEach(function (b) { add(b.olpn_id, 'oLPN', 'Expedite · Splits', 'order ' + o.order_id + ' · ' + det, 'Backlog_live.html', 'xpd-splits', o.order_id); });
    });
    var u = D['untasked_live.json'];
    if (u) {
      (u.orders || []).forEach(function (o) { add(o.order_id, 'Order', 'Floor Check', [UT_CAT[o.category] || o.category, o.svc, o.mins != null ? xMins(o.mins) + ' untasked' : ''].filter(Boolean).join(' · '), 'Backlog_live.html', 'ut'); });
      (u.ghosts || []).forEach(function (o) { add(o.order_id, 'Order', 'Floor Check', 'Ghost allocation · order ' + (o.status || '').toLowerCase(), 'Backlog_live.html', 'ut'); });
      (u.no_task_made || []).forEach(function (o) { add(o.order_id, 'Order', 'Floor Check', 'No task made · ' + (o.svc || ''), 'Backlog_live.html', 'ut'); });
      (u.case_pick || []).forEach(function (o) {
        add(o.order_id, 'Order', 'Floor Check', 'Waiting on a reserve case · ' + (o.svc || ''), 'Backlog_live.html', 'ut');
        (o.lines || []).forEach(function (ln) { (ln.cases || []).forEach(function (c) {
          add(c.lpn, 'Case', 'Floor Check', 'reserve case for order ' + o.order_id, 'Backlog_live.html', 'ut', o.order_id);
          add(c.task_id, 'Task', 'Floor Check', 'case pick for order ' + o.order_id, 'Backlog_live.html', 'ut', o.order_id);
        }); });
      });
      (u.shelves || []).forEach(function (s) { (s.deferred || []).forEach(function (d) { add(d.ilpn, 'iLPN', 'Floor Check', 'replen deferred to ' + (s.location || s.loc || 'a shelf'), 'Backlog_live.html', 'ut'); }); });
    }
    var c = D['container_watch_live.json'];
    [['staging', 'Staging'], ['splits', 'Item Prep Splits'], ['found', 'Found Freight']].forEach(function (t) {
      (c && c[t[0]] || []).forEach(function (r) {
        var det = [r.loc || (t[0] === 'splits' ? 'no location' : ''), r.units ? r.units + ' u' : '', (r.tags || []).join(', ').replace(/_/g, ' ')].filter(Boolean).join(' · ');
        add(r.lpn, 'Container', 'Container Watch · ' + t[1], det, 'Container_watch.html', 'cw-' + t[0]);
        if (r.parent_lpn) add(r.parent_lpn, 'Carton', 'Container Watch · ' + t[1], 'parent carton of ' + r.lpn, 'Container_watch.html', 'cw-' + t[0], r.lpn);
      });
    });
    var tt = D['totes_live.json'];
    ['case1', 'case2', 'case3'].forEach(function (k) { (tt && tt[k] || []).forEach(function (t) {
      add(t.olpn, 'Tote', 'Open Totes', [t.location || 'not dropped', t.timer_min != null ? xMins(t.timer_min) : ''].filter(Boolean).join(' · '), 'Totes_live.html', 'tote');
    }); });
    var tk = D['tasks_live.json'];
    [['picking', 'Pick task'], ['replen', 'Replen task']].forEach(function (g) {
      (tk && tk[g[0]] && tk[g[0]].tasks || []).forEach(function (t) {
        add(t.task_id, 'Task', 'Ecom Backlog · Tasks', [g[1], t.status_label, t.source].filter(Boolean).join(' · '), 'Backlog_live.html', 'tasks');
      });
    });
    ['pick_drop_carts', 'flow_carts'].forEach(function (k) { (tk && tk[k] || []).forEach(function (cart) {
      (cart.ilpns || []).forEach(function (l) { add(l.ilpn_id, 'iLPN', 'Ecom Backlog · Tasks', 'on cart at ' + cart.location, 'Backlog_live.html', 'tasks', cart.location); });
    }); });
    return out;
  }
  function xMins(m) { m = Math.round(m); return m < 60 ? m + ' min' : m < 1440 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : Math.floor(m / 1440) + ' d'; }
  function ensureIndex() {
    if (findIdx && Date.now() - findAt < 90000) return Promise.resolve(findIdx);
    if (findLoading) return findLoading;
    findLoading = Promise.all(FIND_SOURCES.map(loadData)).then(function (arr) {
      var D = {}; FIND_SOURCES.forEach(function (n, i) { D[n] = arr[i]; });
      findIdx = buildIndex(D); findAt = Date.now(); findLoading = null; return findIdx;
    });
    return findLoading;
  }
  function norm(s) { return String(s || '').toUpperCase().replace(/\s+/g, ''); }
  function search(q) {
    var n = norm(q), res = [];
    if (!n) return res;
    var seen = {};
    (findIdx || []).forEach(function (e) {
      var id = norm(e.id), score = id === n ? 3 : (n.length >= 4 && id.indexOf(n) !== -1) ? (id.slice(-n.length) === n ? 2 : 1) : 0;
      var k = e.id + '|' + e.where + '|' + e.go;
      if (score && !seen[k]) { seen[k] = 1; res.push({ e: e, s: score }); }
    });
    res.sort(function (a, b) { return b.s - a.s; });
    var low = String(q).toLowerCase().trim();
    var pages = PAGES.map(function (p, i) {
      if (p.fileOnly && location.protocol !== 'file:') return null;           // board pages: OneDrive only
      var s = pageScore(p, low);
      return s ? { p: p, s: s, i: i } : null;
    }).filter(Boolean).sort(function (a, b) { return b.s - a.s || a.i - b.i; }).slice(0, 10).map(function (x) { return x.p; });
    // On this page: what you typed is in the page's visible text (e.g. a store, order or lane on
    // Shubham's board, which SCOUT's data files don't carry). Enter jumps to the first match.
    var here_ = [];
    if (n.length >= 3 && pageText.indexOf(n) !== -1)
      here_.push({ id: String(q).trim(), page: '', kind: 'Here', where: 'On this page', detail: 'jump to the first match',
                   go: '__here', key: String(q).trim(), here: true });
    return res.slice(0, 12).map(function (r) { return r.e; }).concat(here_, pages.map(function (p) {
      return { page: root() + p.file, kind: 'Page', where: p.name, detail: p.what || '', go: p.go || '', key: p.key || '', isPage: true };
    }));
  }

  var palEl = null, palSel = 0, palRes = [];
  var PAL_CSS = [
    '.sui-pal-back{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.45);display:none;align-items:flex-start;justify-content:center;padding-top:12vh;}',
    '.sui-pal-back.open{display:flex;}',
    '.sui-pal{width:min(640px,92vw);border-radius:14px;background:#1d1f27;color:#e6e6e4;border:1px solid rgba(255,255,255,0.12);',
    ' box-shadow:0 18px 48px rgba(0,0,0,0.45);overflow:hidden;font-family:-apple-system,"Segoe UI",sans-serif;}',
    '.sui-pal.sui-light{background:#fff;color:#1a1a1a;border-color:rgba(0,0,0,0.12);}',
    '.sui-pal input{width:100%;box-sizing:border-box;border:0;outline:0;padding:16px 18px;font-size:16px;background:transparent;color:inherit;',
    ' border-bottom:1px solid rgba(127,127,127,0.25);font-family:inherit;}',
    '.sui-pal-list{max-height:52vh;overflow-y:auto;padding:6px;}',
    '.sui-pal-item{display:flex;gap:12px;align-items:baseline;padding:9px 12px;border-radius:9px;cursor:pointer;}',
    '.sui-pal-item.sel{background:rgba(14,158,142,0.18);}',
    '.sui-pal-kind{font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;min-width:64px;opacity:0.6;}',
    '.sui-pal-main{flex:1;min-width:0;}',
    '.sui-pal-id{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;word-break:break-all;}',
    '.sui-pal-where{font-size:12px;opacity:0.85;margin-top:1px;}',
    '.sui-pal-det{font-size:11px;opacity:0.6;margin-top:1px;}',
    '.sui-pal-msg{padding:14px 16px;font-size:13px;opacity:0.7;line-height:1.5;}',
    '.sui-pal-foot{padding:8px 14px;font-size:11px;opacity:0.5;border-top:1px solid rgba(127,127,127,0.2);}',
    '.sui-found{outline:2px solid #0E9E8E !important;outline-offset:2px;background-color:rgba(14,158,142,0.14) !important;}',
    '.sui-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:100001;padding:10px 16px;border-radius:10px;',
    ' background:#1d1f27;color:#e6e6e4;font:13px -apple-system,"Segoe UI",sans-serif;box-shadow:0 8px 24px rgba(0,0,0,0.35);max-width:90vw;}'
  ].join('\n');
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function palDraw(q, msg) {
    var list = palEl.querySelector('.sui-pal-list');
    if (msg) { list.innerHTML = '<div class="sui-pal-msg">' + msg + '</div>'; return; }
    if (!palRes.length) {
      list.innerHTML = '<div class="sui-pal-msg">' + (norm(q).length >= 4
        ? '<b>' + esc(q) + '</b> is not on any SCOUT list right now. SCOUT only lists late, stuck or flagged work, so this usually means nothing is wrong with it.'
        : 'Paste an order #, oLPN, iLPN / case, tote or task ID — or type a page name.') + '</div>';
      return;
    }
    list.innerHTML = palRes.map(function (r, i) {
      return '<div class="sui-pal-item' + (i === palSel ? ' sel' : '') + '" data-i="' + i + '"><div class="sui-pal-kind">' + esc(r.kind) +
        '</div><div class="sui-pal-main">' + (r.isPage ? '' : '<div class="sui-pal-id">' + esc(r.id) + '</div>') +
        '<div class="sui-pal-where">' + esc(r.where) + '</div>' + (r.detail ? '<div class="sui-pal-det">' + esc(r.detail) + '</div>' : '') + '</div></div>';
    }).join('');
    var s = list.querySelector('.sel'); if (s) s.scrollIntoView({ block: 'nearest' });
  }
  function palRun() {
    var q = palEl.querySelector('input').value;
    palRes = search(q); palSel = 0; palDraw(q);
  }
  function openPalette() {
    if (!palEl) {
      if (!document.getElementById('sui-pal-css')) { var st = document.createElement('style'); st.id = 'sui-pal-css'; st.textContent = PAL_CSS; document.head.appendChild(st); }
      palEl = document.createElement('div'); palEl.className = 'sui-pal-back';
      palEl.innerHTML = '<div class="sui-pal" role="dialog" aria-label="Quick find"><input type="text" placeholder="Find an order, oLPN, LPN, tote, task — or a page" autocomplete="off" spellcheck="false">' +
        '<div class="sui-pal-list"></div><div class="sui-pal-foot">↑ ↓ to pick · Enter to open · Esc to close · searches what SCOUT is showing right now</div></div>';
      document.body.appendChild(palEl);
      var inp = palEl.querySelector('input');
      inp.addEventListener('input', function () { ensureIndex().then(palRun); });
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { palSel = Math.min(palRes.length - 1, palSel + 1); palDraw(inp.value); e.preventDefault(); }
        else if (e.key === 'ArrowUp') { palSel = Math.max(0, palSel - 1); palDraw(inp.value); e.preventDefault(); }
        else if (e.key === 'Enter') { if (palRes[palSel]) goTo(palRes[palSel]); e.preventDefault(); }
        else if (e.key === 'Escape') closePalette();
      });
      palEl.addEventListener('mousedown', function (e) { if (e.target === palEl) closePalette(); });
      palEl.querySelector('.sui-pal-list').addEventListener('click', function (e) {
        var it = e.target.closest && e.target.closest('.sui-pal-item'); if (it) goTo(palRes[+it.getAttribute('data-i')]);
      });
    }
    palEl.querySelector('.sui-pal').classList.toggle('sui-light', !!pageIsLight());
    try { pageText = norm(document.body.innerText); } catch (e) { pageText = ''; }   // palette still hidden here
    palEl.classList.add('open');
    var inp2 = palEl.querySelector('input'); inp2.value = ''; inp2.focus();
    palRes = []; palDraw('', findIdx ? null : 'Loading what SCOUT is showing…');
    ensureIndex().then(function () { if (palEl.classList.contains('open') && !inp2.value) palDraw(''); else palRun(); });
  }
  function closePalette() { if (palEl) palEl.classList.remove('open'); }

  function here(page) { return (location.pathname.split('/').pop() || 'index.html') === page; }
  function goTo(r) {
    closePalette();
    if (!r) return;
    var id = r.key;
    if (r.here) { runFind('__here', id); return; }
    var page = r.isPage ? r.page : root() + r.page;                 // data results: page names are top-level
    if (here(page.split('/').pop())) { if (r.go) runFind(r.go, id); return; }
    var url = page + (r.go ? '?sui_go=' + encodeURIComponent(r.go) + '&sui_find=' + encodeURIComponent(id) : '');
    location.href = url;
  }
  function toast(msg) {
    var t = document.createElement('div'); t.className = 'sui-toast'; t.textContent = msg; document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 5000);
  }
  // find text `id` inside root → the row-like element holding it
  function findText(root, id) {
    var n = norm(id); if (!root || !n) return null;
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null), node;
    while ((node = w.nextNode())) {
      if (norm(node.nodeValue).indexOf(n) === -1) continue;
      var el = node.parentElement;
      if (!el || el.offsetParent === null) continue;               // hidden
      return el.closest('tr, .order-entry, [data-oid], li, .tote-card, .tote-row') || el;
    }
    return null;
  }
  function highlight(el) {
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('sui-found');
    setTimeout(function () { el.classList.remove('sui-found'); }, 6000);
  }
  // ask the page's find hook (retries while its data is still loading)
  function runFind(go, id) {
    if (!document.getElementById('sui-pal-css')) { var st = document.createElement('style'); st.id = 'sui-pal-css'; st.textContent = PAL_CSS; document.head.appendChild(st); }
    var hook = opts && opts.find, tries = 0, redo = 0;
    (function attempt() {
      var el = null;
      try { el = hook && go !== '__here' ? hook(go, id, findText) : findText(document.body, id); } catch (e) { console.warn('[scout_ui] find', e); }
      if (el && el.nodeType === 1) {
        highlight(el);
        // the page may redraw its table right after (data still landing) — find the new row again
        var check = function () { if (!el.isConnected && redo++ < 3) { tries = 0; attempt(); } };
        setTimeout(check, 1200); setTimeout(check, 3500);
        return;
      }
      if (el === true) return;                                     // page handled it itself
      if (++tries < 20) { setTimeout(attempt, 500); return; }
      toast(id + ' is not showing on this page right now — it may be hidden by a filter, or it just cleared.');
    })();
  }
  function initFind() {
    if (window._suiFindInit) return; window._suiFindInit = true;
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); openPalette(); }
    });
    var p = new URLSearchParams(location.search), go = p.get('sui_go'), id = p.get('sui_find');
    if (go && id) {
      p.delete('sui_go'); p.delete('sui_find');                    // a refresh won't re-run it; keep ?from=ecom etc.
      try { history.replaceState(null, '', location.pathname + (p.toString() ? '?' + p.toString() : '')); } catch (e) {}
      setTimeout(function () { runFind(go, id); }, 300);
    }
  }

  // ── move settings (export / import, 2026-10-22) ──
  // Rosters and settings live in the browser per site, so GitHub Pages and the OneDrive copy (file://)
  // each start empty. Export writes one file with every roster + setting below; Import on the other
  // site ADDS it: rosters merge by email (people already there stay as they are), name lists merge by
  // LAN ID, and other settings only fill in where nothing is set yet. Nothing is ever deleted.
  // New roster/setting key on a page → add it here.
  var MOVE_KEYS = [
    ['sc_roster_2nd_v5', 'Ecom roster · 2nd shift'], ['sc_roster_1st_v1', 'Ecom roster · 1st shift'],
    ['ecom_headcount_v1', 'Ecom headcount'], ['ecom_pph_v1', 'Ecom PPH targets'], ['ecom_shift_hours_v1', 'Ecom shift hours'],
    ['rs_roster_v1_2nd', 'Retail roster · 2nd shift'], ['rs_roster_v1_1st', 'Retail roster · 1st shift'],
    ['rs_roster_v1', 'Retail roster (older save)'], ['rs_goals_v1', 'Retail goals'],
    ['ip_roster_2nd_v1', 'Item Prep roster · 2nd shift'], ['ip_roster_1st_v1', 'Item Prep roster · 1st shift'], ['ip_goals_v1', 'Item Prep goals'],
    ['shipping_lan_map_v1', 'Shipping names'], ['recv_lan_map_v1', 'Receiving names'], ['recv_live_roster_v2', 'Receiving roster (older save)'],
    ['dc499_theme_v1', 'Theme'], ['dc499_remi_enabled_v1', 'Remi on / off']
  ];
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function parseVal(s) { try { return JSON.parse(s); } catch (e) { return s; } }
  function personId(x) { return x && typeof x === 'object' ? String(x.email || x.id || x.name || JSON.stringify(x)).toLowerCase() : String(x).toLowerCase(); }
  function describe(v) {
    if (Array.isArray(v)) return v.length + (v.length === 1 ? ' person' : ' people');
    if (v && typeof v === 'object') { var n = Object.keys(v).length; return n + (n === 1 ? ' entry' : ' entries'); }
    return String(v);
  }
  // existing (raw string or null) + imported (raw string) → {raw to save or null, note}
  function mergeVal(have, got) {
    if (have == null || have === '') return { raw: got, note: 'added' };
    var a = parseVal(have), b = parseVal(got);
    if (Array.isArray(a) && Array.isArray(b)) {
      var ids = {}; a.forEach(function (x) { ids[personId(x)] = 1; });
      var add = b.filter(function (x) { return !ids[personId(x)]; });
      return add.length ? { raw: JSON.stringify(a.concat(add)), note: '+' + add.length + ' added, ' + a.length + ' already here kept' }
                        : { raw: null, note: 'everyone already here' };
    }
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      var n = 0; Object.keys(b).forEach(function (k) { if (!(k in a)) { a[k] = b[k]; n++; } });
      return n ? { raw: JSON.stringify(a), note: '+' + n + ' added, the rest kept as set here' } : { raw: null, note: 'already set here — kept' };
    }
    return { raw: null, note: 'already set here — kept' };
  }
  function exportSettings() {
    var keys = {}, n = 0;
    MOVE_KEYS.forEach(function (m) { var v = lsGet(m[0]); if (v != null && v !== '') { keys[m[0]] = v; n++; } });
    if (!n) { moveMsg('Nothing to export yet — no rosters or settings are saved in this browser for this site.'); return; }
    var d = new Date(), stamp = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    var file = { scout_settings: 1, exported: d.toISOString(), from: location.protocol === 'file:' ? 'OneDrive' : location.hostname, keys: keys };
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' }));
    a.download = 'SCOUT settings ' + stamp + '.json';
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    moveMsg('Saved <b>' + esc(a.download) + '</b> (' + n + ' rosters / settings) to your Downloads. Open SCOUT the other way (OneDrive or GitHub), open the Menu, choose Move settings → Import and pick this file.'
      + '<div style="margin-top:6px;opacity:0.7;">The file has your team\'s work emails in it — keep it to yourself and delete it when you are done.</div>');
  }
  var moveEl = null, movePending = null;
  function moveMsg(html) { var m = moveEl && moveEl.querySelector('.sui-move-msg'); if (m) m.innerHTML = html; }
  function readImport(fileObj) {
    var r = new FileReader();
    r.onload = function () {
      var f = null; try { f = JSON.parse(r.result); } catch (e) {}
      if (!f || f.scout_settings !== 1 || !f.keys) { movePending = null; moveMsg('That file is not a SCOUT settings export.'); return; }
      var rows = [], plan = [];
      MOVE_KEYS.forEach(function (m) {
        if (!(m[0] in f.keys)) return;
        var res = mergeVal(lsGet(m[0]), f.keys[m[0]]);
        rows.push('<tr><td>' + esc(m[1]) + '</td><td>' + esc(describe(parseVal(f.keys[m[0]]))) + '</td><td>' + esc(res.note) + '</td></tr>');
        if (res.raw != null) plan.push([m[0], res.raw]);
      });
      movePending = plan;
      moveMsg('<div style="margin-bottom:6px;">From ' + esc(f.from || 'another site') + ', exported ' + esc(new Date(f.exported).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })) + ':</div>'
        + '<table class="sui-move-tab"><tr><th>What</th><th>In the file</th><th>Here</th></tr>' + rows.join('') + '</table>'
        + (plan.length ? '<button type="button" class="sui-move-btn sui-move-go">Add these</button>' : '<div style="margin-top:8px;">Nothing new to add — this browser already has all of it.</div>'));
    };
    r.readAsText(fileObj);
  }
  function applyImport() {
    if (!movePending) return;
    var ok = 0; movePending.forEach(function (p) { try { localStorage.setItem(p[0], p[1]); ok++; } catch (e) {} });
    movePending = null;
    moveMsg('Done — ' + ok + ' added. Pages that are already open: refresh them to see the rosters.');
  }
  function openMove() {
    if (!document.getElementById('sui-pal-css')) { var st = document.createElement('style'); st.id = 'sui-pal-css'; st.textContent = PAL_CSS; document.head.appendChild(st); }
    if (!document.getElementById('sui-move-css')) {
      var s2 = document.createElement('style'); s2.id = 'sui-move-css';
      s2.textContent = '.sui-move{padding:16px 18px;font-size:13px;line-height:1.5;}.sui-move h3{margin:0 0 6px;font-size:15px;}'
        + '.sui-move-btn{font:inherit;font-size:13px;font-weight:600;padding:7px 14px;margin:8px 8px 0 0;border-radius:8px;cursor:pointer;'
        + 'border:1px solid rgba(14,158,142,0.6);background:rgba(14,158,142,0.16);color:inherit;}'
        + '.sui-move-msg{margin-top:12px;font-size:12px;}.sui-move-tab{border-collapse:collapse;width:100%;font-size:12px;}'
        + '.sui-move-tab th,.sui-move-tab td{text-align:left;padding:3px 8px 3px 0;border-bottom:1px solid rgba(127,127,127,0.2);}';
      document.head.appendChild(s2);
    }
    if (!moveEl) {
      moveEl = document.createElement('div'); moveEl.className = 'sui-pal-back';
      moveEl.innerHTML = '<div class="sui-pal" role="dialog" aria-label="Move settings"><div class="sui-move"><h3>Move your rosters and settings</h3>'
        + '<div style="opacity:0.8;">GitHub and the OneDrive copy keep rosters separately. Export here, then Import on the other one. '
        + 'Import only adds: people already on a roster stay, and settings you already set are kept.</div>'
        + '<button type="button" class="sui-move-btn sui-move-exp">&#x2B07; Export my settings</button>'
        + '<button type="button" class="sui-move-btn sui-move-imp">&#x2B06; Import from a file</button>'
        + '<input type="file" accept=".json,application/json" style="display:none">'
        + '<div class="sui-move-msg"></div></div><div class="sui-pal-foot">Esc or click outside to close</div></div>';
      document.body.appendChild(moveEl);
      var fi = moveEl.querySelector('input[type=file]');
      moveEl.querySelector('.sui-move-exp').onclick = exportSettings;
      moveEl.querySelector('.sui-move-imp').onclick = function () { fi.value = ''; fi.click(); };
      fi.onchange = function () { if (fi.files && fi.files[0]) readImport(fi.files[0]); };
      moveEl.addEventListener('click', function (e) {
        if (e.target === moveEl) moveEl.classList.remove('open');
        if (e.target.classList && e.target.classList.contains('sui-move-go')) applyImport();
      });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && moveEl) moveEl.classList.remove('open'); });
    }
    moveEl.querySelector('.sui-pal').classList.toggle('sui-light', !!pageIsLight());
    movePending = null; moveMsg('');
    moveEl.classList.add('open');
  }

  // another tab changed the theme → follow it
  window.addEventListener('storage', function (e) { if (e.key === THEME_KEY && valid(e.newValue)) applyTheme(e.newValue, false); });

  window.SCOUT_UI = {
    bar: bar,
    updated: function (d) { lastUpdated = d ? new Date(d) : null; renderUpdated(); },
    countUp: countUp,
    countKeys: countKeys,
    theme: { get: function () { return getTheme(); }, set: function (t) { applyTheme(t, true); }, list: THEMES.slice(), key: THEME_KEY },
    menuPage: MENU_PAGE,
    // quick find for a page without the bar (the Menu): SCOUT_UI.initFind()
    initFind: function (o) { if (o) opts = o; initFind(); },
    openFind: function () { openPalette(); },
    // export / import rosters + settings between GitHub Pages and the OneDrive copy (Menu button)
    openMove: function () { openMove(); }
  };
})();
