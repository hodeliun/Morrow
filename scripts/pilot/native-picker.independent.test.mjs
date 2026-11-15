// Independent Linux-native end-to-end validation of the real linked-view picker.
// The common runner owns the frozen candidate, synthetic vault, private display/DBus,
// driver lifecycle, restart and retained evidence; this file owns its own UI checks.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
const OBSERVER_KEY = '__MORROW_E003_G06_PICKER_INDEPENDENT_EVENTS__';
const MARKER_PATTERN = /<!-- morrow:polaris-dados-view:v1:([A-Za-z0-9_-]+) -->/g;
const CONTENT_FILES = ['Inventory.md', 'Inventory/Widget.md', 'Views.md'];
const BANK_FILES = ['Inventory.md', 'Inventory/Widget.md'];
const FIXTURE_PROSE = 'The two linked views below share Inventory.md and keep independent configuration.';
const KEY = {
  ctrl: '\uE009',
  enter: '\uE007',
  end: '\uE010',
  arrowDown: '\uE015',
};

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function capture(file) {
  const bytes = await readFile(file);
  const info = await stat(file);
  return { bytes, sha256: sha256(bytes), size: bytes.length, mtimeMs: info.mtimeMs };
}

async function captureContent(vault) {
  const files = {};
  for (const relative of CONTENT_FILES) files[relative] = await capture(path.join(vault, relative));
  return files;
}

function summarizeContent(files) {
  return Object.fromEntries(Object.entries(files).map(([relative, value]) => [relative, {
    sha256: value.sha256,
    size: value.size,
    mtimeMs: value.mtimeMs,
  }]));
}

function assertStableFiles(before, after, relatives, label) {
  for (const relative of relatives) {
    assert.equal(after[relative].sha256, before[relative].sha256, `${label}: ${relative} bytes changed.`);
    assert.equal(after[relative].size, before[relative].size, `${label}: ${relative} size changed.`);
    assert.equal(after[relative].mtimeMs, before[relative].mtimeMs, `${label}: ${relative} mtime changed.`);
  }
}

function decodeMarkers(markdown) {
  const result = [];
  for (const match of markdown.matchAll(MARKER_PATTERN)) {
    let value;
    try {
      value = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    } catch (error) {
      throw new Error(`Could not decode persisted linked-view marker: ${error?.message ?? error}`, { cause: error });
    }
    assert.equal(value?.version, 1, 'Every linked-view marker must use version 1.');
    assert.ok(typeof value.viewId === 'string' && value.viewId.length > 0, 'Every linked-view marker needs a view ID.');
    assert.ok(typeof value.sourceDatabaseId === 'string' && value.sourceDatabaseId.length > 0,
      'Every linked-view marker needs a source database ID.');
    result.push(value);
  }
  return result;
}

function plainBlocks(markdown) {
  return markdown.replace(MARKER_PATTERN, '')
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(' '))
    .filter(Boolean);
}

function normalizeWhitespace(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function parseScalar(markdown, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = markdown.match(new RegExp(`^\\s*(?:[-*]\\s*)?${escaped}\\s*::?\\s*(.*?)\\s*$`, 'im'));
  if (!match) return null;
  return String(match[1]).trim().replace(/^['"]|['"]$/g, '').replace(/^\*\*(.*)\*\*$/, '$1');
}

function readBank(rowMarkdown, schemaMarkdown) {
  const quantityText = parseScalar(rowMarkdown, 'Quantity');
  const priceText = parseScalar(rowMarkdown, 'Price');
  assert.ok(quantityText !== null && quantityText !== '', 'Inventory/Widget.md must contain Quantity.');
  assert.ok(priceText !== null && priceText !== '', 'Inventory/Widget.md must contain Price.');
  const quantity = Number(quantityText);
  const price = Number(priceText);
  assert.ok(Number.isFinite(quantity), 'Source Quantity must be numeric.');
  assert.ok(Number.isFinite(price), 'Source Price must be numeric.');
  assert.match(schemaMarkdown, /formula:\s*Quantity\s*\*\s*Price/i,
    'Inventory.md must retain the Quantity × Price formula.');
  return { quantity, price, total: quantity * price };
}

async function readPageIds(vault) {
  const workspace = JSON.parse(await readFile(path.join(vault, '.morrow/workspace.json'), 'utf8'));
  const pages = workspace.pages ?? {};
  const ids = {
    source: pages['Inventory.md']?.id,
    row: pages['Inventory/Widget.md']?.id,
    note: pages['Views.md']?.id,
  };
  assert.ok(Object.values(ids).every((id) => typeof id === 'string' && id.length > 0),
    'The synthetic workspace must have stable source, row and note IDs.');
  return ids;
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

async function elementRef(driver, selector) {
  const reference = await driver.execute('return document.querySelector(arguments[0]) ?? null;', [selector]);
  const id = reference?.[ELEMENT_KEY] ?? reference?.ELEMENT;
  if (!id) throw new Error(`No rendered element for ${selector}`);
  return id;
}

async function clickRef(driver, id) {
  return driver.request('POST', driver.path(`/element/${id}/click`), {});
}

async function typeRef(driver, id, text) {
  return driver.request('POST', driver.path(`/element/${id}/value`), { text, value: [...text] });
}

async function clickParagraphContaining(driver, text) {
  const reference = await driver.execute(`return [...document.querySelectorAll('.ProseMirror[contenteditable="true"] p')]
    .find((node) => node.textContent?.includes(arguments[0])) ?? null;`, [text]);
  const id = reference?.[ELEMENT_KEY] ?? reference?.ELEMENT;
  if (!id) throw new Error(`The real editor paragraph containing ${JSON.stringify(text)} was not found.`);
  await clickRef(driver, id);
  return id;
}

async function assertCaretAtParagraphEnd(driver) {
  const editorId = await elementRef(driver, '.ProseMirror[contenteditable="true"]');
  await typeRef(driver, editorId, KEY.end);
  const caret = await driver.execute(`return (() => {
    const selection = window.getSelection();
    const anchor = selection?.anchorNode ?? null;
    const anchorElement = anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement;
    const currentParagraph = anchorElement?.closest('p') ?? null;
    return {
      insideEditor: Boolean(currentParagraph?.closest('.ProseMirror[contenteditable="true"]')),
      paragraphText: currentParagraph?.textContent ?? null,
      containsFixtureProse: currentParagraph?.textContent?.includes(arguments[0]) ?? false,
      anchorText: anchor?.textContent ?? null,
      anchorOffset: selection?.anchorOffset ?? null,
      anchorLength: anchor?.textContent?.length ?? null,
    };
  })();`, [FIXTURE_PROSE]);
  assert.equal(caret.insideEditor, true, 'The insertion caret must remain in the genuine PageEditor paragraph.');
  assert.equal(caret.containsFixtureProse, true, 'The genuine fixture paragraph must retain the caret.');
  assert.equal(caret.anchorOffset, caret.anchorLength,
    'The real End key must place the caret at the end of its text node before adding the token.');
  return caret;
}

async function routeToPage(driver, pageId) {
  await driver.execute(`location.hash = '#/page/' + encodeURIComponent(arguments[0]);`, [pageId]);
}

async function readEditor(driver) {
  return driver.execute(`return {
    pageHeading: document.querySelector('.ProseMirror[contenteditable="true"] h1')?.textContent?.trim() ?? null,
    prose: document.querySelector('.ProseMirror[contenteditable="true"]')?.innerText ?? '',
    editorReady: Boolean(document.querySelector('.ProseMirror[contenteditable="true"]')),
  };`);
}

async function readPrePaletteSnapshot(driver) {
  return driver.execute(`const editor = document.querySelector('.ProseMirror[contenteditable="true"]');
    const selection = window.getSelection();
    const anchor = selection?.anchorNode ?? null;
    const anchorElement = anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement;
    const paragraph = anchorElement?.closest('p') ?? null;
    const status = document.querySelector('.topbar .save-status');
    const events = window[${JSON.stringify(OBSERVER_KEY)}]?.state ?? null;
    return {
      editorText: editor?.innerText ?? '',
      heading: editor?.querySelector('h1')?.textContent?.trim() ?? null,
      caret: {
        collapsed: selection?.isCollapsed ?? false,
        insideEditor: Boolean(paragraph?.closest('.ProseMirror[contenteditable="true"]')),
        paragraphText: paragraph?.textContent ?? null,
        containsFixtureProse: paragraph?.textContent?.includes(arguments[0]) ?? false,
        anchorText: anchor?.textContent ?? null,
        anchorOffset: selection?.anchorOffset ?? null,
        anchorLength: anchor?.textContent?.length ?? null,
      },
      saveStatus: status ? {
        label: status.querySelector('.save-label')?.textContent?.trim() ?? '',
        className: status.className,
        title: status.getAttribute('title'),
      } : null,
      editorInput: events?.editorInput ?? null,
    };`, [FIXTURE_PROSE]);
}

async function readSaveStatus(driver) {
  return driver.execute(`const status = document.querySelector('.topbar .save-status');
    return status ? {
      label: status.querySelector('.save-label')?.textContent?.trim() ?? '',
      className: status.className,
      title: status.getAttribute('title'),
    } : null;`);
}

async function waitForSaved(driver, label) {
  const status = await waitFor(async () => {
    const value = await readSaveStatus(driver);
    return value && !value.className.includes('is-saving') && !value.className.includes('is-error')
      ? value
      : false;
  }, label);
  assert.equal(status.label, 'Saved', `${label}: English save status must be Saved.`);
  return status;
}

async function readNativeIdentity(driver, candidate) {
  const runtime = await driver.execute('return window.__MORROW_INFO__ || null;');
  assert.equal(runtime?.platform, 'linux', 'Picker validation must run in the isolated Linux native app.');
  assert.equal(runtime?.dataPath, candidate.expectedBackendDataPath,
    'Native runtime must use the synthetic profile verified by the common runner.');
  return runtime;
}

async function readPickerDom(driver) {
  return driver.execute(`const panels = [...document.querySelectorAll('[data-polaris-dados-picker]')];
    const panel = panels[0] ?? null;
    const select = panel?.querySelector('select[data-polaris-action="source"]') ?? null;
    const insert = panel?.querySelector('button[data-polaris-action="insert"]') ?? null;
    return {
      count: panels.length,
      title: panel?.querySelector('h2')?.textContent?.trim() ?? null,
      label: panel?.querySelector('label')?.textContent?.trim() ?? null,
      status: panel?.querySelector('[data-polaris-action="status"]')?.textContent?.trim() ?? null,
      options: select ? [...select.options].map((option) => ({ value: option.value, text: option.textContent?.trim() ?? '' })) : [],
      selectedSourceId: select?.value ?? null,
      insertDisabled: insert?.disabled ?? null,
    };`);
}

async function readLinkedDom(driver) {
  return driver.execute(`const editor = document.querySelector('.ProseMirror[contenteditable="true"]');
    const wrappers = [...(editor?.querySelectorAll('.polaris-dados-view-node') ?? [])];
    const allRoots = [...(editor?.querySelectorAll('[data-provider="polaris-dados"]') ?? [])];
    return {
      wrapperCount: wrappers.length,
      providerCount: allRoots.length,
      views: wrappers.map((wrapper) => {
        const roots = [...wrapper.querySelectorAll('[data-provider="polaris-dados"]')];
        const root = roots[0] ?? null;
        const table = root?.querySelector('table.polaris-dados-grid') ?? null;
        const rows = [...(table?.querySelectorAll('tbody tr') ?? [])].map((row) => ({
          id: row.dataset.rowId ?? null,
          quantity: row.querySelector('[data-field="quantity"]')?.textContent?.trim() ?? null,
          price: row.querySelector('[data-field="price"]')?.textContent?.trim() ?? null,
          total: row.querySelector('[data-field="total"]')?.textContent?.trim() ?? null,
          totalKind: row.querySelector('[data-field="total"] [data-value-kind]')?.getAttribute('data-value-kind') ?? null,
        }));
        return {
          rootCount: roots.length,
          ariaLabel: root?.getAttribute('aria-label') ?? null,
          title: root?.querySelector('[data-view-toolbar] [data-view-title]')?.textContent?.trim() ?? null,
          rows,
        };
      }),
    };`);
}

function assertProjection(configs, dom, ids, bank, label) {
  assert.equal(dom.wrapperCount, configs.length, `${label}: each marker must have exactly one rendered wrapper.`);
  assert.equal(dom.providerCount, configs.length, `${label}: expected one mounted provider root per view marker.`);
  assert.equal(dom.views.length, configs.length, `${label}: wrapper snapshot must have one entry per marker.`);
  for (let index = 0; index < configs.length; index += 1) {
    const config = configs[index];
    const view = dom.views[index];
    assert.equal(view.rootCount, 1, `${label}: view ${index} must have exactly one provider root.`);
    assert.equal(view.ariaLabel, 'Polaris Data', `${label}: provider root ${index} must be mounted by Polaris Data.`);
    assert.equal(view.title, config.title, `${label}: DOM order/title must match persisted marker ${config.viewId}.`);
    assert.equal(config.sourceDatabaseId, ids.source, `${label}: ${config.viewId} must use Inventory.md.`);
    const visible = config.filter === null || config.filter === undefined
      ? true
      : config.filter.propertyId === 'quantity'
        ? bank.quantity >= Number(config.filter.value)
        : false;
    assert.equal(view.rows.length, visible ? 1 : 0,
      `${label}: ${config.viewId} row projection must agree with its persisted filter.`);
    if (visible) {
      assert.deepEqual(view.rows, [{
        id: ids.row,
        quantity: String(bank.quantity),
        price: String(bank.price),
        total: String(bank.total),
        totalKind: 'number',
      }], `${label}: ${config.viewId} must render the original row and numeric formula result.`);
    }
  }
}

function assertNoteProse(note, token) {
  assert.ok(note.includes('# Origin Views'), 'The existing note heading must remain intact.');
  assert.ok(note.includes('Synthetic vault marker: OPEN-OLD'), 'The fixture provenance line must remain intact.');
  assert.ok(note.includes(FIXTURE_PROSE), 'The original genuine fixture prose must remain intact.');
  assert.ok(plainBlocks(note).some((block) => block.includes(FIXTURE_PROSE) && block.includes(token)),
    'The trusted UI token must remain in the same genuine fixture paragraph.');
  assert.ok(note.includes('View boundary Origin-BETWEEN'), 'The existing prose boundary must remain intact.');
}

function assertUniqueViewSet(actual, original, sourceId, label) {
  assert.equal(actual.length, original.length + 1, `${label}: exactly one marker must be added.`);
  const actualIds = actual.map((view) => view.viewId);
  assert.equal(new Set(actualIds).size, actualIds.length, `${label}: view IDs must remain unique.`);
  const originalIds = original.map((view) => view.viewId);
  const added = actual.filter((view) => !originalIds.includes(view.viewId));
  assert.equal(added.length, 1, `${label}: exactly one new view ID must be present.`);
  assert.deepEqual(actual.filter((view) => originalIds.includes(view.viewId)), original,
    `${label}: both original configs must remain unchanged.`);
  assert.ok(actual.every((view) => view.sourceDatabaseId === sourceId),
    `${label}: all three views must continue to reference Inventory.md.`);
  const inserted = added[0];
  assert.equal(inserted.version, 1);
  assert.ok(inserted.viewId && !originalIds.includes(inserted.viewId));
  assert.equal(inserted.title, 'Inventory — view', `${label}: inserted view should use the English default title.`);
  assert.deepEqual(inserted.columnOrder, [], `${label}: inserted view must start with the default column order.`);
  assert.equal(inserted.filter, null, `${label}: inserted view must start unfiltered.`);
  assert.deepEqual(actual.map((view) => view.viewId), [inserted.viewId, ...originalIds],
    `${label}: the new view must occupy the genuine prose caret before the two original markers.`);
  return inserted;
}

async function installEventObserver(driver) {
  const installed = await driver.execute(`return (() => {
    const key = ${JSON.stringify(OBSERVER_KEY)};
    if (window[key]) return false;
    const state = {};
    const onInput = (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.ProseMirror[contenteditable="true"]')) {
        state.editorInput = {
          trusted: event.isTrusted,
          inputType: event.inputType ?? null,
          targetTag: target.tagName,
          at: performance.now(),
        };
      }
    };
    const onKeydown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        state.paletteShortcut = { trusted: event.isTrusted, at: performance.now(), targetTag: event.target?.tagName ?? null };
      }
    };
    const onClick = (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const option = target?.closest('[role="option"]') ?? null;
      if (option?.innerText?.includes('Polaris Data: insert linked view')) {
        state.commandChoice = { trusted: event.isTrusted, title: option.innerText.trim(), at: performance.now() };
      }
      const insert = target?.closest('[data-polaris-dados-picker] button[data-polaris-action="insert"]') ?? null;
      if (insert) state.insertClick = { trusted: event.isTrusted, at: performance.now() };
    };
    const onChange = (event) => {
      const target = event.target;
      if (target instanceof HTMLSelectElement && target.matches('[data-polaris-dados-picker] select[data-polaris-action="source"]')) {
        state.sourceChange = { trusted: event.isTrusted, value: target.value, at: performance.now() };
      }
    };
    document.addEventListener('input', onInput, true);
    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('change', onChange, true);
    window[key] = { state, onInput, onKeydown, onClick, onChange };
    return true;
  })();`);
  assert.equal(installed, true, 'The passive trusted-event observer must be new for this run.');
}

async function readEventObservation(driver) {
  return driver.execute(`return window[${JSON.stringify(OBSERVER_KEY)}]?.state ?? null;`);
}

async function removeEventObserver(driver) {
  await driver.execute(`(() => {
    const key = ${JSON.stringify(OBSERVER_KEY)};
    const observer = window[key];
    if (!observer) return false;
    document.removeEventListener('input', observer.onInput, true);
    document.removeEventListener('keydown', observer.onKeydown, true);
    document.removeEventListener('click', observer.onClick, true);
    document.removeEventListener('change', observer.onChange, true);
    delete window[key];
    return true;
  })();`);
}

export async function runIndependentNativePickerScenario(context) {
  const { candidate, restartSession, recordStep } = context;
  let { driver } = context;
  assert.ok(driver && candidate?.vault && candidate?.evidence,
    'The independent picker scenario requires the isolated driver and prepared synthetic candidate.');
  assert.equal(typeof restartSession, 'function', 'The common runner must provide its owned restart callback.');
  assert.equal(typeof recordStep, 'function', 'The common runner must provide durable step recording.');

  await readNativeIdentity(driver, candidate);
  const ids = await readPageIds(candidate.vault);
  assert.equal(ids.source, candidate.databaseId, 'Inventory.md must be the registered fixture source.');

  const startingContent = await captureContent(candidate.vault);
  const startingViewsMarkdown = startingContent['Views.md'].bytes.toString('utf8');
  const originalViews = decodeMarkers(startingViewsMarkdown);
  assert.equal(originalViews.length, 2, 'The picker must start with exactly the two original fixture markers.');
  assert.equal(new Set(originalViews.map((view) => view.viewId)).size, 2,
    'The two original fixture marker IDs must be unique.');
  assert.ok(originalViews.every((view) => view.sourceDatabaseId === ids.source),
    'Both original markers must reference the fixture source.');
  if (candidate.linkedViews?.origin) {
    assert.deepEqual(originalViews.map((view) => view.viewId),
      candidate.linkedViews.origin.map((view) => view.viewId),
      'The note must begin with the two IDs generated for this synthetic vault.');
  }
  const startingBank = readBank(
    startingContent['Inventory/Widget.md'].bytes.toString('utf8'),
    startingContent['Inventory.md'].bytes.toString('utf8'),
  );
  const startingText = plainBlocks(startingViewsMarkdown);
  assert.ok(startingViewsMarkdown.includes('# Origin Views'), 'The synthetic note heading must be present at entry.');
  assert.ok(startingViewsMarkdown.includes(FIXTURE_PROSE), 'The genuine fixture paragraph must be present at entry.');

  await routeToPage(driver, ids.note);
  await waitFor(async () => (await readEditor(driver)).editorReady, 'real editable Views.md page');
  await waitFor(async () => {
    const editor = await readEditor(driver);
    return editor.pageHeading === 'Origin Views' && editor.prose.includes(FIXTURE_PROSE) ? editor : false;
  }, 'fixture heading and genuine prose in the PageEditor DOM');

  const proseToken = `independent-picker-prose-${Date.now()}`;
  const notePath = path.join(candidate.vault, 'Views.md');
  await installEventObserver(driver);
  let eventObservation = null;
  let caretEvidence;
  let saveStatusBeforePalette;
  let prePaletteDom;
  let noteFileBeforePalette;
  let noteFileBeforeInsert;
  let tokenPersistedBeforeInsert;
  let inputToPaletteMs;
  try {
    await clickParagraphContaining(driver, FIXTURE_PROSE);
    caretEvidence = await assertCaretAtParagraphEnd(driver);
    const editorId = await elementRef(driver, '.ProseMirror[contenteditable="true"]');
    await typeRef(driver, editorId, ` ${proseToken}`);
    prePaletteDom = await readPrePaletteSnapshot(driver);
    assert.ok(normalizeWhitespace(prePaletteDom.editorText).includes(FIXTURE_PROSE)
      && normalizeWhitespace(prePaletteDom.editorText).includes(proseToken),
      'The trusted token must be visible in the real editor before opening the palette.');
    assert.equal(prePaletteDom.heading, 'Origin Views', 'The existing heading must remain in the edited note.');
    assert.equal(prePaletteDom.caret.collapsed, true, 'The real caret must remain collapsed after trusted typing.');
    assert.equal(prePaletteDom.caret.insideEditor, true, 'The caret must remain in the genuine PageEditor paragraph.');
    assert.equal(prePaletteDom.caret.containsFixtureProse, true,
      'The caret must remain in the original fixture paragraph containing the provenance line and prose.');
    assert.equal(prePaletteDom.caret.anchorOffset, prePaletteDom.caret.anchorLength,
      'The trusted token must leave the genuine paragraph caret at its end.');
    noteFileBeforePalette = await capture(notePath);
    assert.ok(!noteFileBeforePalette.bytes.includes(Buffer.from(proseToken)),
      `Pending-text race: token already reached Views.md before Ctrl+K (sha256=${noteFileBeforePalette.sha256}, size=${noteFileBeforePalette.size}).`);
    assert.equal(noteFileBeforePalette.sha256, startingContent['Views.md'].sha256,
      'Pending-text race: Views.md changed before Ctrl+K; refusing to claim an unsaved editor draft.');
    saveStatusBeforePalette = prePaletteDom.saveStatus;
    assert.ok(saveStatusBeforePalette?.className.includes('is-saving'),
      `Pending-text race: expected an active save state before Ctrl+K, observed ${JSON.stringify(saveStatusBeforePalette)}.`);
    assert.ok(prePaletteDom.editorInput?.trusted,
      'The pending editor text must originate from a trusted UI input event.');
    assert.ok(Number.isFinite(prePaletteDom.editorInput.at), 'The observed trusted input timestamp must be valid.');

    // Keep Ctrl+K adjacent to the DOM/caret and disk snapshots. The token must still be an
    // unsaved editor draft here; later autosave during the palette is recorded, not assumed.
    await typeRef(driver, editorId, `${KEY.ctrl}k`);
    await waitFor(async () => {
      const present = await driver.execute('return Boolean(document.querySelector(".palette input.palette-input"));');
      return present ? true : false;
    }, 'command palette opened with the real Ctrl+K shortcut');
    eventObservation = await readEventObservation(driver);
    assert.ok(eventObservation?.paletteShortcut?.trusted,
      'Command palette must open from a trusted Ctrl+K event.');
    inputToPaletteMs = eventObservation.paletteShortcut.at - eventObservation.editorInput.at;
    assert.ok(Number.isFinite(inputToPaletteMs) && inputToPaletteMs >= 0 && inputToPaletteMs < 250,
      `Pending-text timing failure before picker use: Ctrl+K must follow trusted text input before the 250 ms autosave window; observed ${inputToPaletteMs} ms (disk token before palette=${noteFileBeforePalette.bytes.includes(Buffer.from(proseToken))}).`);
    const paletteInput = await elementRef(driver, '.palette input.palette-input');
    await typeRef(driver, paletteInput, '>Polaris Data: insert linked view');
    const commandId = await waitFor(async () => {
      const reference = await driver.execute(`return [...document.querySelectorAll('.palette [role="option"]')]
        .filter((option) => option.innerText.trim() === 'Polaris Data: insert linked view')[0] ?? null;`);
      return reference?.[ELEMENT_KEY] ?? reference?.ELEMENT ?? false;
    }, 'unique English Polaris Data command in the real command palette');
    const commandMatches = await driver.execute(`return [...document.querySelectorAll('.palette [role="option"]')]
      .filter((option) => option.innerText.trim() === 'Polaris Data: insert linked view').length;`);
    assert.equal(commandMatches, 1, 'The command palette must show exactly one matching Polaris Data command.');
    await clickRef(driver, commandId);

    await waitFor(async () => {
      const picker = await readPickerDom(driver);
      return picker.count === 1 && picker.options.length > 1 ? picker : false;
    }, 'one real Polaris Data source picker');
    const pickerBeforeSelection = await readPickerDom(driver);
    assert.equal(pickerBeforeSelection.title, 'Insert linked view');
    assert.equal(pickerBeforeSelection.label, 'Source database');
    assert.equal(pickerBeforeSelection.options.length, 2,
      'Only the placeholder and the one eligible synthetic Inventory database should be listed.');
    assert.deepEqual(pickerBeforeSelection.options[1], { value: ids.source, text: 'Inventory' },
      'The picker must expose the correct source through its user-facing option.');
    assert.match(pickerBeforeSelection.status ?? '', /Insertion target captured/i,
      'The picker must report the target captured from the real page editor caret.');
    assert.equal(pickerBeforeSelection.insertDisabled, true,
      'Insert must stay disabled until the user selects a source.');

    const sourceSelect = await elementRef(driver, '[data-polaris-dados-picker] select[data-polaris-action="source"]');
    await clickRef(driver, sourceSelect);
    await typeRef(driver, sourceSelect, `${KEY.arrowDown}${KEY.enter}`);
    const pickerSelected = await waitFor(async () => {
      const picker = await readPickerDom(driver);
      return picker.selectedSourceId === ids.source && picker.insertDisabled === false ? picker : false;
    }, 'keyboard selection of the synthetic Inventory source');
    assert.equal(pickerSelected.options[pickerSelected.options.findIndex((option) => option.value === ids.source)]?.text,
      'Inventory');

    noteFileBeforeInsert = await capture(notePath);
    tokenPersistedBeforeInsert = noteFileBeforeInsert.bytes.includes(Buffer.from(proseToken));
    const insertButton = await elementRef(driver, '[data-polaris-dados-picker] button[data-polaris-action="insert"]');
    await clickRef(driver, insertButton);
    await waitFor(async () => (await readPickerDom(driver)).count === 0, 'picker closed after real Insert button click');
    eventObservation = await readEventObservation(driver);
    assert.ok(eventObservation?.editorInput?.trusted, 'Token must come from a trusted editor input event.');
    assert.ok(eventObservation?.paletteShortcut?.trusted, 'Command palette must open from a trusted Ctrl+K event.');
    assert.ok(eventObservation?.commandChoice?.trusted,
      'Picker command must be chosen with a trusted interaction in the real command palette.');
    assert.ok(eventObservation?.sourceChange?.trusted,
      'Picker source must be selected through a trusted native select change event.');
    assert.equal(eventObservation.sourceChange.value, ids.source);
    assert.ok(eventObservation?.insertClick?.trusted, 'The Insert action must come from a trusted UI click.');
    assert.ok(eventObservation.editorInput.at <= eventObservation.paletteShortcut.at
      && eventObservation.paletteShortcut.at <= eventObservation.commandChoice.at
      && eventObservation.commandChoice.at <= eventObservation.sourceChange.at
      && eventObservation.sourceChange.at <= eventObservation.insertClick.at,
    'Trusted editor, palette, source selection and insert events must occur in the expected order.');
  } finally {
    await removeEventObserver(driver);
  }

  const noteAfterInsert = await waitFor(async () => {
    const text = await readFile(notePath, 'utf8');
    return decodeMarkers(text).length === 3 ? text : false;
  }, 'exactly three persisted linked-view markers after picker insertion');
  assertNoteProse(noteAfterInsert, proseToken);
  assert.deepEqual(plainBlocks(noteAfterInsert).map((line) => line.replace(` ${proseToken}`, '')),
    startingText,
    'Inserting the marker must preserve heading, fixture text and token without adding or replacing prose.');
  const viewsAfterInsert = decodeMarkers(noteAfterInsert);
  const insertedView = assertUniqueViewSet(viewsAfterInsert, originalViews, ids.source, 'after picker insertion');
  const contentAfterInsert = await captureContent(candidate.vault);
  assertStableFiles(startingContent, contentAfterInsert, BANK_FILES,
    'picker insertion must leave the source database and row unchanged');
  const bankAfterInsert = readBank(
    contentAfterInsert['Inventory/Widget.md'].bytes.toString('utf8'),
    contentAfterInsert['Inventory.md'].bytes.toString('utf8'),
  );
  assert.deepEqual(bankAfterInsert, startingBank, 'Source values and formula result must remain unchanged.');
  assert.equal(contentAfterInsert['Views.md'].sha256, sha256(Buffer.from(noteAfterInsert)),
    'The marker count must be read from the note bytes captured after insertion.');

  await waitFor(async () => {
    const status = await readSaveStatus(driver);
    return status && !status.className.includes('is-saving') && !status.className.includes('is-error')
      ? status
      : false;
  }, 'linked-view insertion autosave completion');
  const savedAfterInsert = await waitForSaved(driver, 'linked-view insertion autosave completion');
  const domAfterInsert = await waitFor(async () => {
    const dom = await readLinkedDom(driver);
    return dom.wrapperCount === 3 && dom.providerCount === 3 ? dom : false;
  }, 'three unique linked-view wrappers and provider mounts');
  assertProjection(viewsAfterInsert, domAfterInsert, ids, bankAfterInsert, 'after picker insertion');
  const editorAfterInsert = await readEditor(driver);
  assert.equal(editorAfterInsert.pageHeading, 'Origin Views');
  assert.ok(editorAfterInsert.prose.includes(FIXTURE_PROSE) && editorAfterInsert.prose.includes(proseToken),
    'Rendered note heading, prose and token must survive picker insertion.');
  await driver.screenshot(path.join(candidate.evidence, 'independent-158-picker-inserted-three-views.png'));
  await recordStep('independent-158-picker-inserted-one-view-from-real-caret', {
    ids,
    insertedViewId: insertedView.viewId,
    insertedViewTitle: insertedView.title,
    viewIds: viewsAfterInsert.map((view) => view.viewId),
    configs: viewsAfterInsert,
    trustedEvents: eventObservation,
    caret: caretEvidence,
    pendingBeforePalette: {
      tokenVisibleInDom: prePaletteDom.editorText.includes(proseToken),
      tokenAbsentFromDisk: !noteFileBeforePalette.bytes.includes(Buffer.from(proseToken)),
      dom: prePaletteDom,
      noteFile: summarizeContent({ 'Views.md': noteFileBeforePalette })['Views.md'],
      saveStatus: saveStatusBeforePalette,
      inputToPaletteMs,
    },
    tokenPersistedBeforeInsert,
    noteFileBeforeInsert: summarizeContent({ 'Views.md': noteFileBeforeInsert })['Views.md'],
    autosaveSettledAfterInsert: savedAfterInsert,
    noteSha256: contentAfterInsert['Views.md'].sha256,
    bank: summarizeContent(Object.fromEntries(BANK_FILES.map((relative) => [relative, contentAfterInsert[relative]]))),
    dom: domAfterInsert,
  });

  driver = await restartSession();
  await readNativeIdentity(driver, candidate);
  await routeToPage(driver, ids.note);
  const domAfterRestart = await waitFor(async () => {
    const current = await readLinkedDom(driver);
    return current.wrapperCount === 3 && current.providerCount === 3 ? current : false;
  }, 'three linked views remounted after a real app restart');
  const contentAfterRestart = await captureContent(candidate.vault);
  assertStableFiles(contentAfterInsert, contentAfterRestart, CONTENT_FILES,
    'opening the persisted three-view note after restart must not rewrite Markdown');
  const noteAfterRestart = contentAfterRestart['Views.md'].bytes.toString('utf8');
  const viewsAfterRestart = decodeMarkers(noteAfterRestart);
  assert.deepEqual(viewsAfterRestart, viewsAfterInsert,
    'All three view IDs, source IDs, titles, filters and orders must survive restart.');
  assertNoteProse(noteAfterRestart, proseToken);
  assert.deepEqual(plainBlocks(noteAfterRestart), plainBlocks(noteAfterInsert),
    'All non-marker note text must remain byte-content equivalent after restart.');
  assert.deepEqual(await readPageIds(candidate.vault), ids,
    'The picker must not create, replace or duplicate source, row or note page IDs.');
  const bankAfterRestart = readBank(
    contentAfterRestart['Inventory/Widget.md'].bytes.toString('utf8'),
    contentAfterRestart['Inventory.md'].bytes.toString('utf8'),
  );
  assert.deepEqual(bankAfterRestart, startingBank, 'Source row, values and formula must remain unchanged after restart.');
  assertProjection(viewsAfterRestart, domAfterRestart, ids, bankAfterRestart, 'after restart');
  const editorAfterRestart = await readEditor(driver);
  assert.equal(editorAfterRestart.pageHeading, 'Origin Views');
  assert.ok(editorAfterRestart.prose.includes(FIXTURE_PROSE) && editorAfterRestart.prose.includes(proseToken),
    'The rendered note heading, fixture prose and token must survive restart.');
  await driver.screenshot(path.join(candidate.evidence, 'independent-158-picker-after-restart.png'));
  await recordStep('independent-158-picker-flush-restart-preserved-three-views', {
    ids,
    insertedViewId: insertedView.viewId,
    viewIds: viewsAfterRestart.map((view) => view.viewId),
    configs: viewsAfterRestart,
    proseToken,
    noteSha256BeforeRestart: contentAfterInsert['Views.md'].sha256,
    noteSha256AfterRestart: contentAfterRestart['Views.md'].sha256,
    bankAfterRestart: summarizeContent(Object.fromEntries(BANK_FILES.map((relative) => [relative, contentAfterRestart[relative]]))),
    dom: domAfterRestart,
    markdownStableAfterRestart: true,
  });
  return {
    noteId: ids.note,
    sourceId: ids.source,
    insertedViewId: insertedView.viewId,
    insertedViewTitle: insertedView.title,
    originalViewConfigs: originalViews,
    configsAfterInsert: viewsAfterInsert,
    proseToken,
    beforeInsert: summarizeContent(startingContent),
    afterInsert: summarizeContent(contentAfterInsert),
    afterRestart: summarizeContent(contentAfterRestart),
  };
}
