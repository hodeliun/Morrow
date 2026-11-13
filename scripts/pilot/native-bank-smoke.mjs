#!/usr/bin/env node

// Isolated native smoke for the Polaris Dados pilot. This script intentionally
// requires a frozen debug binary and fresh output paths; it never discovers or
// attaches to an existing app, WebDriver server, vault, or desktop display.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, chmod, lstat, mkdir, readFile, readdir, readlink, realpath, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildVaultRegistry,
  copyEvidenceDurably,
  freezeSourceManifest,
  readSourceManifest,
  recordArtifactManifest,
  verifyArtifactManifest,
  verifySourceManifest,
} from './native-preparation.mjs';
import {
  APP_STAGE_RUNTIME_ENVIRONMENT_KEYS,
  buildPrivateDbusConfig,
  buildPrivateDbusClientArgs,
  buildPrivateDbusLaunch,
  createPrivateRuntimeEnv,
  PRIVATE_DBUS_SYNTHETIC_SERVICE_NAME,
  isFalseNameHasOwnerOutput,
  parseGdbusStringArray,
  summarizeAppStageRuntimeEnvironment,
  summarizeActivatableNames,
  summarizeRuntimeEnvironment,
} from './native-runtime-isolation.mjs';
import { runNativeFunctionalScenario } from './native-functional.mjs';
import { runIndependentFunctionalScenario } from './native-functional.independent.test.mjs';
import {
  captureNativeReadinessFailure,
  prepareNativeUi,
  runNativeReadinessScenario,
} from './native-readiness.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '../..');
const PILOT_ID = 'polaris-dados';
const APP_IDENTIFIER = 'app.morrow.polaris-dados-pilot';
const DRIVER_ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
const BANK_FILES = ['Inventory.md', 'Inventory/Widget.md'];
const TIMEOUT_MS = 25_000;
const UI_PREPARATION_SCENARIOS = new Set(['readiness', 'functional', 'functional-independent']);

function help() {
  process.stdout.write(`Usage:\n  node scripts/pilot/native-bank-smoke.mjs --freeze-sources --source-manifest-output NEW_JSON --diff-output NEW_PATCH\n  node scripts/pilot/native-bank-smoke.mjs --record-artifacts --source-manifest FROZEN_JSON --artifact-manifest-output NEW_JSON <artifact args>\n  node scripts/pilot/native-bank-smoke.mjs --check-only [--scenario readiness|functional|functional-independent|app-identity-only|dbus-isolation] <candidate args>\n  node scripts/pilot/native-bank-smoke.mjs --run-native --confirm-synthetic-profile [--scenario readiness|functional|functional-independent|app-identity-only] <candidate args>\n  node scripts/pilot/native-bank-smoke.mjs --run-native --confirm-synthetic-profile --confirm-private-dbus-probe --scenario dbus-isolation <candidate args>\n\nScenario defaults to the legacy bank smoke. Readiness observes boot and real Settings UI before checking the fixed synthetic source Total=20. app-identity-only checks the private app runtime identity without changing Settings, routing, or synthetic data. Functional scenarios run under the native isolation guards; dbus-isolation starts only the private D-Bus daemon and gdbus client, without Xvfb or Morrow.\nThe D-Bus probe requires both explicit confirmation flags and a separate root gate; never run it without that authorization.\nRequired candidate args:\n  --expected-commit SHA\n  --binary PATH --binary-sha256 SHA\n  --bundle PATH --bundle-sha256 SHA\n  --manifest PATH (plugins/polaris-dados/manifest.json; not a source hash manifest)\n  --source-manifest PATH --artifact-manifest PATH --tauri-config PATH\n  --vault NEW_PATH --destination-vault NEW_PATH --profile NEW_PATH --evidence NEW_PATH\n  --retained-evidence NEW_PATH --driver PATH --webkit-driver PATH\n\nThe synthetic vaults, profile, evidence, and retained evidence paths must be new and distinct.\nCheck-only verifies a frozen candidate and never creates those outputs or launches processes.\nNative runs own Xvfb, DBus, tauri-driver, the WebKit profile, and both synthetic vaults.\n`);
}

function parseArgs(argv) {
  const args = {};
  const switches = new Set(['--check-only', '--run-native', '--confirm-synthetic-profile', '--confirm-private-dbus-probe', '--freeze-sources', '--record-artifacts', '--help']);
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (switches.has(item)) {
      args[item.slice(2)] = true;
      continue;
    }
    if (!item.startsWith('--')) throw new Error(`Unexpected argument: ${item}`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${item}`);
    args[item.slice(2)] = value;
    i += 1;
  }
  return args;
}

function requireArg(args, name) {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Missing --${name}`);
  return value;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function hashFile(file) {
  return sha256(await readFile(file));
}

async function hashTree(root, files) {
  const digest = createHash('sha256');
  for (const relative of files) {
    digest.update(relative);
    digest.update('\0');
    digest.update(await readFile(path.join(root, relative)));
    digest.update('\0');
  }
  return digest.digest('hex');
}

function equalPath(a, b) {
  return path.resolve(a) === path.resolve(b);
}

function containsPath(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertDistinctOutputPaths(paths) {
  const values = Object.entries(paths);
  for (const [name, value] of values) {
    for (const [otherName, otherValue] of values) {
      if (name === otherName) continue;
      if (containsPath(value, otherValue) || containsPath(otherValue, value)) {
        throw new Error(`Output paths overlap: --${name} and --${otherName}`);
      }
    }
  }
}

function assertHash(value, name) {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(`--${name} must be a SHA-256 hex digest`);
}

async function assertNewTempPath(raw, name) {
  if (!path.isAbsolute(raw)) throw new Error(`--${name} must be absolute`);
  const resolved = path.resolve(raw);
  const temp = await realpath(os.tmpdir());
  if (!containsPath(temp, resolved) || equalPath(temp, resolved)) {
    throw new Error(`--${name} must be a new directory below ${temp}`);
  }
  if (!equalPath(path.dirname(resolved), temp)) {
    throw new Error(`--${name} must be a direct child of ${temp}; nested/symlinked output roots are refused`);
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(path.basename(resolved))) {
    throw new Error(`--${name} must use a simple ASCII directory name for isolated Unix socket paths`);
  }
  try {
    await lstat(resolved);
    throw new Error(`--${name} already exists; refusing to reuse it: ${resolved}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return resolved;
}

async function assertNewDurablePath(raw, name) {
  if (!path.isAbsolute(raw)) throw new Error(`--${name} must be absolute`);
  const resolved = path.resolve(raw);
  if (containsPath(REPO_ROOT, resolved) || containsPath(resolved, REPO_ROOT)) {
    throw new Error(`--${name} must be outside the repository`);
  }
  const temp = await realpath(os.tmpdir());
  if (containsPath(temp, resolved)) throw new Error(`--${name} must be outside the temporary directory`);
  const parent = path.dirname(resolved);
  if (await realpath(parent) !== parent) throw new Error(`--${name} parent must not use a symlinked path`);
  if (!/^[a-zA-Z0-9._-]+$/.test(path.basename(resolved))) {
    throw new Error(`--${name} must use a simple ASCII directory name`);
  }
  try {
    await lstat(resolved);
    throw new Error(`--${name} already exists; refusing to reuse it: ${resolved}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return resolved;
}

async function listFiles(root, current = root) {
  const output = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink in synthetic fixture is not allowed: ${full}`);
    if (entry.isDirectory()) output.push(...(await listFiles(root, full)));
    else if (entry.isFile()) output.push(path.relative(root, full).split(path.sep).join('/'));
    else throw new Error(`Unsupported fixture entry: ${full}`);
  }
  return output.sort();
}

async function verifyInputs(args) {
  const expectedCommit = requireArg(args, 'expected-commit');
  const binary = path.resolve(requireArg(args, 'binary'));
  const expectedBinaryHash = requireArg(args, 'binary-sha256').toLowerCase();
  const bundle = path.resolve(requireArg(args, 'bundle'));
  const expectedBundleHash = requireArg(args, 'bundle-sha256').toLowerCase();
  const manifest = path.resolve(requireArg(args, 'manifest'));
  const sourceManifest = path.resolve(requireArg(args, 'source-manifest'));
  const artifactManifest = path.resolve(requireArg(args, 'artifact-manifest'));
  const fixture = path.join(REPO_ROOT, 'plugins', PILOT_ID, 'fixture');
  const fixtureScript = path.join(REPO_ROOT, 'scripts', 'pilot', 'create-polaris-dados-fixture.mjs');
  const tauriConfig = path.resolve(requireArg(args, 'tauri-config'));
  const driver = path.resolve(requireArg(args, 'driver'));
  const webkitDriver = path.resolve(requireArg(args, 'webkit-driver'));
  const outputs = {
    vault: await assertNewTempPath(requireArg(args, 'vault'), 'vault'),
    destinationVault: await assertNewTempPath(requireArg(args, 'destination-vault'), 'destination-vault'),
    profile: await assertNewTempPath(requireArg(args, 'profile'), 'profile'),
    evidence: await assertNewTempPath(requireArg(args, 'evidence'), 'evidence'),
    retainedEvidence: await assertNewDurablePath(requireArg(args, 'retained-evidence'), 'retained-evidence'),
  };
  assertDistinctOutputPaths(outputs);
  assertHash(expectedBinaryHash, 'binary-sha256');
  assertHash(expectedBundleHash, 'bundle-sha256');
  if (!/^[a-f0-9]{40}$/i.test(expectedCommit)) throw new Error('--expected-commit must be a full Git SHA');

  const gitHead = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT })).trim();
  if (gitHead !== expectedCommit) throw new Error(`Candidate HEAD ${gitHead} differs from --expected-commit ${expectedCommit}`);
  const sourceVerification = await verifySourceManifest({ repositoryRoot: REPO_ROOT, sourceManifestPath: sourceManifest });
  if (sourceVerification.head !== expectedCommit) {
    throw new Error(`Frozen source HEAD ${sourceVerification.head} differs from --expected-commit ${expectedCommit}`);
  }
  const frozenSourceManifest = await readSourceManifest(sourceManifest);

  const artifactVerification = await verifyArtifactManifest({
    repositoryRoot: REPO_ROOT,
    sourceManifestPath: sourceManifest,
    artifactManifestPath: artifactManifest,
    binaryPath: binary,
    expectedBinarySha256: expectedBinaryHash,
    bundlePath: bundle,
    expectedBundleSha256: expectedBundleHash,
    pluginManifestPath: manifest,
    tauriConfigPath: tauriConfig,
    driverPath: driver,
    webkitDriverPath: webkitDriver,
  });

  const binaryReal = await realpath(binary);
  if (!containsPath(path.join(REPO_ROOT, 'src-tauri', 'target', 'debug'), binaryReal)) {
    throw new Error(`Only the isolated debug target is accepted; got ${binaryReal}`);
  }
  const binaryInfo = await stat(binaryReal);
  if (!binaryInfo.isFile() || (binaryInfo.mode & 0o111) === 0) throw new Error('Candidate binary is not executable');
  const actualBinaryHash = await hashFile(binaryReal);
  if (actualBinaryHash !== expectedBinaryHash) throw new Error(`Candidate binary SHA mismatch: ${actualBinaryHash}`);

  const bundleReal = await realpath(bundle);
  if (!equalPath(bundleReal, path.join(REPO_ROOT, 'dist', PILOT_ID, 'main.js'))) {
    throw new Error(`Bundle must be the built candidate at ${path.join(REPO_ROOT, 'dist', PILOT_ID, 'main.js')}`);
  }
  const actualBundleHash = await hashFile(bundleReal);
  if (actualBundleHash !== expectedBundleHash) throw new Error(`Plugin bundle SHA mismatch: ${actualBundleHash}`);

  const manifestReal = await realpath(manifest);
  if (!equalPath(manifestReal, path.join(REPO_ROOT, 'plugins', PILOT_ID, 'manifest.json'))) {
    throw new Error('Manifest must be the checked-in Polaris Dados source manifest');
  }
  const manifestData = JSON.parse(await readFile(manifestReal, 'utf8'));
  if (manifestData.id !== PILOT_ID) throw new Error(`Manifest id must be ${PILOT_ID}`);
  if (typeof manifestData.name !== 'string' || manifestData.name.length === 0) throw new Error('Manifest must name the installed pilot');
  const configReal = await realpath(tauriConfig);
  if (!equalPath(configReal, path.join(REPO_ROOT, 'src-tauri', 'tauri.pilot.conf.json'))) {
    throw new Error('Tauri config must be the checked-in pilot overlay');
  }
  const configData = JSON.parse(await readFile(configReal, 'utf8'));
  if (configData.identifier !== APP_IDENTIFIER) throw new Error(`Tauri overlay identifier must be ${APP_IDENTIFIER}`);

  const fixtureReal = await realpath(fixture);
  const expectedFixture = path.join(REPO_ROOT, 'plugins', PILOT_ID, 'fixture');
  if (!equalPath(fixtureReal, expectedFixture)) {
    throw new Error(`Fixture must be the checked-in synthetic fixture at ${expectedFixture}`);
  }
  const fixtureFiles = await listFiles(fixtureReal);
  const missing = BANK_FILES.filter((file) => !fixtureFiles.includes(file));
  if (missing.length) throw new Error(`Fixture is missing required bank files: ${missing.join(', ')}`);
  if (fixtureFiles.length !== BANK_FILES.length) {
    throw new Error(`Source fixture must contain only ${BANK_FILES.join(' and ')}; got ${fixtureFiles.join(', ')}`);
  }
  await access(fixtureScript);

  for (const [label, file] of [['tauri-driver', driver], ['WebKitWebDriver', webkitDriver]]) {
    const info = await stat(file);
    if (!info.isFile() || (info.mode & 0o111) === 0) throw new Error(`${label} is missing or not executable: ${file}`);
  }
  const runtimePath = path.join(outputs.profile, 'xdg', 'runtime', 'bus');
  if (Buffer.byteLength(runtimePath) > 90) throw new Error(`Private DBus socket path is too long: ${runtimePath}`);
  const webviewDataPath = path.join(outputs.profile, 'xdg', 'data', APP_IDENTIFIER);
  const expectedBackendDataPath = outputs.profile;
  if (!containsPath(outputs.profile, webviewDataPath) || equalPath(outputs.profile, webviewDataPath)) {
    throw new Error('Expected WebView profile must be inside the isolated profile root and identifier-scoped');
  }

  return {
    expectedCommit,
    sourceManifest,
    sourceManifestSha256: artifactVerification.sourceManifestSha256,
    sourceVerification,
    sourceTestHashes: frozenSourceManifest.manifest.testHashes,
    artifactManifest,
    artifactManifestSha256: artifactVerification.artifactManifestSha256,
    artifactVerification,
    binary: binaryReal,
    binarySha256: actualBinaryHash,
    bundle: bundleReal,
    bundleSha256: actualBundleHash,
    manifest: manifestReal,
    manifestSha256: await hashFile(manifestReal),
    pluginName: manifestData.name,
    fixture: fixtureReal,
    fixtureScript,
    fixtureFiles,
    fixtureSha256: await hashTree(fixtureReal, fixtureFiles),
    tauriConfig: configReal,
    expectedBackendDataPath,
    expectedWebviewDataPath: webviewDataPath,
    driver,
    driverSha256: await hashFile(driver),
    webkitDriver,
    webkitDriverSha256: await hashFile(webkitDriver),
    ...outputs,
  };
}

function findPathId(root, wantedPath) {
  const stack = [root];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (!Array.isArray(value) && value.path === wantedPath && typeof value.id === 'string') return value.id;
    for (const [key, child] of Object.entries(value)) {
      if (key === wantedPath && child && typeof child === 'object' && typeof child.id === 'string') return child.id;
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return null;
}

async function runCapture(command, argv, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} ${argv.join(' ')} failed (${code}): ${stderr || stdout}`));
    });
  });
}

async function runPrivateDbusCommand(argv, env) {
  const summary = summarizeRuntimeEnvironment({ actual: env, expected: env });
  if (!summary.ok) throw new Error('Refusing to run D-Bus probe client with a non-isolated environment');
  return new Promise((resolve) => {
    const child = spawn('gdbus', argv, { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let spawnErrorCode = null;
    let timedOut = false;
    let timeoutKillSucceeded = null;
    const append = (current, chunk) => `${current}${chunk}`.slice(-64 * 1024);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.once('error', (error) => { spawnErrorCode = error?.code ?? 'UNKNOWN'; });
    const timeout = setTimeout(() => {
      timedOut = true;
      try { timeoutKillSucceeded = child.kill('SIGKILL'); }
      catch { timeoutKillSucceeded = false; }
    }, 10_000);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr, spawnErrorCode, timedOut, timeoutKillSucceeded });
    });
  });
}

async function privateDbusCall(env, method, parameters = []) {
  return runPrivateDbusCommand(buildPrivateDbusClientArgs({
    runtimeDir: env.XDG_RUNTIME_DIR,
    busAddress: env.DBUS_SESSION_BUS_ADDRESS,
    method,
    parameters,
  }), env);
}

function assertPrivateDbusCommandCompleted(result, label) {
  if (result.spawnErrorCode || result.timedOut) {
    throw new Error(`Private D-Bus probe command ${label} did not complete cleanly (spawnError=${Boolean(result.spawnErrorCode)}, timedOut=${result.timedOut}, timeoutKillSucceeded=${result.timeoutKillSucceeded})`);
  }
}

async function probePrivateDbus(env, recordStep, receipt) {
  const sha = (text) => sha256(Buffer.from(text));
  const listActivatableBefore = await waitFor(async () => {
    const result = await privateDbusCall(env, 'ListActivatableNames');
    assertPrivateDbusCommandCompleted(result, 'ListActivatableNames-before');
    return result.code === 0 ? result : false;
  }, 'private D-Bus readiness');
  const activatableNamesBefore = summarizeActivatableNames(listActivatableBefore.stdout);
  receipt.activatableNamesBefore = activatableNamesBefore;
  await recordStep('dbus-probe-activatable-names-before', activatableNamesBefore);
  if (!activatableNamesBefore.valid) {
    throw new Error('Private D-Bus activatable-name inventory did not match the driver-only allowlist');
  }

  const namesBefore = await privateDbusCall(env, 'ListNames');
  assertPrivateDbusCommandCompleted(namesBefore, 'ListNames-before');
  const namesBeforeParsed = namesBefore.code === 0 ? parseGdbusStringArray(namesBefore.stdout) : null;
  const namesBeforePrivateOnly = Array.isArray(namesBeforeParsed)
    && namesBeforeParsed.includes('org.freedesktop.DBus')
    && namesBeforeParsed.every((name) => name === 'org.freedesktop.DBus' || /^:\d+(?:\.\d+)?$/.test(name));
  await recordStep('dbus-probe-owned-names-before', {
    privateOnly: namesBeforePrivateOnly,
    outputSha256: sha(namesBefore.stdout),
  });
  if (!namesBeforePrivateOnly) throw new Error('Private D-Bus reported an unexpected owned service before the probe');

  const secretOwnerBefore = await privateDbusCall(env, 'NameHasOwner', ['org.freedesktop.secrets']);
  assertPrivateDbusCommandCompleted(secretOwnerBefore, 'NameHasOwner-secrets-before');
  const secretsUnownedBefore = secretOwnerBefore.code === 0 && isFalseNameHasOwnerOutput(secretOwnerBefore.stdout);
  await recordStep('dbus-probe-secrets-owner-before', {
    unowned: secretsUnownedBefore,
    outputSha256: sha(secretOwnerBefore.stdout),
  });
  if (!secretsUnownedBefore) throw new Error('Private D-Bus unexpectedly reported an owner for org.freedesktop.secrets');

  const syntheticName = PRIVATE_DBUS_SYNTHETIC_SERVICE_NAME;
  const activationAttempt = await privateDbusCall(env, 'StartServiceByName', [syntheticName, '0']);
  assertPrivateDbusCommandCompleted(activationAttempt, 'StartServiceByName-synthetic');
  const activationError = `${activationAttempt.stdout}\n${activationAttempt.stderr}`;
  const activationRejected = activationAttempt.code !== 0
    && /org\.freedesktop\.DBus\.Error\.ServiceUnknown/.test(activationError);
  await recordStep('dbus-probe-synthetic-activation', {
    rejectedAsUnregistered: activationRejected,
    exitCode: activationAttempt.code,
    outputSha256: sha(activationError),
  });
  if (!activationRejected) throw new Error('Private D-Bus did not reject activation of an unregistered synthetic service name');

  const syntheticOwner = await privateDbusCall(env, 'NameHasOwner', [syntheticName]);
  assertPrivateDbusCommandCompleted(syntheticOwner, 'NameHasOwner-synthetic-after');
  const syntheticNameUnowned = syntheticOwner.code === 0 && isFalseNameHasOwnerOutput(syntheticOwner.stdout);
  await recordStep('dbus-probe-synthetic-owner-after', {
    unowned: syntheticNameUnowned,
    outputSha256: sha(syntheticOwner.stdout),
  });
  if (!syntheticNameUnowned) throw new Error('Private D-Bus reported an owner for the unregistered synthetic service name');

  const listActivatableAfter = await privateDbusCall(env, 'ListActivatableNames');
  assertPrivateDbusCommandCompleted(listActivatableAfter, 'ListActivatableNames-after');
  const activatableNamesAfter = listActivatableAfter.code === 0
    ? summarizeActivatableNames(listActivatableAfter.stdout)
    : summarizeActivatableNames(null);
  receipt.activatableNamesAfter = activatableNamesAfter;
  await recordStep('dbus-probe-activatable-names-after', activatableNamesAfter);
  if (!activatableNamesAfter.valid) {
    throw new Error('Private D-Bus activatable-name inventory changed from the driver-only allowlist');
  }
  const namesAfter = await privateDbusCall(env, 'ListNames');
  assertPrivateDbusCommandCompleted(namesAfter, 'ListNames-after');
  const namesAfterParsed = namesAfter.code === 0 ? parseGdbusStringArray(namesAfter.stdout) : null;
  const namesAfterPrivateOnly = Array.isArray(namesAfterParsed)
    && namesAfterParsed.includes('org.freedesktop.DBus')
    && namesAfterParsed.every((name) => name === 'org.freedesktop.DBus' || /^:\d+(?:\.\d+)?$/.test(name));
  await recordStep('dbus-probe-owned-names-after', {
    privateOnly: namesAfterPrivateOnly,
    outputSha256: sha(namesAfter.stdout),
  });
  if (!namesAfterPrivateOnly) throw new Error('Private D-Bus reported an unexpected owned service after the probe');

  return {
    activatableNamesBefore,
    namesBeforePrivateOnly,
    namesBeforeSha256: sha(namesBefore.stdout),
    secretsUnownedBefore,
    secretOwnerBeforeSha256: sha(secretOwnerBefore.stdout),
    syntheticActivationRejected: activationRejected,
    syntheticActivationExitCode: activationAttempt.code,
    syntheticActivationErrorSha256: sha(activationError),
    syntheticNameUnowned,
    syntheticOwnerSha256: sha(syntheticOwner.stdout),
    activatableNamesAfter,
    namesAfterPrivateOnly,
    namesAfterSha256: sha(namesAfter.stdout),
    ...receipt,
  };
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Could not reserve a TCP port'));
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, label, timeout = TIMEOUT_MS) {
  const until = Date.now() + timeout;
  let lastError;
  while (Date.now() < until) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function launchLogged(command, argv, { cwd, env, logPath, stdio = 'pipe' }) {
  const child = spawn(command, argv, { cwd, env, detached: true, stdio: ['ignore', stdio, 'pipe'] });
  const log = await import('node:fs');
  const stream = log.createWriteStream(logPath, { flags: 'a', mode: 0o600 });
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  let stdout = '';
  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      stream.write(chunk);
    });
  }
  if (child.stderr) child.stderr.pipe(stream, { end: false });
  child.once('error', (error) => stream.write(`\nspawn error: ${error.stack ?? error}\n`));
  child.once('exit', (code, signal) => stream.write(`\nexit code=${code} signal=${signal}\n`));
  child.once('close', (code, signal) => resolveClosed({ code, signal }));
  return { child, getStdout: () => stdout, stream, closed, groupSignalled: false };
}

async function processGroupMembers(groupId) {
  const entries = await readdir('/proc', { withFileTypes: true });
  const members = [];
  await Promise.all(entries.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name)).map(async (entry) => {
    const pid = Number(entry.name);
    const statLine = await readFile(path.join('/proc', entry.name, 'stat'), 'utf8').catch(() => null);
    if (!statLine) return;
    const closeParen = statLine.lastIndexOf(')');
    if (closeParen < 0) return;
    const fields = statLine.slice(closeParen + 1).trim().split(/\s+/);
    const processGroup = Number(fields[2]); // /proc/<pid>/stat field 5, after pid and comm.
    if (processGroup === groupId) members.push(pid);
  }));
  return members.sort((a, b) => a - b);
}

async function finishLoggedProcess(processRecord) {
  if (!processRecord) return;
  const errors = [];
  let processClosed = !processRecord.closed;
  const groupId = processRecord.child?.pid;
  if (groupId && !processRecord.groupSignalled) {
    try {
      await killProcessGroup(groupId);
      processRecord.groupSignalled = true;
    } catch (error) { errors.push(`could not stop owned process group ${groupId}: ${error?.message ?? error}`); }
  }
  if (groupId && processRecord.groupSignalled) {
    try {
      await waitFor(async () => (await processGroupMembers(groupId)).length === 0, `owned process group ${groupId} to become empty`, 5_000);
    } catch (error) { errors.push(error?.message ?? String(error)); }
  }
  if (processRecord.closed) {
    let timeout;
    try {
      await Promise.race([
        processRecord.closed.then((result) => { processClosed = true; return result; }),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`Timed out waiting for owned process ${processRecord.child?.pid ?? '<unknown>'} to close`)), 5_000);
        }),
      ]);
    } catch (error) { errors.push(error?.message ?? String(error)); }
    finally { clearTimeout(timeout); }
  }
  if (processRecord.stream && !processRecord.stream.writableFinished && !processClosed) {
    errors.push('owned child did not close; log stream was kept open to avoid truncating later output');
  } else if (processRecord.stream && !processRecord.stream.writableFinished) {
    try {
      let timeout;
      await Promise.race([
        new Promise((resolve, reject) => {
          processRecord.stream.once('error', reject);
          if (processRecord.stream.writableEnded) processRecord.stream.once('finish', resolve);
          else processRecord.stream.end(resolve);
        }),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Timed out waiting for owned log stream to flush')), 5_000);
        }),
      ]).finally(() => clearTimeout(timeout));
    } catch (error) { errors.push(`could not flush owned log stream: ${error?.message ?? error}`); }
  }
  if (errors.length) throw new Error(errors.join('; '));
}

async function waitForLine(processRecord, label, timeout = 10_000) {
  return waitFor(() => {
    const line = processRecord.getStdout().split(/\r?\n/).find((item) => item.trim());
    if (line) return line.trim();
    if (processRecord.child.exitCode !== null) throw new Error(`${label} exited before reporting startup`);
    return false;
  }, `${label} startup`, timeout);
}

async function createSyntheticVault(candidate) {
  await mkdir(candidate.evidence, { recursive: false });
  candidate.evidenceOwned = true;
  await mkdir(candidate.profile, { recursive: false, mode: 0o700 });
  await chmod(candidate.profile, 0o700);
  const xdg = {
    config: path.join(candidate.profile, 'xdg', 'config'),
    data: path.join(candidate.profile, 'xdg', 'data'),
    cache: path.join(candidate.profile, 'xdg', 'cache'),
    runtime: path.join(candidate.profile, 'xdg', 'runtime'),
  };
  await Promise.all(Object.values(xdg).map(async (dir) => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  }));
  if ((await readdir(xdg.data)).length !== 0) throw new Error('Private XDG data directory was not empty before launch');
  const dbusConfig = buildPrivateDbusConfig({ profile: candidate.profile, runtimeDir: xdg.runtime });
  await writeFile(dbusConfig.configPath, dbusConfig.contents, { flag: 'wx', mode: 0o600 });
  await chmod(dbusConfig.configPath, 0o600);
  const dbusConfigEvidencePath = path.join(candidate.evidence, 'dbus-session.conf');
  await writeFile(dbusConfigEvidencePath, dbusConfig.contents, { flag: 'wx', mode: 0o600 });
  const initialRuntimeEnv = privateRuntimeEnv(candidate, xdg);
  const initialRuntimeSummary = summarizeRuntimeEnvironment({ actual: initialRuntimeEnv, expected: initialRuntimeEnv });
  if (!initialRuntimeSummary.ok) throw new Error('Private runtime environment failed its pre-spawn isolation check');
  await writeFile(path.join(candidate.evidence, 'runtime-isolation.json'), `${JSON.stringify({
    observedAt: new Date().toISOString(),
    profile: candidate.profile,
    xdg,
    dbusConfigPath: dbusConfig.configPath,
    dbusConfigSha256: dbusConfig.sha256,
    dbusConfigEvidencePath,
    dbusSocketPath: dbusConfig.socketPath,
    environment: initialRuntimeSummary,
    displaySetBeforeSpawn: false,
    sessionBusSetBeforeSpawn: false,
  }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });

  let generatorOutput = '';
  try {
    generatorOutput = await runCapture(process.execPath, [candidate.fixtureScript, candidate.vault, candidate.destinationVault], { cwd: REPO_ROOT, env: initialRuntimeEnv });
    await writeFile(path.join(candidate.evidence, 'fixture-generator.log'), generatorOutput);
  } catch (error) {
    await writeFile(path.join(candidate.evidence, 'fixture-generator.log'), `${generatorOutput}\n${error?.stack ?? error}\n`);
    throw error;
  }
  const generation = JSON.parse(generatorOutput);
  if (!Array.isArray(generation.vaults) || generation.vaults.length !== 2) {
    throw new Error('Fixture generator did not create both registered synthetic vaults');
  }
  const origin = await verifyGeneratedVault(candidate, candidate.vault, generation.vaults[0], 'OPEN-OLD');
  const destination = await verifyGeneratedVault(candidate, candidate.destinationVault, generation.vaults[1], 'OPEN-DESTINATION');
  const allIds = [
    ...origin.pageIds,
    origin.sourceViewId,
    ...origin.linkedViewIds,
    ...destination.pageIds,
    destination.sourceViewId,
    ...destination.linkedViewIds,
  ];
  const orderedNumbers = allIds.map((id) => {
    const match = /-(\d+)$/.exec(id);
    if (!match) throw new Error(`Generated fixture ID is not monotonic: ${id}`);
    return BigInt(match[1]);
  });
  if (new Set(allIds).size !== allIds.length) throw new Error('Generated synthetic vault/page/view IDs are not unique');
  if (orderedNumbers.some((value, index) => index > 0 && value <= orderedNumbers[index - 1])) {
    throw new Error('Generated synthetic vault/page/view IDs are not strictly monotonic');
  }
  if (origin.databaseId === destination.databaseId) throw new Error('Origin and destination database IDs must be distinct');
  candidate.databaseId = origin.databaseId;
  candidate.destinationDatabaseId = destination.databaseId;
  candidate.linkedViews = { origin: origin.views, destination: destination.views };
  candidate.vaultFiles = origin.vaultFiles;
  candidate.destinationVaultFiles = destination.vaultFiles;

  try {
    await lstat(candidate.expectedWebviewDataPath);
    throw new Error(`Identifier-scoped WebView profile already exists before launch: ${candidate.expectedWebviewDataPath}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const vaultRegistry = buildVaultRegistry(candidate.vault, candidate.destinationVault);
  await writeFile(path.join(candidate.profile, 'vaults.json'), `${JSON.stringify(vaultRegistry, null, 2)}\n`, { flag: 'wx' });
  const registeredVaults = JSON.parse(await readFile(path.join(candidate.profile, 'vaults.json'), 'utf8'));
  const recentPaths = Array.isArray(registeredVaults.recent) ? registeredVaults.recent.map((item) => item.path) : [];
  if (registeredVaults.current !== candidate.vault || !recentPaths.includes(candidate.vault) || !recentPaths.includes(candidate.destinationVault)) {
    throw new Error('Both synthetic vaults must be registered in the isolated profile before launch');
  }
  const bankBefore = await captureBank(candidate.vault);
  const destinationBankBefore = await captureBank(candidate.destinationVault);
  const originVaultContent = await captureVaultInventory(candidate.vault, origin.vaultFiles);
  const destinationVaultContent = await captureVaultInventory(candidate.destinationVault, destination.vaultFiles);
  const profileVaultRegistry = await captureFile(path.join(candidate.profile, 'vaults.json'));
  const row = bankBefore['Inventory/Widget.md'].bytes.toString('utf8');
  const schema = bankBefore['Inventory.md'].bytes.toString('utf8');
  assertNumber(row, 'Quantity', 2);
  assertNumber(row, 'Price', 10);
  assertFormula(schema);
  await writeFile(path.join(candidate.evidence, 'fixture-initial.json'), `${JSON.stringify({
    fixtureSource: candidate.fixture,
    fixtureSha256: candidate.fixtureSha256,
    fixtureFiles: candidate.fixtureFiles,
    sourceManifest: candidate.sourceManifest,
    sourceManifestSha256: candidate.sourceManifestSha256,
    artifactManifest: candidate.artifactManifest,
    artifactManifestSha256: candidate.artifactManifestSha256,
    generatedVaults: [origin, destination],
    generatedVaultFiles: { origin: origin.vaultFiles, destination: destination.vaultFiles },
    generatedDatabaseId: candidate.databaseId,
    destinationDatabaseId: candidate.destinationDatabaseId,
    linkedViews: candidate.linkedViews,
    generatedVaultContent: { origin: originVaultContent, destination: destinationVaultContent },
    isolatedVaultRegistry: {
      path: path.join(candidate.profile, 'vaults.json'),
      sha256: profileVaultRegistry.hash,
      size: profileVaultRegistry.size,
      mtimeMs: profileVaultRegistry.mtimeMs,
    },
    bank: Object.fromEntries(Object.entries(bankBefore).map(([name, value]) => [name, { sha256: value.hash, mtimeMs: value.mtimeMs, size: value.size }])),
    destinationBank: Object.fromEntries(Object.entries(destinationBankBefore).map(([name, value]) => [name, { sha256: value.hash, mtimeMs: value.mtimeMs, size: value.size }])),
  }, null, 2)}\n`);
  candidate.generatedVaultContent = { origin: originVaultContent, destination: destinationVaultContent };
  candidate.isolatedVaultRegistry = {
    path: path.join(candidate.profile, 'vaults.json'),
    sha256: profileVaultRegistry.hash,
    size: profileVaultRegistry.size,
    mtimeMs: profileVaultRegistry.mtimeMs,
  };
  return {
    xdg,
    dbusConfig,
    dbusConfigEvidencePath,
    bankBefore,
    destinationBankBefore,
    originVaultContent,
    destinationVaultContent,
  };
}

async function preservePreparationFailure(candidate, error) {
  if (!candidate.evidenceOwned) return;
  const failure = {
    observedAt: new Date().toISOString(),
    outcome: 'fixture-preparation-failed-before-launch',
    error: error?.stack ?? String(error),
    sourceManifest: candidate.sourceManifest,
    sourceManifestSha256: candidate.sourceManifestSha256,
    artifactManifest: candidate.artifactManifest,
    artifactManifestSha256: candidate.artifactManifestSha256,
    expectedCommit: candidate.expectedCommit,
    binary: { path: candidate.binary, sha256: candidate.binarySha256 },
    bundle: { path: candidate.bundle, sha256: candidate.bundleSha256 },
    syntheticVaults: [candidate.vault, candidate.destinationVault],
    profile: candidate.profile,
    evidence: candidate.evidence,
    retainedEvidence: candidate.retainedEvidence,
    applicationLaunched: false,
  };
  try {
    await writeFile(path.join(candidate.evidence, 'preparation-failure.json'), `${JSON.stringify(failure, null, 2)}\n`, { flag: 'wx' });
  } catch (writeError) {
    process.stderr.write(`Could not persist preparation failure metadata: ${writeError?.stack ?? writeError}\n`);
  }
  try {
    const retained = await copyEvidenceDurably({
      sourceDirectory: candidate.evidence,
      destinationDirectory: candidate.retainedEvidence,
    });
    process.stderr.write(`Preparation failure evidence retained: ${JSON.stringify({ path: retained.destination, fileCount: retained.fileCount, receiptSha256: retained.receiptSha256 })}\n`);
  } catch (retentionError) {
    const report = `Durable evidence copy failed: ${retentionError?.stack ?? retentionError}\n`;
    try { await writeFile(path.join(candidate.evidence, 'retention-failure.log'), report, { flag: 'wx' }); }
    catch (writeError) { process.stderr.write(`Could not persist retention failure report: ${writeError?.stack ?? writeError}\n`); }
    process.stderr.write(report);
  }
}

async function verifyGeneratedVault(candidate, vaultPath, descriptor, expectedMarker) {
  if (path.resolve(descriptor.path) !== path.resolve(vaultPath)) throw new Error(`Fixture generator returned the wrong ${expectedMarker} vault path`);
  if (descriptor.marker !== expectedMarker) throw new Error(`Fixture generator returned the wrong marker for ${vaultPath}`);
  const vaultFiles = await listFiles(vaultPath);
  const requiredVaultFiles = [
    ...BANK_FILES,
    'Views.md',
    '.morrow/workspace.json',
    '.morrow/plugins.json',
    `.morrow/plugins/${PILOT_ID}/main.js`,
    `.morrow/plugins/${PILOT_ID}/manifest.json`,
  ];
  const missingVaultFiles = requiredVaultFiles.filter((file) => !vaultFiles.includes(file));
  if (missingVaultFiles.length) throw new Error(`Generated synthetic vault is missing: ${missingVaultFiles.join(', ')}`);
  const copiedBundle = path.join(vaultPath, '.morrow', 'plugins', PILOT_ID, 'main.js');
  const copiedManifest = path.join(vaultPath, '.morrow', 'plugins', PILOT_ID, 'manifest.json');
  if (await hashFile(copiedBundle) !== candidate.bundleSha256) throw new Error(`${expectedMarker} fixture copied a bundle different from the frozen candidate`);
  if (await hashFile(copiedManifest) !== candidate.manifestSha256) throw new Error(`${expectedMarker} fixture copied a different plugin manifest`);
  const enabled = JSON.parse(await readFile(path.join(vaultPath, '.morrow', 'plugins.json'), 'utf8'));
  if (!Array.isArray(enabled.enabled) || !enabled.enabled.includes(PILOT_ID)) throw new Error(`${expectedMarker} vault does not enable the Polaris Dados pilot`);
  const workspace = JSON.parse(await readFile(path.join(vaultPath, '.morrow', 'workspace.json'), 'utf8'));
  const sourceDatabaseId = findPathId(workspace, 'Inventory.md');
  if (!sourceDatabaseId) throw new Error(`${expectedMarker} workspace registry does not identify Inventory.md`);
  const pageIds = ['Inventory.md', 'Inventory/Widget.md', 'Views.md'].map((file) => findPathId(workspace, file));
  if (pageIds.some((id) => !id)) throw new Error(`${expectedMarker} workspace registry is missing a page ID`);
  const note = await readFile(path.join(vaultPath, 'Views.md'), 'utf8');
  if (!note.includes(`Synthetic vault marker: ${expectedMarker}`)) throw new Error(`${expectedMarker} note marker is missing`);
  const markers = [...note.matchAll(/<!-- morrow:polaris-dados-view:v1:([A-Za-z0-9_-]+) -->/g)];
  if (markers.length !== 2) throw new Error(`${expectedMarker} note must contain exactly two linked-view markers`);
  const views = markers.map((match) => JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')));
  if (JSON.stringify(views.map((view) => view.viewId)) !== JSON.stringify(descriptor.linkedViewIds)) {
    throw new Error(`${expectedMarker} linked-view IDs differ from the fixture generator receipt`);
  }
  if (!((await readFile(path.join(vaultPath, 'Inventory.md'), 'utf8')).includes(`id: ${descriptor.sourceViewId}`))) {
    throw new Error(`${expectedMarker} source table view ID differs from the fixture generator receipt`);
  }
  if (views.some((view) => view.sourceDatabaseId !== sourceDatabaseId)) {
    throw new Error(`${expectedMarker} linked views must both reference their own vault's database ID`);
  }
  if (new Set(views.map((view) => view.viewId)).size !== 2) throw new Error(`${expectedMarker} linked-view IDs must be unique`);
  if (views[0].title === views[1].title || JSON.stringify(views[0].columnOrder) === JSON.stringify(views[1].columnOrder) || JSON.stringify(views[0].filter) === JSON.stringify(views[1].filter)) {
    throw new Error(`${expectedMarker} linked views must have distinct titles, ordering, and filters`);
  }
  return {
    path: vaultPath,
    marker: expectedMarker,
    databaseId: sourceDatabaseId,
    pageIds,
    sourceViewId: descriptor.sourceViewId,
    linkedViewIds: views.map((view) => view.viewId),
    views,
    vaultFiles,
  };
}

async function captureFile(file) {
  const bytes = await readFile(file);
  const info = await stat(file);
  return { bytes, hash: sha256(bytes), mtimeMs: info.mtimeMs, size: info.size };
}

async function captureFinalVaultContent(candidate) {
  const allowedFiles = ['Inventory.md', 'Inventory/Widget.md', 'Views.md'];
  const root = path.resolve(candidate.vault);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || await realpath(root) !== root) {
    throw new Error('Refusing to retain final Markdown from a non-canonical synthetic vault root.');
  }
  const evidenceRoot = path.resolve(candidate.evidence);
  const evidenceInfo = await lstat(evidenceRoot);
  if (evidenceInfo.isSymbolicLink() || !evidenceInfo.isDirectory() || await realpath(evidenceRoot) !== evidenceRoot) {
    throw new Error('Refusing to retain final Markdown outside the owned evidence directory.');
  }
  for (const relative of allowedFiles) {
    if (!candidate.vaultFiles?.includes(relative)) {
      throw new Error(`Refusing to retain a Markdown file absent from the generated vault manifest: ${relative}`);
    }
  }

  const outputRoot = path.join(candidate.evidence, 'final-vault-content');
  await mkdir(outputRoot, { recursive: false });
  const files = {};
  for (const relative of allowedFiles) {
    const segments = relative.split('/');
    let source = root;
    for (let index = 0; index < segments.length; index += 1) {
      source = path.join(source, segments[index]);
      const info = await lstat(source);
      const finalSegment = index === segments.length - 1;
      if (info.isSymbolicLink() || (finalSegment ? !info.isFile() : !info.isDirectory())) {
        throw new Error(`Refusing to retain a non-regular synthetic vault path: ${relative}`);
      }
      const canonical = await realpath(source);
      if (!containsPath(root, canonical) || canonical !== source) {
        throw new Error(`Refusing to retain a synthetic vault path that escapes or resolves through an alias: ${relative}`);
      }
    }
    const bytes = await readFile(source);
    const info = await stat(source);
    const destination = path.join(outputRoot, ...segments);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: 'wx' });
    files[relative] = {
      source,
      evidencePath: path.relative(candidate.evidence, destination).split(path.sep).join('/'),
      sha256: sha256(bytes),
      size: bytes.length,
      mtimeMs: info.mtimeMs,
    };
  }
  const manifest = {
    capturedAt: new Date().toISOString(),
    syntheticVault: root,
    generatedVaultFileCount: candidate.vaultFiles.length,
    files,
    scope: 'three whitelisted Markdown files from the verified synthetic origin vault only',
  };
  await writeFile(path.join(candidate.evidence, 'final-vault-content.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return manifest;
}

async function captureBank(vault) {
  const result = {};
  for (const relative of BANK_FILES) result[relative] = await captureFile(path.join(vault, relative));
  return result;
}

async function captureVaultInventory(vault, files) {
  const records = {};
  for (const relative of files) {
    const info = await captureFile(path.join(vault, relative));
    const category = relative.startsWith('.morrow/plugins/')
      ? 'pluginArtifacts'
      : relative.startsWith('.morrow/')
        ? 'morrowMetadata'
        : BANK_FILES.includes(relative)
          ? 'bankContent'
          : 'documentContent';
    records[relative] = { category, sha256: info.hash, size: info.size, mtimeMs: info.mtimeMs };
  }
  return records;
}

function privateRuntimeEnv(candidate, xdg, { display, busAddress } = {}) {
  return createPrivateRuntimeEnv({ profile: candidate.profile, xdg, display, busAddress });
}

async function assertCandidateStillFrozen(candidate) {
  if (await hashFile(candidate.sourceManifest) !== candidate.sourceManifestSha256) {
    throw new Error('Source manifest changed after preflight');
  }
  if (await hashFile(candidate.artifactManifest) !== candidate.artifactManifestSha256) {
    throw new Error('Artifact manifest changed after preflight');
  }
  return verifyArtifactManifest({
    repositoryRoot: REPO_ROOT,
    sourceManifestPath: candidate.sourceManifest,
    artifactManifestPath: candidate.artifactManifest,
    binaryPath: candidate.binary,
    expectedBinarySha256: candidate.binarySha256,
    bundlePath: candidate.bundle,
    expectedBundleSha256: candidate.bundleSha256,
    pluginManifestPath: candidate.manifest,
    tauriConfigPath: candidate.tauriConfig,
    driverPath: candidate.driver,
    webkitDriverPath: candidate.webkitDriver,
  });
}

async function startPrivateDbus(candidate, xdg, config, onProcessStart = () => {}) {
  const env = privateRuntimeEnv(candidate, xdg);
  if (!config || config.configPath !== path.join(candidate.profile, 'dbus-session.conf')) {
    throw new Error('Private D-Bus config must be generated under this candidate profile before runtime launch');
  }
  const configInfo = await lstat(config.configPath);
  if (configInfo.isSymbolicLink() || !configInfo.isFile() || (configInfo.mode & 0o777) !== 0o600) {
    throw new Error('Private D-Bus config must remain a mode-0600 regular file in the candidate profile');
  }
  if (await hashFile(config.configPath) !== config.sha256) {
    throw new Error('Private D-Bus config changed after its pre-spawn hash was recorded');
  }
  if (await hashFile(path.join(candidate.evidence, 'dbus-session.conf')) !== config.sha256) {
    throw new Error('Retained private D-Bus config copy differs from the profile configuration hash');
  }
  let dbus;
  try {
    dbus = await launchLogged('dbus-daemon', buildPrivateDbusLaunch(config.configPath), {
      cwd: REPO_ROOT,
      env,
      logPath: path.join(candidate.evidence, 'dbus.log'),
    });
    onProcessStart('dbus', dbus);
    const busAddress = await waitForLine(dbus, 'private DBus');
    dbus.busAddress = busAddress;
    dbus.busAddressSha256 = sha256(Buffer.from(busAddress));
    const runtimeEnv = privateRuntimeEnv(candidate, xdg, { busAddress });
    const daemonInfo = await waitFor(async () => {
      const current = await readProcInfo(dbus.child.pid).catch(() => null);
      return current?.exe ? current : false;
    }, 'owned private D-Bus process metadata');
    const expectedDaemonArgv = buildPrivateDbusLaunch(config.configPath);
    const daemonArgvMatches = daemonInfo.argv.length === expectedDaemonArgv.length + 1
      && expectedDaemonArgv.every((argument, index) => daemonInfo.argv[index + 1] === argument);
    const daemonExecutableMatches = path.basename(daemonInfo.exe) === 'dbus-daemon';
    const daemonEnvironment = summarizeRuntimeEnvironment({
      actual: daemonInfo.environment,
      expected: env,
      forbiddenKeys: daemonInfo.forbiddenEnvironmentKeys,
      observedKeys: daemonInfo.observedEnvironmentKeys,
    });
    if (!daemonExecutableMatches || !daemonArgvMatches || !daemonEnvironment.ok) {
      throw new Error(`Owned private D-Bus process isolation mismatch: ${JSON.stringify({
        executableNameMatches: daemonExecutableMatches,
        expectedArgumentsMatch: daemonArgvMatches,
        environment: daemonEnvironment,
      })}`);
    }
    const daemonIsolation = {
      executableNameMatches: daemonExecutableMatches,
      expectedArgumentsMatch: daemonArgvMatches,
      environment: daemonEnvironment,
      argvSha256: sha256(Buffer.from(daemonInfo.argv.join('\0'))),
    };
    dbus.daemonIsolation = daemonIsolation;
    return { dbus, busAddress, busAddressSha256: dbus.busAddressSha256, dbusConfig: config, daemonIsolation, env: runtimeEnv };
  } catch (error) {
    const cleanupErrors = [];
    try { await finishLoggedProcess(dbus); }
    catch (cleanupError) { cleanupErrors.push(String(cleanupError)); }
    const details = cleanupErrors.length ? ` Cleanup errors: ${cleanupErrors.join(' | ')}` : '';
    throw new Error(`Could not start private DBus: ${error?.message ?? error}.${details}`, { cause: error });
  }
}

async function startPrivateDisplay(candidate, prepared, onProcessStart = () => {}) {
  const { xdg, dbusConfig } = prepared;
  let xvfb;
  let dbusRuntime;
  try {
    const env = privateRuntimeEnv(candidate, xdg);
    xvfb = await launchLogged('Xvfb', ['-displayfd', '1', '-screen', '0', '1440x1000x24', '-nolisten', 'tcp', '-noreset', '-ac'], {
      cwd: REPO_ROOT,
      env,
      logPath: path.join(candidate.evidence, 'xvfb.log'),
    });
    onProcessStart('xvfb', xvfb);
    const displayNumber = await waitForLine(xvfb, 'Xvfb');
    if (!/^\d+$/.test(displayNumber)) throw new Error(`Xvfb returned unexpected display number: ${displayNumber}`);
    const display = `:${displayNumber}`;
    dbusRuntime = await startPrivateDbus(candidate, xdg, dbusConfig, onProcessStart);
    const runtimeEnv = privateRuntimeEnv(candidate, xdg, { display, busAddress: dbusRuntime.busAddress });
    return {
      xvfb,
      dbus: dbusRuntime.dbus,
      display,
      busAddress: dbusRuntime.busAddress,
      busAddressSha256: dbusRuntime.busAddressSha256,
      dbusConfig: dbusRuntime.dbusConfig,
      daemonIsolation: dbusRuntime.daemonIsolation,
      env: runtimeEnv,
    };
  } catch (error) {
    const cleanupErrors = [];
    for (const processRecord of [dbusRuntime?.dbus, xvfb]) {
      try { await finishLoggedProcess(processRecord); }
      catch (cleanupError) { cleanupErrors.push(String(cleanupError)); }
    }
    const details = cleanupErrors.length ? ` Cleanup errors: ${cleanupErrors.join(' | ')}` : '';
    throw new Error(`Could not start the private display and DBus: ${error?.message ?? error}.${details}`, { cause: error });
  }
}

async function assertNoResponse(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(500) });
    throw new Error(`Refusing to use pre-existing WebDriver endpoint on port ${port} (HTTP ${response.status})`);
  } catch (error) {
    if (error?.message?.startsWith('Refusing')) throw error;
    if (error?.cause?.code !== 'ECONNREFUSED') {
      throw new Error(`Could not prove WebDriver port ${port} is unused: ${error?.message ?? error}`, { cause: error });
    }
  }
}

async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port }, () => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }).catch((error) => {
    throw new Error(`Refusing to launch WebDriver on occupied port ${port}: ${error?.message ?? error}`);
  });
}

async function startDriver(candidate, env, preferredPort = null, onProcessStart = () => {}) {
  const port = preferredPort ?? await reservePort();
  await assertNoResponse(port);
  await assertPortFree(port);
  const record = await launchLogged(candidate.driver, [
    '--port', String(port),
    '--native-driver', candidate.webkitDriver,
  ], {
    cwd: REPO_ROOT,
    env,
    logPath: path.join(candidate.evidence, 'tauri-driver.log'),
  });
  onProcessStart(record);
  try {
    await waitFor(() => processOwnsTcpListener(record.child.pid, port), `tauri-driver process owns port ${port}`, 10_000);
    await waitFor(async () => {
      if (record.child.exitCode !== null) throw new Error('tauri-driver exited during startup');
      try {
        const response = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(800) });
        return response.ok;
      } catch {
        return false;
      }
    }, `owned tauri-driver on port ${port}`, 15_000);
    return { ...record, port };
  } catch (error) {
    try { await finishLoggedProcess(record); }
    catch (cleanupError) {
      const cleanupReport = `Startup error: ${error?.stack ?? error}\nOwned-process cleanup error: ${cleanupError?.stack ?? cleanupError}\n`;
      try {
        await writeFile(path.join(candidate.evidence, 'tauri-driver-cleanup-failure.log'), cleanupReport, { flag: 'wx' });
      } catch (reportError) {
        process.stderr.write(`Could not persist tauri-driver cleanup failure: ${reportError?.stack ?? reportError}\n`);
      }
      if (error && typeof error === 'object') error.cleanupError = cleanupError;
      process.stderr.write(cleanupReport);
    }
    throw error;
  }
}

class WebDriver {
  constructor(port) {
    this.base = `http://127.0.0.1:${port}`;
    this.sessionId = null;
  }

  async request(method, endpoint, body) {
    const response = await fetch(`${this.base}${endpoint}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json; charset=utf-8' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(35_000),
    });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; } catch { throw new Error(`WebDriver returned non-JSON: ${raw.slice(0, 500)}`); }
    if (!response.ok || data.value?.error) {
      throw new Error(`WebDriver ${method} ${endpoint}: ${data.value?.error ?? response.status} ${data.value?.message ?? raw}`);
    }
    return data.value;
  }

  async createSession(binary) {
    const value = await this.request('POST', '/session', {
      capabilities: {
        alwaysMatch: {
          'tauri:options': { application: binary, args: [] },
        },
      },
    });
    this.sessionId = value.sessionId;
    return value;
  }

  path(suffix) {
    if (!this.sessionId) throw new Error('WebDriver session is not active');
    return `/session/${this.sessionId}${suffix}`;
  }

  async execute(script, args = []) {
    return this.request('POST', this.path('/execute/sync'), { script, args });
  }

  async refresh() {
    await this.request('POST', this.path('/refresh'), {});
  }

  async elements(selector) {
    return this.request('POST', this.path('/elements'), { using: 'css selector', value: selector });
  }

  async element(selector) {
    const elements = await this.elements(selector);
    if (!elements.length) throw new Error(`Element not found: ${selector}`);
    return elements[0][DRIVER_ELEMENT] ?? elements[0].ELEMENT;
  }

  async click(selector) {
    const id = await this.element(selector);
    return this.request('POST', this.path(`/element/${id}/click`), {});
  }

  async clear(selector) {
    const id = await this.element(selector);
    return this.request('POST', this.path(`/element/${id}/clear`), {});
  }

  async sendKeys(selector, text) {
    const id = await this.element(selector);
    return this.request('POST', this.path(`/element/${id}/value`), { text, value: [...text] });
  }

  async text(selector) {
    const id = await this.element(selector);
    return this.request('GET', this.path(`/element/${id}/text`));
  }

  async attribute(selector, name) {
    const id = await this.element(selector);
    return this.request('GET', this.path(`/element/${id}/attribute/${encodeURIComponent(name)}`));
  }

  async screenshot(file) {
    const value = await this.request('GET', this.path('/screenshot'));
    await writeFile(file, Buffer.from(value, 'base64'));
  }

  async closeSession() {
    if (!this.sessionId) return;
    try { await this.request('DELETE', `/session/${this.sessionId}`); } finally { this.sessionId = null; }
  }
}

async function waitForProvider(driver) {
  return waitFor(async () => {
    const value = await driver.execute(`return {
      count: document.querySelectorAll('[data-provider="polaris-dados"]').length,
      text: document.querySelector('[data-provider="polaris-dados"]')?.innerText ?? '',
      theme: document.documentElement.dataset.theme ?? '',
      locale: document.documentElement.lang ?? '',
    }`);
    return value.count === 1 ? value : false;
  }, 'one real Polaris Dados provider root');
}

async function setPreferences(driver, updates) {
  await driver.execute(`const key = 'morrow.preferences';
    const before = JSON.parse(localStorage.getItem(key) || '{}');
    localStorage.setItem(key, JSON.stringify({ ...before, ...arguments[0] }));`, [updates]);
  await driver.refresh();
}

async function recentOpenedAt(vault, pageId) {
  let text;
  try {
    text = await readFile(path.join(vault, '.morrow', 'recent.json'), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const recent = JSON.parse(text);
  const openedAt = recent?.opened?.[pageId];
  return typeof openedAt === 'number' && Number.isFinite(openedAt) ? openedAt : null;
}

async function waitForPageSaveSettled(driver, candidate, pageId, previousOpenedAt) {
  return waitFor(async () => {
    const indicator = await driver.execute(`const node = document.querySelector('.save-status');
      return {
        found: node !== null,
        saving: node?.classList.contains('is-saving') ?? false,
        error: node?.classList.contains('is-error') ?? false,
        text: node?.textContent?.trim() ?? '',
      }`);
    const openedAt = await recentOpenedAt(candidate.vault, pageId);
    const advanced = openedAt !== null && (previousOpenedAt === null || openedAt > previousOpenedAt);
    return indicator.found && !indicator.saving && !indicator.error && advanced
      ? { openedAt, status: indicator.text }
      : false;
  }, `persisted navigation and settled save state for ${pageId}`);
}

async function navigateToDatabase(driver, databaseId) {
  await driver.execute(`location.hash = '#/page/' + encodeURIComponent(arguments[0]);`, [databaseId]);
  await waitForProvider(driver);
}

async function navigateToRowPage(driver, rowId) {
  await driver.execute(`location.hash = '#/page/' + encodeURIComponent(arguments[0]);`, [rowId]);
  return waitFor(async () => {
    const page = await driver.execute(`return {
      title: document.querySelector('textarea.page-title')?.value ?? null,
      hasPageBody: document.querySelector('.page-scroll') !== null,
      providerCount: document.querySelectorAll('[data-provider="polaris-dados"]').length,
    }`);
    return page.title === 'Widget' && page.hasPageBody && page.providerCount === 0 ? page : false;
  }, 'Widget row page');
}

async function runtimeInfo(driver, expectedDataPath, expectedWebviewDataPath) {
  const info = await waitFor(() => driver.execute(`return window.__MORROW_INFO__ || null`), 'Morrow runtime identity', 30_000);
  if (info.dataPath !== expectedDataPath) {
    throw new Error(`Isolation check failed before UI interaction: runtime dataPath=${info.dataPath}; expected ${expectedDataPath}`);
  }
  if (info.platform !== 'linux') throw new Error(`Expected Linux native build, got platform=${info.platform}`);
  const webviewDataPath = await waitFor(async () => {
    try {
      const entry = await lstat(expectedWebviewDataPath);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(`WebView profile is not a real directory: ${expectedWebviewDataPath}`);
      }
      const resolved = await realpath(expectedWebviewDataPath);
      if (resolved !== expectedWebviewDataPath) {
        throw new Error(`WebView profile resolves outside its isolated directory: ${resolved}`);
      }
      return resolved;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  }, 'the identifier-scoped Tauri/WebView profile before UI interaction', 10_000);
  return { ...info, backendDataPath: info.dataPath, webviewDataPath };
}

function parseScalarFromMarkdown(markdown, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const line of markdown.split(/\r?\n/)) {
    const field = line.trim().match(new RegExp(`^(?:[-*]\\s*)?${escaped}\\s*::?\\s*(.*?)\\s*$`, 'i'));
    if (field) return cleanScalar(field[1]);
  }
  const lines = markdown.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('|'));
  for (let i = 0; i + 1 < lines.length; i += 1) {
    const headers = lines[i].split('|').slice(1, -1).map((cell) => cell.trim());
    if (!headers.includes(name)) continue;
    const valuesLine = lines.slice(i + 1).find((line) => !/^\|\s*:?-{2,}/.test(line));
    if (!valuesLine) return null;
    const values = valuesLine.split('|').slice(1, -1).map((cell) => cell.trim());
    const index = headers.indexOf(name);
    return cleanScalar(values[index] ?? '');
  }
  return null;
}

function cleanScalar(value) {
  return String(value).trim().replace(/^['"]|['"]$/g, '').replace(/^\*\*(.*)\*\*$/, '$1');
}

function assertNumber(markdown, name, expected) {
  const actual = parseScalarFromMarkdown(markdown, name);
  if (actual === null || Number(actual) !== expected) {
    throw new Error(`Expected ${name}=${expected} in persisted Markdown, found ${actual ?? '<missing>'}`);
  }
}

function assertFormula(markdown) {
  if (!/quantity\s*\*\s*price/i.test(markdown)) {
    throw new Error('Inventory.md no longer contains the Quantity * Price formula');
  }
}

async function recordStep(candidate, name, details = {}) {
  const line = JSON.stringify({ time: new Date().toISOString(), name, ...details });
  await writeFile(path.join(candidate.evidence, 'steps.ndjson'), `${line}\n`, { flag: 'a' });
  process.stdout.write(`${name}\n`);
}

async function saveRunInfo(candidate, extra) {
  const files = {};
  for (const relative of BANK_FILES) {
    const info = await captureFile(path.join(candidate.vault, relative));
    files[relative] = { sha256: info.hash, size: info.size, mtimeMs: info.mtimeMs };
  }
  const destinationFiles = {};
  for (const relative of BANK_FILES) {
    const info = await captureFile(path.join(candidate.destinationVault, relative));
    destinationFiles[relative] = { sha256: info.hash, size: info.size, mtimeMs: info.mtimeMs };
  }
  await writeFile(path.join(candidate.evidence, 'run.json'), `${JSON.stringify({
    candidate: {
      commit: candidate.expectedCommit,
      scenario: candidate.scenario ?? 'legacy',
      sourceManifest: candidate.sourceManifest,
      sourceManifestSha256: candidate.sourceManifestSha256,
      sourceStatusAtFreeze: candidate.sourceVerification.frozenStatus,
      sourceStatusAtRun: candidate.sourceVerification.currentStatus,
      sourceDiffAtFreezeSha256: candidate.sourceVerification.frozenDiffSha256,
      sourceDiffAtRunSha256: candidate.sourceVerification.currentDiffSha256,
      sourceTestHashes: candidate.sourceTestHashes,
      artifactManifest: candidate.artifactManifest,
      artifactManifestSha256: candidate.artifactManifestSha256,
      artifactInventory: candidate.artifactVerification,
      binary: candidate.binary,
      binarySha256: candidate.binarySha256,
      bundle: candidate.bundle,
      bundleSha256: candidate.bundleSha256,
      manifest: candidate.manifest,
      manifestSha256: candidate.manifestSha256,
      fixtureSha256: candidate.fixtureSha256,
      tauriDriver: candidate.driver,
      tauriDriverSha256: candidate.driverSha256,
      webkitDriver: candidate.webkitDriver,
      webkitDriverSha256: candidate.webkitDriverSha256,
      tauriConfig: candidate.tauriConfig,
      identifier: APP_IDENTIFIER,
    },
    isolated: {
      vault: candidate.vault,
      destinationVault: candidate.destinationVault,
      profile: candidate.profile,
      evidence: candidate.evidence,
      retainedEvidence: candidate.retainedEvidence,
      expectedBackendDataPath: candidate.expectedBackendDataPath,
      expectedWebviewDataPath: candidate.expectedWebviewDataPath,
      display: extra.display,
      dbusAddressSha256: extra.dbusAddressSha256,
      dbusConfigPath: extra.dbusConfigPath,
      dbusConfigSha256: extra.dbusConfigSha256,
      dbusConfigEvidencePath: extra.dbusConfigEvidencePath,
      dbusDaemonIsolation: extra.dbusDaemonIsolation ?? null,
      dbusLogAddressRedacted: extra.dbusLogAddressRedacted ?? null,
      driverPort: extra.driverPort,
      driverPid: extra.driverPid,
      xvfbPid: extra.xvfbPid,
      dbusPid: extra.dbusPid,
      dbusProcessTermination: extra.dbusProcessTermination ?? null,
      xdg: extra.xdg,
      driverSessions: extra.driverSessions,
    },
    fixtureFiles: candidate.fixtureFiles,
    generatedVaultFiles: { origin: candidate.vaultFiles ?? null, destination: candidate.destinationVaultFiles ?? null },
    databaseId: candidate.databaseId,
    destinationDatabaseId: candidate.destinationDatabaseId,
    linkedViews: candidate.linkedViews,
    generatedVaultContent: candidate.generatedVaultContent,
    isolatedVaultRegistry: candidate.isolatedVaultRegistry,
    finalVaultContent: extra.finalVaultContent ?? null,
    readinessFailureCapture: extra.readinessFailureCapture ?? null,
    runtimeInfo: extra.runtimeInfo ?? null,
    identityConfirmed: extra.identityConfirmed === true,
    appProcessCandidates: extra.appProcessCandidates ?? [],
    appProcesses: extra.appProcesses ?? [],
    dbusProbe: extra.dbusProbe ?? null,
    testHashes: extra.testHashes,
    bankFiles: files,
    destinationBankFiles: destinationFiles,
    outcome: extra.outcome ?? 'running',
    error: extra.error ?? null,
  }, null, 2)}\n`);
}

async function redactPrivateDbusLogAddress(candidate, dbusProcess) {
  if (!dbusProcess?.busAddress) return false;
  const logPath = path.join(candidate.evidence, 'dbus.log');
  const log = await readFile(logPath, 'utf8');
  if (!log.includes(dbusProcess.busAddress)) throw new Error('Private D-Bus log did not contain the owned address for redaction');
  const replacement = `<private D-Bus address sha256=${dbusProcess.busAddressSha256}>`;
  const sanitized = log.replaceAll(dbusProcess.busAddress, replacement);
  if (sanitized.includes(dbusProcess.busAddress)) throw new Error('Private D-Bus log address redaction was incomplete');
  await writeFile(logPath, sanitized, { mode: 0o600 });
  await chmod(logPath, 0o600);
  return true;
}

async function preflight(candidate, args) {
  const evidence = {
    commit: candidate.expectedCommit,
    sourceManifest: candidate.sourceManifest,
    sourceManifestSha256: candidate.sourceManifestSha256,
    sourceStatus: candidate.sourceVerification.currentStatus,
    sourceDiffSha256: candidate.sourceVerification.currentDiffSha256,
    sourceTestCount: Object.keys(candidate.sourceTestHashes).length,
    artifactManifest: candidate.artifactManifest,
    artifactManifestSha256: candidate.artifactManifestSha256,
    binary: candidate.binary,
    binarySha256: candidate.binarySha256,
    bundle: candidate.bundle,
    bundleSha256: candidate.bundleSha256,
    tauriDriver: candidate.driver,
    tauriDriverSha256: candidate.driverSha256,
    webkitDriver: candidate.webkitDriver,
    webkitDriverSha256: candidate.webkitDriverSha256,
    identifier: APP_IDENTIFIER,
    tauriConfig: candidate.tauriConfig,
    fixture: candidate.fixture,
    fixtureScript: candidate.fixtureScript,
    fixtureSha256: candidate.fixtureSha256,
    fixtureFiles: candidate.fixtureFiles,
    scenario: args.scenario ?? 'legacy',
    scenarioDispatchesToNativeRun: Boolean(args['run-native'] && candidate.scenario !== 'dbus-isolation'),
    scenarioDispatchesToPrivateDbusProbe: Boolean(args['run-native'] && candidate.scenario === 'dbus-isolation'),
    privateDbusProbeConfirmationPresent: Boolean(args['confirm-private-dbus-probe']),
    databaseId: candidate.databaseId,
    outputPaths: {
      vault: candidate.vault,
      destinationVault: candidate.destinationVault,
      profile: candidate.profile,
      evidence: candidate.evidence,
      retainedEvidence: candidate.retainedEvidence,
    },
    expectedBackendDataPath: candidate.expectedBackendDataPath,
    expectedWebviewDataPath: candidate.expectedWebviewDataPath,
    nativeRunRequested: Boolean(args['run-native']),
  };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (args['check-only']) return;
  if (!args['run-native'] || !args['confirm-synthetic-profile']) {
    throw new Error('Native launch requires both --run-native and --confirm-synthetic-profile');
  }
}

async function sendKey(driver, selector, text) {
  const id = await driver.element(selector);
  return driver.request('POST', driver.path(`/element/${id}/value`), { text, value: [...text] });
}

async function setInput(driver, value) {
  await driver.click('[data-provider="polaris-dados"] button[data-action="edit"][data-field="quantity"]');
  const editor = '[data-provider="polaris-dados"] input[type="number"][data-field="quantity"]';
  await waitFor(() => driver.elements(editor).then((items) => items.length === 1), 'quantity editor');
  await driver.click(editor);
  await sendKey(driver, editor, '\uE009a');
  await driver.sendKeys(editor, String(value));
  const focused = await driver.execute(`return document.activeElement?.matches('input[type="number"][data-field="quantity"]') === true`);
  if (!focused) throw new Error('Quantity editor lost focus while typing');
}

async function clickAction(driver, action) {
  await driver.click(`[data-provider="polaris-dados"] [data-action="${action}"]`);
}

async function waitBankValue(candidate, field, expected) {
  return waitFor(async () => {
    const markdown = await readFile(path.join(candidate.vault, 'Inventory', 'Widget.md'), 'utf8');
    return parseScalarFromMarkdown(markdown, field) !== null && Number(parseScalarFromMarkdown(markdown, field)) === expected
      ? markdown
      : false;
  }, `persisted ${field}=${expected}`);
}

async function emitNativeCommand(driver, command) {
  const result = await driver.execute(`
    const internals = window.__TAURI_INTERNALS__;
    if (!internals?.invoke) throw new Error('Tauri invoke bridge is not available');
    return await internals.invoke('plugin:event|emit', { event: 'morrow:command', payload: arguments[0] });
  `, [command]);
  return result;
}

async function openPluginSettings(driver, locale, pluginName) {
  await emitNativeCommand(driver, 'view.settings');
  await waitFor(() => driver.execute(`return Boolean(document.querySelector('.settings-dialog'))`), 'settings dialog');
  const sectionName = locale === 'es' ? 'Complementos' : 'Plugins';
  const clicked = await driver.execute(`
    const button = [...document.querySelectorAll('.settings-nav-item')]
      .find((item) => item.textContent.trim() === arguments[0]);
    if (!button) return false;
    button.click();
    return true;
  `, [sectionName]);
  if (!clicked) throw new Error(`Could not open the ${sectionName} settings section`);
  await waitFor(() => driver.execute(`return [...document.querySelectorAll('.settings-dialog [role="switch"]')]
    .some((item) => item.getAttribute('aria-label') === arguments[0])`, [pluginName]), 'plugin settings');
}

async function setPluginSwitch(driver, pluginName, enabled) {
  const switched = await driver.execute(`
    const target = [...document.querySelectorAll('.settings-dialog [role="switch"]')]
      .find((item) => item.getAttribute('aria-label') === arguments[0]);
    if (!target) return false;
    if ((target.getAttribute('aria-checked') === 'true') !== arguments[1]) target.click();
    return true;
  `, [pluginName, enabled]);
  if (!switched) throw new Error(`Could not locate plugin switch ${pluginName}`);
}

async function closeSettings(driver, locale) {
  const closeLabel = locale === 'pt' ? 'Fechar configurações' : locale === 'es' ? 'Cerrar ajustes' : 'Close settings';
  const closed = await driver.execute(`
    const button = document.querySelector('.settings-dialog button[aria-label="' + arguments[0] + '"]');
    if (!button) return false;
    button.click();
    return true;
  `, [closeLabel]);
  if (!closed) throw new Error('Could not close plugin settings');
  await waitFor(() => driver.execute(`return !document.querySelector('.settings-dialog')`), 'settings dialog close');
}

async function waitPluginEnabledFile(candidate, enabled) {
  return waitFor(async () => {
    const state = JSON.parse(await readFile(path.join(candidate.vault, '.morrow', 'plugins.json'), 'utf8'));
    return Array.isArray(state.enabled) && state.enabled.includes(PILOT_ID) === enabled;
  }, `plugin enabled=${enabled} in vault settings`);
}

async function clickAndSave(driver, candidate, value) {
  await setInput(driver, value);
  await clickAction(driver, 'save');
  await waitBankValue(candidate, 'Quantity', value);
  const markdown = await readFile(path.join(candidate.vault, 'Inventory', 'Widget.md'), 'utf8');
  assertNumber(markdown, 'Quantity', value);
  assertNumber(markdown, 'Price', 10);
  assertFormula(await readFile(path.join(candidate.vault, 'Inventory.md'), 'utf8'));
  await waitForTotal(driver, value * 10);
  return markdown;
}

async function waitForGridNumber(driver, propertyId, expected) {
  return waitFor(async () => {
    const value = await driver.execute(`const cell = document.querySelector('[data-provider="polaris-dados"] [data-property-id="' + arguments[0] + '"]');
      return { kind: cell?.dataset.valueKind ?? null, text: cell?.textContent?.trim() ?? null }`, [propertyId]);
    return value.kind === 'number' && value.text === String(expected) ? value : false;
  }, `computed ${propertyId} ${expected}`);
}

async function waitForTotal(driver, expected) {
  return waitForGridNumber(driver, 'total', expected);
}

async function openPageAndCheck(driver, candidate, { quantity, price, total, previousOpenedAt }) {
  await navigateToDatabase(driver, candidate.databaseId);
  await waitForGridNumber(driver, 'quantity', quantity);
  await waitForGridNumber(driver, 'price', price);
  await waitForTotal(driver, total);
  await waitForPageSaveSettled(driver, candidate, candidate.databaseId, previousOpenedAt);
  const rootText = await driver.text('[data-provider="polaris-dados"]');
  const rowId = await driver.attribute('[data-provider="polaris-dados"] button[data-action="edit"][data-field="quantity"]', 'data-row-id');
  if (!rowId) throw new Error('Quantity control is missing stable data-row-id');
  return { rootText, rowId };
}

async function runNative(candidate, prepared, scenarioCallback = null, scenarioName = 'legacy') {
  let env = privateRuntimeEnv(candidate, prepared.xdg);
  const testHashes = candidate.sourceTestHashes;
  let display;
  const displayProcesses = {};
  let runtime = null;
  let driverRecord;
  let webdriver;
  let sessionCreated = false;
  let outcome = 'running';
  let error = null;
  let primaryFailure = null;
  let cleanupFailure = null;
  let processLogsFlushed = false;
  let identityConfirmed = false;
  const info = { testHashes, identityConfirmed: false, appProcessCandidates: [] };

  async function openSession() {
    identityConfirmed = false;
    info.identityConfirmed = false;
    await assertCandidateStillFrozen(candidate);
    driverRecord = await startDriver(candidate, env, null, (record) => { driverRecord = record; });
    info.driverPort = driverRecord.port;
    info.driverPid = driverRecord.child.pid;
    info.xvfbPid = display?.xvfb?.child?.pid;
    info.dbusPid = display?.dbus?.child?.pid;
    info.xdg = {
      config: env.XDG_CONFIG_HOME,
      data: env.XDG_DATA_HOME,
      cache: env.XDG_CACHE_HOME,
      runtime: env.XDG_RUNTIME_DIR,
    };
    await saveRunInfo(candidate, { ...info, identityConfirmed: false, outcome: 'running' });
    webdriver = new WebDriver(driverRecord.port);
    await webdriver.createSession(candidate.binary);
    sessionCreated = true;
    info.driverSessions ??= [];
    const driverSession = { pid: driverRecord.child.pid, port: driverRecord.port, appPid: null };
    info.driverSessions.push(driverSession);
    await saveRunInfo(candidate, { ...info, identityConfirmed: false, outcome: 'running' });
    const appProcess = await findOwnedAppProcess(driverRecord.child.pid, candidate);
    const appProcessCandidate = summarizeAppProcessCandidate(appProcess, driverRecord.child.pid, candidate);
    driverSession.appPid = appProcess.pid;
    info.appProcessCandidates ??= [];
    info.appProcessCandidates.push(appProcessCandidate);
    await saveRunInfo(candidate, { ...info, identityConfirmed: false, outcome: 'running' });

    runtime = await runtimeInfo(webdriver, candidate.expectedBackendDataPath, candidate.expectedWebviewDataPath);
    const appEnvironment = await verifyAppStageRuntimeEnvironment(appProcess, candidate, env);
    identityConfirmed = true;
    info.identityConfirmed = true;
    info.appProcesses ??= [];
    info.appProcesses.push({ ...appProcessCandidate, identityConfirmed: true, environment: appEnvironment });
    info.runtimeInfo = runtime;
    await saveRunInfo(candidate, { ...info, identityConfirmed: true, outcome: 'running' });
    await recordStep(candidate, 'isolated-runtime-path-confirmed', { dataPath: runtime.dataPath, pid: driverRecord.child.pid });
  }

  async function stopSession() {
    identityConfirmed = false;
    info.identityConfirmed = false;
    if (webdriver && sessionCreated) {
      try { await webdriver.closeSession(); }
      finally { sessionCreated = false; }
    }
    if (driverRecord?.child?.pid) {
      await finishLoggedProcess(driverRecord);
      driverRecord = null;
    }
    webdriver = null;
  }

  try {
    await assertCandidateStillFrozen(candidate);
    if (scenarioName === 'dbus-isolation') {
      display = await startPrivateDbus(candidate, prepared.xdg, prepared.dbusConfig, (name, record) => { displayProcesses[name] = record; });
      env = display.env;
      info.display = null;
      info.dbusAddressSha256 = sha256(Buffer.from(display.busAddress));
      info.dbusConfigPath = display.dbusConfig.configPath;
      info.dbusConfigSha256 = display.dbusConfig.sha256;
      info.dbusConfigEvidencePath = prepared.dbusConfigEvidencePath;
      info.dbusDaemonIsolation = display.daemonIsolation;
      info.dbusPid = display.dbus.child.pid;
      info.xdg = {
        config: env.XDG_CONFIG_HOME,
        data: env.XDG_DATA_HOME,
        cache: env.XDG_CACHE_HOME,
        runtime: env.XDG_RUNTIME_DIR,
      };
      await saveRunInfo(candidate, { ...info, outcome: 'prepared' });
      await recordStep(candidate, 'private-dbus-started-without-app-or-display', {
        dbusPid: info.dbusPid,
        dbusAddressSha256: info.dbusAddressSha256,
        dbusConfigSha256: info.dbusConfigSha256,
      });
      info.dbusProbe = {
        secretServiceWasContacted: false,
        applicationLaunched: false,
        xvfbLaunched: false,
        webdriverLaunched: false,
      };
      info.dbusProbe = await probePrivateDbus(
        env,
        (name, details) => recordStep(candidate, name, details),
        info.dbusProbe,
      );
      outcome = 'passed';
      await recordStep(candidate, 'private-dbus-isolation-probe-passed', info.dbusProbe);
    } else {
      display = await startPrivateDisplay(candidate, prepared, (name, record) => { displayProcesses[name] = record; });
      env = display.env;
      info.display = display.display;
      info.dbusAddressSha256 = display.busAddressSha256;
      info.dbusConfigPath = display.dbusConfig.configPath;
      info.dbusConfigSha256 = display.dbusConfig.sha256;
      info.dbusConfigEvidencePath = prepared.dbusConfigEvidencePath;
      info.dbusDaemonIsolation = display.daemonIsolation;
      await saveRunInfo(candidate, { ...info, outcome: 'prepared' });
      await recordStep(candidate, 'synthetic-vault-profile-prepared', {
        bankBaseline: Object.fromEntries(Object.entries(prepared.bankBefore).map(([name, value]) => [name, { sha256: value.hash, mtimeMs: value.mtimeMs }])),
      });
      const initialRow = prepared.bankBefore['Inventory/Widget.md'].bytes.toString('utf8');
      const initialSchema = prepared.bankBefore['Inventory.md'].bytes.toString('utf8');
      assertNumber(initialRow, 'Quantity', 2);
      assertNumber(initialRow, 'Price', 10);
      assertFormula(initialSchema);
      await openSession();

      const verifyCurrentRuntimeIdentity = async () => {
        try {
          runtime = await runtimeInfo(webdriver, candidate.expectedBackendDataPath, candidate.expectedWebviewDataPath);
          identityConfirmed = true;
          info.identityConfirmed = true;
          info.runtimeInfo = runtime;
          return runtime;
        } catch (identityError) {
          identityConfirmed = false;
          info.identityConfirmed = false;
          throw identityError;
        }
      };
      if (UI_PREPARATION_SCENARIOS.has(scenarioName)) {
        await prepareNativeUi({
          driver: webdriver,
          candidate,
          prepared,
          beginRuntimeRefresh: () => {
            identityConfirmed = false;
            info.identityConfirmed = false;
          },
          verifyRuntimeIdentity: verifyCurrentRuntimeIdentity,
          recordStep: (name, details = {}) => recordStep(candidate, name, details),
        });
      } else if (scenarioName !== 'app-identity-only') {
        // The legacy smoke keeps its historical defaults; ticket #160 uses real Settings UI above.
        await setPreferences(webdriver, { plugins: true, startPage: 'home', locale: 'en', theme: 'dark' });
        await verifyCurrentRuntimeIdentity();
      }
      if (scenarioName === 'app-identity-only') {
        await scenarioCallback({
          candidate,
          identityConfirmed,
          appProcessCount: info.appProcesses?.length ?? 0,
        });
        outcome = 'passed';
      } else if (scenarioCallback) {
        const context = {
          get driver() { return webdriver; },
          candidate,
          prepared,
          restartSession: async () => {
            await stopSession();
            await openSession();
            return webdriver;
          },
          recordStep: (name, details = {}) => recordStep(candidate, name, details),
        };
        await scenarioCallback(context);
        const finalStatus = await webdriver.execute(`return [...document.querySelectorAll('[role="status"]')].map((node) => node.innerText).join(' | ')`);
        if (/pending|saving|error|failed/i.test(finalStatus)) throw new Error(`Refusing to close with pending/error status: ${finalStatus}`);
        outcome = 'passed';
        await recordStep(candidate, `native-${scenarioName}-scenario-passed`, { finalStatus });
    } else {
    const databaseOpenedAtBeforeInitial = await recentOpenedAt(candidate.vault, candidate.databaseId);
    const initial = await openPageAndCheck(webdriver, candidate, {
      quantity: 2,
      price: 10,
      total: 20,
      previousOpenedAt: databaseOpenedAtBeforeInitial,
    });
    const afterInitialOpen = await captureBank(candidate.vault);
    const initialOpenComparison = Object.fromEntries(BANK_FILES.map((relative) => {
      const before = prepared.bankBefore[relative];
      const after = afterInitialOpen[relative];
      return [relative, {
        before: { sha256: before.hash, mtimeMs: before.mtimeMs, size: before.size },
        after: { sha256: after.hash, mtimeMs: after.mtimeMs, size: after.size },
        bytesUnchanged: before.hash === after.hash,
        mtimeUnchanged: before.mtimeMs === after.mtimeMs,
      }];
    }));
    await writeFile(path.join(candidate.evidence, 'initial-open-bank-comparison.json'), `${JSON.stringify({
      observedAt: new Date().toISOString(),
      comparison: initialOpenComparison,
    }, null, 2)}\n`);
    await recordStep(candidate, 'initial-open-bank-bytes-and-mtime-captured', { comparison: initialOpenComparison });
    const changedAfterOpen = BANK_FILES.find((relative) => {
      const file = initialOpenComparison[relative];
      return !file.bytesUnchanged || !file.mtimeUnchanged;
    });
    if (changedAfterOpen) {
      throw new Error(`Opening the database changed persisted bytes or mtime for ${changedAfterOpen} before any user edit`);
    }
    await webdriver.screenshot(path.join(candidate.evidence, 'initial-grid.png'));
    await recordStep(candidate, 'initial-20', { rowId: initial.rowId, rootText: initial.rootText, bankFiles: initialOpenComparison });

    const beforeRowPage = await captureBank(candidate.vault);
    const rowOpenedAtBeforePage = await recentOpenedAt(candidate.vault, initial.rowId);
    await navigateToRowPage(webdriver, initial.rowId);
    await waitForPageSaveSettled(webdriver, candidate, initial.rowId, rowOpenedAtBeforePage);
    const rowPage = await webdriver.execute(`const rows = [...document.querySelectorAll('.row-props .row-prop')];
      const properties = Object.fromEntries(rows.map((row) => [
        row.querySelector('.row-prop-name')?.textContent?.trim() ?? '',
        row.querySelector('.row-prop-value')?.textContent?.trim() ?? '',
      ]));
      return {
        title: document.querySelector('textarea.page-title')?.value ?? null,
        titleReadonly: document.querySelector('textarea.page-title')?.readOnly ?? false,
        editablePropertyNames: document.querySelectorAll('.row-props .row-prop-name.row-prop-button').length,
        propertyEditors: document.querySelectorAll('.row-props input, .row-props textarea, .row-props select, .row-props .row-prop-actions button').length,
        properties,
        formulaLiteral: document.querySelector('.formula-source-literal')?.textContent?.trim() ?? null,
      }`);
    if (rowPage.title !== 'Widget' || !rowPage.titleReadonly || rowPage.editablePropertyNames !== 0 || rowPage.propertyEditors !== 0) {
      throw new Error(`Widget properties are not rendered read-only on the row page: ${JSON.stringify(rowPage)}`);
    }
    if (rowPage.properties.Quantity !== '2' || rowPage.properties.Price !== '10' || rowPage.properties.Total !== 'Quantity * Price' || rowPage.formulaLiteral !== 'Quantity * Price') {
      throw new Error(`Widget row properties or formula source changed on its page: ${JSON.stringify(rowPage)}`);
    }
    await webdriver.screenshot(path.join(candidate.evidence, 'widget-row-page.png'));
    const databaseOpenedAtBeforeReturn = await recentOpenedAt(candidate.vault, candidate.databaseId);
    await navigateToDatabase(webdriver, candidate.databaseId);
    await waitForGridNumber(webdriver, 'quantity', 2);
    await waitForGridNumber(webdriver, 'price', 10);
    await waitForTotal(webdriver, 20);
    await waitForPageSaveSettled(webdriver, candidate, candidate.databaseId, databaseOpenedAtBeforeReturn);
    const afterRowPage = await captureBank(candidate.vault);
    const rowPageBankComparison = Object.fromEntries(BANK_FILES.map((relative) => {
      const before = beforeRowPage[relative];
      const after = afterRowPage[relative];
      return [relative, {
        before: { sha256: before.hash, mtimeMs: before.mtimeMs, size: before.size },
        after: { sha256: after.hash, mtimeMs: after.mtimeMs, size: after.size },
        bytesUnchanged: before.hash === after.hash,
        mtimeUnchanged: before.mtimeMs === after.mtimeMs,
      }];
    }));
    await writeFile(path.join(candidate.evidence, 'row-page-open-bank-comparison.json'), `${JSON.stringify({
      observedAt: new Date().toISOString(),
      rowId: initial.rowId,
      properties: rowPage,
      comparison: rowPageBankComparison,
    }, null, 2)}\n`);
    const changedAfterRowPage = BANK_FILES.find((relative) => {
      const file = rowPageBankComparison[relative];
      return !file.bytesUnchanged || !file.mtimeUnchanged;
    });
    if (changedAfterRowPage) {
      throw new Error(`Opening and leaving the Widget row page changed persisted bytes or mtime for ${changedAfterRowPage}`);
    }
    await recordStep(candidate, 'widget-row-page-open-return-preserved-source', {
      rowId: initial.rowId,
      properties: rowPage,
      bankFiles: rowPageBankComparison,
      totalAfterReturn: 20,
    });

    const beforeCancel = await captureBank(candidate.vault);
    await setInput(webdriver, 3);
    await clickAction(webdriver, 'cancel');
    const afterCancel = await captureBank(candidate.vault);
    for (const relative of BANK_FILES) {
      if (beforeCancel[relative].hash !== afterCancel[relative].hash || beforeCancel[relative].mtimeMs !== afterCancel[relative].mtimeMs) {
        throw new Error(`Cancel changed persisted bank file ${relative}`);
      }
    }
    await waitForTotal(webdriver, 20);
    await recordStep(candidate, 'cancel-left-bank-bytes-and-mtime-unchanged');

    await clickAndSave(webdriver, candidate, 3);
    const saved3 = await captureBank(candidate.vault);
    if (saved3['Inventory.md'].hash !== beforeCancel['Inventory.md'].hash) throw new Error('Saving a row changed the database schema/source file');
    if (saved3['Inventory/Widget.md'].hash === beforeCancel['Inventory/Widget.md'].hash) throw new Error('Saving Quantity=3 did not persist the row file');
    await webdriver.screenshot(path.join(candidate.evidence, 'saved-quantity-3-total-30.png'));
    await recordStep(candidate, 'quantity-3-total-30-persisted', { rowFileSha256: saved3['Inventory/Widget.md'].hash });

    // Keyboard route through the focused host root; menu route emits the same
    // app command the native Tauri menu sends to the main webview.
    await webdriver.click('[data-provider="polaris-dados"]');
    await sendKey(webdriver, '[data-provider="polaris-dados"]', '\uE009z');
    let markdown = await waitBankValue(candidate, 'Quantity', 2);
    await waitForTotal(webdriver, 20);
    await recordStep(candidate, 'keyboard-undo-20-persisted');
    await sendKey(webdriver, '[data-provider="polaris-dados"]', '\uE009y');
    markdown = await waitBankValue(candidate, 'Quantity', 3);
    await waitForTotal(webdriver, 30);
    await recordStep(candidate, 'keyboard-redo-30-persisted');
    await emitNativeCommand(webdriver, 'edit.undo');
    markdown = await waitBankValue(candidate, 'Quantity', 2);
    await waitForTotal(webdriver, 20);
    await recordStep(candidate, 'native-menu-command-undo-20-persisted', { method: 'Tauri app event morrow:command/edit.undo' });
    await emitNativeCommand(webdriver, 'edit.redo');
    markdown = await waitBankValue(candidate, 'Quantity', 3);
    await waitForTotal(webdriver, 30);
    await recordStep(candidate, 'native-menu-command-redo-30-persisted', { method: 'Tauri app event morrow:command/edit.redo' });

    await clickAndSave(webdriver, candidate, 0);
    markdown = await readFile(path.join(candidate.vault, 'Inventory', 'Widget.md'), 'utf8');
    assertNumber(markdown, 'Quantity', 0);
    await waitForTotal(webdriver, 0);
    await recordStep(candidate, 'zero-is-a-persisted-value');
    await emitNativeCommand(webdriver, 'edit.undo');
    markdown = await waitBankValue(candidate, 'Quantity', 3);
    await waitForTotal(webdriver, 30);

    // Locale changes preserve user schema field names. Theme is checked through
    // the host's resolved document attribute, and each locale is a full reload.
    for (const locale of ['pt', 'es', 'en']) {
      await setPreferences(webdriver, { locale, theme: locale === 'es' ? 'light' : 'dark', plugins: true, startPage: 'home' });
      await runtimeInfo(webdriver, candidate.expectedBackendDataPath, candidate.expectedWebviewDataPath);
      await navigateToDatabase(webdriver, candidate.databaseId);
      const localized = await webdriver.execute(`return {
        locale: JSON.parse(localStorage.getItem('morrow.preferences') || '{}').locale,
        theme: document.documentElement.dataset.theme,
        schemaNamesPresent: ['Name', 'Quantity', 'Price', 'Total'].every((name) => document.querySelector('[data-provider="polaris-dados"]')?.innerText.includes(name)),
        tableLabel: document.querySelector('[data-provider="polaris-dados"] table')?.getAttribute('aria-label') ?? '',
        editLabel: document.querySelector('[data-provider="polaris-dados"] button[data-action="edit"][data-field="quantity"]')?.getAttribute('aria-label') ?? '',
      }`);
      const expectedLabels = {
        pt: { table: 'Polaris Dados', edit: 'Editar Quantity de Widget' },
        es: { table: 'Polaris Datos', edit: 'Editar Quantity para Widget' },
        en: { table: 'Polaris Data', edit: 'Edit Quantity for Widget' },
      };
      if (!localized.schemaNamesPresent || localized.locale !== locale || localized.tableLabel !== expectedLabels[locale].table || localized.editLabel !== expectedLabels[locale].edit) {
        throw new Error(`Localized grid labels did not match ${locale}: ${JSON.stringify(localized)}`);
      }
      const expectedTheme = locale === 'es' ? 'light' : 'dark';
      if (localized.theme !== expectedTheme) throw new Error(`Theme did not apply in ${locale}: ${localized.theme}`);
      await webdriver.screenshot(path.join(candidate.evidence, `locale-${locale}-${expectedTheme}.png`));
      const beforeLocaleCancel = await captureFile(path.join(candidate.vault, 'Inventory', 'Widget.md'));
      await webdriver.click('[data-provider="polaris-dados"] button[data-action="edit"][data-field="quantity"]');
      const controls = await webdriver.execute(`return {
        save: document.querySelector('[data-provider="polaris-dados"] [data-action="save"]')?.textContent ?? '',
        cancel: document.querySelector('[data-provider="polaris-dados"] [data-action="cancel"]')?.textContent ?? '',
      }`);
      const expectedControls = {
        pt: { save: 'Salvar', cancel: 'Cancelar' },
        es: { save: 'Guardar', cancel: 'Cancelar' },
        en: { save: 'Save', cancel: 'Cancel' },
      };
      if (controls.save !== expectedControls[locale].save || controls.cancel !== expectedControls[locale].cancel) {
        throw new Error(`Localized editor actions did not match ${locale}: ${JSON.stringify(controls)}`);
      }
      await clickAction(webdriver, 'cancel');
      const afterLocaleCancel = await captureFile(path.join(candidate.vault, 'Inventory', 'Widget.md'));
      if (beforeLocaleCancel.hash !== afterLocaleCancel.hash || beforeLocaleCancel.mtimeMs !== afterLocaleCancel.mtimeMs) {
        throw new Error(`Locale ${locale} cancel changed persisted data`);
      }
      await recordStep(candidate, `locale-theme-${locale}-${expectedTheme}`, localized);
    }

    // Draft-local undo must not consume database history or alter persisted bytes.
    const beforeDraft = await captureFile(path.join(candidate.vault, 'Inventory', 'Widget.md'));
    await setInput(webdriver, 4);
    await sendKey(webdriver, '[data-provider="polaris-dados"] input[type="number"][data-field="quantity"]', '\uE009z');
    const draftValue = await webdriver.execute(`return document.querySelector('[data-provider="polaris-dados"] input[type="number"][data-field="quantity"]')?.value ?? null`);
    if (draftValue !== '3') throw new Error(`Ctrl+Z did not prioritize the input draft; value=${draftValue}`);
    const afterDraft = await captureFile(path.join(candidate.vault, 'Inventory', 'Widget.md'));
    if (beforeDraft.hash !== afterDraft.hash || beforeDraft.mtimeMs !== afterDraft.mtimeMs) throw new Error('Input draft undo changed persisted data');
    await clickAction(webdriver, 'cancel');
    await recordStep(candidate, 'input-draft-undo-kept-database-history-and-file-unchanged');

    // Exercise actual WebKit input undo/redo from a second draft, then persist
    // the restored value. Ctrl+Z inside the editor must stay in native text
    // editing history instead of invoking Morrow's database history.
    const beforeUndoRedoSave = await captureFile(path.join(candidate.vault, 'Inventory', 'Widget.md'));
    await setInput(webdriver, 4);
    const quantityEditor = '[data-provider="polaris-dados"] input[type="number"][data-field="quantity"]';
    await sendKey(webdriver, quantityEditor, '\uE009z');
    let restoredDraft = await webdriver.execute(`return document.querySelector('[data-provider="polaris-dados"] input[type="number"][data-field="quantity"]')?.value ?? null`);
    if (restoredDraft !== '3') throw new Error(`Native input undo did not restore Quantity=3 before redo; value=${restoredDraft}`);
    await sendKey(webdriver, quantityEditor, '\uE009\uE008z');
    restoredDraft = await webdriver.execute(`return document.querySelector('[data-provider="polaris-dados"] input[type="number"][data-field="quantity"]')?.value ?? null`);
    if (restoredDraft !== '4') throw new Error(`Native input redo did not restore Quantity=4; value=${restoredDraft}`);
    await sendKey(webdriver, quantityEditor, '\uE009z');
    restoredDraft = await webdriver.execute(`return document.querySelector('[data-provider="polaris-dados"] input[type="number"][data-field="quantity"]')?.value ?? null`);
    if (restoredDraft !== '3') throw new Error(`Native input undo did not restore Quantity=3 before Save; value=${restoredDraft}`);
    const beforeUndoRedoCommit = await captureFile(path.join(candidate.vault, 'Inventory', 'Widget.md'));
    if (beforeUndoRedoSave.hash !== beforeUndoRedoCommit.hash || beforeUndoRedoSave.mtimeMs !== beforeUndoRedoCommit.mtimeMs) {
      throw new Error('Input undo/redo changed persisted row bytes or mtime before Save');
    }
    await clickAction(webdriver, 'save');
    await waitBankValue(candidate, 'Quantity', 3);
    await waitForTotal(webdriver, 30);
    const afterUndoRedoSave = await readFile(path.join(candidate.vault, 'Inventory', 'Widget.md'), 'utf8');
    assertNumber(afterUndoRedoSave, 'Quantity', 3);
    assertNumber(afterUndoRedoSave, 'Price', 10);
    await waitForTotal(webdriver, 30);
    await recordStep(candidate, 'native-input-undo-redo-saved-restored-quantity-3', {
      draftBeforeSave: restoredDraft,
      rowFileSha256: sha256(Buffer.from(afterUndoRedoSave)),
      total: 30,
    });

    // Reopen the exact debug binary with the same isolated profile/vault.
    const beforeRestartBank = await captureBank(candidate.vault);
    const databaseOpenedAtBeforeRestart = await recentOpenedAt(candidate.vault, candidate.databaseId);
    await stopSession();
    await openSession();
    await runtimeInfo(webdriver, candidate.expectedBackendDataPath, candidate.expectedWebviewDataPath);
    const reopened = await openPageAndCheck(webdriver, candidate, {
      quantity: 3,
      price: 10,
      total: 30,
      previousOpenedAt: databaseOpenedAtBeforeRestart,
    });
    if (reopened.rowId !== initial.rowId) throw new Error(`Row ID changed across app restart: ${initial.rowId} -> ${reopened.rowId}`);
    const afterRestartBank = await captureBank(candidate.vault);
    const restartBankComparison = Object.fromEntries(BANK_FILES.map((relative) => {
      const before = beforeRestartBank[relative];
      const after = afterRestartBank[relative];
      return [relative, {
        before: { sha256: before.hash, mtimeMs: before.mtimeMs, size: before.size },
        after: { sha256: after.hash, mtimeMs: after.mtimeMs, size: after.size },
        bytesUnchanged: before.hash === after.hash,
        mtimeUnchanged: before.mtimeMs === after.mtimeMs,
      }];
    }));
    await writeFile(path.join(candidate.evidence, 'restart-bank-comparison.json'), `${JSON.stringify({
      observedAt: new Date().toISOString(),
      rowId: reopened.rowId,
      expectedGrid: { quantity: 3, price: 10, total: 30 },
      comparison: restartBankComparison,
    }, null, 2)}\n`);
    const changedAfterRestart = BANK_FILES.find((relative) => {
      const file = restartBankComparison[relative];
      return !file.bytesUnchanged || !file.mtimeUnchanged;
    });
    if (changedAfterRestart) {
      throw new Error(`Reopening the saved database changed source bytes or mtime for ${changedAfterRestart}`);
    }
    markdown = await readFile(path.join(candidate.vault, 'Inventory', 'Widget.md'), 'utf8');
    assertNumber(markdown, 'Quantity', 3);
    assertNumber(markdown, 'Price', 10);
    assertFormula(await readFile(path.join(candidate.vault, 'Inventory.md'), 'utf8'));
    await recordStep(candidate, 'app-reopen-preserved-row-id-and-source-hashes', {
      rowId: reopened.rowId,
      grid: { quantity: 3, price: 10, total: 30 },
      bankFiles: restartBankComparison,
    });

    // Toggle this plugin through Morrow's real Plugins settings so unload and
    // reload exercise the host lifecycle, not just a webview restart.
    await openPluginSettings(webdriver, 'en', candidate.pluginName);
    await setPluginSwitch(webdriver, candidate.pluginName, false);
    await waitPluginEnabledFile(candidate, false);
    const fallbackMounted = await waitFor(() => webdriver.execute(`return document.querySelectorAll('[data-provider="polaris-dados"]').length === 0`), 'provider cleanup after disable');
    if (!fallbackMounted) throw new Error('Plugin disable did not remove its provider root');
    await closeSettings(webdriver, 'en');
    const disabled = await webdriver.execute(`return document.body.innerText`);
    for (const value of ['Widget', 'Quantity', 'Price']) {
      if (!disabled.includes(value)) throw new Error(`Fallback view lost ${value} after plugin disable`);
    }
    await webdriver.screenshot(path.join(candidate.evidence, 'plugin-disabled-fallback.png'));
    await recordStep(candidate, 'plugin-disabled-fallback-remains-readable');

    await openPluginSettings(webdriver, 'en', candidate.pluginName);
    await setPluginSwitch(webdriver, candidate.pluginName, true);
    await waitPluginEnabledFile(candidate, true);
    const reenabled = await waitForProvider(webdriver);
    if (reenabled.count !== 1) throw new Error(`Expected one provider root after re-enable, got ${reenabled.count}`);
    const reloadClicked = await webdriver.execute(`
      const button = document.querySelector('.settings-dialog button[aria-label="Reload"]');
      if (!button) return false;
      button.click();
      return true;
    `);
    if (!reloadClicked) throw new Error('Could not trigger the plugin Reload action');
    await delay(300);
    const afterReload = await waitForProvider(webdriver);
    if (afterReload.count !== 1) throw new Error(`Expected exactly one provider after Reload, got ${afterReload.count}`);
    await closeSettings(webdriver, 'en');
    const beforeSingleSave = await captureFile(path.join(candidate.vault, 'Inventory', 'Widget.md'));
    await clickAndSave(webdriver, candidate, 4);
    const afterSingleSave = await captureFile(path.join(candidate.vault, 'Inventory', 'Widget.md'));
    if (beforeSingleSave.hash === afterSingleSave.hash) throw new Error('Re-enabled provider did not persist a single save');
    markdown = await readFile(path.join(candidate.vault, 'Inventory', 'Widget.md'), 'utf8');
    assertNumber(markdown, 'Quantity', 4);
    await waitForTotal(webdriver, 40);
    await recordStep(candidate, 'plugin-reenabled-single-save-persisted-once', { providerRoots: afterReload.count });
    await emitNativeCommand(webdriver, 'edit.undo');
    markdown = await waitBankValue(candidate, 'Quantity', 3);
    await waitForTotal(webdriver, 30);
    await emitNativeCommand(webdriver, 'edit.redo');
    markdown = await waitBankValue(candidate, 'Quantity', 4);
    await waitForTotal(webdriver, 40);
    await recordStep(candidate, 'single-history-step-after-reactivation');
    await webdriver.screenshot(path.join(candidate.evidence, 'reenabled-single-provider.png'));

    const finalStatus = await webdriver.execute(`return [...document.querySelectorAll('[role="status"]')].map((node) => node.innerText).join(' | ')`);
    if (/pending|saving|error|failed/i.test(finalStatus)) throw new Error(`Refusing to close with pending/error status: ${finalStatus}`);
    outcome = 'passed';
    await recordStep(candidate, 'native-bank-smoke-passed', { finalStatus });
      }
    }
  } catch (caught) {
    error = caught?.stack ?? String(caught);
    if (caught?.cleanupError) error += `\nOwned-process cleanup error: ${caught.cleanupError?.stack ?? caught.cleanupError}`;
    outcome = 'failed';
    primaryFailure = caught;
    if (UI_PREPARATION_SCENARIOS.has(scenarioName)) {
      try {
        info.readinessFailureCapture = await captureNativeReadinessFailure({
          driver: webdriver,
          candidate,
          scenarioName,
          identityConfirmed,
          error: caught,
        });
      } catch (captureError) {
        info.readinessFailureCapture = {
          status: 'failed',
          errorName: captureError?.name ?? 'Error',
        };
      }
    }
  } finally {
    const cleanupErrors = [];
    identityConfirmed = false;
    info.identityConfirmed = identityConfirmed;
    try {
      if (webdriver && sessionCreated) await webdriver.closeSession();
    } catch (cleanupError) { cleanupErrors.push(`Could not close WebDriver session: ${String(cleanupError)}`); }
    try {
      await stopCurrentChildren({ ...displayProcesses, ...display }, driverRecord);
      processLogsFlushed = true;
    } catch (cleanupError) { cleanupErrors.push(`Could not stop isolated processes and flush owned logs: ${String(cleanupError)}`); }
    const ownedDbus = display?.dbus ?? displayProcesses.dbus;
    if (ownedDbus?.closed) {
      try { info.dbusProcessTermination = await ownedDbus.closed; }
      catch (cleanupError) { cleanupErrors.push(`Could not read the owned DBus exit status: ${String(cleanupError)}`); }
    }
    if (processLogsFlushed && ownedDbus?.busAddress) {
      try { info.dbusLogAddressRedacted = await redactPrivateDbusLogAddress(candidate, ownedDbus); }
      catch (cleanupError) { cleanupErrors.push(`Could not redact the private D-Bus endpoint from its log: ${String(cleanupError)}`); }
    }
    if (processLogsFlushed) {
      try { info.finalVaultContent = await captureFinalVaultContent(candidate); }
      catch (captureError) { cleanupErrors.push(`Could not capture final synthetic Markdown bytes: ${String(captureError)}`); }
    }
    if (cleanupErrors.length) {
      error = [error, ...cleanupErrors].filter(Boolean).join('\n');
      if (outcome === 'passed') outcome = 'failed-cleanup';
      const report = `${cleanupErrors.join('\n')}\n`;
      try { await writeFile(path.join(candidate.evidence, 'cleanup-failures.log'), report); }
      catch (reportError) { process.stderr.write(`Could not save cleanup report: ${String(reportError)}\n`); }
      if (outcome === 'failed-cleanup') cleanupFailure = new Error(`Native smoke passed but cleanup failed: ${cleanupErrors.join(' | ')}`);
    }
    try { await saveRunInfo(candidate, { ...info, identityConfirmed, outcome, error }); }
    catch (metadataError) {
      const message = `Could not write run metadata after processes/logs were stopped: ${String(metadataError)}`;
      error = [error, message].filter(Boolean).join('\n');
      process.stderr.write(`${message}\n`);
      if (outcome === 'passed') {
        outcome = 'failed-cleanup';
        cleanupFailure = new Error(message);
      }
    }
    let retentionError = null;
    if (!processLogsFlushed) {
      retentionError = new Error('Refusing durable copy until every owned process has stopped and its log stream has flushed');
    } else {
      try {
        const retained = await copyEvidenceDurably({
          sourceDirectory: candidate.evidence,
          destinationDirectory: candidate.retainedEvidence,
        });
        process.stdout.write(`${JSON.stringify({ retainedEvidence: retained }, null, 2)}\n`);
      } catch (caughtRetentionError) {
        retentionError = caughtRetentionError;
      }
    }
    if (retentionError) {
      const message = `Could not retain durable evidence at ${candidate.retainedEvidence}: ${retentionError?.stack ?? retentionError}`;
      error = [error, message].filter(Boolean).join('\n');
      if (outcome === 'passed') {
        outcome = 'failed-retention';
        cleanupFailure = new Error(message);
      }
      try { await writeFile(path.join(candidate.evidence, 'retention-failure.log'), `${message}\n`, { flag: 'wx' }); }
      catch (reportError) { process.stderr.write(`Could not save retention failure report: ${String(reportError)}\n`); }
      try { await saveRunInfo(candidate, { ...info, outcome, error }); }
      catch (metadataError) { process.stderr.write(`Could not update run metadata after retention failure: ${String(metadataError)}\n`); }
    }
  }
  if (primaryFailure) throw primaryFailure;
  if (cleanupFailure) throw cleanupFailure;
}

async function readProcInfo(pid, { appExecutable = null } = {}) {
  const proc = `/proc/${pid}`;
  const [exe, cmdline, children] = await Promise.all([
    realpath(path.join(proc, 'exe')).catch(() => null),
    readFile(path.join(proc, 'cmdline')).catch(() => Buffer.alloc(0)),
    readFile(path.join(proc, 'task', String(pid), 'children'), 'utf8').catch(() => ''),
  ]);
  const argv = cmdline.toString('utf8').split('\0').filter(Boolean);
  const envBytes = await readFile(path.join(proc, 'environ')).catch(() => Buffer.alloc(0));
  const allowedEnv = new Set(['HOME', 'MORROW_USER_DATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'GDK_BACKEND', 'WEBKIT_DISABLE_DMABUF_RENDERER', 'PATH']);
  const captureAppStageEnvironment = exe !== null && exe === appExecutable;
  const appStageEnvironmentKeys = new Set(APP_STAGE_RUNTIME_ENVIRONMENT_KEYS);
  const appStageEntries = [];
  const forbiddenEnvKey = (key) => key.startsWith('DBUS_STARTER_')
    || key.startsWith('GNOME_KEYRING_')
    || ['DBUS_SYSTEM_BUS_ADDRESS', 'DBUS_SYSTEM_BUS_PID', 'SSH_AUTH_SOCK', 'GPG_AGENT_INFO', 'AT_SPI_BUS_ADDRESS', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'LD_PRELOAD', 'GTK_MODULES'].includes(key);
  const environment = {};
  const forbiddenEnvironmentKeys = [];
  const observedEnvironmentKeys = [];
  for (const item of envBytes.toString('utf8').split('\0')) {
    const separator = item.indexOf('=');
    if (separator < 0) continue;
    const key = item.slice(0, separator);
    const value = item.slice(separator + 1);
    observedEnvironmentKeys.push(key);
    if (allowedEnv.has(key)) environment[key] = value;
    if (captureAppStageEnvironment && appStageEnvironmentKeys.has(key)) appStageEntries.push({ key, value });
    if (forbiddenEnvKey(key)) forbiddenEnvironmentKeys.push(key);
  }
  return {
    pid,
    exe,
    argv,
    children: children.trim().split(/\s+/).filter(Boolean).map(Number),
    environment,
    forbiddenEnvironmentKeys,
    observedEnvironmentKeys,
    appStageEntries: captureAppStageEnvironment ? appStageEntries : [],
  };
}

async function processOwnsTcpListener(rootPid, port) {
  const visited = new Set();
  const stack = [rootPid];
  const socketInodes = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (!pid || visited.has(pid)) continue;
    visited.add(pid);
    const info = await readProcInfo(pid).catch(() => null);
    if (info) stack.push(...info.children);
    const fdDir = `/proc/${pid}/fd`;
    let descriptors;
    try { descriptors = await readdir(fdDir); } catch { continue; }
    for (const fd of descriptors) {
      const target = await readlink(path.join(fdDir, fd)).catch(() => '');
      const match = /^socket:\[(\d+)\]$/.exec(target);
      if (match) socketInodes.add(match[1]);
    }
  }
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const contents = await readFile(table, 'utf8').catch(() => '');
    for (const line of contents.split(/\r?\n/).slice(1)) {
      const columns = line.trim().split(/\s+/);
      const localAddress = columns[1];
      const state = columns[3];
      const inode = columns[9];
      if (!localAddress || state !== '0A' || !inode || !socketInodes.has(inode)) continue;
      const localPort = Number.parseInt(localAddress.split(':').at(-1) ?? '', 16);
      if (localPort === port) return true;
    }
  }
  return false;
}

async function findOwnedAppProcess(driverPid, candidate) {
  return waitFor(async () => {
    const visited = new Set();
    const stack = [driverPid];
    while (stack.length) {
      const pid = stack.pop();
      if (!pid || visited.has(pid)) continue;
      visited.add(pid);
      const info = await readProcInfo(pid, { appExecutable: candidate.binary }).catch(() => null);
      if (!info) continue;
      if (info.exe === candidate.binary) {
        return info;
      }
      stack.push(...info.children);
    }
    return false;
  }, 'the native Morrow child process candidate under the owned WebDriver', 20_000);
}

function summarizeAppProcessCandidate(info, driverPid, candidate) {
  return {
    pid: info.pid,
    executableMatchesExpected: info.exe === candidate.binary,
    executablePathSha256: sha256(Buffer.from(info.exe ?? '')),
    argvSha256: sha256(Buffer.from(info.argv.join('\0'))),
    ownedDescendantOfDriver: true,
    ownerDriverPid: driverPid,
  };
}

async function verifyAppStageRuntimeEnvironment(info, candidate, env) {
  const expectedBase = {
    HOME: candidate.profile,
    MORROW_USER_DATA: candidate.profile,
    XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: env.XDG_DATA_HOME,
    XDG_CACHE_HOME: env.XDG_CACHE_HOME,
    XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR,
    DISPLAY: env.DISPLAY,
    DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS,
    GDK_BACKEND: 'x11',
    WEBKIT_DISABLE_DMABUF_RENDERER: '1',
    PATH: '/usr/bin:/bin',
  };
  const inputs = {
    actualBase: info.environment,
    expectedBase,
    forbiddenKeys: info.forbiddenEnvironmentKeys,
    observedKeys: info.observedEnvironmentKeys,
    appStageEntries: info.appStageEntries,
  };
  const preListener = summarizeAppStageRuntimeEnvironment(inputs);
  const preListenerStage = preListener.summary.appStage;
  if (!preListener.summary.base.ok
      || !Object.values(preListenerStage.variables).every((value) => value.valid)
      || !preListenerStage.inspector.portValid
      || preListener.inspectorPort === null) {
    throw new Error(`Native app-stage isolation mismatch: ${JSON.stringify(preListener.summary)}`);
  }

  await waitFor(
    () => processOwnsTcpListener(info.pid, preListener.inspectorPort),
    'the owned native app inspector listener',
    10_000,
  );
  const verified = summarizeAppStageRuntimeEnvironment({ ...inputs, inspectorListenerOwned: true });
  if (!verified.summary.ok) {
    throw new Error(`Native app-stage isolation mismatch: ${JSON.stringify(verified.summary)}`);
  }
  return verified.summary;
}

async function killProcessGroup(pid) {
  try { process.kill(-pid, 'SIGTERM'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
  await delay(500);
  try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
}

async function stopCurrentChildren(display, driverRecord) {
  const errors = [];
  if (driverRecord) {
    try { await finishLoggedProcess(driverRecord); }
    catch (error) { errors.push(`tauri-driver: ${error?.message ?? error}`); }
  }
  for (const key of ['dbus', 'xvfb']) {
    const processRecord = display?.[key];
    if (!processRecord) continue;
    try { await finishLoggedProcess(processRecord); }
    catch (error) { errors.push(`${key}: ${error?.message ?? error}`); }
  }
  if (errors.length) throw new Error(errors.join('\n'));
}

async function runNativeAppIdentityOnlyScenario({ candidate, identityConfirmed, appProcessCount }) {
  if (identityConfirmed !== true || appProcessCount !== 1) {
    throw new Error('App identity-only scenario requires one app process with confirmed isolated runtime identity');
  }
  await recordStep(candidate, 'native-app-identity-only-passed', {
    identityConfirmed: true,
    appProcessCount,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return help();
  const scenarioName = args.scenario ?? 'legacy';
  const scenarioCallbacks = {
    readiness: runNativeReadinessScenario,
    functional: runNativeFunctionalScenario,
    'functional-independent': runIndependentFunctionalScenario,
    'app-identity-only': runNativeAppIdentityOnlyScenario,
  };
  if (scenarioName !== 'legacy' && scenarioName !== 'dbus-isolation' && !Object.hasOwn(scenarioCallbacks, scenarioName)) {
    throw new Error(`Unknown fixed scenario ${scenarioName}; expected legacy, readiness, functional, functional-independent, app-identity-only, or dbus-isolation`);
  }
  if (args.scenario && (args['freeze-sources'] || args['record-artifacts'])) {
    throw new Error('--scenario is valid only with --check-only or --run-native');
  }
  if (args['freeze-sources'] && args['record-artifacts']) throw new Error('Choose one preparation mode at a time');
  if (args['freeze-sources']) {
    const result = await freezeSourceManifest({
      repositoryRoot: REPO_ROOT,
      sourceManifestOutput: requireArg(args, 'source-manifest-output'),
      diffOutput: requireArg(args, 'diff-output'),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (args['record-artifacts']) {
    const result = await recordArtifactManifest({
      repositoryRoot: REPO_ROOT,
      sourceManifestPath: requireArg(args, 'source-manifest'),
      artifactManifestOutput: requireArg(args, 'artifact-manifest-output'),
      binaryPath: requireArg(args, 'binary'),
      bundlePath: requireArg(args, 'bundle'),
      pluginManifestPath: requireArg(args, 'manifest'),
      tauriConfigPath: requireArg(args, 'tauri-config'),
      driverPath: requireArg(args, 'driver'),
      webkitDriverPath: requireArg(args, 'webkit-driver'),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (Boolean(args['check-only']) === Boolean(args['run-native'])) {
    throw new Error('Choose exactly one of --check-only or --run-native');
  }
  if (args['check-only'] && args['confirm-synthetic-profile']) {
    throw new Error('--confirm-synthetic-profile is only valid with --run-native');
  }
  if (args['confirm-private-dbus-probe'] && (args.scenario !== 'dbus-isolation' || !args['run-native'])) {
    throw new Error('--confirm-private-dbus-probe is valid only for --run-native --scenario dbus-isolation');
  }
  if (args.scenario === 'dbus-isolation' && args['run-native'] && !args['confirm-private-dbus-probe']) {
    throw new Error('The private D-Bus probe requires --confirm-private-dbus-probe after its separate root gate');
  }
  if (!args['check-only'] && !args['run-native']) throw new Error('Choose --check-only or --run-native');
  const candidate = await verifyInputs(args);
  candidate.scenario = scenarioName;
  await preflight(candidate, args);
  if (args['check-only']) return;

  let prepared;
  try { prepared = await createSyntheticVault(candidate); }
  catch (error) {
    await preservePreparationFailure(candidate, error);
    throw error;
  }
  // Output paths were proven new by preflight. runNative preserves all evidence.
  await runNative(candidate, prepared, scenarioCallbacks[scenarioName] ?? null, scenarioName);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}

