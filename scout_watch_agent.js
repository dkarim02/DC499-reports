#!/usr/bin/env node
/**
 * SCOUT — Container Watch Agent
 * Flags containers worth researching before they land on the CUP report:
 *   Staging     — sitting at P1-FC (Item Prep conveyor drop) or P1-PK (replen staging); stuck > 24 hrs
 *   Item Prep   — splits that were never scanned again; ghost = the same units split twice
 *                 (vendor carton split qty > received qty for that SKU)
 *   Found       — containers made by hand (no PO/ASN/source), paired with a lost/Z1 container
 *                 of the same SKU + units that existed first
 * Writes container_watch_live.json.
 *
 * Usage:
 *   node scout_watch_agent.js            one-shot refresh
 *   node scout_watch_agent.js --once     one-shot using the token lock (safe while other agents run)
 *   node scout_watch_agent.js --auth     first-time auth / re-auth
 *   node scout_watch_agent.js --serve    auto-refresh (default 15 min)
 *   node scout_watch_agent.js --serve --interval=30
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
const OUTPUT_FILE   = path.join(__dirname, 'container_watch_live.json');
const CLIENT_ID     = 'https://claude.ai/oauth/claude-code-client-metadata';
const REDIRECT_PORT = 3124;
const REDIRECT_URI  = `http://localhost:${REDIRECT_PORT}/callback`;
const FACILITY      = '499';
const LOST_LOC      = 'Z1-Z-0499Z01';   // virtual lost / variance location
const SPLIT_DAYS    = 180;  // Item Prep splits still open with no location
const FOUND_DAYS    = 60;   // hand-made containers considered for lost matches
const RECENT_FOUND_DAYS = 7;  // unmatched found freight shown on the page
const MAX_STEPS     = 40;   // scan history kept per container

const args       = process.argv.slice(2);
const MODE_AUTH  = args.includes('--auth');
const MODE_SERVE = args.includes('--serve');
const MODE_ONCE  = args.includes('--once');   // one-shot using the shared-token lock (safe alongside serve agents)
const INTERVAL   = (() => {
  const f = args.find(a => a.startsWith('--interval='));
  return f ? parseInt(f.split('=')[1]) * 60 * 1000 : 15 * 60 * 1000;
})();

// ── MCP login + queries — shared by every agent, see scout_mcp.js ─────────────
const mcp = require('./scout_mcp')({ redirectPort: REDIRECT_PORT });
const { doAuthFlow, getAccessToken, AuthError, getAccessTokenSilent, mcpQuery } = mcp;

// ── helpers ────────────────────────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
}
const fmtUtc  = d => d.toISOString().replace('T', ' ').slice(0, 19);
const utcAgo  = days => fmtUtc(new Date(Date.now() - days * 864e5));
const toIso   = s => s ? new Date(String(s).replace(' ', 'T') + (String(s).endsWith('Z') ? '' : 'Z')).toISOString() : null;
const hrsSince = s => s ? Math.round((Date.now() - new Date(toIso(s)).getTime()) / 36e5) : null;
const sqlList = ids => ids.map(id => `'${String(id).replace(/'/g, "''")}'`).join(',');
const normSku = s => String(s || '').replace(/^0+/, '');
function chunks(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

// Real person vs system/MHE account (LIKE on CREATED_BY is blocked by the PII filter — check in Node).
const isPerson = email => !!email && email.includes('@') && !/^(system|manhedge)/i.test(email);

// "esperanza.reynoso@nordstrom.com" → "Esperanza R." — shown only in the detail view
function shortName(email) {
  if (!email) return '';
  if (!isPerson(email)) return 'System';
  const cap = w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  const parts = email.split('@')[0].replace(/\d+$/, '').split(/[._-]/).filter(Boolean);
  return parts.length < 2 ? cap(parts[0] || email) : `${cap(parts[0])} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

// Batched queries (small-batch iteration pattern) — one failed batch doesn't sink the cycle
async function batched(token, ids, size, sqlFn, label) {
  const rows = [];
  for (const part of chunks(ids, size)) {
    try {
      const r = await mcpQuery(token, sqlFn(part));
      rows.push(...(r.rows || []));
    } catch (e) {
      console.warn(`[${ts()}]   ${label} batch failed (non-fatal): ${e.message}`);
    }
  }
  return rows;
}

// Collapse ILPN + inventory join rows into one container (multi-SKU → 'MIXED')
function collapse(rows) {
  const map = new Map();
  for (const r of rows) {
    let c = map.get(r.ILPN_ID);
    if (!c) {
      c = { lpn: r.ILPN_ID, status: r.STATUS, loc: r.CURRENT_LOCATION_ID || null, prev_loc: r.PREVIOUS_LOCATION_ID || null,
            source: r.SOURCE_LPN_ID || null, asn: r.ASN_ID || r.PURCHASE_ORDER_ID || null, created_by: r.CREATED_BY || null,
            created: toIso(r.CREATED_TIMESTAMP), updated: toIso(r.UPDATED_TIMESTAMP), skus: new Set(), units: 0 };
      map.set(r.ILPN_ID, c);
    }
    if (r.ITEM_ID) c.skus.add(r.ITEM_ID);
    c.units += Number(r.ON_HAND) || 0;
  }
  return [...map.values()].map(c => {
    const skus = [...c.skus];
    return { ...c, skus: undefined, sku: skus.length === 1 ? skus[0] : skus.length ? 'MIXED' : null, units: Math.round(c.units) };
  });
}

// ── SQL ────────────────────────────────────────────────────────────────────────
const ILPN_COLS = `il.ILPN_ID, il.STATUS, il.CURRENT_LOCATION_ID, il.PREVIOUS_LOCATION_ID, il.SOURCE_LPN_ID, il.ASN_ID, il.PURCHASE_ORDER_ID,
  il.CREATED_BY, il.CREATED_TIMESTAMP, il.UPDATED_TIMESTAMP, inv.ITEM_ID, inv.ON_HAND`;
const ILPN_FROM = `FROM default_dcinventory.DCI_ILPN il
LEFT JOIN default_dcinventory.DCI_INVENTORY inv ON inv.ILPN_ID = il.ILPN_ID AND inv.FACILITY_ID = il.FACILITY_ID`;

// Containers sitting at Item Prep conveyor drop (P1-FC) or replen staging (P1-PK)
function sqlStaging() {
  return `SELECT ${ILPN_COLS} ${ILPN_FROM}
WHERE il.FACILITY_ID = '${FACILITY}' AND il.STATUS IN ('3000','5000')
  AND (il.CURRENT_LOCATION_ID LIKE 'P1-FC%' OR il.CURRENT_LOCATION_ID LIKE 'P1-PK%')`;
}

// Split off a vendor carton, still open, never given a location
function sqlSplits(since) {
  return `SELECT ${ILPN_COLS} ${ILPN_FROM}
WHERE il.FACILITY_ID = '${FACILITY}' AND il.STATUS = '3000' AND il.CURRENT_LOCATION_ID IS NULL
  AND il.SOURCE_LPN_ID IS NOT NULL AND il.CREATED_TIMESTAMP >= '${since}'`;
}

// Made by hand: no PO, no ASN, not split from anything. Z1 (lost location) excluded — that's the lost side.
function sqlFound(since) {
  return `SELECT ${ILPN_COLS} ${ILPN_FROM}
WHERE il.FACILITY_ID = '${FACILITY}' AND il.STATUS = '3000'
  AND il.ASN_ID IS NULL AND il.SOURCE_LPN_ID IS NULL AND il.PURCHASE_ORDER_ID IS NULL
  AND il.CREATED_TIMESTAMP >= '${since}'
  AND (il.CURRENT_LOCATION_ID IS NULL OR il.CURRENT_LOCATION_ID <> '${LOST_LOC}')`;
}

// Lost side: sitting in Z1 or status 10000 (Lost)
function sqlLost() {
  return `SELECT ${ILPN_COLS} ${ILPN_FROM}
WHERE il.FACILITY_ID = '${FACILITY}'
  AND ((il.STATUS = '3000' AND il.CURRENT_LOCATION_ID = '${LOST_LOC}') OR il.STATUS = '10000')`;
}

function sqlScanCounts(ids) {
  return `SELECT CONTAINER_ID, COUNT(*) AS n FROM default_task.TSK_ACTIVITY_TRACKING
WHERE FACILITY_ID = '${FACILITY}' AND CONTAINER_ID IN (${sqlList(ids)}) GROUP BY CONTAINER_ID`;
}

// Per vendor carton + SKU: units received vs units split out. Split > received = the same units split twice.
function sqlParentSplits(parents) {
  return `SELECT CONTAINER_ID AS parent, ITEM_ID,
  SUM(CASE WHEN TRANSACTION_ID = 'Split iLPN' THEN QUANTITY ELSE 0 END) AS split_qty,
  SUM(CASE WHEN TRANSACTION_ID = 'Split iLPN' THEN 1 ELSE 0 END)        AS splits,
  MAX(CASE WHEN TRANSACTION_ID LIKE '%Receive%' THEN QUANTITY END)      AS recv_qty
FROM default_task.TSK_ACTIVITY_TRACKING
WHERE FACILITY_ID = '${FACILITY}' AND CONTAINER_ID IN (${sqlList(parents)})
  AND ITEM_ID IS NOT NULL AND ITEM_ID <> 'MIXED'
GROUP BY CONTAINER_ID, ITEM_ID`;
}

const STEP_COLS = `CONTAINER_ID, CREATED_TIMESTAMP, TRANSACTION_ID, CREATED_BY, ITEM_ID, QUANTITY, COMPLETED_QUANTITY,
  ADJUSTED_QUANTITY, SOURCE_LOCATION_ID, TARGET_LOCATION_ID, NEW_CONTAINER_ID, CONDITION_CODE_ID, PALLET_ID, NEW_STATUS, UI_ACTION`;
function sqlSteps(ids) {
  return `SELECT ${STEP_COLS} FROM default_task.TSK_ACTIVITY_TRACKING
WHERE FACILITY_ID = '${FACILITY}' AND CONTAINER_ID IN (${sqlList(ids)})
ORDER BY CONTAINER_ID, CREATED_TIMESTAMP`;
}

function toStep(r) {
  const n = v => v == null ? null : Number(v);
  return compact({
    t: toIso(r.CREATED_TIMESTAMP), tx: r.TRANSACTION_ID || null, who: shortName(r.CREATED_BY),
    sku: r.ITEM_ID || null, qty: n(r.QUANTITY), done: n(r.COMPLETED_QUANTITY), adj: n(r.ADJUSTED_QUANTITY),
    from: r.SOURCE_LOCATION_ID || null, to: r.TARGET_LOCATION_ID || null, new_lpn: r.NEW_CONTAINER_ID || null,
    code: r.CONDITION_CODE_ID || null, pallet: r.PALLET_ID || null, status: r.NEW_STATUS || null, ui: r.UI_ACTION || null,
  });
}
function compact(o) { for (const k in o) if (o[k] == null || o[k] === '') delete o[k]; return o; }
function groupSteps(rows) {
  const by = {};
  for (const r of rows) (by[r.CONTAINER_ID] = by[r.CONTAINER_ID] || []).push(toStep(r));
  for (const k in by) if (by[k].length > MAX_STEPS) by[k] = by[k].slice(-MAX_STEPS);
  return by;
}
async function fetchSteps(token, ids, label) {
  return groupSteps(await batched(token, [...new Set(ids)], 25, sqlSteps, label));
}

// ── lost ↔ found matching ──────────────────────────────────────────────────────
// Same SKU (leading zeros stripped — CUP keeps them, MA doesn't) + same units.
// Phase 1 (no history needed): lost container existed before the found one was made.
const matchable = c => c.sku && c.sku !== 'MIXED' && String(c.sku).toLowerCase() !== 'research' && c.units > 0;
function matchCandidates(found, lost) {
  const pool = {};
  for (const l of lost) if (matchable(l)) (pool[normSku(l.sku)] = pool[normSku(l.sku)] || []).push(l);
  const out = new Map();
  for (const f of found) {
    if (!matchable(f)) continue;
    const c = (pool[normSku(f.sku)] || []).filter(l => l.units === f.units && l.created < f.created);
    if (c.length) out.set(f.lpn, c);
  }
  return out;
}
// Last good sighting = last scan that isn't just moving it to lost (Z1, LW code, Lost count)
function lastGoodSighting(steps, fallback) {
  const good = (steps || []).filter(s => s.to !== LOST_LOC && s.from !== LOST_LOC && s.code !== 'LW' && s.status !== 'Lost');
  return good.length ? good[good.length - 1].t : fallback;
}
// Phase 2: found made after the last good sighting, and never received (a receive scan = real receipt).
// Each lost container pairs once; closest last-sighting wins.
function matchLostFound(found, cands, stepsBy) {
  const used = new Set();
  for (const f of [...found].sort((a, b) => a.created.localeCompare(b.created))) {
    const list = cands.get(f.lpn);
    if (!list) continue;
    if ((stepsBy[f.lpn] || []).some(s => /Receive/.test(s.tx || ''))) continue;
    const ok = list.filter(l => !used.has(l.lpn))
      .map(l => ({ l, seen: lastGoodSighting(stepsBy[l.lpn], l.created) }))
      .filter(x => x.seen < f.created)
      .sort((a, b) => b.seen.localeCompare(a.seen));
    if (!ok.length) continue;
    const { l, seen } = ok[0];
    used.add(l.lpn);
    f.match = { lpn: l.lpn, sku: l.sku, units: l.units, status: l.status, loc: l.loc, prev_loc: l.prev_loc, created: l.created, last_seen: seen,
      gap_days: Math.round((new Date(f.created) - new Date(seen)) / 864e5) };
    f.tags.push('lost_match');
  }
}

// ── main fetch ─────────────────────────────────────────────────────────────────
async function fetchContainerWatch(token) {
  console.log(`[${ts()}] Container Watch — fetching...`);
  const t0 = Date.now();

  // Base lists fire together
  const [stagingRes, splitsRes, foundRes, lostRes] = await Promise.all([
    mcpQuery(token, sqlStaging()),
    mcpQuery(token, sqlSplits(utcAgo(SPLIT_DAYS))),
    mcpQuery(token, sqlFound(utcAgo(FOUND_DAYS))),
    mcpQuery(token, sqlLost()),
  ]);
  const staging = collapse(stagingRes.rows || []);
  const splitsAll = collapse(splitsRes.rows || []);
  const foundAll = collapse(foundRes.rows || []).filter(c => isPerson(c.created_by));
  const lost = collapse(lostRes.rows || []);
  console.log(`[${ts()}]   staging ${staging.length} · open splits ${splitsAll.length} · found ${foundAll.length} · lost pool ${lost.length}`);

  // ── Item Prep splits: zero scans = never left the station in the system
  const scanRows = await batched(token, splitsAll.map(c => c.lpn), 40, sqlScanCounts, 'scan count');
  const scans = Object.fromEntries(scanRows.map(r => [r.CONTAINER_ID, Number(r.n)]));
  const unscanned = splitsAll.filter(c => !scans[c.lpn]);

  const parents = [...new Set(unscanned.map(c => c.source))];
  const parentRows = await batched(token, parents, 15, sqlParentSplits, 'parent split');
  const parentQty = {};
  for (const r of parentRows) parentQty[`${r.parent}|${normSku(r.ITEM_ID)}`] = {
    split_qty: Math.round(Number(r.split_qty) || 0), splits: Number(r.splits) || 0,
    recv_qty: r.recv_qty == null ? null : Math.round(Number(r.recv_qty)),
  };

  const splits = unscanned.map(c => {
    const p = parentQty[`${c.source}|${normSku(c.sku)}`] || null;
    const overSplit = p && p.recv_qty != null && p.split_qty > p.recv_qty;
    return { ...c, parent: p, tags: [overSplit ? 'ghost' : 'never_located'] };
  });

  // ── staging tags
  for (const c of staging) {
    c.area = c.loc.slice(0, 5);
    c.tags = [];
  }

  // ── found freight: keep matched ones + anything made in the last RECENT_FOUND_DAYS
  for (const c of foundAll) c.tags = [String(c.sku).toLowerCase() === 'research' ? 'research' : 'found'];
  const stagingFound = staging.filter(c => !c.source && !c.asn && isPerson(c.created_by) && c.created >= toIso(utcAgo(FOUND_DAYS)));
  for (const c of stagingFound) c.tags.push('found');
  const foundPool = [...foundAll, ...stagingFound];
  const cands = matchCandidates(foundPool, lost);
  const recentCut = toIso(utcAgo(RECENT_FOUND_DAYS));

  // ── scan histories: staging, recent found, match candidates (both sides), ghost parents
  const candLost = [...cands.values()].flat().map(l => l.lpn);
  const steps = await fetchSteps(token, [
    ...staging.map(c => c.lpn), ...foundAll.filter(c => c.created >= recentCut || cands.has(c.lpn)).map(c => c.lpn), ...candLost,
  ], 'history');
  const parentSteps = await fetchSteps(token, parents, 'parent history');
  matchLostFound(foundPool, cands, steps);
  const found = foundAll.filter(c => c.match || c.created >= recentCut);

  for (const c of staging) {
    c.steps = steps[c.lpn] || [];
    c.last_scan = c.steps.length ? c.steps[c.steps.length - 1].t : c.updated;
    c.age_h = hrsSince(c.last_scan);
    if (c.age_h >= 24) c.tags.unshift(c.age_h >= 168 ? 'stuck_week' : 'stuck');
    if (c.area === 'P1-PK' && c.steps.some(s => s.tx === 'UI_Deallocate_Ilpn' || (s.tx === 'iLPN Replen Fill' && s.done === 0)))
      c.tags.push('replen_dropped');
  }
  for (const c of found) {
    c.steps = steps[c.lpn] || [];
    if (c.match) c.match.steps = steps[c.match.lpn] || [];
  }
  for (const c of staging) if (c.match) c.match.steps = steps[c.match.lpn] || [];
  for (const c of splits) {
    // Ghost detail = the parent carton's steps for this SKU (receive → split → re-audit → split)
    c.steps = (parentSteps[c.source] || []).filter(s => normSku(s.sku) === normSku(c.sku) || (!s.sku && s.tx === 'Locate iLPN'));
    c.age_h = hrsSince(c.created);
  }

  const slim = c => ({
    lpn: c.lpn, sku: c.sku, units: c.units, loc: c.loc, prev_loc: c.prev_loc, area: c.area,
    created: c.created, by: shortName(c.created_by), last_scan: c.last_scan || null, age_h: c.age_h ?? hrsSince(c.created),
    parent_lpn: c.source, parent: c.parent || null, tags: c.tags, match: c.match || null, steps: c.steps || [],
  });
  const has = (list, tag) => list.filter(c => c.tags.includes(tag));
  const stagingOut = staging.map(slim).sort((a, b) => (b.age_h || 0) - (a.age_h || 0));
  const splitsOut  = splits.map(slim).sort((a, b) => (a.tags[0] === 'ghost' ? 0 : 1) - (b.tags[0] === 'ghost' ? 0 : 1) || (b.age_h || 0) - (a.age_h || 0));
  const foundOut   = found.map(slim).sort((a, b) => (b.match ? 1 : 0) - (a.match ? 1 : 0)
    || (a.match && b.match ? a.match.gap_days - b.match.gap_days : 0) || b.created.localeCompare(a.created));
  const stuck = c => c.tags.includes('stuck') || c.tags.includes('stuck_week');

  const output = {
    generated: new Date().toISOString(),
    facility: FACILITY,
    windows: { split_days: SPLIT_DAYS, found_days: FOUND_DAYS, recent_found_days: RECENT_FOUND_DAYS },
    summary: {
      fc: stagingOut.filter(c => c.area === 'P1-FC').length,
      fc_stuck: stagingOut.filter(c => c.area === 'P1-FC' && stuck(c)).length,
      pk: stagingOut.filter(c => c.area === 'P1-PK').length,
      pk_stuck: stagingOut.filter(c => c.area === 'P1-PK' && stuck(c)).length,
      ghosts: has(splits, 'ghost').length,
      ghost_units: has(splits, 'ghost').reduce((s, c) => s + c.units, 0),
      never_located: has(splits, 'never_located').length,
      found_recent: foundAll.filter(c => c.created >= recentCut).length,
      lost_matches: [...found, ...staging].filter(c => c.match).length,
      lost_pool: lost.length,
    },
    staging: stagingOut,
    splits: splitsOut,
    found: foundOut,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output));
  const s = output.summary;
  console.log(`[${ts()}] ✓ container_watch_live.json written in ${Math.round((Date.now() - t0) / 1000)}s — ` +
    `P1-FC ${s.fc} (${s.fc_stuck} stuck) · P1-PK ${s.pk} (${s.pk_stuck} stuck) · ghosts ${s.ghosts} · never located ${s.never_located} · lost matches ${s.lost_matches}`);
  console.log(`[${ts()}] container_watch_live.json ready — dc499_refresh will push on next cycle`);
}

// ── entry point ────────────────────────────────────────────────────────────────
async function main() {
  if (MODE_AUTH) {
    await doAuthFlow();
    return;
  }

  if (MODE_SERVE) {
    console.log(`[${ts()}] SCOUT Container Watch Agent — serve mode, interval ${INTERVAL / 60000} min`);
    const token = await getAccessTokenSilent().catch(async e => {
      if (e instanceof AuthError) return doAuthFlow();
      throw e;
    });
    await fetchContainerWatch(token);
    let busy = false;
    setInterval(async () => {
      // Skip if the last cycle is still running, so cycles never stack up
      if (busy) { console.log(`[${ts()}] Previous cycle still running — skipping this tick`); return; }
      busy = true;
      try {
        const t = await getAccessTokenSilent();
        await fetchContainerWatch(t);
      } catch (e) {
        console.error(`[${ts()}] Error:`, e.message);
      } finally {
        busy = false;
      }
    }, INTERVAL);
    return;
  }

  const token = await getAccessToken();
  await fetchContainerWatch(token);
}

main().catch(e => { console.error(e.message); process.exit(1); });
