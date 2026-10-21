# Item Prep Live — archived 2026-10-21

Live Item Prep page (tiles, capacity bar, hourly scoreboard) and its agent, `scout_itemprep_agent.js`
(dc499.bat 14–16, REDIRECT_PORT 3121). The menu's Item Prep card still opens the upload-based
`ItemPrep_v2.0.html`, which never used this data.

## To bring it back
1. `git mv archived/itemprep_live/ItemPrep_live.html .` and `git mv archived/itemprep_live/scout_itemprep_agent.js .`
2. dc499.bat: restore options 14–16 (one-shot / `--serve --interval=3` / `--auth`).
3. Start option 15. The agent writes `itemprep_live.json` (not in the gitPush list — local/OneDrive only).
