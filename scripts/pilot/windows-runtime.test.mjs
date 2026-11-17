import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createWindowsChildEnvironment,
  createWindowsRuntimeSession,
  WINDOWS_RUNTIME_STATES,
} from './windows-runtime.mjs';

const SID = 'S-1-5-21-1200000000-1200000001-1200000002-1001';
const expected = {
  ownerSid: SID,
  driverPort: 4444,
  runnerTemp: 'C:\\runner\\temp\\issue-180',
  backendDataPath: 'C:\\runner\\temp\\issue-180\\profile\\backend',
  webviewDataPath: 'C:\\runner\\temp\\issue-180\\profile\\webview',
  vaultPath: 'C:\\runner\\temp\\issue-180\\profile\\vault',
  evidencePath: 'C:\\runner\\temp\\issue-180\\profile\\evidence',
  driver: {
    processId: 4100,
    parentProcessId: 3900,
    executablePath: 'C:\\tools\\tauri-driver.exe',
    executableSha256: 'a'.repeat(64),
    creationTimeUtc: '2026-11-16T10:00:00.000Z',
    ownerSid: SID,
  },
  nativeDriver: {
    executablePath: 'C:\\tools\\msedgedriver.exe',
    executableSha256: 'd'.repeat(64),
    ownerSid: SID,
  },
  rustBackend: {
    executablePath: 'C:\\runner\\temp\\issue-180\\package\\morrow.exe',
    executableSha256: 'b'.repeat(64),
    ownerSid: SID,
  },
  webview: {
    executablePath:
      'C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\156.0.0.0\\msedgewebview2.exe',
    executableSha256: 'c'.repeat(64),
    ownerSid: SID,
  },
};

function processRecord(overrides = {}) {
  return {
    processId: 4100,
    parentProcessId: 3900,
    executablePath: 'C:\\tools\\tauri-driver.exe',
    executableSha256: 'a'.repeat(64),
    creationTimeUtc: '2026-11-16T10:00:00.000Z',
    ownerSid: SID,
    ...overrides,
  };
}

function nativeDriverRecord(overrides = {}) {
  return processRecord({
    processId: 4150,
    parentProcessId: 4100,
    executablePath: 'C:\\tools\\msedgedriver.exe',
    executableSha256: 'd'.repeat(64),
    creationTimeUtc: '2026-11-16T10:00:01.000Z',
    ...overrides,
  });
}

function rustBackendRecord(overrides = {}) {
  return processRecord({
    processId: 4200,
    parentProcessId: 4150,
    executablePath: 'C:\\runner\\temp\\issue-180\\package\\morrow.exe',
    executableSha256: 'b'.repeat(64),
    creationTimeUtc: '2026-11-16T10:00:02.000Z',
    ...overrides,
  });
}

function webviewRecord(overrides = {}) {
  return processRecord({
    processId: 4300,
    parentProcessId: 4200,
    executablePath:
      'C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\156.0.0.0\\msedgewebview2.exe',
    executableSha256: 'c'.repeat(64),
    creationTimeUtc: '2026-11-16T10:00:03.000Z',
    commandLineUserDataDir: expected.webviewDataPath,
    ...overrides,
  });
}

function ownedProcessObservation(overrides = {}) {
  return {
    driver: processRecord(),
    nativeDriver: nativeDriverRecord(),
    listener: { processId: 4100, port: 4444, localAddress: '127.0.0.1' },
    rustBackend: rustBackendRecord(),
    webview: webviewRecord(),
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

function createSession({
  expectedIdentity = expected,
  driverPort,
  driverBase = 'http://127.0.0.1:4444',
  runtimeInfo = { platform: 'windows', dataPath: expected.backendDataPath },
  observe = ownedProcessObservation,
  readinessScenario = async () => {},
  onExecute = () => {},
  restartDriver,
  candidate = {},
} = {}) {
  const calls = {
    execute: [],
    requests: [],
    screenshots: 0,
    refreshes: 0,
    readiness: 0,
    functional: 0,
    evidence: 0,
    restarts: 0,
  };
  const driver = {
    base: driverBase,
    sessionId: 'session-current',
    path(suffix) {
      return `/session/${this.sessionId}${suffix}`;
    },
    async request(method, endpoint, body) {
      calls.requests.push({ method, endpoint, body });
      return null;
    },
    async execute(script) {
      calls.execute.push(script);
      onExecute(script);
      return runtimeInfo;
    },
    async screenshot() {
      calls.screenshots += 1;
    },
    async refresh() {
      calls.refreshes += 1;
    },
    async elements() {},
    async element() {},
    async click() {},
    async clear() {},
    async sendKeys() {},
    async text() {},
    async attribute() {},
  };
  const session = createWindowsRuntimeSession({
    driver,
    driverPort,
    expected: expectedIdentity,
    observeOwnedProcesses: observe,
    candidate: {
      vault: expectedIdentity.vaultPath,
      evidence: expectedIdentity.evidencePath,
      expectedBackendDataPath: expectedIdentity.backendDataPath,
      expectedWebviewDataPath: expectedIdentity.webviewDataPath,
      ...candidate,
    },
    prepared: { fixtureKind: 'synthetic-contract-only' },
    restartSession: async () => {
      calls.restarts += 1;
      return typeof restartDriver === 'function' ? restartDriver(driver) : (restartDriver ?? driver);
    },
    recordStep: async () => {
      calls.evidence += 1;
    },
    readinessScenario: async (...args) => {
      calls.readiness += 1;
      return readinessScenario(...args);
    },
    functionalScenario: async () => {
      calls.functional += 1;
    },
  });
  return { session, calls };
}

test('Windows runtime exposes explicit states without importing a launch entrypoint', () => {
  assert.deepEqual(WINDOWS_RUNTIME_STATES, [
    'prepared',
    'process-owned',
    'runtime-identity-confirmed',
    'ready',
  ]);
  const { session, calls } = createSession();
  assert.equal(session.state, 'prepared');
  assert.equal(calls.execute.length, 0);
  assert.equal(calls.readiness, 0);
  assert.equal(calls.functional, 0);
  assert.equal(calls.screenshots, 0);
});

test('shared WebDriver client is pinned to the owned loopback:4444 listener', () => {
  assert.throws(() => createSession({ driverBase: 'http://localhost:4444' }), /loopback:4444 listener/);
  assert.throws(() => createSession({ driverPort: 5555 }), /loopback:4444 listener/);
});

test('child environment keeps only allowlisted keys and explicit isolated profiles', () => {
  const source = {
    SystemRoot: 'C:\\Windows',
    WINDIR: 'C:\\Windows',
    Path: 'C:\\Windows\\System32',
    RUNNER_TEMP: 'C:\\runner\\temp',
    TEMP: 'C:\\runner\\temp',
    TMP: 'C:\\runner\\temp',
    USERPROFILE: 'C:\\runner\\user',
    LOCALAPPDATA: 'C:\\runner\\user\\AppData\\Local',
    APPDATA: 'C:\\runner\\user\\AppData\\Roaming',
    MORROW_USER_DATA: 'C:\\runner\\user\\AppData\\Roaming\\Morrow',
    WEBVIEW2_USER_DATA_FOLDER: 'C:\\runner\\user\\AppData\\Local\\WebView2',
    GITHUB_TOKEN: 'synthetic-secret-marker',
    GH_TOKEN: 'synthetic-secret-marker',
    ACTIONS_RUNTIME_TOKEN: 'synthetic-secret-marker',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-secret-marker',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.invalid/request',
    ACTIONS_CACHE_URL: 'https://cache.invalid',
    GITHUB_ACTIONS: 'true',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraheader',
    GIT_CONFIG_VALUE_0: 'synthetic-secret-marker',
    GIT_ASKPASS: 'synthetic-helper',
    NODE_OPTIONS: '--require synthetic-hook',
    AWS_ACCESS_KEY_ID: 'synthetic-secret-marker',
    TAURI_SIGNING_PRIVATE_KEY: 'synthetic-secret-marker',
    HTTP_PROXY: 'https://proxy.invalid',
    GITHUB_WORKSPACE: 'C:\\runner\\_work\\Morrow',
  };
  const child = createWindowsChildEnvironment(
    source,
    {
      MORROW_USER_DATA: expected.backendDataPath,
      WEBVIEW2_USER_DATA_FOLDER: expected.webviewDataPath,
    },
    { testRoot: expected.runnerTemp },
  );

  assert.deepEqual(
    Object.keys(child).sort(),
    [
      'APPDATA',
      'LOCALAPPDATA',
      'MORROW_USER_DATA',
      'PATH',
      'SYSTEMROOT',
      'TEMP',
      'TMP',
      'USERPROFILE',
      'WEBVIEW2_USER_DATA_FOLDER',
      'WINDIR',
    ].sort(),
  );
  for (const key of [
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'ACTIONS_RUNTIME_TOKEN',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'ACTIONS_CACHE_URL',
    'GITHUB_ACTIONS',
    'GIT_CONFIG_VALUE_0',
    'GIT_ASKPASS',
    'NODE_OPTIONS',
    'AWS_ACCESS_KEY_ID',
    'TAURI_SIGNING_PRIVATE_KEY',
    'HTTP_PROXY',
    'GITHUB_WORKSPACE',
  ]) {
    assert.equal(Object.hasOwn(child, key), false, `${key} must not be inherited`);
  }
  assert.equal(Object.values(child).includes('synthetic-secret-marker'), false);
  assert.equal(child.MORROW_USER_DATA, expected.backendDataPath);
  assert.equal(child.WEBVIEW2_USER_DATA_FOLDER, expected.webviewDataPath);
  assert.equal(Object.hasOwn(child, 'RUNNER_TEMP'), false);
  assert.equal(Object.isFrozen(child), true);
  assert.throws(
    () =>
      createWindowsChildEnvironment(
        source,
        { GITHUB_TOKEN: 'synthetic-secret-marker' },
        { testRoot: expected.runnerTemp },
      ),
    /forbidden/,
  );
  assert.throws(
    () =>
      createWindowsChildEnvironment(
        source,
        { GIT_CONFIG_VALUE_0: 'synthetic-secret-marker' },
        { testRoot: expected.runnerTemp },
      ),
    /forbidden/,
  );
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
        { MORROW_USER_DATA: expected.backendDataPath },
        { testRoot: expected.runnerTemp },
      ),
    /explicit WEBVIEW2_USER_DATA_FOLDER override/,
  );
  assert.throws(
    () =>
      createWindowsChildEnvironment(
        source,
        {
          MORROW_USER_DATA: 'C:\\Users\\runner\\AppData\\Roaming\\Morrow',
          WEBVIEW2_USER_DATA_FOLDER: expected.webviewDataPath,
        },
        { testRoot: expected.runnerTemp },
      ),
    /distinct child path under its isolated parent/,
  );
  assert.throws(
    () =>
      createWindowsChildEnvironment(
        source,
        {
          MORROW_USER_DATA: `${expected.backendDataPath}:stream`,
          WEBVIEW2_USER_DATA_FOLDER: expected.webviewDataPath,
        },
        { testRoot: expected.runnerTemp },
      ),
    /alternate data stream/,
  );
  assert.throws(
    () =>
      createWindowsChildEnvironment(
        source,
        {
          MORROW_USER_DATA: `${expected.runnerTemp}\\profile\\..\\outside`,
          WEBVIEW2_USER_DATA_FOLDER: expected.webviewDataPath,
        },
        { testRoot: expected.runnerTemp },
      ),
    /canonical local Windows path|absolute local Windows path|path alias/,
  );
  assert.throws(
    () =>
      createWindowsChildEnvironment(
        source,
        {
          MORROW_USER_DATA: `${expected.runnerTemp}\\profile\\MORROW~1`,
          WEBVIEW2_USER_DATA_FOLDER: expected.webviewDataPath,
        },
        { testRoot: expected.runnerTemp },
      ),
    /path alias/,
  );
  assert.throws(
    () =>
      createWindowsChildEnvironment(
        source,
        {
          MORROW_USER_DATA: expected.backendDataPath,
          morrow_user_data: expected.backendDataPath,
          WEBVIEW2_USER_DATA_FOLDER: expected.webviewDataPath,
        },
        { testRoot: expected.runnerTemp },
      ),
    /Duplicate Windows environment override/,
  );
});

test('UI, screenshot, readiness, functional callbacks, and session launch stay blocked before identity', async () => {
  const { session, calls } = createSession();
  await assert.rejects(session.driver.execute('return document.title'), /identity is confirmed/);
  await assert.rejects(
    session.driver.execute('return { info: window.__MORROW_INFO__, title: document.title }'),
    /identity is confirmed/,
  );
  await assert.rejects(session.driver.screenshot('ignored.png'), /identity is confirmed/);
  await assert.rejects(session.driver.click('#save'), /identity is confirmed/);
  await assert.rejects(session.driver.createSession('C:\\runner\\temp\\morrow.exe'), /after gate 181/);
  await assert.rejects(session.runReadinessScenario(), /identity is confirmed/);
  await assert.rejects(session.runFunctionalScenario(), /gated native readiness/);
  assert.deepEqual(calls, {
    execute: [],
    requests: [],
    screenshots: 0,
    refreshes: 0,
    readiness: 0,
    functional: 0,
    evidence: 0,
    restarts: 0,
  });
});

test('before identity, the only permitted WebDriver script is the runtime identity query', async () => {
  const { session, calls } = createSession();
  session.confirmProcessOwned(ownedProcessObservation());
  await assert.rejects(session.driver.execute('return document.title'), /identity is confirmed/);
  await assert.rejects(
    session.driver.execute('return { info: window.__MORROW_INFO__, title: document.title }'),
    /identity is confirmed/,
  );
  assert.deepEqual(calls.execute, []);

  await session.driver.execute('return window.__MORROW_INFO__ || null');
  assert.deepEqual(calls.execute, ['return window.__MORROW_INFO__ || null']);
  assert.equal(session.state, 'runtime-identity-confirmed');
  assert.equal(calls.readiness, 0);
  assert.equal(calls.functional, 0);
  assert.equal(calls.evidence, 0);
  assert.equal(calls.screenshots, 0);
});

test('facade limits raw WebDriver access to UI routes on the current session', async () => {
  const { session, calls } = createSession();
  session.confirmProcessOwned(ownedProcessObservation());
  await session.confirmRuntimeIdentity();

  const currentClickPath = session.driver.path('/element/item-7/click');
  assert.equal(currentClickPath, '/session/session-current/element/item-7/click');
  await session.driver.request('POST', currentClickPath, {});
  assert.deepEqual(calls.requests, [{ method: 'POST', endpoint: currentClickPath, body: {} }]);

  await assert.rejects(session.driver.request('POST', '/session', {}), /outside the current UI session/);
  await assert.rejects(
    session.driver.request('POST', '/session/session-current/refresh', {}),
    /outside the current UI session allowlist/,
  );
  await assert.rejects(
    session.driver.request('POST', '/session/session-current/window', {}),
    /outside the current UI session allowlist/,
  );
  await assert.rejects(
    session.driver.request('POST', '/session/old-session/element/item-7/click', {}),
    /outside the current UI session/,
  );
  assert.throws(() => session.driver.path('/refresh'), /outside the current UI session allowlist/);
  assert.throws(() => session.driver.path('/session'), /outside the current UI session allowlist/);
  assert.throws(() => session.driver.base, /blocked by the Windows runtime facade/);
  assert.throws(() => session.driver.sessionId, /blocked by the Windows runtime facade/);
  assert.throws(() => session.driver.closeSession(), /blocked by the Windows runtime facade/);
  await assert.rejects(session.driver.createSession('C:\\runner\\temp\\morrow.exe'), /after gate 181/);

  await session.driver.screenshot(`${expected.evidencePath}\\capture.png`);
  await assert.rejects(
    session.driver.screenshot(`${expected.evidencePath}\\nested\\capture.png`),
    /direct children of the owned evidence directory/,
  );
  assert.equal(calls.screenshots, 1);
  assert.equal(calls.requests.length, 1, 'blocked protocol calls must not reach the client');
});

test('ownership validates every process tuple, driver edge, loopback listener, and isolated path proof', () => {
  const invalidObservations = [
    ownedProcessObservation({ driver: processRecord({ processId: 4101 }) }),
    ownedProcessObservation({ driver: processRecord({ parentProcessId: 3901 }) }),
    ownedProcessObservation({ driver: processRecord({ executablePath: 'C:\\tools\\other.exe' }) }),
    ownedProcessObservation({ driver: processRecord({ executablePath: 'C:relative\\tauri-driver.exe' }) }),
    ownedProcessObservation({ nativeDriver: nativeDriverRecord({ processId: 4151 }) }),
    ownedProcessObservation({ nativeDriver: nativeDriverRecord({ parentProcessId: 4101 }) }),
    ownedProcessObservation({ nativeDriver: nativeDriverRecord({ executableSha256: 'e'.repeat(64) }) }),
    ownedProcessObservation({ nativeDriver: nativeDriverRecord({ creationTimeUtc: 'not-a-time' }) }),
    ownedProcessObservation({ nativeDriver: nativeDriverRecord({ ownerSid: 'S-1-5-21-9-9-9-9' }) }),
    ownedProcessObservation({ driver: processRecord({ executableSha256: 'd'.repeat(64) }) }),
    ownedProcessObservation({ driver: processRecord({ creationTimeUtc: '2026-11-16T10:00:03.000Z' }) }),
    ownedProcessObservation({ driver: processRecord({ ownerSid: 'S-1-5-21-9-9-9-9' }) }),
    ownedProcessObservation({ listener: { processId: 9999, port: 4444, localAddress: '127.0.0.1' } }),
    ownedProcessObservation({ listener: { processId: 4100, port: 5555, localAddress: '127.0.0.1' } }),
    ownedProcessObservation({ listener: { processId: 4100, port: 4444, localAddress: '0.0.0.0' } }),
    ownedProcessObservation({ rustBackend: rustBackendRecord({ parentProcessId: 4100 }) }),
    ownedProcessObservation({ rustBackend: rustBackendRecord({ executablePath: 'C:\\runner\\other.exe' }) }),
    ownedProcessObservation({ rustBackend: rustBackendRecord({ executableSha256: 'f'.repeat(64) }) }),
    ownedProcessObservation({ webview: webviewRecord({ parentProcessId: 4150 }) }),
    ownedProcessObservation({ webview: webviewRecord({ executableSha256: 'f'.repeat(64) }) }),
    ownedProcessObservation({ webview: webviewRecord({ ownerSid: 'S-1-5-21-9-9-9-9' }) }),
    ownedProcessObservation({ webview: webviewRecord({ creationTimeUtc: 'not-a-time' }) }),
    ownedProcessObservation({
      webview: webviewRecord({
        executablePath: 'C:\\Program Files\\Microsoft\\EdgeWebView\\msedgewebview2.exe',
        commandLineUserDataDir: 'C:\\runner\\user\\AppData\\Local\\WebView2',
      }),
    }),
    ownedProcessObservation({
      isolatedPaths: {
        backendPath: expected.backendDataPath,
        backendUnderRunnerTemp: false,
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
    }),
    ownedProcessObservation({
      isolatedPaths: {
        ...ownedProcessObservation().isolatedPaths,
        backendPath: `${expected.backendDataPath}:profile`,
      },
    }),
    ownedProcessObservation({
      isolatedPaths: {
        ...ownedProcessObservation().isolatedPaths,
        webviewPath: '\\\\server\\share\\profile',
      },
    }),
    ownedProcessObservation({
      isolatedPaths: {
        ...ownedProcessObservation().isolatedPaths,
        vaultUnderRunnerTemp: false,
      },
    }),
    ownedProcessObservation({
      isolatedPaths: {
        ...ownedProcessObservation().isolatedPaths,
        evidenceNoReparse: false,
      },
    }),
  ];
  for (const observation of invalidObservations) {
    const { session } = createSession();
    assert.throws(() => session.confirmProcessOwned(observation));
    assert.equal(session.state, 'prepared');
  }
  assert.throws(
    () => createSession({ expectedIdentity: { ...expected, driverPort: 5555 } }),
    /shared WebDriver client must target the owned loopback:4444 listener/,
  );
});

test('candidate vault and evidence must stay below the isolated runner temporary root', () => {
  assert.throws(
    () =>
      createSession({
        expectedIdentity: { ...expected, vaultPath: 'C:\\Users\\runner\\Documents\\Vault' },
      }),
    /synthetic vault path must be a distinct child path/,
  );
  assert.throws(
    () =>
      createSession({
        expectedIdentity: { ...expected, evidencePath: 'C:\\runner\\temp\\issue-180' },
      }),
    /evidence path must be a distinct child path/,
  );
  assert.throws(
    () =>
      createSession({
        candidate: { expectedBackendDataPath: 'C:\\runner\\user\\AppData\\Local\\Morrow' },
      }),
    /candidate backend data path does not match/,
  );
  assert.throws(
    () =>
      createSession({
        candidate: { expectedWebviewDataPath: 'C:\\runner\\user\\AppData\\Local\\WebView2' },
      }),
    /candidate WebView2 data path does not match/,
  );
});

test('synthetic identity contract refresh and restart invalidate identity without producing readiness', async () => {
  const { session, calls } = createSession();
  session.confirmProcessOwned(ownedProcessObservation());
  assert.equal(session.state, 'process-owned');
  const identity = await session.confirmRuntimeIdentity();
  assert.deepEqual(identity, {
    platform: 'windows',
    dataPath: expected.backendDataPath,
    webviewDataPath: expected.webviewDataPath,
    backendIdentityMatches: true,
    webviewIdentityMatches: true,
    processOwnerMatches: true,
    generation: 0,
  });
  assert.equal(session.state, 'runtime-identity-confirmed');
  assert.equal(calls.readiness, 0);
  assert.equal(calls.functional, 0);
  assert.equal(calls.evidence, 0);
  assert.equal(calls.screenshots, 0);

  await session.driver.refresh();
  assert.equal(session.state, 'process-owned');
  assert.equal(session.generation, 1);
  assert.equal(calls.refreshes, 1);
  await assert.rejects(session.driver.execute('return document.title'), /identity is confirmed/);

  await session.confirmRuntimeIdentity();
  session.invalidateForRestart();
  assert.equal(session.state, 'prepared');
  assert.equal(session.generation, 2);
  await assert.rejects(session.driver.screenshot('ignored.png'), /identity is confirmed/);
  assert.equal(calls.readiness, 0);
  assert.equal(calls.functional, 0);
  assert.equal(calls.evidence, 0);
  assert.equal(calls.screenshots, 0);
});

test('synthetic restart revalidates the new process chain without claiming runtime readiness', async () => {
  let session;
  let restarted = false;
  const observe = () => {
    if (!restarted) return ownedProcessObservation();
    const observation = ownedProcessObservation();
    observation.rustBackend = rustBackendRecord({
      processId: 5200,
      parentProcessId: 4150,
      creationTimeUtc: '2026-11-16T10:02:00.000Z',
    });
    observation.webview = webviewRecord({
      processId: 5300,
      parentProcessId: 5200,
      creationTimeUtc: '2026-11-16T10:02:01.000Z',
    });
    return observation;
  };
  const { session: created, calls } = createSession({
    observe,
    readinessScenario: async ({ driver, restartSession, verifyRuntimeIdentity }) => {
      restarted = true;
      const restartedDriver = await restartSession();
      assert.equal(restartedDriver, session.driver);
      assert.equal(session.state, 'process-owned');
      await assert.rejects(driver.click('#save'), /identity is confirmed/);
      await verifyRuntimeIdentity();
      assert.equal(session.state, 'runtime-identity-confirmed');
      throw new Error('synthetic contract stops before real readiness');
    },
  });
  session = created;
  session.confirmProcessOwned(ownedProcessObservation());
  await session.confirmRuntimeIdentity();
  await assert.rejects(session.runReadinessScenario(), /stops before real readiness/);
  assert.equal(session.state, 'runtime-identity-confirmed');
  assert.equal(session.generation, 1);
  assert.equal(calls.restarts, 1);
  assert.equal(calls.readiness, 1);
  assert.equal(calls.functional, 0);
});

test('facade references cached before restart are invalidated after the new client identity is confirmed', async () => {
  let session;
  let restartRequested = false;
  const nextCalls = { execute: [], requests: [], screenshots: 0, refreshes: 0 };
  const nextDriver = {
    base: 'http://127.0.0.1:4444',
    sessionId: 'session-next',
    path(suffix) {
      return `/session/${this.sessionId}${suffix}`;
    },
    async request(method, endpoint, body) {
      nextCalls.requests.push({ method, endpoint, body });
      return null;
    },
    async execute(script) {
      nextCalls.execute.push(script);
      return { platform: 'windows', dataPath: expected.backendDataPath };
    },
    async screenshot() {
      nextCalls.screenshots += 1;
    },
    async refresh() {
      nextCalls.refreshes += 1;
    },
    async elements() {},
    async element() {},
    async click() {},
    async clear() {},
    async sendKeys() {},
    async text() {},
    async attribute() {},
  };
  let cachedConfirmRuntimeIdentity;
  const { session: created, calls } = createSession({
    observe: () => {
      if (!restartRequested) return ownedProcessObservation();
      return ownedProcessObservation({
        rustBackend: rustBackendRecord({
          processId: 5200,
          parentProcessId: 4150,
          creationTimeUtc: '2026-11-16T10:02:00.000Z',
        }),
        webview: webviewRecord({
          processId: 5300,
          parentProcessId: 5200,
          creationTimeUtc: '2026-11-16T10:02:01.000Z',
        }),
      });
    },
    restartDriver: () => {
      restartRequested = true;
      return nextDriver;
    },
    readinessScenario: async ({ driver, restartSession }) => {
      const cached = Object.fromEntries(
        [
          'execute',
          'refresh',
          'screenshot',
          'elements',
          'element',
          'click',
          'clear',
          'sendKeys',
          'text',
          'attribute',
          'path',
          'request',
        ].map((method) => [method, driver[method]]),
      );
      const oldEndpoint = cached.path('/element/item-1/click');

      await restartSession();
      assert.equal(session.state, 'process-owned');
      await cachedConfirmRuntimeIdentity();
      assert.equal(session.state, 'runtime-identity-confirmed');
      assert.deepEqual(nextCalls.execute, ['return window.__MORROW_INFO__ || null']);
      assert.equal(
        calls.execute.length,
        1,
        'the old client must not receive the post-restart identity query',
      );

      await assert.rejects(cached.execute('return document.title'), /reference is stale/);
      await assert.rejects(cached.refresh(), /reference is stale/);
      await assert.rejects(cached.screenshot(`${expected.evidencePath}\\stale.png`), /reference is stale/);
      for (const method of ['elements', 'element', 'click', 'clear', 'sendKeys', 'text', 'attribute']) {
        await assert.rejects(cached[method]('#item'), /reference is stale/);
      }
      assert.throws(() => cached.path('/element/item-1/click'), /reference is stale/);
      await assert.rejects(cached.request('POST', oldEndpoint, {}), /reference is stale/);
      assert.equal(calls.requests.length, 0);
      assert.equal(calls.refreshes, 0);
      assert.equal(calls.screenshots, 0);

      await driver.request('POST', driver.path('/element/item-1/click'), {});
      assert.equal(session.state, 'runtime-identity-confirmed');
      throw new Error('synthetic contract stops before real readiness');
    },
  });
  session = created;
  cachedConfirmRuntimeIdentity = session.confirmRuntimeIdentity;
  session.confirmProcessOwned(ownedProcessObservation());
  await session.confirmRuntimeIdentity();
  await assert.rejects(session.runReadinessScenario(), /stops before real readiness/);
  assert.deepEqual(nextCalls.execute, ['return window.__MORROW_INFO__ || null']);
  assert.equal(nextCalls.requests.length, 1);
  assert.equal(nextCalls.requests[0].endpoint, '/session/session-next/element/item-1/click');
  assert.equal(calls.requests.length, 0);
  assert.equal(session.state, 'runtime-identity-confirmed');
  assert.equal(session.generation, 1);
});

test('a stale full process chain after refresh cannot regain identity or UI access', async () => {
  let observations = 0;
  const observe = () => {
    observations += 1;
    const result = ownedProcessObservation();
    if (observations >= 3) {
      result.nativeDriver.creationTimeUtc = '2026-11-16T10:01:00.000Z';
    }
    return result;
  };
  const { session, calls } = createSession({ observe });
  session.confirmProcessOwned(ownedProcessObservation());
  await session.confirmRuntimeIdentity();
  await session.driver.refresh();
  assert.equal(session.state, 'process-owned');
  await assert.rejects(session.confirmRuntimeIdentity(), /creation time changed/);
  await assert.rejects(session.driver.click('#save'), /identity is confirmed/);
  assert.equal(session.state, 'process-owned');
  assert.equal(calls.execute.length, 1);
  assert.equal(calls.refreshes, 1);
});

test('refresh cannot overlap an in-flight runtime identity query', async () => {
  let resolveRuntimeInfo;
  let signalQueryStarted;
  const queryStarted = new Promise((resolve) => {
    signalQueryStarted = resolve;
  });
  const runtimeInfo = new Promise((resolve) => {
    resolveRuntimeInfo = resolve;
  });
  const { session, calls } = createSession({
    runtimeInfo,
    onExecute: signalQueryStarted,
  });
  session.confirmProcessOwned(ownedProcessObservation());
  const pendingIdentity = session.confirmRuntimeIdentity();
  await queryStarted;
  await assert.rejects(session.driver.refresh(), /another runtime operation is in progress/);
  resolveRuntimeInfo({ platform: 'windows', dataPath: expected.backendDataPath });
  await pendingIdentity;
  assert.equal(session.state, 'runtime-identity-confirmed');
  assert.equal(calls.refreshes, 0);
});

test('readiness callback refreshes through the identity seam and cannot claim ready when it aborts', async () => {
  let session;
  const { session: created, calls } = createSession({
    readinessScenario: async ({ driver, beginRuntimeRefresh, verifyRuntimeIdentity }) => {
      beginRuntimeRefresh();
      await driver.refresh();
      await assert.rejects(driver.execute('return document.title'), /identity is confirmed/);
      await verifyRuntimeIdentity();
      await assert.rejects(session.runFunctionalScenario(), /gated native readiness/);
      throw new Error('synthetic callback deliberately stopped before ready');
    },
  });
  session = created;
  session.confirmProcessOwned(ownedProcessObservation());
  await session.confirmRuntimeIdentity();
  await assert.rejects(session.runReadinessScenario(), /stopped before ready/);
  assert.equal(session.state, 'runtime-identity-confirmed');
  assert.equal(session.generation, 1);
  assert.equal(calls.refreshes, 1);
  assert.equal(calls.functional, 0);
  assert.equal(calls.evidence, 0);
  assert.equal(calls.screenshots, 0);
});

test('runtime identity rejects a non-Windows platform, wrong backend path, and a recycled PID', async () => {
  const mismatches = [
    {
      runtimeInfo: { platform: 'linux', dataPath: expected.backendDataPath },
      observe: ownedProcessObservation,
      error: /platform is not Windows/,
    },
    {
      runtimeInfo: { platform: 'windows', dataPath: 'C:\\runner\\user\\AppData\\Local\\Morrow' },
      observe: ownedProcessObservation,
      error: /dataPath does not match/,
    },
    {
      runtimeInfo: {
        platform: 'windows',
        dataPath: expected.backendDataPath,
        webviewDataPath: 'C:\\runner\\user\\AppData\\Local\\WebView2',
      },
      observe: ownedProcessObservation,
      error: /webviewDataPath does not match/,
    },
    {
      runtimeInfo: { platform: 'windows', dataPath: expected.backendDataPath },
      observe: (() => {
        let reads = 0;
        return () => {
          reads += 1;
          const observation = ownedProcessObservation();
          if (reads === 1) observation.rustBackend.creationTimeUtc = '2026-11-16T10:01:00.000Z';
          return observation;
        };
      })(),
      error: /creation time changed/,
    },
    {
      runtimeInfo: { platform: 'windows', dataPath: expected.backendDataPath },
      observe: (() => {
        let reads = 0;
        return () => {
          reads += 1;
          const observation = ownedProcessObservation();
          if (reads === 2) observation.webview.creationTimeUtc = '2026-11-16T10:01:00.000Z';
          return observation;
        };
      })(),
      error: /creation time changed/,
    },
  ];

  for (const mismatch of mismatches) {
    const { session, calls } = createSession(mismatch);
    session.confirmProcessOwned(ownedProcessObservation());
    await assert.rejects(session.confirmRuntimeIdentity(), mismatch.error);
    assert.equal(session.state, 'process-owned');
    assert.equal(calls.readiness, 0);
    assert.equal(calls.functional, 0);
    assert.equal(calls.evidence, 0);
  }
});
