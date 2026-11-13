#!/usr/bin/env node

// Read-only candidate fingerprinting and durable evidence helpers for the
// isolated Linux pilot. This module does not launch Morrow or any driver.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, open, readFile, realpath, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_COMMAND_OUTPUT = 64 * 1024 * 1024;
const SOURCE_SCHEMA = 'morrow-e003-g06-source-freeze/v1';
const ARTIFACT_SCHEMA = 'morrow-e003-g06-artifact-inventory/v1';

export const BUILD_COMMANDS = [
  'npm run tauri -- build --debug --no-bundle --config src-tauri/tauri.pilot.conf.json',
  'npm run build:polaris-dados',
];

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function buildVaultRegistry(origin, destination, openedAt = Date.now()) {
  const current = path.resolve(origin);
  const next = path.resolve(destination);
  if (!path.isAbsolute(origin) || !path.isAbsolute(destination)) throw new Error('Synthetic vault paths must be absolute');
  if (current === next) throw new Error('Origin and destination vault paths must be distinct');
  if (!Number.isFinite(openedAt) || openedAt < 1) throw new Error('Vault registration timestamp must be a positive finite number');
  return {
    current,
    recent: [
      { path: current, openedAt },
      { path: next, openedAt: openedAt - 1 },
    ],
  };
}

async function command(commandName, argv, { cwd, allowFailure = false } = {}) {
  try {
    const result = await execFileAsync(commandName, argv, {
      cwd,
      encoding: 'buffer',
      maxBuffer: MAX_COMMAND_OUTPUT,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      windowsHide: true,
    });
    return { stdout: Buffer.from(result.stdout), stderr: Buffer.from(result.stderr), code: 0 };
  } catch (error) {
    const result = {
      stdout: Buffer.from(error?.stdout ?? ''),
      stderr: Buffer.from(error?.stderr ?? ''),
      code: Number.isInteger(error?.code) ? error.code : 1,
    };
    if (!allowFailure) {
      const detail = result.stderr.toString('utf8').trim() || result.stdout.toString('utf8').trim();
      throw new Error(`${commandName} ${argv.join(' ')} failed (${result.code})${detail ? `: ${detail}` : ''}`, { cause: error });
    }
    return result;
  }
}

async function git(root, ...argv) {
  const result = await command('git', argv, { cwd: root });
  return result.stdout;
}

function nulEntries(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

function statusDisplay(buffer) {
  return buffer.toString('utf8').replaceAll('\0', '\n').replace(/\n+$/, '');
}

async function repositoryFiles(root) {
  const [trackedBytes, untrackedBytes] = await Promise.all([
    git(root, 'ls-files', '-z'),
    git(root, 'ls-files', '--others', '--exclude-standard', '-z'),
  ]);
  const tracked = nulEntries(trackedBytes);
  const trackedSet = new Set(tracked);
  const untracked = nulEntries(untrackedBytes).filter((item) => !trackedSet.has(item));
  tracked.sort();
  untracked.sort();
  return { tracked, untracked, files: [...new Set([...tracked, ...untracked])].sort() };
}

async function fileRecord(root, relative) {
  const absolute = path.resolve(root, relative);
  if (!isWithin(root, absolute) || absolute === path.resolve(root)) throw new Error(`Source path escaped checkout: ${relative}`);
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) throw new Error(`Symlink in frozen source inputs is not allowed: ${relative}`);
  if (!info.isFile()) throw new Error(`Source input must be a regular file or symlink: ${relative}`);
  const resolved = await realpath(absolute);
  if (!isWithin(root, resolved)) throw new Error(`Source symlink resolves outside checkout: ${relative}`);
  const bytes = await readFile(absolute);
  return { path: relative, type: 'file', mode: info.mode & 0o777, bytes: bytes.length, sha256: sha256(bytes) };
}

function isTestSource(relative) {
  return /(?:^|\/)(?:test|tests)(?:\/|$)/i.test(relative) || /(?:\.test|\.spec)\.[^/]+$/i.test(relative);
}

async function gitIdentity(root) {
  const [headBytes, treeBytes] = await Promise.all([
    git(root, 'rev-parse', 'HEAD'),
    git(root, 'rev-parse', 'HEAD^{tree}'),
  ]);
  return { head: headBytes.toString('utf8').trim(), tree: treeBytes.toString('utf8').trim() };
}

async function statusAndDiff(root, files = null) {
  const scopedArgs = files?.length ? ['--', ...files] : [];
  const [status, combinedDiff, stagedDiff, unstagedDiff] = await Promise.all([
    git(root, '--literal-pathspecs', 'status', '--porcelain=v1', '-z', '--untracked-files=all', ...scopedArgs),
    git(root, '--literal-pathspecs', 'diff', '--binary', 'HEAD', ...scopedArgs),
    git(root, '--literal-pathspecs', 'diff', '--cached', '--binary', 'HEAD', ...scopedArgs),
    git(root, '--literal-pathspecs', 'diff', '--binary', ...scopedArgs),
  ]);
  return {
    statusDisplay: statusDisplay(status),
    statusBase64: status.toString('base64'),
    statusSha256: sha256(status),
    diffSha256: sha256(combinedDiff),
    diffBytes: combinedDiff.length,
    stagedDiffSha256: sha256(stagedDiff),
    stagedDiffBytes: stagedDiff.length,
    unstagedDiffSha256: sha256(unstagedDiff),
    unstagedDiffBytes: unstagedDiff.length,
    diffBytesBuffer: combinedDiff,
  };
}

function ensureAbsolute(rawPath, label) {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || !path.isAbsolute(rawPath)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.resolve(rawPath);
}

async function assertOutputOutsideCheckout(root, rawPath, label) {
  const output = ensureAbsolute(rawPath, label);
  if (isWithin(root, output) || isWithin(output, root)) throw new Error(`${label} must be outside the checkout`);
  const parent = path.dirname(output);
  const actualParent = await realpath(parent);
  if (actualParent !== parent) throw new Error(`${label} parent must not use a symlinked path`);
  try {
    await lstat(output);
    throw new Error(`${label} already exists; refusing to overwrite ${output}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return output;
}

async function writeExclusive(output, bytes) {
  const handle = await open(output, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function freezeSourceManifest({ repositoryRoot, sourceManifestOutput, diffOutput }) {
  const root = await realpath(ensureAbsolute(repositoryRoot, 'repositoryRoot'));
  const manifestPath = await assertOutputOutsideCheckout(root, sourceManifestOutput, 'sourceManifestOutput');
  const patchPath = await assertOutputOutsideCheckout(root, diffOutput, 'diffOutput');
  if (manifestPath === patchPath) throw new Error('Source manifest and diff output must be distinct');

  const inventory = await repositoryFiles(root);
  const files = await Promise.all(inventory.files.map((relative) => fileRecord(root, relative)));
  const sourceStatus = await statusAndDiff(root, inventory.files);
  const fullStatus = await statusAndDiff(root);
  if (sourceStatus.statusSha256 !== fullStatus.statusSha256 || sourceStatus.diffSha256 !== fullStatus.diffSha256) {
    throw new Error('Source-scoped status/diff does not cover the full non-ignored repository state');
  }
  const identity = await gitIdentity(root);
  const generatedAt = new Date().toISOString();
  const testHashes = Object.fromEntries(files.filter((file) => isTestSource(file.path)).map((file) => [file.path, file.sha256]));
  const manifest = {
    schema: SOURCE_SCHEMA,
    generatedAt,
    repositoryRoot: root,
    git: {
      ...identity,
      status: fullStatus.statusDisplay,
      statusSha256: fullStatus.statusSha256,
      diffSha256: fullStatus.diffSha256,
      diffBytes: fullStatus.diffBytes,
      stagedDiffSha256: fullStatus.stagedDiffSha256,
      unstagedDiffSha256: fullStatus.unstagedDiffSha256,
      sourceScopeStatus: sourceStatus.statusDisplay,
      sourceScopeStatusSha256: sourceStatus.statusSha256,
      sourceScopeDiffSha256: sourceStatus.diffSha256,
      sourceScopeDiffBytes: sourceStatus.diffBytes,
    },
    inventory: {
      trackedFileCount: inventory.tracked.length,
      untrackedFileCount: inventory.untracked.length,
      fileCount: files.length,
      trackedPaths: inventory.tracked,
      untrackedPaths: inventory.untracked,
      files,
    },
    testHashes,
    diff: {
      path: patchPath,
      sha256: fullStatus.diffSha256,
      bytes: fullStatus.diffBytes,
      stagedSha256: fullStatus.stagedDiffSha256,
      unstagedSha256: fullStatus.unstagedDiffSha256,
    },
    interpretation: {
      headIsLastCommit: true,
      workingTreeChangesAreWip: Boolean(fullStatus.statusDisplay),
      diffFileContainsTrackedChangesOnly: true,
      untrackedFilesAreCapturedByIndividualFileHashes: true,
      sourceInputsIncludeTests: true,
    },
  };

  let diffWritten = false;
  try {
    await writeExclusive(patchPath, fullStatus.diffBytesBuffer);
    diffWritten = true;
    await writeExclusive(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    if (diffWritten) {
      const { unlink } = await import('node:fs/promises');
      await unlink(patchPath).catch(() => undefined);
    }
    throw error;
  }
  const manifestBytes = await readFile(manifestPath);
  return {
    sourceManifest: manifestPath,
    sourceManifestSha256: sha256(manifestBytes),
    diff: patchPath,
    diffSha256: fullStatus.diffSha256,
    head: identity.head,
    tree: identity.tree,
    trackedFileCount: inventory.tracked.length,
    untrackedFileCount: inventory.untracked.length,
    testFileCount: Object.keys(testHashes).length,
    status: fullStatus.statusDisplay,
    wipDiffSha256: fullStatus.diffSha256,
  };
}

export async function readSourceManifest(sourceManifestPath) {
  const sourcePath = ensureAbsolute(sourceManifestPath, 'sourceManifest');
  const statInfo = await lstat(sourcePath);
  if (!statInfo.isFile() || statInfo.isSymbolicLink()) throw new Error('Source manifest must be a regular file');
  const bytes = await readFile(sourcePath);
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw new Error(`Source manifest is not valid JSON: ${error.message}`, { cause: error }); }
  if (
    manifest?.schema !== SOURCE_SCHEMA ||
    !Array.isArray(manifest?.inventory?.files) ||
    !Array.isArray(manifest?.inventory?.trackedPaths) ||
    !Array.isArray(manifest?.inventory?.untrackedPaths) ||
    !manifest?.testHashes ||
    typeof manifest.testHashes !== 'object' ||
    !manifest?.git
  ) {
    throw new Error(`Unsupported source manifest schema; expected ${SOURCE_SCHEMA}`);
  }
  const trackedPaths = manifest.inventory.trackedPaths;
  const untrackedPaths = manifest.inventory.untrackedPaths;
  if (
    trackedPaths.some((item) => typeof item !== 'string') ||
    untrackedPaths.some((item) => typeof item !== 'string') ||
    new Set(trackedPaths).size !== trackedPaths.length ||
    new Set(untrackedPaths).size !== untrackedPaths.length ||
    trackedPaths.some((item) => untrackedPaths.includes(item))
  ) throw new Error('Source manifest tracked/untracked path lists are invalid or overlap');
  const expectedPaths = [...trackedPaths, ...untrackedPaths].sort();
  const recordedPaths = manifest.inventory.files.map((file) => file?.path);
  if (recordedPaths.some((item) => typeof item !== 'string') || new Set(recordedPaths).size !== recordedPaths.length) {
    throw new Error('Source manifest file records contain invalid or duplicate paths');
  }
  if (JSON.stringify(recordedPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error('Source manifest file records are not the exact tracked/untracked path union');
  }
  const expectedTestHashes = Object.fromEntries(
    manifest.inventory.files
      .filter((file) => isTestSource(file.path))
      .map((file) => [file.path, file.sha256]),
  );
  if (JSON.stringify(Object.entries(manifest.testHashes).sort(([a], [b]) => a.localeCompare(b))) !==
      JSON.stringify(Object.entries(expectedTestHashes).sort(([a], [b]) => a.localeCompare(b)))) {
    throw new Error('Source manifest testHashes do not match its source file records');
  }
  if (
    manifest.git.sourceScopeStatusSha256 !== manifest.git.statusSha256 ||
    manifest.git.sourceScopeDiffSha256 !== manifest.git.diffSha256
  ) throw new Error('Source manifest full and source-scoped status/diff hashes disagree');
  return { sourcePath, bytes, sha256: sha256(bytes), manifest };
}

export async function verifySourceManifest({ repositoryRoot, sourceManifestPath }) {
  const root = await realpath(ensureAbsolute(repositoryRoot, 'repositoryRoot'));
  const source = await readSourceManifest(sourceManifestPath);
  const manifest = source.manifest;
  if (manifest.repositoryRoot !== root) throw new Error(`Source manifest belongs to ${manifest.repositoryRoot}, not ${root}`);
  const identity = await gitIdentity(root);
  if (identity.head !== manifest.git.head) throw new Error(`Candidate HEAD ${identity.head} differs from frozen HEAD ${manifest.git.head}`);
  if (identity.tree !== manifest.git.tree) throw new Error(`Candidate HEAD tree ${identity.tree} differs from frozen tree ${manifest.git.tree}`);

  const frozenFiles = manifest.inventory.files;
  const actualFiles = await Promise.all(frozenFiles.map((file) => fileRecord(root, file.path)));
  const drift = [];
  for (let index = 0; index < frozenFiles.length; index += 1) {
    const expected = frozenFiles[index];
    const actual = actualFiles[index];
    if (
      actual.sha256 !== expected.sha256 ||
      actual.bytes !== expected.bytes ||
      actual.mode !== expected.mode ||
      actual.type !== expected.type ||
      actual.symlinkTarget !== expected.symlinkTarget
    ) drift.push(expected.path);
  }
  if (drift.length) throw new Error(`Frozen source files changed: ${drift.join(', ')}`);

  const paths = frozenFiles.map((file) => file.path);
  const scopedStatus = await statusAndDiff(root, paths);
  if (scopedStatus.statusSha256 !== manifest.git.sourceScopeStatusSha256) {
    throw new Error('Candidate source status differs from the frozen WIP status');
  }
  if (scopedStatus.diffSha256 !== manifest.git.sourceScopeDiffSha256) {
    throw new Error('Candidate source diff differs from the frozen WIP diff');
  }
  const currentFullStatus = await statusAndDiff(root);
  if (currentFullStatus.statusSha256 !== manifest.git.statusSha256) {
    throw new Error('Candidate full working-tree status differs from the frozen status');
  }
  if (currentFullStatus.diffSha256 !== manifest.git.diffSha256) {
    throw new Error('Candidate full working-tree diff differs from the frozen WIP diff');
  }
  const inventory = await repositoryFiles(root);
  if (JSON.stringify(inventory.tracked) !== JSON.stringify(manifest.inventory.trackedPaths)) {
    throw new Error('Tracked file set differs from the source freeze');
  }
  if (JSON.stringify(inventory.untracked) !== JSON.stringify(manifest.inventory.untrackedPaths)) {
    throw new Error('Untracked file set differs from the source freeze');
  }
  return {
    sourceManifestSha256: source.sha256,
    sourceManifestPath: source.sourcePath,
    head: identity.head,
    tree: identity.tree,
    fileCount: frozenFiles.length,
    testFileCount: Object.keys(manifest.testHashes ?? {}).length,
    frozenStatus: manifest.git.status,
    currentStatus: currentFullStatus.statusDisplay,
    frozenDiffSha256: manifest.git.diffSha256,
    currentDiffSha256: currentFullStatus.diffSha256,
    currentStatusSha256: currentFullStatus.statusSha256,
  };
}

async function fileArtifact(repositoryRoot, rawPath, label, { mustBeInsideRepository = false, executable = false } = {}) {
  const absolute = ensureAbsolute(rawPath, label);
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${absolute}`);
  const actual = await realpath(absolute);
  if (actual !== absolute) throw new Error(`${label} must not resolve through a symlink: ${absolute}`);
  if (mustBeInsideRepository && !isWithin(repositoryRoot, actual)) throw new Error(`${label} must be inside the repository`);
  if (executable && (info.mode & 0o111) === 0) throw new Error(`${label} is not executable: ${absolute}`);
  const bytes = await readFile(actual);
  return { path: actual, sha256: sha256(bytes), bytes: bytes.length, mode: info.mode & 0o777 };
}

async function version(commandName, argv, cwd) {
  try {
    const result = await command(commandName, argv, { cwd });
    return result.stdout.toString('utf8').trim();
  } catch (error) {
    return `unavailable: ${error.message}`;
  }
}

export async function recordArtifactManifest({
  repositoryRoot,
  sourceManifestPath,
  artifactManifestOutput,
  binaryPath,
  bundlePath,
  pluginManifestPath,
  tauriConfigPath,
  driverPath,
  webkitDriverPath,
}) {
  const root = await realpath(ensureAbsolute(repositoryRoot, 'repositoryRoot'));
  const output = await assertOutputOutsideCheckout(root, artifactManifestOutput, 'artifactManifestOutput');
  const sourceBefore = await verifySourceManifest({ repositoryRoot: root, sourceManifestPath });
  const source = await readSourceManifest(sourceManifestPath);
  const [binary, bundle, pluginManifest, tauriConfig, driver, webkitDriver] = await Promise.all([
    fileArtifact(root, binaryPath, 'binary', { mustBeInsideRepository: true, executable: true }),
    fileArtifact(root, bundlePath, 'bundle', { mustBeInsideRepository: true }),
    fileArtifact(root, pluginManifestPath, 'pluginManifest', { mustBeInsideRepository: true }),
    fileArtifact(root, tauriConfigPath, 'tauriConfig', { mustBeInsideRepository: true }),
    fileArtifact(root, driverPath, 'tauriDriver', { executable: true }),
    fileArtifact(root, webkitDriverPath, 'webkitDriver', { executable: true }),
  ]);
  const pluginData = JSON.parse((await readFile(pluginManifest.path)).toString('utf8'));
  const tauriData = JSON.parse((await readFile(tauriConfig.path)).toString('utf8'));
  if (pluginData.id !== 'polaris-dados') throw new Error('Plugin manifest id must be polaris-dados');
  if (tauriData.identifier !== 'app.morrow.polaris-dados-pilot') throw new Error('Tauri overlay identifier is not isolated');
  const toolchain = {
    node: await version(process.execPath, ['--version'], root),
    npm: await version('npm', ['--version'], root),
    rustc: await version('rustc', ['--version'], root),
    cargo: await version('cargo', ['--version'], root),
  };
  const sourceAfter = await verifySourceManifest({ repositoryRoot: root, sourceManifestPath });
  if (sourceBefore.currentStatusSha256 !== sourceAfter.currentStatusSha256 || sourceBefore.currentDiffSha256 !== sourceAfter.currentDiffSha256) {
    throw new Error('Source status or diff changed while recording post-build artifacts');
  }
  const artifactManifest = {
    schema: ARTIFACT_SCHEMA,
    recordedAt: new Date().toISOString(),
    repositoryRoot: root,
    sourceManifest: {
      path: source.sourcePath,
      sha256: source.sha256,
      head: sourceBefore.head,
      tree: sourceBefore.tree,
      frozenDiffSha256: sourceBefore.frozenDiffSha256,
      currentDiffSha256: sourceAfter.currentDiffSha256,
      currentStatusSha256: sourceAfter.currentStatusSha256,
      currentStatus: sourceAfter.currentStatus,
    },
    artifacts: { binary, bundle, pluginManifest, tauriConfig, tauriDriver: driver, webkitDriver },
    toolchain,
    buildCommands: BUILD_COMMANDS,
    recordingScope: 'Post-build hashes are recorded here; this recorder did not launch the application, driver, display, or build commands.',
    interpretation: {
      binaryAndBundleArePostBuildArtifacts: true,
      sourceManifestDescribesCommitAndWipSeparately: true,
      standaloneBundleBuildMustFollowTauriHostBuild: true,
    },
  };
  await writeExclusive(output, `${JSON.stringify(artifactManifest, null, 2)}\n`);
  return {
    artifactManifest: output,
    artifactManifestSha256: sha256(await readFile(output)),
    sourceManifestSha256: source.sha256,
    binarySha256: binary.sha256,
    bundleSha256: bundle.sha256,
    tauriConfigSha256: tauriConfig.sha256,
    toolchain,
  };
}

export async function readArtifactManifest(artifactManifestPath) {
  const artifactPath = ensureAbsolute(artifactManifestPath, 'artifactManifest');
  const info = await lstat(artifactPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Artifact manifest must be a regular file');
  const bytes = await readFile(artifactPath);
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw new Error(`Artifact manifest is not valid JSON: ${error.message}`, { cause: error }); }
  if (manifest?.schema !== ARTIFACT_SCHEMA || !manifest?.artifacts) {
    throw new Error(`Unsupported artifact manifest schema; expected ${ARTIFACT_SCHEMA}`);
  }
  return { artifactPath, bytes, sha256: sha256(bytes), manifest };
}

export async function verifyArtifactManifest({
  repositoryRoot,
  sourceManifestPath,
  artifactManifestPath,
  binaryPath,
  expectedBinarySha256,
  bundlePath,
  expectedBundleSha256,
  pluginManifestPath,
  tauriConfigPath,
  driverPath,
  webkitDriverPath,
}) {
  const root = await realpath(ensureAbsolute(repositoryRoot, 'repositoryRoot'));
  const source = await readSourceManifest(sourceManifestPath);
  const artifact = await readArtifactManifest(artifactManifestPath);
  const actualSource = await verifySourceManifest({ repositoryRoot: root, sourceManifestPath });
  if (artifact.manifest.repositoryRoot !== root) throw new Error('Artifact manifest belongs to another repository');
  if (artifact.manifest.sourceManifest?.path !== source.sourcePath) throw new Error('Artifact manifest points to a different source manifest path');
  if (artifact.manifest.sourceManifest?.sha256 !== source.sha256) throw new Error('Artifact manifest points to a different source freeze');
  if (artifact.manifest.sourceManifest?.head !== actualSource.head || artifact.manifest.sourceManifest?.tree !== actualSource.tree) {
    throw new Error('Artifact manifest source commit/tree differs from the frozen candidate');
  }
  if (artifact.manifest.sourceManifest?.frozenDiffSha256 !== source.manifest.git.diffSha256) {
    throw new Error('Artifact manifest frozen diff hash differs from the source freeze');
  }
  if (artifact.manifest.sourceManifest?.currentStatusSha256 !== actualSource.currentStatusSha256 ||
      artifact.manifest.sourceManifest?.currentDiffSha256 !== actualSource.currentDiffSha256 ||
      artifact.manifest.sourceManifest?.currentStatus !== actualSource.currentStatus) {
    throw new Error('Artifact manifest status/diff differs from the live frozen candidate');
  }

  const requested = {
    binary: { path: ensureAbsolute(binaryPath, 'binary'), sha256: expectedBinarySha256 },
    bundle: { path: ensureAbsolute(bundlePath, 'bundle'), sha256: expectedBundleSha256 },
    pluginManifest: { path: ensureAbsolute(pluginManifestPath, 'manifest') },
    tauriConfig: { path: ensureAbsolute(tauriConfigPath, 'tauriConfig') },
    tauriDriver: { path: ensureAbsolute(driverPath, 'driver') },
    webkitDriver: { path: ensureAbsolute(webkitDriverPath, 'webkitDriver') },
  };
  for (const [name, expected] of Object.entries(requested)) {
    const recorded = artifact.manifest.artifacts[name];
    if (!recorded || recorded.path !== expected.path) throw new Error(`Artifact manifest ${name} path differs from the requested candidate`);
    if (expected.sha256 && recorded.sha256 !== expected.sha256.toLowerCase()) {
      throw new Error(`Artifact manifest ${name} hash differs from the requested SHA`);
    }
    const actual = await fileArtifact(root, expected.path, name, {
      mustBeInsideRepository: ['binary', 'bundle', 'pluginManifest', 'tauriConfig'].includes(name),
      executable: ['binary', 'tauriDriver', 'webkitDriver'].includes(name),
    });
    if (recorded.sha256 !== actual.sha256 || recorded.bytes !== actual.bytes || recorded.mode !== actual.mode) {
      throw new Error(`${name} no longer matches the post-build artifact inventory`);
    }
  }
  return {
    artifactManifestSha256: artifact.sha256,
    sourceManifestSha256: source.sha256,
    source: actualSource,
    artifacts: artifact.manifest.artifacts,
    toolchain: artifact.manifest.toolchain,
    buildCommands: artifact.manifest.buildCommands,
  };
}

async function walkEvidence(root, current = root) {
  const output = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Evidence symlink is not allowed: ${absolute}`);
    if (entry.isDirectory()) output.push(...(await walkEvidence(root, absolute)));
    else if (entry.isFile()) output.push(path.relative(root, absolute).split(path.sep).join('/'));
    else throw new Error(`Unsupported evidence entry: ${absolute}`);
  }
  return output.sort();
}

export async function copyEvidenceDurably({ sourceDirectory, destinationDirectory }) {
  const rawSource = ensureAbsolute(sourceDirectory, 'sourceDirectory');
  const sourceInfo = await lstat(rawSource);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error('Evidence source must be a real directory');
  const source = await realpath(ensureAbsolute(sourceDirectory, 'sourceDirectory'));
  const destination = ensureAbsolute(destinationDirectory, 'destinationDirectory');
  if (isWithin(source, destination) || isWithin(destination, source)) {
    throw new Error('Evidence source and destination must not overlap');
  }
  const temporaryRoot = await realpath(os.tmpdir());
  if (isWithin(temporaryRoot, destination)) throw new Error('Durable evidence destination must be outside the system temporary directory');
  const destinationParent = path.dirname(destination);
  if (await realpath(destinationParent) !== destinationParent) throw new Error('Evidence destination parent must not use symlinks');
  try {
    await lstat(destination);
    throw new Error(`Evidence destination exists; refusing to overwrite ${destination}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const sourceFiles = await walkEvidence(source);
  if (sourceFiles.includes('retention.json')) throw new Error('Evidence source already contains reserved retention.json');
  await mkdir(destination, { recursive: false, mode: 0o700 });
  const records = [];
  // A failed copy leaves the partial destination intact for diagnosis.
  for (const relative of sourceFiles) {
    const sourcePath = path.join(source, relative);
    const destinationPath = path.join(destination, relative);
    await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
    const before = await readFile(sourcePath);
    await writeExclusive(destinationPath, before);
    const after = await readFile(destinationPath);
    if (sha256(before) !== sha256(after)) throw new Error(`Evidence copy hash mismatch: ${relative}`);
    records.push({ path: relative, bytes: before.length, sha256: sha256(before) });
  }
  const receipt = {
    schema: 'morrow-e003-durable-evidence/v1',
    copiedAt: new Date().toISOString(),
    sourceDirectory: source,
    destinationDirectory: destination,
    files: records,
  };
  await writeExclusive(path.join(destination, 'retention.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  const copiedFiles = await walkEvidence(destination);
  const expectedFiles = [...sourceFiles, 'retention.json'].sort();
  if (JSON.stringify(copiedFiles) !== JSON.stringify(expectedFiles)) throw new Error('Durable evidence directory does not match the expected file inventory');
  for (const record of records) {
    const copied = await readFile(path.join(destination, record.path));
    if (copied.length !== record.bytes || sha256(copied) !== record.sha256) throw new Error(`Durable evidence verification failed: ${record.path}`);
  }
  return { destination, fileCount: records.length, files: records, receiptSha256: sha256(await readFile(path.join(destination, 'retention.json'))) };
}

export async function readJsonFile(filePath, label = 'JSON file') {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  try { return JSON.parse((await readFile(filePath)).toString('utf8')); }
  catch (error) { throw new Error(`${label} is not valid JSON: ${error.message}`, { cause: error }); }
}

export function sourceManifestSchema() {
  return SOURCE_SCHEMA;
}

export function artifactManifestSchema() {
  return ARTIFACT_SCHEMA;
}

