# Retail Replen Watch — archived 2026-10-21

Old stand-alone view of `retail_replen.json`. Not linked from the menu. dc499_refresh.js still writes
and pushes `retail_replen.json` — Backlog_live.html reads it, so do not remove it.

## To bring it back
1. `git mv archived/retail_replen/RetailReplen_live.html .`
2. dc499_refresh.js `fileMap`: add `'/RetailReplen_live.html': 'RetailReplen_live.html'`.
