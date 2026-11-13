// Independent Linux-native E003-G06 scenario. The native runner owns only the
// frozen candidate, synthetic profile, private display/DBus, driver lifecycle,
// restart and evidence retention; all interactions and assertions live here.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
const PENDING_OBSERVER_KEY = '__MORROW_E003_G06_PENDING_OBSERVER__';
const CONTENT_FILES = ['Inventory.md', 'Inventory/Widget.md', 'Views.md'];
const KEY = { ctrl: '\uE009', shift: '\uE008', enter: '\uE007', escape: '\uE00C' };

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function capture(file) {
  const bytes = await readFile(file);
  const info = await stat(file);
  return { bytes, sha256: sha256(bytes), size: bytes.length, mtimeMs: info.mtimeMs };
}

async function captureContent(vault) {
  const result = {};
  for (const relative of CONTENT_FILES) result[relative] = await capture(path.join(vault, relative));
  return result;
}

function publicSnapshot(snapshot) {
  return Object.fromEntries(Object.entries(snapshot).map(([name, value]) => [name, {
    sha256: value.sha256,
    size: value.size,
    mtimeMs: value.mtimeMs,
  }]));
}

function assertNoWrite(before, after, label) {
  for (const relative of CONTENT_FILES) {
    assert.equal(after[relative].sha256, before[relative].sha256, `${label}: bytes changed for ${relative}`);
    assert.equal(after[relative].size, before[relative].size, `${label}: size changed for ${relative}`);
    assert.equal(after[relative].mtimeMs, before[relative].mtimeMs, `${label}: mtime changed for ${relative}`);
  }
}

function parseScalar(markdown, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.trim().match(new RegExp(`^(?:[-*]\\s*)?${escaped}\\s*::?\\s*(.*?)\\s*$`, 'i'));
    if (match) return String(match[1]).trim().replace(/^['"]|['"]$/g, '').replace(/^\*\*(.*)\*\*$/, '$1');
  }
  const rows = markdown.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('|'));
  for (let index = 0; index + 1 < rows.length; index += 1) {
    const headers = rows[index].split('|').slice(1, -1).map((cell) => cell.trim());
    const column = headers.indexOf(name);
    if (column < 0) continue;
    const valuesRow = rows.slice(index + 1).find((line) => !/^\|\s*:?-{2,}/.test(line));
    if (!valuesRow) return null;
    return String(valuesRow.split('|').slice(1, -1)[column] ?? '').trim().replace(/^['"]|['"]$/g, '');
  }
  return null;
}

function assertBank(markdown, quantity, price = 10) {
  const persistedQuantity = parseScalar(markdown, 'Quantity');
  const persistedPrice = parseScalar(markdown, 'Price');
  assert.ok(persistedQuantity !== null && persistedQuantity.trim() !== '', 'Persisted row must contain Quantity.');
  assert.ok(persistedPrice !== null && persistedPrice.trim() !== '', 'Persisted row must contain Price.');
  assert.equal(Number(persistedQuantity), quantity, `Expected persisted Quantity=${quantity}`);
  assert.equal(Number(persistedPrice), price, `Expected persisted Price=${price}`);
}

function decodeViews(markdown) {
  const records = [];
  const pattern = /<!-- morrow:polaris-dados-view:v1:([A-Za-z0-9_-]+) -->/g;
  for (const match of markdown.matchAll(pattern)) {
    records.push(JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')));
  }
  return records;
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

async function elementRef(driver, selector, rootIndex = null) {
  const reference = await driver.execute(`
    const roots = [...document.querySelectorAll('[data-provider="polaris-dados"]')];
    const root = arguments[1] === null ? document : roots[arguments[1]];
    return root?.querySelector(arguments[0]) ?? null;
  `, [selector, rootIndex]);
  const id = reference?.[ELEMENT_KEY] ?? reference?.ELEMENT;
  if (!id) throw new Error(`No rendered element for ${selector}${rootIndex === null ? '' : ` in view root ${rootIndex}`}`);
  return id;
}

async function rootRef(driver, rootIndex) {
  const reference = await driver.execute(`
    const roots = [...document.querySelectorAll('[data-provider="polaris-dados"]')];
    return roots[arguments[0]] ?? null;
  `, [rootIndex]);
  const id = reference?.[ELEMENT_KEY] ?? reference?.ELEMENT;
  if (!id) throw new Error(`No Polaris Dados root at index ${rootIndex}`);
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

async function clickWithin(driver, selector, rootIndex = null) {
  return clickRef(driver, await elementRef(driver, selector, rootIndex));
}

async function typeWithin(driver, selector, text, rootIndex = null, { clear = false } = {}) {
  const id = await elementRef(driver, selector, rootIndex);
  if (clear) await clearRef(driver, id);
  await typeRef(driver, id, text);
}

async function setPreferences(driver) {
  await driver.execute(`const key = 'morrow.preferences';
    const before = JSON.parse(localStorage.getItem(key) || '{}');
    localStorage.setItem(key, JSON.stringify({ ...before, plugins: true, locale: 'en', theme: 'dark', startPage: 'home' }));`);
  await driver.refresh();
  const info = await waitFor(() => driver.execute('return window.__MORROW_INFO__ || null'), 'isolated runtime identity');
  return info;
}

async function routeToPage(driver, pageId) {
  await driver.execute(`location.hash = '#/page/' + encodeURIComponent(arguments[0]);`, [pageId]);
}

async function sourceUi(driver) {
  return driver.execute(`
    const roots = [...document.querySelectorAll('[data-provider="polaris-dados"]')];
    const root = roots[0];
    const row = root?.querySelector('tbody tr');
    const cell = (id) => row?.querySelector('[data-field="' + id + '"]')?.textContent?.trim() ?? null;
    return {
      count: roots.length,
      title: root?.querySelector('table[aria-label]')?.getAttribute('aria-label') ?? null,
      rowId: row?.dataset.rowId ?? null,
      quantity: cell('quantity'),
      price: cell('price'),
      total: cell('total'),
      totalKind: row?.querySelector('[data-field="total"] [data-value-kind]')?.getAttribute('data-value-kind') ?? null,
    };
  `);
}

async function waitSource(driver, quantity, total) {
  return waitFor(async () => {
    const value = await sourceUi(driver);
    return value.count === 1 && value.quantity === String(quantity) && value.total === String(total)
      ? value
      : false;
  }, `one source grid with Quantity=${quantity}, Total=${total}`);
}

async function linkedUi(driver) {
  return driver.execute(`
    const roots = [...document.querySelectorAll('[data-provider="polaris-dados"]')];
    return roots.map((root) => {
      const table = root.querySelector('table.polaris-dados-grid');
      const rows = [...(table?.querySelectorAll('tbody tr') ?? [])];
      const headers = [...(table?.querySelectorAll('thead th') ?? [])].map((header) =>
        header.dataset.columnId ?? header.dataset.columnKey ?? header.textContent?.trim() ?? ''
      );
      return {
        title: root.querySelector('[data-view-toolbar] [data-view-title]')?.textContent?.trim() ?? null,
        headers,
        rows: rows.map((row) => ({
          id: row.dataset.rowId ?? null,
          quantity: row.querySelector('[data-field="quantity"]')?.textContent?.trim() ?? null,
          price: row.querySelector('[data-field="price"]')?.textContent?.trim() ?? null,
          total: row.querySelector('[data-field="total"]')?.textContent?.trim() ?? null,
        })),
      };
    });
  `);
}

async function waitLinked(driver, predicate, label) {
  return waitFor(async () => {
    const roots = await linkedUi(driver);
    return roots.length === 2 && predicate(roots) ? roots : false;
  }, label);
}

async function focusIsInRoot(driver, index) {
  return driver.execute(`const roots = [...document.querySelectorAll('[data-provider="polaris-dados"]')];
    return !!roots[arguments[0]] && roots[arguments[0]].contains(document.activeElement);`, [index]);
}

async function editQuantity(candidate, driver, value, { key = null, saveButton = false } = {}) {
  const rowPath = path.join(candidate.vault, 'Inventory/Widget.md');
  const beforeInputHistory = key === 'undo' ? await capture(rowPath) : null;
  let inputHistoryEvidence = null;
  await clickWithin(driver, 'button[data-action="edit"][data-field="quantity"]');
  let input = await elementRef(driver, 'input[type="number"][data-field="quantity"]');
  assert.equal(await driver.execute('return document.activeElement?.matches(`input[type="number"][data-field="quantity"]`) === true'), true,
    'The quantity editor must receive focus after opening.');
  await typeRef(driver, input, `${KEY.ctrl}a`);
  await typeRef(driver, input, String(value));
  if (key === 'undo') {
    await typeRef(driver, input, `${KEY.ctrl}z`);
    const draftAfterUndo = await driver.execute('return document.querySelector(`input[type="number"][data-field="quantity"]`)?.value ?? null');
    assert.equal(draftAfterUndo, '2', 'Native field undo should restore only the draft value before Save.');
    assertBank(await readFile(rowPath, 'utf8'), 2);
    const afterUndo = await capture(rowPath);
    assert.equal(afterUndo.sha256, beforeInputHistory.sha256,
      'Native input undo must leave persisted row bytes unchanged before Save.');
    assert.equal(afterUndo.mtimeMs, beforeInputHistory.mtimeMs,
      'Native input undo must leave persisted row mtime unchanged before Save.');
    await typeRef(driver, input, `${KEY.ctrl}${KEY.shift}z`);
    const draftAfterRedo = await driver.execute('return document.querySelector(`input[type="number"][data-field="quantity"]`)?.value ?? null');
    assert.equal(draftAfterRedo, String(value), 'Native field redo should restore the edited draft before Save.');
    const afterRedo = await capture(rowPath);
    assert.equal(afterRedo.sha256, beforeInputHistory.sha256,
      'Native input redo must leave persisted row bytes unchanged before Save.');
    assert.equal(afterRedo.mtimeMs, beforeInputHistory.mtimeMs,
      'Native input redo must leave persisted row mtime unchanged before Save.');
    inputHistoryEvidence = {
      before: { sha256: beforeInputHistory.sha256, size: beforeInputHistory.size, mtimeMs: beforeInputHistory.mtimeMs },
      afterUndo: { sha256: afterUndo.sha256, size: afterUndo.size, mtimeMs: afterUndo.mtimeMs },
      afterRedo: { sha256: afterRedo.sha256, size: afterRedo.size, mtimeMs: afterRedo.mtimeMs },
      draftAfterUndo,
      draftAfterRedo,
    };
  }
  if (key === 'escape') {
    await typeRef(driver, input, KEY.escape);
    await waitSource(driver, 2, 20);
    assert.equal(await focusIsInRoot(driver, 0), true, 'Escape should close the draft and restore provider focus.');
    return;
  }
  if (key === 'enter') {
    await typeRef(driver, input, KEY.enter);
  } else if (saveButton) {
    await clickWithin(driver, 'button[data-action="save"]');
  }
  return inputHistoryEvidence;
}

async function waitFileQuantity(candidate, expected) {
  return waitFor(async () => {
    const markdown = await readFile(path.join(candidate.vault, 'Inventory/Widget.md'), 'utf8');
    const quantity = parseScalar(markdown, 'Quantity');
    return quantity !== null && quantity.trim() !== '' && Number(quantity) === expected ? markdown : false;
  }, `persisted Inventory/Widget.md Quantity=${expected}`);
}

async function readFileViews(candidate) {
  return decodeViews(await readFile(path.join(candidate.vault, 'Views.md'), 'utf8'));
}

async function readProfileIds(candidate) {
  const workspace = JSON.parse(await readFile(path.join(candidate.vault, '.morrow/workspace.json'), 'utf8'));
  const pages = workspace.pages ?? {};
  const ids = {
    source: pages['Inventory.md']?.id,
    row: pages['Inventory/Widget.md']?.id,
    note: pages['Views.md']?.id,
  };
  assert.ok(Object.values(ids).every((id) => typeof id === 'string' && id.length > 0), 'Synthetic workspace IDs must be present.');
  return ids;
}

function assertViewsShareSource(views, sourceId, label) {
  assert.equal(views.length, 2, `${label}: note must retain exactly two linked-view markers.`);
  assert.equal(new Set(views.map((view) => view.viewId)).size, 2, `${label}: view IDs must be distinct.`);
  assert.ok(views.every((view) => view.sourceDatabaseId === sourceId), `${label}: both views must use the local database.`);
}

async function readRecentMetadata(vault) {
  let file;
  try {
    file = await capture(path.join(vault, '.morrow/recent.json'));
  } catch (error) {
    if (error?.code === 'ENOENT') return { present: false, sha256: null, size: null, mtimeMs: null, opened: null };
    throw error;
  }
  let value;
  try { value = JSON.parse(file.bytes.toString('utf8')); }
  catch { value = null; }
  return { present: true, sha256: file.sha256, size: file.size, mtimeMs: file.mtimeMs, opened: value?.opened ?? null };
}

async function installPendingObserver(driver) {
  const installed = await driver.execute(`(() => {
    const key = ${JSON.stringify(PENDING_OBSERVER_KEY)};
    if (window[key]) return false;
    const state = { lastEditorInputAt: null, firstViewSaveClickAt: null };
    const onInput = (event) => {
      const target = event.target;
      if (event.isTrusted && target instanceof Element &&
        target.closest('.ProseMirror[contenteditable="true"]') &&
        !target.closest('[data-provider="polaris-dados"]')) {
        state.lastEditorInputAt = performance.now();
        state.lastEditorInputTrusted = event.isTrusted;
        state.lastEditorInputTarget = target.tagName;
        state.lastEditorInputRootIndex = -1;
        state.lastEditorInputProviderRootCount = document.querySelectorAll('[data-provider="polaris-dados"]').length;
      }
    };
    const onClick = (event) => {
      const target = event.target;
      const button = target instanceof Element ? target.closest('button[data-action="view-save"]') : null;
      const roots = [...document.querySelectorAll('[data-provider="polaris-dados"]')];
      if (event.isTrusted && button && roots.length === 2 && roots[0]?.contains(button) && state.lastEditorInputAt !== null) {
        state.firstViewSaveClickAt ??= performance.now();
        state.firstViewSaveTrusted = event.isTrusted;
        state.firstViewSaveTarget = button.dataset.action;
        state.firstViewSaveRootIndex = roots.indexOf(button.closest('[data-provider="polaris-dados"]'));
      }
    };
    document.addEventListener('input', onInput, true);
    document.addEventListener('click', onClick, true);
    window[key] = { state, onInput, onClick };
    return true;
  })()`);
  assert.equal(installed, true, 'Pending-text observer must be newly installed for this real UI action.');
}

async function readPendingObservation(driver) {
  return driver.execute(`return window[${JSON.stringify(PENDING_OBSERVER_KEY)}]?.state ?? null`);
}

async function removePendingObserver(driver) {
  await driver.execute(`(() => {
    const key = ${JSON.stringify(PENDING_OBSERVER_KEY)};
    const observer = window[key];
    if (!observer) return false;
    document.removeEventListener('input', observer.onInput, true);
    document.removeEventListener('click', observer.onClick, true);
    delete window[key];
    return true;
  })()`);
}

export async function runIndependentFunctionalScenario(context) {
  const { candidate, prepared, restartSession, recordStep } = context;
  let { driver } = context;

  const ids = await readProfileIds(candidate);
  assert.equal(ids.source, candidate.databaseId, 'Inventory.md page ID must identify the source database used by the fixture.');
  const originalViews = await readFileViews(candidate);
  assertViewsShareSource(originalViews, ids.source, 'initial fixture');
  assert.deepEqual(originalViews.map((view) => view.viewId), candidate.linkedViews.origin.map((view) => view.viewId),
    'The two view marker IDs in the synthetic note must match the registered origin fixture.');
  assert.equal(originalViews[0].filter?.propertyId, 'quantity');
  assert.equal(originalViews[0].filter?.value, 1);
  assert.equal(originalViews[1].filter?.propertyId, 'quantity');
  assert.equal(originalViews[1].filter?.value, 3);
  assert.ok(originalViews[0].columnOrder.includes('price') && originalViews[0].columnOrder.includes('quantity'));

  const formulaBefore = await readFile(path.join(candidate.vault, 'Inventory.md'), 'utf8');
  assert.match(formulaBefore, /formula:\s*Quantity\s*\*\s*Price/i);
  const rowBefore = await readFile(path.join(candidate.vault, 'Inventory/Widget.md'), 'utf8');
  assertBank(rowBefore, 2, 10);
  const generatedContent = prepared.originVaultContent;
  assert.ok(generatedContent && typeof generatedContent === 'object', 'Pre-launch origin-vault inventory must be available from preparation.');
  const sourceBaseline = Object.fromEntries(CONTENT_FILES.map((relative) => {
    const expected = generatedContent[relative];
    assert.ok(expected, `Pre-launch origin-vault inventory is missing ${relative}.`);
    return [relative, expected];
  }));
  const beforeNavigation = await captureContent(candidate.vault);
  assertNoWrite(sourceBaseline, beforeNavigation, 'Application launch before UI navigation');
  const recentBeforeNavigation = await readRecentMetadata(candidate.vault);
  const initialSnapshot = publicSnapshot(sourceBaseline);

  const runtime = await driver.execute('return window.__MORROW_INFO__ || null');
  assert.equal(runtime?.platform, 'linux', 'Scenario must run in a Linux native application.');
  assert.equal(runtime?.dataPath, candidate.expectedBackendDataPath, 'Runtime dataPath must be the private synthetic profile.');
  const refreshedRuntime = await setPreferences(driver);
  assert.equal(refreshedRuntime?.platform, 'linux');
  assert.equal(refreshedRuntime?.dataPath, candidate.expectedBackendDataPath);
  await routeToPage(driver, ids.source);
  const initialGrid = await waitSource(driver, 2, 20);
  assert.equal(initialGrid.rowId, ids.row);
  assert.equal(initialGrid.price, '10');
  assert.equal(initialGrid.totalKind, 'number', 'Total=20 must be a native numeric formula result.');
  await driver.screenshot(path.join(candidate.evidence, 'independent-157-source-initial.png'));
  await recordStep('independent-157-source-initial-20', { rowId: initialGrid.rowId, grid: initialGrid });

  await routeToPage(driver, ids.note);
  const initialLinked = await waitLinked(driver, (roots) =>
    roots[0].title === originalViews[0].title && roots[1].title === originalViews[1].title,
  'exactly two linked-view roots in note order');
  assert.deepEqual(initialLinked.map((root) => root.rows.map((row) => row.id)), [[ids.row], []],
    'Initial quantity=2 should pass view A filter >=1 and fail view B filter >=3.');
  await driver.screenshot(path.join(candidate.evidence, 'independent-157-two-views-initial.png'));

  const afterOpen = await captureContent(candidate.vault);
  assertNoWrite(sourceBaseline, afterOpen, 'Opening source and two-view note compared with pre-launch fixture');
  const recentAfterOpen = await readRecentMetadata(candidate.vault);
  await recordStep('independent-157-no-write-on-open', {
    fixtureInitialContent: Object.fromEntries(CONTENT_FILES.map((relative) => [relative, {
      sha256: generatedContent[relative].sha256,
      size: generatedContent[relative].size,
      mtimeMs: generatedContent[relative].mtimeMs,
    }])),
    contentBefore: initialSnapshot,
    contentAfter: publicSnapshot(afterOpen),
    recentMetadataBefore: recentBeforeNavigation,
    recentMetadataAfter: recentAfterOpen,
  });

  await routeToPage(driver, ids.source);
  await waitSource(driver, 2, 20);
  const beforeCancel = await captureContent(candidate.vault);
  await editQuantity(candidate, driver, 0, { saveButton: false });
  await clickWithin(driver, 'button[data-action="cancel"]');
  await waitSource(driver, 2, 20);
  const afterButtonCancel = await captureContent(candidate.vault);
  assertNoWrite(beforeCancel, afterButtonCancel, 'Cancel button');
  assert.equal(await focusIsInRoot(driver, 0), true, 'Cancel should restore provider focus.');

  await editQuantity(candidate, driver, 0, { key: 'escape' });
  const afterEscape = await captureContent(candidate.vault);
  assertNoWrite(beforeCancel, afterEscape, 'Escape cancellation');

  const inputUndoEvidence = await editQuantity(candidate, driver, 3, { key: 'undo', saveButton: true });
  const savedThree = await waitFileQuantity(candidate, 3);
  assertBank(savedThree, 3, 10);
  const gridThree = await waitSource(driver, 3, 30);
  assert.equal(gridThree.price, '10');
  assert.equal(gridThree.totalKind, 'number', 'Total=30 must remain a native numeric formula result.');
  assert.equal(await focusIsInRoot(driver, 0), true, 'Save should restore provider focus after committing the row.');
  await driver.screenshot(path.join(candidate.evidence, 'independent-157-saved-30.png'));
  await recordStep('independent-157-input-undo-and-save-30', {
    grid: gridThree,
    rowSha256: sha256(Buffer.from(savedThree)),
    inputUndoEvidence,
  });

  await editQuantity(candidate, driver, 0, { key: 'enter' });
  const savedZero = await waitFileQuantity(candidate, 0);
  assertBank(savedZero, 0, 10);
  const gridZero = await waitSource(driver, 0, 0);
  assert.equal(gridZero.totalKind, 'number', 'Zero must remain a native numeric formula result.');
  assert.equal(await focusIsInRoot(driver, 0), true, 'Enter should save the field and restore provider focus.');
  await recordStep('independent-157-enter-saved-zero', { grid: gridZero, rowSha256: sha256(Buffer.from(savedZero)) });

  const sourceRootId = await rootRef(driver, 0);
  await clickRef(driver, sourceRootId);
  await typeRef(driver, sourceRootId, `${KEY.ctrl}z`);
  const restoredThree = await waitFileQuantity(candidate, 3);
  assertBank(restoredThree, 3, 10);
  await waitSource(driver, 3, 30);
  await recordStep('independent-157-bank-history-restored-three-from-zero');

  await routeToPage(driver, ids.note);
  await waitLinked(driver, (roots) => roots[0].title === originalViews[0].title, 'two linked views after source edit');
  const originalRowIds = await driver.execute(`return [...document.querySelectorAll('[data-provider="polaris-dados"]')].map((root) =>
    [...root.querySelectorAll('tbody tr')].map((row) => row.dataset.rowId));`);
  assert.deepEqual(originalRowIds, [[ids.row], [ids.row]], 'Both views must project the same row when Q=3.');

  const bankBeforeConfig = await captureContent(candidate.vault);
  const firstRootId = await elementRef(driver, 'button[data-action="view-settings-toggle"]', 0);
  await clickRef(driver, firstRootId);
  const titleInputId = await elementRef(driver, '[data-action="view-title"]', 0);
  const nextTitle = `${originalViews[0].title} verified`;
  await clearRef(driver, titleInputId);
  await typeRef(driver, titleInputId, nextTitle);
  const initialOrder = originalViews[0].columnOrder;
  const quantityIndex = initialOrder.indexOf('quantity');
  const priceIndex = initialOrder.indexOf('price');
  assert.ok(quantityIndex >= 0 && priceIndex >= 0 && quantityIndex !== priceIndex,
    'Fixture primary view needs Quantity and Price priorities for the ordering check.');
  const moveAction = quantityIndex > priceIndex ? 'view-move-up' : 'view-move-down';
  await clickWithin(driver, `button[data-action="${moveAction}"][data-column-id="quantity"]`, 0);
  await typeWithin(driver, '[data-action="view-filter-value"]', '2', 0, { clear: true });

  // Add a real editor draft while the view-config draft is still unsaved. A passive
  // observer records the trusted editor-input and Save-click events against the
  // actual debounce window; the scenario never changes app handlers or timers.
  const pendingToken = `pending-view-draft-${Date.now()}`;
  const paragraphId = await (async () => {
    const reference = await driver.execute(`const editor = document.querySelector('.ProseMirror[contenteditable="true"]');
      return [...(editor?.querySelectorAll('p') ?? [])].find((item) =>
        item.textContent?.includes('two linked views below share Inventory.md')
      ) ?? null;`);
    const id = reference?.[ELEMENT_KEY] ?? reference?.ELEMENT;
    if (!id) throw new Error('Could not find the real note paragraph for the pending-text preservation check.');
    return id;
  })();
  const editorId = await elementRef(driver, '.ProseMirror[contenteditable="true"]');
  const saveConfigId = await elementRef(driver, 'button[data-action="view-save"]', 0);
  await clickRef(driver, paragraphId);
  await installPendingObserver(driver);
  let pendingObservation;
  let editorText;
  let beforeProjectionBytes;
  try {
    await typeRef(driver, editorId, ` ${pendingToken}`);
    beforeProjectionBytes = await readFile(path.join(candidate.vault, 'Views.md'));
    const pendingDom = await driver.execute(`return {
      text: document.querySelector('.ProseMirror[contenteditable="true"]')?.innerText ?? '',
      observation: window[${JSON.stringify(PENDING_OBSERVER_KEY)}]?.state ?? null,
    }`);
    editorText = pendingDom.text;
    pendingObservation = pendingDom.observation;
    assert.ok(editorText.includes(pendingToken), 'Pending text must be visible in the real note editor DOM.');
    assert.ok(!beforeProjectionBytes.toString('utf8').includes(pendingToken),
      'Text must still be pending in memory before configuration flush/projection.');
    assert.ok(Number.isFinite(pendingObservation?.lastEditorInputAt), 'A real editor input event must be observed.');
    assert.equal(pendingObservation?.lastEditorInputTrusted, true, 'The pending text must come from trusted UI input.');
    assert.equal(pendingObservation?.lastEditorInputRootIndex, -1, 'The pending input must target the page editor outside plugin roots.');
    assert.equal(pendingObservation?.lastEditorInputProviderRootCount, 2,
      'Pending text must be edited while both real linked-view roots are mounted.');
    assert.equal(pendingObservation?.firstViewSaveClickAt, null, 'Configuration Save must not be clicked before pending text is observed.');
    await clickRef(driver, saveConfigId);
    pendingObservation = await readPendingObservation(driver);
  } finally {
    await removePendingObserver(driver);
  }
  assert.ok(pendingObservation, 'The passive observer state must remain available after the real Save click.');
  assert.ok(Number.isFinite(pendingObservation.firstViewSaveClickAt), 'A trusted configuration Save click must be observed.');
  const elapsedToConfigClickMs = pendingObservation.firstViewSaveClickAt - pendingObservation.lastEditorInputAt;
  assert.ok(Number.isFinite(elapsedToConfigClickMs) && elapsedToConfigClickMs >= 0 && elapsedToConfigClickMs < 250,
    `Real editor input-to-configuration click must cross the 250 ms debounce window; observed ${elapsedToConfigClickMs} ms.`);
  assert.equal(pendingObservation.firstViewSaveTrusted, true, 'The view configuration must be saved by a trusted UI click.');
  assert.equal(pendingObservation.firstViewSaveTarget, 'view-save');
  assert.equal(pendingObservation.firstViewSaveRootIndex, 0, 'The click must save only view A configuration.');
  await waitFor(async () => {
    const note = await readFile(path.join(candidate.vault, 'Views.md'), 'utf8');
    const views = decodeViews(note);
    return views[0]?.title === nextTitle && note.includes(pendingToken) ? views : false;
  }, 'configuration projection and pending note text persisted');
  const configuredNote = await readFile(path.join(candidate.vault, 'Views.md'), 'utf8');
  const configuredViews = decodeViews(configuredNote);
  assertViewsShareSource(configuredViews, ids.source, 'after first view configuration');
  assert.equal(configuredViews[0].title, nextTitle);
  assert.equal(configuredViews[0].filter.propertyId, 'quantity');
  assert.equal(configuredViews[0].filter.value, 2);
  assert.notDeepEqual(configuredViews[0].columnOrder, originalViews[0].columnOrder,
    'Saving view A must persist its changed priority order.');
  assert.deepEqual(configuredViews[1], originalViews[1], 'View B configuration must remain byte-equivalent.');
  const configuredUi = await waitLinked(driver, (roots) =>
    roots[0].title === nextTitle && roots[1].title === originalViews[1].title,
  'two scoped views after configuration projection');
  assert.deepEqual(configuredUi.map((root) => root.rows.map((row) => row.id)), [[ids.row], [ids.row]],
    'Changing A configuration should leave Q=3 visible in both independent filters.');
  assert.ok(configuredUi[0].headers.indexOf('quantity') < configuredUi[0].headers.indexOf('price'),
    'View A should render the changed Quantity-before-Price priority.');
  const afterConfigBank = await captureContent(candidate.vault);
  for (const relative of ['Inventory.md', 'Inventory/Widget.md']) {
    assert.equal(afterConfigBank[relative].sha256, bankBeforeConfig[relative].sha256,
      `Saving view configuration must not change source data ${relative}.`);
    assert.equal(afterConfigBank[relative].mtimeMs, bankBeforeConfig[relative].mtimeMs,
      `Saving view configuration must not update source data mtime ${relative}.`);
  }
  await driver.screenshot(path.join(candidate.evidence, 'independent-157-view-a-configured.png'));
  await recordStep('independent-157-pending-text-survived-view-projection', {
    pendingToken,
    pendingObservation: {
      ...pendingObservation,
      method: 'passive trusted DOM input/click listeners with performance.now; removed in finally',
    },
    elapsedToConfigClickMs,
    pendingTextVisibleInRealEditor: editorText.includes(pendingToken),
    bytesStillOldBeforeConfigurationClick: !beforeProjectionBytes.toString('utf8').includes(pendingToken),
    noteSha256: sha256(Buffer.from(configuredNote)),
    configuredViews,
    bankUnchanged: publicSnapshot({
      'Inventory.md': afterConfigBank['Inventory.md'],
      'Inventory/Widget.md': afterConfigBank['Inventory/Widget.md'],
    }),
  });

  await clickWithin(driver, 'button[data-action="view-undo"]', 0);
  await waitFor(async () => {
    const views = await readFileViews(candidate);
    return JSON.stringify(views[0]) === JSON.stringify(originalViews[0]) && JSON.stringify(views[1]) === JSON.stringify(originalViews[1])
      ? views
      : false;
  }, 'view A configuration undo without changing view B');
  assertBank(await readFile(path.join(candidate.vault, 'Inventory/Widget.md'), 'utf8'), 3, 10);
  await clickWithin(driver, 'button[data-action="view-redo"]', 0);
  await waitFor(async () => {
    const views = await readFileViews(candidate);
    return JSON.stringify(views[0]) === JSON.stringify(configuredViews[0]) && JSON.stringify(views[1]) === JSON.stringify(originalViews[1])
      ? views
      : false;
  }, 'view A configuration redo with view B unchanged');
  assertBank(await readFile(path.join(candidate.vault, 'Inventory/Widget.md'), 'utf8'), 3, 10);
  const noteAfterConfigHistory = await capture(path.join(candidate.vault, 'Views.md'));
  await recordStep('independent-157-view-config-history-isolated', {
    originalViewA: originalViews[0],
    configuredViewA: configuredViews[0],
    unchangedViewB: configuredViews[1],
    noteSha256AfterRedo: noteAfterConfigHistory.sha256,
  });

  const secondRootId = await rootRef(driver, 1);
  await clickRef(driver, secondRootId);
  await typeRef(driver, secondRootId, `${KEY.ctrl}z`);
  const historyUndoRow = await waitFileQuantity(candidate, 2);
  assertBank(historyUndoRow, 2, 10);
  const afterSharedUndo = await waitLinked(driver, (roots) => roots[0].rows.length === 1 && roots[1].rows.length === 0,
    'shared bank undo reflected by both view filters');
  assert.equal(afterSharedUndo[0].rows[0].id, ids.row);
  assert.equal(afterSharedUndo[0].rows[0].quantity, '2');
  assert.equal(sha256(await readFile(path.join(candidate.vault, 'Views.md'))), noteAfterConfigHistory.sha256,
    'Data history must not modify the linked-view note configuration.');
  await clickRef(driver, secondRootId);
  await typeRef(driver, secondRootId, `${KEY.ctrl}${KEY.shift}z`);
  const historyRedoRow = await waitFileQuantity(candidate, 3);
  assertBank(historyRedoRow, 3, 10);
  const afterSharedRedo = await waitLinked(driver, (roots) => roots.every((root) => root.rows.length === 1),
    'shared bank redo reflected by both views');
  assert.ok(afterSharedRedo.every((root) => root.rows[0].id === ids.row && root.rows[0].quantity === '3' && root.rows[0].total === '30'));
  assert.equal(sha256(await readFile(path.join(candidate.vault, 'Views.md'))), noteAfterConfigHistory.sha256);
  await recordStep('independent-157-bank-history-shared-by-both-views', {
    undo: { rowSha256: sha256(Buffer.from(historyUndoRow)), roots: afterSharedUndo },
    redo: { rowSha256: sha256(Buffer.from(historyRedoRow)), roots: afterSharedRedo },
  });

  const viewIdsBeforeRestart = (await readFileViews(candidate)).map((view) => view.viewId);
  const configsBeforeRestart = await readFileViews(candidate);
  driver = await restartSession();
  const runtimeAfterRestart = await driver.execute('return window.__MORROW_INFO__ || null');
  assert.equal(runtimeAfterRestart?.platform, 'linux');
  assert.equal(runtimeAfterRestart?.dataPath, candidate.expectedBackendDataPath);
  await routeToPage(driver, ids.source);
  const afterRestartGrid = await waitSource(driver, 3, 30);
  assert.equal(afterRestartGrid.rowId, ids.row);
  assert.equal(afterRestartGrid.totalKind, 'number');
  assertBank(await readFile(path.join(candidate.vault, 'Inventory/Widget.md'), 'utf8'), 3, 10);
  const formulaAfterRestart = await readFile(path.join(candidate.vault, 'Inventory.md'), 'utf8');
  assert.match(formulaAfterRestart, /formula:\s*Quantity\s*\*\s*Price/i);
  await routeToPage(driver, ids.note);
  const afterRestartViewsUi = await waitLinked(driver, (roots) =>
    roots[0].title === configuredViews[0].title && roots[1].title === originalViews[1].title,
  'two persisted view configurations after restart');
  const viewsAfterRestart = await readFileViews(candidate);
  assert.deepEqual(viewsAfterRestart.map((view) => view.viewId), viewIdsBeforeRestart,
    'Linked-view IDs must remain stable through flush and restart.');
  assert.deepEqual(viewsAfterRestart, configsBeforeRestart, 'Both current view configurations must survive restart.');
  assert.equal(viewsAfterRestart[0].sourceDatabaseId, ids.source);
  assert.equal(viewsAfterRestart[1].sourceDatabaseId, ids.source);
  const noteAfterRestart = await readFile(path.join(candidate.vault, 'Views.md'), 'utf8');
  assert.ok(noteAfterRestart.includes(pendingToken), 'Pending note text must persist after restart.');
  const editorAfterRestart = await driver.execute(`return document.querySelector('.ProseMirror[contenteditable="true"]')?.innerText ?? '';`);
  assert.ok(editorAfterRestart.includes(pendingToken), 'Pending text must remain visible after restart.');
  assert.ok(afterRestartViewsUi.every((root) => root.rows.length === 1 && root.rows[0].id === ids.row));
  await driver.screenshot(path.join(candidate.evidence, 'independent-157-after-restart.png'));
  await recordStep('independent-157-flush-restart-preserved-data-expression-ids-config-text', {
    ids,
    rowId: afterRestartGrid.rowId,
    viewIds: viewIdsBeforeRestart,
    views: viewsAfterRestart,
    rowSha256: sha256(await readFile(path.join(candidate.vault, 'Inventory/Widget.md'))),
    schemaSha256: sha256(Buffer.from(formulaAfterRestart)),
    noteSha256: sha256(Buffer.from(noteAfterRestart)),
    pendingToken,
  });
}
