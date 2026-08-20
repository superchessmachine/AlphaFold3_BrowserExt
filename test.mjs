/* test.mjs — self-checks for the two bits of non-obvious logic:
   capture.js's ZIP writer, and inject.js's paginator disabled-state test.
   Run: node test.mjs   (needs `unzip` and `python3` on PATH)                */
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
  { name: 'fold_p53_1.json', body: '{"hello":"p53"}' },
  { name: 'fold_p53_2.cif', body: 'data_x\nATOM 1 N\n'.repeat(500) },
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

async function flush(label) {
  const id = 'flush-' + label;
  let acked = null;
  listeners.push((e) => { if (e.data.__af === 'ack' && e.data.id === id) acked = e.data; });
  globalThis.window.postMessage({ __af: 'cmd', id, cmd: 'flush', filename: label + '.zip' });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(acked, label + ': flush never acked');
  assert.strictEqual(acked.error, undefined, label + ': flush errored: ' + acked.error);
  assert.strictEqual(acked.count, 3, label + ': wrong file count');
  assert.ok(saved && saved.name === label + '.zip', label + ': no zip was saved');
}
await flush('zip32');

const dir = mkdtempSync(join(tmpdir(), 'afzip-'));

// `unzip -t` validates CRCs, offsets and the central directory. Python's
// zipfile then checks names+contents (macOS's Info-ZIP ignores the UTF-8 flag).
const expected = Object.fromEntries(files.map((f) => [f.name, f.body]));

async function verify(label) {
  const zipPath = join(dir, label + '.zip');
  writeFileSync(zipPath, Buffer.from(await saved.blob.arrayBuffer()));
  execFileSync('unzip', ['-t', zipPath], { stdio: 'pipe' });
  const got = execFileSync('python3', ['-c', `
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
print(json.dumps({i.filename: z.read(i).decode() for i in z.infolist()}))
`, zipPath], { encoding: 'utf8' }).trim();
  assert.deepStrictEqual(JSON.parse(got), expected, label + ': contents did not round-trip');
}

await verify('zip32');

// Same files again, but with the zip64 threshold dropped to 100 bytes so the
// 64-bit size/offset headers and the zip64 EOCD are actually exercised.
globalThis.window.__afCap.zip64Limit = 100;
for (const f of files) globalThis.window.__afCap.files.push({ name: f.name, blob: new Blob([f.body]) });
await flush('zip64');
await verify('zip64');
const z64 = readFileSync(join(dir, 'zip64.zip'));
assert.ok(z64.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])), 'zip64 EOCD record missing');
assert.ok(z64.includes(Buffer.from([0x50, 0x4b, 0x06, 0x07])), 'zip64 EOCD locator missing');

console.log('zip self-check passed: zip32 + zip64 archives, CRCs valid, UTF-8 names and contents round-trip');

// ---------------------------------------------------------------------------
// isDisabled — pulled straight out of inject.js so the check cannot drift from
// the implementation. Material's `disabledInteractive` buttons keep the
// `mat-mdc-button-disabled-interactive` class while ENABLED and signal their
// real state via aria-disabled; reading the class as "disabled" is what made
// the paginator look dead and stopped downloads after one page.
// ---------------------------------------------------------------------------
const injectSrc = readFileSync('inject.js', 'utf8');
const fnSrc = injectSrc.match(/const isDisabled = \(btn\) =>[\s\S]*?;\n/);
assert.ok(fnSrc, 'could not find isDisabled in inject.js');
const isDisabled = new Function('return ' + fnSrc[0].replace(/^const isDisabled = /, '').replace(/;\n$/, ''))();

const el = (classes, attrs = {}, disabled = false) => ({
  classList: { contains: (c) => classes.includes(c) },
  getAttribute: (n) => (n in attrs ? attrs[n] : null),
  disabled
});

const NEXT = ['mdc-icon-button', 'mat-mdc-icon-button', 'mat-mdc-paginator-navigation-next', 'mat-mdc-button-disabled-interactive'];
assert.strictEqual(isDisabled(el(NEXT, { 'aria-label': 'Next page' })), false,
  'live disabledInteractive arrow must read as ENABLED');
assert.strictEqual(isDisabled(el(NEXT, { 'aria-label': 'Next page', 'aria-disabled': 'true' })), true,
  'last-page disabledInteractive arrow must read as disabled');
assert.strictEqual(isDisabled(el(['mat-mdc-icon-button', 'mat-mdc-button-disabled'], {}, true)), true,
  'ordinary disabled button must read as disabled');
assert.strictEqual(isDisabled(el(['mat-mdc-icon-button'], { 'aria-label': 'Next page' })), false,
  'ordinary enabled button must read as enabled');

console.log('paginator self-check passed: disabledInteractive arrows are followed, real disabled ones are not');
