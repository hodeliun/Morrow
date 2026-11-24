// Independent real-UI vault switching proof for the isolated Linux pilot.
// The common runner owns the frozen candidate, WebDriver session, private runtime and evidence retention.
/* global document, getComputedStyle, location, window */
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
const LEGACY_ELEMENT_KEY = 'ELEMENT';
const MARKDOWN_FILES = ['Inventory.md', 'Inventory/Widget.md', 'Views.md'];
const IDENTITY_FIELDS = [
  'pid',
  'startTimeTicks',
  'effectiveUid',
  'executablePathSha256',
  'argvSha256',
  'driverPid',
  'runtimeIdentityConfirmed',
];
const MARKER_TEXT = {
  origin: 'Synthetic vault marker: OPEN-OLD',
  destination: 'Synthetic vault marker: OPEN-DESTINATION',
};
const WAIT_MS = 25_000;
const POLL_MS = 100;
const BARRIER_LIMIT_MS = 15_000;
const PROFILE_RESTORE_LIMIT_MS = 5_000;

function fail(message) {
  throw new Error(message);
}

function shortError(error, vaultPaths = []) {
  let message = String(error?.message ?? error ?? 'Unknown error')
    .replace(/\s+/g, ' ')
    .trim();
  for (const value of vaultPaths) {
    if (typeof value === 'string' && value.length > 0)
      message = message.split(value).join('[synthetic-vault]');
  }
  return {
    name: typeof error?.name === 'string' ? error.name.slice(0, 80) : 'Error',
    code: typeof error?.code === 'string' ? error.code.slice(0, 40) : null,
    message: message.slice(0, 400),
  };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function bounded(promise, label, timeoutMs = 5_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolveReject, reject) => {
        timer = setTimeout(
          () => reject(new Error(label + ' timed out after ' + timeoutMs + 'ms.')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitFor(read, predicate, label, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastValue = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const remaining = Math.max(1, deadline - Date.now());
      lastValue = await bounded(
        Promise.resolve().then(read),
        label + ' observation',
        Math.min(5_000, remaining),
      );
      lastError = null;
      if (predicate(lastValue)) return lastValue;
    } catch (error) {
      lastError = error;
    }
    await delay(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
  }
  const serialized = JSON.stringify(lastValue);
  const detail = lastError ? shortError(lastError).message : String(serialized ?? lastValue).slice(0, 500);
  fail('Timed out waiting for ' + label + (detail ? ': ' + detail : '.'));
}

function identityShape(identity, label) {
  if (!identity || typeof identity !== 'object') fail(label + ' is missing.');
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) fail(label + ' has an invalid PID.');
  if (!/^\d+$/.test(String(identity.startTimeTicks ?? '')))
    fail(label + ' has an invalid process start time.');
  if (!Number.isInteger(identity.effectiveUid) || identity.effectiveUid <= 0) {
    fail(label + ' must have a non-root effective UID.');
  }
  for (const field of ['executablePathSha256', 'argvSha256']) {
    if (!/^[a-f0-9]{64}$/i.test(identity[field] ?? '')) fail(label + ' has no valid ' + field + '.');
  }
  if (!Number.isSafeInteger(identity.driverPid) || identity.driverPid <= 0)
    fail(label + ' has an invalid driver PID.');
  if (identity.runtimeIdentityConfirmed !== true) fail(label + ' is not runtime-confirmed.');
  return Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, identity[field]]));
}

function sameIdentity(left, right) {
  return Boolean(left && right && IDENTITY_FIELDS.every((field) => left[field] === right[field]));
}

function driverElementId(element) {
  return element?.[ELEMENT_KEY] ?? element?.[LEGACY_ELEMENT_KEY] ?? null;
}

async function clickRef(driver, id, timeoutMs = 5_000) {
  return bounded(
    driver.request('POST', driver.path('/element/' + id + '/click'), {}),
    'W3C element click',
    timeoutMs,
  );
}

async function screenshot(driver, outputPath) {
  await bounded(driver.screenshot(outputPath), 'Screenshot capture', 5_000);
}

async function captureMarkdown(vaultRoot) {
  const rootInfo = await lstat(vaultRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    fail('Synthetic vault root must be a real directory.');
  const root = await realpath(vaultRoot);
  if (root !== path.resolve(vaultRoot)) fail('Synthetic vault root is not canonical.');
  const output = {};
  for (const relative of MARKDOWN_FILES) {
    const absolute = path.resolve(root, relative);
    if (!inside(root, absolute) || absolute === root) fail('Markdown path escaped its synthetic vault.');
    if (relative.includes(path.sep)) {
      const parent = path.dirname(absolute);
      const parentInfo = await lstat(parent);
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || (await realpath(parent)) !== parent) {
        fail('Markdown parent directory is not canonical: ' + relative);
      }
    }
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || (await realpath(absolute)) !== absolute) {
      fail('Expected a regular Markdown fixture file: ' + relative);
    }
    const bytes = await readFile(absolute);
    output[relative] = {
      sha256: sha256(bytes),
      size: bytes.length,
      mtimeMs: info.mtimeMs,
      mode: info.mode & 0o7777,
      quantity: relative === 'Inventory/Widget.md' ? quantityFrom(bytes.toString('utf8')) : null,
    };
  }
  return output;
}

function quantityFrom(markdown) {
  const match = /^\s*Quantity\s*:\s*(\d+)\s*$/im.exec(markdown);
  if (!match) fail('Synthetic Widget Markdown has no integer Quantity field.');
  return Number(match[1]);
}

function assertMarkdownEqual(before, after, label) {
  for (const relative of MARKDOWN_FILES) {
    for (const field of ['sha256', 'size', 'mtimeMs', 'mode']) {
      if (before?.[relative]?.[field] !== after?.[relative]?.[field]) {
        fail(label + ': ' + relative + ' changed ' + field + '.');
      }
    }
  }
}

async function readFixture(vaultRoot, expectedMarker, expectedQuantity, expectedBundleSha256) {
  const canonicalRoot = await realpath(vaultRoot);
  const [inventory, widget, views, workspaceBytes, pluginsBytes, bundleBytes] = await Promise.all([
    readFile(path.join(canonicalRoot, 'Inventory.md'), 'utf8'),
    readFile(path.join(canonicalRoot, 'Inventory', 'Widget.md'), 'utf8'),
    readFile(path.join(canonicalRoot, 'Views.md'), 'utf8'),
    readFile(path.join(canonicalRoot, '.morrow', 'workspace.json')),
    readFile(path.join(canonicalRoot, '.morrow', 'plugins.json')),
    readFile(path.join(canonicalRoot, '.morrow', 'plugins', 'polaris-dados', 'main.js')),
  ]);
  const workspace = JSON.parse(workspaceBytes.toString('utf8'));
  const pages = workspace?.pages ?? {};
  const pageIds = {
    inventory: pages['Inventory.md']?.id,
    widget: pages['Inventory/Widget.md']?.id,
    views: pages['Views.md']?.id,
  };
  if (!Object.values(pageIds).every((id) => typeof id === 'string' && id.length > 0)) {
    fail('Synthetic workspace lacks stable Inventory, Widget or Views page IDs.');
  }
  const quantity = quantityFrom(widget);
  const priceMatch = /^\s*Price\s*:\s*(\d+(?:\.\d+)?)\s*$/im.exec(widget);
  if (!priceMatch || Number(priceMatch[1]) !== 10) fail('Synthetic Widget Price must be 10.');
  if (quantity !== expectedQuantity) fail('Synthetic Widget Quantity does not match the expected vault.');
  if (!/formula:\s*Quantity\s*\*\s*Price/i.test(inventory))
    fail('Inventory formula is not Quantity * Price.');
  const markerCount = views.split(expectedMarker).length - 1;
  if (markerCount !== 1) fail('Views.md must contain exactly one expected OPEN marker.');
  const viewMarkers = [...views.matchAll(/<!--\s*morrow:polaris-dados-view:v1:([A-Za-z0-9_-]+)\s*-->/g)];
  if (viewMarkers.length !== 2) fail('Views.md must retain its two linked-view markers.');
  const linkedViews = viewMarkers.map((match) => {
    let value;
    try {
      value = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    } catch (error) {
      throw new Error('Linked-view fixture marker could not be decoded.', { cause: error });
    }
    if (value?.version !== 1 || value.sourceDatabaseId !== pageIds.inventory) {
      fail('Linked-view marker does not identify this vault inventory database.');
    }
    return { viewId: value.viewId, title: value.title, sourceDatabaseId: value.sourceDatabaseId };
  });
  if (new Set(linkedViews.map((view) => view.viewId)).size !== 2) fail('Linked-view IDs are not distinct.');
  const pluginConfig = JSON.parse(pluginsBytes.toString('utf8'));
  if (!Array.isArray(pluginConfig.enabled) || !pluginConfig.enabled.includes('polaris-dados')) {
    fail('Synthetic Polaris Dados plugin is not enabled in the vault.');
  }
  const actualBundleSha256 = sha256(bundleBytes);
  if (actualBundleSha256 !== expectedBundleSha256)
    fail('Synthetic vault plugin bundle differs from the frozen bundle.');
  return {
    path: canonicalRoot,
    expectedMarker,
    quantity,
    price: 10,
    total: quantity * 10,
    pageIds,
    linkedViews,
    markdown: await captureMarkdown(canonicalRoot),
    bundleSha256: actualBundleSha256,
  };
}

async function captureRegistry(profileRoot) {
  const profileInfo = await lstat(profileRoot);
  if (!profileInfo.isDirectory() || profileInfo.isSymbolicLink())
    fail('Isolated profile must be a real directory.');
  const root = await realpath(profileRoot);
  if (root !== path.resolve(profileRoot)) fail('Isolated profile path is not canonical.');
  const registryPath = path.join(root, 'vaults.json');
  const info = await lstat(registryPath);
  if (!info.isFile() || info.isSymbolicLink() || (await realpath(registryPath)) !== registryPath) {
    fail('Isolated vaults.json must be a regular file.');
  }
  const bytes = await readFile(registryPath);
  if (bytes.length > 64 * 1024) fail('Isolated vault registry is unexpectedly large.');
  const parsed = JSON.parse(bytes.toString('utf8'));
  const recent = Array.isArray(parsed.recent) ? parsed.recent : [];
  return {
    path: registryPath,
    sha256: sha256(bytes),
    size: bytes.length,
    mtimeMs: info.mtimeMs,
    mode: info.mode & 0o7777,
    uid: info.uid,
    current: typeof parsed.current === 'string' ? parsed.current : null,
    recent: recent.map((item) => ({
      path: typeof item?.path === 'string' ? item.path : null,
      openedAt: Number.isFinite(item?.openedAt) ? item.openedAt : null,
    })),
  };
}

function assertRegistry(registry, originPath, destinationPath, currentPath, label) {
  if (registry.current !== currentPath) fail(label + ' registry current path was not expected.');
  const paths = registry.recent.map((item) => item.path);
  if (!paths.includes(originPath) || !paths.includes(destinationPath)) {
    fail(label + ' registry must retain both synthetic vault paths.');
  }
}

function assertRegistryFront(registry, currentPath, label) {
  if (registry.recent[0]?.path !== currentPath) {
    fail(label + ' must move the selected vault to the first recent entry.');
  }
}

async function profileMode(profileRoot) {
  const info = await lstat(profileRoot);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(profileRoot)) !== path.resolve(profileRoot)
  ) {
    fail('Isolated profile directory changed identity.');
  }
  return { mode: info.mode & 0o7777, uid: info.uid, dev: info.dev, ino: info.ino };
}

async function restoreProfileMode(profileRoot, expectedMode, expectedUid, startedAt, deadlineAt) {
  const initial = await lstat(profileRoot);
  if (!initial.isDirectory() || initial.isSymbolicLink() || initial.uid !== expectedUid) {
    fail('Profile directory identity changed during permission-denial probe.');
  }
  await chmod(profileRoot, expectedMode);
  const restored = await lstat(profileRoot);
  const elapsedMs = performance.now() - startedAt;
  if ((restored.mode & 0o7777) !== expectedMode) fail('Profile directory mode was not restored exactly.');
  if (restored.uid !== expectedUid || restored.dev !== initial.dev || restored.ino !== initial.ino) {
    fail('Profile directory identity changed while restoring mode.');
  }
  if (performance.now() > deadlineAt || elapsedMs > PROFILE_RESTORE_LIMIT_MS) {
    fail('Profile directory mode restoration exceeded its five-second bound.');
  }
  return { before: expectedMode, restored: restored.mode & 0o7777, elapsedMs };
}

async function withProfileWritesDenied(profileRoot, callback) {
  const runnerUid = typeof process.geteuid === 'function' ? process.geteuid() : null;
  if (runnerUid === null || runnerUid === 0) fail('Permission test requires a non-root Linux user.');
  const initial = await profileMode(profileRoot);
  if (initial.uid !== runnerUid) fail('Isolated profile is not owned by the effective non-root user.');
  const blockedMode = initial.mode & ~0o222;
  if (blockedMode === initial.mode) fail('Profile directory already has no write bits.');
  if ((blockedMode & 0o555) !== (initial.mode & 0o555))
    fail('Write denial changed read/execute permissions.');
  const startedAt = performance.now();
  const deadlineAt = startedAt + PROFILE_RESTORE_LIMIT_MS;
  let timer = null;
  let restorePromise = null;
  let watchdogError = null;
  let watchdogFired = false;
  let result;
  let primaryError = null;
  let restoreError = null;
  const restore = async (reason) => {
    if (restorePromise) return restorePromise;
    restorePromise = (async () => {
      const current = await lstat(profileRoot);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.uid !== initial.uid ||
        current.dev !== initial.dev ||
        current.ino !== initial.ino ||
        (current.mode & 0o7777) !== blockedMode
      ) {
        fail('Profile mode or identity changed unexpectedly before exact restoration.');
      }
      return {
        reason,
        ...(await restoreProfileMode(profileRoot, initial.mode, initial.uid, startedAt, deadlineAt)),
      };
    })();
    return restorePromise;
  };
  await chmod(profileRoot, blockedMode);
  try {
    const blocked = await profileMode(profileRoot);
    if (
      blocked.mode !== blockedMode ||
      blocked.uid !== initial.uid ||
      blocked.dev !== initial.dev ||
      blocked.ino !== initial.ino
    ) {
      fail('Profile directory did not enter the exact expected write-denied state.');
    }
    timer = setTimeout(
      () => {
        watchdogFired = true;
        void restore('node-watchdog').catch((error) => {
          watchdogError = error;
        });
      },
      Math.max(1, PROFILE_RESTORE_LIMIT_MS - 250),
    );
    timer.unref?.();
    result = await callback({
      mode: {
        before: initial.mode,
        blocked: blocked.mode,
        uid: initial.uid,
        device: initial.dev,
        inode: initial.ino,
        readExecutePreserved: (blocked.mode & 0o555) === (initial.mode & 0o555),
      },
      deadlineAt,
    });
  } catch (error) {
    primaryError = error;
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await bounded(
        restore('finally'),
        'Exact isolated profile mode restoration',
        Math.max(1, deadlineAt - performance.now()),
      );
    } catch (error) {
      restoreError = error;
    }
    if (!restorePromise && watchdogError) restoreError = watchdogError;
  }
  if (primaryError) {
    if (restoreError) {
      try {
        Object.defineProperty(primaryError, 'profileRestoreError', {
          value: shortError(restoreError),
          configurable: true,
        });
      } catch {
        /* Preserve the original permission failure. */
      }
    }
    throw primaryError;
  }
  if (restoreError) throw restoreError;
  return { result, modeRestoration: await restorePromise, watchdogFired };
}

async function observeDocument(driver) {
  return bounded(
    driver.execute('return (' + documentSnapshot.toString() + ').apply(null, arguments);', ['polaris-dados']),
    'DOM snapshot',
  );
}

function documentSnapshot(pluginId) {
  const main = document.querySelector('.app > main.main');
  const brand = document.querySelector('.sidebar .sidebar-header button.brand');
  const roots = [...document.querySelectorAll('[data-provider="' + pluginId + '"]')];
  const visible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    return element.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const providers = roots.map((root) => {
    const rows = [...root.querySelectorAll('tbody tr')];
    return {
      tableCount: root.querySelectorAll('table').length,
      rows: rows.map((row) => {
        const value = (field) => {
          const input = row.querySelector('input[data-field="' + field + '"]');
          const cell = row.querySelector('[data-field="' + field + '"]');
          return input?.value ?? cell?.textContent?.trim() ?? null;
        };
        return {
          quantity: value('quantity'),
          price: value('price'),
          total: value('total'),
          rowId: row.getAttribute('data-row-id'),
        };
      }),
      editControls: root.querySelectorAll('button[data-action="edit"][data-field="quantity"]').length,
      editDisabled:
        root.querySelector('button[data-action="edit"][data-field="quantity"]')?.disabled === true,
      editAriaDisabled:
        root
          .querySelector('button[data-action="edit"][data-field="quantity"]')
          ?.getAttribute('aria-disabled') === 'true',
      quantityInputs: root.querySelectorAll('input[data-field="quantity"]').length,
    };
  });
  const mainInert = (() => {
    let node = main;
    while (node) {
      if (node.inert || node.hasAttribute('inert')) return true;
      node = node.parentElement;
    }
    return false;
  })();
  const saveStatus = document.querySelector('.save-status');
  const alerts = [...document.querySelectorAll('[role="alert"], [role="status"]')]
    .filter(visible)
    .map((node) => (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 240))
    .filter(Boolean)
    .slice(0, 12);
  return {
    readyState: document.readyState,
    timeOrigin: performance.timeOrigin,
    route: location.hash,
    brandPath: brand?.getAttribute('title') ?? null,
    mainVisible: visible(main),
    mainInert,
    providerCount: roots.length,
    providers,
    pageHeading:
      document.querySelector('.ProseMirror[contenteditable="true"] h1')?.textContent?.trim() ?? null,
    pageBodyVisible: visible(document.querySelector('.page-scroll')),
    inputCount: document.querySelectorAll('[data-provider="' + pluginId + '"] input[data-field="quantity"]')
      .length,
    editButtonCount: document.querySelectorAll(
      '[data-provider="' + pluginId + '"] button[data-action="edit"][data-field="quantity"]',
    ).length,
    saveStatus: saveStatus
      ? {
          label: saveStatus.querySelector('.save-label')?.textContent?.trim() ?? '',
          className: saveStatus.className,
          role: saveStatus.getAttribute('role'),
        }
      : null,
    alerts,
  };
}

function readPublicMarker() {
  const key = arguments[0];
  const marker = arguments[1];
  const state = { status: 'pending', matches: false, markerCount: 0, length: null, error: null };
  const readText = window.morrow?.vault?.readText;
  if (typeof readText !== 'function') return { status: 'missing', error: 'public readText is unavailable' };
  try {
    Promise.resolve(readText.call(window.morrow.vault, 'Views.md')).then(
      (value) => {
        if (window[key] !== state) return;
        const text = typeof value === 'string' ? value : '';
        state.status = 'fulfilled';
        state.matches = text.includes(marker);
        state.markerCount = text.split(marker).length - 1;
        state.length = typeof value === 'string' ? value.length : null;
      },
      (error) => {
        if (window[key] !== state) return;
        state.status = 'rejected';
        state.error = String(error?.message ?? error).slice(0, 240);
      },
    );
  } catch (error) {
    state.status = 'rejected';
    state.error = String(error?.message ?? error).slice(0, 240);
  }
  window[key] = state;
  return { status: state.status };
}

async function probePublicMarker(driver, expectedMarker) {
  const key = '__morrowSwitchIndependentRead_' + randomUUID().replace(/-/g, '');
  const started = await bounded(
    driver.execute('return (' + readPublicMarker.toString() + ').apply(null, arguments);', [
      key,
      expectedMarker,
    ]),
    'Start public readText probe',
  );
  if (started?.status === 'missing' || started?.status === 'rejected') {
    fail('Public vault.readText probe could not start: ' + String(started.error ?? 'unknown error'));
  }
  const result = await waitFor(
    () =>
      driver.execute(
        'return window[arguments[0]] ? ({ status: window[arguments[0]].status, matches: window[arguments[0]].matches, markerCount: window[arguments[0]].markerCount, length: window[arguments[0]].length, error: window[arguments[0]].error }) : null;',
        [key],
      ),
    (value) => value?.status === 'fulfilled' || value?.status === 'rejected',
    'public readText marker result',
    10_000,
  );
  try {
    await driver.execute('delete window[arguments[0]]; return true;', [key]);
  } catch {
    /* The probe result remains available in its returned evidence. */
  }
  if (result.status !== 'fulfilled' || result.matches !== true || result.markerCount !== 1) {
    fail('Public vault.readText did not return exactly one expected OPEN marker.');
  }
  return {
    api: 'window.morrow.vault.readText',
    relativePath: 'Views.md',
    marker: expectedMarker,
    length: result.length,
  };
}

function readPageReference(pageId) {
  const matches = [...document.querySelectorAll('.app [role="treeitem"][data-page-id]')].filter(
    (item) => item.getAttribute('data-page-id') === pageId,
  );
  return matches.length === 1 ? matches[0] : null;
}

async function clickPage(driver, pageId, label) {
  const reference = await bounded(
    driver.execute('return (' + readPageReference.toString() + ').apply(null, arguments);', [pageId]),
    'Resolve real Sidebar page row',
  );
  const id = driverElementId(reference);
  if (!id) fail('Could not resolve a unique real Sidebar tree item for ' + label + '.');
  return clickRef(driver, id);
}

async function waitForViews(driver, pageId, expectedTitle, expectedCount = 2) {
  await clickPage(driver, pageId, 'Views.md');
  const state = await waitFor(
    () => observeDocument(driver),
    (value) =>
      value.pageHeading === expectedTitle &&
      value.providerCount === expectedCount &&
      value.providers.every((provider) => provider.tableCount === 1),
    'Views.md editor and linked-view tables after real Sidebar selection',
  );
  return { pageState: state, state };
}

async function waitForSourceGrid(driver, pageId, expectedQuantity, expectedPath) {
  await clickPage(driver, pageId, 'Inventory.md');
  const state = await waitFor(
    () => observeDocument(driver),
    (value) =>
      value.providerCount === 1 &&
      value.providers?.[0]?.rows?.length === 1 &&
      value.providers[0].rows[0].quantity === String(expectedQuantity) &&
      value.providers[0].rows[0].price === '10' &&
      value.providers[0].rows[0].total === String(expectedQuantity * 10),
    'real Inventory grid for ' + expectedPath,
  );
  const row = state.providers[0].rows[0];
  if (row.price !== '10' || row.total !== String(expectedQuantity * 10) || state.inputCount !== 0) {
    fail('Real Inventory grid did not show the expected Price, Total and read state.');
  }
  if (state.brandPath !== expectedPath)
    fail('Sidebar brand changed while reading the synthetic Inventory grid.');
  return state;
}

async function waitForIdleSaved(driver, label) {
  return waitFor(
    () => observeDocument(driver),
    (state) =>
      state.saveStatus?.label === 'Saved' &&
      !/(?:^|\s)is-(?:saving|error)(?:\s|$)/.test(state.saveStatus.className) &&
      !state.alerts.some((text) => /save failed|could not save/i.test(text)),
    label + ' saved status',
    10_000,
  );
}

async function openAndVerifyVault(
  context,
  before,
  expectedPath,
  expectedMarker,
  expectedQuantity,
  fixture,
  expectedDriverSessionId,
) {
  const driver = context.driver;
  const currentRoot = await realpath(expectedPath);
  const state = await waitFor(
    () => observeDocument(driver),
    (value) =>
      value.readyState === 'complete' &&
      Number.isFinite(value.timeOrigin) &&
      value.timeOrigin !== before.timeOrigin &&
      value.brandPath === currentRoot &&
      value.mainVisible === true,
    'new real document for selected synthetic vault',
  );
  if (driver.sessionId !== expectedDriverSessionId) {
    fail('A helper reload unexpectedly replaced the original WebDriver session.');
  }
  const runtime = await context.verifyRuntimeIdentity();
  const currentIdentity = identityShape(
    await context.readOwnedAppIdentity(),
    'owned app identity after helper reload',
  );
  if (!sameIdentity(context.ownedAppIdentity, currentIdentity)) {
    fail('Owned app PID/start time or runtime identity changed across a same-window helper reload.');
  }
  if (
    runtime?.platform !== 'linux' ||
    runtime?.dataPath !== context.candidate.expectedBackendDataPath ||
    runtime?.webviewDataPath !== context.candidate.expectedWebviewDataPath
  ) {
    fail('Backend or WebView profile identity changed across the helper reload.');
  }
  const marker = await probePublicMarker(driver, expectedMarker);
  const expectedTitle = expectedMarker === MARKER_TEXT.origin ? 'Origin Views' : 'Destination Views';
  const views = await waitForViews(driver, fixture.pageIds.views, expectedTitle);
  if (views.state.brandPath !== currentRoot || views.state.providerCount !== 2) {
    fail('The reloaded vault did not render its own two linked views.');
  }
  const grid = await waitForSourceGrid(driver, fixture.pageIds.inventory, expectedQuantity, currentRoot);
  await waitForIdleSaved(driver, 'post-reload vault page navigation');
  return {
    timeOriginBefore: before.timeOrigin,
    timeOriginAfter: state.timeOrigin,
    domAfterReload: state,
    marker,
    linkedViews: views.state,
    inventoryGrid: grid,
    runtime: { dataPath: runtime.dataPath, webviewDataPath: runtime.webviewDataPath ?? null },
    identity: currentIdentity,
  };
}

async function openSidebarMenu(driver, expectedCurrentPath) {
  const current = await observeDocument(driver);
  if (current.brandPath !== expectedCurrentPath)
    fail('Vault switch did not begin from the expected real Sidebar brand.');
  const brands = await driver.elements('.sidebar .sidebar-header button.brand[title]');
  if (brands.length !== 1) fail('Expected exactly one real Sidebar vault menu button.');
  const id = driverElementId(brands[0]);
  if (!id) fail('Sidebar vault button has no WebDriver element ID.');
  await clickRef(driver, id);
  return waitFor(
    async () => {
      const menu = await driver.execute(
        'return [...document.querySelectorAll("[role=menu]")].filter((node) => node.getAttribute("aria-label") === "Vaults").length;',
      );
      return menu === 1 ? menu : false;
    },
    Boolean,
    'real Sidebar Vaults menu',
    5_000,
  );
}

async function sidebarMenuItem(driver, targetPath) {
  await waitFor(
    async () => {
      const items = await driver.execute(
        'return [...document.querySelectorAll("[role=menu] button[role=menuitemradio]")].map((node) => ({ id: node, label: node.textContent?.trim() ?? "", checked: node.getAttribute("aria-checked") }));',
      );
      return Array.isArray(items) && items.length >= 2 ? items : false;
    },
    Boolean,
    'real recent vault menu items',
    5_000,
  );
  const expectedName = path.basename(targetPath);
  const matches = await driver.execute(
    'return [...document.querySelectorAll("[role=menu] button[role=menuitemradio]")].filter((node) => node.textContent?.trim() === arguments[0]).map((node) => ({ element: node, label: node.textContent?.trim() ?? "", checked: node.getAttribute("aria-checked") }));',
    [expectedName],
  );
  if (matches.length !== 1) fail('Expected exactly one real Sidebar item for ' + expectedName + '.');
  const id = driverElementId(matches[0].element);
  if (!id) fail('Real Sidebar vault menu item has no W3C reference.');
  return { id, label: matches[0].label, checked: matches[0].checked };
}

async function waitForReloadDocument(context, before, targetPath) {
  const currentRoot = await realpath(targetPath);
  return waitFor(
    () => observeDocument(context.driver),
    (value) =>
      value.readyState === 'complete' &&
      Number.isFinite(value.timeOrigin) &&
      value.timeOrigin !== before.timeOrigin &&
      value.brandPath === currentRoot &&
      value.mainVisible === true,
    'actual window.location.reload into the selected vault',
  );
}

function permissionError(texts) {
  return texts.some((text) => /(permission denied|os error 13|eacces)/i.test(text));
}

function fileList(profileRoot) {
  return readdir(profileRoot, { withFileTypes: true }).then((entries) =>
    entries
      .map((entry) => ({
        name: entry.name,
        directory: entry.isDirectory(),
        file: entry.isFile(),
        symlink: entry.isSymbolicLink(),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  );
}

function vaultSelectBarrierCommand(action, key, targetPath, watchdogMs) {
  const windowObject = window;
  const state = windowObject[key];
  const snapshot = (current) => ({
    schema: current.schema,
    version: current.version,
    phase: current.phase,
    targetPath: current.targetPath,
    descriptor: current.descriptor,
    callCount: current.callCount,
    originalCallCount: current.originalCallCount,
    interceptedCallCount: current.interceptedCallCount,
    targetMatched: current.targetMatched,
    thisMatched: current.thisMatched,
    argsCount: current.argsCount,
    settlement: current.settlement,
    restoreOutcome: current.restoreOutcome,
    restoreError: current.restoreError,
    releaseRequested: current.releaseRequested,
    releaseSource: current.releaseSource,
    watchdogFired: current.watchdogFired,
    delivered: current.delivered,
    deliveryEvidenceError: current.deliveryEvidenceError,
    unexpectedCalls: current.unexpectedCalls.slice(0, 6),
  });
  if (action === 'install') {
    if (state) throw new Error('Switch barrier key is already in use.');
    if (typeof targetPath !== 'string' || !targetPath.startsWith('/'))
      throw new Error('Barrier target must be an exact absolute path.');
    if (!Number.isInteger(watchdogMs) || watchdogMs < 1000 || watchdogMs > 30000) {
      throw new Error('Barrier watchdog is outside its bounded range.');
    }
    const vault = windowObject.morrow?.vault;
    if (!vault || typeof vault.select !== 'function')
      throw new Error('Public window.morrow.vault.select is unavailable.');
    let owner = vault;
    let descriptor = null;
    let depth = 0;
    while (owner !== null && depth < 16) {
      descriptor = Object.getOwnPropertyDescriptor(owner, 'select');
      if (descriptor) break;
      owner = Object.getPrototypeOf(owner);
      depth += 1;
    }
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error('Public vault.select is missing or is an accessor.');
    }
    const original = vault.select;
    if (typeof original !== 'function' || descriptor.value !== original)
      throw new Error('Public vault.select descriptor does not identify its function.');
    const ownBefore = Object.getOwnPropertyDescriptor(vault, 'select') ?? null;
    if (ownBefore && ownBefore.configurable !== true && ownBefore.writable !== true) {
      throw new Error('Public vault.select own descriptor cannot be temporarily wrapped.');
    }
    if (!ownBefore && !Object.isExtensible(vault))
      throw new Error('Public vault object cannot be shadowed for this probe.');
    let settleKind = null;
    let settleValue;
    let originalSettled = false;
    let deliveryScheduled = false;
    let delivered = false;
    let resolveGate;
    let rejectGate;
    const gate = new Promise((resolveGateValue, rejectGateValue) => {
      resolveGate = resolveGateValue;
      rejectGate = rejectGateValue;
    });
    const current = {
      schema: 'morrow.native-switch-independent-barrier',
      version: 1,
      phase: 'installed',
      targetPath,
      descriptor: {
        owner: owner === vault ? 'own' : 'inherited',
        depth,
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
      deliveryEvidenceError: null,
      unexpectedCalls: [],
      watchdogTimer: null,
      resolveDelivery: null,
    };
    const scheduleDelivery = () => {
      if (!current.releaseRequested || !originalSettled || delivered || deliveryScheduled) return false;
      deliveryScheduled = true;
      windowObject.setTimeout(() => {
        deliveryScheduled = false;
        if (!current.releaseRequested || !originalSettled || delivered) return;
        delivered = true;
        current.delivered = true;
        current.phase = 'real-settlement-delivered';
        if (current.watchdogTimer !== null) windowObject.clearTimeout(current.watchdogTimer);
        try {
          windowObject.sessionStorage.setItem(key + ':delivery', JSON.stringify(snapshot(current)));
        } catch (error) {
          current.deliveryEvidenceError = String(error?.message ?? error).slice(0, 180);
        }
        if (settleKind === 'fulfilled') resolveGate(settleValue);
        else rejectGate(settleValue);
      }, 0);
      return true;
    };
    const observeOriginalSettlement = (kind, value) => {
      if (originalSettled) return;
      originalSettled = true;
      settleKind = kind;
      settleValue = value;
      current.settlement = {
        kind,
        observedAtMs: windowObject.performance.now(),
        resultOk: kind === 'fulfilled' && value !== null && typeof value === 'object' && value.ok === true,
        resultFailed:
          kind === 'fulfilled' && value !== null && typeof value === 'object' && value.ok === false,
        errorName:
          kind === 'rejected' && value && typeof value.name === 'string'
            ? String(value.name).slice(0, 80)
            : null,
        errorMessage:
          kind === 'rejected'
            ? String(value && value.message !== undefined ? value.message : value).slice(0, 240)
            : null,
      };
      current.phase = current.releaseRequested
        ? 'real-settlement-after-release-request'
        : 'real-settlement-held';
      scheduleDelivery();
    };
    const wrapper = function (...args) {
      current.callCount += 1;
      const exactTarget = args.length > 0 && args[0] === targetPath;
      if (!exactTarget) {
        current.originalCallCount += 1;
        return Reflect.apply(original, this, args);
      }
      if (current.interceptedCallCount !== 0) {
        current.unexpectedCalls.push({
          call: current.callCount,
          targetMatched: true,
          argsCount: args.length,
        });
        return Promise.reject(
          new Error('Duplicate public vault.select target call refused by one-shot barrier.'),
        );
      }
      current.interceptedCallCount += 1;
      current.targetMatched = true;
      current.thisMatched = this === vault;
      current.argsCount = args.length;
      current.phase = 'real-select-pending';
      current.originalCallCount += 1;
      try {
        const actualResult = Reflect.apply(original, this, args);
        Promise.resolve(actualResult).then(
          (value) => observeOriginalSettlement('fulfilled', value),
          (error) => observeOriginalSettlement('rejected', error),
        );
      } catch (error) {
        observeOriginalSettlement('rejected', error);
      }
      return gate;
    };
    const wrapped = ownBefore
      ? { ...ownBefore, value: wrapper }
      : { configurable: true, enumerable: descriptor.enumerable === true, writable: true, value: wrapper };
    Object.defineProperty(vault, 'select', wrapped);
    current.restoreDescriptor = () => {
      if (current.restoreOutcome !== 'pending') return current.restoreOutcome === 'restored';
      try {
        const now = Object.getOwnPropertyDescriptor(vault, 'select');
        if (!now || now.value !== wrapper) {
          current.restoreOutcome = 'not-owned-anymore';
          return false;
        }
        if (ownBefore) Object.defineProperty(vault, 'select', ownBefore);
        else if (!Reflect.deleteProperty(vault, 'select')) {
          current.restoreOutcome = 'delete-refused';
          return false;
        }
        current.restoreOutcome = 'restored';
        if (vault.select !== original) current.restoreOutcome = 'restore-mismatch';
        current.phase =
          current.restoreOutcome === 'restored'
            ? current.releaseRequested
              ? 'descriptor-restored-after-release-request'
              : 'descriptor-restored-awaiting-release'
            : 'descriptor-restoration-mismatch';
        return current.restoreOutcome === 'restored';
      } catch (error) {
        current.restoreOutcome = 'restore-error';
        current.restoreError = String(error && error.message !== undefined ? error.message : error).slice(
          0,
          240,
        );
        current.phase = 'descriptor-restoration-error';
        return false;
      }
    };
    current.requestRelease = (source, allowRestoreFailure = false) => {
      const restorationReady = current.restoreOutcome === 'restored';
      const recoveryReady = allowRestoreFailure && current.restoreOutcome !== 'pending';
      if (current.releaseRequested || (!restorationReady && !recoveryReady)) return false;
      current.releaseRequested = true;
      current.releaseSource = source;
      current.phase = restorationReady
        ? originalSettled
          ? 'real-settlement-release-scheduled'
          : 'release-requested-awaiting-real-settlement'
        : originalSettled
          ? 'real-settlement-release-scheduled-after-restore-failure'
          : 'release-requested-after-restore-failure';
      scheduleDelivery();
      return true;
    };
    windowObject[key] = current;
    current.watchdogTimer = windowObject.setTimeout(() => {
      current.watchdogFired = true;
      current.phase = 'watchdog-fired';
      const restored = current.restoreDescriptor();
      current.requestRelease('page-watchdog', !restored);
    }, watchdogMs);
    return snapshot(current);
  }
  if (!state) throw new Error('Vault select barrier state is unavailable.');
  if (action === 'read') return snapshot(state);
  if (action === 'restore') return { restored: state.restoreDescriptor(), state: snapshot(state) };
  if (action === 'release') return { requested: state.requestRelease('harness'), state: snapshot(state) };
  if (action === 'release-failsafe') {
    return { requested: state.requestRelease('harness-restore-failure', true), state: snapshot(state) };
  }
  throw new Error('Unknown vault select barrier command.');
}

function barrierScript() {
  return 'return (' + vaultSelectBarrierCommand.toString() + ').apply(null, arguments);';
}

function readBarrierDeliveryEvidence(key) {
  const storageKey = key + ':delivery';
  const raw = sessionStorage.getItem(storageKey);
  if (raw === null) return null;
  sessionStorage.removeItem(storageKey);
  try {
    return JSON.parse(raw);
  } catch {
    return { parseError: true, bytes: raw.length };
  }
}

async function takeBarrierDeliveryEvidence(driver, key) {
  return bounded(
    driver.execute('return (' + readBarrierDeliveryEvidence.toString() + ').apply(null, arguments);', [key]),
    'Read one-shot barrier delivery evidence',
  );
}

async function runBarrierCommand(driver, action, key, targetPath, watchdogMs = BARRIER_LIMIT_MS) {
  return bounded(
    driver.execute(barrierScript(), [action, key, targetPath, watchdogMs]),
    'Serialized public select barrier ' + action,
    5_000,
  );
}

async function captureEvidenceReceipt(candidate, receipt, initialError, recordStep, vaultPaths) {
  receipt.outcome = initialError ? 'failed' : 'passed';
  receipt.finishedAt = new Date().toISOString();
  if (initialError) receipt.failure = shortError(initialError, vaultPaths);
  const output = path.join(candidate.evidence, 'native-switch-independent-receipt.json');
  try {
    await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const bytes = await readFile(output);
    await recordStep('switch-independent-receipt-retained', {
      outcome: receipt.outcome,
      file: path.basename(output),
      sha256: sha256(bytes),
      bytes: bytes.length,
    });
    return output;
  } catch (error) {
    if (!initialError) throw error;
    try {
      await writeFile(
        path.join(candidate.evidence, 'switch-independent-receipt-write-failure.log'),
        shortError(error, vaultPaths).message + '\n',
        { flag: 'wx', mode: 0o600 },
      );
    } catch {
      /* Preserve the original scenario error if even the failure receipt cannot be written. */
    }
    return null;
  }
}

export async function runIndependentNativeSwitchScenario(context) {
  const { candidate, recordStep } = context ?? {};
  const driver = context?.driver;
  if (
    !candidate?.vault ||
    !candidate?.destinationVault ||
    !candidate?.profile ||
    !candidate?.evidence ||
    !driver
  ) {
    fail('Independent switch scenario requires the isolated candidate and WebDriver session.');
  }
  const uid = typeof process.geteuid === 'function' ? process.geteuid() : null;
  const initialIdentity = identityShape(context.ownedAppIdentity, 'initial owned app identity');
  const initialDriverSessionId = driver.sessionId;
  if (typeof initialDriverSessionId !== 'string' || initialDriverSessionId.length === 0) {
    fail('Independent switch scenario requires the owned WebDriver session ID.');
  }
  if (uid === null || uid === 0 || initialIdentity.effectiveUid !== uid) {
    fail('Independent switch scenario requires the owned app and runner to share a non-root UID.');
  }
  const origin = await readFixture(candidate.vault, MARKER_TEXT.origin, 2, candidate.bundleSha256);
  const destination = await readFixture(
    candidate.destinationVault,
    MARKER_TEXT.destination,
    5,
    candidate.bundleSha256,
  );
  if (origin.path === destination.path) fail('Synthetic vaults must be distinct canonical directories.');
  const profile = await profileMode(candidate.profile);
  if (profile.uid !== uid) fail('Isolated profile must be owned by the runner non-root UID.');
  const initialRegistry = await captureRegistry(candidate.profile);
  assertRegistry(initialRegistry, origin.path, destination.path, origin.path, 'Initial');
  const initialRuntime = await context.verifyRuntimeIdentity();
  if (
    initialRuntime?.platform !== 'linux' ||
    initialRuntime?.dataPath !== candidate.expectedBackendDataPath ||
    initialRuntime?.webviewDataPath !== candidate.expectedWebviewDataPath
  ) {
    fail('Initial runtime is not bound to the isolated Linux backend and WebView profiles.');
  }
  const initialIdentityReadback = identityShape(
    await context.readOwnedAppIdentity(),
    'initial app identity readback',
  );
  if (!sameIdentity(initialIdentity, initialIdentityReadback))
    fail('Initial owned app identity changed before UI interaction.');
  const initialDom = await observeDocument(driver);
  if (
    initialDom.readyState !== 'complete' ||
    initialDom.brandPath !== origin.path ||
    initialDom.mainVisible !== true
  ) {
    fail('The initial document is not the open synthetic origin vault.');
  }
  const initialMarker = await probePublicMarker(driver, MARKER_TEXT.origin);
  const initialViews = await waitForViews(driver, origin.pageIds.views, 'Origin Views');
  const initialGrid = await waitForSourceGrid(driver, origin.pageIds.inventory, 2, origin.path);
  await waitForIdleSaved(driver, 'initial origin navigation');
  await screenshot(driver, path.join(candidate.evidence, 'switch-independent-initial-origin.png'));

  const receipt = {
    schema: 'morrow.native-switch-independent-receipt',
    version: 1,
    outcome: 'running',
    startedAt: new Date().toISOString(),
    ownership: {
      driverSessionId: initialDriverSessionId,
      identity: initialIdentity,
      runtimeIdentityBeforeFirstSwitch: {
        platform: initialRuntime.platform,
        dataPath: initialRuntime.dataPath,
        webviewDataPath: initialRuntime.webviewDataPath,
      },
      pathPolicy: 'Two new synthetic non-root-owned vaults and one isolated profile only.',
    },
    profile: { path: candidate.profile, directory: profile, registryBefore: initialRegistry },
    fixture: {
      origin: {
        path: origin.path,
        marker: origin.expectedMarker,
        quantity: origin.quantity,
        price: origin.price,
        total: origin.total,
        pageIds: origin.pageIds,
        linkedViews: origin.linkedViews,
        bundleSha256: origin.bundleSha256,
      },
      destination: {
        path: destination.path,
        marker: destination.expectedMarker,
        quantity: destination.quantity,
        price: destination.price,
        total: destination.total,
        pageIds: destination.pageIds,
        linkedViews: destination.linkedViews,
        bundleSha256: destination.bundleSha256,
      },
    },
    initial: {
      dom: initialDom,
      marker: initialMarker,
      linkedViews: initialViews.state,
      inventoryGrid: initialGrid,
    },
    flows: [],
    markdown: {
      initialOrigin: origin.markdown,
      initialDestination: destination.markdown,
    },
    limits: [
      'All three selection actions come from the real Sidebar Vaults menu.',
      'The permission failure changes only the synthetic profile parent directory mode and restores it exactly.',
      'The final wrapper holds only the real public select result after the Rust/filesystem operation settled.',
      'The public WebView bridge probe does not exercise the native Rust save chooser or filesystem dialog.',
      'Same-window location.reload may retain the same owned app PID, start time and WebDriver session.',
    ],
  };
  const vaultPaths = [origin.path, destination.path, candidate.profile];
  let primaryError = null;
  let barrierInstalled = false;
  const barrierKey = '__morrowSwitchIndependentBarrier_' + randomUUID().replace(/-/g, '');
  try {
    // Flow 1: select B through the real Sidebar menu and observe the helper reload.
    const beforeFirst = await observeDocument(driver);
    const firstTarget = await sidebarMenuItemAfterOpen(driver, origin.path, destination.path);
    await context.beginRuntimeRefresh();
    const firstClick = await clickRefResult(driver, firstTarget.id);
    const firstDocument = await waitForReloadDocument(context, beforeFirst, destination.path);
    const firstReload = await openAndVerifyVault(
      context,
      beforeFirst,
      destination.path,
      MARKER_TEXT.destination,
      5,
      destination,
      initialDriverSessionId,
    );
    const registryAfterFirst = await captureRegistry(candidate.profile);
    assertRegistry(registryAfterFirst, origin.path, destination.path, destination.path, 'First A-to-B');
    assertRegistryFront(registryAfterFirst, destination.path, 'First A-to-B');
    await screenshot(
      driver,
      path.join(candidate.evidence, 'switch-independent-destination-after-first-reload.png'),
    );
    receipt.flows.push({
      phase: 'real-sidebar-origin-to-destination',
      from: origin.path,
      to: destination.path,
      menuItem: firstTarget,
      click: firstClick,
      document: firstDocument,
      webDriverSessionIdAfterReload: driver.sessionId,
      verification: firstReload,
      registry: registryAfterFirst,
    });
    await recordStep('switch-independent-real-sidebar-a-to-b', {
      timeOriginBefore: beforeFirst.timeOrigin,
      timeOriginAfter: firstReload.timeOriginAfter,
      marker: MARKER_TEXT.destination,
      quantity: 5,
      registryCurrent: registryAfterFirst.current,
    });

    // Flow 2: chmod only the profile parent so atomic vaults.json creation fails.
    const sourceBeforeFailure = await captureMarkdown(destination.path);
    const originBeforeFailure = await captureMarkdown(origin.path);
    const failureRegistryBefore = await captureRegistry(candidate.profile);
    const failureProfileEntriesBefore = await fileList(candidate.profile);
    const beforeFailureUi = await observeDocument(driver);
    if (
      beforeFailureUi.brandPath !== destination.path ||
      beforeFailureUi.providers.length !== 1 ||
      beforeFailureUi.providers[0].rows[0]?.quantity !== '5'
    ) {
      fail('Permission failure must begin with the destination vault OPEN on its real Inventory page.');
    }
    await waitForIdleSaved(driver, 'before permission-denial switch');
    if (permissionError(beforeFailureUi.alerts)) {
      fail('A stale permission alert exists before the controlled profile write-denial action.');
    }
    const tempRegistryPath = path.join(candidate.profile, 'vaults.json.tmp');
    try {
      await lstat(tempRegistryPath);
      fail('The atomic vaults.json temp file already exists before the permission test.');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const failureClickTarget = await sidebarMenuItemAfterOpen(driver, destination.path, origin.path);
    const denied = await withProfileWritesDenied(candidate.profile, async ({ mode }) => {
      const click = await clickRefResult(driver, failureClickTarget.id, 1_500);
      const failedUi = await waitFor(
        () => observeDocument(driver),
        (state) =>
          state.timeOrigin === beforeFailureUi.timeOrigin &&
          state.brandPath === destination.path &&
          state.saveStatus?.label === 'Saved' &&
          !/(?:^|\s)is-(?:saving|error)(?:\s|$)/.test(state.saveStatus.className) &&
          permissionError(state.alerts),
        'real permission error while destination remains OPEN',
        2_500,
      );
      const openMarker = await probePublicMarker(driver, MARKER_TEXT.destination);
      if (openMarker.marker !== MARKER_TEXT.destination)
        fail('Public OPEN marker changed after the failed selection.');
      return { mode, click, ui: failedUi, openMarker };
    });
    const failureUi = denied.result.ui;
    const failureOpenMarker = await probePublicMarker(driver, MARKER_TEXT.destination);
    if (failureOpenMarker.marker !== MARKER_TEXT.destination)
      fail('Public OPEN marker changed after the failed selection.');
    if (denied.watchdogFired)
      fail('Profile mode watchdog fired before the real permission denial was observed.');
    await screenshot(
      driver,
      path.join(candidate.evidence, 'switch-independent-permission-denial-open-destination.png'),
    );
    const failureRegistryAfter = await captureRegistry(candidate.profile);
    const failureProfileEntriesAfter = await fileList(candidate.profile);
    const sourceAfterFailure = await captureMarkdown(destination.path);
    const originAfterFailure = await captureMarkdown(origin.path);
    assertMarkdownEqual(
      sourceBeforeFailure,
      sourceAfterFailure,
      'Known registry permission failure on OPEN destination',
    );
    assertMarkdownEqual(
      originBeforeFailure,
      originAfterFailure,
      'Known registry permission failure on registered origin',
    );
    if (
      failureRegistryBefore.sha256 !== failureRegistryAfter.sha256 ||
      failureRegistryBefore.size !== failureRegistryAfter.size ||
      failureRegistryBefore.mtimeMs !== failureRegistryAfter.mtimeMs ||
      failureRegistryAfter.current !== destination.path
    ) {
      fail('Failed atomic registry write changed vaults.json or the OPEN selection.');
    }
    assertRegistryFront(failureRegistryAfter, destination.path, 'Failed B-to-A');
    if (JSON.stringify(failureProfileEntriesBefore) !== JSON.stringify(failureProfileEntriesAfter)) {
      fail('Failed atomic registry write left an unexpected profile entry or removed an existing one.');
    }
    try {
      await lstat(tempRegistryPath);
      fail('Failed atomic registry write left vaults.json.tmp behind.');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (driver.sessionId !== initialDriverSessionId)
      fail('WebDriver session changed despite the failed selection not reloading the document.');
    const failureRuntime = await context.verifyRuntimeIdentity();
    if (
      failureRuntime?.dataPath !== candidate.expectedBackendDataPath ||
      failureRuntime?.webviewDataPath !== candidate.expectedWebviewDataPath
    ) {
      fail('The isolated runtime profile changed after the known failed selection.');
    }
    const afterFailureIdentity = identityShape(
      await context.readOwnedAppIdentity(),
      'app identity after known failure',
    );
    if (!sameIdentity(initialIdentity, afterFailureIdentity))
      fail('Owned app PID/start time changed after a failed selection without reload.');
    receipt.flows.push({
      phase: 'real-profile-permission-denial-keeps-destination-open',
      from: destination.path,
      to: origin.path,
      menuItem: failureClickTarget,
      click: denied.result.click,
      ui: failureUi,
      marker: failureOpenMarker,
      registryBefore: failureRegistryBefore,
      registryAfter: failureRegistryAfter,
      profileEntriesBefore: failureProfileEntriesBefore,
      profileEntriesAfter: failureProfileEntriesAfter,
      markdownBefore: { destination: sourceBeforeFailure, origin: originBeforeFailure },
      markdownAfter: { destination: sourceAfterFailure, origin: originAfterFailure },
      mode: denied.modeRestoration,
      watchdogFired: denied.watchdogFired,
      noReload: failureUi.timeOrigin === beforeFailureUi.timeOrigin,
      processIdentityAfter: afterFailureIdentity,
    });
    await recordStep('switch-independent-profile-permission-failure-kept-open', {
      timeOrigin: failureUi.timeOrigin,
      errorVisible: true,
      registryHashPreserved: failureRegistryBefore.sha256 === failureRegistryAfter.sha256,
      profileModeRestored: denied.modeRestoration.restored === denied.modeRestoration.before,
      markdownPreserved: true,
    });

    // Flow 3: retry B-to-A using real UI after exact permission restoration.
    const profileRestored = await profileMode(candidate.profile);
    if (profileRestored.mode !== denied.modeRestoration.before || profileRestored.uid !== uid) {
      fail('Profile mode or owner is not exact before UI retry.');
    }
    const retryTarget = await sidebarMenuItemAfterOpen(driver, destination.path, origin.path);
    const beforeRetry = await observeDocument(driver);
    await context.beginRuntimeRefresh();
    const retryClick = await clickRefResult(driver, retryTarget.id);
    const retryDocument = await waitForReloadDocument(context, beforeRetry, origin.path);
    const retryReload = await openAndVerifyVault(
      context,
      beforeRetry,
      origin.path,
      MARKER_TEXT.origin,
      2,
      origin,
      initialDriverSessionId,
    );
    const registryAfterRetry = await captureRegistry(candidate.profile);
    assertRegistry(
      registryAfterRetry,
      origin.path,
      destination.path,
      origin.path,
      'Restored-mode B-to-A retry',
    );
    assertRegistryFront(registryAfterRetry, origin.path, 'Restored-mode B-to-A retry');
    await screenshot(driver, path.join(candidate.evidence, 'switch-independent-origin-after-retry.png'));
    receipt.flows.push({
      phase: 'real-sidebar-retry-destination-to-origin',
      from: destination.path,
      to: origin.path,
      menuItem: retryTarget,
      click: retryClick,
      document: retryDocument,
      webDriverSessionIdAfterReload: driver.sessionId,
      verification: retryReload,
      registry: registryAfterRetry,
      profileMode: profileRestored,
    });
    await recordStep('switch-independent-restored-profile-retry-opened-origin', {
      timeOriginBefore: beforeRetry.timeOrigin,
      timeOriginAfter: retryReload.timeOriginAfter,
      marker: MARKER_TEXT.origin,
      quantity: 2,
    });

    // Final flow: public select call executes once, then only its real resolved value is held.
    const beforeBarrierUi = await waitForSourceGrid(driver, origin.pageIds.inventory, 2, origin.path);
    await waitForIdleSaved(driver, 'before final held select');
    const sourceBeforeBarrier = await captureMarkdown(origin.path);
    const destinationBeforeBarrier = await captureMarkdown(destination.path);
    const registryBeforeBarrier = await captureRegistry(candidate.profile);
    assertRegistry(registryBeforeBarrier, origin.path, destination.path, origin.path, 'Before final barrier');
    const barrierInstall = await runBarrierCommand(driver, 'install', barrierKey, destination.path);
    barrierInstalled = true;
    if (barrierInstall?.phase !== 'installed') fail('Public one-shot select barrier did not install.');
    await recordStep('switch-independent-public-select-barrier-installed', {
      targetPath: destination.path,
      descriptor: barrierInstall.descriptor,
      watchdogMs: BARRIER_LIMIT_MS,
    });

    const menuTarget = await sidebarMenuItemAfterOpen(driver, origin.path, destination.path);
    await context.beginRuntimeRefresh();
    const barrierClick = await clickRefResult(driver, menuTarget.id, 3_000);
    const held = await waitFor(
      () => runBarrierCommand(driver, 'read', barrierKey, destination.path),
      (value) => value.interceptedCallCount === 1 && value.settlement !== null,
      'real vault.select settlement held after registry write',
      BARRIER_LIMIT_MS - 1_000,
    );
    if (
      held.watchdogFired ||
      held.callCount !== 1 ||
      held.originalCallCount !== 1 ||
      held.interceptedCallCount !== 1 ||
      held.targetMatched !== true ||
      held.thisMatched !== true ||
      held.argsCount < 1 ||
      held.settlement?.kind !== 'fulfilled' ||
      held.settlement?.resultOk !== true
    ) {
      fail('Final barrier did not observe exactly one successful real public select settlement.');
    }
    const registryHeld = await captureRegistry(candidate.profile);
    assertRegistry(registryHeld, origin.path, destination.path, destination.path, 'Held final selection');
    assertRegistryFront(registryHeld, destination.path, 'Held final selection');
    const markerHeld = await probePublicMarker(driver, MARKER_TEXT.origin);
    const uiHeld = await observeDocument(driver);
    if (
      uiHeld.timeOrigin !== beforeBarrierUi.timeOrigin ||
      uiHeld.brandPath !== origin.path ||
      uiHeld.providerCount !== 1 ||
      uiHeld.providers[0].rows[0]?.quantity !== '2'
    ) {
      fail('The OPEN origin document or UI changed before delivery of the real select result.');
    }
    const identityHeld = identityShape(
      await context.readOwnedAppIdentity(),
      'owned process during held result',
    );
    if (!sameIdentity(initialIdentity, identityHeld))
      fail('Owned process identity changed during a same-document held result.');
    const runtimeHeld = await context.verifyRuntimeIdentity();
    if (
      runtimeHeld?.platform !== 'linux' ||
      runtimeHeld?.dataPath !== candidate.expectedBackendDataPath ||
      runtimeHeld?.webviewDataPath !== candidate.expectedWebviewDataPath
    ) {
      fail('Runtime profile changed during held result.');
    }

    const editButton = await driver.elements(
      '[data-provider="polaris-dados"] button[data-action="edit"][data-field="quantity"]',
    );
    if (editButton.length !== 1) fail('Expected one genuine Quantity edit button for the held W3C attempt.');
    const editId = driverElementId(editButton[0]);
    if (!editId) fail('The Quantity edit button has no W3C element reference.');
    const fenceBefore = await observeDocument(driver);
    let editAttempt;
    try {
      await clickRef(driver, editId, 2_500);
      editAttempt = { kind: 'resolved', requestIssued: true };
    } catch (error) {
      editAttempt = { kind: 'webdriver-error-or-timeout', requestIssued: true, error: shortError(error) };
    }
    await delay(150);
    const uiAfterEditAttempt = await observeDocument(driver);
    const visibleFence =
      fenceBefore.mainInert ||
      uiAfterEditAttempt.mainInert ||
      fenceBefore.providers[0]?.editControls === 0 ||
      uiAfterEditAttempt.providers[0]?.editControls === 0;
    if (
      uiAfterEditAttempt.timeOrigin !== beforeBarrierUi.timeOrigin ||
      uiAfterEditAttempt.brandPath !== origin.path ||
      uiAfterEditAttempt.inputCount !== 0 ||
      uiAfterEditAttempt.providers[0]?.rows[0]?.quantity !== '2' ||
      !visibleFence
    ) {
      fail('The held-switch WebDriver edit attempt was not visibly refused without changing Quantity.');
    }
    const originAfterAttempt = await captureMarkdown(origin.path);
    const destinationAfterAttempt = await captureMarkdown(destination.path);
    assertMarkdownEqual(
      sourceBeforeBarrier,
      originAfterAttempt,
      'Held-switch real edit attempt on OPEN origin',
    );
    assertMarkdownEqual(
      destinationBeforeBarrier,
      destinationAfterAttempt,
      'Held-switch real edit attempt on registered destination',
    );
    await screenshot(driver, path.join(candidate.evidence, 'switch-independent-held-result-open-origin.png'));
    const heldAfterAttempt = await runBarrierCommand(driver, 'read', barrierKey, destination.path);
    if (
      heldAfterAttempt.callCount !== 1 ||
      heldAfterAttempt.originalCallCount !== 1 ||
      heldAfterAttempt.interceptedCallCount !== 1 ||
      heldAfterAttempt.releaseRequested !== false ||
      heldAfterAttempt.delivered !== false ||
      heldAfterAttempt.restoreOutcome !== 'pending'
    ) {
      fail('Barrier state changed before the conditional descriptor restoration and release.');
    }
    receipt.flows.push({
      phase: 'real-select-settled-registry-destination-document-origin',
      from: origin.path,
      to: destination.path,
      menuItem: menuTarget,
      click: barrierClick,
      barrier: {
        installed: barrierInstall,
        held: held,
        registryBefore: registryBeforeBarrier,
        registryHeld: registryHeld,
        openMarkerHeld: markerHeld,
        domBefore: beforeBarrierUi,
        domHeld: uiHeld,
        webDriverEditAttempt: editAttempt,
        editFenceBefore: fenceBefore,
        domAfterEditAttempt: uiAfterEditAttempt,
        markdownBefore: { origin: sourceBeforeBarrier, destination: destinationBeforeBarrier },
        markdownAfter: { origin: originAfterAttempt, destination: destinationAfterAttempt },
        identityHeld,
        runtimeHeld: { dataPath: runtimeHeld.dataPath, webviewDataPath: runtimeHeld.webviewDataPath ?? null },
        restoration: null,
        release: null,
        finalReload: null,
      },
    });
    await recordStep('switch-independent-registry-advanced-open-origin-edit-refused', {
      registryCurrent: registryHeld.current,
      openMarker: MARKER_TEXT.origin,
      webDriverEditRefused: visibleFence && uiAfterEditAttempt.inputCount === 0,
      markdownUnchanged: true,
      settlement: held.settlement,
    });

    // Restore the exact method descriptor before delivery. Release schedules the true settlement
    // on the next page task so the WebDriver command can return before location.reload continues.
    const restoredBarrier = await runBarrierCommand(driver, 'restore', barrierKey, destination.path);
    if (!restoredBarrier.restored || restoredBarrier.state.restoreOutcome !== 'restored') {
      fail('Public select descriptor was not conditionally restored before result delivery.');
    }
    receipt.flows.at(-1).barrier.restoration = restoredBarrier;
    const releaseBarrier = await runBarrierCommand(driver, 'release', barrierKey, destination.path);
    if (!releaseBarrier.requested) fail('One-shot barrier refused its sole release request.');
    receipt.flows.at(-1).barrier.release = releaseBarrier;
    barrierInstalled = false;
    const finalReload = await openAndVerifyVault(
      context,
      beforeBarrierUi,
      destination.path,
      MARKER_TEXT.destination,
      5,
      destination,
      initialDriverSessionId,
    );
    const registryAfterBarrier = await captureRegistry(candidate.profile);
    assertRegistry(
      registryAfterBarrier,
      origin.path,
      destination.path,
      destination.path,
      'Final released destination',
    );
    assertRegistryFront(registryAfterBarrier, destination.path, 'Final released destination');
    receipt.flows.at(-1).barrier.finalReload = finalReload;
    receipt.flows.at(-1).barrier.webDriverSessionIdAfterReload = driver.sessionId;
    receipt.flows.at(-1).barrier.registryAfterRelease = registryAfterBarrier;
    receipt.flows.at(-1).barrier.deliveryEvidence = await takeBarrierDeliveryEvidence(driver, barrierKey);
    const delivery = receipt.flows.at(-1).barrier.deliveryEvidence;
    if (
      delivery?.delivered !== true ||
      delivery?.releaseRequested !== true ||
      delivery?.restoreOutcome !== 'restored' ||
      delivery?.watchdogFired !== false ||
      delivery?.callCount !== 1 ||
      delivery?.originalCallCount !== 1 ||
      delivery?.interceptedCallCount !== 1 ||
      delivery?.settlement?.kind !== 'fulfilled' ||
      delivery?.settlement?.resultOk !== true ||
      delivery?.deliveryEvidenceError
    ) {
      fail(
        'The real successful public select settlement was not delivered exactly once after descriptor restoration.',
      );
    }
    await screenshot(
      driver,
      path.join(candidate.evidence, 'switch-independent-destination-after-barrier-reload.png'),
    );
    const finalOriginMarkdown = await captureMarkdown(origin.path);
    const finalDestinationMarkdown = await captureMarkdown(destination.path);
    assertMarkdownEqual(origin.markdown, finalOriginMarkdown, 'End-to-end final origin Markdown readback');
    assertMarkdownEqual(
      destination.markdown,
      finalDestinationMarkdown,
      'End-to-end final destination Markdown readback',
    );
    receipt.markdown.finalOrigin = finalOriginMarkdown;
    receipt.markdown.finalDestination = finalDestinationMarkdown;
    await recordStep('switch-independent-restored-public-select-result-reloaded-destination', {
      timeOriginBefore: beforeBarrierUi.timeOrigin,
      timeOriginAfter: finalReload.timeOriginAfter,
      marker: MARKER_TEXT.destination,
      quantity: 5,
      realSettlementDelivered: true,
      bothVaultMarkdownUnchanged: true,
    });
  } catch (error) {
    primaryError = error;
  } finally {
    if (barrierInstalled) {
      let restorationSucceeded = false;
      try {
        const restored = await runBarrierCommand(driver, 'restore', barrierKey, destination.path);
        receipt.barrierRecovery = { restore: restored };
        restorationSucceeded = restored?.restored === true;
      } catch (restoreError) {
        receipt.barrierRecovery = { restoreError: shortError(restoreError, vaultPaths) };
      }
      try {
        const released = await runBarrierCommand(
          driver,
          restorationSucceeded ? 'release' : 'release-failsafe',
          barrierKey,
          destination.path,
        );
        receipt.barrierRecovery = {
          ...receipt.barrierRecovery,
          release: released,
          releaseWasFailsafe: !restorationSucceeded,
        };
      } catch (releaseError) {
        receipt.barrierRecovery = {
          ...receipt.barrierRecovery,
          releaseError: shortError(releaseError, vaultPaths),
        };
      }
    }
  }

  const receiptPath = await captureEvidenceReceipt(candidate, receipt, primaryError, recordStep, vaultPaths);
  receipt.receiptPath = receiptPath;
  if (primaryError) throw primaryError;
  return receipt;
}

async function sidebarMenuItemAfterOpen(driver, currentPath, targetPath) {
  await openSidebarMenu(driver, currentPath);
  return sidebarMenuItem(driver, targetPath);
}

async function clickRefResult(driver, id, timeoutMs = 5_000) {
  try {
    await clickRef(driver, id, timeoutMs);
    return { kind: 'resolved', requestIssued: true };
  } catch (error) {
    return { kind: 'webdriver-error-or-timeout', requestIssued: true, error: shortError(error) };
  }
}
