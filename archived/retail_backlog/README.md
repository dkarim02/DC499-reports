# Retail Backlog — archived 2026-10-20

Store replen order progress by wave (Waves / Zones tabs). Archived because Shubham's retail board
covers the same ground (menu: Reserve Stock → Retail Board). Kept for a while in case it comes back.

Files: `Retail_backlog.html` (v1.2), `scout_retail_agent.js` (REDIRECT_PORT 3123), the last
`retail_backlog_live.json`. Design notes are in CLAUDE.md → "Retail Backlog".

## To bring it back
1. Move the 3 files back to the reporter folder root (`git mv archived/retail_backlog/<file> .`).
2. dc499.bat options 20–22: restore the three blocks (one-shot / `--serve --interval=5` / `--auth`).
3. dc499_refresh.js `gitPush()`: add `retail_backlog_live.json` back to the `git add` list and
   `'retail_backlog_live.json': 'retail'` to LABELS.
4. Menu_v2.0.html: add the chip back to the Reserve Stock tools:
   `{ icon: '🏬', name: 'Retail Backlog', ver: 'v1.2', file: 'Retail_backlog.html' }`
5. Restart the agents.
