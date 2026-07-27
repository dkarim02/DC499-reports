# DC499 Reporter — New PC Setup Guide

Follow these steps to get SCOUT running on a new machine or to hand off to another lead.

---

## What you need

- Git for Windows: https://git-scm.com/download/win
- Node.js (LTS): https://nodejs.org  ← just install from the website, takes 2 min
- A Nordstrom SSO account with MAWM data access

---

## Step 1 — Clone the repo

Open Git Bash or a terminal and run:

```
git clone https://github.com/dkarim02/DC499-reports.git "DC499 Reporter"
```

Put it wherever you want (Desktop, Documents, etc.). The folder name doesn't matter.

---

## Step 2 — Auth (first time only)

1. Open the folder you just cloned
2. Double-click **dc499.bat**
3. Press **4** (First-time auth)
4. A browser window opens — sign in with your Nordstrom SSO account
5. After "Authorized!" appears in the browser, come back to the terminal

That's it. The token file (`.mcp_token.json`) is saved in the project folder.

---

## Step 3 — Test it

Double-click **dc499.bat** → press **1** (Refresh data only).

You should see lines like:
```
[14:32:01] ✓ receiving_live.json — 8 associates
[14:32:01] ✓ batch_status.json — 6 batches, 3 cleared
[14:32:01] ✓ Pushed to git
Done.
```

---

## Step 4 — Set up the auto-refresh (so it runs while you're away)

1. Right-click **dc499_setup_task.ps1** → **Run with PowerShell**
2. It will say "Task registered" — done.

This schedules the refresh to run every 20 hours automatically, even with the screen locked.

**Important:** The PC must be **locked, not logged out.** Lock it with Win+L before you leave.  
Also: go to Windows Update settings and disable "Restart this device as soon as possible" so a surprise restart doesn't kill the session over the weekend.

---

## Moving the project to a different location

The project is fully portable — all paths are relative to the folder. Just move the whole folder and re-run **dc499_setup_task.ps1** to update the scheduled task path.

---

## If the token expires (auth failed on refresh)

Double-click **dc499.bat** → press **4**. Done. Takes 30 seconds.

---

## Check the auto-refresh log

Open **dc499_autorefresh.log** in the project folder to see when it last ran and whether it succeeded.

---

## Re-register the scheduled task after moving folders

If you move the DC499 Reporter folder, run **dc499_setup_task.ps1** again — it will update the path automatically.
