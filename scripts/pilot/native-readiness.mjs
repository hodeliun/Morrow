import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PILOT_ID = 'polaris-dados';
const WAIT_TIMEOUT_MS = 25_000;
const WAIT_INTERVAL_MS = 100;
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

const SETTINGS_LABELS = ['Settings', 'Configurações', 'Ajustes'];
const HOME_LABELS = ['Home', 'Início', 'Inicio'];
const PLUGINS_SECTION_LABELS = ['Plugins', 'Complementos'];
const CLOSE_SETTINGS_LABELS = ['Close settings', 'Fechar configurações', 'Cerrar ajustes'];
const MASTER_SWITCH_LABELS = [
  'Turn on plugins on this computer',
  'Ativar plugins neste computador',
  'Activar complementos en este ordenador',
];

function boundedCount(value, maximum = 100) {
  return Number.isInteger(value) && value >= 0 ? Math.min(value, maximum) : 0;
}

function shortText(value, maximum = 100) {
  if (typeof value !== 'string') return null;
  const text = value
    .split('')
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('')
    .replace(/(?:[A-Za-z]:[\\/]|\/(?:home|tmp|media|mnt|run)\/)[^\s'"<>]*/g, '[path]')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[id]')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, maximum) : null;
}

function shortPreference(value, allowed, maximum = 32) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().slice(0, maximum);
  return allowed.includes(normalized) ? normalized : null;
}

function numericText(value) {
  if (typeof value !== 'string' || value.length > 16 || !/^-?\d+(?:\.\d+)?$/.test(value)) return null;
  return value;
}

export function normalizeNativeRoute(value) {
  const allowed = new Set([
    'home', 'today', 'page', 'search', 'tasks', 'tags', 'graph', 'review', 'archive', 'trash', 'other', 'empty',
  ]);
  if (typeof value !== 'string') return 'other';
  const route = value.trim();
  if (route === '' || route === '/' || route === '#/') return 'home';
  if (allowed.has(route)) return route;
  const pathname = (route.startsWith('#') ? route.slice(1) : route).split('?')[0] ?? '';
  const firstSegment = pathname.split('/').filter(Boolean)[0]?.toLowerCase();
  if (firstSegment === undefined) return 'home';
  return allowed.has(firstSegment) && firstSegment !== 'other' && firstSegment !== 'empty'
    ? firstSegment
    : 'other';
}

export function sanitizeNativeReadinessSnapshot(raw, { pluginName = 'Polaris Dados' } = {}) {
  const rawPreferences = raw?.preferences ?? {};
  const rawSettings = raw?.settings ?? {};
  const rawRoots = raw?.roots ?? {};
  const rawProvider = raw?.provider ?? {};
  const masterLabels = new Set(MASTER_SWITCH_LABELS);
  const approvedSwitches = Array.isArray(rawSettings.switches)
    ? rawSettings.switches.filter((entry) =>
        entry && (masterLabels.has(entry.label) || entry.label === pluginName),
      )
    : [];
  const masterEntries = approvedSwitches.filter((entry) => masterLabels.has(entry.label));
  const pluginEntries = approvedSwitches.filter((entry) => entry.label === pluginName);
  const locale = shortPreference(rawPreferences.locale, ['auto', 'en', 'pt', 'es']);

  return {
    roots: {
      appMain: rawRoots.appMain === true,
      boot: rawRoots.boot === true,
      vaultChooser: rawRoots.vaultChooser === true,
    },
    route: normalizeNativeRoute(raw?.route),
    documentLanguage: shortText(raw?.documentLanguage, 16),
    heading: shortText(raw?.heading, 100),
    bootText: shortText(raw?.bootText, 240),
    preferences: {
      plugins: typeof rawPreferences.plugins === 'boolean' ? rawPreferences.plugins : null,
      startPage: shortPreference(rawPreferences.startPage, ['home', 'today', 'last']),
      locale,
      theme: shortPreference(rawPreferences.theme, ['system', 'light', 'dark']),
    },
    settings: {
      open: rawSettings.open === true,
      section: shortText(rawSettings.section, 40),
      masterSwitchCount: boundedCount(rawSettings.masterSwitchCount ?? masterEntries.length, 10),
      masterEnabled: masterEntries.length === 1 && masterEntries[0].checked === true,
      pluginSwitchCount: boundedCount(rawSettings.pluginSwitchCount ?? pluginEntries.length, 10),
      pluginEnabled: pluginEntries.length === 1 && pluginEntries[0].checked === true,
      pluginSwitchDisabled: pluginEntries.length === 1 && pluginEntries[0].disabled === true,
    },
    provider: {
      count: boundedCount(rawProvider.count, 10),
      tableLabel: shortText(rawProvider.tableLabel, 64),
      rowCount: boundedCount(rawProvider.rowCount, 100),
      quantity: numericText(rawProvider.quantity),
      price: numericText(rawProvider.price),
      total: numericText(rawProvider.total),
      totalKind: rawProvider.totalKind === 'number' ? 'number' : null,
    },
  };
}

export function isNativeBootReady(snapshot) {
  return snapshot?.roots?.appMain === true && snapshot?.roots?.boot === false && snapshot?.roots?.vaultChooser === false;
}

export function isKnownNativeUi(snapshot) {
  return snapshot?.roots?.appMain === true || snapshot?.roots?.boot === true;
}

export function isNativeHomeSourceClosed(snapshot) {
  return isNativeBootReady(snapshot) && snapshot.route === 'home' && snapshot.provider?.count === 0;
}

export function assertNativePluginSettingsEnabled(snapshot) {
  if (!snapshot?.settings?.open) throw new Error('The real Settings dialog is not open.');
  if (!PLUGINS_SECTION_LABELS.includes(snapshot.settings.section)) {
    throw new Error(`The real Plugins settings section is not selected: ${snapshot.settings.section ?? '<missing>'}.`);
  }
  if (snapshot.settings.masterSwitchCount !== 1 || !snapshot.settings.masterEnabled) {
    throw new Error('The real global plugin switch is missing, duplicated, or off.');
  }
  if (snapshot.preferences?.plugins !== true) {
    throw new Error('Public morrow.preferences.plugins is not true after the real global switch was enabled.');
  }
  if (snapshot.settings.pluginSwitchCount !== 1 || !snapshot.settings.pluginEnabled) {
    throw new Error('The Polaris Dados vault switch is missing, duplicated, or off.');
  }
  if (snapshot.settings.pluginSwitchDisabled) {
    throw new Error('The Polaris Dados vault switch remained disabled after global plugin activation.');
  }
}

export function assertNativeSourceReadiness(snapshot) {
  const provider = snapshot?.provider;
  if (
    provider?.count !== 1 ||
    provider.rowCount !== 1 ||
    provider.quantity !== '2' ||
    provider.price !== '10' ||
    provider.total !== '20' ||
    provider.totalKind !== 'number'
  ) {
    throw new Error(`The fixed readiness source did not render Q=2, P=10, Total=20: ${JSON.stringify(provider ?? null)}`);
  }
}

async function observeNativeUi(driver, candidate) {
  const raw = await driver.execute(`
    const providerId = arguments[0];
    const pluginName = arguments[1];
    const masterLabels = arguments[2];
    let preferences = {};
    try {
      const parsed = JSON.parse(localStorage.getItem('morrow.preferences') || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) preferences = parsed;
    } catch {}
    const switches = [...document.querySelectorAll('.settings-dialog [role="switch"]')];
    const masterSwitches = switches.filter((item) => masterLabels.includes(item.getAttribute('aria-label')));
    const pluginSwitches = switches.filter((item) => item.getAttribute('aria-label') === pluginName);
    const section = document.querySelector('.settings-dialog .settings-nav-item[aria-current="page"]');
    const main = document.querySelector('.app > main.main');
    const boot = document.querySelector('.boot');
    const chooser = document.querySelector('.boot.vault-chooser');
    const dialog = document.querySelector('.settings-dialog');
    const heading = (dialog?.querySelector('.settings-page-head h3') || main?.querySelector('h1, h2, h3') || boot?.querySelector('h1, h2, h3'));
    const bootText = boot?.querySelector('.boot-text, p')?.textContent?.trim() ?? '';
    const providerRoots = [...document.querySelectorAll('[data-provider="' + providerId + '"]')];
    const root = providerRoots[0];
    const row = root?.querySelector('tbody tr');
    const cell = (field) => row?.querySelector('[data-field="' + field + '"]')?.textContent?.trim() ?? null;
    return {
      roots: { appMain: main !== null, boot: boot !== null, vaultChooser: chooser !== null },
      route: location.hash,
      documentLanguage: document.documentElement.lang ?? '',
      heading: heading?.textContent?.trim() ?? '',
      bootText,
      preferences: {
        plugins: typeof preferences.plugins === 'boolean' ? preferences.plugins : null,
        startPage: typeof preferences.startPage === 'string' ? preferences.startPage.slice(0, 40) : null,
        locale: typeof preferences.locale === 'string' ? preferences.locale.slice(0, 24) : null,
        theme: typeof preferences.theme === 'string' ? preferences.theme.slice(0, 24) : null,
      },
      settings: {
        open: dialog !== null,
        section: section?.textContent?.trim() ?? '',
        masterSwitchCount: masterSwitches.length,
        masterEnabled: masterSwitches.length === 1 && masterSwitches[0].getAttribute('aria-checked') === 'true',
        pluginSwitchCount: pluginSwitches.length,
        pluginEnabled: pluginSwitches.length === 1 && pluginSwitches[0].getAttribute('aria-checked') === 'true',
        pluginSwitchDisabled: pluginSwitches.length === 1 && pluginSwitches[0].disabled,
        switches: [
          ...masterSwitches.map((item) => ({
            label: item.getAttribute('aria-label'),
            checked: item.getAttribute('aria-checked') === 'true',
            disabled: item.disabled,
          })),
          ...pluginSwitches.map((item) => ({
            label: item.getAttribute('aria-label'),
            checked: item.getAttribute('aria-checked') === 'true',
            disabled: item.disabled,
          })),
        ],
      },
      provider: {
        count: providerRoots.length,
        tableLabel: root?.querySelector('table[aria-label]')?.getAttribute('aria-label') ?? '',
        rowCount: root?.querySelectorAll('tbody tr').length ?? 0,
        quantity: cell('quantity'),
        price: cell('price'),
        total: cell('total'),
        totalKind: row?.querySelector('[data-field="total"] [data-value-kind]')?.getAttribute('data-value-kind') ?? null,
      },
    };
  `, [PILOT_ID, candidate.pluginName ?? 'Polaris Dados', MASTER_SWITCH_LABELS]);
  return sanitizeNativeReadinessSnapshot(raw, { pluginName: candidate.pluginName ?? 'Polaris Dados' });
}

function waitFor(description, read, predicate, timeoutMs = WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const value = await read();
        if (predicate(value)) return resolve(value);
        if (Date.now() >= deadline) {
          return reject(new Error(`Timed out waiting for ${description}: ${JSON.stringify(value)}`));
        }
        setTimeout(poll, WAIT_INTERVAL_MS);
      } catch (error) {
        if (Date.now() >= deadline) return reject(error);
        setTimeout(poll, WAIT_INTERVAL_MS);
      }
    };
    void poll();
  });
}

async function clickReference(driver, reference, description) {
  const elementId = reference?.[ELEMENT_KEY] ?? reference?.ELEMENT;
  if (typeof elementId !== 'string' || !elementId) throw new Error(`Could not locate the real ${description} control.`);
  await driver.request('POST', driver.path(`/element/${elementId}/click`), {});
}

async function findUniqueElement(driver, selector, labels, childSelector = null) {
  return driver.execute(`
    const labels = arguments[1];
    const childSelector = arguments[2];
    const matches = [...document.querySelectorAll(arguments[0])].filter((element) => {
      const target = childSelector ? element.querySelector(childSelector) : element;
      return labels.includes(target?.textContent?.trim() ?? '');
    });
    return matches.length === 1 ? matches[0] : null;
  `, [selector, labels, childSelector]);
}

async function findUniqueAriaControl(driver, selector, labels) {
  return driver.execute(`
    const labels = arguments[1];
    const matches = [...document.querySelectorAll(arguments[0])]
      .filter((element) => labels.includes(element.getAttribute('aria-label')));
    return matches.length === 1 ? matches[0] : null;
  `, [selector, labels]);
}

async function clickNamedControl(driver, selector, labels, description, childSelector = null) {
  const reference = await findUniqueElement(driver, selector, labels, childSelector);
  await clickReference(driver, reference, description);
}

async function openPluginsSettings(driver, candidate) {
  let state = await observeNativeUi(driver, candidate);
  if (!state.settings.open) {
    await clickNamedControl(driver, '.sidebar-footer .nav-item', SETTINGS_LABELS, 'Settings navigation', '.nav-label');
    state = await waitFor(
      'the real Settings dialog',
      () => observeNativeUi(driver, candidate),
      (value) => value.settings.open,
    );
  }
  if (!PLUGINS_SECTION_LABELS.includes(state.settings.section)) {
    await clickNamedControl(
      driver,
      '.settings-dialog .settings-nav-item',
      PLUGINS_SECTION_LABELS,
      'Plugins settings navigation',
    );
  }
  return waitFor(
    'the real Plugins controls for this synthetic vault',
    () => observeNativeUi(driver, candidate),
    (value) =>
      value.settings.open &&
      PLUGINS_SECTION_LABELS.includes(value.settings.section) &&
      value.settings.masterSwitchCount === 1 &&
      value.settings.pluginSwitchCount === 1,
  );
}

async function clickSwitch(driver, label, description) {
  const reference = await driver.execute(`
    const matches = [...document.querySelectorAll('.settings-dialog [role="switch"]')]
      .filter((item) => item.getAttribute('aria-label') === arguments[0]);
    return matches.length === 1 ? matches[0] : null;
  `, [label]);
  await clickReference(driver, reference, description);
}

async function closeSettings(driver, candidate) {
  const reference = await findUniqueAriaControl(
    driver,
    '.settings-dialog button[aria-label]',
    CLOSE_SETTINGS_LABELS,
  );
  await clickReference(driver, reference, 'close Settings');
  await waitFor('Settings dialog close', () => observeNativeUi(driver, candidate), (value) => !value.settings.open);
}

async function waitForPluginFile(candidate, enabled) {
  await waitFor(
    `the synthetic vault plugin state enabled=${enabled}`,
    async () => {
      const value = JSON.parse(await readFile(path.join(candidate.vault, '.morrow', 'plugins.json'), 'utf8'));
      return Array.isArray(value.enabled) && value.enabled.includes(PILOT_ID);
    },
    (value) => value === enabled,
  );
}

async function waitForBootReady(driver, candidate, description) {
  return waitFor(
    description,
    () => observeNativeUi(driver, candidate),
    isNativeBootReady,
  );
}

export async function prepareNativeUi({
  driver,
  candidate,
  prepared,
  recordStep,
  beginRuntimeRefresh,
  verifyRuntimeIdentity,
}) {
  if (!driver || !candidate?.vault || !candidate?.evidence || !prepared?.bankBefore) {
    throw new Error('Native UI preparation requires the isolated driver and prepared synthetic vault.');
  }
  if (
    typeof recordStep !== 'function' ||
    typeof beginRuntimeRefresh !== 'function' ||
    typeof verifyRuntimeIdentity !== 'function'
  ) {
    throw new Error('Native UI preparation requires evidence and runtime identity callbacks.');
  }

  const before = await waitForBootReady(driver, candidate, 'conclusive native app boot before UI setup');
  await recordStep('native-readiness-before-settings-ui', { snapshot: before });

  let controls = await openPluginsSettings(driver, candidate);
  if (!controls.settings.masterEnabled) {
    const matchingLabel = await driver.execute(`
      const labels = arguments[0];
      const matches = [...document.querySelectorAll('.settings-dialog [role="switch"]')]
        .filter((item) => labels.includes(item.getAttribute('aria-label')));
      return matches.length === 1 ? matches[0].getAttribute('aria-label') : null;
    `, [MASTER_SWITCH_LABELS]);
    if (!matchingLabel) throw new Error('Could not identify the localized global plugin switch.');
    await clickSwitch(driver, matchingLabel, 'global plugin switch');
  }

  controls = await waitFor(
    'global plugin activation through Settings',
    () => observeNativeUi(driver, candidate),
    (value) => value.settings.masterEnabled && value.preferences.plugins === true,
  );

  if (!controls.settings.pluginEnabled) {
    if (controls.settings.pluginSwitchDisabled) {
      throw new Error('The Polaris Dados switch is disabled after the global plugin switch was enabled.');
    }
    await clickSwitch(driver, candidate.pluginName ?? 'Polaris Dados', 'Polaris Dados vault switch');
  }
  controls = await waitFor(
    'Polaris Dados activation in the synthetic vault',
    () => observeNativeUi(driver, candidate),
    (value) => value.settings.pluginEnabled && !value.settings.pluginSwitchDisabled,
  );
  assertNativePluginSettingsEnabled(controls);
  await waitForPluginFile(candidate, true);
  await recordStep('native-readiness-settings-ui-enabled', { snapshot: controls });

  await closeSettings(driver, candidate);
  beginRuntimeRefresh();
  await driver.refresh();
  const runtime = await verifyRuntimeIdentity();
  const afterRefresh = await waitForBootReady(driver, candidate, 'conclusive native app boot after UI refresh');
  if (afterRefresh.preferences.plugins !== true) {
    throw new Error('Public morrow.preferences.plugins did not remain true after refresh.');
  }
  await recordStep('native-readiness-after-refresh', {
    snapshot: afterRefresh,
    runtime: {
      platform: runtime.platform,
      backendIdentityMatches: runtime.dataPath === candidate.expectedBackendDataPath,
      webviewIdentityMatches: runtime.webviewDataPath === candidate.expectedWebviewDataPath,
    },
  });

  let home = await observeNativeUi(driver, candidate);
  if (!isNativeHomeSourceClosed(home)) {
    await clickNamedControl(driver, '.sidebar-nav .nav-item', HOME_LABELS, 'Home navigation', '.nav-label');
    home = await waitFor(
      'the synthetic Home route with no provider open',
      () => observeNativeUi(driver, candidate),
      isNativeHomeSourceClosed,
    );
  }
  await recordStep('native-readiness-home-route-source-closed', { snapshot: home });

  controls = await openPluginsSettings(driver, candidate);
  assertNativePluginSettingsEnabled(controls);
  await recordStep('native-readiness-settings-ui-confirmed-after-refresh', { snapshot: controls });
  await closeSettings(driver, candidate);
  const final = await waitFor(
    'the common preparation boundary with source closed on Home',
    () => observeNativeUi(driver, candidate),
    isNativeHomeSourceClosed,
  );
  await recordStep('native-readiness-pre-callback-source-closed', {
    snapshot: final,
    globalPluginsEnabled: controls.settings.masterEnabled,
    vaultPluginEnabled: controls.settings.pluginEnabled,
  });
  return { before, afterRefresh, home, settingsAfterRefresh: controls, final };
}

async function clickSyntheticDatabase(driver, databaseId) {
  const reference = await driver.execute(`
    const matches = [...document.querySelectorAll('.app [role="treeitem"][data-page-id]')]
      .filter((item) => item.getAttribute('data-page-id') === arguments[0]);
    return matches.length === 1 ? matches[0] : null;
  `, [databaseId]);
  await clickReference(driver, reference, 'synthetic Inventory database page');
}

export async function runNativeReadinessScenario({ driver, candidate, recordStep }) {
  if (!driver || !candidate?.databaseId || typeof recordStep !== 'function') {
    throw new Error('The fixed readiness scenario requires the isolated driver and generated Inventory database.');
  }
  const initial = await waitForBootReady(driver, candidate, 'conclusive app boot before opening the fixed readiness source');
  await clickSyntheticDatabase(driver, candidate.databaseId);
  const source = await waitFor(
    'the fixed synthetic source grid with Total=20',
    () => observeNativeUi(driver, candidate),
    (value) =>
      value.provider.count === 1 &&
      value.provider.rowCount === 1 &&
      value.provider.quantity === '2' &&
      value.provider.price === '10' &&
      value.provider.total === '20' &&
      value.provider.totalKind === 'number',
  );
  assertNativeSourceReadiness(source);
  await recordStep('native-readiness-fixed-source-total-20', {
    beforeNavigation: { route: initial.route, heading: initial.heading, providerCount: initial.provider.count },
    source: source.provider,
    expected: { quantity: 2, price: 10, total: 20 },
  });
}

function safeErrorName(error) {
  const name = shortText(error?.name, 40);
  return name && /^[A-Za-z][A-Za-z0-9_.-]*$/.test(name) ? name : 'Error';
}

export async function captureNativeReadinessFailure({
  driver,
  candidate,
  scenarioName,
  identityConfirmed,
  error,
}) {
  if (!candidate?.evidence) return { status: 'skipped', reason: 'evidence-path-unavailable' };
  const outputPath = path.join(candidate.evidence, 'native-readiness-failure.json');
  const base = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    scenario: shortText(scenarioName, 40) ?? 'unknown',
    errorName: safeErrorName(error),
  };
  if (!identityConfirmed || !driver) {
    const result = { ...base, status: 'skipped', reason: 'runtime-identity-not-confirmed' };
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    return { status: result.status, reason: result.reason };
  }

  let snapshot;
  try {
    snapshot = await observeNativeUi(driver, candidate);
  } catch (captureError) {
    const result = {
      ...base,
      status: 'partial',
      reason: 'dom-observation-failed',
      captureErrorName: safeErrorName(captureError),
    };
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    return { status: result.status, reason: result.reason };
  }

  if (!isKnownNativeUi(snapshot)) {
    const result = { ...base, status: 'skipped', reason: 'unknown-ui-root' };
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    return { status: result.status, reason: result.reason };
  }

  const result = { ...base, status: 'captured', domSnapshot: snapshot, screenshot: null };
  try {
    const screenshotPath = path.join(candidate.evidence, 'native-readiness-failure.png');
    await driver.screenshot(screenshotPath);
    result.screenshot = path.basename(screenshotPath);
  } catch (captureError) {
    result.screenshotFailureName = safeErrorName(captureError);
  }
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  return { status: result.status, screenshot: result.screenshot !== null };
}
