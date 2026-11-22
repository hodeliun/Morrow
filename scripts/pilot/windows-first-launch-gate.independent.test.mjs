import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';

const gateModulePath = process.env.MORROW_FIRST_LAUNCH_GATE_PATH
  ? path.resolve(process.env.MORROW_FIRST_LAUNCH_GATE_PATH)
  : fileURLToPath(new URL('./windows-first-launch-gate.mjs', import.meta.url));
const gate = await import(pathToFileURL(gateModulePath).href);
const GATE = gate.WINDOWS_FIRST_LAUNCH_GATE;
const FIRST_LAUNCH_CANDIDATE = gate.FIRST_LAUNCH_CANDIDATE;

const REPOSITORY = 'hodeliun/Morrow';
const GATE_BRANCH = 'codex/e003-g07-windows-runtime';
const GATE_REF = `refs/heads/${GATE_BRANCH}`;
const WORKFLOW_PATH = '.github/workflows/pilot-windows-first-launch-preflight.yml';
const WORKFLOW_REF = `${REPOSITORY}/${WORKFLOW_PATH}@${GATE_REF}`;
const SOURCE_PATHS = [
  WORKFLOW_PATH,
  'scripts/pilot/windows-first-launch-gate.mjs',
  'scripts/pilot/windows-run-gate.mjs',
  'scripts/pilot/windows-first-launch-gate.test.mjs',
  'scripts/pilot/windows-first-launch-gate.independent.test.mjs',
  'scripts/pilot/windows-first-launch-preflight.ps1',
  'scripts/pilot/windows-first-launch-preflight.test.ps1',
  'scripts/pilot/windows-first-launch-preflight.independent.test.ps1',
  'scripts/pilot/windows-preflight.ps1',
];

const PURPOSE = 'first-windows-launch';
const EXECUTION_PHASE = 'protected-check-only';
const GATE_RUN_ID = '44970000001';
const GATE_RUN_ATTEMPT = '1';
const GATE_SOURCE_SHA = 'c'.repeat(40);
const CANDIDATE_REPOSITORY = 'hodeliun/Morrow';
const CANDIDATE_BRANCH = 'pilot/e003-polaris-dados-2.0';
const CANDIDATE_SOURCE_SHA = 'bdf54cd4eb6f20e63664c00cf46209a5c941065e';
const CANDIDATE_SOURCE_TREE = '4778832b283814759fafc8945eacffe3fa1e1baf';
const CANDIDATE_BUILD_RUN_ID = '44961916968';
const CANDIDATE_BUILD_RUN_ATTEMPT = '1';
const CANDIDATE_ARTIFACT_ID = '14730062702';
const CANDIDATE_ARTIFACT_NAME =
  'morrow-polaris-dados-windows-build-44961916968-1-bdf54cd4eb6f20e63664c00cf46209a5c941065e';
const CANDIDATE_OUTER_SHA = '008b17dd30a28fcad18070f9415aa43b4ca0e1c91f5acf7e8bfe38f817af4c65';
const CANDIDATE_ARTIFACT_DIGEST = `sha256:${CANDIDATE_OUTER_SHA}`;
const CANDIDATE_ARTIFACT_SIZE = 31_988_714;
const CANDIDATE_ARTIFACT_EXPIRES = '2026-11-28T23:34:10.000Z';
const CANDIDATE_INNER_NAME =
  'morrow-polaris-dados-windows-44961916968-1-bdf54cd4eb6f20e63664c00cf46209a5c941065e.zip';
const CANDIDATE_INNER_SHA = '678270f73fa90bb1f58af11b0a5de74245c002887270a809fc2c85ff1002373e';
const CANDIDATE_EXE_SHA = '85015c92631dbfcef49856c6729accd1c4d2567c097ef87c5ebad38745f99879';
const CANDIDATE_BUILD_INFO_SHA = '480080192f50de4b5388adc4c1f76cb1c99fb4a50ae0725c4e32aa529c112efa';
const CANDIDATE_SUMS_SHA = '343bd75415c4b51c265f4d547099aa4a8fdf7ec917b81344250bde55ce204adb';
const CANDIDATE_LAUNCHER_SHA = '321b9e8cc723e292225ef3819110776363843bf6c85761a5e22ae9871bc2ef79';
const CANDIDATE_LAUNCHER_CMD_SHA = 'b22e8236a258f9aceccd4476c2d4e3490a9fcc63a699476d6af691a5bc6e4798';
const CANDIDATE_MCP_SHA = '555b5b5aeb441f1fc10958aeea3bb49c694810d369de60833d1a3d46cb498ade';
const CANDIDATE_OVERLAY_PATH = 'src-tauri/tauri.pilot.conf.json';
const CANDIDATE_OVERLAY_SHA = 'c2e8898d991f38da8418a0cdac156f163c0e8b968a3f03c601bac67d2bbbcf9f';
const CANDIDATE_DEMO_VAULT_PATH = 'DemoVault';
const CANDIDATE_DEMO_VAULT_SHA = '7090716fb431d19f6ee0b2db463280352a34ffffbe23fded9f807d8cfaa65a1a';
const CANDIDATE_EXE_SIZE = 51_768_832;
const CANDIDATE_BUILD_INFO_SIZE = 7_175;
const CANDIDATE_SUMS_SIZE = 1_919;
const CANDIDATE_INNER_SIZE = 32_037_277;
const CANDIDATE_INNER_ENTRY_COUNT = 21;
const CANDIDATE_INNER_TOTAL_BYTES = 53_867_047;
const CANDIDATE_FILE_COUNT = 19;
const CANDIDATE_APP_VERSION = '2.2.0';
const CANDIDATE_PILOT_ID = 'app.morrow.polaris-dados-pilot';
const CANDIDATE_SOURCE_AUDIT_SHA = '77f85cf358e799fef123ab4218e29acf30320711f8edaa12251885880002dcc8';
const CANDIDATE_CANONICAL_INVENTORY_SHA = 'd8d4e6cb1a419cc342f9f63f43c5931cc1d3feb6041a4a1f7d104167104b9baf';
const FIXED_NOW = Date.parse('2026-11-22T12:00:00.000Z');
const RUNNER_TEMP = 'C:\\a\\_temp\\morrow-issue-251-44970000001-1';
const WORKSPACE = 'C:\\a\\Morrow\\Morrow';

let sourceWorkspace;
let sourceHashes;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectGateError(action) {
  assert.throws(action, (error) => {
    assert.equal(error?.name, 'FirstLaunchGateError');
    assert.equal(error?.code, 'ERR_FIRST_LAUNCH_GATE');
    return true;
  });
}

function makeEnvironment(overrides = {}) {
  return {
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_REF: GATE_REF,
    GITHUB_WORKFLOW_REF: WORKFLOW_REF,
    GITHUB_SHA: GATE_SOURCE_SHA,
    GITHUB_RUN_ID: GATE_RUN_ID,
    GITHUB_RUN_ATTEMPT: GATE_RUN_ATTEMPT,
    GITHUB_EVENT_NAME: 'push',
    GITHUB_WORKSPACE: WORKSPACE,
    RUNNER_TEMP,
    RUNNER_OS: 'Windows',
    RUNNER_ARCH: 'X64',
    ...overrides,
  };
}

function makeGateIdentity(environment = makeEnvironment()) {
  return {
    repository: environment.GITHUB_REPOSITORY,
    ref: environment.GITHUB_REF,
    workflowPath: WORKFLOW_PATH,
    workflowRef: environment.GITHUB_WORKFLOW_REF,
    sourceSha: environment.GITHUB_SHA,
    gateRunId: environment.GITHUB_RUN_ID,
    gateRunAttempt: environment.GITHUB_RUN_ATTEMPT,
    event: environment.GITHUB_EVENT_NAME,
  };
}

const EXPECTED_CANDIDATE = {
  repository: CANDIDATE_REPOSITORY,
  branch: CANDIDATE_BRANCH,
  sourceSha: CANDIDATE_SOURCE_SHA,
  sourceTree: CANDIDATE_SOURCE_TREE,
  candidateBuildRunId: CANDIDATE_BUILD_RUN_ID,
  candidateBuildRunAttempt: CANDIDATE_BUILD_RUN_ATTEMPT,
  artifact: {
    id: CANDIDATE_ARTIFACT_ID,
    name: CANDIDATE_ARTIFACT_NAME,
    digest: CANDIDATE_ARTIFACT_DIGEST,
    sizeBytes: CANDIDATE_ARTIFACT_SIZE,
    expiresAtUtc: CANDIDATE_ARTIFACT_EXPIRES,
  },
  package: {
    outerSha256: CANDIDATE_OUTER_SHA,
    innerName: CANDIDATE_INNER_NAME,
    innerSizeBytes: CANDIDATE_INNER_SIZE,
    innerSha256: CANDIDATE_INNER_SHA,
    innerEntryCount: CANDIDATE_INNER_ENTRY_COUNT,
    innerTotalBytes: CANDIDATE_INNER_TOTAL_BYTES,
    fileInventoryCount: CANDIDATE_FILE_COUNT,
    buildInfoSizeBytes: CANDIDATE_BUILD_INFO_SIZE,
    buildInfoSha256: CANDIDATE_BUILD_INFO_SHA,
    sha256SumsSizeBytes: CANDIDATE_SUMS_SIZE,
    sha256SumsSha256: CANDIDATE_SUMS_SHA,
    launcherSha256: CANDIDATE_LAUNCHER_SHA,
    launcherCmdSha256: CANDIDATE_LAUNCHER_CMD_SHA,
    mcpResourceSha256: CANDIDATE_MCP_SHA,
    mcpResourceSource: '../dist-mcp/index.js',
    mcpResourceTarget: 'mcp/index.js',
    overlayPath: CANDIDATE_OVERLAY_PATH,
    overlaySha256: CANDIDATE_OVERLAY_SHA,
    demoVaultPath: CANDIDATE_DEMO_VAULT_PATH,
    demoVaultSha256: CANDIDATE_DEMO_VAULT_SHA,
    sourceAuditSha256: CANDIDATE_SOURCE_AUDIT_SHA,
    canonicalInventorySha256: CANDIDATE_CANONICAL_INVENTORY_SHA,
  },
  application: {
    version: CANDIDATE_APP_VERSION,
    executableSizeBytes: CANDIDATE_EXE_SIZE,
    executableSha256: CANDIDATE_EXE_SHA,
    pilotIdentifier: CANDIDATE_PILOT_ID,
    appGUIWindowsTested: false,
  },
};

const PINNED_PACKAGE_INVENTORY = [
  { path: 'DemoVault/.morrow/plugins.json', sizeBytes: 43, sha256: 'fccc40d7f515aafe89f665615e6872fea972c873a17fc861d1f9b2d2c3fc06b6' },
  { path: 'DemoVault/.morrow/plugins/polaris-dados/LICENSE', sizeBytes: 11_558, sha256: '1eb85fc97224598dad1852b5d6483bbcf0aa8608790dcc657a5a2a761ae9c8c6' },
  { path: 'DemoVault/.morrow/plugins/polaris-dados/main.js', sizeBytes: 111_948, sha256: '27c108b72897466aeb47e978c4633911d8e64c6d703f03e97d6b20c7a27cfee3' },
  { path: 'DemoVault/.morrow/plugins/polaris-dados/manifest.json', sizeBytes: 178, sha256: '6708670c4529d683a8269252115f069500d465fa4369d0c4f43447c4f945e145' },
  { path: 'DemoVault/.morrow/plugins/polaris-dados/README.md', sizeBytes: 5_957, sha256: '4f80935c9f7b2993c002e2249a3577ae9127d858f07c0c409aa7fdb0e75c6abb' },
  { path: 'DemoVault/.morrow/workspace.json', sizeBytes: 913, sha256: '48523143d05636f52585aec2a8cb528fdb8ed18319efdc9d81615eb2166f66ab' },
  { path: 'DemoVault/Checklist Views.md', sizeBytes: 555, sha256: '6e7410847b51bbcddf2bddcfc8160ed730262b0f3f9a3fa40b157151e2560de6' },
  { path: 'DemoVault/Checklist.md', sizeBytes: 405, sha256: 'c12c55141e6a4a5997e36254c8c3195b56da291d9b71096f6e800e6d76279848' },
  { path: 'DemoVault/Checklist/Missing.md', sizeBytes: 60, sha256: 'ba3855e412d01c0edb3d7fecb99c120c129ff88d4995bdf6f8037a0c683dd810' },
  { path: 'DemoVault/Checklist/Null.md', sizeBytes: 68, sha256: '58b1a30cf4072c8fe9fbf3930545e38a017174cd5b34ea8c584ee9f2362c1935' },
  { path: 'DemoVault/Checklist/Unchecked.md', sizeBytes: 60, sha256: '6936d098a993c248b91a37babf47bebbfe4c956bd556f1256e04f964972a4146' },
  { path: 'DemoVault/Inventory.md', sizeBytes: 569, sha256: '46911f087baee1a0eac73b2e62ba0904c2c55f641119bfb416b92bad729d1383' },
  { path: 'DemoVault/Inventory/Widget.md', sizeBytes: 105, sha256: '306a70f5cde5e6dc4956a016812f54f216f716f0ff196d038f55c5c6e01be700' },
  { path: 'DemoVault/Views.md', sizeBytes: 828, sha256: 'dc99d9eb869c51f4b17bc03044b587af249323c737f85f83cd8229ad0e17f2b0' },
  { path: 'mcp/index.js', sizeBytes: 1_928_614, sha256: CANDIDATE_MCP_SHA },
  { path: 'morrow.exe', sizeBytes: CANDIDATE_EXE_SIZE, sha256: CANDIDATE_EXE_SHA },
  { path: 'TESTAR-NO-WINDOWS.md', sizeBytes: 6_298, sha256: '4df976b8340fd3cefaa00472302bc5599020021c31c593a3b28ad2fcf386908b' },
  { path: 'windows-launch.cmd', sizeBytes: 329, sha256: CANDIDATE_LAUNCHER_CMD_SHA },
  { path: 'windows-launch.ps1', sizeBytes: 20_633, sha256: CANDIDATE_LAUNCHER_SHA },
];

function makeCandidateBuild() {
  return clone(EXPECTED_CANDIDATE);
}

function makePackageInventory() {
  return clone(PINNED_PACKAGE_INVENTORY);
}

function makeDrivers() {
  // Synthetic, internally consistent values: issue 248 pins the application artifact,
  // while each Stage binds its selected driver provenance into this run's evidence.
  const tauriVersion = '9.8.7';
  const edgeVersion = '123.45.67.89';
  const runtimeVersion = '123.45.67.12';
  const webView2Prefix = '123.45.67';
  return {
    tauriDriver: {
      version: tauriVersion,
      source: 'crates.io',
      sourceUrl: `https://crates.io/crates/tauri-driver/${tauriVersion}`,
      downloadUrl: `https://crates.io/api/v1/crates/tauri-driver/${tauriVersion}/download`,
      cargoVersion: 'cargo 1.92.0',
      installCommand: `cargo install tauri-driver --version ${tauriVersion} --locked --root <tool-stage>`,
      executableSha256: sha256('independent-fixture:tauri-driver-executable'),
      serviceStarted: false,
    },
    edgeDriver: {
      version: edgeVersion,
      runtimeVersion,
      compatibleFirstThreeComponents: webView2Prefix,
      sourcePageUrl: 'https://developer.microsoft.com/en-us/microsoft-edge/tools/webdriver',
      sourceCatalogUrl: 'https://msedgedriver.microsoft.com/listing.json',
      downloadUrl: `https://msedgedriver.microsoft.com/${edgeVersion}/edgedriver_win64.zip`,
      responseUrl: `https://msedgedriver.microsoft.com/${edgeVersion}/edgedriver_win64.zip`,
      catalogGeneratedAtUtc: '2026-11-22T11:58:00.1234567Z',
      catalogSizeBytes: 1_048_576,
      catalogItemCount: 4_096,
      catalogSha256: sha256('independent-fixture:edge-catalog'),
      selectedLastModified: '2026-11-22T11:57:00.7654321Z',
      expectedArchiveBytes: 123_456,
      archiveSizeBytes: 123_456,
      archiveSha256: sha256('independent-fixture:edge-archive'),
      executableSha256: sha256('independent-fixture:msedgedriver-executable'),
      versionProbeExitCode: 0,
      serviceStarted: false,
    },
  };
}

function profilePaths(tempRoot, sourceSha = GATE_SOURCE_SHA, gateRunId = GATE_RUN_ID) {
  const root = path.win32.join(
    tempRoot,
    `morrow-issue-187-${sourceSha}-${gateRunId}-1`,
    'profile',
  );
  return {
    root,
    morrowUserData: path.win32.join(root, 'MorrowUserData'),
    webView2UserData: path.win32.join(root, 'WebView2UserData'),
  };
}

function makeStage(environment = makeEnvironment(), mutate = (value) => value) {
  const tempRoot = environment.RUNNER_TEMP;
  const gateIdentity = makeGateIdentity(environment);
  const candidateBuild = makeCandidateBuild();
  const drivers = makeDrivers();
  const runtimeVersion = drivers.edgeDriver.runtimeVersion;
  const stage = {
    schema: 'morrow.e003.g15.first-launch-stage.v1',
    status: 'staged',
    purpose: PURPOSE,
    executionPhase: EXECUTION_PHASE,
    gate: gateIdentity,
    runner: { os: 'Windows', arch: 'X64', tempRoot },
    webView2Runtime: {
      version: runtimeVersion,
      observedAtUtc: '2026-11-22T11:55:00.000Z',
      sources: [
        {
          registryPath:
            'HKLM64\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
          version: runtimeVersion,
        },
        {
          registryPath:
            'HKCU64\\Software\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
          version: runtimeVersion,
        },
      ],
    },
    candidateBuild,
    packageInventory: makePackageInventory(),
    drivers,
    noLaunch: { appLaunched: false, driverServiceStarted: false, guiTested: false },
    stagedAtUtc: new Date(FIXED_NOW - 5_000).toISOString(),
  };
  return mutate(stage) ?? stage;
}

function makeCheckOnlyReceipt(stage, mutate = (value) => value, environment = makeEnvironment()) {
  const tempRoot = stage.runner?.tempRoot ?? environment.RUNNER_TEMP;
  const candidateBuild = clone(stage.candidateBuild ?? makeCandidateBuild());
  const gateIdentity = clone(stage.gate ?? makeGateIdentity(environment));
  const profiles = profilePaths(
    tempRoot,
    gateIdentity.sourceSha ?? GATE_SOURCE_SHA,
    gateIdentity.gateRunId ?? GATE_RUN_ID,
  );
  const receipt = {
    schema: 'morrow.e003.g15.first-launch-check-only-receipt.v1',
    status: 'passed',
    purpose: PURPOSE,
    executionPhase: EXECUTION_PHASE,
    gate: gateIdentity,
    candidateBuild,
    stageSha256: sha256(Buffer.from(JSON.stringify(stage))),
    pinsVerified: true,
    driverHashes: {
      tauriDriverSha256: stage.drivers.tauriDriver.executableSha256,
      edgeDriverSha256: stage.drivers.edgeDriver.executableSha256,
    },
    webView2RuntimeVersion: stage.webView2Runtime.version,
    identity: { sid: 'S-1-5-21-1000000000-2000000000-3000000000-1001' },
    knownFolders: {
      localAppData: 'C:\\Users\\runneradmin\\AppData\\Local',
      roamingAppData: 'C:\\Users\\runneradmin\\AppData\\Roaming',
    },
    profiles,
    noLaunch: { appLaunched: false, driverServiceStarted: false, guiTested: false },
    checkedAtUtc: new Date(FIXED_NOW).toISOString(),
  };
  return mutate(receipt) ?? receipt;
}

function serializeDto(dto) {
  return Buffer.from(JSON.stringify(dto), 'utf8');
}

function makeBytes(stageMutator, receiptMutator, environment = makeEnvironment()) {
  const stage = makeStage(environment, stageMutator);
  const receipt = makeCheckOnlyReceipt(stage, receiptMutator, environment);
  return { stage, receipt, stageBytes: serializeDto(stage), checkOnlyReceiptBytes: serializeDto(receipt) };
}

function createBindingFixture({
  environment = makeEnvironment(),
  sourceHashesOverride = sourceHashes,
  stageMutator,
  receiptMutator,
  now = FIXED_NOW,
} = {}) {
  const context = gate.safeFirstLaunchRunContext(environment);
  const evidence = makeBytes(stageMutator, receiptMutator, environment);
  const created = gate.createBinding({
    context,
    sourceHashes: sourceHashesOverride,
    stageBytes: evidence.stageBytes,
    checkOnlyReceiptBytes: evidence.checkOnlyReceiptBytes,
    now,
  });
  return {
    context,
    ...evidence,
    ...created,
    sourceHashes: sourceHashesOverride,
    environment,
    now,
  };
}

async function createSourceWorkspace() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'morrow-g15-251-independent-'));
  for (const sourcePath of SOURCE_PATHS) {
    const absolute = path.join(workspace, sourcePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, Buffer.from(`independent-source-fixture\n${sourcePath}\n`, 'utf8'));
  }
  return workspace;
}

before(async () => {
  assert.ok(GATE, 'the public gate configuration export is required');
  for (const name of [
    'safeFirstLaunchRunContext',
    'hashSourceFiles',
    'createBinding',
    'validateBinding',
    'serializeBinding',
    'firstLaunchClaimPath',
    'validateActionsArtifactMetadata',
    'validateActionsWorkflowRunMetadata',
    'parseTrustedBindingPayload',
    'claimFirstLaunchOnce',
  ]) {
    assert.equal(typeof gate[name], 'function', `public export ${name} is required`);
  }
  if (process.platform !== 'win32') {
    assert.equal(typeof gate.createTestFilesystemBacking, 'function');
  }
  assert.ok(FIRST_LAUNCH_CANDIDATE, 'the separately pinned candidate export is required');
  sourceWorkspace = await createSourceWorkspace();
  sourceHashes = await gate.hashSourceFiles(sourceWorkspace);
});

after(async () => {
  if (sourceWorkspace) await rm(sourceWorkspace, { recursive: true, force: true });
});

test('public configuration freezes the separate gate and candidate identities', () => {
  assert.equal(GATE.schema, 'morrow.e003.g15.first-launch-binding.v1');
  assert.equal(GATE.purpose, PURPOSE);
  assert.equal(GATE.executionPhase, EXECUTION_PHASE);
  assert.equal(GATE.repository, REPOSITORY);
  assert.equal(GATE.ref, GATE_REF);
  assert.equal(GATE.branch, GATE_BRANCH);
  assert.equal(GATE.workflowPath, WORKFLOW_PATH);
  assert.equal(GATE.workflowRef, WORKFLOW_REF);
  assert.equal(GATE.lifetimeMs, 7_200_000);
  assert.deepEqual(GATE.sourcePaths, SOURCE_PATHS);
  assert.equal(SOURCE_PATHS.at(-1), 'scripts/pilot/windows-preflight.ps1');
  assert.equal(SOURCE_PATHS.filter((sourcePath) => sourcePath === 'scripts/pilot/windows-preflight.ps1').length, 1);
  assert.equal(SOURCE_PATHS.filter((sourcePath) => sourcePath === 'scripts/pilot/windows-run-gate.mjs').length, 1);
  assert.equal(sha256(JSON.stringify(PINNED_PACKAGE_INVENTORY)), CANDIDATE_CANONICAL_INVENTORY_SHA);
  assert.deepEqual(FIRST_LAUNCH_CANDIDATE, EXPECTED_CANDIDATE);
  assert.notEqual(FIRST_LAUNCH_CANDIDATE.candidateBuildRunId, GATE_RUN_ID);
  assert.equal(FIRST_LAUNCH_CANDIDATE.candidateBuildRunId, CANDIDATE_BUILD_RUN_ID);
  assert.equal(FIRST_LAUNCH_CANDIDATE.artifact.id, CANDIDATE_ARTIFACT_ID);
});

test('PowerShell and Node serialize the pinned inventory to the same UTF-8 bytes and digest', async () => {
  const nodeBytes = Buffer.from(JSON.stringify(PINNED_PACKAGE_INVENTORY), 'utf8');
  assert.equal(sha256(nodeBytes), CANDIDATE_CANONICAL_INVENTORY_SHA);

  const scratch = await mkdtemp(path.join(os.tmpdir(), 'morrow-g15-251-serializer-'));
  const inventoryPath = path.join(scratch, 'inventory.json');
  const scriptPath = path.join(scratch, 'serialize-inventory.ps1');
  const powershellScript = String.raw`param([Parameter(Mandatory = $true)][string] $InventoryPath)
$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$source = [IO.File]::ReadAllText($InventoryPath, $utf8)
$items = @(ConvertFrom-Json -InputObject $source -AsHashtable)
$orderedInventory = @(
  foreach ($item in $items) {
    [ordered]@{
      path = [string]$item.path
      sizeBytes = [long]$item.sizeBytes
      sha256 = [string]$item.sha256
    }
  }
)
$json = ConvertTo-Json -InputObject $orderedInventory -Depth 3 -Compress
[Console]::OpenStandardOutput().Write($utf8.GetBytes($json))
`;
  try {
    await writeFile(inventoryPath, nodeBytes);
    await writeFile(scriptPath, powershellScript, 'utf8');
    const executable = process.env.MORROW_POWERSHELL_EXE || (process.platform === 'win32' ? 'pwsh.exe' : 'pwsh');
    const result = spawnSync(executable, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptPath, inventoryPath,
    ], { timeout: 15_000, maxBuffer: 1024 * 1024 });
    assert.equal(result.error, undefined, `PowerShell serializer could not start: ${result.error?.code ?? result.error?.message}`);
    assert.equal(result.status, 0, `PowerShell serializer failed: ${result.stderr?.toString('utf8') ?? ''}`);
    assert.deepEqual(result.stdout, nodeBytes, 'PowerShell must preserve the canonical entry/key order and exact UTF-8 JSON bytes');
    assert.equal(sha256(result.stdout), CANDIDATE_CANONICAL_INVENTORY_SHA);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('safe context accepts only the exact gate repository, branch, workflow and first attempt', () => {
  const context = gate.safeFirstLaunchRunContext(makeEnvironment());
  assert.equal(context.repository, REPOSITORY);
  assert.equal(context.ref, GATE_REF);
  assert.equal(context.workflowRef, WORKFLOW_REF);
  assert.equal(context.sourceSha, GATE_SOURCE_SHA);
  assert.equal(context.gateRunId, GATE_RUN_ID);
  assert.equal(context.gateRunAttempt, GATE_RUN_ATTEMPT);
  assert.equal(context.event, 'push');
  assert.deepEqual(context.runner, {
    os: 'Windows',
    arch: 'X64',
    tempRoot: RUNNER_TEMP,
    workspace: WORKSPACE,
  });

  for (const overrides of [
    { GITHUB_REPOSITORY: 'other/Morrow' },
    { GITHUB_REF: 'refs/heads/main' },
    { GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/pilot-windows-runtime.yml@${GATE_REF}` },
    { GITHUB_SHA: 'not-a-commit' },
    { GITHUB_RUN_ATTEMPT: '2' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch' },
    { RUNNER_OS: 'Linux' },
    { RUNNER_ARCH: 'ARM64' },
    { RUNNER_TEMP: WORKSPACE },
  ]) {
    expectGateError(() => gate.safeFirstLaunchRunContext(makeEnvironment(overrides)));
  }
});

test('source hashing covers the ordered gate source inventory and reacts to byte drift', async () => {
  assert.deepEqual(GATE.sourcePaths, SOURCE_PATHS);
  const beforeHashes = await gate.hashSourceFiles(sourceWorkspace);
  const driftWorkspace = await createSourceWorkspace();
  try {
    const target = path.join(driftWorkspace, 'scripts/pilot/windows-preflight.ps1');
    await writeFile(target, 'changed independent source bytes', 'utf8');
    const driftHashes = await gate.hashSourceFiles(driftWorkspace);
    assert.notDeepEqual(driftHashes, beforeHashes);
  } finally {
    await rm(driftWorkspace, { recursive: true, force: true });
  }

  const missingWorkspace = await createSourceWorkspace();
  try {
    await rm(path.join(missingWorkspace, 'scripts/pilot/windows-preflight.ps1'));
    await assert.rejects(gate.hashSourceFiles(missingWorkspace), (error) => {
      assert.equal(error?.name, 'FirstLaunchGateError');
      assert.equal(error?.code, 'ERR_FIRST_LAUNCH_GATE');
      return true;
    });
  } finally {
    await rm(missingWorkspace, { recursive: true, force: true });
  }

});

test('requires exact seven-digit UTC vendor timestamps and binds their source bytes without millisecond truncation', () => {
  const fixture = createBindingFixture();
  assert.equal(fixture.stage.drivers.edgeDriver.catalogGeneratedAtUtc, '2026-11-22T11:58:00.1234567Z');
  assert.equal(fixture.stage.drivers.edgeDriver.selectedLastModified, '2026-11-22T11:57:00.7654321Z');
  assert.equal(fixture.binding.stage.sha256, sha256(fixture.stageBytes));
  const parsedStage = JSON.parse(fixture.stageBytes.toString('utf8'));
  assert.equal(parsedStage.drivers.edgeDriver.catalogGeneratedAtUtc, '2026-11-22T11:58:00.1234567Z');
  assert.equal(parsedStage.drivers.edgeDriver.selectedLastModified, '2026-11-22T11:57:00.7654321Z');
  assert.match(fixture.binding.createdAtUtc, /^2026-11-22T12:00:00\.000Z$/);
  assert.match(fixture.binding.expiresAtUtc, /^2026-11-22T14:00:00\.000Z$/);

  const lastDigitMutant = createBindingFixture({
    stageMutator: (stage) => {
      stage.drivers.edgeDriver.catalogGeneratedAtUtc = '2026-11-22T11:58:00.1234568Z';
      return stage;
    },
  });
  assert.equal(lastDigitMutant.binding.stage.sha256, sha256(lastDigitMutant.stageBytes));
  assert.notEqual(lastDigitMutant.binding.stage.sha256, fixture.binding.stage.sha256);
  const selectedTimeLastDigitMutant = createBindingFixture({
    stageMutator: (stage) => {
      stage.drivers.edgeDriver.selectedLastModified = '2026-11-22T11:57:00.7654322Z';
      return stage;
    },
  });
  assert.equal(selectedTimeLastDigitMutant.binding.stage.sha256, sha256(selectedTimeLastDigitMutant.stageBytes));
  assert.notEqual(selectedTimeLastDigitMutant.binding.stage.sha256, fixture.binding.stage.sha256);

  const invalidTimestamps = [
    ['catalogGeneratedAtUtc', '2026-11-22T11:58:00.123456Z'],
    ['catalogGeneratedAtUtc', '2026-11-22T11:58:00.12345678Z'],
    ['catalogGeneratedAtUtc', '2026-11-22T11:58:00.1234567+00:00'],
    ['catalogGeneratedAtUtc', '2026-02-30T11:58:00.1234567Z'],
    ['selectedLastModified', '2026-11-22T11:57:00.765432Z'],
    ['selectedLastModified', '2026-11-22T11:57:00.76543210Z'],
    ['selectedLastModified', '2026-11-22T11:57:00.7654321-00:00'],
    ['selectedLastModified', '2026-11-22T11:57:00.7654321Z '],
  ];
  for (const [field, value] of invalidTimestamps) {
    const altered = makeBytes((stage) => {
      stage.drivers.edgeDriver[field] = value;
      return stage;
    });
    expectGateError(() => gate.createBinding({
      context: fixture.context,
      sourceHashes: fixture.sourceHashes,
      stageBytes: altered.stageBytes,
      checkOnlyReceiptBytes: altered.checkOnlyReceiptBytes,
      now: FIXED_NOW,
    }));
  }
});

test('creates and validates a binding with purpose, phase, nonce, exact hashes and separated run IDs', () => {
  const fixture = createBindingFixture();
  assert.equal(fixture.binding.schema, 'morrow.e003.g15.first-launch-binding.v1');
  assert.equal(fixture.binding.purpose, PURPOSE);
  assert.equal(fixture.binding.executionPhase, EXECUTION_PHASE);
  assert.equal(fixture.binding.gate.gateRunId, GATE_RUN_ID);
  assert.equal(fixture.binding.gate.gateRunAttempt, GATE_RUN_ATTEMPT);
  assert.equal(fixture.binding.candidateBuild.candidateBuildRunId, CANDIDATE_BUILD_RUN_ID);
  assert.equal(fixture.binding.candidateBuild.candidateBuildRunAttempt, CANDIDATE_BUILD_RUN_ATTEMPT);
  assert.notEqual(fixture.binding.gate.gateRunId, fixture.binding.candidateBuild.candidateBuildRunId);
  assert.equal(fixture.binding.candidateBuild.package.canonicalInventorySha256, CANDIDATE_CANONICAL_INVENTORY_SHA);
  assert.equal(fixture.binding.stage.packageInventoryCount, CANDIDATE_FILE_COUNT);
  assert.equal(fixture.binding.stage.packageInventorySha256, CANDIDATE_CANONICAL_INVENTORY_SHA);
  assert.deepEqual(fixture.binding.gate.sourceHashes.map((entry) => entry.path), SOURCE_PATHS);
  assert.ok(fixture.binding.gate.sourceHashes.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256) && entry.sizeBytes > 0));
  assert.match(fixture.binding.nonce, /^[0-9a-f]{32}$/);
  assert.equal(Date.parse(fixture.binding.expiresAtUtc) - Date.parse(fixture.binding.createdAtUtc), 7_200_000);

  const summary = gate.validateBinding(fixture.binding, {
    context: fixture.context,
    sourceHashes: fixture.sourceHashes,
    stageBytes: fixture.stageBytes,
    checkOnlyReceiptBytes: fixture.checkOnlyReceiptBytes,
    now: fixture.now,
  });
  assert.equal(summary.gateRunId, GATE_RUN_ID);
  assert.equal(summary.gateRunAttempt, GATE_RUN_ATTEMPT);
  assert.equal(summary.candidateBuildRunId, CANDIDATE_BUILD_RUN_ID);
  assert.equal(summary.candidateBuildRunAttempt, CANDIDATE_BUILD_RUN_ATTEMPT);
  assert.equal(summary.nonce, fixture.binding.nonce);
  assert.equal(summary.stageSha256, sha256(fixture.stageBytes));
  assert.equal(summary.checkOnlyReceiptSha256, sha256(fixture.checkOnlyReceiptBytes));
});

test('uses canonical JSON bytes and verifies them against the trusted upload payload hash', () => {
  const fixture = createBindingFixture();
  const bytes = gate.serializeBinding(fixture.binding);
  assert.ok(Buffer.isBuffer(bytes));
  assert.equal(bytes[0], 0x7b, 'serialized binding begins with JSON, without a UTF-8 BOM');
  assert.equal(bytes.at(-1), 0x0a, 'serialized binding has one terminal LF');
  assert.notEqual(bytes.at(-2), 0x0a, 'serialized binding does not append a blank line');
  assert.equal(bytes.toString('utf8'), `${JSON.stringify(fixture.binding, null, 2)}\n`);

  const parsed = gate.parseTrustedBindingPayload(bytes, sha256(bytes));
  assert.deepEqual(parsed, fixture.binding);
  const changed = Buffer.from(bytes);
  changed[changed.indexOf(Buffer.from(PURPOSE)[0])] ^= 0x01;
  expectGateError(() => gate.parseTrustedBindingPayload(changed, sha256(bytes)));
  expectGateError(() => gate.parseTrustedBindingPayload(bytes, '0'.repeat(64)));
  assert.deepEqual(fixture.payloadBytes, bytes);
  assert.equal(fixture.payloadSha256, sha256(bytes));
});

test('binding expires at the exact two-hour boundary without extending on validation', () => {
  const fixture = createBindingFixture();
  const expiresAt = Date.parse(fixture.binding.expiresAtUtc);
  assert.equal(expiresAt, FIXED_NOW + 7_200_000);
  const args = {
    context: fixture.context,
    sourceHashes: fixture.sourceHashes,
    stageBytes: fixture.stageBytes,
    checkOnlyReceiptBytes: fixture.checkOnlyReceiptBytes,
  };
  assert.doesNotThrow(() => gate.validateBinding(fixture.binding, { ...args, now: expiresAt - 1 }));
  expectGateError(() => gate.validateBinding(fixture.binding, { ...args, now: expiresAt }));
  expectGateError(() => gate.validateBinding(fixture.binding, { ...args, now: expiresAt + 1 }));
  assert.doesNotThrow(() => gate.validateBinding(fixture.binding, {
    ...args,
    now: new Date(expiresAt - 1),
  }));
  const dateCreated = createBindingFixture({ now: new Date(FIXED_NOW) });
  assert.equal(Date.parse(dateCreated.binding.createdAtUtc), FIXED_NOW);
  assert.equal(Date.parse(dateCreated.binding.expiresAtUtc), FIXED_NOW + 7_200_000);
});

test('generates fresh lowercase 128-bit nonces and rejects malformed nonce values', () => {
  const first = createBindingFixture();
  const second = createBindingFixture();
  assert.match(first.binding.nonce, /^[0-9a-f]{32}$/);
  assert.match(second.binding.nonce, /^[0-9a-f]{32}$/);
  assert.notEqual(first.binding.nonce, second.binding.nonce);

  for (const nonce of [
    '1234567890abcdef1234567890abcde',
    '1234567890abcdef1234567890abcdef0',
    '1234567890abcdef1234567890ABCDEf',
    '1234567890abcdef1234567890abcdeg',
    '',
  ]) {
    const binding = clone(first.binding);
    binding.nonce = nonce;
    expectGateError(() => gate.validateBinding(binding, {
      context: first.context,
      sourceHashes: first.sourceHashes,
      stageBytes: first.stageBytes,
      checkOnlyReceiptBytes: first.checkOnlyReceiptBytes,
      now: first.now,
    }));
  }
});

test('rejects a gate/candidate RunID collision and all candidate identity drift', () => {
  const fixture = createBindingFixture();
  const candidateMutations = [
    (candidate) => { candidate.repository = 'other/Morrow'; },
    (candidate) => { candidate.branch = GATE_BRANCH; },
    (candidate) => { candidate.sourceSha = 'd'.repeat(40); },
    (candidate) => { candidate.sourceTree = 'e'.repeat(40); },
    (candidate) => { candidate.candidateBuildRunId = GATE_RUN_ID; },
    (candidate) => { candidate.candidateBuildRunAttempt = '2'; },
    (candidate) => { candidate.artifact.id = '14730062703'; },
    (candidate) => { candidate.artifact.name += '-substituted'; },
    (candidate) => { candidate.artifact.digest = `sha256:${'1'.repeat(64)}`; },
    (candidate) => { candidate.artifact.sizeBytes += 1; },
    (candidate) => { candidate.artifact.expiresAtUtc = '2026-11-29T00:00:00Z'; },
    (candidate) => { candidate.package.outerSha256 = '1'.repeat(64); },
    (candidate) => { candidate.package.innerSha256 = '2'.repeat(64); },
    (candidate) => { candidate.package.innerEntryCount += 1; },
    (candidate) => { candidate.package.fileInventoryCount -= 1; },
    (candidate) => { candidate.package.buildInfoSha256 = '3'.repeat(64); },
    (candidate) => { candidate.package.sha256SumsSha256 = '4'.repeat(64); },
    (candidate) => { candidate.package.launcherSha256 = '5'.repeat(64); },
    (candidate) => { candidate.package.launcherCmdSha256 = '6'.repeat(64); },
    (candidate) => { candidate.package.mcpResourceSha256 = '7'.repeat(64); },
    (candidate) => { candidate.package.overlaySha256 = '8'.repeat(64); },
    (candidate) => { candidate.package.demoVaultSha256 = '9'.repeat(64); },
    (candidate) => { candidate.package.sourceAuditSha256 = 'a'.repeat(64); },
    (candidate) => { candidate.package.canonicalInventorySha256 = 'b'.repeat(64); },
    (candidate) => { candidate.application.executableSizeBytes += 1; },
    (candidate) => { candidate.application.executableSha256 = 'b'.repeat(64); },
    (candidate) => { candidate.application.pilotIdentifier = 'app.other'; },
    (candidate) => { candidate.application.version = '2.1.0'; },
    (candidate) => { candidate.application.appGUIWindowsTested = true; },
  ];
  for (const mutateCandidate of candidateMutations) {
    const stageMutator = (stage) => { mutateCandidate(stage.candidateBuild); return stage; };
    const receiptMutator = (receipt) => { mutateCandidate(receipt.candidateBuild); return receipt; };
    const altered = makeBytes(stageMutator, receiptMutator);
    expectGateError(() => gate.createBinding({
      context: fixture.context,
      sourceHashes: fixture.sourceHashes,
      stageBytes: altered.stageBytes,
      checkOnlyReceiptBytes: altered.checkOnlyReceiptBytes,
      now: FIXED_NOW,
    }));
  }
});

test('rejects purpose, phase, gate identity, attempt and Stage/CheckOnly disagreement', () => {
  const fixture = createBindingFixture();
  const pairs = [
    [(stage) => { stage.purpose = 'protected-check-only'; }, (receipt) => { receipt.purpose = 'protected-check-only'; }],
    [(stage) => { stage.executionPhase = 'first-windows-launch'; }, (receipt) => { receipt.executionPhase = 'first-windows-launch'; }],
    [(stage) => { stage.gate.repository = 'other/Morrow'; }, (receipt) => { receipt.gate.repository = 'other/Morrow'; }],
    [(stage) => { stage.gate.ref = 'refs/heads/main'; }, (receipt) => { receipt.gate.ref = 'refs/heads/main'; }],
    [(stage) => { stage.gate.workflowPath = '.github/workflows/pilot-windows-runtime.yml'; }, (receipt) => { receipt.gate.workflowPath = '.github/workflows/pilot-windows-runtime.yml'; }],
    [(stage) => { stage.gate.workflowRef += '.old'; }, (receipt) => { receipt.gate.workflowRef += '.old'; }],
    [(stage) => { stage.gate.sourceSha = 'b'.repeat(40); }, (receipt) => { receipt.gate.sourceSha = 'b'.repeat(40); }],
    [(stage) => { stage.gate.gateRunId = '44970000002'; }, (receipt) => { receipt.gate.gateRunId = '44970000002'; }],
    [(stage) => { stage.gate.gateRunAttempt = '2'; }, (receipt) => { receipt.gate.gateRunAttempt = '2'; }],
  ];
  for (const [stageMutator, receiptMutator] of pairs) {
    const altered = makeBytes(stageMutator, receiptMutator);
    expectGateError(() => gate.createBinding({
      context: fixture.context,
      sourceHashes: fixture.sourceHashes,
      stageBytes: altered.stageBytes,
      checkOnlyReceiptBytes: altered.checkOnlyReceiptBytes,
      now: FIXED_NOW,
    }));
  }

  const mismatch = makeBytes(undefined, (receipt) => {
    receipt.gate.gateRunId = '44970000002';
    return receipt;
  });
  expectGateError(() => gate.createBinding({
    context: fixture.context,
    sourceHashes: fixture.sourceHashes,
    stageBytes: mismatch.stageBytes,
    checkOnlyReceiptBytes: mismatch.checkOnlyReceiptBytes,
    now: FIXED_NOW,
  }));
});

test('rejects open, incomplete or invalid StageV1 and CheckOnlyReceiptV1 records', () => {
  const fixture = createBindingFixture();
  const mutations = [
    [() => makeBytes((stage) => { stage.unexpected = true; return stage; }), 'Stage root extra key'],
    [() => makeBytes((stage) => { delete stage.runner; return stage; }), 'Stage missing runner'],
    [() => makeBytes((stage) => { stage.runner.unexpected = true; return stage; }), 'Stage runner extra key'],
    [() => makeBytes((stage) => { stage.packageInventory[0].sizeBytes = -1; return stage; }), 'negative package size'],
    [() => makeBytes((stage) => { stage.packageInventory[0].sizeBytes += 1; return stage; }), 'forged pinned package size'],
    [() => makeBytes((stage) => { stage.packageInventory[0].sha256 = '0'.repeat(64); return stage; }), 'forged pinned package file hash'],
    [() => makeBytes((stage) => { stage.packageInventory[0].path = '../escape'; return stage; }), 'package path traversal'],
    [() => makeBytes((stage) => {
      stage.packageInventory[1].path = stage.packageInventory[0].path.toUpperCase();
      return stage;
    }), 'case-alias duplicate package path'],
    [() => makeBytes((stage) => {
      stage.packageInventory.reverse();
      return stage;
    }), 'unsorted package inventory'],
    [() => makeBytes((stage) => { stage.packageInventory.pop(); return stage; }), 'incomplete package inventory'],
    [() => makeBytes((stage) => { stage.noLaunch.appLaunched = true; return stage; }), 'application launch claim'],
    [() => makeBytes((stage) => { stage.drivers.tauriDriver.serviceStarted = true; return stage; }), 'Tauri service claim'],
    [() => makeBytes((stage) => { stage.drivers.edgeDriver.serviceStarted = true; return stage; }), 'EdgeDriver service claim'],
    [() => makeBytes((stage) => { stage.drivers.edgeDriver.versionProbeExitCode = 1; return stage; }), 'EdgeDriver version probe failure'],
    [() => makeBytes((stage) => { stage.drivers.tauriDriver.installCommand += ' --unlocked'; return stage; }), 'Tauri install provenance mismatch'],
    [() => makeBytes((stage) => { stage.drivers.edgeDriver.sourceCatalogUrl = 'https://example.invalid/catalog'; return stage; }), 'nonofficial Edge catalog'],
    [() => makeBytes((stage) => { stage.drivers.edgeDriver.runtimeVersion = '123.45.68.12'; return stage; }), 'Edge runtime version mismatch'],
    [() => makeBytes((stage) => { stage.webView2Runtime.sources[0].version = '123.45.67.13'; return stage; }), 'WebView2 source disagreement'],
    [() => makeBytes((stage) => {
      stage.webView2Runtime.observedAtUtc = new Date(Date.parse(stage.stagedAtUtc) + 1).toISOString();
      return stage;
    }), 'WebView2 observation after Stage time'],
    [() => makeBytes(undefined, (receipt) => { receipt.extra = true; return receipt; }), 'CheckOnly root extra key'],
    [() => makeBytes(undefined, (receipt) => { delete receipt.identity; return receipt; }), 'CheckOnly missing identity'],
    [() => makeBytes(undefined, (receipt) => { receipt.driverHashes.edgeDriverSha256 = 'f'.repeat(64); return receipt; }), 'CheckOnly driver hash mismatch'],
    [() => makeBytes(undefined, (receipt) => { receipt.pinsVerified = false; return receipt; }), 'CheckOnly pins not verified'],
    [() => makeBytes(undefined, (receipt) => { receipt.noLaunch.guiTested = true; return receipt; }), 'CheckOnly GUI claim'],
  ];
  const acceptedInvalidFixtures = [];
  for (const [makeAltered, label] of mutations) {
    const altered = makeAltered();
    try {
      gate.createBinding({
        context: fixture.context,
        sourceHashes: fixture.sourceHashes,
        stageBytes: altered.stageBytes,
        checkOnlyReceiptBytes: altered.checkOnlyReceiptBytes,
        now: FIXED_NOW,
      });
      acceptedInvalidFixtures.push(label);
    } catch (error) {
      assert.equal(error?.name, 'FirstLaunchGateError', label);
      assert.equal(error?.code, 'ERR_FIRST_LAUNCH_GATE', label);
    }
  }
  assert.deepEqual(acceptedInvalidFixtures, [], 'invalid closed-schema or inventory fixtures were accepted');
});

test('create validates preparer temp and profile paths; validate permits a different consumer temp', () => {
  const fixture = createBindingFixture();
  const wrongPrepTemp = makeEnvironment({ RUNNER_TEMP: 'C:\\a\\_temp\\other-runner' });
  const wrongStage = makeBytes((stage) => {
    stage.runner.tempRoot = wrongPrepTemp.RUNNER_TEMP;
    return stage;
  }, (receipt) => {
    receipt.profiles = profilePaths(wrongPrepTemp.RUNNER_TEMP);
    return receipt;
  }, makeEnvironment());
  expectGateError(() => gate.createBinding({
    context: fixture.context,
    sourceHashes: fixture.sourceHashes,
    stageBytes: wrongStage.stageBytes,
    checkOnlyReceiptBytes: wrongStage.checkOnlyReceiptBytes,
    now: FIXED_NOW,
  }));

  const outsideProfiles = makeBytes(undefined, (receipt) => {
    receipt.profiles.root = 'C:\\Users\\runneradmin\\AppData\\Local\\MorrowUserData';
    receipt.profiles.morrowUserData = path.win32.join(receipt.profiles.root, 'MorrowUserData');
    receipt.profiles.webView2UserData = path.win32.join(receipt.profiles.root, 'WebView2UserData');
    return receipt;
  });
  expectGateError(() => gate.createBinding({
    context: fixture.context,
    sourceHashes: fixture.sourceHashes,
    stageBytes: outsideProfiles.stageBytes,
    checkOnlyReceiptBytes: outsideProfiles.checkOnlyReceiptBytes,
    now: FIXED_NOW,
  }));

  const profileChildEscape = makeBytes(undefined, (receipt) => {
    receipt.profiles.webView2UserData = 'C:\\Users\\runneradmin\\AppData\\Local\\WebView2UserData';
    return receipt;
  });
  expectGateError(() => gate.createBinding({
    context: fixture.context,
    sourceHashes: fixture.sourceHashes,
    stageBytes: profileChildEscape.stageBytes,
    checkOnlyReceiptBytes: profileChildEscape.checkOnlyReceiptBytes,
    now: FIXED_NOW,
  }));

  const consumerEnvironment = makeEnvironment({ RUNNER_TEMP: 'C:\\a\\_temp\\fresh-consumer-44970000001-1' });
  const consumerContext = gate.safeFirstLaunchRunContext(consumerEnvironment);
  assert.doesNotThrow(() => gate.validateBinding(fixture.binding, {
    context: consumerContext,
    sourceHashes: fixture.sourceHashes,
    stageBytes: fixture.stageBytes,
    checkOnlyReceiptBytes: fixture.checkOnlyReceiptBytes,
    now: FIXED_NOW,
  }));
});

test('rejects source-hash drift after the binding was created', async () => {
  const fixture = createBindingFixture();
  const driftWorkspace = await createSourceWorkspace();
  try {
    await writeFile(path.join(driftWorkspace, 'scripts/pilot/windows-preflight.ps1'), 'legacy source drift', 'utf8');
    const changedSourceHashes = await gate.hashSourceFiles(driftWorkspace);
    expectGateError(() => gate.validateBinding(fixture.binding, {
      context: fixture.context,
      sourceHashes: changedSourceHashes,
      stageBytes: fixture.stageBytes,
      checkOnlyReceiptBytes: fixture.checkOnlyReceiptBytes,
      now: FIXED_NOW,
    }));
  } finally {
    await rm(driftWorkspace, { recursive: true, force: true });
  }
});

test('binding rejects a duplicated legacy source hash entry', () => {
  const duplicateSourceHashes = sourceHashes.map((entry) => ({ ...entry }));
  duplicateSourceHashes.at(-1).path = duplicateSourceHashes.at(-2).path;
  expectGateError(() => createBindingFixture({ sourceHashesOverride: duplicateSourceHashes }));
});

test('Actions artifact metadata must be for the candidate build, not the new gate run', () => {
  const expected = {
    repository: REPOSITORY,
    artifactId: CANDIDATE_ARTIFACT_ID,
    artifactName: CANDIDATE_ARTIFACT_NAME,
    artifactDigest: CANDIDATE_ARTIFACT_DIGEST,
    artifactSizeBytes: CANDIDATE_ARTIFACT_SIZE,
    workflowRunId: CANDIDATE_BUILD_RUN_ID,
    sourceSha: CANDIDATE_SOURCE_SHA,
    sourceBranch: CANDIDATE_BRANCH,
  };
  const metadata = {
    id: Number(CANDIDATE_ARTIFACT_ID),
    name: CANDIDATE_ARTIFACT_NAME,
    digest: CANDIDATE_ARTIFACT_DIGEST,
    size_in_bytes: CANDIDATE_ARTIFACT_SIZE,
    expired: false,
    workflow_run: {
      id: Number(CANDIDATE_BUILD_RUN_ID),
      head_sha: CANDIDATE_SOURCE_SHA,
      head_branch: CANDIDATE_BRANCH,
    },
  };
  assert.equal(gate.validateActionsArtifactMetadata(metadata, expected), true);
  expectGateError(() => gate.validateActionsArtifactMetadata(metadata, {
    ...expected,
    repository: 'other/Morrow',
  }));
  const mutations = [
    (value) => { value.id += 1; },
    (value) => { value.name += '.zip'; },
    (value) => { value.digest = `sha256:${'1'.repeat(64)}`; },
    (value) => { value.size_in_bytes += 1; },
    (value) => { value.expired = true; },
    (value) => { value.workflow_run.id = Number(GATE_RUN_ID); },
    (value) => { value.workflow_run.head_sha = GATE_SOURCE_SHA; },
    (value) => { value.workflow_run.head_branch = GATE_BRANCH; },
  ];
  for (const mutate of mutations) {
    const altered = clone(metadata);
    mutate(altered);
    expectGateError(() => gate.validateActionsArtifactMetadata(altered, expected));
  }
});

test('Actions workflow-run metadata identifies the exact protected-check run', () => {
  const expected = {
    repository: REPOSITORY,
    gateRunId: GATE_RUN_ID,
    gateRunAttempt: GATE_RUN_ATTEMPT,
    sourceSha: GATE_SOURCE_SHA,
    branch: GATE_BRANCH,
    event: 'push',
    workflowPath: WORKFLOW_PATH,
  };
  const metadata = {
    id: Number(GATE_RUN_ID),
    run_attempt: Number(GATE_RUN_ATTEMPT),
    head_sha: GATE_SOURCE_SHA,
    head_branch: GATE_BRANCH,
    event: 'push',
    path: WORKFLOW_PATH,
    repository: { full_name: REPOSITORY },
  };
  assert.equal(gate.validateActionsWorkflowRunMetadata(metadata, expected), true);

  const wrongAttempt = clone(metadata);
  wrongAttempt.run_attempt = 2;
  expectGateError(() => gate.validateActionsWorkflowRunMetadata(wrongAttempt, expected));
  const wrongPath = clone(metadata);
  wrongPath.path = '.github/workflows/pilot-windows-runtime.yml';
  expectGateError(() => gate.validateActionsWorkflowRunMetadata(wrongPath, expected));
  const wrongBranch = clone(metadata);
  wrongBranch.head_branch = 'main';
  expectGateError(() => gate.validateActionsWorkflowRunMetadata(wrongBranch, expected));
});

test('local claim binds the trusted payload hash and is one-shot under concurrency', async () => {
  const runId = `${Date.now()}`;
  let backingRoot;
  let testFilesystemBacking;
  let environment;
  let physicalClaimDirectory;
  let createdClaimDirectory = false;

  if (process.platform === 'win32') {
    assert.ok(process.env.RUNNER_TEMP && process.env.GITHUB_WORKSPACE, 'Windows runner paths are required');
    environment = makeEnvironment({
      GITHUB_RUN_ID: runId,
      RUNNER_TEMP: process.env.RUNNER_TEMP,
      GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE,
    });
  } else {
    backingRoot = await mkdtemp(path.join(os.tmpdir(), 'morrow-g15-248-claim-'));
    testFilesystemBacking = await gate.createTestFilesystemBacking(backingRoot);
    environment = makeEnvironment({
      GITHUB_RUN_ID: runId,
      RUNNER_TEMP: 'D:\\a\\_temp',
      GITHUB_WORKSPACE: 'D:\\a\\Morrow\\Morrow',
    });
  }

  try {
    const fixture = createBindingFixture({ environment });
    const claimPath = gate.firstLaunchClaimPath(fixture.context);
    const semanticClaimDirectory = path.win32.dirname(claimPath);
    physicalClaimDirectory = backingRoot
      ? path.join(backingRoot, path.win32.basename(semanticClaimDirectory))
      : semanticClaimDirectory;
    await mkdir(physicalClaimDirectory, { recursive: false });
    createdClaimDirectory = true;
    const physicalClaimPath = backingRoot
      ? path.join(physicalClaimDirectory, path.win32.basename(claimPath))
      : claimPath;
    const input = {
      context: fixture.context,
      binding: fixture.binding,
      bindingPayloadBytes: fixture.payloadBytes,
      bindingPayloadSha256: fixture.payloadSha256,
      sourceHashes: fixture.sourceHashes,
      stageBytes: fixture.stageBytes,
      checkOnlyReceiptBytes: fixture.checkOnlyReceiptBytes,
      now: FIXED_NOW,
      ...(testFilesystemBacking ? { testFilesystemBacking } : {}),
    };
    assert.equal(gate.firstLaunchClaimPath(fixture.context), claimPath);

    const tamperedBinding = clone(fixture.binding);
    tamperedBinding.nonce = `${tamperedBinding.nonce[0] === '0' ? '1' : '0'}${tamperedBinding.nonce.slice(1)}`;
    const tamperedPayloadBytes = gate.serializeBinding(tamperedBinding);
    await assert.rejects(gate.claimFirstLaunchOnce({
      ...input,
      binding: tamperedBinding,
      bindingPayloadBytes: tamperedPayloadBytes,
      bindingPayloadSha256: fixture.payloadSha256,
    }), (error) => {
      assert.equal(error?.name, 'FirstLaunchGateError');
      assert.equal(error?.code, 'ERR_FIRST_LAUNCH_GATE');
      return true;
    });
    await assert.rejects(readFile(physicalClaimPath), (error) => error?.code === 'ENOENT');

    const results = await Promise.allSettled([
      gate.claimFirstLaunchOnce(input),
      gate.claimFirstLaunchOnce(input),
    ]);
    const succeeded = results.filter((result) => result.status === 'fulfilled');
    const failed = results.filter((result) => result.status === 'rejected');
    assert.equal(succeeded.length, 1);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].reason?.code, 'EEXIST');

    const claim = succeeded[0].value;
    assert.equal(claim.path, claimPath);
    assert.equal(claim.receipt.authority, 'local-claim-only');
    assert.equal(claim.receipt.environmentApprovalVerified, false);
    assert.equal(claim.receipt.nonce, fixture.binding.nonce);
    assert.ok(JSON.stringify(claim.receipt).includes(fixture.payloadSha256));
    assert.match(claim.receiptSha256, /^[0-9a-f]{64}$/);
    const claimBytes = await readFile(physicalClaimPath);
    assert.equal(sha256(claimBytes), claim.receiptSha256);
    assert.deepEqual(JSON.parse(claimBytes.toString('utf8')), claim.receipt);
    await assert.rejects(gate.claimFirstLaunchOnce(input), (error) => error?.code === 'EEXIST');
  } finally {
    if (backingRoot) await rm(backingRoot, { recursive: true, force: true });
    else if (createdClaimDirectory) await rm(physicalClaimDirectory, { recursive: true, force: true });
  }
});
