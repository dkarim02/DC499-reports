# SCOUT — Shift Centralized Output Utilization Tracker
## DC499 Reporter Suite — Claude Code Project Memory

This file is read automatically at the start of every Claude Code session. Do not delete it.

---

## Who I am

Dean Karim — Warehouse Trainer and 2nd Shift Supervisor, Nordstrom DC499. I built SCOUT using Claude.ai and Claude Code. This is my primary project. I manage ~25+ Ecom associates and work across Ecom, Reserve Stock, Item Prep, and Receiving departments.

---

## What this project is

SCOUT is a browser-based reporting suite deployed on GitHub Pages. It processes MAWM CSV exports and delivers real-time associate throughput visibility for warehouse supervisors. No backend, no build system — pure HTML/CSS/JS.

**GitHub:** dkarim02/DC499-reports
**Live site:** dkarim02.github.io/DC499-reports
**Local clone:** C:\Users\JLEO\OneDrive - Nordstrom\DC499 Reporter

---

## Current file versions

| File | Version |
|---|---|
| Menu_v1.6.html | v1.6 |
| Ecom_v2_9.html | v2.9 |
| Reserve_v1_7.html | v1.7 |
| ItemPrep_v2.0.html | v2.0 |
| Receiving_v2.0.html | v2.0 |
| Receiving_live.html | v1.1 |
| receiving_live_agent.ps1 | current |

---

## Architecture rules — always follow these

**Dedup key:** Employee + Transaction ID + Activity Datetime. NEVER use CP Trace Id.

**Location filter (shared TX IDs only):**
- Zone H (3rd character of location string) = Reserve Stock
- Any other zone = Ecom
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
- Shipping: OB Putaway By Ship Via → Sum Quantity
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

## PPH projection (Ecom v2.9)

- Shift start: 2:15 PM, cap: 10:45 PM, 8 productive hours
- Lunch: 30 min deducted after 6:15 PM
- Headcount: from Settings dept headcount fields (ecom_headcount_v1 localStorage)
- PPH values: from Settings PPH submenu (ecom_pph_v1 localStorage)
- Defaults: Replen 111.6, Putaway 19.6, Picking 93.1, Packing 24.3, Shipping 245.9, Sorting 81.4
- On pace: current units >= projected units at this point in shift

---

## MAWM database (Claude Code MCP connector)

**Connector:** mawm-data-http-prod
**Auth:** OIDC SSO — Dean.Karim@nordstrom.com
**Access:** Read-only, production data, audit-logged
**Facility ID:** Always '499' — never '0499'
**PII policy:** LIKE queries on CREATED_BY are blocked — use exact email match only

**Key tables:**
- Receiving associate productivity → default_receiving.RCV_RECEIPT (not RCV_LPN)
- ASN lifecycle / dock timing → default_receiving.RCV_ASN
- Wave progress → default_dcorder.DCO_WAVE_AGGREGATE_ORDER
- Task lifecycle → default_task.TSK_TASK
- Labor productivity → default_lmcore.LMC_THROUGHPUT (verify table name)
- Clock in/out → default_timeclock (not yet explored)

**Critical finding:** LPN Level Receive data is in RCV_RECEIPT not RCV_LPN. RCV_LPN stores the LPN record created by system-msg-user, RCV_RECEIPT stores the associate scan.

---

## Live receiving agent

**Script:** receiving_live_agent.ps1
**Query table:** default_receiving.RCV_RECEIPT
**Metric:** COUNT(DISTINCT LPN_ID) per associate
**Filter:** FACILITY_ID = '499', DATE = CURDATE(), TIME >= '12:00:00', exclude system-msg-user
**Loop interval:** 60 minutes (configurable via $INTERVAL)
**Run once:** .\receiving_live_agent.ps1 -RunOnce
**Output:** receiving_live.json → committed and pushed to GitHub each cycle

---

## Teams webhooks (Ecom)

- 2nd shift: configured and working in Ecom v2.9
- 1st shift: PENDING — webhook URL not yet obtained from 1st shift channel
- Routing: sendToTeams() reads getShift() and picks correct webhook

---

## Disclaimer (required on all dept apps)

```
Disclaimer: This tool measures throughput only and may not be used to evaluate, coach, or hold team members accountable on performance.
```

---

## Pending work

- [ ] 1st shift Teams webhook URL → add to Ecom v2.9 TEAMS_WEBHOOK_1ST
- [ ] changelog.json update — after full go-live
- [ ] Batch visibility report — default_dcorder.DCO_ORDER
- [ ] Wave progress report — default_dcorder.DCO_WAVE_AGGREGATE_ORDER
- [ ] Timeclock report — default_timeclock
- [ ] GitHub Pro ($4/month) for private repo + Pages
- [ ] CLAUDE.md — this file, now done

---

## How Dean works

- Confirms design decisions with mockups before building
- Patch notes in plain supervisor language only — no technical details
- Prefers targeted edits over full rewrites
- Always review before pushing to GitHub
- Use descriptive commit messages: "Ecom v2.9 — PPH projection, headcount settings"
- File size warning: HTML files 85-115KB, GitHub MCP times out at ~95KB+ — use git push directly
