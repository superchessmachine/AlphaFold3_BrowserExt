/*
 * inject.js
 * Self-contained automation installed into the active AlphaFold tab via
 * chrome.scripting.executeScript. It attaches `window.__afAuto` with the same
 * behaviour as the original console scripts (start draft runs + download all),
 * plus a small on-page status panel so progress is visible after the popup
 * closes. The whole function is serialized and re-evaluated in the page, so it
 * must NOT reference anything outside its own body.
 */
function installAutomation() {
  if (window.__afAutoInstalled) return true;
  window.__afAutoInstalled = true;

  const normalize = (text = '') => text.replace(/\s+/g, ' ').trim().toLowerCase();
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Persistent set of job names started during this page session so reruns skip them.
  if (!(window.__afStartedPredictions instanceof Set)) {
    const existing = window.__afStartedPredictions;
    window.__afStartedPredictions = Array.isArray(existing) ? new Set(existing) : new Set();
  }

  // -------------------------------------------------------------------------
  // On-page status panel
  // -------------------------------------------------------------------------
  const overlay = (() => {
    let panel, titleEl, logEl, barFill, barWrap, stopBtn, countEl;

    const build = () => {
      if (panel && document.body && document.body.contains(panel)) return;
      panel = document.createElement('div');
      panel.id = '__af_auto_panel';
      Object.assign(panel.style, {
        position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483647',
        width: '320px', maxHeight: '60vh', display: 'flex', flexDirection: 'column',
        background: '#11181f', color: '#e7eef5', borderRadius: '12px',
        boxShadow: '0 8px 30px rgba(0,0,0,0.45)', fontFamily: 'system-ui, sans-serif',
        fontSize: '13px', overflow: 'hidden', border: '1px solid #233040'
      });

      const header = document.createElement('div');
      Object.assign(header.style, {
        display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px',
        background: '#1a73e8', color: '#fff', fontWeight: '600'
      });
      titleEl = document.createElement('span');
      titleEl.textContent = 'AlphaFold Automation';
      titleEl.style.flex = '1';
      titleEl.style.whiteSpace = 'nowrap';
      titleEl.style.overflow = 'hidden';
      titleEl.style.textOverflow = 'ellipsis';

      stopBtn = document.createElement('button');
      stopBtn.textContent = 'Stop';
      Object.assign(stopBtn.style, {
        border: 'none', borderRadius: '6px', padding: '3px 9px', cursor: 'pointer',
        background: 'rgba(255,255,255,0.2)', color: '#fff', fontSize: '12px'
      });
      stopBtn.onclick = () => { window.__afAutoStop = true; overlay.log('Stop requested…', 'warn'); };

      const closeBtn = document.createElement('button');
      closeBtn.textContent = '✕';
      Object.assign(closeBtn.style, {
        border: 'none', background: 'transparent', color: '#fff', cursor: 'pointer',
        fontSize: '14px', lineHeight: '1'
      });
      closeBtn.onclick = () => panel.remove();

      header.append(titleEl, stopBtn, closeBtn);

      barWrap = document.createElement('div');
      Object.assign(barWrap.style, { height: '4px', background: '#233040' });
      barFill = document.createElement('div');
      Object.assign(barFill.style, { height: '100%', width: '0%', background: '#34a853', transition: 'width .2s' });
      barWrap.appendChild(barFill);

      countEl = document.createElement('div');
      Object.assign(countEl.style, { padding: '6px 12px 0', color: '#9fb3c8', fontSize: '12px' });

      logEl = document.createElement('div');
      Object.assign(logEl.style, {
        padding: '6px 12px 12px', overflowY: 'auto', flex: '1', lineHeight: '1.5',
        fontFamily: 'ui-monospace, monospace', fontSize: '12px'
      });

      panel.append(header, barWrap, countEl, logEl);
      (document.body || document.documentElement).appendChild(panel);
    };

    const colors = { ok: '#7ee2a8', warn: '#f5c451', err: '#f28b82', info: '#cdd9e5' };

    return {
      start(title) {
        build();
        titleEl.textContent = title;
        logEl.innerHTML = '';
        countEl.textContent = '';
        barFill.style.width = '0%';
        barFill.style.background = '#34a853';
        stopBtn.style.display = '';
      },
      log(msg, kind = 'info') {
        build();
        const line = document.createElement('div');
        line.textContent = msg;
        line.style.color = colors[kind] || colors.info;
        logEl.appendChild(line);
        logEl.scrollTop = logEl.scrollHeight;
      },
      count(text) { build(); countEl.textContent = text; },
      progress(done, total) {
        build();
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        barFill.style.width = pct + '%';
      },
      done(msg) {
        build();
        barFill.style.width = '100%';
        stopBtn.style.display = 'none';
        this.log(msg, 'ok');
      },
      error(msg) {
        build();
        barFill.style.background = '#f28b82';
        stopBtn.style.display = 'none';
        this.log(msg, 'err');
      }
    };
  })();

  // -------------------------------------------------------------------------
  // Shared DOM helpers
  // -------------------------------------------------------------------------
  const closeAnyMenu = () => {
    const backdrop = document.querySelector('.cdk-overlay-backdrop');
    if (backdrop) backdrop.click();
  };

  const findMenuButtonByLabel = (label) => {
    const target = normalize(label);
    const menuButtons = Array.from(document.querySelectorAll('button.mat-mdc-menu-item'));
    const buttonMatch = menuButtons.find((btn) => normalize(btn.textContent) === target);
    if (buttonMatch) return buttonMatch;
    const spans = Array.from(document.querySelectorAll('span.mat-mdc-menu-item-text'));
    const spanMatch = spans.find((span) => normalize(span.textContent) === target);
    return spanMatch ? (spanMatch.closest('button') || spanMatch) : null;
  };

  const findMenuButtonByLabels = (labels) => labels.map(findMenuButtonByLabel).find(Boolean) || null;

  const findButtonByLabel = (label) => {
    const target = normalize(label);
    return Array.from(document.querySelectorAll('button')).find(
      (btn) => normalize(btn.textContent) === target && !btn.disabled
    );
  };

  const findDialogButtonByLabels = (labels) => {
    const targets = labels.map(normalize);
    const scope = document.querySelector('.mat-mdc-dialog-container, mat-dialog-container') || document;
    return Array.from(scope.querySelectorAll('button')).find(
      (btn) => !btn.disabled && targets.includes(normalize(btn.textContent))
    );
  };

  const isDisabled = (btn) => btn.disabled || btn.getAttribute('aria-disabled') === 'true'
    || btn.classList.contains('mat-mdc-button-disabled')
    || btn.classList.contains('mat-mdc-button-disabled-interactive');

  // Every plausible "next page" arrow on the page, most specific first. There
  // can be more than one paginator (e.g. a hidden one above the table), so the
  // caller clicks the first ENABLED match rather than the first match.
  const findNextPageButtons = () => {
    const seen = new Set();
    const out = [];
    const add = (btn) => { if (btn && !seen.has(btn)) { seen.add(btn); out.push(btn); } };
    document.querySelectorAll('button.mat-mdc-paginator-navigation-next, button.mat-paginator-navigation-next').forEach(add);
    Array.from(document.querySelectorAll('button, a'))
      .filter((b) => /^\s*next page\s*$/i.test(b.getAttribute('aria-label') || '' ))
      .forEach(add);
    document.querySelectorAll('mat-paginator, .mat-mdc-paginator').forEach((p) => {
      Array.from(p.querySelectorAll('button'))
        .filter((b) => /chevron_right|navigate_next|keyboard_arrow_right|arrow_forward/i.test(b.textContent || ''))
        .forEach(add);
    });
    return out;
  };

  // Advance the Material paginator with the ▶ arrow. Returns false when no
  // enabled arrow exists (i.e. we are on the last page, or there is no paginator).
  const clickNextPage = async (delayMs) => {
    const candidates = findNextPageButtons();
    if (!candidates.length) {
      if (!window.__afNoPaginatorWarned) {
        window.__afNoPaginatorWarned = true;
        overlay.log('No paginator ▶ arrow found on this page.', 'warn');
      }
      return false;
    }
    const next = candidates.find((b) => !isDisabled(b));
    if (!next) return false;
    overlay.log('Next page…');
    next.click();
    await wait(delayMs);
    return true;
  };

  // Bump the paginator to 100 rows/page. Returns true only if it actually
  // changed, so callers can re-check the table.
  const setPageSizeTo100 = async (menuDelayMs, settleMs) => {
    const paginator = document.querySelector('mat-paginator, .mat-mdc-paginator');
    if (!paginator || normalize(paginator.textContent).includes('items per page: 100')) return false;
    const trigger = paginator.querySelector('.mat-mdc-select-trigger')
      || paginator.querySelector('mat-select') || paginator.querySelector('[role="combobox"]');
    if (!trigger) return false;
    overlay.log('Showing 100 rows per page…');
    trigger.click();
    await wait(menuDelayMs);
    const option = Array.from(document.querySelectorAll('mat-option, .mat-mdc-option'))
      .find((o) => normalize(o.textContent) === '100');
    if (!option) { closeAnyMenu(); return false; }
    option.click();
    await wait(settleMs);
    return true;
  };

  // Read a chip's visible label only — chip.textContent also includes the icon
  // ligature text (e.g. "edit_document"), so match on the label span instead.
  const chipLabel = (chip) => {
    const el = chip.querySelector('.mdc-evolution-chip__text-label, .mat-mdc-chip-action-label');
    return normalize(el ? el.textContent : chip.textContent);
  };

  // Force the status filter chips to show ONLY "Saved draft" so runs operate on
  // real drafts instead of paging through completed/example/etc. predictions.
  const ensureSavedDraftFilter = async () => {
    const chips = Array.from(document.querySelectorAll('mat-chip-option'));
    if (!chips.length) return;
    let changed = false;
    for (const chip of chips) {
      const action = chip.querySelector('button.mat-mdc-chip-action');
      if (!action) continue;
      const selected = action.getAttribute('aria-selected') === 'true'
        || chip.classList.contains('mdc-evolution-chip--selected');
      const wantSelected = chipLabel(chip) === 'saved draft';
      if (selected !== wantSelected) { action.click(); changed = true; await wait(300); }
    }
    if (changed) { overlay.log('Filtered to saved drafts only.', 'ok'); await wait(1500); }
  };

  const labelOpenDraft = 'Open draft';
  const labelContinue = 'Continue and preview job';
  const labelConfirm = 'Confirm and submit job';
  const labelDeleteDrafts = ['Delete', 'Delete draft', 'Delete prediction', 'Remove'];
  const labelConfirmDelete = ['Delete', 'Delete draft', 'Confirm', 'OK'];

  // -------------------------------------------------------------------------
  // Download predictions from the top of the list.
  // Like startRuns, this keeps going until `desiredDownloads` rows are
  // triggered, scrolling to reveal more rows when the visible ones run out.
  // Already-downloaded job names are remembered for the page session so a
  // rerun continues with the next batch instead of repeating the top rows.
  // Everything captured in one run goes into a single ZIP (zip64, so size is
  // not a limit) — one Chrome download approval for the whole job.
  // If desiredDownloads is omitted/invalid it falls back to downloading every
  // row it can reach (revealing more by scrolling until nothing new loads).
  // -------------------------------------------------------------------------
  async function downloadAll(params) {
    params = params || {};
    const config = Object.assign({
      menuDelayMs: 500, idleDelayMs: 1500, maxIdleCycles: 3, rowRetryLimit: 2,
      captureWaitMs: 12000
    }, params.options || {});
    const delayMs = Number(params.delayMs) > 0 ? Number(params.delayMs) : 500;

    const desired = Number(params.desiredDownloads);
    const limited = Number.isFinite(desired) && desired > 0;

    // Only download rows whose title contains this text (case-insensitive).
    const titleFilter = (params.titleFilter || '').trim();
    const titleNeedle = normalize(titleFilter);
    const matchesFilter = (name) => !titleNeedle || normalize(name).includes(titleNeedle);

    // Bundle the whole run into ONE ZIP instead of firing one download per row.
    let bundle = params.bundle !== false;

    if (window.__afAuto.busy) { overlay.log('Already running — please wait.', 'warn'); return { busy: true }; }
    if (!document.querySelectorAll('tr.mat-mdc-row').length) { overlay.error('No prediction rows found on the page.'); return { triggered: 0 }; }

    window.__afAuto.busy = true;
    window.__afAutoStop = false;
    overlay.start(limited ? `Downloading ${desired} prediction(s)` : 'Downloading predictions');
    if (titleNeedle) overlay.log(`Only downloading titles containing "${titleFilter}".`);

    // ---- talk to the MAIN-world capture shim (capture.js) ----
    const capSend = (msg) => new Promise((resolve) => {
      const id = 'af' + Math.random().toString(36).slice(2);
      const onMessage = (event) => {
        if (event.source !== window || !event.data || event.data.__af !== 'ack' || event.data.id !== id) return;
        window.removeEventListener('message', onMessage);
        clearTimeout(timer);
        resolve(event.data);
      };
      const timer = setTimeout(() => { window.removeEventListener('message', onMessage); resolve(null); }, 1800000);
      window.addEventListener('message', onMessage);
      window.postMessage(Object.assign({ __af: 'cmd', id }, msg), '*');
    });

    const zipName = ((titleFilter || 'alphafold').replace(/[^\w.-]+/g, '_')) + '.zip';
    if (!window.__afZipProgressHooked) {
      window.__afZipProgressHooked = true;
      window.addEventListener('message', (event) => {
        if (event.source === window && event.data && event.data.__af === 'zipProgress') {
          overlay.count(`Zipping ${event.data.done} / ${event.data.total}`);
          overlay.progress(event.data.done, event.data.total);
        }
      });
    }
    const flushArchive = async () => {
      overlay.log(`Packaging everything into ${zipName} — this can take a while for a big run…`);
      const res = await capSend({ cmd: 'flush', filename: zipName });
      if (!res || res.error) { overlay.log(`Packaging failed: ${res ? res.error : 'timed out'}`, 'err'); return 0; }
      if (!res.count) return 0;
      overlay.log(`Saved ${zipName} (${res.count} file(s), ${(res.bytes / 1073741824).toFixed(2)} GB).`, 'ok');
      return res.count;
    };

    // ---- persistent download log (survives reloads and incognito windows) ----
    const LOG_KEY = 'downloadedPredictions';
    const hasStorage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
    let logged;
    if (hasStorage) {
      const stored = await chrome.storage.local.get(LOG_KEY);
      logged = new Set(stored[LOG_KEY] || []);
      overlay.log(`Log has ${logged.size} previously downloaded prediction(s) — those are skipped.`);
    } else {
      if (!(window.__afDownloadedPredictions instanceof Set)) window.__afDownloadedPredictions = new Set();
      logged = window.__afDownloadedPredictions;
    }
    const newlyLogged = [];
    const saveLog = async () => {
      if (!hasStorage || !newlyLogged.length) return;
      await chrome.storage.local.set({ [LOG_KEY]: Array.from(logged) });
    };

    const failureCounts = new Map();

    const rowKey = (row) => {
      const cell = row.querySelector('.cdk-column-name, .mat-column-name');
      const name = cell ? cell.textContent.trim() : '';
      return name || ('__row:' + normalize(row.textContent).slice(0, 120));
    };

    const nextEligibleRow = () => {
      const rows = Array.from(document.querySelectorAll('tr.mat-mdc-row'));
      for (const row of rows) {
        const key = rowKey(row);
        if (logged.has(key)) continue;
        if (!matchesFilter(key)) continue;
        if ((failureCounts.get(key) || 0) >= config.rowRetryLimit) continue;
        return { row, key };
      }
      return null;
    };

    // Scroll the table to coax the next batch of rows into the DOM.
    const getScrollContainer = () => {
      const viewport = document.querySelector('cdk-virtual-scroll-viewport');
      if (viewport) return viewport;
      const table = document.querySelector('table.mat-mdc-table, .mat-mdc-table');
      let node = table;
      while (node && node !== document.body) {
        const style = getComputedStyle(node);
        if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
        node = node.parentElement;
      }
      return document.scrollingElement || document.documentElement;
    };
    const revealMore = async () => {
      const rows = document.querySelectorAll('tr.mat-mdc-row');
      const lastRow = rows[rows.length - 1];
      if (lastRow && lastRow.scrollIntoView) lastRow.scrollIntoView({ block: 'end' });
      const container = getScrollContainer();
      if (container) container.scrollTop = container.scrollHeight;
      await wait(config.idleDelayMs);
    };

    if (bundle) {
      const armed = await capSend({ cmd: 'arm', on: true });
      if (!armed) { bundle = false; overlay.log('Capture shim not responding — falling back to one download per row.', 'warn'); }
      else overlay.log('Bundling the whole run into one ZIP.');
    }

    try {
      let triggered = 0;
      let idleCycles = 0;
      let pageSizeExpanded = false;

      while (!limited || triggered < desired) {
        if (window.__afAutoStop) { overlay.log('Stopped by user.', 'warn'); break; }

        const selection = nextEligibleRow();
        if (!selection) {
          // Nothing left on this page: show 100 rows at a time, then walk pages
          // with the ▶ arrow, and only then fall back to scrolling for
          // virtual-scroll tables.
          if (!pageSizeExpanded) { pageSizeExpanded = true; if (await setPageSizeTo100(config.menuDelayMs, config.idleDelayMs)) { idleCycles = 0; continue; } }
          if (await clickNextPage(config.idleDelayMs)) { idleCycles = 0; continue; }
          idleCycles += 1;
          if (idleCycles > config.maxIdleCycles) { overlay.log('No more predictions to download. Stopping.', 'warn'); break; }
          overlay.log('No new rows visible — scrolling to reveal more…', 'warn');
          await revealMore();
          continue;
        }
        idleCycles = 0;

        const { row, key } = selection;
        overlay.count(limited ? `Downloaded ${triggered} / ${desired}` : `Downloaded ${triggered}`);
        if (limited) overlay.progress(triggered, desired);

        const menuButton = row.querySelector('button.mat-mdc-menu-trigger');
        if (!menuButton) {
          overlay.log(`${key}: menu button not found.`, 'warn');
          failureCounts.set(key, (failureCounts.get(key) || 0) + 1);
          continue;
        }
        menuButton.click();
        await wait(config.menuDelayMs);

        const items = Array.from(document.querySelectorAll('span.mat-mdc-menu-item-text'));
        const downloadItem = items.find((el) => el.textContent.trim() === 'Download');
        if (!downloadItem) {
          overlay.log(`${key}: "Download" not found.`, 'warn');
          failureCounts.set(key, (failureCounts.get(key) || 0) + 1);
          closeAnyMenu();
          await wait(delayMs);
          continue;
        }

        downloadItem.click();
        triggered += 1;
        logged.add(key);
        if (!key.startsWith('__row:')) newlyLogged.push(key);
        overlay.log(`Downloaded ${key} (${triggered}${limited ? '/' + desired : ''}).`, 'ok');
        if (limited) overlay.progress(triggered, desired);
        await wait(delayMs);

        if (bundle) {
          // First row is the canary: if nothing was captured the page must use a
          // download path we do not hook, so stop pretending and let it through.
          if (triggered === 1) {
            const deadline = performance.now() + config.captureWaitMs;
            let seen = 0;
            while (performance.now() < deadline) {
              const status = await capSend({ cmd: 'status' });
              if (status && (status.count > 0 || status.pending > 0)) { seen = 1; break; }
              await wait(400);
            }
            if (!seen) {
              bundle = false;
              await capSend({ cmd: 'arm', on: false });
              overlay.log('Could not intercept the download — continuing without ZIP packaging.', 'warn');
            }
          }
        }
      }

      let packaged = 0;
      if (bundle) { packaged = await flushArchive(); await capSend({ cmd: 'arm', on: false }); }
      await saveLog();

      if (limited) overlay.progress(triggered, desired);
      overlay.done(`Finished. Triggered ${triggered} download(s)${bundle ? ` — ${packaged} of them packaged into ${zipName}` : ''}.`);
      return { triggered, packaged };
    } finally {
      if (bundle) capSend({ cmd: 'arm', on: false });
      await saveLog();
      window.__afAuto.busy = false;
    }
  }

  // -------------------------------------------------------------------------
  // Delete saved drafts whose title contains a required search term.
  // -------------------------------------------------------------------------
  async function deleteDrafts(params) {
    params = params || {};
    const config = Object.assign({
      menuDelayMs: 400, dialogDelayMs: 600, pageDelayMs: 1200,
      overlayTimeoutMs: 10000, overlayPollMs: 120
    }, params.options || {});

    const titleFilter = (params.titleFilter || '').trim();
    const titleNeedle = normalize(titleFilter);
    if (!titleNeedle) { overlay.error('Enter a title search term before deleting drafts.'); return { deleted: 0 }; }
    if (window.__afAuto.busy) { overlay.log('Already running — please wait.', 'warn'); return { busy: true }; }

    window.__afAuto.busy = true;
    window.__afAutoStop = false;
    overlay.start('Deleting saved drafts');
    overlay.log(`Only deleting titles containing "${titleFilter}".`, 'warn');

    const waitForElement = (resolver) => new Promise((resolve, reject) => {
      const start = performance.now();
      const lookup = () => {
        const element = typeof resolver === 'string' ? document.querySelector(resolver) : resolver();
        if (element) { resolve(element); return; }
        if (performance.now() - start > config.overlayTimeoutMs) { reject(new Error('Timed out waiting for element.')); return; }
        setTimeout(lookup, config.overlayPollMs);
      };
      lookup();
    });

    const readJobName = (row) => {
      const cell = row.querySelector('.cdk-column-name, .mat-column-name');
      const raw = cell ? cell.textContent.trim() : '';
      return raw || null;
    };

    const matchesFilter = (name) => normalize(name).includes(titleNeedle);

    const deletedNames = [];
    const skippedNames = new Set();

    const nextEligibleRow = () => {
      const rows = Array.from(document.querySelectorAll('tr.mat-mdc-row'));
      for (const row of rows) {
        const jobName = readJobName(row);
        if (!jobName || skippedNames.has(jobName)) continue;
        if (!matchesFilter(jobName)) continue;
        return { row, jobName };
      }
      return null;
    };

    const deleteRow = async (row, jobName) => {
      const menuButton = row.querySelector('button.mat-mdc-menu-trigger');
      if (!menuButton) { overlay.log(`${jobName}: menu trigger not found.`, 'warn'); return false; }

      overlay.log(`Deleting ${jobName}...`);
      menuButton.click();
      await wait(config.menuDelayMs);

      const deleteButton = findMenuButtonByLabels(labelDeleteDrafts);
      if (!deleteButton) { overlay.log(`${jobName}: delete action not found.`, 'warn'); closeAnyMenu(); return false; }
      deleteButton.click();
      await wait(config.dialogDelayMs);

      try {
        const confirmButton = await waitForElement(() => findDialogButtonByLabels(labelConfirmDelete));
        confirmButton.click();
        await wait(config.pageDelayMs);
        return true;
      } catch (e) {
        overlay.log(`${jobName}: failed to confirm delete.`, 'warn');
        closeAnyMenu();
        return false;
      }
    };

    try {
      await ensureSavedDraftFilter();
      if (!document.querySelectorAll('tr.mat-mdc-row').length) { overlay.error('No saved draft rows found on the page.'); return { deleted: 0 }; }

      let pageSizeExpanded = false;
      while (true) {
        if (window.__afAutoStop) { overlay.log('Stopped by user.', 'warn'); break; }

        const selection = nextEligibleRow();
        if (selection) {
          const didDelete = await deleteRow(selection.row, selection.jobName);
          skippedNames.add(selection.jobName);
          if (didDelete) {
            deletedNames.push(selection.jobName);
            overlay.count(`Deleted ${deletedNames.length}`);
          }
          continue;
        }

        if (!pageSizeExpanded) { pageSizeExpanded = true; if (await setPageSizeTo100(config.menuDelayMs, config.pageDelayMs)) continue; }
        if (await clickNextPage(config.pageDelayMs)) continue;
        break;
      }

      overlay.done(`Finished. Deleted ${deletedNames.length} draft(s).`);
      return { deleted: deletedNames.length, names: deletedNames };
    } finally {
      window.__afAuto.busy = false;
    }
  }

  // -------------------------------------------------------------------------
  // Start draft runs (Open draft → Continue → Confirm)
  // confirmed=false : one top-down pass, counts every confirm click
  // confirmed=true  : loops until N submissions report success (snackbar based)
  // -------------------------------------------------------------------------
  async function startRuns(params) {
    params = params || {};
    const confirmed = !!params.confirmed;
    const config = Object.assign({
      rowDelayMs: 1200, menuDelayMs: 400, dialogDelayMs: 600,
      overlayTimeoutMs: 10000, overlayPollMs: 120,
      resultTimeoutMs: 8000, idleDelayMs: 1500, maxIdleCycles: 2, rowRetryLimit: 2
    }, params.options || {});

    const runLimit = Number(params.desiredRuns);
    if (!Number.isFinite(runLimit) || runLimit <= 0) { overlay.error('Invalid run count.'); return { started: 0 }; }
    if (window.__afAuto.busy) { overlay.log('Already running — please wait.', 'warn'); return { busy: true }; }
    if (!document.querySelectorAll('tr.mat-mdc-row').length) { overlay.error('No prediction rows found on the page.'); return { started: 0 }; }

    window.__afAuto.busy = true;
    window.__afAutoStop = false;
    overlay.start(confirmed ? `Starting ${runLimit} run(s) — confirmed` : `Starting ${runLimit} run(s)`);

    // Only run drafts whose title contains this text (case-insensitive). Empty = run any.
    const titleNeedle = normalize(params.titleFilter || '');
    const matchesFilter = (name) => !titleNeedle || normalize(name).includes(titleNeedle);
    if (titleNeedle) overlay.log(`Only running titles containing "${params.titleFilter.trim()}".`);

    await ensureSavedDraftFilter();

    const startedNames = window.__afStartedPredictions;
    const startedThisRun = [];

    const waitForElement = (resolver) => new Promise((resolve, reject) => {
      const start = performance.now();
      const lookup = () => {
        const element = typeof resolver === 'string' ? document.querySelector(resolver) : resolver();
        if (element) { resolve(element); return; }
        if (performance.now() - start > config.overlayTimeoutMs) { reject(new Error('Timed out waiting for element.')); return; }
        setTimeout(lookup, config.overlayPollMs);
      };
      lookup();
    });

    // ---- confirmed-mode helpers ----
    const gatherLiveMessages = () => {
      const candidates = [
        ...document.querySelectorAll('.mat-mdc-snack-bar-container .mdc-snackbar__label'),
        ...document.querySelectorAll('[role="alert"]'),
        ...document.querySelectorAll('[aria-live="assertive"], [aria-live="polite"]')
      ];
      return candidates
        .map((node) => normalize(node.textContent))
        .filter((text) => text && !text.includes('confirm and submit job'));
    };

    const classifyMessage = (message) => {
      const successTokens = ['job submitted', 'prediction submitted', 'prediction started', 'successfully submitted', 'queued'];
      const fatalTokens = ['quota', 'limit', 'not allowed', 'exceeded', 'too many', 'max number'];
      const failureTokens = ['failed', 'error', 'try again', 'unable', 'duplicate', 'already running', 'conflict'];
      if (successTokens.some((t) => message.includes(t))) return 'success';
      if (fatalTokens.some((t) => message.includes(t))) return 'fatal';
      if (failureTokens.some((t) => message.includes(t))) return 'failure';
      return 'unknown';
    };

    const waitForSubmissionOutcome = async () => {
      const start = performance.now();
      const seen = new Set();
      let dialogClosed = false;
      while (performance.now() - start < config.resultTimeoutMs) {
        if (!document.querySelector('.mat-mdc-dialog-container')) dialogClosed = true;
        for (const message of gatherLiveMessages()) {
          if (seen.has(message)) continue;
          seen.add(message);
          const c = classifyMessage(message);
          if (c === 'success') return { success: true, message };
          if (c === 'fatal') return { success: false, fatal: true, message };
          if (c === 'failure') return { success: false, fatal: false, message };
        }
        await wait(config.overlayPollMs);
      }
      if (!dialogClosed) return { success: false, fatal: false, message: 'Confirmation dialog never closed.' };
      return { success: true, message: 'No failure message detected; assuming success.' };
    };

    const readJobName = (row) => {
      const cell = row.querySelector('.cdk-column-name, .mat-column-name');
      const raw = cell ? cell.textContent.trim() : '';
      return raw || null;
    };

    // Open one row's draft and walk through Continue → Confirm. Returns true if confirm clicked.
    const submitRow = async (row, jobName) => {
      const menuButton = row.querySelector('button.mat-mdc-menu-trigger');
      if (!menuButton) { overlay.log(`${jobName}: menu trigger not found.`, 'warn'); return false; }

      overlay.log(`Opening draft for ${jobName}…`);
      menuButton.click();
      await wait(config.menuDelayMs);

      const openDraftButton = findMenuButtonByLabel(labelOpenDraft);
      if (!openDraftButton) { overlay.log(`${jobName}: "Open draft" not found.`, 'warn'); closeAnyMenu(); return false; }
      openDraftButton.click();
      await wait(config.dialogDelayMs);

      try {
        const continueButton = await waitForElement(
          () => document.querySelector('button.create-request') || findButtonByLabel(labelContinue)
        );
        continueButton.click();
        await wait(config.dialogDelayMs);
      } catch (e) {
        overlay.log(`${jobName}: failed to click "${labelContinue}".`, 'warn');
        return false;
      }

      try {
        const confirmButton = await waitForElement(
          () => document.querySelector('button.confirm') || findButtonByLabel(labelConfirm)
        );
        confirmButton.click();
        return true;
      } catch (e) {
        overlay.log(`${jobName}: failed to click "${labelConfirm}".`, 'warn');
        return false;
      }
    };

    try {
      let started = 0;
      const failureCounts = new Map();

      const nextEligibleRow = () => {
        const rows = Array.from(document.querySelectorAll('tr.mat-mdc-row'));
        for (const row of rows) {
          const jobName = readJobName(row);
          if (!jobName || startedNames.has(jobName)) continue;
          if (!matchesFilter(jobName)) continue;
          if ((failureCounts.get(jobName) || 0) >= config.rowRetryLimit) continue;
          return { row, jobName };
        }
        return null;
      };

      let pageSizeExpanded = false;
      while (started < runLimit) {
        if (window.__afAutoStop) { overlay.log('Stopped by user.', 'warn'); break; }

        const selection = nextEligibleRow();
        if (!selection) {
          // Out of matching rows on this page — reveal more before giving up.
          if (!pageSizeExpanded) { pageSizeExpanded = true; if (await setPageSizeTo100(config.menuDelayMs, config.pageDelayMs)) continue; }
          if (await clickNextPage(config.idleDelayMs)) continue;
          overlay.log('No more pages / eligible drafts. Stopping.', 'warn');
          break;
        }

        const { row, jobName } = selection;
        overlay.count(`${confirmed ? 'Confirmed' : 'Started'} ${started} / ${runLimit}`);
        const confirmClicked = await submitRow(row, jobName);
        if (!confirmClicked) {
          failureCounts.set(jobName, (failureCounts.get(jobName) || 0) + 1);
          continue;
        }

        if (confirmed) {
          const outcome = await waitForSubmissionOutcome();
          if (outcome.success) {
            started += 1;
            startedNames.add(jobName);
            startedThisRun.push(jobName);
            overlay.log(`Confirmed ${jobName} (${started}/${runLimit}). ${outcome.message}`, 'ok');
            overlay.progress(started, runLimit);
          } else {
            const count = (failureCounts.get(jobName) || 0) + 1;
            failureCounts.set(jobName, count);
            overlay.log(`Failed ${jobName} (${count}x): ${outcome.message}`, 'warn');
            if (outcome.fatal) { overlay.error('Stopping after a quota / limit error.'); break; }
          }
        } else {
          started += 1;
          startedNames.add(jobName);
          startedThisRun.push(jobName);
          overlay.log(`Submitted ${jobName} (${started}/${runLimit}).`, 'ok');
          overlay.progress(started, runLimit);
        }
        await wait(config.rowDelayMs);
      }

      if (startedThisRun.length === 0) overlay.done('Finished. No jobs were submitted.');
      else overlay.done(`Finished. Started ${startedThisRun.length}: ${startedThisRun.join(', ')}`);
      return { started, names: startedThisRun };
    } finally {
      window.__afAuto.busy = false;
    }
  }

  window.__afAuto = { overlay, busy: false, downloadAll, deleteDrafts, startRuns };
  return true;
}
