# DC499 Report Processor Suite — Developer Handoff Guide
**Last updated:** July 7, 2026  
**Original developer:** dean.karim (via Claude.ai Projects + Claude Code)  
**GitHub:** `github.com/dkarim02/DC499-reports` → `dkarim02.github.io/DC499-reports`

---

## 1. Current File Versions

| File | Version | Notes |
|---|---|---|
| `Menu_v1.6.html` | v1.6 | Points to all current dept versions |
| `Ecom_v2_5.html` | v2.5 | Full Report default, location filter, Push to Dashboard, disclaimer footer |
| `Reserve_v1_7.html` | v1.7 | Merged Picking tile, putaway units, shift selector, location filter, disclaimer |
| `ItemPrep_v2.0.html` | v2.0 | Full Report ported from Ecom — ILR + ConditionCode |
| `Receiving_v2.0.html` | v2.0 | Full Report ported from Ecom — LPN Receive by Container ID |
| `Changelog.html` | — | Reads from changelog.json |
| `changelog.json` | — | Source of truth for patch notes |
| `MegaDash_v1.2.html` | v1.2 | Built, not yet integrated — parked until live dashboard solved |

All files must be in the **same folder**. `index.html` redirects to `Menu_v1.6.html`.

**Note on filename convention:** Ecom and Reserve use underscores (`Ecom_v2_5.html`, `Reserve_v1_7.html`). ItemPrep and Receiving use dots (`ItemPrep_v2.0.html`, `Receiving_v2.0.html`). Menu `openApp()` calls must match exactly.

---

## 2. Architecture

**No build system** — pure HTML/CSS/JS, open in any browser. No npm, no bundler.

**External CDN (cloudflare):**
- PapaParse 5.4.1 — CSV parsing
- Chart.js 4.4.1 — charts

**localStorage keys:**
| App | Roster | Goals | Theme | Shift |
|---|---|---|---|---|
| Ecom | `sc_roster_2nd_v5` / `sc_roster_1st_v1` | `sc_goals_v1` | `dc499_ecom_theme_v1` | `ecom_shift_v1` |
| Reserve | `rs_roster_v1` | `rs_goals_v1` | `dc499_reserve_theme_v1` | `res_shift_v1` |
| ItemPrep | `ip_roster_2nd_v1` / `ip_roster_1st_v1` | `ip_goals_v1` | `dc499_itemprep_theme_v1` | — |
| Receiving | `recv_roster_v1` | `recv_goals_v1` | `dc499_receiving_theme_v1` | — |

> ⚠️ Bump storage key version (e.g. `v5` → `v6`) when changing default roster. localStorage is tied to domain — GitHub Pages URL stays the same across file updates so rosters persist.

---

## 3. Transaction IDs & Metrics

### Ecom v2.5

| Section | Transaction IDs | Metric |
|---|---|---|
| Replenishment | `iLPN Replen Fill`, `Retail iLPN Replen Pull`, `iLPN Replen Pull`, `iLPN Replen Fill Large`, `iLPN Replen Pull Large` | Sum `Completed Quantity` |
| Putaway | `System Directed Putaway`, `User Directed Putaway` | Count rows |
| Picking | `Ecom Mezz Pick To Putwall Cart`, `Ecom Non-Mezz Pick To Putwall Cart` | Sum `Quantity` |
| Packing | `NRDR CORE PACK FOR ECOM PACK STATION` | Sum `Quantity` |
| Shipping | `OB Putaway By Ship Via` | Sum `Quantity` |
| Sorting | `OB Sort To Putwall Cubby` + `Criteria = NRDR_SORT_TO_PUTWALL_CUBBIES_CRITERIA` | Sum `Quantity` |

### Reserve v1.7

| Section | Transaction IDs | Metric |
|---|---|---|
| Pick F1 | `Non Haz Retail Pick To oLPN Cart` | Sum `Quantity` |
| Pick F2 | `Non Haz Retail Pick To oLPN Cart Floor 2` | Sum `Quantity` |
| Replenishment | `iLPN Replen Fill`, `iLPN Replen Fill Large` | Sum `Completed Quantity` |
| Putaway | `System Directed Putaway`, `User Directed Putaway` | Sum `Completed Quantity` |

**Reserve Full Report shift summary:** Wide Picking tile spans both columns on top (F1+F2 combined). Replen and Putaway split the row below.

### ItemPrep v2.0

| Section | Transaction IDs | Metric |
|---|---|---|
| Item Level Receive | `Item Level Receive` | Sum `Quantity`, dedup by `Container ID` |
| Condition Code | `IlpnConditionCodeRemoval` | Sum `Quantity`, dedup by `Container ID` |

### Receiving v2.0

| Section | Transaction IDs | Metric |
|---|---|---|
| LPN Receive | `LPN Level Receive`, `Small Parcel LPN Level Receive` | Count unique `Container ID`s |

---

## 4. Location-Based Dept Filter — CRITICAL

**Applies to shared transaction IDs only:**
- `System Directed Putaway`
- `User Directed Putaway`
- `iLPN Replen Fill` / `iLPN Replen Fill Large`
- `iLPN Replen Pull` / `iLPN Replen Pull Large`
- `Retail iLPN Replen Pull`

**Location zone logic** (3rd character of location string):
- Zone `H` → **Reserve Stock**
- Any other zone → **Ecom**

**Priority:** Current Location wins. If blank, use Previous Location. If both blank, default to Ecom.

```javascript
const SHARED_TX = [
  'System Directed Putaway','User Directed Putaway',
  'iLPN Replen Fill','iLPN Replen Fill Large',
  'iLPN Replen Pull','iLPN Replen Pull Large','Retail iLPN Replen Pull'
];
function getLocationZone(loc) {
  if (!loc || loc.trim().length < 3) return null;
  return loc.trim()[2].toUpperCase();
}
function rowBelongsToEcom(r) {
  var txId = (r['Transaction ID'] || '').trim();
  if (SHARED_TX.indexOf(txId) === -1) return true; // not shared
  var curZone = getLocationZone(r['Current Location']);
  if (curZone !== null) return curZone !== 'H';
  var prevZone = getLocationZone(r['Previous Location']);
  if (prevZone !== null) return prevZone !== 'H';
  return true; // both blank — default Ecom
}
// Reserve uses rowBelongsToReserve() — same logic, H === true
```

**Location naming convention:**
- `P` = Pallet active location
- `R` = Reserve (contained iLPN) location  
- `F` = Shelf active location
- Format: `[P/R/F][floor][Zone][aisle/bay...]`
- Examples: `P1H0528A01` = pallet, floor 1, zone H (Reserve Stock)
- Ecom zones: A, B, C, D, E, F and others
- Reserve zones: H only (all floors)

**Applied in 3 places per file:** `processData()`, `addToFullReport()`, `renderSidePanel()`

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
  replen: 'Completed Quantity', putaway: null, // null = count rows
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
var _activeTile = null;
```

### Reserve Full Report Key Variables

```javascript
var RES_TX = {
  pick:    ['Non Haz Retail Pick To oLPN Cart'],
  pick2:   ['Non Haz Retail Pick To oLPN Cart Floor 2'],
  replen:  ['iLPN Replen Fill','iLPN Replen Fill Large'],
  putaway: ['System Directed Putaway','User Directed Putaway']
};
var RES_COLORS = {pick:'#0891B2', pick2:'#D97706', replen:'#6366F1', putaway:'#059669'};
var RES_LABELS = {pick:'Pick F1', pick2:'Pick F2', replen:'Replenishment', putaway:'Putaway'};
var RES_METRIC = {pick:'Quantity', pick2:'Quantity', replen:'Completed Quantity', putaway:'Completed Quantity'};
// Note: putaway switched from null (count) to 'Completed Quantity' (units) in v1.7
```

---

## 6. Full Report Render Order

All dept Full Reports render in this order:
1. Header + row count meta
2. **Shift Summary** — clickable dept tiles
   - Ecom: 3×2 grid (Replen, Putaway, Picking, Packing, Shipping, Sorting)
   - Reserve: Wide Picking tile top, Replen + Putaway row below
3. **Activity by Hour** — multi-line chart, smooth/spiky toggle
4. **Layout wrapper** — dept grid (left) + side panel (right, hidden until tile clicked)

---

## 7. Clickable Tile + Side Panel System

```javascript
function clickTile(typ) {
  var wrapper = document.getElementById('full-layout-wrapper');
  if (_activeTile === typ) {
    _activeTile = null;
    document.querySelectorAll('.full-tile').forEach(t => t.classList.remove('active'));
    var sp = document.getElementById('full-side-panel');
    if (sp) { sp.classList.remove('open'); sp.innerHTML = ''; }
    if (wrapper) wrapper.style.display = 'block'; // collapse
    drawFullChart();
    return;
  }
  _activeTile = typ;
  document.querySelectorAll('.full-tile').forEach(t => t.classList.toggle('active', t.dataset.typ === typ));
  if (wrapper) {
    wrapper.style.display = 'grid';
    wrapper.style.gridTemplateColumns = '1fr 280px';
    wrapper.style.gap = '14px';
    wrapper.style.alignItems = 'start';
  }
  renderSidePanel(typ);
  drawFullChart(typ);
}
```

**Side panel** splits associates into on-roster vs off-roster. On-roster TMs get Disable button, off-roster get Add button.

---

## 8. Dedup Strategy — CRITICAL

`addToFullReport(rows, fileName)` uses **cross-file-only dedup**:
- Key = `Employee + '|' + Transaction ID + '|' + Activity Datetime`
- Rows in **multiple files** → first occurrence kept
- Rows duplicated **within same file** → ALL kept (legitimate)
- Same filename dropped twice → blocked by `fullReportFiles` array

> ⚠️ **Never use CP Trace Id for dedup** — it is shared across multiple legitimate transactions and will silently drop valid rows.

---

## 9. Associate Performance Charts

Clicking any associate row expands an inline chart:
- Combined activity, **5-minute buckets**, only active buckets plotted
- **X-axis labels every 30 minutes** only
- **Red segments** where gap > 10 minutes
- **Tooltip on red points:** gap start, end, duration
- **Bottom right:** total gap time summed
- Charts stored in `assocCharts{}`, destroyed on collapse

---

## 10. Shift Selector

Ecom and Reserve both have a shift selector in Settings:
- **1st shift:** 3:00 AM – 1:45 PM, hour bounds 3–14
- **2nd shift:** 2:15 PM – 1:00 AM, hour bounds 14–25
- Saves to localStorage, updates chart time window, roster label, subtitle, and copy output
- `getShift()` / `setShift(shift)` functions used throughout

---

## 11. Fin Fcst PPH Values (from DC499 Headcount doc)

| Dept | Fin Fcst PPH |
|---|---|
| Replenishment | 111.6 |
| Putaway | 19.6 |
| Picking | 93.1 |
| Packing | 24.3 |
| Shipping | 245.9 |
| Sorting | 81.4 |

**Goal projection formula (not yet built):**
```
Active associates × 7.5 hrs × Fin Fcst PPH = Projected shift goal
```
- Shift start: 2:15 PM flat
- Transacting hours: 7.5 (8 hrs minus 30 min lunch)
- Projection cap: 10:45 PM
- If no goal set within first 2 hours → use actively transacting associates (not roster count)
- Non-transacting supervisors/trainers excluded automatically (don't appear in CSV)

---

## 12. Excel Dashboard Push (Ecom v2.5)

Push to Dashboard button in Full Report header. Uses Microsoft Graph API OAuth2 implicit flow.

**Target file:** `DC499-Dashboard.xlsx`
- Drive ID: `b!BqqqiF0owE6ponKYGHAiPz0HJdD8w7ZKgyhbu8iJ0WlSxRr3W4E1RIskB-MxqR9-`
- Item ID: `01DRZREETI3KCJ34LCMFHJ5TUMKY4QREIE`
- Location: DC499 Reporting → Excel folder on SharePoint/OneDrive

**Status:** Azure AD app registration pending IT approval. Auth popup will fire on first push once Client ID is configured.

**On first push:** Creates `EcomLog` sheet (running data log) and `Dashboard` sheet (colored tiles, formulas pulling latest row, disclaimer footer) automatically.

**Each subsequent push:** Appends one row to EcomLog — Dashboard updates via formulas.

---

## 13. Disclaimer Footer

All dept apps include this footer below the nordstrom-tag:
```html
<p class="nordstrom-tag" style="margin-top:4px;max-width:560px;margin-left:auto;margin-right:auto;line-height:1.5;">
  Disclaimer: This tool measures throughput only and may not be used to evaluate, coach, or hold team members accountable on performance.
</p>
```

---

## 14. Code Patterns

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
const DEFAULT_TEAM_2ND = [{email: 'user@nordstrom.com', enabled: true}];
// loadRoster fallback must NOT re-wrap objects
return defaults.map(function(m) { return {email: m.email, enabled: m.enabled}; });
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

---

## 15. GitHub Deployment

Push files to `main` branch → GitHub Pages redeploys automatically (~60 seconds).

**Git workflow (with Claude Code):**
```
git add .
git commit -m "descriptive message e.g. Ecom v2.6 — location filter, version bump"
git push
```

**File size:** HTML files are 85–115KB. GitHub MCP connector times out on files ~95KB+. Use Claude Code `git push` or GitHub web UI drag-and-drop for large files.

**localStorage + GitHub Pages:** Rosters persist across file updates because localStorage is keyed to the domain. Never bump storage key version unless intentionally resetting rosters.

---

## 16. Versioning

- **Patch** (v2.5 → v2.6): bug fixes, small features, logic changes
- **Minor** (v1.9 → v2.0): new major feature (Full Report expansion)
- Update version in 3 places: Settings footer `<p class="nordstrom-tag">vX.X</p>`, Menu card badge `<span class="card-version">vX.X</span>`, Menu `openApp('Ecom_vX_X.html')`

---

## 17. Pending Work

- [ ] **Ecom version bump to v2.6** — location filter was a meaningful data accuracy change
- [ ] **Remove individual Replen/Putaway tabs from Ecom** — Full Report is now standard view
- [ ] **PPH goal projection** in Ecom Full Report (formula and values documented in Section 11)
- [ ] **Roster drag-and-drop** in each app's Settings tab (CSV/JSON, saves to localStorage, download button)
- [ ] **Date filter toggle** — "today only" to prevent multi-day CSV inflation
- [ ] **Shift card / Teams post** — copyable shift summary card for Teams (UI designed, not built)
- [ ] **Teams Incoming Webhook** — post shift update to channel from Full Report button
- [ ] **Azure AD app registration** — IT ticket submitted for Graph API write access (Excel push)
- [ ] **MegaDash integration** — parked until live dashboard architecture resolved
- [ ] **Power Automate folder-watch + auto-push** — experimental, spec written
- [ ] **changelog.json** — update with all changes since v1.0 (after go-live)
- [ ] **CLAUDE.md** — project memory file for Claude Code sessions

---

## 18. Roadmap (from A3 Presentation)

1. **Stabilization** — consistent roster and dashboard structure ✅ largely done
2. **Expansion** — automate workflow using Power Automate (in progress)
3. **Enhancement** — weekly trackers to compare workflow over several shifts
4. **Scaling** — centralized hub across all departments
