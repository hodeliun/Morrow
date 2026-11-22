import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  FIRST_LAUNCH_CANDIDATE,
  FirstLaunchGateError,
  WINDOWS_FIRST_LAUNCH_GATE,
  claimFirstLaunchOnce,
  createBinding,
  createTestFilesystemBacking,
  firstLaunchClaimPath,
  hashSourceFiles,
  parseTrustedBindingPayload,
  safeFirstLaunchRunContext,
  serializeBinding,
  validateActionsArtifactMetadata,
  validateActionsWorkflowRunMetadata,
  validateBinding,
} from './windows-first-launch-gate.mjs';

const NOW = Date.parse('2026-11-22T00:03:00.000Z');
const STAGED_AT = '2026-11-22T00:01:00.000Z';
const CHECKED_AT = '2026-11-22T00:02:00.000Z';
const RUNTIME_VERSION = '156.0.4314.58';
const DRIVER_VERSION = '156.0.4314.84';
const RUNTIME_HKLM =
  'HKLM64\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
const RUNTIME_HKCU =
  'HKCU64\\Software\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

const PINNED_PACKAGE_INVENTORY = [
  {
    path: 'DemoVault/.morrow/plugins.json',
    sizeBytes: 43,
    sha256: 'fccc40d7f515aafe89f665615e6872fea972c873a17fc861d1f9b2d2c3fc06b6',
  },
  {
    path: 'DemoVault/.morrow/plugins/polaris-dados/LICENSE',
    sizeBytes: 11558,
    sha256: '1eb85fc97224598dad1852b5d6483bbcf0aa8608790dcc657a5a2a761ae9c8c6',
  },
  {
    path: 'DemoVault/.morrow/plugins/polaris-dados/main.js',
    sizeBytes: 111948,
    sha256: '27c108b72897466aeb47e978c4633911d8e64c6d703f03e97d6b20c7a27cfee3',
  },
  {
    path: 'DemoVault/.morrow/plugins/polaris-dados/manifest.json',
    sizeBytes: 178,
    sha256: '6708670c4529d683a8269252115f069500d465fa4369d0c4f43447c4f945e145',
  },
  {
    path: 'DemoVault/.morrow/plugins/polaris-dados/README.md',
    sizeBytes: 5957,
    sha256: '4f80935c9f7b2993c002e2249a3577ae9127d858f07c0c409aa7fdb0e75c6abb',
  },
  {
    path: 'DemoVault/.morrow/workspace.json',
    sizeBytes: 913,
    sha256: '48523143d05636f52585aec2a8cb528fdb8ed18319efdc9d81615eb2166f66ab',
  },
  {
    path: 'DemoVault/Checklist Views.md',
    sizeBytes: 555,
    sha256: '6e7410847b51bbcddf2bddcfc8160ed730262b0f3f9a3fa40b157151e2560de6',
  },
  {
    path: 'DemoVault/Checklist.md',
    sizeBytes: 405,
    sha256: 'c12c55141e6a4a5997e36254c8c3195b56da291d9b71096f6e800e6d76279848',
  },
  {
    path: 'DemoVault/Checklist/Missing.md',
    sizeBytes: 60,
    sha256: 'ba3855e412d01c0edb3d7fecb99c120c129ff88d4995bdf6f8037a0c683dd810',
  },
  {
    path: 'DemoVault/Checklist/Null.md',
    sizeBytes: 68,
    sha256: '58b1a30cf4072c8fe9fbf3930545e38a017174cd5b34ea8c584ee9f2362c1935',
  },
  {
    path: 'DemoVault/Checklist/Unchecked.md',
    sizeBytes: 60,
    sha256: '6936d098a993c248b91a37babf47bebbfe4c956bd556f1256e04f964972a4146',
  },
  {
    path: 'DemoVault/Inventory.md',
    sizeBytes: 569,
    sha256: '46911f087baee1a0eac73b2e62ba0904c2c55f641119bfb416b92bad729d1383',
  },
  {
    path: 'DemoVault/Inventory/Widget.md',
    sizeBytes: 105,
    sha256: '306a70f5cde5e6dc4956a016812f54f216f716f0ff196d038f55c5c6e01be700',
  },
  {
    path: 'DemoVault/Views.md',
    sizeBytes: 828,
    sha256: 'dc99d9eb869c51f4b17bc03044b587af249323c737f85f83cd8229ad0e17f2b0',
  },
  {
    path: 'mcp/index.js',
    sizeBytes: 1928614,
    sha256: '555b5b5aeb441f1fc10958aeea3bb49c694810d369de60833d1a3d46cb498ade',
  },
  {
    path: 'morrow.exe',
    sizeBytes: 51768832,
    sha256: '85015c92631dbfcef49856c6729accd1c4d2567c097ef87c5ebad38745f99879',
  },
  {
    path: 'TESTAR-NO-WINDOWS.md',
    sizeBytes: 6298,
    sha256: '4df976b8340fd3cefaa00472302bc5599020021c31c593a3b28ad2fcf386908b',
  },
  {
    path: 'windows-launch.cmd',
    sizeBytes: 329,
    sha256: 'b22e8236a258f9aceccd4476c2d4e3490a9fcc63a699476d6af691a5bc6e4798',
  },
  {
    path: 'windows-launch.ps1',
    sizeBytes: 20633,
    sha256: '321b9e8cc723e292225ef3819110776363843bf6c85761a5e22ae9871bc2ef79',
  },
];

function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

function environmentFor({
  runnerTemp = 'D:\\a\\_temp',
  gateRunId = '555555555',
  sourceSha = 'a'.repeat(40),
  workspace = 'D:\\a\\Morrow',
} = {}) {
  return {
    GITHUB_REPOSITORY: 'hodeliun/Morrow',
    GITHUB_REF: WINDOWS_FIRST_LAUNCH_GATE.ref,
    GITHUB_WORKFLOW_REF: WINDOWS_FIRST_LAUNCH_GATE.workflowRef,
    GITHUB_SHA: sourceSha,
    GITHUB_RUN_ID: gateRunId,
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_EVENT_NAME: 'push',
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: runnerTemp,
    RUNNER_OS: 'Windows',
    RUNNER_ARCH: 'X64',
  };
}

function contextFor(options) {
  return safeFirstLaunchRunContext(environmentFor(options));
}

function gateIdentity(context) {
  return {
    repository: context.repository,
    ref: context.ref,
    workflowPath: context.workflowPath,
    workflowRef: context.workflowRef,
    sourceSha: context.sourceSha,
    gateRunId: context.gateRunId,
    gateRunAttempt: context.gateRunAttempt,
    event: context.event,
  };
}

function profilePaths(context) {
  const api = path.win32;
  const root = api.join(
    context.runner.tempRoot,
    'morrow-issue-187-' + context.sourceSha + '-' + context.gateRunId + '-1',
    'profile',
  );
  return {
    root,
    morrowUserData: api.join(root, 'MorrowUserData'),
    webView2UserData: api.join(root, 'WebView2UserData'),
  };
}

function sourceHashes() {
  return WINDOWS_FIRST_LAUNCH_GATE.sourcePaths.map((filePath, index) => ({
    path: filePath,
    sha256: String(index + 1).padStart(64, '0'),
    sizeBytes: 10 + index,
  }));
}

function packageInventory() {
  return deepCopy(PINNED_PACKAGE_INVENTORY);
}

function driverProvenance() {
  return {
    tauriDriver: {
      version: '2.1.0',
      source: 'crates.io',
      sourceUrl: 'https://crates.io/crates/tauri-driver/2.1.0',
      downloadUrl: 'https://crates.io/api/v1/crates/tauri-driver/2.1.0/download',
      cargoVersion: 'cargo 1.91.0',
      installCommand: 'cargo install tauri-driver --version 2.1.0 --locked --root <tool-stage>',
      executableSha256: '1'.repeat(64),
      serviceStarted: false,
    },
    edgeDriver: {
      version: DRIVER_VERSION,
      runtimeVersion: RUNTIME_VERSION,
      compatibleFirstThreeComponents: '156.0.4314',
      sourcePageUrl: 'https://developer.microsoft.com/en-us/microsoft-edge/tools/webdriver',
      sourceCatalogUrl: 'https://msedgedriver.microsoft.com/listing.json',
      downloadUrl: 'https://msedgedriver.microsoft.com/' + DRIVER_VERSION + '/edgedriver_win64.zip',
      responseUrl: 'https://msedgedriver.microsoft.com/' + DRIVER_VERSION + '/edgedriver_win64.zip',
      catalogGeneratedAtUtc: '2026-11-21T23:00:00.0000000Z',
      catalogSizeBytes: 1000,
      catalogItemCount: 10089,
      catalogSha256: '2'.repeat(64),
      selectedLastModified: '2026-11-21T22:00:00.0000000Z',
      expectedArchiveBytes: 11631106,
      archiveSizeBytes: 11631106,
      archiveSha256: '3'.repeat(64),
      executableSha256: '4'.repeat(64),
      versionProbeExitCode: 0,
      serviceStarted: false,
    },
  };
}

function stageRecord(context, overrides = {}) {
  return {
    schema: WINDOWS_FIRST_LAUNCH_GATE.stageSchema,
    status: 'staged',
    purpose: WINDOWS_FIRST_LAUNCH_GATE.purpose,
    executionPhase: WINDOWS_FIRST_LAUNCH_GATE.executionPhase,
    gate: gateIdentity(context),
    runner: {
      os: 'Windows',
      arch: 'X64',
      tempRoot: context.runner.tempRoot,
    },
    webView2Runtime: {
      version: RUNTIME_VERSION,
      observedAtUtc: STAGED_AT,
      sources: [
        { registryPath: RUNTIME_HKLM, version: RUNTIME_VERSION },
        { registryPath: RUNTIME_HKCU, version: RUNTIME_VERSION },
      ],
    },
    candidateBuild: deepCopy(FIRST_LAUNCH_CANDIDATE),
    packageInventory: packageInventory(),
    drivers: driverProvenance(),
    noLaunch: {
      appLaunched: false,
      driverServiceStarted: false,
      guiTested: false,
    },
    stagedAtUtc: STAGED_AT,
    ...overrides,
  };
}

function bytes(value) {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function fixture(context = contextFor(), { stageOverrides = {}, receiptOverrides = {} } = {}) {
  const stage = stageRecord(context, stageOverrides);
  const stageBytes = bytes(stage);
  const receipt = {
    schema: WINDOWS_FIRST_LAUNCH_GATE.checkOnlyReceiptSchema,
    status: 'passed',
    purpose: WINDOWS_FIRST_LAUNCH_GATE.purpose,
    executionPhase: WINDOWS_FIRST_LAUNCH_GATE.executionPhase,
    gate: gateIdentity(context),
    candidateBuild: deepCopy(FIRST_LAUNCH_CANDIDATE),
    stageSha256: sha256(stageBytes),
    pinsVerified: true,
    driverHashes: {
      tauriDriverSha256: stage.drivers.tauriDriver.executableSha256,
      edgeDriverSha256: stage.drivers.edgeDriver.executableSha256,
    },
    webView2RuntimeVersion: RUNTIME_VERSION,
    identity: { sid: 'S-1-5-21-100-200-300-1001' },
    knownFolders: {
      localAppData: 'C:\\Users\\runneradmin\\AppData\\Local',
      roamingAppData: 'C:\\Users\\runneradmin\\AppData\\Roaming',
    },
    profiles: profilePaths(context),
    noLaunch: {
      appLaunched: false,
      driverServiceStarted: false,
      guiTested: false,
    },
    checkedAtUtc: CHECKED_AT,
    ...receiptOverrides,
  };
  return {
    context,
    stage,
    stageBytes,
    receipt,
    checkOnlyReceiptBytes: bytes(receipt),
    sourceHashes: sourceHashes(),
  };
}

function makeBinding(f = fixture(), now = NOW) {
  return {
    ...f,
    created: createBinding({
      context: f.context,
      sourceHashes: f.sourceHashes,
      stageBytes: f.stageBytes,
      checkOnlyReceiptBytes: f.checkOnlyReceiptBytes,
      now,
    }),
    now,
  };
}

function assertGateFailure(callback, messagePattern) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof FirstLaunchGateError);
    assert.equal(error.name, 'FirstLaunchGateError');
    assert.equal(error.code, 'ERR_FIRST_LAUNCH_GATE');
    if (messagePattern) assert.match(error.message, messagePattern);
    return true;
  });
}

function expectedActionsArtifact() {
  return {
    repository: 'hodeliun/Morrow',
    artifactId: FIRST_LAUNCH_CANDIDATE.artifact.id,
    artifactName: FIRST_LAUNCH_CANDIDATE.artifact.name,
    artifactDigest: FIRST_LAUNCH_CANDIDATE.artifact.digest,
    artifactSizeBytes: FIRST_LAUNCH_CANDIDATE.artifact.sizeBytes,
    workflowRunId: FIRST_LAUNCH_CANDIDATE.candidateBuildRunId,
    sourceSha: FIRST_LAUNCH_CANDIDATE.sourceSha,
    sourceBranch: FIRST_LAUNCH_CANDIDATE.branch,
  };
}

function actionsArtifactMetadata() {
  const expected = expectedActionsArtifact();
  return {
    id: Number(expected.artifactId),
    name: expected.artifactName,
    digest: expected.artifactDigest,
    size_in_bytes: expected.artifactSizeBytes,
    expired: false,
    workflow_run: {
      id: Number(expected.workflowRunId),
      head_sha: expected.sourceSha,
      head_branch: expected.sourceBranch,
    },
  };
}

test('creates and validates the exact run binding with separate candidate and gate runs', () => {
  const f = makeBinding();
  const { binding, payloadBytes, payloadSha256 } = f.created;
  const result = validateBinding(binding, {
    context: f.context,
    sourceHashes: f.sourceHashes,
    stageBytes: f.stageBytes,
    checkOnlyReceiptBytes: f.checkOnlyReceiptBytes,
    now: f.now,
  });

  assert.equal(binding.purpose, 'first-windows-launch');
  assert.equal(binding.executionPhase, 'protected-check-only');
  assert.notEqual(binding.gate.gateRunId, binding.candidateBuild.candidateBuildRunId);
  assert.equal(binding.gate.gateRunId, f.context.gateRunId);
  assert.equal(binding.candidateBuild.candidateBuildRunId, '44961916968');
  assert.equal(binding.gate.gateRunAttempt, '1');
  assert.match(binding.nonce, /^[0-9a-f]{32}$/);
  assert.equal(Date.parse(binding.expiresAtUtc) - Date.parse(binding.createdAtUtc), 7200000);
  assert.equal(binding.stage.sha256, sha256(f.stageBytes));
  assert.equal(binding.checkOnlyReceipt.sha256, sha256(f.checkOnlyReceiptBytes));
  assert.equal(payloadSha256, sha256(payloadBytes));
  assert.deepEqual(serializeBinding(binding), payloadBytes);
  assert.deepEqual(parseTrustedBindingPayload(payloadBytes, payloadSha256), binding);
  assert.deepEqual(result, {
    gateRunId: f.context.gateRunId,
    gateRunAttempt: '1',
    candidateBuildRunId: '44961916968',
    candidateBuildRunAttempt: '1',
    nonce: binding.nonce,
    createdAtUtc: binding.createdAtUtc,
    expiresAtUtc: binding.expiresAtUtc,
    stageSha256: binding.stage.sha256,
    checkOnlyReceiptSha256: binding.checkOnlyReceipt.sha256,
  });
});

test('source inventory pins the ordered G15 paths and the legacy Windows preflight source', () => {
  assert.deepEqual(WINDOWS_FIRST_LAUNCH_GATE.sourcePaths, [
    '.github/workflows/pilot-windows-first-launch-preflight.yml',
    'scripts/pilot/windows-first-launch-gate.mjs',
    'scripts/pilot/windows-run-gate.mjs',
    'scripts/pilot/windows-first-launch-gate.test.mjs',
    'scripts/pilot/windows-first-launch-gate.independent.test.mjs',
    'scripts/pilot/windows-first-launch-preflight.ps1',
    'scripts/pilot/windows-first-launch-preflight.test.ps1',
    'scripts/pilot/windows-first-launch-preflight.independent.test.ps1',
    'scripts/pilot/windows-preflight.ps1',
  ]);
  const sourceInventory = sourceHashes();
  assert.doesNotThrow(() =>
    createBinding({
      ...fixture(),
      sourceHashes: sourceInventory,
      now: NOW,
    }),
  );
  const missingImportedHelper = sourceInventory.filter(
    (entry) => entry.path !== 'scripts/pilot/windows-run-gate.mjs',
  );
  assertGateFailure(
    () =>
      createBinding({
        ...fixture(),
        sourceHashes: missingImportedHelper,
        now: NOW,
      }),
    /incomplete/,
  );
});

test('hashes the copied legacy preflight and rejects its absence or byte drift', async (t) => {
  const legacyPath = 'scripts/pilot/windows-preflight.ps1';
  const root = await mkdtemp(path.join(os.tmpdir(), 'morrow-first-launch-legacy-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacyBytes = await readFile(new URL('./windows-preflight.ps1', import.meta.url));

  assert.equal(WINDOWS_FIRST_LAUNCH_GATE.sourcePaths.at(-1), legacyPath);
  for (const filePath of WINDOWS_FIRST_LAUNCH_GATE.sourcePaths) {
    const absolutePath = path.join(root, filePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(
      absolutePath,
      filePath === legacyPath ? legacyBytes : 'fixture source for ' + filePath + '\n',
    );
  }

  const copiedSourceHashes = await hashSourceFiles(root);
  const copiedLegacyHash = copiedSourceHashes.find((entry) => entry.path === legacyPath);
  assert.equal(copiedLegacyHash.sha256, sha256(legacyBytes));
  assert.equal(copiedLegacyHash.sizeBytes, legacyBytes.byteLength);
  const f = fixture();
  const created = createBinding({
    context: f.context,
    sourceHashes: copiedSourceHashes,
    stageBytes: f.stageBytes,
    checkOnlyReceiptBytes: f.checkOnlyReceiptBytes,
    now: NOW,
  });
  assert.doesNotThrow(() =>
    validateBinding(created.binding, {
      context: f.context,
      sourceHashes: copiedSourceHashes,
      stageBytes: f.stageBytes,
      checkOnlyReceiptBytes: f.checkOnlyReceiptBytes,
      now: NOW,
    }),
  );

  const copiedLegacyPath = path.join(root, legacyPath);
  await rm(copiedLegacyPath);
  await assert.rejects(hashSourceFiles(root), {
    name: 'FirstLaunchGateError',
    code: 'ERR_FIRST_LAUNCH_GATE',
  });

  await writeFile(copiedLegacyPath, Buffer.concat([legacyBytes, Buffer.from('\n# mock drift\n', 'utf8')]));
  const driftedSourceHashes = await hashSourceFiles(root);
  const driftedLegacyHash = driftedSourceHashes.find((entry) => entry.path === legacyPath);
  assert.notEqual(driftedLegacyHash.sha256, copiedLegacyHash.sha256);
  assertGateFailure(() =>
    validateBinding(created.binding, {
      context: f.context,
      sourceHashes: driftedSourceHashes,
      stageBytes: f.stageBytes,
      checkOnlyReceiptBytes: f.checkOnlyReceiptBytes,
      now: NOW,
    }),
  );
});

test('hashes explicit source fixtures and rejects source traversal or symlinks', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'morrow-first-launch-hashes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts', 'pilot'), { recursive: true });
  const filePath = path.join(root, 'scripts', 'pilot', 'gate.mjs');
  await writeFile(filePath, 'fixture source\n');
  const result = await hashSourceFiles(root, ['scripts/pilot/gate.mjs']);
  assert.equal(result[0].path, 'scripts/pilot/gate.mjs');
  assert.equal(result[0].sha256, sha256(Buffer.from('fixture source\n')));
  assert.equal(result[0].sizeBytes, Buffer.byteLength('fixture source\n'));
  await assert.rejects(hashSourceFiles(root, ['../outside.mjs']), {
    name: 'FirstLaunchGateError',
    code: 'ERR_FIRST_LAUNCH_GATE',
  });
  const linkPath = path.join(root, 'scripts', 'pilot', 'linked.mjs');
  await symlink(filePath, linkPath);
  await assert.rejects(hashSourceFiles(root, ['scripts/pilot/linked.mjs']), {
    name: 'FirstLaunchGateError',
    code: 'ERR_FIRST_LAUNCH_GATE',
  });
});

test('hashes the imported Windows run-gate source and rejects its absence or drift', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'morrow-first-launch-source-set-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const importedPath = 'scripts/pilot/windows-run-gate.mjs';
  for (const filePath of WINDOWS_FIRST_LAUNCH_GATE.sourcePaths) {
    if (filePath === importedPath) continue;
    const absolutePath = path.join(root, filePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, 'fixture source for ' + filePath + '\n');
  }

  await assert.rejects(hashSourceFiles(root), {
    name: 'FirstLaunchGateError',
    code: 'ERR_FIRST_LAUNCH_GATE',
  });
  const importedAbsolutePath = path.join(root, importedPath);
  await mkdir(path.dirname(importedAbsolutePath), { recursive: true });
  await writeFile(importedAbsolutePath, 'imported helper version 1\n');
  const first = await hashSourceFiles(root);
  const firstHelperHash = first.find((entry) => entry.path === importedPath).sha256;
  await writeFile(importedAbsolutePath, 'imported helper version 2\n');
  const second = await hashSourceFiles(root);
  const secondHelperHash = second.find((entry) => entry.path === importedPath).sha256;
  assert.notEqual(secondHelperHash, firstHelperHash);
});

test('Node canonical serialization retains the pinned 19-entry inventory digest', () => {
  const inventoryBytes = Buffer.from(JSON.stringify(PINNED_PACKAGE_INVENTORY), 'utf8');
  assert.equal(PINNED_PACKAGE_INVENTORY.length, 19);
  assert.equal(sha256(inventoryBytes), FIRST_LAUNCH_CANDIDATE.package.canonicalInventorySha256);
  assert.equal(inventoryBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false);
  assert.equal(inventoryBytes.includes(0x0a), false);
});

test('PowerShell serialization matches Node when PowerShell is available', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'morrow-first-launch-inventory-interop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputPath = path.join(root, 'inventory.json');
  const outputPath = path.join(root, 'powershell-inventory.json');
  const scriptPath = path.join(root, 'serialize-inventory.ps1');
  const inventoryBytes = Buffer.from(JSON.stringify(PINNED_PACKAGE_INVENTORY), 'utf8');
  const override = process.env.MORROW_TEST_PWSH;
  const script = [
    'param([Parameter(Mandatory = $true)][string] $InputPath, [Parameter(Mandatory = $true)][string] $OutputPath)',
    "$ErrorActionPreference = 'Stop'",
    '$raw = [IO.File]::ReadAllText($InputPath, [Text.Encoding]::UTF8)',
    '$inventory = ConvertFrom-Json -InputObject $raw -AsHashtable',
    '$serialized = ConvertTo-Json -InputObject $inventory -Depth 20 -Compress',
    '$encoding = [Text.UTF8Encoding]::new($false)',
    '[IO.File]::WriteAllBytes($OutputPath, $encoding.GetBytes($serialized))',
    '',
  ].join('\n');

  if (override !== undefined && override.trim().length === 0) {
    assert.fail('MORROW_TEST_PWSH must name a PowerShell executable when set.');
  }
  await Promise.all([writeFile(inputPath, inventoryBytes), writeFile(scriptPath, script, 'utf8')]);

  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    ...(process.platform === 'win32' ? ['-ExecutionPolicy', 'Bypass'] : []),
    '-File',
    scriptPath,
    inputPath,
    outputPath,
  ];
  const result = spawnSync(override ?? 'pwsh', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 15_000,
  });
  if (result.error?.code === 'ENOENT' && process.platform !== 'win32' && override === undefined) {
    t.skip('pwsh is unavailable on this non-Windows host; the Node digest test still ran.');
    return;
  }
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || 'PowerShell inventory serialization failed.');

  const powershellBytes = await readFile(outputPath);
  assert.deepEqual(powershellBytes, inventoryBytes);
  assert.equal(powershellBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false);
  assert.equal(powershellBytes.includes(0x0a), false);
  assert.equal(sha256(powershellBytes), FIRST_LAUNCH_CANDIDATE.package.canonicalInventorySha256);
});

test('requires normalized local Windows runner paths and rejects aliases and alternate streams', () => {
  const environment = environmentFor();
  for (const tempRoot of [
    '/tmp/morrow-runner-temp',
    '\\\\server\\share\\runner-temp',
    'D:\\a\\_temp\\PROGRA~1',
    'D:\\a\\_temp\\profile:alternate',
    'D:\\a\\_temp\\directory.',
    'D:\\a\\_temp\\..\\other',
    'D:\\a\\_temp\\CON',
  ]) {
    assertGateFailure(() =>
      safeFirstLaunchRunContext({
        ...environment,
        RUNNER_TEMP: tempRoot,
      }),
    );
  }
  assertGateFailure(() =>
    safeFirstLaunchRunContext({
      ...environment,
      GITHUB_WORKSPACE: '\\\\server\\share\\checkout',
    }),
  );
});

test('rejects purpose, phase, extra fields, and gate identity changes', () => {
  const f = makeBinding();
  const wrongPurpose = deepCopy(f.created.binding);
  wrongPurpose.purpose = 'generic-check-only';
  assertGateFailure(
    () =>
      validateBinding(wrongPurpose, {
        context: f.context,
        sourceHashes: f.sourceHashes,
        stageBytes: f.stageBytes,
        checkOnlyReceiptBytes: f.checkOnlyReceiptBytes,
        now: f.now,
      }),
    /purpose/,
  );

  const wrongPhase = deepCopy(f.created.binding);
  wrongPhase.executionPhase = 'first-launch';
  assertGateFailure(
    () =>
      validateBinding(wrongPhase, {
        context: f.context,
        sourceHashes: f.sourceHashes,
        stageBytes: f.stageBytes,
        checkOnlyReceiptBytes: f.checkOnlyReceiptBytes,
        now: f.now,
      }),
    /phase/,
  );

  const extraField = deepCopy(f.created.binding);
  extraField.authorized = true;
  assertGateFailure(
    () =>
      validateBinding(extraField, {
        context: f.context,
        sourceHashes: f.sourceHashes,
        stageBytes: f.stageBytes,
        checkOnlyReceiptBytes: f.checkOnlyReceiptBytes,
        now: f.now,
      }),
    /missing or unexpected fields/,
  );

  for (const [field, value] of [
    ['repository', 'other/Morrow'],
    ['ref', 'refs/heads/main'],
    [
      'workflowRef',
      'hodeliun/Morrow/.github/workflows/pilot-windows-runtime.yml@refs/heads/codex/e003-g07-windows-runtime',
    ],
    ['sourceSha', 'b'.repeat(40)],
    ['gateRunId', '555555556'],
    ['gateRunAttempt', '2'],
    ['event', 'workflow_dispatch'],
  ]) {
    const altered = deepCopy(f.created.binding);
    altered.gate[field] = value;
    assertGateFailure(() =>
      validateBinding(altered, {
        context: f.context,
        sourceHashes: f.sourceHashes,
        stageBytes: f.stageBytes,
        checkOnlyReceiptBytes: f.checkOnlyReceiptBytes,
        now: f.now,
      }),
    );
  }
});

test('rejects source hash drift, stage byte drift, and mismatched check-only receipts', () => {
  const f = makeBinding();
  const sourceDrift = deepCopy(f.created.binding);
  const importedHelperIndex = sourceDrift.gate.sourceHashes.findIndex(
    (entry) => entry.path === 'scripts/pilot/windows-run-gate.mjs',
  );
  sourceDrift.gate.sourceHashes[importedHelperIndex].sha256 = 'f'.repeat(64);
  assertGateFailure(() =>
    validateBinding(sourceDrift, {
      context: f.context,
      sourceHashes: f.sourceHashes,
      stageBytes: f.stageBytes,
      checkOnlyReceiptBytes: f.checkOnlyReceiptBytes,
      now: f.now,
    }),
  );

  const tamperedStage = Buffer.from(f.stageBytes);
  tamperedStage[tamperedStage.length - 2] ^= 1;
  assertGateFailure(() =>
    validateBinding(f.created.binding, {
      context: f.context,
      sourceHashes: f.sourceHashes,
      stageBytes: tamperedStage,
      checkOnlyReceiptBytes: f.checkOnlyReceiptBytes,
      now: f.now,
    }),
  );

  const badReceipt = deepCopy(f.receipt);
  badReceipt.profiles.webView2UserData += '\\Other';
  assertGateFailure(() => {
    const badReceiptBytes = bytes(badReceipt);
    validateBinding(f.created.binding, {
      context: f.context,
      sourceHashes: f.sourceHashes,
      stageBytes: f.stageBytes,
      checkOnlyReceiptBytes: badReceiptBytes,
      now: f.now,
    });
  });
});

test('rejects package inventory drift, duplicate paths, and unsafe package paths', () => {
  const f = makeBinding();
  const alteredBindingSummary = deepCopy(f.created.binding);
  alteredBindingSummary.stage.packageInventorySha256 = 'f'.repeat(64);
  assertGateFailure(() => serializeBinding(alteredBindingSummary), /pinned candidate invoice/);
  for (const mutate of [
    (stage) => {
      stage.packageInventory[0].sha256 = 'f'.repeat(64);
    },
    (stage) => {
      stage.packageInventory[1].path = stage.packageInventory[0].path;
    },
    (stage) => {
      stage.packageInventory[17].path = 'windows-launch.CMD';
    },
    (stage) => {
      stage.packageInventory[0].path = '../outside.bin';
    },
    (stage) => {
      stage.packageInventory[0].path = 'DemoVault/invalid.';
    },
    (stage) => {
      stage.packageInventory[0].path = 'DemoVault/invalid:stream';
    },
    (stage) => {
      stage.packageInventory.pop();
    },
    (stage) => {
      stage.packageInventory.push({ path: 'extra.bin', sizeBytes: 1, sha256: 'a'.repeat(64) });
    },
  ]) {
    const alteredStage = stageRecord(f.context);
    mutate(alteredStage);
    const alteredStageBytes = bytes(alteredStage);
    const alteredReceipt = deepCopy(f.receipt);
    alteredReceipt.stageSha256 = sha256(alteredStageBytes);
    assertGateFailure(() => {
      validateBinding(f.created.binding, {
        context: f.context,
        sourceHashes: f.sourceHashes,
        stageBytes: alteredStageBytes,
        checkOnlyReceiptBytes: bytes(alteredReceipt),
        now: f.now,
      });
    });
  }
});

test('rejects a WebView2 observation later than the Stage timestamp', () => {
  const f = fixture();
  const stage = stageRecord(f.context, {
    webView2Runtime: {
      version: RUNTIME_VERSION,
      observedAtUtc: '2026-11-22T00:01:01.000Z',
      sources: [
        { registryPath: RUNTIME_HKLM, version: RUNTIME_VERSION },
        { registryPath: RUNTIME_HKCU, version: RUNTIME_VERSION },
      ],
    },
  });
  assertGateFailure(
    () =>
      createBinding({
        context: f.context,
        sourceHashes: f.sourceHashes,
        stageBytes: bytes(stage),
        checkOnlyReceiptBytes: f.checkOnlyReceiptBytes,
        now: NOW,
      }),
    /postdates/,
  );
});

test('preserves seven fractional UTC digits and rejects noncanonical or impossible Edge catalog dates', () => {
  const drivers = driverProvenance();
  drivers.edgeDriver.catalogGeneratedAtUtc = '2026-11-21T23:00:00.1234567Z';
  drivers.edgeDriver.selectedLastModified = '2024-02-29T22:00:00.7654321Z';
  const f = makeBinding(fixture(contextFor(), { stageOverrides: { drivers } }));
  assert.equal(
    f.created.binding.stage.drivers.edgeDriver.catalogGeneratedAtUtc,
    '2026-11-21T23:00:00.1234567Z',
  );
  assert.equal(
    f.created.binding.stage.drivers.edgeDriver.selectedLastModified,
    '2024-02-29T22:00:00.7654321Z',
  );

  for (const [field, value] of [
    ['catalogGeneratedAtUtc', '2026-11-21T23:00:00.000Z'],
    ['catalogGeneratedAtUtc', '2026-11-21T23:00:00.123456Z'],
    ['catalogGeneratedAtUtc', '2026-11-21T23:00:00.12345678Z'],
    ['catalogGeneratedAtUtc', '2026-11-21T23:00:00.1234567+00:00'],
    ['catalogGeneratedAtUtc', '2025-02-29T23:00:00.1234567Z'],
    ['selectedLastModified', '2026-11-21T22:00:00.000Z'],
    ['selectedLastModified', '2026-11-21T22:00:00.123456Z'],
    ['selectedLastModified', '2026-11-21T22:00:00.12345678Z'],
    ['selectedLastModified', '2026-11-21T22:00:00.1234567+00:00'],
    ['selectedLastModified', '2026-11-21T24:00:00.1234567Z'],
  ]) {
    const alteredDrivers = driverProvenance();
    alteredDrivers.edgeDriver[field] = value;
    assertGateFailure(
      () => makeBinding(fixture(contextFor(), { stageOverrides: { drivers: alteredDrivers } })),
      /canonical UTC timestamp with seven fractional digits/,
    );
  }
});

test('keeps selected Tauri and Edge driver provenance separate and rejects drift', () => {
  const f = makeBinding();
  const mutations = [
    (stage) => {
      stage.drivers.tauriDriver.source = 'local-build';
    },
    (stage) => {
      stage.drivers.tauriDriver.executableSha256 = 'f'.repeat(64);
    },
    (stage) => {
      stage.drivers.edgeDriver.sourceCatalogUrl = 'https://example.com/catalog.json';
    },
    (stage) => {
      stage.drivers.edgeDriver.archiveSha256 = 'f'.repeat(64);
    },
    (stage) => {
      stage.drivers.edgeDriver.version = '155.0.4314.84';
    },
    (stage) => {
      stage.drivers.edgeDriver.serviceStarted = true;
    },
  ];
  for (const mutate of mutations) {
    const alteredStage = stageRecord(f.context);
    mutate(alteredStage);
    const alteredStageBytes = bytes(alteredStage);
    const alteredReceipt = deepCopy(f.receipt);
    alteredReceipt.stageSha256 = sha256(alteredStageBytes);
    assertGateFailure(() => {
      validateBinding(f.created.binding, {
        context: f.context,
        sourceHashes: f.sourceHashes,
        stageBytes: alteredStageBytes,
        checkOnlyReceiptBytes: bytes(alteredReceipt),
        now: f.now,
      });
    });
  }
});

test('rejects wrong runner architecture, WebView2 observation, profile paths, and launch flags', () => {
  const f = makeBinding();
  const badStages = [
    (stage) => {
      stage.runner.arch = 'ARM64';
    },
    (stage) => {
      stage.webView2Runtime.sources[1].version = '155.0.4314.58';
    },
    (stage) => {
      stage.webView2Runtime.sources[0].registryPath = 'HKCU\\Software\\Other';
    },
    (stage) => {
      stage.noLaunch.appLaunched = true;
    },
  ];
  for (const mutate of badStages) {
    const alteredStage = stageRecord(f.context);
    mutate(alteredStage);
    const alteredStageBytes = bytes(alteredStage);
    const alteredReceipt = deepCopy(f.receipt);
    alteredReceipt.stageSha256 = sha256(alteredStageBytes);
    assertGateFailure(() => {
      validateBinding(f.created.binding, {
        context: f.context,
        sourceHashes: f.sourceHashes,
        stageBytes: alteredStageBytes,
        checkOnlyReceiptBytes: bytes(alteredReceipt),
        now: f.now,
      });
    });
  }

  const badProfile = deepCopy(f.receipt);
  badProfile.profiles.morrowUserData = 'C:\\Users\\runneradmin\\AppData\\Local\\Morrow';
  assertGateFailure(() => {
    validateBinding(f.created.binding, {
      context: f.context,
      sourceHashes: f.sourceHashes,
      stageBytes: f.stageBytes,
      checkOnlyReceiptBytes: bytes(badProfile),
      now: f.now,
    });
  });

  const badKnownFolder = deepCopy(f.receipt);
  badKnownFolder.knownFolders.roamingAppData = badKnownFolder.knownFolders.localAppData;
  assertGateFailure(() => {
    validateBinding(f.created.binding, {
      context: f.context,
      sourceHashes: f.sourceHashes,
      stageBytes: f.stageBytes,
      checkOnlyReceiptBytes: bytes(badKnownFolder),
      now: f.now,
    });
  });
});

test('enforces the exact two-hour deadline and rejects expired or future-start bindings', () => {
  const f = makeBinding();
  const expiry = Date.parse(f.created.binding.expiresAtUtc);
  assert.doesNotThrow(() =>
    validateBinding(f.created.binding, {
      context: f.context,
      sourceHashes: f.sourceHashes,
      stageBytes: f.stageBytes,
      checkOnlyReceiptBytes: f.checkOnlyReceiptBytes,
      now: expiry - 1,
    }),
  );
  assertGateFailure(
    () =>
      validateBinding(f.created.binding, {
        context: f.context,
        sourceHashes: f.sourceHashes,
        stageBytes: f.stageBytes,
        checkOnlyReceiptBytes: f.checkOnlyReceiptBytes,
        now: expiry,
      }),
    /expired/,
  );

  const malformedNonce = deepCopy(f.created.binding);
  malformedNonce.nonce = 'not-a-128-bit-nonce';
  assertGateFailure(
    () =>
      validateBinding(malformedNonce, {
        context: f.context,
        sourceHashes: f.sourceHashes,
        stageBytes: f.stageBytes,
        checkOnlyReceiptBytes: f.checkOnlyReceiptBytes,
        now: f.now,
      }),
    /nonce/,
  );

  const extended = deepCopy(f.created.binding);
  extended.expiresAtUtc = new Date(expiry + 1).toISOString();
  assertGateFailure(
    () =>
      validateBinding(extended, {
        context: f.context,
        sourceHashes: f.sourceHashes,
        stageBytes: f.stageBytes,
        checkOnlyReceiptBytes: f.checkOnlyReceiptBytes,
        now: f.now,
      }),
    /two hours/,
  );

  const futureStart = deepCopy(f.created.binding);
  futureStart.createdAtUtc = new Date(f.now + 6 * 60 * 1000).toISOString();
  futureStart.expiresAtUtc = new Date(f.now + 6 * 60 * 1000 + 7200000).toISOString();
  assertGateFailure(
    () =>
      validateBinding(futureStart, {
        context: f.context,
        sourceHashes: f.sourceHashes,
        stageBytes: f.stageBytes,
        checkOnlyReceiptBytes: f.checkOnlyReceiptBytes,
        now: f.now,
      }),
    /clock/,
  );
});

test('checks GitHub artifact identity, digest, size, and run source metadata', () => {
  const expected = expectedActionsArtifact();
  const metadata = actionsArtifactMetadata();
  assert.equal(validateActionsArtifactMetadata(metadata, expected), true);
  for (const mutate of [
    (artifact) => {
      artifact.id = 123;
    },
    (artifact) => {
      artifact.digest = 'sha256:' + 'f'.repeat(64);
    },
    (artifact) => {
      artifact.size_in_bytes += 1;
    },
    (artifact) => {
      artifact.expired = true;
    },
    (artifact) => {
      artifact.workflow_run.head_sha = 'a'.repeat(40);
    },
    (artifact) => {
      artifact.workflow_run.head_branch = 'codex/e003-g07-windows-runtime';
    },
  ]) {
    const altered = deepCopy(metadata);
    mutate(altered);
    assertGateFailure(() => validateActionsArtifactMetadata(altered, expected));
  }

  const workflowExpected = {
    repository: 'hodeliun/Morrow',
    gateRunId: '555555555',
    gateRunAttempt: '1',
    sourceSha: 'a'.repeat(40),
    branch: 'codex/e003-g07-windows-runtime',
    event: 'push',
    workflowPath: WINDOWS_FIRST_LAUNCH_GATE.workflowPath,
  };
  const runMetadata = {
    id: Number(workflowExpected.gateRunId),
    run_attempt: 1,
    head_sha: workflowExpected.sourceSha,
    head_branch: workflowExpected.branch,
    event: workflowExpected.event,
    path: workflowExpected.workflowPath,
    repository: { full_name: workflowExpected.repository },
  };
  assert.equal(validateActionsWorkflowRunMetadata(runMetadata, workflowExpected), true);
  assertGateFailure(() =>
    validateActionsWorkflowRunMetadata({ ...runMetadata, run_attempt: 2 }, workflowExpected),
  );
  assertGateFailure(
    () =>
      validateActionsWorkflowRunMetadata(runMetadata, {
        ...workflowExpected,
        branch: 'main',
      }),
    /branch/,
  );
});

test('rejects payload-byte drift before parsing the binding', () => {
  const f = makeBinding();
  const altered = Buffer.concat([f.created.payloadBytes, Buffer.from(' ', 'utf8')]);
  assertGateFailure(() => parseTrustedBindingPayload(altered, f.created.payloadSha256));
});

test('derives the local claim path under RUNNER_TEMP and permits exactly one claimant', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'morrow-first-launch-runner-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const testFilesystemBacking = await createTestFilesystemBacking(temporaryRoot);
  const context = contextFor();
  const f = fixture(context);
  const created = createBinding({
    context,
    sourceHashes: f.sourceHashes,
    stageBytes: f.stageBytes,
    checkOnlyReceiptBytes: f.checkOnlyReceiptBytes,
    now: NOW,
  });
  const claimPath = firstLaunchClaimPath(context);
  const relativeClaimPath = path.win32.relative(context.runner.tempRoot, claimPath);
  assert.ok(!path.win32.isAbsolute(relativeClaimPath));
  assert.ok(relativeClaimPath !== '..' && !relativeClaimPath.startsWith('..\\'));
  const backingClaimPath = path.join(temporaryRoot, ...relativeClaimPath.split('\\'));
  await mkdir(path.dirname(backingClaimPath));

  const missingTrustedHash = {
    context,
    binding: created.binding,
    bindingPayloadBytes: created.payloadBytes,
    sourceHashes: f.sourceHashes,
    stageBytes: f.stageBytes,
    checkOnlyReceiptBytes: f.checkOnlyReceiptBytes,
    testFilesystemBacking,
    now: NOW,
  };
  await assert.rejects(claimFirstLaunchOnce(missingTrustedHash), {
    name: 'FirstLaunchGateError',
    code: 'ERR_FIRST_LAUNCH_GATE',
  });

  const alteredBinding = deepCopy(created.binding);
  alteredBinding.nonce = 'f'.repeat(32);
  await assert.rejects(
    claimFirstLaunchOnce({
      context,
      binding: alteredBinding,
      bindingPayloadBytes: serializeBinding(alteredBinding),
      bindingPayloadSha256: created.payloadSha256,
      sourceHashes: f.sourceHashes,
      stageBytes: f.stageBytes,
      checkOnlyReceiptBytes: f.checkOnlyReceiptBytes,
      testFilesystemBacking,
      now: NOW,
    }),
    { name: 'FirstLaunchGateError', code: 'ERR_FIRST_LAUNCH_GATE' },
  );

  const claimArgs = {
    context,
    binding: created.binding,
    bindingPayloadBytes: created.payloadBytes,
    bindingPayloadSha256: created.payloadSha256,
    sourceHashes: f.sourceHashes,
    stageBytes: f.stageBytes,
    checkOnlyReceiptBytes: f.checkOnlyReceiptBytes,
    testFilesystemBacking,
    now: NOW,
  };
  const results = await Promise.allSettled([
    claimFirstLaunchOnce(claimArgs),
    claimFirstLaunchOnce(claimArgs),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  const successful = results.find((result) => result.status === 'fulfilled').value;
  const rejected = results.find((result) => result.status === 'rejected').reason;
  assert.equal(successful.path, claimPath);
  assert.equal(successful.receipt.authority, 'local-claim-only');
  assert.equal(successful.receipt.environmentApprovalVerified, false);
  assert.equal(successful.receipt.bindingPayloadSha256, created.payloadSha256);
  assert.equal(rejected.code, 'EEXIST');
});

test('rejects reparse paths in the local claim directory', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'morrow-first-launch-reparse-'));
  const external = await mkdtemp(path.join(os.tmpdir(), 'morrow-first-launch-external-'));
  t.after(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  });
  const testFilesystemBacking = await createTestFilesystemBacking(temporaryRoot);
  const context = contextFor();
  const f = fixture(context);
  const created = createBinding({
    context,
    sourceHashes: f.sourceHashes,
    stageBytes: f.stageBytes,
    checkOnlyReceiptBytes: f.checkOnlyReceiptBytes,
    now: NOW,
  });
  const claimPath = firstLaunchClaimPath(context);
  const relativeClaimPath = path.win32.relative(context.runner.tempRoot, claimPath);
  const backingClaimPath = path.join(temporaryRoot, ...relativeClaimPath.split('\\'));
  const backingControlDirectory = path.dirname(backingClaimPath);
  await symlink(external, backingControlDirectory, 'dir');
  await assert.rejects(
    claimFirstLaunchOnce({
      context,
      binding: created.binding,
      bindingPayloadBytes: created.payloadBytes,
      bindingPayloadSha256: created.payloadSha256,
      sourceHashes: f.sourceHashes,
      stageBytes: f.stageBytes,
      checkOnlyReceiptBytes: f.checkOnlyReceiptBytes,
      testFilesystemBacking,
      now: NOW,
    }),
    {
      name: 'FirstLaunchGateError',
      code: 'ERR_FIRST_LAUNCH_GATE',
    },
  );
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
