// Independent native close refusal/retry proof. All data and permission changes
// stay inside the run's synthetic vault; the app's real Close button drives both attempts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
const CLOSE_SELECTOR = '.window-control.is-close';
const MARKDOWN_FILES = ['Inventory.md', 'Inventory/Widget.md', 'Views.md'];
const WAIT_MS = 100;
const HOLD_SAMPLE_INTERVAL_MS = 500;
const OBSERVATION_MS = 6_500;
const CLOSE_TIMEOUT_MS = 25_000;
const IO_TIMEOUT_MS = 5_000;
const RECEIPT_NAME = 'native-close-independent-receipt.json';
const KEY = { controlA: '\uE009a' };

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function contained(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bounded(operation, label, timeoutMs = IO_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function withDeadline(operation, deadline, label) {
  const remainingMs = deadline - performance.now();
  if (remainingMs <= 0) throw new Error(`${label} exceeded its absolute deadline.`);
  return bounded(operation, label, Math.min(IO_TIMEOUT_MS, remainingMs));
}

async function waitFor(probe, label, timeoutMs = CLOSE_TIMEOUT_MS) {
  const deadline = performance.now() + timeoutMs;
  let lastError = null;
  while (performance.now() < deadline) {
    try {
      const result = await withDeadline(probe, deadline, `Observe ${label}`);
      if (result) return result;
    } catch (error) {
      lastError = error;
      if (performance.now() >= deadline) break;
    }
    await delay(Math.min(WAIT_MS, Math.max(0, deadline - performance.now())));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `; last observation: ${lastError.message}` : ''}`);
}

function vaultPath(root, relative) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relative);
  assert.ok(target !== resolvedRoot && contained(resolvedRoot, target), `Synthetic path escaped vault: ${relative}`);
  return target;
}

async function assertSyntheticRoot(candidate) {
  assert.equal(typeof process.geteuid, 'function', 'The runtime must expose its effective UID.');
  const euid = process.geteuid();
  assert.notEqual(euid, 0, 'The native scenario must run as a non-root user so directory permissions can deny writes.');
  assert.equal(typeof candidate?.vault, 'string', 'The candidate must name its synthetic origin vault.');
  const root = path.resolve(candidate.vault);
  const tempRoot = await realpath(os.tmpdir());
  assert.equal(path.dirname(root), tempRoot, 'The origin vault must be a direct child of the temporary directory.');
  assert.equal(await realpath(root), root, 'The synthetic vault root must not resolve through a symlink.');
  const info = await lstat(root);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'The synthetic vault root must be a real directory.');
  assert.equal(info.uid, euid, 'The synthetic vault must be owned by the non-root runner UID.');
  return { root, euid };
}

async function captureRegularFile(root, relative) {
  const file = vaultPath(root, relative);
  const before = await lstat(file);
  assert.ok(before.isFile() && !before.isSymbolicLink(), `Expected a regular synthetic file: ${relative}`);
  assert.equal(await realpath(file), file, `Synthetic file must not traverse a symlink: ${relative}`);
  const bytes = await readFile(file);
  const after = await lstat(file);
  assert.ok(after.isFile() && !after.isSymbolicLink(), `Synthetic file changed type while read: ${relative}`);
  assert.equal(after.ino, before.ino, `Synthetic file was replaced while being read: ${relative}`);
  assert.equal(after.size, bytes.byteLength, `Synthetic file changed size while read: ${relative}`);
  return {
    relative,
    bytes,
    sha256: hash(bytes),
    size: bytes.byteLength,
    mtimeMs: after.mtimeMs,
    mode: after.mode & 0o7777,
    uid: after.uid,
    gid: after.gid,
  };
}

async function captureMarkdown(root, deadline = null) {
  const capture = async () => {
    const files = {};
    for (const relative of MARKDOWN_FILES) files[relative] = await captureRegularFile(root, relative);
    return files;
  };
  return deadline === null
    ? bounded(capture, 'Capture all three synthetic Markdown files')
    : withDeadline(capture, deadline, 'Capture all three synthetic Markdown files');
}

function summarizeFiles(files) {
  return Object.fromEntries(MARKDOWN_FILES.map((relative) => {
    const file = files[relative];
    return [relative, {
      sha256: file.sha256,
      size: file.size,
      mtimeMs: file.mtimeMs,
      mode: file.mode,
      quantity: relative === 'Inventory/Widget.md' ? quantityFrom(file.bytes) : null,
    }];
  }));
}

function quantityFrom(bytes) {
  const markdown = Buffer.from(bytes).toString('utf8');
  const match = /^\s*Quantity\s*:\s*(.*?)\s*$/im.exec(markdown);
  assert.ok(match, 'Synthetic Widget Markdown must contain a Quantity field.');
  const quantity = Number(match[1]);
  assert.ok(Number.isFinite(quantity), 'Synthetic Widget Quantity must be numeric.');
  return quantity;
}

function assertFilesEqual(before, after, label) {
  for (const relative of MARKDOWN_FILES) {
    assert.equal(after[relative].sha256, before[relative].sha256, `${label}: ${relative} bytes changed.`);
    assert.equal(after[relative].size, before[relative].size, `${label}: ${relative} size changed.`);
    assert.equal(after[relative].mtimeMs, before[relative].mtimeMs, `${label}: ${relative} mtime changed.`);
    assert.equal(after[relative].mode, before[relative].mode, `${label}: ${relative} mode changed.`);
  }
}

function assertMetadataUnchanged(before, after, relative, label) {
  for (const field of ['sha256', 'size', 'mtimeMs', 'mode']) {
    assert.equal(after[relative][field], before[relative][field], `${label}: ${relative} ${field} changed.`);
  }
}

async function directoryState(root, deadline = null) {
  const read = async () => {
    const directory = vaultPath(root, 'Inventory');
    const info = await lstat(directory);
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Inventory must be a real directory.');
    assert.equal(await realpath(directory), directory, 'Inventory directory must not resolve through a symlink.');
    const entries = await readdir(directory, { withFileTypes: true });
    assert.ok(entries.every((entry) => !entry.isSymbolicLink()), 'Inventory directory contains no symlinks.');
    return {
      path: directory,
      mode: info.mode & 0o7777,
      uid: info.uid,
      gid: info.gid,
      entries: entries.map((entry) => entry.name).sort(),
    };
  };
  return deadline === null
    ? bounded(read, 'Read synthetic Inventory directory state')
    : withDeadline(read, deadline, 'Read synthetic Inventory directory state');
}

async function capturePluginConfiguration(root, deadline = null) {
  const read = async () => {
    const file = await captureRegularFile(root, '.morrow/plugins.json');
    let value;
    try { value = JSON.parse(file.bytes.toString('utf8')); }
    catch (error) { throw new Error('Synthetic plugin configuration is not valid JSON.', { cause: error }); }
    return { file, value };
  };
  return deadline === null
    ? bounded(read, 'Capture synthetic plugin configuration')
    : withDeadline(read, deadline, 'Capture synthetic plugin configuration');
}

function assertSameIdentity(actual, expected, label) {
  assert.ok(actual, `${label}: the owned app PID disappeared unexpectedly.`);
  for (const field of ['pid', 'startTimeTicks', 'effectiveUid', 'executablePathSha256', 'argvSha256', 'driverPid']) {
    assert.equal(actual[field], expected[field], `${label}: owned-app identity field ${field} changed.`);
  }
  assert.equal(actual.runtimeIdentityConfirmed, true, `${label}: app runtime identity was not confirmed.`);
}

function elementId(reference, label) {
  const id = reference?.[ELEMENT_KEY] ?? reference?.ELEMENT;
  assert.ok(typeof id === 'string' && id.length > 0, `WebDriver did not return a reference for ${label}.`);
  return id;
}

async function clickElement(driver, id, label, deadline = null, onIssued = null) {
  const operation = () => {
    onIssued?.();
    return driver.request('POST', driver.path(`/element/${id}/click`), {});
  };
  return deadline === null
    ? bounded(operation, `Click ${label}`)
    : withDeadline(operation, deadline, `Click ${label}`);
}

async function typeElement(driver, id, text, label) {
  return bounded(() => driver.request('POST', driver.path(`/element/${id}/value`), { text, value: [...text] }), `Type ${label}`);
}

async function findUniqueElement(driver, selector, label) {
  return waitFor(async () => {
    const result = await driver.execute(`const matches = [...document.querySelectorAll(arguments[0])];
      return matches.length === 1 ? matches[0] : null;`, [selector]);
    return result ?? false;
  }, `one ${label}`);
}

async function workspacePageId(root) {
  const workspace = JSON.parse((await readFile(vaultPath(root, '.morrow/workspace.json'), 'utf8')));
  const id = workspace?.pages?.['Inventory.md']?.id;
  assert.ok(typeof id === 'string' && id.length > 0, 'Synthetic Inventory page has a stable workspace ID.');
  return id;
}

async function readPublicUiState(driver) {
  return bounded(() => driver.execute(`const visible = (node) => {
      if (!node) return false;
      const style = getComputedStyle(node);
      return node.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden'
        && Number(style.opacity) !== 0;
    };
    const roots = [...document.querySelectorAll('[data-provider="polaris-dados"]')];
    const root = roots.length === 1 ? roots[0] : null;
    const row = root?.querySelector('tbody tr') ?? null;
    const input = root?.querySelector('input[type="number"][data-field="quantity"]') ?? null;
    const cellQuantity = row?.querySelector('[data-field="quantity"] [data-value-kind="number"]')?.textContent?.trim() ?? null;
    const retryButtons = [...(root?.querySelectorAll('button[data-action="retry"]') ?? [])].filter(visible);
    const alerts = [...document.querySelectorAll('[role="alert"]')].filter(visible)
      .map((node) => node.textContent?.replace(/\\s+/g, ' ').trim() ?? '');
    const status = document.querySelector('.topbar .save-status');
    const closeButtons = [...document.querySelectorAll(arguments[0])].filter(visible);
    return {
      title: document.querySelector('textarea.page-title')?.value ?? null,
      route: location.hash,
      providerCount: roots.length,
      tablePresent: Boolean(root?.querySelector('table')),
      rowCount: root?.querySelectorAll('tbody tr').length ?? 0,
      quantity: input?.value ?? cellQuantity,
      cellQuantity,
      quantityEditing: Boolean(input),
      retryVisible: retryButtons.length === 1,
      retryButtonCount: retryButtons.length,
      price: row?.querySelector('[data-field="price"]')?.textContent?.trim() ?? null,
      total: row?.querySelector('[data-field="total"]')?.textContent?.trim() ?? null,
      saveButtonCount: root?.querySelectorAll('button[data-action="save"]').length ?? 0,
      rowAlertTexts: [...(root?.querySelectorAll('[role="alert"]') ?? [])].filter(visible)
        .map((node) => node.textContent?.replace(/\\s+/g, ' ').trim() ?? ''),
      alertTexts: alerts,
      saveStatus: {
        visible: visible(status),
        text: status?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
        className: status?.className ?? '',
        role: status?.getAttribute('role') ?? null,
        title: status?.getAttribute('title') ?? null,
      },
      closeButtonCount: closeButtons.length,
      closeButtonConnected: closeButtons.length === 1 && closeButtons[0].isConnected,
      readyState: document.readyState,
    };`, [CLOSE_SELECTOR]), 'Read public app UI state');
}

function hasSaveFailure(ui) {
  const messages = [...(ui.alertTexts ?? []), ...(ui.rowAlertTexts ?? []), ui.saveStatus?.text ?? '', ui.saveStatus?.title ?? ''];
  return messages.some((message) => /save|writ|permission|denied|salvar|guardar/i.test(message))
    || /(?:^|\s)is-error(?:\s|$)/.test(ui.saveStatus?.className ?? '');
}

function visibleErrorText(ui) {
  return [...(ui.alertTexts ?? []), ...(ui.rowAlertTexts ?? []), ui.saveStatus?.text ?? '', ui.saveStatus?.title ?? '']
    .filter((message) => message.length > 0)
    .join(' | ');
}

async function waitForProvider(driver, pageId) {
  return waitFor(async () => {
    const ui = await readPublicUiState(driver);
    return ui.providerCount === 1 && ui.tablePresent && ui.rowCount === 1 && ui.quantity === '2'
      && ui.title === 'Inventory' && ui.route.includes(encodeURIComponent(pageId)) ? ui : false;
  }, 'the synthetic Inventory table at Quantity=2');
}

async function saveFailure(driver) {
  return waitFor(async () => {
    const ui = await readPublicUiState(driver);
    return ui.cellQuantity === '3' && !ui.quantityEditing && ui.retryVisible && hasSaveFailure(ui) ? ui : false;
  }, 'a visible save failure with staged Quantity=3, Retry and no editor input');
}

function normalizedUi(ui) {
  return {
    draftQuantity: ui.quantityEditing ? ui.quantity : null,
    cellQuantity: ui.cellQuantity,
    quantityEditing: ui.quantityEditing,
    retryVisible: ui.retryVisible,
    errorVisible: hasSaveFailure(ui),
    errorTexts: ui.alertTexts,
    rowErrorTexts: ui.rowAlertTexts,
    saveStatus: ui.saveStatus,
    closeButtonCount: ui.closeButtonCount,
    providerCount: ui.providerCount,
    title: ui.title,
    route: ui.route,
  };
}

async function record(recordStep, name, details = {}, deadline = null) {
  const write = () => recordStep(name, details);
  return deadline === null
    ? bounded(write, `Record ${name}`)
    : withDeadline(write, deadline, `Record ${name}`);
}

async function writeReceipt(candidate, receipt, deadline = null) {
  const within = (operation, label) => deadline === null ? bounded(operation, label) : withDeadline(operation, deadline, label);
  const evidenceRoot = path.resolve(candidate.evidence);
  assert.equal(await within(() => realpath(evidenceRoot), 'Resolve evidence directory'), evidenceRoot,
    'Evidence directory must not resolve through a symlink.');
  const target = path.join(evidenceRoot, RECEIPT_NAME);
  assert.ok(contained(evidenceRoot, target), 'Natural-close receipt must remain under the new evidence directory.');
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  await within(() => writeFile(target, bytes, { flag: 'wx', mode: 0o600 }), 'Write natural-close receipt');
  const copied = await within(() => readFile(target), 'Read back natural-close receipt');
  assert.equal(hash(copied), hash(bytes), 'Natural-close receipt changed when read back.');
  return { path: target, sha256: hash(copied), size: copied.byteLength };
}

async function readOwnedIdentity(context, label, deadline = null) {
  const read = () => context.readOwnedAppIdentity();
  return deadline === null
    ? bounded(read, label)
    : withDeadline(read, deadline, label);
}

async function observeRetryLifecycle({ context, root, identity, rowRelative, samples, deadline, onArmed, onProcessAbsent }) {
  let quantity3Files = null;
  let quantity3Snapshot = null;
  let quantity3ObservedAtMs = null;
  let processAbsentAtMs = null;
  let processBefore = identity;

  while (performance.now() < deadline) {
    const fileState = await captureMarkdown(root, deadline);
    const processAfter = await readOwnedIdentity(context, 'Observe owned app during natural close', deadline);
    if (processBefore !== null) assertSameIdentity(processBefore, identity, 'Before natural-close sample');
    if (processAfter !== null) assertSameIdentity(processAfter, identity, 'After natural-close sample');
    const monotonicMs = performance.now();
    const sample = {
      phase: 'natural-close-observation',
      monotonicMs,
      processBefore,
      processAfter,
      ui: null,
      fileState: summarizeFiles(fileState),
    };
    samples.push(sample);
    onArmed?.();

    if (!quantity3Snapshot && quantityFrom(fileState[rowRelative].bytes) === 3) {
      quantity3ObservedAtMs = monotonicMs;
      quantity3Files = fileState;
      quantity3Snapshot = sample.fileState;
    }
    if (processBefore === null && processAfter === null && processAbsentAtMs === null) {
      processAbsentAtMs = monotonicMs;
      onProcessAbsent?.(monotonicMs);
    }
    processBefore = processAfter;
    if (quantity3Snapshot && processAbsentAtMs !== null && sample.processBefore === null && sample.processAfter === null) break;

    const remainingMs = deadline - performance.now();
    if (remainingMs > 0) await withDeadline(() => delay(Math.min(WAIT_MS, remainingMs)), deadline, 'Wait for natural-close evidence');
  }

  assert.ok(quantity3Snapshot, 'Quantity=3 must persist during the armed retry/close observation.');
  assert.ok(processAbsentAtMs !== null, 'The identified app PID must exit naturally before cleanup.');
  assert.equal(quantityFrom(quantity3Files[rowRelative].bytes), 3);
  return { quantity3Files, quantity3Snapshot, quantity3ObservedAtMs, processAbsentAtMs };
}

export function classifyRetryClickResult({ value, error, requestIssued, processAbsentAtResult }) {
  if (!error) return { kind: 'resolved', requestIssued, responseReceived: true, valueType: typeof value };
  return {
    kind: processAbsentAtResult === null ? 'webdriver-error-after-dispatch' : 'pending-at-process-exit',
    requestIssued,
    responseReceived: false,
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}

export async function runConcurrentRetryObservation(observe, issueClick, processAbsentAtResult = () => null) {
  let requestIssued = false;
  let resolveArmed;
  const armedPromise = new Promise((resolve) => { resolveArmed = resolve; });
  let armed = false;
  const observationPromise = observe(() => {
    if (armed) return;
    armed = true;
    resolveArmed();
  });
  await Promise.race([
    armedPromise,
    observationPromise.then(() => { throw new Error('The natural-close observer ended before the retry click was issued.'); }),
  ]);
  const clickPromise = Promise.resolve().then(() => issueClick(() => { requestIssued = true; })).then(
    (value) => classifyRetryClickResult({ value, requestIssued, processAbsentAtResult: processAbsentAtResult() }),
    (error) => classifyRetryClickResult({ error, requestIssued, processAbsentAtResult: processAbsentAtResult() }),
  );
  const [observationResult, clickResult] = await Promise.allSettled([observationPromise, clickPromise]);
  if (observationResult.status === 'rejected') throw observationResult.reason;
  if (clickResult.status === 'rejected') throw clickResult.reason;
  return { observation: observationResult.value, clickResult: clickResult.value };
}

export async function runIndependentNativeCloseScenario(context) {
  assert.ok(context && context.driver && context.candidate && context.recordStep,
    'Independent native close scenario requires driver, candidate and recordStep.');
  assert.equal(typeof context.readOwnedAppIdentity, 'function', 'Runner must expose the verified owned-app identity reader.');
  const { driver, candidate, recordStep } = context;
  const identity = context.ownedAppIdentity;
  assert.ok(identity && Number.isInteger(identity.pid) && identity.pid > 0, 'Runner must provide the owned app PID.');
  assert.equal(identity.runtimeIdentityConfirmed, true, 'Owned app runtime identity must be confirmed before UI actions.');
  assert.equal(identity.effectiveUid, process.geteuid(), 'App and runner must have the same effective UID.');

  const { root, euid } = await assertSyntheticRoot(candidate);
  const rowRelative = 'Inventory/Widget.md';
  const directoryBefore = await directoryState(root);
  assert.equal(directoryBefore.uid, euid, 'Inventory directory UID must match the non-root runner.');
  const targetBefore = await captureRegularFile(root, rowRelative);
  assert.equal(targetBefore.uid, euid, 'Inventory/Widget.md UID must match the non-root runner.');
  const configBefore = await capturePluginConfiguration(root);
  const markdownInitial = await captureMarkdown(root);
  assert.equal(quantityFrom(targetBefore.bytes), 2, 'Initial synthetic Quantity must be 2.');
  assert.ok(configBefore.value.enabled?.includes('polaris-dados'), 'Synthetic vault must start with Polaris Dados enabled.');

  const workspacePage = await workspacePageId(root);
  await bounded(() => driver.execute("location.hash = '#/page/' + encodeURIComponent(arguments[0]);", [workspacePage]),
    'Route to synthetic Inventory page');
  let ui = await waitForProvider(driver, workspacePage);
  await record(recordStep, 'independent-154-inventory-ready', {
    identity,
    directory: { relative: 'Inventory', mode: directoryBefore.mode, uid: directoryBefore.uid, gid: directoryBefore.gid, entries: directoryBefore.entries },
    target: summarizeFiles(markdownInitial)['Inventory/Widget.md'],
    markdown: summarizeFiles(markdownInitial),
    pluginConfiguration: { ...configBefore.file, bytes: undefined, enabled: configBefore.value.enabled },
    ui: normalizedUi(ui),
  });

  const initialCloseButton = await findUniqueElement(driver, CLOSE_SELECTOR, 'native Close button');
  const closeElementId = elementId(initialCloseButton, 'native Close button');
  const closeButtonFacts = await bounded(() => driver.execute(`const button = arguments[0];
    return { connected: button.isConnected, className: button.className, ariaLabel: button.getAttribute('aria-label'), title: button.title };`, [initialCloseButton]),
  'Read native Close button identity');
  assert.equal(closeButtonFacts.connected, true);
  assert.match(closeButtonFacts.className, /(?:^|\s)is-close(?:\s|$)/);
  assert.equal(closeButtonFacts.ariaLabel, 'Close', 'The real native control must be the user-facing Close button.');

  const blockedMode = directoryBefore.mode & ~0o222;
  assert.equal(blockedMode & 0o222, 0, 'Blocked Inventory directory mode must remove all write bits.');
  let modeBlocked = false;
  let modeRestored = false;
  let cleanupError = null;
  let primaryError = null;
  const samples = [];
  let receiptEvidence = null;
  let failedSaveClickAtMs = null;
  let firstCloseClickIssuedAtMs = null;
  let firstCloseResolvedAtMs = null;
  let deniedHoldMs = null;
  let failedSaveElementId;
  let failedSaveErrorText;
  let observerStartedAtMs = null;
  let retryClickIssuedAtMs = null;
  let quantity3ObservedAtMs = null;
  let processAbsentAtMs = null;
  let observedProcessAbsentAtClickResult = null;
  let quantity3Files;
  let quantity3Snapshot;
  let failedSaveUi;
  let afterSaveFailure;
  let afterDeniedClose;
  let finalBeforeCleanup;
  let retryClickResult;

  const restoreDirectoryMode = async () => {
    if (!modeBlocked || modeRestored) return;
    await bounded(async () => {
      await chmod(directoryBefore.path, directoryBefore.mode);
      const restored = await directoryState(root);
      assert.equal(restored.mode, directoryBefore.mode, 'Inventory directory mode was not restored exactly.');
      assert.equal(restored.uid, directoryBefore.uid, 'Inventory directory ownership changed.');
      assert.equal(restored.gid, directoryBefore.gid, 'Inventory directory group ownership changed.');
    }, 'Restore and verify exact Inventory directory mode', IO_TIMEOUT_MS);
    modeBlocked = false;
    modeRestored = true;
  };

  try {
    modeBlocked = true;
    await bounded(() => chmod(directoryBefore.path, blockedMode), 'Remove write bits from synthetic Inventory directory');
    const blockedDirectory = await directoryState(root);
    assert.equal(blockedDirectory.mode, blockedMode, 'Inventory directory did not enter the exact blocked mode.');
    assert.equal(blockedDirectory.uid, directoryBefore.uid);
    assert.deepEqual(blockedDirectory.entries, directoryBefore.entries, 'Permission setup changed Inventory directory contents.');
    await record(recordStep, 'independent-154-synthetic-directory-write-blocked', {
      directoryRelative: 'Inventory',
      uid: blockedDirectory.uid,
      gid: blockedDirectory.gid,
      beforeMode: directoryBefore.mode,
      blockedMode: blockedDirectory.mode,
      targetFileModeBefore: targetBefore.mode,
      directoryEntries: blockedDirectory.entries,
    });

    const editButton = await findUniqueElement(driver, '[data-provider="polaris-dados"] button[data-action="edit"][data-field="quantity"]', 'Quantity edit button');
    await clickElement(driver, elementId(editButton, 'Quantity edit button'), 'Quantity edit button');
    const quantityInput = await findUniqueElement(driver, '[data-provider="polaris-dados"] input[type="number"][data-field="quantity"]', 'Quantity editor');
    const quantityInputId = elementId(quantityInput, 'Quantity editor');
    await typeElement(driver, quantityInputId, KEY.controlA, 'select all in Quantity editor');
    await typeElement(driver, quantityInputId, '3', 'Quantity=3 draft');
    ui = await readPublicUiState(driver);
    assert.equal(ui.quantity, '3', 'Quantity=3 must be present in the live editor draft before Save.');
    assert.equal(ui.quantityEditing, true, 'Quantity=3 must remain a draft before Save.');
    assertFilesEqual(markdownInitial, await captureMarkdown(root), 'Editing the row must not change persisted files before Save.');

    const saveButton = await findUniqueElement(driver, '[data-provider="polaris-dados"] button[data-action="save"]', 'real provider Save button');
    failedSaveElementId = elementId(saveButton, 'real provider Save button');
    failedSaveClickAtMs = performance.now();
    await clickElement(driver, failedSaveElementId, 'real provider Save button');
    failedSaveUi = await saveFailure(driver);
    failedSaveErrorText = visibleErrorText(failedSaveUi);
    assert.match(failedSaveErrorText, /permission denied|os error 13|eacces/i,
      'Visible failed Save error must identify the synthetic directory permission denial.');
    assert.equal(failedSaveUi.cellQuantity, '3', 'Failed Save must leave staged Quantity=3 visible in the table.');
    assert.equal(failedSaveUi.quantityEditing, false, 'Failed Save must not be represented as an open input editor.');
    assert.equal(failedSaveUi.retryVisible, true, 'Failed Save must show the real Retry control.');
    afterSaveFailure = await captureMarkdown(root);
    assertFilesEqual(markdownInitial, afterSaveFailure, 'Failed provider Save must preserve all three Markdown files.');
    assert.equal(quantityFrom(afterSaveFailure[rowRelative].bytes), 2, 'Failed provider Save must leave on-disk Quantity=2.');
    assert.equal(afterSaveFailure[rowRelative].mode, targetBefore.mode, 'Failed Save must preserve target-file mode.');
    const failedDirectory = await directoryState(root);
    assert.equal(failedDirectory.mode, blockedMode, 'Directory write denial must remain active during the failed Save.');
    assert.deepEqual(failedDirectory.entries, directoryBefore.entries, 'Failed Save must not leave a temp file in Inventory.');
    const failedProcessBefore = await readOwnedIdentity(context, 'Read owned app after failed Save');
    assertSameIdentity(failedProcessBefore, identity, 'After failed provider Save before evidence sample');
    const failedProcessAfter = await readOwnedIdentity(context, 'Confirm owned app after failed Save');
    assertSameIdentity(failedProcessAfter, identity, 'After failed provider Save evidence sample');
    samples.push({
      phase: 'after-save-failure',
      monotonicMs: performance.now(),
      processBefore: failedProcessBefore,
      processAfter: failedProcessAfter,
      ui: normalizedUi(failedSaveUi),
      fileState: summarizeFiles(afterSaveFailure),
    });
    const failedSaveScreenshot = path.join(candidate.evidence, 'native-close-independent-save-failed.png');
    await bounded(() => driver.screenshot(failedSaveScreenshot), 'Capture real save failure');
    await record(recordStep, 'independent-154-real-save-failed-draft-preserved', {
      failedSaveClickAtMs,
      directoryMode: failedDirectory.mode,
      directoryEntries: failedDirectory.entries,
      ui: normalizedUi(failedSaveUi),
      markdown: summarizeFiles(afterSaveFailure),
      screenshot: failedSaveScreenshot,
    });

    firstCloseClickIssuedAtMs = performance.now();
    await clickElement(driver, closeElementId, 'first real native Close click');
    firstCloseResolvedAtMs = performance.now();
    const deniedUi = await waitFor(async () => {
      const current = await readPublicUiState(driver);
      if (current.providerCount === 1 && current.cellQuantity === '3' && !current.quantityEditing
        && current.retryVisible && current.closeButtonCount === 1 && hasSaveFailure(current)) return current;
      return false;
    }, 'real Close refusal with staged Quantity=3, Retry and visible save error');
    const afterFirstCloseProcess = await readOwnedIdentity(context, 'Read owned app after refused Close');
    assertSameIdentity(afterFirstCloseProcess, identity, 'After the first refused Close');
    afterDeniedClose = await captureMarkdown(root);
    assertFilesEqual(markdownInitial, afterDeniedClose, 'Denied Close must keep all three original Markdown files byte/mtime-identical.');
    assert.equal(quantityFrom(afterDeniedClose[rowRelative].bytes), 2, 'Denied Close must keep original persisted Quantity=2.');
    assert.equal(afterDeniedClose[rowRelative].mode, targetBefore.mode, 'Denied Close must preserve target-file mode.');
    const deniedProcessAfter = await readOwnedIdentity(context, 'Confirm owned app after denied-close sample');
    assertSameIdentity(deniedProcessAfter, identity, 'After denied-close file sample');
    samples.push({
      phase: 'denied-close-observed',
      monotonicMs: performance.now(),
      processBefore: afterFirstCloseProcess,
      processAfter: deniedProcessAfter,
      ui: normalizedUi(deniedUi),
      fileState: summarizeFiles(afterDeniedClose),
    });
    const deniedScreenshot = path.join(candidate.evidence, 'native-close-independent-denied-close.png');
    await bounded(() => driver.screenshot(deniedScreenshot), 'Capture denied native Close state');
    await record(recordStep, 'independent-154-real-close-denied', {
      firstCloseClickIssuedAtMs,
      firstCloseResolvedAtMs,
      processIdentity: afterFirstCloseProcess,
      ui: normalizedUi(deniedUi),
      markdown: summarizeFiles(afterDeniedClose),
      screenshot: deniedScreenshot,
    });

    const holdStartedAt = firstCloseResolvedAtMs;
    let lastHoldSampleAt = holdStartedAt;
    const holdSample = async () => {
      const processBefore = await readOwnedIdentity(context, 'Read owned app during denied-close hold');
      assertSameIdentity(processBefore, identity, 'During denied-close hold before public UI/file sample');
      const state = await readPublicUiState(driver);
      const fileState = await captureMarkdown(root);
      const processAfter = await readOwnedIdentity(context, 'Confirm owned app during denied-close hold');
      assertSameIdentity(processAfter, identity, 'During denied-close hold after public UI/file sample');
      assert.equal(state.providerCount, 1, 'The app window and provider must remain mounted while Close is denied.');
      assert.equal(state.cellQuantity, '3', 'The denied-close staged row must remain Quantity=3.');
      assert.equal(state.quantityEditing, false, 'The denied-close state must remain staged, not an editor input.');
      assert.equal(state.retryVisible, true, 'The denied-close state must keep its real Retry control visible.');
      assert.equal(hasSaveFailure(state), true, 'The user-facing save/close error must remain visible during the hold.');
      assertFilesEqual(markdownInitial, fileState, 'Denied-close hold must preserve all three Markdown files.');
      const monotonicMs = performance.now();
      const sample = {
        phase: 'denied-close-hold',
        monotonicMs,
        processBefore,
        processAfter,
        ui: normalizedUi(state),
        fileState: summarizeFiles(fileState),
      };
      samples.push(sample);
      lastHoldSampleAt = monotonicMs;
      return sample;
    };

    await holdSample();
    while (performance.now() - holdStartedAt < OBSERVATION_MS) {
      await delay(HOLD_SAMPLE_INTERVAL_MS);
      await holdSample();
    }
    deniedHoldMs = performance.now() - firstCloseResolvedAtMs;
    assert.ok(deniedHoldMs >= 6_500,
      `The denied window must remain alive for at least 6.5 seconds; observed ${deniedHoldMs.toFixed(1)}ms.`);
    assert.ok(lastHoldSampleAt >= holdStartedAt + OBSERVATION_MS - 250,
      'The final denied-close sample must cover the end of the 6.5-second hold.');
    const finalHoldSample = samples.at(-1);
    finalHoldSample.phase = 'denied-close-final';
    assert.equal(finalHoldSample.ui.cellQuantity, '3');
    assert.equal(finalHoldSample.ui.retryVisible, true);
    assert.equal(finalHoldSample.ui.errorVisible, true);
    assertSameIdentity(finalHoldSample.processAfter, identity, 'Final sample of denied-close hold');
    await record(recordStep, 'independent-154-denied-window-held-past-five-seconds', {
      deniedHoldMs,
      finalSample: finalHoldSample,
      sampleCount: samples.length,
    });

    await restoreDirectoryMode();
    const restoredDirectory = await directoryState(root);
    assert.equal(restoredDirectory.mode, directoryBefore.mode, 'Exact original Inventory directory mode must be restored before retry.');
    assert.equal(restoredDirectory.uid, directoryBefore.uid);
    assert.equal(restoredDirectory.gid, directoryBefore.gid);
    assert.deepEqual(restoredDirectory.entries, directoryBefore.entries, 'Inventory directory entries must be unchanged after restoring write permission.');
    assertFilesEqual(markdownInitial, await captureMarkdown(root), 'Mode restoration alone must not change persisted Markdown.');
    const configAfterRestore = await capturePluginConfiguration(root);
    assert.equal(configAfterRestore.file.sha256, configBefore.file.sha256, 'Plugin configuration bytes must remain unchanged.');
    assert.equal(configAfterRestore.file.size, configBefore.file.size);
    assert.equal(configAfterRestore.file.mtimeMs, configBefore.file.mtimeMs);
    assert.deepEqual(configAfterRestore.value, configBefore.value, 'Plugin configuration semantics must remain unchanged.');

    const sameButton = await bounded(() => driver.execute(`const original = arguments[0];
      const matches = [...document.querySelectorAll(arguments[1])];
      return matches.length === 1 && original.isConnected && original === matches[0];`, [initialCloseButton, CLOSE_SELECTOR]),
    'Verify the original Close button node remains connected for retry');
    assert.equal(sameButton, true, 'Retry must click the exact same DOM Close button.');
    const readyToRetry = await readPublicUiState(driver);
    assert.equal(readyToRetry.closeButtonCount, 1, 'The same Close button must be available after restoring permissions.');
    assert.equal(readyToRetry.cellQuantity, '3', 'Staged Quantity=3 must still be present before retry.');
    assert.equal(readyToRetry.quantityEditing, false, 'Retry proceeds from the staged state, with no open input.');
    assert.equal(readyToRetry.retryVisible, true, 'The real Retry control must remain available before retry.');
    assert.equal(hasSaveFailure(readyToRetry), true, 'The failed-save state must remain visible until retry.');
    assertSameIdentity(await readOwnedIdentity(context, 'Read owned app immediately before retry'), identity, 'Immediately before retry');

    const retryBaseline = await captureMarkdown(root);
    assertFilesEqual(markdownInitial, retryBaseline, 'Retry observer must start from the original persisted Markdown.');
    const retryBaselineProcess = await readOwnedIdentity(context, 'Read owned app identity before retry observer');
    assertSameIdentity(retryBaselineProcess, identity, 'Retry observer armed before click');
    const retryArmedProcessAfter = await readOwnedIdentity(context, 'Confirm owned app remains alive before retry observer');
    assertSameIdentity(retryArmedProcessAfter, identity, 'Retry observer armed before click');
    const retryArmedSample = {
      phase: 'retry-armed',
      monotonicMs: performance.now(),
      processBefore: retryBaselineProcess,
      processAfter: retryArmedProcessAfter,
      ui: null,
      fileState: summarizeFiles(retryBaseline),
    };
    samples.push(retryArmedSample);
    await record(recordStep, 'independent-154-natural-close-observer-baseline', {
      identity: retryBaselineProcess,
      markdown: summarizeFiles(retryBaseline),
      closeElementId,
    });

    observerStartedAtMs = performance.now();
    const processAbsentDeadline = observerStartedAtMs + CLOSE_TIMEOUT_MS;
    const concurrentResult = await runConcurrentRetryObservation(
      (onArmed) => observeRetryLifecycle({
        context,
        root,
        identity,
        rowRelative,
        samples,
        deadline: processAbsentDeadline,
        onArmed,
        onProcessAbsent: (atMs) => { observedProcessAbsentAtClickResult = atMs; },
      }),
      (onIssued) => {
        retryClickIssuedAtMs = performance.now();
        return clickElement(driver, closeElementId, 'retry real native Close click', processAbsentDeadline, onIssued);
      },
      () => observedProcessAbsentAtClickResult,
    );
    retryClickResult = concurrentResult.clickResult;
    assert.equal(retryClickResult.requestIssued, true, 'The one retry W3C request must have been issued.');
    ({ quantity3Files, quantity3Snapshot, quantity3ObservedAtMs, processAbsentAtMs } = concurrentResult.observation);
    assert.ok(processAbsentAtMs !== null, 'The identified app PID must exit naturally before cleanup.');
    assert.equal(quantityFrom(quantity3Files[rowRelative].bytes), 3);
    assertMetadataUnchanged(markdownInitial, quantity3Files, 'Inventory.md', 'Retry must preserve Inventory schema Markdown');
    assertMetadataUnchanged(markdownInitial, quantity3Files, 'Views.md', 'Retry must preserve Views Markdown');
    assert.notEqual(quantity3Files[rowRelative].sha256, markdownInitial[rowRelative].sha256,
      'Successful retry must persist changed Widget Markdown bytes.');
    assert.equal(quantity3Files[rowRelative].size, Buffer.byteLength(quantity3Files[rowRelative].bytes));
    assert.equal(quantity3Files[rowRelative].mode, targetBefore.mode, 'Retry must preserve the Widget Markdown mode.');
    finalBeforeCleanup = await captureMarkdown(root, processAbsentDeadline);
    assert.equal(quantityFrom(finalBeforeCleanup[rowRelative].bytes), 3, 'Final pre-cleanup row must contain Quantity=3.');
    assertMetadataUnchanged(quantity3Files, finalBeforeCleanup, rowRelative,
      'Final pre-cleanup Widget snapshot must match the persisted Quantity=3 observation');
    assertMetadataUnchanged(markdownInitial, finalBeforeCleanup, 'Inventory.md', 'Final files must preserve Inventory schema Markdown');
    assertMetadataUnchanged(markdownInitial, finalBeforeCleanup, 'Views.md', 'Final files must preserve Views Markdown');
    assert.equal(finalBeforeCleanup[rowRelative].mode, targetBefore.mode, 'Final Widget Markdown mode must match its original mode.');
    const finalDirectory = await directoryState(root, processAbsentDeadline);
    assert.equal(finalDirectory.mode, directoryBefore.mode, 'Final Inventory directory mode must be restored exactly.');
    assert.deepEqual(finalDirectory.entries, directoryBefore.entries, 'Retry must not leave temp files in Inventory.');
    const configFinal = await capturePluginConfiguration(root, processAbsentDeadline);
    assert.equal(configFinal.file.sha256, configBefore.file.sha256);
    assert.equal(configFinal.file.size, configBefore.file.size);
    assert.equal(configFinal.file.mtimeMs, configBefore.file.mtimeMs);
    assert.deepEqual(configFinal.value, configBefore.value);

    const receipt = {
      schema: 'morrow.native-close.receipt',
      version: 1,
      outcome: 'owned-natural-close',
      identity,
      mode: {
        directoryRelative: 'Inventory',
        before: directoryBefore.mode,
        blocked: blockedMode,
        restored: finalDirectory.mode,
        targetFileRelative: rowRelative,
        targetFileModeBefore: targetBefore.mode,
      },
      events: {
        failedSaveClickAtMs,
        firstCloseClickIssuedAtMs,
        firstCloseResolvedAtMs,
        deniedHoldMs,
        observerStartedAtMs,
        retryClickIssuedAtMs,
        quantity3ObservedAtMs,
        processAbsentAtMs,
      },
      deniedClose: {
        selector: CLOSE_SELECTOR,
        elementId: closeElementId,
        clickCount: 1,
        clickResult: 'resolved',
      },
      failedSave: {
        selector: '[data-provider="polaris-dados"] button[data-action="save"]',
        elementId: failedSaveElementId,
        clickCount: 1,
        clickResult: 'resolved',
        errorText: failedSaveErrorText,
      },
      retry: {
        selector: CLOSE_SELECTOR,
        elementId: closeElementId,
        sameElement: sameButton,
        clickCount: 1,
        clickResult: retryClickResult,
      },
      files: {
        initial: summarizeFiles(markdownInitial),
        afterSaveFailure: summarizeFiles(afterSaveFailure),
        afterDeniedClose: summarizeFiles(afterDeniedClose),
        quantity3Sample: quantity3Snapshot,
        finalBeforeCleanup: summarizeFiles(finalBeforeCleanup),
      },
      samples,
    };
    receiptEvidence = await writeReceipt(candidate, receipt, processAbsentDeadline);
    await record(recordStep, 'independent-154-owned-natural-close-verified', {
      receipt: receiptEvidence,
      retry: receipt.retry,
      events: receipt.events,
      files: receipt.files,
      samples: samples.length,
    }, processAbsentDeadline);
    return receipt;
  } catch (error) {
    primaryError = error;
  } finally {
    if (modeBlocked && !modeRestored) {
      try {
        await restoreDirectoryMode();
      } catch (error) {
        cleanupError = error;
      }
    }
    if (primaryError && cleanupError && typeof primaryError === 'object') {
      primaryError.cleanupError = cleanupError;
    }
    if (primaryError) {
      await record(recordStep, 'independent-154-natural-close-failed', {
        error: primaryError instanceof Error ? primaryError.message : String(primaryError),
        cleanupError: cleanupError instanceof Error ? cleanupError.message : null,
        mode: { before: directoryBefore.mode, blocked: blockedMode, restored: modeRestored },
        events: {
          failedSaveClickAtMs,
          firstCloseClickIssuedAtMs,
          firstCloseResolvedAtMs,
          deniedHoldMs,
          observerStartedAtMs,
          retryClickIssuedAtMs,
          quantity3ObservedAtMs,
          processAbsentAtMs,
        },
        samples,
        receiptWritten: receiptEvidence,
      }).catch(() => {});
    }
  }

  if (primaryError) throw primaryError;
}
