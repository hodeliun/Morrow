import { randomBytes } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  assertWindowsLocalPath as assertWindowsLocalPathFromWindowsRunGate,
  claimFileOnce as claimFileOnceFromWindowsRunGate,
  hashSourceFiles as hashSourceFilesFromWindowsRunGate,
  parseTrustedBindingPayload as parseTrustedBindingPayloadFromWindowsRunGate,
  sha256 as sha256FromWindowsRunGate,
} from './windows-run-gate.mjs';

const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const WINDOWS_SHORT_NAME_ALIAS = /^[A-Z0-9]{1,6}~[1-9](?:\.[A-Z0-9]{0,3})?$/i;
const VERSION_3 = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const VERSION_4 = /^\d+\.\d+\.\d+\.\d+$/;
const SID = /^S-1-\d+(?:-\d+)+$/;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const PINNED_PACKAGE_INVENTORY_SHA256 = 'd8d4e6cb1a419cc342f9f63f43c5931cc1d3feb6041a4a1f7d104167104b9baf';
const TEST_FILESYSTEM_BACKING = Symbol('first-launch-test-filesystem-backing');
const PRECISE_UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{7})Z$/;
const WEBVIEW2_GUID = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
const WEBVIEW2_REGISTRY_PATHS = new Set([
  'HKLM64\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\' + WEBVIEW2_GUID,
  'HKCU64\\Software\\Microsoft\\EdgeUpdate\\Clients\\' + WEBVIEW2_GUID,
]);
const EDGE_DRIVER_PAGE_URL = 'https://developer.microsoft.com/en-us/microsoft-edge/tools/webdriver';
const EDGE_DRIVER_CATALOG_URL = 'https://msedgedriver.microsoft.com/listing.json';
const TAURI_DRIVER_SOURCE_URL = 'https://crates.io/crates/tauri-driver/';
const TAURI_DRIVER_DOWNLOAD_URL = 'https://crates.io/api/v1/crates/tauri-driver/';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

const candidateSourceSha = 'bdf54cd4eb6f20e63664c00cf46209a5c941065e';
const candidateSourceBranch = 'pilot/e003-polaris-dados-2.0';
const candidateBuildRunId = '44961916968';
const candidateArtifactName =
  'morrow-polaris-dados-windows-build-44961916968-1-bdf54cd4eb6f20e63664c00cf46209a5c941065e';

export const FIRST_LAUNCH_CANDIDATE = deepFreeze({
  repository: 'hodeliun/Morrow',
  branch: candidateSourceBranch,
  sourceSha: candidateSourceSha,
  sourceTree: '4778832b283814759fafc8945eacffe3fa1e1baf',
  candidateBuildRunId,
  candidateBuildRunAttempt: '1',
  artifact: {
    id: '14730062702',
    name: candidateArtifactName,
    digest: 'sha256:008b17dd30a28fcad18070f9415aa43b4ca0e1c91f5acf7e8bfe38f817af4c65',
    sizeBytes: 31988714,
    expiresAtUtc: '2026-11-28T23:34:10.000Z',
  },
  package: {
    outerSha256: '008b17dd30a28fcad18070f9415aa43b4ca0e1c91f5acf7e8bfe38f817af4c65',
    innerName: 'morrow-polaris-dados-windows-44961916968-1-bdf54cd4eb6f20e63664c00cf46209a5c941065e.zip',
    innerSizeBytes: 32037277,
    innerSha256: '678270f73fa90bb1f58af11b0a5de74245c002887270a809fc2c85ff1002373e',
    innerEntryCount: 21,
    innerTotalBytes: 53867047,
    fileInventoryCount: 19,
    buildInfoSizeBytes: 7175,
    buildInfoSha256: '480080192f50de4b5388adc4c1f76cb1c99fb4a50ae0725c4e32aa529c112efa',
    sha256SumsSizeBytes: 1919,
    sha256SumsSha256: '343bd75415c4b51c265f4d547099aa4a8fdf7ec917b81344250bde55ce204adb',
    canonicalInventorySha256: PINNED_PACKAGE_INVENTORY_SHA256,
    launcherSha256: '321b9e8cc723e292225ef3819110776363843bf6c85761a5e22ae9871bc2ef79',
    launcherCmdSha256: 'b22e8236a258f9aceccd4476c2d4e3490a9fcc63a699476d6af691a5bc6e4798',
    mcpResourceSha256: '555b5b5aeb441f1fc10958aeea3bb49c694810d369de60833d1a3d46cb498ade',
    overlayPath: 'src-tauri/tauri.pilot.conf.json',
    overlaySha256: 'c2e8898d991f38da8418a0cdac156f163c0e8b968a3f03c601bac67d2bbbcf9f',
    mcpResourceSource: '../dist-mcp/index.js',
    mcpResourceTarget: 'mcp/index.js',
    demoVaultPath: 'DemoVault',
    demoVaultSha256: '7090716fb431d19f6ee0b2db463280352a34ffffbe23fded9f807d8cfaa65a1a',
    sourceAuditSha256: '77f85cf358e799fef123ab4218e29acf30320711f8edaa12251885880002dcc8',
  },
  application: {
    version: '2.2.0',
    executableSizeBytes: 51768832,
    executableSha256: '85015c92631dbfcef49856c6729accd1c4d2567c097ef87c5ebad38745f99879',
    pilotIdentifier: 'app.morrow.polaris-dados-pilot',
    appGUIWindowsTested: false,
  },
});

const sourcePaths = [
  '.github/workflows/pilot-windows-first-launch-preflight.yml',
  'scripts/pilot/windows-first-launch-gate.mjs',
  'scripts/pilot/windows-run-gate.mjs',
  'scripts/pilot/windows-first-launch-gate.test.mjs',
  'scripts/pilot/windows-first-launch-gate.independent.test.mjs',
  'scripts/pilot/windows-first-launch-preflight.ps1',
  'scripts/pilot/windows-first-launch-preflight.test.ps1',
  'scripts/pilot/windows-first-launch-preflight.independent.test.ps1',
  'scripts/pilot/windows-preflight.ps1',
];

export const WINDOWS_FIRST_LAUNCH_GATE = deepFreeze({
  repository: 'hodeliun/Morrow',
  branch: 'codex/e003-g07-windows-runtime',
  ref: 'refs/heads/codex/e003-g07-windows-runtime',
  workflowPath: '.github/workflows/pilot-windows-first-launch-preflight.yml',
  workflowRef:
    'hodeliun/Morrow/.github/workflows/pilot-windows-first-launch-preflight.yml@refs/heads/codex/e003-g07-windows-runtime',
  event: 'push',
  schema: 'morrow.e003.g15.first-launch-binding.v1',
  stageSchema: 'morrow.e003.g15.first-launch-stage.v1',
  checkOnlyReceiptSchema: 'morrow.e003.g15.first-launch-check-only-receipt.v1',
  claimSchema: 'morrow.e003.g15.first-launch-local-claim.v1',
  purpose: 'first-windows-launch',
  executionPhase: 'protected-check-only',
  lifetimeMs: 2 * 60 * 60 * 1000,
  sourcePaths,
});

const GATE_IDENTITY_KEYS = [
  'repository',
  'ref',
  'workflowPath',
  'workflowRef',
  'sourceSha',
  'gateRunId',
  'gateRunAttempt',
  'event',
];
const BINDING_KEYS = [
  'schema',
  'purpose',
  'executionPhase',
  'gate',
  'candidateBuild',
  'stage',
  'checkOnlyReceipt',
  'nonce',
  'createdAtUtc',
  'expiresAtUtc',
];
const BINDING_GATE_KEYS = [...GATE_IDENTITY_KEYS, 'sourceHashes'];
const STAGE_KEYS = [
  'schema',
  'status',
  'purpose',
  'executionPhase',
  'gate',
  'runner',
  'webView2Runtime',
  'candidateBuild',
  'packageInventory',
  'drivers',
  'noLaunch',
  'stagedAtUtc',
];
const STAGE_RUNNER_KEYS = ['os', 'arch', 'tempRoot'];
const RUNTIME_KEYS = ['version', 'observedAtUtc', 'sources'];
const RUNTIME_SOURCE_KEYS = ['registryPath', 'version'];
const INVENTORY_ENTRY_KEYS = ['path', 'sizeBytes', 'sha256'];
const DRIVERS_KEYS = ['tauriDriver', 'edgeDriver'];
const TAURI_DRIVER_KEYS = [
  'version',
  'source',
  'sourceUrl',
  'downloadUrl',
  'cargoVersion',
  'installCommand',
  'executableSha256',
  'serviceStarted',
];
const EDGE_DRIVER_KEYS = [
  'version',
  'runtimeVersion',
  'compatibleFirstThreeComponents',
  'sourcePageUrl',
  'sourceCatalogUrl',
  'downloadUrl',
  'responseUrl',
  'catalogGeneratedAtUtc',
  'catalogSizeBytes',
  'catalogItemCount',
  'catalogSha256',
  'selectedLastModified',
  'expectedArchiveBytes',
  'archiveSizeBytes',
  'archiveSha256',
  'executableSha256',
  'versionProbeExitCode',
  'serviceStarted',
];
const NO_LAUNCH_KEYS = ['appLaunched', 'driverServiceStarted', 'guiTested'];
const CHECK_ONLY_RECEIPT_KEYS = [
  'schema',
  'status',
  'purpose',
  'executionPhase',
  'gate',
  'candidateBuild',
  'stageSha256',
  'pinsVerified',
  'driverHashes',
  'webView2RuntimeVersion',
  'identity',
  'knownFolders',
  'profiles',
  'noLaunch',
  'checkedAtUtc',
];
const DRIVER_HASH_KEYS = ['tauriDriverSha256', 'edgeDriverSha256'];
const IDENTITY_KEYS = ['sid'];
const KNOWN_FOLDER_KEYS = ['localAppData', 'roamingAppData'];
const PROFILE_KEYS = ['root', 'morrowUserData', 'webView2UserData'];
const STAGE_SUMMARY_KEYS = [
  'schema',
  'sha256',
  'gate',
  'runner',
  'webView2Runtime',
  'candidateBuild',
  'packageInventoryCount',
  'packageInventorySha256',
  'drivers',
  'noLaunch',
  'stagedAtUtc',
];
const RECEIPT_SUMMARY_KEYS = [
  'schema',
  'sha256',
  'status',
  'gate',
  'candidateBuild',
  'stageSha256',
  'pinsVerified',
  'driverHashes',
  'webView2RuntimeVersion',
  'identity',
  'knownFolders',
  'profiles',
  'noLaunch',
  'checkedAtUtc',
];
const SOURCE_HASH_KEYS = ['path', 'sha256', 'sizeBytes'];
const WORKFLOW_RUN_EXPECTED_KEYS = [
  'repository',
  'gateRunId',
  'gateRunAttempt',
  'sourceSha',
  'branch',
  'event',
  'workflowPath',
];
const ARTIFACT_EXPECTED_KEYS = [
  'repository',
  'artifactId',
  'artifactName',
  'artifactDigest',
  'artifactSizeBytes',
  'workflowRunId',
  'sourceSha',
  'sourceBranch',
];
const CLAIM_KEYS = [
  'schema',
  'authority',
  'environmentApprovalVerified',
  'gateRunId',
  'gateRunAttempt',
  'bindingPayloadSha256',
  'nonce',
  'claimedAtUtc',
];

export class FirstLaunchGateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FirstLaunchGateError';
    this.code = 'ERR_FIRST_LAUNCH_GATE';
  }
}

function fail(message) {
  throw new FirstLaunchGateError(message);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expectedKeys, label) {
  if (!isPlainObject(value)) fail(label + ' must be a JSON object.');
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (!isDeepStrictEqual(actual, expected)) fail(label + ' has missing or unexpected fields.');
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    fail(label + ' must be a nonempty string.');
  }
  return value;
}

function requiredRunId(value, label) {
  const runId = requiredString(value, label);
  if (!RUN_ID.test(runId)) fail(label + ' is malformed.');
  return runId;
}

function requiredSha40(value, label) {
  const sha = requiredString(value, label);
  if (!HEX_40.test(sha)) fail(label + ' is malformed.');
  return sha;
}

function requiredSha256(value, label) {
  const sha = requiredString(value, label);
  if (!HEX_64.test(sha)) fail(label + ' is malformed.');
  return sha;
}

function requiredDigest(value, label) {
  const digest = requiredString(value, label);
  if (!DIGEST.test(digest)) fail(label + ' is malformed.');
  return digest;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(label + ' must be a positive safe integer.');
  return value;
}

function utcTimestamp(value, label) {
  const timestamp = requiredString(value, label);
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
    fail(label + ' must be a canonical UTC timestamp.');
  }
  return milliseconds;
}

function preciseUtcTimestamp(value, label) {
  const timestamp = requiredString(value, label);
  const match = PRECISE_UTC_TIMESTAMP.exec(timestamp);
  if (!match) fail(label + ' must be a canonical UTC timestamp with seven fractional digits.');

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  if (
    year === 0 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    fail(label + ' must be a valid canonical UTC timestamp with seven fractional digits.');
  }

  return timestamp;
}

function nowMilliseconds(value) {
  const milliseconds = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    fail('The supplied clock value is invalid.');
  }
  return milliseconds;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertEqual(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) fail(label + ' does not match the bound value.');
}

function canonicalAbsolutePath(value, label) {
  const text = requiredString(value, label);
  try {
    assertWindowsLocalPathFromWindowsRunGate(text, label);
  } catch {
    fail(label + ' must be a normalized local Windows path.');
  }
  if (
    text
      .slice(3)
      .split('\\')
      .some((segment) => WINDOWS_SHORT_NAME_ALIAS.test(segment))
  ) {
    fail(label + ' must not contain a Windows short-name alias.');
  }
  return { value: text, api: path.win32 };
}

function samePath(left, right) {
  const leftInfo = canonicalAbsolutePath(left, 'Path');
  const rightInfo = canonicalAbsolutePath(right, 'Path');
  if (leftInfo.api !== rightInfo.api) return false;
  const leftResolved = leftInfo.api.resolve(leftInfo.value);
  const rightResolved = rightInfo.api.resolve(rightInfo.value);
  return leftInfo.api === path.win32
    ? leftResolved.toLowerCase() === rightResolved.toLowerCase()
    : leftResolved === rightResolved;
}

function pathContains(root, candidate, allowSame = true) {
  const rootInfo = canonicalAbsolutePath(root, 'Path root');
  const candidateInfo = canonicalAbsolutePath(candidate, 'Path candidate');
  if (rootInfo.api !== candidateInfo.api) return false;
  const rootResolved = rootInfo.api.resolve(rootInfo.value);
  const candidateResolved = rootInfo.api.resolve(candidateInfo.value);
  const relative = rootInfo.api.relative(rootResolved, candidateResolved);
  const equal = relative === '';
  if (equal) return allowSame;
  return (
    !rootInfo.api.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + rootInfo.api.sep)
  );
}

function pathsOverlap(left, right) {
  return pathContains(left, right, true) || pathContains(right, left, true);
}

function firstLaunchProfilePaths(runnerTemp, sourceSha, gateRunId, gateRunAttempt) {
  const rootInfo = canonicalAbsolutePath(runnerTemp, 'RUNNER_TEMP');
  requiredSha40(sourceSha, 'Gate source SHA');
  requiredRunId(gateRunId, 'Gate run ID');
  if (gateRunAttempt !== '1') fail('Gate run attempt must be 1.');
  const root = rootInfo.api.join(
    rootInfo.api.resolve(rootInfo.value),
    'morrow-issue-187-' + sourceSha + '-' + gateRunId + '-1',
    'profile',
  );
  return deepFreeze({
    root,
    morrowUserData: rootInfo.api.join(root, 'MorrowUserData'),
    webView2UserData: rootInfo.api.join(root, 'WebView2UserData'),
  });
}

export function firstLaunchClaimPath(context) {
  const checked = validateContext(context);
  const rootInfo = canonicalAbsolutePath(checked.runner.tempRoot, 'RUNNER_TEMP');
  return rootInfo.api.join(
    rootInfo.api.resolve(rootInfo.value),
    'issue-187-control-' + checked.gateRunId + '-1',
    'first-launch-claim.json',
  );
}

function contextIdentity(context) {
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

function validateContext(context) {
  exactKeys(context, [...GATE_IDENTITY_KEYS, 'runner'], 'Gate execution context');
  const identity = {};
  for (const key of GATE_IDENTITY_KEYS) identity[key] = context[key];
  exactKeys(identity, GATE_IDENTITY_KEYS, 'Gate execution identity');
  if (identity.repository !== WINDOWS_FIRST_LAUNCH_GATE.repository) {
    fail('Gate repository does not match the authorized repository.');
  }
  if (identity.ref !== WINDOWS_FIRST_LAUNCH_GATE.ref) fail('Gate ref does not match the authorized ref.');
  if (identity.workflowPath !== WINDOWS_FIRST_LAUNCH_GATE.workflowPath) {
    fail('Gate workflow path does not match the authorized workflow.');
  }
  if (identity.workflowRef !== WINDOWS_FIRST_LAUNCH_GATE.workflowRef) {
    fail('Gate workflow ref does not match the authorized workflow.');
  }
  if (identity.event !== WINDOWS_FIRST_LAUNCH_GATE.event) fail('Gate event is not authorized.');
  requiredSha40(identity.sourceSha, 'Gate source SHA');
  requiredRunId(identity.gateRunId, 'Gate run ID');
  if (identity.gateRunId === FIRST_LAUNCH_CANDIDATE.candidateBuildRunId) {
    fail('Gate run ID must be distinct from the candidate build run ID.');
  }
  if (identity.gateRunAttempt !== '1') fail('Gate run attempt must be 1.');
  exactKeys(context.runner, ['os', 'arch', 'tempRoot', 'workspace'], 'Gate runner context');
  if (context.runner.os !== 'Windows' || context.runner.arch !== 'X64') {
    fail('Gate runner must be Windows X64.');
  }
  const temp = canonicalAbsolutePath(context.runner.tempRoot, 'RUNNER_TEMP');
  const workspace = canonicalAbsolutePath(context.runner.workspace, 'GITHUB_WORKSPACE');
  if (temp.api !== workspace.api) fail('Runner temp and workspace path formats differ.');
  if (pathsOverlap(temp.value, workspace.value)) {
    fail('RUNNER_TEMP must be isolated from the checkout workspace.');
  }
  return deepFreeze({
    ...identity,
    runner: {
      os: 'Windows',
      arch: 'X64',
      tempRoot: temp.value,
      workspace: workspace.value,
    },
  });
}

export function safeFirstLaunchRunContext(env) {
  if (!isPlainObject(env)) fail('GitHub environment must be an object.');
  const repository = requiredString(env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY');
  const ref = requiredString(env.GITHUB_REF, 'GITHUB_REF');
  const workflowRef = requiredString(env.GITHUB_WORKFLOW_REF, 'GITHUB_WORKFLOW_REF');
  const sourceSha = requiredSha40(requiredString(env.GITHUB_SHA, 'GITHUB_SHA').toLowerCase(), 'GITHUB_SHA');
  const gateRunId = requiredRunId(env.GITHUB_RUN_ID, 'GITHUB_RUN_ID');
  const gateRunAttempt = requiredString(env.GITHUB_RUN_ATTEMPT, 'GITHUB_RUN_ATTEMPT');
  const event = requiredString(env.GITHUB_EVENT_NAME, 'GITHUB_EVENT_NAME');
  const workspace = requiredString(env.GITHUB_WORKSPACE, 'GITHUB_WORKSPACE');
  const tempRoot = requiredString(env.RUNNER_TEMP, 'RUNNER_TEMP');
  const os = requiredString(env.RUNNER_OS, 'RUNNER_OS');
  const arch = requiredString(env.RUNNER_ARCH, 'RUNNER_ARCH');
  return validateContext({
    repository,
    ref,
    workflowPath: WINDOWS_FIRST_LAUNCH_GATE.workflowPath,
    workflowRef,
    sourceSha,
    gateRunId,
    gateRunAttempt,
    event,
    runner: { os, arch, tempRoot, workspace },
  });
}

export async function hashSourceFiles(workspace, filePaths = WINDOWS_FIRST_LAUNCH_GATE.sourcePaths) {
  if (!Array.isArray(filePaths) || filePaths.some((filePath) => typeof filePath !== 'string')) {
    fail('Gate source path list is invalid.');
  }
  try {
    return await hashSourceFilesFromWindowsRunGate(workspace, filePaths);
  } catch {
    fail('Gate source files could not be hashed safely.');
  }
}

function validateSourceHashes(sourceHashes) {
  if (!Array.isArray(sourceHashes) || sourceHashes.length !== WINDOWS_FIRST_LAUNCH_GATE.sourcePaths.length) {
    fail('Gate source hash inventory is incomplete.');
  }
  const checked = [];
  for (let index = 0; index < WINDOWS_FIRST_LAUNCH_GATE.sourcePaths.length; index += 1) {
    const entry = sourceHashes[index];
    exactKeys(entry, SOURCE_HASH_KEYS, 'Gate source hash entry');
    if (entry.path !== WINDOWS_FIRST_LAUNCH_GATE.sourcePaths[index]) {
      fail('Gate source hash paths are missing, reordered, or unexpected.');
    }
    checked.push({
      path: entry.path,
      sha256: requiredSha256(entry.sha256, 'Gate source file SHA-256'),
      sizeBytes: positiveInteger(entry.sizeBytes, 'Gate source file size'),
    });
  }
  return deepFreeze(checked);
}

function validateCandidateBuild(candidateBuild) {
  assertEqual(candidateBuild, FIRST_LAUNCH_CANDIDATE, 'Pinned candidate build');
  return FIRST_LAUNCH_CANDIDATE;
}

function safeRelativeInventoryPath(value) {
  const filePath = requiredString(value, 'Package inventory path');
  if (
    filePath.startsWith('/') ||
    filePath.includes('\\') ||
    filePath.includes(':') ||
    filePath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    fail('Package inventory contains an unsafe relative path.');
  }
  try {
    assertWindowsLocalPathFromWindowsRunGate(
      'C:\\' + filePath.replaceAll('/', '\\'),
      'Package inventory path',
    );
  } catch {
    fail('Package inventory contains a path that is ambiguous on Windows.');
  }
  if (filePath.split('/').some((segment) => WINDOWS_SHORT_NAME_ALIAS.test(segment))) {
    fail('Package inventory must not contain a Windows short-name alias.');
  }
  if (filePath.normalize('NFC') !== filePath) {
    fail('Package inventory path must use canonical Unicode normalization.');
  }
  return filePath;
}

function validatePackageInventory(inventory) {
  if (!Array.isArray(inventory) || inventory.length !== FIRST_LAUNCH_CANDIDATE.package.fileInventoryCount) {
    fail('Package file inventory count does not match the pinned candidate.');
  }
  const paths = new Set();
  const caseFoldedPaths = new Set();
  const checked = inventory.map((entry) => {
    exactKeys(entry, INVENTORY_ENTRY_KEYS, 'Package inventory entry');
    const filePath = safeRelativeInventoryPath(entry.path);
    if (paths.has(filePath)) fail('Package inventory contains a duplicate path.');
    const caseFoldedPath = filePath.toLowerCase();
    if (caseFoldedPaths.has(caseFoldedPath)) {
      fail('Package inventory contains Windows case-insensitive duplicate paths.');
    }
    paths.add(filePath);
    caseFoldedPaths.add(caseFoldedPath);
    return {
      path: filePath,
      sizeBytes: positiveInteger(entry.sizeBytes, 'Package inventory file size'),
      sha256: requiredSha256(entry.sha256, 'Package inventory file SHA-256'),
    };
  });
  const sorted = [...checked].sort((left, right) => left.path.localeCompare(right.path, 'en'));
  if (!isDeepStrictEqual(checked, sorted)) fail('Package inventory paths are not in canonical order.');
  if (inventorySha256(checked) !== PINNED_PACKAGE_INVENTORY_SHA256) {
    fail('Package inventory does not match the pinned candidate invoice.');
  }
  return deepFreeze(checked);
}

function inventorySha256(inventory) {
  const bytes = Buffer.from(JSON.stringify(inventory), 'utf8');
  return sha256FromWindowsRunGate(bytes);
}

function validateRuntime(runtime) {
  exactKeys(runtime, RUNTIME_KEYS, 'WebView2 runtime observation');
  const version = requiredString(runtime.version, 'WebView2 runtime version');
  if (!VERSION_4.test(version)) fail('WebView2 runtime version is malformed.');
  utcTimestamp(runtime.observedAtUtc, 'WebView2 runtime observation time');
  if (!Array.isArray(runtime.sources) || runtime.sources.length === 0) {
    fail('WebView2 runtime observation has no registry sources.');
  }
  const seen = new Set();
  const sources = runtime.sources.map((source) => {
    exactKeys(source, RUNTIME_SOURCE_KEYS, 'WebView2 runtime source');
    if (!WEBVIEW2_REGISTRY_PATHS.has(source.registryPath)) {
      fail('WebView2 runtime source is not a documented 64-bit registry location.');
    }
    if (seen.has(source.registryPath)) fail('WebView2 runtime source is duplicated.');
    seen.add(source.registryPath);
    if (source.version !== version) fail('WebView2 registry observations disagree.');
    return { registryPath: source.registryPath, version: source.version };
  });
  return deepFreeze({ version, observedAtUtc: runtime.observedAtUtc, sources });
}

function validateTauriDriver(driver) {
  exactKeys(driver, TAURI_DRIVER_KEYS, 'Tauri driver provenance');
  const version = requiredString(driver.version, 'Tauri driver version');
  if (!VERSION_3.test(version)) fail('Tauri driver version is malformed.');
  if (driver.source !== 'crates.io') fail('Tauri driver source is not crates.io.');
  if (driver.sourceUrl !== TAURI_DRIVER_SOURCE_URL + version) {
    fail('Tauri driver source URL does not match its version.');
  }
  if (driver.downloadUrl !== TAURI_DRIVER_DOWNLOAD_URL + version + '/download') {
    fail('Tauri driver download URL does not match its version.');
  }
  if (
    !/^cargo \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(requiredString(driver.cargoVersion, 'Cargo version'))
  ) {
    fail('Cargo version provenance is malformed.');
  }
  if (
    driver.installCommand !==
    'cargo install tauri-driver --version ' + version + ' --locked --root <tool-stage>'
  ) {
    fail('Tauri driver install provenance does not match its version.');
  }
  requiredSha256(driver.executableSha256, 'Tauri driver executable SHA-256');
  if (driver.serviceStarted !== false) fail('Tauri driver service must remain stopped.');
  return deepFreeze(cloneJson(driver));
}

function firstThree(version, label) {
  const value = requiredString(version, label);
  if (!VERSION_4.test(value)) fail(label + ' is malformed.');
  return value.split('.').slice(0, 3).join('.');
}

function validateEdgeDriver(driver, runtimeVersion) {
  exactKeys(driver, EDGE_DRIVER_KEYS, 'Microsoft EdgeDriver provenance');
  const version = requiredString(driver.version, 'EdgeDriver version');
  if (!VERSION_4.test(version)) fail('EdgeDriver version is malformed.');
  if (driver.runtimeVersion !== runtimeVersion)
    fail('EdgeDriver runtime version differs from the observed WebView2.');
  const compatible = firstThree(version, 'EdgeDriver version');
  if (
    driver.compatibleFirstThreeComponents !== compatible ||
    compatible !== firstThree(runtimeVersion, 'WebView2 runtime version')
  ) {
    fail('EdgeDriver does not match the WebView2 runtime version.');
  }
  if (driver.sourcePageUrl !== EDGE_DRIVER_PAGE_URL) {
    fail('EdgeDriver source page is not the official Microsoft page.');
  }
  if (driver.sourceCatalogUrl !== EDGE_DRIVER_CATALOG_URL) {
    fail('EdgeDriver catalog is not the official Microsoft catalog.');
  }
  const expectedDownload = 'https://msedgedriver.microsoft.com/' + version + '/edgedriver_win64.zip';
  if (driver.downloadUrl !== expectedDownload || driver.responseUrl !== expectedDownload) {
    fail('EdgeDriver download provenance does not match its selected version.');
  }
  preciseUtcTimestamp(driver.catalogGeneratedAtUtc, 'EdgeDriver catalog generation time');
  positiveInteger(driver.catalogSizeBytes, 'EdgeDriver catalog size');
  positiveInteger(driver.catalogItemCount, 'EdgeDriver catalog item count');
  requiredSha256(driver.catalogSha256, 'EdgeDriver catalog SHA-256');
  preciseUtcTimestamp(driver.selectedLastModified, 'EdgeDriver selected item modification time');
  positiveInteger(driver.expectedArchiveBytes, 'EdgeDriver expected archive size');
  positiveInteger(driver.archiveSizeBytes, 'EdgeDriver archive size');
  if (driver.archiveSizeBytes !== driver.expectedArchiveBytes) {
    fail('EdgeDriver archive size differs from the selected catalog record.');
  }
  requiredSha256(driver.archiveSha256, 'EdgeDriver archive SHA-256');
  requiredSha256(driver.executableSha256, 'EdgeDriver executable SHA-256');
  if (driver.versionProbeExitCode !== 0) fail('EdgeDriver version probe did not succeed.');
  if (driver.serviceStarted !== false) fail('EdgeDriver service must remain stopped.');
  return deepFreeze(cloneJson(driver));
}

function validateNoLaunch(noLaunch, label) {
  exactKeys(noLaunch, NO_LAUNCH_KEYS, label);
  if (
    noLaunch.appLaunched !== false ||
    noLaunch.driverServiceStarted !== false ||
    noLaunch.guiTested !== false
  ) {
    fail(label + ' must record that no application, service, or GUI was launched.');
  }
  return deepFreeze({
    appLaunched: false,
    driverServiceStarted: false,
    guiTested: false,
  });
}

function validateStage(stageBytes, context, { requireLocalRunnerTemp = false } = {}) {
  const stage = parseJsonBytes(stageBytes, 'Stage manifest');
  exactKeys(stage, STAGE_KEYS, 'Stage manifest');
  if (stage.schema !== WINDOWS_FIRST_LAUNCH_GATE.stageSchema) fail('Stage schema is unsupported.');
  if (stage.status !== 'staged') fail('Stage status is not staged.');
  if (stage.purpose !== WINDOWS_FIRST_LAUNCH_GATE.purpose) fail('Stage purpose is incorrect.');
  if (stage.executionPhase !== WINDOWS_FIRST_LAUNCH_GATE.executionPhase) {
    fail('Stage execution phase is incorrect.');
  }
  assertGateIdentity(stage.gate, context, 'Stage gate identity');
  exactKeys(stage.runner, STAGE_RUNNER_KEYS, 'Stage runner');
  if (stage.runner.os !== 'Windows' || stage.runner.arch !== 'X64') {
    fail('Stage runner must be Windows X64.');
  }
  const tempRoot = canonicalAbsolutePath(stage.runner.tempRoot, 'Stage RUNNER_TEMP').value;
  if (requireLocalRunnerTemp && !samePath(tempRoot, context.runner.tempRoot)) {
    fail('Stage RUNNER_TEMP does not match the preparation runner.');
  }
  const runtime = validateRuntime(stage.webView2Runtime);
  const stagedAtMs = utcTimestamp(stage.stagedAtUtc, 'Stage completion time');
  if (utcTimestamp(runtime.observedAtUtc, 'WebView2 runtime observation time') > stagedAtMs) {
    fail('WebView2 runtime observation postdates the Stage manifest.');
  }
  validateCandidateBuild(stage.candidateBuild);
  const packageInventory = validatePackageInventory(stage.packageInventory);
  exactKeys(stage.drivers, DRIVERS_KEYS, 'Stage driver set');
  const drivers = deepFreeze({
    tauriDriver: validateTauriDriver(stage.drivers.tauriDriver),
    edgeDriver: validateEdgeDriver(stage.drivers.edgeDriver, runtime.version),
  });
  const noLaunch = validateNoLaunch(stage.noLaunch, 'Stage launch boundary');
  return deepFreeze({
    ...cloneJson(stage),
    runner: { os: 'Windows', arch: 'X64', tempRoot },
    webView2Runtime: runtime,
    packageInventory,
    drivers,
    noLaunch,
  });
}

function assertGateIdentity(gate, context, label) {
  exactKeys(gate, GATE_IDENTITY_KEYS, label);
  for (const key of GATE_IDENTITY_KEYS) {
    if (gate[key] !== context[key]) fail(label + ' differs from the current gate run.');
  }
  return true;
}

function validateCheckOnlyReceipt(receiptBytes, stageBytes, stage, context) {
  const receipt = parseJsonBytes(receiptBytes, 'CheckOnly receipt');
  exactKeys(receipt, CHECK_ONLY_RECEIPT_KEYS, 'CheckOnly receipt');
  if (receipt.schema !== WINDOWS_FIRST_LAUNCH_GATE.checkOnlyReceiptSchema) {
    fail('CheckOnly receipt schema is unsupported.');
  }
  if (receipt.status !== 'passed') fail('CheckOnly receipt did not pass.');
  if (receipt.purpose !== WINDOWS_FIRST_LAUNCH_GATE.purpose) {
    fail('CheckOnly receipt purpose is incorrect.');
  }
  if (receipt.executionPhase !== WINDOWS_FIRST_LAUNCH_GATE.executionPhase) {
    fail('CheckOnly receipt execution phase is incorrect.');
  }
  assertGateIdentity(receipt.gate, context, 'CheckOnly receipt gate identity');
  validateCandidateBuild(receipt.candidateBuild);
  if (receipt.stageSha256 !== sha256FromWindowsRunGate(stageBytes)) {
    fail('CheckOnly receipt is bound to different Stage bytes.');
  }
  if (receipt.pinsVerified !== true) fail('CheckOnly receipt did not verify the package and driver pins.');
  exactKeys(receipt.driverHashes, DRIVER_HASH_KEYS, 'CheckOnly driver hashes');
  if (
    receipt.driverHashes.tauriDriverSha256 !== stage.drivers.tauriDriver.executableSha256 ||
    receipt.driverHashes.edgeDriverSha256 !== stage.drivers.edgeDriver.executableSha256
  ) {
    fail('CheckOnly driver hashes differ from the Stage provenance.');
  }
  if (receipt.webView2RuntimeVersion !== stage.webView2Runtime.version) {
    fail('CheckOnly WebView2 runtime differs from the Stage observation.');
  }
  exactKeys(receipt.identity, IDENTITY_KEYS, 'CheckOnly runner identity');
  if (!SID.test(requiredString(receipt.identity.sid, 'Windows runner SID'))) {
    fail('CheckOnly runner SID is malformed.');
  }
  exactKeys(receipt.knownFolders, KNOWN_FOLDER_KEYS, 'CheckOnly known folders');
  const localAppData = canonicalAbsolutePath(
    receipt.knownFolders.localAppData,
    'LocalAppData Known Folder',
  ).value;
  const roamingAppData = canonicalAbsolutePath(
    receipt.knownFolders.roamingAppData,
    'RoamingAppData Known Folder',
  ).value;
  if (pathsOverlap(localAppData, roamingAppData)) {
    fail('Known Folder paths must be distinct.');
  }
  exactKeys(receipt.profiles, PROFILE_KEYS, 'CheckOnly isolated profile paths');
  const expectedProfiles = firstLaunchProfilePaths(
    stage.runner.tempRoot,
    context.sourceSha,
    context.gateRunId,
    context.gateRunAttempt,
  );
  for (const key of PROFILE_KEYS) {
    const actualPath = canonicalAbsolutePath(receipt.profiles[key], 'CheckOnly profile path').value;
    if (!samePath(actualPath, expectedProfiles[key])) {
      fail('CheckOnly profile path does not match the run-specific RUNNER_TEMP layout.');
    }
  }
  for (const knownFolder of [localAppData, roamingAppData]) {
    if (pathsOverlap(knownFolder, expectedProfiles.root)) {
      fail('Pilot profiles must remain outside the Windows Known Folders.');
    }
  }
  const noLaunch = validateNoLaunch(receipt.noLaunch, 'CheckOnly launch boundary');
  const checkedAtMs = utcTimestamp(receipt.checkedAtUtc, 'CheckOnly completion time');
  const stagedAtMs = utcTimestamp(stage.stagedAtUtc, 'Stage completion time');
  if (checkedAtMs < stagedAtMs) fail('CheckOnly receipt predates its Stage manifest.');
  return deepFreeze({
    ...cloneJson(receipt),
    knownFolders: { localAppData, roamingAppData },
    profiles: cloneJson(expectedProfiles),
    noLaunch,
  });
}

function assertStageTimestamps(stage, receipt, createdAtMs) {
  const stagedAtMs = utcTimestamp(stage.stagedAtUtc, 'Stage completion time');
  const checkedAtMs = utcTimestamp(receipt.checkedAtUtc, 'CheckOnly completion time');
  if (stagedAtMs > checkedAtMs || checkedAtMs > createdAtMs) {
    fail('Stage and CheckOnly timestamps are incompatible with the binding start time.');
  }
}

function stageSummary(stage, stageBytes) {
  return deepFreeze({
    schema: stage.schema,
    sha256: sha256FromWindowsRunGate(stageBytes),
    gate: cloneJson(stage.gate),
    runner: cloneJson(stage.runner),
    webView2Runtime: cloneJson(stage.webView2Runtime),
    candidateBuild: cloneJson(stage.candidateBuild),
    packageInventoryCount: stage.packageInventory.length,
    packageInventorySha256: inventorySha256(stage.packageInventory),
    drivers: cloneJson(stage.drivers),
    noLaunch: cloneJson(stage.noLaunch),
    stagedAtUtc: stage.stagedAtUtc,
  });
}

function checkOnlyReceiptSummary(receipt, receiptBytes) {
  return deepFreeze({
    schema: receipt.schema,
    sha256: sha256FromWindowsRunGate(receiptBytes),
    status: receipt.status,
    gate: cloneJson(receipt.gate),
    candidateBuild: cloneJson(receipt.candidateBuild),
    stageSha256: receipt.stageSha256,
    pinsVerified: receipt.pinsVerified,
    driverHashes: cloneJson(receipt.driverHashes),
    webView2RuntimeVersion: receipt.webView2RuntimeVersion,
    identity: cloneJson(receipt.identity),
    knownFolders: cloneJson(receipt.knownFolders),
    profiles: cloneJson(receipt.profiles),
    noLaunch: cloneJson(receipt.noLaunch),
    checkedAtUtc: receipt.checkedAtUtc,
  });
}

function validateTimes(binding, now) {
  const createdAtMs = utcTimestamp(binding.createdAtUtc, 'Binding creation time');
  const expiresAtMs = utcTimestamp(binding.expiresAtUtc, 'Binding expiry time');
  if (expiresAtMs - createdAtMs !== WINDOWS_FIRST_LAUNCH_GATE.lifetimeMs) {
    fail('Binding lifetime must be exactly two hours.');
  }
  if (createdAtMs > now + MAX_FUTURE_SKEW_MS)
    fail('Binding creation time is incompatible with the runner clock.');
  if (now >= expiresAtMs) fail('Binding has expired.');
  const candidateExpiry = utcTimestamp(
    FIRST_LAUNCH_CANDIDATE.artifact.expiresAtUtc,
    'Candidate artifact expiry',
  );
  if (now >= candidateExpiry) fail('Pinned candidate artifact has expired.');
  return { createdAtMs, expiresAtMs };
}

function validateBindingShape(binding) {
  exactKeys(binding, BINDING_KEYS, 'First Windows launch binding');
  if (binding.schema !== WINDOWS_FIRST_LAUNCH_GATE.schema) fail('Binding schema is unsupported.');
  if (binding.purpose !== WINDOWS_FIRST_LAUNCH_GATE.purpose) fail('Binding purpose is incorrect.');
  if (binding.executionPhase !== WINDOWS_FIRST_LAUNCH_GATE.executionPhase) {
    fail('Binding execution phase is incorrect.');
  }
  exactKeys(binding.gate, BINDING_GATE_KEYS, 'Binding gate identity');
  exactKeys(binding.stage, STAGE_SUMMARY_KEYS, 'Binding Stage summary');
  exactKeys(binding.checkOnlyReceipt, RECEIPT_SUMMARY_KEYS, 'Binding CheckOnly summary');
  validateCandidateBuild(binding.candidateBuild);
  validateSourceHashes(binding.gate.sourceHashes);
  assertGateIdentity(binding.stage.gate, binding.gate, 'Binding Stage gate identity');
  assertGateIdentity(binding.checkOnlyReceipt.gate, binding.gate, 'Binding CheckOnly gate identity');
  exactKeys(binding.stage.runner, STAGE_RUNNER_KEYS, 'Binding Stage runner');
  exactKeys(binding.stage.webView2Runtime, RUNTIME_KEYS, 'Binding WebView2 runtime summary');
  exactKeys(binding.stage.drivers, DRIVERS_KEYS, 'Binding driver provenance');
  exactKeys(binding.stage.noLaunch, NO_LAUNCH_KEYS, 'Binding Stage launch boundary');
  exactKeys(binding.checkOnlyReceipt.driverHashes, DRIVER_HASH_KEYS, 'Binding CheckOnly driver hashes');
  exactKeys(binding.checkOnlyReceipt.identity, IDENTITY_KEYS, 'Binding CheckOnly runner identity');
  exactKeys(binding.checkOnlyReceipt.knownFolders, KNOWN_FOLDER_KEYS, 'Binding CheckOnly known folders');
  exactKeys(binding.checkOnlyReceipt.profiles, PROFILE_KEYS, 'Binding CheckOnly profile paths');
  exactKeys(binding.checkOnlyReceipt.noLaunch, NO_LAUNCH_KEYS, 'Binding CheckOnly launch boundary');
  if (binding.stage.packageInventoryCount !== FIRST_LAUNCH_CANDIDATE.package.fileInventoryCount) {
    fail('Binding Stage inventory count differs from the pinned candidate.');
  }
  if (binding.stage.packageInventorySha256 !== PINNED_PACKAGE_INVENTORY_SHA256) {
    fail('Binding Stage inventory digest differs from the pinned candidate invoice.');
  }
  positiveInteger(binding.stage.packageInventoryCount, 'Binding Stage inventory count');
  requiredSha256(binding.stage.packageInventorySha256, 'Binding Stage inventory SHA-256');
  requiredSha256(binding.stage.sha256, 'Binding Stage SHA-256');
  requiredSha256(binding.checkOnlyReceipt.sha256, 'Binding CheckOnly receipt SHA-256');
  requiredSha256(binding.checkOnlyReceipt.stageSha256, 'Binding CheckOnly Stage SHA-256');
  requiredSha256(binding.checkOnlyReceipt.driverHashes.tauriDriverSha256, 'Binding Tauri driver SHA-256');
  requiredSha256(binding.checkOnlyReceipt.driverHashes.edgeDriverSha256, 'Binding EdgeDriver SHA-256');
  if (!SID.test(requiredString(binding.checkOnlyReceipt.identity.sid, 'Binding runner SID'))) {
    fail('Binding runner SID is malformed.');
  }
  if (!/^[0-9a-f]{32}$/.test(requiredString(binding.nonce, 'Binding nonce'))) {
    fail('Binding nonce must be 128-bit lowercase hexadecimal.');
  }
  utcTimestamp(binding.createdAtUtc, 'Binding creation time');
  utcTimestamp(binding.expiresAtUtc, 'Binding expiry time');
  return binding;
}

export function validateBinding(
  binding,
  { context, sourceHashes, stageBytes, checkOnlyReceiptBytes, now = Date.now() },
) {
  const checkedContext = validateContext(context);
  validateBindingShape(binding);
  const currentTime = nowMilliseconds(now);
  const { createdAtMs } = validateTimes(binding, currentTime);
  const currentSources = validateSourceHashes(sourceHashes);
  for (const key of GATE_IDENTITY_KEYS) {
    if (binding.gate[key] !== checkedContext[key])
      fail('Binding gate identity differs from the current run.');
  }
  assertEqual(binding.gate.sourceHashes, currentSources, 'Binding source hash inventory');
  if (binding.gate.gateRunId === FIRST_LAUNCH_CANDIDATE.candidateBuildRunId) {
    fail('Gate run ID must be distinct from the candidate build run ID.');
  }
  const stage = validateStage(stageBytes, checkedContext);
  const receipt = validateCheckOnlyReceipt(checkOnlyReceiptBytes, stageBytes, stage, checkedContext);
  assertStageTimestamps(stage, receipt, createdAtMs);
  assertEqual(binding.stage, stageSummary(stage, stageBytes), 'Binding Stage summary');
  assertEqual(
    binding.checkOnlyReceipt,
    checkOnlyReceiptSummary(receipt, checkOnlyReceiptBytes),
    'Binding CheckOnly summary',
  );
  return deepFreeze({
    gateRunId: checkedContext.gateRunId,
    gateRunAttempt: checkedContext.gateRunAttempt,
    candidateBuildRunId: FIRST_LAUNCH_CANDIDATE.candidateBuildRunId,
    candidateBuildRunAttempt: FIRST_LAUNCH_CANDIDATE.candidateBuildRunAttempt,
    nonce: binding.nonce,
    createdAtUtc: binding.createdAtUtc,
    expiresAtUtc: binding.expiresAtUtc,
    stageSha256: binding.stage.sha256,
    checkOnlyReceiptSha256: binding.checkOnlyReceipt.sha256,
  });
}

function parseJsonBytes(bytes, label) {
  if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)) {
    fail(label + ' must be supplied as exact bytes.');
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    fail(label + ' is missing or invalid JSON.');
  }
  if (!isPlainObject(parsed)) fail(label + ' must contain a JSON object.');
  return parsed;
}

function jsonBytes(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export function serializeBinding(binding) {
  validateBindingShape(binding);
  return jsonBytes(binding);
}

export function createBinding({
  context,
  sourceHashes,
  stageBytes,
  checkOnlyReceiptBytes,
  now = Date.now(),
}) {
  const checkedContext = validateContext(context);
  const currentTime = nowMilliseconds(now);
  const createdAtUtc = new Date(currentTime).toISOString();
  const expiresAtUtc = new Date(currentTime + WINDOWS_FIRST_LAUNCH_GATE.lifetimeMs).toISOString();
  const checkedSources = validateSourceHashes(sourceHashes);
  const stage = validateStage(stageBytes, checkedContext, { requireLocalRunnerTemp: true });
  const receipt = validateCheckOnlyReceipt(checkOnlyReceiptBytes, stageBytes, stage, checkedContext);
  assertStageTimestamps(stage, receipt, currentTime);
  const nonce = randomBytes(16).toString('hex');
  const binding = deepFreeze({
    schema: WINDOWS_FIRST_LAUNCH_GATE.schema,
    purpose: WINDOWS_FIRST_LAUNCH_GATE.purpose,
    executionPhase: WINDOWS_FIRST_LAUNCH_GATE.executionPhase,
    gate: deepFreeze({
      ...contextIdentity(checkedContext),
      sourceHashes: checkedSources,
    }),
    candidateBuild: FIRST_LAUNCH_CANDIDATE,
    stage: stageSummary(stage, stageBytes),
    checkOnlyReceipt: checkOnlyReceiptSummary(receipt, checkOnlyReceiptBytes),
    nonce,
    createdAtUtc,
    expiresAtUtc,
  });
  validateBinding(binding, {
    context: checkedContext,
    sourceHashes: checkedSources,
    stageBytes,
    checkOnlyReceiptBytes,
    now: currentTime,
  });
  const payloadBytes = serializeBinding(binding);
  return Object.freeze({
    binding,
    payloadBytes,
    payloadSha256: sha256FromWindowsRunGate(payloadBytes),
  });
}

export function parseTrustedBindingPayload(bytes, expectedSha256) {
  try {
    const parsed = parseTrustedBindingPayloadFromWindowsRunGate(bytes, expectedSha256);
    validateBindingShape(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof FirstLaunchGateError) throw error;
    fail('Trusted binding payload failed its integrity check.');
  }
}

export function validateActionsArtifactMetadata(metadata, expected) {
  exactKeys(expected, ARTIFACT_EXPECTED_KEYS, 'Expected Actions artifact metadata');
  if (expected.repository !== WINDOWS_FIRST_LAUNCH_GATE.repository) {
    fail('Actions artifact repository is not authorized.');
  }
  const artifactId = requiredRunId(String(expected.artifactId), 'Expected artifact ID');
  const workflowRunId = requiredRunId(String(expected.workflowRunId), 'Expected workflow run ID');
  const artifactDigest = requiredDigest(expected.artifactDigest, 'Expected artifact digest');
  const artifactSizeBytes = positiveInteger(expected.artifactSizeBytes, 'Expected artifact size');
  requiredString(expected.artifactName, 'Expected artifact name');
  requiredSha40(expected.sourceSha, 'Expected workflow source SHA');
  requiredString(expected.sourceBranch, 'Expected workflow source branch');
  if (!isPlainObject(metadata)) fail('Actions artifact metadata must be an object.');
  if (String(metadata.id) !== artifactId) fail('Actions artifact ID differs from the expected ID.');
  if (metadata.name !== expected.artifactName) fail('Actions artifact name differs from the expected name.');
  if (metadata.digest !== artifactDigest) fail('Actions artifact digest differs from the expected digest.');
  if (metadata.size_in_bytes !== artifactSizeBytes)
    fail('Actions artifact size differs from the expected size.');
  if (metadata.expired !== false) fail('Actions artifact is expired or has an unknown expiry state.');
  const workflowRun = metadata.workflow_run;
  if (!isPlainObject(workflowRun)) fail('Actions artifact has no workflow run identity.');
  if (String(workflowRun.id) !== workflowRunId) {
    fail('Actions artifact workflow run ID differs from the expected run.');
  }
  if (workflowRun.head_sha !== expected.sourceSha) {
    fail('Actions artifact workflow source SHA differs from the expected SHA.');
  }
  if (workflowRun.head_branch !== expected.sourceBranch) {
    fail('Actions artifact workflow source branch differs from the expected branch.');
  }
  return true;
}

export function validateActionsWorkflowRunMetadata(metadata, expected) {
  exactKeys(expected, WORKFLOW_RUN_EXPECTED_KEYS, 'Expected Actions workflow run');
  if (expected.repository !== WINDOWS_FIRST_LAUNCH_GATE.repository) {
    fail('Actions workflow run repository is not authorized.');
  }
  const runId = requiredRunId(String(expected.gateRunId), 'Expected gate run ID');
  if (expected.gateRunAttempt !== '1') fail('Expected gate run attempt must be 1.');
  requiredSha40(expected.sourceSha, 'Expected gate source SHA');
  requiredString(expected.branch, 'Expected gate branch');
  if (expected.branch !== WINDOWS_FIRST_LAUNCH_GATE.branch) {
    fail('Expected workflow run branch is not authorized.');
  }
  if (expected.event !== WINDOWS_FIRST_LAUNCH_GATE.event) fail('Expected workflow event is not authorized.');
  if (expected.workflowPath !== WINDOWS_FIRST_LAUNCH_GATE.workflowPath) {
    fail('Expected workflow path is not authorized.');
  }
  if (!isPlainObject(metadata)) fail('Actions workflow run metadata must be an object.');
  if (String(metadata.id) !== runId || String(metadata.run_attempt) !== '1') {
    fail('Actions workflow run ID or attempt differs from the expected run.');
  }
  if (metadata.head_sha !== expected.sourceSha || metadata.head_branch !== expected.branch) {
    fail('Actions workflow run source identity differs from the expected source.');
  }
  if (metadata.event !== expected.event || metadata.path !== expected.workflowPath) {
    fail('Actions workflow run event or path differs from the expected workflow.');
  }
  if (metadata.repository?.full_name !== expected.repository) {
    fail('Actions workflow run repository differs from the expected repository.');
  }
  return true;
}

async function assertRealDirectory(directory, label, { testFilesystemBacking = false } = {}) {
  let info;
  try {
    info = await lstat(directory);
  } catch {
    fail(label + ' is unavailable.');
  }
  if (!info.isDirectory() || info.isSymbolicLink()) fail(label + ' is not a real directory.');
  let real;
  try {
    real = await realpath(directory);
  } catch {
    fail(label + ' cannot be resolved safely.');
  }
  if (testFilesystemBacking) {
    if (
      process.platform === 'win32' ||
      !path.isAbsolute(directory) ||
      path.resolve(real) !== path.resolve(directory)
    ) {
      fail(label + ' resolves through a test backing alias.');
    }
  } else if (!samePath(real, directory)) {
    fail(label + ' resolves through a path alias.');
  }
}

export async function createTestFilesystemBacking(directory) {
  if (process.platform === 'win32') fail('Test filesystem backing is unavailable on Windows.');
  const root = requiredString(directory, 'Test filesystem backing root');
  if (!path.isAbsolute(root) || path.normalize(root) !== root) {
    fail('Test filesystem backing root must be a normalized absolute POSIX path.');
  }
  await assertRealDirectory(root, 'Test filesystem backing root', { testFilesystemBacking: true });
  return Object.freeze({ [TEST_FILESYSTEM_BACKING]: true, root });
}

function mapWindowsPathToTestBacking(testFilesystemBacking, runnerTemp, candidate) {
  if (!testFilesystemBacking) return candidate;
  if (testFilesystemBacking[TEST_FILESYSTEM_BACKING] !== true) {
    fail('Test filesystem backing was not created by the test seam.');
  }
  const relative = path.win32.relative(runnerTemp, candidate);
  if (path.win32.isAbsolute(relative) || relative === '..' || relative.startsWith('..\\')) {
    fail('Claim path escapes the test filesystem backing.');
  }
  return relative === ''
    ? testFilesystemBacking.root
    : path.join(testFilesystemBacking.root, ...relative.split('\\'));
}

export async function claimFirstLaunchOnce({
  context,
  binding,
  bindingPayloadBytes,
  bindingPayloadSha256,
  sourceHashes,
  stageBytes,
  checkOnlyReceiptBytes,
  testFilesystemBacking,
  now = Date.now(),
}) {
  const checkedContext = validateContext(context);
  const trustedPayloadSha256 = requiredSha256(bindingPayloadSha256, 'Trusted binding payload SHA-256');
  const checked = validateBinding(binding, {
    context: checkedContext,
    sourceHashes,
    stageBytes,
    checkOnlyReceiptBytes,
    now,
  });
  if (!(Buffer.isBuffer(bindingPayloadBytes) || bindingPayloadBytes instanceof Uint8Array)) {
    fail('Binding claim requires the exact payload bytes.');
  }
  const payloadBytes = Buffer.from(bindingPayloadBytes);
  const payloadSha256 = sha256FromWindowsRunGate(payloadBytes);
  if (payloadSha256 !== trustedPayloadSha256) {
    fail('Binding claim payload does not match its trusted SHA-256.');
  }
  const parsed = parseTrustedBindingPayload(payloadBytes, trustedPayloadSha256);
  assertEqual(parsed, binding, 'Claim payload');
  if (checked.gateRunId !== checkedContext.gateRunId) fail('Claim gate run ID is inconsistent.');
  const claimPath = firstLaunchClaimPath(checkedContext);
  const controlDirectory = path.win32.dirname(claimPath);
  const filesystemTempRoot = testFilesystemBacking
    ? mapWindowsPathToTestBacking(
        testFilesystemBacking,
        checkedContext.runner.tempRoot,
        checkedContext.runner.tempRoot,
      )
    : checkedContext.runner.tempRoot;
  const filesystemControlDirectory = mapWindowsPathToTestBacking(
    testFilesystemBacking,
    checkedContext.runner.tempRoot,
    controlDirectory,
  );
  const filesystemClaimPath = mapWindowsPathToTestBacking(
    testFilesystemBacking,
    checkedContext.runner.tempRoot,
    claimPath,
  );
  await assertRealDirectory(filesystemTempRoot, 'RUNNER_TEMP', {
    testFilesystemBacking: Boolean(testFilesystemBacking),
  });
  await assertRealDirectory(filesystemControlDirectory, 'First launch control directory', {
    testFilesystemBacking: Boolean(testFilesystemBacking),
  });
  if (!pathContains(checkedContext.runner.tempRoot, controlDirectory, false)) {
    fail('Claim path escapes RUNNER_TEMP.');
  }
  const receipt = deepFreeze({
    schema: WINDOWS_FIRST_LAUNCH_GATE.claimSchema,
    authority: 'local-claim-only',
    environmentApprovalVerified: false,
    gateRunId: checkedContext.gateRunId,
    gateRunAttempt: checkedContext.gateRunAttempt,
    bindingPayloadSha256: payloadSha256,
    nonce: binding.nonce,
    claimedAtUtc: new Date(nowMilliseconds(now)).toISOString(),
  });
  exactKeys(receipt, CLAIM_KEYS, 'Local claim receipt');
  const receiptSha256 = await claimFileOnceFromWindowsRunGate(filesystemClaimPath, receipt);
  return deepFreeze({ path: claimPath, receipt, receiptSha256 });
}
