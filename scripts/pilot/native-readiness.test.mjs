import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertNativePluginSettingsEnabled,
  assertNativeSourceReadiness,
  isKnownNativeUi,
  isNativeHomeSourceClosed,
  isNativeBootReady,
  normalizeNativeRoute,
  prepareNativeOnboarding,
  sanitizeNativeReadinessSnapshot,
} from './native-readiness.mjs';

function rawSnapshot(overrides = {}) {
  return {
    roots: { appMain: true, boot: false, vaultChooser: false },
    route: 'page',
    documentLanguage: 'en',
    heading: 'Inventory',
    bootText: '',
    preferences: { plugins: true, startPage: 'today', locale: 'pt', theme: 'dark' },
    settings: {
      open: true,
      section: 'Plugins',
      masterSwitchCount: 1,
      pluginSwitchCount: 1,
      switches: [
        { label: 'Ativar plugins neste computador', checked: true, disabled: false },
        { label: 'Polaris Dados', checked: true, disabled: false },
        { label: 'private setting secret', checked: true, disabled: false },
      ],
    },
    provider: {
      count: 1,
      tableLabel: 'Polaris Data',
      rowCount: 1,
      quantity: '2',
      price: '10',
      total: '20',
      totalKind: 'number',
    },
    ...overrides,
  };
}

test('sanitizes passive snapshots to bounded boot, route, preference, switch, and provider fields', () => {
  const raw = rawSnapshot({
    route: '#/page/private-page-id?find=secret-query',
    heading: `  Inventory\n${'X'.repeat(160)}  `,
    bootText: 'Failure below /home/carlos-linuxvm/private/profile',
    preferences: {
      plugins: true,
      startPage: 'last',
      locale: 'es',
      theme: 'system',
      name: 'private user name',
      token: 'private token',
    },
    settings: {
      ...rawSnapshot().settings,
      section: `Plugins${'X'.repeat(100)}`,
      switches: [
        { label: 'Activar complementos en este ordenador', checked: true, disabled: false },
        { label: 'Polaris Dados', checked: true, disabled: false },
        { label: 'api-key: private', checked: true, disabled: false },
      ],
    },
    provider: {
      ...rawSnapshot().provider,
      quantity: '2'.repeat(40),
      total: '20',
      cellContent: 'private row value',
    },
    profilePath: '/private/profile/path',
  });

  const snapshot = sanitizeNativeReadinessSnapshot(raw);

  assert.equal(snapshot.roots.appMain, true);
  assert.equal(snapshot.route, 'page');
  assert.equal(snapshot.heading.length, 100);
  assert.equal(snapshot.bootText, 'Failure below [path]');
  assert.deepEqual(snapshot.preferences, { plugins: true, startPage: 'last', locale: 'es', theme: 'system' });
  assert.equal(snapshot.settings.masterSwitchCount, 1);
  assert.equal(snapshot.settings.masterEnabled, true);
  assert.equal(snapshot.settings.pluginEnabled, true);
  assert.equal(snapshot.settings.section.length, 40);
  assert.equal(snapshot.provider.quantity, null);
  assert.equal(snapshot.provider.total, '20');
  assert.equal('profilePath' in snapshot, false);
  assert.equal('token' in snapshot.preferences, false);
  assert.equal('cellContent' in snapshot.provider, false);
});

test('recognizes only a settled main shell as ready while allowing known boot roots for diagnostics', () => {
  const app = sanitizeNativeReadinessSnapshot(rawSnapshot());
  assert.equal(isNativeBootReady(app), true);
  assert.equal(isKnownNativeUi(app), true);
  assert.equal(isNativeHomeSourceClosed(app), false);

  const home = sanitizeNativeReadinessSnapshot(rawSnapshot({
    route: '#/',
    provider: { count: 0, rowCount: 0 },
  }));
  assert.equal(isNativeHomeSourceClosed(home), true);
  assert.equal(isNativeHomeSourceClosed(sanitizeNativeReadinessSnapshot(rawSnapshot({ route: 'home' }))), false);
  assert.equal(normalizeNativeRoute('#/'), 'home');
  assert.equal(normalizeNativeRoute(''), 'home');
  assert.equal(normalizeNativeRoute('#/page/private-id'), 'page');
  assert.equal(normalizeNativeRoute('#/unknown/private-id'), 'other');

  const loading = sanitizeNativeReadinessSnapshot(rawSnapshot({
    roots: { appMain: false, boot: true, vaultChooser: false },
    heading: 'Opening workspace',
    bootText: 'Loading the synthetic workspace',
  }));
  assert.equal(isNativeBootReady(loading), false);
  assert.equal(isKnownNativeUi(loading), true);

  const chooser = sanitizeNativeReadinessSnapshot(rawSnapshot({
    roots: { appMain: false, boot: true, vaultChooser: true },
  }));
  assert.equal(isNativeBootReady(chooser), false);
  assert.equal(isKnownNativeUi(chooser), true);

  const unknown = sanitizeNativeReadinessSnapshot(rawSnapshot({
    roots: { appMain: false, boot: false, vaultChooser: false },
  }));
  assert.equal(isNativeBootReady(unknown), false);
  assert.equal(isKnownNativeUi(unknown), false);
});

test('requires the localized global switch, public preference, and synthetic vault plugin switch', () => {
  const snapshot = sanitizeNativeReadinessSnapshot(rawSnapshot());
  assertNativePluginSettingsEnabled(snapshot);

  const disabledMaster = sanitizeNativeReadinessSnapshot(rawSnapshot({
    settings: {
      ...rawSnapshot().settings,
      switches: [
        { label: 'Ativar plugins neste computador', checked: false, disabled: false },
        { label: 'Polaris Dados', checked: false, disabled: true },
      ],
    },
    preferences: { ...rawSnapshot().preferences, plugins: false },
  }));
  assert.throws(() => assertNativePluginSettingsEnabled(disabledMaster), /global plugin switch/);

  const missingPluginSwitch = sanitizeNativeReadinessSnapshot(rawSnapshot({
    settings: {
      ...rawSnapshot().settings,
      pluginSwitchCount: 0,
      switches: [{ label: 'Ativar plugins neste computador', checked: true, disabled: false }],
    },
  }));
  assert.throws(() => assertNativePluginSettingsEnabled(missingPluginSwitch), /vault switch/);
});

test('readiness source requires exactly one numeric Q2/P10/Total20 projection', () => {
  const snapshot = sanitizeNativeReadinessSnapshot(rawSnapshot());
  assertNativeSourceReadiness(snapshot);

  for (const provider of [
    { ...snapshot.provider, count: 0 },
    { ...snapshot.provider, rowCount: 2 },
    { ...snapshot.provider, total: '21' },
    { ...snapshot.provider, totalKind: null },
  ]) {
    assert.throws(
      () => assertNativeSourceReadiness({ provider }),
      /fixed readiness source/,
    );
  }
});

function onboardingDriver({
  dialogCount = 0,
  closeButtonCount = 1,
  onboarded = true,
  onboardedAfterClose = onboarded,
} = {}) {
  let openWelcomeDialogs = dialogCount;
  let publicOnboarded = onboarded;
  const events = [];
  const closeButton = { 'element-6066-11e4-a52e-4f735466cecf': 'welcome-close-reference' };

  return {
    events,
    driver: {
      async execute(script) {
        if (script.includes('localStorage.getItem') && script.includes('.welcome-step')) {
          events.push({ type: 'snapshot', dialogCount: openWelcomeDialogs, onboarded: publicOnboarded });
          return {
            dialogCount: openWelcomeDialogs,
            closeButtonCount: openWelcomeDialogs === 1 ? closeButtonCount : 0,
            closeButton: openWelcomeDialogs === 1 && closeButtonCount === 1 ? closeButton : null,
            onboarded: publicOnboarded,
          };
        }
        throw new Error('Unexpected WebDriver script in onboarding test.');
      },
      path(value) {
        return value;
      },
      async request(method, requestPath, body) {
        events.push({ type: 'click', method, requestPath, body });
        openWelcomeDialogs = 0;
        publicOnboarded = onboardedAfterClose;
      },
    },
  };
}

function replayOnboardingDriver({ beforeClick, afterClick }) {
  let nextBeforeClick = 0;
  let clicked = false;
  const events = [];
  const closeButton = { 'element-6066-11e4-a52e-4f735466cecf': 'welcome-close-reference' };
  const takeSnapshot = () => {
    if (clicked) return afterClick;
    const snapshot = beforeClick[Math.min(nextBeforeClick, beforeClick.length - 1)];
    nextBeforeClick += 1;
    return snapshot;
  };
  const snapshotResult = (snapshot) => ({
    dialogCount: snapshot.dialogCount,
    closeButtonCount: snapshot.dialogCount === 1 ? snapshot.closeButtonCount ?? 1 : 0,
    closeButton: snapshot.dialogCount === 1 && (snapshot.closeButtonCount ?? 1) === 1 ? closeButton : null,
    onboarded: snapshot.onboarded,
  });

  return {
    events,
    driver: {
      async execute(script) {
        if (script.includes('localStorage.getItem') && script.includes('.welcome-step')) {
          const snapshot = takeSnapshot();
          events.push({ type: 'snapshot', dialogCount: snapshot.dialogCount, onboarded: snapshot.onboarded });
          return snapshotResult(snapshot);
        }
        throw new Error('Unexpected WebDriver script in onboarding replay.');
      },
      path(value) {
        return value;
      },
      async request(method, requestPath, body) {
        events.push({ type: 'click', method, requestPath, body });
        clicked = true;
      },
    },
  };
}

test('native onboarding waits through transient Welcome absence using one atomic UI and preference snapshot', async () => {
  const { driver, events } = replayOnboardingDriver({
    beforeClick: [
      { dialogCount: 0, onboarded: false },
      { dialogCount: 1, onboarded: false },
    ],
    afterClick: { dialogCount: 0, onboarded: true },
  });
  const records = [];

  const result = await prepareNativeOnboarding({
    driver,
    recordStep: async (name, details) => records.push({ name, details }),
  });

  assert.deepEqual(result, { present: true, dismissed: true, onboarded: true });
  assert.deepEqual(events, [
    { type: 'snapshot', dialogCount: 0, onboarded: false },
    { type: 'snapshot', dialogCount: 1, onboarded: false },
    {
      type: 'click',
      method: 'POST',
      requestPath: '/element/welcome-close-reference/click',
      body: {},
    },
    { type: 'snapshot', dialogCount: 0, onboarded: true },
  ]);
  assert.deepEqual(records, [{
    name: 'native-readiness-welcome-ui',
    details: { present: true, dismissed: true, onboarded: true },
  }]);
});

test('native onboarding is a no-op only when the atomic snapshot says onboarded and Welcome is absent', async () => {
  const { driver, events } = onboardingDriver({ dialogCount: 0, onboarded: true });
  const records = [];
  const result = await prepareNativeOnboarding({
    driver,
    recordStep: async (name, details) => records.push({ name, details }),
  });

  assert.deepEqual(result, { present: false, dismissed: false, onboarded: true });
  assert.deepEqual(events, [{ type: 'snapshot', dialogCount: 0, onboarded: true }]);
  assert.deepEqual(records, [{
    name: 'native-readiness-welcome-ui',
    details: { present: false, dismissed: false, onboarded: true },
  }]);
});

test('native onboarding clicks only the unique Welcome close control through a WebDriver element reference', async () => {
  const { driver, events } = onboardingDriver({
    dialogCount: 1,
    onboarded: false,
    onboardedAfterClose: true,
  });
  const records = [];

  const result = await prepareNativeOnboarding({
    driver,
    recordStep: async (name, details) => records.push({ name, details }),
  });

  assert.deepEqual(result, { present: true, dismissed: true, onboarded: true });
  assert.deepEqual(events, [
    { type: 'snapshot', dialogCount: 1, onboarded: false },
    {
      type: 'click',
      method: 'POST',
      requestPath: '/element/welcome-close-reference/click',
      body: {},
    },
    { type: 'snapshot', dialogCount: 0, onboarded: true },
  ]);
  assert.deepEqual(records, [{
    name: 'native-readiness-welcome-ui',
    details: { present: true, dismissed: true, onboarded: true },
  }]);
});

test('native onboarding fails clearly for duplicate Welcome dialogs or a missing close button', async () => {
  for (const [options, message] of [
    [{ dialogCount: 2 }, /Multiple Welcome dialogs/],
    [{ dialogCount: 1, closeButtonCount: 0 }, /missing its single button\.dialog-close/],
  ]) {
    const { driver, events } = onboardingDriver(options);
    await assert.rejects(
      prepareNativeOnboarding({ driver, recordStep: async () => assert.fail('invalid Welcome state was recorded') }),
      message,
    );
    assert.deepEqual(events, [{
      type: 'snapshot',
      dialogCount: options.dialogCount,
      onboarded: options.onboarded ?? true,
    }]);
  }
});

test('native onboarding times out when Welcome never appears or remains unonboarded after close', async () => {
  const neverAppears = onboardingDriver({ dialogCount: 0, onboarded: null });
  const noWelcomeRecords = [];
  await assert.rejects(
    prepareNativeOnboarding({
      driver: neverAppears.driver,
      recordStep: async (name, details) => noWelcomeRecords.push({ name, details }),
      timeoutMs: 0,
    }),
    /Timed out waiting for one valid Welcome dialog or no Welcome with public onboarded=true/,
  );
  assert.deepEqual(neverAppears.events, [
    { type: 'snapshot', dialogCount: 0, onboarded: null },
  ]);
  assert.deepEqual(noWelcomeRecords, []);

  const remainsUnonboarded = onboardingDriver({
    dialogCount: 1,
    onboarded: false,
    onboardedAfterClose: false,
  });
  const closeRecords = [];
  await assert.rejects(
    prepareNativeOnboarding({
      driver: remainsUnonboarded.driver,
      recordStep: async (name, details) => closeRecords.push({ name, details }),
      timeoutMs: 0,
    }),
    /Timed out waiting for Welcome to disappear with public onboarded=true/,
  );
  assert.deepEqual(remainsUnonboarded.events, [
    { type: 'snapshot', dialogCount: 1, onboarded: false },
    {
      type: 'click',
      method: 'POST',
      requestPath: '/element/welcome-close-reference/click',
      body: {},
    },
    { type: 'snapshot', dialogCount: 0, onboarded: false },
  ]);
  assert.deepEqual(closeRecords, []);
});
