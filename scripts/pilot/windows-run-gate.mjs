import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const WINDOWS_RUN_GATE = Object.freeze({
  repository: 'hodeliun/Morrow',
  branch: 'codex/e003-g07-windows-runtime',
  workflowPath: '.github/workflows/pilot-windows-runtime.yml',
  workflowRef:
    'hodeliun/Morrow/.github/workflows/pilot-windows-runtime.yml@refs/heads/codex/e003-g07-windows-runtime',
  environment: 'morrow-e003-windows-pilot',
  scenario: 'protected-check-only',
  artifactPrefix: 'morrow-e003-issue181-binding',
  schema: 'morrow.e003.g13.issue181.binding.v1',
  lifetimeMs: 2 * 60 * 60 * 1000,
  package: Object.freeze({
    repository: 'hodeliun/Morrow',
    runId: '43854570751',
    runAttempt: '1',
    sourceSha: '9d6d264828d9be8dd393f13d922f25bec1fe74b5',
    sourceTree: 'df94a7bafd5eb60bda5cbcf6f2fc112b3cff4709',
    sourceBranch: 'pilot/e003-polaris-dados-2.0',
    artifactId: '14221286819',
    artifactDigest: 'sha256:7ac7898e93f3c6b81cc0be80b20db3f7c4be2b540ebf95365a6f370f75560d7d',
    outerSha256: '7ac7898e93f3c6b81cc0be80b20db3f7c4be2b540ebf95365a6f370f75560d7d',
    sourceExeSha256: 'c7dc0677a1fa254d08eb06856956a23e7f4729d27793b6a8cc65cc39282b68d3',
  }),
  sourcePaths: Object.freeze([
    '.github/workflows/pilot-windows-runtime.yml',
    'scripts/pilot/windows-run-gate.mjs',
    'scripts/pilot/windows-run-gate.test.mjs',
    'scripts/pilot/windows-run-gate.independent.test.mjs',
    'scripts/pilot/windows-preflight.ps1',
    'scripts/pilot/windows-preflight.test.ps1',
    'scripts/pilot/windows-process.ps1',
    'scripts/pilot/windows-process.test.ps1',
    'scripts/pilot/windows-process.independent.test.ps1',
    'scripts/pilot/windows-runtime.mjs',
    'scripts/pilot/windows-runtime.test.mjs',
    'scripts/pilot/windows-runtime.independent.test.mjs',
    'scripts/pilot/webdriver-client.mjs',
    'scripts/pilot/webdriver-client.test.mjs',
    'scripts/pilot/webdriver-client.independent.test.mjs',
  ]),
});

const HEX_40 = /^[0-9a-f]{40}$/i;
const HEX_64 = /^[0-9a-f]{64}$/i;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const API_VERSION = '2022-11-28';
const OFFICIAL_EDGE_DRIVER_PAGE_URL = 'https://developer.microsoft.com/en-us/microsoft-edge/tools/webdriver';
const OFFICIAL_EDGE_DRIVER_CATALOG_URL = 'https://msedgedriver.microsoft.com/listing.json';
const EDGE_CATALOG_PROVENANCE_FIELDS = Object.freeze([
  'catalogGeneratedAt',
  'catalogSizeBytes',
  'catalogItemCount',
  'catalogSha256',
]);
const EDGE_SELECTED_IDENTITY_FIELDS = Object.freeze([
  'version',
  'runtimeVersion',
  'compatibleFirstThreeComponents',
  'source',
  'sourcePageUrl',
  'sourceCatalogUrl',
  'downloadUrl',
  'responseUrl',
  'contentType',
  'selectedLastModified',
  'expectedArchiveBytes',
  'archiveSizeBytes',
  'archiveSha256',
  'executableSha256',
]);
const EDGE_TIMESTAMP_FIELDS = new Set(['catalogGeneratedAt', 'selectedLastModified']);

function fail(message) {
  throw new Error(message);
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} is missing.`);
  return value;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) fail(`${label} does not match the authorized value.`);
}

function parsePreciseInstant(value, label) {
  const timestamp = requireString(value, label);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,100}))?(Z|[+-]\d{2}:\d{2})$/.exec(
    timestamp,
  );
  if (!match) fail(`${label} is malformed.`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysPerMonth = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysPerMonth[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    fail(`${label} is malformed.`);
  }
  const wallClock = `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}`;
  const wallClockMilliseconds = Date.parse(`${wallClock}Z`);
  if (
    !Number.isFinite(wallClockMilliseconds) ||
    new Date(wallClockMilliseconds).toISOString().slice(0, 19) !== wallClock
  ) {
    fail(`${label} is malformed.`);
  }
  let offsetSeconds = 0;
  if (zone !== 'Z') {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMinutes = Number(zone.slice(4, 6));
    if (offsetHours > 14 || offsetMinutes > 59 || (offsetHours === 14 && offsetMinutes !== 0)) {
      fail(`${label} has an invalid UTC offset.`);
    }
    const direction = zone[0] === '+' ? 1 : -1;
    offsetSeconds = direction * (offsetHours * 60 + offsetMinutes) * 60;
  }
  return Object.freeze({
    utcSeconds: BigInt(Math.trunc(wallClockMilliseconds / 1000)) - BigInt(offsetSeconds),
    fraction: fraction.replace(/0+$/, ''),
  });
}

function assertSamePreciseInstant(actual, expected, label) {
  const actualInstant = parsePreciseInstant(actual, `${label} actual timestamp`);
  const expectedInstant = parsePreciseInstant(expected, `${label} authorized timestamp`);
  const precision = Math.max(actualInstant.fraction.length, expectedInstant.fraction.length);
  const actualFraction = BigInt((actualInstant.fraction || '').padEnd(precision, '0') || '0');
  const expectedFraction = BigInt((expectedInstant.fraction || '').padEnd(precision, '0') || '0');
  if (actualInstant.utcSeconds !== expectedInstant.utcSeconds || actualFraction !== expectedFraction) {
    fail(`${label} does not match the authorized instant.`);
  }
}

function assertEdgeFieldsEqual(actual, expected, fields, label) {
  for (const field of fields) {
    if (EDGE_TIMESTAMP_FIELDS.has(field)) {
      assertSamePreciseInstant(actual[field], expected[field], `${label} ${field}`);
    } else {
      assertEqual(actual[field], expected[field], `${label} ${field}`);
    }
  }
}

function assertHex(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${label} is not a valid hexadecimal digest.`);
  return value.toLowerCase();
}

function normalizeDigest(value, label = 'artifact digest') {
  const digest = requireString(value, label)
    .replace(/^sha256:/i, '')
    .toLowerCase();
  return assertHex(digest, HEX_64, label);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function safeRunContext(env, { requireWindowsRunner = true, requireFirstAttempt = true } = {}) {
  requireObject(env, 'GitHub environment');
  const context = {
    repository: requireString(env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY'),
    runId: requireString(env.GITHUB_RUN_ID, 'GITHUB_RUN_ID'),
    attempt: requireString(env.GITHUB_RUN_ATTEMPT, 'GITHUB_RUN_ATTEMPT'),
    sha: requireString(env.GITHUB_SHA, 'GITHUB_SHA').toLowerCase(),
    ref: requireString(env.GITHUB_REF, 'GITHUB_REF'),
    event: requireString(env.GITHUB_EVENT_NAME, 'GITHUB_EVENT_NAME'),
    workflowRef: requireString(env.GITHUB_WORKFLOW_REF, 'GITHUB_WORKFLOW_REF'),
    runnerTemp: requireString(env.RUNNER_TEMP, 'RUNNER_TEMP'),
    workspace: requireString(env.GITHUB_WORKSPACE, 'GITHUB_WORKSPACE'),
    runnerOs: env.RUNNER_OS ?? '',
    runnerArch: env.RUNNER_ARCH ?? '',
  };
  assertEqual(context.repository, WINDOWS_RUN_GATE.repository, 'Repository');
  if (!RUN_ID.test(context.runId)) fail('Workflow run ID is malformed.');
  assertHex(context.sha, HEX_40, 'Source commit SHA');
  assertEqual(context.ref, `refs/heads/${WINDOWS_RUN_GATE.branch}`, 'Workflow ref');
  assertEqual(context.event, 'push', 'Workflow event');
  assertEqual(context.workflowRef, WINDOWS_RUN_GATE.workflowRef, 'Workflow source ref');
  if (requireFirstAttempt) assertEqual(context.attempt, '1', 'Workflow run attempt');
  else if (!/^[1-9][0-9]*$/.test(context.attempt)) fail('Workflow run attempt is malformed.');
  if (requireWindowsRunner) {
    assertEqual(context.runnerOs, 'Windows', 'Runner operating system');
    assertEqual(context.runnerArch, 'X64', 'Runner architecture');
    assertWindowsLocalPath(context.runnerTemp, 'RUNNER_TEMP');
    assertWindowsLocalPath(context.workspace, 'GITHUB_WORKSPACE');
  }
  return Object.freeze(context);
}

export function assertWindowsLocalPath(value, label = 'Path') {
  const candidate = requireString(value, label);
  if (candidate.includes('/') || candidate.includes('\0') || candidate.startsWith('\\')) {
    fail(`${label} must be a normalized local-drive path.`);
  }
  if (!/^[A-Za-z]:\\/.test(candidate)) fail(`${label} must be rooted on a local drive.`);
  const normalized = path.win32.normalize(candidate);
  if (normalized !== candidate || candidate.endsWith('\\')) fail(`${label} is not normalized.`);
  const tail = candidate.slice(3);
  const segments = tail.split('\\');
  if (segments.some((part) => !part || part === '.' || part === '..' || part.includes(':'))) {
    fail(`${label} contains an empty, dot, or alternate-stream component.`);
  }
  for (const segment of segments) {
    const hasInvalidCharacter = [...segment].some(
      (character) => character.charCodeAt(0) < 32 || '<>"|?*'.includes(character),
    );
    if (segment.endsWith('.') || segment.endsWith(' ') || hasInvalidCharacter) {
      fail(`${label} contains a Windows path alias or invalid character.`);
    }
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(segment)) {
      fail(`${label} contains a reserved Windows path component.`);
    }
  }
  return candidate;
}

export function assertRunnerTempOutsideWorkspace(runnerTemp, workspace) {
  const relative = path.win32.relative(workspace, runnerTemp);
  if (
    relative === '' ||
    (!relative.startsWith('..\\') && relative !== '..' && !path.win32.isAbsolute(relative))
  ) {
    fail('RUNNER_TEMP must be outside the checkout.');
  }
  return true;
}

export function expectedArtifactName(context) {
  return `${WINDOWS_RUN_GATE.artifactPrefix}-${context.runId}-${context.attempt}-${context.sha}`;
}

export function expectedRelativePaths(context) {
  const suffix = `${context.runId}-${context.attempt}`;
  return Object.freeze({
    prepareControl: `issue-179-control-${suffix}`,
    prepareToolStage: `issue-179-tools-${suffix}`,
    protectedControl: `issue-179-control-${suffix}`,
    protectedToolStage: `issue-179-tools-${suffix}`,
    gateControl: `issue-181-control-${suffix}`,
    binding: `issue-181-binding-${suffix}`,
    downloadedBinding: `issue-181-input-${suffix}`,
    approvedDriver: `issue-181-approved-driver-${suffix}\\tauri-driver.exe`,
    audit: `issue-181-audit-${suffix}`,
  });
}

export function validatePackagePin(metadata) {
  requireObject(metadata, 'Pinned package metadata');
  for (const field of [
    'repository',
    'runId',
    'runAttempt',
    'sourceSha',
    'sourceTree',
    'sourceBranch',
    'artifactId',
    'artifactDigest',
    'outerSha256',
    'sourceExeSha256',
  ]) {
    requireString(metadata[field], `Package ${field}`);
  }
  for (const field of [
    'repository',
    'runId',
    'runAttempt',
    'sourceSha',
    'sourceTree',
    'sourceBranch',
    'artifactId',
  ]) {
    assertEqual(metadata[field], WINDOWS_RUN_GATE.package[field], `Pinned package ${field}`);
  }
  assertEqual(
    normalizeDigest(metadata.artifactDigest),
    normalizeDigest(WINDOWS_RUN_GATE.package.artifactDigest),
    'Pinned package artifact digest',
  );
  assertEqual(
    assertHex(metadata.outerSha256, HEX_64, 'Pinned package outer SHA-256'),
    WINDOWS_RUN_GATE.package.outerSha256,
    'Pinned package outer SHA-256',
  );
  assertEqual(
    assertHex(metadata.sourceExeSha256, HEX_64, 'Pinned package executable SHA-256'),
    WINDOWS_RUN_GATE.package.sourceExeSha256,
    'Pinned package executable SHA-256',
  );
  return Object.freeze({
    repository: metadata.repository,
    runId: metadata.runId,
    runAttempt: metadata.runAttempt,
    sourceSha: metadata.sourceSha,
    sourceTree: metadata.sourceTree,
    sourceBranch: metadata.sourceBranch,
    artifactId: metadata.artifactId,
    artifactDigest: metadata.artifactDigest,
    outerSha256: metadata.outerSha256,
    sourceExeSha256: metadata.sourceExeSha256,
  });
}

function validatedStagedTauriDriver(stage) {
  const staged = requireObject(stage.drivers?.tauriDriver, 'Staged tauri-driver provenance');
  assertEqual(staged.version, '2.1.0', 'Staged tauri-driver version');
  assertEqual(staged.source, 'crates.io', 'Staged tauri-driver source');
  assertEqual(
    staged.sourceUrl,
    'https://crates.io/crates/tauri-driver/2.1.0',
    'Staged tauri-driver source URL',
  );
  assertEqual(
    staged.downloadUrl,
    'https://crates.io/api/v1/crates/tauri-driver/2.1.0/download',
    'Staged tauri-driver crate URL',
  );
  assertEqual(
    staged.installCommand,
    'cargo install tauri-driver --version 2.1.0 --locked --root <tool-stage>',
    'Staged tauri-driver install command',
  );
  assertEqual(staged.installedBinaryName, 'tauri-driver.exe', 'Staged tauri-driver filename');
  assertEqual(staged.serviceStarted, false, 'Staged tauri-driver service state');
  const executableSha256 = assertHex(
    staged.executableSha256,
    HEX_64,
    'Approved tauri-driver executable SHA-256',
  );
  return Object.freeze({
    version: staged.version,
    source: staged.source,
    sourceUrl: staged.sourceUrl,
    downloadUrl: staged.downloadUrl,
    installedPackageMetadata: staged.installedPackageMetadata,
    installCommand: staged.installCommand,
    executableSha256,
    serviceStarted: false,
  });
}

function validatedTauriDriver(stage, receipt) {
  const staged = validatedStagedTauriDriver(stage);
  const checked = requireObject(receipt.drivers?.tauriDriver, 'Check-only tauri-driver provenance');
  assertEqual(checked.version, staged.version, 'Check-only tauri-driver version');
  assertEqual(checked.executableSha256, staged.executableSha256, 'Check-only tauri-driver executable hash');
  assertEqual(checked.serviceStarted, false, 'Check-only tauri-driver service state');
  return staged;
}

function validatedRuntimeSources(sources, runtimeVersion, label = 'Prepared WebView2 pv') {
  if (!Array.isArray(sources) || sources.length === 0) fail(`${label} observations are empty.`);
  for (const source of sources) {
    requireObject(source, `${label} source observation`);
    assertEqual(source.Version, runtimeVersion, `${label} source version`);
    requireString(source.RegistryPath, `${label} registry source`);
  }
  return sources;
}

function validatedEdgeDriver(edge, runtimeVersion, label = 'Prepared EdgeDriver') {
  requireObject(edge, `${label} provenance`);
  const version = requireString(edge.version, `${label} version`);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) fail(`${label} version is malformed.`);
  if (version.split('.').slice(0, 3).join('.') !== runtimeVersion.split('.').slice(0, 3).join('.')) {
    fail(`${label} and WebView2 pv versions are incompatible.`);
  }
  assertEqual(edge.source, 'Microsoft Edge WebDriver official download', `${label} source`);
  assertEqual(edge.sourcePageUrl, OFFICIAL_EDGE_DRIVER_PAGE_URL, `${label} official download page URL`);
  assertEqual(edge.sourceCatalogUrl, OFFICIAL_EDGE_DRIVER_CATALOG_URL, `${label} official catalog URL`);
  const officialDownloadUrl = `https://msedgedriver.microsoft.com/${version}/edgedriver_win64.zip`;
  assertEqual(edge.downloadUrl, officialDownloadUrl, `${label} official x64 download URL`);
  assertEqual(edge.responseUrl, officialDownloadUrl, `${label} official x64 response URL`);
  const contentType = requireString(edge.contentType, `${label} archive content type`);
  if (
    !['application/x-zip-compressed', 'application/zip', 'application/octet-stream'].includes(contentType)
  ) {
    fail(`${label} archive content type is not an approved ZIP type.`);
  }
  assertEqual(edge.runtimeVersion, runtimeVersion, `${label} WebView2 pv version`);
  const compatibleFirstThreeComponents = runtimeVersion.split('.').slice(0, 3).join('.');
  assertEqual(
    edge.compatibleFirstThreeComponents,
    compatibleFirstThreeComponents,
    `${label} compatible WebView2 pv components`,
  );
  const catalogGeneratedAt = requireString(edge.catalogGeneratedAt, `${label} catalog generation time`);
  parsePreciseInstant(catalogGeneratedAt, `${label} catalog generation time`);
  const selectedLastModified = requireString(
    edge.selectedLastModified,
    `${label} selected release modification time`,
  );
  parsePreciseInstant(selectedLastModified, `${label} selected release modification time`);
  const catalogSizeBytes = edge.catalogSizeBytes;
  if (
    !Number.isSafeInteger(catalogSizeBytes) ||
    catalogSizeBytes <= 0 ||
    catalogSizeBytes > 4 * 1024 * 1024
  ) {
    fail(`${label} catalog size is outside the authorized bounds.`);
  }
  const catalogItemCount = edge.catalogItemCount;
  if (!Number.isSafeInteger(catalogItemCount) || catalogItemCount <= 0 || catalogItemCount > 50_000) {
    fail(`${label} catalog item count is outside the authorized bounds.`);
  }
  const compatibleCandidateCount = edge.compatibleCandidateCount;
  if (
    !Number.isSafeInteger(compatibleCandidateCount) ||
    compatibleCandidateCount <= 0 ||
    compatibleCandidateCount > catalogItemCount
  ) {
    fail(`${label} compatible candidate count is invalid.`);
  }
  const expectedArchiveBytes = edge.expectedArchiveBytes;
  const archiveSizeBytes = edge.archiveSizeBytes;
  if (
    !Number.isSafeInteger(expectedArchiveBytes) ||
    expectedArchiveBytes <= 0 ||
    expectedArchiveBytes > 64 * 1024 * 1024
  ) {
    fail(`${label} expected archive size is outside the authorized bounds.`);
  }
  if (!Number.isSafeInteger(archiveSizeBytes) || archiveSizeBytes !== expectedArchiveBytes) {
    fail(`${label} downloaded archive size differs from the selected catalog entry.`);
  }
  const catalogSha256 = assertHex(edge.catalogSha256, HEX_64, `${label} catalog SHA-256`);
  const archiveSha256 = assertHex(edge.archiveSha256, HEX_64, `${label} archive SHA-256`);
  const executableSha256 = assertHex(edge.executableSha256, HEX_64, `${label} executable SHA-256`);
  assertEqual(edge.versionProbeExitCode, 0, `${label} version probe exit code`);
  assertEqual(edge.serviceStarted, false, `${label} service state`);
  return Object.freeze({
    version,
    source: edge.source,
    sourcePageUrl: edge.sourcePageUrl,
    sourceCatalogUrl: edge.sourceCatalogUrl,
    catalogGeneratedAt,
    catalogSizeBytes,
    catalogSha256,
    catalogItemCount,
    compatibleCandidateCount,
    compatibleFirstThreeComponents,
    selectedLastModified,
    runtimeVersion,
    downloadUrl: edge.downloadUrl,
    responseUrl: edge.responseUrl,
    contentType,
    expectedArchiveBytes,
    archiveSizeBytes,
    archiveSha256,
    executableSha256,
    versionProbeExitCode: 0,
    serviceStarted: false,
  });
}

function validatedStageRuntimeAndEdge(stage) {
  const runtimeVersion = requireString(stage.runtimeVersion, 'Prepared WebView2 pv version');
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(runtimeVersion)) fail('Prepared WebView2 pv version is malformed.');
  const runtimeSources = validatedRuntimeSources(stage.runtimeSources, runtimeVersion);
  const edgeDriver = validatedEdgeDriver(
    requireObject(stage.drivers?.edgeDriver, 'Prepared EdgeDriver provenance'),
    runtimeVersion,
  );
  return Object.freeze({
    webView2Pv: Object.freeze({ version: runtimeVersion, sources: runtimeSources }),
    edgeDriver,
  });
}

function validatedRuntimeAndEdge(stage, receipt) {
  const staged = validatedStageRuntimeAndEdge(stage);
  assertEqual(receipt.webView2Runtime?.version, staged.webView2Pv.version, 'Check-only WebView2 pv version');
  const checkedEdge = requireObject(receipt.drivers?.edgeDriver, 'Check-only EdgeDriver provenance');
  const checked = validatedStageRuntimeAndEdge({
    runtimeVersion: receipt.webView2Runtime.version,
    runtimeSources: receipt.webView2Runtime.sources,
    drivers: { edgeDriver: checkedEdge },
  });
  assertEdgeFieldsEqual(
    checked.edgeDriver,
    staged.edgeDriver,
    EDGE_SELECTED_IDENTITY_FIELDS,
    'Check-only EdgeDriver',
  );
  assertEdgeFieldsEqual(
    checked.edgeDriver,
    staged.edgeDriver,
    EDGE_CATALOG_PROVENANCE_FIELDS,
    'Check-only EdgeDriver',
  );
  if (JSON.stringify(receipt.webView2Runtime?.sources) !== JSON.stringify(staged.webView2Pv.sources)) {
    fail('Check-only WebView2 pv registry observations differ from Stage.');
  }
  return staged;
}

export function validateStage(stage, context) {
  requireObject(stage, 'Windows preflight stage manifest');
  assertEqual(stage.schemaVersion, 1, 'Stage schema version');
  assertEqual(stage.status, 'staged', 'Stage status');
  assertEqual(stage.scope, 'Morrow E003 G13 issue 185 tool/download stage only', 'Stage scope');
  assertEqual(stage.runId, context.runId, 'Stage run ID');
  assertEqual(stage.runAttempt, context.attempt, 'Stage attempt');
  assertEqual(stage.sha, context.sha, 'Stage source SHA');
  assertEqual(stage.branch, WINDOWS_RUN_GATE.branch, 'Stage branch');
  assertEqual(stage.appLaunched, false, 'Stage app launch state');
  assertEqual(stage.driverServiceStarted, false, 'Stage driver service state');
  const packageMetadata = validatePackagePin(stage.artifact);
  const stageCargo = requireObject(stage.drivers?.cargo, 'Staged Cargo provenance');
  const cargoVersion = requireString(stageCargo.version, 'Staged Cargo version');
  const cargoExecutableName = path.win32.basename(
    requireString(stageCargo.executable, 'Staged Cargo executable path'),
  );
  assertEqual(cargoExecutableName.toLowerCase(), 'cargo.exe', 'Staged Cargo executable name');
  const tauriDriver = validatedStagedTauriDriver(stage);
  const { webView2Pv, edgeDriver } = validatedStageRuntimeAndEdge(stage);
  return Object.freeze({
    package: packageMetadata,
    cargo: Object.freeze({ version: cargoVersion, executableName: cargoExecutableName }),
    tauriDriver,
    webView2Pv,
    edgeDriver,
  });
}

export function validatePreflight(stage, receipt, context) {
  const stageSummary = validateStage(stage, context);
  requireObject(receipt, 'Windows preflight check-only receipt');
  assertEqual(receipt.schemaVersion, 1, 'Check-only receipt schema version');
  assertEqual(receipt.status, 'passed', 'Check-only receipt status');
  assertEqual(receipt.scope, 'Morrow E003 G13 issue 185 preflight only', 'Check-only receipt scope');
  assertEqual(receipt.runId, context.runId, 'Check-only run ID');
  assertEqual(receipt.runAttempt, context.attempt, 'Check-only attempt');
  assertEqual(receipt.sha, context.sha, 'Check-only source SHA');
  assertEqual(receipt.branch, WINDOWS_RUN_GATE.branch, 'Check-only branch');
  assertEqual(receipt.appLaunched, false, 'Check-only app launch state');
  assertEqual(receipt.driverServiceStarted, false, 'Check-only driver service state');
  assertEqual(receipt.windowsRuntimeTested, false, 'Check-only Windows runtime state');
  assertEqual(receipt.guiTested, false, 'Check-only GUI state');
  if (
    receipt.plannedPaths?.newPathsCreatedByCheckOnly !== false ||
    receipt.plannedPaths?.profileObserved !== false
  ) {
    fail('Check-only changed or observed a planned user profile path.');
  }
  const packageMetadata = stageSummary.package;
  validatePackagePin(receipt.sourceArtifact);
  assertEqual(
    receipt.sourceArtifact.artifactId,
    packageMetadata.artifactId,
    'Check-only package artifact ID',
  );
  assertEqual(
    normalizeDigest(receipt.sourceArtifact.artifactDigest),
    normalizeDigest(packageMetadata.artifactDigest),
    'Check-only package artifact digest',
  );
  assertEqual(
    receipt.sourceArtifact.sourceExeSha256,
    packageMetadata.sourceExeSha256,
    'Check-only package executable SHA-256',
  );
  const checkOnlyPackage = requireObject(receipt.package, 'Check-only package receipt');
  const packageRun = requireObject(checkOnlyPackage.buildInfoRun, 'Check-only BUILD-INFO run');
  assertEqual(String(packageRun.id), packageMetadata.runId, 'Check-only BUILD-INFO run ID');
  assertEqual(String(packageRun.attempt), packageMetadata.runAttempt, 'Check-only BUILD-INFO run attempt');
  assertEqual(checkOnlyPackage.applicationVersion, '2.1.0', 'Check-only Morrow application version');
  assertEqual(
    checkOnlyPackage.pilotIdentifier,
    'app.morrow.polaris-dados-pilot',
    'Check-only pilot identifier',
  );
  assertEqual(checkOnlyPackage.pe?.sha256, packageMetadata.sourceExeSha256, 'Check-only executable SHA-256');
  const tauriDriver = validatedTauriDriver(stage, receipt);
  const stageCargo = requireObject(stage.drivers?.cargo, 'Staged Cargo provenance');
  const checkCargo = requireObject(receipt.drivers?.cargo, 'Check-only Cargo provenance');
  const cargoVersion = requireString(stageCargo.version, 'Staged Cargo version');
  assertEqual(checkCargo.version, cargoVersion, 'Check-only Cargo version');
  const cargoExecutableName = path.win32.basename(
    requireString(stageCargo.executable, 'Staged Cargo executable path'),
  );
  assertEqual(cargoExecutableName.toLowerCase(), 'cargo.exe', 'Staged Cargo executable name');
  assertEqual(
    path.win32
      .basename(requireString(checkCargo.executable, 'Check-only Cargo executable path'))
      .toLowerCase(),
    'cargo.exe',
    'Check-only Cargo executable name',
  );
  const { webView2Pv, edgeDriver } = validatedRuntimeAndEdge(stage, receipt);
  return Object.freeze({
    package: packageMetadata,
    cargo: stageSummary.cargo,
    tauriDriver,
    webView2Pv,
    edgeDriver,
  });
}

export async function hashSourceFiles(workspace, filePaths = WINDOWS_RUN_GATE.sourcePaths) {
  const root = path.resolve(workspace);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    fail('Source hash root is not a real checkout directory.');
  const entries = [];
  for (const relative of filePaths) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => part === '..')) {
      fail('Source hash list contains a path outside the checkout.');
    }
    const absolute = path.resolve(root, relative);
    const rel = path.relative(root, absolute);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
      fail('Source file escapes the checkout.');
    let current = root;
    const segments = relative.split(/[\\/]/);
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment);
      const component = await fs.lstat(current);
      if (component.isSymbolicLink())
        fail(`Source path crosses a symbolic link or reparse point: ${relative}`);
      if (index < segments.length - 1 && !component.isDirectory())
        fail(`Source path ancestor is not a directory: ${relative}`);
    }
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink())
      fail(`Source file is not a regular checkout file: ${relative}`);
    const realRoot = await fs.realpath(root);
    const realFile = await fs.realpath(absolute);
    const realRelative = path.relative(realRoot, realFile);
    if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
      fail(`Source file resolves outside the checkout: ${relative}`);
    }
    const bytes = await fs.readFile(absolute);
    entries.push(
      Object.freeze({
        path: relative.replaceAll('\\', '/'),
        sha256: sha256(bytes),
        sizeBytes: bytes.byteLength,
      }),
    );
  }
  return Object.freeze(entries);
}

function assertSourceHashes(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== WINDOWS_RUN_GATE.sourcePaths.length)
    fail('Binding source hash inventory has the wrong length.');
  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry.sha256]));
  const seen = new Set();
  for (const entry of actual) {
    requireObject(entry, 'Binding source hash entry');
    if (!expectedByPath.has(entry.path) || seen.has(entry.path))
      fail('Binding source hash inventory has an unexpected or duplicate path.');
    assertEqual(
      assertHex(entry.sha256, HEX_64, `Source hash for ${entry.path}`),
      expectedByPath.get(entry.path),
      `Source file ${entry.path}`,
    );
    seen.add(entry.path);
  }
  if (seen.size !== expectedByPath.size) fail('Binding source hash inventory is incomplete.');
}

function validateTimeWindow(binding, now = Date.now()) {
  const created = Date.parse(requireString(binding.createdAtUtc, 'Binding creation time'));
  const expires = Date.parse(requireString(binding.expiresAtUtc, 'Binding expiry time'));
  if (!Number.isFinite(created) || !Number.isFinite(expires)) fail('Binding timestamps are malformed.');
  if (expires - created !== WINDOWS_RUN_GATE.lifetimeMs)
    fail('Binding lifetime is not the authorized two-hour window.');
  if (created > now + 5 * 60 * 1000) fail('Binding creation time is too far in the future.');
  if (now >= expires) fail('The immutable run binding has expired.');
}

export function validateBinding(binding, context, currentSourceHashes, now = Date.now()) {
  requireObject(binding, 'Immutable run binding');
  if (Object.hasOwn(binding, 'bindingArtifactId') || Object.hasOwn(binding, 'bindingArtifactDigest')) {
    fail('The binding cannot contain its own Actions artifact ID or digest.');
  }
  assertEqual(binding.schema, WINDOWS_RUN_GATE.schema, 'Binding schema');
  assertEqual(binding.scenario, WINDOWS_RUN_GATE.scenario, 'Binding scenario');
  requireObject(binding.run, 'Binding run identity');
  assertEqual(binding.run.id, context.runId, 'Binding run ID');
  assertEqual(binding.run.attempt, '1', 'Binding run attempt');
  assertEqual(binding.run.repository, WINDOWS_RUN_GATE.repository, 'Binding repository');
  assertEqual(binding.run.ref, `refs/heads/${WINDOWS_RUN_GATE.branch}`, 'Binding ref');
  assertEqual(binding.run.event, 'push', 'Binding event');
  assertEqual(binding.run.sha, context.sha, 'Binding source SHA');
  assertEqual(binding.run.workflowRef, WINDOWS_RUN_GATE.workflowRef, 'Binding workflow ref');
  const nonce = requireString(binding.nonce, 'Binding nonce');
  if (!/^[0-9a-f]{32}$/.test(nonce)) fail('Binding nonce is not 128 bits of lowercase hexadecimal.');
  validateTimeWindow(binding, now);
  const sourceFiles = requireObject(binding.sourceFiles, 'Binding source file hashes');
  assertSourceHashes(sourceFiles.files, currentSourceHashes);
  const packagePin = validatePackagePin(binding.package);
  const driver = requireObject(binding.approvedDriver, 'Approved tauri-driver provenance');
  assertEqual(driver.version, '2.1.0', 'Approved tauri-driver version');
  assertEqual(
    assertHex(driver.sha256, HEX_64, 'Approved tauri-driver SHA-256'),
    assertHex(binding.preflight?.tauriDriver?.executableSha256, HEX_64, 'Prepared tauri-driver SHA-256'),
    'Approved driver provenance hash',
  );
  assertEqual(
    driver.source,
    binding.preflight?.tauriDriver?.source,
    'Approved tauri-driver source provenance',
  );
  assertEqual(
    driver.installCommand,
    binding.preflight?.tauriDriver?.installCommand,
    'Approved tauri-driver install provenance',
  );
  assertEqual(driver.cargoVersion, binding.preflight?.cargo?.version, 'Approved driver Cargo provenance');
  assertEqual(driver.serviceStarted, false, 'Approved driver service state');
  assertEqual(driver.filename, 'tauri-driver.exe', 'Approved driver filename');
  const prepared = requireObject(binding.preflight, 'Binding prepared preflight');
  assertEqual(prepared.checkOnlyStatus, 'passed', 'Prepared check-only status');
  assertHex(prepared.stageSha256, HEX_64, 'Prepared stage manifest SHA-256');
  assertHex(prepared.checkOnlyReceiptSha256, HEX_64, 'Prepared check-only receipt SHA-256');
  assertEqual(prepared.appLaunched, false, 'Prepared app launch state');
  assertEqual(prepared.driverServiceStarted, false, 'Prepared driver service state');
  assertEqual(prepared.guiTested, false, 'Prepared GUI state');
  const webView2PvVersion = requireString(prepared.webView2Pv?.version, 'Bound WebView2 pv version');
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(webView2PvVersion)) fail('Bound WebView2 pv version is malformed.');
  const webView2PvSources = validatedRuntimeSources(
    prepared.webView2Pv?.sources,
    webView2PvVersion,
    'Bound WebView2 pv',
  );
  const cargo = Object.freeze({
    version: requireString(prepared.cargo?.version, 'Bound Cargo version'),
    executableName: requireString(prepared.cargo?.executableName, 'Bound Cargo executable name'),
  });
  assertEqual(cargo.executableName.toLowerCase(), 'cargo.exe', 'Bound Cargo executable name');
  const edgeDriver = validatedEdgeDriver(prepared.edgeDriver, webView2PvVersion, 'Bound EdgeDriver');
  assertEqual(prepared.package?.artifactId, packagePin.artifactId, 'Bound prepared package artifact ID');
  assertEqual(prepared.package?.sourceTree, packagePin.sourceTree, 'Bound prepared package source tree');
  assertEqual(
    normalizeDigest(prepared.package?.artifactDigest),
    normalizeDigest(packagePin.artifactDigest),
    'Bound prepared package digest',
  );
  assertEqual(binding.procedurePaths?.scenario, WINDOWS_RUN_GATE.scenario, 'Procedure path scenario');
  assertEqual(binding.artifactName, expectedArtifactName(context), 'Binding artifact name');
  return Object.freeze({
    package: packagePin,
    driver,
    cargo,
    webView2Pv: Object.freeze({ version: webView2PvVersion, sources: webView2PvSources }),
    edgeDriver,
  });
}

export function validateArtifactApiMetadata(metadata, { context, artifactId, artifactDigest, artifactName }) {
  requireObject(metadata, 'Actions artifact metadata');
  assertEqual(String(metadata.id), String(artifactId), 'Actions artifact ID');
  assertEqual(metadata.name, artifactName, 'Actions artifact name');
  assertEqual(metadata.expired, false, 'Actions artifact expiry state');
  assertEqual(normalizeDigest(metadata.digest), normalizeDigest(artifactDigest), 'Actions artifact digest');
  assertEqual(String(metadata.workflow_run?.id), context.runId, 'Actions artifact workflow run ID');
  assertEqual(metadata.workflow_run?.head_sha, context.sha, 'Actions artifact workflow source SHA');
  assertEqual(
    metadata.workflow_run?.head_branch,
    WINDOWS_RUN_GATE.branch,
    'Actions artifact workflow branch',
  );
  return true;
}

function apiHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': API_VERSION,
  };
}

export async function fetchArtifactMetadata({ token, artifactId, fetchImpl = globalThis.fetch }) {
  requireString(token, 'Read-only GITHUB_TOKEN');
  if (!/^[1-9][0-9]{0,19}$/.test(String(artifactId))) fail('Actions artifact ID is malformed.');
  if (typeof fetchImpl !== 'function') fail('Node fetch is unavailable for the read-only artifact lookup.');
  const url = `https://api.github.com/repos/${WINDOWS_RUN_GATE.repository}/actions/artifacts/${artifactId}`;
  const response = await fetchImpl(url, { headers: apiHeaders(token) });
  if (!response.ok) fail(`Read-only Actions artifact lookup failed with HTTP ${response.status}.`);
  return response.json();
}

function isInsideWindowsPath(root, candidate) {
  const relative = path.win32.relative(root, candidate);
  return (
    relative === '' || (!path.win32.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..\\'))
  );
}

function validateProcedurePaths(context) {
  assertRunnerTempOutsideWorkspace(context.runnerTemp, context.workspace);
  const relative = expectedRelativePaths(context);
  const temp = context.runnerTemp.replace(/[\\]+$/, '');
  const paths = Object.fromEntries(
    Object.entries(relative).map(([key, value]) => [key, path.win32.join(temp, value)]),
  );
  for (const candidate of [
    paths.gateControl,
    paths.binding,
    paths.downloadedBinding,
    paths.approvedDriver,
    paths.audit,
  ]) {
    if (!isInsideWindowsPath(temp, candidate)) fail('A gate procedure path escapes RUNNER_TEMP.');
    assertWindowsLocalPath(candidate, 'Gate procedure path');
  }
  const toolStage = path.win32.join(temp, relative.protectedToolStage);
  if (paths.approvedDriver.toLowerCase().startsWith(`${toolStage.toLowerCase()}\\`)) {
    fail('Approved driver path would overwrite the protected local tool stage.');
  }
  return Object.freeze({ ...paths, relative });
}

async function assertNoReparsePath(absolute, label, { allowMissingLeaf = false } = {}) {
  const candidate = assertWindowsLocalPath(absolute, label);
  const parsed = path.win32.parse(candidate);
  const segments = candidate.slice(parsed.root.length).split('\\');
  let current = parsed.root;
  for (const segment of segments) {
    if (!segment) continue;
    current = path.win32.join(current, segment);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (allowMissingLeaf && error?.code === 'ENOENT' && current.toLowerCase() === candidate.toLowerCase())
        return candidate;
      if (error?.code === 'ENOENT') fail(`${label} has a missing path parent.`);
      throw error;
    }
    if (stat.isSymbolicLink()) fail(`${label} crosses a symbolic link or junction.`);
    const real = await fs.realpath(current);
    const comparable = (value) =>
      path.win32
        .normalize(value.replace(/^\\\\\?\\/, ''))
        .replace(/[\\]+$/, '')
        .toLowerCase();
    if (comparable(real) !== comparable(current)) {
      fail(`${label} resolves through an alias or reparse point.`);
    }
  }
  return candidate;
}

async function assertNoCaseCollision(parent, leaf) {
  const entries = await fs.readdir(parent, { withFileTypes: true });
  const match = entries.find((entry) => entry.name.toLowerCase() === leaf.toLowerCase());
  if (match) fail('The protected path collides with an existing case-insensitive name.');
}

async function createExclusiveDirectory(absolute, label) {
  const fullPath = assertWindowsLocalPath(absolute, label);
  const parent = path.win32.dirname(fullPath);
  const leaf = path.win32.basename(fullPath);
  await assertNoReparsePath(parent, `${label} parent`);
  await assertNoCaseCollision(parent, leaf);
  await fs.mkdir(fullPath, { recursive: false, mode: 0o700 });
  await assertNoReparsePath(fullPath, label);
  return fullPath;
}

async function readJson(absolute, label) {
  return parseJsonBytes(await fs.readFile(absolute), label);
}

function parseJsonBytes(bytes, label) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    fail(`${label} is missing or not valid JSON.`);
  }
  return requireObject(parsed, label);
}

export function parseTrustedBindingPayload(bytes, trustedSha256) {
  if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)) {
    fail('Immutable run binding payload must be supplied as raw bytes.');
  }
  const expectedSha256 = assertHex(
    requireString(trustedSha256, 'Trusted binding payload SHA-256'),
    HEX_64,
    'Trusted binding payload SHA-256',
  );
  assertEqual(sha256(bytes), expectedSha256, 'Trusted binding payload SHA-256');
  return parseJsonBytes(bytes, 'Immutable run binding');
}

async function writeExclusiveJson(absolute, value) {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const handle = await fs.open(absolute, 'wx', 0o600);
  try {
    await handle.writeFile(bytes, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return sha256(bytes);
}

async function writeAtomicJson(absolute, value) {
  const temporary = `${absolute}.${randomBytes(8).toString('hex')}.tmp`;
  await writeExclusiveJson(temporary, value);
  await fs.rename(temporary, absolute);
}

async function writeActionOutput(env, key, value) {
  if (!env.GITHUB_OUTPUT) return;
  const outputPath = env.GITHUB_OUTPUT;
  await fs.appendFile(outputPath, `${key}=${String(value).replace(/[\r\n]/g, '')}\n`, { encoding: 'utf8' });
}

function initialPreflightReceipt(context) {
  return {
    schemaVersion: 1,
    status: 'initializing',
    scope: 'Morrow E003 G13 issue 185 preflight only',
    runId: context.runId,
    runAttempt: context.attempt,
    sha: context.sha,
    appLaunched: false,
    driverServiceStarted: false,
    startedAtUtc: new Date().toISOString(),
  };
}

function preflightBootstrap(context, phase) {
  if (phase !== 'prepare' && phase !== 'protected') fail('Unknown issue 181 workflow phase.');
  return Object.freeze({
    path: path.win32.join(context.runnerTemp, `issue-179-control-${context.runId}-${context.attempt}`),
    receipt: initialPreflightReceipt(context),
  });
}

function initialGateReceipt(context, phase) {
  return {
    schemaVersion: 1,
    status: phase === 'prepare' ? 'preparing' : 'protected-job-started',
    scope: 'Morrow E003 G13 issue 181 protected check-only gate',
    phase,
    runId: context.runId,
    runAttempt: context.attempt,
    sha: context.sha,
    ref: context.ref,
    workflowRef: context.workflowRef,
    scenario: WINDOWS_RUN_GATE.scenario,
    environment: phase === 'protected' ? WINDOWS_RUN_GATE.environment : null,
    consumerRan: false,
    appLaunched: false,
    driverServiceStarted: false,
    windowsRuntimeTested: false,
    guiTested: false,
    startedAtUtc: new Date().toISOString(),
  };
}

async function initializePhase(env, phase, io = {}) {
  const context = safeRunContext(env, { requireWindowsRunner: true, requireFirstAttempt: true });
  const paths = validateProcedurePaths(context);
  const controlRoot = paths.gateControl;
  const createDirectory = io.createExclusiveDirectoryImpl ?? createExclusiveDirectory;
  const writeJson = io.writeExclusiveJsonImpl ?? writeExclusiveJson;
  await createDirectory(controlRoot, 'Issue 181 gate control directory');
  await writeJson(path.win32.join(controlRoot, 'receipt.json'), initialGateReceipt(context, phase));
  const preflight = preflightBootstrap(context, phase);
  await createDirectory(preflight.path, 'Issue 185 preflight control directory');
  await writeJson(path.win32.join(preflight.path, 'receipt.json'), preflight.receipt);
  await writeActionOutput(env, 'gate_control_dir', controlRoot);
  await writeActionOutput(env, 'gate_consumer_ran', 'false');
  return { context, paths, controlRoot };
}

function toSafePackageSummary(metadata) {
  const pin = validatePackagePin(metadata);
  return { ...pin, artifactDigest: metadata.artifactDigest };
}

function validateArtifactSourceAndDriver(stage, receipt, context) {
  const summary = validatePreflight(stage, receipt, context);
  if (!summary.webView2Pv.sources || Object.keys(summary.webView2Pv.sources).length === 0) {
    fail('Prepared WebView2 pv provenance is empty.');
  }
  return summary;
}

function createBinding({
  context,
  sourceFiles,
  stage,
  receipt,
  stageBytes,
  receiptBytes,
  now = Date.now(),
  nonce = randomBytes(16).toString('hex'),
}) {
  const summary = validateArtifactSourceAndDriver(stage, receipt, context);
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + WINDOWS_RUN_GATE.lifetimeMs).toISOString();
  const binding = {
    schema: WINDOWS_RUN_GATE.schema,
    scenario: WINDOWS_RUN_GATE.scenario,
    createdAtUtc: createdAt,
    expiresAtUtc: expiresAt,
    nonce,
    run: {
      repository: context.repository,
      id: context.runId,
      attempt: context.attempt,
      sha: context.sha,
      ref: context.ref,
      event: context.event,
      workflowRef: context.workflowRef,
    },
    artifactName: expectedArtifactName(context),
    sourceFiles: { files: sourceFiles },
    package: toSafePackageSummary(stage.artifact),
    approvedDriver: {
      filename: 'tauri-driver.exe',
      version: summary.tauriDriver.version,
      source: summary.tauriDriver.source,
      sourceUrl: summary.tauriDriver.sourceUrl,
      installCommand: summary.tauriDriver.installCommand,
      cargoVersion: summary.cargo.version,
      sha256: summary.tauriDriver.executableSha256,
      serviceStarted: false,
    },
    preflight: {
      stageSha256: assertHex(sha256(stageBytes), HEX_64, 'Prepared stage manifest SHA-256'),
      checkOnlyReceiptSha256: assertHex(sha256(receiptBytes), HEX_64, 'Prepared check-only receipt SHA-256'),
      checkOnlyStatus: 'passed',
      appLaunched: false,
      driverServiceStarted: false,
      guiTested: false,
      package: summary.package,
      cargo: summary.cargo,
      tauriDriver: summary.tauriDriver,
      webView2Pv: summary.webView2Pv,
      edgeDriver: summary.edgeDriver,
    },
    procedurePaths: {
      scenario: WINDOWS_RUN_GATE.scenario,
      prepare: {
        control: '%RUNNER_TEMP%\\issue-179-control-${RUN_ID}-${ATTEMPT}',
        toolStage: '%RUNNER_TEMP%\\issue-179-tools-${RUN_ID}-${ATTEMPT}',
      },
      protected: {
        control: '%RUNNER_TEMP%\\issue-179-control-${RUN_ID}-${ATTEMPT}',
        toolStage: '%RUNNER_TEMP%\\issue-179-tools-${RUN_ID}-${ATTEMPT}',
        approvedDriver: `%RUNNER_TEMP%\\issue-181-approved-driver-${context.runId}-1\\tauri-driver.exe`,
      },
    },
  };
  validateBinding(binding, context, sourceFiles, now);
  return binding;
}

async function readPrepareFiles(context) {
  const toolStage = path.win32.join(
    context.runnerTemp,
    `issue-179-tools-${context.runId}-${context.attempt}`,
  );
  const control = path.win32.join(
    context.runnerTemp,
    `issue-179-control-${context.runId}-${context.attempt}`,
  );
  await assertNoReparsePath(toolStage, 'Prepared tool stage');
  await assertNoReparsePath(control, 'Prepared control directory');
  const stagePath = path.win32.join(control, 'stage.json');
  const receiptPath = path.win32.join(control, 'receipt.json');
  const driverPath = path.win32.join(toolStage, 'drivers', 'tauri-driver', 'bin', 'tauri-driver.exe');
  await assertNoReparsePath(stagePath, 'Prepared stage manifest');
  await assertNoReparsePath(receiptPath, 'Prepared check-only receipt');
  await assertNoReparsePath(driverPath, 'Prepared tauri-driver executable');
  const [stage, receipt, stageBytes, receiptBytes, driverBytes] = await Promise.all([
    readJson(stagePath, 'Prepared stage manifest'),
    readJson(receiptPath, 'Prepared check-only receipt'),
    fs.readFile(stagePath),
    fs.readFile(receiptPath),
    fs.readFile(driverPath),
  ]);
  const summary = validateArtifactSourceAndDriver(stage, receipt, context);
  assertEqual(sha256(driverBytes), summary.tauriDriver.executableSha256, 'Prepared tauri-driver file');
  return { toolStage, control, stage, receipt, stageBytes, receiptBytes, driverBytes, summary };
}

async function prepareBinding(env) {
  const context = safeRunContext(env, { requireWindowsRunner: true, requireFirstAttempt: true });
  const paths = validateProcedurePaths(context);
  const controlRoot = paths.gateControl;
  await assertNoReparsePath(controlRoot, 'Issue 181 gate control directory');
  const ownReceiptPath = path.win32.join(controlRoot, 'receipt.json');
  const ownReceipt = await readJson(ownReceiptPath, 'Issue 181 preparation receipt');
  assertEqual(ownReceipt.phase, 'prepare', 'Issue 181 phase');
  assertEqual(ownReceipt.runId, context.runId, 'Issue 181 preparation run ID');
  assertEqual(ownReceipt.runAttempt, '1', 'Issue 181 preparation attempt');
  const inputs = await readPrepareFiles(context);
  const sourceFiles = await hashSourceFiles(env.GITHUB_WORKSPACE);
  const binding = createBinding({
    context,
    sourceFiles,
    stage: inputs.stage,
    receipt: inputs.receipt,
    stageBytes: inputs.stageBytes,
    receiptBytes: inputs.receiptBytes,
  });
  const bundleRoot = paths.binding;
  await createExclusiveDirectory(bundleRoot, 'Immutable issue 181 binding directory');
  const approvedDriverRoot = path.win32.join(bundleRoot, 'approved-driver');
  const provenanceRoot = path.win32.join(bundleRoot, 'provenance');
  await fs.mkdir(approvedDriverRoot, { recursive: false, mode: 0o700 });
  await fs.mkdir(provenanceRoot, { recursive: false, mode: 0o700 });
  const approvedDriverPath = path.win32.join(approvedDriverRoot, 'tauri-driver.exe');
  await fs.copyFile(
    path.win32.join(inputs.toolStage, 'drivers', 'tauri-driver', 'bin', 'tauri-driver.exe'),
    approvedDriverPath,
    fsConstants.COPYFILE_EXCL,
  );
  await assertNoReparsePath(approvedDriverPath, 'Immutable approved tauri-driver executable');
  const copiedDriverHash = sha256(await fs.readFile(approvedDriverPath));
  assertEqual(copiedDriverHash, binding.approvedDriver.sha256, 'Immutable approved tauri-driver executable');
  const stagePath = path.win32.join(provenanceRoot, 'stage.json');
  const checkOnlyPath = path.win32.join(provenanceRoot, 'check-only-receipt.json');
  await fs.writeFile(stagePath, inputs.stageBytes, { flag: 'wx', mode: 0o600 });
  await fs.writeFile(checkOnlyPath, inputs.receiptBytes, { flag: 'wx', mode: 0o600 });
  const bindingPath = path.win32.join(bundleRoot, 'binding.json');
  await writeExclusiveJson(bindingPath, binding);
  const bindingPayloadSha256 = sha256(await fs.readFile(bindingPath));
  const updatedReceipt = {
    ...ownReceipt,
    status: 'binding-upload-ready',
    artifactName: binding.artifactName,
    bindingPayloadSha256,
    bindingSha256: bindingPayloadSha256,
    sourceFileHashes: sourceFiles,
    packageArtifactId: binding.package.artifactId,
    packageArtifactDigest: binding.package.artifactDigest,
    approvedDriverSha256: copiedDriverHash,
    approvedDriverProvenance: binding.approvedDriver,
    expiresAtUtc: binding.expiresAtUtc,
    completedAtUtc: new Date().toISOString(),
  };
  await writeAtomicJson(ownReceiptPath, updatedReceipt);
  await writeActionOutput(env, 'binding_artifact_name', binding.artifactName);
  await writeActionOutput(env, 'binding_payload_sha256', bindingPayloadSha256);
  await writeActionOutput(env, 'binding_directory', bundleRoot);
  return { context, paths, binding, bundleRoot, bindingSha256: updatedReceipt.bindingSha256 };
}

async function listTree(root, relative = '') {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) fail('Downloaded binding contains a symbolic link or reparse entry.');
    const absolute = path.join(root, entry.name);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) fail('Downloaded binding contains a symbolic link or reparse entry.');
    if (stat.isDirectory()) {
      items.push(`${rel.replaceAll('\\', '/')}/`);
      items.push(...(await listTree(absolute, rel)));
    } else if (stat.isFile()) items.push(rel.replaceAll('\\', '/'));
    else fail('Downloaded binding contains a non-file entry.');
  }
  return items.sort();
}

async function resolveDownloadedBundle(downloadRoot, context) {
  const root = assertWindowsLocalPath(downloadRoot, 'Downloaded artifact root');
  await assertNoReparsePath(root, 'Downloaded artifact root');
  const rootEntries = await fs.readdir(root, { withFileTypes: true });
  const directHasBinding = rootEntries.some((entry) => entry.name === 'binding.json');
  let bundleRoot = root;
  if (
    !directHasBinding &&
    rootEntries.length === 1 &&
    rootEntries[0].isDirectory() &&
    !rootEntries[0].isSymbolicLink()
  ) {
    bundleRoot = path.win32.join(root, rootEntries[0].name);
  }
  await assertNoReparsePath(bundleRoot, 'Downloaded binding directory');
  const expected = [
    'approved-driver/',
    'approved-driver/tauri-driver.exe',
    'binding.json',
    'provenance/',
    'provenance/check-only-receipt.json',
    'provenance/stage.json',
  ].sort();
  const actual = await listTree(bundleRoot);
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    fail('Downloaded immutable binding contains missing or unexpected files.');
  if (!isInsideWindowsPath(root, bundleRoot))
    fail('Downloaded binding expanded outside its assigned directory.');
  if (
    bundleRoot.toLowerCase() === root.toLowerCase() ||
    rootEntries.some((entry) => entry.name === 'binding.json')
  )
    return bundleRoot;
  assertEqual(
    path.win32.basename(bundleRoot),
    expectedArtifactName(context),
    'Downloaded artifact directory name',
  );
  return bundleRoot;
}

async function verifyDownloadedBundle(env) {
  const context = safeRunContext(env, { requireWindowsRunner: true, requireFirstAttempt: true });
  const paths = validateProcedurePaths(context);
  const artifactId = requireString(env.GATE_BINDING_ARTIFACT_ID, 'Binding artifact ID output');
  const artifactDigest = requireString(env.GATE_BINDING_ARTIFACT_DIGEST, 'Binding artifact digest output');
  const bindingPayloadSha256 = assertHex(
    requireString(env.GATE_BINDING_PAYLOAD_SHA256, 'Trusted binding payload SHA-256'),
    HEX_64,
    'Trusted binding payload SHA-256',
  );
  const artifactName = expectedArtifactName(context);
  const token = requireString(env.GITHUB_TOKEN, 'Read-only GitHub token');
  const metadata = await fetchArtifactMetadata({ token, artifactId });
  validateArtifactApiMetadata(metadata, { context, artifactId, artifactDigest, artifactName });
  const bundleRoot = await resolveDownloadedBundle(
    requireString(env.GATE_BINDING_DOWNLOAD_ROOT, 'Binding download directory'),
    context,
  );
  const bindingPath = path.win32.join(bundleRoot, 'binding.json');
  const stagePath = path.win32.join(bundleRoot, 'provenance', 'stage.json');
  const checkOnlyPath = path.win32.join(bundleRoot, 'provenance', 'check-only-receipt.json');
  const driverPath = path.win32.join(bundleRoot, 'approved-driver', 'tauri-driver.exe');
  for (const [candidate, label] of [
    [bindingPath, 'Binding JSON'],
    [stagePath, 'Prepared stage provenance'],
    [checkOnlyPath, 'Prepared check-only provenance'],
    [driverPath, 'Approved driver artifact'],
  ]) {
    await assertNoReparsePath(candidate, label);
  }
  const [bindingBytes, stage, receipt, stageBytes, receiptBytes, driverBytes] = await Promise.all([
    fs.readFile(bindingPath),
    readJson(stagePath, 'Prepared stage provenance'),
    readJson(checkOnlyPath, 'Prepared check-only provenance'),
    fs.readFile(stagePath),
    fs.readFile(checkOnlyPath),
    fs.readFile(driverPath),
  ]);
  const binding = parseTrustedBindingPayload(bindingBytes, bindingPayloadSha256);
  const sourceFiles = await hashSourceFiles(env.GITHUB_WORKSPACE);
  const bindingSummary = validateBinding(binding, context, sourceFiles);
  assertEqual(sha256(stageBytes), binding.preflight.stageSha256, 'Prepared stage provenance digest');
  assertEqual(
    sha256(receiptBytes),
    binding.preflight.checkOnlyReceiptSha256,
    'Prepared check-only provenance digest',
  );
  const prepareSummary = validatePreflight(stage, receipt, context);
  assertEqual(
    prepareSummary.tauriDriver.executableSha256,
    bindingSummary.driver.sha256,
    'Prepared driver provenance',
  );
  assertEqual(sha256(driverBytes), bindingSummary.driver.sha256, 'Downloaded approved tauri-driver bytes');
  assertSameRuntimeAndDrivers(prepareSummary, bindingSummary);
  const ownReceiptPath = path.win32.join(paths.gateControl, 'receipt.json');
  const ownReceipt = await readJson(ownReceiptPath, 'Issue 181 protected receipt');
  assertEqual(ownReceipt.phase, 'protected', 'Issue 181 protected phase');
  assertEqual(ownReceipt.consumerRan, false, 'Issue 181 consumer state before claim');
  const claimPath = path.win32.join(paths.gateControl, 'claim.json');
  const claim = {
    schemaVersion: 1,
    runId: context.runId,
    runAttempt: context.attempt,
    sourceSha: context.sha,
    bindingArtifactId: String(artifactId),
    bindingArtifactDigest: artifactDigest,
    bindingPayloadSha256,
    bindingNonce: binding.nonce,
    claimedAtUtc: new Date().toISOString(),
  };
  const claimSha256 = await writeExclusiveJson(claimPath, claim);
  const claimedReceipt = {
    ...ownReceipt,
    status: 'claimed-protected-check-only-consumer',
    consumerRan: true,
    claimSha256,
    bindingArtifactId: String(artifactId),
    bindingArtifactDigest: artifactDigest,
    bindingArtifactName: artifactName,
    bindingPayloadSha256,
    bindingSha256: bindingPayloadSha256,
    bindingNonce: binding.nonce,
    bindingExpiresAtUtc: binding.expiresAtUtc,
    sourceFileHashes: sourceFiles,
    packageArtifactId: binding.package.artifactId,
    packageArtifactDigest: binding.package.artifactDigest,
    approvedDriverSha256: bindingSummary.driver.sha256,
    appLaunched: false,
    driverServiceStarted: false,
    windowsRuntimeTested: false,
    guiTested: false,
  };
  await writeAtomicJson(ownReceiptPath, claimedReceipt);
  await writeActionOutput(env, 'gate_consumer_ran', 'true');
  await writeActionOutput(env, 'binding_nonce', binding.nonce);
  return {
    context,
    paths,
    binding,
    bindingSummary,
    bundleRoot,
    ownReceiptPath,
    claimSha256,
    artifactId,
    artifactDigest,
  };
}

function assertSameRuntimeAndDrivers(actual, bindingSummary) {
  assertEqual(actual.cargo.version, bindingSummary.cargo.version, 'Protected Cargo version');
  assertEqual(
    actual.cargo.executableName,
    bindingSummary.cargo.executableName,
    'Protected Cargo executable name',
  );
  assertEqual(actual.webView2Pv.version, bindingSummary.webView2Pv.version, 'Protected WebView2 pv version');
  assertEqual(
    JSON.stringify(actual.webView2Pv.sources),
    JSON.stringify(bindingSummary.webView2Pv.sources),
    'Protected WebView2 pv source observations',
  );
  assertEqual(actual.edgeDriver.version, bindingSummary.edgeDriver.version, 'Protected EdgeDriver version');
  assertEqual(
    actual.edgeDriver.archiveSha256,
    bindingSummary.edgeDriver.archiveSha256,
    'Protected EdgeDriver archive hash',
  );
  assertEqual(
    actual.edgeDriver.executableSha256,
    bindingSummary.edgeDriver.executableSha256,
    'Protected EdgeDriver executable hash',
  );
  assertEdgeFieldsEqual(
    actual.edgeDriver,
    bindingSummary.edgeDriver,
    EDGE_SELECTED_IDENTITY_FIELDS,
    'Protected EdgeDriver selected',
  );
  assertEqual(actual.package.artifactId, bindingSummary.package.artifactId, 'Protected package artifact ID');
  assertEqual(actual.package.sourceTree, bindingSummary.package.sourceTree, 'Protected package source tree');
  assertEqual(
    normalizeDigest(actual.package.artifactDigest),
    normalizeDigest(bindingSummary.package.artifactDigest),
    'Protected package artifact digest',
  );
  assertEqual(
    actual.package.sourceExeSha256,
    bindingSummary.package.sourceExeSha256,
    'Protected package executable hash',
  );
  assertEqual(actual.tauriDriver.version, bindingSummary.driver.version, 'Protected tauri-driver version');
  assertEqual(actual.tauriDriver.source, bindingSummary.driver.source, 'Protected tauri-driver source');
  assertEqual(
    actual.tauriDriver.installCommand,
    bindingSummary.driver.installCommand,
    'Protected tauri-driver install provenance',
  );
  assertEqual(actual.tauriDriver.serviceStarted, false, 'Protected tauri-driver service state');
}

export function validateProtectedStage(stage, binding, context, currentSourceHashes, now = Date.now()) {
  const stageSummary = validateStage(stage, context);
  const bindingSummary = validateBinding(binding, context, currentSourceHashes, now);
  assertSameRuntimeAndDrivers(stageSummary, bindingSummary);
  return Object.freeze({ stage: stageSummary, binding: bindingSummary });
}

async function verifyProtectedStage(env) {
  const context = safeRunContext(env, { requireWindowsRunner: true, requireFirstAttempt: true });
  const paths = validateProcedurePaths(context);
  const bindingPayloadSha256 = assertHex(
    requireString(env.GATE_BINDING_PAYLOAD_SHA256, 'Trusted binding payload SHA-256'),
    HEX_64,
    'Trusted binding payload SHA-256',
  );
  const bundleRoot = await resolveDownloadedBundle(
    requireString(env.GATE_BINDING_DOWNLOAD_ROOT, 'Binding download directory'),
    context,
  );
  const bindingPath = path.win32.join(bundleRoot, 'binding.json');
  const stagePath = path.win32.join(paths.protectedControl, 'stage.json');
  const bundleDriverPath = path.win32.join(bundleRoot, 'approved-driver', 'tauri-driver.exe');
  for (const [candidate, label] of [
    [bindingPath, 'Binding JSON'],
    [stagePath, 'Protected stage manifest'],
    [bundleDriverPath, 'Downloaded approved tauri-driver executable'],
  ]) {
    await assertNoReparsePath(candidate, label);
  }
  const [bindingBytes, stage, sourceFiles, bundleDriverBytes] = await Promise.all([
    fs.readFile(bindingPath),
    readJson(stagePath, 'Protected stage manifest'),
    hashSourceFiles(env.GITHUB_WORKSPACE),
    fs.readFile(bundleDriverPath),
  ]);
  const binding = parseTrustedBindingPayload(bindingBytes, bindingPayloadSha256);
  const { stage: stageSummary, binding: bindingSummary } = validateProtectedStage(
    stage,
    binding,
    context,
    sourceFiles,
  );
  assertEqual(
    sha256(bundleDriverBytes),
    bindingSummary.driver.sha256,
    'Downloaded approved tauri-driver bytes',
  );
  const ownReceiptPath = path.win32.join(paths.gateControl, 'receipt.json');
  const ownReceipt = await readJson(ownReceiptPath, 'Issue 181 protected receipt');
  assertEqual(ownReceipt.phase, 'protected', 'Issue 181 protected phase');
  assertEqual(ownReceipt.status, 'claimed-protected-check-only-consumer', 'Issue 181 precheck state');
  assertEqual(ownReceipt.consumerRan, true, 'Issue 181 consumer claim');
  assertEqual(ownReceipt.bindingNonce, binding.nonce, 'Issue 181 consumed binding nonce');
  assertEqual(ownReceipt.bindingPayloadSha256, bindingPayloadSha256, 'Issue 181 binding payload hash');
  assertEqual(
    String(ownReceipt.bindingArtifactId),
    String(env.GATE_BINDING_ARTIFACT_ID),
    'Issue 181 binding artifact ID',
  );
  assertEqual(
    ownReceipt.bindingArtifactDigest,
    env.GATE_BINDING_ARTIFACT_DIGEST,
    'Issue 181 binding artifact digest',
  );

  const localToolDriver = path.win32.join(
    context.runnerTemp,
    paths.relative.protectedToolStage,
    'drivers',
    'tauri-driver',
    'bin',
    'tauri-driver.exe',
  );
  await assertNoReparsePath(localToolDriver, 'Protected local tauri-driver executable');
  assertEqual(
    sha256(await fs.readFile(localToolDriver)),
    stageSummary.tauriDriver.executableSha256,
    'Protected local tauri-driver bytes before check-only',
  );

  const approvedDriverRoot = path.win32.join(
    context.runnerTemp,
    `issue-181-approved-driver-${context.runId}-${context.attempt}`,
  );
  await createExclusiveDirectory(approvedDriverRoot, 'Protected approved-driver directory');
  const approvedDriverPath = path.win32.join(approvedDriverRoot, 'tauri-driver.exe');
  if (approvedDriverPath.toLowerCase() === localToolDriver.toLowerCase()) {
    fail('Approved driver transfer path collides with the fresh local tool-stage driver.');
  }
  await fs.copyFile(bundleDriverPath, approvedDriverPath, fsConstants.COPYFILE_EXCL);
  await assertNoReparsePath(approvedDriverPath, 'Protected approved tauri-driver executable');
  const approvedSha256 = sha256(await fs.readFile(approvedDriverPath));
  assertEqual(approvedSha256, bindingSummary.driver.sha256, 'Protected approved tauri-driver bytes');

  const approvedDriverTransfer = {
    path: approvedDriverPath,
    pathTemplate: `%RUNNER_TEMP%\\issue-181-approved-driver-${context.runId}-1\\tauri-driver.exe`,
    sha256: approvedSha256,
    version: bindingSummary.driver.version,
    source: bindingSummary.driver.source,
    installCommand: bindingSummary.driver.installCommand,
    provenanceArtifactId: String(env.GATE_BINDING_ARTIFACT_ID),
    provenanceArtifactDigest: env.GATE_BINDING_ARTIFACT_DIGEST,
    provenanceBindingSha256: bindingPayloadSha256,
    serviceStarted: false,
    executableInvoked: false,
  };
  const updatedReceipt = {
    ...ownReceipt,
    status: 'protected-stage-prechecked',
    bindingPayloadSha256,
    protectedStagePrecheck: {
      status: 'passed-before-check-only',
      stageSha256: sha256(await fs.readFile(stagePath)),
      package: stageSummary.package,
      cargo: stageSummary.cargo,
      localTauriDriverSha256: stageSummary.tauriDriver.executableSha256,
      localTauriDriverVersion: stageSummary.tauriDriver.version,
      webView2Pv: stageSummary.webView2Pv,
      edgeDriver: stageSummary.edgeDriver,
      sourceFileHashes: sourceFiles,
    },
    approvedDriverTransfer,
  };
  await writeAtomicJson(ownReceiptPath, updatedReceipt);
  return { context, paths, binding, bindingSummary, stageSummary, approvedDriverPath, approvedSha256 };
}

async function verifyProtectedCheckOnly(env) {
  const context = safeRunContext(env, { requireWindowsRunner: true, requireFirstAttempt: true });
  const paths = validateProcedurePaths(context);
  const bindingPayloadSha256 = assertHex(
    requireString(env.GATE_BINDING_PAYLOAD_SHA256, 'Trusted binding payload SHA-256'),
    HEX_64,
    'Trusted binding payload SHA-256',
  );
  const bundleRoot = await resolveDownloadedBundle(
    requireString(env.GATE_BINDING_DOWNLOAD_ROOT, 'Binding download directory'),
    context,
  );
  const bindingPath = path.win32.join(bundleRoot, 'binding.json');
  const stagePath = path.win32.join(paths.protectedControl, 'stage.json');
  const receiptPath = path.win32.join(paths.protectedControl, 'receipt.json');
  await assertNoReparsePath(bindingPath, 'Binding JSON');
  await assertNoReparsePath(stagePath, 'Protected stage manifest');
  await assertNoReparsePath(receiptPath, 'Protected check-only receipt');
  const [bindingBytes, stage, receipt, sourceFiles] = await Promise.all([
    fs.readFile(bindingPath),
    readJson(stagePath, 'Protected stage manifest'),
    readJson(receiptPath, 'Protected check-only receipt'),
    hashSourceFiles(env.GITHUB_WORKSPACE),
  ]);
  const binding = parseTrustedBindingPayload(bindingBytes, bindingPayloadSha256);
  const summary = validateBinding(binding, context, sourceFiles);
  const actual = validatePreflight(stage, receipt, context);
  assertSameRuntimeAndDrivers(actual, summary);
  const localToolDriver = path.win32.join(
    context.runnerTemp,
    paths.relative.protectedToolStage,
    'drivers',
    'tauri-driver',
    'bin',
    'tauri-driver.exe',
  );
  await assertNoReparsePath(localToolDriver, 'Protected local tauri-driver executable');
  assertEqual(
    sha256(await fs.readFile(localToolDriver)),
    actual.tauriDriver.executableSha256,
    'Protected local tauri-driver bytes',
  );
  const approvedDriverRoot = path.win32.join(
    context.runnerTemp,
    `issue-181-approved-driver-${context.runId}-${context.attempt}`,
  );
  const approvedDriverPath = path.win32.join(approvedDriverRoot, 'tauri-driver.exe');
  await assertNoReparsePath(approvedDriverPath, 'Protected approved tauri-driver executable');
  const approvedSha256 = sha256(await fs.readFile(approvedDriverPath));
  assertEqual(approvedSha256, summary.driver.sha256, 'Protected approved tauri-driver bytes');
  const ownReceiptPath = path.win32.join(paths.gateControl, 'receipt.json');
  const ownReceipt = await readJson(ownReceiptPath, 'Issue 181 protected receipt');
  assertEqual(ownReceipt.status, 'protected-stage-prechecked', 'Issue 181 Stage precheck state');
  assertEqual(ownReceipt.consumerRan, true, 'Issue 181 consumer claim');
  assertEqual(ownReceipt.bindingNonce, binding.nonce, 'Issue 181 consumed binding nonce');
  assertEqual(ownReceipt.bindingPayloadSha256, bindingPayloadSha256, 'Issue 181 binding payload hash');
  assertEqual(
    String(ownReceipt.bindingArtifactId),
    String(env.GATE_BINDING_ARTIFACT_ID),
    'Issue 181 binding artifact ID',
  );
  assertEqual(
    ownReceipt.bindingArtifactDigest,
    env.GATE_BINDING_ARTIFACT_DIGEST,
    'Issue 181 binding artifact digest',
  );
  assertEqual(ownReceipt.approvedDriverTransfer?.path, approvedDriverPath, 'Issue 181 approved driver path');
  assertEqual(ownReceipt.approvedDriverTransfer?.sha256, approvedSha256, 'Issue 181 approved driver hash');
  const completed = {
    ...ownReceipt,
    status: 'passed-protected-check-only',
    protectedPreflight: {
      stageSha256: sha256(await fs.readFile(stagePath)),
      checkOnlyReceiptSha256: sha256(await fs.readFile(receiptPath)),
      cargoVersion: actual.cargo.version,
      cargoExecutableName: actual.cargo.executableName,
      localTauriDriverSha256: actual.tauriDriver.executableSha256,
      localTauriDriverVersion: actual.tauriDriver.version,
      webView2PvVersion: actual.webView2Pv.version,
      edgeDriver: actual.edgeDriver,
      sourceArtifact: actual.package,
    },
    approvedDriver: ownReceipt.approvedDriverTransfer,
    bindingPayloadSha256,
    protectedCheckOnly: {
      status: receipt.status,
      appLaunched: receipt.appLaunched,
      driverServiceStarted: receipt.driverServiceStarted,
      windowsRuntimeTested: receipt.windowsRuntimeTested,
      guiTested: receipt.guiTested,
      sidAndKnownFoldersVerifiedLocally: true,
      sourceFileHashes: sourceFiles,
    },
    completedAtUtc: new Date().toISOString(),
  };
  await writeAtomicJson(ownReceiptPath, completed);
  await writeActionOutput(env, 'approved_driver_path', approvedDriverPath);
  await writeActionOutput(env, 'approved_driver_sha256', approvedSha256);
  return { context, paths, approvedDriverPath, approvedSha256, receipt: completed };
}

async function collectEvidence(root) {
  const results = [];
  const walk = async (current, prefix = '') => {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) await walk(absolute, relative);
      else if (stat.isFile()) {
        const bytes = await fs.readFile(absolute);
        results.push({
          path: relative.replaceAll('\\', '/'),
          sizeBytes: bytes.byteLength,
          sha256: sha256(bytes),
        });
      }
    }
  };
  await walk(root);
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

async function finalizeProtected(env) {
  const context = safeRunContext(env, { requireWindowsRunner: true, requireFirstAttempt: true });
  const paths = validateProcedurePaths(context);
  const receiptPath = path.win32.join(paths.gateControl, 'receipt.json');
  const receipt = await readJson(receiptPath, 'Issue 181 protected receipt');
  const priorReceiptSha256 = sha256(await fs.readFile(receiptPath));
  const evidence = await Promise.all([
    collectEvidence(paths.gateControl),
    collectEvidence(path.win32.join(context.runnerTemp, paths.relative.protectedControl)),
  ]);
  const jobStatus = ['success', 'failure', 'cancelled'].includes(env.GATE_JOB_STATUS)
    ? env.GATE_JOB_STATUS
    : 'unknown';
  const final = {
    ...receipt,
    status:
      receipt.status === 'passed-protected-check-only' && jobStatus === 'success'
        ? receipt.status
        : `protected-${jobStatus}`,
    consumerRan: receipt.consumerRan === true,
    jobConclusionAtFinalize: jobStatus,
    appLaunched: false,
    driverServiceStarted: false,
    guiTested: false,
    priorReceiptSha256,
    evidence: [
      ...new Map(
        evidence
          .flat()
          .filter((entry) => entry.path !== 'receipt.json')
          .map((entry) => [entry.path, entry]),
      ).values(),
    ].sort((a, b) => a.path.localeCompare(b.path)),
    finalizedAtUtc: new Date().toISOString(),
  };
  await writeAtomicJson(receiptPath, final);
  await writeActionOutput(env, 'gate_consumer_ran', final.consumerRan ? 'true' : 'false');
  await writeActionOutput(env, 'gate_final_status', final.status);
  return final;
}

async function requestJson(url, token, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(url, { headers: apiHeaders(token) });
    if (!response.ok) return { ok: false, status: response.status };
    return { ok: true, value: await response.json() };
  } catch (error) {
    return { ok: false, error: error?.name ?? 'Error' };
  }
}

async function auditRun(env) {
  const context = safeRunContext(env, { requireWindowsRunner: false, requireFirstAttempt: false });
  const relative = expectedRelativePaths(context);
  const auditRoot = path.join(
    env.RUNNER_TEMP || process.cwd(),
    `issue-181-audit-${context.runId}-${context.attempt}`,
  );
  await fs.mkdir(auditRoot, { recursive: true, mode: 0o700 });
  const result = {
    schemaVersion: 1,
    scope: 'Morrow E003 G13 issue 181 read-only audit',
    runId: context.runId,
    runAttempt: context.attempt,
    sourceSha: context.sha,
    ref: context.ref,
    workflowRef: context.workflowRef,
    protectedEnvironment: WINDOWS_RUN_GATE.environment,
    scenario: WINDOWS_RUN_GATE.scenario,
    prepareJobResult: env.GATE_PREPARE_RESULT || 'unknown',
    protectedJobResult: env.GATE_PROTECTED_RESULT || 'unknown',
    consumerRan: env.GATE_CONSUMER_RAN === 'true',
    bindingArtifactId: env.GATE_BINDING_ARTIFACT_ID || null,
    bindingArtifactDigest: env.GATE_BINDING_ARTIFACT_DIGEST || null,
    bindingPayloadSha256: env.GATE_BINDING_PAYLOAD_SHA256 || null,
    prepareEvidenceArtifactId: env.GATE_PREPARE_EVIDENCE_ID || null,
    protectedEvidenceArtifactId: env.GATE_PROTECTED_EVIDENCE_ID || null,
    protectedApprovedDriverPath: env.GATE_APPROVED_DRIVER_PATH || null,
    protectedApprovedDriverSha256: env.GATE_APPROVED_DRIVER_SHA256 || null,
    procedurePaths: relative,
    apiReadback: { status: 'not-requested' },
    appLaunched: false,
    driverServiceStarted: false,
    guiTested: false,
    auditedAtUtc: new Date().toISOString(),
  };
  const token = env.GITHUB_TOKEN;
  if (token) {
    const apiRoot = 'https://api.github.com/repos/hodeliun/Morrow/actions';
    const [run, artifacts, jobs, pending] = await Promise.all([
      requestJson(`${apiRoot}/runs/${context.runId}`, token),
      requestJson(`${apiRoot}/runs/${context.runId}/artifacts`, token),
      requestJson(`${apiRoot}/runs/${context.runId}/jobs?per_page=100`, token),
      requestJson(`${apiRoot}/runs/${context.runId}/pending_deployments`, token),
    ]);
    result.apiReadback = {
      run: run.ok
        ? {
            id: String(run.value.id),
            runAttempt: run.value.run_attempt,
            headSha: run.value.head_sha,
            headBranch: run.value.head_branch,
            status: run.value.status,
            conclusion: run.value.conclusion,
          }
        : { status: 'unavailable', httpStatus: run.status ?? null, errorType: run.error ?? null },
      artifacts: artifacts.ok
        ? (artifacts.value.artifacts ?? []).map((artifact) => ({
            id: String(artifact.id),
            name: artifact.name,
            digest: artifact.digest ?? null,
            expired: artifact.expired,
          }))
        : { status: 'unavailable', httpStatus: artifacts.status ?? null, errorType: artifacts.error ?? null },
      jobs: jobs.ok
        ? (jobs.value.jobs ?? []).map((job) => ({
            name: job.name,
            status: job.status,
            conclusion: job.conclusion,
            startedAt: job.started_at,
            completedAt: job.completed_at,
          }))
        : { status: 'unavailable', httpStatus: jobs.status ?? null, errorType: jobs.error ?? null },
      pendingDeployments: pending.ok
        ? Array.isArray(pending.value)
          ? pending.value.map((deployment) => ({
              environmentId: deployment.environment?.id ?? null,
              environmentName: deployment.environment?.name ?? null,
              reviewers: (deployment.reviewers ?? [])
                .map((reviewer) => reviewer.reviewer?.login ?? reviewer.login ?? null)
                .filter(Boolean),
            }))
          : []
        : {
            status: 'not-pending-or-unavailable',
            httpStatus: pending.status ?? null,
            errorType: pending.error ?? null,
          },
    };
  } else {
    result.apiReadback = { status: 'unavailable-read-only-token-not-present' };
  }
  const runReadback = result.apiReadback.run;
  if (runReadback && typeof runReadback === 'object' && runReadback.status !== 'unavailable') {
    assertEqual(runReadback.id, context.runId, 'Audit API run ID');
    assertEqual(runReadback.headSha, context.sha, 'Audit API source SHA');
    assertEqual(runReadback.headBranch, WINDOWS_RUN_GATE.branch, 'Audit API source branch');
    assertEqual(String(runReadback.runAttempt), context.attempt, 'Audit API run attempt');
  }
  const auditPath = path.join(auditRoot, 'audit.json');
  await fs.writeFile(auditPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await writeActionOutput(env, 'audit_file', auditPath);
  return result;
}

export async function claimFileOnce(filePath, contents) {
  return writeExclusiveJson(filePath, contents);
}

export function assertSafeBundleContents(entries) {
  const expected = [
    'approved-driver/',
    'approved-driver/tauri-driver.exe',
    'binding.json',
    'provenance/',
    'provenance/check-only-receipt.json',
    'provenance/stage.json',
  ].sort();
  const actual = [...entries].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    fail('Binding artifact file inventory is incomplete or unexpected.');
  return true;
}

async function runCli() {
  const command = process.argv[2];
  switch (command) {
    case 'prepare-init':
      await initializePhase(process.env, 'prepare');
      console.log('issue181 prepare initialized; no app or driver service started');
      break;
    case 'prepare-bind': {
      const result = await prepareBinding(process.env);
      console.log(`issue181 immutable binding prepared: ${result.binding.artifactName}`);
      break;
    }
    case 'protected-init':
      await initializePhase(process.env, 'protected');
      console.log('issue181 protected check-only job initialized; no app or driver service started');
      break;
    case 'protected-claim':
      await verifyDownloadedBundle(process.env);
      console.log('issue181 binding verified and local one-consumer claim recorded');
      break;
    case 'protected-precheck':
      await verifyProtectedStage(process.env);
      console.log('issue181 fresh Stage and approved-driver transfer verified before check-only');
      break;
    case 'protected-verify':
      await verifyProtectedCheckOnly(process.env);
      console.log('issue181 protected Stage/CheckOnly and approved-driver byte transfer verified');
      break;
    case 'protected-finalize':
      await finalizeProtected(process.env);
      console.log('issue181 protected receipt finalized');
      break;
    case 'audit':
      await auditRun(process.env);
      console.log('issue181 audit receipt written; API calls are read-only');
      break;
    default:
      fail(
        'Expected one of: prepare-init, prepare-bind, protected-init, protected-claim, protected-precheck, protected-verify, protected-finalize, audit.',
      );
  }
}

const invokedAsScript =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  runCli().catch((error) => {
    // Only sanitized diagnostics reach the action log; no API headers or response bodies are printed.
    console.error(`issue181 gate failed closed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  });
}

export const __test = Object.freeze({
  normalizeDigest,
  assertSourceHashes,
  validateTimeWindow,
  validatedTauriDriver,
  validatedRuntimeAndEdge,
  createBinding,
  expectedRelativePaths,
  assertRunnerTempOutsideWorkspace,
  isInsideWindowsPath,
  validateArtifactSourceAndDriver,
  preflightBootstrap,
  initializePhase,
});
