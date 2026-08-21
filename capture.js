/*
 * capture.js — runs in the page's MAIN world (injected with world: 'MAIN').
 *
 * While "armed", it swallows the page's own file downloads and routes the bytes
 * into ONE zip64 archive, so a 300-structure run costs a single save instead of
 * 300 download approvals. That is the only thing that works in incognito, where
 * Chrome never remembers a per-site "allow multiple downloads" answer.
 *
 * Two sinks:
 *   stream  — a FileSystemWritableFileStream from showSaveFilePicker(). Each
 *             file is written through as it arrives, so memory stays flat no
 *             matter how big the run is. This is the one that survives a
 *             several-GB incognito run: incognito keeps Blobs in RAM, so
 *             holding them all is what breaks past ~100 AlphaFold bundles.
 *   memory  — accumulate Blobs, build the archive at the end. Fallback for when
 *             the picker is unavailable or cancelled. Fine for small runs.
 *
 * Talks to the isolated-world automation (inject.js) over window.postMessage.
 */
(() => {
  if (window.__afCapInstalled) return;
  window.__afCapInstalled = true;

  const enc = new TextEncoder();
  const U32 = 0xffffffff;

  const state = {
    armed: false, mode: 'memory', files: [], bytes: 0, pending: 0,
    seen: new Set(), seenUrls: new Set(), skipped: 0, failed: [], zip64Limit: U32
  };
  window.__afCap = state; // exposed for debugging / the self-check

  const stream = { writer: null, name: '', offset: 0, entries: [], chain: Promise.resolve() };

  const origAnchorClick = HTMLAnchorElement.prototype.click;
  const origOpen = window.open;
  let emitting = false; // guard so our own ZIP download is not re-captured

  // ---- CRC32, streamed so a multi-GB entry never lands in the JS heap -------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

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

  // ---- ZIP records (store-only; zip64 when sizes or offsets overflow) -------
  // NOTE: in both headers the extra field comes AFTER the file name.
  const localRecord = (name, crc, size, offset) => {
    const nameBytes = enc.encode(name);
    const bigSize = size > state.zip64Limit;
    const bigOffset = offset > state.zip64Limit;
    const version = bigSize || bigOffset ? 45 : 20;

    const extra = new DataView(new ArrayBuffer(bigSize ? 20 : 0));
    if (bigSize) {
      extra.setUint16(0, 0x0001, true);
      extra.setUint16(2, 16, true);
      extra.setBigUint64(4, BigInt(size), true);
      extra.setBigUint64(12, BigInt(size), true);
    }
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, version, true);
    lh.setUint16(6, 0x0800, true);          // UTF-8 names
    lh.setUint16(8, 0, true);               // method: store
    lh.setUint16(10, 0, true);              // time 00:00
    lh.setUint16(12, 0x21, true);           // date 1980-01-01
    lh.setUint32(14, crc, true);
    lh.setUint32(18, bigSize ? U32 : size, true);
    lh.setUint32(22, bigSize ? U32 : size, true);
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, extra.byteLength, true);

    return {
      parts: [lh.buffer, nameBytes, extra.buffer],
      bytes: 30 + nameBytes.length + extra.byteLength,
      entry: { nameBytes, crc, size, offset, bigSize, bigOffset, version }
    };
  };

  // Zip64 extra in the central record carries only the fields that were masked
  // to 0xFFFFFFFF, in spec order: size, compressed size, offset.
  const centralRecord = (e) => {
    const extraLen = (e.bigSize ? 16 : 0) + (e.bigOffset ? 8 : 0);
    const extra = new DataView(new ArrayBuffer(extraLen ? extraLen + 4 : 0));
    if (extraLen) {
      extra.setUint16(0, 0x0001, true);
      extra.setUint16(2, extraLen, true);
      let p = 4;
      if (e.bigSize) { extra.setBigUint64(p, BigInt(e.size), true); extra.setBigUint64(p + 8, BigInt(e.size), true); p += 16; }
      if (e.bigOffset) extra.setBigUint64(p, BigInt(e.offset), true);
    }
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, e.version, true);
    cd.setUint16(6, e.version, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, 0, true);
    cd.setUint16(14, 0x21, true);
    cd.setUint32(16, e.crc, true);
    cd.setUint32(20, e.bigSize ? U32 : e.size, true);
    cd.setUint32(24, e.bigSize ? U32 : e.size, true);
    cd.setUint16(28, e.nameBytes.length, true);
    cd.setUint16(30, extra.byteLength, true);
    cd.setUint32(42, e.bigOffset ? U32 : e.offset, true);
    return { parts: [cd.buffer, e.nameBytes, extra.buffer], bytes: 46 + e.nameBytes.length + extra.byteLength };
  };

  const endRecords = (count, centralSize, centralOffset) => {
    const limit = state.zip64Limit;
    const parts = [];
    if (count > 0xffff || centralOffset > limit || centralSize > limit) {
      const z64 = new DataView(new ArrayBuffer(56));
      z64.setUint32(0, 0x06064b50, true);
      z64.setBigUint64(4, 44n, true);       // size of this record - 12
      z64.setUint16(12, 45, true);
      z64.setUint16(14, 45, true);
      z64.setBigUint64(24, BigInt(count), true);
      z64.setBigUint64(32, BigInt(count), true);
      z64.setBigUint64(40, BigInt(centralSize), true);
      z64.setBigUint64(48, BigInt(centralOffset), true);

      const loc = new DataView(new ArrayBuffer(20));
      loc.setUint32(0, 0x07064b50, true);
      loc.setBigUint64(8, BigInt(centralOffset + centralSize), true);
      loc.setUint32(16, 1, true);
      parts.push(z64.buffer, loc.buffer);
    }
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, Math.min(count, 0xffff), true);
    eocd.setUint16(10, Math.min(count, 0xffff), true);
    eocd.setUint32(12, Math.min(centralSize, U32), true);
    eocd.setUint32(16, Math.min(centralOffset, U32), true);
    parts.push(eocd.buffer);
    return parts;
  };

  // ---- memory sink --------------------------------------------------------
  const buildZip = async (files, onProgress) => {
    const body = [];
    const central = [];
    let offset = 0;
    let centralSize = 0;
    let index = 0;
    for (const f of files) {
      const crc = await crc32(f.blob);
      if (onProgress) onProgress(++index, files.length);
      const { parts, bytes, entry } = localRecord(f.name, crc, f.blob.size, offset);
      body.push(...parts, f.blob);
      offset += bytes + f.blob.size;
      const cr = centralRecord(entry);
      central.push(...cr.parts);
      centralSize += cr.bytes;
    }
    return new Blob([...body, ...central, ...endRecords(files.length, centralSize, offset)], { type: 'application/zip' });
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

  // ---- streaming sink -----------------------------------------------------
  // Serialized through stream.chain so only one entry is in flight, which is
  // what keeps memory flat.
  const writeEntry = (name, blob) => {
    stream.chain = stream.chain.then(async () => {
      const crc = await crc32(blob);
      const { parts, bytes, entry } = localRecord(name, crc, blob.size, stream.offset);
      for (const p of parts) if (p.byteLength) await stream.writer.write(p);
      await stream.writer.write(blob);
      stream.offset += bytes + blob.size;
      stream.entries.push(entry);
      window.postMessage({ __af: 'zipProgress', done: stream.entries.length, bytes: stream.offset }, '*');
    }).catch((err) => {
      state.failed.push(name + ' (write: ' + (err && err.message || err) + ')');
    });
    return stream.chain;
  };

  const finishStream = async () => {
    await stream.chain;
    const central = [];
    let centralSize = 0;
    for (const e of stream.entries) {
      const cr = centralRecord(e);
      central.push(...cr.parts);
      centralSize += cr.bytes;
    }
    for (const p of [...central, ...endRecords(stream.entries.length, centralSize, stream.offset)]) {
      if (p.byteLength) await stream.writer.write(p);
    }
    await stream.writer.close();
    const out = { count: stream.entries.length, bytes: stream.offset + centralSize, name: stream.name };
    stream.writer = null;
    stream.offset = 0;
    stream.entries = [];
    stream.chain = Promise.resolve();
    return out;
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
    // A blob:/data: URL identifies its bytes exactly (createObjectURL never
    // reuses a UUID), so seeing one twice means the page was asked for the same
    // file twice — archive it once. http(s) URLs are NOT deduped: a site can
    // legitimately serve every row from one endpoint.
    if (/^blob:|^data:/.test(url)) {
      if (state.seenUrls.has(url)) { state.skipped += 1; return; }
      state.seenUrls.add(url);
    }
    state.pending += 1;
    fetch(url, { credentials: 'include' })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((blob) => {
        state.bytes += blob.size;
        if (state.mode === 'stream') return writeEntry(name, blob);
        state.files.push({ name, blob });
      })
      .catch((err) => {
        // Deliberately NOT falling back to a plain browser download: in
        // incognito that is one "Save as" dialog per file. Record it instead so
        // the caller can drop it from the log and pick it up on a rerun.
        state.failed.push(name + ' (' + (err && err.message || err) + ')');
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
  const reply = (id, data) => window.postMessage(Object.assign({ __af: 'ack', id }, data), '*');

  const settle = async (timeoutMs = 300000) => {
    const deadline = performance.now() + timeoutMs;
    while (state.pending > 0 && performance.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  };

  const takeFailures = () => state.failed.splice(0, state.failed.length);

  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data || e.data.__af !== 'cmd') return;
    const { id, cmd } = e.data;

    if (cmd === 'arm') {
      state.armed = !!e.data.on;
      if (state.armed) { state.seen.clear(); state.seenUrls.clear(); state.skipped = 0; state.failed.length = 0; state.bytes = 0; }
      reply(id, { armed: state.armed, mode: state.mode });

    } else if (cmd === 'pick') {
      // Must run while the user gesture that triggered this message is still
      // live, so do no awaiting before the picker call.
      if (!window.showSaveFilePicker) { reply(id, { ok: false, reason: 'unsupported' }); return; }
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: e.data.filename || 'alphafold.zip',
          types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }]
        });
        stream.writer = await handle.createWritable();
        stream.name = handle.name;
        stream.offset = 0;
        stream.entries = [];
        stream.chain = Promise.resolve();
        state.mode = 'stream';
        reply(id, { ok: true, name: handle.name });
      } catch (err) {
        state.mode = 'memory';
        reply(id, { ok: false, reason: (err && err.name) === 'AbortError' ? 'cancelled' : String(err && err.message || err) });
      }

    } else if (cmd === 'status') {
      reply(id, {
        count: state.mode === 'stream' ? stream.entries.length : state.files.length,
        bytes: state.bytes, pending: state.pending, mode: state.mode,
        failed: state.failed.length, skipped: state.skipped
      });

    } else if (cmd === 'flush') {
      await settle();
      if (state.mode === 'stream') {
        if (!stream.writer) { reply(id, { count: 0, bytes: 0, failed: takeFailures() }); return; }
        try {
          const out = await finishStream();
          reply(id, Object.assign(out, { failed: takeFailures() }));
        } catch (err) {
          reply(id, { count: 0, bytes: 0, error: String(err && err.message || err), failed: takeFailures() });
        }
        state.mode = 'memory';
        return;
      }
      const files = state.files.splice(0, state.files.length);
      const bytes = state.bytes;
      state.bytes = 0;
      if (!files.length) { reply(id, { count: 0, bytes: 0, failed: takeFailures() }); return; }
      try {
        const onProgress = (done, total) => window.postMessage({ __af: 'zipProgress', done, total }, '*');
        saveBlob(await buildZip(files, onProgress), e.data.filename || 'alphafold.zip');
        reply(id, { count: files.length, bytes, name: e.data.filename, failed: takeFailures() });
      } catch (err) {
        reply(id, { count: 0, bytes: 0, error: String(err && err.message || err), failed: takeFailures() });
      }
    }
  });

  window.postMessage({ __af: 'ready' }, '*');
})();
