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
        onboarded: this.onboarded,
      };
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

async function runOnboarding(driver, timeoutMs) {
  const records = [];
  const result = await prepareNativeOnboarding({
    driver,
    recordStep: async (name, details) => records.push({ name, details }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { result, records };
}

test('leaves an absent Welcome alone and records only the public onboarding result', async () => {
  const driver = new WelcomeDriverHarness({ dialogs: 0, onboarded: true });

  const { result, records } = await runOnboarding(driver);

  assert.deepEqual(result, { present: false, dismissed: false, onboarded: true });
  assert.deepEqual(driver.events, ['inspect']);
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
    'inspect',
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
      timeoutMs: 0,
      message: /Timed out waiting/,
      events: [
        'inspect',
        { method: 'POST', requestPath: '/element/welcome-control-1/click', body: {} },
        'inspect',
      ],
      records: 0,
    },
  ]) {
    const driver = new WelcomeDriverHarness(scenario.options);
    const records = [];

    await assert.rejects(
      prepareNativeOnboarding({
        driver,
        recordStep: async (name, details) => records.push({ name, details }),
        ...(scenario.timeoutMs === undefined ? {} : { timeoutMs: scenario.timeoutMs }),
      }),
      scenario.message,
    );

    assert.deepEqual(driver.events, scenario.events);
    assert.equal(records.length, scenario.records);
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
        return { dialogCount: 0, closeButtonCount: 0, closeButton: null, onboarded: true };
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
    'record-native-readiness-welcome-ui',
    'observe-ui',
    'find-settings-control',
  ]);
});

class AtomicWelcomeRaceDriver {
  constructor(snapshots) {
    this.snapshots = snapshots;
    this.observation = 0;
    this.events = [];
  }

  path(value) {
    return value;
  }

  async execute() {
    this.events.push('observe');
    const index = Math.min(this.observation, this.snapshots.length - 1);
    this.observation += 1;
    return this.snapshots[index];
  }

  async request(method, requestPath, body) {
    this.events.push({ method, requestPath, body });
    assert.equal(method, 'POST');
    assert.equal(requestPath, '/element/atomic-welcome-close/click');
    assert.deepEqual(body, {});
  }
}

function welcomeSnapshot(dialogCount, onboarded) {
  const closeButtonCount = dialogCount === 1 ? 1 : 0;
  return {
    dialogCount,
    closeButtonCount,
    closeButton: closeButtonCount === 1
      ? { [ELEMENT_KEY]: 'atomic-welcome-close' }
      : null,
    onboarded,
  };
}

test('waits through a late Welcome and a transient post-close false flag using successive snapshots', async () => {
  const driver = new AtomicWelcomeRaceDriver([
    welcomeSnapshot(0, false),
    welcomeSnapshot(1, false),
    welcomeSnapshot(0, false),
    welcomeSnapshot(0, true),
  ]);
  const records = [];

  const result = await prepareNativeOnboarding({
    driver,
    recordStep: async (name, details) => {
      driver.events.push('record');
      records.push({ name, details });
    },
  });

  assert.deepEqual(result, { present: true, dismissed: true, onboarded: true });
  assert.deepEqual(driver.events, [
    'observe',
    'observe',
    { method: 'POST', requestPath: '/element/atomic-welcome-close/click', body: {} },
    'observe',
    'observe',
    'record',
  ]);
  assert.deepEqual(records, [{
    name: 'native-readiness-welcome-ui',
    details: { present: true, dismissed: true, onboarded: true },
  }]);
});

test('a Welcome that never arrives while onboarded stays false fails only at the bounded wait', async () => {
  const driver = new AtomicWelcomeRaceDriver([welcomeSnapshot(0, false)]);
  const records = [];
  await assert.rejects(
    prepareNativeOnboarding({
      driver,
      recordStep: async (...args) => records.push(args),
      timeoutMs: 0,
    }),
    /Timed out waiting/,
  );

  assert.equal(driver.observation, 1);
  assert.deepEqual(driver.events, Array(driver.observation).fill('observe'));
  assert.deepEqual(records, []);
});
