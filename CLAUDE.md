# SCOUT — Shift Centralized Output Utilization Tracker
## DC499 Reporter Suite — Claude Code Project Memory

This file is read automatically at the start of every Claude Code session. Do not delete it.

---

## Quick Start

**Entry point: always `dc499.bat` — never `node` directly.**

- Main server: option 2 (`:3001`, auto-refresh every 2 min)
- Sub-agents: options 5–19 (each dept has one-shot / auto-refresh / auth)
- Git: dc499_refresh.js pushes for everyone — sub-agents only write JSON files locally

**GitHub:** dkarim02/DC499-reports | **Live:** dkarim02.github.io/DC499-reports | **Local:** C:\Users\JLEO\OneDrive - Nordstrom\DC499 Reporter

---

## Architecture

Browser-based reporting suite on GitHub Pages. No backend, no build system — pure HTML/CSS/JS. Node.js agents query MAWM directly via HTTPS, write JSON files, and push to GitHub. The browser fetches JSON from GitHub Pages CDN (or localhost:3001 in serve mode).

**Agent → JSON → HTML relationships:**

| Agent | Output JSON | HTML report |
|---|---|---|
| dc499_refresh.js | receiving_live.json, totes_live.json, backlog_live.json, batch_status.json, retail_replen.json, tasks_live.json, shipped_live.json | Receiving_live.html, Totes_live.html, Backlog_live.html, Batches_live.html |
| scout_ecom_agent.js | ecom_live.json | Ecom_v3.html |
| scout_shipping_agent.js | shipping_live.json | Shipping_live.html |
| scout_reserve_agent.js | reserve_live.json, putaway_live.json | Reserve_v1_7.html, Reserve_putaway.html |
| scout_expedite_agent.js | expedite_live.json | Backlog_live.html (Expedite tab) |
| scout_itemprep_agent.js | itemprep_live.json | ItemPrep_live.html |
| eos_agent.js | eos_sos_snapshot.json, eos_report.json | EOS_live.html |

---

## dc499.bat Options

| # | Action | Agent |
|---|---|---|
| 1 | Refresh data only (one-shot) | dc499_refresh.js |
| 2 | Start live server on :3001 | dc499_refresh.js |
| 3 | Start live server + open Receiving Live | dc499_refresh.js |
| 4 | First-time auth / re-auth | dc499_refresh.js |
| 5–7 | Ecom Live (one-shot / auto / auth) | scout_ecom_agent.js |
| 8–10 | Shipping Live (one-shot / auto / auth) | scout_shipping_agent.js |
| 11–13 | Reserve Live (one-shot / auto / auth) | scout_reserve_agent.js |
| 14–16 | Item Prep Live (one-shot / auto / auth) | scout_itemprep_agent.js |
| 17–19 | Expedite Live (one-shot / auto / auth) | scout_expedite_agent.js |

**EOS:** separate launcher — `eos.bat` (options: 1=SOS snapshot, 2=EOS+finalize, 3=Reconstruct SOS, 4=Auth)

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

---

## Git push pattern

dc499_refresh.js is the single coordinator — sub-agents never push.

```
git add receiving_live.json totes_live.json backlog_live.json batch_status.json retail_replen.json shipped_live.json tasks_live.json ecom_live.json shipping_live.json reserve_live.json putaway_live.json expedite_live.json
git commit -m "Live update -- {stamp} [+ecom, +shipping, +reserve]"
git fetch origin main
git rebase --autostash origin/main
git push origin main
```

**Why `fetch` + `rebase` (not `pull --rebase`):** Claude Code MCP's internal fetches populate FETCH_HEAD with multiple entries — `pull --rebase` fails with "Cannot rebase onto multiple branches".

**index.lock cleanup:** `gitPush()` calls `fs.unlinkSync('.git/index.lock')` before every `git add` — silently clears stale locks left by killed/crashed cycles.

**Commit message `[+label]` tags:** LABELS map in gitPush() — `ecom_live.json`→`ecom`, `shipping_live.json`→`shipping`, `reserve_live.json`→`reserve`, `putaway_live.json`→`putaway`, `expedite_live.json`→`expedite`. Any sub-agent file that changed gets its tag appended.

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

**PPK_OLPN query rules:**
- NEVER use `SELECT *` — PII filter blocks the whole query if any blocked column (e.g. `TOTAL_UNITS`) is included. Always list columns explicitly.
- Safe columns: `OLPN_ID, FACILITY_ID, ORDER_ID, STATUS, CURRENT_LOCATION_ID, CARRIER_ID, SERVICE_LEVEL_ID, TRACKING_NUMBER, PACKED_DATE_TIME, SHIPPED_DATE_TIME, CREATED_TIMESTAMP, UPDATED_TIMESTAMP`
- Query by `OLPN_ID` or `ORDER_ID` — both work directly. No JOIN needed.
- `FACILITY_ID = '499'` always required.

**DCI_ILPN query rules:**
- No `CONTAINER_ID` column — carton ID is `ILPN_ID`. The Cognos "Receive to Putaway WIP" report calls it `carton_id` but maps to `ILPN_ID`.
- Large IN() joins across DCI_ILPN + DCI_INVENTORY + ITE_ITEM time out. Query ITE_ITEM directly with known ITEM_IDs when subdivision lookups are needed.
- Subdivision 740 = Cosmetics, 750 = Fragrance (Beauty/Ecom) — excluded from all Retail putaway queries.

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

**Top Items (backlog_live.json):** `top_items[]` array — top 10 Ecom items by `ORDERED_QUANTITY` today. Fields: `description`, `units`, `orders`, `gwp` (bool). Filtered: `ORDER_TYPE='ECOM'`, `CANCELLED=0`, `DESCRIPTION NOT LIKE '%DUMMY%'`, today UTC range. GWP detected in Node via `/gift with purchase/i` and `/\bgwp\b/i` — no SQL gymnastics. Rendered as numbered list in Backlog_live.html sidebar with orange GWP badge inline.

---

## Token locking (all agents)

All agents (`dc499_refresh.js`, `scout_ecom_agent.js`, `scout_reserve_agent.js`, `scout_shipping_agent.js`, `scout_expedite_agent.js`, `scout_itemprep_agent.js`) share `.mcp_token.json`. Running concurrently caused token collision — one agent would consume the refresh token before another could use it, revoking the session.

**MCP query concurrency (dc499_refresh.js):** Uses a 2-slot in-memory semaphore (`_queryActive`, `_queryQueue`) inside `mcpQuery()`. Do NOT add a file-based query lock — the old `.query_lock` approach serialized all queries and was replaced 2026-09-17. 3+ concurrent slots caused empty responses from the server; 2 is the safe max.

**Fix (2026-08-13):** File-based lock + freshness check in `getAccessTokenSilent()`:
- `_saved_at` timestamp written to token file on every save
- `TOKEN_TTL = 55 * 60 * 1000` — fallback TTL if `expires_in` missing
- `isTokenFresh()` uses `stored.expires_in * 900` (90% of actual lifetime) when available, falls back to TOKEN_TTL
- Fast path: if token is fresh, return immediately — no network call
- Lock path: claim `.mcp_token.lock` (exclusive `wx` write), re-check freshness after acquiring, refresh once, release in `finally`

**REDIRECT_PORTs:** dc499_refresh=3118, scout_ecom=3119, scout_reserve=3120, scout_itemprep=3121, scout_expedite=3122

---

## Ecom Live (scout_ecom_agent.js)

Output: ecom_live.json. Query groups A/B/C/D/E fire in parallel (`Promise.all`).

**Five query groups:**
- Group A: replen + putaway (iLPN Replen Fill/Pull variants, System/User Directed Putaway)
- Group B: picking (Ecom Mezz/Non-Mezz Pick To Putwall Cart)
- Group C: packing (NRDR CORE PACK FOR ECOM PACK STATION)
- Group D: shipping (OB Putaway By Ship Via, NRDR Load Parcel Packages)
- Group E: sorting (OB Sort To Putwall Cubby) — SQL pre-filtered by CRITERIA_ID = NRDR_SORT_TO_PUTWALL_CUBBIES_CRITERIA

**Shift start (UTC):** 2nd = 22:15, 1st = 11:00. Boundary: `is1st = h >= 11 && h < 22`. Timestamp offset: `-07:00` PDT (fix to `-08:00` PST ~Oct 25, 2026 — see DST fix memory).

**Truncation:** `truncated: true` in JSON + amber meta line if any group hits 9,500 rows.

**Pending TX type:** `Returns System Directed Putaway` — not yet assigned to a group.

---

## Shipping Live (scout_shipping_agent.js)

Output: shipping_live.json. Transaction types: NRDR CORE PALLETIZE OLPN, FLOOR LOAD PALLETIZE OLPN.

**Dedup:** Employee + Container ID — earliest PDT hour attribution. Hourly target: 80 containers/person/hour.

**Shift:** 1st: 11:00 UTC start, hours 3–13 PST. 2nd: 22:15 UTC start, hours 14–21 PST. Auto-detected from UTC hour.

**4-tier color scale:** 0=grey (–), 1–39=red, 40–59=orange, 60–79=lime, 80+=green

---

## Reserve Live (scout_reserve_agent.js)

Output: reserve_live.json + putaway_live.json. Pre-aggregated `GROUP BY CREATED_BY` — immune to 10k row cap. All 4 groups fire in parallel.

**Metrics:** pick_f1, pick_f2, replen (iLPN Replen Fill/Large), putaway (System/User Directed Putaway). Zone H filter on replen + putaway.

**Shift detection (agent):** `is1st = h >= 10 && h < 22` (UTC). 1st shift start: 10:00 UTC. 2nd shift start: 21:10 UTC (previous day if h < 10).

**Shift sync (HTML):** `loadLiveData()` auto-syncs app shift to `d.shift` from JSON before calling `renderLiveReport`. Never call `setShift()` from inside `renderLiveReport` — flips storage keys mid-render and crashes headcount reads.

**NAIL button:** `nailFromLiveRS(btn)` — writes to NTP Retail tab (`ntp_dc499_v1`). Picking → "Retail OUT", Replen + Putaway → "Retail IN". `ntpCurrentBlockRS()` filters `NTP_BLOCKS` by `getShift()` — prevents 1st|EOD block matching on 2nd shift during 3–8 PM overlap.

---

## Expedite Live (scout_expedite_agent.js)

Output: expedite_live.json. REDIRECT_PORT 3122.

**Service levels reported:** `'11'` = 1DD (1-day delivery), `'42'` = 2DD (2-day delivery). Standard ground (`'24'`) excluded. Both tagged with SVC badge in UI.

**Expedite flag:** `DESIGNATED_SERVICE_LEVEL_ID = '11'` on DCO_ORDER — confirmed via 1.2-day avg delivery. `EXT_ESTIMATEDSHIPBYDATETIME` is a fixed daily noon PDT cutoff, NOT a per-order deadline — do not use it as the primary ship-by metric.

**True Ship By (UI):** `placed_utc + 24h` (1DD) / `+48h` (2DD). SLA offsets in `XPD_SLA_HRS` — tweak there. DC Cutoff column removed.

**oLPN enrichment:** Direct query on `PPK_OLPN` by `ORDER_ID`. Fetches `OLPN_ID, ORDER_ID, STATUS, CURRENT_LOCATION_ID, CARRIER_ID, SERVICE_LEVEL_ID, TRACKING_NUMBER, PALLET_ID`. Keeps highest-status oLPN per order as `topOlpn`.

**oLPN join gotcha:** `PPK_OLPN.SERVICE_LEVEL_ID` stores carrier codes (e.g. `ONTRAC_GROUND_ECMS`), NOT `'11'`. Never filter PPK_OLPN by service level.

**PPK_OLPN SELECT * gotcha:** `SELECT *` is blocked by the PII filter — even one blocked column (like `TOTAL_UNITS`) kills the entire query with a generic error. Always list columns explicitly. Query by `ORDER_ID` or `OLPN_ID` directly — no JOIN wrapper needed.

**Pallet ID:** `PALLET_ID` column on PPK_OLPN — reliably populated when oLPN is at a P1* (outbound dock) location. Multiple oLPNs share one pallet. UI shows 📦 + pallet ID when `CURRENT_LOCATION_ID LIKE 'P1%'`.

**Carrier labels:** `CARRIER_ID` → friendly name (`ONTRAC`→OnTrac, `ECMS_GENERIC_SERVICE_PROVIDER`→ECMS, etc.). Falls back to `SERVICE_LEVEL_ID` parsing. Carrier assigned at manifest (status 7600) — null at pack time (7200).

**Scope:** Not-yet-shipped = `MAXIMUM_STATUS NOT IN ('8000','9000')`. Quantity from `DCO_ORDER_LINE COUNT(*)` (1 unit/line for Ecom).

**Queries:** Q1 open orders + Q2 shipped counts + Q3 line counts fire in parallel, then oLPN enrichment batch by ORDER_ID.

**Shift:** `is1st = nowUtcHour >= 10 && nowUtcHour < 21`. 1st start: 10:00 UTC, 2nd start: 21:00 UTC.

**Status labels (UI):** 1000=Ready, 2090=Allocated, 7100=Packing, 7200=Packed, 7600=Manifested.

**Backlog_live.html Expedite tab:** 4 summary tiles + inline filter bar (1DD/2DD toggles | stage pills | Show Ready checkbox). Sortable table: SVC | Order # | Status | Carrier | oLPN/Location | Qty | Age | Ship By | Ordered. Stage pills clickable to filter rows. Themed via `--xpd` CSS vars.

---

## Receiving Live (Receiving_live.html v2.0)

Rebuilt 2026-08-15. Color-coded hourly scoreboard (same 80/60/40/0 thresholds as Shipping). No manual shift selector — auto-detects from `data.shift` in JSON.

**Roster key:** `recv_live_roster_v2` (single key, shift-agnostic). Migrates from old `recv_live_roster_v2_shift2` on first load.

**Shift boundaries in fetchReceiving():** 1st = 13:00 UTC (6 AM PDT), 2nd = 21:00 UTC (2 PM PDT). Timestamps offset `-07:00` PDT (fix to `-08:00` PST ~Oct 25 — see DST fix memory).

---

## Reserve Putaway WIP (Reserve_putaway.html)

Entry point: orange "📦 Putaway WIP" pill in Reserve_v1_7.html top bar. Data: `putaway_live.json`.

**Scope:** DCI_ILPN STATUS=3000, IS_CLOSED=0, retail SKUs only (EXT_SUBDIVISION NOT IN ('740','750')), 60-day window. Excludes Z1-Z-0499Z01 and shelf locations (R1H/R2H/R1B/R1C/R1D/R1E/R1F/R1-SR).

**PO number:** Correlated subquery on RCV_RECEIPT (LIMIT 1) — avoids unit-count fan-out from LEFT JOIN.

**Age badges (v1.1+):** green 5–7d, amber 7–14d, red ≥14d. Floor is 5 days — containers under 5 days are always hidden.

**CSV upload mode (v1.1):** User uploads Cognos "Receive to Putaway WIP" xlsx. Carton IDs forward-filled (sparse Cognos format). Matched against live JSON by ILPN_ID. Unmatched cartons are mostly Beauty/Ecom (740/750) — not a data error. SheetJS loaded lazily on first upload. Works on GitHub Pages; requires :3001 server when opened as file://.

**Shelf PP anomaly (deferred):** ~17k shelf LPNs (R1B/D/E/F/H, R2H) at STATUS=3000 — putaway scan never completed. Excluded pending team discussion.

---

## Reserve Weekly (Reserve_weekly.html)

Storage key: `rs_weekly_v1`. Per-day payload includes `employees: {email: {pick_f1, pick_f2, replen, putaway}}`.

**Date helpers (UTC-safe):** `todayISO()` builds manually from `getFullYear/Month/Date`. `weekMonday(isoStr)` accepts ISO string only — never pass a Date object. `toLocaleDateString('en-CA')` and `new Date('YYYY-MM-DD')` both have UTC-shift bugs — always use these helpers.

**Resets:** Sunday morning — clears if `_weekMon` doesn't match current week.

---

## Batches_live.html / Backlog_live.html

**Themes:** dark, solid, pastel, starr, light. `starr` = pink glamour (Dean's boss). THEME_VALS and THEME_NAMES arrays must stay in sync with CSS and dropdown HTML.

**Teams card:** `notifyNewCleared()` auto-fires on batch transitions. No emoji in card text.

**Send dropdown (Backlog):** `sendToTeams(btn)` — btn may be a `<div>` not `<button>`, guard: `if(btn.disabled!==undefined) btn.disabled=true`.

**Allocated tile:** Shows `totA - rfp_units` (units allocated but not yet at D1-SN-01). `m-total-alloc` shows full `totA` as "Total Allocated". RFP tile stays separate.

**Expedite oLPN sub-line priority (Backlog_live.html):** 4 cases in order: (1) `P1*` location + pallet → pallet badge, (2) `D1-SN-01` → "Located to D1-SN-01", (3) any other location → show raw, (4) allocated (2090) + no location + `pick_stage` → italic stage label. Never show pick_stage if a location is already known.

**pick_stage field (expedite_live.json):** String TSK_TASK STATUS code (`'3000'`/`'5000'`/`'7000'`) for the highest-status open pick task tied to that ORDER_ID this shift. Null if no task yet. Rendered as: In Queue / Assigned / Picking. Only shown for `order_status='2090'` with no `olpn_location`. Source: Q4 in scout_expedite_agent.js — JOIN TSK_TASK + TSK_TASK_DETAIL on ORDER_ID, filter Ecom pick TX IDs.

**Status pill panel:** Clicking Ready/Allocated/Packed pill opens detail panel. Each order row = `.order-entry` (not `.order-item`). Expanding shows line count + oldest line date (PDT). State tracked in `expandedOrders` Set. Panel + expanded rows survive auto-refresh via `openDetailPanel(..., true)` (silent=true).

**EOD Email:** `exportEodEmail()` reads lastBlData, lastBtData, lastRrData. Outlook compat: `width="600"` HTML attr, `bgcolor="#hex"` on every td/th. `addBgcolor()` post-pass injects bgcolor from computed style.

---

## Ecom_v3.html — per-transaction TM disable

**Disable scoped to transaction:** State stored in `disabled_tx[]` on each roster member. `isTMEnabledForTx(roster, emp, typ)` returns false if `!m.enabled` OR if `typ` in `m.disabled_tx`.

**Functions:** `toggleTMFromLive/Panel(emp, typ)` — toggle `typ` in/out of `disabled_tx`. `disableTMAllFromLive/Panel(emp)` — set `enabled = false`, clear `disabled_tx`.

**`loadRoster` normalization:** Always ensures `disabled_tx: []` present — backward-compatible with pre-field rosters.

---

## Page transitions (Menu_v2.0.html + all dept pages)

**Menu exit:** `openApp()` adds `.is-exiting` to body, waits 420ms, then navigates. CSS keyframes (`blobExit-*`) collapse blobs to center; `.content` fades out.
**Menu entrance:** `is-entering` class added at init, removed after 700ms. CSS keyframes (`blobEnter-*`) burst blobs from center to corners.
**`applyTheme()`:** Preserves `is-entering`/`is-exiting` classes before reassigning `body.className` — never wipe animation state when switching themes.
**Dept page entrance:** All pages have `@keyframes pageEnter` + `body { animation: pageEnter 0.28s ease-out both; }` at the bottom of their `<style>` block.
**Blob-only:** Entrance/exit animations are scout-theme-aware but live in base CSS — they run on all themes (blobs are just dim on light).

---

## Remi sprite

Animated MP4 (`remi.mp4`) along top of progress bars. `mix-blend-mode:multiply` removes white bg. `clip-path:inset(4px 6px 6px 6px)`. Speed: 45px/s, `scaleX(-1)` on direction change. Toggle: `dc499_remi_enabled_v1` localStorage. **Video elements must be in DOM BEFORE `<script>` block.**

---

## Watchdog (dc499_watchdog.ps1)

Scheduled Task every 30 min. Checks for node.exe with `*dc499_refresh*`. If not running: relaunches with `--serve`. Log: dc499_watchdog.log. Setup: run `dc499_watchdog_setup.bat` once. **Lock PC (Win+L) — do NOT log out.**

---

## Teams webhooks

**1st shift (all pages):** workflows/a26c40b1c9ee4739abd0269aedbef04b
**2nd shift — Batches:** workflows/d4415440c8004523a34336a1a21e6dae
**2nd shift — Ecom/Backlog:** workflows/eacd8206a4274abb96f43be9d3d01256
**Auth expiry alert:** cu/30/workflows/db4396647efa46f783e0ed9a5d09e32f... (TEAMS_WEBHOOK_AUTH_ALERT) — sends `{"text":"..."}` plain body, NOT Adaptive Card.

Routing: `getShift()` — 1st = 6AM–2PM PDT, 2nd = 2PM–10PM PDT.

---

## batch_status.json key fields

generated, facility, shift_label, shift_start_utc, summary {total/cleared/active_batches, avg_mins_to_clear, avg_release_interval_mins}, batches[] {batch_num, batch_id, work_release_batch_id, total_orders/olpns/tasks/task_details, status_code/label, released_pdt, cleared_pdt, mins_to_clear, is_cleared, mins_since_prev_release}

**Carryover batches:** 14-hour lookback: `OR (STATUS_ID != 5800 AND CREATED_TIMESTAMP >= '{lookbackStart}')` catches 1st-shift batches not yet cleared at 2nd-shift start.

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

## EOS (End of Shift) Report system

**Files:** eos_agent.js, eos.bat (launcher), EOS_live.html.

**eos.bat options:** 1=SOS snapshot (run at 2:10 PM), 2=EOS+finalize, 3=Reconstruct SOS, 4=Auth.

**JSON:** eos_sos_snapshot.json (option 1/3), eos_report.json (option 2, contains {sos, eos}).

**Key tables:** DCO_ORDER, DCO_ORDER_LINE, PPK_OLPN, TSK_TASK (exclude OBPUTAWAY type), DCO_ORDER_PLAN_RUN_STRATEGY, WR_BATCH.

**Waves ≠ Batches.** Waves = planner runs (DCO_ORDER_PLAN_RUN_STRATEGY). Batches = work-release pools to putwalls (WR_BATCH).

**Orders not released:** `MAXIMUM_STATUS = '1000' AND CREATED_TIMESTAMP < '{captureTime}'` — do NOT use all current '1000' orders (includes fresh customer inbound).

**Cannot reconstruct (option 3):** open_orders, open_units, hospital_orders, packed_not_shipped, loaded_virtually — current-state only, shown as null.

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

Safe at 15 IDs; try 25–30 if count is high. Used in: `fetchTaskData()` for TSK_TASK_DETAIL counts per open task.

**TSK_TASK_DETAIL status codes:** 1000=open, 8000=completed, 9000=cancelled. Use `STATUS='8000'` for done count — NOT 9000 (cancelled).

---

## TSK_TASK — safe columns + filters

**Never query:** ASSIGNED_USER_ID, PLANNED_START_TIME — PII-gated, crashes query.

**Picking filter:** `TRANSACTION_ID IN ('Ecom Mezz Pick To Putwall Cart','Ecom Non-Mezz Pick To Putwall Cart')` — NOT LABOR_ACTIVITY_ID (unreliable).

**Replen filter:** `LEFT(SOURCE_LOCATION_ID,3) IN ('R1B','R1C','R1D','R1E','R1F')`

**Carryover open tasks:** OR condition — this shift always included, PLUS any task still open (STATUS IN 3000/5000/7000) created in last 2 days.

---

## Research notes

**Putwall → batch mapping:** TSK_TASK_DETAIL.RESOURCE_GROUP_ID joined on `RESOURCE_BATCH_ID = WR_BATCH.BATCH_ID` is the verified join path. All rows showed S1-PW-01 on 2026-07-25 — possibly only PW1 was active. Verify on a multi-putwall shift before adding to batch_status.json.

**Condition codes:** Data visible in MA's Location Inventory is not accessible via MCP connector. Do not attempt to rebuild.

**LAN fast-refresh (parked):** Built and reverted 2026-08-04. Blocked by Windows Firewall (port 3001 needs admin) and mixed-content (HTTPS Pages vs HTTP local). Needs IT firewall rule + HTTPS cert.

**Packed Not Shipped (PPK_OLPN STATUS=7200):** ~6,500 oLPNs on a typical 2nd shift. CARRIER_ID null at pack time (assigned at manifest/7600). Report pending: clarify requirements (count by door? age flags? Ecom only?).

---

## Metabase migration (in evaluation — 2026-08-10)

**Proposed architecture:** Metabase holds direct MAWM DB connection (IT manages creds, no OIDC expiry). Reporter HTML/CSS/JS hosted on Nordstrom intranet. PC agent shrinks to ~100 lines — polls Metabase REST API for operational events only.

**Key blocking question:** Can Dean push HTML/JS updates himself without an IT ticket? Must be confirmed before migration begins.

**What stays in PC agent:** Teams webhooks, EOD email, shift detection.

**What cannot move to Metabase:** Teams notifications on row-level events, EOD email generation, PPH pace math, headcount settings, custom themes.

**Metabase REST API pattern:** `GET /api/card/{id}/query` with `X-Metabase-Session` header. Agent polls every 5 min, maps to existing JSON format.

**SQL translations needed:** Dedup via `ROW_NUMBER() OVER (PARTITION BY employee, transaction_id, activity_datetime)`, Zone H via `CASE WHEN SUBSTR(location,3,1)='H'`, shift bucketing via `CONVERT_TZ`. All existing TX ID filters and `facility_id='499'` rules apply unchanged.

**Next step:** Review eng manager's Metabase report — verify facility_id='499' (not '0499'), REST API intranet accessibility, and deploy access terms.

---

## Disclaimer (required on all dept apps)

```
Disclaimer: This tool measures throughput only and may not be used to evaluate, coach, or hold team members accountable on performance.
```

---

## Pending work

**Urgent / active:**
- [ ] **Backlog date bucketing** — waiting on leader sign-off. Fix: join subquery for `MIN(CREATED_TIMESTAMP)` across ALL lines (incl. cancelled) per order as bucket date, filter `CANCELLED=0` for status counts. Verified vs Cognos 2026-08-17.
- [ ] **DST fix** — ~Oct 25, 2026: change `-07:00` PDT → `-08:00` PST in scout_ecom_agent.js, scout_reserve_agent.js (shift boundaries + timestamps). See DST fix memory.

**Pending build:**
- [ ] Packed Not Shipped: build PackedNotShipped_live.html + fetchPackedNotShipped() in dc499_refresh.js
- [ ] EOS: add EOS time cap to orders_not_released — `AND CREATED_TIMESTAMP < '{captureTime}'`
- [ ] EOD Email: verify Outlook dark mode rendering with bgcolor attrs (addBgcolor post-pass)
- [ ] Pack Line Order Locator — need from Dean: Line 1/2 tote capacity, pizza tote footprint (inches), diverter trigger

**Parked / needs info:**
- [ ] **Shelf PP anomaly (Reserve):** ~17k shelf LPNs stuck at STATUS=3000. Discuss with retail team before building tooling.
- [ ] Putwall column in batch display — needs multi-PW shift to confirm TSK_TASK_DETAIL.RESOURCE_GROUP_ID populated
- [ ] **Mixed putwall detection (Totes_live.html):** Add `dz1/dz2_last_active_min` fields from `MAX(UPDATED_TIMESTAMP)` per DZ location, flag mixed only when both DZs active within ~30–45 min.
- [ ] Lost Tote Lookup: verify PPK_OLPN_DETAIL schema + repick location join. Requires PC server endpoint.
- [ ] PWA / iPad: add manifest.json + service worker; update getLiveBase() to LAN IP
- [ ] Wave progress report (DCO_WAVE_AGGREGATE_ORDER)
- [ ] Timeclock report (default_timeclock)
- [ ] GitHub Pro ($4/mo) for private repo + Pages
- [ ] IT/Metabase: review eng manager's report, confirm deploy access
- [ ] Reserve Weekly: replen/pick ratio metrics

---

## DeanAgentGuide

Field guide for building MAWM agents — invoke on demand only. Do NOT summarize or surface this section unprompted.

**IMPORTANT — When the user's message is exactly `DeanAgentGuide`:** Stop what you are doing. Do not search for commands. Do not ask what they meant. Read `agent-guide/DEAN_AGENT_GUIDE.md` immediately using the Read tool, then follow the instructions inside it exactly.
