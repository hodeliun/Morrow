#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { preflightPackagedArtifact } = require('./packaged-smoke-preflight.cjs');

const SMOKE_SWITCH = '--smoke-test';
const NOTE_TITLE = 'Packaged smoke note';
const ORIGINAL_TEXT = 'Packaged smoke original marker.';
const EDITED_TEXT = 'Packaged smoke edited marker.';
const DEFAULT_EVIDENCE_SUBDIR = 'packaged-smoke';
const EVIDENCE_ROOT = path.resolve(
  __dirname,
  '..',
  'docs',
  'evidence',
  'stabilization-1.1.1',
);

function usage() {
  return [
    'Usage:',
    '  node scripts/verify-packaged-smoke.cjs <win-unpacked/Morrow.exe> <expected-version> [--evidence-dir <subdirectory>]',
    '',
    `The evidence subdirectory is relative to docs/evidence/stabilization-1.1.1 (default: ${DEFAULT_EVIDENCE_SUBDIR}).`,
  ].join('\n');
}

function parseArguments(args) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return null;
  if (args.length < 2) throw new Error(usage());

  const [executable, expectedVersion, ...options] = args;
  if (!executable || !expectedVersion || expectedVersion.startsWith('--'))
    throw new Error(usage());

  let evidenceSubdir = DEFAULT_EVIDENCE_SUBDIR;
  for (let index = 0; index < options.length; index++) {
    if (options[index] !== '--evidence-dir' || !options[index + 1])
      throw new Error(`Unknown or incomplete option: ${options[index] ?? ''}`);
    evidenceSubdir = options[index + 1];
    index++;
  }

  if (
    path.isAbsolute(evidenceSubdir) ||
    evidenceSubdir.split(/[\\/]+/).some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('Evidence directory must be a non-empty subdirectory under the stabilization evidence folder.');
  }

  return {
    executablePath: path.resolve(executable),
    expectedVersion,
    evidenceDirectory: path.resolve(EVIDENCE_ROOT, evidenceSubdir),
  };
}

function samePath(left, right) {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function isWithinPath(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative !== '' &&
    !path.isAbsolute(relative) &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`)
  );
}

function loadElectronHarness() {
  const configuredModule = process.env.MORROW_PLAYWRIGHT_MODULE;
  if (configuredModule) return require(path.resolve(configuredModule))._electron;

  const runtimeNodeModules = path.join(
    os.homedir(),
    '.cache',
    'codex-runtimes',
    'codex-primary-runtime',
    'dependencies',
    'node',
    'node_modules',
  );
  try {
    const resolvedModule = require.resolve('playwright', {
      paths: [process.cwd(), runtimeNodeModules],
    });
    return require(resolvedModule)._electron;
  } catch {
    throw new Error(
      'Playwright is unavailable. Install it for the harness or set MORROW_PLAYWRIGHT_MODULE to its module entry.',
    );
  }
}

function validateOwnedTempRoot(rootPath, tempDirectory) {
  const rootStat = fs.lstatSync(rootPath);
  assert.ok(
    !rootStat.isSymbolicLink() && rootStat.isDirectory(),
    'The smoke root must remain a real directory.',
  );
  assert.match(path.basename(rootPath), /^morrow-smoke-[A-Za-z0-9]+$/);

  const realTemp = fs.realpathSync(tempDirectory);
  const realRoot = fs.realpathSync(rootPath);
  assert.ok(samePath(path.dirname(realRoot), realTemp), 'The smoke root must be a direct child of the OS temp directory.');
  assert.ok(samePath(realRoot, rootPath), 'The smoke root must not resolve through a link or junction.');
  return realRoot;
}

function makeFixture(rootPath) {
  const profilePath = path.join(rootPath, 'profile');
  const vaultPath = path.join(rootPath, 'vault');
  fs.mkdirSync(profilePath);
  fs.mkdirSync(vaultPath);
  fs.mkdirSync(path.join(vaultPath, '.morrow'));

  fs.writeFileSync(
    path.join(profilePath, 'vaults.json'),
    JSON.stringify({
      current: vaultPath,
      recent: [{ path: vaultPath, openedAt: Date.now() }],
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(vaultPath, '.morrow', 'workspace.json'),
    JSON.stringify({ pages: { 'Packaged smoke note.md': { id: 'packaged-smoke-note' } } }, null, 2),
    'utf8',
  );

  const notePath = path.join(vaultPath, 'Packaged smoke note.md');
  fs.writeFileSync(notePath, `# ${NOTE_TITLE}\n\n${ORIGINAL_TEXT}\n`, 'utf8');
  return { profilePath, vaultPath, notePath };
}

function recordRuntimeError(runtime, source, errorName = 'Error') {
  runtime.errors.push({
    launch: runtime.index,
    source,
    name: errorName || 'Error',
  });
}

function attachPageListeners(runtime, page) {
  if (runtime.pages.has(page)) return;
  runtime.pages.add(page);
  page.on('pageerror', (error) => recordRuntimeError(runtime, 'renderer-pageerror', error.name));
  page.on('console', (message) => {
    if (message.type() === 'error') recordRuntimeError(runtime, 'renderer-console', 'ConsoleError');
  });
  page.on('crash', () => recordRuntimeError(runtime, 'renderer-crash', 'PageCrash'));
}

async function launchPackaged(
  _electron,
  executablePath,
  profilePath,
  runtimeErrors,
  preflightOptions,
  expectedPreflight,
  preflightDependencies = {},
) {
  const currentPreflight = preflightPackagedArtifact(
    { ...preflightOptions, executablePath },
    preflightDependencies,
  );
  assert.deepEqual(
    currentPreflight,
    expectedPreflight,
    'The packaged executable or app.asar changed after preflight.',
  );
  const app = await _electron.launch({
    executablePath,
    args: [SMOKE_SWITCH],
    cwd: path.dirname(executablePath),
    env: {
      ...process.env,
      MORROW_HIDDEN: '1',
      MORROW_USER_DATA: profilePath,
    },
  });

  const runtime = {
    app,
    process: app.process(),
    index: runtimeErrors.launches + 1,
    pages: new WeakSet(),
    errors: runtimeErrors.entries,
    closing: false,
    closed: false,
  };
  runtimeErrors.launches++;
  runtime.process.on('error', (error) => recordRuntimeError(runtime, 'main-process', error.name));
  runtime.process.on('exit', (code, signal) => {
    runtime.closed = true;
    if (!runtime.closing) recordRuntimeError(runtime, 'unexpected-process-exit', signal ?? `Exit${code}`);
  });
  app.on('window', (page) => attachPageListeners(runtime, page));
  runtimeErrors.runtimes.push(runtime);

  const page = await app.firstWindow();
  attachPageListeners(runtime, page);
  page.setDefaultTimeout(30_000);
  runtime.page = page;
  return runtime;
}

async function inspectPackagedStartup(runtime, expectedVersion, profilePath) {
  const startup = await runtime.app.evaluate(({ app, BrowserWindow }) => ({
    packaged: app.isPackaged,
    version: app.getVersion(),
    userDataPath: app.getPath('userData'),
    sessionDataPath: app.getPath('sessionData'),
    windowVisibility: BrowserWindow.getAllWindows().map((window) => window.isVisible()),
  }));

  assert.equal(startup.packaged, true, 'The launched application must report app.isPackaged === true.');
  assert.equal(startup.version, expectedVersion, 'The packaged version did not match the expected version.');
  assert.ok(samePath(startup.userDataPath, profilePath), 'Electron userData must resolve to the isolated profile.');
  assert.ok(isWithinPath(profilePath, startup.sessionDataPath), 'Electron sessionData must stay under the isolated profile.');
  assert.ok(!startup.windowVisibility.includes(true), 'Every BrowserWindow must remain hidden.');
  assert.ok(startup.windowVisibility.length > 0, 'The packaged app must create its hidden test window.');

  const realProfilePath = fs.realpathSync(profilePath);
  const realUserDataPath = fs.realpathSync(startup.userDataPath);
  const realSessionDataPath = fs.realpathSync(startup.sessionDataPath);
  assert.ok(samePath(realUserDataPath, realProfilePath), 'The resolved userData path escaped the isolated profile.');
  assert.ok(isWithinPath(realProfilePath, realSessionDataPath), 'The resolved sessionData path escaped the isolated profile.');

  return {
    packaged: startup.packaged,
    version: startup.version,
    windowCount: startup.windowVisibility.length,
    visibleWindowCount: startup.windowVisibility.filter(Boolean).length,
  };
}

async function assertHiddenWindows(runtime) {
  const visibility = await runtime.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => window.isVisible()),
  );
  assert.ok(visibility.length > 0, 'The packaged app must keep its hidden test window open.');
  assert.ok(!visibility.includes(true), 'Every BrowserWindow must remain hidden.');
}

async function openSyntheticNote(page, expectedText) {
  await page.locator('.tree-row, .link-row').first().waitFor({ state: 'visible' });
  const rows = page.locator('.tree-row, .link-row');
  for (let index = 0; index < (await rows.count()); index++) {
    const row = rows.nth(index);
    const label = (await row.innerText()).split(/\r?\n/)[0].trim();
    if (label !== NOTE_TITLE) continue;
    await row.click();
    await page.waitForFunction(
      (text) => document.querySelector('.ProseMirror')?.innerText.includes(text) ?? false,
      expectedText,
    );
    return;
  }
  throw new Error('The synthetic note is missing from the packaged app navigation.');
}

async function waitForFileText(filePath, expectedText, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8').includes(expectedText)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description} in the synthetic note.`);
}

async function waitForProcessExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('The packaged app did not close in time.')), timeoutMs);
    const onExit = () => finish();
    const onError = (error) => finish(error);
    function finish(error) {
      clearTimeout(timeout);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      if (error) reject(error);
      else resolve();
    }
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function closeRuntime(runtime) {
  if (runtime.closed || runtime.process.exitCode !== null || runtime.process.signalCode !== null) {
    runtime.closed = true;
    return;
  }
  runtime.closing = true;
  await runtime.app.close();
  await waitForProcessExit(runtime.process);
  runtime.closed = true;
}

function removeOwnedTempRoot(rootPath, tempDirectory) {
  validateOwnedTempRoot(rootPath, tempDirectory);
  fs.rmSync(rootPath, { recursive: true, force: false });
  return !fs.existsSync(rootPath);
}

function prepareEvidenceDirectory(evidenceDirectory) {
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
  const realEvidenceRoot = fs.realpathSync(EVIDENCE_ROOT);
  const relative = path.relative(EVIDENCE_ROOT, evidenceDirectory);
  assert.ok(isWithinPath(EVIDENCE_ROOT, evidenceDirectory), 'Evidence directory must be below its configured root.');

  let current = EVIDENCE_ROOT;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      fs.mkdirSync(current);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const stat = fs.lstatSync(current);
    assert.ok(!stat.isSymbolicLink() && stat.isDirectory(), 'Evidence path components must be real directories.');
    const realCurrent = fs.realpathSync(current);
    assert.ok(isWithinPath(realEvidenceRoot, realCurrent), 'Evidence directory must stay under its configured root.');
  }
}

function writeEvidence(evidenceDirectory, evidence) {
  prepareEvidenceDirectory(evidenceDirectory);

  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const filePath = path.join(evidenceDirectory, `packaged-smoke-${stamp}-${process.pid}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return path.relative(path.resolve(__dirname, '..'), filePath).replaceAll(path.sep, '/');
}

function errorName(error) {
  return error instanceof Error && error.name ? error.name : 'Error';
}

function safeErrorMessage(error, privatePaths) {
  let message = error instanceof Error ? error.message : String(error);
  for (const privatePath of privatePaths.filter(Boolean).sort((left, right) => right.length - left.length))
    message = message.split(privatePath).join('[local path]');
  return message
    .replace(/\b[A-Za-z]:\\[^"'<>:\r\n]*/g, '[local path]')
    .replace(/\\\\[^"'<>\r\n]*/g, '[local network path]')
    .slice(0, 400);
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  if (!options) {
    console.log(usage());
    return;
  }

  let stage = 'input-validation';
  let rootPath = null;
  const tempDirectory = os.tmpdir();
  const runtimes = { launches: 0, entries: [], runtimes: [] };
  const evidence = {
    schemaVersion: 1,
    scenario: 'win-unpacked-packaged-smoke',
    runId: `${new Date().toISOString()}-${process.pid}`,
    startedAt: new Date().toISOString(),
    executableName: path.basename(options.executablePath),
    expectedVersion: options.expectedVersion,
    packaged: null,
    actualVersion: null,
    isolatedPaths: { userDataMatchesProfile: false, sessionDataWithinProfile: false },
    hiddenWindows: [],
    note: {
      initialDiskContentConfirmed: false,
      editedContentSavedToDisk: false,
      editedContentReopened: false,
      editedDiskContentConfirmedAfterReopen: false,
    },
    launchCount: 0,
    artifactPreflight: null,
    runtimeErrors: [],
    appCloseCount: 0,
    cleanupVerified: false,
    result: 'failed',
    failure: null,
  };
  let failure = null;
  let evidencePath = null;
  let fixture = null;
  let preflightOptions = null;
  let expectedPreflight = null;

  try {
    stage = 'artifact-preflight';
    preflightOptions = {
      executablePath: options.executablePath,
      expectedVersion: options.expectedVersion,
      projectRoot: path.resolve(__dirname, '..'),
    };
    expectedPreflight = preflightPackagedArtifact(preflightOptions);
    evidence.artifactPreflight = { ...expectedPreflight, recheckedBeforeLaunches: [] };

    const _electron = loadElectronHarness();

    stage = 'synthetic-fixture';
    rootPath = fs.mkdtempSync(path.join(tempDirectory, 'morrow-smoke-'));
    validateOwnedTempRoot(rootPath, tempDirectory);
    fixture = makeFixture(rootPath);

    for (let launchIndex = 0; launchIndex < 2; launchIndex++) {
      stage = launchIndex === 0 ? 'first-launch-preflight' : 'reopen-launch-preflight';
      const runtime = await launchPackaged(
        _electron,
        options.executablePath,
        fixture.profilePath,
        runtimes,
        preflightOptions,
        expectedPreflight,
      );
      evidence.artifactPreflight.recheckedBeforeLaunches.push(launchIndex + 1);
      stage = launchIndex === 0 ? 'first-launch' : 'reopen-launch';
      evidence.launchCount = runtimes.launches;
      await runtime.page.waitForLoadState('domcontentloaded');
      await runtime.page.waitForFunction(() => document.querySelector('.tree-row, .link-row') !== null);
      const startup = await inspectPackagedStartup(runtime, options.expectedVersion, fixture.profilePath);
      evidence.packaged = startup.packaged;
      evidence.actualVersion = startup.version;
      evidence.isolatedPaths.userDataMatchesProfile = true;
      evidence.isolatedPaths.sessionDataWithinProfile = true;
      evidence.hiddenWindows.push({
        launch: launchIndex + 1,
        windowCount: startup.windowCount,
        visibleWindowCount: startup.visibleWindowCount,
      });

      if (launchIndex === 0) {
        stage = 'initial-note-read';
        await openSyntheticNote(runtime.page, ORIGINAL_TEXT);
        assert.ok(fs.readFileSync(fixture.notePath, 'utf8').includes(ORIGINAL_TEXT));
        evidence.note.initialDiskContentConfirmed = true;

        stage = 'edit-and-save';
        const paragraph = runtime.page.locator('.ProseMirror > p').filter({ hasText: ORIGINAL_TEXT }).first();
        await paragraph.click();
        await runtime.page.keyboard.press('Home');
        await runtime.page.keyboard.press('Shift+End');
        await runtime.page.keyboard.insertText(EDITED_TEXT);
        await runtime.page.waitForFunction(
          (text) => document.querySelector('.ProseMirror')?.innerText.includes(text) ?? false,
          EDITED_TEXT,
        );
        await waitForFileText(fixture.notePath, EDITED_TEXT, 'edited note save');
        evidence.note.editedContentSavedToDisk = true;
      } else {
        stage = 'reopened-note-read';
        await openSyntheticNote(runtime.page, EDITED_TEXT);
        assert.ok(fs.readFileSync(fixture.notePath, 'utf8').includes(EDITED_TEXT));
        evidence.note.editedContentReopened = true;
        evidence.note.editedDiskContentConfirmedAfterReopen = true;
      }

      await assertHiddenWindows(runtime);
      stage = launchIndex === 0 ? 'first-app-close' : 'final-app-close';
      await closeRuntime(runtime);
      evidence.appCloseCount++;
    }

    assert.deepEqual(runtimes.entries, [], 'Every packaged launch must be free of renderer and process errors.');
    evidence.runtimeErrors = runtimes.entries;
    evidence.result = 'passed';
  } catch (error) {
    failure = error;
    evidence.failure = { stage, name: errorName(error) };
  } finally {
    for (const runtime of runtimes.runtimes) {
      if (runtime.closed || runtime.process.exitCode !== null || runtime.process.signalCode !== null) continue;
      try {
        await closeRuntime(runtime);
        evidence.appCloseCount++;
      } catch (error) {
        if (!failure) failure = error;
        evidence.result = 'failed';
        evidence.failure ??= { stage: 'app-close', name: errorName(error) };
      }
    }

    evidence.runtimeErrors = runtimes.entries;
    const allAppsClosed = runtimes.runtimes.every(
      (runtime) => runtime.process.exitCode !== null || runtime.process.signalCode !== null,
    );
    if (rootPath && allAppsClosed) {
      try {
        evidence.cleanupVerified = removeOwnedTempRoot(rootPath, tempDirectory);
      } catch (error) {
        if (!failure) failure = error;
        evidence.result = 'failed';
        evidence.failure ??= { stage: 'temporary-cleanup', name: errorName(error) };
      }
    }
    if (!evidence.cleanupVerified && evidence.result === 'passed') {
      evidence.result = 'failed';
      evidence.failure = { stage: 'temporary-cleanup', name: 'CleanupNotVerified' };
    }

    try {
      evidencePath = writeEvidence(options.evidenceDirectory, evidence);
    } catch (error) {
      if (!failure) failure = error;
      evidence.result = 'failed';
      evidence.failure ??= { stage: 'evidence-write', name: errorName(error) };
    }
  }

  if (failure || evidence.result !== 'passed') {
    const privatePaths = [rootPath, fixture?.profilePath, fixture?.vaultPath, options.executablePath];
    const summary = failure ? safeErrorMessage(failure, privatePaths) : 'Packaged smoke did not complete successfully.';
    console.error(
      JSON.stringify(
        {
          result: 'failed',
          stage: evidence.failure?.stage ?? stage,
          error: summary,
          cleanupVerified: evidence.cleanupVerified,
          evidencePath,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    JSON.stringify(
      {
        result: evidence.result,
        version: evidence.actualVersion,
        launchCount: evidence.launchCount,
        hiddenWindowLaunches: evidence.hiddenWindows.length,
        noteSaveAndReopen: true,
        cleanupVerified: evidence.cleanupVerified,
        evidencePath,
      },
      null,
      2,
    ),
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Packaged smoke harness error: ${errorName(error)}: ${safeErrorMessage(error, [])}`);
    process.exitCode = 1;
  });
}

module.exports = { launchPackaged };
