#!/usr/bin/env node
/**
 * SCOUT — Item Prep Live Agent
 * Queries TSK_ACTIVITY_TRACKING for Item Level Receive + IlpnConditionCodeRemoval.
 * Uses pre-aggregated GROUP BY queries — immune to the ~10k row cap.
 * Writes itemprep_live.json locally; dc499_refresh.js pushes to GitHub on next 2-min cycle.
 *
 * Usage:
 *   node scout_itemprep_agent.js            one-shot refresh
 *   node scout_itemprep_agent.js --auth     first-time auth / re-auth
 *   node scout_itemprep_agent.js --serve    auto-refresh (default 3 min)
 *   node scout_itemprep_agent.js --serve --interval=5
 */

const fs     = require('fs');
const path   = require('path');
require('./scout_file_mirror');  // also writes filedata/*.js so pages work from OneDrive (file://)
const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const { execSync } = require('child_process');

// ── config ─────────────────────────────────────────────────────────────────────
const MCP_BASE      = 'https://mawm-data-mcp.nordstromaws.app';
const TOKEN_FILE    = path.join(__dirname, '.mcp_token.json');
const OUTPUT_FILE   = path.join(__dirname, 'itemprep_live.json');
const CLIENT_ID     = 'https://claude.ai/oauth/claude-code-client-metadata';
const REDIRECT_PORT = 3121;
const REDIRECT_URI  = `http://localhost:${REDIRECT_PORT}/callback`;
const FACILITY      = '499';

const args       = process.argv.slice(2);
const MODE_AUTH  = args.includes('--auth');
const MODE_SERVE = args.includes('--serve');
const INTERVAL   = (() => {
  const f = args.find(a => a.startsWith('--interval='));
  return f ? parseInt(f.split('=')[1]) * 60 * 1000 : 3 * 60 * 1000;
})();

// ── MCP login + queries — shared by every agent, see scout_mcp.js ─────────────
const mcp = require('./scout_mcp')({ redirectPort: REDIRECT_PORT });
const { doAuthFlow, AuthError, getAccessTokenSilent, getAccessToken, mcpQuery } = mcp;

// ── helpers ────────────────────────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
}

function shiftBounds() {
  const nowUtc  = new Date();
  const h       = nowUtc.getUTCHours();
  // 1st shift: 6 AM–2:15 PM PST = 14:00–22:15 UTC
  // 2nd shift: 2:15 PM–10:45 PM PST = 22:15–06:45 UTC (next day)
  const is1st   = h >= 14 && h < 22;
  const start   = new Date(nowUtc);
  const end     = new Date(nowUtc);

  if (is1st) {
    start.setUTCHours(14, 0, 0, 0);
    end.setUTCHours(22, 15, 0, 0);
  } else {
    // 2nd shift start: 22:15 UTC
    start.setUTCHours(22, 15, 0, 0);
    if (h < 14) start.setUTCDate(start.getUTCDate() - 1); // past midnight UTC
    // 2nd shift end: 06:45 UTC next day
    end.setUTCHours(6, 45, 0, 0);
    if (h >= 22) end.setUTCDate(end.getUTCDate() + 1);
  }

  return {
    label:    is1st ? '1st' : '2nd',
    startUtc: start.toISOString().replace('T', ' ').slice(0, 19),
    endUtc:   end.toISOString().replace('T', ' ').slice(0, 19),
  };
}

// ── SQL builders ───────────────────────────────────────────────────────────────

// Group A: per-associate totals (GROUP BY — immune to row cap)
function sqlAssocTotals(shiftStart) {
  return `
SELECT
  CREATED_BY                     AS employee,
  TRANSACTION_ID,
  COUNT(DISTINCT CONTAINER_ID)   AS cartons,
  SUM(QUANTITY)                  AS quantity
FROM default_task.TSK_ACTIVITY_TRACKING
WHERE FACILITY_ID     = '${FACILITY}'
  AND TRANSACTION_ID  IN ('Item Level Receive', 'IlpnConditionCodeRemoval')
  AND CREATED_TIMESTAMP >= '${shiftStart}'
  AND CONTAINER_ID IS NOT NULL
GROUP BY CREATED_BY, TRANSACTION_ID
ORDER BY cartons DESC
`.trim();
}

// Group B: per-associate hourly breakdown (GROUP BY — immune to row cap)
function sqlAssocHourly(shiftStart) {
  return `
SELECT
  CREATED_BY                      AS employee,
  DATE_FORMAT(
    CONVERT_TZ(CREATED_TIMESTAMP, '+00:00', '-08:00'),
    '%H'
  )                               AS pst_hour,
  COUNT(DISTINCT CONTAINER_ID)    AS cartons
FROM default_task.TSK_ACTIVITY_TRACKING
WHERE FACILITY_ID     = '${FACILITY}'
  AND TRANSACTION_ID  IN ('Item Level Receive', 'IlpnConditionCodeRemoval')
  AND CREATED_TIMESTAMP >= '${shiftStart}'
  AND CONTAINER_ID IS NOT NULL
GROUP BY CREATED_BY, pst_hour
ORDER BY employee, pst_hour
`.trim();
}

// Group C: current backlog at L1IP* locations
function sqlBacklog() {
  return `
SELECT
  COUNT(DISTINCT ilpn.ILPN_ID) AS lpns_pending,
  SUM(inv.ON_HAND)             AS units_pending
FROM default_dcinventory.DCI_ILPN ilpn
LEFT JOIN default_dcinventory.DCI_INVENTORY inv
  ON  inv.ILPN_ID     = ilpn.ILPN_ID
  AND inv.FACILITY_ID = ilpn.FACILITY_ID
WHERE ilpn.FACILITY_ID          = '${FACILITY}'
  AND ilpn.CURRENT_LOCATION_ID LIKE 'L1IP%'
  AND ilpn.STATUS               != '9000'
  AND ilpn.IS_CLOSED             = 0
`.trim();
}

// ── main fetch ─────────────────────────────────────────────────────────────────
async function fetchItemPrepLive(accessToken) {
  const { label: shift, startUtc, endUtc } = shiftBounds();
  const nowUtc = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts()}] Item Prep Live — ${shift} shift, since ${startUtc} UTC`);

  // All three groups fire in parallel
  console.log(`[${ts()}] Querying groups A/B/C in parallel...`);
  const [resA, resB, resC] = await Promise.all([
    mcpQuery(accessToken, sqlAssocTotals(startUtc)).catch(e => {
      console.error(`[${ts()}] Group A (totals) failed:`, e.message); return { rows: [] };
    }),
    mcpQuery(accessToken, sqlAssocHourly(startUtc)).catch(e => {
      console.error(`[${ts()}] Group B (hourly) failed:`, e.message); return { rows: [] };
    }),
    mcpQuery(accessToken, sqlBacklog()).catch(e => {
      console.error(`[${ts()}] Group C (backlog) failed:`, e.message); return { rows: [] };
    }),
  ]);

  // ── assemble associates map ──────────────────────────────────────────────────
  const associates = {};

  for (const row of (resA.rows || [])) {
    const emp = row.employee;
    if (!associates[emp]) associates[emp] = { receive: 0, condcode: 0, total: 0, hours: {} };
    const cartons = Math.round(Number(row.cartons) || 0);
    if (row.TRANSACTION_ID === 'Item Level Receive') {
      associates[emp].receive += cartons;
    } else {
      associates[emp].condcode += cartons;
    }
    associates[emp].total += cartons;
  }

  for (const row of (resB.rows || [])) {
    const emp = row.employee;
    if (!associates[emp]) associates[emp] = { receive: 0, condcode: 0, total: 0, hours: {} };
    const h       = row.pst_hour;
    const cartons = Math.round(Number(row.cartons) || 0);
    associates[emp].hours[h] = (associates[emp].hours[h] || 0) + cartons;
  }

  // ── backlog ──────────────────────────────────────────────────────────────────
  const backlogRow    = (resC.rows || [])[0] || {};
  const lpns_pending  = Math.round(Number(backlogRow.lpns_pending)  || 0);
  const units_pending = Math.round(Number(backlogRow.units_pending) || 0);

  // ── capacity math ────────────────────────────────────────────────────────────
  const nowMs    = new Date().getTime();
  const startMs  = new Date(startUtc.replace(' ', 'T') + 'Z').getTime();
  const endMs    = new Date(endUtc.replace(' ', 'T') + 'Z').getTime();
  const hoursLeft = Math.max((endMs - nowMs) / 3600000, 0);

  // current PST hour (for active check + recent window)
  const nowPst     = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const curH       = nowPst.getHours();
  const hStr  = h => String(((h % 24) + 24) % 24).padStart(2, '0');
  const curHStr    = hStr(curH);
  const prevHStr   = hStr(curH - 1);
  const prev2HStr  = hStr(curH - 2);
  const prev3HStr  = hStr(curH - 3);

  // per-associate: recent PPH + active flag + remaining capacity
  let activeHeadcount  = 0;
  let totalCapLeft     = 0;
  let totalCartons     = 0;
  let sumRecentPph     = 0;

  for (const [, a] of Object.entries(associates)) {
    totalCartons += a.total;

    // active = scanned in current or previous hour
    const isActive = (a.hours[curHStr] || 0) > 0 || (a.hours[prevHStr] || 0) > 0;
    a.active = isActive;

    // recent rate: last 2 *complete* hours (prev1 + prev2); if both zero try prev3
    const r1 = a.hours[prevHStr]  || 0;
    const r2 = a.hours[prev2HStr] || 0;
    const r3 = a.hours[prev3HStr] || 0;
    const recentCartons = r1 + r2 > 0 ? r1 + r2 : r1 + r3;
    const recentHours   = (r1 > 0 ? 1 : 0) + (r2 > 0 || (r1 + r2 === 0 && r3 > 0) ? 1 : 0) || 1;

    // fall back to shift average when recent window is empty (early shift)
    const hoursElapsed = Math.max((nowMs - startMs) / 3600000, 0.1);
    const pph = recentCartons > 0
      ? recentCartons / recentHours
      : a.total / hoursElapsed;

    a.pph              = Math.round(pph * 10) / 10;
    a.remaining_capacity = isActive ? Math.round(pph * hoursLeft) : 0;

    if (isActive) {
      activeHeadcount++;
      totalCapLeft  += a.remaining_capacity;
      sumRecentPph  += a.pph;
    }
  }

  const hoursElapsed = Math.max((nowMs - startMs) / 3600000, 0.1);
  const teamPph      = Math.round((activeHeadcount > 0 ? sumRecentPph / activeHeadcount : totalCartons / hoursElapsed) * 10) / 10;
  const capacityLeft = totalCapLeft;
  const headroom     = capacityLeft - lpns_pending;

  // ── truncation check ─────────────────────────────────────────────────────────
  const truncated = (resA.row_count || 0) >= 9500 || (resB.row_count || 0) >= 9500;
  if (truncated) console.warn(`[${ts()}] WARNING: query result near row cap — data may be incomplete`);

  // ── write output ─────────────────────────────────────────────────────────────
  const output = {
    generated:        new Date().toISOString(),
    shift,
    shift_start_utc:  startUtc,
    shift_end_utc:    endUtc,
    facility:         FACILITY,
    truncated,
    backlog: {
      lpns_pending,
      units_pending,
    },
    capacity: {
      active_headcount:   activeHeadcount,
      total_cartons:      totalCartons,
      hours_elapsed:      Math.round(hoursElapsed * 100) / 100,
      hours_remaining:    Math.round(hoursLeft * 100) / 100,
      team_pph:           teamPph,
      capacity_remaining: capacityLeft,
      headroom,
      method: 'recent_2hr_per_associate',
    },
    associates,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`[${ts()}] ✓ itemprep_live.json written`);
  console.log(`[${ts()}]   Backlog: ${lpns_pending} LPNs | PPH: ${teamPph} | Headroom: ${headroom > 0 ? '+' : ''}${headroom}`);
  console.log(`[${ts()}] itemprep_live.json ready — dc499_refresh will push on next cycle`);
}

// ── entry point ────────────────────────────────────────────────────────────────
async function main() {
  if (MODE_AUTH) {
    await doAuthFlow();
    return;
  }

  if (MODE_SERVE) {
    console.log(`[${ts()}] SCOUT Item Prep Agent — serve mode, interval ${INTERVAL / 60000} min`);
    const token = await getAccessTokenSilent().catch(async e => {
      if (e instanceof AuthError) return doAuthFlow();
      throw e;
    });
    await fetchItemPrepLive(token);
    let busy = false;
    setInterval(async () => {
      // Skip if the last cycle is still running, so cycles never stack up
      if (busy) { console.log(`[${ts()}] Previous cycle still running — skipping this tick`); return; }
      busy = true;
      try {
        const t = await getAccessTokenSilent();
        await fetchItemPrepLive(t);
      } catch (e) {
        console.error(`[${ts()}] Error:`, e.message);
      } finally {
        busy = false;
      }
    }, INTERVAL);
    return;
  }

  const token = await getAccessToken();
  await fetchItemPrepLive(token);
}

main().catch(e => { console.error(e.message); process.exit(1); });
