# Totes Live Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix dead code, stale threshold bug, redundant `1 *` multiplier, split the combined case1+case2 summary pill into two, and bump the version to v1.4.

**Architecture:** All changes are confined to `Totes_live.html` and the version badge in `Menu_v1.6.html`. No backend changes. No new data fields needed — `s.case1` and `s.case2` are already separate in the JSON payload.

**Tech Stack:** Vanilla HTML/CSS/JS, no build step.

## Global Constraints

- No new external dependencies
- Dedup key and location filter rules in CLAUDE.md must not be touched
- Version bump must update 3 places: HTML title tag, dept-label, and Menu card badge + `openApp()` filename reference
- Do not change any query logic in `dc499_refresh.js`

---

### Task 1: Remove dead code (`lastData`, `makeDivider`, unused `fetchData` argument)

**Files:**
- Modify: `Totes_live.html` (script section)

**Interfaces:**
- Produces: clean script with no unused symbols

- [ ] **Step 1: Remove `lastData` variable and assignment**

In the `var` declarations block near the top of `<script>`, remove:
```js
var lastData    = null;
```
In the `.then` callback inside `fetchData`, change:
```js
.then(function(data) { lastData = data; render(data); scheduleAutoRefresh(); })
```
to:
```js
.then(function(data) { render(data); scheduleAutoRefresh(); })
```

- [ ] **Step 2: Remove `makeDivider` function**

Delete the entire function (lines ~586–597 in current file):
```js
function makeDivider(label, cls) {
  var wrap = document.createElement('div');
  wrap.className = 'section-divider';
  var span = document.createElement('span');
  span.className = 'section-divider-label ' + cls;
  span.textContent = label;
  var line = document.createElement('div');
  line.className = 'section-divider-line';
  wrap.appendChild(span);
  wrap.appendChild(line);
  return wrap;
}
```

- [ ] **Step 3: Remove unused argument from `fetchData` call sites**

`fetchData` accepts no parameters. Remove the arguments from all three call sites:

```js
// manualRefresh
function manualRefresh() { fetchData(); }

// auto-refresh setTimeout
autoTimer = setTimeout(function() { fetchData(); }, INTERVAL_MS);

// initial call at bottom of script
fetchData();
```

- [ ] **Step 4: Verify in browser — page loads, refresh button works, auto-refresh countdown ticks**

- [ ] **Step 5: Commit**
```bash
git add Totes_live.html
git commit -m "Totes v1.4 — remove dead code (lastData, makeDivider, unused fetchData args)"
```

---

### Task 2: Fix stale threshold and clean up interval constant

**Files:**
- Modify: `Totes_live.html` (script section)

**Interfaces:**
- Produces: stale banner fires at 5 min; interval constant is readable

- [ ] **Step 1: Lower stale threshold from 10 min to 5 min**

In `isStale()`:
```js
function isStale(generated) {
  if (!generated) return false;
  try {
    var ts = generated.endsWith('Z') ? generated : generated + 'Z';
    return (Date.now() - new Date(ts).getTime()) / 60000 > 5;
  } catch(e) { return false; }
}
```

- [ ] **Step 2: Clean up interval constant**

```js
var INTERVAL_MS = 60 * 1000;
```

- [ ] **Step 3: Verify — open browser, confirm subtitle still says "every 1 min", stale banner logic unchanged visually**

- [ ] **Step 4: Commit**
```bash
git add Totes_live.html
git commit -m "Totes v1.4 — stale threshold 10m -> 5m, clean up interval constant"
```

---

### Task 3: Split combined case1+case2 summary pill into two separate pills

**Files:**
- Modify: `Totes_live.html` (HTML + CSS + script)

**Interfaces:**
- Consumes: `s.case1`, `s.case2` from `data.summary` (already present in totes_live.json)
- Produces: two pills — "X in pick" (teal) and "X not dropped" (yellow)

- [ ] **Step 1: Replace single pill element in HTML**

Find:
```html
<span class="summary-pill pill-c1"     id="p-c1"></span>
<span class="summary-pill pill-c3"     id="p-c3"></span>
```
Replace with:
```html
<span class="summary-pill pill-c1"     id="p-c1"></span>
<span class="summary-pill pill-c2"     id="p-c2"></span>
<span class="summary-pill pill-c3"     id="p-c3"></span>
```

- [ ] **Step 2: Add CSS for the new pill**

In the `/* Summary pills */` block, add after `.pill-c1`:
```css
.pill-c2{background:var(--yellow-bg);border-color:var(--yellow-border);color:var(--yellow);}
```

- [ ] **Step 3: Update render() to populate both pills separately**

Find:
```js
document.getElementById('p-c1').textContent     = ((s.case1 || 0) + (s.case2 || 0)) + ' in pick / not dropped';
```
Replace with:
```js
document.getElementById('p-c1').textContent = (s.case1 || 0) + ' in pick';
document.getElementById('p-c2').textContent = (s.case2 || 0) + ' not dropped';
```

- [ ] **Step 4: Verify in browser — summary row now shows 5 pills, "in pick" is teal-neutral, "not dropped" is yellow**

- [ ] **Step 5: Commit**
```bash
git add Totes_live.html
git commit -m "Totes v1.4 — split in-pick and not-dropped into separate summary pills"
```

---

### Task 4: Version bump to v1.4 and push

**Files:**
- Modify: `Totes_live.html` (title, dept-label)
- Modify: `Menu_v1.6.html` (card badge + openApp filename)

**Interfaces:**
- Produces: version shown consistently as v1.4 across all surfaces

- [ ] **Step 1: Update Totes_live.html title tag**
```html
<title>Open Totes v1.4 -- DC499</title>
```

- [ ] **Step 2: Update dept-label in Totes_live.html**
```html
<p class="dept-label"><span class="live-dot"></span>Open Totes v1.4 &mdash; Live</p>
```

- [ ] **Step 3: Update Menu card badge and openApp() in Menu_v1.6.html**

Find the Totes card badge — it will contain `v1.3` — and update to `v1.4`. The `openApp()` call for Totes should already reference `Totes_live.html` (filename unchanged, no update needed there).

- [ ] **Step 4: Verify — open Menu, Totes card shows v1.4; open Totes page, header and browser tab show v1.4**

- [ ] **Step 5: Commit and push**
```bash
git add Totes_live.html Menu_v1.6.html
git commit -m "Totes v1.4 — version bump across title, dept-label, and menu card"
git push origin main
```
