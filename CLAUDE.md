# SCOUT — Shift Centralized Output Utilization Tracker
## DC499 Reporter Suite — Claude Code Project Memory

This file is read automatically at the start of every Claude Code session. Do not delete it.

---

## Quick Start

**Entry point: always `dc499.bat` — never `node` directly.**

- Main server: option 2 (`:3001`, auto-refresh every 2 min)
- Sub-agents: options 5–28 (each dept has one-shot / auto-refresh / auth)
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
| scout_retail_agent.js | retail_backlog_live.json | Retail_backlog.html |
| scout_watch_agent.js | container_watch_live.json | Container_watch.html |
| scout_untasked_agent.js | untasked_live.json | Backlog_live.html (No Task tab) |

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
| 20–22 | Retail Backlog (one-shot / auto every 5 min / auth) | scout_retail_agent.js |
| 23–25 | Container Watch (one-shot / auto every 15 min / auth) | scout_watch_agent.js |
| 26–28 | Untasked Orders (one-shot / auto every 5 min / auth) | scout_untasked_agent.js |

**EOS:** archived 2026-10-01 (archived/eos/) — see EOS section.

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

## OneDrive / file:// mode (added 2026-09-28)

Backup path if GitHub is lost: share the folder through OneDrive and open pages straight from disk.
- Browsers block `fetch()` of local JSON on file://. Every agent `require('./scout_file_mirror')`, which wraps `fs.writeFileSync` so every data JSON in the folder also writes `filedata/<name>.js` (compact, `window.SCOUT_FILE_DATA[...]`).
- Every data page loads `<script src="scout_file_mode.js">` first. On file:// it catches GET fetches for `*.json` (relative, localhost:3001, or the github.io URL) and serves them from `filedata/`. It does nothing on Pages or localhost. Webhook POSTs pass through.
- **New agent → add the require. New page that fetches JSON → add the script tag at the top of `<head>`.** Keep page links relative (no `/DC499-reports/` paths).
- `filedata/` is gitignored (OneDrive-only). `git fetch`/`push` have a 60s timeout so a GitHub outage can't hang the cycle.
- localStorage (rosters, headcount, PPH, NTP) is per site: settings on github.io don't carry over to file://. Each user sets them up once in file mode.

---

## Git push pattern

dc499_refresh.js is the single coordinator — sub-agents never push.

```
git add receiving_live.json totes_live.json backlog_live.json batch_status.json retail_replen.json shipped_live.json tasks_live.json ecom_live.json ecom_history.json shipping_live.json reserve_live.json putaway_live.json expedite_live.json retail_backlog_live.json container_watch_live.json untasked_live.json
git commit -m "Live update -- {stamp} [+ecom, +shipping, +reserve]"
git fetch origin main
git rebase --autostash origin/main
git push origin main
```

**Why `fetch` + `rebase` (not `pull --rebase`):** Claude Code MCP's internal fetches populate FETCH_HEAD with multiple entries — `pull --rebase` fails with "Cannot rebase onto multiple branches".

**index.lock cleanup:** `gitPush()` calls `fs.unlinkSync('.git/index.lock')` before every `git add` — silently clears stale locks left by killed/crashed cycles.

**Commit message `[+label]` tags:** LABELS map in gitPush() — `ecom_live.json`→`ecom`, `shipping_live.json`→`shipping`, `reserve_live.json`→`reserve`, `putaway_live.json`→`putaway`, `expedite_live.json`→`expedite`, `retail_backlog_live.json`→`retail`, `container_watch_live.json`→`watch`, `untasked_live.json`→`untasked`. Any sub-agent file that changed gets its tag appended.

---

## Transaction IDs by dept

**Ecom:**
- Replen: iLPN Replen Fill, iLPN Replen Fill Large → Sum Completed Quantity (agent also fetches iLPN Replen Pull/Pull Large but doesn't count them). Retail iLPN Replen Pull = Retail work, removed from the Ecom query 2026-09-24 — it never counted toward the tile.
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
- Pick Execution Zones (PEZ) → default_dcinventory.DCI_ZONE (`ZONE_TYPE_ID='PICK_EXECUTION'`); location → zone via `DCI_LOCATION.PICK_EXECUTION_ZONE_ID` (`PROFILE_ID='499'`); task lines carry `TSK_TASK_DETAIL.PICK_EXECUTION_ZONE_ID`. Every active zone H location has a PEZ. E1H = `PEZ_PACKHOLD_RTV`, U1H = `PEZ_UNALLOCATED` (not pick/replen work).

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

## Shared sign-in + query slots — scout_mcp.js (all agents, 2026-10-01)

All 9 agents share `.mcp_token.json`. The login/query code lives in ONE file, `scout_mcp.js`; each agent does `const mcp = require('./scout_mcp')({ redirectPort: REDIRECT_PORT })` and destructures `getAccessToken, getAccessTokenSilent, doAuthFlow, AuthError, mcpQuery` (+ `jsonPost` in dc499_refresh). **New agent → use that require, never copy the OAuth block.** Fix login/query behavior in scout_mcp.js only. Untasked keeps a local `mcpQuery` wrapper that also throws on `{success:false}`.

**Query slots:** at most `POOL_SLOTS = 3` MCP queries in flight across ALL agents together (`.mcp_slot_0..2.lock` files; in-process queue in front so queued queries don't all poll disk). Before 10/1 it was 2 in-memory slots for dc499_refresh + one `.query_lock` file shared single-file by every sub-agent, uncoordinated (peaks of 3+). More than 3 has caused empty responses — don't raise it. `SCOUT_MCP_SLOTS` env var overrides for testing.

**Priority (2026-10-02):** dc499_refresh is created with `{ priority: true }`. While it has a query waiting it keeps `.mcp_priority.lock` fresh (pid + time, ignored after 10 s or if the pid is gone); sub-agents won't take a freed slot while it's fresh, and refresh hands a slot straight to its own next queued query. Between live cycles the sub-agents get all 3. Why: after the 10/1 switch, refresh shared slots evenly with 7 sub-agents (aligned start times + Watch's 30-query burst) and pushes slipped to 4–6 min apart. Test: 28-query burst vs a full pool 6.5 s → 1.8 s (`.tmp_audit/test_priority.js`). Only one agent should ever be priority.

**Cycle timing line (dc499_refresh):** every cycle prints `⏱ cycle Xs — queries Ys (last to finish: <section>), git Zs · N queries, longest slot wait, slowest: <table> Ns …` (`takeStats()` from scout_mcp.js). Read it before tuning anything — the section that finishes last is the one setting the cycle time.

**Lock rules:** lock files hold `{id,pid,at}`; only the owner (matching id) deletes on release. Stale = owner PID gone, or older than `SLOT_STALE_MS` (5 min) / 60 s for the token lock — cleared automatically with a `[scout_mcp] cleared stale lock` console line. A waiting query never runs unprotected; after 5 min of waiting it fails instead. Hung queries are dropped after `QUERY_TIMEOUT_MS` (4 min, absolute timer — the server's pings would reset an idle timeout). Token/webhook POSTs: 30 s.

**Token:** fast path if fresh (`expires_in * 900` = 90% of lifetime, else 55 min); otherwise claim `.mcp_token.json.lock`, re-check, refresh once (tries `.bak` refresh token as fallback), save via temp+rename. A refresh response without `access_token` is treated as a failure (it used to get merged into the token file). **One-shot `getAccessToken()` now goes through the same locked path** and only opens a browser if that fails — so one-shots and the "DC499 Auto-Refresh" scheduled task are safe alongside serve agents.

**Serve loops:** every sub-agent skips a tick if its previous cycle is still running (dc499_refresh already did).

**Rollback:** git tag `pre-shared-mcp` = the commit before this change (`git checkout pre-shared-mcp -- scout_*_agent.js dc499_refresh.js` and delete scout_mcp.js, then restart agents). Offline tests: `.tmp_audit/test_mcp.js` (local, gitignored).

**REDIRECT_PORTs:** dc499_refresh=3118, scout_ecom=3119, scout_reserve=3120, scout_itemprep=3121, scout_expedite=3122, scout_retail=3123, scout_watch=3124, scout_untasked=3125, scout_shipping=3126 (was 3120, clashed with Reserve)

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

**History snapshot gate:** `updateEcomHistory()` only fires for 1st shift (always) or 2nd shift after ≥420 min elapsed (~9:10 PM PDT). Before that, console prints `history snapshot skipped`. Gate is offset-based from shift start — DST-safe, no hardcoded UTC hour.

**Archive vs live consistency:** No zone H filter on either archive or live tab. P1-PK excluded from replen on both. `rowBelongsToEcom()` (zone H filter) is only called in `addToFullReport()` — the CSV upload path in Full Report tab — NOT in the live summary tiles.

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

**Hourly view (v2.0, 2026-09-29):** Each group query is `GROUP BY CREATED_BY, pdt_hr` (PDT hour via `PDT_OFFSET` constant). Shift totals are rolled up from the hourly rows, so `associates[emp].hourly["15"] = {pick_f1,…,bulk_lpn}` always adds up to the total. Replen containers use a separate shift-level query (distinct counts can't be summed across hours). The page reads `hourly` directly. The old localStorage snapshots (`rs_sc_v1_*`) are removed and get cleared on load. Hour columns add any off-range hour with scans (2nd shift often scans into 10 PM). v2.1 adds type pills (`RS_HOURLY_TYPES`: All / Picking F1+F2 / Replenishment / Putaway / Full LPN Pick). Keys match the Live card keys, so `isTMEnabledForCard` disables carry over. The choice is saved in `rs_hourly_type_v1`.

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

## Retail Backlog (scout_retail_agent.js → Retail_backlog.html)

Store replen order progress by wave. Output: retail_backlog_live.json. REDIRECT_PORT 3123. Menu entry: Reserve Stock card → "Retail Backlog" tool chip.

**Scope:** `DCO_ORDER` with `ORDER_TYPE='RETAIL'`, `CANCELLED=0`, `MAXIMUM_STATUS NOT IN ('8000','9000')`, 90-day lookback. One wave per week; wave = PDT date of `CREATED_TIMESTAMP` (`pdtDateToUtcWindow()` — midnight PDT = 07:00 UTC, DST fix applies).

**Wave number:** Full `ORDER_PLANNING_RUN_ID` string (e.g. `W09212026000000000035`) from `DCO_ORDER_PLAN_RUN_STRATEGY` where `PLANNING_STRATEGY_ID='NRDR_CORE_RETAIL_ORDER_PLANNING_STRATEGY'`, matched by PDT date. Not readable from DCO_ORDER directly. Highest sequence wins if a date has several runs.

**Order status = MINIMUM_STATUS, not MAXIMUM_STATUS.** An order with min=Allocated / max=Packed still has lines to pick — it counts as Allocated. MAXIMUM_STATUS is only used to drop shipped/cancelled orders.

**Units gotcha:** On retail lines, `ALLOCATED_QUANTITY`, `PACKED_QUANTITY`, etc. are set once and mirror `ORDERED_QUANTITY` — summing them makes every column equal Ordered. Correct: `SUM(ORDERED_QUANTITY) GROUP BY DCO_ORDER_LINE.STATUS` (strings: ALLOCATED, PACKING, PACKED, LOADED, MANIFESTED, SHIPPED). Agent buckets ALLOCATED+PACKING → `allocated`; `ordered` = sum of all buckets. Always `ol.CANCELLED = 0`.

**Per-wave queries (parallel):** status breakdown (by MINIMUM_STATUS), unit counts (by line STATUS), store breakdown (DESTINATION_FACILITY_ID). Then `allocated_orders[]` (best-effort — failure doesn't drop the wave): orders with MINIMUM_STATUS=2090, only lines still at STATUS='ALLOCATED' → `{order_id, store_id, lines, units}` = what's left to pick, sorted by units desc.

**Zones tab (v1.1):** `zones` object in the JSON = open/done units + lines per Pick Execution Zone (PEZ), split into `picks[]` and `replen[]`. Source: `TSK_TASK_DETAIL.PICK_EXECUTION_ZONE_ID LIKE 'PEZ_RTL%'` (TSK_TASK.SOURCE_ZONE_ID is empty for these). Open = STATUS not 8000/9000, created in last 48 hrs. Done = STATUS 8000 with `ACTUAL_END_TIME` ≥ shift start (1st 10:00 / 2nd 21:10 UTC). Location ranges come from `DCI_LOCATION.PICK_EXECUTION_ZONE_ID`. Zones whose locations are all R1H/R2H = replen (Retail iLPN Replen Pull); the rest = picks (Non Haz Retail Pick To oLPN Cart / Floor 2). Friendly names come from `zoneName()`: `PEZ_RTL_ZONE_3` → "Zone 3", `PEZ_RTL_ZONE_3_R1H` → "R1H Zone 3", `PEZ_RTL_ZONE_F2H` → "F2H Zone". Retired zones (no locations, no work) are skipped. HTML: Picks/Replen toggle + "Show completed" checkbox (same idea as the Ecom Tasks tab). Two cards side by side, Downstairs · 1H and Upstairs · 2H (from `floor`, the digit in the area code; R2H counts as upstairs). Each card header shows its subtotal units and share. Zones are never split by P/F. **Display names** come from `shortZoneName()` in the HTML, built from `where`: "F 10–11 · P 9–10", "P 11–13", "F 5", "Aisles 2–5 · Bays 1–30". It falls back to the agent's `name` if parsing fails. The MA zone ID shows in the row tooltip. No Where column. Share % = zone's slice of the total; bars scale to the busiest zone. The last tab is remembered in `retail_backlog_tab_v1`. **Query gotcha:** a JOIN to TSK_TASK combined with `LIKE 'PEZ_RTL%'` fails server-side — use an explicit IN() list if a join is ever needed.

**Retail zone map (as of 2026-09-24).** Pick zones 1/2/3/F2H/P2H were created 2026-09-17 (a re-zone); the R1H/R2H replen zones date from Feb 2026.

| Zone | Where | Work |
|---|---|---|
| Zone 1 | F1H 10–11 + P1H 09–10 | Picks |
| Zone 2 | F1H 04–08 + P1H 01–04 | Picks |
| Zone 3 | P1H 11–13 | Picks |
| F1H Zone 10 | F1H05, 3 locations (first work 9/24) | Picks |
| F2H Zone | F2H 01–13 (1,254 locations) | Picks (Floor 2) |
| P2H Zone | P2H 01–08 | Picks (Floor 2) |
| R1H Zone 1–4 | R1H aisles 01–08, split by aisle + bay (01–30 / 31–46) | Replen |
| R2H Zone 5–6 | R2H bays 01–10 / 11–55 | Replen |

Older numbered zones (7–12 with F1H/P1H/F2H/P2H suffixes) have few or no locations left.

**HTML:** Units view is the default (Orders toggle available). Wave table = one bubble pill per status + totals footer. Clicking the Allocated bubble (either view) or the Allocated tile opens the order list panel (search by order # or store); open state + search survive wave switches and auto-refresh. Store table rows carry colored dots that match pie slices (`groupStores()` assigns colors) — pie has no legend. Pie uses `responsive:false` + in-place `update('none')` so it never resizes between waves.

---

## Container Watch (scout_watch_agent.js → Container_watch.html)

CUP-report prevention tool (built 2026-09-30). Menu: Item Prep card → "Container Watch" chip. Output container_watch_live.json (~370 KB, ~45 KB gzipped), refresh 15 min, a full cycle takes ~1 min (~30 queries). `--once` = one-shot via getAccessTokenSilent (safe to run from Claude Code while serve agents run).

**Tabs:**
- **Staging** — DCI_ILPN STATUS 3000/5000 at `P1-FC%` (Item Prep conveyor drop) or `P1-PK%` (replen staging). Age = since last scan. Tags: stuck (24h+), stuck_week (7d+), replen_dropped (P1-PK + deallocated or fill completed 0). 44% of Ecom lost containers on the Wk34 CUP were last seen at one of these two spots.
- **Item Prep Splits** — STATUS 3000, no location, SOURCE_LPN_ID set, last 180 days, **zero scans**. Ghost = parent vendor carton split_qty > received qty for that SKU (same units split twice after an audit/Modify LPN re-adds them; the first LPN is never deleted). Else never_located (real units, probably at a station). Detail = parent carton steps for that SKU.
- **Found Freight** — ASN/PO/SOURCE all null, made by a person (checked in Node — LIKE on CREATED_BY is blocked), last 60 days, not in Z1. Lost match = same SKU (leading zeros stripped) + same units as a Z1 / status-10000 container whose **last good sighting** (ignores Z1 moves, LW codes, Lost counts) is before the found one was made; the found side must have no Receive scan. Sorted by gap days (>60 = weaker lead). "Research" placeholder items never match.

**Names:** shown only in the row detail timeline ("First L."), never in the table — Dean's call, so it reads as research, not blame.

**Limits:** consumed found-containers lose ITEM_ID in DCI_ILPN (can't match); "Recover from LOST" adjustments into active slots aren't searched (TSK_ACTIVITY_TRACKING by ITEM_ID over weeks times out).

---

## Untasked Orders (scout_untasked_agent.js → Backlog_live.html No Task tab)

Ecom orders allocated with no pick task, grouped by why (built 2026-10-01). Output untasked_live.json, refresh 5 min, ~4–6 queries. `--once` = safe one-shot. Backlog v1.3 fetches it every 2 min for the tab + red count badge.

**Method (from Shubham Dalal's retail dashboard):** `DCI_ALLOCATION` is the source, not "NOT EXISTS in TSK_TASK_DETAIL". STATUS 3000 = allocated, no task yet; 5000 = released. **STATUS is stored as '3000.0'** — always `IN ('3000','3000.0')` or it silently returns 0 rows. No date bound on the 3000 query (indexed, small set — a window would hide the aged ones).

**Categories:**
- Grace: untasked < 60 min (`GRACE_MIN`) = waiting for batch release, counted not flagged. Age = oldest 3000 allocation CREATED_TIMESTAMP.
- **short_shelf** — a line's shelf is short: `on_hand < max(untasked need, DCI_INVENTORY.ALLOCATED)` (ALLOCATED covers tasked + untasked picks). Work release only tasks stock on the shelf, and the whole order waits on its one short item — the other lines are "hostage".
- **wont_fit** (checked first) — short shelf with a replen allocation at **`1000.0` Deferred For Capacity** (`DCI_ALLOCATION` TYPE_ID='REPLENISHMENT', `TO_LOCATION_ID` = shelf; `LOCATION_ID` is the reserve source — easy to invert). Re-firing the replen defers again. Space math: `DCI_LOCATION.MAX_VOLUME` (PROFILE_ID='499') − Σ on_hand × `default_item_master.ITE_ITEM.VOLUME` (cuft; no profile filter — rows are `JWN-L1-PROFILE`; never ORIGINAL_VOLUME = cubic inches) over **every item on the shelf** (Ecom shelves hold up to MAX_ITEMS = 3 SKUs). `fit`: `too_big` (carton > empty shelf → re-slot) / `needs_space` (fits empty, not the free space → make room: queued picks on the shelf, else move the biggest other item, usually one with no orders) / `fits_now`. 10/1 example: F1D1212C03 2.09 cuft, 0.26 free, A8129325 = 61% with no orders, 2 × 0.43 cuft candle cartons deferred since 8:25 AM → 2DD order stuck all day (deadlock — nothing to pick down).
- **count_open_since** — any open TSK_TASK_DETAIL on the shelf whose TRANSACTION_ID has COUNT (e.g. `NRDR CORE PICK EXCEPTION COUNT`). Shown as "may be holding the replen" — inferred, not confirmed.
- **replen_loop** — short shelf whose replen (TSK_TASK_DETAIL TYPE_ID='REPLENISHMENT', TARGET_LOCATION_ID) was cancelled ≥2× in 12 hrs. Page shows reserve free (R1B–R1F on_hand − allocated): reserve > 0 → shelf space; 0 → research.
- **has_stock** — past grace, every shelf covers it, still no task (hidden when empty). The hold-up is the release, so `stockReason()` names which part. "Ready" = latest allocation UPDATED_TIMESTAMP (MA re-points waiting allocations to a new shelf when a replen lands — seen 10/1: replen landed 9:23 PM, allocations moved 9:25 PM).
  - Multis only task when a putwall batch releases (WR_BATCH, every ~35–105 min). Singles release every 5 min (separate WORK_RELEASE_BATCH_ID every 5 min in TSK_TASK_DETAIL).
  - `single_skipped` (ready 15+ min) / `single_waiting` · `missed_batch` (ready before the last batch, left out — batch may be full) · `release_late` (no batch 2+ hrs during shift) · `next_batch` · `after_last_release` (after ~9:30 PM PDT; first batch ~5:10 AM). Night window = `NIGHT_START_MIN`/`NIGHT_END_MIN`, observed 9/30–10/1. `PDT_OFFSET_HRS` needs the DST fix.
  - Location locks / condition codes can't be checked (not in MCP) — "single_skipped" points the floor at MA's Location Inventory screen.
- **ghost** — 3000 allocation on a shipped/cancelled order. Locks shelf stock. On 10/1 all 4 were GWPs (oldest 7/13).
- **no_task_made** — 5000 allocation on an open order with **no** TSK_TASK_DETAIL row by ALLOCATION_ID (not even cancelled). TYPE_ID 'PACK', no location. Cancelled-only = short-pick leftover that re-allocates itself — not flagged.

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

Scheduled Task every 30 min. Checks for node.exe with `*dc499_refresh*`. If not running: relaunches with `--serve`. Log: dc499_watchdog.log. Setup: run `setup/dc499_watchdog_setup.bat` once. **Lock PC (Win+L) — do NOT log out.**

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

## EOS (End of Shift) Report system — ARCHIVED 2026-10-01

Unused for a long time. eos_agent.js, eos.bat, EOS_live.html moved to `archived/eos/`; the EOS Report button was removed from Ecom_v3.html. Notes below kept for reference if it's ever revived (it would need converting to scout_mcp.js).

**Files:** archived/eos/eos_agent.js, eos.bat (launcher), EOS_live.html.

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

## Dev tooling (Claude Code sessions)

- **Node isn't on the bash PATH.** Use the bundled copy: `"/c/Users/JLEO/OneDrive - Nordstrom/node/node-v24.18.0-win-x64/node.exe"` (same one dc499.bat uses). `--check file.js` does a syntax check.
- **One-shot runs are lock-safe since 2026-10-01** (scout_mcp.js), but still prefer stubbing for logic tests — a one-shot uses real query slots and writes the live JSON. To test agent logic, stub `mcpQuery` with real rows pulled via the MCP tool (or swap in a stub `scout_mcp.js` in a temp folder).
- **Page screenshots:** use headless Edge (`/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe --headless=new --virtual-time-budget=2000 --screenshot=C:/path/x.png file:///C:/path/page.html`). Stub `window.fetch` in a temp copy to feed sample JSON. Add `body{animation:none !important}` or the shot comes out dim (pageEnter fade gets frozen). Use forward-slash Windows paths.
- **Commit edits fast — the 2-min live push can eat them.** dc499_refresh.js runs `git rebase --autostash` every cycle. If a file is edited while that's mid-flight, the autostash can fail to re-apply and the edit gets stranded in `git stash list` (one autostash entry per event). Recover with `git show stash@{N}:<file>`. Prefer doing edit + commit in one step. Cleared 2026-09-30: 129 entries reviewed, the stranded file-mode/Reserve-hourly notes + pick-to-light gitignore line restored, and every code/doc diff saved as patches in `archived/stash_backup/` (local only).
- Agent files are CRLF — split on `/\r?\n/` when loading them in test scripts.

---

## Change log (Changelog.html — printed for Dean's binder)

After every **finalized major change** (new report/tab/column, a fix to a number, a version bump), add a line to `Changelog.html` in the same commit. Skip small tweaks (spacing, colors, label wording, chart cosmetics), CLAUDE.md edits, and live data pushes.
- Newest day on top: `<div class="day" data-date="YYYY-MM-DD">` + `<h2>Weekday, Mon D, YYYY</h2>`. Check the weekday with node — don't guess.
- One line per change: `<span class="rpt">Report vX.Y:</span>` + one short plain-supervisor sentence. No technical details.
- Roll several same-day edits to one report into a single line.
- One page per **Nordstrom fiscal week** (Sun–Sat), labeled "Fiscal Week N · FY2026". JS groups the `.day` blocks into `.week` sections at load. You only add day blocks. FY starts the Sunday after the Saturday closest to Jan 31 (FY2026 Wk 1 = Feb 1, 2026; Sept 27–Oct 3 = Wk 35).
- "Print from" week dropdown hides older weeks, so Dean prints only the new pages.

---

## Disclaimer (required on all dept apps)

```
Disclaimer: This tool measures throughput only and may not be used to evaluate, coach, or hold team members accountable on performance.
```

---

## Pending work

**Urgent / active:**
- [ ] **Verify scout_mcp.js live (from 2026-10-01):** after all agents are restarted on the new code, watch one shift — every agent should keep updating, no "No free MCP query slot" / "timed out" errors, no sign-in prompts. If anything goes wrong, roll back via tag `pre-shared-mcp` (see Shared sign-in section). Also consider disabling the redundant "DC499 Auto-Refresh" Windows scheduled task (one-shot dc499_refresh run alongside serve mode → two git pushes racing).
- [ ] **Backlog date bucketing** — waiting on leader sign-off. Fix: join subquery for `MIN(CREATED_TIMESTAMP)` across ALL lines (incl. cancelled) per order as bucket date, filter `CANCELLED=0` for status counts. Verified vs Cognos 2026-08-17.
- [ ] **DST fix** — ~Oct 25, 2026: change `-07:00` PDT → `-08:00` PST in scout_ecom_agent.js, scout_reserve_agent.js, scout_retail_agent.js (shift boundaries + timestamps + `pdtDateToUtcWindow` 07:00 → 08:00; Reserve hourly bucketing = `PDT_OFFSET` in scout_reserve_agent.js; `PDT_OFFSET_HRS` in scout_untasked_agent.js). See DST fix memory.
- [ ] **Verify Zones tab live (from 2026-09-24):** restart the Retail agent (option 21) so it runs the v1.1 code. Confirm a `Zones — picks: … · replen: …` line appears in the console and the tab fills in. So far it's been tested with real query results plus a page screenshot, not a full agent run.
- [ ] **NEXT SESSION — Zones tab v2:** (1) rename zones to what the team calls them (ask Dean for names first), (2) tap a zone to expand its running list of open tasks (task ID, status, units, age, source), (3) show Tasks + Units instead of Lines + Units, (4) ~~group downstairs/upstairs~~ DONE 2026-09-24 (P/F split rejected — keep zones whole). Mock up first. See Zones Tab v2 memory.
- [ ] **Retail Backlog next:** order lists for other status pills, replen tasks blocking picks, zone task visibility (Zones tab shipped v1.1 — TM-per-zone headcount still open), TM throughput, mixed-SKU case locations, open waves → release date/pending qty, failed orders by reason. See Retail Report Backlog memory.

**Pending build:**
- [ ] Packed Not Shipped: build PackedNotShipped_live.html + fetchPackedNotShipped() in dc499_refresh.js
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
