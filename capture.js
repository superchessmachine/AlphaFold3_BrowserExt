/*
 * capture.js — runs in the page's MAIN world (injected with world: 'MAIN').
 *
 * While "armed", it swallows the page's own file downloads, keeps the bytes as
 * Blobs, and on "flush" writes them into ONE store-only ZIP that it downloads
 * with a single click. That is what turns 100 download approvals into 1, and it
 * is the only part that works in incognito, where Chrome does not remember a
 * per-site "allow multiple downloads" answer.
 *
 * Talks to the isolated-world automation (inject.js) over window.postMessage.
 */
(() => {
  if (window.__afCapInstalled) return;
  window.__afCapInstalled = true;

  const state = { armed: false, files: [], bytes: 0, pending: 0, seen: new Set() };
  window.__afCap = state; // exposed for debugging / the zip self-check
  const origAnchorClick = HTMLAnchorElement.prototype.click;
  const origOpen = window.open;
  let emitting = false; // guard so our own ZIP download is not re-captured

  // ---- store-only ZIP writer (no compression: AF3 payloads are already zips) --
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  // Streamed so a multi-GB batch never lands in the JS heap — the Blob bytes
  // stay in Chrome's blob store (which spills to disk).
  const crc32 = async (blob) => {
    let c = 0xffffffff;
    const reader = blob.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (let i = 0; i < value.length; i++) c = CRC_TABLE[(c ^ value[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  };

  // ponytail: zip32 only — no zip64. Entries and the archive must stay under
  // 4 GB, which the batch-size knob in the popup already keeps you under.
  // Add zip64 headers if someone really wants a single >4 GB bundle.
  const buildZip = async (files) => {
    const enc = new TextEncoder();
    const body = [];
    const central = [];
    let offset = 0;
    let centralSize = 0;

    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const crc = await crc32(f.blob);
      const size = f.blob.size;

      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);      // version needed
      lh.setUint16(6, 0x0800, true);  // UTF-8 names
      lh.setUint16(8, 0, true);       // method: store
      lh.setUint16(10, 0, true);      // time 00:00
      lh.setUint16(12, 0x21, true);   // date 1980-01-01
      lh.setUint32(14, crc, true);
      lh.setUint32(18, size, true);
      lh.setUint32(22, size, true);
      lh.setUint16(26, nameBytes.length, true);
      body.push(lh.buffer, nameBytes, f.blob);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, 0, true);
      cd.setUint16(14, 0x21, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, size, true);
      cd.setUint32(24, size, true);
      cd.setUint16(28, nameBytes.length, true);
      cd.setUint32(42, offset, true); // relative offset of local header
      central.push(cd.buffer, nameBytes);

      offset += 30 + nameBytes.length + size;
      centralSize += 46 + nameBytes.length;
    }

    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, files.length, true);
    eocd.setUint16(10, files.length, true);
    eocd.setUint32(12, centralSize, true);
    eocd.setUint32(16, offset, true);
    return new Blob([...body, ...central, eocd.buffer], { type: 'application/zip' });
  };

  const saveBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    emitting = true;
    try { origAnchorClick.call(a); } finally { emitting = false; }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  // ---- capture ------------------------------------------------------------
  const uniqueName = (name) => {
    if (!state.seen.has(name)) { state.seen.add(name); return name; }
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let i = 2;
    while (state.seen.has(`${stem}_${i}${ext}`)) i++;
    const out = `${stem}_${i}${ext}`;
    state.seen.add(out);
    return out;
  };

  const nameFor = (anchor, url) => {
    let name = anchor ? anchor.getAttribute('download') : '';
    if (!name) {
      try { name = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop() || ''); } catch (e) { /* opaque url */ }
    }
    return uniqueName(name || 'download.bin');
  };

  // Start the fetch in the SAME tick as the click — pages routinely call
  // URL.revokeObjectURL() right after, which would kill a deferred fetch.
  const capture = (url, name) => {
    state.pending += 1;
    fetch(url, { credentials: 'include' })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((blob) => { state.files.push({ name, blob }); state.bytes += blob.size; })
      .catch(() => {
        // Could not read it — let the browser download it the normal way so
        // the file is not silently lost.
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        emitting = true;
        try { origAnchorClick.call(a); } finally { emitting = false; }
      })
      .finally(() => { state.pending -= 1; });
  };

  const isDownloadUrl = (anchor, url) =>
    !!url && ((anchor && anchor.hasAttribute('download')) || /^blob:|^data:/.test(url));

  HTMLAnchorElement.prototype.click = function () {
    if (state.armed && !emitting && isDownloadUrl(this, this.href)) {
      capture(this.href, nameFor(this, this.href));
      return;
    }
    return origAnchorClick.apply(this, arguments);
  };

  // Anchors clicked by a real/dispatched MouseEvent rather than a.click().
  document.addEventListener('click', (e) => {
    if (!state.armed || emitting) return;
    const a = e.target && e.target.closest && e.target.closest('a[download], a[href^="blob:"]');
    if (!a || !a.href) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    capture(a.href, nameFor(a, a.href));
  }, true);

  window.open = function (url, ...rest) {
    if (state.armed && !emitting && typeof url === 'string' && /^blob:|\.(zip|cif|pdb|json|tar|gz)(\?|$)/i.test(url)) {
      capture(url, nameFor(null, url));
      return null;
    }
    return origOpen.call(window, url, ...rest);
  };

  // ---- command channel ----------------------------------------------------
  const reply = (id, kind, data) => window.postMessage(Object.assign({ __af: kind, id }, data), '*');

  const settle = async (timeoutMs = 60000) => {
    const deadline = performance.now() + timeoutMs;
    while (state.pending > 0 && performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data || e.data.__af !== 'cmd') return;
    const { id, cmd } = e.data;

    if (cmd === 'arm') {
      state.armed = !!e.data.on;
      reply(id, 'ack', { armed: state.armed });
    } else if (cmd === 'status') {
      reply(id, 'ack', { count: state.files.length, bytes: state.bytes, pending: state.pending });
    } else if (cmd === 'flush') {
      await settle();
      const files = state.files.splice(0, state.files.length);
      const bytes = state.bytes;
      state.bytes = 0;
      state.seen.clear();
      if (!files.length) { reply(id, 'ack', { count: 0, bytes: 0 }); return; }
      try {
        saveBlob(await buildZip(files), e.data.filename || 'alphafold_batch.zip');
        reply(id, 'ack', { count: files.length, bytes });
      } catch (err) {
        reply(id, 'ack', { count: 0, bytes: 0, error: String(err && err.message || err) });
      }
    }
  });

  window.postMessage({ __af: 'ready' }, '*');
})();
