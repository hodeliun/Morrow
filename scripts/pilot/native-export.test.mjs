import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { strToU8, zipSync } from 'fflate';
import test from 'node:test';
import { copyEvidenceDurably } from './native-preparation.mjs';

import {
  finalizeSaveFileCapture,
  inspectInventoryHtml,
  inspectWebsiteZip,
  installPublicSaveFileCapture,
  extractWebsiteHtml,
  observeAndFinalizeCapture,
  retainWebsiteHtml,
  summarizeSaveFileCapture,
  waitForSaveFileCapture,
} from './native-export.mjs';

const RUNNER = fileURLToPath(new URL('./native-bank-smoke.mjs', import.meta.url));
const STATE_KEY = '__nativeExportTestCapture';
const FORMULA = 'Quantity * Price';
const FALLBACK = 'This export is read only. Stored values are shown as written; formula cells show their source.';

function fixtureHtml({ total = FORMULA, totalHeader = 'Total', includeFallback = true } = {}) {
  return `<!doctype html><html lang="en"><head><title>Inventory</title></head><body>
    ${includeFallback ? `<p class="provider-fallback">${FALLBACK}</p>` : ''}
    <p>Other exported text may include the values 20 and 30.</p>
    <div class="table"><table><tr><th>Name</th><th>Quantity</th><th>Price</th><th>${totalHeader}</th></tr>
      <tr><td><a href="widget.html">Widget</a></td><td>2</td><td>10</td><td>${total}</td></tr></table></div>
  </body></html>`;
}

function setupBridge({ ownDescriptor, prototypeDescriptor } = {}) {
  let originalCalls = 0;
  const original = function originalSaveFile() {
    originalCalls += 1;
    return Promise.resolve({ ok: true, path: '/must-not-open' });
  };
  const prototype = {};
  if (prototypeDescriptor) Object.defineProperty(prototype, 'saveFile', { ...prototypeDescriptor, value: original });
  const bridge = Object.create(prototype);
  if (ownDescriptor) Object.defineProperty(bridge, 'saveFile', { ...ownDescriptor, value: original });
  return { bridge, prototype, original, get originalCalls() { return originalCalls; } };
}

function install(bridge, stateTarget = {}) {
  installPublicSaveFileCapture(bridge, stateTarget, STATE_KEY);
  return stateTarget;
}

test('public sink capture copies the first ArrayBuffer, cancels it, cancels extras, and restores own flags', async () => {
  const setup = setupBridge({ ownDescriptor: { configurable: true, enumerable: false, writable: true } });
  const originalDescriptor = Object.getOwnPropertyDescriptor(setup.bridge, 'saveFile');
  const stateTarget = install(setup.bridge);
  const bytes = Uint8Array.from([0, 1, 2, 3, 254, 255]);

  assert.deepEqual(await setup.bridge.saveFile('site-website.zip', bytes.slice().buffer), { ok: false, error: null });
  assert.deepEqual(await setup.bridge.saveFile('late-website.zip', new ArrayBuffer(1)), { ok: false, error: null });
  const state = summarizeSaveFileCapture(stateTarget[STATE_KEY]);
  assert.equal(state.invocationCount, 2);
  assert.equal(state.extraCalls, 1);
  assert.equal(state.invalidCalls, 0);
  assert.equal(state.capture.name, 'site-website.zip');
  assert.equal(state.capture.byteLength, bytes.byteLength);
  assert.deepEqual(Buffer.from(state.capture.bytesBase64, 'base64'), Buffer.from(bytes));
  assert.equal(setup.originalCalls, 0);

  const finalized = finalizeSaveFileCapture(setup.bridge, stateTarget, STATE_KEY, false);
  assert.equal(finalized.restoreStatus, 'restored-original-descriptor');
  assert.deepEqual(Object.getOwnPropertyDescriptor(setup.bridge, 'saveFile'), originalDescriptor);
  assert.equal(setup.originalCalls, 0);
});

test('prototype-backed sink is shadowed temporarily and deletion reveals the original prototype method', async () => {
  const setup = setupBridge({
    prototypeDescriptor: { configurable: true, enumerable: false, writable: false },
  });
  const stateTarget = install(setup.bridge);
  assert.notEqual(Object.getOwnPropertyDescriptor(setup.bridge, 'saveFile'), undefined);
  assert.deepEqual(await setup.bridge.saveFile('site-website.zip', Uint8Array.from([9]).buffer), { ok: false, error: null });
  assert.equal(finalizeSaveFileCapture(setup.bridge, stateTarget, STATE_KEY, false).restoreStatus, 'restored-original-descriptor');
  assert.equal(Object.hasOwn(setup.bridge, 'saveFile'), false);
  assert.equal(setup.bridge.saveFile, setup.original);
  assert.equal(Object.getOwnPropertyDescriptor(setup.prototype, 'saveFile').writable, false);
  assert.equal(setup.originalCalls, 0);
});

test('unpatchable descriptors and accessors fail before an export action can run', () => {
  const immutable = setupBridge({ ownDescriptor: { configurable: false, enumerable: true, writable: false } });
  assert.throws(() => install(immutable.bridge), /cannot be patched safely/);
  assert.equal(immutable.bridge.saveFile, immutable.original);
  assert.equal(immutable.originalCalls, 0);

  const accessorBridge = {};
  Object.defineProperty(accessorBridge, 'saveFile', { configurable: true, get() { return () => undefined; } });
  assert.throws(() => installPublicSaveFileCapture(accessorBridge, {}, STATE_KEY), /accessor-backed/);
});

test('reentrant and extra sink calls are counted and cancelled without invoking the captured original', async () => {
  const setup = setupBridge({ ownDescriptor: { configurable: true, enumerable: true, writable: true } });
  const stateTarget = install(setup.bridge);
  const nativeBtoa = globalThis.btoa;
  let reentered = false;
  globalThis.btoa = (binary) => {
    if (!reentered) {
      reentered = true;
      void setup.bridge.saveFile('reentrant.zip', new ArrayBuffer(1));
    }
    return nativeBtoa(binary);
  };
  try {
    assert.deepEqual(await setup.bridge.saveFile('site-website.zip', Uint8Array.from([5, 6]).buffer), { ok: false, error: null });
  } finally {
    globalThis.btoa = nativeBtoa;
  }
  const state = summarizeSaveFileCapture(stateTarget[STATE_KEY]);
  assert.equal(state.invocationCount, 2);
  assert.equal(state.reentrantCalls, 1);
  assert.equal(state.extraCalls, 1);
  assert.equal(state.capture.byteLength, 2);
  assert.equal(setup.originalCalls, 0);
  finalizeSaveFileCapture(setup.bridge, stateTarget, STATE_KEY, false);
});

test('absolute capture watchdog bounds a never-resolving WebView read and keeps the canceller for late sink calls', async () => {
  const setup = setupBridge({ ownDescriptor: { configurable: true, enumerable: true, writable: true } });
  const stateTarget = install(setup.bridge);
  const outcome = await Promise.race([
    waitForSaveFileCapture(() => new Promise(() => {}), { timeoutMs: 10, intervalMs: 1 }).then(
      () => ({ kind: 'resolved' }),
      (error) => ({ kind: 'watchdog', error }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ kind: 'outer-timeout' }), 80)),
  ]);
  assert.equal(outcome.kind, 'watchdog');
  assert.equal(outcome.error.watchdogExpired, true);
  assert.match(outcome.error.message, /Timed out/);

  const finalized = finalizeSaveFileCapture(setup.bridge, stateTarget, STATE_KEY, true, true);
  assert.equal(finalized.deferredRestore, true);
  assert.equal(finalized.watchdogExpired, true);
  assert.equal(finalized.restoreStatus, 'deferred-until-isolated-app-teardown');
  assert.notEqual(setup.bridge.saveFile, setup.original);
  assert.deepEqual(await setup.bridge.saveFile('late-website.zip', Uint8Array.from([7]).buffer), { ok: false, error: null });
  assert.equal(summarizeSaveFileCapture(stateTarget[STATE_KEY]).capture.name, 'late-website.zip');
  assert.equal(setup.originalCalls, 0);
});

test('post-publish cleanup bounds a never-resolving observation and does not finalize or restore without state', async () => {
  let finalizeCalls = 0;
  const outcome = await Promise.race([
    observeAndFinalizeCapture(
      () => new Promise(() => {}),
      async () => { finalizeCalls += 1; return { restoreStatus: 'should-not-run' }; },
      performance.now() + 10,
    ).then(() => ({ kind: 'resolved' }), (error) => ({ kind: 'watchdog', error })),
    new Promise((resolve) => setTimeout(() => resolve({ kind: 'outer-timeout' }), 80)),
  ]);
  assert.equal(outcome.kind, 'watchdog');
  assert.equal(outcome.error.watchdogExpired, true);
  assert.match(outcome.error.message, /cleanup observation/);
  assert.equal(finalizeCalls, 0);
});

test('post-publish cleanup bounds a never-resolving finalizer and preserves the observed capture for failure evidence', async () => {
  const observed = { capture: { name: 'site-website.zip', byteLength: 1 } };
  await assert.rejects(
    observeAndFinalizeCapture(
      async () => observed,
      () => new Promise(() => {}),
      performance.now() + 10,
    ),
    (error) => error.watchdogExpired === true && error.captureState === observed && /cleanup finalization/.test(error.message),
  );
});

test('conditional restore preserves a descriptor installed by another runtime owner', () => {
  const setup = setupBridge({ ownDescriptor: { configurable: true, enumerable: true, writable: true } });
  const stateTarget = install(setup.bridge);
  const replacement = () => 'other owner';
  Object.defineProperty(setup.bridge, 'saveFile', { configurable: true, enumerable: true, writable: true, value: replacement });
  const state = finalizeSaveFileCapture(setup.bridge, stateTarget, STATE_KEY, false);
  assert.equal(state.restoreStatus, 'skipped-current-descriptor-changed');
  assert.equal(setup.bridge.saveFile, replacement);
  assert.equal(setup.originalCalls, 0);
});

test('serialized WebView installer and finalizer have no hidden module-scope dependencies', async () => {
  const setup = setupBridge({ ownDescriptor: { configurable: true, enumerable: true, writable: true } });
  const stateTarget = {};
  const context = {
    bridge: setup.bridge,
    stateTarget,
    stateKey: STATE_KEY,
    ArrayBuffer,
    Uint8Array,
    Promise,
    Reflect,
    Object,
    Date,
    btoa,
  };
  runInNewContext(`(${installPublicSaveFileCapture.toString()})(bridge, stateTarget, stateKey)`, context);
  const cancelled = await setup.bridge.saveFile('site-website.zip', Uint8Array.from([10, 11]).buffer);
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error, null);
  const summary = runInNewContext(`(${finalizeSaveFileCapture.toString()})(bridge, stateTarget, stateKey, false)`, context);
  assert.equal(summary.restoreStatus, 'restored-original-descriptor');
  assert.equal(summary.capture.byteLength, 2);
  assert.equal(setup.originalCalls, 0);
});

test('offline HTML parser finds the Total cell by headers and accepts only the literal formula there', () => {
  const parsed = inspectInventoryHtml(fixtureHtml(), 'Morrow/Inventory.html');
  assert.deepEqual(parsed.inventoryTable, {
    headers: ['Name', 'Quantity', 'Price', 'Total'],
    quantity: '2',
    price: '10',
    total: FORMULA,
  });
  assert.match(parsed.fallbackText, /read only/);
  assert.equal(parsed.interactiveControlCount, 0);
});

test('offline HTML parser rejects a wrong header and computed Total cell values without banning other 20/30 text', () => {
  assert.throws(() => inspectInventoryHtml(fixtureHtml({ totalHeader: 'Amount' })), /expected one Inventory table/);
  assert.throws(() => inspectInventoryHtml(fixtureHtml({ total: '20' })), /Total cell must contain only the literal formula/);
  assert.throws(() => inspectInventoryHtml(fixtureHtml({ total: '30' })), /Total cell must contain only the literal formula/);
  assert.doesNotThrow(() => inspectInventoryHtml(fixtureHtml({ total: FORMULA })));
  assert.throws(() => inspectInventoryHtml(fixtureHtml({ includeFallback: false })), /missing the provider's read-only export fallback note/);
});

test('ZIP inventory inspection hashes real HTML entries and resolves Inventory by filename', () => {
  const html = strToU8(fixtureHtml());
  const zip = zipSync({ 'Morrow/Inventory.html': html, 'Morrow/Widget.html': strToU8('<html><body>Widget</body></html>') });
  const inspected = inspectWebsiteZip(zip);
  assert.equal(inspected.htmlInventory.length, 2);
  assert.ok(inspected.htmlInventory.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)));
  assert.equal(inspected.inventory.filename, 'Morrow/Inventory.html');
  assert.equal(inspected.inventory.inventoryTable.total, FORMULA);
});

test('common durable retention copies the real ZIP and every extracted HTML file with their hashes', async () => {
  const root = await mkdtemp(path.join(process.cwd(), '.e182-retention-test-'));
  const evidence = path.join(root, 'evidence');
  const retainedEvidence = path.join(root, 'retained');
  try {
    await mkdir(evidence);
    const html = strToU8(fixtureHtml());
    const zip = zipSync({ 'Morrow/Inventory.html': html, 'Morrow/Widget.html': strToU8('<html>Widget</html>') });
    const zipPath = path.join(evidence, 'native-export-website.zip');
    await writeFile(zipPath, zip);
    const extracted = extractWebsiteHtml(zip);
    await retainWebsiteHtml({ evidence }, extracted);

    const retained = await copyEvidenceDurably({ sourceDirectory: evidence, destinationDirectory: retainedEvidence });
    const retainedPaths = retained.files.map((entry) => entry.path).sort();
    assert.deepEqual(retainedPaths, [
      'native-export-html/Morrow/Inventory.html',
      'native-export-html/Morrow/Widget.html',
      'native-export-website.zip',
    ]);
    for (const entry of retained.files) {
      const bytes = await readFile(path.join(retainedEvidence, entry.path));
      assert.equal(bytes.byteLength, entry.bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
    }
    const inventory = await readFile(path.join(retainedEvidence, 'native-export-html/Morrow/Inventory.html'), 'utf8');
    assert.equal(inventory, Buffer.from(html).toString('utf8'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native runner exposes the own export scenario and rejects unknown dispatch before candidate preflight', () => {
  const help = spawnSync(process.execPath, [RUNNER, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /picker\|picker-independent\|export\|app-identity-only/);

  const unknown = spawnSync(process.execPath, [RUNNER, '--check-only', '--scenario', 'unknown-export'], { encoding: 'utf8' });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown fixed scenario unknown-export/);
  assert.match(unknown.stderr, /picker-independent, export, app-identity-only/);
  assert.doesNotMatch(unknown.stdout, /outputPaths/);

  const validButIncomplete = spawnSync(process.execPath, [RUNNER, '--check-only', '--scenario', 'export'], { encoding: 'utf8' });
  assert.equal(validButIncomplete.status, 1);
  assert.match(validButIncomplete.stderr, /Missing --expected-commit/);
  assert.doesNotMatch(validButIncomplete.stderr, /Unknown fixed scenario/);
  assert.doesNotMatch(validButIncomplete.stdout, /outputPaths/);
});
