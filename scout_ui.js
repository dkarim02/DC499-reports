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
    '.sui-id{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 220px;}',
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
    var menu = el('a', 'sui-menu', '← Menu'); menu.href = MENU_PAGE; menu.title = 'Back to the SCOUT menu';
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
  }

  // another tab changed the theme → follow it
  window.addEventListener('storage', function (e) { if (e.key === THEME_KEY && valid(e.newValue)) applyTheme(e.newValue, false); });

  window.SCOUT_UI = {
    bar: bar,
    updated: function (d) { lastUpdated = d ? new Date(d) : null; renderUpdated(); },
    theme: { get: function () { return getTheme(); }, set: function (t) { applyTheme(t, true); }, list: THEMES.slice(), key: THEME_KEY },
    menuPage: MENU_PAGE
  };
})();
