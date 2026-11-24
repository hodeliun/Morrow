#!/usr/bin/env node

// Independent, non-GUI validation for the E003-G06 candidate preparation.
// It uses copied manifests and synthetic temporary paths for negative cases;
// it never edits the frozen checkout or launches Morrow/a WebDriver process.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { copyEvidenceDurably } from './native-preparation.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '../..');
const RUNNER = path.join(REPO_ROOT, 'scripts/pilot/native-bank-smoke.mjs');
const FIXTURE_GENERATOR = path.join(REPO_ROOT, 'scripts/pilot/create-polaris-dados-fixture.mjs');
const TEMP_ROOT = await realpath(os.tmpdir());

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--') || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error(`Expected --source-manifest PATH --artifact-manifest PATH --receipt-dir PATH; got ${argv.join(' ')}`);
    }
    result[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  for (const key of ['source-manifest', 'artifact-manifest', 'receipt-dir']) {
    if (!result[key]) throw new Error(`Missing --${key}`);
  }
  return result;
}

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function fileSha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeNew(file, bytes) {
  await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
}

async function copyTree(source, destination) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error(`Refusing to copy a symlink: ${source}`);
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: false, mode: 0o700 });
    const children = (await readdir(source)).sort();
    for (const name of children) await copyTree(path.join(source, name), path.join(destination, name));
    return;
  }
  if (!info.isFile()) throw new Error(`Unsupported evidence input: ${source}`);
  await writeNew(destination, await readFile(source));
}

async function collectFiles(root, current = root) {
  const result = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected fixture symlink: ${full}`);
    if (entry.isDirectory()) result.push(...(await collectFiles(root, full)));
    else if (entry.isFile()) result.push(path.relative(root, full).split(path.sep).join('/'));
    else throw new Error(`Unsupported fixture entry: ${full}`);
  }
  return result.sort();
}

function decodeLinkedViews(markdown) {
  const records = [];
  const pattern = /<!-- morrow:polaris-dados-view:v1:([A-Za-z0-9_-]+) -->/g;
  for (const match of markdown.matchAll(pattern)) {
    records.push(JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')));
  }
  return records;
}

function numericId(id) {
  const match = /-(\d+)$/.exec(id);
  assert.ok(match, `Fixture ID does not end in a monotonic numeric suffix: ${id}`);
  return BigInt(match[1]);
}

async function assertAbsent(paths, context) {
  for (const item of paths) {
    await assert.rejects(lstat(item), (error) => error?.code === 'ENOENT', `${context}: ${item} must remain absent`);
  }
}

async function execute(command, args, { cwd = REPO_ROOT } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
  });
}

function walkOutputPaths() {
  const runPrefix = `morrow-g06-independent-${process.pid}-${Date.now()}`;
  let sequence = 0;
  const make = (suffix) => {
    return path.join(TEMP_ROOT, `${runPrefix}-${sequence++}-${suffix}`);
  };
  return { make, runPrefix };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourcePath = path.resolve(args['source-manifest']);
  const artifactPath = path.resolve(args['artifact-manifest']);
  const receiptDir = path.resolve(args['receipt-dir']);
  if (isWithin(REPO_ROOT, receiptDir) || isWithin(receiptDir, REPO_ROOT)) {
    throw new Error('Receipt directory must be outside the checkout.');
  }
  if (isWithin(TEMP_ROOT, receiptDir) || receiptDir === TEMP_ROOT) {
    throw new Error('Receipt directory must be outside the system temporary directory.');
  }
  if (await realpath(path.dirname(receiptDir)) !== path.dirname(receiptDir)) {
    throw new Error('Receipt directory parent must be a real, non-symlinked path.');
  }
  await assert.rejects(lstat(receiptDir), (error) => error?.code === 'ENOENT', 'Receipt directory must be new.');
  await mkdir(receiptDir, { recursive: false, mode: 0o700 });

  const sourceBytes = await readFile(sourcePath);
  const artifactBytes = await readFile(artifactPath);
  const source = JSON.parse(sourceBytes.toString('utf8'));
  const artifact = JSON.parse(artifactBytes.toString('utf8'));
  assert.equal(source.schema, 'morrow-e003-g06-source-freeze/v1');
  assert.equal(artifact.schema, 'morrow-e003-g06-artifact-inventory/v1');
  assert.equal(source.repositoryRoot, REPO_ROOT);
  assert.equal(artifact.sourceManifest.sha256, fileSha(sourceBytes));
  assert.equal(path.resolve(artifact.sourceManifest.path), sourcePath);
  assert.equal(artifact.sourceManifest.head, source.git.head);
  assert.equal(artifact.sourceManifest.tree, source.git.tree);
  const expectedPaths = [...source.inventory.trackedPaths, ...source.inventory.untrackedPaths].sort();
  const recordedPaths = source.inventory.files.map((record) => record.path);
  assert.equal(new Set(expectedPaths).size, expectedPaths.length, 'Source path inventory contains duplicates.');
  assert.deepEqual(recordedPaths, expectedPaths, 'Source file records must be the exact tracked/untracked union.');
  const expectedTestHashes = Object.fromEntries(source.inventory.files
    .filter((record) => /(?:^|\/)(?:test|tests)(?:\/|$)/i.test(record.path) || /(?:\.test|\.spec)\.[^/]+$/i.test(record.path))
    .map((record) => [record.path, record.sha256]));
  assert.deepEqual(source.testHashes, expectedTestHashes, 'testHashes must be derived from frozen source records.');
  assert.equal(source.git.statusSha256, source.git.sourceScopeStatusSha256);
  assert.equal(source.git.diffSha256, source.git.sourceScopeDiffSha256);
  assert.ok(path.isAbsolute(source.diff.path));
  assert.ok(!isWithin(REPO_ROOT, source.diff.path) && !isWithin(source.diff.path, REPO_ROOT));
  const diffInfo = await lstat(source.diff.path);
  assert.ok(diffInfo.isFile() && !diffInfo.isSymbolicLink(), 'Frozen WIP diff must be a regular file.');
  const diffBytes = await readFile(source.diff.path);
  assert.equal(diffBytes.length, source.diff.bytes);
  assert.equal(fileSha(diffBytes), source.diff.sha256);

  const testRecord = source.inventory.files.find((record) => record.path === path.relative(REPO_ROOT, SCRIPT_PATH).split(path.sep).join('/'));
  assert.ok(testRecord, 'Independent validator itself must be included in the frozen source inventory.');
  assert.equal(testRecord.sha256, fileSha(await readFile(SCRIPT_PATH)), 'Independent test changed after source freeze.');
  assert.equal(source.testHashes[testRecord.path], testRecord.sha256, 'Independent test hash is absent from testHashes.');

  const binary = artifact.artifacts.binary;
  const bundle = artifact.artifacts.bundle;
  const pluginManifest = artifact.artifacts.pluginManifest;
  const tauriConfig = artifact.artifacts.tauriConfig;
  const driver = artifact.artifacts.tauriDriver;
  const webkitDriver = artifact.artifacts.webkitDriver;
  for (const [label, item] of Object.entries({ binary, bundle, pluginManifest, tauriConfig, driver, webkitDriver })) {
    assert.ok(item && path.isAbsolute(item.path) && /^[a-f0-9]{64}$/i.test(item.sha256), `Invalid artifact record: ${label}`);
    const bytes = await readFile(item.path);
    assert.equal(bytes.length, item.bytes, `${label} byte count differs from artifact inventory.`);
    assert.equal(fileSha(bytes), item.sha256, `${label} hash differs from artifact inventory.`);
  }

  const paths = walkOutputPaths();
  const runs = [];
  const failures = [];
  let fixtureRoots = [];
  let fixtureEvidenceCopied = false;
  let ownedSentinelPath = null;
  let sourceStability = null;
  const sandbox = path.join(TEMP_ROOT, `${paths.runPrefix}-scratch`);
  await mkdir(sandbox, { recursive: false, mode: 0o700 });

  const retainedPath = path.join(receiptDir, 'runner-retention-reserved');
  const baseOutputPaths = () => ({
    vault: paths.make('vault'),
    destinationVault: paths.make('destination'),
    profile: paths.make('profile'),
    evidence: paths.make('evidence'),
    retainedEvidence: retainedPath,
  });

  async function runCase(name, {
    overrides = {},
    expectedSuccess,
    expectedError,
    expectOutputsAbsent = true,
    preserveOutputPaths = [],
  } = {}) {
    const outputPaths = baseOutputPaths();
    const changed = { ...outputPaths, ...overrides.outputPaths };
    const sourceManifest = overrides.sourceManifest ?? sourcePath;
    const artifactManifest = overrides.artifactManifest ?? artifactPath;
    const expectedCommit = overrides.expectedCommit ?? source.git.head;
    const binarySha = overrides.binarySha ?? binary.sha256;
    const bundleSha = overrides.bundleSha ?? bundle.sha256;
    const manifestPath = overrides.manifestPath ?? pluginManifest.path;
    const candidateArgs = [
      '--check-only',
      '--expected-commit', expectedCommit,
      '--binary', binary.path, '--binary-sha256', binarySha,
      '--bundle', bundle.path, '--bundle-sha256', bundleSha,
      '--manifest', manifestPath,
      '--source-manifest', sourceManifest,
      '--artifact-manifest', artifactManifest,
      '--tauri-config', tauriConfig.path,
      '--vault', changed.vault,
      '--destination-vault', changed.destinationVault,
      '--profile', changed.profile,
      '--evidence', changed.evidence,
      '--retained-evidence', changed.retainedEvidence,
      '--driver', driver.path,
      '--webkit-driver', webkitDriver.path,
    ];
    const result = await execute(process.execPath, [RUNNER, ...candidateArgs]);
    const entry = {
      name,
      command: process.execPath,
      args: [RUNNER, ...candidateArgs],
      exitCode: result.code,
      signal: result.signal,
      stdoutBytes: result.stdout.length,
      stdoutSha256: fileSha(result.stdout),
      stderrBytes: result.stderr.length,
      stderrSha256: fileSha(result.stderr),
      outputPaths: changed,
      expectedSuccess,
      expectedError: expectedError ?? null,
      passed: expectedSuccess ? result.code === 0 : result.code !== 0,
    };
    const basename = `${String(runs.length + 1).padStart(2, '0')}-${name.replace(/[^a-zA-Z0-9._-]+/g, '-')}`;
    const stdoutFile = `${basename}.stdout.log`;
    const stderrFile = `${basename}.stderr.log`;
    await writeNew(path.join(receiptDir, stdoutFile), result.stdout);
    await writeNew(path.join(receiptDir, stderrFile), result.stderr);
    entry.stdoutFile = stdoutFile;
    entry.stderrFile = stderrFile;
    runs.push(entry);

    const passed = expectedSuccess ? result.code === 0 : result.code !== 0;
    if (!passed) failures.push(`${name}: expected ${expectedSuccess ? 'exit 0' : 'non-zero exit'}, got ${result.code}`);
    if (expectedError && result.code !== 0) {
      const diagnostic = `${result.stdout.toString('utf8')}\n${result.stderr.toString('utf8')}`;
      if (!new RegExp(expectedError, 'i').test(diagnostic)) {
        failures.push(`${name}: exit was non-zero but no diagnostic matched /${expectedError}/i`);
      }
    }
    if (expectedSuccess && result.code === 0 && !result.stdout.toString('utf8').includes('"nativeRunRequested": false')) {
      failures.push(`${name}: successful check-only output did not explicitly report nativeRunRequested=false`);
    }
    if (expectOutputsAbsent) {
      const absenceSet = Object.values(changed).filter((item) => !preserveOutputPaths.includes(item));
      try { await assertAbsent(absenceSet, name); }
      catch (error) { failures.push(`${name}: ${error.message}`); }
    }
    return result;
  }

  async function copiedManifestCase(name, mutateSource, mutateArtifact = () => {}) {
    const sourceCopy = path.join(sandbox, `${name}.source.json`);
    const artifactCopy = path.join(sandbox, `${name}.artifact.json`);
    const sourceClone = structuredClone(source);
    const artifactClone = structuredClone(artifact);
    mutateSource(sourceClone);
    const sourceCopyBytes = Buffer.from(`${JSON.stringify(sourceClone, null, 2)}\n`);
    artifactClone.sourceManifest.path = sourceCopy;
    artifactClone.sourceManifest.sha256 = fileSha(sourceCopyBytes);
    mutateArtifact(artifactClone);
    await writeNew(sourceCopy, sourceCopyBytes);
    await writeNew(artifactCopy, `${JSON.stringify(artifactClone, null, 2)}\n`);
    const errorExpectations = {
      'reject-test-hash-disagreement': 'testHashes do not match',
      'reject-incomplete-file-inventory': 'exact tracked/untracked path union',
      'reject-source-file-hash-drift': 'Frozen source files changed',
      'reject-source-scope-status-disagreement': 'source status differs from the frozen',
      'reject-source-identity-drift': 'Candidate HEAD .* differs from frozen HEAD',
      'reject-source-tree-drift': 'Candidate HEAD tree .* differs from frozen tree',
      'reject-artifact-source-status-drift': 'Artifact manifest status/diff differs',
      'reject-artifact-binary-record-drift': 'Artifact manifest binary hash differs',
    };
    await runCase(name, {
      overrides: { sourceManifest: sourceCopy, artifactManifest: artifactCopy },
      expectedSuccess: false,
      expectedError: errorExpectations[name],
    });
  }

  async function copiedArtifactCase(name, mutateArtifact) {
    const artifactCopy = path.join(sandbox, `${name}.artifact.json`);
    const artifactClone = structuredClone(artifact);
    mutateArtifact(artifactClone);
    await writeNew(artifactCopy, `${JSON.stringify(artifactClone, null, 2)}\n`);
    await runCase(name, {
      overrides: { artifactManifest: artifactCopy },
      expectedSuccess: false,
      expectedError: name === 'reject-artifact-source-path-drift' ? 'points to a different source manifest path' : undefined,
    });
  }

  async function verifyCandidateUnchanged() {
    for (const expected of source.inventory.files) {
      const absolute = path.join(REPO_ROOT, expected.path);
      const info = await lstat(absolute);
      assert.ok(info.isFile() && !info.isSymbolicLink(), `Frozen source path is no longer a regular file: ${expected.path}`);
      const bytes = await readFile(absolute);
      assert.equal(bytes.length, expected.bytes, `Frozen source byte count changed after check-only: ${expected.path}`);
      assert.equal(fileSha(bytes), expected.sha256, `Frozen source content changed after check-only: ${expected.path}`);
      assert.equal(info.mode & 0o777, expected.mode, `Frozen source mode changed after check-only: ${expected.path}`);
    }
    for (const [name, expected] of Object.entries(artifact.artifacts)) {
      const bytes = await readFile(expected.path);
      const info = await lstat(expected.path);
      assert.ok(info.isFile() && !info.isSymbolicLink(), `Artifact is no longer a regular file: ${name}`);
      assert.equal(bytes.length, expected.bytes, `Artifact byte count changed after check-only: ${name}`);
      assert.equal(fileSha(bytes), expected.sha256, `Artifact content changed after check-only: ${name}`);
      assert.equal(info.mode & 0o777, expected.mode, `Artifact mode changed after check-only: ${name}`);
    }
    const gitCommands = [
      ['git', ['rev-parse', 'HEAD'], 'candidate-head'],
      ['git', ['rev-parse', 'HEAD^{tree}'], 'candidate-tree'],
      ['git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 'candidate-status'],
      ['git', ['diff', '--binary', 'HEAD'], 'candidate-wip-diff'],
    ];
    const results = {};
    for (const [command, commandArgs, label] of gitCommands) {
      const result = await execute(command, commandArgs);
      const basename = `${String(runs.length + 1).padStart(2, '0')}-${label}`;
      await writeNew(path.join(receiptDir, `${basename}.stdout.log`), result.stdout);
      await writeNew(path.join(receiptDir, `${basename}.stderr.log`), result.stderr);
      runs.push({
        name: label,
        command,
        args: commandArgs,
        exitCode: result.code,
        signal: result.signal,
        stdoutBytes: result.stdout.length,
        stdoutSha256: fileSha(result.stdout),
        stderrBytes: result.stderr.length,
        stderrSha256: fileSha(result.stderr),
      });
      assert.equal(result.code, 0, `${label} failed during independent post-check snapshot.`);
      results[label] = { bytes: result.stdout.length, sha256: fileSha(result.stdout) };
    }
    assert.equal(results['candidate-head'].sha256, fileSha(Buffer.from(`${source.git.head}\n`)));
    assert.equal(results['candidate-tree'].sha256, fileSha(Buffer.from(`${source.git.tree}\n`)));
    assert.equal(results['candidate-status'].sha256, source.git.statusSha256);
    assert.equal(results['candidate-wip-diff'].sha256, source.git.diffSha256);
    sourceStability = results;
  }

  try {
    await runCase('candidate-check-only-positive', { expectedSuccess: true });
    await runCase('reject-wrong-expected-commit', {
      overrides: { expectedCommit: source.git.head.replace(/^./, source.git.head[0] === '0' ? '1' : '0') },
      expectedSuccess: false,
      expectedError: 'Candidate HEAD .* differs from --expected-commit',
    });
    await runCase('reject-binary-hash-mismatch', {
      overrides: { binarySha: '0'.repeat(64) },
      expectedSuccess: false,
      expectedError: 'binary hash differs from the requested SHA',
    });
    await runCase('reject-wrong-plugin-manifest-path', {
      overrides: { manifestPath: sourcePath },
      expectedSuccess: false,
      expectedError: 'pluginManifest path differs',
    });

    await copiedManifestCase('reject-test-hash-disagreement', (copy) => {
      copy.testHashes[testRecord.path] = '0'.repeat(64);
    });
    await copiedManifestCase('reject-incomplete-file-inventory', (copy) => {
      copy.inventory.files = copy.inventory.files.filter((entry) => entry.path !== testRecord.path);
      delete copy.testHashes[testRecord.path];
    });
    await copiedManifestCase('reject-source-file-hash-drift', (copy) => {
      const file = copy.inventory.files.find((entry) => entry.path === testRecord.path);
      file.sha256 = file.sha256.replace(/^./, file.sha256[0] === '0' ? '1' : '0');
      copy.testHashes[testRecord.path] = file.sha256;
    });
    await copiedManifestCase('reject-source-scope-status-disagreement', (copy) => {
      copy.git.statusSha256 = '0'.repeat(64);
      copy.git.sourceScopeStatusSha256 = '0'.repeat(64);
    });
    await copiedManifestCase('reject-source-identity-drift', (copy) => {
      copy.git.head = copy.git.head.replace(/^./, copy.git.head[0] === '0' ? '1' : '0');
    }, (copy) => {
      copy.sourceManifest.head = copy.sourceManifest.head.replace(/^./, copy.sourceManifest.head[0] === '0' ? '1' : '0');
    });
    await copiedManifestCase('reject-source-tree-drift', (copy) => {
      copy.git.tree = copy.git.tree.replace(/^./, copy.git.tree[0] === '0' ? '1' : '0');
    }, (copy) => {
      copy.sourceManifest.tree = copy.sourceManifest.tree.replace(/^./, copy.sourceManifest.tree[0] === '0' ? '1' : '0');
    });
    await copiedManifestCase('reject-artifact-source-status-drift', () => {}, (copy) => {
      copy.sourceManifest.currentStatusSha256 = '0'.repeat(64);
    });
    await copiedManifestCase('reject-artifact-binary-record-drift', () => {}, (copy) => {
      copy.artifacts.binary.sha256 = '0'.repeat(64);
    });
    await copiedArtifactCase('reject-artifact-source-path-drift', (copy) => {
      copy.sourceManifest.path = path.join(sandbox, 'unrelated-source-freeze.json');
    });

    await runCase('reject-plugin-manifest-used-as-source-freeze', {
      overrides: { sourceManifest: pluginManifest.path },
      expectedSuccess: false,
      expectedError: 'Unsupported source manifest schema',
    });
    await runCase('reject-output-path-outside-temp-root', {
      overrides: { outputPaths: { vault: path.join(path.dirname(TEMP_ROOT), 'var', 'tmp', `${paths.runPrefix}-outside`) } },
      expectedSuccess: false,
      expectedError: '--vault must be a new directory below',
    });
    const overlap = paths.make('overlap');
    await runCase('reject-overlapping-output-paths', {
      overrides: { outputPaths: { vault: overlap, destinationVault: overlap } },
      expectedSuccess: false,
      expectedError: 'Output paths overlap',
    });
    await runCase('reject-retention-path-inside-tmp', {
      overrides: { outputPaths: { retainedEvidence: paths.make('retained-in-tmp') } },
      expectedSuccess: false,
      expectedError: 'retained-evidence must be outside the temporary directory',
    });

    const existingVault = paths.make('existing-vault');
    await mkdir(existingVault, { recursive: false, mode: 0o700 });
    const sentinelPath = path.join(existingVault, 'keep.txt');
    ownedSentinelPath = sentinelPath;
    const sentinelBytes = Buffer.from('must remain byte-identical\n');
    await writeNew(sentinelPath, sentinelBytes);
    const existingResult = await runCase('reject-existing-output-without-modification', {
      overrides: { outputPaths: { vault: existingVault } },
      expectedSuccess: false,
      expectedError: 'already exists; refusing to reuse it',
      preserveOutputPaths: [existingVault],
    });
    assert.notEqual(existingResult.code, 0);
    assert.deepEqual(await readFile(sentinelPath), sentinelBytes, 'Check-only modified the existing sentinel path.');
    await writeNew(path.join(receiptDir, 'existing-output-sentinel.sha256'), `${fileSha(await readFile(sentinelPath))}\n`);

    await verifyCandidateUnchanged();

    const vaultA = paths.make('fixture-vault-a');
    const vaultB = paths.make('fixture-vault-b');
    fixtureRoots = [vaultA, vaultB];
    const fixtureRun = await execute(process.execPath, [FIXTURE_GENERATOR, vaultA, vaultB]);
    const fixtureOutput = fixtureRun.stdout.toString('utf8');
    const fixtureLog = {
      name: 'two-vault-fixture-generation',
      command: process.execPath,
      args: [FIXTURE_GENERATOR, vaultA, vaultB],
      exitCode: fixtureRun.code,
      signal: fixtureRun.signal,
      stdoutBytes: fixtureRun.stdout.length,
      stdoutSha256: fileSha(fixtureRun.stdout),
      stderrBytes: fixtureRun.stderr.length,
      stderrSha256: fileSha(fixtureRun.stderr),
      stdoutFile: 'fixture-generator.stdout.log',
      stderrFile: 'fixture-generator.stderr.log',
    };
    runs.push(fixtureLog);
    await writeNew(path.join(receiptDir, fixtureLog.stdoutFile), fixtureRun.stdout);
    await writeNew(path.join(receiptDir, fixtureLog.stderrFile), fixtureRun.stderr);
    assert.equal(fixtureRun.code, 0, `Fixture generator failed: ${fixtureRun.stderr.toString('utf8')}`);

    const generated = JSON.parse(fixtureOutput);
    assert.equal(generated.vaults.length, 2);
    assert.equal(generated.vaults[0].marker, 'OPEN-OLD');
    assert.equal(generated.vaults[1].marker, 'OPEN-DESTINATION');
    const fixtureIds = [];
    const allViewIds = [];
    const fixtureSummary = [];
    for (let index = 0; index < generated.vaults.length; index += 1) {
      const vault = generated.vaults[index];
      const expectedRoot = index === 0 ? vaultA : vaultB;
      assert.equal(vault.path, expectedRoot);
      assert.deepEqual(vault.files, [
        'Inventory.md', 'Inventory/Widget.md', 'Views.md', '.morrow/workspace.json', '.morrow/plugins.json',
        '.morrow/plugins/polaris-dados/main.js', '.morrow/plugins/polaris-dados/manifest.json',
        '.morrow/plugins/polaris-dados/README.md', '.morrow/plugins/polaris-dados/LICENSE',
      ]);
      const actualFiles = await collectFiles(expectedRoot);
      assert.deepEqual(actualFiles, [...vault.files].sort(), `Unexpected generated files in ${expectedRoot}`);
      const workspace = await readJson(path.join(expectedRoot, '.morrow/workspace.json'));
      const workspaceIds = ['Inventory.md', 'Inventory/Widget.md', 'Views.md'].map((name) => workspace.pages[name]?.id);
      assert.ok(workspaceIds.every((id) => typeof id === 'string' && id.length > 0));
      assert.equal(new Set(workspaceIds).size, workspaceIds.length, 'Workspace page IDs must be unique within each vault.');
      assert.equal(workspace.pages['Inventory.md'].id, vault.sourceDatabaseId);
      assert.equal(fileSha(await readFile(path.join(expectedRoot, '.morrow/plugins/polaris-dados/main.js'))), bundle.sha256);
      assert.equal(fileSha(await readFile(path.join(expectedRoot, '.morrow/plugins/polaris-dados/manifest.json'))), pluginManifest.sha256);
      assert.deepEqual(JSON.parse(await readFile(path.join(expectedRoot, '.morrow/plugins.json'), 'utf8')).enabled, ['polaris-dados']);
      const note = await readFile(path.join(expectedRoot, 'Views.md'), 'utf8');
      assert.ok(note.includes(vault.marker));
      const views = decodeLinkedViews(note);
      assert.equal(views.length, 2, 'Each synthetic note must store two linked-view markers.');
      assert.equal(new Set(views.map((view) => view.viewId)).size, 2, 'Linked view IDs must differ within the note.');
      assert.ok(views.every((view) => view.sourceDatabaseId === vault.sourceDatabaseId), 'Linked views must use the local database.');
      assert.ok(views.every((view) => Array.isArray(view.columnOrder) && view.columnOrder.length > 0));
      assert.ok(views.every((view) => view.filter && typeof view.filter === 'object'));
      assert.notDeepEqual(views[0].columnOrder, views[1].columnOrder, 'Linked views need independent column configuration.');
      assert.notDeepEqual(views[0].filter, views[1].filter, 'Linked views need independent filter configuration.');
      assert.deepEqual(views.map((view) => view.viewId), vault.linkedViewIds);
      fixtureIds.push(vault.sourceDatabaseId, vault.rowId, vault.noteId, vault.sourceViewId, ...vault.linkedViewIds);
      allViewIds.push(...views.map((view) => view.viewId));
      fixtureSummary.push({
        root: expectedRoot,
        marker: vault.marker,
        views,
        workspaceIds,
      });
    }
    assert.equal(new Set(fixtureIds).size, fixtureIds.length, 'All fixture IDs must be unique across both vaults.');
    assert.equal(new Set(allViewIds).size, allViewIds.length, 'Linked view IDs must be unique across both vaults.');
    const monotonicIds = fixtureIds.map(numericId);
    for (let index = 1; index < monotonicIds.length; index += 1) {
      assert.ok(monotonicIds[index] > monotonicIds[index - 1], 'Fixture IDs must be allocated in strictly increasing order.');
    }
    const fixtureEvidenceRoot = path.join(receiptDir, 'fixture-vaults');
    await mkdir(fixtureEvidenceRoot, { recursive: false, mode: 0o700 });
    await copyTree(vaultA, path.join(fixtureEvidenceRoot, 'vault-a'));
    await copyTree(vaultB, path.join(fixtureEvidenceRoot, 'vault-b'));
    const fixtureHashes = {};
    for (const folder of ['vault-a', 'vault-b']) {
      const root = path.join(fixtureEvidenceRoot, folder);
      for (const relative of await collectFiles(root)) {
        fixtureHashes[`${folder}/${relative}`] = fileSha(await readFile(path.join(root, relative)));
      }
    }
    fixtureEvidenceCopied = true;
    await writeNew(path.join(receiptDir, 'fixture-summary.json'), `${JSON.stringify({
      generatedAt: generated.createdAt,
      idSeed: generated.idSeed,
      vaults: fixtureSummary.map((item) => ({
        root: item.root,
        marker: item.marker,
        views: item.views,
        workspaceIds: item.workspaceIds,
      })),
      fixtureHashes,
    }, null, 2)}\n`);

    // Exercise durable-copy semantics with a tiny, synthetic evidence directory.
    const evidenceSource = path.join(sandbox, 'evidence-source');
    await mkdir(evidenceSource, { recursive: false, mode: 0o700 });
    const evidencePayload = Buffer.from('independent retention probe\n');
    await writeNew(path.join(evidenceSource, 'probe.log'), evidencePayload);
    const retainedCopy = path.join(receiptDir, 'retained-evidence-copy');
    const retention = await copyEvidenceDurably({ sourceDirectory: evidenceSource, destinationDirectory: retainedCopy });
    assert.equal(retention.fileCount, 1);
    assert.deepEqual(await readFile(path.join(retainedCopy, 'probe.log')), evidencePayload);
    const retentionReceipt = await readJson(path.join(retainedCopy, 'retention.json'));
    assert.equal(retentionReceipt.schema, 'morrow-e003-durable-evidence/v1');
    assert.equal(retentionReceipt.files[0].sha256, fileSha(evidencePayload));
    const existingRetention = path.join(receiptDir, 'existing-retention-target');
    await mkdir(existingRetention, { recursive: false, mode: 0o700 });
    const retainSentinelPath = path.join(existingRetention, 'keep.txt');
    await writeNew(retainSentinelPath, Buffer.from('do not overwrite\n'));
    await assert.rejects(
      copyEvidenceDurably({ sourceDirectory: evidenceSource, destinationDirectory: existingRetention }),
      /exists; refusing to overwrite/,
    );
    assert.equal(fileSha(await readFile(retainSentinelPath)), fileSha(Buffer.from('do not overwrite\n')));
    await writeNew(path.join(receiptDir, 'retention-summary.json'), `${JSON.stringify({
      receiptSha256: retention.receiptSha256,
      retainedCopy,
      copiedFiles: retention.files,
      existingTargetPreserved: true,
    }, null, 2)}\n`);
  } catch (error) {
    failures.push(error?.stack ?? String(error));
  } finally {
    // Persist test outcome before removing only this script's explicit scratch outputs.
    const summary = {
      schema: 'morrow-e003-g06-independent-preparation-receipt/v1',
      completedAt: new Date().toISOString(),
      repositoryRoot: REPO_ROOT,
      sourceManifest: { path: sourcePath, sha256: fileSha(sourceBytes) },
      artifactManifest: { path: artifactPath, sha256: fileSha(artifactBytes) },
      independentValidator: { path: SCRIPT_PATH, sha256: fileSha(await readFile(SCRIPT_PATH)) },
      candidate: { head: source.git.head, tree: source.git.tree, binarySha256: binary.sha256, bundleSha256: bundle.sha256 },
      mode: 'check-only plus synthetic fixture/retention validation; no GUI or app launch',
      runs,
      sourceStability,
      failures,
      cleanup: {
        scratchDirectory: sandbox,
        fixtureRoots,
        fixtureEvidenceCopied,
        retainedFailureFixtureRoots: fixtureEvidenceCopied ? [] : fixtureRoots,
        removedSentinelDirectory: ownedSentinelPath ? path.dirname(ownedSentinelPath) : null,
      },
    };
    await writeNew(path.join(receiptDir, 'receipt.json'), `${JSON.stringify(summary, null, 2)}\n`);
    const receiptHash = fileSha(await readFile(path.join(receiptDir, 'receipt.json')));
    await writeNew(path.join(receiptDir, 'receipt.sha256'), `${receiptHash}  receipt.json\n`);
    if (fixtureEvidenceCopied) {
      for (const root of fixtureRoots) await rm(root, { recursive: true, force: true });
    }
    await rm(sandbox, { recursive: true, force: true });
    if (ownedSentinelPath) await rm(path.dirname(ownedSentinelPath), { recursive: true, force: true });
  }

  if (failures.length) throw new Error(`Independent preparation validation failed (${failures.length} issue(s)); see ${path.join(receiptDir, 'receipt.json')}`);
  process.stdout.write(`${JSON.stringify({ ok: true, receiptDir, receiptSha256: fileSha(await readFile(path.join(receiptDir, 'receipt.json'))), checks: runs.length })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
