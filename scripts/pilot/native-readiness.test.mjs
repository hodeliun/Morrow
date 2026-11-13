import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertNativePluginSettingsEnabled,
  assertNativeSourceReadiness,
  isKnownNativeUi,
  isNativeHomeSourceClosed,
  isNativeBootReady,
  normalizeNativeRoute,
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
