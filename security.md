# Security Policy

## Scope

This repository contains browser-based operational reporting tools for internal warehouse use. The tools process CSV exports from the warehouse management system and display throughput data for supervisors.

## Supported Versions

Only the latest version of each department app is actively maintained and supported.

| App | Current Version |
|---|---|
| Ecom | v2.9 |
| Reserve Stock | v1.7 |
| Item Prep | v2.0 |
| Receiving | v2.0 |
| Receiving Live | v1.1 |

## Data Handled

- Warehouse associate usernames (first.last format)
- Transaction timestamps and unit counts
- Department and location codes
- No customer data, no payment data, no sensitive PII

## Reporting a Vulnerability

If you identify a security issue with this tool — including unintended data exposure, XSS vulnerabilities, or insecure data handling — please report it directly to the repository owner rather than opening a public issue.

**Contact:** Reach out through internal Nordstrom channels to the DC499 operations team.

Do not include sensitive operational data, associate names, or system credentials in any public issue or pull request.

## Security Practices

- All data processing happens client-side in the browser — no data is transmitted to external servers
- The live receiving agent authenticates via Nordstrom SSO (OIDC) — no credentials are stored in the repository
- No API keys, tokens, or secrets should ever be committed to this repository
- The Teams webhook URL is embedded in the HTML — treat it as semi-sensitive and rotate if the channel is compromised
- localStorage is used for roster and settings persistence — data is stored on the user's device only

## Known Limitations

- The Teams webhook URL embedded in the Ecom app provides write access to the configured Teams channel — anyone with the source code can post to that channel
- GitHub Pages serves files publicly — do not commit any file containing credentials, associate rosters, or operational data that should not be public
