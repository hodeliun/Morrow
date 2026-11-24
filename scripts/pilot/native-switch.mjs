// Native two-vault switch proof. All switches are initiated by the real Sidebar
// menu; the only instrumentation wraps the public vault.select bridge method.
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SWITCH_MARKDOWN_PATHS = ['Inventory.md', 'Inventory/Widget.md', 'Views.md'];
export const SWITCH_RECEIPT_SCHEMA = 'morrow.native-switch.receipt';
export const SWITCH_RECEIPT_VERSION = 1;
export const SWITCH_BARRIER_SCRIPT_KEY = '__morrowNativeSwitchBarrierV1';
export const SWITCH_PROFILE_RESTORE_LIMIT_MS = 5_000;
export const SWITCH_BARRIER_WATCHDOG_MS = 30_000;

const SWITCH_WAIT_TIMEOUT_MS = 25_000;
const SWITCH_POLL_INTERVAL_MS = 100;
const PROFILE_MODE_WATCHDOG_MS = 4_000;
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
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

function shortError(error, maxLength = 240) {
  const message = String(error?.message ?? error ?? 'Unknown error')
    .replace(/(?:[A-Za-z]:[\\/]|\/(?:home|tmp|media|mnt|run)\/)[^\s'"<>]*/g, '[path]')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    name: typeof error?.name === 'string' ? error.name.slice(0, 64) : 'Error',
    code: typeof error?.code === 'string' ? error.code.slice(0, 32) : null,
    message: message.slice(0, maxLength),
  };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out waiting for ' + label + '.')), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function waitFor(read, predicate, label, timeoutMs = SWITCH_WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastValue = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      lastValue = await read();
      lastError = null;
      if (predicate(lastValue)) return lastValue;
    } catch (error) {
      lastError = error;
    }
    await delay(Math.min(SWITCH_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  const detail = lastError ? shortError(lastError).message : JSON.stringify(lastValue).slice(0, 500);
  fail('Timed out waiting for ' + label + (detail ? ': ' + detail : '.'));
}

function assertIdentityShape(identity, label) {
  if (!identity || typeof identity !== 'object') fail(label + ' is missing.');
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) fail(label + ' has an invalid PID.');
  if (!/^\d+$/.test(String(identity.startTimeTicks ?? ''))) fail(label + ' has invalid /proc starttime.');
  if (!Number.isInteger(identity.effectiveUid) || identity.effectiveUid <= 0) {
    fail(label + ' must have a non-root effective UID.');
  }
  if (!/^[a-f0-9]{64}$/i.test(identity.executablePathSha256 ?? '')) {
    fail(label + ' has no executable-path digest.');
  }
  if (!/^[a-f0-9]{64}$/i.test(identity.argvSha256 ?? '')) fail(label + ' has no argv digest.');
  if (!Number.isSafeInteger(identity.driverPid) || identity.driverPid <= 0) {
    fail(label + ' has an invalid owning driver PID.');
  }
  if (identity.runtimeIdentityConfirmed !== true)
    fail(label + ' has no confirmed isolated runtime identity.');
  return Object.fromEntries(IDENTITY_KEYS.map((key) => [key, identity[key]]));
}

function sameIdentity(left, right) {
  return Boolean(left && right && IDENTITY_KEYS.every((key) => left[key] === right[key]));
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  );
}

export async function captureNativeSwitchMarkdownFiles(vaultPath) {
  const rootInfo = await lstat(vaultPath);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) fail('Synthetic vault is not a real directory.');
  const root = await realpath(vaultPath);
  const snapshots = {};
  for (const relative of SWITCH_MARKDOWN_PATHS) {
    const file = path.resolve(root, relative);
    if (!isWithin(root, file)) fail('Markdown snapshot escaped the synthetic vault.');
    if (relative.includes(path.sep)) {
      const parent = path.dirname(file);
      const parentInfo = await lstat(parent);
      if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
        fail('Markdown parent is not a real directory: ' + relative);
      }
      if ((await realpath(parent)) !== parent) fail('Markdown parent resolves outside its synthetic path.');
    }
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) fail('Markdown fixture is not a regular file: ' + relative);
    if ((await realpath(file)) !== file)
      fail('Markdown fixture resolves outside its synthetic path: ' + relative);
    const bytes = await readFile(file);
    snapshots[relative] = {
      sha256: sha256(bytes),
      size: bytes.length,
      mtimeMs: info.mtimeMs,
      mode: info.mode & 0o7777,
    };
  }
  return snapshots;
}

export function assertSameNativeSwitchMarkdownFiles(left, right, label) {
  if (!left || !right) fail(label + ' is missing one Markdown snapshot.');
  for (const relative of SWITCH_MARKDOWN_PATHS) {
    for (const key of ['sha256', 'size', 'mtimeMs', 'mode']) {
      if (left[relative]?.[key] !== right[relative]?.[key]) {
        fail(label + ': ' + relative + ' changed ' + key + '.');
      }
    }
  }
  return true;
}

export async function captureFinalNativeSwitchMarkdownFiles(
  vaultPath,
  initialSnapshot,
  { timeoutMs = 2_000 } = {},
) {
  let files;
  try {
    files = await withTimeout(
      captureNativeSwitchMarkdownFiles(vaultPath),
      timeoutMs,
      'final synthetic vault Markdown snapshot',
    );
  } catch (error) {
    return { status: 'error', error: shortError(error) };
  }
  if (!initialSnapshot) {
    return {
      status: 'captured',
      files,
      matchesInitial: null,
      comparisonError: 'Initial Markdown snapshot was unavailable.',
    };
  }
  try {
    assertSameNativeSwitchMarkdownFiles(initialSnapshot, files, 'Final synthetic vault snapshot');
    return { status: 'captured', files, matchesInitial: true };
  } catch (error) {
    return {
      status: 'captured',
      files,
      matchesInitial: false,
      comparisonError: shortError(error),
    };
  }
}

async function captureVaultRegistry(profilePath) {
  const profileInfo = await lstat(profilePath);
  if (profileInfo.isSymbolicLink() || !profileInfo.isDirectory())
    fail('Isolated profile is not a real directory.');
  const profile = await realpath(profilePath);
  if (profile !== path.resolve(profilePath)) fail('Isolated profile path is not canonical.');
  const file = path.join(profile, 'vaults.json');
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile()) fail('Isolated vault registry is not a regular file.');
  const bytes = await readFile(file);
  if (bytes.length > 64 * 1024) fail('Isolated vault registry exceeds the evidence bound.');
  const parsed = JSON.parse(bytes.toString('utf8'));
  const recent = Array.isArray(parsed.recent) ? parsed.recent : [];
  return {
    path: file,
    sha256: sha256(bytes),
    size: bytes.length,
    mtimeMs: info.mtimeMs,
    mode: info.mode & 0o7777,
    current: typeof parsed.current === 'string' ? parsed.current : null,
    recentPaths: recent
      .map((item) => (typeof item?.path === 'string' ? item.path : null))
      .filter(Boolean)
      .slice(0, 20),
    recentCount: recent.length,
  };
}

function assertRegisteredRegistry(registry, originPath, destinationPath, currentPath, label) {
  if (registry.current !== currentPath) {
    fail(label + ': registry current does not identify the expected selected vault.');
  }
  for (const vaultPath of [originPath, destinationPath]) {
    if (!registry.recentPaths.includes(vaultPath)) {
      fail(label + ': both synthetic vault paths must remain registered.');
    }
  }
}

function elementId(element) {
  return element?.[ELEMENT_KEY] ?? element?.ELEMENT ?? null;
}

async function getElementText(driver, id) {
  return driver.request('GET', driver.path('/element/' + id + '/text'));
}

async function clickElement(driver, id, timeoutMs = 5_000) {
  const startedAtMs = performance.now();
  let requestIssued = false;
  try {
    const endpoint = driver.path('/element/' + id + '/click');
    requestIssued = true;
    const response = await withTimeout(
      driver.request('POST', endpoint, {}),
      timeoutMs,
      'WebDriver click response',
    );
    return {
      kind: 'resolved',
      response: response == null ? null : String(response).slice(0, 120),
      requestIssued,
      elapsedMs: performance.now() - startedAtMs,
    };
  } catch (error) {
    return {
      kind: 'webdriver-error-or-timeout',
      error: shortError(error),
      requestIssued,
      elapsedMs: performance.now() - startedAtMs,
    };
  }
}

async function openVaultMenu(driver) {
  const brand = await driver.elements('.sidebar .sidebar-header button.brand');
  if (brand.length !== 1) fail('Expected exactly one real Sidebar vault chooser control.');
  const brandId = elementId(brand[0]);
  if (!brandId) fail('Sidebar brand control has no WebDriver element ID.');
  await clickElement(driver, brandId);
  return waitFor(
    async () => {
      const menus = await driver.elements('.menu[role="menu"]');
      if (menus.length !== 1) return null;
      const label = await driver.attribute('.menu[role="menu"]', 'aria-label');
      return label === 'Vaults' ? menus[0] : null;
    },
    Boolean,
    'the real Sidebar vault menu',
    5_000,
  );
}

async function resolveVaultMenuItem(driver, targetPath) {
  await openVaultMenu(driver);
  const expectedName = path.basename(targetPath);
  const items = await driver.elements('.menu[role="menu"] button[role="menuitemradio"]');
  const matches = [];
  for (const item of items) {
    const id = elementId(item);
    if (!id) fail('Vault menu item has no WebDriver element ID.');
    const text = String(await getElementText(driver, id)).trim();
    if (text === expectedName) matches.push({ id, text });
  }
  if (matches.length !== 1) {
    fail(
      'Could not resolve exactly one registered Sidebar menu item for synthetic vault basename ' +
        expectedName +
        '.',
    );
  }
  return { selector: '.menu[role="menu"] button[role="menuitemradio"]', ...matches[0] };
}

async function observeUi(driver, pluginId = 'polaris-dados') {
  return driver.execute(
    `
    const providerId = arguments[0];
    const root = document.querySelector('.app > main.main');
    const brand = document.querySelector('.sidebar .sidebar-header button.brand');
    const providers = [...document.querySelectorAll('[data-provider="' + providerId + '"]')];
    const provider = providers[0];
    const quantity = provider?.querySelector('[data-field="quantity"]')?.textContent?.trim() ?? null;
    const price = provider?.querySelector('[data-field="price"]')?.textContent?.trim() ?? null;
    const total = provider?.querySelector('[data-field="total"]')?.textContent?.trim() ?? null;
    const statuses = [...document.querySelectorAll('[role="alert"], [role="status"]')]
      .map((node) => (node.innerText || node.textContent || '').trim().replace(/\\\\s+/g, ' ').slice(0, 180))
      .filter(Boolean).slice(0, 6);
    return {
      readyState: document.readyState,
      timeOrigin: performance.timeOrigin,
      route: location.hash,
      appMain: root !== null,
      brandPath: brand?.getAttribute('title') ?? null,
      providerCount: providers.length,
      quantity,
      price,
      total,
      editCount: document.querySelectorAll('[data-provider="' + providerId + '"] button[data-action="edit"][data-field="quantity"]').length,
      editorCount: document.querySelectorAll('[data-provider="' + providerId + '"] input[data-field="quantity"]').length,
      statuses,
    };
  `,
    [pluginId],
  );
}

async function readOpenVaultMarker(driver, expectedMarker, timeoutMs = 5_000) {
  const key = '__morrowNativeSwitchRead_' + randomUUID().replace(/-/g, '');
  const started = await withTimeout(
    driver.execute(
      `
    const key = arguments[0];
    const relativePath = arguments[1];
    const marker = arguments[2];
    const state = { status: 'pending', matches: false, length: null, error: null };
    window[key] = state;
    const readText = window.morrow?.vault?.readText;
    if (typeof readText !== 'function') {
      state.status = 'failed';
      state.error = 'public vault.readText method is missing';
      return { status: state.status, error: state.error };
    }
    try {
      Promise.resolve(readText.call(window.morrow.vault, relativePath)).then((text) => {
        if (window[key] !== state) return;
        state.status = 'fulfilled';
        state.matches = typeof text === 'string' && text.includes(marker);
        state.length = typeof text === 'string' ? text.length : null;
      }, (error) => {
        if (window[key] !== state) return;
        state.status = 'rejected';
        state.error = String(error?.message ?? error).slice(0, 180);
      });
    } catch (error) {
      state.status = 'rejected';
      state.error = String(error?.message ?? error).slice(0, 180);
    }
    return { status: state.status };
  `,
      [key, 'Views.md', 'Synthetic vault marker: ' + expectedMarker],
    ),
    timeoutMs,
    'public vault.readText probe start',
  );
  if (started?.status === 'failed' || started?.status === 'rejected') {
    fail('Public vault.readText probe failed: ' + String(started.error ?? 'unknown error'));
  }
  const result = await waitFor(
    () =>
      withTimeout(
        driver.execute(
          `
      const state = window[arguments[0]];
      if (!state) return null;
      return { status: state.status, matches: state.matches, length: state.length, error: state.error };
    `,
          [key],
        ),
        timeoutMs,
        'public vault.readText probe poll',
      ),
    (value) => value?.status === 'fulfilled' || value?.status === 'rejected',
    'public readText marker in the currently open vault',
    timeoutMs,
  );
  let cleanupError = null;
  try {
    await driver.execute('delete window[arguments[0]]; return true;', [key]);
  } catch (error) {
    cleanupError = shortError(error);
  }
  if (cleanupError) fail('Could not remove the public readText observation state: ' + cleanupError.message);
  if (result.status !== 'fulfilled')
    fail('Public vault.readText rejected: ' + String(result.error ?? 'unknown error'));
  return {
    api: 'window.morrow.vault.readText',
    relativePath: 'Views.md',
    marker: expectedMarker,
    matches: result.matches === true,
    textLength: Number.isSafeInteger(result.length) ? result.length : null,
    cleanupError,
  };
}

async function navigateToSourceDatabase(driver, databaseId, expectedQuantity) {
  if (typeof databaseId !== 'string' || databaseId.length === 0) {
    fail('Synthetic source database ID is missing for the post-reload UI check.');
  }
  await withTimeout(
    driver.execute("location.hash = '#/page/' + encodeURIComponent(arguments[0]);", [databaseId]),
    5_000,
    'synthetic source UI route',
  );
  return waitFor(
    () => withTimeout(observeUi(driver), 5_000, 'synthetic source UI observation'),
    (value) =>
      value?.appMain === true && value.providerCount === 1 && value.quantity === String(expectedQuantity),
    'the real synthetic source UI grid',
  );
}

async function waitForReload(context, before, targetPath, expectedMarker, expectedQuantity) {
  const driver = context.driver;
  const targetRealPath = await realpath(targetPath);
  const newDocument = await waitFor(
    () => withTimeout(observeUi(driver), 5_000, 'new-document DOM observation'),
    (value) =>
      value?.readyState === 'complete' &&
      Number.isFinite(value.timeOrigin) &&
      value.timeOrigin !== before.timeOrigin &&
      value.brandPath === targetRealPath &&
      value.appMain === true,
    'actual helper reload and destination document',
  );
  const runtime = await context.verifyRuntimeIdentity();
  const afterIdentity = assertIdentityShape(await context.readOwnedAppIdentity(), 'post-reload app identity');
  const beforeIdentity = assertIdentityShape(context.ownedAppIdentity, 'pre-reload app identity');
  if (!sameIdentity(beforeIdentity, afterIdentity)) {
    fail(
      'App process ownership changed across helper reload; no new process/session is assumed by this probe.',
    );
  }
  if (runtime?.dataPath !== context.candidate.expectedBackendDataPath) {
    fail('Runtime backend profile changed after the helper reload.');
  }
  const marker = await readOpenVaultMarker(driver, expectedMarker);
  if (!marker.matches) fail('The public readText marker does not identify the expected OPEN destination.');
  const expectedDatabaseId =
    targetRealPath === (await realpath(context.candidate.vault))
      ? context.candidate.databaseId
      : context.candidate.destinationDatabaseId;
  const ui = await navigateToSourceDatabase(driver, expectedDatabaseId, expectedQuantity);
  return {
    timeOriginBefore: before.timeOrigin,
    timeOriginAfter: newDocument.timeOrigin,
    newDocument: {
      readyState: newDocument.readyState,
      route: newDocument.route,
      appMain: newDocument.appMain,
      brandPath: newDocument.brandPath,
    },
    dom: {
      readyState: ui.readyState,
      route: ui.route,
      appMain: ui.appMain,
      brandPath: ui.brandPath,
      providerCount: ui.providerCount,
      quantity: ui.quantity,
      price: ui.price,
      total: ui.total,
    },
    openMarker: marker,
    runtime: {
      dataPath: runtime.dataPath,
      webviewDataPath: runtime.webviewDataPath ?? null,
    },
    ownedAppIdentity: afterIdentity,
  };
}

async function readProfileRegistryBounded(profile) {
  return withTimeout(captureVaultRegistry(profile), 2_000, 'isolated vault registry snapshot');
}

export async function withSyntheticProfileDirectoryWriteDenied(
  profilePath,
  callback,
  {
    expectedUid = typeof process.geteuid === 'function' ? process.geteuid() : null,
    watchdogMs = PROFILE_MODE_WATCHDOG_MS,
  } = {},
) {
  if (typeof callback !== 'function') fail('Profile permission callback is required.');
  if (expectedUid === null || expectedUid === 0)
    fail('Profile permission probe requires a non-root effective UID.');
  if (!Number.isInteger(watchdogMs) || watchdogMs < 1 || watchdogMs > PROFILE_MODE_WATCHDOG_MS) {
    fail('Profile restoration watchdog must be between 1 and 4000 ms.');
  }
  const profileInfo = await lstat(profilePath);
  if (profileInfo.isSymbolicLink() || !profileInfo.isDirectory())
    fail('Profile permission target is not a real directory.');
  const canonicalProfile = await realpath(profilePath);
  if (canonicalProfile !== path.resolve(profilePath)) fail('Profile permission target is not canonical.');
  if (profileInfo.uid !== expectedUid) fail('Profile directory is not owned by the expected non-root UID.');
  const beforeMode = profileInfo.mode & 0o7777;
  const blockedMode = beforeMode & ~0o222;
  if ((beforeMode & 0o222) === 0) fail('Profile directory had no write permission to remove.');
  if ((blockedMode & 0o555) !== (beforeMode & 0o555)) fail('Write denial changed profile read/execute bits.');

  let restorePromise = null;
  let restoreResult = null;
  let restoreError = null;
  let watchdogFired = false;
  let blockedAt = null;
  let autoRestoreTimer = null;
  const restore = (reason) => {
    if (restorePromise) return restorePromise;
    restorePromise = (async () => {
      const current = await lstat(canonicalProfile);
      if (current.isSymbolicLink() || !current.isDirectory()) {
        fail('Profile directory changed identity while write permission was denied.');
      }
      if ((current.mode & 0o7777) !== blockedMode) {
        fail('Profile mode changed unexpectedly while the synthetic write failure was active.');
      }
      await chmod(canonicalProfile, beforeMode);
      const restored = await lstat(canonicalProfile);
      const elapsedMs = blockedAt === null ? 0 : performance.now() - blockedAt;
      if ((restored.mode & 0o7777) !== beforeMode) fail('Profile directory mode was not restored exactly.');
      if (elapsedMs > SWITCH_PROFILE_RESTORE_LIMIT_MS) {
        fail('Profile directory mode restoration exceeded the 5 second limit.');
      }
      restoreResult = {
        reason,
        before: beforeMode,
        blocked: blockedMode,
        restored: restored.mode & 0o7777,
        elapsedMs,
        readExecutePreserved: (blockedMode & 0o555) === (beforeMode & 0o555),
      };
      return restoreResult;
    })();
    return restorePromise;
  };

  await chmod(canonicalProfile, blockedMode);
  blockedAt = performance.now();
  let value;
  let primaryError = null;
  try {
    const verified = await lstat(canonicalProfile);
    if ((verified.mode & 0o7777) !== blockedMode)
      fail('Profile mode did not enter the expected write-denied state.');
    autoRestoreTimer = setTimeout(() => {
      watchdogFired = true;
      void restore('node-watchdog').catch((error) => {
        restoreError = error;
      });
    }, watchdogMs);
    value = await callback({
      mode: {
        before: beforeMode,
        blocked: blockedMode,
        readExecutePreserved: (blockedMode & 0o555) === (beforeMode & 0o555),
      },
      restoreDeadlineMs: SWITCH_PROFILE_RESTORE_LIMIT_MS,
    });
  } catch (error) {
    primaryError = error;
  } finally {
    if (autoRestoreTimer) clearTimeout(autoRestoreTimer);
    try {
      await withTimeout(
        restore('finally'),
        SWITCH_PROFILE_RESTORE_LIMIT_MS,
        'exact profile mode restoration',
      );
    } catch (error) {
      restoreError = error;
    }
  }
  if (primaryError) {
    let annotationError = null;
    try {
      Object.defineProperty(primaryError, 'nativeSwitchProfileWriteDenied', {
        value: {
          before: beforeMode,
          blocked: blockedMode,
          restore: restoreResult,
          restoreError: restoreError ? shortError(restoreError) : null,
          watchdogFired,
        },
        configurable: true,
      });
    } catch (error) {
      annotationError = error;
    }
    if (restoreError || annotationError) {
      throw new AggregateError(
        [
          primaryError,
          ...(restoreError ? [restoreError] : []),
          ...(annotationError ? [annotationError] : []),
        ],
        'The profile write-denial callback failed and profile restoration evidence could not be fully attached.',
        { cause: primaryError },
      );
    }
    throw primaryError;
  }
  if (restoreError) throw restoreError;
  return { value, restore: restoreResult, watchdogFired };
}

export function buildVaultSelectBarrierScript() {
  return String.raw`
    const [action, key, targetPath, watchdogMs] = arguments;
    const ownerWindow = window;
    const getState = () => ownerWindow[key];
    const snapshot = (state) => ({
      schema: state.schema,
      version: state.version,
      phase: state.phase,
      targetPath: state.targetPath,
      descriptor: state.descriptor,
      callCount: state.callCount,
      originalCallCount: state.originalCallCount,
      interceptedCallCount: state.interceptedCallCount,
      targetMatched: state.targetMatched,
      thisMatched: state.thisMatched,
      argsCount: state.argsCount,
      settlement: state.settlement,
      restoreOutcome: state.restoreOutcome,
      restoreError: state.restoreError,
      releaseRequested: state.releaseRequested,
      releaseSource: state.releaseSource,
      watchdogFired: state.watchdogFired,
      delivered: state.delivered,
      unexpectedCalls: state.unexpectedCalls.slice(0, 4),
    });
    if (action === 'install') {
      if (getState()) throw new Error('Vault select barrier key is already in use.');
      if (typeof targetPath !== 'string' || !targetPath.startsWith('/')) {
        throw new Error('Vault select barrier requires the exact absolute synthetic target path.');
      }
      if (!Number.isInteger(watchdogMs) || watchdogMs < 1 || watchdogMs > 30000) {
        throw new Error('Vault select barrier watchdog is outside its bounded range.');
      }
      const vault = ownerWindow.morrow && ownerWindow.morrow.vault;
      if (!vault || typeof vault.select !== 'function') throw new Error('Public window.morrow.vault.select is unavailable.');
      let descriptorOwner = vault;
      let descriptor = null;
      let descriptorDepth = 0;
      while (descriptorOwner !== null && descriptorDepth < 16) {
        descriptor = Object.getOwnPropertyDescriptor(descriptorOwner, 'select');
        if (descriptor) break;
        descriptorOwner = Object.getPrototypeOf(descriptorOwner);
        descriptorDepth += 1;
      }
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new Error('Public vault.select descriptor is missing or is an accessor.');
      }
      const original = vault.select;
      if (typeof original !== 'function' || descriptor.value !== original) {
        throw new Error('Public vault.select descriptor does not resolve to its validated function.');
      }
      const ownBefore = Object.getOwnPropertyDescriptor(vault, 'select') || null;
      if (ownBefore && ownBefore.configurable !== true && ownBefore.writable !== true) {
        throw new Error('Public own vault.select descriptor cannot be temporarily decorated.');
      }
      if (!ownBefore && !Object.isExtensible(vault)) {
        throw new Error('Public vault object cannot shadow its inherited select method.');
      }
      let heldKind = null;
      let heldValue;
      let originalSettled = false;
      let heldPromiseResolved = false;
      let resolveHeld;
      let rejectHeld;
      const heldPromise = new Promise((resolve, reject) => {
        resolveHeld = resolve;
        rejectHeld = reject;
      });
      const state = {
        schema: 'morrow.native-switch-barrier',
        version: 1,
        phase: 'installed',
        targetPath,
        descriptor: {
          owner: descriptorOwner === vault ? 'own' : 'inherited',
          depth: descriptorDepth,
          kind: 'data',
          configurable: descriptor.configurable === true,
          enumerable: descriptor.enumerable === true,
          writable: descriptor.writable === true,
        },
        callCount: 0,
        originalCallCount: 0,
        interceptedCallCount: 0,
        targetMatched: false,
        thisMatched: null,
        argsCount: null,
        settlement: null,
        restoreOutcome: 'pending',
        restoreError: null,
        releaseRequested: false,
        releaseSource: null,
        watchdogFired: false,
        delivered: false,
        unexpectedCalls: [],
        snapshot: null,
        restore: null,
        release: null,
        watchdogTimer: null,
      };
      const deliver = () => {
        if (!state.releaseRequested || !originalSettled || heldPromiseResolved) return false;
        heldPromiseResolved = true;
        state.delivered = true;
        state.phase = 'released-real-settlement';
        if (state.watchdogTimer !== null) clearTimeout(state.watchdogTimer);
        if (heldKind === 'fulfilled') resolveHeld(heldValue);
        else rejectHeld(heldValue);
        return true;
      };
      const settleOriginal = (kind, value) => {
        if (originalSettled) return;
        originalSettled = true;
        heldKind = kind;
        heldValue = value;
        state.settlement = {
          kind,
          observedAtMs: performance.now(),
          resultOk: kind === 'fulfilled' && value !== null && typeof value === 'object' && value.ok === true,
          resultFailed: kind === 'fulfilled' && value !== null && typeof value === 'object' && value.ok === false,
          errorName: kind === 'rejected' && value && typeof value.name === 'string' ? value.name.slice(0, 64) : null,
          errorMessage: kind === 'rejected' ? String(value && value.message !== undefined ? value.message : value).slice(0, 180) : null,
        };
        state.phase = state.releaseRequested ? 'settled-after-release-request' : 'settled-held';
        deliver();
      };
      const wrapper = function(...args) {
        state.callCount += 1;
        const isExpectedOneShot = state.callCount === 1 && args.length > 0 && args[0] === targetPath;
        if (!isExpectedOneShot) {
          state.unexpectedCalls.push({
            call: state.callCount,
            targetMatched: args.length > 0 && args[0] === targetPath,
            argsCount: args.length,
          });
          state.originalCallCount += 1;
          return Reflect.apply(original, this, args);
        }
        state.interceptedCallCount += 1;
        state.targetMatched = true;
        state.thisMatched = this === vault;
        state.argsCount = args.length;
        state.originalCallCount += 1;
        state.phase = 'original-pending';
        try {
          const realSettlement = Reflect.apply(original, this, args);
          Promise.resolve(realSettlement).then(
            (value) => settleOriginal('fulfilled', value),
            (error) => settleOriginal('rejected', error),
          );
        } catch (error) {
          settleOriginal('rejected', error);
        }
        return heldPromise;
      };
      const wrappedDescriptor = ownBefore
        ? { ...ownBefore, value: wrapper }
        : { configurable: true, enumerable: descriptor.enumerable === true, writable: true, value: wrapper };
      Object.defineProperty(vault, 'select', wrappedDescriptor);
      state.snapshot = () => snapshot(state);
      state.restore = () => {
        if (state.restoreOutcome !== 'pending') return state.restoreOutcome === 'restored';
        try {
          const current = Object.getOwnPropertyDescriptor(vault, 'select');
          if (!current || current.value !== wrapper) {
            state.restoreOutcome = 'not-owned';
            return false;
          }
          if (ownBefore) Object.defineProperty(vault, 'select', ownBefore);
          else if (!Reflect.deleteProperty(vault, 'select')) {
            state.restoreOutcome = 'delete-refused';
            return false;
          }
          state.restoreOutcome = 'restored';
          if (vault.select !== original) state.restoreOutcome = 'restore-mismatch';
          state.phase = state.releaseRequested ? 'restore-after-release-request' : 'restored-awaiting-release';
          return state.restoreOutcome === 'restored';
        } catch (error) {
          state.restoreOutcome = 'restore-error';
          state.restoreError = {
            name: error && typeof error.name === 'string' ? error.name.slice(0, 64) : 'Error',
            message: String(error && error.message !== undefined ? error.message : error)
              .replace(/\s+/g, ' ')
              .slice(0, 180),
          };
          state.phase = 'restore-error';
          return false;
        }
      };
      state.release = (source) => {
        if (state.releaseRequested) return false;
        if (state.restoreOutcome === 'pending') return false;
        state.releaseRequested = true;
        state.releaseSource = source;
        state.phase = originalSettled ? 'release-requested' : 'release-requested-awaiting-real-settlement';
        deliver();
        return true;
      };
      ownerWindow[key] = state;
      state.watchdogTimer = setTimeout(() => {
        state.watchdogFired = true;
        state.phase = 'watchdog-fired';
        try {
          state.restore();
        } catch (error) {
          state.restoreOutcome = 'restore-error';
          state.restoreError = {
            name: error && typeof error.name === 'string' ? error.name.slice(0, 64) : 'Error',
            message: String(error && error.message !== undefined ? error.message : error)
              .replace(/\s+/g, ' ')
              .slice(0, 180),
          };
        } finally {
          state.release('page-watchdog');
        }
      }, watchdogMs);
      return snapshot(state);
    }
    const state = getState();
    if (!state) throw new Error('Vault select barrier state is unavailable.');
    if (action === 'read') return snapshot(state);
    if (action === 'restore') {
      const restored = state.restore();
      return { restored, state: snapshot(state) };
    }
    if (action === 'release') {
      const requested = state.release('harness');
      return { requested, state: snapshot(state) };
    }
    throw new Error('Unknown vault select barrier action.');
  `;
}

async function executeBarrier(driver, action, key, targetPath, watchdogMs = SWITCH_BARRIER_WATCHDOG_MS) {
  return withTimeout(
    driver.execute(buildVaultSelectBarrierScript(), [action, key, targetPath, watchdogMs]),
    5_000,
    'serialized vault.select barrier ' + action,
  );
}

function isPermissionFailure(text) {
  return typeof text === 'string' && /(permission denied|os error 13|eacces)/i.test(text);
}

async function observeEditFence(driver) {
  return driver.execute(`
    const selector = '[data-provider="polaris-dados"] button[data-action="edit"][data-field="quantity"]';
    const edit = document.querySelector(selector);
    let node = edit;
    let inertAncestor = false;
    while (node) {
      if (node.inert || node.hasAttribute('inert')) inertAncestor = true;
      node = node.parentElement;
    }
    const provider = document.querySelector('[data-provider="polaris-dados"]');
    return {
      editCount: document.querySelectorAll(selector).length,
      disabled: edit?.disabled === true,
      ariaDisabled: edit?.getAttribute('aria-disabled') === 'true',
      inertAncestor,
      inputCount: provider?.querySelectorAll('input[data-field="quantity"]').length ?? 0,
      quantity: provider?.querySelector('[data-field="quantity"]')?.textContent?.trim() ?? null,
    };
  `);
}

async function attemptW3cEditDuringBarrier(driver) {
  const before = await withTimeout(observeEditFence(driver), 4_000, 'pre-edit fence observation');
  if (before.editCount !== 1) fail('Expected one real Quantity edit control during the held switch.');
  const items = await driver.elements(
    '[data-provider="polaris-dados"] button[data-action="edit"][data-field="quantity"]',
  );
  if (items.length !== 1) fail('W3C could not resolve the unique real Quantity edit control.');
  const id = elementId(items[0]);
  if (!id) fail('Quantity edit control has no WebDriver element ID.');
  const click = await clickElement(driver, id, 3_000);
  await delay(120);
  const after = await withTimeout(observeEditFence(driver), 4_000, 'post-edit fence observation');
  if (before.quantity !== after.quantity || after.inputCount !== 0) {
    fail('A real W3C edit attempt changed the origin UI draft while the select response was held.');
  }
  const refusedByVisibleFence =
    before.disabled ||
    before.ariaDisabled ||
    before.inertAncestor ||
    after.disabled ||
    after.ariaDisabled ||
    after.inertAncestor;
  if (!refusedByVisibleFence) {
    fail('The W3C edit attempt was not visibly refused by a disabled control or inert exit-fenced UI.');
  }
  if (click.kind === 'resolved' && !refusedByVisibleFence) {
    fail('W3C click resolved without visible fence evidence.');
  }
  return { click, before, after, refusedByVisibleFence };
}

async function writeReceipt(candidate, receipt) {
  const file = path.join(candidate.evidence, 'native-switch-receipt.json');
  await writeFile(file, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return file;
}

export async function runNativeSwitchScenario(context) {
  const { candidate, recordStep } = context;
  const driver = context.driver;
  const runnerUid = typeof process.geteuid === 'function' ? process.geteuid() : null;
  const initialIdentity = assertIdentityShape(context.ownedAppIdentity, 'initial owned app identity');
  if (runnerUid === null || runnerUid === 0 || initialIdentity.effectiveUid !== runnerUid) {
    fail('Native switch scenario requires the owned app and runner to share a non-root effective UID.');
  }
  if (!candidate?.vault || !candidate?.destinationVault || !candidate?.profile || !candidate?.evidence) {
    fail('Native switch candidate is missing its two vaults, profile, or evidence directory.');
  }
  const originPath = await realpath(candidate.vault);
  const destinationPath = await realpath(candidate.destinationVault);
  if (originPath === destinationPath) fail('Synthetic origin and destination paths must differ.');
  const originMarker = 'OPEN-OLD';
  const destinationMarker = 'OPEN-DESTINATION';
  const receipt = {
    schema: SWITCH_RECEIPT_SCHEMA,
    version: SWITCH_RECEIPT_VERSION,
    outcome: 'running',
    startedAt: new Date().toISOString(),
    candidate: {
      expectedCommit: candidate.expectedCommit ?? null,
      binarySha256: candidate.binarySha256 ?? null,
      bundleSha256: candidate.bundleSha256 ?? null,
      manifestSha256: candidate.manifestSha256 ?? null,
      sourceManifestSha256: candidate.sourceManifestSha256 ?? null,
      artifactManifestSha256: candidate.artifactManifestSha256 ?? null,
    },
    identity: { initial: initialIdentity, reloads: [] },
    profile: {
      path: candidate.profile,
      registryPath: path.join(candidate.profile, 'vaults.json'),
      directoryOwnerUid: null,
      directoryMode: null,
    },
    vaults: { originPath, destinationPath, originMarker, destinationMarker },
    reloads: [],
    failure: null,
    barrier: null,
    markdown: {},
    limits: [
      'The barrier holds the real result only after the Rust command has settled.',
      'No claim is made that Rust or filesystem execution was blocked.',
      'A helper reload may preserve the same app PID and WebDriver session.',
    ],
  };
  let primaryError = null;
  let barrierMayExist = false;
  let barrierInstalled = false;
  let barrierClickIssued = false;
  let barrierReleaseExpectedReload = false;
  const barrierKey = '__morrowNativeSwitchBarrier_' + randomUUID().replace(/-/g, '');
  try {
    const profileInfo = await lstat(candidate.profile);
    if (profileInfo.isSymbolicLink() || !profileInfo.isDirectory() || profileInfo.uid !== runnerUid) {
      fail('Isolated profile ownership or directory type is invalid before the scenario.');
    }
    receipt.profile.directoryOwnerUid = profileInfo.uid;
    receipt.profile.directoryMode = profileInfo.mode & 0o7777;
    const initialRegistry = await readProfileRegistryBounded(candidate.profile);
    assertRegisteredRegistry(initialRegistry, originPath, destinationPath, originPath, 'Initial registry');
    receipt.profile.initialRegistry = initialRegistry;

    const initialMarkerProbe = await readOpenVaultMarker(driver, originMarker);
    if (!initialMarkerProbe.matches) fail('Initial public readText marker does not identify OPEN origin.');
    const initialUi = await navigateToSourceDatabase(driver, candidate.databaseId, 2);
    if (
      initialUi.readyState !== 'complete' ||
      initialUi.brandPath !== originPath ||
      initialUi.providerCount !== 1 ||
      initialUi.quantity !== '2'
    ) {
      fail('Initial real UI does not identify the OPEN origin synthetic vault.');
    }
    receipt.initial = {
      timeOrigin: initialUi.timeOrigin,
      dom: initialUi,
      openMarker: initialMarkerProbe,
      markdownOrigin: await captureNativeSwitchMarkdownFiles(originPath),
      markdownDestination: await captureNativeSwitchMarkdownFiles(destinationPath),
    };
    receipt.markdown.originInitial = receipt.initial.markdownOrigin;
    receipt.markdown.destinationInitial = receipt.initial.markdownDestination;
    await recordStep('switch-initial-origin-confirmed', {
      timeOrigin: initialUi.timeOrigin,
      originPath,
      destinationPath,
      openMarker: initialMarkerProbe.marker,
      registeredVaultCount: initialRegistry.recentCount,
    });

    // A -> B, selected through the real Sidebar menu with no instrumentation.
    const firstItem = await resolveVaultMenuItem(driver, destinationPath);
    await context.beginRuntimeRefresh();
    const firstClick = await clickElement(driver, firstItem.id);
    const firstReload = await waitForReload(context, initialUi, destinationPath, destinationMarker, 5);
    receipt.reloads.push({
      phase: 'normal-origin-to-destination',
      from: originPath,
      to: destinationPath,
      entry: 'Sidebar.recent-vaults',
      itemLabel: firstItem.text,
      click: firstClick,
      ...firstReload,
    });
    receipt.identity.reloads.push(firstReload.ownedAppIdentity);
    const destinationRegistry = await readProfileRegistryBounded(candidate.profile);
    assertRegisteredRegistry(
      destinationRegistry,
      originPath,
      destinationPath,
      destinationPath,
      'Registry after normal A-to-B',
    );
    receipt.reloads[0].registry = destinationRegistry;
    await recordStep('switch-normal-a-to-b-reloaded-destination', {
      timeOriginBefore: firstReload.timeOriginBefore,
      timeOriginAfter: firstReload.timeOriginAfter,
      quantity: firstReload.dom.quantity,
      marker: firstReload.openMarker.marker,
      clickKind: firstClick.kind,
    });

    // B -> A, fail a real registry atomic write by denying profile-dir writes.
    const destinationBeforeFailure = await captureNativeSwitchMarkdownFiles(destinationPath);
    const failureRegistryBefore = await readProfileRegistryBounded(candidate.profile);
    const retryItem = await resolveVaultMenuItem(driver, originPath);
    const blockedSelectTemp = path.join(candidate.profile, 'vaults.json.tmp');
    try {
      await lstat(blockedSelectTemp);
      fail('A vault registry temp file unexpectedly exists before the failure probe.');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const failureUiBefore = await withTimeout(observeUi(driver), 4_000, 'pre-failure B UI');
    if (
      failureUiBefore.timeOrigin !== firstReload.timeOriginAfter ||
      failureUiBefore.brandPath !== destinationPath ||
      failureUiBefore.providerCount !== 1 ||
      failureUiBefore.quantity !== '5'
    ) {
      fail('Failure probe did not begin from the OPEN destination UI.');
    }
    const permissionWindow = await withSyntheticProfileDirectoryWriteDenied(
      candidate.profile,
      async ({ mode }) => {
        if ((mode.blocked & 0o555) !== (mode.before & 0o555)) {
          fail('The profile write-denial probe changed read/execute permissions.');
        }
        const click = await clickElement(driver, retryItem.id, 2_500);
        const failedUi = await waitFor(
          () => withTimeout(observeUi(driver), 1_500, 'post-failure UI observation'),
          (value) =>
            value?.timeOrigin === failureUiBefore.timeOrigin &&
            value?.brandPath === destinationPath &&
            value?.statuses?.some(isPermissionFailure),
          'real permission error without helper reload',
          2_500,
        );
        return { click, failedUi };
      },
      { expectedUid: runnerUid },
    );
    const failedUi = permissionWindow.value.failedUi;
    const failureRegistryAfter = await readProfileRegistryBounded(candidate.profile);
    if (
      failureRegistryAfter.sha256 !== failureRegistryBefore.sha256 ||
      failureRegistryAfter.current !== destinationPath
    ) {
      fail('Failed atomic registry write unexpectedly changed vaults.json.');
    }
    try {
      await lstat(blockedSelectTemp);
      fail('Failed selection left an unexpected vaults.json.tmp file.');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const openAfterFailure = await readOpenVaultMarker(driver, destinationMarker);
    if (!openAfterFailure.matches)
      fail('OPEN destination was not readable through public vault.readText after failure.');
    if (!failedUi.appMain || failedUi.providerCount !== 1 || failedUi.quantity !== '5') {
      fail('Open destination UI was not usable after the real selection failure.');
    }
    const destinationAfterFailure = await captureNativeSwitchMarkdownFiles(destinationPath);
    assertSameNativeSwitchMarkdownFiles(
      destinationBeforeFailure,
      destinationAfterFailure,
      'Known selection failure',
    );
    receipt.failure = {
      phase: 'destination-to-origin-known-permission-denial',
      from: destinationPath,
      to: originPath,
      entry: 'Sidebar.recent-vaults',
      itemLabel: retryItem.text,
      click: permissionWindow.value.click,
      timeOrigin: failureUiBefore.timeOrigin,
      errorText: failedUi.statuses.filter(isPermissionFailure).slice(0, 2),
      registryBefore: failureRegistryBefore,
      registryAfter: failureRegistryAfter,
      openMarkerAfterFailure: openAfterFailure,
      uiAfterFailure: failedUi,
      mode: {
        ...permissionWindow.restore,
        watchdogFired: permissionWindow.watchdogFired,
      },
      markdownBefore: destinationBeforeFailure,
      markdownAfter: destinationAfterFailure,
      tempFileAbsent: true,
      noReload: true,
    };
    if (permissionWindow.watchdogFired)
      fail('Profile permission watchdog had to restore before the expected UI failure completed.');
    if (!permissionWindow.restore || permissionWindow.restore.restored !== permissionWindow.restore.before) {
      fail('Profile directory mode was not restored exactly.');
    }
    await recordStep('switch-real-profile-permission-failure-kept-open-destination', {
      timeOrigin: failedUi.timeOrigin,
      openMarker: openAfterFailure.marker,
      registrySha256Preserved: failureRegistryBefore.sha256 === failureRegistryAfter.sha256,
      mode: receipt.failure.mode,
      error: receipt.failure.errorText,
    });

    // Retry B -> A using the UI after exact mode restoration.
    const restoredMode = (await lstat(candidate.profile)).mode & 0o7777;
    if (restoredMode !== receipt.failure.mode.before) fail('Profile mode is not exact before retry.');
    const retryOriginItem = await resolveVaultMenuItem(driver, originPath);
    await context.beginRuntimeRefresh();
    const retryClick = await clickElement(driver, retryOriginItem.id);
    const retryReload = await waitForReload(context, failureUiBefore, originPath, originMarker, 2);
    receipt.reloads.push({
      phase: 'retry-destination-to-origin',
      from: destinationPath,
      to: originPath,
      entry: 'Sidebar.recent-vaults',
      itemLabel: retryOriginItem.text,
      click: retryClick,
      ...retryReload,
    });
    receipt.identity.reloads.push(retryReload.ownedAppIdentity);
    const retryRegistry = await readProfileRegistryBounded(candidate.profile);
    assertRegisteredRegistry(
      retryRegistry,
      originPath,
      destinationPath,
      originPath,
      'Registry after UI retry',
    );
    receipt.reloads[1].registry = retryRegistry;
    await recordStep('switch-retry-ui-opened-origin', {
      timeOriginBefore: retryReload.timeOriginBefore,
      timeOriginAfter: retryReload.timeOriginAfter,
      quantity: retryReload.dom.quantity,
      marker: retryReload.openMarker.marker,
      clickKind: retryClick.kind,
    });

    // A -> B after real Rust select settlement; only delivery to switchVault is held.
    const originBeforeBarrier = await captureNativeSwitchMarkdownFiles(originPath);
    const registryBeforeBarrier = await readProfileRegistryBounded(candidate.profile);
    assertRegisteredRegistry(
      registryBeforeBarrier,
      originPath,
      destinationPath,
      originPath,
      'Registry before deterministic barrier',
    );
    const barrierStartUi = await withTimeout(observeUi(driver), 4_000, 'pre-barrier A UI');
    if (barrierStartUi.brandPath !== originPath || barrierStartUi.quantity !== '2') {
      fail('Deterministic barrier did not begin with the origin UI open.');
    }
    const barrierItem = await resolveVaultMenuItem(driver, destinationPath);
    barrierMayExist = true;
    const barrierInstall = await executeBarrier(
      driver,
      'install',
      barrierKey,
      destinationPath,
      SWITCH_BARRIER_WATCHDOG_MS,
    );
    barrierInstalled = true;
    if (barrierInstall?.phase !== 'installed')
      fail('Serialized public vault.select barrier did not install.');
    receipt.barrier = {
      phase: 'origin-to-destination-post-rust-pre-helper-delivery',
      entry: 'Sidebar.recent-vaults',
      itemLabel: barrierItem.text,
      targetPath: destinationPath,
      install: barrierInstall,
      click: null,
      heldState: null,
      registryBefore: registryBeforeBarrier,
      uiBefore: barrierStartUi,
      restore: null,
      release: null,
      finalReload: null,
    };
    await context.beginRuntimeRefresh();
    barrierClickIssued = true;
    const barrierClick = await clickElement(driver, barrierItem.id);
    receipt.barrier.click = barrierClick;
    const heldState = await waitFor(
      () => executeBarrier(driver, 'read', barrierKey, destinationPath),
      (value) => value?.interceptedCallCount === 1 && value?.settlement !== null,
      'real Rust select settlement held before helper delivery',
      SWITCH_BARRIER_WATCHDOG_MS - 1_000,
    );
    receipt.barrier.heldState = heldState;
    barrierReleaseExpectedReload =
      heldState?.interceptedCallCount === 1 &&
      heldState?.settlement?.kind === 'fulfilled' &&
      heldState?.settlement?.resultOk === true;
    if (heldState.watchdogFired) fail('Barrier watchdog fired before controlled release.');
    if (
      heldState.callCount !== 1 ||
      heldState.originalCallCount !== 1 ||
      heldState.targetMatched !== true ||
      heldState.thisMatched !== true ||
      heldState.interceptedCallCount !== 1
    ) {
      fail('Public select barrier did not capture exactly one real call with preserved this/target.');
    }
    if (heldState.settlement?.kind !== 'fulfilled' || heldState.settlement?.resultOk !== true) {
      fail('The real Rust vault.select settlement did not report success.');
    }
    const registryDuringBarrier = await readProfileRegistryBounded(candidate.profile);
    assertRegisteredRegistry(
      registryDuringBarrier,
      originPath,
      destinationPath,
      destinationPath,
      'Registry during held helper delivery',
    );
    const openDuringBarrier = await readOpenVaultMarker(driver, originMarker);
    if (!openDuringBarrier.matches)
      fail('OPEN origin was not readable while successful destination registry was held.');
    const uiDuringBarrier = await withTimeout(observeUi(driver), 4_000, 'UI during held select response');
    if (
      uiDuringBarrier.timeOrigin !== barrierStartUi.timeOrigin ||
      uiDuringBarrier.brandPath !== originPath ||
      uiDuringBarrier.quantity !== '2'
    ) {
      fail('The helper reloaded or changed the UI before the real select result was released.');
    }
    const editAttempt = await attemptW3cEditDuringBarrier(driver);
    const originAfterBarrierAttempt = await captureNativeSwitchMarkdownFiles(originPath);
    assertSameNativeSwitchMarkdownFiles(
      originBeforeBarrier,
      originAfterBarrierAttempt,
      'Held switch W3C edit attempt',
    );
    const barrierStateBeforeRestore = await executeBarrier(driver, 'read', barrierKey, destinationPath);
    const barrierIdentity = assertIdentityShape(
      await context.readOwnedAppIdentity(),
      'owned app identity during barrier',
    );
    if (!sameIdentity(initialIdentity, barrierIdentity)) {
      fail('Owned app identity changed during the post-Rust/pre-helper barrier.');
    }
    const runtimeBeforeBarrier = await context.verifyRuntimeIdentity();
    if (runtimeBeforeBarrier?.dataPath !== candidate.expectedBackendDataPath) {
      fail('Isolated backend profile identity changed while the helper response was held.');
    }
    Object.assign(receipt.barrier, {
      heldState: barrierStateBeforeRestore,
      registryBefore: registryBeforeBarrier,
      registryDuring: registryDuringBarrier,
      openMarkerDuring: openDuringBarrier,
      uiBefore: barrierStartUi,
      uiDuring: uiDuringBarrier,
      w3cEditAttempt: editAttempt,
      markdownBefore: originBeforeBarrier,
      markdownAfter: originAfterBarrierAttempt,
      ownedAppIdentityDuring: barrierIdentity,
      runtimeDuring: {
        dataPath: runtimeBeforeBarrier.dataPath,
        webviewDataPath: runtimeBeforeBarrier.webviewDataPath ?? null,
      },
      restore: null,
      release: null,
      finalReload: null,
    });
    await recordStep('switch-barrier-proved-registry-destination-open-origin-fenced', {
      targetPath: destinationPath,
      settlement: heldState.settlement,
      registryCurrent: registryDuringBarrier.current,
      openMarker: openDuringBarrier.marker,
      timeOrigin: uiDuringBarrier.timeOrigin,
      editRefused: editAttempt.refusedByVisibleFence,
      markdownPreserved: true,
    });
  } catch (error) {
    const modeEvidence =
      error?.nativeSwitchProfileWriteDenied ?? error?.cause?.nativeSwitchProfileWriteDenied;
    if (modeEvidence) receipt.failureProbe = modeEvidence;
    primaryError = error;
  } finally {
    if (barrierMayExist) {
      try {
        const restore = await executeBarrier(driver, 'restore', barrierKey, destinationPath);
        if (receipt.barrier) receipt.barrier.restore = restore;
        else receipt.barrier = { phase: 'cleanup-after-barrier-error', restore };
      } catch (error) {
        const detail = shortError(error);
        if (receipt.barrier) receipt.barrier.restore = { outcome: 'restore-command-failed', error: detail };
        else
          receipt.barrier = {
            phase: 'cleanup-after-barrier-error',
            restore: { outcome: 'restore-command-failed', error: detail },
          };
      }
      let preReleaseState = receipt.barrier?.heldState ?? null;
      if (barrierInstalled && !preReleaseState && barrierClickIssued) {
        try {
          preReleaseState = await executeBarrier(driver, 'read', barrierKey, destinationPath);
          if (receipt.barrier) receipt.barrier.heldState = preReleaseState;
          barrierReleaseExpectedReload =
            preReleaseState?.interceptedCallCount === 1 &&
            preReleaseState?.settlement?.kind === 'fulfilled' &&
            preReleaseState?.settlement?.resultOk === true;
        } catch (error) {
          if (receipt.barrier) receipt.barrier.preReleaseReadError = shortError(error);
        }
      }
      try {
        const release = barrierMayExist
          ? await executeBarrier(driver, 'release', barrierKey, destinationPath)
          : null;
        if (receipt.barrier) receipt.barrier.release = release;
      } catch (error) {
        const detail = shortError(error);
        if (receipt.barrier)
          receipt.barrier.release = { outcome: 'release-command-failed-or-navigation-race', error: detail };
      }
      if (barrierReleaseExpectedReload) {
        try {
          const startUi =
            receipt.barrier?.uiBefore ??
            (await withTimeout(observeUi(driver), 4_000, 'barrier release origin UI'));
          const finalReload = await waitForReload(context, startUi, destinationPath, destinationMarker, 5);
          if (receipt.barrier) receipt.barrier.finalReload = finalReload;
          receipt.reloads.push({
            phase: 'barrier-origin-to-destination-release',
            from: originPath,
            to: destinationPath,
            entry: 'Sidebar.recent-vaults',
            click: receipt.barrier?.click ?? null,
            ...finalReload,
          });
          receipt.identity.reloads.push(finalReload.ownedAppIdentity);
          if (receipt.barrier) {
            const finalRegistry = await readProfileRegistryBounded(candidate.profile);
            assertRegisteredRegistry(
              finalRegistry,
              originPath,
              destinationPath,
              destinationPath,
              'Registry after barrier release',
            );
            receipt.barrier.registryAfterRelease = finalRegistry;
          }
        } catch (error) {
          const detail = shortError(error);
          if (receipt.barrier) receipt.barrier.finalReload = { outcome: 'not-proven', error: detail };
          if (!primaryError) primaryError = error;
        }
      }
      if (receipt.barrier?.restore?.restored === false && !primaryError) {
        primaryError = new Error('Barrier wrapper was not conditionally restored before release.');
      }
      if (receipt.barrier?.restore?.state?.watchdogFired && !primaryError) {
        primaryError = new Error(
          'Barrier watchdog fired before the harness released the real select result.',
        );
      }
      if (receipt.barrier?.release?.state?.watchdogFired && !primaryError) {
        primaryError = new Error(
          'Barrier watchdog fired; harness evidence is incomplete even if the real result was released.',
        );
      }
      if (receipt.barrier?.heldState?.watchdogFired && !primaryError) {
        primaryError = new Error('Barrier watchdog fired before the harness completed observation.');
      }
    }
  }

  const finalMarkdown = {
    origin: await captureFinalNativeSwitchMarkdownFiles(originPath, receipt.markdown.originInitial),
    destination: await captureFinalNativeSwitchMarkdownFiles(
      destinationPath,
      receipt.markdown.destinationInitial,
    ),
  };
  receipt.markdown.final = finalMarkdown;
  const markdownErrors = [];
  for (const [vault, evidence] of Object.entries(finalMarkdown)) {
    if (evidence.status === 'captured' && evidence.matchesInitial === true) continue;
    const detail =
      evidence.status === 'error'
        ? evidence.error?.message
        : (evidence.comparisonError?.message ?? 'Final snapshot did not match its initial state.');
    markdownErrors.push({ vault, status: evidence.status, error: String(detail).slice(0, 240) });
    if (!primaryError)
      primaryError = new Error('Final ' + vault + ' Markdown snapshot did not match its initial state.');
  }
  receipt.markdown.finalValidation = {
    status: markdownErrors.length === 0 ? 'passed' : 'failed',
    errors: markdownErrors.slice(0, 2),
  };

  if (!primaryError && receipt.reloads.length !== 3) {
    primaryError = new Error('Expected exactly three helper-driven successful reloads.');
  }
  receipt.outcome = primaryError ? 'failed' : 'passed';
  receipt.finishedAt = new Date().toISOString();
  if (primaryError) receipt.failureError = shortError(primaryError);
  try {
    receipt.evidencePath = await writeReceipt(candidate, receipt);
    await recordStep('switch-receipt-written', {
      outcome: receipt.outcome,
      reloadCount: receipt.reloads.length,
      receiptFile: path.basename(receipt.evidencePath),
      receiptSha256: sha256(await readFile(receipt.evidencePath)),
    });
  } catch (error) {
    if (!primaryError) primaryError = error;
  }
  if (primaryError) throw primaryError;
  return receipt;
}
