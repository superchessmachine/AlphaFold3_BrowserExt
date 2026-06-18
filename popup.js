/* popup.js — wires the buttons to the injected automation on the active tab. */

const $ = (id) => document.getElementById(id);

function setStatus(msg, kind = 'info') {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status ' + kind;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

const RESTRICTED = /^(chrome|edge|brave|about|chrome-extension|devtools|view-source|https:\/\/chromewebstore\.google\.com|https:\/\/chrome\.google\.com\/webstore)/i;

// Install the automation bundle, then invoke one of its methods. The injected
// method keeps running in the page even after this popup closes.
async function trigger(method, params) {
  const tab = await getActiveTab();
  if (!tab || !tab.id) { setStatus('No active tab found.', 'err'); return; }
  if (RESTRICTED.test(tab.url || '')) {
    setStatus('Open your AlphaFold predictions page in this tab first — the extension cannot run on browser/store pages.', 'err');
    return;
  }

  try {
    // 1) Ensure the automation is installed (idempotent).
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: installAutomation });
  } catch (e) {
    setStatus('Could not access this page: ' + e.message, 'err');
    return;
  }

  // 2) Kick off the action. Do not await completion so the popup stays responsive.
  setStatus('Running on the page — watch the progress panel in the bottom-right corner. You can close this popup.', 'ok');
  chrome.scripting
    .executeScript({
      target: { tabId: tab.id },
      func: (m, p) => window.__afAuto && window.__afAuto[m](p),
      args: [method, params]
    })
    .catch(() => { /* page navigated or popup closed mid-run; the page-side script handles its own state */ });
}

$('startRuns').addEventListener('click', () => {
  const desiredRuns = parseInt($('runCount').value, 10);
  if (!Number.isFinite(desiredRuns) || desiredRuns <= 0) { setStatus('Enter how many runs to start (1 or more).', 'err'); return; }
  const confirmed = $('confirmedMode').checked;
  const titleFilter = $('titleFilter').value.trim();
  const rowDelayMs = parseInt($('rowDelay').value, 10);
  const options = Number.isFinite(rowDelayMs) ? { rowDelayMs } : {};
  trigger('startRuns', { desiredRuns, confirmed, titleFilter, options });
});

$('deleteDrafts').addEventListener('click', () => {
  const titleFilter = $('deleteFilter').value.trim();
  if (!titleFilter) { setStatus('Enter title text to match before deleting drafts.', 'err'); return; }
  if (!confirm(`Delete saved drafts whose title contains "${titleFilter}"?`)) return;
  trigger('deleteDrafts', { titleFilter });
});

$('downloadAll').addEventListener('click', () => {
  const desiredDownloads = parseInt($('dlCount').value, 10);
  if (!Number.isFinite(desiredDownloads) || desiredDownloads <= 0) { setStatus('Enter how many predictions to download (1 or more).', 'err'); return; }
  const delayMs = parseInt($('dlDelay').value, 10);
  trigger('downloadAll', { desiredDownloads, delayMs: Number.isFinite(delayMs) ? delayMs : 500 });
});

$('openGenerator').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('generator.html') });
});
