# SCOUT — Reporting Architecture Overview
### DC499 Reporter Suite · Nordstrom Distribution Center 499

Prepared for: Manhattan Network Reporting Suite integration review

---

## What it is

SCOUT (Shift Centralized Output Utilization Tracker) is a real-time operational reporting suite built and maintained by Dean Karim, Warehouse Trainer at DC499. It surfaces associate throughput data from the warehouse management system (MAWM) for the support team — live, by department, by hour, by person — without requiring manual exports or spreadsheet work.

The suite covers five departments:

| Department | What is tracked |
|---|---|
| Ecom | Replenishment, putaway, picking, packing, shipping, sorting |
| Reserve Stock | Floor 1 and Floor 2 picking, replenishment, putaway |
| Item Prep | Units received and processed |
| Receiving | LPN receives per hour, per associate |
| Shipping | Containers palletized per hour, per associate |

All metrics are throughput counts. No customer data, no order contents, no financial data.

---

## Two modes of operation

SCOUT operates in two modes depending on the report and the situation.

### CSV mode

A support team member exports an activity tracking CSV from MAWM and drops it into the browser tool. All processing happens client-side in the browser — no server, no upload, no network call. The report renders in under 30 seconds. This mode works from any device with a browser, regardless of network access to the floor PC.

### Live mode

A data agent running on a dedicated DC floor PC connects to MAWM on a recurring cycle, pulls current-shift activity, and writes the results to a shared data repository. Support team members open the live dashboard pages in any browser and see an up-to-date view refreshed automatically every 60 seconds — no CSV needed, no page reload.

Live mode is always-on during a shift. CSV mode is available as a fallback or for historical analysis.

---

## Report pages

SCOUT is organized around dedicated pages per department and function, all accessible from a central menu.

### Department reports (CSV + live)

| Page | Department | Mode |
|---|---|---|
| `Ecom_v3.html` | Ecom | CSV + live |
| `Reserve_v1_7.html` | Reserve Stock | CSV + live |
| `ItemPrep_v2.0.html` | Item Prep | CSV only |
| `Receiving_live.html` | Receiving | Live only |
| `Shipping_live.html` | Shipping | Live only |

### Operational dashboards (live only)

| Page | Purpose |
|---|---|
| `Batches_live.html` | Wave/batch status — release cadence, picks in progress, cleared counts |
| `Backlog_live.html` | Open orders, PPH pace projection, daily backlog breakdown |
| `Totes_live.html` | Tote status and counts |
| `RetailReplen_live.html` | Retail replenishment status |
| `EOS_live.html` | End-of-Shift summary report — shift-over-shift comparison |

### Supplemental reports

| Page | Purpose |
|---|---|
| `Reserve_putaway.html` | Reserve putaway WIP — pending iLPNs by age, location, and category |
| `Reserve_weekly.html` | Reserve weekly recap — bar charts, per-day breakdown, associate detail |

All pages are accessible from `Menu_v1.6.html`, the central department selection hub.

---

## Architecture

SCOUT is composed of three layers that work independently of each other.

### Layer 1 — Static web application

The front end is pure HTML, CSS, and JavaScript — no framework, no build system, no server-side execution. Every report page is a self-contained file that runs entirely in the browser. This makes it portable to any static hosting environment, including SharePoint document libraries, intranet web servers, or content delivery networks.

Two runtime dependencies are loaded from CDN at page load:
- **PapaParse** — CSV parsing for file-drop mode
- **Chart.js** — charts, hourly trend graphs, and weekly bar charts

User settings (rosters, PPH targets, headcount, themes) are stored in the browser's `localStorage` and never leave the device.

### Layer 2 — Floor PC agent layer

A set of Node.js agents runs on a single dedicated PC on the DC floor. There are four agents with distinct roles:

**Coordinator — `dc499_refresh.js`**
The main agent, running continuously. Every 2 minutes it queries MAWM for all primary operational data, writes the result JSON files locally, picks up any files written by the sub-agents, and pushes everything to the shared repository in a single commit. It also handles batch-cleared notifications to Teams. This is the only agent that ever pushes to git — sub-agents never push directly.

**Sub-agents**
Three purpose-built agents that run independently and write their own JSON output files:

| Agent | Output | Data covered |
|---|---|---|
| `scout_ecom_agent.js` | `ecom_live.json` | Ecom associate metrics, hourly breakdown |
| `scout_reserve_agent.js` | `reserve_live.json`, `putaway_live.json` | Reserve metrics, putaway WIP |
| `scout_shipping_agent.js` | `shipping_live.json` | Shipping associate metrics, hourly breakdown |

Sub-agents write their files locally and exit. The coordinator picks them up on its next 2-minute cycle and includes them in the commit. This prevents concurrent push collisions — only one process ever touches git.

**EOS agent — `eos_agent.js`**
Run manually at shift boundaries. Captures a point-in-time snapshot of open orders, batch status, and packed/shipped counts. A Start-of-Shift (SOS) snapshot is taken at 2:10 PM; an End-of-Shift snapshot is taken at shift close. The diff between the two populates `EOS_live.html` with a shift-over-shift summary.

**Watchdog — `dc499_watchdog.ps1`**
A PowerShell script registered as a Windows Scheduled Task. It runs every 30 minutes, checks whether the coordinator process is running, and relaunches it automatically if it has stopped. The floor PC must remain locked (not logged out) at all times for the watchdog to function.

**Launcher — `dc499.bat`**
A single batch menu that launches all agents, handles authentication, and starts the local server. All agent operations go through this launcher — individual agents are never invoked directly.

### Layer 3 — Shared data repository

The JSON result files written by the agents are stored in a NordTech GitHub repository. The static web pages fetch these files on a 60-second polling interval. This creates a clean separation: the agent writes data, the browser reads data, and the repository is the shared handoff point between the two.

**Current state:** The repository is under a personal NordTech account while the DC499 organization-level repository is being established. SharePoint is the active host for the static pages as part of the Nordstrom intranet rollout.

**Future state:** Once the NordTech organization repository is confirmed, the static pages will be published via GitHub Pages on the Nordstrom intranet domain — accessible to the support team via a standard intranet URL with no local file access required.

---

## Data flow

```
MAWM Database  (warehouse management system)
       |
       |  OIDC authenticated query — Nordstrom SSO
       ↓
 Floor PC — Agent Layer
 ├── dc499_refresh.js     (coordinator, every 2 min)
 ├── scout_ecom_agent.js  (sub-agent)
 ├── scout_reserve_agent.js  (sub-agent)
 └── scout_shipping_agent.js (sub-agent)
       |
       |  structured JSON  →  local disk
       |  git push  →  every 2 minutes (coordinator only)
       ↓
 NordTech GitHub Repository  (shared data handoff)
       |
       |  HTTPS fetch  →  every 60 seconds
       ↓
 Browser  (SharePoint-hosted static pages)
       |
       ↓
 Support team  —  live department dashboards
```

No data transits any third-party service. The browser's only outbound network call is fetching the JSON files from the repository host.

---

## Live data payloads

The coordinator and sub-agents each produce a set of JSON files that feed the live dashboards. All files follow the same structure: a `generated` timestamp, a `shift` label, and a payload specific to the report.

| File | Fed by | Powers |
|---|---|---|
| `ecom_live.json` | `scout_ecom_agent.js` | Ecom live tab in `Ecom_v3.html` |
| `reserve_live.json` | `scout_reserve_agent.js` | Reserve live tab in `Reserve_v1_7.html` |
| `putaway_live.json` | `scout_reserve_agent.js` | `Reserve_putaway.html` |
| `shipping_live.json` | `scout_shipping_agent.js` | `Shipping_live.html` |
| `receiving_live.json` | `dc499_refresh.js` | `Receiving_live.html` |
| `backlog_live.json` | `dc499_refresh.js` | `Backlog_live.html` |
| `batch_status.json` | `dc499_refresh.js` | `Batches_live.html` |
| `tasks_live.json` | `dc499_refresh.js` | Tasks tab in `Backlog_live.html` |
| `totes_live.json` | `dc499_refresh.js` | `Totes_live.html` |
| `retail_replen.json` | `dc499_refresh.js` | `RetailReplen_live.html` |
| `shipped_live.json` | `dc499_refresh.js` | Shipped counts in `Backlog_live.html` |

---

## Authentication

The floor PC agent authenticates to MAWM via Nordstrom's standard OIDC/SSO flow. OAuth tokens are stored locally on the floor PC only — never committed to the repository, never sent to the browser, never transmitted externally.

All four agents share a single token file. A file-based lock ensures that if multiple agents are running simultaneously, only one performs a token refresh at a time — preventing session collisions.

Token refresh is automatic. If a session expires, the agent detects it, sends a Teams alert to the support team, and re-authentication is completed through a local browser prompt. No IT ticket or password reset is required for routine session renewal.

The dashboards themselves have no authentication — access is controlled by the SharePoint permissions of the hosting document library.

---

## Notifications

SCOUT sends automated summary cards to Microsoft Teams via Power Automate webhooks. Routing is shift-aware — 1st and 2nd shift post to separate channels.

| Event | Trigger | Content |
|---|---|---|
| Batch cleared | Automatic, on status change | Wave/batch summary card |
| Shift summary | Manual, support team-initiated | Department totals card |
| Auth expiry | Automatic, agent-detected | Plain text alert |

All notifications contain aggregate operational data only — no associate-level detail.

---

## Hosting compatibility

SCOUT was intentionally designed without a backend so it can be hosted anywhere Nordstrom has static file serving available.

- **SharePoint** — static HTML/JS/JSON files served from a SharePoint document library. This is the active path for the intranet rollout.
- **NordTech GitHub Pages** — once the organization-level repository is established, Pages provides CDN-backed delivery on the Nordstrom intranet domain with no infrastructure overhead.
- **Any HTTPS static file server** — the only requirement is that the JSON data files and HTML pages are reachable from the same origin, or CORS is enabled between them.

**Manhattan Network integration:** The data layer is plain JSON over HTTPS. SCOUT's endpoints can be consumed directly by a broader reporting platform, or the agent's push target can be redirected to a different endpoint entirely — with no changes required to any of the front-end pages.

---

## Data & privacy

SCOUT processes operational throughput data only:
- Associate email usernames (`first.last@nordstrom.com`)
- Transaction timestamps and unit counts
- Warehouse location and zone codes
- Order and batch identifiers (no order contents)

No customer data, no payment information, no sensitive PII beyond associate usernames used for productivity tracking. All data handling is consistent with Nordstrom data policies.

> **Disclaimer:** This tool measures throughput only and may not be used independently to evaluate, coach, or hold team members accountable on performance.

---

## Contact

Dean Karim — Warehouse Trainer, Nordstrom DC499
