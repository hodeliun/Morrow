import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PROVIDER = '[data-provider="polaris-dados"]';
const VIEW_NODE = '.polaris-dados-view-node';
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
const CONTENT_FILES = ['Inventory.md', 'Inventory/Widget.md', 'Views.md'];
const WAIT_TIMEOUT_MS = 25_000;
const WAIT_INTERVAL_MS = 100;
const PENDING_OBSERVER_KEY = '__MORROW_NATIVE_FUNCTIONAL_PENDING__';

export function decodeLinkedViewMarkers(markdown) {
  const markers = [...markdown.matchAll(/<!-- morrow:polaris-dados-view:v1:([A-Za-z0-9_-]+) -->/g)];
  return markers.map((match) => {
    let config;
    try {
      config = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    } catch (error) {
      throw new Error(`Could not decode linked-view marker: ${error?.message ?? error}`, { cause: error });
    }
    if (!config || config.version !== 1 || typeof config.viewId !== 'string') {
      throw new Error('Linked-view marker has an unsupported or incomplete config.');
    }
    return config;
  });
}

export function assertViewConfigs(actual, expected, label = 'linked views') {
  if (actual.length !== expected.length) {
    throw new Error(`${label}: expected ${expected.length} configs, got ${actual.length}`);
  }
  const ids = actual.map((config) => config.viewId);
  if (new Set(ids).size !== ids.length)
    throw new Error(`${label}: duplicate view IDs were rendered or persisted`);
  for (let index = 0; index < expected.length; index += 1) {
    const got = actual[index];
    const want = expected[index];
    if (
      got.viewId !== want.viewId ||
      got.sourceDatabaseId !== want.sourceDatabaseId ||
      got.title !== want.title ||
      JSON.stringify(got.columnOrder) !== JSON.stringify(want.columnOrder) ||
      JSON.stringify(got.filter) !== JSON.stringify(want.filter)
    ) {
      throw new Error(`${label}: config ${index} changed unexpectedly: ${JSON.stringify({ got, want })}`);
    }
  }
}

export function assertExactViewTopology(snapshot, expectedTitles) {
  if (snapshot.providerCount !== expectedTitles.length || snapshot.views.length !== expectedTitles.length) {
    throw new Error(
      `Expected exactly ${expectedTitles.length} linked provider roots/wrappers; ` +
        `found ${snapshot.providerCount} roots and ${snapshot.views.length} wrappers.`,
    );
  }
  for (let index = 0; index < expectedTitles.length; index += 1) {
    const view = snapshot.views[index];
    if (view.rootCount !== 1 || view.title !== expectedTitles[index]) {
      throw new Error(
        `Linked view ${index} is missing/duplicated or has the wrong title: ${JSON.stringify({
          ...view,
          expectedTitle: expectedTitles[index],
        })}`,
      );
    }
  }
}

export function assertExactRowProjection(rows, expectedVisible, expectedRowId, label = 'row projection') {
  const expectedCount = expectedVisible ? 1 : 0;
  if (!Array.isArray(rows) || rows.length !== expectedCount) {
    throw new Error(
      `${label}: expected exactly ${expectedCount} row(s), got ${Array.isArray(rows) ? rows.length : '<not an array>'}.`,
    );
  }
  if (expectedVisible && rows[0]?.id !== expectedRowId) {
    throw new Error(`${label}: expected stable row ID ${expectedRowId}, got ${rows[0]?.id ?? '<missing>'}.`);
  }
}

export function compareContentSnapshots(before, after, label = 'vault content') {
  const result = {};
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const relative of paths) {
    const initial = before[relative];
    const current = after[relative];
    if (!initial || !current) throw new Error(`${label}: missing content snapshot for ${relative}`);
    const bytesUnchanged = initial.hash === current.hash;
    const mtimeUnchanged = initial.mtimeMs === current.mtimeMs;
    result[relative] = {
      before: { sha256: initial.hash, mtimeMs: initial.mtimeMs, size: initial.size },
      after: { sha256: current.hash, mtimeMs: current.mtimeMs, size: current.size },
      bytesUnchanged,
      mtimeUnchanged,
    };
    if (!bytesUnchanged || !mtimeUnchanged) {
      throw new Error(`${label}: ${relative} changed bytes or mtime without an accepted edit.`);
    }
  }
  return result;
}

export async function runNativeFunctionalScenario({
  driver: initialDriver,
  candidate,
  prepared,
  restartSession,
  recordStep,
}) {
  if (!initialDriver || typeof restartSession !== 'function' || typeof recordStep !== 'function') {
    throw new Error(
      'The native functional scenario requires the isolated driver, restart callback, and evidence callback.',
    );
  }
  if (!candidate?.vault || !candidate?.databaseId || !candidate?.evidence || !prepared?.bankBefore) {
    throw new Error('The native functional scenario requires the prepared synthetic candidate.');
  }

  let driver = initialDriver;
  const noteId = await linkedViewNoteId(candidate.vault);
  const initialConfigs = candidate.linkedViews?.origin;
  if (!Array.isArray(initialConfigs) || initialConfigs.length !== 2) {
    throw new Error('The origin fixture must provide exactly two linked-view configs.');
  }
  if (initialConfigs.some((config) => config.sourceDatabaseId !== candidate.databaseId)) {
    throw new Error('Both linked-view configs must point to the generated origin database.');
  }
  const initialContent = initialContentSnapshot(prepared);
  const initialViewsMarkdown = await readFile(path.join(candidate.vault, 'Views.md'), 'utf8');
  const persistedInitialConfigs = decodeLinkedViewMarkers(initialViewsMarkdown);
  assertViewConfigs(persistedInitialConfigs, initialConfigs, 'synthetic fixture');

  const initialMetadata = await captureExpectedMetadata(candidate.vault);
  const databaseOpenedAt = await recentOpenedAt(candidate.vault, candidate.databaseId);
  await navigateToPage(driver, candidate.databaseId);
  await waitForSourceGrid(driver, 'real source grid');
  await waitForRecentPage(candidate.vault, candidate.databaseId, databaseOpenedAt);
  const initialSourceGrid = await assertSourceGrid(driver, { quantity: 2, price: 10, total: 20 });
  const sourceRowId = initialSourceGrid.rowId;
  const afterSourceOpen = await captureFunctionalContent(candidate.vault);
  const sourceOpenComparison = compareContentSnapshots(
    initialContent,
    afterSourceOpen,
    'opening Inventory.md',
  );
  const afterSourceMetadata = await captureExpectedMetadata(candidate.vault);
  await writeEvidence(candidate, 'native-functional-source-open.json', {
    observedAt: new Date().toISOString(),
    expectedGrid: { quantity: 2, price: 10, total: 20 },
    content: sourceOpenComparison,
    metadataBefore: initialMetadata,
    metadataAfter: afterSourceMetadata,
    recentMetadataMayChange: true,
  });
  await driver.screenshot(path.join(candidate.evidence, 'native-functional-source-initial.png'));
  await recordStep('functional-source-open-no-write', {
    grid: { quantity: 2, price: 10, total: 20 },
    content: sourceOpenComparison,
  });

  const rowOpenedAt = await recentOpenedAt(candidate.vault, sourceRowId);
  await navigateToPage(driver, sourceRowId);
  const rowPage = await waitFor(
    async () =>
      driver
        .execute(
          `
    const rows = [...document.querySelectorAll('.row-props .row-prop')];
    const properties = Object.fromEntries(rows.map((row) => [
      row.querySelector('.row-prop-name')?.textContent?.trim() ?? '',
      row.querySelector('.row-prop-value')?.textContent?.trim() ?? '',
    ]));
    return {
      title: document.querySelector('textarea.page-title')?.value ?? null,
      hasPageBody: document.querySelector('.page-scroll') !== null,
      providerCount: document.querySelectorAll('${PROVIDER}').length,
      titleReadonly: document.querySelector('textarea.page-title')?.readOnly ?? false,
      editablePropertyNames: document.querySelectorAll('.row-props .row-prop-name.row-prop-button').length,
      propertyEditors: document.querySelectorAll('.row-props input, .row-props textarea, .row-props select, .row-props .row-prop-actions button').length,
      properties,
      formulaLiteral: document.querySelector('.formula-source-literal')?.textContent?.trim() ?? null,
    };
  `,
        )
        .then((state) => (state.title === 'Widget' ? state : false)),
    'real Widget row page',
  );
  await waitForRecentPage(candidate.vault, sourceRowId, rowOpenedAt);
  if (
    !rowPage.hasPageBody ||
    rowPage.providerCount !== 0 ||
    !rowPage.titleReadonly ||
    rowPage.editablePropertyNames !== 0 ||
    rowPage.propertyEditors !== 0 ||
    rowPage.properties.Quantity !== '2' ||
    rowPage.properties.Price !== '10' ||
    rowPage.properties.Total !== 'Quantity * Price' ||
    rowPage.formulaLiteral !== 'Quantity * Price'
  ) {
    throw new Error(
      `Widget row page did not expose the expected read-only source data: ${JSON.stringify(rowPage)}`,
    );
  }
  const afterRowOpen = await captureFunctionalContent(candidate.vault);
  const rowOpenComparison = compareContentSnapshots(
    initialContent,
    afterRowOpen,
    'opening Inventory/Widget.md',
  );
  await writeEvidence(candidate, 'native-functional-row-open.json', {
    observedAt: new Date().toISOString(),
    rowId: sourceRowId,
    properties: rowPage,
    content: rowOpenComparison,
    metadataBefore: initialMetadata,
    metadataAfter: await captureExpectedMetadata(candidate.vault),
    recentMetadataMayChange: true,
  });
  await driver.screenshot(path.join(candidate.evidence, 'native-functional-row-page.png'));
  await recordStep('functional-row-open-no-write', {
    rowId: sourceRowId,
    properties: rowPage,
    content: rowOpenComparison,
  });

  const returnToSourceAt = await recentOpenedAt(candidate.vault, candidate.databaseId);
  await navigateToPage(driver, candidate.databaseId);
  await waitForSourceGrid(driver, 'source grid after Widget row page');
  await waitForRecentPage(candidate.vault, candidate.databaseId, returnToSourceAt);
  await assertGridNoWriteSince(
    candidate.vault,
    initialContent,
    'returning from Inventory/Widget.md before Views.md',
  );

  const viewsOpenedAt = await recentOpenedAt(candidate.vault, noteId);
  await navigateToPage(driver, noteId);
  await waitFor(async () => {
    const state = await linkedViewsDom(driver);
    return state.providerCount === 2 && state.views.length === 2 ? state : false;
  }, 'two linked-view roots');
  await waitForRecentPage(candidate.vault, noteId, viewsOpenedAt);
  let viewState = await linkedViewsDom(driver);
  const initialTitles = initialConfigs.map((config) => config.title);
  assertExactViewTopology(viewState, initialTitles);
  await assertLinkedViewRows(viewState, [true, false], 2, sourceRowId);
  const afterViewsOpen = await captureFunctionalContent(candidate.vault);
  const viewsOpenComparison = compareContentSnapshots(initialContent, afterViewsOpen, 'opening Views.md');
  await writeEvidence(candidate, 'native-functional-views-open.json', {
    observedAt: new Date().toISOString(),
    providerCount: viewState.providerCount,
    views: viewState.views,
    content: viewsOpenComparison,
    metadataBefore: initialMetadata,
    metadataAfter: await captureExpectedMetadata(candidate.vault),
    recentMetadataMayChange: true,
  });
  await driver.screenshot(path.join(candidate.evidence, 'native-functional-two-views-initial.png'));
  await recordStep('functional-two-views-open-no-write', {
    providerCount: viewState.providerCount,
    views: viewState.views,
    content: viewsOpenComparison,
  });

  const sourceOpenBeforeEdits = await recentOpenedAt(candidate.vault, candidate.databaseId);
  await navigateToPage(driver, candidate.databaseId);
  await waitForSourceGrid(driver, 'source grid after linked views');
  await waitForRecentPage(candidate.vault, candidate.databaseId, sourceOpenBeforeEdits);
  await assertGridNoWriteSince(candidate.vault, initialContent, 'returning from Views.md before editing');

  const sourceRoots = await driver.elements(PROVIDER);
  if (sourceRoots.length !== 1)
    throw new Error(`Expected one source root before editing, got ${sourceRoots.length}`);
  const sourceRoot = elementId(sourceRoots[0]);
  const beforeCancel = await captureFunctionalContent(candidate.vault);
  await editQuantity(driver, sourceRoot, '3');
  await clickWithin(driver, sourceRoot, '[data-action="cancel"]');
  await waitForSourceGrid(driver, 'source grid after Cancel');
  await assertProviderFocus(driver, 'Cancel');
  assertContentSame(beforeCancel, await captureFunctionalContent(candidate.vault), 'Cancel');
  await assertSourceGrid(driver, { quantity: 2, price: 10, total: 20, rowId: sourceRowId });
  await recordStep('functional-save-cancel-cancel-preserved-bytes', {
    content: summarizeContent(beforeCancel),
  });

  const beforeEscape = await captureFunctionalContent(candidate.vault);
  const escapeEditor = await editQuantity(driver, sourceRoot, '4');
  await sendKeysToElement(driver, escapeEditor, '\uE00C');
  await waitForSourceGrid(driver, 'source grid after Escape');
  await assertProviderFocus(driver, 'Escape');
  assertContentSame(beforeEscape, await captureFunctionalContent(candidate.vault), 'Escape');
  await assertSourceGrid(driver, { quantity: 2, price: 10, total: 20, rowId: sourceRowId });
  await recordStep('functional-save-cancel-escape-preserved-bytes', {
    content: summarizeContent(beforeEscape),
  });

  const inputUndoBefore = await captureFunctionalContent(candidate.vault);
  const inputEditor = await editQuantity(driver, sourceRoot, '4');
  await sendKeysToElement(driver, inputEditor, '\uE009z');
  const nativeDraft = await inputValue(driver);
  if (nativeDraft !== '2')
    throw new Error(`Native field undo should restore the input draft to 2; got ${nativeDraft}`);
  await sendKeysToElement(driver, inputEditor, '\uE009\uE008z');
  const nativeRedoDraft = await inputValue(driver);
  if (nativeRedoDraft !== '4')
    throw new Error(`Native field redo should restore the input draft to 4; got ${nativeRedoDraft}`);
  await sendKeysToElement(driver, inputEditor, '\uE009z');
  const nativeRestoredDraft = await inputValue(driver);
  if (nativeRestoredDraft !== '2')
    throw new Error(
      `Native field undo after redo should restore the input draft to 2; got ${nativeRestoredDraft}`,
    );
  assertContentSame(inputUndoBefore, await captureFunctionalContent(candidate.vault), 'native input undo');
  await sendKeysToElement(driver, inputEditor, '\uE00C');
  await waitForSourceGrid(driver, 'source grid after input undo Escape');
  await assertSourceGrid(driver, { quantity: 2, price: 10, total: 20, rowId: sourceRowId });
  await recordStep('functional-native-input-undo-redo-did-not-consume-data-history', {
    draftSequence: [2, 4, 2],
    persistedValueUnchanged: true,
  });

  await editQuantity(driver, sourceRoot, '3');
  await clickWithin(driver, sourceRoot, '[data-action="save"]');
  await waitForRowQuantity(candidate.vault, 3);
  await assertSourceGrid(driver, { quantity: 3, price: 10, total: 30, rowId: sourceRowId });
  await driver.screenshot(path.join(candidate.evidence, 'native-functional-quantity-3-total-30.png'));
  await recordStep('functional-save-button-quantity-3-total-30');

  await sendKeysToElement(driver, sourceRoot, '\uE009z');
  await waitForRowQuantity(candidate.vault, 2);
  await assertSourceGrid(driver, { quantity: 2, price: 10, total: 20, rowId: sourceRowId });
  await sendKeysToElement(driver, sourceRoot, '\uE009\uE008z');
  await waitForRowQuantity(candidate.vault, 3);
  await assertSourceGrid(driver, { quantity: 3, price: 10, total: 30, rowId: sourceRowId });
  await editQuantity(driver, sourceRoot, '0');
  const zeroEditor = await editorWithin(driver, sourceRoot);
  await sendKeysToElement(driver, zeroEditor, '\uE007');
  await waitForRowQuantity(candidate.vault, 0);
  await assertSourceGrid(driver, { quantity: 0, price: 10, total: 0, rowId: sourceRowId });
  await sendKeysToElement(driver, sourceRoot, '\uE009z');
  await waitForRowQuantity(candidate.vault, 3);
  await assertSourceGrid(driver, { quantity: 3, price: 10, total: 30, rowId: sourceRowId });
  await assertFormulaFile(candidate.vault);
  await recordStep('functional-enter-zero-and-bank-undo-redo', { sequence: [3, 2, 3, 0, 3] });

  const beforeSecondViewsOpen = await captureFunctionalContent(candidate.vault);
  const noteOpenedAtAgain = await recentOpenedAt(candidate.vault, noteId);
  await navigateToPage(driver, noteId);
  await waitForTwoLinkedViews(driver, 'linked views after source edits');
  await waitForRecentPage(candidate.vault, noteId, noteOpenedAtAgain);
  assertContentSame(
    beforeSecondViewsOpen,
    await captureFunctionalContent(candidate.vault),
    'reopening Views.md before configuration',
  );
  viewState = await linkedViewsDom(driver);
  assertExactViewTopology(viewState, initialTitles);
  await assertLinkedViewRows(viewState, [true, true], 3, sourceRowId);

  const changedConfig = {
    ...initialConfigs[0],
    title: `${initialConfigs[0].title} revised`,
    columnOrder: ['quantity', 'price'],
    filter: { propertyId: 'quantity', op: 'gte', value: 4 },
  };
  const sourceDataBeforeConfig = await captureFunctionalContent(candidate.vault);
  const viewSaveButton = await prepareViewConfig(driver, 0, changedConfig);
  const noteContentBeforeDraft = await captureFile(path.join(candidate.vault, 'Views.md'));
  const draftToken = `PENDING-LINKED-NOTE-157-${Date.now()}`;
  await installPendingObserver(driver);
  let pendingObservation;
  let pendingEditorState;
  let noteAfterDraft;
  try {
    pendingEditorState = await typePendingNoteText(driver, draftToken);
    noteAfterDraft = await captureFile(path.join(candidate.vault, 'Views.md'));
    if (
      noteContentBeforeDraft.hash !== noteAfterDraft.hash ||
      noteContentBeforeDraft.mtimeMs !== noteAfterDraft.mtimeMs
    ) {
      throw new Error(
        'The note draft was written before view configuration Save while the acceptance requires a pending text state.',
      );
    }
    pendingObservation = pendingEditorState.observation;
    if (!Number.isFinite(pendingObservation?.lastEditorInputAt)) {
      throw new Error('The passive observer did not capture a real input event from the note editor.');
    }
    if (
      pendingObservation.lastEditorInputTrusted !== true ||
      pendingObservation.lastEditorInputRootIndex !== -1
    ) {
      throw new Error(
        `Pending note text did not come from trusted input in the page editor: ${JSON.stringify(pendingObservation)}`,
      );
    }
    if (pendingObservation.firstViewSaveClickAt !== null) {
      throw new Error('The view Save was clicked before the pending note draft was observed.');
    }
    await clickElement(driver, viewSaveButton);
    pendingObservation = await readPendingObservation(driver);
  } finally {
    await removePendingObserver(driver);
  }
  const elapsedToConfigClickMs =
    pendingObservation.firstViewSaveClickAt - pendingObservation.lastEditorInputAt;
  if (
    !Number.isFinite(elapsedToConfigClickMs) ||
    elapsedToConfigClickMs < 0 ||
    elapsedToConfigClickMs >= 250
  ) {
    throw new Error(
      `The view Save must follow the last real editor input before the 250 ms debounce; observed ${elapsedToConfigClickMs} ms.`,
    );
  }
  if (
    pendingObservation.firstViewSaveTrusted !== true ||
    pendingObservation.firstViewSaveTarget !== 'view-save' ||
    pendingObservation.firstViewSaveRootIndex !== 0
  ) {
    throw new Error(
      `The pending text was not flushed by a trusted Save on view A: ${JSON.stringify(pendingObservation)}`,
    );
  }
  await recordStep('functional-note-text-pending-before-view-change', {
    token: draftToken,
    editorContainsToken: pendingEditorState.text.includes(draftToken),
    saveState: 'pending',
    fileBytesUnchanged: noteContentBeforeDraft.hash === noteAfterDraft.hash,
    fileMtimeUnchanged: noteContentBeforeDraft.mtimeMs === noteAfterDraft.mtimeMs,
    elapsedToConfigClickMs,
    passiveObservation: pendingObservation,
  });
  await waitForViewConfig(candidate.vault, changedConfig);
  let persistedViews = decodeLinkedViewMarkers(
    await readFile(path.join(candidate.vault, 'Views.md'), 'utf8'),
  );
  assertViewConfigs(persistedViews, [changedConfig, initialConfigs[1]], 'after configuring first view');
  const noteDraftAfterConfig = await editorContains(driver, draftToken);
  if (!noteDraftAfterConfig)
    throw new Error('Changing the first view projection/configuration lost pending note text in the editor.');
  await waitForSavedPage(driver);
  const noteAfterConfig = await readFile(path.join(candidate.vault, 'Views.md'), 'utf8');
  if (!noteAfterConfig.includes(draftToken))
    throw new Error('The note draft was not preserved when the view configuration flushed.');
  persistedViews = decodeLinkedViewMarkers(noteAfterConfig);
  assertViewConfigs(persistedViews, [changedConfig, initialConfigs[1]], 'after configuration flush');
  const sourceDataAfterConfig = await captureFunctionalContent(candidate.vault);
  const sourcePaths = ['Inventory.md', 'Inventory/Widget.md'];
  assertContentSame(
    Object.fromEntries(sourcePaths.map((relative) => [relative, sourceDataBeforeConfig[relative]])),
    Object.fromEntries(sourcePaths.map((relative) => [relative, sourceDataAfterConfig[relative]])),
    'view projection/configuration',
  );
  viewState = await linkedViewsDom(driver);
  assertExactViewTopology(viewState, [changedConfig.title, initialConfigs[1].title]);
  await assertLinkedViewRows(viewState, [false, true], 3, sourceRowId);
  if (viewState.views[0].columnIds.slice(1, 3).join(',') !== 'property:"quantity",property:"price"') {
    throw new Error(
      `First view column order did not update independently: ${JSON.stringify(viewState.views[0].columnIds)}`,
    );
  }
  await driver.screenshot(path.join(candidate.evidence, 'native-functional-first-view-configured.png'));
  await recordStep('functional-first-view-config-and-pending-text-preserved', {
    first: changedConfig,
    second: persistedViews[1],
    pendingTextPreserved: true,
    sourceDataUnchanged: summarizeContent(
      Object.fromEntries(sourcePaths.map((relative) => [relative, sourceDataAfterConfig[relative]])),
    ),
    firstViewRows: viewState.views[0].rows.length,
    secondViewRows: viewState.views[1].rows.length,
  });

  await toggleViewSettings(driver, 1, true);
  const secondUndoDisabled = await viewHistoryButtonDisabled(driver, 1, 'view-undo');
  if (!secondUndoDisabled)
    throw new Error('Second view unexpectedly inherited the first view configuration history.');
  await toggleViewSettings(driver, 0, true);
  const firstUndoDisabled = await viewHistoryButtonDisabled(driver, 0, 'view-undo');
  if (firstUndoDisabled)
    throw new Error('First view configuration history is not available after its saved change.');
  await clickWithinView(driver, 0, '[data-action="view-undo"]');
  await waitFor(async () => {
    const configs = decodeLinkedViewMarkers(await readFile(path.join(candidate.vault, 'Views.md'), 'utf8'));
    return sameConfig(configs[0], initialConfigs[0]) ? configs : false;
  }, 'first-view configuration undo');
  persistedViews = decodeLinkedViewMarkers(await readFile(path.join(candidate.vault, 'Views.md'), 'utf8'));
  assertViewConfigs(persistedViews, initialConfigs, 'after first-view undo');
  viewState = await waitFor(async () => {
    const state = await linkedViewsDom(driver);
    return state.views?.[0]?.title === initialConfigs[0].title ? state : false;
  }, 'first linked-view undo projection');
  assertExactViewTopology(viewState, initialTitles);
  await assertLinkedViewRows(viewState, [true, true], 3, sourceRowId);
  if (!(await editorContains(driver, draftToken)))
    throw new Error('Undoing view configuration lost pending note text.');
  await clickWithinView(driver, 0, '[data-action="view-redo"]');
  await waitFor(async () => {
    const configs = decodeLinkedViewMarkers(await readFile(path.join(candidate.vault, 'Views.md'), 'utf8'));
    return sameConfig(configs[0], changedConfig) ? configs : false;
  }, 'first-view configuration redo');
  persistedViews = decodeLinkedViewMarkers(await readFile(path.join(candidate.vault, 'Views.md'), 'utf8'));
  assertViewConfigs(persistedViews, [changedConfig, initialConfigs[1]], 'after first-view redo');
  viewState = await waitFor(async () => {
    const state = await linkedViewsDom(driver);
    return state.views?.[0]?.title === changedConfig.title ? state : false;
  }, 'first linked-view redo projection');
  assertExactViewTopology(viewState, [changedConfig.title, initialConfigs[1].title]);
  await assertLinkedViewRows(viewState, [false, true], 3, sourceRowId);
  if (!(await editorContains(driver, draftToken)))
    throw new Error('Redoing view configuration lost pending note text.');
  await recordStep('functional-view-history-is-per-view', {
    firstCanUndo: true,
    secondCanUndo: false,
    secondConfigUnchanged: sameConfig(persistedViews[1], initialConfigs[1]),
  });
  await toggleViewSettings(driver, 0, false);
  await toggleViewSettings(driver, 1, false);

  const sourceBeforeLinkedEditAt = await recentOpenedAt(candidate.vault, candidate.databaseId);
  await navigateToPage(driver, candidate.databaseId);
  await waitForSourceGrid(driver, 'source grid before linked-view shared edit');
  await waitForRecentPage(candidate.vault, candidate.databaseId, sourceBeforeLinkedEditAt);
  await assertSourceGrid(driver, { quantity: 3, price: 10, total: 30, rowId: sourceRowId });
  const viewsBeforeLinkedEditAt = await recentOpenedAt(candidate.vault, noteId);
  await navigateToPage(driver, noteId);
  await waitForTwoLinkedViews(driver, 'linked views before shared edit');
  await waitForRecentPage(candidate.vault, noteId, viewsBeforeLinkedEditAt);
  viewState = await linkedViewsDom(driver);
  assertExactViewTopology(viewState, [changedConfig.title, initialConfigs[1].title]);
  await assertLinkedViewRows(viewState, [false, true], 3, sourceRowId);

  const secondViewRoot = await linkedViewRoot(driver, 1);
  await editQuantity(driver, secondViewRoot, '4');
  const secondEditor = await editorWithin(driver, secondViewRoot);
  await sendKeysToElement(driver, secondEditor, '\uE007');
  await waitForRowQuantity(candidate.vault, 4);
  viewState = await waitFor(async () => {
    const state = await linkedViewsDom(driver);
    return state.views?.[1]?.rows.some((row) => row.quantity === '4') ? state : false;
  }, 'second linked view reflects shared Quantity=4');
  assertExactViewTopology(viewState, [changedConfig.title, initialConfigs[1].title]);
  await assertLinkedViewRows(viewState, [true, true], 4, sourceRowId);
  if (viewState.views[0].rows[0]?.quantity !== '4' || viewState.views[1].rows[0]?.quantity !== '4') {
    throw new Error('Both linked views did not reflect the same shared row record.');
  }

  const secondViewRootAfterEdit = await linkedViewRoot(driver, 1);
  await sendKeysToElement(driver, secondViewRootAfterEdit, '\uE009z');
  await waitForRowQuantity(candidate.vault, 3);
  viewState = await waitFor(async () => {
    const state = await linkedViewsDom(driver);
    return state.views?.[1]?.rows.some((row) => row.quantity === '3') ? state : false;
  }, 'shared bank undo from second linked view');
  await assertLinkedViewRows(viewState, [false, true], 3, sourceRowId);
  await toggleViewSettings(driver, 0, true);
  const firstViewUndoStillEnabled = !(await viewHistoryButtonDisabled(driver, 0, 'view-undo'));
  if (!firstViewUndoStillEnabled)
    throw new Error('Shared data undo consumed the independent first-view configuration history.');
  await sendKeysToElement(driver, await linkedViewRoot(driver, 1), '\uE009\uE008z');
  await waitForRowQuantity(candidate.vault, 4);
  viewState = await waitFor(async () => {
    const state = await linkedViewsDom(driver);
    return state.views?.[0]?.rows.some((row) => row.quantity === '4') ? state : false;
  }, 'shared bank redo visible in both linked views');
  await assertLinkedViewRows(viewState, [true, true], 4, sourceRowId);
  await assertFormulaFile(candidate.vault);
  await waitForSavedPage(driver);
  await recordStep('functional-two-views-share-data-and-bank-history', {
    quantityAfterUndo: 3,
    quantityAfterRedo: 4,
    bothViewsUpdated: true,
    formula: 'Quantity * Price',
  });
  await driver.screenshot(path.join(candidate.evidence, 'native-functional-shared-records-history.png'));

  viewState = await linkedViewsDom(driver);
  assertExactViewTopology(viewState, [changedConfig.title, initialConfigs[1].title]);
  const beforeRestartContent = await captureFunctionalContent(candidate.vault);
  const beforeRestartViews = decodeLinkedViewMarkers(
    await readFile(path.join(candidate.vault, 'Views.md'), 'utf8'),
  );
  assertViewConfigs(beforeRestartViews, [changedConfig, initialConfigs[1]], 'before native restart');
  assertQuantityFile(await readFile(path.join(candidate.vault, 'Inventory/Widget.md'), 'utf8'), 4);
  await assertFormulaFile(candidate.vault);
  await writeEvidence(candidate, 'native-functional-before-restart.json', {
    observedAt: new Date().toISOString(),
    expectedRow: { quantity: 4, price: 10, total: 40 },
    views: beforeRestartViews,
    content: summarizeContent(beforeRestartContent),
    noteTextPreserved: (await readFile(path.join(candidate.vault, 'Views.md'), 'utf8')).includes(draftToken),
  });

  driver = await restartSession();
  await recordStep('functional-app-restarted', { candidate: candidate.expectedCommit });
  const restartOpenedAt = await recentOpenedAt(candidate.vault, candidate.databaseId);
  await navigateToPage(driver, candidate.databaseId);
  await waitForSourceGrid(driver, 'source grid after restart');
  await waitForRecentPage(candidate.vault, candidate.databaseId, restartOpenedAt);
  await assertSourceGrid(driver, { quantity: 4, price: 10, total: 40, rowId: sourceRowId });
  const afterRestartSourceOpen = await captureFunctionalContent(candidate.vault);
  const restartSourceComparison = compareContentSnapshots(
    beforeRestartContent,
    afterRestartSourceOpen,
    'source open after restart',
  );
  const restartedNoteAt = await recentOpenedAt(candidate.vault, noteId);
  await navigateToPage(driver, noteId);
  await waitForTwoLinkedViews(driver, 'linked views after restart');
  await waitForRecentPage(candidate.vault, noteId, restartedNoteAt);
  viewState = await linkedViewsDom(driver);
  assertExactViewTopology(viewState, [changedConfig.title, initialConfigs[1].title]);
  await assertLinkedViewRows(viewState, [true, true], 4, sourceRowId);
  if (viewState.views[0].rows[0]?.quantity !== '4' || viewState.views[1].rows[0]?.quantity !== '4') {
    throw new Error('Both linked views must show the persisted record after restart.');
  }
  const afterRestartViewsOpen = await captureFunctionalContent(candidate.vault);
  const restartViewsComparison = compareContentSnapshots(
    beforeRestartContent,
    afterRestartViewsOpen,
    'Views.md open after restart',
  );
  const restartViewsMarkdown = await readFile(path.join(candidate.vault, 'Views.md'), 'utf8');
  if (!restartViewsMarkdown.includes(draftToken))
    throw new Error('Pending note text did not survive flush/restart.');
  const afterRestartConfigs = decodeLinkedViewMarkers(restartViewsMarkdown);
  assertViewConfigs(afterRestartConfigs, [changedConfig, initialConfigs[1]], 'after native restart');
  const afterRestartMetadata = await captureExpectedMetadata(candidate.vault);
  await writeEvidence(candidate, 'native-functional-after-restart.json', {
    observedAt: new Date().toISOString(),
    expectedRow: { quantity: 4, price: 10, total: 40 },
    views: afterRestartConfigs,
    contentAfterSourceOpen: restartSourceComparison,
    contentAfterViewsOpen: restartViewsComparison,
    metadataAfter: afterRestartMetadata,
    recentMetadataMayChange: true,
    noteTextPreserved: true,
  });
  await driver.screenshot(path.join(candidate.evidence, 'native-functional-after-restart.png'));
  await recordStep('functional-two-views-flush-restart-preserved', {
    quantity: 4,
    price: 10,
    total: 40,
    viewIds: afterRestartConfigs.map((config) => config.viewId),
    configs: afterRestartConfigs,
    noteTextPreserved: true,
    content: restartViewsComparison,
  });
}

async function linkedViewNoteId(vault) {
  const workspace = JSON.parse(await readFile(path.join(vault, '.morrow/workspace.json'), 'utf8'));
  const page = workspace.pages?.['Views.md'];
  if (typeof page?.id !== 'string' || !page.id)
    throw new Error('Synthetic workspace has no Views.md page ID.');
  return page.id;
}

function initialContentSnapshot(prepared) {
  const note = prepared.originVaultContent?.['Views.md'];
  if (!note) throw new Error('The source fixture freeze does not include Views.md content metadata.');
  return {
    'Inventory.md': prepared.bankBefore['Inventory.md'],
    'Inventory/Widget.md': prepared.bankBefore['Inventory/Widget.md'],
    'Views.md': { hash: note.sha256, mtimeMs: note.mtimeMs, size: note.size },
  };
}

async function captureFunctionalContent(vault) {
  const entries = await Promise.all(
    CONTENT_FILES.map(async (relative) => [relative, await captureFile(path.join(vault, relative))]),
  );
  return Object.fromEntries(entries);
}

async function captureFile(file) {
  const [bytes, info] = await Promise.all([readFile(file), stat(file)]);
  return {
    bytes,
    hash: createHash('sha256').update(bytes).digest('hex'),
    mtimeMs: info.mtimeMs,
    size: info.size,
  };
}

async function captureExpectedMetadata(vault) {
  const result = {};
  for (const relative of ['.morrow/recent.json', '.morrow/plugins.json', '.morrow/workspace.json']) {
    try {
      const info = await captureFile(path.join(vault, relative));
      result[relative] = { sha256: info.hash, size: info.size, mtimeMs: info.mtimeMs };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      result[relative] = null;
    }
  }
  return result;
}

async function assertGridNoWriteSince(vault, before, label) {
  const after = await captureFunctionalContent(vault);
  return compareContentSnapshots(before, after, label);
}

function assertContentSame(before, after, label) {
  return compareContentSnapshots(before, after, label);
}

function summarizeContent(files) {
  return Object.fromEntries(
    Object.entries(files).map(([relative, info]) => [
      relative,
      {
        sha256: info.hash,
        mtimeMs: info.mtimeMs,
        size: info.size,
      },
    ]),
  );
}

async function writeEvidence(candidate, file, value) {
  await writeFile(path.join(candidate.evidence, file), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

async function recentOpenedAt(vault, pageId) {
  try {
    const recent = JSON.parse(await readFile(path.join(vault, '.morrow/recent.json'), 'utf8'));
    const value = recent?.opened?.[pageId];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function waitForRecentPage(vault, pageId, previousOpenedAt) {
  return waitFor(async () => {
    const current = await recentOpenedAt(vault, pageId);
    return current !== null && (previousOpenedAt === null || current > previousOpenedAt) ? current : false;
  }, `recent metadata for page ${pageId}`);
}

async function navigateToPage(driver, pageId) {
  await driver.execute(`location.hash = '#/page/' + encodeURIComponent(arguments[0]);`, [pageId]);
}

async function sourceGrid(driver) {
  return driver.execute(`
    const roots = [...document.querySelectorAll('${PROVIDER}')];
    const root = roots.length === 1 ? roots[0] : null;
    const rows = [...(root?.querySelectorAll('table tbody tr') ?? [])].map((row) => ({ id: row.dataset.rowId ?? null }));
    const read = (propertyId) => {
      const node = root?.querySelector('[data-property-id="' + propertyId + '"]');
      return { kind: node?.dataset.valueKind ?? null, text: node?.textContent?.trim() ?? null };
    };
    return {
      providerCount: roots.length,
      quantity: read('quantity'),
      price: read('price'),
      total: read('total'),
      rows,
      rowId: rows[0]?.id ?? root?.querySelector('button[data-action="edit"][data-field="quantity"]')?.dataset.rowId ?? null,
      text: root?.innerText ?? '',
    };
  `);
}

async function waitForSourceGrid(driver, label) {
  return waitFor(async () => {
    const snapshot = await sourceGrid(driver);
    return snapshot.providerCount === 1 ? snapshot : false;
  }, label);
}

async function assertProviderFocus(driver, action) {
  const focused = await driver.execute(`
    const roots = [...document.querySelectorAll('${PROVIDER}')];
    return roots.length === 1 && roots[0].contains(document.activeElement);
  `);
  if (!focused) throw new Error(`The source provider did not retain/restore focus after ${action}.`);
}

async function assertSourceGrid(driver, expected) {
  const state = await waitFor(async () => {
    const value = await sourceGrid(driver);
    return value.providerCount === 1 &&
      value.quantity.text === String(expected.quantity) &&
      value.price.text === String(expected.price) &&
      value.total.text === String(expected.total)
      ? value
      : false;
  }, `source grid Q=${expected.quantity}, P=${expected.price}, T=${expected.total}`);
  if (state.quantity.kind !== 'number' || state.price.kind !== 'number' || state.total.kind !== 'number') {
    throw new Error(`The source grid did not expose computed numeric cells: ${JSON.stringify(state)}`);
  }
  if (!state.rowId) throw new Error('The source grid quantity editor has no stable row ID.');
  assertExactRowProjection(state.rows, true, expected.rowId ?? state.rowId, 'source grid');
  return state;
}

async function linkedViewsDom(driver) {
  return driver.execute(`
    const wrappers = [...document.querySelectorAll('${VIEW_NODE}')];
    const views = wrappers.map((wrapper) => {
      const roots = [...wrapper.querySelectorAll('${PROVIDER}')];
      const root = roots.length === 1 ? roots[0] : null;
      const table = root?.querySelector('table') ?? null;
      const rows = [...(table?.querySelectorAll('tbody tr') ?? [])].map((row) => ({
        id: row.dataset.rowId ?? null,
        quantity: row.querySelector('[data-property-id="quantity"]')?.textContent?.trim() ?? null,
        price: row.querySelector('[data-property-id="price"]')?.textContent?.trim() ?? null,
        total: row.querySelector('[data-property-id="total"]')?.textContent?.trim() ?? null,
        text: row.textContent?.trim() ?? '',
      }));
      return {
        rootCount: roots.length,
        title: root?.querySelector('[data-view-toolbar] [data-view-title]')?.textContent?.trim() ?? null,
        columnIds: [...(table?.querySelectorAll('thead th') ?? [])].map((item) => item.dataset.columnKey ?? item.dataset.columnId ?? null),
        rows,
        text: root?.innerText ?? '',
      };
    });
    return { providerCount: document.querySelectorAll('${PROVIDER}').length, views };
  `);
}

async function waitForTwoLinkedViews(driver, label) {
  return waitFor(async () => {
    const snapshot = await linkedViewsDom(driver);
    return snapshot.providerCount === 2 && snapshot.views.length === 2 ? snapshot : false;
  }, label);
}

async function assertLinkedViewRows(snapshot, expectedVisible, quantity, expectedRowId) {
  if (snapshot.views.length !== expectedVisible.length)
    throw new Error('Linked-view row check saw an unexpected wrapper count.');
  for (let index = 0; index < expectedVisible.length; index += 1) {
    const rows = snapshot.views[index].rows;
    assertExactRowProjection(rows, expectedVisible[index], expectedRowId, `linked view ${index}`);
    if (expectedVisible[index] && rows[0]?.quantity !== String(quantity)) {
      throw new Error(`Linked view ${index} does not show Quantity=${quantity}: ${JSON.stringify(rows[0])}`);
    }
  }
}

function sameConfig(actual, expected) {
  return (
    Boolean(actual) &&
    actual.viewId === expected.viewId &&
    actual.sourceDatabaseId === expected.sourceDatabaseId &&
    actual.title === expected.title &&
    JSON.stringify(actual.columnOrder) === JSON.stringify(expected.columnOrder) &&
    JSON.stringify(actual.filter) === JSON.stringify(expected.filter)
  );
}

async function waitForSavedPage(driver) {
  await waitFor(
    () =>
      driver.execute(`
    const status = document.querySelector('.save-status');
    if (!status) return false;
    return !status.classList.contains('is-saving') && !status.classList.contains('is-error');
  `),
    'page save queue to settle',
  );
}

async function typePendingNoteText(driver, token) {
  const editors = await driver.elements('.ProseMirror[contenteditable="true"]');
  if (editors.length !== 1) throw new Error(`Expected one visible note editor, got ${editors.length}.`);
  const editor = elementId(editors[0]);
  await clickElement(driver, editor);
  await sendKeysToElement(driver, editor, '\uE009\uE007\uE000');
  await sendKeysToElement(driver, editor, ` ${token}`);
  const state = await driver.execute(`
    const editor = document.querySelector('.ProseMirror[contenteditable="true"]');
    const status = document.querySelector('.save-status');
    return {
      text: editor?.innerText ?? '',
      focusedInEditor: Boolean(editor && editor.contains(document.activeElement)),
      saving: status?.classList.contains('is-saving') ?? false,
      error: status?.classList.contains('is-error') ?? false,
      observation: window[${JSON.stringify(PENDING_OBSERVER_KEY)}]?.state ?? null,
    };
  `);
  if (!state.focusedInEditor || !state.text.includes(token) || state.error) {
    throw new Error(`The real note editor did not retain a pending text draft: ${JSON.stringify(state)}`);
  }
  return state;
}

async function installPendingObserver(driver) {
  const installed = await driver.execute(
    `
    const key = arguments[0];
    if (window[key]) throw new Error('Pending-text observer is already installed.');
    const state = {
      lastEditorInputAt: null,
      lastEditorInputTrusted: null,
      lastEditorInputRootIndex: null,
      firstViewSaveClickAt: null,
      firstViewSaveTrusted: null,
      firstViewSaveTarget: null,
      firstViewSaveRootIndex: null,
    };
    const onInput = (event) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest('.ProseMirror[contenteditable="true"]')) return;
      const roots = [...document.querySelectorAll('${PROVIDER}')];
      state.lastEditorInputAt = performance.now();
      state.lastEditorInputTrusted = event.isTrusted;
      state.lastEditorInputRootIndex = roots.indexOf(target.closest('${PROVIDER}'));
    };
    const onClick = (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest('button[data-action="view-save"]');
      if (!button || state.firstViewSaveClickAt !== null) return;
      const roots = [...document.querySelectorAll('${PROVIDER}')];
      state.firstViewSaveClickAt = performance.now();
      state.firstViewSaveTrusted = event.isTrusted;
      state.firstViewSaveTarget = button.dataset.action ?? null;
      state.firstViewSaveRootIndex = roots.indexOf(button.closest('${PROVIDER}'));
    };
    document.addEventListener('input', onInput, true);
    document.addEventListener('click', onClick, true);
    window[key] = { state, onInput, onClick };
    return true;
  `,
    [PENDING_OBSERVER_KEY],
  );
  if (installed !== true) throw new Error('Could not install the passive pending-text observer.');
}

async function readPendingObservation(driver) {
  return driver.execute(`return window[arguments[0]]?.state ?? null`, [PENDING_OBSERVER_KEY]);
}

async function removePendingObserver(driver) {
  const removed = await driver.execute(
    `
    const key = arguments[0];
    const observer = window[key];
    if (!observer) return true;
    document.removeEventListener('input', observer.onInput, true);
    document.removeEventListener('click', observer.onClick, true);
    delete window[key];
    return true;
  `,
    [PENDING_OBSERVER_KEY],
  );
  if (removed !== true) throw new Error('Could not remove the passive pending-text observer.');
}

async function editorContains(driver, token) {
  return driver.execute(
    `return document.querySelector('.ProseMirror[contenteditable="true"]')?.innerText.includes(arguments[0]) ?? false`,
    [token],
  );
}

async function toggleViewSettings(driver, index, open) {
  const root = await linkedViewRoot(driver, index);
  const toggles = await findWithin(driver, root, '[data-action="view-settings-toggle"]');
  if (toggles.length !== 1)
    throw new Error(`Expected one view settings toggle for linked view ${index}; got ${toggles.length}.`);
  const expanded = await getAttribute(driver, toggles[0], 'aria-expanded');
  if ((expanded === 'true') !== open) await clickElement(driver, toggles[0]);
  await waitFor(
    async () => {
      const current = await linkedViewRoot(driver, index);
      const forms = await findWithin(driver, current, '[data-view-settings-form]');
      return (forms.length === 1) === open;
    },
    `view ${index} settings ${open ? 'open' : 'closed'}`,
  );
}

async function viewHistoryButtonDisabled(driver, index, action) {
  const root = await linkedViewRoot(driver, index);
  const buttons = await findWithin(driver, root, `[data-action="${action}"]`);
  if (buttons.length !== 1)
    throw new Error(`Expected exactly one ${action} button in linked view ${index}; got ${buttons.length}.`);
  return (await getAttribute(driver, buttons[0], 'disabled')) !== null;
}

async function prepareViewConfig(driver, index, config) {
  await toggleViewSettings(driver, index, true);
  let root = await linkedViewRoot(driver, index);
  let titleInput = await oneWithin(driver, root, '[data-action="view-title"]', 'view title input');
  await clickElement(driver, titleInput);
  await sendKeysToElement(driver, titleInput, '\uE009a');
  await sendKeysToElement(driver, titleInput, config.title);

  const moveUp = await findWithin(driver, root, '[data-action="view-move-up"][data-column-id="quantity"]');
  if (moveUp.length !== 1)
    throw new Error(`Could not find the quantity move-up control for linked view ${index}.`);
  await clickElement(driver, moveUp[0]);

  root = await linkedViewRoot(driver, index);
  const filterProperty = await oneWithin(
    driver,
    root,
    '[data-action="view-filter-property"]',
    'view filter property',
  );
  const selectedProperty = await getPropertyValue(driver, filterProperty);
  if (selectedProperty !== config.filter.propertyId) {
    throw new Error(
      `Fixture filter property ${selectedProperty} does not match desired ${config.filter.propertyId}.`,
    );
  }
  const filterValue = await oneWithin(driver, root, '[data-action="view-filter-value"]', 'view filter value');
  await clickElement(driver, filterValue);
  await sendKeysToElement(driver, filterValue, '\uE009a');
  await sendKeysToElement(driver, filterValue, String(config.filter.value));
  root = await linkedViewRoot(driver, index);
  return oneWithin(driver, root, '[data-action="view-save"]', 'view save button');
}

async function waitForViewConfig(vault, config) {
  await waitFor(async () => {
    const markdown = await readFile(path.join(vault, 'Views.md'), 'utf8').catch(() => null);
    return markdown ? decodeLinkedViewMarkers(markdown).some((item) => sameConfig(item, config)) : false;
  }, 'view configuration save');
}

async function clickWithinView(driver, index, selector) {
  const root = await linkedViewRoot(driver, index);
  const target = await oneWithin(driver, root, selector, selector);
  await clickElement(driver, target);
}

async function linkedViewRoot(driver, index) {
  const wrappers = await driver.elements(VIEW_NODE);
  if (wrappers.length !== 2)
    throw new Error(`Expected exactly two linked-view wrappers; got ${wrappers.length}.`);
  if (!Number.isInteger(index) || index < 0 || index >= wrappers.length)
    throw new Error(`Invalid linked-view index ${index}.`);
  const roots = await findWithin(driver, elementId(wrappers[index]), PROVIDER);
  if (roots.length !== 1) throw new Error(`Linked-view wrapper ${index} has ${roots.length} provider roots.`);
  const allRoots = await driver.elements(PROVIDER);
  if (allRoots.length !== 2)
    throw new Error(`Expected exactly two provider roots on Views.md; got ${allRoots.length}.`);
  return roots[0];
}

async function editorWithin(driver, root) {
  return oneWithin(driver, root, 'input[type="number"][data-field="quantity"]', 'quantity editor');
}

async function editQuantity(driver, root, value) {
  const editButton = await oneWithin(
    driver,
    root,
    'button[data-action="edit"][data-field="quantity"]',
    'quantity edit button',
  );
  await clickElement(driver, editButton);
  const editor = await waitFor(async () => {
    const inputs = await findWithin(driver, root, 'input[type="number"][data-field="quantity"]');
    return inputs.length === 1 ? inputs[0] : false;
  }, 'quantity editor to open');
  await clickElement(driver, editor);
  const focus = await driver.execute(
    `return document.activeElement?.matches('input[type="number"][data-field="quantity"]') ?? false`,
  );
  if (!focus) throw new Error('Quantity field did not receive keyboard focus.');
  await sendKeysToElement(driver, editor, '\uE009a');
  await sendKeysToElement(driver, editor, String(value));
  return editor;
}

async function inputValue(driver) {
  return driver.execute(
    `return document.querySelector('${PROVIDER} input[type="number"][data-field="quantity"]')?.value ?? null`,
  );
}

async function waitForRowQuantity(vault, expected) {
  return waitFor(async () => {
    const markdown = await readFile(path.join(vault, 'Inventory/Widget.md'), 'utf8');
    return parseScalar(markdown, 'Quantity') === String(expected) ? markdown : false;
  }, `Inventory/Widget.md Quantity=${expected}`);
}

function parseScalar(markdown, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return markdown.match(new RegExp(`^${escaped}:\\s*(.*?)\\s*$`, 'm'))?.[1] ?? null;
}

function assertQuantityFile(markdown, expected) {
  const value = parseScalar(markdown, 'Quantity');
  if (value !== String(expected))
    throw new Error(`Expected persisted Quantity=${expected}, found ${value ?? '<missing>'}.`);
}

async function assertFormulaFile(vault) {
  const schema = await readFile(path.join(vault, 'Inventory.md'), 'utf8');
  if (!/formula:\s*Quantity\s*\*\s*Price/i.test(schema))
    throw new Error('Inventory.md no longer has the Quantity * Price formula.');
}

async function waitFor(predicate, label, timeoutMs = WAIT_TIMEOUT_MS) {
  const until = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < until) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS));
  }
  const suffix = lastError ? `; last error: ${lastError?.message ?? lastError}` : '';
  throw new Error(`Timed out waiting for ${label}${suffix}`);
}

async function findWithin(driver, parentId, selector) {
  const value = elementIdValue(parentId);
  const elements = await driver.request('POST', driver.path(`/element/${value}/elements`), {
    using: 'css selector',
    value: selector,
  });
  return elements.map(elementId);
}

async function oneWithin(driver, parentId, selector, label) {
  const results = await findWithin(driver, parentId, selector);
  if (results.length !== 1) throw new Error(`Expected exactly one ${label}; found ${results.length}.`);
  return results[0];
}

function elementId(element) {
  const value = elementIdValue(element);
  if (typeof value !== 'string' || !value)
    throw new Error('WebDriver returned an element without a W3C element ID.');
  return value;
}

function elementIdValue(element) {
  if (typeof element === 'string') return element;
  return element?.[ELEMENT_KEY] ?? element?.ELEMENT ?? null;
}

async function clickWithin(driver, parentId, selector) {
  await clickElement(driver, await oneWithin(driver, parentId, selector, selector));
}

async function clickElement(driver, element) {
  await driver.request('POST', driver.path(`/element/${elementIdValue(element)}/click`), {});
}

async function sendKeysToElement(driver, element, text) {
  await driver.request('POST', driver.path(`/element/${elementIdValue(element)}/value`), {
    text,
    value: [...text],
  });
}

async function getAttribute(driver, element, name) {
  return driver.request(
    'GET',
    driver.path(`/element/${elementIdValue(element)}/attribute/${encodeURIComponent(name)}`),
  );
}

async function getPropertyValue(driver, element) {
  return driver.request('GET', driver.path(`/element/${elementIdValue(element)}/property/value`));
}
