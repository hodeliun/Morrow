'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { finished } = require('node:stream/promises');
const { after, test } = require('node:test');
const { createPackage } = require('@electron/asar');
const { launchPackaged } = require('./verify-packaged-smoke.cjs');
const { loadAsarReader, preflightPackagedArtifact } = require('./packaged-smoke-preflight.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PROJECT_PACKAGE = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
const READER = loadAsarReader(PROJECT_ROOT);
const GUARDED_MAIN = [
  'const SMOKE_SWITCH = "--smoke-test";',
  'MORROW_HIDDEN',
  'MORROW_USER_DATA',
  'packaged smoke mode requires',
].join('\n');

async function makeFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'morrow-packaged-preflight-'));
  after(() => {
    const tempRoot = path.resolve(os.tmpdir());
    const realRoot = fs.realpathSync(root);
    assert.ok(
      realRoot.startsWith(`${tempRoot}${path.sep}`) &&
        path.basename(realRoot).startsWith('morrow-packaged-preflight-'),
      'Only this test’s temporary fixture may be removed.',
    );
    fs.rmSync(realRoot, { recursive: true, force: false });
  });

  const trustedProjectRoot = path.join(root, 'trusted-project');
  const trustedBuild = path.join(trustedProjectRoot, 'dist-electron');
  const unpackedRoot = path.join(root, 'candidate', 'win-unpacked');
  const resourcesRoot = path.join(unpackedRoot, 'resources');
  const archiveSource = path.join(root, 'archive-source');
  const archivePath = path.join(resourcesRoot, 'app.asar');
  const executablePath = path.join(unpackedRoot, 'Morrow.exe');

  fs.mkdirSync(trustedBuild, { recursive: true });
  fs.mkdirSync(resourcesRoot, { recursive: true });
  fs.mkdirSync(path.join(archiveSource, 'dist-electron'), { recursive: true });
  fs.writeFileSync(
    path.join(trustedProjectRoot, 'package.json'),
    JSON.stringify({ name: 'morrow', version: PROJECT_PACKAGE.version, main: 'dist-electron/main.cjs' }),
    'utf8',
  );
  fs.writeFileSync(path.join(trustedBuild, 'main.cjs'), options.trustedMain ?? GUARDED_MAIN, 'utf8');
  fs.writeFileSync(executablePath, 'synthetic executable bytes', 'utf8');

  const archiveMain = options.archiveMain ?? options.trustedMain ?? GUARDED_MAIN;
  const archivePackage = {
    name: 'morrow',
    version: options.archiveVersion ?? PROJECT_PACKAGE.version,
    main: options.archiveMainEntry ?? 'dist-electron/main.cjs',
  };
  fs.writeFileSync(path.join(archiveSource, 'package.json'), JSON.stringify(archivePackage), 'utf8');
  if (archivePackage.main === 'dist-electron/main.cjs') {
    fs.writeFileSync(path.join(archiveSource, archivePackage.main), archiveMain, 'utf8');
  }

  if (options.malformedArchive) {
    fs.writeFileSync(archivePath, 'not an asar archive', 'utf8');
  } else {
    const archiveStream = await createPackage(archiveSource, archivePath);
    await finished(archiveStream);
  }

  const preflightOptions = {
    executablePath,
    expectedVersion: PROJECT_PACKAGE.version,
    projectRoot: trustedProjectRoot,
  };
  return {
    root,
    trustedProjectRoot,
    unpackedRoot,
    resourcesRoot,
    archivePath,
    executablePath,
    preflightOptions,
  };
}

function assertPreflightRejected(fixture, expectedReason, dependencies = { asarReader: READER }) {
  assert.throws(
    () => preflightPackagedArtifact(fixture.preflightOptions, dependencies),
    (error) => {
      assert.ok(error instanceof Error);
      assert.ok(
        error.message.includes(expectedReason),
        `Expected preflight rejection containing ${JSON.stringify(expectedReason)}, got: ${error.message}`,
      );
      return true;
    },
    `Preflight should reject the candidate because ${expectedReason}`,
  );
}

async function assertLaunchIsBlocked(
  fixture,
  expectedPreflight,
  expectedReason,
  dependencies = { asarReader: READER },
) {
  let launchCalls = 0;
  const electron = {
    async launch() {
      launchCalls++;
      return {};
    },
  };
  const runtimeErrors = { launches: 0, entries: [], runtimes: [] };
  await assert.rejects(
    launchPackaged(
      electron,
      fixture.executablePath,
      path.join(fixture.root, 'unused-profile'),
      runtimeErrors,
      fixture.preflightOptions,
      expectedPreflight,
      dependencies,
    ),
    (error) => {
      assert.ok(error instanceof Error);
      assert.ok(
        error.message.includes(expectedReason),
        `Expected launch guard to reject containing ${JSON.stringify(expectedReason)}, got: ${error.message}`,
      );
      return true;
    },
  );
  assert.equal(launchCalls, 0, 'Rejected artifacts must be refused before Electron launch.');
}

async function assertRejectedArtifact(fixture, expectedReason, dependencies = { asarReader: READER }) {
  assertPreflightRejected(fixture, expectedReason, dependencies);
  await assertLaunchIsBlocked(fixture, null, expectedReason, dependencies);
}

test('accepts an unpacked executable whose ASAR main exactly matches the guarded trusted main', async () => {
  const fixture = await makeFixture();
  const result = preflightPackagedArtifact(fixture.preflightOptions, { asarReader: READER });
  assert.equal(result.expectedVersion, PROJECT_PACKAGE.version);
  assert.equal(result.packagedVersion, PROJECT_PACKAGE.version);
  assert.equal(result.mainEntry, 'dist-electron/main.cjs');
  assert.equal(result.asarReaderVersion, '3.4.1');
  assert.equal(result.sha256.main, result.sha256.trustedMain);
  assert.match(result.sha256.executable, /^[a-f0-9]{64}$/);
  assert.match(result.sha256.appAsar, /^[a-f0-9]{64}$/);
});

test('refuses an old packaged version before any Electron launch', async () => {
  const fixture = await makeFixture({ archiveVersion: '1.0.1' });
  await assertRejectedArtifact(fixture, 'the app.asar version does not match the expected version.');
});

test('refuses an ASAR main hash mismatch before any Electron launch', async () => {
  const changedMain = GUARDED_MAIN.replace('SMOKE_SWITCH', 'STALE_SWITCH');
  const fixture = await makeFixture({ archiveMain: changedMain });
  await assertRejectedArtifact(fixture, 'the packaged main entry does not match the trusted dist-electron/main.cjs.');
});

test('refuses a trusted main without the packaged smoke isolation guard before launch', async () => {
  const unsafeMain = 'console.log("no smoke profile guard");';
  const fixture = await makeFixture({ trustedMain: unsafeMain, archiveMain: unsafeMain });
  await assertRejectedArtifact(fixture, 'The trusted main entry is missing the packaged smoke isolation guard.');
});

test('refuses malformed ASAR data before any Electron launch', async () => {
  const fixture = await makeFixture({ malformedArchive: true });
  await assertRejectedArtifact(fixture, 'The packaged package.json is missing or malformed in app.asar.');
});

test('refuses a junction that redirects resources outside win-unpacked before launch', async () => {
  const fixture = await makeFixture();
  const redirectedResources = path.join(fixture.root, 'redirected-resources');
  fs.mkdirSync(redirectedResources);
  fs.copyFileSync(fixture.archivePath, path.join(redirectedResources, 'app.asar'));
  fs.rmSync(fixture.resourcesRoot, { recursive: true, force: false });
  fs.symlinkSync(redirectedResources, fixture.resourcesRoot, 'junction');
  await assertRejectedArtifact(fixture, 'The packaged resources directory may not be a symbolic link or junction.');
});

test('refuses a redirected main entry path before any Electron launch', async () => {
  const fixture = await makeFixture({ archiveMainEntry: '../../external-main.cjs' });
  await assertRejectedArtifact(fixture, 'The packaged main entry contains a redirected ASAR path.');
});

test('refuses a missing ASAR reader module before any Electron launch', async () => {
  const fixture = await makeFixture();
  const dependencyRoot = path.join(fixture.root, 'without-dependencies');
  fs.mkdirSync(path.join(dependencyRoot, 'node_modules'), { recursive: true });
  assert.throws(loadAsarReader.bind(null, dependencyRoot), /ASAR reader module is unavailable/);
  await assertRejectedArtifact(fixture, 'the ASAR reader module is missing.', { asarReader: null });
});

test('refuses a different ASAR reader version before inspecting the archive or launching', async () => {
  const fixture = await makeFixture();
  let archiveReadCount = 0;
  const readerWithWrongVersion = {
    ...READER,
    version: '3.4.2',
    statFile(...args) {
      archiveReadCount++;
      return READER.statFile(...args);
    },
  };
  await assertRejectedArtifact(
    fixture,
    'the ASAR reader version must be 3.4.1.',
    { asarReader: readerWithWrongVersion },
  );
  assert.equal(archiveReadCount, 0, 'A mismatched reader version must be rejected before archive inspection.');
});

test('rechecks the artifact snapshot before launch and refuses a changed executable', async () => {
  const fixture = await makeFixture();
  const initial = preflightPackagedArtifact(fixture.preflightOptions, { asarReader: READER });
  fs.writeFileSync(fixture.executablePath, 'changed synthetic executable bytes', 'utf8');
  await assertLaunchIsBlocked(
    fixture,
    initial,
    'The packaged executable or app.asar changed after preflight.',
    { asarReader: READER },
  );
});
