# DC499 Report Processor Suite — Developer Handoff Guide
**Last updated:** June 23, 2026  
**Original developer:** dean.karim (via Claude.ai Projects)  
**GitHub:** `github.com/dkarim02/DC499-reports` → `dkarim02.github.io/DC499-reports`

---

## 1. Current File Versions

| File | Version | Notes |
|---|---|---|
| `Menu_v1.6.html` | v1.6 | "What's new?" footer link, updated card colors |
| `Ecom_v2.4.html` | v2.4 | Title fix, 3×2 tiles, clickable tiles + side panel (layout bug pending) |
| `Reserve_v1.5.html` | v1.5 | Full Report with Pick F1/F2/Replen/Putaway, same tile/panel system |
| `ItemPrep_v1.9.html` | v1.9 | No changes this session |
| `Receiving_v1.6.html` | v1.6 | No changes this session |
| `Changelog.html` | — | Reads from changelog.json |
| `changelog.json` | — | Source of truth for patch notes |
| `MegaDash_v1.2.html` | v1.2 | Built independently by Dean, not yet integrated |

All files must be in the **same folder**. `index.html` redirects to `Menu_v1.6.html`.

---

## 2. Known Bug — MUST FIX NEXT SESSION

**File:** `Ecom_v2.4.html` (and `Reserve_v1.5.html` — same issue)  
**Bug:** In `renderFullReport()`, the side panel div renders **below** the dept grid instead of **beside** it. The shift summary 3×2 grid also appears misaligned.

**Root cause:** The HTML string building order is wrong. The side panel `<div>` is placed **before** the `full-layout-with-panel` wrapper div instead of inside it as the second column.

**Current broken order:**
```
[side panel div]           ← outside the grid, renders below
[full-layout-with-panel]
  [dept grid]              ← left col
  [empty]                  ← right col has nothing
```

**Correct order:**
```
[full-layout-with-panel]
  [dept grid]              ← left col
  [side panel div]         ← right col
```

**Desired behavior:**
- **No tile selected:** dept grid spans full width (2-col cards), side panel hidden
- **Tile clicked:** layout switches to `grid-template-columns: 1fr 280px`, side panel appears on right
- **Same tile clicked again:** collapses back to full width
- **Different tile clicked:** swaps side panel content

**Fix location in renderFullReport():**
```javascript
// WRONG (current):
html += '<div id="full-side-panel" class="full-side-panel"></div>';
html += '<div class="full-layout-with-panel"><div id="full-dept-grid"><div class="full-grid">';
// ... dept cards ...
html += '</div></div></div>';

// CORRECT:
html += '<div id="full-layout-wrapper">';  // no grid class yet — applied by clickTile
html += '<div id="full-dept-grid"><div class="full-grid">';
// ... dept cards ...
html += '</div></div>';
html += '<div id="full-side-panel" class="full-side-panel"></div>';
html += '</div>';
```

Then in `clickTile()`:
```javascript
// On tile click — activate 2-col layout:
document.getElementById('full-layout-wrapper').style.display = 'grid';
document.getElementById('full-layout-wrapper').style.gridTemplateColumns = '1fr 280px';
document.getElementById('full-layout-wrapper').style.gap = '14px';

// On collapse — revert to full width:
document.getElementById('full-layout-wrapper').style.display = 'block';
```

---

## 3. Architecture

**No build system** — pure HTML/CSS/JS, open in any browser. No npm, no bundler.

**External CDN (cloudflare):**
- PapaParse 5.4.1 — CSV parsing
- Chart.js 4.4.1 — charts

**localStorage keys:**
| App | Roster | Goals | Theme |
|---|---|---|---|
| Ecom | `sc_roster_2nd_v5` / `sc_roster_1st_v1` | `sc_goals_v1` | `dc499_ecom_theme_v1` |
| Reserve | `rs_roster_v1` | `rs_goals_v1` | `dc499_reserve_theme_v1` |
| ItemPrep | `ip_roster_2nd_v1` / `ip_roster_1st_v1` | `ip_goals_v1` | `dc499_itemprep_theme_v1` |
| Receiving | `recv_roster_v1` | `recv_goals_v1` | `dc499_receiving_theme_v1` |

> ⚠️ Bump storage key version (e.g. `v5` → `v6`) when changing default roster. localStorage is tied to domain — GitHub Pages URL stays the same across file updates so rosters persist.

---

## 4. Transaction IDs & Metrics

### Ecom v2.4

| Section | Transaction IDs | Metric |
|---|---|---|
| Replenishment | `iLPN Replen Fill`, `Retail iLPN Replen Pull`, `iLPN Replen Pull`, `iLPN Replen Fill Large`, `iLPN Replen Pull Large` | Sum `Completed Quantity` |
| Putaway | `System Directed Putaway`, `User Directed Putaway` | Count rows (NOT Transaction Type) |
| Picking | `Ecom Mezz Pick To Putwall Cart`, `Ecom Non-Mezz Pick To Putwall Cart` | Sum `Quantity` |
| Packing | `NRDR CORE PACK FOR ECOM PACK STATION` | Sum `Quantity` |
| Shipping | `OB Putaway By Ship Via` | Sum `Quantity` |
| Sorting | `OB Sort To Putwall Cubby` + `Criteria = NRDR_SORT_TO_PUTWALL_CUBBIES_CRITERIA` | Sum `Quantity` |

### Reserve v1.5

| Section | Transaction IDs | Metric |
|---|---|---|
| Pick F1 | `Non Haz Retail Pick To oLPN Cart` | Sum `Quantity` |
| Pick F2 | `Non Haz Retail Pick To oLPN Cart Floor 2` | Sum `Quantity` |
| Replenishment | `iLPN Replen Fill`, `iLPN Replen Fill Large` | Sum `Completed Quantity` |
| Putaway | `System Directed Putaway`, `User Directed Putaway` | Count rows |

### Item Prep v1.9

| Section | Transaction IDs | Metric |
|---|---|---|
| Item Level Receive | `Item Level Receive` | Sum `Quantity`, dedup by `Container ID` |
| Condition Code | `IlpnConditionCodeRemoval` | Sum `Quantity`, dedup by `Container ID` |

### Receiving v1.6

| Section | Transaction IDs | Metric |
|---|---|---|
| LPN Receive | `LPN Level Receive`, `Small Parcel LPN Level Receive` | Count unique `Container ID`s |

---

## 5. Ecom Full Report Key Variables

```javascript
var SORT_CRITERIA = 'NRDR_SORT_TO_PUTWALL_CUBBIES_CRITERIA';

var FULL_TX = {
  replen:  ['iLPN Replen Fill','Retail iLPN Replen Pull','iLPN Replen Pull','iLPN Replen Fill Large','iLPN Replen Pull Large'],
  putaway: ['System Directed Putaway','User Directed Putaway'],
  picking: ['Ecom Mezz Pick To Putwall Cart','Ecom Non-Mezz Pick To Putwall Cart'],
  packing: ['NRDR CORE PACK FOR ECOM PACK STATION'],
  shipping: ['OB Putaway By Ship Via'],
  sorting:  ['OB Sort To Putwall Cubby']
};

var FULL_METRIC = {
  replen: 'Completed Quantity', putaway: null,  // null = count rows
  picking: 'Quantity', packing: 'Quantity',
  shipping: 'Quantity', sorting: 'Quantity'
};

var FULL_COLORS = {
  replen: '#185FA5', putaway: '#0F6E56', picking: '#9B4DCA',
  packing: '#E67E22', shipping: '#0E9E8E', sorting: '#C0392B'
};

var FULL_LABELS = {
  replen: 'Replenishment', putaway: 'Putaway', picking: 'Picking',
  packing: 'Packing', shipping: 'Shipping', sorting: 'Sorting'
};

var fullReportRows = [];
var fullReportFiles = [];
var fullReportKeysByFile = {};
var _activeTile = null;  // currently selected dept tile
```

### Reserve Full Report Key Variables

```javascript
var RES_TX = {
  pick:   ['Non Haz Retail Pick To oLPN Cart'],
  pick2:  ['Non Haz Retail Pick To oLPN Cart Floor 2'],
  replen: ['iLPN Replen Fill','iLPN Replen Fill Large'],
  putaway:['System Directed Putaway','User Directed Putaway']
};
var RES_COLORS = {pick:'#0891B2', pick2:'#D97706', replen:'#6366F1', putaway:'#059669'};
var RES_LABELS = {pick:'Pick F1', pick2:'Pick F2', replen:'Replenishment', putaway:'Putaway'};
var RES_METRIC = {pick:'Quantity', pick2:'Quantity', replen:'Completed Quantity', putaway:null};
```

---

## 6. Full Report Render Order

Both Ecom and Reserve Full Reports render in this order:
1. Header + row count meta
2. **Shift Summary** — clickable dept tiles (3×2 for Ecom, 2×2 for Reserve)
3. **Activity by Hour** — multi-line chart, smooth/spiky toggle
4. **Layout wrapper** — dept grid (left) + side panel (right, hidden until tile clicked)

---

## 7. Clickable Tile + Side Panel System

```javascript
function clickTile(typ) {
  // Toggle off if same tile clicked again
  if (_activeTile === typ) {
    _activeTile = null;
    // Remove active class from all tiles
    // Hide side panel
    // Reset layout to full width
    drawFullChart();  // restore all dept lines
    return;
  }
  _activeTile = typ;
  // Set active class on clicked tile
  // Render side panel for this dept
  // Activate 2-col layout
  drawFullChart(typ);  // filter chart to this dept only
}

function renderSidePanel(typ) {
  // Find all employees in current CSV for this dept
  // Split into: onRoster (in loadRoster()) vs offRoster (in data but not roster)
  // On-roster TMs: show units + Disable button
  // Off-roster TMs: show units + Add button
}

function addTMFromPanel(emp, typ) {
  // confirm() prompt → add to localStorage roster permanently
}

function toggleTMFromPanel(emp, typ) {
  // Toggle enabled/disabled in localStorage roster
  // Re-renders full report + side panel
}
```

**drawFullChart(filterTyp)** — optional param. If provided, only renders that dept's line. If omitted, renders all depts.

---

## 8. Dedup Strategy — CRITICAL

`addToFullReport(rows, fileName)` uses **cross-file-only dedup**:
- Key = `Employee + '|' + Transaction ID + '|' + Activity Datetime`
- Rows appearing in **multiple files** → first occurrence kept (seam dedup)
- Rows duplicated **within same file** → ALL kept (legitimate — e.g. 5 packs same second)
- Same filename dropped twice → blocked by `fullReportFiles` array

> ⚠️ **Never use CP Trace Id for dedup** — it is shared across multiple legitimate transactions and will silently drop valid rows (caused 723 missing replen units previously).

---

## 9. Associate Performance Charts

Clicking any associate row in the dept grid expands an inline chart:
- Combined activity, **5-minute buckets**, only active buckets plotted
- **X-axis labels every 30 minutes** only  
- **Red segments** where gap > 10 minutes
- **Tooltip on red points:** gap start, end, duration
- **Bottom right:** total gap time summed across all gaps
- Charts stored in `assocCharts{}`, destroyed on collapse

---

## 10. Roster Drag-and-Drop (PENDING — not yet built)

Per the roadmap, each app's Settings tab needs:
- A small drop zone accepting `.csv` (one email per line) or `.json` (array of `{email, enabled}`)
- Auto-detect format by extension
- Saves to localStorage + offers a Download button to reshare
- No roster data stored in GitHub code — all local

---

## 11. Code Patterns

### Null metric (putaway = count rows)
```javascript
var val = metricKey ? (parseFloat(r[metricKey])||0) : 1;
```
Must appear in: dept grid totals loop, shift summary reduce, chart hourly map. All three.

### Sorting — requires both TX ID AND Criteria column
```javascript
var filtered = fullReportRows.filter(function(r) {
  if (txList.indexOf((r['Transaction ID']||'').trim()) === -1) return false;
  if (typ === 'sorting') return (r['Criteria']||'').trim() === SORT_CRITERIA;
  return true;
});
```

### Roster format — always objects, never strings
```javascript
const DEFAULT_TEAM_2ND = [
  {email: 'user@nordstrom.com', enabled: true},
];
// loadRoster fallback must NOT re-wrap:
return defaults.map(function(m) { return {email: m.email, enabled: m.enabled}; });
// NOT: return defaults.map(function(email) { return {email: email}; }); ← wraps object in object → [object Object]
```

### onclick with dynamic keys — use dataset, not inline quotes
```javascript
// CORRECT:
html += '<tr data-empkey="'+empKey+'" onclick="toggleAssocDetail(this.dataset.empkey)">';
// WRONG — causes SyntaxError:
html += '<tr onclick="toggleAssocDetail(\''+empKey+'\')">';
```

### Copy button — always use execCommand fallback
```javascript
try {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(...);
  } else {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position='fixed'; ta.style.opacity='0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
} catch(e) { alert('Copy failed'); }
```

### Duplicate body tag check
After any patch, verify `c.count('<body>') == 1` and run `node --check` on extracted script block.

---

## 12. MegaDash Integration (PENDING)

MegaDash v1.2 is built and in the repo. Each dept app needs:

**1. Export button** (next to Copy button):
```html
<button class="export-btn" onclick="exportForDash()">📊 Export for Dashboard</button>
```

**2. exportForDash() function** — replace placeholders per app:
```javascript
function exportForDash() {
  var payload = {
    dept: 'ecom',           // 'ecom' | 'reserve' | 'itemprep' | 'receiving'
    shift: getShift(),
    date: new Date().toISOString().split('T')[0],
    exportedAt: Date.now(),
    units: /* team total */,
    goal: /* current goal */,
    tabs: [
      {label: 'Replenishment', units: /* replenTotal */},
      {label: 'Putaway', units: /* putawayTotal */}
    ],
    roster: loadRoster().filter(function(m){return m.enabled;}).length,
    version: '2.4'
  };
  var blob = new Blob([JSON.stringify(payload)], {type:'application/json'});
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'ecom_export.json';
  a.click();
}
```

**3. MegaDash card in Menu** — add after existing 4 cards:
```html
<button class="card card-megadash" onclick="openApp('MegaDash_v1.2.html')">
  <span class="card-version">v1.2</span>
  <div class="card-icon">📊</div>
  <div class="card-name">Shift Dashboard</div>
  <div class="card-sub">Cross-Dept &middot; Leadership</div>
</button>
```
CSS: `.card-megadash { border-color: #534AB7; }` etc.

---

## 13. Menu Patch Notes System

`Menu_v1.6.html` has a "What's new?" footer link that fetches `changelog.json` on click and renders the latest release in a floating panel. To add a new entry:

Edit `changelog.json` — prepend to the array:
```json
[
  {
    "version": "2.4",
    "date": "2026-06-23",
    "author": "dean.karim",
    "apps": [
      {
        "app": "Ecom",
        "changes": [
          "Dept tiles are now clickable — shows team breakdown and allows adding TMs to roster",
          "Shift summary reorganized into 3×2 grid"
        ]
      },
      {
        "app": "Reserve Stock",
        "changes": [
          "Full Report added — Pick F1, Pick F2, Replenishment, Putaway in one view",
          "Pick Floor 2 tab added"
        ]
      }
    ]
  },
  ...previous entries
]
```
Only supervisor-facing plain language — no technical implementation details.

---

## 14. GitHub Deployment

Push files to `main` branch → GitHub Pages redeploys automatically (~60 seconds).

**File size issue:** HTML files are ~95KB each which causes the GitHub MCP connector to time out on push. **Workaround:** drag-and-drop upload via GitHub web UI (`github.com/dkarim02/DC499-reports` → Add file → Upload files).

**`.gitignore`:** Currently named `gitignore` without the dot — Git isn't using it. Rename to `.gitignore` via GitHub web editor.

**localStorage + GitHub Pages:** Rosters persist across file updates because localStorage is keyed to the domain (`dkarim02.github.io`), not the file content. Never bump the storage key version unless you intentionally want to reset everyone's saved roster.

---

## 15. Versioning

- **Subversion** (v2.4 → v2.5): bug fixes, small features
- **Major** (v2.x → v3.0): new tab or major feature
- Update version in 3 places: Settings footer `<p class="nordstrom-tag">vX.X</p>`, Menu card badge `<span class="card-version">vX.X</span>`, Menu `openApp('Ecom_vX.X.html')`

---

## 16. Pending Work

- [ ] **Fix `renderFullReport` layout bug** (side panel + shift summary alignment) — see Section 2
- [ ] **Rename `gitignore` → `.gitignore`** in GitHub repo
- [ ] **Roster drag-and-drop** in each app's Settings tab (CSV/JSON, saves to localStorage, download button)
- [ ] **exportForDash() button** in all 4 dept apps for MegaDash integration
- [ ] **MegaDash card** added to Menu
- [ ] **Reserve Stock shift selector** (currently hardcoded 2nd shift)
- [ ] **Full Report expansion** to ItemPrep and Receiving (matching Ecom/Reserve pattern)
- [ ] **Power Automate** CSV export automation (blocked by Nordstrom Chrome group policy)
- [ ] **Shared OneDrive folder** auto-load path for MegaDash
- [ ] **Date filter toggle** — "today only" to prevent multi-day CSV inflation
