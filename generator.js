/* generator.js — in-browser port of generate_screening_json_v1.py */

const $ = (id) => document.getElementById(id);

let csvRows = null;   // array of objects keyed by header
let csvHeaders = [];
let generatedChunks = [];   // [{ name, json }]
let fullArrayJson = '';

function setStatus(msg, kind = 'info') {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status ' + kind;
}

// ---------- screening chain rows ----------
function addChainRow(name = '', sequence = '') {
  const row = document.createElement('div');
  row.className = 'chain-row';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'Chain name (optional)';
  nameInput.value = name;
  nameInput.className = 'chain-name';

  const seqInput = document.createElement('textarea');
  seqInput.placeholder = 'Paste amino-acid sequence…';
  seqInput.value = sequence;
  seqInput.className = 'chain-seq';

  const remove = document.createElement('button');
  remove.className = 'remove';
  remove.textContent = '✕';
  remove.title = 'Remove chain';
  remove.onclick = () => row.remove();

  row.append(nameInput, seqInput, remove);
  $('chains').appendChild(row);
}

function normalizeSequence(raw) {
  return (raw || '').replace(/\s+/g, '');
}

function getChains() {
  const chains = [];
  let counter = 1;
  document.querySelectorAll('#chains .chain-row').forEach((row) => {
    const sequence = normalizeSequence(row.querySelector('.chain-seq').value);
    if (!sequence) return;
    const label = row.querySelector('.chain-name').value.trim() || `Chain${counter}`;
    chains.push({ name: label, sequence });
    counter += 1;
  });
  return chains;
}

// ---------- CSV ----------
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\r') {
      // ignore; handled by \n
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function loadCsvText(text) {
  const matrix = parseCSV(stripBom(text)).filter((r) => r.some((cell) => cell.trim() !== ''));
  if (!matrix.length) { setStatus('The CSV appears to be empty.', 'err'); return; }
  csvHeaders = matrix[0].map((h) => h.trim());
  csvRows = matrix.slice(1).map((r) => {
    const obj = {};
    csvHeaders.forEach((h, idx) => { obj[h] = r[idx] !== undefined ? r[idx] : ''; });
    return obj;
  });

  // populate datalist + guess columns
  const dl = $('csvCols');
  dl.innerHTML = '';
  csvHeaders.forEach((h) => {
    const opt = document.createElement('option');
    opt.value = h;
    dl.appendChild(opt);
  });
  const guess = (re) => csvHeaders.find((h) => re.test(h));
  if (!$('nameCol').value) $('nameCol').value = guess(/name|id|target/i) || csvHeaders[0] || '';
  if (!$('seqCol').value) $('seqCol').value = guess(/seq/i) || csvHeaders[1] || '';

  $('csvInfo').textContent = `Loaded ${csvRows.length} row(s). Columns: ${csvHeaders.join(', ')}`;
}

$('csvFile').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => loadCsvText(String(reader.result));
  reader.onerror = () => setStatus('Failed to read the CSV file.', 'err');
  reader.readAsText(file);
});

// ---------- payload ----------
function randomSeed() {
  // 9-digit seed not starting with 0, matching the Python generator.
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100000000 + (buf[0] % 900000000));
}

function loadTargets(nameCol, seqCol) {
  const targets = [];
  csvRows.forEach((rowObj, idx) => {
    const sequence = normalizeSequence(rowObj[seqCol]);
    if (!sequence) return; // skip empty-sequence rows
    const name = (rowObj[nameCol] || '').trim() || `Entry${idx + 1}`;
    targets.push({ name, sequence });
  });
  return targets;
}

function buildPayload(targets, chains) {
  const payload = [];
  targets.forEach((target) => {
    chains.forEach((chain) => {
      payload.push({
        name: `${target.name}_${chain.name}`,
        modelSeeds: [randomSeed()],
        sequences: [
          { proteinChain: { sequence: target.sequence, count: 1, useStructureTemplate: true } },
          { proteinChain: { sequence: chain.sequence, count: 1, useStructureTemplate: true } }
        ],
        dialect: 'alphafoldserver',
        version: 1
      });
    });
  });
  return payload;
}

function chunkPayload(payload, size) {
  const chunks = [];
  for (let start = 0; start < payload.length; start += size) {
    const slice = payload.slice(start, start + size);
    chunks.push({ slice, startIdx: start + 1, endIdx: start + slice.length });
  }
  return chunks;
}

$('generate').addEventListener('click', () => {
  const chains = getChains();
  if (!chains.length) { setStatus('Add at least one screening chain with a sequence.', 'err'); return; }
  if (!csvRows) { setStatus('Choose a CSV file with your targets.', 'err'); return; }

  const nameCol = $('nameCol').value.trim();
  const seqCol = $('seqCol').value.trim();
  if (!nameCol || !seqCol) { setStatus('Enter both the name and sequence column titles.', 'err'); return; }
  if (!csvHeaders.includes(nameCol) || !csvHeaders.includes(seqCol)) {
    setStatus(`Column not found. Available columns: ${csvHeaders.join(', ')}`, 'err'); return;
  }

  const targets = loadTargets(nameCol, seqCol);
  if (!targets.length) { setStatus('No usable target sequences found in the CSV.', 'err'); return; }

  const chunkSize = Math.max(1, parseInt($('chunkSize').value, 10) || 100);
  const baseName = ($('baseName').value.trim() || 'predictions').replace(/\.json$/i, '');

  const payload = buildPayload(targets, chains);
  fullArrayJson = JSON.stringify(payload, null, 2);

  generatedChunks = chunkPayload(payload, chunkSize).map(({ slice, startIdx, endIdx }) => ({
    name: `${baseName}_${startIdx}-${endIdx}.json`,
    json: JSON.stringify(slice, null, 2)
  }));

  $('preview').value = generatedChunks[0].json;
  $('downloadSplit').disabled = false;
  $('downloadSingle').disabled = false;
  $('copyAll').disabled = false;

  setStatus(
    `Generated ${payload.length} entr${payload.length === 1 ? 'y' : 'ies'} ` +
    `(${targets.length} target × ${chains.length} chain) across ${generatedChunks.length} file(s).`,
    'ok'
  );
});

// ---------- downloads ----------
function downloadBlob(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

$('downloadSplit').addEventListener('click', async () => {
  if (!generatedChunks.length) return;
  for (let i = 0; i < generatedChunks.length; i += 1) {
    downloadBlob(generatedChunks[i].name, generatedChunks[i].json);
    await new Promise((r) => setTimeout(r, 350)); // stagger so Chrome accepts the batch
  }
  setStatus(`Downloaded ${generatedChunks.length} file(s). If only one saved, allow multiple downloads when Chrome asks.`, 'ok');
});

$('downloadSingle').addEventListener('click', () => {
  if (!fullArrayJson) return;
  const baseName = ($('baseName').value.trim() || 'predictions').replace(/\.json$/i, '');
  downloadBlob(`${baseName}.json`, fullArrayJson);
});

$('copyAll').addEventListener('click', async () => {
  if (!fullArrayJson) return;
  try {
    await navigator.clipboard.writeText(fullArrayJson);
    setStatus('Copied the full JSON array to the clipboard.', 'ok');
  } catch (e) {
    setStatus('Clipboard blocked — use a download button instead.', 'err');
  }
});

// start with one empty chain row
addChainRow();
$('addChain').addEventListener('click', () => addChainRow());
