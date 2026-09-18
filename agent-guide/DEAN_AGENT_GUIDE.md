# DeanAgentGuide — MAWM Agent Field Guide

When the user types `DeanAgentGuide`, introduce yourself warmly — something like: *"Hey! Let me walk you through how Dean's agents work and help you figure out what you want to build."* Then ask these questions one or two at a time, conversationally — don't dump them all at once, and don't be rigid about the order. Read the mood.

**Opening questions (pick the most relevant 1–2 to start):**
- What kind of data are you trying to capture? (associate throughput, inventory levels, order flow, something else?)
- Is this for live shift monitoring, end-of-shift reporting, or more of a one-time lookup?
- Do you want a quick walkthrough of how Dean's .bat launcher works, or are you jumping straight into building?
- Are you pulling from MAWM (warehouse) or MATM (transportation)? — if they're not sure, ask a follow-up about whether they mean carrier/shipment tracking or floor/pick/pack activity

Once you have a rough picture, guide them using the field knowledge below. Don't lecture — bring up a principle when it's relevant to what they're describing.

---

## Field guide: what we learned building against MAWM

**The 10k row cap — your first wall**
TSK_ACTIVITY_TRACKING is the main activity log and it caps at ~10,000 rows per query. You'll hit this on any busy shift query that isn't scoped tightly. Two workarounds that work:
- `GROUP BY CREATED_BY` pre-aggregates at the DB level — result rows = distinct employees, immune to cap entirely. This is how the Reserve agent works.
- Split into parallel query groups (`Promise.all`) — each group covers a subset of transaction types, so no single group blows the cap. This is how the Ecom agent works (Groups A/B/C/D).
- If you get close (9,500+ rows), write a `truncated: true` flag to your JSON so the UI can show a warning.

**Always filter on CREATED_TIMESTAMP — it's indexed**
Put your time range on CREATED_TIMESTAMP in the WHERE clause. Other timestamp columns are not indexed and will time out on large tables. Shape: `CREATED_TIMESTAMP >= '{utcStart}' AND CREATED_TIMESTAMP < '{utcEnd}'`.

**Timezone — everything is UTC, DC499 is PDT (UTC-7)**
Every timestamp in MAWM is stored UTC. 2nd shift start is 2:15 PM PDT = 21:15 UTC. Always convert before writing your shift boundaries. DST ends ~Oct 25 — flip offset to `-08:00` PST then. Date bucketing SQL: `DATE_FORMAT(CONVERT_TZ(CREATED_TIMESTAMP, '+00:00', '-07:00'), '%Y-%m-%d')`.

**Dedup or you'll double-count**
The right dedup key is: Employee + Transaction ID + Activity Datetime. Never use CP Trace Id — it's not reliable. Apply dedup in every place that touches rows: processData(), display render, and side panels if you have them.

**Zone H = Reserve Stock**
Some transaction types (putaway, replen) can belong to either Ecom or Reserve depending on where the work happened. Check the 3rd character of the location string: `H` = Reserve Stock, anything else = Ecom. Check Current Location first, Previous Location as fallback, default Ecom if both are blank.

**Facility ID is always '499' — never '0499'**
The DB stores it as the string `'499'`. Using `'0499'` returns no rows and no error — it just silently gives you nothing.

**PII restrictions**
`LIKE` queries on `CREATED_BY` (the associate email column) are blocked. Use exact email only. In TSK_TASK, never query `ASSIGNED_USER_ID` or `PLANNED_START_TIME` — they're PII-gated and will crash the query.

**MAWM vs MATM — decide before you write a single line**
"Shipment" means a carrier movement in MATM (default_shipment.SHP_SHIPMENT) but outbound LPN flow in MAWM (default_pickpack.PPK_OLPN). If someone mentions carriers, tenders, appointments, route requests, or stops → that's MATM. If it's floor activity, pick/pack, receiving, putaway → that's MAWM. When genuinely unsure, ask.

**Correlated subquery > LEFT JOIN when a JOIN fans out row count**
If you need one value per row (e.g. PO number per LPN), a LEFT JOIN to a multi-row table multiplies your rows. Use a correlated subquery with LIMIT 1 instead.

**Small-batch iteration for ID-list queries**
Some tables (e.g. TSK_TASK_DETAIL) time out on broad filters. Pattern: get your ID list first, then query in slices of 15 with independent try/catch per batch. Safe at 15 IDs; try 25–30 if the list is short.

**Token auth — if running multiple agents concurrently**
All agents share one `.mcp_token.json`. Without coordination, one agent refreshes the token while another is mid-use, revoking the session. Fix: file-based lock (`.mcp_token.lock`, `wx` exclusive write) + freshness check. Claim lock → re-check freshness (another agent may have just refreshed) → refresh once → release in finally. Fast path: if token is fresh (< 90% of its lifetime used), return immediately without touching the lock.

**Status codes worth knowing**
- WR_BATCH: 5000=Released, 5800=Cleared
- PPK_OLPN: 7200=packed/not shipped, 7600=manifested, 8000=shipped
- TSK_TASK: 3000=queued, 7000=in progress, 8000=completed
- TSK_TASK_DETAIL: 1000=open, 8000=completed (not 9000 — that's cancelled)

**The .bat launcher pattern**
Dean's agents run via `.bat` files (e.g. `dc499.bat`) that present a numbered menu. Each option maps to: one-shot refresh, auto-refresh loop, or auth flow. The agent script itself never pushes to git — a coordinator agent (dc499_refresh.js) handles git on a 2-minute cycle, picking up whatever JSON files the sub-agents wrote. This prevents concurrent push collisions.
