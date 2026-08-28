# SCOUT Engineering Reference
### DC499 Reporter Suite — Internal Architecture & Mechanics

This document covers the internal implementation details of the SCOUT agent layer and data pipeline. It is intended for engineers extending, migrating, or replicating the system. For setup instructions see `SETUP_NEW_PC.md`. For security practices see `security.md`.

---

## Table of Contents

1. [System overview](#1-system-overview)
2. [Agent architecture](#2-agent-architecture)
3. [Authentication & token management](#3-authentication--token-management)
4. [Query architecture](#4-query-architecture)
5. [Deduplication logic](#5-deduplication-logic)
6. [Zone routing (department attribution)](#6-zone-routing-department-attribution)
7. [Shift detection](#7-shift-detection)
8. [Timezone handling](#8-timezone-handling)
9. [JSON payload schemas](#9-json-payload-schemas)
10. [Git push pattern](#10-git-push-pattern)
11. [Teams webhook routing](#11-teams-webhook-routing)
12. [EOS (End-of-Shift) system](#12-eos-end-of-shift-system)
13. [Live page polling](#13-live-page-polling)
14. [PPH projection math](#14-pph-projection-math)
15. [Row cap handling](#15-row-cap-handling)
16. [Key SQL patterns](#16-key-sql-patterns)
17. [MAWM table reference](#17-mawm-table-reference)

---

## 1. System overview

SCOUT is split into two layers:

**Static layer** — HTML/CSS/JS files hosted on SharePoint (intranet). No server, no build step. CSV-mode features run entirely in the browser. Live-mode features fetch JSON payloads served from GitHub CDN.

**Agent layer** — Node.js processes running on a single DC floor PC. They authenticate to the MAWM database via OIDC, run SQL queries through an MCP connector, write JSON files locally, and push them to the GitHub repository on a 2-minute cycle.

The browser never touches MAWM directly. It only reads the JSON files that the agents push.

---

## 2. Agent architecture

### Coordinator: `dc499_refresh.js`

Runs continuously (or can be triggered once). On each 2-minute cycle:

1. Fires all data queries in parallel
2. Writes updated JSON files to disk
3. Runs `git fetch origin main → git rebase --autostash origin/main → git push origin main`
4. Sends Teams notifications for new cleared batches

It also imports results written by the three sub-agents (ecom, reserve, shipping) and includes them in the same commit. Sub-agents never push to git themselves.

### Sub-agents

| Agent | Output file | Trigger |
|---|---|---|
| `scout_ecom_agent.js` | `ecom_live.json` | `dc499.bat` options 5/6/7 |
| `scout_reserve_agent.js` | `reserve_live.json`, `putaway_live.json` | `dc499.bat` options 11/12/13 |
| `scout_shipping_agent.js` | `shipping_live.json` | `dc499.bat` options 8/9/10 |

Sub-agents write their JSON locally and exit. The coordinator picks up the file on its next cycle and includes it in the commit. This prevents concurrent git push collisions — only one process ever calls `git push`.

### Watchdog: `dc499_watchdog.ps1`

Runs as a Windows Scheduled Task every 30 minutes. Checks for a `node.exe` process matching `*dc499_refresh*`. If not found, launches `dc499.bat --serve`. Log: `dc499_watchdog.log`.

**Critical:** The watchdog runs under the logged-in Windows user account. If the user logs out (not just locks), the scheduled task cannot run. **Always lock (Win+L) — never log out.**

---

## 3. Authentication & token management

### OIDC flow

All four agents share a single OIDC session stored in `.mcp_token.json`. The token is obtained via Nordstrom SSO (OAuth 2.0 PKCE flow) and refreshed automatically using the stored refresh token.

Fields in `.mcp_token.json`:
```json
{
  "access_token": "...",
  "refresh_token": "...",
  "expires_in": 3600,
  "_saved_at": 1724800000000
}
```

`_saved_at` is a Unix timestamp (ms) written on every save. It is used to determine token freshness without trusting the system clock at read time.

### Token freshness check

```
TOKEN_TTL = 55 * 60 * 1000  (fallback: 55 min)

isTokenFresh():
  if stored.expires_in exists:
    threshold = stored.expires_in * 900   // 90% of actual lifetime (ms)
  else:
    threshold = TOKEN_TTL
  return (Date.now() - stored._saved_at) < threshold
```

Using 90% of the actual lifetime prevents the agent from presenting a token that will expire mid-query.

### File-based lock (prevents token collisions)

When multiple agents run concurrently, they share one token file. Without coordination, two agents can simultaneously detect an expired token and both call the refresh endpoint — the second refresh invalidates the first, revoking the session.

Fix: `.mcp_token.lock` is an exclusive-write lock file.

```
getAccessTokenSilent():
  1. Read token file
  2. isTokenFresh() → return immediately (fast path, no network)
  3. Acquire lock: open .mcp_token.lock with flag 'wx' (fails if exists)
     - If lock exists: wait 200ms, retry up to 5 times
  4. Re-check freshness after acquiring lock
     (another agent may have just refreshed — avoids double refresh)
  5. Refresh token via OIDC endpoint
  6. Write updated token file (including new _saved_at)
  7. Release lock in finally block
```

### Re-authentication

When a refresh token is expired or invalid, the agent detects `AuthError`, launches the full browser-based OIDC flow (`doAuthFlow()`), and sends a Teams alert via `TEAMS_WEBHOOK_AUTH_ALERT`.

The `AUTH_PIN = '020405'` convenience endpoint (`localhost:3001/auth?pin=020405`) triggers re-authentication without requiring the PC password. It only initiates the OAuth browser flow — it does not grant data access directly.

---

## 4. Query architecture

### MCP connector

Agents call MAWM SQL via a local MCP server (Claude Code's `mawm-data-http-prod` connector). Queries are passed as strings to `mcpQuery(token, sql)`. The connector returns `{ rows: [...] }`.

**Facility ID:** Always `'499'` (string, no leading zero). The MAWM database stores it as a VARCHAR — `'0499'` returns zero rows.

**PII restriction:** `LIKE` queries on `CREATED_BY` (associate email) are blocked at the connector level. Use exact email match only, or do not filter on `CREATED_BY` at the query level (filter in JS after fetch).

### Parallel query groups

To avoid sequential round-trips, each agent fires multiple independent queries via `Promise.all`. Example pattern from `scout_ecom_agent.js`:

```js
const [groupA, groupB, groupC, groupD] = await Promise.all([
  mcpQuery(token, sqlReplenPutaway),
  mcpQuery(token, sqlPicking),
  mcpQuery(token, sqlPacking),
  mcpQuery(token, sqlShipping),
]);
```

Groups are sized to stay under the ~10,000 row cap (see section 15).

### Pre-aggregation (Reserve / Shipping)

Reserve and Shipping agents use `GROUP BY CREATED_BY` in SQL rather than fetching raw rows. This makes them immune to the row cap regardless of shift volume — the result set is bounded by the number of distinct associates, not the number of transactions.

```sql
SELECT
  CREATED_BY AS employee,
  SUM(COMPLETED_QTY) AS units
FROM default_task.TSK_ACTIVITY_TRACKING
WHERE FACILITY_ID = '499'
  AND TRANSACTION_ID IN (...)
  AND CREATED_TIMESTAMP >= '{shiftStart}'
GROUP BY CREATED_BY
```

---

## 5. Deduplication logic

**Dedup key:** `Employee + Transaction ID + Activity Datetime`

This triplet is unique per scan event. Do not use CP Trace Id — it is not reliably populated.

In the browser (CSV mode), dedup is applied in `processData()` using a `Set` of composite keys. In the agent layer, raw rows are returned per-employee (pre-aggregated); dedup at the row level is not needed because `GROUP BY` already collapses duplicates.

**Container ID dedup (Shipping, Receiving):** For palletize and LPN receive activities, the metric is unique containers handled — not row count or unit sum. Dedup is applied on `Container ID` per employee. Earliest timestamp wins for shift-hour attribution.

---

## 6. Zone routing (department attribution)

Some transaction IDs appear in both Ecom and Reserve workflows. The routing rule uses the warehouse location to determine which department to credit.

**Rule:**
- If the 3rd character of the location string is `H` → Reserve Stock
- Any other zone → Ecom
- Check `Current Location` first; fall back to `Previous Location`; default to Ecom if both are blank

**Applies to:** System Directed Putaway, User Directed Putaway, iLPN Replen Fill, iLPN Replen Pull, iLPN Replen Fill Large, iLPN Replen Pull Large

**Implementation locations:** This logic must be applied consistently in three places:
1. `processData()` — during CSV row processing
2. `addToFullReport()` — when building the full report aggregate
3. `renderSidePanel()` — when displaying department drill-down

Omitting it from any one of these three will cause department totals to diverge.

---

## 7. Shift detection

### Agent side (UTC hours)

```
is1stShift = nowUtcHour >= 10 && nowUtcHour < 21
is2ndShift = all other hours (evening/overnight)
```

Shift boundaries used in queries:
- 2nd shift start: `21:15 UTC` (2:15 PM PDT) — written as `shiftStart` in queries
- 1st shift start: `10:00 UTC` (3:00 AM PDT) — written as `shiftStart` for 1st shift arm
- Receiving: 2nd = `21:00 UTC`, 1st = `13:00 UTC`
- Shipping: 2nd = `22:15 UTC`, 1st = `11:00 UTC`
- Waves: 2nd = `20:40 UTC`, 1st = `10:00 UTC`

### Browser side (PDT hours)

Live pages read `shift_label` and `shift_start_utc` from the JSON payload — they do not re-derive shift from the local clock.

CSV mode uses a shift selector (1st / 2nd) in Settings. Each shift has a separate roster stored in `localStorage`.

### Carryover batches

The coordinator uses a 14-hour lookback arm in the batch query to catch 1st-shift batches that were not cleared by the time 2nd shift started:

```sql
WHERE (CREATED_TIMESTAMP >= '{shiftStart}')
   OR (STATUS_ID != 5800 AND CREATED_TIMESTAMP >= '{lookbackStart}')
```

`lookbackStart` = 14 hours before current time.

---

## 8. Timezone handling

**Rule: all MAWM timestamps are stored UTC. DC499 operates PDT (UTC−7). Always convert before filtering or displaying.**

### SQL conversion

```sql
DATE_FORMAT(CONVERT_TZ(CREATED_TIMESTAMP, '+00:00', '-07:00'), '%Y-%m-%d') AS line_date
```

Use this for any date-bucketing query. Do not rely on the raw `CREATED_TIMESTAMP` date component — it will give wrong results for any activity before 7 AM PDT (before UTC midnight).

### JavaScript conversion (agent side)

```js
// PDT string → UTC ISO for query parameters
function pdtToUtc(pdtStr) {
  return new Date(pdtStr.replace(' ', 'T') + '-07:00')
    .toISOString().slice(0, 19).replace('T', ' ');
}
```

### DST note

The `-07:00` offset is correct for PDT (March–November). Around October 25, 2026 (before DST ends November 1), the agents must be updated to use `-08:00` PST for the winter period. Affected files: `scout_ecom_agent.js`, `scout_reserve_agent.js`, `scout_shipping_agent.js`, `dc499_refresh.js` (Receiving shift boundaries). This is flagged in memory as a deferred fix.

---

## 9. JSON payload schemas

### `ecom_live.json`

```json
{
  "generated": "2026-08-27T21:30:00Z",
  "shift": "2nd",
  "shift_start_utc": "2026-08-27T21:15:00Z",
  "truncated": false,
  "associates": [
    {
      "email": "first.last@nordstrom.com",
      "replen": 0,
      "putaway": 0,
      "pick": 0,
      "pack": 0,
      "ship": 0,
      "sort": 0,
      "total": 0,
      "hours": { "14": 0, "15": 0, "16": 0, "17": 0, "18": 0, "19": 0, "20": 0, "21": 0 }
    }
  ],
  "totals": { "replen": 0, "putaway": 0, "pick": 0, "pack": 0, "ship": 0, "sort": 0, "total": 0 },
  "hourly": { "14": 0, "15": 0, "16": 0, "17": 0, "18": 0, "19": 0, "20": 0, "21": 0 }
}
```

`truncated: true` is set when any query group returns ≥ 9,500 rows.

### `reserve_live.json`

```json
{
  "generated": "2026-08-27T21:30:00Z",
  "shift": "2nd",
  "associates": [
    {
      "email": "first.last@nordstrom.com",
      "pick_f1": 0,
      "pick_f2": 0,
      "replen": 0,
      "putaway": 0,
      "total": 0
    }
  ],
  "totals": { "pick_f1": 0, "pick_f2": 0, "replen": 0, "putaway": 0, "total": 0 }
}
```

### `shipping_live.json`

```json
{
  "generated": "2026-08-27T21:30:00Z",
  "shift": "2nd",
  "associates": [
    {
      "email": "first.last@nordstrom.com",
      "total": 0,
      "hours": { "14": 0, "15": 0, "16": 0 }
    }
  ],
  "totals": { "total": 0 },
  "hourly": { "14": 0, "15": 0, "16": 0 }
}
```

Shipping hourly keys are PDT hour integers (14 = 2 PM PDT). Dedup per employee per container — earliest hour wins for attribution.

### `receiving_live.json`

```json
{
  "generated": "2026-08-27T21:30:00Z",
  "shift": "2nd",
  "associates": [
    {
      "email": "first.last@nordstrom.com",
      "lpns": 0,
      "hours": { "14": 0, "15": 0, "16": 0 }
    }
  ],
  "totals": { "lpns": 0 },
  "hourly": { "14": 0, "15": 0, "16": 0 }
}
```

### `batch_status.json`

```json
{
  "generated": "...",
  "facility": "499",
  "shift_label": "2nd",
  "shift_start_utc": "...",
  "summary": {
    "total_batches": 0,
    "cleared": 0,
    "active_batches": 0,
    "avg_mins_to_clear": 0,
    "avg_release_interval_mins": 0
  },
  "batches": [
    {
      "batch_num": 1,
      "batch_id": "...",
      "work_release_batch_id": "...",
      "total_orders": 0,
      "total_olpns": 0,
      "total_tasks": 0,
      "task_details": { "total": 0, "done": 0, "pct": 0 },
      "status_code": "5200",
      "status_label": "Picking Started",
      "released_pdt": "2:15 PM",
      "cleared_pdt": null,
      "mins_to_clear": null,
      "is_cleared": false,
      "mins_since_prev_release": 0
    }
  ]
}
```

### `backlog_live.json`

Key fields relevant to live page rendering:
```json
{
  "generated": "...",
  "shift_label": "2nd",
  "rfp_units": 0,
  "open_orders": 0,
  "open_units": 0,
  "allocated_orders": 0,
  "shipped_orders": 0,
  "daily_totals": [
    { "date": "2026-08-27", "orders": 0, "units": 0 }
  ]
}
```

`rfp_units` = units at Ready-for-Pack staging location `D1-SN-01` (DCI_ILPN STATUS=5000).

---

## 10. Git push pattern

The coordinator uses this exact sequence — do not substitute `git pull --rebase`:

```bash
git add receiving_live.json dock_live.json totes_live.json backlog_live.json \
        batch_status.json retail_replen.json shipped_live.json tasks_live.json \
        ecom_live.json shipping_live.json reserve_live.json putaway_live.json

git commit -m "Live update -- {stamp} [+ecom, +shipping, +reserve]"

git fetch origin main
git rebase --autostash origin/main
git push origin main
```

**Why `fetch + rebase` instead of `pull --rebase`:** Claude Code's MCP connector internally calls git fetch during some operations, which populates `FETCH_HEAD` with multiple remote entries. `git pull --rebase` reads `FETCH_HEAD` and fails with "Cannot rebase onto multiple branches" when multiple entries exist. `git fetch origin main` populates `FETCH_HEAD` with exactly one entry; `git rebase origin/main` uses the named ref directly.

Commit message appends `[+ecom]`, `[+shipping]`, `[+reserve]` only when the corresponding sub-agent file was updated in the current cycle.

---

## 11. Teams webhook routing

Teams Adaptive Cards are sent via Power Automate webhook URLs embedded in HTML/JS source. Plain-text alert bodies use a separate webhook that accepts `{"text": "..."}` only (not Adaptive Card format — the flow is configured for plain text).

**Shift routing logic:**
```
getShift() in browser:
  PDT hour 6–13 (6 AM–2 PM) → 1st shift webhook
  PDT hour 14–21 (2 PM–10 PM) → 2nd shift webhook
```

**Notification events:**

| Event | Trigger | Payload type |
|---|---|---|
| Batch cleared | Auto, on status transition in `batch_status.json` | Adaptive Card |
| Manual shift summary | Button press in any live page | Adaptive Card |
| Auth expiry | Agent detects AuthError | Plain text |

---

## 12. EOS (End-of-Shift) system

### Purpose

Captures a point-in-time snapshot at the start of 2nd shift (SOS = Start of Shift Snapshot) and again at end-of-shift (EOS). The diff between the two snapshots shows what 2nd shift accomplished.

### Files

- `eos_agent.js` — queries MAWM for current state
- `eos_sos_snapshot.json` — written by option 1/3 (SOS)
- `eos_report.json` — written by option 2 (EOS + finalize); contains `{ sos: {...}, eos: {...} }`
- `EOS_live.html` — reads `eos_report.json` and renders the comparison

### Metrics captured

| Metric | Table | Notes |
|---|---|---|
| Open orders | `DCO_ORDER` | `MAXIMUM_STATUS = '1000'` |
| Open units | `DCO_ORDER_LINE` | Active lines only (`CANCELLED = 0`) |
| Hospital orders | `PPK_OLPN` | `STATUS` codes for exception states |
| Packed, not shipped | `PPK_OLPN` | `STATUS = 7200` |
| Loaded virtually | `PPK_OLPN` | `STATUS = 7800` |
| Batches released | `WR_BATCH` | Count this shift |
| Waves run | `DCO_ORDER_PLAN_RUN_STRATEGY` | Count this shift |

### Waves vs. Batches

These are distinct concepts mapped to different tables:
- **Waves** = planner runs (`DCO_ORDER_PLAN_RUN_STRATEGY`) — the planning event
- **Batches** = work-release pools to putwalls (`WR_BATCH`) — the execution event

One wave can produce multiple batches. Do not conflate them.

### Orders not yet released (open orders filter)

```sql
WHERE MAXIMUM_STATUS = '1000'
  AND CREATED_TIMESTAMP < '{captureTime}'
```

The `CREATED_TIMESTAMP < captureTime` clause is required. Without it, the query includes fresh customer orders that arrived after the snapshot — inflating the "orders not yet released" count. This cap is currently missing from `captureSnapshot()` and is a known pending fix.

### Metrics that cannot be reconstructed

The following are current-state only — they cannot be reconstructed from history:
- `open_orders`, `open_units` — order status is mutable; history not retained in these tables
- `hospital_orders`, `packed_not_shipped`, `loaded_virtually`

If option 1 (SOS) is not run at shift start, option 3 (Reconstruct SOS) sets these fields to `null` in the report.

---

## 13. Live page polling

All live HTML pages follow the same polling pattern:

```js
async function refresh() {
  const data = await fetch(`${BASE}/ecom_live.json?t=${Date.now()}`).then(r => r.json());
  render(data);
}

setInterval(refresh, 60_000);  // 60-second poll
refresh();                     // immediate on load
```

`?t=Date.now()` cache-busts the CDN. Without this, GitHub's CDN can serve a stale file for several minutes.

`BASE` is derived from the current page URL — it points to the SharePoint origin in production (or NordTech GitHub Pages once that is established), or `localhost:3001` when the PC server is running locally.

---

## 14. PPH projection math

Applied in `Ecom_v3.html` (Backlog_live section). All times are PDT.

```
SHIFT_START       = 14:15 (2:15 PM)
SHIFT_END_CAP     = 22:45 (10:45 PM)
PRODUCTIVE_HOURS  = 8.0
LUNCH_AFTER       = 18:15 (6:15 PM)   → deducts 0.5h if now > 18:15
TOTAL_SHIFT_MINS  = 8.0 * 60 = 480

elapsed_mins      = now_pdt - SHIFT_START (capped at SHIFT_END_CAP)
if now > LUNCH_AFTER:
  elapsed_mins -= 30

fraction_elapsed  = elapsed_mins / TOTAL_SHIFT_MINS   (0.0 → 1.0)
projected_units   = headcount * pph_target * PRODUCTIVE_HOURS * fraction_elapsed

on_pace           = actual_units >= projected_units
```

Headcount and PPH target are read from Settings (`ecom_headcount_v1`, `ecom_pph_v1` localStorage keys).

---

## 15. Row cap handling

The MAWM MCP connector returns at most ~10,000 rows per query. On a busy shift, a single broad query (all transaction IDs, all employees, full shift window) can exceed this.

**Detection:** Check `rows.length >= 9500` after any query. If true, set `truncated: true` in the JSON and display an amber warning in the UI.

**Prevention strategies:**

1. **Pre-aggregate in SQL** (`GROUP BY CREATED_BY`) — result set bounded by employee count, not transaction count. Used in Reserve and Shipping agents.

2. **Split by transaction group** — Ecom agent fires 4 parallel queries (Groups A–D), each covering a subset of transaction IDs. Each group is sized to stay under 10k on any expected shift volume.

3. **Small-batch ID loop** — for queries that need per-ID detail (e.g. TSK_TASK_DETAIL counts per open task): fetch the ID list first, then query in batches of 15:

```js
const BATCH_SZ = 15;
const resultMap = {};
for (let i = 0; i < ids.length; i += BATCH_SZ) {
  const batch = ids.slice(i, i + BATCH_SZ).map(id => `'${id}'`).join(',');
  try {
    const r = await mcpQuery(token,
      `SELECT ID, COUNT(*) AS cnt FROM table WHERE ID IN (${batch}) GROUP BY ID`);
    for (const row of r.rows) resultMap[row.ID] = Number(row.cnt);
  } catch (e) { console.warn(`Batch ${Math.floor(i/BATCH_SZ)} failed: ${e.message}`); }
}
```

Batch size 15 is safe; 25–30 is feasible if the ID list is large.

---

## 16. Key SQL patterns

### Date bucketing (PDT)

```sql
DATE_FORMAT(CONVERT_TZ(CREATED_TIMESTAMP, '+00:00', '-07:00'), '%Y-%m-%d') AS line_date
```

### Shift window filter

```sql
WHERE FACILITY_ID = '499'
  AND CREATED_TIMESTAMP >= '{shiftStartUtc}'
  AND CREATED_TIMESTAMP < '{nextShiftStartUtc}'
```

Always filter on `CREATED_TIMESTAMP` (indexed). Do not use `DATE(CREATED_TIMESTAMP)` for range filters — it bypasses the index.

### Zone routing in SQL (optional — can be done in JS)

```sql
CASE
  WHEN SUBSTR(COALESCE(NULLIF(CURRENT_LOCATION_ID,''), PREVIOUS_LOCATION_ID, ''), 3, 1) = 'H'
  THEN 'Reserve'
  ELSE 'Ecom'
END AS zone
```

### Ready for Pack (D1-SN-01 staging)

```sql
SELECT SUM(inv.ON_HAND) AS rfp_units
FROM default_dcinventory.DCI_ILPN ilpn
JOIN default_dcinventory.DCI_INVENTORY inv
  ON inv.ILPN_ID = ilpn.ILPN_ID
  AND inv.FACILITY_ID = ilpn.FACILITY_ID
WHERE ilpn.FACILITY_ID = '499'
  AND ilpn.CURRENT_LOCATION_ID = 'D1-SN-01'
  AND ilpn.STATUS = '5000'
```

### PO number lookup (avoiding fan-out)

Use a correlated subquery with `LIMIT 1` to get one PO per iLPN. A plain `LEFT JOIN` on `RCV_RECEIPT` multiplies rows by scan count:

```sql
(
  SELECT PO_NUMBER
  FROM default_receiving.RCV_RECEIPT r
  WHERE r.CONTAINER_ID = ilpn.LPN_ID
    AND r.FACILITY_ID = ilpn.FACILITY_ID
  ORDER BY r.CREATED_TIMESTAMP ASC
  LIMIT 1
) AS po_number
```

---

## 17. MAWM table reference

### Core tables used by SCOUT

| Schema | Table | Primary use |
|---|---|---|
| `default_task` | `TSK_ACTIVITY_TRACKING` | All scan-level productivity (Ecom, Receiving, Shipping) |
| `default_task` | `TSK_TASK` | Open task list, task status by type |
| `default_task` | `TSK_TASK_DETAIL` | Sub-task completion counts |
| `default_receiving` | `RCV_RECEIPT` | Associate-level receiving scans |
| `default_receiving` | `RCV_ASN` | ASN/PO metadata |
| `default_dcorder` | `DCO_ORDER` | Order status (open, shipped) |
| `default_dcorder` | `DCO_ORDER_LINE` | Per-line status, unit counts |
| `default_dcorder` | `DCO_ORDER_PLAN_RUN_STRATEGY` | Wave planning runs |
| `default_workrelease` | `WR_BATCH` | Batch/putwall release pools |
| `default_pickpack` | `PPK_OLPN` | oLPN status (packed, manifested, shipped) |
| `default_dcinventory` | `DCI_ILPN` | iLPN location and status |
| `default_dcinventory` | `DCI_INVENTORY` | Unit quantities per iLPN |
| `default_lmcore` | `LMC_THROUGHPUT` | Labor management throughput |

### Status code reference

**`WR_BATCH.STATUS_ID`**

| Code | Label |
|---|---|
| 5000 | Released |
| 5200 | Picking Started |
| 5400 | Picking Completed |
| 5600 | In Queue |
| 5800 | Cleared |

**`PPK_OLPN.STATUS`**

| Code | Label |
|---|---|
| 1000 | Created |
| 7100 | Packing Started |
| 7200 | Packed / Not Shipped |
| 7600 | Manifested |
| 7800 | Loaded Virtually |
| 8000 | Shipped |
| 9000 | Cancelled |

**`TSK_TASK.STATUS`**

| Code | Label |
|---|---|
| 3000 | Queued |
| 5000 | Assigned |
| 7000 | In Progress |
| 8000 | Completed |
| 9000 | Cancelled |

**`TSK_TASK_DETAIL.STATUS`**

| Code | Label |
|---|---|
| 1000 | Open |
| 8000 | Completed |
| 9000 | Cancelled |

Use `STATUS = '8000'` for done count — `9000` is cancelled, not completed.

### Columns to avoid

| Table | Column | Reason |
|---|---|---|
| `TSK_TASK` | `ASSIGNED_USER_ID` | PII-gated — query crashes |
| `TSK_TASK` | `PLANNED_START_TIME` | PII-gated — query crashes |
| `TSK_ACTIVITY_TRACKING` | `CREATED_BY` (LIKE) | Blocked at connector — exact match only |

### Picking filter (TSK_TASK)

Use `TRANSACTION_ID` to filter picking tasks — do not use `LABOR_ACTIVITY_ID`. It is unreliable and usually shows "Default Picking Activity" regardless of actual task type.

```sql
WHERE TRANSACTION_ID IN (
  'Ecom Mezz Pick To Putwall Cart',
  'Ecom Non-Mezz Pick To Putwall Cart'
)
```

---

*DC499 Operations · SCOUT v3 · Last updated 2026-08-27*
