# DC499 Report Processor Suite

A browser-based reporting suite that processes warehouse management system CSV exports and delivers real-time associate throughput visibility across multiple departments. Built and maintained by the DC499 operations team.

---

## What it does

The suite eliminates manual CSV filtering and spreadsheet work by automatically processing activity tracking exports from the warehouse management system. Supervisors drop a CSV file into the tool and get an instant leaderboard, hourly activity chart, and shift summary — in under 30 seconds.

**Departments covered:**
- Ecom (Replenishment, Putaway, Picking, Packing, Shipping, Sorting)
- Reserve Stock (Pick F1, Pick F2, Replenishment, Putaway)
- Item Prep (Item Level Receive, Condition Code)
- Receiving (LPN Receive — live data via MAWM connector)

---

## Features

- **Full Report** — shift summary tiles, hourly activity chart, associate leaderboard with expandable 5-min interval charts, clickable department tiles with side panel
- **PPH goal projection** — projects end-of-shift totals based on configurable headcount and Fin Fcst PPH values, with on-pace/behind indicators per department
- **Location-based department attribution** — shared transaction IDs (putaway, replen) are attributed to the correct department based on warehouse location zone
- **Shift selector** — 1st and 2nd shift support with separate rosters and time-window filtering
- **Teams webhook** — one-click shift summary card posted to Teams channel, shift-aware routing
- **Roster management** — add, remove, enable, disable associates per department; persists across sessions
- **Live Receiving dashboard** — queries the warehouse database directly via MCP connector, updated on a configurable interval, no CSV export needed
- **Cross-file deduplication** — multiple CSV files can be uploaded simultaneously; duplicates removed automatically
- **Disclaimer footer** — present on all pages per HR guidance

---

## Architecture

**No build system required.** Pure HTML, CSS, and JavaScript. Open any file directly in a browser or serve via GitHub Pages.

**Dependencies (loaded from CDN):**
- [PapaParse 5.4.1](https://www.papaparse.com/) — CSV parsing
- [Chart.js 4.4.1](https://www.chartjs.org/) — charts

**Storage:** All user preferences (roster, goals, headcount, PPH targets, theme, shift) are stored in `localStorage`. No backend, no database, no authentication required for the CSV-based tools.

**Deployment:** GitHub Pages — push to `main` branch, live within ~60 seconds.

---

## Files

| File | Description |
|---|---|
| `index.html` | Redirects to Menu |
| `Menu_v1.6.html` | Department selection menu |
| `Ecom_v2_9.html` | Ecom report processor |
| `Reserve_v1_7.html` | Reserve Stock report processor |
| `ItemPrep_v2.0.html` | Item Prep report processor |
| `Receiving_v2.0.html` | Receiving report processor (CSV-based) |
| `Receiving_live.html` | Receiving live dashboard (database-connected) |
| `receiving_live.json` | Live receiving data payload (auto-updated by agent) |
| `receiving_live_agent.ps1` | PowerShell agent — queries MAWM, writes JSON, pushes to GitHub |
| `Changelog.html` | Changelog viewer |
| `changelog.json` | Changelog data source |
| `DC499_Handoff_Guide.md` | Full developer reference |

---

## Live Receiving Dashboard

The `Receiving_live.html` dashboard queries the warehouse management system database directly via a Claude Code MCP connector, without requiring a CSV export.

**How it works:**
1. `receiving_live_agent.ps1` runs on a loop (configurable interval)
2. Each cycle it queries the WMS database for current shift receiving activity
3. Results are written to `receiving_live.json` and pushed to GitHub
4. `Receiving_live.html` fetches the JSON automatically every 60 seconds
5. All users who open the page see the same live data

**To run the agent:**
```powershell
cd "path\to\DC499 Reporter"
.\receiving_live_agent.ps1          # loop mode
.\receiving_live_agent.ps1 -RunOnce # single refresh
```

**Requirements:**
- Claude Code installed with MAWM MCP connector configured
- Git installed and repo cloned locally
- Valid SSO credentials

---

## Versioning

- **Patch** (e.g. v2.8 → v2.9): bug fixes, small features, logic changes
- **Minor** (e.g. v1.9 → v2.0): new major feature added

When bumping a version update three places:
1. Settings footer tag in the HTML file
2. Menu card version badge
3. Menu `openApp()` filename call

---

## Data & Privacy

This tool processes operational throughput data only. No customer data, no payment information, no personally identifiable information beyond associate usernames used for productivity tracking.

**Disclaimer:** This tool measures throughput only and may not be used independently to evaluate, coach, or hold team members accountable on performance.

---

## Contributing

This is an internal operational tool. For changes, bug reports, or feature requests contact the DC499 operations team.

---

*Built with Claude AI · Nordstrom DC499*
