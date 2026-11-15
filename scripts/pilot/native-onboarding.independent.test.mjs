import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareNativeOnboarding, prepareNativeUi } from './native-readiness.mjs';

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

class WelcomeDriverHarness {
  constructor({ dialogs = 0, closeButtons = 1, onboarded = true, afterClose = onboarded } = {}) {
    this.dialogs = dialogs;
    this.closeButtons = closeButtons;
    this.onboarded = onboarded;
    this.afterClose = afterClose;
    this.events = [];
    this.closeElement = { [ELEMENT_KEY]: 'welcome-control-1' };
  }

  path(value) {
    return value;
  }

  async execute(script) {
    if (script.includes('closeButtonCount')) {
      this.events.push('inspect');
      return {
        dialogCount: this.dialogs,
        closeButtonCount: this.closeButtons,
        closeButton: this.closeButtons === 1 ? this.closeElement : null,
      };
    }
    if (script.includes('storedPreferences')) {
      this.events.push('read-onboarded');
      return this.onboarded;
    }
    if (script.includes('.welcome-step')) {
      this.events.push('count');
      return this.dialogs;
    }
    throw new Error('Unexpected driver script.');
  }

  async request(method, requestPath, body) {
    this.events.push({ method, requestPath, body });
    assert.equal(method, 'POST');
    assert.equal(requestPath, '/element/welcome-control-1/click');
    assert.deepEqual(body, {});
    this.dialogs = 0;
    this.onboarded = this.afterClose;
  }
}

async function runOnboarding(driver) {
  const records = [];
  const result = await prepareNativeOnboarding({
    driver,
    recordStep: async (name, details) => records.push({ name, details }),
  });
  return { result, records };
}

test('leaves an absent Welcome alone and records only the public onboarding result', async () => {
  const driver = new WelcomeDriverHarness({ dialogs: 0, onboarded: true });

  const { result, records } = await runOnboarding(driver);

  assert.deepEqual(result, { present: false, dismissed: false, onboarded: true });
  assert.deepEqual(driver.events, ['inspect', 'read-onboarded']);
  assert.deepEqual(records, [{
    name: 'native-readiness-welcome-ui',
    details: { present: false, dismissed: false, onboarded: true },
  }]);
});

test('dismisses one Welcome by its returned WebDriver element reference and waits for the public flag', async () => {
  const driver = new WelcomeDriverHarness({
    dialogs: 1,
    onboarded: false,
    afterClose: true,
  });

  const { result, records } = await runOnboarding(driver);

  assert.deepEqual(result, { present: true, dismissed: true, onboarded: true });
  assert.deepEqual(driver.events, [
    'inspect',
    { method: 'POST', requestPath: '/element/welcome-control-1/click', body: {} },
    'count',
    'read-onboarded',
  ]);
  assert.deepEqual(records, [{
    name: 'native-readiness-welcome-ui',
    details: { present: true, dismissed: true, onboarded: true },
  }]);
});

test('rejects duplicate or uncloseable Welcome and a false public onboarded flag', async () => {
  for (const scenario of [
    {
      options: { dialogs: 2, closeButtons: 0 },
      message: /Multiple Welcome dialogs/,
      events: ['inspect'],
      records: 0,
    },
    {
      options: { dialogs: 1, closeButtons: 0 },
      message: /missing its single button\.dialog-close/,
      events: ['inspect'],
      records: 0,
    },
    {
      options: { dialogs: 1, onboarded: false, afterClose: false },
      message: /Public morrow\.preferences\.onboarded is not true after closing the Welcome dialog\./,
      events: [
        'inspect',
        { method: 'POST', requestPath: '/element/welcome-control-1/click', body: {} },
        'count',
        'read-onboarded',
      ],
      records: 1,
    },
  ]) {
    const driver = new WelcomeDriverHarness(scenario.options);
    const records = [];

    await assert.rejects(
      prepareNativeOnboarding({
        driver,
        recordStep: async (name, details) => records.push({ name, details }),
      }),
      scenario.message,
    );

    assert.deepEqual(driver.events, scenario.events);
    assert.equal(records.length, scenario.records);
    if (scenario.records === 1) {
      assert.deepEqual(records[0], {
        name: 'native-readiness-welcome-ui',
        details: { present: true, dismissed: true, onboarded: false },
      });
    }
  }
});

test('prepareNativeUi verifies runtime identity before its first UI observation', async () => {
  const events = [];
  const driver = {
    path(value) {
      return value;
    },
    async execute(script) {
      if (script.includes('providerId')) {
        events.push('observe-ui');
        return {
          roots: { appMain: true, boot: false, vaultChooser: false },
          route: '#/page',
          documentLanguage: 'en',
          heading: 'Synthetic page',
          bootText: '',
          preferences: { plugins: false, startPage: 'home', locale: 'en', theme: 'system' },
          settings: {
            open: false,
            section: '',
            masterSwitchCount: 0,
            pluginSwitchCount: 0,
            switches: [],
          },
          provider: { count: 0, rowCount: 0 },
        };
      }
      if (script.includes('closeButtonCount')) {
        events.push('inspect-welcome');
        return { dialogCount: 0, closeButtonCount: 0, closeButton: null };
      }
      if (script.includes('storedPreferences')) {
        events.push('read-onboarded');
        return true;
      }
      events.push('find-settings-control');
      return null;
    },
    async request() {
      assert.fail('No click should occur before the Settings control is located.');
    },
    async refresh() {
      assert.fail('The test stops before refresh.');
    },
  };

  await assert.rejects(
    prepareNativeUi({
      driver,
      candidate: {
        vault: '/synthetic/vault',
        evidence: '/synthetic/evidence',
        expectedBackendDataPath: '/synthetic/backend',
        expectedWebviewDataPath: '/synthetic/webview',
        pluginName: 'Polaris Dados',
      },
      prepared: { bankBefore: {} },
      recordStep: async (name) => events.push(`record-${name}`),
      beginRuntimeRefresh: () => events.push('begin-refresh'),
      verifyRuntimeIdentity: async () => {
        events.push('verify-runtime-identity');
        return { platform: 'linux', dataPath: '/synthetic/backend', webviewDataPath: '/synthetic/webview' };
      },
    }),
    /Could not locate the real Settings navigation control/,
  );

  assert.deepEqual(events, [
    'verify-runtime-identity',
    'observe-ui',
    'record-native-readiness-before-settings-ui',
    'inspect-welcome',
    'read-onboarded',
    'record-native-readiness-welcome-ui',
    'observe-ui',
    'find-settings-control',
  ]);
});
