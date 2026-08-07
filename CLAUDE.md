# SCOUT — Shift Centralized Output Utilization Tracker
## DC499 Reporter Suite — Claude Code Project Memory

This file is read automatically at the start of every Claude Code session. Do not delete it.

---

## Who I am

Dean Karim — Warehouse Trainer and 2nd Shift Supervisor, Nordstrom DC499. I manage ~25+ Ecom associates across Ecom, Reserve Stock, Item Prep, and Receiving.

---

## What this project is

Browser-based reporting suite on GitHub Pages. Processes MAWM CSV exports for associate throughput visibility. No backend, no build system — pure HTML/CSS/JS.

**GitHub:** dkarim02/DC499-reports | **Live:** dkarim02.github.io/DC499-reports | **Local:** C:\Users\JLEO\OneDrive - Nordstrom\DC499 Reporter

---

## Architecture rules — always follow these

**Dedup key:** Employee + Transaction ID + Activity Datetime. NEVER use CP Trace Id.

**Location filter (shared TX IDs only):**
- Zone H (3rd character of location string) = Reserve Stock; any other zone = Ecom
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
- Shipping (1st shift): NRDR Load Parcel Packages → Sum Quantity, dedup by Container ID
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

## PPH projection (Ecom)

- Shift start: 2:15 PM, cap: 10:45 PM, 8 productive hours
- Lunch: 30 min deducted after 6:15 PM
- Headcount from Settings (ecom_headcount_v1), PPH targets from Settings (ecom_pph_v1)
- On pace: current units >= projected units at this point in shift

---

## MAWM database (MCP: mawm-data-http-prod)

**Auth:** OIDC SSO — Dean.Karim@nordstrom.com | Read-only, audit-logged
**Facility ID:** Always '499' — never '0499'
**PII policy:** LIKE queries on CREATED_BY blocked — exact email only

**Timezone:** ALL timestamps stored UTC. DC499 = PDT (UTC-7). Always convert before querying.
Helper: `new Date(pdtStr.replace(' ','T') + '-07:00').toISOString().slice(0,19).replace('T',' ')`
Shift 2:15 PM PDT = 21:15 UTC. 2nd shift start = 21:00/21:10 UTC; 1st shift start = 10:00 UTC.

**PDT date bucketing (SQL):**
```sql
DATE_FORMAT(CONVERT_TZ(CREATED_TIMESTAMP, '+00:00', '-07:00'), '%Y-%m-%d') AS line_date
```

**Key tables:**
- Receiving productivity → default_receiving.RCV_RECEIPT (not RCV_LPN — associate scans are in RECEIPT)
- ASN lifecycle → default_receiving.RCV_ASN
- Wave progress → default_dcorder.DCO_WAVE_AGGREGATE_ORDER
- Task lifecycle → default_task.TSK_TASK
- Scan-level activity → default_task.TSK_ACTIVITY_TRACKING (CREATED_TIMESTAMP indexed — use for WHERE)
- Labor productivity → default_lmcore.LMC_THROUGHPUT
- Batches → default_workrelease.WR_BATCH (WORK_RELEASE_BATCH_ID = wave-run; BATCH_ID = per-putwall sub-batch)
- Inventory at location → default_dcinventory.DCI_ILPN + DCI_INVENTORY
- oLPN status/shipping → default_pickpack.PPK_OLPN

**Status codes:**

WR_BATCH: 5000=Released, 5200=Picking Started, 5400=Picking Completed, 5600=In Queue, 5800=Cleared

PPK_OLPN: 1000=created, 7100=packing started, 7200=packed/not shipped, 7600=manifested, 7800=loaded virtually, 8000=shipped, 9000=cancelled

TSK_TASK: 3000=queued, 5000=assigned, 7000=in progress, 8000=completed, 9000=cancelled

**Ready for Pack (D1-SN-01):**
```sql
SELECT SUM(inv.ON_HAND) AS unit_count
FROM default_dcinventory.DCI_ILPN ilpn
JOIN default_dcinventory.DCI_INVENTORY inv ON inv.ILPN_ID = ilpn.ILPN_ID AND inv.FACILITY_ID = ilpn.FACILITY_ID
WHERE ilpn.FACILITY_ID = '499' AND ilpn.CURRENT_LOCATION_ID = 'D1-SN-01' AND ilpn.STATUS = '5000'
```
Writes `rfp_units` to backlog_live.json.

---

## dc499_refresh.js — Live server agent

**Entry point:** dc499.bat — ALWAYS use dc499.bat, never node directly.

**Options:**
1. Refresh data only (one-shot)
2. Start live server on :3001
3. Start live server + open Receiving Live
4. First-time auth / re-auth
5. Ecom Live — one-shot refresh (scout_ecom_agent.js)
6. Ecom Live — auto-refresh every 5 min
7. Ecom Live — auth

**Output JSON:** batch_status.json, backlog_live.json, shipped_live.json, tasks_live.json, retail_replen.json, totes_live.json, dock_live.json, receiving_live.json

**Auth:** `AUTH_PIN = '020405'` → localhost:3001/auth?pin=020405 re-auths without PC password. On AuthError: auto-launches doAuthFlow() + Teams notification via TEAMS_WEBHOOK_AUTH_ALERT.

**Shift detection:** 1st shift: `nowUtcHour >= 10 && nowUtcHour < 21`; 2nd: all other hours. Written to `shift_label` in JSON.

**batch_status.json key fields:** generated, facility, shift_label, shift_start_utc, summary {total/cleared/active_batches, avg_mins_to_clear, avg_release_interval_mins}, batches[] {batch_num, batch_id, work_release_batch_id, total_orders/olpns/tasks/task_details, status_code/label, released_pdt, cleared_pdt, mins_to_clear, is_cleared, mins_since_prev_release}

**Carryover batches:** 14-hour lookback arm: `OR (STATUS_ID != 5800 AND CREATED_TIMESTAMP >= '{lookbackStart}')` catches 1st-shift batches not yet cleared at 2nd-shift start.

**Wave labels (PLANNING_STRATEGY_ID → label):**

| PLANNING_STRATEGY_ID | CHASE_MODE | Label |
|---|---|---|
| NRDR_CORE_ECOM_ORDER_PLANNING_STRATEGY | CHASE_DISABLED | Ecom |
| NRDR_NEW_PIPELINE_CHASE_ORDER_PLANNING_STRATEGY | CHASE_ENABLED | Multi Chase |
| NRDR_NEW_PIPELINE_CHASE_ORDER_PLANNING_STRATEGY | CHASE_ONLY | Single Chase |
| SINGLE_CHASE_ORDER_PLANNING_STRATEGY | CHASE_ONLY | Single Chase |
| MULTI_CHASE_ORDER_PLANNING_STRATEGY | CHASE_ENABLED | Multi Chase |
| NRDR_CORE_REPLEN_ORDER_PLANNING_STRATEGY | CHASE_DISABLED | Replen |
| NRDR_CORE_RETAIL_ORDER_PLANNING_STRATEGY | any | **omitted** |

Wave shift start: 2nd = 20:40 UTC, 1st = 10:00 UTC.

---

## Watchdog (dc499_watchdog.ps1)

Scheduled Task every 30 min. Checks for node.exe with `*dc499_refresh*`. If not running: relaunches with `--serve`. Log: dc499_watchdog.log. Setup: run dc499_watchdog_setup.bat once. **Lock PC (Win+L) when leaving — do NOT log out.**

---

## Teams webhooks

**1st shift (all pages):** workflows/a26c40b1c9ee4739abd0269aedbef04b
**2nd shift — Batches:** workflows/d4415440c8004523a34336a1a21e6dae
**2nd shift — Ecom/Backlog:** workflows/eacd8206a4274abb96f43be9d3d01256
**Auth expiry alert:** workflows/db4396647efa46f783e0ed9a5d09e32f... (TEAMS_WEBHOOK_AUTH_ALERT)

Routing: `getShift()` — 1st = 6AM–2PM PDT, 2nd = 2PM–10PM PDT.

---

## Batches_live.html / Backlog_live.html

**Themes:** dark, solid, pastel, starr, light. CSS `data-theme` attribute + custom properties. `starr` = pink glamour (Dean's boss). THEME_VALS and THEME_NAMES arrays must stay in sync with CSS and dropdown HTML.

**Teams card:** Send to Teams → batch picker modal → Adaptive Card. `notifyNewCleared()` auto-fires on batch transitions. No emoji in card text. `shiftLabel` read from `lastData.shift_label`.

**Send dropdown (Backlog):** "Send to Teams" + "EOD Email" in expandable `↑ Send` dropdown (id=send-picker). Click-outside closes both `theme-picker` and `send-picker`. `sendToTeams(btn)` — btn may be a `<div>` not `<button>`, guard: `if(btn.disabled!==undefined) btn.disabled=true`.

**Bridge card:** Units/Hour renamed "Bridge" (id=hourly-title). Two stacked sub-tables side-by-side.

**EOD Email:** `exportEodEmail()` reads lastBlData, lastBtData, lastRrData. Outlook compat: `width="600"` HTML attr (not CSS max-width), `bgcolor="#hex"` on every td/th. `addBgcolor()` post-pass injects bgcolor from computed style. Dark palette: #13172b bg, #1b2035/#232840 cells.

---

## Remi sprite

Animated MP4 (`remi.mp4`) runs along top of progress bars. Files: Batches_live.html (#remi), Backlog_live.html (#bl-remi, #bl-remi2). `mix-blend-mode:multiply` removes white bg. `clip-path:inset(4px 6px 6px 6px)`. Speed: 45px/s, `scaleX(-1)` on direction change. Toggle: `dc499_remi_enabled_v1` localStorage. **Video elements must be in DOM BEFORE `<script>` block.**

---

## EOS (End of Shift) Report system

**Files:** eos_agent.js (Node.js, queries MAWM), eos.bat (launcher — always use eos.bat), EOS_live.html (browser report).

**eos.bat options:** 1=SOS snapshot (run at 2:10 PM), 2=EOS+finalize (shift end), 3=Reconstruct SOS, 4=Auth.

**JSON:** eos_sos_snapshot.json (option 1/3), eos_report.json (option 2, contains {sos, eos}).

**Key tables:** DCO_ORDER (open orders, MAXIMUM_STATUS='1000'), DCO_ORDER_LINE (open units), PPK_OLPN (hospital/packed/loaded), TSK_TASK (tasks — exclude OBPUTAWAY type), DCO_ORDER_PLAN_RUN_STRATEGY (waves), WR_BATCH (batches).

**Waves ≠ Batches.** Waves = planner runs (DCO_ORDER_PLAN_RUN_STRATEGY). Batches = work-release pools to putwalls (WR_BATCH). Different tables, different concepts.

**Orders not released:** `MAXIMUM_STATUS = '1000' AND CREATED_TIMESTAMP < '{captureTime}'` — do NOT count all current '1000' orders (includes fresh customer inbound).

**Cannot reconstruct (option 3):** open_orders, open_units, hospital_orders, packed_not_shipped, loaded_virtually — current-state only, shown as null.

---

## Ecom Live tab (scout_ecom_agent.js)

**Agent:** scout_ecom_agent.js — launch via dc499.bat options 5/6/7 only. Output: ecom_live.json (local + GitHub).

**Query table:** TSK_ACTIVITY_TRACKING. Row columns aliased to CSV names: Employee, Transaction ID, Activity Datetime, Quantity, Completed Quantity, CP Trace Id, Container ID, Current Location, Previous Location, Criteria.

**Four query groups (stay under ~10k row cap):**
- Group A: replen + putaway (iLPN Replen Fill/Pull variants, System/User Directed Putaway)
- Group B: picking (Ecom Mezz/Non-Mezz Pick To Putwall Cart)
- Group C: packing (NRDR CORE PACK FOR ECOM PACK STATION)
- Group D: shipping + sorting (OB Putaway By Ship Via, NRDR Load Parcel Packages, OB Sort To Putwall Cubby)

**Truncation:** `truncated: true` in JSON + amber meta line if any group hits 9,500 rows. Split further if needed.

**Shift start (UTC):** 2nd = 21:10, 1st = 10:00. Boundary: `is1st = h >= 10 && h < 21`.

**Pending TX type:** `Returns System Directed Putaway` — not yet assigned to a group. Decision pending.

---

## Small-batch iteration pattern

For tables that time out on broad filters (e.g. TSK_TASK_DETAIL): get ID list, slice into batches of 15, query `COUNT(*) GROUP BY ID` per batch with independent try/catch.

```js
const BATCH_SZ = 15;
const resultMap = {};
for (let i = 0; i < ids.length; i += BATCH_SZ) {
  const batchIds = ids.slice(i, i + BATCH_SZ).map(id => `'${id}'`).join(',');
  try {
    const r = await mcpQuery(token, `SELECT ID, COUNT(*) AS cnt FROM table WHERE ID IN (${batchIds}) GROUP BY ID`);
    for (const row of (r.rows || [])) resultMap[row.ID] = Number(row.cnt);
  } catch (e) { console.warn(`Batch ${i/BATCH_SZ} failed: ${e.message}`); }
}
```

Used in: `fetchTaskData()` for TSK_TASK_DETAIL detail counts per open task. Safe at 15 IDs; try 25–30 if count is high.

---

## TSK_TASK — safe columns + filters

**Never query:** ASSIGNED_USER_ID, PLANNED_START_TIME — PII-gated, crashes query.

**Picking filter:** `TRANSACTION_ID IN ('Ecom Mezz Pick To Putwall Cart','Ecom Non-Mezz Pick To Putwall Cart')` — NOT LABOR_ACTIVITY_ID (unreliable, usually shows Default Picking Activity).

**Replen filter:** `LEFT(SOURCE_LOCATION_ID,3) IN ('R1B','R1C','R1D','R1E','R1F')`

**Carryover open tasks:** OR condition — this shift always included, PLUS any task still open (STATUS IN 3000/5000/7000) created in last 2 days.

---

## Research notes

**Putwall → batch mapping:** TSK_TASK_DETAIL.RESOURCE_GROUP_ID joined on `RESOURCE_BATCH_ID = WR_BATCH.BATCH_ID` is the verified join path. All rows showed S1-PW-01 on 2026-07-25 — possibly only PW1 was active. Verify on a shift with multiple putwalls before adding to batch_status.json.

**Condition codes:** Data visible in MA's Location Inventory is not accessible via MCP connector. Do not attempt to rebuild.

**LAN fast-refresh (parked):** Built and reverted 2026-08-04. Blocked by Windows Firewall (needs admin to open port 3001) and mixed-content (HTTPS GitHub Pages vs HTTP local server). Needs IT firewall rule + HTTPS cert to unblock.

**Packed Not Shipped (PPK_OLPN STATUS=7200):** ~6,500 oLPNs on a typical 2nd shift. CURRENT_LOCATION_ID shows dock door (P1-OB-010xxx), inbound locations, or numeric values. CARRIER_ID null at pack time (assigned at manifest/7600). Build pending: clarify report requirements (count by door? age flags? Ecom only?).

---

## Disclaimer (required on all dept apps)

```
Disclaimer: This tool measures throughput only and may not be used to evaluate, coach, or hold team members accountable on performance.
```

---

## Pending work

- [ ] EOS: orders_not_released needs EOS time cap in captureSnapshot() — `AND CREATED_TIMESTAMP < '{captureTime}'`
- [ ] EOD Email: verify Outlook dark mode rendering with bgcolor attrs (addBgcolor post-pass)
- [ ] Packed Not Shipped: build PackedNotShipped_live.html + fetchPackedNotShipped() in dc499_refresh.js
- [ ] Putwall column in batch display — needs multi-PW shift to confirm TSK_TASK_DETAIL.RESOURCE_GROUP_ID populated
- [ ] Ecom Live: decide on `Returns System Directed Putaway` — add to Group A (putaway) or exclude
- [ ] Lost Tote Lookup: verify PPK_OLPN_DETAIL schema + repick location join. Requires PC server endpoint.
- [ ] PWA / iPad: add manifest.json + service worker; update getLiveBase() to LAN IP for iPad
- [ ] Wave progress report (DCO_WAVE_AGGREGATE_ORDER)
- [ ] Timeclock report (default_timeclock)
- [ ] GitHub Pro ($4/mo) for private repo + Pages
- [ ] IT conversation re: server hosting (PC vs server — use Lost Tote Lookup as demo)

---

## How Dean works

- Confirms design decisions with mockups before building
- Patch notes in plain supervisor language only — no technical details
- Prefers targeted edits over full rewrites
- Always review before pushing to GitHub
- Use descriptive commit messages: "Ecom v2.9 — PPH projection, headcount settings"
- File size warning: HTML files 85-115KB, GitHub MCP times out at ~95KB+ — use git push directly
