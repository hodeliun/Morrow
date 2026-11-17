import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertOwnedNaturalCloseReceiptContract,
  captureNativeCloseMarkdownFiles,
  CLOSE_MARKDOWN_PATHS,
  CLOSE_RECEIPT_SCHEMA,
  CLOSE_RECEIPT_VERSION,
  withSyntheticMarkdownParentWriteDenied,
} from './native-close.mjs';

const FORMULA = 'formula: Quantity * Price\n';
const INITIAL_WIDGET = 'Name: Widget\nQuantity: 2\nPrice: 10\n';
const SAVED_WIDGET = 'Name: Widget\nQuantity: 3\nPrice: 10\n';
const VIEWS = 'view: Inventory\n';

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function identity(overrides = {}) {
  return {
    pid: 41_002,
    startTimeTicks: '7712300',
    effectiveUid: process.geteuid(),
    executablePathSha256: '1'.repeat(64),
    argvSha256: '2'.repeat(64),
    driverPid: 41_001,
    runtimeIdentityConfirmed: true,
    ...overrides,
  };
}

async function makeVault(t) {
  const vault = await mkdtemp(path.join(os.tmpdir(), 'morrow-native-close-'));
  t.after(async () => rm(vault, { recursive: true, force: true }));
  await mkdir(path.join(vault, 'Inventory'));
  await writeFile(path.join(vault, 'Inventory.md'), FORMULA, { mode: 0o640 });
  await writeFile(path.join(vault, 'Inventory', 'Widget.md'), INITIAL_WIDGET, { mode: 0o604 });
  await writeFile(path.join(vault, 'Views.md'), VIEWS, { mode: 0o600 });
  await chmod(path.join(vault, 'Inventory'), 0o750);
  await chmod(path.join(vault, 'Inventory.md'), 0o640);
  await chmod(path.join(vault, 'Inventory', 'Widget.md'), 0o604);
  await chmod(path.join(vault, 'Views.md'), 0o600);
  return vault;
}

function sameFileState(left, right) {
  for (const relative of CLOSE_MARKDOWN_PATHS) {
    assert.deepEqual(left[relative], right[relative], `${relative} snapshot`);
  }
}

function quantity3Snapshot(initialSnapshot) {
  const bytes = Buffer.from(SAVED_WIDGET);
  return {
    sha256: hash(bytes),
    size: bytes.length,
    mtimeMs: initialSnapshot.mtimeMs + 1,
    mode: initialSnapshot.mode,
    quantity: 3,
  };
}

function copySet(files) {
  return Object.fromEntries(CLOSE_MARKDOWN_PATHS.map((relative) => {
    const snapshot = { ...files[relative] };
    if (relative !== 'Inventory/Widget.md') delete snapshot.quantity;
    return [relative, snapshot];
  }));
}

function makeValidReceipt(initial) {
  const q3 = quantity3Snapshot(initial['Inventory/Widget.md']);
  const files = copySet(initial);
  const finalFiles = copySet({ ...files, 'Inventory/Widget.md': q3 });
  const app = identity();
  const uiSample = (phase, monotonicMs) => ({
    phase,
    monotonicMs,
    processBefore: app,
    processAfter: app,
    ui: { cellQuantity: '3', retryVisible: true, errorVisible: true },
    fileState: copySet(files),
  });
  const retryArmed = {
    phase: 'retry-armed',
    monotonicMs: 7005,
    processBefore: app,
    processAfter: app,
    ui: null,
    fileState: copySet(files),
  };
  const savedAndExited = {
    phase: 'retry-monitor',
    monotonicMs: 7100,
    processBefore: null,
    processAfter: null,
    ui: null,
    fileState: copySet(finalFiles),
  };
  const receipt = {
    schema: CLOSE_RECEIPT_SCHEMA,
    version: CLOSE_RECEIPT_VERSION,
    outcome: 'owned-natural-close',
    identity: app,
    mode: {
      directoryRelative: 'Inventory',
      targetFileRelative: 'Inventory/Widget.md',
      before: 0o750,
      blocked: 0o550,
      restored: 0o750,
      targetFileModeBefore: 0o604,
    },
    events: {
      failedSaveClickAtMs: 100,
      firstCloseClickIssuedAtMs: 120,
      firstCloseResolvedAtMs: 130,
      deniedHoldMs: 6500,
      observerStartedAtMs: 7000,
      retryClickIssuedAtMs: 7010,
      quantity3ObservedAtMs: 7100,
      processAbsentAtMs: 7100,
    },
    deniedClose: {
      selector: '.window-control.is-close',
      elementId: 'close-button-1',
      clickCount: 1,
      clickResult: 'resolved',
    },
    failedSave: {
      selector: '[data-provider="polaris-dados"] button[data-action="save"]',
      elementId: 'save-button-1',
      clickCount: 1,
      clickResult: 'resolved',
      errorText: 'Could not save changes. Permission denied (os error 13).',
    },
    retry: {
      selector: '.window-control.is-close',
      elementId: 'close-button-1',
      sameElement: true,
      clickCount: 1,
      clickResult: {
        kind: 'webdriver-error-after-dispatch',
        requestIssued: true,
        name: 'WebDriverError',
        message: 'Session ended after the native close completed.',
      },
    },
    files: {
      initial: copySet(files),
      afterSaveFailure: copySet(files),
      afterDeniedClose: copySet(files),
      quantity3Sample: copySet(finalFiles),
      finalBeforeCleanup: copySet(finalFiles),
    },
    samples: [
      uiSample('after-save-failure', 110),
      uiSample('denied-close-final', 6700),
      retryArmed,
      savedAndExited,
    ],
  };
  return receipt;
}

test('captures exact bytes, modes and Quantity from the canonical three-file synthetic vault', async (t) => {
  const vault = await makeVault(t);
  const snapshot = await captureNativeCloseMarkdownFiles(vault);
  assert.deepEqual(Object.keys(snapshot).sort(), [...CLOSE_MARKDOWN_PATHS].sort());
  assert.equal(snapshot['Inventory.md'].sha256, hash(Buffer.from(FORMULA)));
  assert.equal(snapshot['Inventory.md'].mode, 0o640);
  assert.equal(snapshot['Inventory/Widget.md'].quantity, 2);
  assert.equal(snapshot['Inventory/Widget.md'].mode, 0o604);
  assert.equal(snapshot['Views.md'].quantity, null);
  assert.equal(snapshot['Views.md'].mode, 0o600);
});

test('removes write bits only from the Markdown parent and restores its exact mode', async (t) => {
  const vault = await makeVault(t);
  const before = await captureNativeCloseMarkdownFiles(vault);
  const result = await withSyntheticMarkdownParentWriteDenied(
    { vault },
    identity(),
    async ({ mode, parent, target }) => {
      assert.equal(mode.before, 0o750);
      assert.equal(mode.blocked, 0o550);
      assert.equal(mode.targetFileModeBefore, 0o604);
      assert.equal((await lstat(parent)).mode & 0o7777, 0o550);
      assert.equal((await lstat(target)).mode & 0o7777, 0o604);
      await assert.rejects(
        writeFile(path.join(parent, 'probe.tmp'), 'must be denied'),
        (error) => ['EACCES', 'EPERM'].includes(error.code),
      );
      sameFileState(before, await captureNativeCloseMarkdownFiles(vault));
      return 'denied';
    },
  );
  assert.equal(result.result, 'denied');
  assert.equal(result.mode.restored, 0o750);
  assert.equal((await lstat(path.join(vault, 'Inventory'))).mode & 0o7777, 0o750);
  assert.equal((await lstat(path.join(vault, 'Inventory/Widget.md'))).mode & 0o7777, 0o604);
  sameFileState(before, await captureNativeCloseMarkdownFiles(vault));
});

test('restores exact directory mode after callback failure and preserves the original error', async (t) => {
  const vault = await makeVault(t);
  const original = new Error('synthetic callback failure');
  await assert.rejects(
    withSyntheticMarkdownParentWriteDenied({ vault }, identity(), async () => { throw original; }),
    (error) => error === original && error.cleanupError === undefined,
  );
  assert.equal((await lstat(path.join(vault, 'Inventory'))).mode & 0o7777, 0o750);
  assert.equal((await lstat(path.join(vault, 'Inventory/Widget.md'))).mode & 0o7777, 0o604);
});

test('refuses root identity and symlinked synthetic vault roots before chmod', async (t) => {
  const vault = await makeVault(t);
  const alias = path.join(os.tmpdir(), `morrow-native-close-alias-${process.pid}-${Date.now()}`);
  await symlink(vault, alias);
  t.after(async () => rm(alias, { force: true }));
  await assert.rejects(captureNativeCloseMarkdownFiles(alias), /canonical synthetic vault/);
  await assert.rejects(
    withSyntheticMarkdownParentWriteDenied({ vault }, identity({ effectiveUid: 0 }), async () => undefined),
    /non-root effective UID/,
  );
  assert.equal((await lstat(path.join(vault, 'Inventory'))).mode & 0o7777, 0o750);
});

test('accepts a WebDriver response error only with same identity, denied hold, exact snapshots, Q3 and natural exit', async (t) => {
  const vault = await makeVault(t);
  const initial = await captureNativeCloseMarkdownFiles(vault);
  const receipt = makeValidReceipt(initial);
  assert.equal(assertOwnedNaturalCloseReceiptContract(receipt, receipt.identity), true);

  const differentIdentity = { ...receipt.identity, startTimeTicks: '7712301' };
  assert.throws(() => assertOwnedNaturalCloseReceiptContract(receipt, differentIdentity), /identity differs/);

  const shortHold = structuredClone(receipt);
  shortHold.events.deniedHoldMs = 6499;
  assert.throws(() => assertOwnedNaturalCloseReceiptContract(shortHold, receipt.identity), /kept open/);

  const changedTargetMode = structuredClone(receipt);
  changedTargetMode.mode.targetFileModeBefore = 0o600;
  assert.throws(() => assertOwnedNaturalCloseReceiptContract(changedTargetMode, receipt.identity), /target Markdown file mode/);

  const noPreClickIdentity = structuredClone(receipt);
  noPreClickIdentity.samples.find((sample) => sample.phase === 'retry-armed').processAfter = null;
  assert.throws(() => assertOwnedNaturalCloseReceiptContract(noPreClickIdentity, receipt.identity), /immediately before Close retry/);

  const genericSessionFailure = structuredClone(receipt);
  genericSessionFailure.retry.clickResult.requestIssued = false;
  assert.throws(() => assertOwnedNaturalCloseReceiptContract(genericSessionFailure, receipt.identity), /cannot prove the retry click/);

  const alteredCompanion = structuredClone(receipt);
  alteredCompanion.files.finalBeforeCleanup['Views.md'].sha256 = 'a'.repeat(64);
  assert.throws(() => assertOwnedNaturalCloseReceiptContract(alteredCompanion, receipt.identity), /Views\.md changed/);
});
