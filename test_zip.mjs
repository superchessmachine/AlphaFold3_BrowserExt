/* test_zip.mjs — self-check for capture.js's store-only ZIP writer.
   Run: node test_zip.mjs   (needs `unzip` on PATH)                          */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';

let saved = null;
const listeners = [];
const anchorProto = { click() { if (this.download) saved = { name: this.download, blob: this._blob }; } };

globalThis.HTMLAnchorElement = function () {};
globalThis.HTMLAnchorElement.prototype = anchorProto;
globalThis.location = { href: 'https://example.test/app' };
const blobs = new Map();
globalThis.URL.createObjectURL = (b) => { const u = 'blob:x' + blobs.size; blobs.set(u, b); return u; };
globalThis.URL.revokeObjectURL = () => {};
globalThis.document = {
  createElement: () => Object.create(anchorProto),
  addEventListener: () => {}
};
globalThis.window = {
  addEventListener: (t, fn) => t === 'message' && listeners.push(fn),
  postMessage: (data) => listeners.forEach((fn) => fn({ source: globalThis.window, data })),
  open: () => {}
};
Object.defineProperty(globalThis.document.createElement(), 'href', { value: '' });

new Function(readFileSync('capture.js', 'utf8'))();

// Hand the shim three files directly, then ask it to package them.
const files = [
  { name: 'fold_sin3a_1.json', body: '{"hello":"sin3a"}' },
  { name: 'fold_sin3a_2.cif', body: 'data_x\nATOM 1 N\n'.repeat(500) },
  { name: 'unicode_ß_名.txt', body: 'ok' }
];
for (const f of files) {
  const blob = new Blob([f.body]);
  // saveBlob's anchor needs the blob reachable; patch createElement per call.
  globalThis.window.__afCap.files.push({ name: f.name, blob });
}
const origCreate = globalThis.document.createElement;
globalThis.document.createElement = () => {
  const a = Object.create(anchorProto);
  Object.defineProperty(a, 'href', { set(v) { this._blob = blobs.get(v); }, get() { return ''; } });
  return a;
};

const id = 'test1';
let acked = null;
listeners.push((e) => { if (e.data.__af === 'ack' && e.data.id === id) acked = e.data; });
globalThis.window.postMessage({ __af: 'cmd', id, cmd: 'flush', filename: 'batch1.zip' });

await new Promise((r) => setTimeout(r, 300));
assert.ok(acked, 'flush never acked');
assert.strictEqual(acked.error, undefined, 'flush errored: ' + acked.error);
assert.strictEqual(acked.count, 3, 'wrong file count');
assert.ok(saved && saved.name === 'batch1.zip', 'no zip was saved');

const dir = mkdtempSync(join(tmpdir(), 'afzip-'));
const zipPath = join(dir, 'batch1.zip');
writeFileSync(zipPath, Buffer.from(await saved.blob.arrayBuffer()));

// `unzip -t` validates CRCs, offsets and the central directory. Python's
// zipfile then checks names+contents (macOS's Info-ZIP ignores the UTF-8 flag).
execFileSync('unzip', ['-t', zipPath], { stdio: 'pipe' });
const expected = JSON.stringify(Object.fromEntries(files.map((f) => [f.name, f.body])));
const got = execFileSync('python3', ['-c', `
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
print(json.dumps({i.filename: z.read(i).decode() for i in z.infolist()}))
`, zipPath], { encoding: 'utf8' }).trim();
assert.deepStrictEqual(JSON.parse(got), JSON.parse(expected), 'zip contents did not round-trip');
console.log('zip self-check passed: 3 entries, CRCs valid, UTF-8 names and contents round-trip');
