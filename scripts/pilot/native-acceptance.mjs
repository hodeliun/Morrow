import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { captureNativeCloseMarkdownFiles } from './native-close.mjs';
import { assertViewConfigs, decodeLinkedViewMarkers } from './native-functional.mjs';

export const NATIVE_ACCEPTANCE_RECEIPT_SCHEMA = 'morrow.e003.native-acceptance/v1';

export const OWN_NATIVE_ACCEPTANCE_COMBINATIONS = Object.freeze([
  { id: 'pt-light-100', locale: 'pt', theme: 'light', zoomPercent: 100 },
  { id: 'pt-dark-125', locale: 'pt', theme: 'dark', zoomPercent: 125 },
  { id: 'en-light-150', locale: 'en', theme: 'light', zoomPercent: 150 },
  { id: 'en-dark-100', locale: 'en', theme: 'dark', zoomPercent: 100 },
  { id: 'es-light-125', locale: 'es', theme: 'light', zoomPercent: 125 },
  { id: 'es-dark-150', locale: 'es', theme: 'dark', zoomPercent: 150 },
]);

export const INDEPENDENT_NATIVE_ACCEPTANCE_COMBINATIONS = Object.freeze([
  { id: 'pt-light-100', locale: 'pt', theme: 'light', zoomPercent: 100 },
  { id: 'en-light-150', locale: 'en', theme: 'light', zoomPercent: 150 },
  { id: 'es-dark-125', locale: 'es', theme: 'dark', zoomPercent: 125 },
]);

const VIEW_NODE = '.polaris-dados-view-node';
const PROVIDER = '[data-provider="polaris-dados"]';
const PAGE_PATHS = ['Inventory.md', 'Inventory/Widget.md', 'Views.md'];
const WAIT_TIMEOUT_MS = 25_000;
const WAIT_INTERVAL_MS = 100;
const ZOOM_OBSERVATION_TIMEOUT_MS = 5_000;
const BASELINE_COMBINATION_ID = 'pt-light-100';
const WEB_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
const WEBDRIVER_KEYS = Object.freeze({ Enter: '\uE007', Space: '\uE00D' });

const UI_LABELS = Object.freeze({
  en: {
    settings: 'Settings',
    language: 'Language',
    locale: 'English',
    plugins: 'Plugins',
    closeSettings: 'Close settings',
    save: 'Save',
    cancel: 'Cancel',
  },
  pt: {
    settings: 'Configurações',
    language: 'Idioma',
    locale: 'Português',
    plugins: 'Plugins',
    closeSettings: 'Fechar configurações',
    save: 'Salvar',
    cancel: 'Cancelar',
  },
  es: {
    settings: 'Ajustes',
    language: 'Idioma',
    locale: 'Español',
    plugins: 'Complementos',
    closeSettings: 'Cerrar ajustes',
    save: 'Guardar',
    cancel: 'Cancelar',
  },
});

const HOST_SAVED_LABELS = Object.freeze({ en: 'Saved', pt: 'Salvo', es: 'Guardado' });
const HOST_SAVING_LABELS = Object.freeze({ en: 'Saving…', pt: 'Salvando…', es: 'Guardando…' });

const THEME_LABELS = Object.freeze({
  en: { appearance: 'Appearance', theme: 'Theme', light: 'Light', dark: 'Dark' },
  pt: { appearance: 'Aparência', theme: 'Tema', light: 'Claro', dark: 'Escuro' },
  es: { appearance: 'Apariencia', theme: 'Tema', light: 'Claro', dark: 'Oscuro' },
});

const EXPECTED_COMBINATIONS = Object.freeze({
  own: OWN_NATIVE_ACCEPTANCE_COMBINATIONS,
  independent: INDEPENDENT_NATIVE_ACCEPTANCE_COMBINATIONS,
});

export function zoomLevelForPercent(percent) {
  if (![100, 125, 150].includes(percent)) {
    throw new Error(`Unsupported native acceptance zoom percentage: ${percent}`);
  }
  return percent === 100 ? 0 : Math.log(percent / 100) / Math.log(1.2);
}

export function measureNativeZoom({ targetPercent, baseline, observed, tolerancePixels = 2 }) {
  if (![100, 125, 150].includes(targetPercent)) {
    throw new Error(`Unsupported native acceptance zoom percentage: ${targetPercent}`);
  }
  if (!isViewportMetrics(baseline) || !isViewportMetrics(observed)) {
    return {
      status: 'unsupported',
      targetPercent,
      expectedFactor: targetPercent / 100,
      tolerancePixels,
      method: null,
      errorPixels: null,
      baseline,
      observed,
    };
  }

  const expectedFactor = targetPercent / 100;
  const candidates = [
    {
      method: 'viewport-inner-width',
      expected: baseline.innerWidth / expectedFactor,
      actual: observed.innerWidth,
    },
    {
      method: 'visual-viewport-width',
      expected: baseline.visualViewportWidth / expectedFactor,
      actual: observed.visualViewportWidth,
    },
    {
      method: 'main-content-width',
      expected: baseline.mainContentWidth / expectedFactor,
      actual: observed.mainContentWidth,
    },
    {
      method: 'device-pixel-ratio',
      expected: baseline.devicePixelRatio * expectedFactor,
      actual: observed.devicePixelRatio,
      pixelScale: baseline.innerWidth,
    },
  ].filter((candidate) => Number.isFinite(candidate.expected) && Number.isFinite(candidate.actual));

  const measured = candidates.map((candidate) => {
    const error = Math.abs(candidate.actual - candidate.expected);
    const errorPixels = error * (candidate.pixelScale ?? 1);
    return { ...candidate, errorPixels };
  });
  const zoomIndicators = measured.filter((candidate) => candidate.method !== 'main-content-width');
  const accepted = zoomIndicators.find((candidate) => candidate.errorPixels <= tolerancePixels);
  return {
    status: accepted ? 'verified' : 'unsupported',
    targetPercent,
    expectedFactor,
    tolerancePixels,
    method: accepted?.method ?? null,
    errorPixels:
      accepted?.errorPixels ?? Math.min(...zoomIndicators.map((candidate) => candidate.errorPixels)),
    measurements: measured.map(({ method, expected, actual, errorPixels }) => ({
      method,
      expected,
      actual,
      errorPixels,
    })),
    baseline,
    observed,
  };
}

export function buildNativeAcceptanceCombinationEvidence({
  combo,
  zoom,
  runtime,
  ui,
  views,
  inventory,
  fallback,
  screenshots,
  navigation,
  keyboardActivations,
}) {
  return {
    ...combo,
    zoom,
    runtime,
    ui,
    views,
    inventory,
    fallback,
    screenshots,
    navigation,
    keyboardActivations,
  };
}

export function isKeyboardActivationEvidence(evidence, expected = {}) {
  const validObservation = (observation) =>
    Boolean(
      observation &&
      typeof observation.route === 'string' &&
      observation.state &&
      typeof observation.state === 'object' &&
      observation.viewport &&
      Number.isFinite(observation.viewport.devicePixelRatio) &&
      observation.viewport.devicePixelRatio > 0 &&
      (observation.rect === null ||
        (observation.rect &&
          Number.isFinite(observation.rect.x) &&
          Number.isFinite(observation.rect.y) &&
          Number.isFinite(observation.rect.width) &&
          Number.isFinite(observation.rect.height) &&
          observation.rect.width > 0 &&
          observation.rect.height > 0)),
    );
  return Boolean(
    evidence?.method === 'webdriver-element-send-keys' &&
    ['Enter', 'Space'].includes(evidence.key) &&
    typeof evidence.label === 'string' &&
    evidence.target &&
    typeof evidence.target.selector === 'string' &&
    typeof evidence.target.tagName === 'string' &&
    typeof evidence.target.role === 'string' &&
    typeof evidence.target.accessibleName === 'string' &&
    evidence.target.focusable === true &&
    (expected.key === undefined || evidence.key === expected.key) &&
    (expected.tagName === undefined || evidence.target.tagName === expected.tagName) &&
    (expected.role === undefined || evidence.target.role === expected.role) &&
    (expected.accessibleName === undefined || evidence.target.accessibleName === expected.accessibleName) &&
    evidence.focus &&
    typeof evidence.focus.targetActiveBefore === 'boolean' &&
    typeof evidence.focus.targetActiveAfter === 'boolean' &&
    (evidence.focus.activeElementBefore === null || typeof evidence.focus.activeElementBefore === 'object') &&
    (evidence.focus.activeElementAfter === null || typeof evidence.focus.activeElementAfter === 'object') &&
    validObservation(evidence.before) &&
    validObservation(evidence.after),
  );
}

export function assertNativeAcceptanceCombinationEvidence(item, target, mode, baselineObserved, baselineId) {
  if (
    item?.id !== target.id ||
    item.locale !== target.locale ||
    item.theme !== target.theme ||
    item.zoomPercent !== target.zoomPercent
  ) {
    throw new Error(`Native acceptance ${target.id} differs from its fixed combination.`);
  }
  if (
    item.runtime?.backendDataPathMatched !== true ||
    item.runtime?.webviewDataPathMatched !== true ||
    !Number.isInteger(item.runtime?.pid) ||
    typeof item.runtime?.startTimeTicks !== 'string'
  ) {
    throw new Error(`Native acceptance ${target.id} is missing post-reload runtime identity evidence.`);
  }
  if (
    item.ui?.localeOption !== UI_LABELS[target.locale].locale ||
    item.ui?.settingsLabel !== UI_LABELS[target.locale].settings ||
    item.ui?.theme !== target.theme ||
    item.ui?.selectedTheme !== THEME_LABELS[target.locale][target.theme]
  ) {
    throw new Error(`Native acceptance ${target.id} did not prove the resolved locale and theme in the UI.`);
  }

  const expectedZoomLevel = zoomLevelForPercent(target.zoomPercent);
  if (
    item.zoom?.targetPercent !== target.zoomPercent ||
    !['verified', 'unsupported'].includes(item.zoom?.status) ||
    item.zoom?.storage?.key !== 'morrow.zoom' ||
    item.zoom.storage.level !== expectedZoomLevel ||
    (item.zoom.storage.observedLevel !== expectedZoomLevel && item.zoom.status === 'verified') ||
    item.zoom.storage.reload !== 'webdriver-page-reload' ||
    !['driver.refresh', 'driver.execute-window.location.reload'].includes(item.zoom.storage.reloadMethod) ||
    item.zoom.baselineId !== baselineId
  ) {
    throw new Error(`Native acceptance ${target.id} has no comparable zoom result against ${baselineId}.`);
  }
  if (item.zoom.status === 'verified') {
    if (
      !isViewportMetrics(item.zoom.baseline) ||
      !isViewportMetrics(item.zoom.observed) ||
      !isViewportMetrics(baselineObserved) ||
      measureNativeZoom({
        targetPercent: 100,
        baseline: baselineObserved,
        observed: item.zoom.baseline,
        tolerancePixels: 2,
      }).status !== 'verified' ||
      measureNativeZoom({
        targetPercent: target.zoomPercent,
        baseline: item.zoom.baseline,
        observed: item.zoom.observed,
        tolerancePixels: item.zoom.tolerancePixels,
      }).status !== 'verified'
    ) {
      throw new Error(
        `Native acceptance ${target.id} reported zoom verified without comparable measurements.`,
      );
    }
  }
  if (target.zoomPercent === 100) {
    const reset = item.zoom.reset;
    if (
      reset?.method !== 'webdriver-w3c-actions-control-0' ||
      reset.baselineId !== baselineId ||
      (item.id === baselineId && reset.status !== 'baseline-established') ||
      (item.id !== baselineId && !['verified', 'unsupported'].includes(reset.status)) ||
      (item.id !== baselineId && reset.status !== item.zoom.status)
    ) {
      throw new Error(
        `Native acceptance ${target.id} did not prove a real Ctrl+0 reset against ${baselineId}.`,
      );
    }
  }

  if (
    !item.screenshots ||
    !['views', 'inventoryDraft', 'fallback'].every((key) => validScreenshot(item.screenshots[key])) ||
    (mode === 'own' && !validScreenshot(item.screenshots.inventoryIdle)) ||
    Object.keys(item.screenshots).some(
      (key) => !['views', 'inventoryDraft', 'inventoryIdle', 'fallback'].includes(key),
    )
  ) {
    throw new Error(`Native acceptance ${target.id} is missing a required genuine screenshot record.`);
  }
  if (!validMarkdownSnapshotList(item.inventory?.markdownBeforeCancel)) {
    throw new Error(`Native acceptance ${target.id} is missing valid pre-Cancel Markdown snapshots.`);
  }
  if (
    !validMarkdownSnapshotList(item.inventory?.markdownAfterCancel) ||
    item.inventory.markdownUnchanged !== true ||
    !sameMarkdownSnapshotLists(item.inventory.markdownBeforeCancel, item.inventory.markdownAfterCancel)
  ) {
    throw new Error(
      `Native acceptance ${target.id} did not preserve all three Markdown files through Cancel.`,
    );
  }
  if (
    !item.views ||
    item.views.providerCount !== 2 ||
    item.views.roots?.length !== 2 ||
    !isHostSavedStatus(item.views.hostStatus, target.locale)
  ) {
    throw new Error(
      `Native acceptance ${target.id} did not prove two linked views with host Saved before capture.`,
    );
  }
  if (
    !item.inventory ||
    item.inventory.cancelVia !== 'webdriver-keyboard-activation' ||
    !isKeyboardActivationEvidence(item.inventory.cancelActivation, {
      key: 'Enter',
      tagName: 'BUTTON',
      role: 'button',
      accessibleName: UI_LABELS[target.locale].cancel,
    }) ||
    item.inventory.persistedQuantity !== '2' ||
    item.inventory.draftQuantity !== '3' ||
    item.inventory.draftLocal !== true ||
    item.inventory.saveVisible !== true ||
    item.inventory.cancelVisible !== true ||
    !isHostSavedStatus(item.inventory.preDraftStatus, target.locale) ||
    !isHostInventoryDraftStatus(item.inventory.draftStatus, target.locale) ||
    !isHostSavedStatus(item.inventory.postCancelStatus, target.locale) ||
    item.inventory.preDraftStatus?.persistedQuantity !== '2' ||
    item.inventory.draftStatus?.draftLocal !== true ||
    item.inventory.draftStatus?.persistedQuantity !== '2' ||
    item.inventory.postCancelStatus?.persistedQuantity !== '2'
  ) {
    throw new Error(
      `Native acceptance ${target.id} did not record the local draft and real Cancel contract.`,
    );
  }
  if (
    !Array.isArray(item.navigation) ||
    item.navigation.length !== 3 ||
    item.navigation.some(
      (entry) =>
        entry?.method !== 'public-location-hash-setup' ||
        entry.sidebarAcceptance !== false ||
        typeof entry.pageId !== 'string' ||
        typeof entry.beforeRoute !== 'string' ||
        typeof entry.afterRoute !== 'string' ||
        !entry.afterRoute.includes(`/page/${encodeURIComponent(entry.pageId)}`),
    ) ||
    !Array.isArray(item.keyboardActivations) ||
    item.keyboardActivations.length === 0 ||
    item.keyboardActivations.some((entry) => !isKeyboardActivationEvidence(entry))
  ) {
    throw new Error(
      `Native acceptance ${target.id} is missing safe navigation and keyboard activation evidence.`,
    );
  }
  if (
    !item.fallback ||
    item.fallback.settingsClosed !== true ||
    item.fallback.overlayVisible !== false ||
    item.fallback.providerCount !== 0 ||
    item.fallback.fallbackPresent !== true ||
    item.fallback.readOnly !== true ||
    item.fallback.pluginEnabled !== false ||
    !isHostSavedStatus(item.fallback.hostStatus, target.locale)
  ) {
    throw new Error(`Native acceptance ${target.id} did not prove the closed-settings read-only fallback.`);
  }
  return true;
}

export function assertNativeAcceptanceReceipt(receipt, mode) {
  if (!Object.hasOwn(EXPECTED_COMBINATIONS, mode)) throw new Error(`Unknown native acceptance mode: ${mode}`);
  if (receipt?.schema !== NATIVE_ACCEPTANCE_RECEIPT_SCHEMA || receipt.mode !== mode) {
    throw new Error(
      `Native acceptance receipt has the wrong schema or mode: ${JSON.stringify({ schema: receipt?.schema, mode: receipt?.mode })}`,
    );
  }
  const expected = EXPECTED_COMBINATIONS[mode];
  if (!Array.isArray(receipt.combinations) || receipt.combinations.length !== expected.length) {
    throw new Error(`Native acceptance ${mode} must contain ${expected.length} combinations.`);
  }
  if (expected[0].zoomPercent !== 100 || receipt.combinations[0]?.zoomPercent !== 100) {
    throw new Error(`Native acceptance ${mode} must establish its 100% baseline in the first combination.`);
  }
  const baselineId = expected[0].id;
  const baselineObserved = receipt.combinations[0]?.zoom?.observed;
  const screenshotNames = [];
  for (let index = 0; index < expected.length; index += 1) {
    const item = receipt.combinations[index];
    assertNativeAcceptanceCombinationEvidence(item, expected[index], mode, baselineObserved, baselineId);
    screenshotNames.push(
      ...Object.values(item.screenshots)
        .filter(Boolean)
        .map((screenshot) => screenshot.file),
    );
  }
  if (new Set(screenshotNames).size !== screenshotNames.length) {
    throw new Error(`Native acceptance ${mode} reuses screenshot filenames.`);
  }
  if (receipt.screenshotCount < expected.length * 3 || receipt.screenshotCount !== screenshotNames.length) {
    throw new Error(
      `Native acceptance ${mode} screenshot count is below the matrix minimum or does not match its records.`,
    );
  }
  const zoomGaps = receipt.combinations
    .filter((item) => item.zoom.status !== 'verified')
    .map((item) => item.id);
  if (
    zoomGaps.length > 0 &&
    (receipt.accepted === true || !zoomGaps.every((id) => receipt.zoomGaps?.some((gap) => gap?.id === id)))
  ) {
    throw new Error(
      `Native acceptance ${mode} must report every unverified zoom as a gap and remain unaccepted.`,
    );
  }
  return {
    schema: receipt.schema,
    mode,
    combinations: expected.length,
    screenshots: screenshotNames.length,
    accepted: receipt.accepted === true,
    zoomGaps: Array.isArray(receipt.zoomGaps) ? receipt.zoomGaps.length : 0,
  };
}

export async function runNativeAcceptanceScenario(context) {
  const { candidate, prepared, recordStep } = context ?? {};
  if (!candidate?.vault || !candidate?.databaseId || !candidate?.evidence || !prepared?.bankBefore) {
    throw new Error('Native acceptance requires the isolated candidate and prepared synthetic vault.');
  }
  if (typeof recordStep !== 'function')
    throw new Error('Native acceptance requires the runner evidence callback.');
  if (candidate.scenario !== 'acceptance' && candidate.scenario !== 'acceptance-independent') {
    throw new Error('Native acceptance only runs through its fixed scenario entry.');
  }

  const mode = candidate.scenario === 'acceptance-independent' ? 'independent' : 'own';
  const combinations = EXPECTED_COMBINATIONS[mode];
  const expectedViews = candidate.linkedViews?.origin;
  if (!Array.isArray(expectedViews) || expectedViews.length !== 2) {
    throw new Error('The synthetic origin must provide exactly two linked view configurations.');
  }
  if (expectedViews.some((view) => view.sourceDatabaseId !== candidate.databaseId)) {
    throw new Error('Both linked views must reference the synthetic Inventory database.');
  }

  const pageIds = await readSyntheticPageIds(candidate.vault);
  const note = await readFile(path.join(candidate.vault, 'Views.md'), 'utf8');
  const persistedConfigs = decodeLinkedViewMarkers(note);
  assertViewConfigs(persistedConfigs, expectedViews, 'native acceptance fixture');
  const startIdentity = await assertCurrentIdentity(context, null, 'before the first acceptance interaction');
  let baselineViewport = null;
  const results = [];
  const zoomGaps = [];

  for (let index = 0; index < combinations.length; index += 1) {
    const combo = combinations[index];
    await setProfilePreferences(context, combo);
    const runtime = await refreshAndRevalidate(context, startIdentity, combo.id);
    const navigation = [await openPage(context, pageIds.inventory, 'Inventory source')];
    if (combo.zoomPercent === 100) await resetZoomToDefault(context.driver);
    const viewport =
      baselineViewport === null
        ? await readStableViewport(context.driver)
        : await waitForZoomViewport(context.driver, combo.zoomPercent, baselineViewport);
    if (combo.zoomPercent === 100 && baselineViewport === null) baselineViewport = viewport;
    if (!baselineViewport) throw new Error(`No 100% viewport baseline exists before ${combo.id}.`);
    const zoom = measureNativeZoom({
      targetPercent: combo.zoomPercent,
      baseline: baselineViewport,
      observed: viewport,
      tolerancePixels: 2,
    });
    const expectedZoomLevel = zoomLevelForPercent(combo.zoomPercent);
    const storageLevelMatched = viewport.storedZoomLevel === expectedZoomLevel;
    if (!storageLevelMatched) zoom.status = 'unsupported';
    zoom.baselineId = BASELINE_COMBINATION_ID;
    if (combo.zoomPercent === 100) {
      zoom.reset = {
        method: 'webdriver-w3c-actions-control-0',
        status: combo.id === BASELINE_COMBINATION_ID ? 'baseline-established' : zoom.status,
        baselineId: BASELINE_COMBINATION_ID,
      };
    }
    zoom.storage = {
      key: 'morrow.zoom',
      level: expectedZoomLevel,
      observedLevel: viewport.storedZoomLevel,
      reload: 'webdriver-page-reload',
      reloadMethod: 'driver.refresh',
      setup: 'profile-localStorage-before-refresh; existing Tauri startup zoom path',
    };
    if (zoom.status !== 'verified') zoomGaps.push({ id: combo.id, observation: zoom });

    const ui = await inspectLocalizedPreferences(context, combo);
    const views = await captureViews(context, pageIds.views, expectedViews, pageIds.row, combo.locale);
    navigation.push(views.navigation);
    const viewScreenshot = await captureScreenshot(
      context.driver,
      candidate.evidence,
      `native-acceptance-${combo.id}-views.png`,
    );
    const inventoryCapture = await captureInventoryDraft(context, combo);
    navigation.push(inventoryCapture.navigation);
    const inventory = inventoryCapture.inventory;
    const fallback = await captureReadOnlyFallback(context, combo);
    const fallbackScreenshot = await captureScreenshot(
      context.driver,
      candidate.evidence,
      `native-acceptance-${combo.id}-fallback.png`,
    );
    const reenablePluginActivations = await setVaultPluginEnabled(context, true, combo);
    const keyboardActivations = [
      ...ui.keyboardActivations,
      inventory.editActivation,
      inventory.cancelActivation,
      ...fallback.keyboardActivations,
      ...reenablePluginActivations,
    ];

    const result = buildNativeAcceptanceCombinationEvidence({
      combo,
      zoom,
      runtime,
      ui,
      views,
      inventory,
      fallback,
      navigation,
      keyboardActivations,
      screenshots: {
        views: viewScreenshot,
        inventoryDraft: inventoryCapture.screenshots.draft,
        inventoryIdle: inventoryCapture.screenshots.idle,
        fallback: fallbackScreenshot,
      },
    });
    results.push(result);
    await recordStep(`native-acceptance-${combo.id}-captured`, {
      zoom: zoom.status,
      views: { providerCount: views.providerCount, roots: views.roots.length },
      inventory: {
        persistedQuantity: inventory.persistedQuantity,
        draftQuantity: inventory.draftQuantity,
        markdownUnchanged: inventory.markdownUnchanged,
      },
      fallback: { providerCount: fallback.providerCount, readOnly: fallback.readOnly },
      screenshots: Object.values(result.screenshots).map((item) => item.file),
    });
  }

  const receipt = {
    schema: NATIVE_ACCEPTANCE_RECEIPT_SCHEMA,
    mode,
    createdAt: new Date().toISOString(),
    startIdentity,
    combinations: results,
    screenshotCount: results.reduce((count, item) => count + Object.keys(item.screenshots).length, 0),
    zoomGaps,
    accepted: zoomGaps.length === 0,
  };
  const summary = assertNativeAcceptanceReceipt(receipt, mode);
  await recordStep(`native-acceptance-${mode}-receipt-ready`, summary);
  return receipt;
}

async function setProfilePreferences(context, combo) {
  await assertCurrentIdentity(context, null, `before profile setup for ${combo.id}`);
  const level = zoomLevelForPercent(combo.zoomPercent);
  const setup = await context.driver.execute(
    `
      const preferences = JSON.parse(localStorage.getItem('morrow.preferences') || '{}');
      preferences.locale = arguments[0];
      preferences.theme = arguments[1];
      localStorage.setItem('morrow.preferences', JSON.stringify(preferences));
      localStorage.setItem('morrow.zoom', String(arguments[2]));
      return {
        locale: preferences.locale,
        theme: preferences.theme,
        zoom: Number(localStorage.getItem('morrow.zoom')),
      };
    `,
    [combo.locale, combo.theme, level],
  );
  if (setup.locale !== combo.locale || setup.theme !== combo.theme || setup.zoom !== level) {
    throw new Error(`Synthetic profile setup did not retain the requested preferences for ${combo.id}.`);
  }
}

async function refreshAndRevalidate(context, expectedIdentity, comboId) {
  await context.beginRuntimeRefresh();
  await context.driver.refresh();
  const runtime = await context.verifyRuntimeIdentity();
  const paths = assertRuntimePaths(context, runtime, `after profile reload for ${comboId}`);
  const currentIdentity = await context.readOwnedAppIdentity();
  assertSameAppIdentity(expectedIdentity, currentIdentity, `after profile reload for ${comboId}`);
  const app = await waitFor(
    `known Morrow UI after reload for ${comboId}`,
    () => context.driver.execute('return Boolean(document.querySelector(".app > main.main"));'),
    Boolean,
  );
  if (!app) throw new Error(`Morrow UI did not return after profile reload for ${comboId}.`);
  return {
    ...paths,
    pid: currentIdentity.pid,
    startTimeTicks: currentIdentity.startTimeTicks,
  };
}

async function assertCurrentIdentity(context, expectedIdentity, label) {
  const runtime = await context.verifyRuntimeIdentity();
  const paths = assertRuntimePaths(context, runtime, label);
  const currentIdentity = await context.readOwnedAppIdentity();
  assertSameAppIdentity(expectedIdentity ?? context.ownedAppIdentity, currentIdentity, label);
  return {
    pid: currentIdentity.pid,
    startTimeTicks: currentIdentity.startTimeTicks,
    driverPid: currentIdentity.driverPid,
    ...paths,
  };
}

function assertRuntimePaths(context, runtime, label) {
  const backendDataPathMatched = runtime?.dataPath === context.candidate.expectedBackendDataPath;
  const webviewDataPathMatched = runtime?.webviewDataPath === context.candidate.expectedWebviewDataPath;
  if (!backendDataPathMatched) throw new Error(`Synthetic backend dataPath was not confirmed ${label}.`);
  if (!webviewDataPathMatched) throw new Error(`Synthetic WebView profile path was not confirmed ${label}.`);
  return { backendDataPathMatched, webviewDataPathMatched };
}

function assertSameAppIdentity(expected, actual, label) {
  if (
    !expected ||
    !actual ||
    expected.pid !== actual.pid ||
    expected.startTimeTicks !== actual.startTimeTicks ||
    expected.driverPid !== actual.driverPid
  ) {
    throw new Error(`Owned Morrow PID/starttime/driver identity changed ${label}.`);
  }
  if (actual.runtimeIdentityConfirmed !== true)
    throw new Error(`Owned Morrow runtime identity is unconfirmed ${label}.`);
}

async function inspectLocalizedPreferences(context, combo) {
  const labels = UI_LABELS[combo.locale];
  const themeLabels = THEME_LABELS[combo.locale];
  const keyboardActivations = [];
  const theme = await waitFor(
    `resolved DOM theme for ${combo.id}`,
    () => context.driver.execute('return document.documentElement.dataset.theme ?? null;'),
    (value) => value === combo.theme,
  );

  const settingsActivation = await openSettings(context.driver, combo.locale);
  if (settingsActivation) keyboardActivations.push(settingsActivation);
  const languageSelector = `button.select-button[aria-label="${labels.language}"]`;
  await waitFor(
    `localized language preference control for ${combo.id}`,
    () =>
      context.driver.execute(`return Boolean(document.querySelector(${JSON.stringify(languageSelector)}));`),
    Boolean,
  );
  keyboardActivations.push(
    await activateByKeyboard(context.driver, languageSelector, {
      key: 'Enter',
      label: 'Language selector',
    }),
  );
  const selectedLocale = await waitFor(
    `selected locale option for ${combo.id}`,
    () =>
      context.driver.execute(`
      const selected = [...document.querySelectorAll('[role="listbox"] [role="option"][aria-selected="true"]')];
      return selected.length === 1 ? selected[0].textContent.trim() : null;
    `),
    (value) => value !== null,
  );
  const expectedLocale = labels.locale;
  if (selectedLocale !== expectedLocale)
    throw new Error(`Settings shows locale ${selectedLocale}; expected ${expectedLocale} for ${combo.id}.`);
  keyboardActivations.push(
    await activateByKeyboard(context.driver, '[role="listbox"] [role="option"][aria-selected="true"]', {
      key: 'Space',
      label: 'Confirm currently selected language option',
    }),
  );
  const languageSelectionState = await waitFor(
    `selected locale retained and only its list closed for ${combo.id}`,
    () =>
      context.driver.execute(`
        const control = document.querySelector(${JSON.stringify(languageSelector)});
        return {
          settingsOpen: Boolean(document.querySelector('.settings-dialog')),
          localeControlPresent: control !== null,
          localeText: control?.querySelector('span')?.textContent?.trim() ?? null,
          listboxOpen: document.querySelector('[role="listbox"]') !== null,
        };
      `),
    (state) => isLanguageSelectorSelectionRetained(state, expectedLocale),
  );
  if (!isLanguageSelectorSelectionRetained(languageSelectionState, expectedLocale)) {
    throw new Error(
      `Confirming the current locale did not close only the language list in Settings for ${combo.id}.`,
    );
  }
  const settingsLabel = await context.driver.execute(
    `
    const labels = [...document.querySelectorAll('.sidebar-footer .nav-item .nav-label')].map((item) => item.textContent.trim());
    return labels.includes(arguments[0]) ? arguments[0] : null;
  `,
    [labels.settings],
  );
  if (settingsLabel !== labels.settings)
    throw new Error(`Resolved Settings label is not localized for ${combo.id}.`);
  keyboardActivations.push(
    await activateUniqueByText(
      context.driver,
      '.settings-dialog .settings-nav-item',
      null,
      themeLabels.appearance,
      'Appearance settings section',
    ),
  );
  const selectedTheme = await context.driver.execute(
    `
    const groups = [...document.querySelectorAll('.settings-dialog [role="radiogroup"]')]
      .filter((item) => item.getAttribute('aria-label') === arguments[0]);
    return groups.length === 1
      ? groups[0].querySelector('[role="radio"][aria-checked="true"]')?.textContent?.trim() ?? null
      : null;
  `,
    [themeLabels.theme],
  );
  if (selectedTheme !== themeLabels[combo.theme]) {
    throw new Error(
      `Settings shows theme ${selectedTheme}; expected ${themeLabels[combo.theme]} for ${combo.id}.`,
    );
  }
  keyboardActivations.push(await closeSettings(context.driver, combo.locale));

  return {
    documentLanguage: await context.driver.execute('return document.documentElement.lang ?? null;'),
    localeOption: selectedLocale,
    settingsLabel,
    theme,
    themeLabel: themeLabels.theme,
    selectedTheme,
    keyboardActivations,
  };
}

async function captureViews(context, pageId, expectedViews, expectedRowId, locale) {
  const navigation = await openPage(context, pageId, 'Views.md');
  const state = await waitFor(
    'two linked view roots on Views.md',
    () => readViewsDom(context.driver),
    (value) => value.providerCount === 2 && value.views.length === 2,
  );
  const roots = state.views.map((view, index) => {
    const expected = expectedViews[index];
    if (view.rootCount !== 1 || view.title !== expected.title) {
      throw new Error(`Linked view ${index} root/title differs from its synthetic configuration.`);
    }
    const positions = expected.columnOrder.map((column) =>
      view.columnKeys.findIndex((key) => key === `property:"${column}"` || key === `property:${column}`),
    );
    if (
      positions.some((position) => position < 0) ||
      positions.some((position, at) => at > 0 && position <= positions[at - 1])
    ) {
      throw new Error(
        `Linked view ${index} column order does not reflect its own config: ${JSON.stringify(view.columnKeys)}.`,
      );
    }
    const visible =
      expected.filter.propertyId === 'quantity' && expected.filter.op === 'gte'
        ? Number(expected.filter.value) <= 2
        : true;
    if (view.rows.length !== (visible ? 1 : 0)) {
      throw new Error(`Linked view ${index} row projection does not reflect its filter.`);
    }
    if (visible && view.rows[0]?.id !== expectedRowId) {
      throw new Error(`Linked view ${index} did not render the synthetic Widget row.`);
    }
    return {
      viewId: expected.viewId,
      sourceDatabaseId: expected.sourceDatabaseId,
      title: expected.title,
      columnOrder: expected.columnOrder,
      filter: expected.filter,
      rootCount: view.rootCount,
      columnKeys: view.columnKeys,
      visibleRowIds: view.rows.map((row) => row.id),
    };
  });
  const hostStatus = await waitForHostSaved(context.driver, locale, 'before Views screenshot');
  return { providerCount: state.providerCount, roots, hostStatus, navigation };
}

async function readViewsDom(driver) {
  return driver.execute(`
    const wrappers = [...document.querySelectorAll('${VIEW_NODE}')];
    const views = wrappers.map((wrapper) => {
      const roots = [...wrapper.querySelectorAll('${PROVIDER}')];
      const root = roots.length === 1 ? roots[0] : null;
      const table = root?.querySelector('table') ?? null;
      const rows = [...(table?.querySelectorAll('tbody tr') ?? [])].map((row) => ({
        id: row.dataset.rowId ?? null,
        quantity: row.querySelector('[data-property-id="quantity"]')?.textContent?.trim() ?? null,
      }));
      return {
        rootCount: roots.length,
        title: root?.querySelector('[data-view-toolbar] [data-view-title]')?.textContent?.trim() ?? null,
        columnKeys: [...(table?.querySelectorAll('thead th') ?? [])].map((item) => item.dataset.columnKey ?? item.dataset.columnId ?? null),
        rows,
      };
    });
    return { providerCount: document.querySelectorAll('${PROVIDER}').length, views };
  `);
}

async function captureInventoryDraft(context, combo) {
  const navigation = await openPage(context, context.candidate.databaseId, 'Inventory.md');
  const labels = UI_LABELS[combo.locale];
  const savedLabel = HOST_SAVED_LABELS[combo.locale];
  const initial = await waitFor(
    `host TopBar Saved indicator (.save-status/.save-label; ${savedLabel}, without is-saving/is-error) before ${combo.id}`,
    () => readInventoryDom(context.driver),
    (state) =>
      state.providerCount === 1 &&
      state.quantity === '2' &&
      classifyPersistedStatus(state, savedLabel) === 'saved',
  );
  const markdownBeforeCancel = await captureNativeCloseMarkdownFiles(context.candidate.vault);
  const editSelector = `${PROVIDER} button[data-action="edit"][data-field="quantity"]`;
  const editActivation = await activateByKeyboard(context.driver, editSelector, {
    key: 'Enter',
    label: 'Quantity edit button',
  });
  await waitFor(
    `local Quantity editor for ${combo.id}`,
    () =>
      context.driver.execute(
        `return Boolean(document.querySelector('${PROVIDER} input[data-field="quantity"]'));`,
      ),
    Boolean,
  );
  const inputSelector = `${PROVIDER} input[data-field="quantity"]`;
  await context.driver.clear(inputSelector);
  await context.driver.sendKeys(inputSelector, '3');
  const draft = await waitFor(
    `local Quantity draft and Save/Cancel controls for ${combo.id}`,
    () => readInventoryDom(context.driver),
    (state) =>
      state.providerCount === 1 &&
      state.inputValue === '3' &&
      state.saveVisible &&
      state.cancelVisible &&
      state.saveText === labels.save &&
      state.cancelText === labels.cancel &&
      classifyInventoryHostStatus(state, combo.locale) !== null,
  );
  await assertMarkdownSnapshotsEqual(
    markdownBeforeCancel,
    await captureNativeCloseMarkdownFiles(context.candidate.vault),
    `local draft ${combo.id}`,
  );
  const draftScreenshot = await captureScreenshot(
    context.driver,
    context.candidate.evidence,
    `native-acceptance-${combo.id}-inventory-draft.png`,
  );
  const cancelActivation = await activateByKeyboard(
    context.driver,
    `${PROVIDER} button[data-action="cancel"]`,
    { key: 'Enter', label: 'Inventory Cancel button' },
  );
  const afterCancel = await waitFor(
    `W3C Cancel restores persisted Quantity and host Saved/idle for ${combo.id}`,
    () => readInventoryDom(context.driver),
    (state) =>
      state.providerCount === 1 &&
      state.quantity === '2' &&
      state.saveVisible === false &&
      state.cancelVisible === false &&
      classifyPersistedStatus(state, savedLabel) === 'saved',
  );
  const markdownAfterCancel = await captureNativeCloseMarkdownFiles(context.candidate.vault);
  await assertMarkdownSnapshotsEqual(markdownBeforeCancel, markdownAfterCancel, `Cancel ${combo.id}`);
  const idleScreenshot = await captureScreenshot(
    context.driver,
    context.candidate.evidence,
    `native-acceptance-${combo.id}-inventory-idle.png`,
  );
  return {
    inventory: {
      preDraftStatus: persistedStatusEvidence(initial, combo.locale, initial.quantity, false),
      persistedQuantity: '2',
      draftQuantity: draft.inputValue,
      draftLocal: true,
      draftStatus: persistedStatusEvidence(draft, combo.locale, '2', true),
      saveVisible: draft.saveVisible,
      cancelVisible: draft.cancelVisible,
      saveText: draft.saveText,
      cancelText: draft.cancelText,
      cancelVia: 'webdriver-keyboard-activation',
      editActivation,
      cancelActivation,
      postCancelStatus: persistedStatusEvidence(afterCancel, combo.locale, afterCancel.quantity, false),
      markdownBeforeCancel: snapshotList(markdownBeforeCancel),
      markdownAfterCancel: snapshotList(markdownAfterCancel),
      markdownUnchanged: true,
    },
    screenshots: { draft: draftScreenshot, idle: idleScreenshot },
    navigation,
  };
}

async function readInventoryDom(driver) {
  return driver.execute(`
    const roots = [...document.querySelectorAll('${PROVIDER}')];
    const root = roots.length === 1 ? roots[0] : null;
    const quantityInput = root?.querySelector('input[data-field="quantity"]');
    const quantityButton = root?.querySelector('button[data-action="edit"][data-field="quantity"]');
    const hostIndicators = [...document.querySelectorAll('.save-status')]
      .filter((item) => item.querySelector('.save-label'));
    const hostIndicator = hostIndicators.length === 1 ? hostIndicators[0] : null;
    const pluginNotice = root?.querySelector('[role="status"]');
    const save = root?.querySelector('button[data-action="save"]');
    const cancel = root?.querySelector('button[data-action="cancel"]');
    return {
      providerCount: roots.length,
      quantity: quantityButton?.textContent?.trim() ?? null,
      inputValue: quantityInput?.value ?? null,
      hostIndicatorCount: hostIndicators.length,
      hostSaveLabel: hostIndicator?.querySelector('.save-label')?.textContent?.trim() ?? null,
      hostSaveClasses: hostIndicator ? [...hostIndicator.classList] : [],
      pluginNoticeText: pluginNotice?.textContent?.trim() ?? null,
      saveVisible: Boolean(save && save.getClientRects().length > 0),
      cancelVisible: Boolean(cancel && cancel.getClientRects().length > 0),
      saveText: save?.textContent?.trim() ?? null,
      cancelText: cancel?.textContent?.trim() ?? null,
    };
  `);
}

async function waitForHostSaved(driver, locale, stage) {
  const expectedLabel = HOST_SAVED_LABELS[locale];
  const state = await waitFor(
    `host TopBar Saved indicator (.save-status/.save-label; ${expectedLabel}, without is-saving/is-error) ${stage}`,
    () =>
      driver.execute(`
        const indicators = [...document.querySelectorAll('.save-status')]
          .filter((item) => item.querySelector('.save-label'));
        const indicator = indicators.length === 1 ? indicators[0] : null;
        const notices = [...document.querySelectorAll('${PROVIDER} [role="status"]')]
          .map((item) => item.textContent?.trim() ?? '')
          .filter(Boolean);
        return {
          count: indicators.length,
          label: indicator?.querySelector('.save-label')?.textContent?.trim() ?? null,
          classes: indicator ? [...indicator.classList] : [],
          pluginNoticeText: notices.length ? notices.join(' | ') : null,
        };
      `),
    (value) =>
      value?.count === 1 &&
      value.label === expectedLabel &&
      !value.classes.includes('is-saving') &&
      !value.classes.includes('is-error'),
  );
  return {
    state: 'saved',
    source: 'host-topbar-save-indicator',
    text: state.label,
    classes: state.classes,
    pluginNoticeText: state.pluginNoticeText,
  };
}

function classifyPersistedStatus(state, savedText) {
  if (
    state.hostIndicatorCount === 1 &&
    state.hostSaveLabel === savedText &&
    !state.hostSaveClasses.includes('is-saving') &&
    !state.hostSaveClasses.includes('is-error')
  ) {
    return 'saved';
  }
  return null;
}

function persistedStatusEvidence(state, locale, persistedQuantity, draftLocal) {
  return {
    state: draftLocal
      ? classifyInventoryHostStatus(state, locale)
      : classifyPersistedStatus(state, HOST_SAVED_LABELS[locale]),
    source: 'host-topbar-save-indicator',
    text: state.hostSaveLabel,
    classes: state.hostSaveClasses,
    pluginNoticeText: state.pluginNoticeText,
    persistedQuantity,
    draftLocal,
    scope: draftLocal ? 'persisted baseline; visible Quantity draft is local only' : 'persisted baseline',
  };
}

export function isHostSavedStatus(status, locale) {
  return Boolean(
    status?.state === 'saved' &&
    status.source === 'host-topbar-save-indicator' &&
    status.text === HOST_SAVED_LABELS[locale] &&
    Array.isArray(status.classes) &&
    !status.classes.includes('is-saving') &&
    !status.classes.includes('is-error'),
  );
}

export function isHostInventoryDraftStatus(status, locale) {
  return (
    isHostSavedStatus(status, locale) ||
    Boolean(
      status?.state === 'saving' &&
      status.source === 'host-topbar-save-indicator' &&
      status.text === HOST_SAVING_LABELS[locale] &&
      Array.isArray(status.classes) &&
      status.classes.includes('is-saving') &&
      !status.classes.includes('is-error'),
    )
  );
}

export function isLanguageSelectorSelectionRetained(state, expectedLocale) {
  return Boolean(
    state?.settingsOpen === true &&
    state.localeControlPresent === true &&
    state.listboxOpen === false &&
    state.localeText === expectedLocale,
  );
}

function classifyInventoryHostStatus(state, locale) {
  if (classifyPersistedStatus(state, HOST_SAVED_LABELS[locale]) === 'saved') return 'saved';
  if (
    state.hostIndicatorCount === 1 &&
    state.hostSaveLabel === HOST_SAVING_LABELS[locale] &&
    state.hostSaveClasses.includes('is-saving') &&
    !state.hostSaveClasses.includes('is-error')
  ) {
    return 'saving';
  }
  return null;
}

async function captureReadOnlyFallback(context, combo) {
  const keyboardActivations = await setVaultPluginEnabled(context, false, combo);
  const fallback = await waitFor(
    `closed-settings read-only fallback for ${combo.id}`,
    () =>
      context.driver.execute(`
      const fallback = document.querySelector('section.provider-fallback');
      const settingsOpen = Boolean(document.querySelector('.settings-dialog'));
      return {
        settingsClosed: !settingsOpen,
        overlayVisible: settingsOpen,
        providerCount: document.querySelectorAll('${PROVIDER}').length,
        fallbackPresent: fallback !== null,
        readOnly: fallback !== null && fallback.querySelectorAll('input,textarea,select,[data-action="edit"],[data-action="save"],[data-action="cancel"]').length === 0,
        fallbackText: fallback?.innerText?.trim() ?? null,
      };
    `),
    (value) => value.settingsClosed && value.providerCount === 0 && value.fallbackPresent && value.readOnly,
  );
  const hostStatus = await waitForHostSaved(
    context.driver,
    combo.locale,
    'before read-only fallback screenshot',
  );
  return { ...fallback, pluginEnabled: false, hostStatus, keyboardActivations };
}

async function setVaultPluginEnabled(context, enabled, combo) {
  const { driver, candidate } = context;
  const keyboardActivations = [];
  const settingsActivation = await openSettings(driver, combo.locale);
  if (settingsActivation) keyboardActivations.push(settingsActivation);
  const pluginsActivation = await openPluginsSection(driver, combo.locale);
  if (pluginsActivation) keyboardActivations.push(pluginsActivation);
  await assertCurrentIdentity(
    context,
    null,
    `before plugin ${enabled ? 'enable' : 'disable'} for ${combo.id}`,
  );
  const current = await readPluginSwitch(driver);
  if (!current) throw new Error(`Polaris Dados Settings switch is missing for ${combo.id}.`);
  if (current.disabled) throw new Error(`Polaris Dados Settings switch is disabled for ${combo.id}.`);
  if (current.checked !== enabled) {
    keyboardActivations.push(
      await activateByKeyboard(driver, '.settings-dialog [role="switch"][aria-label="Polaris Dados"]', {
        key: 'Space',
        label: 'Polaris Dados plugin switch',
      }),
    );
  }
  const fileEnabled = await waitFor(
    `vault plugin setting ${enabled} for ${combo.id}`,
    async () => {
      const settings = JSON.parse(
        await readFile(path.join(candidate.vault, '.morrow', 'plugins.json'), 'utf8'),
      );
      return Array.isArray(settings.enabled) && settings.enabled.includes('polaris-dados') === enabled;
    },
    (value) => value === true,
  );
  if (!fileEnabled) throw new Error(`Synthetic plugin setting did not reach ${enabled} for ${combo.id}.`);
  await waitFor(
    `Settings plugin switch ${enabled} for ${combo.id}`,
    () => readPluginSwitch(driver),
    (value) => value?.checked === enabled,
  );
  if (enabled) {
    await waitFor(
      `re-enabled linked provider for ${combo.id}`,
      () => driver.execute(`return document.querySelectorAll('${PROVIDER}').length;`),
      (count) => count === 1,
    );
  }
  keyboardActivations.push(await closeSettings(driver, combo.locale));
  return keyboardActivations;
}

async function readPluginSwitch(driver) {
  return driver.execute(`
    const matches = [...document.querySelectorAll('.settings-dialog [role="switch"]')]
      .filter((item) => item.getAttribute('aria-label') === 'Polaris Dados');
    return matches.length === 1 ? { checked: matches[0].getAttribute('aria-checked') === 'true', disabled: matches[0].disabled } : null;
  `);
}

async function openSettings(driver, locale) {
  const expected = UI_LABELS[locale].settings;
  const alreadyOpen = await driver.execute('return Boolean(document.querySelector(".settings-dialog"));');
  let activation = null;
  if (!alreadyOpen) {
    activation = await activateUniqueByText(
      driver,
      '.sidebar-footer .nav-item',
      '.nav-label',
      expected,
      'Settings navigation',
    );
  }
  await waitFor(
    'real Settings dialog',
    () => driver.execute('return Boolean(document.querySelector(".settings-dialog"));'),
    Boolean,
  );
  return activation;
}

async function openPluginsSection(driver, locale) {
  const expected = UI_LABELS[locale].plugins;
  const current = await driver.execute(
    'return document.querySelector(".settings-dialog .settings-nav-item[aria-current=page]")?.textContent?.trim() ?? null;',
  );
  let activation = null;
  if (current !== expected) {
    activation = await activateUniqueByText(
      driver,
      '.settings-dialog .settings-nav-item',
      null,
      expected,
      'Plugins settings section',
    );
  }
  await waitFor(
    'real Polaris Dados Settings switch',
    () =>
      driver.execute(
        `return [...document.querySelectorAll('.settings-dialog [role="switch"]')].filter((item) => item.getAttribute('aria-label') === 'Polaris Dados').length;`,
      ),
    (count) => count === 1,
  );
  return activation;
}

async function closeSettings(driver, locale) {
  const label = UI_LABELS[locale].closeSettings;
  const activation = await activateByKeyboard(driver, `.settings-dialog button[aria-label="${label}"]`, {
    key: 'Enter',
    label: 'Close Settings button',
  });
  await waitFor(
    'Settings dialog closed',
    () => driver.execute('return !document.querySelector(".settings-dialog");'),
    Boolean,
  );
  return activation;
}

async function activateUniqueByText(driver, selector, childSelector, expectedText, label) {
  return activateByKeyboard(driver, selector, {
    childSelector,
    expectedText,
    key: 'Enter',
    label,
  });
}

async function activateByKeyboard(
  driver,
  selector,
  { childSelector = null, expectedText = null, key, label },
) {
  if (!Object.hasOwn(WEBDRIVER_KEYS, key)) throw new Error(`Unsupported keyboard activation key: ${key}`);
  const before = await inspectKeyboardTarget(driver, selector, childSelector, expectedText);
  if (before.count !== 1 || !before.descriptor?.focusable || !before.descriptor.visible) {
    throw new Error(
      `Refusing keyboard activation for ${label}: target must be unique, visible, enabled, and keyboard-focusable; observed ${JSON.stringify(before.descriptor)}.`,
    );
  }
  const id = before.element?.[WEB_ELEMENT_KEY] ?? before.element?.ELEMENT;
  if (!id) throw new Error(`WebDriver did not expose a real target element for ${label}.`);

  // Element Send Keys performs browser keyboard interaction; this helper never writes focus or dispatches DOM events.
  try {
    await driver.request('POST', driver.path(`/element/${id}/value`), {
      text: WEBDRIVER_KEYS[key],
      value: [WEBDRIVER_KEYS[key]],
    });
  } finally {
    await driver.request('DELETE', driver.path('/actions'));
  }

  const after = await inspectKeyboardTarget(driver, selector, childSelector, expectedText);
  return {
    method: 'webdriver-element-send-keys',
    key,
    label,
    target: {
      selector,
      tagName: before.descriptor.tagName,
      role: before.descriptor.role,
      accessibleName: before.descriptor.accessibleName,
      focusable: before.descriptor.focusable,
    },
    focus: {
      targetActiveBefore: before.focus.targetActive,
      activeElementBefore: before.focus.activeElement,
      targetActiveAfter: after.focus.targetActive,
      activeElementAfter: after.focus.activeElement,
    },
    before: {
      route: before.route,
      state: before.state,
      rect: before.descriptor.rect,
      viewport: before.viewport,
    },
    after: {
      route: after.route,
      state: after.state,
      rect: after.descriptor?.rect ?? null,
      viewport: after.viewport,
    },
  };
}

async function inspectKeyboardTarget(driver, selector, childSelector, expectedText) {
  return driver.execute(
    `
    const selector = arguments[0];
    const childSelector = arguments[1];
    const expected = arguments[2];
    const matches = [...document.querySelectorAll(selector)].filter((item) => {
      const labelTarget = childSelector ? item.querySelector(childSelector) : item;
      const label = labelTarget?.getAttribute('aria-label') || labelTarget?.textContent?.trim() || '';
      return expected === null || label === expected || labelTarget?.textContent?.trim() === expected;
    });
    const target = matches.length === 1 ? matches[0] : null;
    const labelTarget = target && childSelector ? target.querySelector(childSelector) : target;
    const rect = target?.getBoundingClientRect();
    const active = document.activeElement;
    const tagName = target?.tagName ?? null;
    const role = target?.getAttribute('role') || ({ BUTTON: 'button', INPUT: 'textbox', SELECT: 'combobox', TEXTAREA: 'textbox' }[tagName] ?? null);
    const nativeFocusable = Boolean(target?.matches('button,input,select,textarea,a[href],summary')) && target.tabIndex >= 0;
    const roleFocusable = ['button', 'switch', 'radio', 'option', 'menuitem', 'tab', 'checkbox'].includes(role) && target?.tabIndex >= 0;
    const style = target ? getComputedStyle(target) : null;
    const visible = Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden');
    const describe = (element) => element ? {
      tagName: element.tagName,
      role: element.getAttribute('role') || ({ BUTTON: 'button', INPUT: 'textbox', SELECT: 'combobox', TEXTAREA: 'textbox' }[element.tagName] ?? null),
      accessibleName: element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent?.trim() || '',
    } : null;
    const provider = document.querySelector('[data-provider="polaris-dados"]');
    const quantityButton = provider?.querySelector('button[data-action="edit"][data-field="quantity"]');
    const quantityInput = provider?.querySelector('input[data-field="quantity"]');
    const cancelButton = provider?.querySelector('button[data-action="cancel"]');
    const saveButton = provider?.querySelector('button[data-action="save"]');
    const pluginSwitch = [...document.querySelectorAll('.settings-dialog [role="switch"]')]
      .find((control) => control.getAttribute('aria-label') === 'Polaris Dados');
    const selectedLocale = [...document.querySelectorAll('[role="listbox"] [role="option"][aria-selected="true"]')]
      .map((option) => option.textContent?.trim() ?? '')[0] ?? null;
    const settingsNav = document.querySelector('.settings-dialog .settings-nav-item[aria-current="page"]');
    return {
      count: matches.length,
      element: target,
      descriptor: target ? {
        tagName,
        role,
        accessibleName: target.getAttribute('aria-label') || target.getAttribute('title') || labelTarget?.textContent?.trim() || target.textContent?.trim() || '',
        focusable: !target.disabled && target.getAttribute('aria-disabled') !== 'true' && (nativeFocusable || roleFocusable),
        visible,
        rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
      } : null,
      focus: { targetActive: target === active, activeElement: describe(active) },
      route: location.hash || '#/',
      state: {
        settingsOpen: Boolean(document.querySelector('.settings-dialog')),
        settingsSection: settingsNav?.textContent?.trim() ?? null,
        theme: document.documentElement.dataset.theme ?? null,
        selectedLocale,
        providerCount: document.querySelectorAll('[data-provider="polaris-dados"]').length,
        persistedQuantity: quantityButton?.textContent?.trim() ?? null,
        draftQuantity: quantityInput?.value ?? null,
        saveVisible: Boolean(saveButton && saveButton.getClientRects().length > 0),
        cancelVisible: Boolean(cancelButton && cancelButton.getClientRects().length > 0),
        pluginEnabled: pluginSwitch?.getAttribute('aria-checked') === 'true' ? true : pluginSwitch ? false : null,
      },
      viewport: {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        visualViewportWidth: window.visualViewport?.width ?? null,
        visualViewportHeight: window.visualViewport?.height ?? null,
      },
    };
  `,
    [selector, childSelector, expectedText],
  );
}

async function openPage(context, pageId, label) {
  await assertCurrentIdentity(context, null, `before opening ${label}`);
  const beforeRoute = await context.driver.execute('return location.hash || "#/";');
  const route = `#/page/${encodeURIComponent(pageId)}`;
  // This is only visual setup for evidence capture, not a Sidebar acceptance interaction.
  await context.driver.execute('location.hash = arguments[0]; return location.hash;', [route]);
  await waitFor(
    `${label} page route`,
    () => context.driver.execute('return location.hash;'),
    (hash) => hash === route,
  );
  const afterRoute = await context.driver.execute('return location.hash;');
  return {
    method: 'public-location-hash-setup',
    pageId,
    beforeRoute,
    afterRoute,
    sidebarAcceptance: false,
  };
}

async function readSyntheticPageIds(vault) {
  const workspace = JSON.parse(await readFile(path.join(vault, '.morrow', 'workspace.json'), 'utf8'));
  const pages = workspace?.pages ?? {};
  const result = {
    inventory: pages['Inventory.md']?.id,
    row: pages['Inventory/Widget.md']?.id,
    views: pages['Views.md']?.id,
  };
  if (Object.values(result).some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new Error('The synthetic workspace does not expose the three expected page IDs.');
  }
  return result;
}

async function readViewport(driver) {
  return driver.execute(`
    const main = document.querySelector('.app > main.main');
    const rect = main?.getBoundingClientRect();
    const storedZoom = localStorage.getItem('morrow.zoom');
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      visualViewportWidth: window.visualViewport?.width ?? null,
      visualViewportHeight: window.visualViewport?.height ?? null,
      visualViewportScale: window.visualViewport?.scale ?? null,
      mainContentWidth: rect?.width ?? null,
      storedZoomLevel: storedZoom === null ? null : Number(storedZoom),
    };
  `);
}

async function resetZoomToDefault(driver) {
  try {
    await driver.request('POST', driver.path('/actions'), {
      actions: [
        {
          type: 'key',
          id: 'native-acceptance-zoom-reset',
          actions: [
            { type: 'keyDown', value: '\uE009' },
            { type: 'keyDown', value: '0' },
            { type: 'keyUp', value: '0' },
            { type: 'keyUp', value: '\uE009' },
          ],
        },
      ],
    });
  } finally {
    await driver.request('DELETE', driver.path('/actions'));
  }
  return true;
}

async function readStableViewport(driver) {
  const deadline = Date.now() + ZOOM_OBSERVATION_TIMEOUT_MS;
  let previous = null;
  let last = null;
  while (Date.now() <= deadline) {
    last = await readViewport(driver);
    if (isViewportMetrics(last) && previous && viewportSamplesMatch(previous, last)) return last;
    previous = last;
    await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS));
  }
  return last;
}

async function waitForZoomViewport(driver, targetPercent, baseline) {
  const deadline = Date.now() + ZOOM_OBSERVATION_TIMEOUT_MS;
  let last = null;
  while (Date.now() <= deadline) {
    last = await readViewport(driver);
    if (
      measureNativeZoom({ targetPercent, baseline, observed: last, tolerancePixels: 2 }).status === 'verified'
    ) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS));
  }
  return last;
}

function viewportSamplesMatch(left, right) {
  return (
    ['innerWidth', 'innerHeight', 'visualViewportWidth', 'visualViewportHeight', 'mainContentWidth'].every(
      (key) => Math.abs(left[key] - right[key]) <= 0.1,
    ) && Math.abs(left.devicePixelRatio - right.devicePixelRatio) <= 0.001
  );
}

async function captureScreenshot(driver, evidence, filename) {
  const file = path.join(evidence, filename);
  await driver.screenshot(file);
  const bytes = await readFile(file);
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error(`WebDriver screenshot is not a PNG: ${filename}.`);
  }
  return {
    file: filename,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function snapshotList(snapshot) {
  return PAGE_PATHS.map((relative) => ({
    path: relative,
    sha256: snapshot[relative].sha256,
    size: snapshot[relative].size,
    mtimeMs: snapshot[relative].mtimeMs,
    mode: snapshot[relative].mode,
    quantity: snapshot[relative].quantity,
  }));
}

async function assertMarkdownSnapshotsEqual(before, after, label) {
  for (const relative of PAGE_PATHS) {
    const left = before[relative];
    const right = after[relative];
    if (
      !left ||
      !right ||
      left.sha256 !== right.sha256 ||
      left.size !== right.size ||
      left.mtimeMs !== right.mtimeMs ||
      left.mode !== right.mode
    ) {
      throw new Error(`The synthetic Markdown changed during ${label}: ${relative}.`);
    }
  }
}

function validScreenshot(value) {
  return Boolean(
    value &&
    typeof value.file === 'string' &&
    /^[A-Za-z0-9._-]+\.png$/.test(value.file) &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.size) &&
    value.size > 24 &&
    Number.isSafeInteger(value.width) &&
    value.width > 0 &&
    Number.isSafeInteger(value.height) &&
    value.height > 0,
  );
}

function validMarkdownSnapshotList(value) {
  return Boolean(
    Array.isArray(value) &&
    value.length === PAGE_PATHS.length &&
    PAGE_PATHS.every((relative) => {
      const item = value.find((snapshot) => snapshot?.path === relative);
      return Boolean(
        item &&
        /^[a-f0-9]{64}$/.test(item.sha256) &&
        Number.isSafeInteger(item.size) &&
        item.size > 0 &&
        Number.isFinite(item.mtimeMs) &&
        Number.isInteger(item.mode) &&
        item.mode >= 0 &&
        item.mode <= 0o7777 &&
        (relative === 'Inventory/Widget.md' ? item.quantity === 2 : item.quantity === null),
      );
    }),
  );
}

function isViewportMetrics(value) {
  return Boolean(
    value &&
    Number.isFinite(value.innerWidth) &&
    value.innerWidth > 0 &&
    Number.isFinite(value.devicePixelRatio) &&
    value.devicePixelRatio > 0 &&
    Number.isFinite(value.visualViewportWidth) &&
    value.visualViewportWidth > 0 &&
    Number.isFinite(value.mainContentWidth) &&
    value.mainContentWidth > 0,
  );
}

function sameMarkdownSnapshotLists(before, after) {
  const fields = ['sha256', 'size', 'mtimeMs', 'mode', 'quantity'];
  return PAGE_PATHS.every((relative) => {
    const left = before.find((item) => item?.path === relative);
    const right = after.find((item) => item?.path === relative);
    return Boolean(left && right && fields.every((field) => left[field] === right[field]));
  });
}

async function waitFor(description, read, accept, timeoutMs = WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() <= deadline) {
    last = await read();
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS));
  }
  throw new Error(`Timed out waiting for ${description}; last state: ${JSON.stringify(last)}.`);
}
