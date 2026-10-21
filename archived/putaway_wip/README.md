# Putaway WIP — archived 2026-10-20

Reserve containers received but not put away (DCI_ILPN STATUS 3000, retail SKUs, age badges, Cognos
WIP upload). Archived with Retail Backlog — Shubham's retail board covers retail flow. Design notes
are in CLAUDE.md → "Reserve Putaway WIP".

Files: `Reserve_putaway.html` (v1.1), the last `putaway_live.json`. The query is still in
`scout_reserve_agent.js` (`fetchPutawayWip`), just not called.

## To bring it back
1. `git mv archived/putaway_wip/Reserve_putaway.html .`
2. scout_reserve_agent.js `main()`: run `fetchPutawayWip` next to `fetchReserveLive` again
   (`Promise.all([fetchReserveLive(t), fetchPutawayWip(t)])`, 3 places).
3. dc499_refresh.js `gitPush()`: add `putaway_live.json` to the `git add` list and
   `'putaway_live.json': 'putaway'` to LABELS; add `'/Reserve_putaway.html'` back to `fileMap`.
4. Reserve_v1_7.html top bar: add the orange "📦 Putaway WIP" pill back
   (`window.open('Reserve_putaway.html','_blank')`).
5. Restart the Reserve agent and the live refresh.
