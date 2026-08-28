# SCOUT — Shift Centralized Output Utilization Tracker
### DC499 Reporter Suite · Nordstrom DC499 Operations

A browser-based reporting suite that delivers real-time associate throughput visibility across multiple departments. Built and maintained by Dean Karim, Warehouse Trainer at DC499. All data sourced from MAWM (warehouse management system).

---

## Hosting

**Primary:** SharePoint static site (Nordstrom intranet)
**Source:** NordTech GitHub — `DC499-reports` repository

Static HTML/CSS/JS — no build system, no backend. Files are served directly; any static file host works.

---

## What it does

The suite has two modes:

**CSV mode** — a support team member exports an activity tracking CSV from MAWM, drops it into the tool, and gets an instant leaderboard, hourly chart, and shift summary in under 30 seconds.

**Live mode** — a Node.js agent running on a DC floor PC queries MAWM directly via an MCP connector, writes JSON payloads, and pushes them to the repo on a 2-minute cycle. Live pages poll the JSON automatically — no CSV needed, no page reload.

---

## Departments covered

| Department | Metrics tracked |
|---|---|
| Ecom | Replenishment, Putaway, Picking, Packing, Shipping, Sorting |
| Reserve Stock | Pick F1, Pick F2, Replenishment, Putaway, Putaway WIP |
| Item Prep | Item Level Receive, Condition Code Removal |
| Receiving | LPN Receive (live, hourly scoreboard) |
| Shipping | Palletize oLPN (live, hourly scoreboard) |

---

## Files

### HTML — menus and reports

| File | Description |
|---|---|
| `index.html` | Redirects to Menu |
| `Menu_v1.6.html` | Department selection menu |
| `Ecom_v3.html` | Ecom report processor (CSV + live) |
| `Reserve_v1_7.html` | Reserve Stock report processor (CSV + live) |
| `Reserve_putaway.html` | Reserve putaway WIP report (live) |
| `Reserve_weekly.html` | Reserve weekly recap (bar charts, per-day detail) |
| `ItemPrep_v2.0.html` | Item Prep report processor (CSV) |
| `Receiving_live.html` | Receiving live dashboard (hourly scoreboard) |
| `Shipping_live.html` | Shipping live dashboard (hourly scoreboard) |
| `Backlog_live.html` | Backlog + PPH projection dashboard |
| `Batches_live.html` | Wave/batch status dashboard |
| `Totes_live.html` | Tote status live view |
| `RetailReplen_live.html` | Retail replenishment live view |
| `EOS_live.html` | End-of-Shift report viewer |

### JSON — live data payloads (auto-updated by agents)

| File | Written by | Contents |
|---|---|---|
| `ecom_live.json` | `scout_ecom_agent.js` | Ecom associate metrics, hourly breakdown |
| `reserve_live.json` | `scout_reserve_agent.js` | Reserve associate metrics |
| `putaway_live.json` | `scout_reserve_agent.js` | Reserve putaway WIP (pending iLPNs) |
| `shipping_live.json` | `scout_shipping_agent.js` | Shipping associate metrics, hourly breakdown |
| `receiving_live.json` | `dc499_refresh.js` | Receiving associate metrics, hourly breakdown |
| `backlog_live.json` | `dc499_refresh.js` | Open orders, PPH pace, backlog by date |
| `batch_status.json` | `dc499_refresh.js` | Wave/batch status, release cadence |
| `tasks_live.json` | `dc499_refresh.js` | Open tasks, pick-drop carts |
| `totes_live.json` | `dc499_refresh.js` | Tote status counts |
| `retail_replen.json` | `dc499_refresh.js` | Retail replenishment metrics |
| `shipped_live.json` | `dc499_refresh.js` | Shipped oLPN counts |

### Node.js agents (run on the DC floor PC)

| File | Role |
|---|---|
| `dc499_refresh.js` | Coordinator — queries MAWM, writes all primary JSON, pushes to NordTech GitHub every 2 min |
| `scout_ecom_agent.js` | Sub-agent — Ecom metrics |
| `scout_reserve_agent.js` | Sub-agent — Reserve metrics + putaway WIP |
| `scout_shipping_agent.js` | Sub-agent — Shipping metrics |
| `eos_agent.js` | End-of-Shift snapshot agent (run manually at shift boundaries) |

### Launchers and utilities

| File | Description |
|---|---|
| `dc499.bat` | Main launcher — all agents, auth, and server options in one menu |
| `eos.bat` | EOS agent launcher |
| `dc499_watchdog.ps1` | Watchdog — restarts coordinator if process dies (runs as Scheduled Task) |
| `dc499_watchdog_setup.bat` | One-time setup for the Scheduled Task |
| `SETUP_NEW_PC.md` | New PC setup walkthrough |

---

## Architecture

### Static layer

The front end is pure HTML/CSS/JS — no framework, no build step. Report pages are served from SharePoint (Nordstrom intranet). The live JSON data files are hosted separately in the NordTech GitHub repository and fetched by the browser over HTTPS.

This split-host model means the pages and the data live in two different places:
- **SharePoint** — hosts the HTML/CSS/JS report files
- **NordTech GitHub** — hosts the live JSON data payloads

CDN dependencies loaded at runtime:
- **PapaParse 5.4.1** — CSV parsing
- **Chart.js 4.4.1** — charts

User preferences (roster, goals, headcount, PPH targets, theme) are stored in `localStorage`. No backend needed for CSV-mode features.

### Agent layer (DC floor PC)

Four Node.js agents run independently on the floor PC:

```
DC Floor PC
├── dc499_refresh.js       ← coordinator (every 2 min, only process that pushes to git)
├── scout_ecom_agent.js    ← sub-agent, writes ecom_live.json
├── scout_reserve_agent.js ← sub-agent, writes reserve_live.json + putaway_live.json
├── scout_shipping_agent.js← sub-agent, writes shipping_live.json
└── eos_agent.js           ← manual, run at shift boundaries
```

Sub-agents run independently and write their JSON files locally. The coordinator picks them up on its next 2-minute cycle and pushes everything to NordTech GitHub in a single commit. Only the coordinator ever touches git — this prevents concurrent push collisions.

Each agent authenticates to MAWM via OIDC SSO. A file-based lock (`mcp_token.lock`) prevents token collisions when multiple agents refresh credentials simultaneously.

### Data flow

```
MAWM database
    ↓  (OIDC auth, MCP connector)
DC Floor PC agents  →  *.json files (local disk)
    ↓  (git push, every 2 min — coordinator only)
NordTech GitHub repo  (live JSON data)
    ↓  (HTTPS fetch, every 60s)
Browser  →  SharePoint-hosted HTML pages
```

### Watchdog

`dc499_watchdog.ps1` runs as a Windows Scheduled Task every 30 minutes. If the coordinator process is not running, it relaunches it automatically. **Lock the PC (Win+L) when leaving — do not log out.**

---

## Running the agents

Always use `dc499.bat` — never invoke Node directly.

```
dc499.bat options:
  1  Refresh data once (all primary JSON)
  2  Start live server on :3001
  3  Start live server + open Receiving Live
  4  Re-authenticate (dc499_refresh)
  5  Ecom Live — one-shot refresh
  6  Ecom Live — auto-refresh every 3 min
  7  Ecom Live — auth
  8  Shipping Live — one-shot refresh
  9  Shipping Live — auto-refresh every 3 min
  10 Shipping Live — auth
  11 Reserve Live — one-shot refresh
  12 Reserve Live — auto-refresh every 3 min
  13 Reserve Live — auth
```

**EOS (End of Shift):**
```
eos.bat options:
  1  SOS snapshot (run at 2:10 PM, start of 2nd shift)
  2  EOS + finalize (run at shift end)
  3  Reconstruct SOS (if option 1 was missed)
  4  Auth
```

---

## Metrics reference

### Ecom

| Activity | Metric |
|---|---|
| iLPN Replen Fill / Pull (all variants) | Sum Completed Quantity |
| System / User Directed Putaway | Row count (zone-filtered) |
| Ecom Mezz / Non-Mezz Pick To Putwall Cart | Sum Quantity |
| NRDR CORE PACK FOR ECOM PACK STATION | Sum Quantity |
| OB Putaway By Ship Via | Sum Quantity, dedup by Container ID |
| NRDR Load Parcel Packages | Sum Quantity, dedup by Container ID |
| OB Sort To Putwall Cubby + NRDR_SORT criteria | Sum Quantity |

### Reserve Stock

| Activity | Metric |
|---|---|
| Non Haz Retail Pick To oLPN Cart (F1 / F2) | Sum Quantity |
| iLPN Replen Fill / Fill Large | Sum Completed Quantity |
| System / User Directed Putaway | Sum Completed Quantity (zone-filtered) |

### Receiving

| Activity | Metric |
|---|---|
| LPN Level Receive, Small Parcel LPN Level Receive | Count unique Container IDs |

### Shipping

| Activity | Metric |
|---|---|
| NRDR CORE PALLETIZE OLPN, FLOOR LOAD PALLETIZE OLPN | Sum Quantity, dedup by Container ID |

---

## PPH projection (Ecom)

- Shift start: 2:15 PM, end cap: 10:45 PM (8 productive hours)
- Lunch: 30 min deducted after 6:15 PM
- Headcount and PPH targets configurable in Settings
- On pace = current units ≥ projected units at this point in shift

---

## Notifications

Teams webhooks fire on:
- New batch cleared (auto, Batches_live)
- Manual shift summary send (all live pages)
- Agent auth expiry (background alert)

Routing is shift-aware: 1st shift (6 AM–2 PM PDT) and 2nd shift (2 PM–10 PM PDT) post to separate channels.

---

## Versioning

**Patch** (v2.8 → v2.9): bug fix, small feature, logic change
**Minor** (v1.9 → v2.0): new major feature

Three places to update on every version bump:
1. HTML `<title>` tag
2. Settings footer tag in the HTML
3. Menu card badge + `openApp()` filename in Menu

---

## Data & Privacy

Operational throughput data only. No customer data, no payment information. Associate usernames (email) are used for productivity tracking and are subject to standard Nordstrom data handling policies.

> **Disclaimer:** This tool measures throughput only and may not be used independently to evaluate, coach, or hold team members accountable on performance.

---

## Contact

Dean Karim — Warehouse Trainer, Nordstrom DC499
