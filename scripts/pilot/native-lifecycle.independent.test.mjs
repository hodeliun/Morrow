// Independent Linux-native lifecycle, fallback and synthetic-file safety checks.
// The common runner owns the candidate, private runtime, driver lifecycle and evidence retention.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
const PLUGIN_ID = 'polaris-dados';
const CONTENT_PATHS = [
  'Inventory.md',
  'Inventory/Widget.md',
  'Views.md',
  '.morrow/workspace.json',
  '.morrow/plugins.json',
  '.morrow/plugins/polaris-dados/manifest.json',
];
const MARKDOWN_PATHS = ['Inventory.md', 'Inventory/Widget.md', 'Views.md'];
const KEY = { ctrl: '\uE009', comma: ',' };

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function vaultFile(vault, relative) {
  const root = path.resolve(vault);
  const file = path.resolve(root, relative);
  assert.ok(inside(root, file) && file !== root, `Synthetic path must stay below its vault: ${relative}`);
  return file;
}

async function capture(file) {
  const info = await lstat(file);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `Expected a regular synthetic file: ${file}`);
  const bytes = await readFile(file);
  return { bytes, sha256: sha256(bytes), size: bytes.length, mtimeMs: info.mtimeMs };
}

function summary(value) {
  return { sha256: value.sha256, size: value.size, mtimeMs: value.mtimeMs };
}

function assertSameFile(before, after, label) {
  assert.equal(after.sha256, before.sha256, `${label}: bytes changed.`);
  assert.equal(after.size, before.size, `${label}: size changed.`);
  assert.equal(after.mtimeMs, before.mtimeMs, `${label}: mtime changed.`);
}

async function captureMarkdownFiles(vault) {
  return Object.fromEntries(await Promise.all(MARKDOWN_PATHS.map(async (relative) => [
    relative,
    await capture(vaultFile(vault, relative)),
  ])));
}

function assertMarkdownFilesSame(before, after, label) {
  for (const relative of MARKDOWN_PATHS) {
    assertSameFile(before[relative], after[relative], `${label}: ${relative}`);
  }
}

function summarizeFiles(files) {
  return Object.fromEntries(MARKDOWN_PATHS.map((relative) => [relative, summary(files[relative])]));
}

function quantityOf(markdown) {
  const match = /^\s*Quantity\s*:\s*(.*?)\s*$/im.exec(markdown);
  assert.ok(match, 'Synthetic row must contain a Quantity frontmatter field.');
  return Number(match[1]);
}

async function workspaceIds(vault) {
  const workspace = JSON.parse(await readFile(vaultFile(vault, '.morrow/workspace.json'), 'utf8'));
  const pages = workspace.pages ?? {};
  const result = {
    source: pages['Inventory.md']?.id,
    row: pages['Inventory/Widget.md']?.id,
    note: pages['Views.md']?.id,
  };
  assert.ok(Object.values(result).every((id) => typeof id === 'string' && id.length > 0),
    'Synthetic workspace must retain stable source, row and note IDs.');
  return result;
}

async function waitFor(check, label, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function elementRef(driver, selector, label = selector) {
  const reference = await driver.execute('return document.querySelector(arguments[0]) ?? null;', [selector]);
  const id = reference?.[ELEMENT_KEY] ?? reference?.ELEMENT;
  if (!id) throw new Error(`No rendered element for ${label}.`);
  return id;
}

async function elementByText(driver, selector, text, label) {
  const reference = await driver.execute(`return [...document.querySelectorAll(arguments[0])]
    .find((element) => element.textContent?.trim() === arguments[1]) ?? null;`, [selector, text]);
  const id = reference?.[ELEMENT_KEY] ?? reference?.ELEMENT;
  if (!id) throw new Error(`Could not find ${label}.`);
  return id;
}

async function clickRef(driver, id) {
  return driver.request('POST', driver.path(`/element/${id}/click`), {});
}

async function clearRef(driver, id) {
  return driver.request('POST', driver.path(`/element/${id}/clear`), {});
}

async function typeRef(driver, id, text) {
  return driver.request('POST', driver.path(`/element/${id}/value`), { text, value: [...text] });
}

async function routeToPage(driver, pageId) {
  await driver.execute("location.hash = '#/page/' + encodeURIComponent(arguments[0]);", [pageId]);
}

async function readViewState(driver) {
  return driver.execute(`const providers = [...document.querySelectorAll('[data-provider="polaris-dados"]')];
    const fallbacks = [...document.querySelectorAll('.polaris-dados-view-fallback')];
    return {
      providerCount: providers.length,
      providers: providers.map((root) => ({
        title: root.querySelector('table[aria-label]')?.getAttribute('aria-label') ?? null,
        rowCount: root.querySelectorAll('tbody tr').length,
      })),
      fallbacks: fallbacks.map((node) => ({
        text: node.textContent?.trim() ?? '',
        contentEditable: node.contentEditable,
      })),
      pageText: document.querySelector('.ProseMirror[contenteditable]')?.textContent ?? '',
    };`);
}

async function readSourceState(driver) {
  return driver.execute(`const roots = [...document.querySelectorAll('[data-provider="polaris-dados"]')];
    const root = roots[0] ?? null;
    const row = root?.querySelector('tbody tr') ?? null;
    const cell = (name) => row?.querySelector('[data-field="' + name + '"]')?.textContent?.trim() ?? null;
    const input = root?.querySelector('input[type="number"][data-field="quantity"]') ?? null;
    const save = input?.closest('td')?.querySelector('button[data-action="save"]') ?? null;
    return {
      providerCount: roots.length,
      tablePresent: Boolean(root?.querySelector('table')),
      rowId: row?.dataset.rowId ?? null,
      quantity: input?.value ?? cell('quantity'),
      price: cell('price'),
      total: cell('total'),
      totalKind: row?.querySelector('[data-field="total"] [data-value-kind]')?.getAttribute('data-value-kind') ?? null,
      editCount: root?.querySelectorAll('button[data-action="edit"]').length ?? 0,
      saveDisabled: save?.disabled ?? null,
      saveAlerts: [...(root?.querySelectorAll('[role="alert"]') ?? [])].map((node) => node.textContent?.trim() ?? ''),
      rootText: root?.textContent ?? '',
    };`);
}

async function waitSource(driver, quantity, total) {
  return waitFor(async () => {
    const state = await readSourceState(driver);
    return state.providerCount === 1 && state.tablePresent && state.quantity === String(quantity)
      && state.total === String(total) ? state : false;
  }, `one provider grid with Quantity=${quantity} and Total=${total}`);
}

async function waitProviderCount(driver, expected) {
  return waitFor(async () => {
    const state = await readViewState(driver);
    return state.providerCount === expected ? state : false;
  }, `exactly ${expected} provider mounts`);
}

async function openPluginSettings(driver, pluginName) {
  await typeRef(driver, await elementRef(driver, 'body', 'document body'), `${KEY.ctrl}${KEY.comma}`);
  await waitFor(() => driver.execute('return Boolean(document.querySelector(".settings-dialog"));'), 'Settings opened by its keyboard shortcut');
  await clickRef(driver, await elementByText(driver, '.settings-nav-item', 'Plugins', 'Plugins settings section'));
  await waitFor(() => driver.execute(`return [...document.querySelectorAll('.settings-dialog [role="switch"]')]
    .some((item) => item.getAttribute('aria-label') === arguments[0]);`, [pluginName]), 'plugin switch in Settings');
}

async function switchPlugin(driver, pluginName, enabled) {
  const reference = await driver.execute(`return [...document.querySelectorAll('.settings-dialog [role="switch"]')]
    .find((item) => item.getAttribute('aria-label') === arguments[0]) ?? null;`, [pluginName]);
  const id = reference?.[ELEMENT_KEY] ?? reference?.ELEMENT;
  if (!id) throw new Error(`Plugin switch ${pluginName} was not present in Settings.`);
  const checked = await driver.execute(`return [...document.querySelectorAll('.settings-dialog [role="switch"]')]
    .find((item) => item.getAttribute('aria-label') === arguments[0])?.getAttribute('aria-checked') === 'true';`, [pluginName]);
  if (checked !== enabled) await clickRef(driver, id);
}

async function waitPluginSetting(vault, enabled) {
  return waitFor(async () => {
    const state = JSON.parse(await readFile(vaultFile(vault, '.morrow/plugins.json'), 'utf8'));
    return Array.isArray(state.enabled) && state.enabled.includes(PLUGIN_ID) === enabled ? state : false;
  }, `synthetic plugin configuration enabled=${enabled}`);
}

async function closeSettings(driver) {
  await clickRef(driver, await elementRef(driver, '.settings-dialog button[aria-label="Close settings"]', 'Close settings button'));
  await waitFor(() => driver.execute('return !document.querySelector(".settings-dialog");'), 'Settings closed');
}

async function clickReload(driver) {
  await clickRef(driver, await elementRef(driver, '.settings-dialog button[aria-label="Reload"]', 'plugin Reload button'));
}

async function assertReadonlyFallback(driver, sourceId, expectedCount, label) {
  const state = await waitFor(async () => {
    const current = await readViewState(driver);
    return current.providerCount === 0 && current.fallbacks.length === expectedCount ? current : false;
  }, `${expectedCount} readable fallback blocks after ${label}`);
  assert.ok(state.fallbacks.every((item) => item.contentEditable === 'false'), `${label}: every fallback must be read only.`);
  assert.ok(state.fallbacks.every((item) => item.text.includes(sourceId)), `${label}: fallback must identify the synthetic source.`);
  assert.ok(state.fallbacks.every((item) => /unavailable|activate|provider/i.test(item.text)),
    `${label}: fallback must explain why the linked view is unavailable.`);
  return state;
}

async function openQuantityEditor(driver) {
  await clickRef(driver, await elementRef(driver, '[data-provider="polaris-dados"] button[data-action="edit"][data-field="quantity"]', 'Quantity edit button'));
  await waitFor(() => driver.execute('return Boolean(document.querySelector("[data-provider=polaris-dados] input[type=number][data-field=quantity]"));'), 'Quantity editor');
  return elementRef(driver, '[data-provider="polaris-dados"] input[type="number"][data-field="quantity"]', 'Quantity input');
}

async function saveQuantity(driver, value) {
  const input = await openQuantityEditor(driver);
  await clearRef(driver, input);
  await typeRef(driver, input, String(value));
  const typed = await driver.execute('return document.querySelector("[data-provider=polaris-dados] input[type=number][data-field=quantity]")?.value ?? null;');
  assert.equal(typed, String(value), 'The UI draft must hold the requested quantity before Save.');
  await clickRef(driver, await elementRef(driver, '[data-provider="polaris-dados"] button[data-action="save"]', 'Quantity Save button'));
}

async function undoAtProviderRoot(driver) {
  const root = await elementRef(driver, '[data-provider="polaris-dados"]', 'provider root for native Undo');
  await clickRef(driver, root);
  await typeRef(driver, root, `${KEY.ctrl}z`);
}

export async function runIndependentNativeLifecycleScenario(context) {
  const { candidate, prepared, restartSession, recordStep } = context;
  let { driver } = context;
  assert.ok(driver && candidate?.vault && candidate?.evidence && candidate?.bundle,
    'The lifecycle scenario requires the isolated native driver and synthetic candidate.');
  assert.ok(prepared?.bankBefore && prepared?.originVaultContent,
    'The lifecycle scenario requires the runner prepared synthetic vault receipt.');
  assert.equal(typeof restartSession, 'function', 'The common runner must own the restart callback.');
  assert.equal(typeof recordStep, 'function', 'The common runner must own durable step recording.');

  const vaultRoot = await realpath(candidate.vault);
  const ids = await workspaceIds(vaultRoot);
  assert.equal(ids.source, candidate.databaseId, 'Inventory.md must be this synthetic vault source.');
  const sourcePath = vaultFile(vaultRoot, 'Inventory.md');
  const rowPath = vaultFile(vaultRoot, 'Inventory/Widget.md');
  const installedMainPath = vaultFile(vaultRoot, `.morrow/plugins/${PLUGIN_ID}/main.js`);
  const installedMain = await capture(installedMainPath);
  assert.equal(installedMain.sha256, candidate.bundleSha256,
    'The installed synthetic plugin must begin byte-identical to the frozen bundle.');
  const originalBundle = await capture(candidate.bundle);
  assert.equal(originalBundle.sha256, candidate.bundleSha256, 'The frozen source bundle hash must match the candidate.');
  assert.ok(!inside(vaultRoot, candidate.bundle), 'The frozen source bundle must remain outside the synthetic vault.');
  const starting = Object.fromEntries(await Promise.all(CONTENT_PATHS.map(async (relative) => [
    relative,
    await capture(vaultFile(vaultRoot, relative)),
  ])));
  const startingQuantity = quantityOf(starting['Inventory/Widget.md'].bytes.toString('utf8'));
  assert.equal(startingQuantity, 2, 'The isolated synthetic row must begin at Quantity=2.');
  const startingNote = starting['Views.md'].bytes.toString('utf8');
  const markers = [...startingNote.matchAll(/<!-- morrow:polaris-dados-view:v1:[A-Za-z0-9_-]+ -->/g)];
  assert.equal(markers.length, 2, 'The origin note must contain exactly two independent linked-view markers.');
  const configStart = JSON.parse(starting['.morrow/plugins.json'].bytes.toString('utf8'));
  assert.ok(configStart.enabled?.includes(PLUGIN_ID), 'The synthetic vault must start with Polaris Dados enabled.');

  await routeToPage(driver, ids.note);
  const initialViews = await waitProviderCount(driver, 2);
  assert.equal(initialViews.fallbacks.length, 0, 'The two original linked views must each have one provider mount.');
  await recordStep('independent-153-started-with-two-origin-mounts', {
    ids,
    providerCount: initialViews.providerCount,
    originalLinkedMarkers: markers.length,
    source: summary(starting['Inventory.md']),
    row: summary(starting['Inventory/Widget.md']),
    note: summary(starting['Views.md']),
    installedBundleSha256: installedMain.sha256,
  });

  for (let cycle = 1; cycle <= 2; cycle += 1) {
    await openPluginSettings(driver, candidate.pluginName);
    const checked = await driver.execute(`return [...document.querySelectorAll('.settings-dialog [role="switch"]')]
      .find((item) => item.getAttribute('aria-label') === arguments[0])?.getAttribute('aria-checked') ?? null;`, [candidate.pluginName]);
    assert.equal(checked, 'true', `Cycle ${cycle}: the UI must start with the plugin enabled.`);
    await switchPlugin(driver, candidate.pluginName, false);
    await waitPluginSetting(vaultRoot, false);
    await assertReadonlyFallback(driver, ids.source, 2, `cycle ${cycle} disable`);
    await closeSettings(driver);
    const settingsClosed = await driver.execute('return !document.querySelector(".settings-dialog");');
    assert.equal(settingsClosed, true, `Cycle ${cycle}: Settings must be closed for the fallback screenshot.`);
    const visibleFallback = await assertReadonlyFallback(
      driver,
      ids.source,
      2,
      `cycle ${cycle} disable with Settings closed`,
    );
    const fallbackScreenshot = `independent-153-disabled-fallback-${cycle}.png`;
    await driver.screenshot(path.join(candidate.evidence, fallbackScreenshot));
    await recordStep(`independent-153-plugin-disabled-${cycle}`, {
      providerCount: visibleFallback.providerCount,
      settingsClosed,
      fallbackScreenshot,
      fallbacks: visibleFallback.fallbacks.map(({ text, contentEditable }) => ({ text, contentEditable })),
      enabledFile: summary(await capture(vaultFile(vaultRoot, '.morrow/plugins.json'))),
    });
    await openPluginSettings(driver, candidate.pluginName);
    const disabledChecked = await driver.execute(`return [...document.querySelectorAll('.settings-dialog [role="switch"]')]
      .find((item) => item.getAttribute('aria-label') === arguments[0])?.getAttribute('aria-checked') ?? null;`, [candidate.pluginName]);
    assert.equal(disabledChecked, 'false', `Cycle ${cycle}: the UI must show the plugin disabled before re-enabling.`);
    await switchPlugin(driver, candidate.pluginName, true);
    await waitPluginSetting(vaultRoot, true);
    const reenabled = await waitProviderCount(driver, 2);
    assert.equal(reenabled.fallbacks.length, 0, `Cycle ${cycle}: enabling must remount exactly two views.`);
    for (let reload = 1; reload <= 2; reload += 1) {
      await clickReload(driver);
      const mounted = await waitProviderCount(driver, 2);
      assert.equal(mounted.fallbacks.length, 0,
        `Cycle ${cycle}, reload ${reload}: plugin reload must not duplicate or lose provider mounts.`);
    }
    await closeSettings(driver);
    assert.equal((await waitProviderCount(driver, 2)).providerCount, 2,
      `Cycle ${cycle}: the linked views must remain mounted after closing Settings.`);
  }

  for (const relative of CONTENT_PATHS.filter((item) => item !== '.morrow/plugins.json')) {
    assertSameFile(starting[relative], await capture(vaultFile(vaultRoot, relative)),
      `Repeated disable/enable/Reload for ${relative}`);
  }
  const enabledConfigAfterCycles = await capture(vaultFile(vaultRoot, '.morrow/plugins.json'));
  const enabledConfigAfterCyclesJson = JSON.parse(enabledConfigAfterCycles.bytes.toString('utf8'));
  assert.deepEqual(enabledConfigAfterCyclesJson, configStart,
    'Repeated UI toggles must restore the complete original plugin configuration semantically.');
  assert.ok(enabledConfigAfterCyclesJson.enabled.includes(PLUGIN_ID),
    'The plugin configuration must finish in its original enabled state.');
  assert.notEqual(enabledConfigAfterCycles.mtimeMs, starting['.morrow/plugins.json'].mtimeMs,
    'The plugin configuration mtime should reflect the real UI toggles that rewrote it.');
  assertSameFile(installedMain, await capture(installedMainPath),
    'Repeated plugin toggles and reloads must preserve the installed bundle copy.');
  await recordStep('independent-153-repeated-disable-reload-preserved-vault', {
    cycles: 2,
    reloadsPerCycle: 2,
    providerCount: 2,
    markdownFiles: Object.fromEntries(MARKDOWN_PATHS.map((relative) => [relative, summary(starting[relative])])),
    pluginConfiguration: {
      semanticValue: enabledConfigAfterCyclesJson,
      before: summary(starting['.morrow/plugins.json']),
      after: summary(enabledConfigAfterCycles),
    },
  });

  await routeToPage(driver, ids.source);
  await waitSource(driver, 2, 20);
  const beforeSave = await capture(rowPath);
  await saveQuantity(driver, 3);
  await waitSource(driver, 3, 30);
  const afterSave = await waitFor(async () => {
    const file = await capture(rowPath);
    return quantityOf(file.bytes.toString('utf8')) === 3 ? file : false;
  }, 'the one UI Save to persist Quantity=3');
  assert.notEqual(afterSave.sha256, beforeSave.sha256, 'One Save must produce a persisted row change.');
  await undoAtProviderRoot(driver);
  await waitSource(driver, 2, 20);
  const afterUndo = await waitFor(async () => {
    const file = await capture(rowPath);
    return quantityOf(file.bytes.toString('utf8')) === 2 ? file : false;
  }, 'one native UI Undo to restore Quantity=2');
  await undoAtProviderRoot(driver);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const afterSecondUndo = await capture(rowPath);
  assertSameFile(afterUndo, afterSecondUndo, 'A second Undo with no prior action must have no duplicate effect.');
  assert.equal((await readSourceState(driver)).quantity, '2', 'Undo must restore exactly one database history step.');
  await recordStep('independent-153-save-undo-had-one-observable-effect', {
    before: summary(beforeSave),
    afterSave: summary(afterSave),
    afterUndo: summary(afterUndo),
    afterSecondUndo: summary(afterSecondUndo),
    ui: await readSourceState(driver),
  });

  await routeToPage(driver, ids.note);
  await waitProviderCount(driver, 2);
  await openPluginSettings(driver, candidate.pluginName);
  const faultContentBaseline = Object.fromEntries(await Promise.all(CONTENT_PATHS.map(async (relative) => [
    relative,
    await capture(vaultFile(vaultRoot, relative)),
  ])));
  const faultMarkdownBaseline = await captureMarkdownFiles(vaultRoot);
  const faultTargetRelative = `.morrow/plugins/${PLUGIN_ID}/main.js`;
  const faultBackup = await capture(installedMainPath);
  assert.equal(faultBackup.sha256, candidate.bundleSha256,
    'Fault injection may start only from the exact installed copy of the candidate bundle.');
  const faultBytes = Buffer.from("export default function activate() { throw new Error('synthetic lifecycle activation fault'); }\n");
  try {
    await writeFile(installedMainPath, faultBytes);
    const injected = await capture(installedMainPath);
    assert.notEqual(injected.sha256, faultBackup.sha256, 'The installed synthetic copy must have its own fault hash.');
    await clickReload(driver);
    const fallback = await assertReadonlyFallback(driver, ids.source, 2, 'synthetic activation failure');
    const visibleFailure = await waitFor(() => driver.execute('return document.body.innerText.includes(arguments[0]);', ['synthetic lifecycle activation fault']),
      'activation failure visible in Settings');
    assert.equal(visibleFailure, true,
      'Settings must display the synthetic activation failure for the installed copy.');
    await driver.screenshot(path.join(candidate.evidence, 'independent-153-activation-failure-fallback.png'));
    for (const relative of CONTENT_PATHS) {
      assertSameFile(faultContentBaseline[relative], await capture(vaultFile(vaultRoot, relative)),
        `Synthetic activation failure must preserve ${relative}`);
    }
    assertMarkdownFilesSame(faultMarkdownBaseline, await captureMarkdownFiles(vaultRoot),
      'Synthetic activation failure must preserve its immediate Markdown baseline');
    await recordStep('independent-153-installed-copy-activation-failure-fell-back-readonly', {
      faultTargetRelative,
      originalInstalledSha256: faultBackup.sha256,
      faultInstalledSha256: injected.sha256,
      sourceBundleSha256: originalBundle.sha256,
      providerCount: fallback.providerCount,
      fallbacks: fallback.fallbacks.map(({ text, contentEditable }) => ({ text, contentEditable })),
      markdownBeforeAndDuring: {
        before: summarizeFiles(faultMarkdownBaseline),
        during: summarizeFiles(await captureMarkdownFiles(vaultRoot)),
      },
    });
  } finally {
    await writeFile(installedMainPath, faultBackup.bytes);
    const restored = await capture(installedMainPath);
    assert.equal(restored.sha256, faultBackup.sha256, 'The installed synthetic bundle copy must be restored byte for byte.');
    await clickReload(driver);
    const remounted = await waitProviderCount(driver, 2);
    assert.equal(remounted.fallbacks.length, 0, 'Restoring the installed original must remount both original views.');
  }
  assertSameFile(originalBundle, await capture(candidate.bundle), 'Fault injection must never alter the frozen source bundle.');
  await closeSettings(driver);

  const unsupportedMarkdownBaseline = await captureMarkdownFiles(vaultRoot);
  const originalSchema = unsupportedMarkdownBaseline['Inventory.md'];
  const schemaText = originalSchema.bytes.toString('utf8');
  const formulaType = '      type: formula\n';
  assert.equal(schemaText.split(formulaType).length - 1, 1, 'Synthetic source fixture must contain one formula property.');
  const unsupportedBytes = Buffer.from(schemaText.replace(formulaType, '      type: future-v153\n'));
  let unsupportedMarkdownRestored;
  try {
    await writeFile(sourcePath, unsupportedBytes);
    const unsupported = await capture(sourcePath);
    assert.equal(unsupported.sha256, sha256(unsupportedBytes), 'Only the temporary synthetic source was changed.');
    const markdownAfterInjection = await captureMarkdownFiles(vaultRoot);
    assertSameFile(unsupportedMarkdownBaseline['Inventory/Widget.md'], markdownAfterInjection['Inventory/Widget.md'],
      'Unsupported-schema injection must not change the synthetic row.');
    assertSameFile(unsupportedMarkdownBaseline['Views.md'], markdownAfterInjection['Views.md'],
      'Unsupported-schema injection must not change the synthetic linked-view note.');
    assertSameFile(unsupported, markdownAfterInjection['Inventory.md'],
      'The intended unsupported source bytes must be the only injected Markdown change.');
    await routeToPage(driver, ids.source);
    const protectedState = await waitFor(async () => {
      const state = await readSourceState(driver);
      const text = state.rootText.toLowerCase();
      return state.providerCount === 1 && /unsupported|not supported|cannot safely represent/.test(text) ? state : false;
    }, 'read-only message for the synthetic unsupported schema');
    assert.equal(protectedState.tablePresent, false, 'Unsupported schema must not be rendered as an editable provider table.');
    assert.equal(protectedState.editCount, 0, 'Unsupported synthetic schema must expose no edit action.');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const unsupportedMarkdownAfterWait = await captureMarkdownFiles(vaultRoot);
    assertMarkdownFilesSame(markdownAfterInjection, unsupportedMarkdownAfterWait,
      'The read-only unsupported-schema phase must not write any Markdown file');
    await driver.screenshot(path.join(candidate.evidence, 'independent-153-unsupported-schema-readonly.png'));
    await recordStep('independent-153-unsupported-synthetic-schema-readonly-preserved', {
      original: summary(originalSchema),
      unsupported: summary(unsupported),
      markdownBeforeInjection: summarizeFiles(unsupportedMarkdownBaseline),
      markdownAfterInjection: summarizeFiles(markdownAfterInjection),
      markdownAfterReadOnlyOpen: summarizeFiles(unsupportedMarkdownAfterWait),
      ui: protectedState,
    });
  } finally {
    await writeFile(sourcePath, originalSchema.bytes);
    const restored = await capture(sourcePath);
    assert.equal(restored.sha256, originalSchema.sha256, 'The synthetic source fixture must be restored after the unsupported probe.');
    const restoredMarkdown = await captureMarkdownFiles(vaultRoot);
    assertSameFile(unsupportedMarkdownBaseline['Inventory/Widget.md'], restoredMarkdown['Inventory/Widget.md'],
      'Restoring the unsupported source must leave the row unchanged.');
    assertSameFile(unsupportedMarkdownBaseline['Views.md'], restoredMarkdown['Views.md'],
      'Restoring the unsupported source must leave the linked-view note unchanged.');
    assert.equal(restoredMarkdown['Inventory.md'].sha256, unsupportedMarkdownBaseline['Inventory.md'].sha256,
      'The unsupported source bytes must be restored to the pre-injection baseline.');
    assert.equal(restoredMarkdown['Inventory.md'].size, unsupportedMarkdownBaseline['Inventory.md'].size,
      'Restored source size must match the pre-injection baseline.');
    unsupportedMarkdownRestored = restoredMarkdown;
  }
  await recordStep('independent-153-unsupported-synthetic-schema-restored', {
    markdownBeforeInjection: summarizeFiles(unsupportedMarkdownBaseline),
    markdownAfterRestore: summarizeFiles(unsupportedMarkdownRestored),
    sourceRestoreMtimeChanged: unsupportedMarkdownRestored['Inventory.md'].mtimeMs !== originalSchema.mtimeMs,
  });
  await routeToPage(driver, ids.note);
  await waitProviderCount(driver, 2);
  await routeToPage(driver, ids.source);
  await waitSource(driver, 2, 20);

  const conflictMarkdownBaseline = await captureMarkdownFiles(vaultRoot);
  const rowBeforeConflict = conflictMarkdownBaseline['Inventory/Widget.md'];
  const rowText = rowBeforeConflict.bytes.toString('utf8');
  const quantityLine = /^Quantity: 2$/m;
  assert.match(rowText, quantityLine, 'Synthetic row must be back at its original Quantity before conflict probe.');
  const input = await openQuantityEditor(driver);
  await clearRef(driver, input);
  await typeRef(driver, input, '9');
  assert.equal(await driver.execute('return document.querySelector("[data-provider=polaris-dados] input[type=number][data-field=quantity]")?.value ?? null;'), '9');
  assertSameFile(rowBeforeConflict, await capture(rowPath), 'Uncommitted UI draft must not write the row file.');
  const externalBytes = Buffer.from(rowText.replace(quantityLine, 'Quantity: 7'));
  await writeFile(rowPath, externalBytes);
  const externalVersion = await capture(rowPath);
  assert.equal(externalVersion.sha256, sha256(externalBytes), 'The conflict version must be created only in the synthetic row file.');
  const markdownAfterConflictInjection = await captureMarkdownFiles(vaultRoot);
  assertSameFile(conflictMarkdownBaseline['Inventory.md'], markdownAfterConflictInjection['Inventory.md'],
    'Conflict injection must not change the synthetic source schema.');
  assertSameFile(conflictMarkdownBaseline['Views.md'], markdownAfterConflictInjection['Views.md'],
    'Conflict injection must not change the synthetic linked-view note.');
  assertSameFile(externalVersion, markdownAfterConflictInjection['Inventory/Widget.md'],
    'The intended external row version must be the only injected Markdown change.');
  const stale = await waitFor(async () => {
    const state = await readSourceState(driver);
    return state.saveDisabled === true && state.saveAlerts.some((message) => /data changed|older data revision/i.test(message))
      ? state : false;
  }, 'stale draft rejection after an external synthetic row change');
  assert.equal(stale.saveDisabled, true, 'Save must be disabled when the row revision is stale.');
  assert.ok(stale.saveAlerts.some((message) => /data changed/i.test(message)),
    'The user-facing UI must explain that the data changed before Save.');
  await new Promise((resolve) => setTimeout(resolve, 500));
  const externalMarkdownAfterWait = await captureMarkdownFiles(vaultRoot);
  assertMarkdownFilesSame(markdownAfterConflictInjection, externalMarkdownAfterWait,
    'Stale-save refusal must preserve all three Markdown files after conflict injection');
  const externalAfterWait = externalMarkdownAfterWait['Inventory/Widget.md'];
  const cancel = await elementRef(driver, '[data-provider="polaris-dados"] button[data-action="cancel"]', 'Cancel for stale synthetic draft');
  await clickRef(driver, cancel);
  const resolved = await waitFor(async () => {
    const state = await readSourceState(driver);
    return state.tablePresent && state.quantity === '7' ? state : false;
  }, 'the current external Quantity=7 after cancelling the stale draft');
  const externalAfterCancel = await captureMarkdownFiles(vaultRoot);
  assertMarkdownFilesSame(markdownAfterConflictInjection, externalAfterCancel,
    'Cancelling a stale draft must preserve all three Markdown files after conflict injection');
  await driver.screenshot(path.join(candidate.evidence, 'independent-153-external-conflict-preserved.png'));
  await recordStep('independent-153-stale-save-refused-external-synthetic-row-preserved', {
    draftQuantity: '9',
    externalQuantity: 7,
    before: summary(rowBeforeConflict),
    external: summary(externalVersion),
    afterRefusal: summary(externalAfterWait),
    markdownBeforeInjection: summarizeFiles(conflictMarkdownBaseline),
    markdownAfterInjection: summarizeFiles(markdownAfterConflictInjection),
    markdownAfterRefusal: summarizeFiles(externalMarkdownAfterWait),
    markdownAfterCancel: summarizeFiles(externalAfterCancel),
    ui: { staleMessage: stale.saveAlerts, saveDisabled: stale.saveDisabled, resolvedQuantity: resolved.quantity },
  });

  await writeFile(rowPath, rowBeforeConflict.bytes);
  const markdownAfterConflictRestore = await captureMarkdownFiles(vaultRoot);
  assertSameFile(conflictMarkdownBaseline['Inventory.md'], markdownAfterConflictRestore['Inventory.md'],
    'Conflict row restoration must leave the source schema unchanged.');
  assertSameFile(conflictMarkdownBaseline['Views.md'], markdownAfterConflictRestore['Views.md'],
    'Conflict row restoration must leave the linked-view note unchanged.');
  assert.equal(markdownAfterConflictRestore['Inventory/Widget.md'].sha256,
    conflictMarkdownBaseline['Inventory/Widget.md'].sha256,
    'Conflict row restoration must restore the pre-injection bytes.');
  assert.equal(markdownAfterConflictRestore['Inventory/Widget.md'].size,
    conflictMarkdownBaseline['Inventory/Widget.md'].size,
    'Conflict row restoration must restore the pre-injection size.');
  assert.notEqual(markdownAfterConflictRestore['Inventory/Widget.md'].mtimeMs,
    conflictMarkdownBaseline['Inventory/Widget.md'].mtimeMs,
    'Conflict row restoration is an intentional second write, so its mtime should differ from the baseline.');
  const finalRow = markdownAfterConflictRestore['Inventory/Widget.md'];
  await recordStep('independent-153-conflict-synthetic-row-restored', {
    markdownBeforeInjection: summarizeFiles(conflictMarkdownBaseline),
    markdownAfterInjection: summarizeFiles(markdownAfterConflictInjection),
    markdownAfterRestore: summarizeFiles(markdownAfterConflictRestore),
    rowRestoreMtimeChanged: finalRow.mtimeMs !== rowBeforeConflict.mtimeMs,
  });
  assertSameFile(originalBundle, await capture(candidate.bundle), 'The frozen source bundle must remain unchanged.');
  await recordStep('independent-153-complete', {
    ids,
    expectedProviderMounts: 2,
    finalRow: summary(finalRow),
    originalBundleSha256: originalBundle.sha256,
  });
  return {
    ids,
    originalBundleSha256: originalBundle.sha256,
    installedBundleSha256: faultBackup.sha256,
    unsupportedSourceSha256: sha256(unsupportedBytes),
    externalConflictRowSha256: externalVersion.sha256,
    finalRowSha256: finalRow.sha256,
    disableReloadCycles: 2,
    reloadsPerCycle: 2,
    providerMounts: 2,
  };
}
