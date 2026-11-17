import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  WINDOWS_RUN_GATE,
  __test,
  assertRunnerTempOutsideWorkspace,
  assertSafeBundleContents,
  assertWindowsLocalPath,
  claimFileOnce,
  expectedArtifactName,
  hashSourceFiles,
  parseTrustedBindingPayload,
  safeRunContext,
  sha256,
  validateArtifactApiMetadata,
  validateBinding,
  validatePackagePin,
  validatePreflight,
  validateProtectedStage,
  validateStage,
} from './windows-run-gate.mjs';

const CONTEXT_ENV = Object.freeze({
  GITHUB_REPOSITORY: 'hodeliun/Morrow',
  GITHUB_RUN_ID: '12345678901',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_REF: 'refs/heads/codex/e003-g07-windows-runtime',
  GITHUB_EVENT_NAME: 'push',
  GITHUB_WORKFLOW_REF:
    'hodeliun/Morrow/.github/workflows/pilot-windows-runtime.yml@refs/heads/codex/e003-g07-windows-runtime',
  RUNNER_TEMP: 'D:\\a\\_temp',
  GITHUB_WORKSPACE: 'D:\\a\\Morrow\\Morrow',
  RUNNER_OS: 'Windows',
  RUNNER_ARCH: 'X64',
});

const PACKAGE = Object.freeze({ ...WINDOWS_RUN_GATE.package });
const TAURI_HASH = '1'.repeat(64);
const EDGE_CATALOG_HASH = '2'.repeat(64);
const EDGE_ARCHIVE_HASH = '3'.repeat(64);
const EDGE_EXE_HASH = '4'.repeat(64);
const BINDING_VALIDATION_TIME = Date.parse('2026-11-17T05:00:00.000Z');
const SOURCE_FILES = Object.freeze(
  WINDOWS_RUN_GATE.sourcePaths.map((filePath, index) => ({
    path: filePath,
    sha256: String(index + 10).padStart(64, '0'),
    sizeBytes: index + 1,
  })),
);

function context() {
  return safeRunContext(CONTEXT_ENV);
}

function stageAndReceipt(overrides = {}) {
  const runtimeSources = [
    {
      RegistryPath: 'HKLM64\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\WebView2',
      Version: '156.0.4314.58',
    },
  ];
  const edgeDriver = {
    version: '156.0.4314.84',
    source: 'Microsoft Edge WebDriver official download',
    sourceCatalogUrl: 'https://msedgedriver.microsoft.com/listing.json',
    catalogSha256: EDGE_CATALOG_HASH,
    archiveSha256: EDGE_ARCHIVE_HASH,
    executableSha256: EDGE_EXE_HASH,
    runtimeVersion: '156.0.4314.58',
    serviceStarted: false,
  };
  const tauriDriver = {
    version: '2.1.0',
    source: 'crates.io',
    sourceUrl: 'https://crates.io/crates/tauri-driver/2.1.0',
    downloadUrl: 'https://crates.io/api/v1/crates/tauri-driver/2.1.0/download',
    installedPackageMetadata: 'cargo install --list --root <tool-stage>/drivers/tauri-driver',
    installedBinaryName: 'tauri-driver.exe',
    installCommand: 'cargo install tauri-driver --version 2.1.0 --locked --root <tool-stage>',
    executableSha256: TAURI_HASH,
    serviceStarted: false,
  };
  const cargo = {
    version: 'cargo 1.92.0 (111111111 2025-10-01)',
    executable: 'C:\\Users\\runneradmin\\.cargo\\bin\\cargo.exe',
  };
  const stage = {
    schemaVersion: 1,
    status: 'staged',
    scope: 'Morrow E003 G13 issue 185 tool/download stage only',
    runId: CONTEXT_ENV.GITHUB_RUN_ID,
    runAttempt: '1',
    sha: CONTEXT_ENV.GITHUB_SHA,
    branch: WINDOWS_RUN_GATE.branch,
    runtimeVersion: '156.0.4314.58',
    runtimeSources,
    artifact: PACKAGE,
    drivers: { cargo, tauriDriver, edgeDriver },
    appLaunched: false,
    driverServiceStarted: false,
    ...overrides.stage,
  };
  const receipt = {
    schemaVersion: 1,
    status: 'passed',
    scope: 'Morrow E003 G13 issue 185 preflight only',
    runId: CONTEXT_ENV.GITHUB_RUN_ID,
    runAttempt: '1',
    sha: CONTEXT_ENV.GITHUB_SHA,
    branch: WINDOWS_RUN_GATE.branch,
    webView2Runtime: { version: stage.runtimeVersion, sources: runtimeSources },
    sourceArtifact: PACKAGE,
    package: {
      buildInfoRun: { id: PACKAGE.runId, attempt: PACKAGE.runAttempt },
      applicationVersion: '2.1.0',
      pilotIdentifier: 'app.morrow.polaris-dados-pilot',
      pe: { sha256: PACKAGE.sourceExeSha256 },
    },
    drivers: { cargo, tauriDriver, edgeDriver },
    plannedPaths: { newPathsCreatedByCheckOnly: false, profileObserved: false },
    appLaunched: false,
    driverServiceStarted: false,
    windowsRuntimeTested: false,
    guiTested: false,
    ...overrides.receipt,
  };
  return { stage, receipt };
}

function bindingFixture() {
  const run = context();
  const { stage, receipt } = stageAndReceipt();
  const stageBytes = Buffer.from(JSON.stringify(stage));
  const receiptBytes = Buffer.from(JSON.stringify(receipt));
  return {
    schema: WINDOWS_RUN_GATE.schema,
    scenario: WINDOWS_RUN_GATE.scenario,
    createdAtUtc: '2026-11-17T04:00:00.000Z',
    expiresAtUtc: '2026-11-17T06:00:00.000Z',
    nonce: '0123456789abcdef0123456789abcdef',
    run: {
      repository: run.repository,
      id: run.runId,
      attempt: '1',
      sha: run.sha,
      ref: run.ref,
      event: run.event,
      workflowRef: run.workflowRef,
    },
    artifactName: expectedArtifactName(run),
    sourceFiles: { files: SOURCE_FILES },
    package: PACKAGE,
    approvedDriver: {
      filename: 'tauri-driver.exe',
      version: '2.1.0',
      source: 'crates.io',
      sourceUrl: 'https://crates.io/crates/tauri-driver/2.1.0',
      installCommand: 'cargo install tauri-driver --version 2.1.0 --locked --root <tool-stage>',
      cargoVersion: 'cargo 1.92.0 (111111111 2025-10-01)',
      sha256: TAURI_HASH,
      serviceStarted: false,
    },
    preflight: {
      stageSha256: sha256(stageBytes),
      checkOnlyReceiptSha256: sha256(receiptBytes),
      checkOnlyStatus: 'passed',
      appLaunched: false,
      driverServiceStarted: false,
      guiTested: false,
      package: PACKAGE,
      cargo: { version: 'cargo 1.92.0 (111111111 2025-10-01)', executableName: 'cargo.exe' },
      tauriDriver: {
        version: '2.1.0',
        source: 'crates.io',
        installCommand: 'cargo install tauri-driver --version 2.1.0 --locked --root <tool-stage>',
        executableSha256: TAURI_HASH,
        serviceStarted: false,
      },
      webView2Pv: { version: '156.0.4314.58', sources: stage.runtimeSources },
      edgeDriver: {
        version: '156.0.4314.84',
        catalogSha256: EDGE_CATALOG_HASH,
        archiveSha256: EDGE_ARCHIVE_HASH,
        executableSha256: EDGE_EXE_HASH,
      },
    },
    procedurePaths: { scenario: WINDOWS_RUN_GATE.scenario },
  };
}

test('run context accepts only the exact push branch and first attempt', () => {
  assert.equal(safeRunContext(CONTEXT_ENV).runId, CONTEXT_ENV.GITHUB_RUN_ID);
  assert.throws(() => safeRunContext({ ...CONTEXT_ENV, GITHUB_RUN_ID: '0' }), /run ID is malformed/);
  assert.throws(() => safeRunContext({ ...CONTEXT_ENV, GITHUB_RUN_ATTEMPT: '2' }), /run attempt/);
  assert.throws(() => safeRunContext({ ...CONTEXT_ENV, GITHUB_SHA: 'not-a-commit' }), /commit SHA/);
  assert.throws(() => safeRunContext({ ...CONTEXT_ENV, GITHUB_REF: 'refs/heads/main' }), /Workflow ref/);
  assert.throws(
    () => safeRunContext({ ...CONTEXT_ENV, GITHUB_EVENT_NAME: 'workflow_dispatch' }),
    /Workflow event/,
  );
  assert.throws(() => safeRunContext({ ...CONTEXT_ENV, RUNNER_ARCH: 'ARM64' }), /Runner architecture/);
  assert.throws(
    () => safeRunContext({ ...CONTEXT_ENV, GITHUB_WORKFLOW_REF: 'other/workflow.yml@main' }),
    /Workflow source ref/,
  );
});

test('Windows path checks reject aliases, UNC, reserved names, and checkout-local temp', () => {
  assert.equal(assertWindowsLocalPath('D:\\a\\_temp'), 'D:\\a\\_temp');
  for (const candidate of [
    '\\\\server\\share\\temp',
    'D:/a/_temp',
    'D:\\a\\..\\temp',
    'D:\\a\\stage.\\file',
    'D:\\a\\CON\\file',
    'D:\\a\\stream:name',
    'D:\\a\\_temp\\',
  ])
    assert.throws(() => assertWindowsLocalPath(candidate));
  assert.equal(assertRunnerTempOutsideWorkspace('D:\\a\\_temp', 'D:\\a\\Morrow\\Morrow'), true);
  assert.throws(
    () => assertRunnerTempOutsideWorkspace('D:\\a\\Morrow\\Morrow\\temp', 'D:\\a\\Morrow\\Morrow'),
    /outside the checkout/,
  );
});

test('package pin binds the package 9d run, artifact digest, and executable bytes', () => {
  assert.deepEqual(validatePackagePin(PACKAGE), PACKAGE);
  assert.throws(() => validatePackagePin({ ...PACKAGE, artifactId: '14221286818' }), /artifactId/);
  assert.throws(
    () => validatePackagePin({ ...PACKAGE, artifactDigest: `sha256:${'f'.repeat(64)}` }),
    /artifact digest/,
  );
  assert.throws(() => validatePackagePin({ ...PACKAGE, sourceExeSha256: 'bad' }), /executable SHA-256/);
  assert.throws(() => validatePackagePin({ ...PACKAGE, sourceTree: 'bad' }), /sourceTree/);
});

test('preflight acceptance requires the exact run, package pins, and check-only no-launch receipt', () => {
  const run = context();
  const { stage, receipt } = stageAndReceipt();
  const summary = validatePreflight(stage, receipt, run);
  assert.equal(summary.tauriDriver.executableSha256, TAURI_HASH);
  assert.equal(summary.webView2Pv.version, '156.0.4314.58');
  assert.throws(() => validatePreflight({ ...stage, runAttempt: '2' }, receipt, run), /attempt/);
  assert.throws(() => validatePreflight({ ...stage, runId: '99' }, receipt, run), /run ID/);
  assert.throws(() => validatePreflight(stage, { ...receipt, appLaunched: true }, run), /app launch/);
  assert.throws(() => validatePreflight(stage, { ...receipt, guiTested: true }, run), /GUI state/);
  assert.throws(
    () => validatePreflight(stage, { ...receipt, plannedPaths: { newPathsCreatedByCheckOnly: true } }, run),
    /profile path/,
  );
  assert.throws(
    () =>
      validatePreflight(
        stage,
        {
          ...receipt,
          drivers: {
            ...receipt.drivers,
            tauriDriver: { ...receipt.drivers.tauriDriver, serviceStarted: true },
          },
        },
        run,
      ),
    /service state/,
  );
});

test('protected Stage precheck binds package and runtime before check-only while allowing local driver byte drift', () => {
  const run = context();
  const binding = bindingFixture();
  const { stage } = stageAndReceipt();
  const freshStage = {
    ...stage,
    drivers: {
      ...stage.drivers,
      tauriDriver: { ...stage.drivers.tauriDriver, executableSha256: '5'.repeat(64) },
    },
  };
  assert.equal(validateStage(freshStage, run).tauriDriver.executableSha256, '5'.repeat(64));
  assert.equal(
    validateProtectedStage(freshStage, binding, run, SOURCE_FILES, BINDING_VALIDATION_TIME).stage.package
      .sourceTree,
    PACKAGE.sourceTree,
  );
  assert.throws(
    () =>
      validateProtectedStage(
        { ...freshStage, artifact: { ...PACKAGE, sourceTree: 'f'.repeat(40) } },
        binding,
        run,
        SOURCE_FILES,
        BINDING_VALIDATION_TIME,
      ),
    /Pinned package sourceTree/,
  );
  assert.throws(
    () =>
      validateProtectedStage(
        {
          ...freshStage,
          drivers: {
            ...freshStage.drivers,
            edgeDriver: { ...freshStage.drivers.edgeDriver, archiveSha256: 'f'.repeat(64) },
          },
        },
        binding,
        run,
        SOURCE_FILES,
        BINDING_VALIDATION_TIME,
      ),
    /Protected EdgeDriver archive hash/,
  );
});

test('protected initialization creates a fresh issue 185 initializing receipt in both jobs', async () => {
  const expectedPreflight = path.win32.join(
    CONTEXT_ENV.RUNNER_TEMP,
    `issue-179-control-${CONTEXT_ENV.GITHUB_RUN_ID}-1`,
  );
  for (const phase of ['prepare', 'protected']) {
    const directories = [];
    const receipts = [];
    const created = new Set();
    await __test.initializePhase(CONTEXT_ENV, phase, {
      createExclusiveDirectoryImpl: async (directory) => {
        assert.equal(created.has(directory.toLowerCase()), false, 'control directory is created once');
        created.add(directory.toLowerCase());
        directories.push(directory);
      },
      writeExclusiveJsonImpl: async (filePath, receipt) => receipts.push({ filePath, receipt }),
    });
    assert.equal(directories.length, 2);
    assert.equal(directories.includes(expectedPreflight), true);
    const preflight = receipts.find(
      ({ filePath }) => filePath === path.win32.join(expectedPreflight, 'receipt.json'),
    );
    assert.ok(preflight);
    assert.equal(preflight.receipt.status, 'initializing');
    assert.equal(preflight.receipt.runId, CONTEXT_ENV.GITHUB_RUN_ID);
    assert.equal(preflight.receipt.runAttempt, '1');
    assert.equal(preflight.receipt.scope, 'Morrow E003 G13 issue 185 preflight only');
  }
});

test('immutable binding validates run, scenario, nonce, expiry, sources, and driver provenance', () => {
  const run = context();
  const binding = bindingFixture();
  assert.equal(
    validateBinding(binding, run, SOURCE_FILES, BINDING_VALIDATION_TIME).driver.sha256,
    TAURI_HASH,
  );
  assert.throws(
    () =>
      validateBinding(
        { ...binding, run: { ...binding.run, id: 'other' } },
        run,
        SOURCE_FILES,
        BINDING_VALIDATION_TIME,
      ),
    /run ID/,
  );
  assert.throws(
    () => validateBinding({ ...binding, scenario: 'launch-app' }, run, SOURCE_FILES, BINDING_VALIDATION_TIME),
    /scenario/,
  );
  assert.throws(
    () => validateBinding({ ...binding, nonce: 'short' }, run, SOURCE_FILES, BINDING_VALIDATION_TIME),
    /128 bits/,
  );
  assert.throws(
    () =>
      validateBinding(
        { ...binding, createdAtUtc: '2026-11-17T04:00:00.000Z', expiresAtUtc: '2026-11-17T07:00:00.000Z' },
        run,
        SOURCE_FILES,
        BINDING_VALIDATION_TIME,
      ),
    /two-hour/,
  );
  assert.throws(
    () => validateBinding(binding, run, SOURCE_FILES, Date.parse('2026-11-17T06:00:00.000Z')),
    /expired/,
  );
  assert.throws(
    () =>
      validateBinding(
        {
          ...binding,
          sourceFiles: {
            files: SOURCE_FILES.map((entry, index) =>
              index === 0 ? { ...entry, sha256: 'f'.repeat(64) } : entry,
            ),
          },
        },
        run,
        SOURCE_FILES,
        BINDING_VALIDATION_TIME,
      ),
    /Source file/,
  );
  assert.throws(
    () =>
      validateBinding(
        { ...binding, approvedDriver: { ...binding.approvedDriver, sha256: 'f'.repeat(64) } },
        run,
        SOURCE_FILES,
        BINDING_VALIDATION_TIME,
      ),
    /provenance hash/,
  );
  assert.throws(
    () =>
      validateBinding({ ...binding, bindingArtifactId: '999' }, run, SOURCE_FILES, BINDING_VALIDATION_TIME),
    /cannot contain its own/,
  );
  assert.throws(
    () =>
      validateBinding({ ...binding, artifactName: 'unbound' }, run, SOURCE_FILES, BINDING_VALIDATION_TIME),
    /artifact name/,
  );
});

test('Actions artifact ID and digest are verified outside the self-describing binding payload', () => {
  const run = context();
  const artifactDigest = 'a'.repeat(64);
  const metadata = {
    id: 98765,
    name: expectedArtifactName(run),
    digest: `sha256:${artifactDigest}`,
    expired: false,
    workflow_run: { id: Number(run.runId), head_sha: run.sha, head_branch: WINDOWS_RUN_GATE.branch },
  };
  assert.equal(
    validateArtifactApiMetadata(metadata, {
      context: run,
      artifactId: '98765',
      artifactDigest,
      artifactName: metadata.name,
    }),
    true,
  );
  assert.throws(
    () =>
      validateArtifactApiMetadata(
        { ...metadata, digest: `sha256:${'b'.repeat(64)}` },
        { context: run, artifactId: '98765', artifactDigest, artifactName: metadata.name },
      ),
    /artifact digest/,
  );
  assert.throws(
    () =>
      validateArtifactApiMetadata(metadata, {
        context: run,
        artifactId: '98766',
        artifactDigest,
        artifactName: metadata.name,
      }),
    /artifact ID/,
  );
  assert.throws(
    () =>
      validateArtifactApiMetadata(
        { ...metadata, workflow_run: { ...metadata.workflow_run, head_sha: 'f'.repeat(40) } },
        { context: run, artifactId: '98765', artifactDigest, artifactName: metadata.name },
      ),
    /workflow source SHA/,
  );
});

test('trusted payload SHA rejects altered binding bytes even with valid artifact metadata', () => {
  const run = context();
  const original = Buffer.from(JSON.stringify(bindingFixture()));
  const trustedSha256 = sha256(original);
  const metadata = {
    id: 98765,
    name: expectedArtifactName(run),
    digest: `sha256:${'a'.repeat(64)}`,
    expired: false,
    workflow_run: { id: Number(run.runId), head_sha: run.sha, head_branch: WINDOWS_RUN_GATE.branch },
  };
  assert.equal(
    validateArtifactApiMetadata(metadata, {
      context: run,
      artifactId: '98765',
      artifactDigest: 'a'.repeat(64),
      artifactName: metadata.name,
    }),
    true,
  );
  assert.equal(parseTrustedBindingPayload(original, trustedSha256).nonce, '0123456789abcdef0123456789abcdef');
  const changedBinding = { ...JSON.parse(original.toString('utf8')), nonce: 'f'.repeat(32) };
  assert.throws(
    () => parseTrustedBindingPayload(Buffer.from(JSON.stringify(changedBinding)), trustedSha256),
    /Trusted binding payload SHA-256/,
  );
  assert.throws(
    () => parseTrustedBindingPayload(Buffer.from('{'), trustedSha256),
    /Trusted binding payload SHA-256/,
  );
});

test('protected workflow prechecks Stage and transfers the approved driver before CheckOnly', async () => {
  const workflow = await readFile(
    new URL('../../.github/workflows/pilot-windows-runtime.yml', import.meta.url),
    'utf8',
  );
  const start = workflow.indexOf('  protected-check-only:');
  const end = workflow.indexOf('\n  audit:', start);
  assert.ok(start >= 0 && end > start);
  const protectedJob = workflow.slice(start, end);
  const requiredSteps = [
    'windows-run-gate.mjs protected-init',
    'windows-preflight.ps1 -Mode Stage',
    'windows-run-gate.mjs protected-precheck',
    'windows-preflight.ps1 -Mode CheckOnly',
    'windows-run-gate.mjs protected-verify',
  ];
  const positions = requiredSteps.map((step) => protectedJob.indexOf(step));
  assert.equal(
    positions.every((position) => position >= 0),
    true,
  );
  assert.deepEqual(
    positions,
    [...positions].sort((left, right) => left - right),
  );
  assert.match(
    protectedJob,
    /GATE_BINDING_PAYLOAD_SHA256:\s*\$\{\{ needs\.prepare\.outputs\.binding_payload_sha256 \}\}/,
  );
});

test('bundle inventory rejects missing or unexpected files', () => {
  const files = [
    'approved-driver/',
    'approved-driver/tauri-driver.exe',
    'binding.json',
    'provenance/',
    'provenance/check-only-receipt.json',
    'provenance/stage.json',
  ];
  assert.equal(assertSafeBundleContents(files), true);
  assert.throws(() => assertSafeBundleContents([...files, '../outside.txt']), /incomplete or unexpected/);
  assert.throws(() => assertSafeBundleContents(files.slice(0, -1)), /incomplete or unexpected/);
});

test('source hash inventory stays inside the checkout and records exact bytes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'morrow-issue181-source-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'morrow-issue181-outside-'));
  try {
    await mkdir(path.join(root, 'scripts', 'pilot'), { recursive: true });
    const sourcePath = path.join(root, 'scripts', 'pilot', 'source.mjs');
    const bytes = Buffer.from('export const bound = true;\n');
    await writeFile(sourcePath, bytes);
    const inventory = await hashSourceFiles(root, ['scripts/pilot/source.mjs']);
    assert.equal(inventory[0].sha256, sha256(bytes));
    await assert.rejects(hashSourceFiles(root, ['../outside/file.mjs']), /outside the checkout/);
    if (process.platform !== 'win32') {
      await writeFile(path.join(outside, 'external.mjs'), 'external');
      await symlink(outside, path.join(root, 'external-link'));
      await assert.rejects(hashSourceFiles(root, ['external-link/external.mjs']), /symbolic link/);
    } else {
      t.skip('Windows runner image does not guarantee symlink creation privilege.');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('local claim uses exclusive creation and rejects a second consumer', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'morrow-issue181-claim-'));
  const claimPath = path.join(root, 'claim.json');
  try {
    const first = { runId: '123', attempt: '1', nonce: 'abc' };
    const firstHash = await claimFileOnce(claimPath, first);
    assert.equal(firstHash.length, 64);
    assert.equal(firstHash, sha256(`${JSON.stringify(first, null, 2)}\n`));
    await assert.rejects(claimFileOnce(claimPath, first), { code: 'EEXIST' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
