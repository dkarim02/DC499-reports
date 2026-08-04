# SCOUT — Shift Centralized Output Utilization Tracker
## DC499 Reporter Suite — Claude Code Project Memory

This file is read automatically at the start of every Claude Code session. Do not delete it.

---

## Who I am

Dean Karim — Warehouse Trainer and 2nd Shift Supervisor, Nordstrom DC499. I built SCOUT using Claude.ai and Claude Code. This is my primary project. I manage ~25+ Ecom associates and work across Ecom, Reserve Stock, Item Prep, and Receiving departments.

---

## What this project is

SCOUT is a browser-based reporting suite deployed on GitHub Pages. It processes MAWM CSV exports and delivers real-time associate throughput visibility for warehouse supervisors. No backend, no build system — pure HTML/CSS/JS.

**GitHub:** dkarim02/DC499-reports
**Live site:** dkarim02.github.io/DC499-reports
**Local clone:** C:\Users\JLEO\OneDrive - Nordstrom\DC499 Reporter

---

## Current file versions

| File | Version |
|---|---|
| Menu_v1.6.html | v1.7 |
| Ecom_v3.html | v3.0 (Live tab active) |
| Reserve_v1_7.html | v1.7 |
| ItemPrep_v2.0.html | v2.0 |
| Receiving_v2.0.html | v2.0 |
| Receiving_live.html | v1.2 |
| Totes_live.html | v1.0 |
| Batches_live.html | v1.0 |
| Backlog_live.html | v1.0 |
| receiving_live_agent.ps1 | current |
| EOS_live.html | v1.0 |
| eos_agent.js | current |
| eos.bat | current |
| dc499.bat | current |
| scout_ecom_agent.js | current |
| ecom_live.json | written by scout_ecom_agent.js |
| dc499_refresh.js | current |
| dc499_watchdog.ps1 | current |
| dc499_watchdog_setup.bat | current |
| dc499-nail-the-plan 29.html | v29 |

---

## Architecture rules — always follow these

**Dedup key:** Employee + Transaction ID + Activity Datetime. NEVER use CP Trace Id.

**Location filter (shared TX IDs only):**
- Zone H (3rd character of location string) = Reserve Stock
- Any other zone = Ecom
- Check Current Location first, Previous Location as fallback, default Ecom if both blank
- Applies to: System/User Directed Putaway, iLPN Replen Fill/Pull variants
- Must be applied in processData(), addToFullReport(), AND renderSidePanel()

**Roster format:** Always objects `{email, enabled}` — never plain strings.

**onclick with dynamic keys:** Always use `data-empkey` dataset attribute — never inline quotes.

**Putaway metric (Reserve):** Completed Quantity (units) not row count — changed in v1.7.

**Sorting filter:** Requires BOTH Transaction ID AND Criteria = NRDR_SORT_TO_PUTWALL_CUBBIES_CRITERIA.

**Version bumps — always update 3 places:**
1. HTML title tag
2. Settings footer nordstrom-tag paragraph
3. Menu card badge + openApp() filename

**Git push pattern (agent script):**
```
git stash
git pull --rebase origin main
git stash pop
git add receiving_live.json
git commit -m "message"
git push origin main
```

---

## Transaction IDs by dept

**Ecom:**
- Replen: iLPN Replen Fill, Retail iLPN Replen Pull, iLPN Replen Pull, iLPN Replen Fill Large, iLPN Replen Pull Large → Sum Completed Quantity
- Putaway: System Directed Putaway, User Directed Putaway → Count rows
- Picking: Ecom Mezz Pick To Putwall Cart, Ecom Non-Mezz Pick To Putwall Cart → Sum Quantity
- Packing: NRDR CORE PACK FOR ECOM PACK STATION → Sum Quantity
- Shipping (2nd shift): OB Putaway By Ship Via → Sum Quantity, dedup by Container ID
- Shipping (1st shift): OB Putaway By Ship Via OR NRDR Load Parcel Packages → Sum Quantity, dedup by Container ID
- Sorting: OB Sort To Putwall Cubby + Criteria filter → Sum Quantity

**Reserve:**
- Pick F1: Non Haz Retail Pick To oLPN Cart → Sum Quantity
- Pick F2: Non Haz Retail Pick To oLPN Cart Floor 2 → Sum Quantity
- Replen: iLPN Replen Fill, iLPN Replen Fill Large → Sum Completed Quantity
- Putaway: System Directed Putaway, User Directed Putaway → Sum Completed Quantity

**ItemPrep:**
- Item Level Receive → Sum Quantity, dedup by Container ID
- IlpnConditionCodeRemoval → Sum Quantity, dedup by Container ID

**Receiving (CSV):**
- LPN Level Receive, Small Parcel LPN Level Receive → Count unique Container IDs

---

## PPH projection (Ecom v2.9)

- Shift start: 2:15 PM, cap: 10:45 PM, 8 productive hours
- Lunch: 30 min deducted after 6:15 PM
- Headcount: from Settings dept headcount fields (ecom_headcount_v1 localStorage)
- PPH values: from Settings PPH submenu (ecom_pph_v1 localStorage)
- Defaults: Replen 111.6, Putaway 19.6, Picking 93.1, Packing 24.3, Shipping 245.9, Sorting 81.4
- On pace: current units >= projected units at this point in shift

---

## MAWM database (Claude Code MCP connector)

**Connector:** mawm-data-http-prod
**Auth:** OIDC SSO — Dean.Karim@nordstrom.com
**Access:** Read-only, production data, audit-logged
**Facility ID:** Always '499' — never '0499'
**PII policy:** LIKE queries on CREATED_BY are blocked — use exact email match only

**Key tables:**
- Receiving associate productivity → default_receiving.RCV_RECEIPT (not RCV_LPN)
- ASN lifecycle / dock timing → default_receiving.RCV_ASN
- Wave progress → default_dcorder.DCO_WAVE_AGGREGATE_ORDER
- Task lifecycle → default_task.TSK_TASK
- Labor productivity → default_lmcore.LMC_THROUGHPUT (verify table name)
- Clock in/out → default_timeclock (not yet explored)

**Critical finding:** LPN Level Receive data is in RCV_RECEIPT not RCV_LPN. RCV_LPN stores the LPN record created by system-msg-user, RCV_RECEIPT stores the associate scan.

**Critical finding:** All MAWM timestamps are stored in UTC. DC499 is PDT (UTC-7). Always convert shift times before using in queries. Helper: `new Date(pdtStr.replace(' ','T') + '-07:00').toISOString().slice(0,19).replace('T',' ')`. Shift start 2:15 PM PDT = '2026-07-25 21:15:00' UTC.

**Batch table:** default_workrelease.WR_BATCH — work release pools (up to 120 orders). One WORK_RELEASE_BATCH_ID contains multiple rows, each with a distinct BATCH_ID (e.g. B_0000016279472) and CONTEXT_ID. Each BATCH_ID = one putwall's batch. WORK_RELEASE_BATCH_ID is the wave-run ID; BATCH_ID is the per-putwall sub-batch.

---

## dc499_refresh.js — Live server agent

**Entry point:** dc499.bat (ALWAYS use dc499.bat, never node directly)
**Options in dc499.bat:**
1. Refresh data only (one-shot)
2. Start live server on :3001
3. Start live server + open Receiving Live
4. First-time auth / re-auth
5. Ecom Live — one-shot refresh (runs scout_ecom_agent.js)
6. Ecom Live — auto-refresh every 5 min (--serve --interval=5)
7. Ecom Live — auth

**Auth / token expiry handling:**
- `AUTH_PIN = '020405'` — anyone can hit `localhost:3001/auth?pin=020405` to trigger re-auth without the server PC password
- `getAccessTokenSilent()` tries primary then backup refresh token file automatically
- On AuthError during serve loop: auto-launches `doAuthFlow()` (opens Chrome) + sends Teams notification
- `TEAMS_WEBHOOK_AUTH_ALERT` = `workflows/db4396647efa46f783e0ed9a5d09e32f...` (auth expiry channel)
- Teams card instructs: switch user → open Chrome → go to localhost:3001/auth?pin=020405
- `reauthing` flag prevents multiple browser tabs; `authNotified` flag prevents repeated Teams pings

**Output JSON files written by dc499_refresh.js:**
- `batch_status.json` — batch report for Batches_live.html
- `backlog_live.json` — order backlog for Backlog_live.html
- `totes_live.json` — putwall tote counts for Totes_live.html
- `dock_live.json` — dock/receiving activity
- `receiving_live.json` — receiving live data (also pushed to GitHub by receiving_live_agent.ps1)

**batch_status.json structure:**
```json
{
  "generated": "...",
  "facility": "499",
  "shift_label": "1st shift" | "2nd shift",
  "shift_start_utc": "...",
  "summary": { "total_batches", "cleared_batches", "active_batches", "avg_mins_to_clear", "avg_release_interval_mins" },
  "batches": [
    {
      "batch_num", "batch_id", "work_release_batch_id",
      "total_orders", "total_olpns", "total_tasks", "total_task_details",
      "status_code", "status_label",
      "released_pdt", "cleared_pdt",
      "mins_to_clear", "is_cleared", "mins_since_prev_release"
    }
  ]
}
```

**Shift auto-detection in fetchBatchStatus():**
- 1st shift: `nowUtcHour >= 10 && nowUtcHour < 21` (3 AM–1:59 PM PDT, safe OT cutoff)
- 2nd shift: all other hours (2 PM–2:59 AM PDT)
- 1st shift start UTC = 10:00, 2nd shift start UTC = 21:00
- `shift_label` written to JSON and used by HTML pages for Teams card headers

**Carryover batches (1st-shift batches still active at 2nd shift start):**
- 14-hour lookback arm in SQL: `OR (STATUS_ID != 5800 AND CREATED_TIMESTAMP >= '{lookbackStart}')`
- Ensures 1st-shift batches not yet cleared appear in 2nd shift's active list

---

## Watchdog (dc499_watchdog.ps1 / dc499_watchdog_setup.bat)

- Runs every 30 min as a Windows Scheduled Task (no admin required)
- Checks for node.exe process with `*dc499_refresh*` in command line
- If not running: launches a new visible cmd window with `--serve` flag
- Log: `dc499_watchdog.log` (trimmed to 500 lines)
- Setup: run `dc499_watchdog_setup.bat` once to register the scheduled task
- **Lock the PC (Win+L) before leaving — do NOT log out** or the task won't run

---

## Batches_live.html and Backlog_live.html — Themes

Both pages share the same theme system. Theme key stored in localStorage.

**Theme values:** `dark`, `solid`, `pastel`, `starr`, `light`
- `starr` = pink glamour theme (named after Dean's boss). CSS selector: `[data-theme="starr"]`
- All theme vars use CSS custom properties on `[data-theme]` attribute

**THEME_VALS and THEME_NAMES arrays** must be updated in sync with the CSS and dropdown HTML when adding/renaming themes.

---

## Batches_live.html — Teams webhook (Send to Teams)

**Webhook var:** `TEAMS_WEBHOOK_BATCHES` at top of script block
**Trigger:** Manual "Send to Teams" button → opens batch picker modal → sends selected batches as Adaptive Card
**Auto-notify:** `notifyNewCleared()` in dc499_refresh.js fires when batches transition to cleared status
**Card format:** Per-batch rows with ColumnSet layout (batch #, orders, time cleared), `style:'attention'` header container
**shiftLabel** in card header: read from `lastData.shift_label` (Batches) or `lastBtData.shift_label` (Backlog)
**No emoji in card text** — emoji only in theme picker dropdown label (Starr ⭐)

**Backlog_live.html — Send dropdown:**
- "Send to Teams" and "EOD Email" are combined into a single expandable "↑ Send" dropdown (same pattern as theme picker)
- Dropdown ID: `send-picker`. Click-outside handler closes both `theme-picker` and `send-picker`
- `sendToTeams(btn)` — btn may be a `<div>` not `<button>`, guard: `if(btn.disabled!==undefined) btn.disabled=true`

**Backlog_live.html — Bridge card:**
- Units/Hour sidebar widget renamed to "Bridge" (`id="hourly-title"`)
- Displays as a column (two stacked sub-tables side by side) not a single row

---

## Putwall → batch mapping research (INCONCLUSIVE as of 2026-07-25)

Goal: show which putwall (S1-PW-01 through S1-PW-08) each WR_BATCH BATCH_ID is assigned to.

**What we found:**
- `WR_RESOURCE_GROUP` has 8 rows with unique CONTEXT_IDs, one per putwall (S1-PW-01..08), DESCRIPTION = "ECOM PUTWALL SORTER N"
- `WR_BATCH.CONTEXT_ID` is unique per putwall (same CONTEXT_ID = same putwall) but in a different namespace — does NOT match WR_RESOURCE_GROUP CONTEXT_IDs
- `default_pickpack.TSK_TASK_DETAIL` has `RESOURCE_BATCH_ID` (= WR_BATCH.BATCH_ID) and `RESOURCE_GROUP_ID` (= S1-PW-01..08) — this IS the correct join table
- However on 2026-07-25, ALL batches returned S1-PW-01 for RESOURCE_GROUP_ID — possibly only PW1 was genuinely active that shift, or RESOURCE_GROUP_ID is only set for certain batch types

**Verified join path:**
```sql
SELECT DISTINCT td.RESOURCE_BATCH_ID, td.RESOURCE_GROUP_ID
FROM default_pickpack.TSK_TASK_DETAIL td
WHERE td.FACILITY_ID = '499'
AND td.CREATED_TIMESTAMP >= '{shiftStartUtc}'
AND td.RESOURCE_BATCH_ID IS NOT NULL
AND td.RESOURCE_GROUP_ID IS NOT NULL
```
Then join on `WR_BATCH.BATCH_ID = td.RESOURCE_BATCH_ID`.

**Tables that do NOT work for this:**
- WR_BATCH.CONTEXT_ID → WR_RESOURCE_GROUP.CONTEXT_ID: namespaces don't match
- TSK_TASK.WORK_RELEASE_BATCH_ID → putwall: times out or returns nothing
- DCO_ORDER_LINE.RESOURCE_GROUP_ID: only S1-PW-01 ever appears, very sparse
- WR_WORK, WR_ALLOCATION, WR_WORK_RELEASE_RUN_DETAIL: empty tables (config only)
- PPK_BATCH_PRINT_HEADER.PRINTER_LOCATION_ID: no rows for facility 499

**Next step:** Verify on a shift with multiple putwalls active. If TSK_TASK_DETAIL.RESOURCE_GROUP_ID shows multiple values that day, the join is correct and can be added to batch_status.json output.

---

## Live receiving agent

**Script:** receiving_live_agent.ps1
**Query table:** default_receiving.RCV_RECEIPT
**Metric:** COUNT(DISTINCT LPN_ID) per associate
**Filter:** FACILITY_ID = '499', DATE = CURDATE(), TIME >= '12:00:00', exclude system-msg-user
**Loop interval:** 60 minutes (configurable via $INTERVAL)
**Run once:** .\receiving_live_agent.ps1 -RunOnce
**Output:** receiving_live.json → committed and pushed to GitHub each cycle

---

## EOS (End of Shift) Report system

### Files
- **eos_agent.js** — Node.js agent, queries MAWM via MCP HTTP connector, writes JSON files
- **eos.bat** — Bat launcher for eos_agent.js. ALWAYS use eos.bat to run EOS tasks, never node directly or an agent tool
- **EOS_live.html** — Browser report page, loads eos_report.json (falls back to eos_sos_snapshot.json)

### How to run (eos.bat options)
1. **Option 1 — SOS snapshot**: Run at 2:10 PM. Captures live state, writes eos_sos_snapshot.json
2. **Option 2 — EOS + finalize**: Run at shift end. Captures EOS state, merges with SOS, writes eos_report.json
3. **Option 3 — Reconstruct SOS**: If you missed option 1. Prompts for anchor time (default 2:10 PM). Reconstructs task/wave/batch state from timestamps
4. **Option 4 — Auth**: First-time OAuth login only

### JSON files
- **eos_sos_snapshot.json** — written by option 1 or 3
- **eos_report.json** — written by option 2, contains { sos, eos } objects. HTML loads this first

### Timezone — CRITICAL
MAWM stores ALL timestamps in UTC. PDT = UTC-7.
- Shift start 2:15 PM PDT = 21:15 UTC
- All query filters use pdtToUtc() helper to convert before sending to DB
- Never use raw PDT times (e.g. '14:15:00') in MAWM queries

### Key MAWM tables for EOS
| Metric | Table | Notes |
|---|---|---|
| Open orders / not released | default_dcorder.DCO_ORDER | MAXIMUM_STATUS = '1000', cap at EOS time |
| Open units | default_dcorder.DCO_ORDER_LINE | Today only filter |
| Hospital orders | default_pickpack.PPK_OLPN | CURRENT_LOCATION_ID LIKE 'H1-PW-01%' |
| Packed not shipped | default_pickpack.PPK_OLPN | STATUS = '7200' |
| Loaded virtually | default_pickpack.PPK_OLPN | STATUS IN ('7800','8000') since shiftStart |
| Pick / Replen / Putaway tasks | default_task.TSK_TASK | TYPE_ID IN ('PICK/PACK','REPLENISHMENT','PUTAWAY') |
| **Waves** | default_dcorder.DCO_ORDER_PLAN_RUN_STRATEGY | Planning runs — count by type |
| **Batches** | default_workrelease.WR_BATCH | Work release pools (up to 120 orders each, one per putwall). STATUS 5800 = cleared, 5600 = in queue |
| Avg batch release interval | default_workrelease.WR_BATCH | LAG() on CREATED_TIMESTAMP |

**Waves ≠ Batches.** Waves = planner runs that select and release orders (DCO_ORDER_PLAN_RUN_STRATEGY). Batches = work-release pools sent to putwalls (WR_BATCH). These are different tables and different concepts.

### Task status codes (TSK_TASK)
- Open: 3000 (queued), 5000 (assigned), 7000 (in progress)
- Done: 8000 (completed)
- Cancelled: 9000 — exclude from done count
- OBPUTAWAY type = system-driven outbound putaway, not associate work — exclude

### WR_BATCH status codes
- 5000 = Released (tasks created, picking not started)
- 5200 = Picking Started
- 5400 = Picking Completed
- 5600 = In Queue (waiting for sort)
- 5800 = Cleared (fully sorted and packed)

### Orders not released definition
Orders that existed during the shift but never progressed past MAXIMUM_STATUS = '1000' by EOS.
Filter: `MAXIMUM_STATUS = '1000' AND CREATED_TIMESTAMP < '{eosTime}'`
Do NOT count all current '1000' orders — that includes fresh inbound from customers.

### What can / cannot be reconstructed (option 3)
- **CAN reconstruct:** pick/replen/putaway tasks (ACTUAL_END_TIME), waves (CREATED_TIMESTAMP), batches (CREATED_TIMESTAMP), orders not released (CREATED_TIMESTAMP)
- **CANNOT reconstruct:** open_orders, open_units, hospital_orders, packed_not_shipped, loaded_virtually — these are current-state only, shown as null on reconstructed SOS

### EOS_live.html features
- Always renders even with no data (manual entry mode for all fields)
- Manual fields: Batch Criteria Not Met, Shipping Status, Line Capacity, Cross-Training, Pallet IDs (notes), per-section Notes textareas
- **Export for Email** button: generates inline-HTML report matching the EOS CSV format, copy-paste into Outlook/Gmail
- Print / PDF button
- Amber color scheme, dark theme
- Two-column email export layout: Orders/Picking/Packing left, Sorting/Shipping/Stock Control right, Waves full-width

### EOS button in Ecom_v3.html
Amber pill button in top-right column, opens EOS_live.html in new tab via openEOS().

---

## EOD Email export (Backlog_live.html)

**Trigger:** Send dropdown → "EOD Email" → opens modal with preview + Copy HTML button
**Paste target:** Outlook new message body (Ctrl+V after copy)
**Content:** Header → backlog tiles → order breakdown by date → Bridge (2-col) → waves → batch summary + active/queued + cleared tables → retail replen → footer

**Outlook compatibility rules (hard-learned):**
- Use `width="600"` HTML attribute on outer table — `max-width` CSS is ignored by Outlook
- Every `<td>`/`<th>` needs `bgcolor="#hex"` attribute alongside `background:` CSS — Outlook dark mode inverts CSS backgrounds but respects the HTML attribute
- `addBgcolor()` post-pass injects `bgcolor=` automatically from each cell's `background:` style value
- Dark palette (`#13172b` bg, `#1b2035`/`#232840` cells) matches the screen look and renders correctly with `bgcolor` attrs in place

**`exportEodEmail()` reads from:** `lastBlData`, `lastBtData`, `lastRrData`
**`copyEodHtml()` reads from:** `eod-preview` innerHTML (already has bgcolor injected)

---

## Teams webhooks

All pages now fully shift-aware. 1st shift webhook URL obtained and wired in everywhere.

| File | 1st shift | 2nd shift |
|---|---|---|
| Ecom_v3.html | ✅ | ✅ |
| Batches_live.html | ✅ | ✅ |
| Backlog_live.html — Orders tab | ✅ | ✅ |
| Backlog_live.html — Batches tab | ✅ | ✅ |
| dc499_refresh.js auto-notify | ✅ | ✅ |
| dc499_refresh.js auth expiry alert | ✅ (single channel) | ✅ |

**1st shift webhook (all pages):** `workflows/a26c40b1c9ee4739abd0269aedbef04b`
**2nd shift webhook (all pages):** `workflows/d4415440c8004523a34336a1a21e6dae` (batches) / `workflows/eacd8206a4274abb96f43be9d3d01256` (Ecom/Backlog orders)
**Auth expiry alert webhook:** `workflows/db4396647efa46f783e0ed9a5d09e32f...` (TEAMS_WEBHOOK_AUTH_ALERT in dc499_refresh.js)
- Routing: `getShift()` reads local PDT hour — 1st = 6AM–2PM, 2nd = 2PM–10PM

---

## Disclaimer (required on all dept apps)

```
Disclaimer: This tool measures throughput only and may not be used to evaluate, coach, or hold team members accountable on performance.
```

---

## Remi sprite system

Animated MP4 sprite (`remi.mp4`) that runs along the top of the Next Batch progress bar.

**Files using Remi:** Batches_live.html (`#remi`), Backlog_live.html (`#bl-remi`, `#bl-remi2`)
**CSS:** `mix-blend-mode:multiply` removes white background on all themes. `clip-path:inset(4px 6px 6px 6px)` crops tight to the character.
**Animation:** `requestAnimationFrame` bounce loop. Speed = 45px/s. `scaleX(-1)` flips on direction change.
**Positioning:** `left = rect.left - CLIP + x`, `top = rect.top - H + offset`. Bounds: `x=0` to `x = rect.width - (W - CLIP)` so visible edges align exactly with bar edges.
**Toggle:** Theme dropdown in Backlog_live.html has a "Rem" pill toggle. Persists to `dc499_remi_enabled_v1` localStorage. Guards in `getPill()` / `getCard()` check `remiEnabled` before showing.
**Critical:** Video elements must be in DOM BEFORE the `<script>` block or `getElementById` returns null and the loop dies silently.
**bl-remi2** runs on the Active & Queued card (`bt-batch-card-active`) in Backlog's Batches tab.

---

## Wave labels (dc499_refresh.js)

Real `PLANNING_STRATEGY_ID` values from DCO_ORDER_PLAN_RUN_STRATEGY (verified 2026-07-27):

| PLANNING_STRATEGY_ID | CHASE_MODE | Label |
|---|---|---|
| NRDR_CORE_ECOM_ORDER_PLANNING_STRATEGY | CHASE_DISABLED | Ecom |
| NRDR_NEW_PIPELINE_CHASE_ORDER_PLANNING_STRATEGY | CHASE_ENABLED | Multi Chase |
| NRDR_NEW_PIPELINE_CHASE_ORDER_PLANNING_STRATEGY | CHASE_ONLY | Single Chase |
| SINGLE_CHASE_ORDER_PLANNING_STRATEGY | CHASE_ONLY | Single Chase |
| MULTI_CHASE_ORDER_PLANNING_STRATEGY | CHASE_ENABLED | Multi Chase |
| NRDR_CORE_REPLEN_ORDER_PLANNING_STRATEGY | CHASE_DISABLED | Replen |
| NRDR_CORE_RETAIL_ORDER_PLANNING_STRATEGY | any | **omitted** (not counted) |

Wave shift start: 2nd shift = 20:40 UTC (1:40 PM PDT). 1st shift = 10:00 UTC (3:00 AM PDT).
`fetchReceiving()` shift start: 2nd = 21:00 UTC (2:00 PM PDT), 1st = 13:00 UTC (6:00 AM PDT) — now shift-aware.

---

## Condition codes research (2026-07-30, CONCLUDED — NOT BUILDABLE)

**Goal was:** Tab in Backlog_live.html showing items with QL/EX/PP/QA condition codes in active floor (F1A/F1B/F2C/P1C/F1D) and reserve (R1B-R1F) locations.

**What we tried:**
- `DCI_CONTAINER_CONDITION` joined to `DCI_INVENTORY` — returns 0 rows for QL in active locations even when MA shows units with QL at those locations
- `DCI_INVENTORY.PRODUCT_STATUS_ID` — null on all sampled rows in active locations
- `DCI_INVENTORY_ATTRIBUTES` — no rows for sampled inventory IDs
- `DCI_ILPN`, `DCI_CONDITION_CODE` — tables not accessible (operation failed errors)

**Root cause:** MA's "Location Inventory" screen shows condition codes that are not stored in any table accessible via this MCP connector. The condition code visible in MA likely comes from a layer not exposed here.

**Decision:** Tab removed. Do not attempt to rebuild until a new data source is identified.

---

## Backlog_live.html — fetchBacklog() fixes (2026-07-30)

**Problem 1 — lookback too short:** Was only looking back 2 days. Fixed to 7 days.

**Problem 2 — DATE() returns JS Date object via MCP:** `DATE(CONVERT_TZ(...))` came back as a JS Date object, not a string. `.slice(0,10)` on it produced garbage keys so all buckets were empty. Fix: use `DATE_FORMAT(CONVERT_TZ(CREATED_TIMESTAMP, '+00:00', '-07:00'), '%Y-%m-%d')` to get a plain string, plus `String()` coercion before slicing.

**Problem 3 — RELEASED status dropped:** Switch statement had no case for 'RELEASED'. Fix: `case 'RELEASED': b.ready += n;` fallthrough — RELEASED counts as READY.

**SQL pattern to always use for PDT date bucketing:**
```sql
DATE_FORMAT(CONVERT_TZ(CREATED_TIMESTAMP, '+00:00', '-07:00'), '%Y-%m-%d') AS line_date
```

---

## Ready for Pack tile — Backlog_live.html (2026-07-30, COMPLETE)

**Tile:** Amber/teal metric tile between Allocated and Packed in the Backlog metrics row.
**Label:** "Ready for Pack" | Sub-label: "Units at D1-SN-01"
**Color:** `--rfp` CSS variable (teal, distinct from Allocated's orange `--alloc`) — defined per theme.

**Data source:** `default_dcinventory.DCI_ILPN` joined to `default_dcinventory.DCI_INVENTORY`
```sql
SELECT SUM(inv.ON_HAND) AS unit_count
FROM default_dcinventory.DCI_ILPN ilpn
JOIN default_dcinventory.DCI_INVENTORY inv ON inv.ILPN_ID = ilpn.ILPN_ID AND inv.FACILITY_ID = ilpn.FACILITY_ID
WHERE ilpn.FACILITY_ID = '499'
  AND ilpn.CURRENT_LOCATION_ID = 'D1-SN-01'
  AND ilpn.STATUS = '5000'
```

**Key findings from research:**
- D1-SN-01 = staging/induction location where picked carts are staged before pack station
- `DCI_ILPN.STATUS = '5000'` = "Allocated" in MA's UI (fully allocated). STATUS 3000 = Not Allocated, 4000 = Partially Allocated
- `DCI_INVENTORY` has multiple rows per iLPN — never use `SUM(ON_HAND)` directly on it without joining to DCI_ILPN first, or you get overcounting. Always join and filter by iLPN status.
- `COUNT(*)` on DCI_ILPN gives LPN count (~295); `SUM(inv.ON_HAND)` via join gives unit count (~1,151)
- `rfp_units` field written to `backlog_live.json` by `fetchBacklog()` in dc499_refresh.js

---

## TSK_TASK_DETAIL — query limitation (2026-07-30)

**Finding:** Any query on `default_task.TSK_TASK_DETAIL` that uses a subquery or broad filter times out after 30 seconds. Even filtering by `SOURCE_LOCATION_ID LIKE 'F1%'` times out. The table is too large to query without a very specific TASK_ID filter.

**Implication:** Cannot use TSK_TASK_DETAIL for batch detail counts in the refresh cycle. If detail counts are needed in future, must query by exact TASK_ID list passed in separately, not as a subquery.

---

## Packed Not Shipped — research (2026-07-27, IN PROGRESS)

**Goal:** New live report showing oLPNs that are packed but not yet loaded/shipped — visibility into shipping backlog.

**Table:** `default_pickpack.PPK_OLPN` — same table used by EOS
**Key field:** `STATUS = '7200'` = packed, not shipped

**Status codes verified:**
- 1000 = created/allocated
- 7100 = packing started
- 7200 = **packed, not shipped** ← target
- 7600 = manifested (carrier label printed)
- 7800 = loaded virtually
- 8000 = shipped/loaded
- 9000 = cancelled

**What we know from tonight's data (2nd shift 2026-07-27):**
- 6,524 oLPNs at STATUS 7200 this shift — significant backlog
- `CURRENT_LOCATION_ID` shows where each packed box is sitting: `P1-OB-010xxx` = outbound dock door locations, `L1IB00x01` = inbound locations (odd — may be misrouted), numeric values (2, 5, 6, etc.) = unknown location type, null = location not set
- `CARRIER_ID` is null on all sampled 7200 rows — carrier not assigned at pack time, likely assigned at manifest (7600)
- `TRACKING_NUMBER` column exists — populated at manifest step
- `LOADED_DATE_TIME` column exists — populated when loaded to trailer
- `SCHEDULED_SHIP_DATE_TIME` column exists — may be useful for cutoff visibility

**Questions to answer before building:**
1. What does the report need to show? Options: total count, count by door/location, age of oldest box, by carrier, by order?
2. Should it be a live page (auto-refreshing via dc499.bat) or a standalone query tool?
3. What's "too long" — at what age does a packed box become a concern worth flagging?
4. Are the numeric CURRENT_LOCATION_IDs (2, 5, 13, 25 etc.) dock door numbers? Need to verify with floor knowledge.
5. Is `P1OB02A001` etc. a staging area vs `P1-OB-010xxx` a specific door? Pattern differs — worth investigating.
6. Should this filter to Ecom only, or include Reserve/Retail?

**Likely dc499.bat integration:** Add `fetchPackedNotShipped()` to dc499_refresh.js, write to `packed_not_shipped.json`, build `PackedNotShipped_live.html`.

---

## Ecom Live tab (scout_ecom_agent.js)

**What it is:** A second tab in Ecom_v3.html backed by MAWM direct queries instead of CSV uploads. Supplement to the Full Report — eventually a replacement.

**Agent:** `scout_ecom_agent.js` — Node.js, same OAuth pattern as dc499_refresh.js. ALWAYS launch via dc499.bat options 5/6/7, never node directly.

**Output:** `ecom_live.json` — written locally and pushed to GitHub each cycle.

**ecom_live.json structure:**
```json
{
  "generated": "ISO timestamp",
  "shift": "1st" | "2nd",
  "shift_start": "UTC datetime",
  "facility": "499",
  "row_count": 12492,
  "truncated": false,
  "rows": [ { CSV-compatible column names } ]
}
```

**Row columns (aliased to CSV names):** Employee, Transaction ID, Activity Datetime, Quantity, Completed Quantity, CP Trace Id, Container ID, Current Location, Previous Location, Criteria

**Query table:** `default_task.TSK_ACTIVITY_TRACKING` — scan-level, one row per item scan. CREATED_TIMESTAMP is indexed (use for WHERE); ACTIVITY_DATE_TIME is not.

**Three query groups (to stay under MCP ~10k row cap):**
- Group A: replen + putaway (iLPN Replen Fill/Pull variants, System/User Directed Putaway)
- Group B: picking + shipping + sorting (Ecom Mezz/Non-Mezz Pick, OB Putaway By Ship Via, NRDR Load Parcel Packages, OB Sort To Putwall Cubby)
- Group C: packing alone (NRDR CORE PACK FOR ECOM PACK STATION) — split out because packing alone generates ~2,700 rows

**Truncation warning:** `truncated: true` written to JSON if any group hits 9,500 rows. Live tab meta line turns amber. If a group needs further splitting, add a Group D.

**Shift start times (UTC):**
- 2nd shift: 21:10 UTC (2:10 PM PDT)
- 1st shift: 10:00 UTC (3:00 AM PDT)
- Boundary: `is1st = h >= 10 && h < 21`

**Missing TX type found 2026-07-31:** `Returns System Directed Putaway` — 43 rows, not in any group yet. Decision pending: does it count toward Putaway or excluded?

**Live tab features:**
- Summary tiles — clickable, expand per-dept associate table below
- PPH pace bars on each tile — same `getTilePace()` as Full Report, reads Settings headcount + PPH targets
- Enabled/Inactive separator in associate tables — only roster members shown; non-roster omitted
- Send to Teams button — same Adaptive Card as Full Report, includes data timestamp
- NAIL button — writes to same `ntp_dc499_v1` localStorage key as Full Report NAIL
- Refresh button — re-fetches ecom_live.json from GitHub Pages or localhost:3001
- Tab order — draggable, persisted to `ecom_tab_order_v1` localStorage
- Active tab — persisted to `ecom_active_tab_v1` localStorage, restored on page load

**Dedup behavior (Live vs Full Report):**
- Full Report: cross-file-only dedup — within-file duplicates kept (legitimate same-second scans)
- Live: no dedup needed — MAWM TSK_ACTIVITY_TRACKING stores one row per scan; no within-file duplicates
- Live row counts will be slightly higher than CSV late in shift (CSV exported mid-shift misses later scans)

**Accuracy notes verified 2026-07-31:**
- Packing: MAWM 2,658 rows vs CSV 2,543 — gap is mid-shift CSV export, not a bug
- Shipping: MAWM 1,701 rows / 2,539 qty vs CSV 1,570 / 2,337 — same reason
- No pre-shift rows found (CREATED_TIMESTAMP filter at 21:10 UTC is clean for packing)

---

## Lost Tote Lookup — brainstorm (2026-07-31, NOT YET BUILT)

**Problem:** When a tote is lost, supervisor must look up: tote ID → order/destination → items → where to repick each item.

**Requires PC server (Path A):** On-demand query from browser — type tote ID, get back order + items + floor locations in ~2s. Best architecture. Key IT talking point.

**Tables to explore:**
- `default_pickpack.PPK_OLPN` — tote record, status, last known location, order ID
- `PPK_OLPN_DETAIL` or order line table — items/SKUs in tote (needs verification)
- `default_dcinventory.DCI_ILPN` + `DCI_INVENTORY` — floor locations with available inventory for repick

**Status:** MAWM table structure not yet verified for this use case. Next step: probe PPK_OLPN_DETAIL schema and confirm repick location join.

---

## PWA / iPad app — brainstorm (2026-07-31, NOT YET BUILT)

**Easiest path:** PWA (Progressive Web App) — add manifest.json + service worker to existing pages. On iPad: Safari → Share → Add to Home Screen → launches full-screen like native app. No App Store, no Apple Developer account, no rewrite. ~30 min build.

**Live data on iPad:** Pages served from GitHub Pages already work on iPad. Backlog/Batches/Totes (localhost:3001) need `getLiveBase()` updated to use LAN IP (e.g. 192.168.x.x:3001) instead of localhost.

**Not worth it:** Native iOS (Swift rewrite + $99/yr Apple Developer) or Capacitor (still needs Mac + Apple account).

---

## Pending work

### EOS system — remaining fixes
- [ ] orders_not_released query needs EOS time cap: `AND CREATED_TIMESTAMP < '{captureTime}'` in captureSnapshot() — currently counts all '1000' orders including fresh inbound

### Batch/Backlog pages — remaining
- [ ] Putwall column in batch display — join verified but needs multi-PW shift to confirm RESOURCE_GROUP_ID is populated correctly. See "Putwall → batch mapping research" section above.
- [x] **Shipped oLPNs card** — DONE 2026-08-03. Green "Shipped" tile in Backlog header row. Shows oLPN count (main value) + orders count (sub-label). fetchShipped() in dc499_refresh.js queries PPK_OLPN STATUS IN ('7800','8000') using CREATED_TIMESTAMP. Writes shipped_live.json, served at /shipped_live.json. Page fetches on load + every 5 min independently of backlog refresh.
- [x] **Backlog order-date pooling** — DONE 2026-07-30. READY/RELEASED/ALLOCATED lines pool to order's earliest date; PACKED/SHIPPED keep their own date. sqlCounts query removed; totals now derived from pooled orders array.
- [x] **Bridge Total row** — DONE 2026-07-30. Total row added below Avg/hr in both live widget and EOD email export.
- [x] **Total column in Order Lines by Date** — DONE 2026-07-30. True full-day line count per date (all statuses, both shifts) via dedicated sqlDailyTotals query. Shown as rightmost column; footer sums it.
- [x] **Ready for Pack tile** — DONE 2026-07-30. Teal tile between Allocated and Packed. Shows units (not LPN count) at D1-SN-01 from DCI_ILPN STATUS=5000 joined to DCI_INVENTORY. Color: `--rfp` CSS var, distinct from `--alloc`.

### Tasks tab — Backlog_live.html (BUILT 2026-08-03, BROKEN)
- Tab exists in Backlog_live.html with health-check tiles and task tables — but never shows data
- **Root cause:** `default_task.TSK_TASK` only has a usable index on `FACILITY_ID + CREATED_TIMESTAMP`. Any filter beyond that (TYPE_ID, LABOR_ACTIVITY_ID, STATUS, TRANSACTION_ID) causes operation failures. Even a bare 5-minute CREATED_TIMESTAMP window fails intermittently — the table is unreliable through this MCP connector.
- The one query pattern that worked early in the session (bare 5-min window, no extra filters) returned data inconsistently and now fails consistently.
- `fetchTaskData()` in dc499_refresh.js uses `LABOR_ACTIVITY_ID IN (...)` + `LEFT(SOURCE_LOCATION_ID,3) IN (...)` filters — both fail. tasks_live.json is never written.
- **Options to fix:**
  1. **CSV drop approach** — user exports Task screen from MA manually, page reads local CSV. Gives full open task list (Ready/Assigned/In Progress) with no MAWM query issues.
  2. **TSK_ACTIVITY_TRACKING** — reframe tab as "work done this shift" (completed picks/replen by person). Proven reliable at shift scale, already used by Ecom Live. No open task counts.
  3. **Wait and retry** — TSK_TASK sometimes works. Could add retry logic with very narrow windows.
- **Decision needed:** pick an approach before rebuilding.
- **Confirmed filters (for when table works):** Ecom picking = `LABOR_ACTIVITY_ID IN ('ECOM MEZZ CART','ECOM NON MEZZ CART')`. Ecom replen = `LEFT(SOURCE_LOCATION_ID,3) IN ('R1B','R1C','R1D','R1E','R1F')`. Both verified against live CSV exports.

### EOD Email — remaining
- [ ] Verify Outlook dark mode rendering with bgcolor attrs (addBgcolor post-pass) — confirm colors match screen

### Packed Not Shipped report — new
- [ ] Clarify report requirements (see questions above)
- [ ] Explore CURRENT_LOCATION_ID patterns to understand door vs staging vs unknown
- [ ] Build PackedNotShipped_live.html + fetchPackedNotShipped() in dc499_refresh.js

### Condition codes — blocked
- Cannot build — condition code data visible in MA's Location Inventory screen is not accessible via MCP connector. See "Condition codes research" section above.

### Ecom Live — remaining
- [ ] `Returns System Directed Putaway` — decide whether to add to Group A (putaway) or exclude
- [ ] Per-dept pace indicator on tiles already done — consider adding active TM count + shift progress bar
- [ ] Eventually replace Full Report CSV tab entirely with Live tab

### Lost Tote Lookup — new
- [ ] Verify PPK_OLPN_DETAIL schema and repick location join via MAWM MCP
- [ ] Build requires PC server (localhost endpoint) — good IT talking point

### PWA / iPad — new
- [ ] Add manifest.json + service worker to key pages
- [ ] Update getLiveBase() to accept LAN IP for iPad → localhost:3001 routing

### Other pending
- [ ] changelog.json update — after full go-live
- [ ] Wave progress report — default_dcorder.DCO_WAVE_AGGREGATE_ORDER
- [ ] Timeclock report — default_timeclock
- [ ] GitHub Pro ($4/month) for private repo + Pages
- [ ] IT conversation re: server hosting — use PC vs server comparison in memory + lost tote lookup as demo

---

## How Dean works

- Confirms design decisions with mockups before building
- Patch notes in plain supervisor language only — no technical details
- Prefers targeted edits over full rewrites
- Always review before pushing to GitHub
- Use descriptive commit messages: "Ecom v2.9 — PPH projection, headcount settings"
- File size warning: HTML files 85-115KB, GitHub MCP times out at ~95KB+ — use git push directly
