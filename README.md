# AlphaFold3 Webserver Automation — Chrome Extension

A Chromium (Chrome / Edge / Brave) browser extension that turns the
[AlphaFold3 Webserver Automation](https://github.com/superchessmachine/AlphaFold3-Webserver-Automation)
console scripts into one-click buttons. No more pasting code into DevTools.

It does the same four jobs as the original suite:

| Button | Equivalent script |
| --- | --- |
| **Start draft runs** | `startDraftRuns.js` (Open draft → Continue → Confirm) |
| **Start draft runs · Confirmed mode** | `startDraftRunsExperimental.js` (only counts confirmed submissions) |
| **Download predictions** | `downloadPredictions.js` (enter how many; scrolls to reveal more) |
| **Open JSON generator** | `generate_screening_json_v1.py` (now runs entirely in the browser) |

While an action runs, a small progress panel appears in the **bottom-right of the
AlphaFold page** with a live log and a **Stop** button. The panel keeps working
even after you close the extension popup.

---

## Install it in your own Chrome — for free

This loads the extension **unpacked** in Developer Mode. It is completely free,
needs no Chrome Web Store account, and no payment.

1. Download / clone this folder to your computer.
   ```bash
   git clone https://github.com/superchessmachine/AlphaFold3_BrowserExt.git
   ```
2. Open Chrome and go to **`chrome://extensions`** (Edge: `edge://extensions`).
3. Turn on **Developer mode** (toggle, top-right).
4. Click **Load unpacked**.
5. Select this folder — the one that contains **`manifest.json`** (the
   `AlphaFold3_BrowserExt` folder).
6. The **AlphaFold3 Automation** icon now appears in your toolbar. Click the
   puzzle-piece icon and pin it so it's always visible.

That's it — it's installed and fully functional. Whenever you edit a file, return
to `chrome://extensions` and click the **↻ reload** icon on the extension card.

---

## How to use it

### Start draft runs / Download predictions
1. Open your AlphaFold Server page that lists your drafts/predictions and
   **zoom out** (Ctrl/Cmd + minus) until every row you care about is on screen.
2. Click the extension icon.
3. **Start draft runs** — enter how many drafts to submit and click **Start**.
   - Tick **Confirmed mode** to keep going until that many submissions actually
     report success (it watches the success/error snackbars and stops on a
     quota/limit error). Leave it off for the simple top-down pass.
   - Already-submitted jobs are remembered for the tab session, so you can click
     again later to keep chewing through the queue without repeats.
4. **Download predictions** — enter how many to download and click **Download**.
   It opens each row's ⋮ menu, clicks **Download**, and **scrolls to reveal more
   rows when it can't see enough** — just like the run buttons. Downloaded jobs
   are remembered for the tab session, so click again to grab the next batch.
   Raise the *Advanced timing* delay (default 500 ms) on a slow connection.
5. Watch the progress panel on the page. Use **Stop** to cancel.

### Generate screening JSON
1. Click **Open JSON generator** (opens in a new tab).
2. **Screening chains** — paste the partner sequence(s) present in every job.
   Add as many as you need; each is paired with every target as its own entry.
3. **Targets CSV** — choose your CSV, then pick the **name** and **sequence**
   columns (it auto-guesses and offers a dropdown of headers). Empty-sequence
   rows are skipped.
4. **Output** — set a base file name and entries-per-file (default 100), then:
   - **Generate** — builds the JSON and previews the first file.
   - **Download split files** — one `.json` per chunk, named
     `base_1-100.json`, `base_101-200.json`, … (allow multiple downloads if
     Chrome asks).
   - **Download one file** — everything in a single array.
   - **Copy all JSON** — copies the full array to the clipboard.

Each entry is named `<target>_<chain>` and gets a unique 9-digit model seed,
exactly like the original Python generator.

---

## How it works (for the curious)

- **Manifest V3**, permissions limited to `activeTab` + `scripting` — it only
  touches a page when *you* click a button, and only the tab you're looking at.
- `popup.js` injects `inject.js` into the active tab with
  `chrome.scripting.executeScript`. `inject.js` is a self-contained port of the
  three console scripts plus the on-page progress panel.
- The JSON generator (`generator.html` / `generator.js`) runs fully offline in
  its own tab — no network, no server.
- No data leaves your browser. There are no analytics and no external requests.

## Files
```
manifest.json     Extension manifest (MV3)
popup.html/.css/.js   Toolbar popup with the action buttons
inject.js         Page automation: start runs, download, progress panel
generator.html/.css/.js   In-browser screening-JSON builder
icons/            Toolbar icons (16/48/128 px)
```

## Troubleshooting
- **"Open your AlphaFold predictions page first"** — the buttons can't run on
  `chrome://`, the Web Store, or a blank tab. Switch to your AlphaFold tab.
- **Nothing happens / buttons not found** — AlphaFold may have changed its HTML.
  The selectors live in `inject.js` (`tr.mat-mdc-row`, the ⋮ menu, and the
  *Open draft / Continue and preview job / Confirm and submit job* labels).
- **Only one file downloads** from the generator — click **Allow** when Chrome
  asks to download multiple files, or use **Download one file**.
- **Downloads/submissions get skipped** — increase the delay (start runs: the
  *Advanced timing* delay; downloads: the delay field). 750–1000 ms is safe on
  slower machines.
