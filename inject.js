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

  const findButtonByLabel = (label) => {
    const target = normalize(label);
    return Array.from(document.querySelectorAll('button')).find(
      (btn) => normalize(btn.textContent) === target && !btn.disabled
    );
  };

  const labelOpenDraft = 'Open draft';
  const labelContinue = 'Continue and preview job';
  const labelConfirm = 'Confirm and submit job';

  // -------------------------------------------------------------------------
  // Download predictions from the top of the list.
  // Like startRuns, this keeps going until `desiredDownloads` rows are
  // triggered, scrolling to reveal more rows when the visible ones run out.
  // Already-downloaded job names are remembered for the page session so a
  // rerun continues with the next batch instead of repeating the top rows.
  // If desiredDownloads is omitted/invalid it falls back to downloading every
  // row it can reach (revealing more by scrolling until nothing new loads).
  // -------------------------------------------------------------------------
  async function downloadAll(params) {
    params = params || {};
    const config = Object.assign({
      menuDelayMs: 500, idleDelayMs: 1500, maxIdleCycles: 3, rowRetryLimit: 2
    }, params.options || {});
    const delayMs = Number(params.delayMs) > 0 ? Number(params.delayMs) : 500;

    const desired = Number(params.desiredDownloads);
    const limited = Number.isFinite(desired) && desired > 0;

    if (window.__afAuto.busy) { overlay.log('Already running — please wait.', 'warn'); return { busy: true }; }
    if (!document.querySelectorAll('tr.mat-mdc-row').length) { overlay.error('No prediction rows found on the page.'); return { triggered: 0 }; }

    window.__afAuto.busy = true;
    window.__afAutoStop = false;
    overlay.start(limited ? `Downloading ${desired} prediction(s)` : 'Downloading predictions');

    // Persistent set of job names downloaded this page session so reruns skip them.
    if (!(window.__afDownloadedPredictions instanceof Set)) {
      const existing = window.__afDownloadedPredictions;
      window.__afDownloadedPredictions = Array.isArray(existing) ? new Set(existing) : new Set();
    }
    const downloadedNames = window.__afDownloadedPredictions;
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
        if (downloadedNames.has(key)) continue;
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

    try {
      let triggered = 0;
      let idleCycles = 0;

      while (!limited || triggered < desired) {
        if (window.__afAutoStop) { overlay.log('Stopped by user.', 'warn'); break; }

        const selection = nextEligibleRow();
        if (!selection) {
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
        if (downloadItem) {
          downloadItem.click();
          triggered += 1;
          downloadedNames.add(key);
          overlay.log(`Downloaded ${key} (${triggered}${limited ? '/' + desired : ''}).`, 'ok');
          if (limited) overlay.progress(triggered, desired);
        } else {
          overlay.log(`${key}: "Download" not found.`, 'warn');
          failureCounts.set(key, (failureCounts.get(key) || 0) + 1);
          closeAnyMenu();
        }
        await wait(delayMs);
      }

      if (limited) overlay.progress(triggered, desired);
      overlay.done(`Finished. Triggered ${triggered} download(s).`);
      return { triggered };
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

      if (!confirmed) {
        // ---- Simple top-down pass ----
        const rows = Array.from(document.querySelectorAll('tr.mat-mdc-row'));
        for (let i = 0; i < rows.length && started < runLimit; i += 1) {
          if (window.__afAutoStop) { overlay.log('Stopped by user.', 'warn'); break; }
          const row = rows[i];
          const jobName = readJobName(row) || `Row ${i + 1}`;
          if (startedNames.has(jobName)) { overlay.log(`Skipping ${jobName} (already started).`, 'warn'); continue; }

          overlay.count(`Started ${started} / ${runLimit}`);
          const ok = await submitRow(row, jobName);
          if (ok) {
            started += 1;
            startedNames.add(jobName);
            startedThisRun.push(jobName);
            overlay.log(`Submitted ${jobName} (${started}/${runLimit}).`, 'ok');
            overlay.progress(started, runLimit);
          }
          await wait(config.rowDelayMs);
        }
      } else {
        // ---- Confirmed mode: loop until N successes ----
        const failureCounts = new Map();
        const nextEligibleRow = () => {
          const rows = Array.from(document.querySelectorAll('tr.mat-mdc-row'));
          for (const row of rows) {
            const jobName = readJobName(row);
            if (!jobName || startedNames.has(jobName)) continue;
            if ((failureCounts.get(jobName) || 0) >= config.rowRetryLimit) continue;
            return { row, jobName };
          }
          return null;
        };

        let idleCycles = 0;
        while (started < runLimit) {
          if (window.__afAutoStop) { overlay.log('Stopped by user.', 'warn'); break; }
          const selection = nextEligibleRow();
          if (!selection) {
            idleCycles += 1;
            if (idleCycles > config.maxIdleCycles) { overlay.log('No eligible drafts remain. Stopping.', 'warn'); break; }
            overlay.log('No eligible drafts found. Waiting for table to update…', 'warn');
            await wait(config.idleDelayMs);
            continue;
          }
          idleCycles = 0;

          const { row, jobName } = selection;
          overlay.count(`Confirmed ${started} / ${runLimit}`);
          const confirmClicked = await submitRow(row, jobName);
          if (!confirmClicked) {
            failureCounts.set(jobName, (failureCounts.get(jobName) || 0) + 1);
            continue;
          }

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
          await wait(config.rowDelayMs);
        }
      }

      if (startedThisRun.length === 0) overlay.done('Finished. No jobs were submitted.');
      else overlay.done(`Finished. Started ${startedThisRun.length}: ${startedThisRun.join(', ')}`);
      return { started, names: startedThisRun };
    } finally {
      window.__afAuto.busy = false;
    }
  }

  window.__afAuto = { overlay, busy: false, downloadAll, startRuns };
  return true;
}
