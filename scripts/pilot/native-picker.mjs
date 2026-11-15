#!/usr/bin/env node

// Native UI scenario for inserting one Polaris Dados linked view into Views.md.
// All editing, palette, source selection, and insert actions use WebDriver input.
import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PROVIDER = '[data-provider="polaris-dados"]';
const VIEW_NODE = '.polaris-dados-view-node';
const PICKER = '[data-polaris-dados-picker]';
const SOURCE_SENTENCE = 'The two linked views below share Inventory.md and keep independent configuration.';
const INSERT_COMMAND = 'Polaris Data: insert linked view';
const WAIT_INTERVAL_MS = 100;
const WAIT_TIMEOUT_MS = 25_000;
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function comparableConfig(config) {
  return {
    version: config?.version,
    viewId: config?.viewId,
    sourceDatabaseId: config?.sourceDatabaseId,
    title: config?.title,
    columnOrder: config?.columnOrder,
    filter: config?.filter,
  };
}

export function decodePickerViewMarkers(markdown) {
  if (typeof markdown !== 'string') fail('Views.md must be UTF-8 text.');
  const matches = [...markdown.matchAll(/<!-- morrow:polaris-dados-view:v1:([A-Za-z0-9_-]+) -->/g)];
  return matches.map((match) => {
    let config;
    try {
      config = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    } catch {
      fail('Could not decode a persisted Polaris Dados view marker.');
    }
    if (
      config?.version !== 1 ||
      typeof config.viewId !== 'string' ||
      !config.viewId ||
      typeof config.sourceDatabaseId !== 'string' ||
      !config.sourceDatabaseId ||
      typeof config.title !== 'string' ||
      !Array.isArray(config.columnOrder) ||
      !(config.filter === null || (config.filter && typeof config.filter === 'object'))
    ) {
      fail('A persisted linked-view marker has an invalid config shape.');
    }
    return config;
  });
}

export function assertPickerConfigSequence(actual, expected, label = 'linked-view sequence') {
  if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) {
    const expectedCount = Array.isArray(expected) ? expected.length : '<invalid expectation>';
    fail(`${label}: expected ${expectedCount} configs, got ${Array.isArray(actual) ? actual.length : '<not an array>'}.`);
  }
  const ids = actual.map((config) => config.viewId);
  if (new Set(ids).size !== ids.length) fail(`${label}: duplicate view IDs were persisted.`);
  for (let index = 0; index < expected.length; index += 1) {
    if (JSON.stringify(comparableConfig(actual[index])) !== JSON.stringify(comparableConfig(expected[index]))) {
      fail(`${label}: config ${index} changed unexpectedly.`);
    }
  }
}

export function assertCollapsedParagraphCaret(state, token) {
  if (
    !state ||
    state.focusedEditor !== true ||
    state.anchorInEditor !== true ||
    state.anchorIsText !== true ||
    state.isCollapsed !== true ||
    state.anchorOffset !== state.anchorTextLength ||
    typeof state.paragraphText !== 'string' ||
    !state.paragraphText.endsWith(token) ||
    typeof state.editorText !== 'string' ||
    state.editorText.split(token).length - 1 !== 1
  ) {
    fail(`Pending text/caret was not preserved at the end of its paragraph: ${JSON.stringify(state)}`);
  }
}

export function findSourceSentenceParagraphIndex(paragraphTexts) {
  if (!Array.isArray(paragraphTexts)) fail('The note paragraph inventory must be an array.');
  const matches = paragraphTexts
    .map((text, index) => ({ text, index }))
    .filter(({ text }) => typeof text === 'string' && text.includes(SOURCE_SENTENCE));
  if (matches.length !== 1) fail(`Expected one paragraph containing the source sentence, got ${matches.length}.`);
  return matches[0].index;
}

function findPathId(root, wantedPath) {
  const stack = [root];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (!Array.isArray(value) && value.path === wantedPath && typeof value.id === 'string') return value.id;
    for (const [key, child] of Object.entries(value)) {
      if (key === wantedPath && child && typeof child === 'object' && typeof child.id === 'string') return child.id;
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return null;
}

async function pageIds(vault) {
  const workspace = JSON.parse(await readFile(path.join(vault, '.morrow', 'workspace.json'), 'utf8'));
  const noteId = findPathId(workspace, 'Views.md');
  const rowId = findPathId(workspace, 'Inventory/Widget.md');
  const sourceId = findPathId(workspace, 'Inventory.md');
  if (!noteId || !rowId || !sourceId) fail('The synthetic workspace is missing its note, row, or source ID.');
  return { noteId, rowId, sourceId };
}

async function captureMarkdown(vault) {
  const result = {};
  for (const relative of ['Views.md', 'Inventory.md', 'Inventory/Widget.md']) {
    const file = path.join(vault, relative);
    const bytes = await readFile(file);
    const info = await stat(file);
    result[relative] = {
      bytes,
      text: bytes.toString('utf8'),
      sha256: sha256(bytes),
      size: info.size,
      mtimeMs: info.mtimeMs,
    };
  }
  return result;
}

function summarizeMarkdown(snapshot) {
  return Object.fromEntries(Object.entries(snapshot).map(([file, value]) => [file, {
    sha256: value.sha256,
    size: value.size,
    mtimeMs: value.mtimeMs,
  }]));
}

function assertSameFile(before, after, label) {
  if (before.sha256 !== after.sha256 || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    fail(`${label} changed bytes, size, or mtime unexpectedly.`);
  }
}

function assertUntouchedSourceFiles(before, after, label) {
  for (const file of ['Inventory.md', 'Inventory/Widget.md']) assertSameFile(before[file], after[file], `${label}: ${file}`);
}

function assertSourceData(snapshot, label) {
  const schema = snapshot['Inventory.md'].text;
  const row = snapshot['Inventory/Widget.md'].text;
  if (!/^[ \t]*formula:\s*Quantity\s*\*\s*Price\s*$/im.test(schema)) {
    fail(`${label}: Inventory.md no longer preserves the Quantity * Price formula.`);
  }
  for (const [field, expected] of [['Quantity', '2'], ['Price', '10']]) {
    const actual = row.match(new RegExp(`^${field}:\\s*(.*?)\\s*$`, 'm'))?.[1] ?? null;
    if (actual !== expected) fail(`${label}: Inventory/Widget.md ${field} changed from ${expected}.`);
  }
}

async function waitFor(predicate, label, timeoutMs = WAIT_TIMEOUT_MS) {
  const until = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < until) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS));
  }
  const suffix = lastError ? `; last error: ${lastError?.message ?? lastError}` : '';
  fail(`Timed out waiting for ${label}${suffix}`);
}

function elementId(element) {
  const value = element?.[ELEMENT_KEY] ?? element?.ELEMENT;
  if (typeof value !== 'string' || !value) fail('WebDriver returned an element without a W3C element ID.');
  return value;
}

async function clickElement(driver, element) {
  await driver.request('POST', driver.path(`/element/${elementId(element)}/click`), {});
}

async function sendKeysToElement(driver, element, text) {
  await driver.request('POST', driver.path(`/element/${elementId(element)}/value`), { text, value: [...text] });
}

async function elementText(driver, element) {
  return driver.request('GET', driver.path(`/element/${elementId(element)}/text`));
}

async function navigateToNote(driver, noteId) {
  await driver.execute(`location.hash = '#/page/' + encodeURIComponent(arguments[0]);`, [noteId]);
  return waitFor(async () => {
    const state = await driver.execute(`return {
      hasEditor: document.querySelector('.ProseMirror[contenteditable="true"]') !== null,
      editorText: document.querySelector('.ProseMirror[contenteditable="true"]')?.innerText ?? '',
    }`);
    return state.hasEditor && state.editorText.includes(SOURCE_SENTENCE) ? state : false;
  }, 'Views.md editor');
}

async function readLiveViews(driver) {
  return driver.execute(`
    const wrappers = [...document.querySelectorAll(${JSON.stringify(VIEW_NODE)})];
    const views = wrappers.map((wrapper) => {
      const roots = [...wrapper.querySelectorAll(${JSON.stringify(PROVIDER)})];
      const root = roots.length === 1 ? roots[0] : null;
      const table = root?.querySelector('table') ?? null;
      const rows = [...(table?.querySelectorAll('tbody tr') ?? [])].map((row) => ({
        id: row.dataset.rowId ?? null,
        quantity: row.querySelector('[data-property-id="quantity"]')?.textContent?.trim() ?? null,
        price: row.querySelector('[data-property-id="price"]')?.textContent?.trim() ?? null,
        total: row.querySelector('[data-property-id="total"]')?.textContent?.trim() ?? null,
      }));
      return {
        rootCount: roots.length,
        title: root?.querySelector('[data-view-toolbar] [data-view-title]')?.textContent?.trim() ?? null,
        rows,
      };
    });
    return { wrapperCount: wrappers.length, providerCount: document.querySelectorAll(${JSON.stringify(PROVIDER)}).length, views };
  `);
}

function expectedVisibleRows(config) {
  if (config.filter === null) return 1;
  if (config.filter?.propertyId === 'quantity' && config.filter.op === 'gte' && Number.isFinite(config.filter.value)) {
    return 2 >= config.filter.value ? 1 : 0;
  }
  fail(`The synthetic linked-view fixture has an unsupported filter: ${JSON.stringify(config.filter)}`);
}

function assertLiveViews(snapshot, configs, rowId, label) {
  if (
    snapshot?.wrapperCount !== configs.length ||
    snapshot?.providerCount !== configs.length ||
    !Array.isArray(snapshot.views) ||
    snapshot.views.length !== configs.length
  ) {
    fail(`${label}: expected exactly ${configs.length} linked-view wrappers and provider mounts, got ${JSON.stringify(snapshot)}.`);
  }
  const bindings = [];
  for (let index = 0; index < configs.length; index += 1) {
    const config = configs[index];
    const view = snapshot.views[index];
    if (view.rootCount !== 1 || view.title !== config.title) {
      fail(`${label}: view ${index} did not have one provider mount with its configured title: ${JSON.stringify({ config, view })}`);
    }
    const expectedRows = expectedVisibleRows(config);
    if (!Array.isArray(view.rows) || view.rows.length !== expectedRows) {
      fail(`${label}: view ${index} expected ${expectedRows} row(s), got ${JSON.stringify(view.rows)}.`);
    }
    for (const row of view.rows) {
      if (row.id !== rowId || row.quantity !== '2' || row.price !== '10' || row.total !== '20') {
        fail(`${label}: view ${index} did not show the shared source row and formula result: ${JSON.stringify(row)}`);
      }
    }
    bindings.push({ viewId: config.viewId, wrapperIndex: index, rootCount: view.rootCount, title: view.title });
  }
  return bindings;
}

async function saveStatus(driver) {
  return driver.execute(`const node = document.querySelector('.save-status');
    return {
      found: node !== null,
      saving: node?.classList.contains('is-saving') ?? false,
      error: node?.classList.contains('is-error') ?? false,
      text: node?.textContent?.trim() ?? '',
    }`);
}

async function waitForSaveIdle(driver, label) {
  return waitFor(async () => {
    const state = await saveStatus(driver);
    return state.found && !state.saving && !state.error ? state : false;
  }, `${label} autosave idle`);
}

async function readCaretState(driver, token) {
  return driver.execute(`
    const editor = document.querySelector('.ProseMirror[contenteditable="true"]');
    const selection = window.getSelection();
    const node = selection?.anchorNode ?? null;
    const paragraph = node?.nodeType === Node.TEXT_NODE ? node.parentElement?.closest('p') : node?.closest?.('p');
    const active = document.activeElement;
    const editorText = editor?.innerText ?? '';
    const anchorText = node?.nodeType === Node.TEXT_NODE ? node.textContent ?? '' : '';
    return {
      focusedEditor: Boolean(editor && (active === editor || editor.contains(active))),
      anchorInEditor: Boolean(editor && node && editor.contains(node)),
      anchorIsText: node?.nodeType === Node.TEXT_NODE,
      isCollapsed: selection?.isCollapsed ?? false,
      anchorOffset: selection?.anchorOffset ?? null,
      anchorTextLength: anchorText.length,
      anchorTextEndsWithToken: anchorText.endsWith(arguments[0]),
      paragraphText: paragraph?.textContent ?? '',
      editorText,
      tokenOccurrences: editorText.split(arguments[0]).length - 1,
      activeTag: active?.tagName ?? null,
    };
  `, [token]);
}

async function typePendingText(driver, token) {
  const editorElements = await driver.elements('.ProseMirror[contenteditable="true"]');
  if (editorElements.length !== 1) fail(`Expected one editable note, got ${editorElements.length}.`);
  const editor = editorElements[0];
  const paragraphs = await driver.elements('.ProseMirror p');
  const paragraphTexts = [];
  for (const paragraph of paragraphs) {
    paragraphTexts.push(await elementText(driver, paragraph));
  }
  const matchingIndex = findSourceSentenceParagraphIndex(paragraphTexts);

  await clickElement(driver, paragraphs[matchingIndex]);
  await sendKeysToElement(driver, editor, '\uE010');
  await sendKeysToElement(driver, editor, ` ${token}`);
  return { token, typedAtMs: Date.now() };
}

async function readFilesystemNoteObservation(vault, token, typedAtMs) {
  const file = path.join(vault, 'Views.md');
  const [bytes, info] = await Promise.all([readFile(file), stat(file)]);
  const text = bytes.toString('utf8');
  const observedAt = new Date().toISOString();
  return {
    observedAt,
    elapsedMsSinceTyped: Date.now() - typedAtMs,
    filesystem: {
      path: 'Views.md',
      tokenPresent: text.includes(token),
      sha256: sha256(bytes),
      size: info.size,
      mtimeMs: info.mtimeMs,
    },
  };
}

async function observePrePaletteState(driver, vault, token, typedAtMs) {
  const caret = await readCaretState(driver, token);
  assertCollapsedParagraphCaret(caret, token);
  if (!caret.anchorTextEndsWithToken) fail(`Caret is not at the end of the typed paragraph: ${JSON.stringify(caret)}`);
  const saveStatus = await saveStatus(driver);
  if (!saveStatus.found || saveStatus.error) {
    fail(`Autosave status was unavailable or failed before Ctrl+K: ${JSON.stringify(saveStatus)}`);
  }
  const note = await readFilesystemNoteObservation(vault, token, typedAtMs);
  const observation = { ...note, saveStatus, caret };
  if (note.filesystem.tokenPresent) {
    fail(`Views.md already contained the token immediately before Ctrl+K: ${JSON.stringify(observation)}`);
  }
  return observation;
}

async function observePickerOpenState(driver, vault, token, typedAtMs) {
  const save = await saveStatus(driver);
  const note = await readFilesystemNoteObservation(vault, token, typedAtMs);
  return { ...note, saveStatus: save };
}

async function openPickerThroughCommandPalette(driver, { vault, token, typedAtMs, recordStep }) {
  const editors = await driver.elements('.ProseMirror[contenteditable="true"]');
  if (editors.length !== 1) fail(`Expected one focused editor before Ctrl+K, got ${editors.length}.`);
  const prePalette = await observePrePaletteState(driver, vault, token, typedAtMs);
  await sendKeysToElement(driver, editors[0], '\uE009k');
  await recordStep('picker-pre-palette-dom-caret-and-filesystem-observed', prePalette);
  await waitFor(async () => {
    const dialogs = await driver.elements('.palette[role="dialog"] input[role="combobox"]');
    return dialogs.length === 1 ? dialogs[0] : false;
  }, 'Ctrl+K command palette');
  const input = (await driver.elements('.palette[role="dialog"] input[role="combobox"]'))[0];
  await clickElement(driver, input);
  await sendKeysToElement(driver, input, '\uE009a');
  await sendKeysToElement(driver, input, INSERT_COMMAND);
  const titles = await waitFor(async () => {
    const current = await driver.execute(`return [...document.querySelectorAll('.palette-item[role="option"] .palette-item-title')]
      .map((item) => item.textContent?.trim() ?? '')`);
    return current.includes(INSERT_COMMAND) ? current : false;
  }, `exact palette command "${INSERT_COMMAND}"`);
  const matchingIndex = titles.indexOf(INSERT_COMMAND);
  if (matchingIndex < 0 || titles.lastIndexOf(INSERT_COMMAND) !== matchingIndex) {
    fail(`Command palette did not expose exactly one exact title ${INSERT_COMMAND}.`);
  }
  const options = await driver.elements('.palette-item[role="option"]');
  if (options.length !== titles.length) fail('Palette option/title inventories diverged before selection.');
  await clickElement(driver, options[matchingIndex]);
  await waitFor(async () => {
    const panels = await driver.elements(PICKER);
    return panels.length === 1 ? true : false;
  }, 'unique linked-view picker');
  return prePalette;
}

async function chooseSourceAndInsert(driver, sourceId, { vault, token, typedAtMs, recordStep }) {
  const panelCount = (await driver.elements(PICKER)).length;
  const selects = await driver.elements(`${PICKER} select[data-polaris-action="source"]`);
  if (panelCount !== 1 || selects.length !== 1) fail('The linked-view picker must expose exactly one source select.');
  const pickerOpenObservation = await observePickerOpenState(driver, vault, token, typedAtMs);
  await recordStep('picker-open-filesystem-and-save-state-observed-before-insert', pickerOpenObservation);
  const options = await driver.execute(`
    const select = document.querySelector(${JSON.stringify(`${PICKER} select[data-polaris-action="source"]`)});
    return select ? [...select.options].map((option) => ({ value: option.value, text: option.textContent?.trim() ?? '', disabled: option.disabled })) : null;
  `);
  if (
    !Array.isArray(options) ||
    options.length !== 2 ||
    options[0].value !== '' ||
    options[1].value !== sourceId ||
    options[1].text !== 'Inventory' ||
    options[1].disabled
  ) {
    fail(`Picker source options did not contain the one expected synthetic database: ${JSON.stringify(options)}`);
  }
  const optionElements = await driver.elements(`${PICKER} select[data-polaris-action="source"] option`);
  if (optionElements.length !== options.length) fail('Picker option inventory changed before selection.');
  await clickElement(driver, optionElements[1]);
  const selected = await waitFor(async () => {
    const state = await driver.execute(`const select = document.querySelector(${JSON.stringify(`${PICKER} select[data-polaris-action="source"]`)});
      return {
        value: select?.value ?? null,
        insertDisabled: document.querySelector(${JSON.stringify(`${PICKER} button[data-polaris-action="insert"]`)})?.disabled ?? true,
      }`);
    return state.value === sourceId && !state.insertDisabled ? state : false;
  }, 'real source-option selection');
  await driver.click(`${PICKER} button[data-polaris-action="insert"]`);
  await waitFor(async () => (await driver.elements(PICKER)).length === 0, 'picker close after real insert');
  return { selected, options, pickerOpenObservation };
}

async function validatePersistedInsertion({ candidate, sourceId, rowId, token, initialMarkdown, initialConfigs }) {
  const markdown = await captureMarkdown(candidate.vault);
  const configs = decodePickerViewMarkers(markdown['Views.md'].text);
  if (configs.length !== initialConfigs.length + 1) {
    fail(`Expected exactly one new linked-view marker, got ${configs.length - initialConfigs.length}.`);
  }
  const initialIds = new Set(initialConfigs.map((config) => config.viewId));
  const newConfigs = configs.filter((config) => !initialIds.has(config.viewId));
  if (newConfigs.length !== 1) fail('Expected exactly one new linked-view ID distinct from the two existing IDs.');
  const inserted = newConfigs[0];
  if (inserted.sourceDatabaseId !== sourceId) fail('The inserted linked view does not reference Inventory.md.');
  if (inserted.columnOrder.length !== 0 || inserted.filter !== null) {
    fail(`New linked-view config did not preserve its default configuration: ${JSON.stringify(inserted)}`);
  }
  const oldInOrder = configs.filter((config) => initialIds.has(config.viewId));
  assertPickerConfigSequence(oldInOrder, initialConfigs, 'existing views after insertion');
  const note = markdown['Views.md'].text;
  const heading = initialMarkdown['Views.md'].text.split(/\r?\n/, 1)[0];
  if (!heading.startsWith('# ') || note.split(/\r?\n/, 1)[0] !== heading) fail('The Views.md heading changed after insertion.');
  if (!note.includes(SOURCE_SENTENCE) || !note.includes(token)) fail('The existing prose or pending text was lost from Views.md.');
  if (!note.includes('View boundary Origin-BETWEEN')) fail('The original boundary prose between linked views was lost.');
  if (note.split(token).length - 1 !== 1) fail('The inserted pending token was duplicated in persisted note content.');
  const markerMatches = [...note.matchAll(/<!-- morrow:polaris-dados-view:v1:([A-Za-z0-9_-]+) -->/g)].map((match) => ({
    index: match.index,
    config: JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')),
  }));
  const insertedMarker = markerMatches.find((match) => match.config.viewId === inserted.viewId);
  const firstOriginalMarker = markerMatches.find((match) => initialConfigs.some((config) => config.viewId === match.config.viewId));
  if (!insertedMarker || !firstOriginalMarker || !(note.indexOf(token) < insertedMarker.index && insertedMarker.index < firstOriginalMarker.index)) {
    fail('The inserted marker did not persist at the typed caret before the two existing linked views.');
  }
  assertUntouchedSourceFiles(initialMarkdown, markdown, 'picker insertion');
  assertSourceData(markdown, 'after picker insertion');
  const candidateIds = candidate.linkedViews?.origin?.map((config) => config.viewId) ?? [];
  if (candidateIds.length !== 2) fail('Candidate fixture did not carry its two original view IDs.');
  if (candidateIds.some((id, index) => initialConfigs[index]?.viewId !== id)) {
    fail('Initial Views.md marker order does not match the candidate fixture.');
  }
  if (!rowId) fail('The synthetic row ID is missing.');
  return { markdown, configs, inserted, initialIds: candidateIds };
}

function assertSourceDatabase(candidate, ids) {
  if (ids.sourceId !== candidate.databaseId) fail('Workspace Inventory.md ID differs from the candidate source database ID.');
}

async function writeScenarioEvidence(candidate, result) {
  const output = path.join(candidate.evidence, 'native-picker-scenario.json');
  await writeFile(output, `${JSON.stringify({ observedAt: new Date().toISOString(), ...result }, null, 2)}\n`, { flag: 'wx' });
}

export async function runNativePickerScenario({ driver: initialDriver, candidate, prepared, restartSession, recordStep }) {
  if (!initialDriver || typeof restartSession !== 'function' || typeof recordStep !== 'function') {
    fail('The native picker scenario requires the isolated driver, restart callback, and evidence callback.');
  }
  if (!candidate?.vault || !candidate?.databaseId || !candidate?.evidence || !prepared?.bankBefore) {
    fail('The native picker scenario requires the prepared synthetic candidate.');
  }

  let driver = initialDriver;
  const ids = await pageIds(candidate.vault);
  assertSourceDatabase(candidate, ids);
  const initialMarkdown = await captureMarkdown(candidate.vault);
  const initialConfigs = decodePickerViewMarkers(initialMarkdown['Views.md'].text);
  if (initialConfigs.length !== 2) fail(`The synthetic Views.md fixture must start with two linked views, got ${initialConfigs.length}.`);
  const expectedInitialConfigs = candidate.linkedViews?.origin;
  if (!Array.isArray(expectedInitialConfigs) || expectedInitialConfigs.length !== 2) {
    fail('Candidate fixture did not carry the two expected linked-view configs.');
  }
  assertPickerConfigSequence(initialConfigs, expectedInitialConfigs, 'initial Views.md fixture');
  assertSourceData(initialMarkdown, 'initial fixture');
  for (const file of ['Inventory.md', 'Inventory/Widget.md']) {
    const preparedFile = prepared.bankBefore[file];
    if (
      !preparedFile ||
      preparedFile.hash !== initialMarkdown[file].sha256 ||
      preparedFile.size !== initialMarkdown[file].size ||
      preparedFile.mtimeMs !== initialMarkdown[file].mtimeMs
    ) {
      fail(`Prepared source baseline differs from the freshly opened synthetic fixture for ${file}.`);
    }
  }
  await recordStep('picker-initial-two-view-fixture-verified', {
    noteId: ids.noteId,
    sourceId: ids.sourceId,
    rowId: ids.rowId,
    viewIds: initialConfigs.map((config) => config.viewId),
  });

  await navigateToNote(driver, ids.noteId);
  const beforeInsert = await waitFor(async () => {
    const views = await readLiveViews(driver);
    try {
      assertLiveViews(views, initialConfigs, ids.rowId, 'before picker insert');
      return views;
    } catch {
      return false;
    }
  }, 'two existing linked-view mounts');
  const beforeBindings = assertLiveViews(beforeInsert, initialConfigs, ids.rowId, 'before picker insert');
  const beforeStatus = await waitForSaveIdle(driver, 'opening Views.md');
  const markdownAfterOpen = await captureMarkdown(candidate.vault);
  for (const file of ['Views.md', 'Inventory.md', 'Inventory/Widget.md']) {
    assertSameFile(initialMarkdown[file], markdownAfterOpen[file], `opening ${file}`);
  }
  await recordStep('picker-two-existing-mounts-before-insert', {
    views: beforeInsert,
    bindings: beforeBindings,
    saveStatus: beforeStatus,
    markdown: summarizeMarkdown(markdownAfterOpen),
  });

  const token = `E158-PICKER-${randomUUID()}`;
  const typed = await typePendingText(driver, token);
  const beforePaletteObservation = await openPickerThroughCommandPalette(driver, {
    vault: candidate.vault,
    token,
    typedAtMs: typed.typedAtMs,
    recordStep,
  });
  const sourceSelection = await chooseSourceAndInsert(driver, ids.sourceId, {
    vault: candidate.vault,
    token,
    typedAtMs: typed.typedAtMs,
    recordStep,
  });
  const provisionalMarkdown = await waitFor(async () => {
    const text = await readFile(path.join(candidate.vault, 'Views.md'), 'utf8');
    return decodePickerViewMarkers(text).length === 3 ? text : false;
  }, 'exactly one inserted marker to reach Views.md');
  const provisionalConfigs = decodePickerViewMarkers(provisionalMarkdown);
  const inserted = provisionalConfigs.find((config) => !initialConfigs.some((old) => old.viewId === config.viewId));
  if (!inserted) fail('Autosaved Views.md did not contain a new view ID.');
  const afterInsert = await waitFor(async () => {
    const views = await readLiveViews(driver);
    try {
      assertLiveViews(views, provisionalConfigs, ids.rowId, 'after picker insert');
      return views;
    } catch {
      return false;
    }
  }, 'three provider mounts and rows after picker insertion');
  const afterBindings = assertLiveViews(afterInsert, provisionalConfigs, ids.rowId, 'after picker insert');
  const insertStatus = await waitForSaveIdle(driver, 'picker insertion');
  await driver.screenshot(path.join(candidate.evidence, 'native-picker-after-insert.png'));
  const insertedState = await validatePersistedInsertion({
    candidate,
    sourceId: ids.sourceId,
    rowId: ids.rowId,
    token,
    initialMarkdown,
    initialConfigs,
  });
  if (insertedState.inserted.viewId !== inserted.viewId) fail('Live and persisted new view IDs diverged.');
  const markdownAfterInsert = summarizeMarkdown(insertedState.markdown);
  await recordStep('picker-one-view-inserted-and-autosaved', {
    insertedViewId: inserted.viewId,
    insertedViewTitle: inserted.title,
    sourceId: inserted.sourceDatabaseId,
    sourceSelection,
    markerCount: insertedState.configs.length,
    bindings: afterBindings,
    saveStatus: insertStatus,
    markdown: markdownAfterInsert,
  });

  const beforeRestart = await captureMarkdown(candidate.vault);
  const configsBeforeRestart = decodePickerViewMarkers(beforeRestart['Views.md'].text);
  assertPickerConfigSequence(configsBeforeRestart, insertedState.configs, 'pre-restart persisted views');
  await recordStep('picker-restart-started-after-autosave-idle', {
    saveStatus: insertStatus,
    markdown: summarizeMarkdown(beforeRestart),
  });

  driver = await restartSession();
  if (!driver) fail('Restart callback did not return a WebDriver session.');
  await navigateToNote(driver, ids.noteId);
  const afterRestart = await waitFor(async () => {
    const views = await readLiveViews(driver);
    try {
      assertLiveViews(views, configsBeforeRestart, ids.rowId, 'after restart');
      return views;
    } catch {
      return false;
    }
  }, 'three linked-view mounts and rows after real application restart');
  const afterRestartBindings = assertLiveViews(afterRestart, configsBeforeRestart, ids.rowId, 'after restart');
  const restartStatus = await waitForSaveIdle(driver, 'reopened Views.md');
  await driver.screenshot(path.join(candidate.evidence, 'native-picker-after-restart.png'));

  const markdownAfterRestart = await captureMarkdown(candidate.vault);
  for (const file of ['Views.md', 'Inventory.md', 'Inventory/Widget.md']) {
    assertSameFile(beforeRestart[file], markdownAfterRestart[file], `restart read of ${file}`);
  }
  const configsAfterRestart = decodePickerViewMarkers(markdownAfterRestart['Views.md'].text);
  assertPickerConfigSequence(configsAfterRestart, configsBeforeRestart, 'persisted views after restart');
  if (!markdownAfterRestart['Views.md'].text.includes(token)) fail('Restart lost the pending note token.');
  if (markdownAfterRestart['Views.md'].text.split(/\r?\n/, 1)[0] !== initialMarkdown['Views.md'].text.split(/\r?\n/, 1)[0]) {
    fail('Restart changed the Views.md heading.');
  }
  assertSourceData(markdownAfterRestart, 'after restart');
  await recordStep('picker-real-restart-preserved-three-views-and-source', {
    insertedViewId: inserted.viewId,
    configs: configsAfterRestart,
    bindings: afterRestartBindings,
    markdown: summarizeMarkdown(markdownAfterRestart),
    noWriteAfterRestart: true,
    saveStatus: restartStatus,
  });

  const result = {
    noteId: ids.noteId,
    sourceId: ids.sourceId,
    insertedViewId: inserted.viewId,
    insertedViewTitle: inserted.title,
    originalViewConfigs: initialConfigs,
    configsAfterInsert: insertedState.configs,
    configsAfterRestart,
    proseToken: token,
    typedAt: typed.typedAtMs,
    beforePaletteObservation,
    pickerOpenObservation: sourceSelection.pickerOpenObservation,
    beforeInsert: { views: beforeInsert, bindings: beforeBindings },
    afterInsert: { views: afterInsert, bindings: afterBindings, saveStatus: insertStatus },
    afterRestart: { views: afterRestart, bindings: afterRestartBindings, saveStatus: restartStatus },
    markdownAfterInsert,
    markdownAfterRestart: summarizeMarkdown(markdownAfterRestart),
  };
  await writeScenarioEvidence(candidate, result);
  return result;
}
