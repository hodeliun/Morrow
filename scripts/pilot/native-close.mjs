// Native close refusal/retry proof for the synthetic Polaris Dados pilot.
// This scenario changes only the synthetic Markdown parent directory mode;
// the product, host bridge, and close protocol are never patched.
import { createHash } from 'node:crypto';
import { chmod, lstat, open as openFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const CLOSE_RECEIPT_SCHEMA = 'morrow.native-close.receipt';
export const CLOSE_RECEIPT_VERSION = 1;
export const CLOSE_BUTTON_SELECTOR = '.window-control.is-close';
export const CLOSE_MARKDOWN_PATHS = ['Inventory.md', 'Inventory/Widget.md', 'Views.md'];

const PROVIDER_SELECTOR = '[data-provider="polaris-dados"]';
const QUANTITY_INPUT = `${PROVIDER_SELECTOR} input[type="number"][data-field="quantity"]`;
const QUANTITY_EDIT = `${PROVIDER_SELECTOR} button[data-action="edit"][data-field="quantity"]`;
const QUANTITY_SAVE = `${PROVIDER_SELECTOR} button[data-action="save"]`;
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
const EXIT_WAIT_MS = 25_000;
const POLL_INTERVAL_MS = 50;
const DENIED_CLOSE_HOLD_MS = 6_500;
const MODE_RESTORE_TIMEOUT_MS = 5_000;
const FILE_STATE_KEYS = ['sha256', 'size', 'mtimeMs', 'mode'];
const IDENTITY_KEYS = [
  'pid',
  'startTimeTicks',
  'effectiveUid',
  'executablePathSha256',
  'argvSha256',
  'driverPid',
  'runtimeIdentityConfirmed',
];

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function monotonicMs(origin) {
  return performance.now() - origin;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function sameIdentity(actual, expected) {
  return Boolean(actual && expected && IDENTITY_KEYS.every((key) => actual[key] === expected[key]));
}

function assertIdentityShape(identity, label = 'owned app identity') {
  if (!identity || typeof identity !== 'object') fail(`${label} is missing.`);
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) fail(`${label} has an invalid PID.`);
  if (!/^\d+$/.test(String(identity.startTimeTicks ?? ''))) fail(`${label} has an invalid /proc starttime.`);
  if (!Number.isInteger(identity.effectiveUid) || identity.effectiveUid <= 0) {
    fail(`${label} must have a non-root effective UID.`);
  }
  if (!/^[a-f0-9]{64}$/i.test(identity.executablePathSha256 ?? '')) {
    fail(`${label} has no executable-path digest.`);
  }
  if (!/^[a-f0-9]{64}$/i.test(identity.argvSha256 ?? '')) fail(`${label} has no argv digest.`);
  if (!Number.isSafeInteger(identity.driverPid) || identity.driverPid <= 0) {
    fail(`${label} has an invalid owning driver PID.`);
  }
  if (identity.runtimeIdentityConfirmed !== true) fail(`${label} has no confirmed isolated runtime identity.`);
  return identity;
}

function isSnapshot(value, relative) {
  const quantityValid = relative === 'Inventory/Widget.md'
    ? Number.isFinite(value?.quantity)
    : value?.quantity === undefined || value?.quantity === null;
  return Boolean(
    value &&
      typeof value === 'object' &&
      /^[a-f0-9]{64}$/i.test(value.sha256 ?? '') &&
      Number.isSafeInteger(value.size) &&
      value.size >= 0 &&
      Number.isFinite(value.mtimeMs) &&
      Number.isInteger(value.mode) &&
      value.mode >= 0 &&
      value.mode <= 0o7777 &&
      quantityValid,
  );
}

function assertMarkdownSet(value, label) {
  if (!value || typeof value !== 'object') fail(`${label} is missing.`);
  for (const relative of CLOSE_MARKDOWN_PATHS) {
    if (!isSnapshot(value[relative], relative)) fail(`${label} has an invalid snapshot for ${relative}.`);
  }
}

function sameSnapshot(left, right) {
  return Boolean(left && right && FILE_STATE_KEYS.every((key) => left[key] === right[key]));
}

function assertSameMarkdownSet(left, right, label) {
  assertMarkdownSet(left, `${label} left`);
  assertMarkdownSet(right, `${label} right`);
  for (const relative of CLOSE_MARKDOWN_PATHS) {
    if (!sameSnapshot(left[relative], right[relative])) fail(`${label}: ${relative} changed.`);
  }
}

function assertQuantity(snapshot, expected, label) {
  if (snapshot['Inventory/Widget.md']?.quantity !== expected) {
    fail(`${label}: expected persisted Quantity=${expected}, got ${snapshot['Inventory/Widget.md']?.quantity ?? '<missing>'}.`);
  }
}

function assertOriginalCompanionFiles(initial, current, label) {
  for (const relative of ['Inventory.md', 'Views.md']) {
    if (!sameSnapshot(initial[relative], current[relative])) fail(`${label}: ${relative} changed unexpectedly.`);
  }
}

function isExactTimestamp(value) {
  return Number.isFinite(value) && value >= 0;
}

export function assertOwnedNaturalCloseReceiptContract(receipt, expectedIdentity) {
  assertIdentityShape(expectedIdentity, 'expected app identity');
  if (!receipt || typeof receipt !== 'object') fail('Native close callback did not return a receipt.');
  if (receipt.schema !== CLOSE_RECEIPT_SCHEMA || receipt.version !== CLOSE_RECEIPT_VERSION) {
    fail('Native close receipt schema/version is unsupported.');
  }
  if (receipt.outcome !== 'owned-natural-close') fail('Native close receipt does not prove an owned natural close.');
  if (!sameIdentity(receipt.identity, expectedIdentity)) fail('Native close receipt identity differs from the runtime-verified app.');

  const mode = receipt.mode;
  if (!mode || mode.directoryRelative !== 'Inventory' || mode.targetFileRelative !== 'Inventory/Widget.md') {
    fail('Native close receipt does not identify the Markdown parent directory.');
  }
  for (const key of ['before', 'blocked', 'restored', 'targetFileModeBefore']) {
    if (!Number.isInteger(mode[key]) || mode[key] < 0 || mode[key] > 0o7777) fail(`Native close receipt has invalid mode.${key}.`);
  }
  if ((mode.before & 0o222) === 0) fail('Native close receipt did not start with write permission enabled.');
  if (mode.blocked !== (mode.before & ~0o222)) fail('Native close receipt did not remove only the parent directory write bits.');
  if ((mode.blocked & 0o555) !== (mode.before & 0o555)) fail('Native close receipt changed parent directory read/execute bits.');
  if (mode.restored !== mode.before) fail('Native close receipt did not restore the exact parent directory mode.');

  const events = receipt.events;
  const eventKeys = [
    'failedSaveClickAtMs',
    'firstCloseClickIssuedAtMs',
    'firstCloseResolvedAtMs',
    'deniedHoldMs',
    'observerStartedAtMs',
    'retryClickIssuedAtMs',
    'quantity3ObservedAtMs',
    'processAbsentAtMs',
  ];
  if (!events || eventKeys.some((key) => !isExactTimestamp(events[key]))) {
    fail('Native close receipt has incomplete monotonic event times.');
  }
  if (events.firstCloseClickIssuedAtMs < events.failedSaveClickAtMs) fail('Initial Close preceded the failed Save attempt.');
  if (events.firstCloseResolvedAtMs < events.firstCloseClickIssuedAtMs) fail('Initial Close resolution preceded its click.');
  if (events.deniedHoldMs < DENIED_CLOSE_HOLD_MS) fail('Failed Close was not kept open beyond the previous 5 second limit.');
  if (events.retryClickIssuedAtMs - events.firstCloseResolvedAtMs < events.deniedHoldMs) {
    fail('Retry Close was issued before the recorded denied-close hold elapsed.');
  }
  if (events.observerStartedAtMs >= events.retryClickIssuedAtMs) fail('Retry observer was not armed before the retry click.');
  if (events.quantity3ObservedAtMs < events.retryClickIssuedAtMs) fail('Quantity=3 appeared before the retry Close attempt.');
  if (events.processAbsentAtMs < events.retryClickIssuedAtMs) fail('Owned app process disappeared before the retry Close attempt.');

  const firstClose = receipt.deniedClose;
  const failedSave = receipt.failedSave;
  const retry = receipt.retry;
  if (
    !failedSave ||
    failedSave.selector !== QUANTITY_SAVE ||
    failedSave.clickCount !== 1 ||
    failedSave.clickResult !== 'resolved' ||
    typeof failedSave.errorText !== 'string' ||
    !/(permission denied|os error 13|eacces)/i.test(failedSave.errorText)
  ) {
    fail('Receipt does not prove a resolved W3C Save click with the real parent-directory permission error.');
  }
  if (!firstClose || firstClose.selector !== CLOSE_BUTTON_SELECTOR || firstClose.clickCount !== 1 || firstClose.clickResult !== 'resolved') {
    fail('Receipt does not prove one successful W3C click of the real Close button during the denied attempt.');
  }
  if (!retry || retry.selector !== CLOSE_BUTTON_SELECTOR || retry.sameElement !== true || retry.clickCount !== 1) {
    fail('Receipt does not prove one retry through the same real Close button.');
  }
  if (typeof firstClose.elementId !== 'string' || firstClose.elementId.length === 0 || retry.elementId !== firstClose.elementId) {
    fail('Close retry did not use the original WebDriver element identity.');
  }
  if (!retry.clickResult || !['resolved', 'webdriver-error-after-dispatch', 'pending-at-process-exit'].includes(retry.clickResult.kind)) {
    fail('Receipt has an invalid retry click result.');
  }
  if (retry.clickResult.kind !== 'resolved' && retry.clickResult.requestIssued !== true) {
    fail('A failed WebDriver response cannot prove the retry click was issued.');
  }

  const files = receipt.files;
  if (!files) fail('Native close receipt has no Markdown snapshots.');
  for (const label of ['initial', 'afterSaveFailure', 'afterDeniedClose', 'quantity3Sample', 'finalBeforeCleanup']) {
    assertMarkdownSet(files[label], `files.${label}`);
  }
  assertQuantity(files.initial, 2, 'Initial synthetic row');
  assertQuantity(files.afterSaveFailure, 2, 'After failed Save');
  assertQuantity(files.afterDeniedClose, 2, 'After denied Close');
  assertSameMarkdownSet(files.initial, files.afterSaveFailure, 'Failed Save must preserve all three Markdown files');
  assertSameMarkdownSet(files.initial, files.afterDeniedClose, 'Denied Close must preserve all three Markdown files');
  assertQuantity(files.quantity3Sample, 3, 'Retry observer');
  assertQuantity(files.finalBeforeCleanup, 3, 'Final pre-cleanup content');
  for (const label of ['initial', 'afterSaveFailure', 'afterDeniedClose', 'quantity3Sample', 'finalBeforeCleanup']) {
    if (files[label]['Inventory/Widget.md'].mode !== mode.targetFileModeBefore) {
      fail(`Native close receipt changed the target Markdown file mode in ${label}.`);
    }
  }
  assertOriginalCompanionFiles(files.initial, files.quantity3Sample, 'Quantity retry sample');
  assertOriginalCompanionFiles(files.initial, files.finalBeforeCleanup, 'Final pre-cleanup content');

  if (!Array.isArray(receipt.samples) || receipt.samples.length < 3) fail('Native close receipt lacks passive PID/filesystem samples.');
  const expectedSample = (sample) =>
    sample &&
    isExactTimestamp(sample.monotonicMs) &&
    (sample.processBefore === null || sameIdentity(sample.processBefore, expectedIdentity)) &&
    (sample.processAfter === null || sameIdentity(sample.processAfter, expectedIdentity)) &&
    sample.fileState &&
    CLOSE_MARKDOWN_PATHS.every((relative) => isSnapshot(sample.fileState[relative], relative));
  if (receipt.samples.some((sample) => !expectedSample(sample))) fail('Native close receipt contains an invalid passive observation sample.');

  const deniedHoldSample = receipt.samples.find((sample) => sample.phase === 'denied-close-final');
  if (
    !deniedHoldSample ||
    !sameIdentity(deniedHoldSample.processBefore, expectedIdentity) ||
    !sameIdentity(deniedHoldSample.processAfter, expectedIdentity) ||
    deniedHoldSample.ui?.cellQuantity !== '3' ||
    deniedHoldSample.ui?.retryVisible !== true ||
    deniedHoldSample.ui?.errorVisible !== true
  ) {
    fail('Denied Close hold does not prove a live app with staged Quantity=3 and visible Retry/error UI.');
  }
  assertSameMarkdownSet(files.initial, deniedHoldSample.fileState, 'Denied Close hold sample');
  const failedSaveSample = receipt.samples.find((sample) => sample.phase === 'after-save-failure');
  if (
    !failedSaveSample ||
    !sameIdentity(failedSaveSample.processBefore, expectedIdentity) ||
    !sameIdentity(failedSaveSample.processAfter, expectedIdentity) ||
    failedSaveSample.ui?.cellQuantity !== '3' ||
    failedSaveSample.ui?.retryVisible !== true ||
    failedSaveSample.ui?.errorVisible !== true
  ) {
    fail('Failed Save sample does not prove a live app, staged Quantity=3, and visible Retry/error UI.');
  }
  assertSameMarkdownSet(files.initial, failedSaveSample.fileState, 'Failed Save sample');

  const retryArmedSample = receipt.samples.find(
    (sample) => sample.phase === 'retry-armed' && sample.monotonicMs < events.retryClickIssuedAtMs,
  );
  if (
    !retryArmedSample ||
    !sameIdentity(retryArmedSample.processBefore, expectedIdentity) ||
    !sameIdentity(retryArmedSample.processAfter, expectedIdentity)
  ) {
    fail('Retry observer does not prove the exact app PID/starttime was live immediately before Close retry.');
  }
  assertQuantity(retryArmedSample.fileState, 2, 'Retry pre-click sample');

  const quantity3Sample = receipt.samples.find((sample) => sample.monotonicMs === events.quantity3ObservedAtMs);
  if (!quantity3Sample || !sameSnapshotSetOrFail(files.quantity3Sample, quantity3Sample.fileState, 'Q3 observation')) {
    fail('Quantity=3 receipt snapshot is not linked to a passive filesystem sample.');
  }
  const exitSample = receipt.samples.find(
    (sample) =>
      sample.monotonicMs === events.processAbsentAtMs &&
      sample.processBefore === null &&
      sample.processAfter === null,
  );
  if (!exitSample) fail('Receipt has no passive sample proving the owned PID/starttime absent before cleanup.');
  assertQuantity(exitSample.fileState, 3, 'Owned natural exit sample');
  if (!sameSnapshotSetOrFail(files.finalBeforeCleanup, exitSample.fileState, 'Final exit sample')) {
    fail('Final pre-cleanup Markdown snapshot is not linked to the natural exit sample.');
  }
  return true;
}

function sameSnapshotSetOrFail(left, right, label) {
  try {
    assertSameMarkdownSet(left, right, label);
    return true;
  } catch {
    return false;
  }
}

async function assertCanonicalSyntheticVault(vault) {
  if (typeof vault !== 'string' || !path.isAbsolute(vault)) fail('Close scenario requires an absolute synthetic vault path.');
  const root = path.resolve(vault);
  const tempRoot = await realpath(os.tmpdir());
  if (path.dirname(root) !== tempRoot || (await realpath(root)) !== root) {
    fail('Close scenario requires the canonical synthetic vault as a direct child of the temporary directory.');
  }
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail('Synthetic vault root is not a regular directory.');
  return root;
}

async function checkedSyntheticFile(root, relative, expectedKind) {
  const target = path.resolve(root, relative);
  const relativePath = path.relative(root, target);
  if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    fail(`Synthetic Markdown path escaped its vault: ${relative}`);
  }
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) fail(`Symlink in synthetic Markdown path: ${relative}`);
    const finalSegment = current === target;
    const expectedFinalType = expectedKind === 'directory' ? info.isDirectory() : info.isFile();
    if (finalSegment ? !expectedFinalType : !info.isDirectory()) {
      fail(`Unexpected filesystem type in synthetic Markdown path: ${relative}`);
    }
    if ((await realpath(current)) !== current) fail(`Non-canonical synthetic Markdown path: ${relative}`);
  }
  return target;
}

function quantityFromMarkdown(bytes, relative) {
  if (relative !== 'Inventory/Widget.md') return null;
  const text = Buffer.from(bytes).toString('utf8');
  const matches = [...text.matchAll(/^\s*Quantity\s*:\s*(-?\d+(?:\.\d+)?)\s*$/gim)];
  if (matches.length !== 1) fail('Synthetic Widget Markdown must contain exactly one Quantity field.');
  return Number(matches[0][1]);
}

export async function captureNativeCloseMarkdownFiles(vault) {
  const root = await assertCanonicalSyntheticVault(vault);
  const result = {};
  let schemaText = '';
  for (const relative of CLOSE_MARKDOWN_PATHS) {
    const file = await checkedSyntheticFile(root, relative, 'file');
    const handle = await openFile(file, 'r');
    try {
      const before = await handle.stat();
      if (!before.isFile()) fail(`Synthetic Markdown path is not a regular file: ${relative}`);
      const bytes = await handle.readFile();
      const after = await handle.stat();
      const current = await lstat(file);
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.mode !== after.mode ||
        current.dev !== after.dev ||
        current.ino !== after.ino ||
        after.size !== bytes.length ||
        (await realpath(file)) !== file
      ) {
        fail(`Synthetic Markdown changed while being observed: ${relative}`);
      }
      if (relative === 'Inventory.md') schemaText = bytes.toString('utf8');
      result[relative] = {
        sha256: sha256(bytes),
        size: bytes.length,
        mtimeMs: after.mtimeMs,
        mode: after.mode & 0o7777,
        quantity: quantityFromMarkdown(bytes, relative),
      };
    } finally {
      await handle.close();
    }
  }
  if (!/formula\s*:\s*Quantity\s*\*\s*Price/i.test(schemaText)) fail('Synthetic Inventory schema formula changed.');
  return result;
}

async function fileMode(file) {
  const info = await lstat(file);
  if (info.isSymbolicLink()) fail(`Refusing symlinked synthetic mode path: ${file}`);
  return info.mode & 0o7777;
}

async function restoreExactParentMode(parent, target, expectedDirectoryMode, expectedTargetMode) {
  return withTimeout((async () => {
    if ((await realpath(parent)) !== parent) fail('Refusing to restore a non-canonical synthetic Markdown parent.');
    const current = await lstat(parent);
    if (!current.isDirectory() || current.isSymbolicLink()) fail('Synthetic Markdown parent changed type before restoration.');
    await chmod(parent, expectedDirectoryMode);
    const restored = await fileMode(parent);
    if (restored !== expectedDirectoryMode) fail(`Synthetic Markdown parent mode restoration mismatch: ${restored.toString(8)}.`);
    const targetMode = await fileMode(target);
    if (targetMode !== expectedTargetMode) fail('The Markdown file mode changed during the directory permission probe.');
    return restored;
  })(), MODE_RESTORE_TIMEOUT_MS, 'exact synthetic Markdown directory mode restoration');
}

async function writeDeniedDirectory(candidate, identity) {
  assertIdentityShape(identity);
  if (typeof process.geteuid !== 'function') fail('Linux effective UID is unavailable for the directory permission probe.');
  const processUid = process.geteuid();
  if (processUid === 0 || identity.effectiveUid !== processUid) {
    fail('Directory permission probe requires the app and runner to share the same non-root effective UID.');
  }
  const root = await assertCanonicalSyntheticVault(candidate?.vault);
  const parent = await checkedSyntheticFile(root, 'Inventory', 'directory');
  const target = await checkedSyntheticFile(root, 'Inventory/Widget.md', 'file');
  const parentInfo = await lstat(parent);
  const targetInfo = await lstat(target);
  if (parentInfo.uid !== processUid || targetInfo.uid !== processUid) {
    fail('Synthetic Markdown parent and file must be owned by the non-root runner UID.');
  }
  const before = parentInfo.mode & 0o7777;
  const targetFileModeBefore = targetInfo.mode & 0o7777;
  if ((before & 0o222) === 0) fail('Synthetic Markdown parent already has no write bits; refusing a false fault injection.');
  const blocked = before & ~0o222;
  try {
    await chmod(parent, blocked);
    const actualBlocked = await fileMode(parent);
    if (actualBlocked !== blocked) {
      fail(`Synthetic Markdown parent mode did not become the requested write-denied mode: ${actualBlocked.toString(8)}.`);
    }
  } catch (error) {
    try {
      await restoreExactParentMode(parent, target, before, targetFileModeBefore);
    } catch (cleanupError) {
      if (typeof error === 'object' && error !== null) error.cleanupError = cleanupError;
    }
    throw error;
  }

  const mode = {
    directoryRelative: 'Inventory',
    targetFileRelative: 'Inventory/Widget.md',
    before,
    blocked,
    restored: null,
    targetFileModeBefore,
  };
  let actionError = null;
  let result;
  try {
    result = await candidate.action({ mode, parent, target });
  } catch (error) {
    actionError = error;
  }

  let restoreError = null;
  try {
    mode.restored = await restoreExactParentMode(parent, target, before, targetFileModeBefore);
  } catch (error) {
    restoreError = error;
  }
  if (actionError) {
    if (restoreError && typeof actionError === 'object' && actionError !== null) actionError.cleanupError = restoreError;
    throw actionError;
  }
  if (restoreError) throw restoreError;
  return { result, mode };
}

export async function withSyntheticMarkdownParentWriteDenied(candidate, identity, action) {
  if (typeof action !== 'function') fail('Directory permission probe requires an observation callback.');
  return writeDeniedDirectory({ ...candidate, action }, identity);
}

function summarizeFiles(files) {
  return Object.fromEntries(CLOSE_MARKDOWN_PATHS.map((relative) => [relative, { ...files[relative] }]));
}

async function readPluginUi(driver) {
  return driver.execute(`
    const roots = [...document.querySelectorAll('${PROVIDER_SELECTOR}')];
    const root = roots.length === 1 ? roots[0] : null;
    const editor = root?.querySelector('input[type="number"][data-field="quantity"]');
    const errors = [...(root?.querySelectorAll('[role="alert"][data-notice="error"]') ?? [])];
    const cell = root?.querySelector('td[data-field="quantity"] [data-value-kind="number"]');
    const retry = root?.querySelector('[data-action="retry"]');
    return {
      providerCount: roots.length,
      draftQuantity: editor?.value ?? null,
      cellQuantity: cell?.textContent?.trim() ?? null,
      retryVisible: retry !== null,
      errorVisible: errors.length > 0,
      errorText: errors.map((node) => node.textContent?.trim() ?? '').filter(Boolean).join(' | '),
    };
  `);
}

async function waitFor(check, label, timeoutMs = EXIT_WAIT_MS) {
  const deadline = performance.now() + timeoutMs;
  let lastError;
  while (performance.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function webdriverElementId(item) {
  const id = item?.[ELEMENT_KEY] ?? item?.ELEMENT;
  if (typeof id !== 'string' || !id) fail('WebDriver returned a malformed element identity.');
  return id;
}

async function clickElementId(driver, elementId) {
  return driver.request('POST', driver.path(`/element/${elementId}/click`), {});
}

async function clickUnique(driver, selector) {
  const elements = await driver.elements(selector);
  if (elements.length !== 1) fail(`Expected one W3C click target for ${selector}, found ${elements.length}.`);
  const elementId = webdriverElementId(elements[0]);
  await clickElementId(driver, elementId);
  return elementId;
}

async function closeButtonId(driver) {
  const elements = await driver.elements(CLOSE_BUTTON_SELECTOR);
  if (elements.length !== 1) fail(`Expected exactly one real window Close button, found ${elements.length}.`);
  const elementId = webdriverElementId(elements[0]);
  const state = await driver.execute(`
    const buttons = [...document.querySelectorAll('${CLOSE_BUTTON_SELECTOR}')];
    const button = buttons.length === 1 ? buttons[0] : null;
    const controls = button?.closest('.window-controls') ?? null;
    const bounds = button?.getBoundingClientRect();
    return {
      count: buttons.length,
      tag: button?.tagName ?? null,
      className: button?.className ?? null,
      inHostControls: controls?.parentElement === document.body,
      visible: !!bounds && bounds.width > 0 && bounds.height > 0,
      disabled: button?.disabled ?? true,
    };
  `);
  if (
    state.count !== 1 ||
    state.tag !== 'BUTTON' ||
    !String(state.className).split(/\s+/).includes('is-close') ||
    !state.inHostControls ||
    !state.visible ||
    state.disabled
  ) {
    fail(`The W3C Close target is not the visible host window control: ${JSON.stringify(state)}.`);
  }
  return elementId;
}

async function editQuantityToThree(driver) {
  await clickUnique(driver, QUANTITY_EDIT);
  const editor = await waitFor(async () => {
    const matches = await driver.elements(QUANTITY_INPUT);
    return matches.length === 1 ? matches[0] : false;
  }, 'Quantity editor');
  const editorId = webdriverElementId(editor);
  await clickElementId(driver, editorId);
  await driver.request('POST', driver.path(`/element/${editorId}/value`), {
    text: '\uE009a',
    value: [...'\uE009a'],
  });
  await driver.request('POST', driver.path(`/element/${editorId}/value`), { text: '3', value: ['3'] });
  const draft = await readPluginUi(driver);
  if (draft.draftQuantity !== '3') fail(`Quantity editor did not hold draft 3: ${JSON.stringify(draft)}.`);
}

async function observeManualSample({ phase, origin, candidate, readOwnedAppIdentity, driver }) {
  const monotonicAtStart = monotonicMs(origin);
  const processBefore = await readOwnedAppIdentity();
  const ui = await readPluginUi(driver);
  const files = await captureNativeCloseMarkdownFiles(candidate.vault);
  const processAfter = await readOwnedAppIdentity();
  return {
    phase,
    monotonicMs: monotonicMs(origin),
    monotonicAtStartMs: monotonicAtStart,
    processBefore,
    processAfter,
    ui: {
      draftQuantity: ui.draftQuantity,
      cellQuantity: ui.cellQuantity,
      retryVisible: ui.retryVisible,
      errorVisible: ui.errorVisible,
      errorText: ui.errorText,
    },
    fileState: summarizeFiles(files),
  };
}

function createPassiveObserver({ candidate, readOwnedAppIdentity, origin, expectedIdentity }) {
  const samples = [];
  let task = null;
  let startedAtMs = null;
  let deadlineAt = null;

  function withObservationDeadline(promise, label) {
    const remainingMs = deadlineAt - performance.now();
    if (remainingMs <= 0) return Promise.reject(new Error(`Timed out waiting for ${label}.`));
    return withTimeout(promise, remainingMs, label);
  }

  async function takeSample() {
    const monotonicAtStart = monotonicMs(origin);
    const processBefore = await readOwnedAppIdentity();
    const files = await captureNativeCloseMarkdownFiles(candidate.vault);
    const processAfter = await readOwnedAppIdentity();
    const sample = {
      phase: 'retry-monitor',
      monotonicMs: monotonicMs(origin),
      monotonicAtStartMs: monotonicAtStart,
      processBefore,
      processAfter,
      ui: null,
      fileState: summarizeFiles(files),
    };
    samples.push(sample);
    return sample;
  }

  async function pollUntilAbsent() {
    while (performance.now() < deadlineAt) {
      const sample = await withObservationDeadline(
        takeSample(),
        'absolute native close process/filesystem observation deadline',
      );
      if (sample.processBefore === null && sample.processAfter === null) return sample;
      await delay(POLL_INTERVAL_MS);
    }
    throw new Error(`Timed out waiting for owned Morrow PID ${expectedIdentity.pid}/${expectedIdentity.startTimeTicks} to exit naturally.`);
  }

  return {
    get samples() { return samples; },
    get startedAtMs() { return startedAtMs; },
    withDeadline(promise, label) { return withObservationDeadline(promise, label); },
    withResponseWindow(promise, label, maxWaitMs) {
      const remainingMs = deadlineAt - performance.now();
      if (remainingMs <= 0) return Promise.reject(new Error(`Timed out waiting for ${label}.`));
      return withTimeout(promise, Math.min(remainingMs, maxWaitMs), label);
    },
    async start() {
      if (task) fail('Native close passive observer was started more than once.');
      startedAtMs = monotonicMs(origin);
      deadlineAt = performance.now() + EXIT_WAIT_MS;
      const first = await withObservationDeadline(takeSample(), 'pre-retry identity/filesystem observation deadline');
      if (!sameIdentity(first.processBefore, expectedIdentity) || !sameIdentity(first.processAfter, expectedIdentity)) {
        fail('Owned app PID/starttime was not live around the pre-retry observer sample.');
      }
      assertQuantity(first.fileState, 2, 'Retry observer pre-click sample');
      first.phase = 'retry-armed';
      task = pollUntilAbsent();
      return first;
    },
    async waitForNaturalExit() {
      if (!task) fail('Native close passive observer was not armed before the retry click.');
      return task;
    },
  };
}

async function writeJournal(candidate, journal) {
  const evidence = path.resolve(candidate.evidence);
  const evidenceInfo = await lstat(evidence);
  if (evidenceInfo.isSymbolicLink() || !evidenceInfo.isDirectory() || (await realpath(evidence)) !== evidence) {
    fail('Native close journal destination is not the canonical owned evidence directory.');
  }
  await writeFile(path.join(evidence, 'native-close-journal.json'), `${JSON.stringify(journal, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
}

export async function runNativeCloseScenario(context) {
  const { candidate, driver, recordStep, ownedAppIdentity, readOwnedAppIdentity } = context ?? {};
  if (!candidate?.vault || !candidate?.databaseId || !candidate?.evidence || !driver || typeof recordStep !== 'function') {
    fail('Native close scenario requires the isolated candidate, WebDriver and evidence callback.');
  }
  if (typeof readOwnedAppIdentity !== 'function') fail('Native close scenario requires the runner-owned PID observer.');
  const identity = assertIdentityShape(ownedAppIdentity);
  const processUid = typeof process.geteuid === 'function' ? process.geteuid() : null;
  if (processUid === null || processUid === 0 || identity.effectiveUid !== processUid) {
    fail('Native close scenario requires the app and runner to share the same non-root effective UID.');
  }
  if (!Array.isArray(candidate.vaultFiles) || CLOSE_MARKDOWN_PATHS.some((relative) => !candidate.vaultFiles.includes(relative))) {
    fail('Native close scenario requires the three verified synthetic Markdown files.');
  }

  const origin = performance.now();
  const samples = [];
  let result;
  let scenarioError = null;
  let phase = 'started';
  try {
    const observedIdentity = await readOwnedAppIdentity();
    if (!sameIdentity(observedIdentity, identity)) fail('Owned Morrow process identity changed before close test setup.');

    await driver.execute(`location.hash = '#/page/' + encodeURIComponent(arguments[0]);`, [candidate.databaseId]);
    const initialUi = await waitFor(async () => {
      const state = await readPluginUi(driver);
      return state.providerCount === 1 && state.cellQuantity === '2' ? state : false;
    }, 'synthetic Inventory grid with Quantity=2');

    const initial = await captureNativeCloseMarkdownFiles(candidate.vault);
    assertQuantity(initial, 2, 'Initial synthetic row');
    samples.push({
      phase: 'baseline',
      monotonicMs: monotonicMs(origin),
      monotonicAtStartMs: monotonicMs(origin),
      processBefore: observedIdentity,
      processAfter: await readOwnedAppIdentity(),
      ui: { draftQuantity: null, errorVisible: false, cellQuantity: initialUi.cellQuantity },
      fileState: summarizeFiles(initial),
    });
    const initialMode = await withSyntheticMarkdownParentWriteDenied(candidate, identity, async ({ mode }) => {
      phase = 'write-blocked';
      const beforeFailureSave = await captureNativeCloseMarkdownFiles(candidate.vault);
      assertSameMarkdownSet(initial, beforeFailureSave, 'Synthetic Markdown before failed Save');

      await editQuantityToThree(driver);
      const saveButtons = await driver.elements(QUANTITY_SAVE);
      if (saveButtons.length !== 1) fail(`Expected one W3C Save target, found ${saveButtons.length}.`);
      const failedSaveElementId = webdriverElementId(saveButtons[0]);
      const failedSaveClickAtMs = monotonicMs(origin);
      await clickElementId(driver, failedSaveElementId);
      const failedUi = await waitFor(async () => {
        const state = await readPluginUi(driver);
        return state.errorVisible && state.retryVisible && state.cellQuantity === '3' ? state : false;
      }, 'real flush error with staged Quantity=3 and Retry action');
      if (!failedUi.errorText) fail('Real flush error has no visible UI message.');
      const afterSaveFailure = await captureNativeCloseMarkdownFiles(candidate.vault);
      assertSameMarkdownSet(initial, afterSaveFailure, 'Failed real Save must preserve all three Markdown files');
      assertQuantity(afterSaveFailure, 2, 'Failed real Save');
      await driver.screenshot(path.join(candidate.evidence, 'native-close-save-error.png'));
      samples.push(await observeManualSample({
        phase: 'after-save-failure',
        origin,
        candidate,
        readOwnedAppIdentity,
        driver,
      }));

      const firstCloseElementId = await closeButtonId(driver);
      const firstCloseClickIssuedAtMs = monotonicMs(origin);
      await clickElementId(driver, firstCloseElementId);
      const firstCloseResolvedAtMs = monotonicMs(origin);
      const holdStart = performance.now();
      let holdSample;
      while (performance.now() - holdStart < DENIED_CLOSE_HOLD_MS) {
        const sample = await observeManualSample({
          phase: 'denied-close-hold',
          origin,
          candidate,
          readOwnedAppIdentity,
          driver,
        });
        if (!sameIdentity(sample.processBefore, identity) || !sameIdentity(sample.processAfter, identity)) {
          fail('App process did not remain alive through the failed Close hold.');
        }
        if (sample.ui?.cellQuantity !== '3' || sample.ui?.retryVisible !== true || sample.ui?.errorVisible !== true) {
          fail(`Staged Quantity/Retry/error state disappeared during the failed Close hold: ${JSON.stringify(sample.ui)}.`);
        }
        assertSameMarkdownSet(initial, sample.fileState, 'Failed Close hold must preserve all three Markdown files');
        samples.push(sample);
        await delay(Math.min(500, Math.max(1, DENIED_CLOSE_HOLD_MS - (performance.now() - holdStart))));
      }
      const deniedHoldMs = performance.now() - holdStart;
      if (deniedHoldMs < DENIED_CLOSE_HOLD_MS) fail('Failed Close hold ended before exceeding the old 5 second timeout.');
      holdSample = await observeManualSample({
        phase: 'denied-close-final',
        origin,
        candidate,
        readOwnedAppIdentity,
        driver,
      });
      if (!sameIdentity(holdSample.processBefore, identity) || !sameIdentity(holdSample.processAfter, identity)) {
        fail('App process was not alive at the end of the failed Close hold.');
      }
      if (holdSample.ui?.cellQuantity !== '3' || holdSample.ui?.retryVisible !== true || holdSample.ui?.errorVisible !== true) {
        fail('Staged Quantity=3 and visible Retry/error were not preserved after the failed Close hold.');
      }
      assertSameMarkdownSet(initial, holdSample.fileState, 'Denied Close final sample must preserve all three Markdown files');
      samples.push(holdSample);
      await driver.screenshot(path.join(candidate.evidence, 'native-close-denied-after-6500ms.png'));
      await recordStep('native-close-denied-keeps-staged-value-and-files', {
        closeButtonSelector: CLOSE_BUTTON_SELECTOR,
        heldMs: deniedHoldMs,
        processIdentity: identity,
        stagedQuantity: holdSample.ui.cellQuantity,
        retryVisible: holdSample.ui.retryVisible,
        errorVisible: holdSample.ui.errorVisible,
        filesUnchanged: true,
      });
      return {
        mode,
        initial,
        afterSaveFailure,
        afterDeniedClose: holdSample.fileState,
        failedSaveClickAtMs,
        firstCloseClickIssuedAtMs,
        firstCloseResolvedAtMs,
        deniedHoldMs,
        firstCloseElementId,
        failedSaveElementId,
        failedUi,
      };
    });

    const denied = initialMode.result;
    const mode = initialMode.mode;
    if (mode.restored !== mode.before) fail('Permission probe did not restore the original directory mode exactly.');
    const actualParentMode = await fileMode(path.join(candidate.vault, 'Inventory'));
    const actualTargetMode = await fileMode(path.join(candidate.vault, 'Inventory/Widget.md'));
    if (actualParentMode !== mode.before || actualTargetMode !== mode.targetFileModeBefore) {
      fail('Permission restoration differs from the original directory/file modes.');
    }
    assertSameMarkdownSet(denied.initial, await captureNativeCloseMarkdownFiles(candidate.vault), 'Content after permission restoration');

    const retryUi = await readPluginUi(driver);
    if (retryUi.cellQuantity !== '3' || !retryUi.retryVisible || !retryUi.errorVisible) {
      fail(`The staged Quantity/Retry/error state was not available for Close retry after mode restoration: ${JSON.stringify(retryUi)}.`);
    }
    const retryElementId = await closeButtonId(driver);
    if (retryElementId !== denied.firstCloseElementId) fail('The native Close button element identity changed before retry.');

    phase = 'retry-observation-armed';
    const observer = createPassiveObserver({
      candidate,
      readOwnedAppIdentity,
      origin,
      expectedIdentity: identity,
    });
    await observer.start();
    const observerStartedAtMs = observer.startedAtMs;
    const retryClickIssuedAtMs = monotonicMs(origin);
    phase = 'retry-close-clicked';
    const retryClickPromise = clickElementId(driver, retryElementId).then(
      () => ({ kind: 'resolved', requestIssued: true }),
      (error) => ({
        kind: 'webdriver-error-after-dispatch',
        requestIssued: true,
        name: error?.name ?? 'Error',
        message: String(error?.message ?? error).slice(0, 500),
      }),
    );
    const exitSample = await observer.waitForNaturalExit();
    const retryClickResult = await observer.withResponseWindow(
      retryClickPromise,
      'WebDriver Close retry response after process exit',
      1_000,
    ).catch(() => ({ kind: 'pending-at-process-exit', requestIssued: true }));
    const passiveSamples = observer.samples;
    const quantity3Sample = passiveSamples.find((sample) => sample.fileState['Inventory/Widget.md'].quantity === 3);
    if (!quantity3Sample) fail('The passive retry observer did not see persisted Quantity=3.');
    const finalBeforeCleanup = await observer.withDeadline(
      captureNativeCloseMarkdownFiles(candidate.vault),
      'final Markdown read before cleanup',
    );
    assertQuantity(finalBeforeCleanup, 3, 'Retry persistence before cleanup');
    assertOriginalCompanionFiles(denied.initial, finalBeforeCleanup, 'Retry persistence');
    const restoredDirectoryMode = await observer.withDeadline(
      fileMode(path.join(candidate.vault, 'Inventory')),
      'restored Markdown directory mode verification',
    );
    const restoredFileMode = await observer.withDeadline(
      fileMode(path.join(candidate.vault, 'Inventory/Widget.md')),
      'restored Markdown file mode verification',
    );
    if (
      mode.restored !== mode.before ||
      restoredDirectoryMode !== mode.before ||
      restoredFileMode !== mode.targetFileModeBefore
    ) {
      fail('The parent directory mode was not restored before natural process exit.');
    }
    const currentIdentity = await observer.withDeadline(readOwnedAppIdentity(), 'final owned process identity verification');
    if (currentIdentity !== null) fail('The owned Morrow PID/starttime remained present after retry Close.');
    if (exitSample.processBefore !== null || exitSample.processAfter !== null) {
      fail('Natural exit sample did not show the identified process entry absent on both sides of the file read.');
    }

    const events = {
      failedSaveClickAtMs: denied.failedSaveClickAtMs,
      firstCloseClickIssuedAtMs: denied.firstCloseClickIssuedAtMs,
      firstCloseResolvedAtMs: denied.firstCloseResolvedAtMs,
      deniedHoldMs: denied.deniedHoldMs,
      observerStartedAtMs,
      retryClickIssuedAtMs,
      quantity3ObservedAtMs: quantity3Sample.monotonicMs,
      processAbsentAtMs: exitSample.monotonicMs,
    };
    result = {
      schema: CLOSE_RECEIPT_SCHEMA,
      version: CLOSE_RECEIPT_VERSION,
      outcome: 'owned-natural-close',
      identity,
      mode,
      events,
      deniedClose: {
        selector: CLOSE_BUTTON_SELECTOR,
        elementId: denied.firstCloseElementId,
        clickCount: 1,
        clickResult: 'resolved',
      },
      failedSave: {
        selector: QUANTITY_SAVE,
        elementId: denied.failedSaveElementId,
        clickCount: 1,
        clickResult: 'resolved',
        errorText: denied.failedUi.errorText,
      },
      retry: {
        selector: CLOSE_BUTTON_SELECTOR,
        elementId: retryElementId,
        sameElement: retryElementId === denied.firstCloseElementId,
        clickCount: 1,
        clickResult: retryClickResult,
      },
      files: {
        initial: denied.initial,
        afterSaveFailure: denied.afterSaveFailure,
        afterDeniedClose: denied.afterDeniedClose,
        quantity3Sample: quantity3Sample.fileState,
        finalBeforeCleanup,
      },
      samples: [...samples, ...passiveSamples],
      ui: {
        failedSaveAlert: denied.failedUi.errorText,
        stagedQuantityBeforeRetry: retryUi.cellQuantity,
        retryVisibleBeforeRetry: retryUi.retryVisible,
        errorVisibleBeforeRetry: retryUi.errorVisible,
      },
    };
    assertOwnedNaturalCloseReceiptContract(result, identity);
    await recordStep('native-close-retry-saved-before-owned-natural-exit', {
      identity,
      quantity: 3,
      persistedFiles: result.files.finalBeforeCleanup,
      processAbsentAtMs: events.processAbsentAtMs,
      retryClickResult,
    });
    phase = 'passed';
  } catch (error) {
    scenarioError = error;
  }

  try {
    await writeJournal(candidate, {
      schema: 'morrow.native-close.journal',
      version: 1,
      phase,
      outcome: scenarioError ? 'failed' : 'observed',
      error: scenarioError ? String(scenarioError?.message ?? scenarioError) : null,
      samples,
      receipt: result ?? null,
      writtenAt: new Date().toISOString(),
    });
  } catch (journalError) {
    if (scenarioError && typeof scenarioError === 'object') scenarioError.cleanupError = journalError;
    else scenarioError = journalError;
  }
  if (scenarioError) throw scenarioError;
  return result;
}
