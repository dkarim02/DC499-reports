# Security Policy

## Scope

This repository contains browser-based operational reporting tools for internal warehouse use at Nordstrom DC499. The tools process CSV exports from the warehouse management system (MAWM) and deliver real-time associate throughput visibility for supervisors. A local Node.js agent queries MAWM directly via an authenticated MCP connector and writes live JSON data served over localhost.

## Supported Versions

Only the latest version of each app is actively maintained and supported.

| App | Current Version |
|---|---|
| Ecom | v3.0 |
| Reserve Stock | v1.7 |
| Item Prep | v2.0 |
| Receiving | v2.0 |
| Receiving Live | v1.2 |
| Totes Live | v1.0 |
| Batches Live | v1.0 |
| Backlog Live | v1.0 |
| EOS Live | v1.0 |
| Nail the Plan | v29 |

## Data Handled

- Warehouse associate usernames (first.last format)
- Transaction timestamps, unit counts, and throughput metrics
- Department, location, and zone codes
- Order IDs and order line statuses (MAWM live data)
- Batch and wave identifiers
- No customer data, no payment data, no sensitive PII

## Authentication & Secrets

- **MAWM MCP connector** authenticates via Nordstrom SSO (OIDC) — OAuth tokens are stored locally in `dc499_token.json` and `.mcp_token.json`, never committed to the repository
- **Teams webhooks** are embedded in HTML files — treat them as semi-sensitive; rotate if a channel is compromised or the repo becomes public
- `AUTH_PIN = '020405'` is a convenience PIN for re-authenticating the local agent without the PC password — it grants access to trigger the OAuth flow only, not to data directly
- `.gitignore` excludes token files and local JSON data files from commits

## Security Practices

- All CSV data processing happens client-side in the browser — no associate data is transmitted to external servers
- Live JSON files (`backlog_live.json`, `batch_status.json`, etc.) written by the local agent are served only over `localhost:3001` — not exposed to the internet
- `receiving_live.json` is the only live data file pushed to GitHub Pages — it contains only aggregate counts, no associate-level data
- No API keys, credentials, or secrets should ever be committed to this repository
- localStorage is used for roster and settings persistence — data stays on the user's device only
- The watchdog scheduled task runs under the current Windows user account — no elevated privileges required

## Known Limitations

- Teams webhook URLs embedded in HTML files provide write access to the configured Teams channels — anyone with the source code can post to those channels
- GitHub Pages serves files publicly — do not commit any file containing credentials, associate rosters, or operational data that should not be public
- The local agent PC must remain locked (not logged out) for the watchdog scheduled task to run unattended
- OAuth refresh tokens expire periodically — re-authentication is required via `dc499.bat` option 4 or `localhost:3001/auth?pin=020405`

## Reporting a Vulnerability

If you identify a security issue — including unintended data exposure, XSS vulnerabilities, or insecure data handling — please report it directly to the repository owner rather than opening a public issue.

**Contact:** Reach out to Dean directly via Teams or email.

Do not include sensitive operational data, associate names, or system credentials in any public issue or pull request.
