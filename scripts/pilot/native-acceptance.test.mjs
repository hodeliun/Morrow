import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertNativeAcceptanceCombinationEvidence,
  buildNativeAcceptanceCombinationEvidence,
  isKeyboardActivationEvidence,
  isLanguageSectionReady,
  openLocalizedLanguageSelector,
  isHostInventoryDraftStatus,
  isLanguageSelectorSelectionRetained,
  isHostSavedStatus,
  LANGUAGE_SECTION_LABELS,
  measureNativeZoom,
  OWN_NATIVE_ACCEPTANCE_COMBINATIONS,
  zoomLevelForPercent,
} from './native-acceptance.mjs';

const BASELINE_ID = 'pt-light-100';

function viewport(overrides = {}) {
  return {
    innerWidth: 1280,
    innerHeight: 720,
    devicePixelRatio: 1,
    visualViewportWidth: 1280,
    visualViewportHeight: 720,
    visualViewportScale: 1,
    mainContentWidth: 960,
    storedZoomLevel: 0,
    ...overrides,
  };
}

function snapshots(quantity = 2) {
  return [
    { path: 'Inventory.md', sha256: 'a'.repeat(64), size: 100, mtimeMs: 1000, mode: 0o644, quantity: null },
    { path: 'Inventory/Widget.md', sha256: 'b'.repeat(64), size: 90, mtimeMs: 1001, mode: 0o644, quantity },
    { path: 'Views.md', sha256: 'c'.repeat(64), size: 80, mtimeMs: 1002, mode: 0o644, quantity: null },
  ];
}

function savedStatus(locale) {
  const text = { en: 'Saved', pt: 'Salvo', es: 'Guardado' }[locale];
  return {
    state: 'saved',
    source: 'host-topbar-save-indicator',
    text,
    classes: ['save-status'],
    pluginNoticeText: null,
  };
}

function savingStatus(locale) {
  const text = { en: 'Saving…', pt: 'Salvando…', es: 'Guardando…' }[locale];
  return {
    state: 'saving',
    source: 'host-topbar-save-indicator',
    text,
    classes: ['save-status', 'is-saving'],
    pluginNoticeText: null,
  };
}

function screenshot(file) {
  return { file, sha256: 'd'.repeat(64), size: 128, width: 1280, height: 720 };
}

function keyboardActivation({
  key = 'Enter',
  selector = '[data-action="cancel"]',
  label = 'Inventory Cancel button',
  accessibleName = 'Cancel',
  tagName = 'BUTTON',
  role = 'button',
  targetActiveAfter = false,
} = {}) {
  const observation = (rect) => ({
    route: '#/page/inventory',
    state: { settingsOpen: false, providerCount: 1, saveVisible: true, cancelVisible: true },
    rect,
    viewport: {
      innerWidth: 1280,
      innerHeight: 720,
      devicePixelRatio: 1,
      visualViewportWidth: 1280,
      visualViewportHeight: 720,
    },
  });
  return {
    method: 'webdriver-element-send-keys',
    key,
    label,
    target: {
      selector,
      tagName,
      role,
      accessibleName,
      focusable: true,
    },
    focus: {
      targetActiveBefore: false,
      activeElementBefore: { tagName: 'BODY', role: null, accessibleName: '' },
      targetActiveAfter,
      activeElementAfter: targetActiveAfter
        ? { tagName: 'BUTTON', role: 'button', accessibleName }
        : { tagName: 'BODY', role: null, accessibleName: '' },
    },
    before: observation({ x: 10, y: 20, width: 90, height: 30 }),
    after: observation(null),
  };
}

function navigation(pageId, beforeRoute) {
  return {
    method: 'public-location-hash-setup',
    pageId,
    beforeRoute,
    afterRoute: `#/page/${encodeURIComponent(pageId)}`,
    sidebarAcceptance: false,
  };
}

function buildItem(target, { zoom, omitReset = false, draftState = 'saved' } = {}) {
  const baseline = viewport();
  const observed = zoom?.observed ?? baseline;
  const measured =
    zoom ??
    measureNativeZoom({
      targetPercent: target.zoomPercent,
      baseline,
      observed,
      tolerancePixels: 2,
    });
  measured.baselineId = BASELINE_ID;
  measured.storage = {
    key: 'morrow.zoom',
    level: zoomLevelForPercent(target.zoomPercent),
    observedLevel: zoomLevelForPercent(target.zoomPercent),
    reload: 'webdriver-page-reload',
    reloadMethod: 'driver.refresh',
  };
  if (target.zoomPercent === 100 && !omitReset) {
    measured.reset = {
      method: 'webdriver-w3c-actions-control-0',
      status: target.id === BASELINE_ID ? 'baseline-established' : measured.status,
      baselineId: BASELINE_ID,
    };
  }

  const persisted = snapshots();
  const cancelActivation = keyboardActivation({
    accessibleName: { en: 'Cancel', pt: 'Cancelar', es: 'Cancelar' }[target.locale],
  });
  const draftStatus = {
    ...(draftState === 'saving' ? savingStatus(target.locale) : savedStatus(target.locale)),
    persistedQuantity: '2',
    draftLocal: true,
  };
  const idleStatus = { ...savedStatus(target.locale), persistedQuantity: '2', draftLocal: false };
  return buildNativeAcceptanceCombinationEvidence({
    combo: target,
    zoom: measured,
    runtime: { backendDataPathMatched: true, webviewDataPathMatched: true, pid: 123, startTimeTicks: '456' },
    ui: {
      localeOption: { en: 'English', pt: 'Português', es: 'Español' }[target.locale],
      settingsLabel: { en: 'Settings', pt: 'Configurações', es: 'Ajustes' }[target.locale],
      theme: target.theme,
      selectedTheme: {
        light: { en: 'Light', pt: 'Claro', es: 'Claro' },
        dark: { en: 'Dark', pt: 'Escuro', es: 'Oscuro' },
      }[target.theme][target.locale],
    },
    views: { providerCount: 2, roots: [{}, {}], hostStatus: savedStatus(target.locale) },
    inventory: {
      cancelVia: 'webdriver-keyboard-activation',
      cancelActivation,
      persistedQuantity: '2',
      draftQuantity: '3',
      draftLocal: true,
      saveVisible: true,
      cancelVisible: true,
      preDraftStatus: idleStatus,
      draftStatus,
      postCancelStatus: idleStatus,
      markdownBeforeCancel: persisted,
      markdownAfterCancel: snapshots(),
      markdownUnchanged: true,
    },
    fallback: {
      settingsClosed: true,
      overlayVisible: false,
      providerCount: 0,
      fallbackPresent: true,
      readOnly: true,
      pluginEnabled: false,
      hostStatus: savedStatus(target.locale),
    },
    screenshots: {
      views: screenshot(`${target.id}-views.png`),
      inventoryDraft: screenshot(`${target.id}-inventory-draft.png`),
      inventoryIdle: screenshot(`${target.id}-inventory-idle.png`),
      fallback: screenshot(`${target.id}-fallback.png`),
    },
    navigation: [
      navigation('Inventory', '#/home'),
      navigation('Views', '#/page/Inventory'),
      navigation('Inventory', '#/page/Views'),
    ],
    keyboardActivations: [cancelActivation],
  });
}

test('native acceptance uses the existing zoom scale and measures it within two pixels', () => {
  assert.equal(zoomLevelForPercent(100), 0);
  assert.ok(Math.abs(Math.pow(1.2, zoomLevelForPercent(125)) - 1.25) < 1e-12);
  assert.ok(Math.abs(Math.pow(1.2, zoomLevelForPercent(150)) - 1.5) < 1e-12);
  assert.throws(() => zoomLevelForPercent(110), /Unsupported/);

  const result = measureNativeZoom({
    targetPercent: 125,
    baseline: viewport(),
    observed: viewport({ innerWidth: 1025, visualViewportWidth: 1025, mainContentWidth: 769 }),
    tolerancePixels: 2,
  });
  assert.equal(result.status, 'verified');
  assert.equal(result.method, 'viewport-inner-width');
  assert.equal(result.errorPixels, 1);
});

test('native acceptance reports zoom gaps rather than assuming an unobservable factor', () => {
  const baseline = viewport();
  const result = measureNativeZoom({
    targetPercent: 150,
    baseline,
    observed: baseline,
    tolerancePixels: 2,
  });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.method, null);
  assert.ok(result.errorPixels > 2);
});

test('main content width cannot verify zoom when viewport and DPR contradict the requested factor', () => {
  const result = measureNativeZoom({
    targetPercent: 125,
    baseline: viewport(),
    observed: viewport({ mainContentWidth: 768 }),
    tolerancePixels: 2,
  });

  assert.equal(result.status, 'unsupported');
  assert.equal(result.method, null);
  assert.ok(
    result.measurements.some((item) => item.method === 'main-content-width' && item.errorPixels === 0),
  );
});

test('native acceptance distinguishes localized host Saved and Saving states without accepting errors', () => {
  const status = savedStatus('pt');
  assert.equal(isHostSavedStatus(status, 'pt'), true);
  assert.equal(isHostSavedStatus({ ...status, text: 'Alterações salvas.' }, 'pt'), false);
  assert.equal(isHostSavedStatus({ ...status, classes: ['save-status', 'is-saving'] }, 'pt'), false);
  assert.equal(isHostSavedStatus({ ...status, classes: ['save-status', 'is-error'] }, 'pt'), false);

  const saving = savingStatus('pt');
  assert.equal(isHostInventoryDraftStatus(saving, 'pt'), true);
  assert.equal(isHostInventoryDraftStatus({ ...saving, classes: ['save-status', 'is-error'] }, 'pt'), false);
  assert.equal(isHostInventoryDraftStatus({ ...saving, text: 'unknown' }, 'pt'), false);
  assert.equal(isHostInventoryDraftStatus(status, 'pt'), true);
});

test('the callback builder produces the item shape accepted by the real combination checker', () => {
  const target = OWN_NATIVE_ACCEPTANCE_COMBINATIONS[0];
  const baseline = viewport();
  const item = buildItem(target);
  assert.equal(assertNativeAcceptanceCombinationEvidence(item, target, 'own', baseline, BASELINE_ID), true);
});

test('native acceptance records real guarded keyboard activation and setup-only page routing', () => {
  const target = OWN_NATIVE_ACCEPTANCE_COMBINATIONS[0];
  const item = buildItem(target);
  assert.equal(isKeyboardActivationEvidence(item.inventory.cancelActivation), true);
  assert.equal(item.inventory.cancelVia, 'webdriver-keyboard-activation');
  assert.ok(item.navigation.every((entry) => entry.method === 'public-location-hash-setup'));
  assert.ok(item.navigation.every((entry) => entry.sidebarAcceptance === false));
  assert.equal(assertNativeAcceptanceCombinationEvidence(item, target, 'own', viewport(), BASELINE_ID), true);

  const unsafeActivation = keyboardActivation({});
  unsafeActivation.target.focusable = false;
  assert.equal(isKeyboardActivationEvidence(unsafeActivation), false);
  assert.throws(
    () =>
      assertNativeAcceptanceCombinationEvidence(
        {
          ...item,
          inventory: {
            ...item.inventory,
            cancelActivation: unsafeActivation,
          },
        },
        target,
        'own',
        viewport(),
        BASELINE_ID,
      ),
    /local draft and real Cancel contract/,
  );
  assert.throws(
    () =>
      assertNativeAcceptanceCombinationEvidence(
        { ...item, inventory: { ...item.inventory, cancelVia: 'webdriver-click' } },
        target,
        'own',
        viewport(),
        BASELINE_ID,
      ),
    /local draft and real Cancel contract/,
  );
});

test('confirming the current locale closes only its list and preserves Settings', () => {
  const state = {
    settingsOpen: true,
    localeControlPresent: true,
    listboxOpen: false,
    localeText: 'Português',
  };
  assert.equal(isLanguageSelectorSelectionRetained(state, 'Português'), true);
  assert.equal(isLanguageSelectorSelectionRetained({ ...state, settingsOpen: false }, 'Português'), false);
  assert.equal(isLanguageSelectorSelectionRetained({ ...state, listboxOpen: true }, 'Português'), false);
  assert.equal(isLanguageSelectorSelectionRetained({ ...state, localeText: 'English' }, 'Português'), false);
  const selectedOption = keyboardActivation({
    key: 'Space',
    selector: '[role="listbox"] [role="option"][aria-selected="true"]',
    label: 'Confirm currently selected language option',
    accessibleName: 'Português',
    role: 'option',
  });
  assert.equal(
    isKeyboardActivationEvidence(selectedOption, {
      key: 'Space',
      tagName: 'BUTTON',
      role: 'option',
      accessibleName: 'Português',
    }),
    true,
  );
  assert.equal(isKeyboardActivationEvidence(keyboardActivation({ key: 'Escape' })), false);
});

test('language section readiness is verified before the language selector receives keyboard input', async () => {
  const expectedLabel = 'Idioma e região';
  const languageSectionSelector = '.settings-dialog .settings-nav-item';
  const languageSelector = 'button.select-button[aria-label="Idioma"]';
  const calls = [];
  let sectionInspections = 0;
  let selectorInspections = 0;
  const readiness = {
    settingsOpen: true,
    activeSectionCount: 1,
    activeSectionAriaCurrent: 'page',
    activeSectionLabel: expectedLabel,
    sectionLabelMatches: true,
    languageSelectorCount: 1,
    languageSelectorVisible: true,
    languageSelectorEnabled: true,
  };
  const driver = {
    path: (value) => value,
    request: async (method, route, body) => {
      if (method === 'POST' && route.startsWith('/element/') && route.endsWith('/value')) {
        assert.deepEqual(body, { text: '\uE007', value: ['\uE007'] });
        calls.push(
          route.includes('language-section') ? 'webdriver-enter-section' : 'webdriver-enter-selector',
        );
        return {};
      }
      if (method === 'DELETE' && route === '/actions') {
        calls.push('release-actions');
        return {};
      }
      throw new Error(`Unexpected WebDriver request: ${method} ${route}`);
    },
    execute: async (_script, args = []) => {
      if (args[0] === languageSectionSelector) {
        sectionInspections += 1;
        calls.push(sectionInspections === 1 ? 'inspect-section-before' : 'inspect-section-after');
        return {
          count: 1,
          element: { 'element-6066-11e4-a52e-4f735466cecf': 'language-section' },
          descriptor: {
            tagName: 'BUTTON',
            role: 'button',
            accessibleName: expectedLabel,
            focusable: true,
            visible: true,
            rect: { x: 20, y: 30, width: 180, height: 32 },
          },
          focus: {
            targetActive: false,
            activeElement: { tagName: 'BODY', role: null, accessibleName: '' },
          },
          route: '#/home',
          state: {
            settingsOpen: true,
            settingsSection: sectionInspections === 1 ? 'Geral' : expectedLabel,
          },
          viewport: {
            innerWidth: 1280,
            innerHeight: 720,
            devicePixelRatio: 1,
            visualViewportWidth: 1280,
            visualViewportHeight: 720,
          },
        };
      }
      if (args[0] === languageSelector) {
        selectorInspections += 1;
        calls.push(selectorInspections === 1 ? 'inspect-selector-before' : 'inspect-selector-after');
        return {
          count: 1,
          element: { 'element-6066-11e4-a52e-4f735466cecf': 'language-control' },
          descriptor: {
            tagName: 'BUTTON',
            role: 'button',
            accessibleName: 'Idioma',
            focusable: true,
            visible: true,
            rect: { x: 180, y: 110, width: 220, height: 36 },
          },
          focus: {
            targetActive: false,
            activeElement: { tagName: 'BODY', role: null, accessibleName: '' },
          },
          route: '#/home',
          state: { settingsOpen: true, settingsSection: expectedLabel },
          viewport: {
            innerWidth: 1280,
            innerHeight: 720,
            devicePixelRatio: 1,
            visualViewportWidth: 1280,
            visualViewportHeight: 720,
          },
        };
      }
      if (args[0] === expectedLabel) {
        calls.push('check-section-readiness');
        return readiness;
      }
      throw new Error('Unexpected browser read in language section test.');
    },
  };

  assert.deepEqual(LANGUAGE_SECTION_LABELS, {
    en: 'Language and region',
    pt: 'Idioma e região',
    es: 'Idioma y región',
  });
  assert.notEqual(LANGUAGE_SECTION_LABELS.en, 'Language');
  assert.notEqual(LANGUAGE_SECTION_LABELS.pt, 'Idioma');
  assert.notEqual(LANGUAGE_SECTION_LABELS.es, 'Idioma');
  assert.deepEqual(calls, []);

  const result = await openLocalizedLanguageSelector(driver, 'pt');
  assert.deepEqual(calls, [
    'inspect-section-before',
    'webdriver-enter-section',
    'release-actions',
    'inspect-section-after',
    'check-section-readiness',
    'inspect-selector-before',
    'webdriver-enter-selector',
    'release-actions',
    'inspect-selector-after',
  ]);
  assert.equal(result.sectionActivation.key, 'Enter');
  assert.equal(result.sectionActivation.label, 'Language settings section');
  assert.equal(result.sectionActivation.before.state.settingsSection, 'Geral');
  assert.equal(result.sectionActivation.after.state.settingsSection, expectedLabel);
  assert.equal(result.selector, languageSelector);
  assert.equal(result.selectorActivation.key, 'Enter');
  assert.equal(result.selectorActivation.label, 'Language selector');
  assert.deepEqual(result.state, readiness);
  assert.equal(isLanguageSectionReady(result.state, expectedLabel), true);
  assert.equal(isKeyboardActivationEvidence(result.sectionActivation), true);
  assert.equal(isKeyboardActivationEvidence(result.selectorActivation), true);

  for (const invalid of [
    { ...readiness, settingsOpen: false },
    { ...readiness, activeSectionCount: 2 },
    { ...readiness, activeSectionAriaCurrent: null },
    { ...readiness, activeSectionLabel: 'Geral' },
    { ...readiness, sectionLabelMatches: false },
    { ...readiness, languageSelectorCount: 0 },
    { ...readiness, languageSelectorVisible: false },
    { ...readiness, languageSelectorEnabled: false },
  ]) {
    assert.equal(isLanguageSectionReady(invalid, expectedLabel), false);
  }
});

test('the real combination checker accepts either observed host Saved or Saving during the local draft', () => {
  const target = OWN_NATIVE_ACCEPTANCE_COMBINATIONS[0];
  const baseline = viewport();
  for (const draftState of ['saved', 'saving']) {
    const item = buildItem(target, { draftState });
    assert.equal(item.inventory.draftStatus.state, draftState);
    assert.equal(assertNativeAcceptanceCombinationEvidence(item, target, 'own', baseline, BASELINE_ID), true);
  }
});

test('the real combination checker rejects missing evidence and unsafe PNG filenames', () => {
  const target = OWN_NATIVE_ACCEPTANCE_COMBINATIONS[0];
  const baseline = viewport();
  const missing = buildItem(target);
  delete missing.views.hostStatus;
  assert.throws(
    () => assertNativeAcceptanceCombinationEvidence(missing, target, 'own', baseline, BASELINE_ID),
    /linked views with host Saved/,
  );

  const unsafe = buildItem(target);
  unsafe.screenshots.views.file = '../outside.png';
  assert.throws(
    () => assertNativeAcceptanceCombinationEvidence(unsafe, target, 'own', baseline, BASELINE_ID),
    /screenshot record/,
  );
});

test('the real combination checker rejects mismatched Markdown and 100% after 150% without Ctrl+0 reset', () => {
  const baseline = viewport();
  const target = OWN_NATIVE_ACCEPTANCE_COMBINATIONS[3];
  const mismatched = buildItem(OWN_NATIVE_ACCEPTANCE_COMBINATIONS[0]);
  mismatched.inventory.markdownAfterCancel[1].sha256 = 'f'.repeat(64);
  assert.throws(
    () =>
      assertNativeAcceptanceCombinationEvidence(
        mismatched,
        OWN_NATIVE_ACCEPTANCE_COMBINATIONS[0],
        'own',
        baseline,
        BASELINE_ID,
      ),
    /preserve all three Markdown/,
  );

  const stillAt150 = viewport({
    innerWidth: 853,
    devicePixelRatio: 1.5,
    visualViewportWidth: 853,
    mainContentWidth: 640,
    storedZoomLevel: zoomLevelForPercent(150),
  });
  const zoom = measureNativeZoom({ targetPercent: 100, baseline, observed: stillAt150, tolerancePixels: 2 });
  const noReset = buildItem(target, { zoom, omitReset: true });
  assert.equal(noReset.zoom.status, 'unsupported');
  assert.throws(
    () => assertNativeAcceptanceCombinationEvidence(noReset, target, 'own', baseline, BASELINE_ID),
    /real Ctrl\+0 reset/,
  );
});
