import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const adapterIndex = process.argv.indexOf('--adapter');
const adapterArgument = adapterIndex >= 0 ? process.argv[adapterIndex + 1] : null;
if (adapterArgument?.startsWith('--')) {
  throw new Error('The --adapter option requires an absolute path.');
}
const adapterUrl = adapterArgument
  ? pathToFileURL(path.resolve(adapterArgument))
  : new URL(process.env.POLARIS_WINDOWS_RUNTIME_MODULE ?? './windows-runtime.mjs', import.meta.url);
if (adapterUrl.protocol !== 'file:') throw new Error('The reviewed module must use a file URL.');
const adapterPath = fileURLToPath(adapterUrl);
const adapterBytes = await readFile(adapterPath);
const adapterSha256 = createHash('sha256').update(adapterBytes).digest('hex');
const adapter = await import(adapterUrl.href);
const { createWindowsChildEnvironment, createWindowsRuntimeSession, WINDOWS_RUNTIME_STATES } = adapter;

assert.equal(typeof createWindowsChildEnvironment, 'function');
assert.equal(typeof createWindowsRuntimeSession, 'function');
assert.deepEqual(WINDOWS_RUNTIME_STATES, [
  'prepared',
  'process-owned',
  'runtime-identity-confirmed',
  'ready',
]);

const SID = 'S-1-5-21-1200000000-1200000001-1200000002-1001';
const OTHER_SID = 'S-1-5-21-1200000000-1200000001-1200000002-1002';
const RUNTIME_INFO_QUERY = 'return window.__MORROW_INFO__ || null';
const expected = {
  ownerSid: SID,
  driverPort: 4444,
  runnerTemp: 'C:\\runner\\temp\\issue-184-independent',
  backendDataPath: 'C:\\runner\\temp\\issue-184-independent\\profile\\backend',
  webviewDataPath: 'C:\\runner\\temp\\issue-184-independent\\profile\\webview',
  vaultPath: 'C:\\runner\\temp\\issue-184-independent\\vault',
  evidencePath: 'C:\\runner\\temp\\issue-184-independent\\evidence',
  driver: {
    processId: 4100,
    parentProcessId: 3900,
    executablePath: 'C:\\tools\\tauri-driver.exe',
    executableSha256: 'a'.repeat(64),
    creationTimeUtc: '2026-11-17T03:00:00.000Z',
    ownerSid: SID,
  },
  nativeDriver: {
    processId: 4150,
    parentProcessId: 4100,
    executablePath: 'C:\\tools\\msedgedriver.exe',
    executableSha256: 'd'.repeat(64),
    creationTimeUtc: '2026-11-17T03:00:01.000Z',
    ownerSid: SID,
  },
  rustBackend: {
    processId: 4200,
    parentProcessId: 4150,
    executablePath: 'C:\\runner\\temp\\issue-184-independent\\package\\morrow.exe',
    executableSha256: 'b'.repeat(64),
    creationTimeUtc: '2026-11-17T03:00:02.000Z',
    ownerSid: SID,
  },
  webview: {
    processId: 4300,
    parentProcessId: 4200,
    executablePath:
      'C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\156.0.0.0\\msedgewebview2.exe',
    executableSha256: 'c'.repeat(64),
    creationTimeUtc: '2026-11-17T03:00:03.000Z',
    ownerSid: SID,
    commandLineUserDataDir: 'C:\\runner\\temp\\issue-184-independent\\profile\\webview',
  },
};

function observation(overrides = {}) {
  return {
    driver: { ...expected.driver },
    nativeDriver: { ...expected.nativeDriver },
    rustBackend: { ...expected.rustBackend },
    webview: { ...expected.webview },
    listener: { processId: expected.driver.processId, port: 4444, localAddress: '127.0.0.1' },
    isolatedPaths: {
      backendPath: expected.backendDataPath,
      backendUnderRunnerTemp: true,
      backendNoReparse: true,
      webviewPath: expected.webviewDataPath,
      webviewUnderRunnerTemp: true,
      webviewNoReparse: true,
      vaultPath: expected.vaultPath,
      vaultUnderRunnerTemp: true,
      vaultNoReparse: true,
      evidencePath: expected.evidencePath,
      evidenceUnderRunnerTemp: true,
      evidenceNoReparse: true,
    },
    ...overrides,
  };
}

function makeClient(label, runtimeInfo = { platform: 'windows', dataPath: expected.backendDataPath }) {
  const calls = {
    execute: [],
    requests: [],
    paths: [],
    clicks: [],
    refreshes: [],
    screenshots: [],
    createSessions: 0,
  };
  const client = {
    base: 'http://127.0.0.1:4444',
    sessionId: 'session-' + label,
    async execute(script) {
      calls.execute.push(script);
      if (script === RUNTIME_INFO_QUERY) return runtimeInfo;
      return 'synthetic-result';
    },
    async request(method, endpoint, body) {
      calls.requests.push({ method, endpoint, body });
      return null;
    },
    path(suffix) {
      calls.paths.push(suffix);
      return '/session/' + this.sessionId + suffix;
    },
    async click(selector) {
      calls.clicks.push(selector);
      return 'synthetic-click';
    },
    async refresh() {
      calls.refreshes.push(true);
    },
    async screenshot(file) {
      calls.screenshots.push(file);
    },
    async createSession() {
      calls.createSessions += 1;
      return { sessionId: this.sessionId };
    },
  };
  return { client, calls };
}

function createSession({
  driver,
  observeOwnedProcesses = async () => observation(),
  restartSession,
  readinessScenario = async () => {},
  functionalScenario = async () => {},
  runtimeInfo,
} = {}) {
  const selected = driver ?? makeClient('default', runtimeInfo).client;
  const evidenceCalls = [];
  const session = createWindowsRuntimeSession({
    driver: selected,
    expected,
    observeOwnedProcesses,
    candidate: {
      vault: expected.vaultPath,
      evidence: expected.evidencePath,
      expectedBackendDataPath: expected.backendDataPath,
      expectedWebviewDataPath: expected.webviewDataPath,
    },
    prepared: { fixtureKind: 'synthetic-contract-only' },
    restartSession: restartSession ?? (async () => selected),
    recordStep: async (...args) => evidenceCalls.push(args),
    readinessScenario,
    functionalScenario,
  });
  return { session, evidenceCalls };
}

async function runScenario(name, callback, completed) {
  await callback();
  completed.push(name);
}

const completed = [];

await runScenario(
  'explicit isolated child environment',
  async () => {
    const source = {
      SYSTEMROOT: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      PATH: 'C:\\Windows\\System32',
      RUNNER_TEMP: expected.runnerTemp,
      TEMP: expected.runnerTemp,
      TMP: expected.runnerTemp,
      USERPROFILE: 'C:\\runner\\user',
      APPDATA: 'C:\\runner\\user\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\runner\\user\\AppData\\Local',
      MORROW_USER_DATA: 'C:\\Users\\synthetic-user\\AppData\\Roaming\\Morrow',
      WEBVIEW2_USER_DATA_FOLDER: 'C:\\Users\\synthetic-user\\AppData\\Local\\WebView2',
      GITHUB_TOKEN: 'synthetic-secret-marker',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-secret-marker',
      GIT_CONFIG_VALUE_0: 'synthetic-secret-marker',
      NODE_OPTIONS: '--require synthetic-hook',
      HTTP_PROXY: 'https://proxy.invalid',
    };
    const child = createWindowsChildEnvironment(
      source,
      {
        MORROW_USER_DATA: expected.backendDataPath,
        WEBVIEW2_USER_DATA_FOLDER: expected.webviewDataPath,
      },
      { testRoot: expected.runnerTemp },
    );
    assert.equal(child.MORROW_USER_DATA, expected.backendDataPath);
    assert.equal(child.WEBVIEW2_USER_DATA_FOLDER, expected.webviewDataPath);
    assert.equal(Object.hasOwn(child, 'GITHUB_TOKEN'), false);
    assert.equal(Object.hasOwn(child, 'ACTIONS_ID_TOKEN_REQUEST_TOKEN'), false);
    assert.equal(Object.hasOwn(child, 'GIT_CONFIG_VALUE_0'), false);
    assert.equal(Object.hasOwn(child, 'NODE_OPTIONS'), false);
    assert.equal(Object.hasOwn(child, 'HTTP_PROXY'), false);
    assert.equal(Object.isFrozen(child), true);
    assert.throws(
      () =>
        createWindowsChildEnvironment(
          source,
          { WEBVIEW2_USER_DATA_FOLDER: expected.webviewDataPath },
          { testRoot: expected.runnerTemp },
        ),
      /explicit MORROW_USER_DATA override/,
    );
    assert.throws(
      () =>
        createWindowsChildEnvironment(
          source,
          {
            MORROW_USER_DATA: 'C:\\Users\\synthetic-user\\AppData\\Roaming\\Morrow',
            WEBVIEW2_USER_DATA_FOLDER: expected.webviewDataPath,
          },
          { testRoot: expected.runnerTemp },
        ),
      /distinct child path under its isolated parent/,
    );
  },
  completed,
);

await runScenario(
  'complete synthetic PS shape and wrong-chain or owner denial',
  async () => {
    const wrongOwner = observation();
    wrongOwner.webview.ownerSid = OTHER_SID;
    for (const invalid of [
      wrongOwner,
      observation({ rustBackend: { ...expected.rustBackend, parentProcessId: expected.driver.processId } }),
      observation({ listener: { processId: 9999, port: 4444, localAddress: '127.0.0.1' } }),
    ]) {
      const probe = createSession();
      assert.throws(() => probe.session.confirmProcessOwned(invalid));
      assert.equal(probe.session.state, 'prepared');
    }

    const driver = makeClient('happy');
    let session;
    const probe = createSession({
      driver: driver.client,
      readinessScenario: async ({
        driver: facade,
        beginRuntimeRefresh,
        verifyRuntimeIdentity,
        recordStep,
        prepared,
      }) => {
        assert.equal(prepared.fixtureKind, 'synthetic-contract-only');
        assert.equal(session.state, 'runtime-identity-confirmed');
        await facade.click('#before-refresh');
        beginRuntimeRefresh();
        await facade.refresh();
        assert.equal(session.state, 'process-owned');
        await assert.rejects(facade.click('#blocked-until-revalidation'), /identity is confirmed/);
        await verifyRuntimeIdentity();
        assert.equal(session.state, 'runtime-identity-confirmed');
        await facade.click('#after-revalidation');
        await recordStep({ fixtureOnly: true });
      },
    });
    session = probe.session;
    assert.equal(session.state, 'prepared');
    session.confirmProcessOwned(observation());
    assert.equal(session.state, 'process-owned');
    const identity = await session.confirmRuntimeIdentity();
    assert.equal(identity.platform, 'windows');
    assert.equal(identity.dataPath, expected.backendDataPath);
    assert.equal(identity.webviewDataPath, expected.webviewDataPath);
    assert.equal(session.state, 'runtime-identity-confirmed');
    await session.runReadinessScenario();
    assert.equal(session.state, 'ready');
    assert.deepEqual(driver.calls.execute, [RUNTIME_INFO_QUERY, RUNTIME_INFO_QUERY]);
    assert.deepEqual(driver.calls.clicks, ['#before-refresh', '#after-revalidation']);
    assert.deepEqual(driver.calls.refreshes, [true]);
    assert.equal(probe.evidenceCalls.length, 1);
  },
  completed,
);

await runScenario(
  'facade blocks raw session and lifecycle bypasses',
  async () => {
    const driver = makeClient('facade');
    const probe = createSession({ driver: driver.client });
    probe.session.confirmProcessOwned(observation());
    await probe.session.confirmRuntimeIdentity();

    assert.throws(() => probe.session.driver.path('/session'), /current UI session allowlist/);
    await assert.rejects(
      probe.session.driver.request('POST', '/session', {}),
      /outside the current UI session/,
    );
    await assert.rejects(
      probe.session.driver.request('POST', '/session/session-facade/refresh', {}),
      /outside the current UI session allowlist/,
    );
    await assert.rejects(
      probe.session.driver.createSession('C:\\runner\\temp\\synthetic\\morrow.exe'),
      /after gate 181/,
    );
    assert.equal(driver.calls.paths.length, 0);
    assert.equal(driver.calls.requests.length, 0);
    assert.equal(driver.calls.createSessions, 0);
  },
  completed,
);

await runScenario(
  'cached client references become stale across restart',
  async () => {
    const oldClient = makeClient('old');
    const newClient = makeClient('new');
    let session;
    let initialOldExecuteCount = 0;
    const probe = createSession({
      driver: oldClient.client,
      restartSession: async () => newClient.client,
      readinessScenario: async ({ driver: facade, restartSession }) => {
        const cached = Object.fromEntries(
          ['execute', 'refresh', 'screenshot', 'click', 'path', 'request'].map((method) => [
            method,
            facade[method],
          ]),
        );
        const confirmIdentityFromBeforeRestart = session.confirmRuntimeIdentity;
        await restartSession();
        assert.equal(session.state, 'process-owned');
        await confirmIdentityFromBeforeRestart();
        assert.equal(session.state, 'runtime-identity-confirmed');
        assert.equal(oldClient.calls.execute.length, initialOldExecuteCount);
        assert.deepEqual(newClient.calls.execute, [RUNTIME_INFO_QUERY]);

        await assert.rejects(cached.execute('return document.title'), /reference is stale/);
        await assert.rejects(cached.refresh(), /reference is stale/);
        await assert.rejects(cached.screenshot(expected.evidencePath + '\\stale.png'), /reference is stale/);
        await assert.rejects(cached.click('#stale'), /reference is stale/);
        assert.throws(() => cached.path('/element/item-1/click'), /reference is stale/);
        await assert.rejects(
          cached.request('POST', '/session/session-old/element/item-1/click', {}),
          /reference is stale/,
        );

        assert.equal(oldClient.calls.execute.length, initialOldExecuteCount);
        assert.equal(oldClient.calls.requests.length, 0);
        assert.equal(oldClient.calls.clicks.length, 0);
        assert.equal(oldClient.calls.refreshes.length, 0);
        assert.equal(oldClient.calls.screenshots.length, 0);
        assert.equal(newClient.calls.requests.length, 0);
        assert.equal(newClient.calls.clicks.length, 0);

        await facade.click('#current-client');
        assert.deepEqual(newClient.calls.clicks, ['#current-client']);
        assert.equal(oldClient.calls.clicks.length, 0);
      },
    });
    session = probe.session;
    session.confirmProcessOwned(observation());
    await session.confirmRuntimeIdentity();
    initialOldExecuteCount = oldClient.calls.execute.length;
    await session.runReadinessScenario();
    assert.equal(session.state, 'ready');
    assert.equal(session.generation, 1);
  },
  completed,
);

const adapterBytesAfter = await readFile(adapterPath);
const adapterSha256After = createHash('sha256').update(adapterBytesAfter).digest('hex');
assert.equal(
  adapterSha256After,
  adapterSha256,
  'the reviewed input module must remain unchanged during the probe',
);

console.log(
  JSON.stringify(
    {
      status: 'passed',
      scope: 'independent JavaScript contract probes with synthetic fixtures only',
      adapterSha256,
      scenariosPassed: completed.length,
      scenarios: completed,
      appLaunched: false,
      driverServiceStarted: false,
      webviewProcessLaunched: false,
      nativeWindowsReadinessTested: false,
      guiTested: false,
    },
    null,
    2,
  ),
);
