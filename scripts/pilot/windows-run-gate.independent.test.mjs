import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

function adapterUrl() {
  const configured = process.env.POLARIS_WINDOWS_RUN_GATE_MODULE;
  if (!configured) return new URL('./windows-run-gate.mjs', import.meta.url);
  return configured.startsWith('file:') ? new URL(configured) : pathToFileURL(path.resolve(configured));
}

const gate = await import(adapterUrl().href);
const {
  WINDOWS_RUN_GATE,
  __test,
  assertSafeBundleContents,
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
} = gate;

const RUN_ENV = Object.freeze({
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
const NOW = Date.parse('2026-11-17T05:00:00.000Z');
const CARGO_VERSION = 'cargo 1.100.0 (3acc79c0c 2026-11-05)';
const TAURI_PREPARE_HASH = '3bd720c493fc7662d4cd3c184bb306350ec7101d6d4e793d2529c92735820abd';
const TAURI_PROTECTED_HASH = 'af80990420eac83a779b2466dd9d0019bef18c9930cb56e9b1e16e3ffd0a8204';
const EDGE_SELECTED = Object.freeze({
  version: '156.0.4314.84',
  versionOutput: 'Microsoft Edge WebDriver 156.0.4314.84 (80b2677ad41c39cab5b059161520c2ada1a92c3d)',
  source: 'Microsoft Edge WebDriver official download',
  sourcePageUrl: 'https://developer.microsoft.com/en-us/microsoft-edge/tools/webdriver',
  sourceCatalogUrl: 'https://msedgedriver.microsoft.com/listing.json',
  downloadUrl: 'https://msedgedriver.microsoft.com/156.0.4314.84/edgedriver_win64.zip',
  responseUrl: 'https://msedgedriver.microsoft.com/156.0.4314.84/edgedriver_win64.zip',
  contentType: 'application/x-zip-compressed',
  selectedLastModified: '2026-11-12T23:18:26.0000000+00:00',
  expectedArchiveBytes: 11631106,
  archiveSizeBytes: 11631106,
  archiveSha256: '8da63dd8eab4086c37f862bd227cef60263d3fa837f4ccca98590dc2c7889d97',
  executableSha256: '6b211417e8c8b09e9c8c3d39cb928f718708ab47c83f08c2ca15596083fbf26b',
  runtimeVersion: '156.0.4314.58',
  compatibleFirstThreeComponents: '156.0.4314',
  compatibleCandidateCount: 12,
  versionProbeExitCode: 0,
  serviceStarted: false,
});
const PREPARE_EDGE = Object.freeze({
  ...EDGE_SELECTED,
  catalogGeneratedAt: '2026-11-13T23:11:37.8486030+00:00',
  catalogSizeBytes: 1348710,
  catalogItemCount: 10089,
  catalogSha256: 'fcdf088fa509a4382e396438785f7f24f336fe5731258eec5c64a1ddf334640b',
});
const PROTECTED_EDGE = Object.freeze({
  ...EDGE_SELECTED,
  catalogGeneratedAt: '2026-11-16T23:24:23.4075781+00:00',
  catalogSizeBytes: 1346958,
  catalogItemCount: 10076,
  catalogSha256: 'dae047c0817a16f04ad9d03b6757c43d40b77ac0b353c20b5e526ddd6e3aa7ac',
});
const RUNTIME_SOURCES = Object.freeze([
  Object.freeze({
    RegistryPath:
      'HKLM64\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    Version: '156.0.4314.58',
    MajorMinorBuild: '156.0.4314',
  }),
]);
const SOURCE_FILES = Object.freeze(
  WINDOWS_RUN_GATE.sourcePaths.map((filePath, index) => ({
    path: filePath,
    sha256: (index + 1).toString(16).padStart(64, '0'),
    sizeBytes: index + 10,
  })),
);

function runContext() {
  return safeRunContext(RUN_ENV);
}

function makeStage(overrides = {}) {
  const runtimeSources = RUNTIME_SOURCES.map((source) => ({ ...source }));
  const stage = {
    schemaVersion: 1,
    status: 'staged',
    scope: 'Morrow E003 G13 issue 185 tool/download stage only',
    runId: RUN_ENV.GITHUB_RUN_ID,
    runAttempt: '1',
    sha: RUN_ENV.GITHUB_SHA,
    branch: WINDOWS_RUN_GATE.branch,
    runtimeVersion: '156.0.4314.58',
    runtimeSources,
    artifact: { ...WINDOWS_RUN_GATE.package },
    drivers: {
      cargo: { version: CARGO_VERSION, executable: 'C:\\Users\\runneradmin\\.cargo\\bin\\cargo.exe' },
      tauriDriver: {
        version: '2.1.0',
        source: 'crates.io',
        sourceUrl: 'https://crates.io/crates/tauri-driver/2.1.0',
        downloadUrl: 'https://crates.io/api/v1/crates/tauri-driver/2.1.0/download',
        installedPackageMetadata: 'cargo install --list --root <tool-stage>\\drivers\\tauri-driver',
        installedBinaryName: 'tauri-driver.exe',
        installCommand: 'cargo install tauri-driver --version 2.1.0 --locked --root <tool-stage>',
        executableSha256: TAURI_PREPARE_HASH,
        serviceStarted: false,
      },
      edgeDriver: { ...PREPARE_EDGE },
    },
    appLaunched: false,
    driverServiceStarted: false,
    ...overrides,
  };
  return stage;
}

function makeProtectedStage() {
  const stage = makeStage();
  stage.drivers.tauriDriver.executableSha256 = TAURI_PROTECTED_HASH;
  stage.drivers.edgeDriver = { ...PROTECTED_EDGE };
  return stage;
}

function makeReceipt(stage) {
  return {
    schemaVersion: 1,
    status: 'passed',
    scope: 'Morrow E003 G13 issue 185 preflight only',
    runId: stage.runId,
    runAttempt: stage.runAttempt,
    sha: stage.sha,
    branch: stage.branch,
    webView2Runtime: {
      version: stage.runtimeVersion,
      sources: stage.runtimeSources.map((source) => ({ ...source })),
    },
    sourceArtifact: { ...stage.artifact },
    package: {
      buildInfoRun: { id: stage.artifact.runId, attempt: stage.artifact.runAttempt },
      applicationVersion: '2.1.0',
      pilotIdentifier: 'app.morrow.polaris-dados-pilot',
      pe: { sha256: stage.artifact.sourceExeSha256 },
    },
    drivers: {
      cargo: { ...stage.drivers.cargo },
      tauriDriver: { ...stage.drivers.tauriDriver },
      edgeDriver: { ...stage.drivers.edgeDriver },
    },
    plannedPaths: { newPathsCreatedByCheckOnly: false, profileObserved: false },
    appLaunched: false,
    driverServiceStarted: false,
    windowsRuntimeTested: false,
    guiTested: false,
  };
}

function makeBinding(overrides = {}) {
  const context = runContext();
  const packagePin = { ...WINDOWS_RUN_GATE.package };
  const tauriDriver = {
    filename: 'tauri-driver.exe',
    version: '2.1.0',
    source: 'crates.io',
    sourceUrl: 'https://crates.io/crates/tauri-driver/2.1.0',
    installCommand: 'cargo install tauri-driver --version 2.1.0 --locked --root <tool-stage>',
    cargoVersion: CARGO_VERSION,
    sha256: TAURI_PREPARE_HASH,
    serviceStarted: false,
  };
  const binding = {
    schema: WINDOWS_RUN_GATE.schema,
    scenario: WINDOWS_RUN_GATE.scenario,
    createdAtUtc: '2026-11-17T04:00:00.000Z',
    expiresAtUtc: '2026-11-17T06:00:00.000Z',
    nonce: '0123456789abcdef0123456789abcdef',
    run: {
      repository: context.repository,
      id: context.runId,
      attempt: '1',
      sha: context.sha,
      ref: context.ref,
      event: context.event,
      workflowRef: context.workflowRef,
    },
    artifactName: expectedArtifactName(context),
    sourceFiles: { files: SOURCE_FILES },
    package: packagePin,
    approvedDriver: tauriDriver,
    preflight: {
      stageSha256: '5'.repeat(64),
      checkOnlyReceiptSha256: '6'.repeat(64),
      checkOnlyStatus: 'passed',
      appLaunched: false,
      driverServiceStarted: false,
      guiTested: false,
      package: packagePin,
      cargo: { version: CARGO_VERSION, executableName: 'cargo.exe' },
      tauriDriver: {
        version: tauriDriver.version,
        source: tauriDriver.source,
        installCommand: tauriDriver.installCommand,
        executableSha256: tauriDriver.sha256,
      },
      webView2Pv: {
        version: '156.0.4314.58',
        sources: RUNTIME_SOURCES.map((source) => ({ ...source })),
      },
      edgeDriver: { ...PREPARE_EDGE },
    },
    procedurePaths: { scenario: WINDOWS_RUN_GATE.scenario },
  };
  return {
    ...binding,
    ...overrides,
    run: { ...binding.run, ...overrides.run },
    sourceFiles: overrides.sourceFiles ?? binding.sourceFiles,
    package: overrides.package ?? binding.package,
    approvedDriver: { ...binding.approvedDriver, ...overrides.approvedDriver },
    preflight: {
      ...binding.preflight,
      ...overrides.preflight,
      package: overrides.preflight?.package ?? binding.preflight.package,
      tauriDriver: { ...binding.preflight.tauriDriver, ...overrides.preflight?.tauriDriver },
      edgeDriver: { ...binding.preflight.edgeDriver, ...overrides.preflight?.edgeDriver },
    },
    procedurePaths: { ...binding.procedurePaths, ...overrides.procedurePaths },
  };
}

function artifactMetadata(overrides = {}) {
  const context = runContext();
  const workflowRun = {
    id: Number(context.runId),
    head_sha: context.sha,
    head_branch: WINDOWS_RUN_GATE.branch,
  };
  return {
    id: 98765,
    name: expectedArtifactName(context),
    digest: `sha256:${'a'.repeat(64)}`,
    expired: false,
    ...overrides,
    workflow_run: { ...workflowRun, ...overrides.workflow_run },
  };
}

function workflowUrl() {
  const configured = process.env.POLARIS_WINDOWS_RUN_GATE_WORKFLOW;
  if (!configured) return new URL('../../.github/workflows/pilot-windows-runtime.yml', import.meta.url);
  return configured.startsWith('file:') ? new URL(configured) : pathToFileURL(path.resolve(configured));
}

test('immutable binding rejects a different attempt, commit, or incomplete source inventory', () => {
  const context = runContext();
  const binding = makeBinding();
  assert.equal(validateBinding(binding, context, SOURCE_FILES, NOW).driver.sha256, TAURI_PREPARE_HASH);
  assert.throws(() =>
    validateBinding(makeBinding({ run: { sha: 'b'.repeat(40) } }), context, SOURCE_FILES, NOW),
  );
  assert.throws(() => validateBinding(makeBinding({ run: { attempt: '2' } }), context, SOURCE_FILES, NOW));

  const duplicateSources = [...SOURCE_FILES];
  duplicateSources[1] = { ...duplicateSources[1], path: duplicateSources[0].path };
  assert.throws(() =>
    validateBinding(makeBinding({ sourceFiles: { files: duplicateSources } }), context, SOURCE_FILES, NOW),
  );
  assert.throws(() =>
    validateBinding(
      makeBinding({ sourceFiles: { files: SOURCE_FILES.slice(1) } }),
      context,
      SOURCE_FILES,
      NOW,
    ),
  );
});

test('artifact API metadata must bind the exact run, branch, digest, and unexpired artifact', () => {
  const context = runContext();
  const expected = {
    context,
    artifactId: '98765',
    artifactDigest: 'a'.repeat(64),
    artifactName: expectedArtifactName(context),
  };
  assert.equal(validateArtifactApiMetadata(artifactMetadata(), expected), true);
  assert.throws(() =>
    validateArtifactApiMetadata(artifactMetadata({ workflow_run: { id: 98766 } }), expected),
  );
  assert.throws(() =>
    validateArtifactApiMetadata(artifactMetadata({ workflow_run: { head_branch: 'main' } }), expected),
  );
  assert.throws(() => validateArtifactApiMetadata(artifactMetadata({ expired: true }), expected));
});

test('trusted producer payload hash rejects valid JSON tampering despite valid artifact metadata', () => {
  const context = runContext();
  const expected = {
    context,
    artifactId: '98765',
    artifactDigest: 'a'.repeat(64),
    artifactName: expectedArtifactName(context),
  };
  const metadata = artifactMetadata();
  assert.equal(validateArtifactApiMetadata(metadata, expected), true);

  const originalBytes = Buffer.from(JSON.stringify(makeBinding()));
  const trustedPayloadSha256 = sha256(originalBytes);
  assert.deepEqual(parseTrustedBindingPayload(originalBytes, trustedPayloadSha256), makeBinding());

  const changedPayload = makeBinding({ run: { sha: 'b'.repeat(40) } });
  const changedBytes = Buffer.from(JSON.stringify(changedPayload));
  assert.notEqual(sha256(changedBytes), trustedPayloadSha256);
  assert.equal(validateArtifactApiMetadata(metadata, expected), true);
  assert.throws(() => parseTrustedBindingPayload(changedBytes, trustedPayloadSha256));

  assert.throws(
    () => parseTrustedBindingPayload(Buffer.from('{invalid JSON'), trustedPayloadSha256),
    (error) => !(error instanceof SyntaxError),
  );
});

test('fresh Stage permits global catalog snapshot drift while preserving the selected driver identity', () => {
  const context = runContext();
  const preparedStage = makeStage();
  const stageSummary = validateStage(preparedStage, context);
  assert.equal(stageSummary.cargo.version, CARGO_VERSION);
  assert.equal(stageSummary.package.sourceTree, WINDOWS_RUN_GATE.package.sourceTree);

  const freshStage = makeProtectedStage();
  const protectedSummary = validateProtectedStage(freshStage, makeBinding(), context, SOURCE_FILES, NOW);
  assert.equal(protectedSummary.stage.tauriDriver.executableSha256, TAURI_PROTECTED_HASH);
  assert.equal(protectedSummary.stage.edgeDriver.catalogSha256, PROTECTED_EDGE.catalogSha256);
  assert.equal(protectedSummary.stage.edgeDriver.archiveSha256, EDGE_SELECTED.archiveSha256);
  assert.equal(protectedSummary.stage.edgeDriver.executableSha256, EDGE_SELECTED.executableSha256);

  const equivalentTimestampStage = makeProtectedStage();
  equivalentTimestampStage.drivers.edgeDriver.selectedLastModified = '2026-11-12T23:18:26+00:00';
  assert.doesNotThrow(() =>
    validateProtectedStage(equivalentTimestampStage, makeBinding(), context, SOURCE_FILES, NOW),
  );

  const wrongPackage = makeProtectedStage();
  wrongPackage.artifact = { ...wrongPackage.artifact, sourceTree: 'e'.repeat(40) };
  assert.throws(() => validateProtectedStage(wrongPackage, makeBinding(), context, SOURCE_FILES, NOW));

  const wrongPv = makeProtectedStage();
  wrongPv.runtimeVersion = '156.0.4314.59';
  wrongPv.runtimeSources = wrongPv.runtimeSources.map((source) => ({
    ...source,
    Version: wrongPv.runtimeVersion,
    MajorMinorBuild: '156.0.4314',
  }));
  wrongPv.drivers.edgeDriver.runtimeVersion = wrongPv.runtimeVersion;
  assert.throws(() => validateProtectedStage(wrongPv, makeBinding(), context, SOURCE_FILES, NOW));

  const changedVersion = makeProtectedStage();
  changedVersion.drivers.edgeDriver.version = '156.0.4314.85';
  changedVersion.drivers.edgeDriver.downloadUrl =
    'https://msedgedriver.microsoft.com/156.0.4314.85/edgedriver_win64.zip';
  changedVersion.drivers.edgeDriver.responseUrl =
    'https://msedgedriver.microsoft.com/156.0.4314.85/edgedriver_win64.zip';
  assert.throws(() => validateProtectedStage(changedVersion, makeBinding(), context, SOURCE_FILES, NOW));

  for (const [field, value] of [
    ['sourcePageUrl', 'https://example.invalid/webdriver'],
    ['downloadUrl', 'https://example.invalid/edgedriver_win64.zip'],
    ['responseUrl', 'https://example.invalid/edgedriver_win64.zip'],
    ['expectedArchiveBytes', EDGE_SELECTED.expectedArchiveBytes + 1],
    ['archiveSizeBytes', EDGE_SELECTED.archiveSizeBytes + 1],
    ['archiveSha256', 'e'.repeat(64)],
    ['executableSha256', 'e'.repeat(64)],
    ['selectedLastModified', '2026-11-12T23:18:26.0000001+00:00'],
  ]) {
    const changedStage = makeProtectedStage();
    changedStage.drivers.edgeDriver[field] = value;
    if (field === 'expectedArchiveBytes' || field === 'archiveSizeBytes') {
      changedStage.drivers.edgeDriver.expectedArchiveBytes = EDGE_SELECTED.expectedArchiveBytes + 1;
      changedStage.drivers.edgeDriver.archiveSizeBytes = EDGE_SELECTED.archiveSizeBytes + 1;
    }
    assert.throws(() => validateProtectedStage(changedStage, makeBinding(), context, SOURCE_FILES, NOW));
  }
});

test('within-VM Stage and CheckOnly compare precise timestamps and full catalog snapshots', () => {
  const stage = makeStage();
  const receipt = makeReceipt(stage);
  receipt.drivers.edgeDriver.catalogGeneratedAt = '2026-11-13T23:11:37.848603+00:00';
  receipt.drivers.edgeDriver.selectedLastModified = '2026-11-12T23:18:26+00:00';
  assert.doesNotThrow(() => validatePreflight(stage, receipt, runContext()));

  for (const [field, value] of [
    ['catalogGeneratedAt', '2026-11-13T23:11:37.8486031+00:00'],
    ['selectedLastModified', '2026-11-12T23:18:26.0000001+00:00'],
    ['catalogSizeBytes', PREPARE_EDGE.catalogSizeBytes + 1],
    ['catalogItemCount', PREPARE_EDGE.catalogItemCount + 1],
    ['catalogSha256', 'e'.repeat(64)],
  ]) {
    const changedReceipt = makeReceipt(stage);
    if (field === 'catalogGeneratedAt') {
      changedReceipt.drivers.edgeDriver[field] = value;
    } else if (field === 'selectedLastModified') {
      changedReceipt.drivers.edgeDriver[field] = value;
    } else {
      changedReceipt.drivers.edgeDriver[field] = value;
    }
    assert.throws(() => validatePreflight(stage, changedReceipt, runContext()));
  }
});

test('both job phases create an initial issue 185 receipt before Stage or CheckOnly', async () => {
  for (const phase of ['prepare', 'protected']) {
    const events = [];
    await __test.initializePhase(RUN_ENV, phase, {
      createExclusiveDirectoryImpl: async (directory, label) =>
        events.push({ type: 'directory', directory, label }),
      writeExclusiveJsonImpl: async (file, value) => events.push({ type: 'receipt', file, value }),
    });

    const receipts = events.filter((event) => event.type === 'receipt');
    assert.equal(receipts.length, 2);
    const gateReceipt = receipts.find((event) => event.value.scope.includes('issue 181'))?.value;
    const preflightReceipt = receipts.find(
      (event) => event.value.scope === 'Morrow E003 G13 issue 185 preflight only',
    )?.value;
    assert.equal(gateReceipt.phase, phase);
    assert.equal(gateReceipt.consumerRan, false);
    assert.equal(preflightReceipt.status, 'initializing');
    assert.equal(preflightReceipt.runId, RUN_ENV.GITHUB_RUN_ID);
    assert.equal(preflightReceipt.runAttempt, '1');
    assert.equal(preflightReceipt.sha, RUN_ENV.GITHUB_SHA);
    assert.equal(preflightReceipt.appLaunched, false);
    assert.equal(preflightReceipt.driverServiceStarted, false);
  }
});

test('workflow binds the producer payload hash and runs protected precheck between Stage and CheckOnly', async () => {
  const workflow = await readFile(workflowUrl(), 'utf8');
  assert.match(
    workflow,
    /binding_payload_sha256:\s*\$\{\{\s*steps\.prepare-binding\.outputs\.binding_payload_sha256\s*\}\}/,
  );

  const protectedJobStart = workflow.indexOf('  protected-check-only:');
  assert.ok(protectedJobStart >= 0, 'Protected consumer job exists.');
  const protectedJob = workflow.slice(protectedJobStart);
  assert.ok(protectedJob.length > 0, 'Protected consumer job exists.');
  assert.match(
    protectedJob,
    /GATE_BINDING_PAYLOAD_SHA256:\s*\$\{\{\s*needs\.prepare\.outputs\.binding_payload_sha256\s*\}\}/,
  );
  assert.ok((protectedJob.match(/GATE_BINDING_PAYLOAD_SHA256:/g) ?? []).length >= 3);

  const requiredSteps = [
    'windows-run-gate.mjs protected-init',
    'windows-preflight.ps1 -Mode Stage',
    'windows-run-gate.mjs protected-precheck',
    'windows-preflight.ps1 -Mode CheckOnly',
    'windows-run-gate.mjs protected-verify',
  ].map((command) => protectedJob.indexOf(command));
  assert.ok(
    requiredSteps.every((position) => position >= 0),
    'All protected phase commands are present.',
  );
  assert.deepEqual(
    requiredSteps,
    [...requiredSteps].sort((left, right) => left - right),
  );
});

test('package provenance rejects valid-shaped but unpinned source and executable identities', () => {
  const pinned = { ...WINDOWS_RUN_GATE.package };
  assert.deepEqual(validatePackagePin(pinned), pinned);
  assert.throws(() => validatePackagePin({ ...pinned, sourceSha: 'f'.repeat(40) }));
  assert.throws(() => validatePackagePin({ ...pinned, sourceBranch: 'main' }));
  assert.throws(() => validatePackagePin({ ...pinned, outerSha256: 'f'.repeat(64) }));
  assert.throws(() => validatePackagePin({ ...pinned, sourceExeSha256: 'f'.repeat(64) }));
});

test('exclusive run claim has exactly one winner when consumers race', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'morrow-issue181-independent-claim-'));
  const claimPath = path.join(root, 'claim.json');
  try {
    const claims = await Promise.allSettled([
      claimFileOnce(claimPath, { runId: '12345678901', attempt: '1', nonce: 'first' }),
      claimFileOnce(claimPath, { runId: '12345678901', attempt: '1', nonce: 'second' }),
    ]);
    assert.equal(claims.filter((entry) => entry.status === 'fulfilled').length, 1);
    const rejected = claims.find((entry) => entry.status === 'rejected');
    assert.equal(rejected.reason.code, 'EEXIST');
    const stored = JSON.parse(await readFile(claimPath, 'utf8'));
    assert.ok(['first', 'second'].includes(stored.nonce));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('source hashing rejects checkout escapes and reflects changed source bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'morrow-issue181-independent-source-'));
  try {
    await writeFile(path.join(root, 'source.mjs'), 'frozen source one\n');
    const first = await hashSourceFiles(root, ['source.mjs']);
    assert.equal(first[0].sha256, sha256(Buffer.from('frozen source one\n')));
    await writeFile(path.join(root, 'source.mjs'), 'changed source two\n');
    const second = await hashSourceFiles(root, ['source.mjs']);
    assert.notEqual(first[0].sha256, second[0].sha256);
    await assert.rejects(hashSourceFiles(root, ['../outside.mjs']));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('binding bundle inventory rejects duplicate entries and injected paths', () => {
  const expected = [
    'approved-driver/',
    'approved-driver/tauri-driver.exe',
    'binding.json',
    'provenance/',
    'provenance/check-only-receipt.json',
    'provenance/stage.json',
  ];
  assert.equal(assertSafeBundleContents(expected), true);
  assert.throws(() => assertSafeBundleContents([...expected, 'binding.json']));
  assert.throws(() => assertSafeBundleContents([...expected, 'provenance/../outside.json']));
});
