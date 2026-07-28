# DC499 Reporter — New PC Setup Guide

Follow these steps to get SCOUT running on a new machine or to hand off to another lead.

---

## What you need

- Git for Windows: https://git-scm.com/download/win
- Node.js (LTS): https://nodejs.org  — just install from the website, takes 2 min
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

The token is saved in the project folder. You only do this once.

---

## Step 3 — Test it

Double-click **dc499.bat** and press **1** (Refresh data only).

You should see lines like:
```
[14:32:01] ✓ receiving_live.json — 8 associates
[14:32:01] ✓ batch_status.json — 6 batches, 3 cleared
[14:32:01] ✓ Pushed to git
Done.
```

---

## Step 4 — Start the live server

Double-click **dc499.bat** and press **2** (Start live server).

Leave the terminal window open and the screen locked (Win+L). The server refreshes data every 2 minutes and pushes to GitHub automatically. It runs until the terminal is closed or the PC restarts — so don't close it and don't log out.

This is what keeps the reports live for Sunday crew and 1st shift Monday.

---

## Optional — Auto-refresh safety net

If you want the data to keep updating even if the terminal gets closed, double-click **dc499_install_task.bat**. It registers a scheduled task that runs a one-shot refresh every 20 hours in the background.

This is a backup, not a replacement for Step 4. It won't give 2-minute updates — just keeps data from going completely stale.

---

## If the token expires

Double-click **dc499.bat** and press **4**. Done in 30 seconds. This should only happen if the PC was fully restarted or logged out.

---

## Check the log

Open **dc499_autorefresh.log** in the project folder to see when the scheduled task last ran and whether it succeeded.

---

## Moving the project to a different folder

Everything is portable — all paths are relative. Just move the whole folder. If you registered the scheduled task, run **dc499_install_task.bat** again to update its path.
