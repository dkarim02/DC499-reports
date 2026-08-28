# SCOUT — System Overview
### DC499 Reporter Suite · For IT & Network Stakeholders

This document provides a functional overview of the SCOUT reporting suite — what it does, how it is structured, and what it requires to run. It is intended for IT, network engineering, or infrastructure teams evaluating hosting or integration options.

For deeper implementation detail, see `ENGINEERING.md`.

---

## What it is

SCOUT is an internal operational reporting tool used by 2nd shift supervisors at Nordstrom DC499. It provides real-time throughput visibility for warehouse associates across five departments: Ecom, Reserve Stock, Item Prep, Receiving, and Shipping.

It replaces manual spreadsheet work. Supervisors previously exported CSVs from the warehouse management system (MAWM) and filtered them by hand. SCOUT does this automatically — either from a dropped file or a live database connection — and delivers a formatted leaderboard and hourly breakdown in seconds.

---

## Two modes of operation

### CSV mode
A supervisor exports an activity CSV from MAWM and drops it into the browser tool. Processing happens entirely client-side — no server involved. Results appear in under 30 seconds.

### Live mode
A lightweight agent running on a DC floor PC connects to MAWM, pulls current-shift data on a recurring cycle, and publishes the results to a shared data endpoint. All supervisors who open the live page see the same up-to-date view — no CSV needed, no manual refresh.

---

## System components

### 1. Static web application

A set of HTML/CSS/JavaScript files with no framework dependencies and no build system. Any static file host can serve them — currently GitHub Pages, with SharePoint as the target intranet host.

All user preferences (rosters, targets, themes) are stored in the browser's `localStorage`. No user data is transmitted to any server.

CDN dependencies (loaded at runtime):
- PapaParse — CSV parsing
- Chart.js — charts and graphs

### 2. Floor PC agent

A Node.js application running on a dedicated PC on the DC floor. It:

- Authenticates to the MAWM database using the supervisor's Nordstrom SSO credentials (OIDC)
- Queries MAWM for current-shift activity data
- Writes structured JSON result files locally
- Pushes those files to the shared repository every 2 minutes

The agent runs continuously in the background. A watchdog process (Windows Scheduled Task) monitors it and relaunches it automatically if it stops. The PC must remain locked but logged in at all times — the watchdog cannot run if the user logs out.

### 3. Data repository

The JSON result files are stored in a Git repository (currently NordTech GitHub). The static web pages fetch these files on a 60-second polling interval. This creates a clean separation: the agent writes data, the browser reads data, and the repository is the shared handoff point.

---

## Data flow

```
MAWM database
    ↓  authenticated query (OIDC SSO)
Floor PC agent  →  JSON files (local disk)
    ↓  pushed every 2 minutes
Git repository  (NordTech GitHub / intranet)
    ↓  fetched every 60 seconds
Browser  →  supervisor's screen
```

No data passes through any third-party service. The only external call from the browser is to fetch the JSON files from the repository host.

---

## Authentication

The floor PC agent authenticates using the supervisor's Nordstrom SSO credentials via an OIDC flow. Tokens are stored locally on the floor PC only — never committed to the repository, never transmitted to the browser, never sent to external services.

Token refresh is handled automatically. If a session expires (roughly every 8 hours), the agent detects it and sends an alert to a Teams channel so the supervisor can re-authenticate via a simple local browser prompt — no IT involvement needed for routine re-auth.

---

## Notifications

SCOUT sends automated notifications to Microsoft Teams channels via Power Automate webhooks. Notifications are shift-aware — 1st and 2nd shift post to separate channels.

Notification triggers:
- A wave batch clears (auto-detected, fires immediately)
- Supervisor manually sends a shift summary card
- Agent authentication expires (background alert)

No notification contains associate-level data — only aggregate counts and operational status.

---

## Departments and metrics

| Department | What is measured |
|---|---|
| Ecom | Replenishment, putaway, picking, packing, shipping, sorting — units per hour |
| Reserve Stock | Picking (two floors), replenishment, putaway — units per hour |
| Item Prep | Units received and processed |
| Receiving | LPNs received per hour, by associate |
| Shipping | Containers palletized per hour, by associate |

All metrics are throughput counts only. No customer data, no order contents, no financial data.

---

## Hosting requirements

For intranet hosting, SCOUT requires:

- **Static file host** — any server capable of serving HTML, CSS, JS, and JSON files over HTTPS. No server-side execution required.
- **JSON file endpoint** — the result files written by the floor PC agent must be fetchable from the browser. In the current GitHub Pages model this is the CDN; on the intranet this would be a file share, SharePoint document library, or a lightweight API endpoint.
- **CORS** — the static pages must be able to fetch the JSON files from wherever they are hosted. Same-origin hosting (static pages and JSON on the same host) is the simplest path.
- **No inbound connectivity to the floor PC** — the agent pushes data outbound only. No port forwarding or firewall exception is required for the PC itself.

### What does not change with intranet hosting

- The floor PC agent architecture remains the same
- Authentication to MAWM remains OIDC SSO
- The Teams webhook integration is unchanged
- All browser-side logic (CSV processing, charts, settings) is unchanged

### What changes

- The agent pushes JSON to an intranet endpoint instead of GitHub
- The static files are served from SharePoint or intranet web server instead of GitHub Pages
- Supervisors access the tool via an intranet URL instead of a public GitHub Pages URL

---

## Data & privacy

SCOUT handles operational throughput data only:
- Associate email usernames (first.last@nordstrom.com format)
- Transaction timestamps and unit counts
- Warehouse location codes and zone identifiers
- Order and batch identifiers (no order contents)

No customer data, no payment data, no sensitive PII beyond associate usernames used for productivity tracking. All data handling follows standard Nordstrom data policies.

> **Disclaimer:** This tool measures throughput only and may not be used independently to evaluate, coach, or hold team members accountable on performance.

---

## Contact

DC499 Operations team — 2nd Shift Supervisor.
