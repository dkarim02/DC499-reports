# SCOUT — Reporting Architecture Overview
### DC499 Reporter Suite · Nordstrom Distribution Center 499

Prepared for: Manhattan Network Reporting Suite integration review

---

## What it is

SCOUT (Shift Centralized Output Utilization Tracker) is a real-time operational reporting suite built and maintained by Dean Karim, Warehouse Trainer and 2nd Shift Supervisor at DC499. It surfaces associate throughput data from the warehouse management system (MAWM) for the support team — live, by department, by hour, by person — without requiring manual exports or spreadsheet work.

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

## Architecture

SCOUT is composed of three layers that work independently of each other.

### Layer 1 — Static web application

The front end is pure HTML, CSS, and JavaScript — no framework, no build system, no server-side execution. Every report page is a self-contained file that runs entirely in the browser. This makes it portable to any static hosting environment, including SharePoint document libraries, intranet web servers, or content delivery networks.

Two runtime dependencies are loaded from CDN:
- **PapaParse** — CSV parsing
- **Chart.js** — charts and trend graphs

User settings (rosters, targets, themes, headcount) are stored in the browser's `localStorage` and never leave the device.

### Layer 2 — Floor PC data agent

A lightweight Node.js agent runs continuously on a dedicated PC on the DC floor. Every 2 minutes it:

1. Authenticates to MAWM using Nordstrom SSO credentials (OIDC)
2. Queries the MAWM database for current-shift activity
3. Formats the results as structured JSON files
4. Pushes those files to the shared data repository

The agent runs headless in the background. A watchdog (Windows Scheduled Task) monitors it and automatically restarts it if the process stops. No inbound network connectivity to the PC is required — all communication is outbound.

### Layer 3 — Shared data repository

The JSON result files live in a NordTech GitHub repository. The static web pages poll those files every 60 seconds. This creates a clean handoff point: the agent writes, the browser reads, and neither needs to know anything about the other beyond the file format.

**Current state:** The repository is hosted under a personal NordTech account while the organization-level repository under the DC499 reporting structure is being established. SharePoint is the target host for the static pages as part of the Nordstrom intranet rollout.

**Future state (Pages):** Once the NordTech organization repository is confirmed, the static pages will be published via GitHub Pages on the Nordstrom intranet domain — accessible to the support team via a standard intranet URL, no local file access required.

---

## Data flow

```
MAWM Database  (warehouse management system)
       |
       |  OIDC authenticated query — Nordstrom SSO
       ↓
 Floor PC Agent  (Node.js, runs continuously)
       |
       |  structured JSON  →  local disk
       |  git push  →  every 2 minutes
       ↓
 NordTech GitHub Repository  (shared data handoff)
       |
       |  HTTPS fetch  →  every 60 seconds
       ↓
 Browser  (SharePoint-hosted static pages)
       |
       ↓
 Supervisor's screen  —  live department dashboards
```

No data transits any third-party service. The browser's only network call is fetching the JSON files from the repository host.

---

## Authentication model

The floor PC agent authenticates to MAWM via Nordstrom's standard OIDC/SSO flow. OAuth tokens are stored locally on the floor PC only — never committed to the repository, never sent to the browser, never transmitted externally.

Token refresh is automatic. If a session expires, the agent detects it, sends a Teams alert to the support team, and re-authentication is completed through a local browser prompt. No IT ticket or password reset is required for routine session renewal.

The dashboards have no authentication of their own — access is controlled by the SharePoint permissions of the hosting document library.

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

SCOUT was intentionally designed without a backend so it can be hosted anywhere Nordstrom has static file serving available. For integration into a broader reporting network:

- **SharePoint** — static HTML/JS/JSON files can be served from a SharePoint document library today. This is the active path for the intranet rollout.
- **NordTech GitHub Pages** — once the organization-level repository is established, Pages provides CDN-backed delivery on the Nordstrom intranet domain with no infrastructure overhead.
- **Intranet web server** — any HTTPS file server works. The only requirement is that the JSON data files and the HTML pages are reachable from the same origin (or CORS is enabled between them).
- **Manhattan Network integration** — because the data layer is plain JSON over HTTPS, it is straightforward to either consume these endpoints from a broader reporting platform or re-emit the data to a different endpoint by modifying only the agent's push target. No changes to the front end are required.

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

Dean Karim — Warehouse Trainer & 2nd Shift Supervisor, Nordstrom DC499
