import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { WebDriver } from './webdriver-client.mjs';

export const WINDOWS_RUNTIME_STATES = Object.freeze([
  'prepared',
  'process-owned',
  'runtime-identity-confirmed',
  'ready',
]);

const RUNTIME_INFO_SCRIPT = 'return window.__MORROW_INFO__ || null';
const CHILD_ENV_ALLOWLIST = new Set([
  'APPDATA',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'WINDIR',
  'MORROW_USER_DATA',
  'WEBVIEW2_USER_DATA_FOLDER',
]);
const EXPLICIT_ISOLATED_ENV = new Set(['MORROW_USER_DATA', 'WEBVIEW2_USER_DATA_FOLDER']);
const PROCESS_ROLES = Object.freeze(['driver', 'nativeDriver', 'rustBackend', 'webview']);
const ISOLATED_PATH_ROLES = Object.freeze(['backend', 'webview', 'vault', 'evidence']);
const UI_REQUESTS = Object.freeze([
  { method: 'POST', suffix: /^\/element\/[A-Za-z0-9._:-]+\/elements$/ },
  { method: 'POST', suffix: /^\/element\/[A-Za-z0-9._:-]+\/(?:click|clear|value)$/ },
  { method: 'GET', suffix: /^\/element\/[A-Za-z0-9._:-]+\/(?:text|property\/value)$/ },
  { method: 'GET', suffix: /^\/element\/[A-Za-z0-9._:-]+\/attribute\/[A-Za-z0-9_.%~-]+$/ },
]);
const UI_METHODS = new Set([
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
]);

function normalizedPath(value, label) {
  if (typeof value !== 'string' || value.trim() === '' || hasControlCharacters(value)) {
    throw new Error(`${label} must be a non-empty Windows path.`);
  }
  if (value !== value.trim() || value.includes('/')) {
    throw new Error(`${label} must use a canonical local Windows path.`);
  }
  const full = path.win32.normalize(value);
  if (!/^[a-z]:\\/i.test(full) || full.startsWith('\\\\') || full !== value) {
    throw new Error(`${label} must be an absolute local Windows path.`);
  }
  const segments = full.slice(3).split('\\');
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        /[.: ]$/.test(segment) ||
        segment.includes(':') ||
        /^[^ .]{1,6}~[0-9]+(?:\..*)?$/.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment),
    )
  ) {
    throw new Error(`${label} contains a Windows path alias or alternate data stream.`);
  }
  return full.toLocaleLowerCase('en-US');
}

function hasControlCharacters(value) {
  return [...value].some((character) => character.charCodeAt(0) < 0x20);
}

function samePath(actual, expected, label) {
  if (normalizedPath(actual, label) !== normalizedPath(expected, label)) {
    throw new Error(`${label} does not match the expected isolated path.`);
  }
}

function assertDescendantPath(child, parent, label) {
  const normalizedChild = normalizedPath(child, label);
  const normalizedParent = normalizedPath(parent, `${label} parent`);
  const relative = path.win32.relative(normalizedParent, normalizedChild);
  if (
    !relative ||
    relative === '.' ||
    path.win32.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith('..\\')
  ) {
    throw new Error(`${label} must be a distinct child path under its isolated parent.`);
  }
}

function assertAtOrUnderPath(child, parent, label) {
  if (normalizedPath(child, label) === normalizedPath(parent, `${label} parent`)) return;
  assertDescendantPath(child, parent, label);
}

function assertDistinctPaths(first, second, label) {
  const normalizedFirst = normalizedPath(first, `${label} first path`);
  const normalizedSecond = normalizedPath(second, `${label} second path`);
  const isSameOrDescendant = (relative) =>
    relative === '' ||
    (!path.win32.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..\\'));
  if (
    isSameOrDescendant(path.win32.relative(normalizedFirst, normalizedSecond)) ||
    isSameOrDescendant(path.win32.relative(normalizedSecond, normalizedFirst))
  ) {
    throw new Error(`${label} must be separate isolated paths.`);
  }
}

function sha256(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${label} must be a SHA-256 digest.`);
  }
  return value.toLowerCase();
}

function assertProcessTuple(process, label) {
  if (!process || typeof process !== 'object') throw new Error(`${label} process observation is missing.`);
  for (const key of ['processId', 'parentProcessId']) {
    if (!Number.isSafeInteger(process[key]) || process[key] <= 0) {
      throw new Error(`${label} ${key} is invalid.`);
    }
  }
  normalizedPath(process.executablePath, `${label} executable path`);
  sha256(process.executableSha256, `${label} executable digest`);
  if (
    typeof process.creationTimeUtc !== 'string' ||
    !/Z$/i.test(process.creationTimeUtc) ||
    !Number.isFinite(Date.parse(process.creationTimeUtc))
  ) {
    throw new Error(`${label} creation time is invalid.`);
  }
  if (typeof process.ownerSid !== 'string' || !/^S-\d-\d+(?:-\d+)+$/i.test(process.ownerSid)) {
    throw new Error(`${label} owner SID is invalid.`);
  }
}

function assertProcessMatches(actual, expected, label) {
  assertProcessTuple(actual, label);
  if (!expected || typeof expected !== 'object') throw new Error(`${label} expected identity is missing.`);
  if (expected.processId !== undefined && actual.processId !== expected.processId) {
    throw new Error(`${label} PID changed.`);
  }
  if (expected.parentProcessId !== undefined && actual.parentProcessId !== expected.parentProcessId) {
    throw new Error(`${label} parent PID changed.`);
  }
  samePath(actual.executablePath, expected.executablePath, `${label} executable path`);
  if (
    sha256(actual.executableSha256, `${label} executable digest`) !==
    sha256(expected.executableSha256, `${label} expected executable digest`)
  ) {
    throw new Error(`${label} executable digest changed.`);
  }
  if (actual.ownerSid !== expected.ownerSid) throw new Error(`${label} owner SID changed.`);
  if (expected.creationTimeUtc !== undefined && actual.creationTimeUtc !== expected.creationTimeUtc) {
    throw new Error(`${label} creation time changed.`);
  }
}

function assertSameProcessIdentity(actual, expected, label) {
  assertProcessTuple(actual, label);
  assertProcessTuple(expected, `${label} previous`);
  for (const key of ['processId', 'parentProcessId', 'creationTimeUtc', 'ownerSid']) {
    if (actual[key] !== expected[key]) {
      const name = {
        processId: 'PID',
        parentProcessId: 'parent PID',
        creationTimeUtc: 'creation time',
        ownerSid: 'owner SID',
      }[key];
      throw new Error(`${label} ${name} changed during identity confirmation.`);
    }
  }
  samePath(actual.executablePath, expected.executablePath, `${label} executable path`);
  if (
    sha256(actual.executableSha256, `${label} executable digest`) !== expected.executableSha256.toLowerCase()
  ) {
    throw new Error(`${label} executable digest changed during identity confirmation.`);
  }
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1';
}

function validateOwnedProcessObservation(observation, expected) {
  if (!observation || typeof observation !== 'object')
    throw new Error('Windows process observation is missing.');
  if (!expected || typeof expected !== 'object')
    throw new Error('Expected Windows runner identity is missing.');
  const { driver, nativeDriver, rustBackend, webview, listener, isolatedPaths } = observation;
  for (const role of PROCESS_ROLES) {
    assertProcessMatches(
      observation[role],
      expected[role],
      {
        driver: 'WebDriver',
        nativeDriver: 'Microsoft Edge WebDriver',
        rustBackend: 'Morrow Rust backend',
        webview: 'WebView2',
      }[role],
    );
    if (observation[role].ownerSid !== expected.ownerSid) {
      throw new Error('Every process in the Windows pilot chain must run under the isolated runner SID.');
    }
  }
  if (path.win32.basename(driver.executablePath).toLowerCase() !== 'tauri-driver.exe') {
    throw new Error('The observed WebDriver process is not tauri-driver.');
  }
  if (path.win32.basename(nativeDriver.executablePath).toLowerCase() !== 'msedgedriver.exe') {
    throw new Error('The observed native WebDriver process is not msedgedriver.');
  }
  if (nativeDriver.parentProcessId !== driver.processId) {
    throw new Error('The native WebDriver is not a child of the owned tauri-driver process.');
  }
  if (rustBackend.parentProcessId !== nativeDriver.processId) {
    throw new Error('The Morrow Rust backend is not a child of the owned native WebDriver process.');
  }
  if (webview.parentProcessId !== rustBackend.processId) {
    throw new Error('The WebView2 process is not a child of the owned Morrow backend.');
  }
  if (
    path.win32.basename(webview.executablePath).toLowerCase() !== 'msedgewebview2.exe' ||
    !/\\microsoft\\edgewebview\\application\\[^\\]+\\msedgewebview2\.exe$/i.test(webview.executablePath)
  ) {
    throw new Error('The observed WebView process is not Microsoft WebView2.');
  }
  if (
    expected.driverPort !== 4444 ||
    listener?.processId !== driver.processId ||
    listener?.port !== 4444 ||
    !isLoopback(listener?.localAddress)
  ) {
    throw new Error('The WebDriver listener must be owned by tauri-driver on loopback port 4444.');
  }

  if (!isolatedPaths || typeof isolatedPaths !== 'object') {
    throw new Error('Windows isolated path proofs are missing.');
  }
  for (const role of ISOLATED_PATH_ROLES) {
    const expectedPathKey = {
      backend: 'backendDataPath',
      webview: 'webviewDataPath',
      vault: 'vaultPath',
      evidence: 'evidencePath',
    }[role];
    const label = {
      backend: 'backend data path',
      webview: 'WebView2 data path',
      vault: 'synthetic vault path',
      evidence: 'evidence path',
    }[role];
    const proof = isolatedPaths[`${role}UnderRunnerTemp`];
    const noReparse = isolatedPaths[`${role}NoReparse`];
    if (proof !== true || noReparse !== true) {
      throw new Error(`${label} was not proven under RUNNER_TEMP without reparse points.`);
    }
    samePath(isolatedPaths[`${role}Path`], expected[expectedPathKey], label);
    assertDescendantPath(expected[expectedPathKey], expected.runnerTemp, label);
  }
  assertDistinctPaths(expected.backendDataPath, expected.webviewDataPath, 'Backend and WebView2 profiles');
  samePath(webview.commandLineUserDataDir, expected.webviewDataPath, 'WebView2 --user-data-dir');
}

function assertSameOwnedObservation(actual, expected, label) {
  for (const role of PROCESS_ROLES) {
    assertSameProcessIdentity(
      actual[role],
      expected[role],
      {
        driver: 'WebDriver',
        nativeDriver: 'Microsoft Edge WebDriver',
        rustBackend: 'Morrow Rust backend',
        webview: 'WebView2',
      }[role],
    );
  }
  for (const key of ['processId', 'port', 'localAddress']) {
    if (actual.listener?.[key] !== expected.listener?.[key]) {
      throw new Error(`Windows ${label} listener ${key} changed during identity confirmation.`);
    }
  }
  for (const role of ISOLATED_PATH_ROLES) {
    const pathKey = `${role}Path`;
    samePath(
      actual.isolatedPaths?.[pathKey],
      expected.isolatedPaths?.[pathKey],
      `Windows ${label} ${role} path`,
    );
    for (const proofKey of [`${role}UnderRunnerTemp`, `${role}NoReparse`]) {
      if (actual.isolatedPaths?.[proofKey] !== expected.isolatedPaths?.[proofKey]) {
        throw new Error(`Windows ${label} ${role} path proof changed during identity confirmation.`);
      }
    }
  }
}

function isRuntimeInfoQuery(script) {
  if (typeof script !== 'string') return false;
  return script.replace(/\s+/g, ' ').trim().replace(/;$/, '') === RUNTIME_INFO_SCRIPT;
}

function assertUiSuffix(suffix) {
  if (typeof suffix !== 'string' || !UI_REQUESTS.some(({ suffix: pattern }) => pattern.test(suffix))) {
    throw new Error('The WebDriver path is outside the current UI session allowlist.');
  }
}

function assertUiRequest(activeWebDriver, method, endpoint) {
  if (typeof method !== 'string' || typeof endpoint !== 'string') {
    throw new Error('WebDriver request method and endpoint must be strings.');
  }
  const sessionId = activeWebDriver.sessionId;
  if (
    typeof sessionId !== 'string' ||
    sessionId.trim() === '' ||
    ['/', '\\', '?', '#'].some((separator) => sessionId.includes(separator))
  ) {
    throw new Error('WebDriver request requires the active session.');
  }
  const prefix = `/session/${sessionId}`;
  if (!endpoint.startsWith(prefix)) {
    throw new Error('WebDriver request is blocked outside the current UI session.');
  }
  const suffix = endpoint.slice(prefix.length);
  const normalizedMethod = method.toUpperCase();
  if (!UI_REQUESTS.some((entry) => entry.method === normalizedMethod && entry.suffix.test(suffix))) {
    throw new Error('WebDriver request is outside the current UI session allowlist.');
  }
}

function cloneSafe(value) {
  return structuredClone(value);
}

async function assertNewEvidenceFile(file) {
  let targetState;
  try {
    await lstat(file);
    targetState = 'exists';
  } catch (error) {
    targetState = error?.code === 'ENOENT' ? 'missing' : 'unknown';
  }
  if (targetState === 'missing') return;
  if (targetState === 'unknown') throw new Error('Could not verify the owned WebView evidence target.');
  throw new Error('WebView screenshots must use a new evidence file path.');
}

export function createWindowsChildEnvironment(sourceEnvironment, overrides = {}, { testRoot } = {}) {
  if (!sourceEnvironment || typeof sourceEnvironment !== 'object' || Array.isArray(sourceEnvironment)) {
    throw new Error('A source process environment object is required.');
  }
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('Environment overrides must be an object.');
  }
  if (typeof testRoot !== 'string' || testRoot.trim() === '') {
    throw new Error('An explicit isolated Windows test root is required.');
  }

  const safe = Object.create(null);
  const sourceEntries = Object.entries(sourceEnvironment);
  for (const allowed of CHILD_ENV_ALLOWLIST) {
    if (EXPLICIT_ISOLATED_ENV.has(allowed)) continue;
    const entries = sourceEntries.filter(([key]) => key.toUpperCase() === allowed);
    if (entries.length > 1) throw new Error(`Duplicate Windows environment key is ambiguous: ${allowed}.`);
    const entry = entries[0];
    if (entry) {
      if (typeof entry[1] !== 'string' || /[\0\r\n]/.test(entry[1])) {
        throw new Error(`Windows environment value is invalid: ${allowed}.`);
      }
      safe[allowed] = entry[1];
    }
  }
  const runnerTempEntries = sourceEntries.filter(([key]) => key.toUpperCase() === 'RUNNER_TEMP');
  if (
    runnerTempEntries.length !== 1 ||
    typeof runnerTempEntries[0]?.[1] !== 'string' ||
    runnerTempEntries[0][1] === '' ||
    /[\0\r\n]/.test(runnerTempEntries[0][1])
  ) {
    throw new Error('RUNNER_TEMP is required to validate isolated Windows paths.');
  }
  const runnerTemp = runnerTempEntries[0][1];
  assertAtOrUnderPath(testRoot, runnerTemp, 'Windows test root');

  const normalizedOverrides = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    const normalizedKey = key.toUpperCase();
    if (/^(?:GH|GITHUB|ACTIONS|GIT)(?:_|$)/.test(normalizedKey)) {
      throw new Error(`Credential or Git configuration environment key is forbidden: ${key}.`);
    }
    if (!CHILD_ENV_ALLOWLIST.has(normalizedKey))
      throw new Error(`Environment key is not allowlisted: ${key}.`);
    if (typeof value !== 'string' || /[\0\r\n]/.test(value))
      throw new Error(`Environment value is invalid: ${key}.`);
    if (normalizedOverrides.has(normalizedKey)) {
      throw new Error(`Duplicate Windows environment override is ambiguous: ${normalizedKey}.`);
    }
    normalizedOverrides.set(normalizedKey, value);
  }
  for (const required of EXPLICIT_ISOLATED_ENV) {
    const value = normalizedOverrides.get(required);
    if (typeof value !== 'string' || value === '') {
      throw new Error(`An explicit ${required} override is required for the isolated Windows runner.`);
    }
    assertDescendantPath(value, testRoot, `${required} path`);
    safe[required] = value;
  }

  assertDistinctPaths(
    normalizedOverrides.get('MORROW_USER_DATA'),
    normalizedOverrides.get('WEBVIEW2_USER_DATA_FOLDER'),
    'Morrow and WebView2 user data',
  );

  for (const required of ['SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE']) {
    if (typeof safe[required] !== 'string' || safe[required] === '') {
      throw new Error(`Required Windows environment value is missing: ${required}.`);
    }
  }
  return Object.freeze(safe);
}

export function createWindowsRuntimeSession({
  driver,
  driverPort,
  expected,
  observeOwnedProcesses,
  candidate,
  prepared,
  restartSession,
  recordStep,
  readinessScenario,
  functionalScenario,
}) {
  let activeWebDriver = driver ?? (Number.isInteger(driverPort) ? new WebDriver(driverPort) : null);
  if (!activeWebDriver || typeof activeWebDriver.execute !== 'function')
    throw new Error('The shared WebDriver client is required.');
  if (!expected || typeof expected !== 'object')
    throw new Error('Expected Windows runner identity is required.');
  if (
    expected.driverPort !== 4444 ||
    (driverPort !== undefined && driverPort !== expected.driverPort) ||
    activeWebDriver.base !== `http://127.0.0.1:${expected.driverPort}`
  ) {
    throw new Error('The shared WebDriver client must target the owned loopback:4444 listener.');
  }
  const expectedDriverBase = `http://127.0.0.1:${expected.driverPort}`;
  function assertOwnedDriverEndpoint(client) {
    if (client?.base !== expectedDriverBase) {
      throw new Error('The shared WebDriver client must target the owned loopback:4444 listener.');
    }
  }
  samePath(candidate?.vault, expected.vaultPath, 'synthetic vault path');
  samePath(candidate?.evidence, expected.evidencePath, 'evidence path');
  samePath(candidate?.expectedBackendDataPath, expected.backendDataPath, 'candidate backend data path');
  samePath(candidate?.expectedWebviewDataPath, expected.webviewDataPath, 'candidate WebView2 data path');
  assertDescendantPath(candidate.vault, expected.runnerTemp, 'synthetic vault path');
  assertDescendantPath(candidate.evidence, expected.runnerTemp, 'evidence path');
  if (typeof observeOwnedProcesses !== 'function')
    throw new Error('A Windows process identity observer is required.');
  if (typeof restartSession !== 'function') throw new Error('A restart callback is required.');
  if (typeof recordStep !== 'function') throw new Error('An evidence callback is required.');
  if (typeof readinessScenario !== 'function' || typeof functionalScenario !== 'function') {
    throw new Error('The native readiness and functional callbacks must be supplied by the gated caller.');
  }

  let state = 'prepared';
  let ownedProcesses = null;
  let generation = 0;
  let refreshPrepared = false;
  let lifecycleTransitionInProgress = false;
  let identityQueryInProgress = false;
  let activeUiOperations = 0;

  function assertLifecycleIdle(operation) {
    if (lifecycleTransitionInProgress || identityQueryInProgress || activeUiOperations > 0) {
      throw new Error(`${operation} is blocked while another runtime operation is in progress.`);
    }
  }

  function requireIdentity(operation) {
    assertOwnedDriverEndpoint(activeWebDriver);
    if (lifecycleTransitionInProgress || identityQueryInProgress) {
      throw new Error(`${operation} is blocked while Windows runtime identity is being revalidated.`);
    }
    if (!['runtime-identity-confirmed', 'ready'].includes(state)) {
      throw new Error(`${operation} is blocked until Windows runtime identity is confirmed.`);
    }
  }

  function assertCurrentFacadeReference(target, referenceGeneration, operation) {
    if (referenceGeneration !== generation || target !== activeWebDriver) {
      throw new Error(`${operation} reference is stale after a Windows runtime lifecycle transition.`);
    }
    assertOwnedDriverEndpoint(target);
  }

  async function runUiOperation(operation, callback) {
    requireIdentity(operation);
    const operationGeneration = generation;
    activeUiOperations += 1;
    try {
      const result = await callback();
      if (generation !== operationGeneration || !['runtime-identity-confirmed', 'ready'].includes(state)) {
        throw new Error(`${operation} was invalidated before completion.`);
      }
      return result;
    } finally {
      activeUiOperations -= 1;
    }
  }

  function confirmOwnership(observation) {
    if (state !== 'prepared')
      throw new Error('Process ownership can only be established from prepared state.');
    validateOwnedProcessObservation(observation, expected);
    ownedProcesses = cloneSafe(observation);
    state = 'process-owned';
    return state;
  }

  async function confirmRuntimeIdentityWith(queryRuntimeInfo) {
    if (state !== 'process-owned')
      throw new Error('Runtime identity can only be queried from process-owned state.');
    assertOwnedDriverEndpoint(activeWebDriver);
    assertLifecycleIdle('Runtime identity query');
    const queryGeneration = generation;
    identityQueryInProgress = true;
    try {
      const beforeQuery = await observeOwnedProcesses();
      if (queryGeneration !== generation || state !== 'process-owned') {
        throw new Error('Runtime identity query was invalidated before confirmation.');
      }
      validateOwnedProcessObservation(beforeQuery, expected);
      assertSameOwnedObservation(beforeQuery, ownedProcesses, 'pre-query');

      const runtimeInfo = await queryRuntimeInfo();
      if (queryGeneration !== generation || state !== 'process-owned') {
        throw new Error('Runtime identity query was invalidated before confirmation.');
      }
      const processObservation = await observeOwnedProcesses();
      if (queryGeneration !== generation || state !== 'process-owned') {
        throw new Error('Runtime identity query was invalidated before confirmation.');
      }
      validateOwnedProcessObservation(processObservation, expected);
      assertSameOwnedObservation(processObservation, beforeQuery, 'post-query');

      if (runtimeInfo?.platform !== 'windows') throw new Error('Morrow runtime platform is not Windows.');
      samePath(runtimeInfo?.dataPath, expected.backendDataPath, '__MORROW_INFO__.dataPath');
      if (runtimeInfo?.webviewDataPath !== undefined) {
        samePath(runtimeInfo.webviewDataPath, expected.webviewDataPath, '__MORROW_INFO__.webviewDataPath');
      }
      ownedProcesses = cloneSafe(processObservation);
      state = 'runtime-identity-confirmed';
      return Object.freeze({
        platform: 'windows',
        dataPath: expected.backendDataPath,
        webviewDataPath: expected.webviewDataPath,
        backendIdentityMatches: true,
        webviewIdentityMatches: true,
        processOwnerMatches: true,
        generation,
      });
    } finally {
      identityQueryInProgress = false;
    }
  }

  async function confirmRuntimeIdentityFromDriver() {
    assertLifecycleIdle('Runtime identity query');
    if (state === 'runtime-identity-confirmed' || state === 'ready') state = 'process-owned';
    if (state !== 'process-owned')
      throw new Error('Runtime identity can only be queried from process-owned state.');
    return confirmRuntimeIdentityWith(() => activeWebDriver.execute(RUNTIME_INFO_SCRIPT));
  }

  function invalidateForRefresh() {
    assertLifecycleIdle('Refresh');
    if (!['runtime-identity-confirmed', 'ready'].includes(state)) {
      throw new Error('Refresh is blocked until runtime identity has been confirmed.');
    }
    state = 'process-owned';
    generation += 1;
  }

  function invalidateForRestart() {
    assertLifecycleIdle('Owned process restart');
    ownedProcesses = null;
    state = 'prepared';
    generation += 1;
    refreshPrepared = false;
  }

  function beginRuntimeRefresh() {
    invalidateForRefresh();
    refreshPrepared = true;
  }

  const protectedDriver = new Proxy(Object.create(null), {
    get(_facade, property) {
      if (property === 'then') return undefined;
      if (property === Symbol.toStringTag) return 'WindowsRuntimeDriverFacade';
      if (typeof property !== 'string') return undefined;
      if (property === 'createSession') {
        return async () => {
          throw new Error(
            'Starting Morrow or a driver session is reserved for the authorized issue 169 run after gate 181.',
          );
        };
      }
      if (!UI_METHODS.has(property)) {
        throw new Error(`WebDriver operation ${property} is blocked by the Windows runtime facade.`);
      }
      const target = activeWebDriver;
      const referenceGeneration = generation;
      const member = Reflect.get(target, property, target);
      if (typeof member !== 'function') {
        throw new Error(`WebDriver operation ${property} is blocked by the Windows runtime facade.`);
      }
      if (property === 'execute') {
        return async (script, ...args) => {
          assertCurrentFacadeReference(target, referenceGeneration, 'WebDriver execute');
          if (isRuntimeInfoQuery(script)) {
            if (state !== 'process-owned')
              throw new Error('Morrow identity query requires a freshly owned process.');
            let value;
            await confirmRuntimeIdentityWith(async () => {
              value = await Reflect.apply(member, target, [script, ...args]);
              return value;
            });
            return value;
          }
          return runUiOperation('WebDriver command', () => Reflect.apply(member, target, [script, ...args]));
        };
      }
      if (property === 'refresh') {
        return async (...args) => {
          assertCurrentFacadeReference(target, referenceGeneration, 'WebDriver refresh');
          assertLifecycleIdle('Refresh');
          if (refreshPrepared) {
            refreshPrepared = false;
            if (state !== 'process-owned') invalidateForRefresh();
          } else {
            invalidateForRefresh();
          }
          lifecycleTransitionInProgress = true;
          try {
            return await Reflect.apply(member, target, args);
          } finally {
            lifecycleTransitionInProgress = false;
          }
        };
      }
      if (property === 'screenshot') {
        return (...args) =>
          runUiOperation('WebView screenshot', async () => {
            assertCurrentFacadeReference(target, referenceGeneration, 'WebView screenshot');
            assertDescendantPath(args[0], candidate.evidence, 'WebView screenshot path');
            if (
              path.win32.dirname(normalizedPath(args[0], 'WebView screenshot path')) !==
              normalizedPath(candidate.evidence, 'WebView evidence directory')
            ) {
              throw new Error('WebView screenshots must be direct children of the owned evidence directory.');
            }
            await assertNewEvidenceFile(args[0]);
            return Reflect.apply(member, target, args);
          });
      }
      if (property === 'path') {
        return (suffix) => {
          assertCurrentFacadeReference(target, referenceGeneration, 'WebDriver UI path');
          requireIdentity('WebDriver UI path');
          assertUiSuffix(suffix);
          return Reflect.apply(member, target, [suffix]);
        };
      }
      if (property === 'request') {
        return (method, endpoint, body) =>
          runUiOperation('WebDriver UI request', async () => {
            assertCurrentFacadeReference(target, referenceGeneration, 'WebDriver UI request');
            assertUiRequest(target, method, endpoint);
            return Reflect.apply(member, target, [method, endpoint, body]);
          });
      }
      return (...args) =>
        runUiOperation(`WebDriver ${String(property)}`, async () => {
          assertCurrentFacadeReference(target, referenceGeneration, `WebDriver ${String(property)}`);
          return Reflect.apply(member, target, args);
        });
    },
  });

  async function restartOwnedSession(...args) {
    assertLifecycleIdle('Owned process restart');
    requireIdentity('Owned process restart');
    invalidateForRestart();
    lifecycleTransitionInProgress = true;
    try {
      const restartedDriver = await restartSession(...args);
      if (!restartedDriver || typeof restartedDriver.execute !== 'function') {
        throw new Error('The restart callback must return the active shared WebDriver client.');
      }
      assertOwnedDriverEndpoint(restartedDriver);
      activeWebDriver = restartedDriver;
      const observation = await observeOwnedProcesses();
      confirmOwnership(observation);
      return protectedDriver;
    } finally {
      lifecycleTransitionInProgress = false;
    }
  }

  async function recordStepAfterIdentity(...args) {
    requireIdentity('Evidence callback');
    return recordStep(...args);
  }

  function confirmProcessOwned(observation) {
    if (observation === undefined)
      throw new Error('Process ownership must be explicitly observed before UI access.');
    return confirmOwnership(observation);
  }

  async function runReadinessScenario() {
    requireIdentity('Native readiness scenario');
    if (state !== 'runtime-identity-confirmed')
      throw new Error('Readiness requires freshly confirmed runtime identity.');
    const result = await readinessScenario({
      driver: protectedDriver,
      candidate,
      prepared,
      restartSession: restartOwnedSession,
      recordStep: recordStepAfterIdentity,
      beginRuntimeRefresh,
      verifyRuntimeIdentity: confirmRuntimeIdentityFromDriver,
    });
    requireIdentity('Readiness completion');
    state = 'ready';
    return result;
  }

  async function runFunctionalScenario() {
    if (state !== 'ready')
      throw new Error('The functional callback is blocked until gated native readiness succeeds.');
    const result = await functionalScenario({
      driver: protectedDriver,
      candidate,
      prepared,
      restartSession: restartOwnedSession,
      recordStep: recordStepAfterIdentity,
      beginRuntimeRefresh,
      verifyRuntimeIdentity: confirmRuntimeIdentityFromDriver,
    });
    requireIdentity('Functional scenario completion');
    state = 'ready';
    return result;
  }

  return Object.freeze({
    get state() {
      return state;
    },
    get generation() {
      return generation;
    },
    get driver() {
      return protectedDriver;
    },
    confirmProcessOwned,
    confirmRuntimeIdentity: confirmRuntimeIdentityFromDriver,
    invalidateForRefresh,
    invalidateForRestart,
    runReadinessScenario,
    runFunctionalScenario,
  });
}
