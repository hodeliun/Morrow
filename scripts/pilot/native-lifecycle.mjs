import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const PLUGIN_ID = 'polaris-dados';
const INSTALLED_MAIN = `.morrow/plugins/${PLUGIN_ID}/main.js`;
const FILES_TO_PRESERVE = ['Inventory.md', 'Inventory/Widget.md', 'Views.md', '.morrow/workspace.json'];
const SYNTHETIC_MARKDOWN = new Set(['Inventory.md', 'Inventory/Widget.md']);
const OBSERVER_KEY = '__MORROW_NATIVE_LIFECYCLE_OBSERVER__';
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
const WAIT_TIMEOUT_MS = 25_000;
const WAIT_INTERVAL_MS = 100;

const SETTINGS_LABELS = ['Settings', 'Configurações', 'Ajustes'];
const PLUGIN_SECTION_LABELS = ['Plugins', 'Complementos'];
const CLOSE_SETTINGS_LABELS = ['Close settings', 'Fechar configurações', 'Cerrar ajustes'];
const RELOAD_LABELS = ['Reload', 'Recarregar', 'Recargar'];

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function summary(file) {
  return { sha256: file.hash, size: file.size, mtimeMs: file.mtimeMs };
}

async function captureFile(filePath) {
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Expected a regular file: ${filePath}`);
  const bytes = await readFile(filePath);
  const after = await stat(filePath);
  return { bytes, hash: sha256(bytes), size: bytes.length, mtimeMs: after.mtimeMs };
}

export function assertFileSnapshotsUnchanged(before, after, label, { checkMtime = true } = {}) {
  const paths = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();
  if (!paths.length) throw new Error(`${label}: no files were captured.`);
  for (const relative of paths) {
    const initial = before?.[relative];
    const current = after?.[relative];
    if (!initial || !current) throw new Error(`${label}: missing snapshot for ${relative}.`);
    if (initial.hash !== current.hash || initial.size !== current.size) {
      throw new Error(`${label}: bytes changed for ${relative}.`);
    }
    if (checkMtime && initial.mtimeMs !== current.mtimeMs) {
      throw new Error(`${label}: mtime changed for ${relative}.`);
    }
  }
  return true;
}

export function assertJsonSnapshotsSemanticallyEqual(before, after, label) {
  let initial;
  let current;
  try {
    initial = JSON.parse(Buffer.from(before?.bytes ?? []).toString('utf8'));
    current = JSON.parse(Buffer.from(after?.bytes ?? []).toString('utf8'));
  } catch (error) {
    throw new Error(`${label}: plugin configuration snapshot is not valid JSON.`, { cause: error });
  }
  if (!isDeepStrictEqual(initial, current)) {
    throw new Error(`${label}: plugin configuration changed semantically.`);
  }
  return true;
}

export function assertMountTransitions(events, { mounts, unmounts }, label = 'provider lifecycle') {
  if (!Array.isArray(events)) throw new Error(`${label}: mount observer did not return an event list.`);
  if (!Number.isInteger(mounts) || !Number.isInteger(unmounts) || mounts < 0 || unmounts < 0) {
    throw new Error(`${label}: expected mount counts must be non-negative integers.`);
  }
  const kinds = events.map((event) => event?.kind);
  if (kinds.some((kind) => kind !== 'mount' && kind !== 'unmount')) {
    throw new Error(`${label}: observer returned an unknown provider transition.`);
  }
  const actualMounts = kinds.filter((kind) => kind === 'mount').length;
  const actualUnmounts = kinds.filter((kind) => kind === 'unmount').length;
  if (actualMounts !== mounts || actualUnmounts !== unmounts) {
    throw new Error(
      `${label}: expected ${mounts} mount(s) and ${unmounts} unmount(s), got ${actualMounts} and ${actualUnmounts}.`,
    );
  }
  for (let index = 1; index < kinds.length; index += 1) {
    if (kinds[index] === kinds[index - 1]) {
      throw new Error(`${label}: provider transitions were not paired: ${kinds.join(', ')}.`);
    }
  }
  if (!kinds.length || kinds[0] !== 'mount' || (mounts !== unmounts && mounts !== unmounts + 1)) {
    throw new Error(`${label}: expected an initially mounted provider and at most one live provider root.`);
  }
  const expectedFinal = mounts === unmounts ? 'unmount' : 'mount';
  if (kinds[kinds.length - 1] !== expectedFinal) {
    throw new Error(`${label}: expected the transition sequence to finish ${expectedFinal}ed.`);
  }
  return { mounts: actualMounts, unmounts: actualUnmounts, sequence: kinds };
}

export function createUnsupportedSchemaBytes(originalBytes) {
  const text = Buffer.from(originalBytes).toString('utf8');
  const viewsHeading = /^\x20{2}views:$/m;
  if (!viewsHeading.test(text))
    throw new Error('The synthetic source fixture has no database views heading.');
  const duplicateName = '    - id: lifecycle-name-duplicate\n      name: Name\n      type: text\n';
  return Buffer.from(text.replace(viewsHeading, `${duplicateName}  views:`));
}

async function syntheticVaultRoot(candidate) {
  if (typeof candidate?.vault !== 'string' || !path.isAbsolute(candidate.vault)) {
    throw new Error('Lifecycle fault injection requires an absolute synthetic vault path.');
  }
  const root = path.resolve(candidate.vault);
  const tempRoot = await realpath(os.tmpdir());
  if (path.dirname(root) !== tempRoot || (await realpath(root)) !== root) {
    throw new Error(
      'Lifecycle fault injection requires the canonical synthetic vault as a direct child of the temp directory.',
    );
  }
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Synthetic vault root is not a regular directory.');
  return root;
}

async function syntheticFile(candidate, relative, allowed = SYNTHETIC_MARKDOWN) {
  if (!allowed.has(relative))
    throw new Error(`Refusing to inject synthetic content outside the allowlist: ${relative}`);
  const root = await syntheticVaultRoot(candidate);
  const filePath = path.resolve(root, relative);
  if (!inside(root, filePath) || filePath === root || (await realpath(filePath)) !== filePath) {
    throw new Error(`Synthetic test path escaped its vault or used a symlink: ${relative}`);
  }
  return filePath;
}

export async function withSyntheticMarkdownOverride(candidate, relative, replacementBytes, action) {
  if (!(replacementBytes instanceof Uint8Array) || typeof action !== 'function') {
    throw new Error('Synthetic Markdown override requires replacement bytes and an action callback.');
  }
  const filePath = await syntheticFile(candidate, relative);
  const before = await captureFile(filePath);
  const replacement = Buffer.from(replacementBytes);
  if (sha256(replacement) === before.hash)
    throw new Error(`Synthetic override for ${relative} did not change its bytes.`);
  let writeAttempted = false;
  let injected;
  let result;
  let actionError;
  let restoreError;
  try {
    writeAttempted = true;
    await writeFile(filePath, replacement);
    injected = await captureFile(filePath);
    if (injected.hash !== sha256(replacement))
      throw new Error(`Synthetic override did not persist for ${relative}.`);
    result = await action({ filePath, before, injected });
  } catch (error) {
    actionError = error;
  }
  if (writeAttempted) {
    try {
      if ((await realpath(filePath)) !== filePath)
        throw new Error(`Refusing to restore a symlinked synthetic path: ${relative}`);
      await writeFile(filePath, before.bytes);
      const restored = await captureFile(filePath);
      if (restored.hash !== before.hash)
        throw new Error(`Synthetic override restoration failed for ${relative}.`);
    } catch (error) {
      restoreError = error;
    }
  }
  if (actionError) {
    if (restoreError && typeof actionError === 'object' && actionError !== null)
      actionError.cleanupError = restoreError;
    throw actionError;
  }
  if (restoreError) throw restoreError;
  const restored = await captureFile(filePath);
  return { result, filePath, before, injected, restored };
}

function activationFaultBytes() {
  return Buffer.from(
    "export default function activate() { throw new Error('synthetic lifecycle activation fault'); }\n",
  );
}

export async function withSyntheticActivationFault(candidate, action) {
  if (typeof action !== 'function')
    throw new Error('Synthetic activation fault requires an action callback.');
  const root = await syntheticVaultRoot(candidate);
  const installedPath = await syntheticFile(candidate, INSTALLED_MAIN, new Set([INSTALLED_MAIN]));
  if (typeof candidate.bundle !== 'string' || !path.isAbsolute(candidate.bundle)) {
    throw new Error('The frozen plugin bundle path must be absolute.');
  }
  const bundlePath = path.resolve(candidate.bundle ?? '');
  if (!path.isAbsolute(bundlePath) || inside(root, bundlePath) || bundlePath === installedPath) {
    throw new Error('The frozen plugin bundle must remain outside the synthetic vault fault target.');
  }
  if (typeof candidate.bundleSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(candidate.bundleSha256)) {
    throw new Error('Synthetic activation fault requires the frozen candidate bundle SHA-256.');
  }
  const original = await captureFile(installedPath);
  const bundleBefore = await captureFile(bundlePath);
  if (original.hash !== candidate.bundleSha256 || bundleBefore.hash !== candidate.bundleSha256) {
    throw new Error(
      'Fault injection requires the installed synthetic copy and frozen bundle to match the candidate hash.',
    );
  }
  const faultBytes = activationFaultBytes();
  const faultHash = sha256(faultBytes);
  if (faultHash === original.hash)
    throw new Error('Synthetic activation fault unexpectedly matches the frozen bundle.');
  let writeAttempted = false;
  let injected;
  let result;
  let actionError;
  let restoreError;
  try {
    writeAttempted = true;
    await writeFile(installedPath, faultBytes);
    injected = await captureFile(installedPath);
    if (injected.hash !== faultHash)
      throw new Error('Activation fault bytes did not persist to the installed synthetic copy.');
    result = await action({ installedPath, original, injected, bundleBefore });
  } catch (error) {
    actionError = error;
  }
  if (writeAttempted) {
    try {
      if ((await realpath(installedPath)) !== installedPath) {
        throw new Error('Refusing to restore a symlinked installed synthetic plugin path.');
      }
      await writeFile(installedPath, original.bytes);
      const restored = await captureFile(installedPath);
      if (restored.hash !== original.hash)
        throw new Error('Installed synthetic plugin copy was not restored byte for byte.');
      const bundleAfter = await captureFile(bundlePath);
      if (bundleAfter.hash !== bundleBefore.hash)
        throw new Error('Synthetic activation fault altered the frozen source bundle.');
    } catch (error) {
      restoreError = error;
    }
  }
  if (actionError) {
    if (restoreError && typeof actionError === 'object' && actionError !== null)
      actionError.cleanupError = restoreError;
    throw actionError;
  }
  if (restoreError) throw restoreError;
  const restored = await captureFile(installedPath);
  const bundleAfter = await captureFile(bundlePath);
  return { result, installedPath, original, injected, restored, bundleBefore, bundleAfter };
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(description, read, accept, timeoutMs = WAIT_TIMEOUT_MS) {
  if (typeof read !== 'function' || typeof accept !== 'function') {
    throw new Error(`${description}: waitFor requires read and accept callbacks.`);
  }
  const deadline = Date.now() + timeoutMs;
  let last;
  let lastError;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (accept(last)) return last;
    } catch (error) {
      lastError = error;
    }
    await pause(WAIT_INTERVAL_MS);
  }
  throw new Error(
    `Timed out waiting for ${description}: ${JSON.stringify(last ?? lastError?.message ?? null)}`,
  );
}

async function elementByText(driver, selector, labels, description, childSelector = null) {
  const reference = await driver.execute(
    `
    const labels = arguments[1];
    const childSelector = arguments[2];
    const matches = [...document.querySelectorAll(arguments[0])].filter((element) => {
      const target = childSelector ? element.querySelector(childSelector) : element;
      return labels.includes(target?.textContent?.trim() ?? '');
    });
    return matches.length === 1 ? matches[0] : null;
  `,
    [selector, labels, childSelector],
  );
  const id = reference?.[ELEMENT_KEY] ?? reference?.ELEMENT;
  if (!id) throw new Error(`Could not find the real ${description} control.`);
  return id;
}

async function clickReference(driver, id) {
  await driver.request('POST', driver.path(`/element/${id}/click`), {});
}

async function clickByText(driver, selector, labels, description, childSelector = null) {
  const id = await elementByText(driver, selector, labels, description, childSelector);
  await clickReference(driver, id);
}

async function openPluginSettings(driver, candidate) {
  const pluginName = candidate.pluginName ?? 'Polaris Dados';
  const alreadyOpen = await driver.execute('return Boolean(document.querySelector(".settings-dialog"));');
  if (!alreadyOpen) {
    await clickByText(
      driver,
      '.sidebar-footer .nav-item',
      SETTINGS_LABELS,
      'Settings navigation',
      '.nav-label',
    );
    await waitFor(
      'real Settings dialog',
      () => driver.execute('return Boolean(document.querySelector(".settings-dialog"));'),
      Boolean,
    );
  }
  const currentSection = await driver.execute(
    'return document.querySelector(".settings-nav-item[aria-current=page]")?.textContent?.trim() ?? "";',
  );
  if (!PLUGIN_SECTION_LABELS.includes(currentSection)) {
    await clickByText(
      driver,
      '.settings-dialog .settings-nav-item',
      PLUGIN_SECTION_LABELS,
      'Plugins settings section',
    );
  }
  await waitFor(
    'the real Polaris Dados switch in Settings',
    () =>
      driver.execute(
        `return [...document.querySelectorAll('.settings-dialog [role="switch"]')]
      .filter((item) => item.getAttribute('aria-label') === arguments[0]).length;`,
        [pluginName],
      ),
    (count) => count === 1,
  );
}

async function pluginSwitch(driver, pluginName) {
  return driver.execute(
    `
    const matches = [...document.querySelectorAll('.settings-dialog [role="switch"]')]
      .filter((item) => item.getAttribute('aria-label') === arguments[0]);
    return matches.length === 1 ? {
      checked: matches[0].getAttribute('aria-checked') === 'true',
      disabled: matches[0].disabled,
    } : null;
  `,
    [pluginName],
  );
}

async function setPluginEnabled(driver, candidate, enabled) {
  const pluginName = candidate.pluginName ?? 'Polaris Dados';
  const current = await pluginSwitch(driver, pluginName);
  if (!current) throw new Error('The synthetic Polaris Dados switch was not present in Settings.');
  if (current.disabled) throw new Error('The synthetic Polaris Dados switch was unexpectedly disabled.');
  if (current.checked !== enabled) {
    const reference = await driver.execute(
      `return [...document.querySelectorAll('.settings-dialog [role="switch"]')]
      .find((item) => item.getAttribute('aria-label') === arguments[0]) ?? null;`,
      [pluginName],
    );
    const id = reference?.[ELEMENT_KEY] ?? reference?.ELEMENT;
    if (!id) throw new Error('Could not locate the real Polaris Dados switch in Settings.');
    await clickReference(driver, id);
  }
  await waitFor(
    `synthetic plugin enabled=${enabled}`,
    async () => {
      const file = JSON.parse(await readFile(path.join(candidate.vault, '.morrow', 'plugins.json'), 'utf8'));
      return Array.isArray(file.enabled) && file.enabled.includes(PLUGIN_ID) === enabled;
    },
    (value) => value === true,
  );
  await waitFor(
    `Settings switch enabled=${enabled}`,
    () => pluginSwitch(driver, pluginName),
    (value) => value?.checked === enabled,
  );
}

async function closePluginSettings(driver) {
  const id = await driver
    .execute(
      `
    const labels = arguments[0];
    const matches = [...document.querySelectorAll('.settings-dialog button[aria-label]')]
      .filter((element) => labels.includes(element.getAttribute('aria-label')));
    return matches.length === 1 ? matches[0] : null;
  `,
      [CLOSE_SETTINGS_LABELS],
    )
    .then((reference) => reference?.[ELEMENT_KEY] ?? reference?.ELEMENT ?? null);
  if (!id) throw new Error('Could not find the real Close Settings control.');
  await clickReference(driver, id);
  await waitFor(
    'Settings dialog closed',
    () => driver.execute('return !document.querySelector(".settings-dialog");'),
    Boolean,
  );
}

async function clickPluginReload(driver) {
  const reference = await driver.execute(
    `
    const labels = arguments[0];
    const matches = [...document.querySelectorAll('.settings-dialog button[aria-label]')]
      .filter((element) => labels.includes(element.getAttribute('aria-label')));
    return matches.length === 1 ? matches[0] : null;
  `,
    [RELOAD_LABELS],
  );
  const id = reference?.[ELEMENT_KEY] ?? reference?.ELEMENT;
  if (!id) throw new Error('Could not find the real plugin Reload button.');
  await clickReference(driver, id);
}

async function pageState(driver) {
  return driver.execute(`
    const root = document.querySelector('[data-provider="polaris-dados"]');
    const fallback = document.querySelector('section.provider-fallback');
    const grid = root?.querySelector('.polaris-dados-grid') ?? null;
    const row = grid?.querySelector('tbody tr') ?? null;
    const quantity = row?.querySelector('[data-field="quantity"]')?.textContent?.trim() ?? null;
    const total = row?.querySelector('[data-field="total"]')?.textContent?.trim() ?? null;
    const save = root?.querySelector('button[data-action="save"]') ?? null;
    const input = root?.querySelector('input[data-field="quantity"]') ?? null;
    return {
      providerCount: document.querySelectorAll('[data-provider="polaris-dados"]').length,
      fallbackPresent: fallback !== null,
      fallbackText: fallback?.innerText ?? '',
      fallbackRows: fallback?.querySelectorAll('tbody tr').length ?? 0,
      fallbackEditControls: fallback?.querySelectorAll('input,textarea,select,[data-action="edit"],[data-action="save"]').length ?? 0,
      rootText: root?.textContent ?? '',
      gridPresent: grid !== null,
      quantity,
      total,
      saveDisabled: save?.disabled ?? null,
      inputValue: input?.value ?? null,
      statusText: [...(root?.querySelectorAll('[role="status"],[role="alert"]') ?? [])]
        .map((node) => node.innerText?.trim() ?? '').filter(Boolean),
      settingsErrorVisible: (document.querySelector('.settings-dialog')?.innerText ?? '')
        .includes('synthetic lifecycle activation fault'),
      editableControls: root?.querySelectorAll('button[data-action="edit"],button[data-action="save"],input[data-field="quantity"]').length ?? 0,
    };
  `);
}

function assertFallbackIsReadableReadonly(state, label) {
  if (state.providerCount !== 0 || !state.fallbackPresent) {
    throw new Error(`${label}: expected the host's readable fallback, got ${JSON.stringify(state)}.`);
  }
  for (const labelText of ['Widget', 'Quantity', 'Price']) {
    if (!state.fallbackText.includes(labelText)) throw new Error(`${label}: fallback omitted ${labelText}.`);
  }
  if (state.fallbackRows !== 1 || state.fallbackEditControls !== 0) {
    throw new Error(`${label}: fallback was not a single read-only row: ${JSON.stringify(state)}.`);
  }
}

async function readMountEvents(driver) {
  return driver.execute(`return window[arguments[0]]?.events?.slice() ?? null;`, [OBSERVER_KEY]);
}

async function waitMountEvents(driver, expectedMounts, expectedUnmounts, label) {
  await waitFor(
    label,
    () => readMountEvents(driver),
    (value) => {
      if (!Array.isArray(value)) return false;
      return (
        value.filter((event) => event.kind === 'mount').length >= expectedMounts &&
        value.filter((event) => event.kind === 'unmount').length >= expectedUnmounts
      );
    },
  );
  await pause(150);
  const settled = await readMountEvents(driver);
  return assertMountTransitions(settled, { mounts: expectedMounts, unmounts: expectedUnmounts }, label);
}

async function installMountObserver(driver) {
  const installed = await driver.execute(
    `
    const key = arguments[0];
    if (Object.getOwnPropertyDescriptor(window, key)) return false;
    if (document.querySelectorAll('[data-provider="polaris-dados"]').length !== 0) return false;
    const events = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target;
        if (record.attributeName !== 'data-provider' || !target.matches?.('.database-provider-root')) continue;
        events.push({
          kind: target.getAttribute('data-provider') === 'polaris-dados' ? 'mount' : 'unmount',
          at: performance.now(),
        });
      }
    });
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-provider'] });
    Object.defineProperty(window, key, { configurable: true, value: { events, observer } });
    return true;
  `,
    [OBSERVER_KEY],
  );
  if (installed !== true)
    throw new Error('Could not install a fresh passive provider-mount observer at the Home boundary.');
}

async function removeMountObserver(driver) {
  await driver.execute(
    `
    const key = arguments[0];
    const state = window[key];
    if (!state) return false;
    state.observer.disconnect();
    return delete window[key];
  `,
    [OBSERVER_KEY],
  );
}

async function openDatabasePage(driver, databaseId) {
  const reference = await driver.execute(
    `
    const matches = [...document.querySelectorAll('.app [role="treeitem"][data-page-id]')]
      .filter((item) => item.getAttribute('data-page-id') === arguments[0]);
    return matches.length === 1 ? matches[0] : null;
  `,
    [databaseId],
  );
  const id = reference?.[ELEMENT_KEY] ?? reference?.ELEMENT;
  if (!id) throw new Error('Could not locate the generated synthetic Inventory page in the real sidebar.');
  await clickReference(driver, id);
  await waitFor(
    'one mounted Polaris Dados source grid',
    async () => {
      const state = await pageState(driver);
      return state.providerCount === 1 && state.gridPresent ? state : false;
    },
    (state) => Boolean(state),
  );
}

async function captureSet(root, relatives) {
  const entries = await Promise.all(
    relatives.map(async (relative) => [relative, await captureFile(path.join(root, relative))]),
  );
  return Object.fromEntries(entries);
}

async function rowQuantity(rowPath) {
  const text = await readFile(rowPath, 'utf8');
  const match = /^Quantity:\s*(\d+(?:\.\d+)?)\s*$/m.exec(text);
  if (!match) throw new Error('The synthetic Widget row no longer has a scalar Quantity field.');
  return Number(match[1]);
}

async function waitQuantity(rowPath, expected) {
  await waitFor(
    `synthetic Quantity=${expected}`,
    async () => rowQuantity(rowPath),
    (value) => value === expected,
  );
}

async function waitForSaveSettled(driver, quantity, total) {
  await waitFor(
    'the native Save or Undo flush to settle',
    () => pageState(driver),
    (state) =>
      state.gridPresent &&
      state.quantity === String(quantity) &&
      state.total === String(total) &&
      !state.statusText.some((message) => /saving|salvando|guardando/i.test(message)),
  );
}

async function openQuantityEditor(driver) {
  await driver.click('[data-provider="polaris-dados"] button[data-action="edit"][data-field="quantity"]');
  const selector = '[data-provider="polaris-dados"] input[type="number"][data-field="quantity"]';
  await waitFor(
    'real Quantity editor',
    () => driver.execute(`return Boolean(document.querySelector(arguments[0]));`, [selector]),
    Boolean,
  );
  await driver.click(selector);
  await driver.clear(selector);
  return selector;
}

async function setQuantityDraft(driver, value) {
  const selector = await openQuantityEditor(driver);
  await driver.sendKeys(selector, String(value));
  const observed = await driver.execute(`return document.querySelector(arguments[0])?.value ?? null;`, [
    selector,
  ]);
  if (observed !== String(value)) throw new Error(`Synthetic draft input did not retain Quantity=${value}.`);
}

async function saveQuantity(driver, rowPath, value) {
  await setQuantityDraft(driver, value);
  await driver.click('[data-provider="polaris-dados"] button[data-action="save"]');
  await waitQuantity(rowPath, value);
  await waitForSaveSettled(driver, value, value * 10);
}

async function undoAtProviderRoot(driver) {
  const selector = '[data-provider="polaris-dados"]';
  await driver.click(selector);
  await driver.sendKeys(selector, '\uE009z');
}

async function readPageId(vault, relativePath) {
  const workspace = JSON.parse(await readFile(path.join(vault, '.morrow', 'workspace.json'), 'utf8'));
  const entry = workspace.pages?.[relativePath];
  if (typeof entry?.id !== 'string' || !entry.id)
    throw new Error(`Synthetic workspace has no page ID for ${relativePath}.`);
  return entry.id;
}

async function openHome(driver) {
  await clickByText(
    driver,
    '.sidebar-nav .nav-item',
    ['Home', 'Início', 'Inicio'],
    'Home navigation',
    '.nav-label',
  );
  await waitFor(
    'the Home route with no provider mounted',
    async () => {
      const state = await driver.execute(`return {
      home: Boolean(document.querySelector('.home')),
      providerCount: document.querySelectorAll('[data-provider="polaris-dados"]').length,
    };`);
      return state;
    },
    (state) => state.home && state.providerCount === 0,
  );
}

export async function runNativeLifecycleScenario({ driver, candidate, prepared, recordStep }) {
  if (
    !driver ||
    !candidate?.vault ||
    !candidate?.evidence ||
    !candidate?.databaseId ||
    !prepared?.bankBefore
  ) {
    throw new Error(
      'The native lifecycle scenario requires the isolated driver and prepared synthetic source.',
    );
  }
  if (typeof recordStep !== 'function')
    throw new Error('The native lifecycle scenario requires the runner evidence callback.');

  const root = await syntheticVaultRoot(candidate);
  const rowPath = await syntheticFile(candidate, 'Inventory/Widget.md');
  const sourcePath = await syntheticFile(candidate, 'Inventory.md');
  const installedPath = await syntheticFile(candidate, INSTALLED_MAIN, new Set([INSTALLED_MAIN]));
  const initialBundle = await captureFile(candidate.bundle);
  const initialInstalled = await captureFile(installedPath);
  if (initialBundle.hash !== candidate.bundleSha256 || initialInstalled.hash !== candidate.bundleSha256) {
    throw new Error('The frozen bundle and installed synthetic copy must match before lifecycle testing.');
  }
  const baseline = await captureSet(root, [...FILES_TO_PRESERVE, '.morrow/plugins.json']);
  const rowId = await readPageId(root, 'Inventory/Widget.md');

  await installMountObserver(driver);
  let observerInstalled = true;
  try {
    await openDatabasePage(driver, candidate.databaseId);
    await waitMountEvents(driver, 1, 0, 'initial source mount');
    await recordStep('lifecycle-source-mounted-once', {
      databaseId: candidate.databaseId,
      rowId,
      providerCount: 1,
      bundleSha256: initialBundle.hash,
      installedSha256: initialInstalled.hash,
    });

    let expectedMounts = 1;
    let expectedUnmounts = 0;
    for (let cycle = 1; cycle <= 2; cycle += 1) {
      await openPluginSettings(driver, candidate);
      await setPluginEnabled(driver, candidate, false);
      expectedUnmounts += 1;
      await waitFor(
        `readable read-only fallback after disable ${cycle}`,
        () => pageState(driver),
        (state) => state.providerCount === 0 && state.fallbackPresent,
      );
      const disabled = await pageState(driver);
      assertFallbackIsReadableReadonly(disabled, `disable cycle ${cycle}`);
      await waitMountEvents(
        driver,
        expectedMounts,
        expectedUnmounts,
        `provider unload after disable ${cycle}`,
      );
      await driver.screenshot(path.join(candidate.evidence, `lifecycle-disabled-fallback-${cycle}.png`));
      await recordStep(`lifecycle-plugin-disabled-${cycle}-read-only-fallback`, {
        providerCount: disabled.providerCount,
        fallbackText: disabled.fallbackText,
        fallbackRows: disabled.fallbackRows,
      });

      await setPluginEnabled(driver, candidate, true);
      expectedMounts += 1;
      await waitFor(
        `provider remount after enable ${cycle}`,
        () => pageState(driver),
        (state) => state.providerCount === 1 && state.gridPresent,
      );
      await waitMountEvents(
        driver,
        expectedMounts,
        expectedUnmounts,
        `provider remount after enable ${cycle}`,
      );
      await clickPluginReload(driver);
      expectedUnmounts += 1;
      expectedMounts += 1;
      await waitFor(
        `exactly one provider after Reload ${cycle}`,
        () => pageState(driver),
        (state) => state.providerCount === 1 && state.gridPresent,
      );
      await waitMountEvents(
        driver,
        expectedMounts,
        expectedUnmounts,
        `exact provider transition after Reload ${cycle}`,
      );
      const counts = await readMountEvents(driver);
      assertMountTransitions(
        counts,
        { mounts: expectedMounts, unmounts: expectedUnmounts },
        `Reload cycle ${cycle}`,
      );
      await closePluginSettings(driver);
      await recordStep(`lifecycle-plugin-reenabled-and-reloaded-${cycle}`, {
        expectedMounts,
        expectedUnmounts,
        transitions: counts.map(({ kind }) => kind),
      });
    }

    const afterCycles = await captureSet(root, [...FILES_TO_PRESERVE, '.morrow/plugins.json']);
    assertFileSnapshotsUnchanged(
      Object.fromEntries(FILES_TO_PRESERVE.map((relative) => [relative, baseline[relative]])),
      Object.fromEntries(FILES_TO_PRESERVE.map((relative) => [relative, afterCycles[relative]])),
      'Repeated Settings disable/enable and Reload',
    );
    assertJsonSnapshotsSemanticallyEqual(
      baseline['.morrow/plugins.json'],
      afterCycles['.morrow/plugins.json'],
      'Repeated Settings toggles must restore the plugin configuration semantically',
    );
    await recordStep('lifecycle-repeated-settings-preserved-synthetic-files', {
      cycles: 2,
      reloads: 2,
      files: Object.fromEntries(
        [...FILES_TO_PRESERVE, '.morrow/plugins.json'].map((relative) => [
          relative,
          summary(afterCycles[relative]),
        ]),
      ),
    });

    const faultMarkdownBefore = await captureSet(root, ['Inventory.md', 'Inventory/Widget.md', 'Views.md']);
    const activationFault = await withSyntheticActivationFault(candidate, async ({ injected }) => {
      await openPluginSettings(driver, candidate);
      await clickPluginReload(driver);
      expectedUnmounts += 1;
      const faultFallback = await waitFor(
        'readable fallback after the synthetic activation failure',
        () => pageState(driver),
        (state) => state.providerCount === 0 && state.fallbackPresent,
      );
      assertFallbackIsReadableReadonly(faultFallback, 'synthetic activation failure');
      await waitFor(
        'the synthetic activation diagnostic in Settings',
        () => pageState(driver),
        (state) => state.settingsErrorVisible,
      );
      const filesAfterFailure = await captureSet(root, ['Inventory.md', 'Inventory/Widget.md', 'Views.md']);
      assertFileSnapshotsUnchanged(
        faultMarkdownBefore,
        filesAfterFailure,
        'Synthetic activation failure must preserve all three Markdown files and their mtimes',
      );
      await waitMountEvents(
        driver,
        expectedMounts,
        expectedUnmounts,
        'provider unmount after activation failure',
      );
      await driver.screenshot(path.join(candidate.evidence, 'lifecycle-activation-failure-fallback.png'));
      await recordStep('lifecycle-installed-copy-activation-fault-fell-back-readonly', {
        target: INSTALLED_MAIN,
        faultSha256: injected.hash,
        frozenBundleSha256: initialBundle.hash,
        providerCount: faultFallback.providerCount,
        fallbackText: faultFallback.fallbackText,
      });
      return { providerCount: faultFallback.providerCount, fallbackText: faultFallback.fallbackText };
    });
    if (
      activationFault.restored.hash !== initialInstalled.hash ||
      activationFault.bundleAfter.hash !== initialBundle.hash
    ) {
      throw new Error('The synthetic plugin restore did not match the initial installed and frozen hashes.');
    }
    await recordStep('lifecycle-installed-copy-restored-byte-for-byte', {
      originalInstalled: summary(activationFault.original),
      faultInstalled: summary(activationFault.injected),
      restoredInstalled: summary(activationFault.restored),
      frozenBundleBefore: summary(activationFault.bundleBefore),
      frozenBundleAfter: summary(activationFault.bundleAfter),
    });

    await clickPluginReload(driver);
    expectedMounts += 1;
    await waitFor(
      'provider remount after restoring the original installed copy',
      () => pageState(driver),
      (state) => state.providerCount === 1 && state.gridPresent,
    );
    await waitMountEvents(
      driver,
      expectedMounts,
      expectedUnmounts,
      'provider remount after restoring original plugin code',
    );
    await closePluginSettings(driver);

    await saveQuantity(driver, rowPath, 3);
    const savedState = await pageState(driver);
    if (savedState.quantity !== '3' || savedState.total !== '30') {
      throw new Error(`One UI Save did not produce Quantity=3 and Total=30: ${JSON.stringify(savedState)}.`);
    }
    const afterSave = await captureFile(rowPath);
    await undoAtProviderRoot(driver);
    await waitQuantity(rowPath, 2);
    await waitForSaveSettled(driver, 2, 20);
    const afterUndo = await captureFile(rowPath);
    if (afterUndo.hash !== baseline['Inventory/Widget.md'].hash) {
      throw new Error('One native Undo did not restore the single saved row change byte for byte.');
    }
    await undoAtProviderRoot(driver);
    await pause(400);
    const afterExtraUndoState = await pageState(driver);
    if (afterExtraUndoState.quantity !== '2' || afterExtraUndoState.total !== '20') {
      throw new Error(
        `A second native Undo changed the already restored value: ${JSON.stringify(afterExtraUndoState)}.`,
      );
    }
    const afterExtraUndo = await captureFile(rowPath);
    if (afterExtraUndo.hash !== afterUndo.hash || afterExtraUndo.mtimeMs !== afterUndo.mtimeMs) {
      throw new Error('A second native Undo had an observable duplicate effect after the only saved change.');
    }
    await recordStep('lifecycle-one-save-one-undo-no-duplicate-effect', {
      before: summary(baseline['Inventory/Widget.md']),
      afterSave: summary(afterSave),
      afterUndo: summary(afterUndo),
      afterExtraUndo: summary(afterExtraUndo),
      afterUndoUi: afterExtraUndoState,
    });

    const originalRow = await captureFile(rowPath);
    const rowText = originalRow.bytes.toString('utf8');
    const quantityLine = /^Quantity: 2$/m;
    if (!quantityLine.test(rowText))
      throw new Error('The synthetic row was not restored to Quantity=2 before conflict injection.');
    await setQuantityDraft(driver, 9);
    const draftState = await pageState(driver);
    if (draftState.inputValue !== '9')
      throw new Error('The synthetic Quantity=9 edit was not held as an unsaved UI draft.');
    const externalBytes = Buffer.from(rowText.replace(quantityLine, 'Quantity: 7'));
    const conflictSideBefore = await captureSet(root, ['Inventory.md', 'Views.md']);
    const conflict = await withSyntheticMarkdownOverride(
      candidate,
      'Inventory/Widget.md',
      externalBytes,
      async ({ injected }) => {
        const stale = await waitFor(
          'stale draft refusal after an external synthetic row change',
          () => pageState(driver),
          (state) =>
            state.saveDisabled === true &&
            /older data revision|changed before save|data changed|dados mudaram|datos cambiaron/i.test(
              state.statusText.join(' '),
            ),
        );
        if (stale.saveDisabled !== true)
          throw new Error('Save remained enabled for the stale synthetic draft.');
        const saveSelector = '[data-provider="polaris-dados"] button[data-action="save"]';
        const visibleSave = await driver.execute(`return Boolean(document.querySelector(arguments[0]));`, [
          saveSelector,
        ]);
        if (!visibleSave) throw new Error('The stale draft lost its Save control before the refusal check.');
        try {
          await driver.click(saveSelector);
        } catch (error) {
          if (!/disabled|not interactable|not enabled/i.test(String(error?.message ?? error))) throw error;
        }
        await pause(300);
        const afterRefusal = await captureFile(rowPath);
        assertFileSnapshotsUnchanged(
          { 'Inventory/Widget.md': injected },
          { 'Inventory/Widget.md': afterRefusal },
          'Stale UI Save must preserve the external synthetic row conflict',
        );
        const sideAfterRefusal = await captureSet(root, ['Inventory.md', 'Views.md']);
        assertFileSnapshotsUnchanged(
          conflictSideBefore,
          sideAfterRefusal,
          'External row conflict must preserve the other two Markdown files and their mtimes',
        );
        await driver.click('[data-provider="polaris-dados"] button[data-action="cancel"]');
        return { stale, afterRefusal, sideAfterRefusal };
      },
    );
    await recordStep('lifecycle-external-row-conflict-refused-save', {
      original: summary(conflict.before),
      externalVersion: summary(conflict.injected),
      afterRefusal: summary(conflict.result.afterRefusal),
      restored: summary(conflict.restored),
      saveDisabled: conflict.result.stale.saveDisabled,
      statusText: conflict.result.stale.statusText,
    });
    await waitFor(
      'restored original row visible after conflict fixture cleanup',
      async () => {
        const state = await pageState(driver);
        return (await rowQuantity(rowPath)) === 2 && state.gridPresent ? state : false;
      },
      Boolean,
    );

    const originalSchema = await captureFile(sourcePath);
    const unsupportedBytes = createUnsupportedSchemaBytes(originalSchema.bytes);
    const unsupportedSideBefore = await captureSet(root, ['Inventory/Widget.md', 'Views.md']);
    const unsupported = await withSyntheticMarkdownOverride(
      candidate,
      'Inventory.md',
      unsupportedBytes,
      async ({ injected }) => {
        const state = await waitFor(
          'read-only diagnostic for the synthetic unsupported schema',
          async () => {
            const current = await pageState(driver);
            return current.providerCount === 1 &&
              !current.gridPresent &&
              current.rootText
                .toLowerCase()
                .includes('duplicate, empty, or reserved property identifiers/names')
              ? current
              : false;
          },
          Boolean,
        );
        if (state.editableControls !== 0)
          throw new Error('Unsupported synthetic schema still exposed editable provider controls.');
        await pause(350);
        const afterWait = await captureFile(sourcePath);
        assertFileSnapshotsUnchanged(
          { 'Inventory.md': injected },
          { 'Inventory.md': afterWait },
          'Opening unsupported synthetic schema must preserve its bytes and mtime',
        );
        const sideAfterWait = await captureSet(root, ['Inventory/Widget.md', 'Views.md']);
        assertFileSnapshotsUnchanged(
          unsupportedSideBefore,
          sideAfterWait,
          'Unsupported synthetic schema must preserve the other two Markdown files and their mtimes',
        );
        await driver.screenshot(path.join(candidate.evidence, 'lifecycle-unsupported-schema-readonly.png'));
        return { state, afterWait, sideAfterWait };
      },
    );
    await recordStep('lifecycle-unsupported-schema-remained-readonly-and-unchanged', {
      original: summary(unsupported.before),
      unsupported: summary(unsupported.injected),
      afterReadOnlyOpen: summary(unsupported.result.afterWait),
      restored: summary(unsupported.restored),
      ui: unsupported.result.state,
    });
    await waitFor(
      'provider grid recovered after restoring the synthetic schema',
      () => pageState(driver),
      (state) => state.providerCount === 1 && state.gridPresent,
    );

    await assertMountTransitions(
      await readMountEvents(driver),
      {
        mounts: expectedMounts,
        unmounts: expectedUnmounts,
      },
      'final lifecycle mount count',
    );
    const finalContent = await captureSet(root, [...FILES_TO_PRESERVE, '.morrow/plugins.json']);
    assertFileSnapshotsUnchanged(
      Object.fromEntries(
        ['Views.md', '.morrow/workspace.json'].map((relative) => [relative, baseline[relative]]),
      ),
      Object.fromEntries(
        ['Views.md', '.morrow/workspace.json'].map((relative) => [relative, finalContent[relative]]),
      ),
      'Lifecycle, fallback and unsupported tests',
    );
    assertFileSnapshotsUnchanged(
      { 'Inventory.md': baseline['Inventory.md'] },
      { 'Inventory.md': finalContent['Inventory.md'] },
      'Synthetic schema restoration',
      { checkMtime: false },
    );
    if (finalContent['Inventory/Widget.md'].hash !== baseline['Inventory/Widget.md'].hash) {
      throw new Error(
        'The synthetic row did not return to its original bytes after Save/Undo and conflict restoration.',
      );
    }
    assertJsonSnapshotsSemanticallyEqual(
      baseline['.morrow/plugins.json'],
      finalContent['.morrow/plugins.json'],
      'Final synthetic plugin enabled configuration',
    );
    const finalPluginState = JSON.parse(finalContent['.morrow/plugins.json'].bytes.toString('utf8'));
    if (!finalPluginState.enabled?.includes(PLUGIN_ID))
      throw new Error('Polaris Dados was not restored to enabled in the synthetic vault.');
    const finalInstalled = await captureFile(installedPath);
    const finalBundle = await captureFile(candidate.bundle);
    if (finalInstalled.hash !== initialInstalled.hash || finalBundle.hash !== initialBundle.hash) {
      throw new Error('Lifecycle testing changed the installed original copy or frozen bundle.');
    }
    await recordStep('lifecycle-complete', {
      expectedMounts,
      expectedUnmounts,
      installedBundleSha256: finalInstalled.hash,
      frozenBundleSha256: finalBundle.hash,
      finalFiles: Object.fromEntries(
        Object.entries(finalContent).map(([relative, file]) => [relative, summary(file)]),
      ),
    });

    await removeMountObserver(driver);
    observerInstalled = false;
    await closePluginSettings(driver).catch(() => undefined);
    await openHome(driver);
  } finally {
    if (observerInstalled) await removeMountObserver(driver).catch(() => undefined);
  }
}
