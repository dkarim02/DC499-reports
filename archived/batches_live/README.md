# Batches Live — archived 2026-10-21

Test page for the putwall batch view. That view now lives in Backlog_live.html (Batches tab), which
reads the same `batch_status.json`. dc499_refresh.js still writes and pushes that file.

## To bring it back
1. `git mv archived/batches_live/Batches_live.html .`
2. dc499_refresh.js `fileMap`: add `'/Batches_live.html': 'Batches_live.html'`.
