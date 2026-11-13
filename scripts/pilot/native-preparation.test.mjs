import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  buildVaultRegistry,
  copyEvidenceDurably,
  freezeSourceManifest,
  recordArtifactManifest,
  readArtifactManifest,
  readSourceManifest,
  verifyArtifactManifest,
  verifySourceManifest,
} from './native-preparation.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '../..');
const FIXTURE_GENERATOR = path.join(SCRIPT_DIRECTORY, 'create-polaris-dados-fixture.mjs');

async function run(command, args, cwd) {
  const result = await execFileAsync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return result.stdout;
}

async function temporaryDirectory(prefix = 'morrow-g06-native-prep-') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function decodeViews(markdown) {
  return [...markdown.matchAll(/<!-- morrow:polaris-dados-view:v1:([A-Za-z0-9_-]+) -->/g)]
    .map((match) => JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')));
}

test('fixture generator creates two isolated vaults with monotonic IDs and two distinct views', async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin');
  const destination = path.join(root, 'destination');
  const output = await run(process.execPath, [FIXTURE_GENERATOR, origin, destination], REPOSITORY_ROOT);
  const generated = JSON.parse(output);
  assert.equal(generated.vaults.length, 2);
  assert.equal(generated.vaults[0].marker, 'OPEN-OLD');
  assert.equal(generated.vaults[1].marker, 'OPEN-DESTINATION');

  const allIds = [];
  for (const vault of generated.vaults) {
    const workspace = JSON.parse(await readFile(path.join(vault.path, '.morrow/workspace.json'), 'utf8'));
    const pageIds = ['Inventory.md', 'Inventory/Widget.md', 'Views.md'].map((item) => workspace.pages[item].id);
    const note = await readFile(path.join(vault.path, 'Views.md'), 'utf8');
    const views = decodeViews(note);
    assert.equal(views.length, 2);
    assert.ok(note.includes(`Synthetic vault marker: ${vault.marker}`));
    assert.ok(views.every((view) => view.sourceDatabaseId === vault.sourceDatabaseId));
    assert.notDeepEqual(views[0].columnOrder, views[1].columnOrder);
    assert.notDeepEqual(views[0].filter, views[1].filter);
    assert.deepEqual(views.map((view) => view.viewId), vault.linkedViewIds);
    assert.equal(pageIds[0], vault.sourceDatabaseId);
    allIds.push(...pageIds, vault.sourceViewId, ...vault.linkedViewIds);
    assert.deepEqual((await readdir(vault.path)).sort(), ['.morrow', 'Inventory', 'Inventory.md', 'Views.md'].sort());
  }
  assert.equal(new Set(allIds).size, allIds.length);
  const numbers = allIds.map((id) => BigInt(/-(\d+)$/.exec(id)?.[1] ?? '-1'));
  assert.ok(numbers.every((number, index) => index === 0 || number > numbers[index - 1]));
});

test('source freeze and post-build artifact inventory identify commit, WIP, tests, and immutable inputs', async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repo');
  const evidence = path.join(root, 'evidence');
  await mkdir(repository);
  await mkdir(evidence);
  await mkdir(path.join(repository, 'bin'));
  await run('git', ['init', '-q'], repository);
  await run('git', ['config', 'user.name', 'Native Prep Test'], repository);
  await run('git', ['config', 'user.email', 'native-prep@example.invalid'], repository);

  await writeFile(path.join(repository, 'source.js'), 'export const value = 1;\n');
  await writeFile(path.join(repository, 'test.test.mjs'), 'import test from "node:test";\ntest("fixture", () => {});\n');
  await mkdir(path.join(repository, 'plugins'));
  await writeFile(path.join(repository, 'plugins/manifest.json'), `${JSON.stringify({ id: 'polaris-dados', name: 'Polaris Dados' })}\n`);
  await writeFile(path.join(repository, 'tauri.pilot.conf.json'), `${JSON.stringify({ identifier: 'app.morrow.polaris-dados-pilot' })}\n`);
  await writeFile(path.join(repository, 'bundle.js'), 'export const plugin = true;\n');
  await writeFile(path.join(repository, 'bin/morrow'), '#!/bin/sh\nexit 0\n');
  await chmod(path.join(repository, 'bin/morrow'), 0o755);
  await run('git', ['add', '.'], repository);
  await run('git', ['commit', '-q', '-m', 'candidate base'], repository);
  await writeFile(path.join(repository, 'source.js'), 'export const value = 2; // WIP\n');
  await writeFile(path.join(repository, 'extra.fixture.test.mjs'), 'export const fixture = true;\n');

  const sourceManifestPath = path.join(evidence, 'source-manifest.json');
  const diffPath = path.join(evidence, 'source-wip.patch');
  const frozen = await freezeSourceManifest({
    repositoryRoot: repository,
    sourceManifestOutput: sourceManifestPath,
    diffOutput: diffPath,
  });
  const source = await readSourceManifest(sourceManifestPath);
  assert.equal(source.manifest.git.head, frozen.head);
  assert.equal(source.manifest.git.tree, frozen.tree);
  assert.equal(source.manifest.interpretation.workingTreeChangesAreWip, true);
  assert.ok(source.manifest.inventory.trackedPaths.includes('test.test.mjs'));
  assert.ok(source.manifest.inventory.untrackedPaths.includes('extra.fixture.test.mjs'));
  assert.equal(source.manifest.testHashes['extra.fixture.test.mjs'], source.manifest.inventory.files.find((file) => file.path === 'extra.fixture.test.mjs').sha256);
  assert.equal(await verifySourceManifest({ repositoryRoot: repository, sourceManifestPath }).then((value) => value.head), frozen.head);

  const binaryPath = path.join(repository, 'bin/morrow');
  const bundlePath = path.join(repository, 'bundle.js');
  const manifestPath = path.join(repository, 'plugins/manifest.json');
  const configPath = path.join(repository, 'tauri.pilot.conf.json');
  const driverPath = path.join(root, 'tauri-driver');
  const webkitDriverPath = path.join(root, 'WebKitWebDriver');
  await writeFile(driverPath, '#!/bin/sh\nexit 0\n');
  await writeFile(webkitDriverPath, '#!/bin/sh\nexit 0\n');
  await chmod(driverPath, 0o755);
  await chmod(webkitDriverPath, 0o755);
  const artifactManifestPath = path.join(evidence, 'artifact-manifest.json');
  const recorded = await recordArtifactManifest({
    repositoryRoot: repository,
    sourceManifestPath,
    artifactManifestOutput: artifactManifestPath,
    binaryPath,
    bundlePath,
    pluginManifestPath: manifestPath,
    tauriConfigPath: configPath,
    driverPath,
    webkitDriverPath,
  });
  const artifact = await readArtifactManifest(artifactManifestPath);
  assert.equal(artifact.manifest.sourceManifest.sha256, source.sha256);
  assert.equal(artifact.manifest.sourceManifest.head, frozen.head);
  assert.equal(artifact.manifest.artifacts.binary.sha256, recorded.binarySha256);
  assert.deepEqual(artifact.manifest.buildCommands, [
    'npm run tauri -- build --debug --no-bundle --config src-tauri/tauri.pilot.conf.json',
    'npm run build:polaris-dados',
  ]);
  assert.equal((await verifyArtifactManifest({
    repositoryRoot: repository,
    sourceManifestPath,
    artifactManifestPath,
    binaryPath,
    expectedBinarySha256: artifact.manifest.artifacts.binary.sha256,
    bundlePath,
    expectedBundleSha256: artifact.manifest.artifacts.bundle.sha256,
    pluginManifestPath: manifestPath,
    tauriConfigPath: configPath,
    driverPath,
    webkitDriverPath,
  })).sourceManifestSha256, source.sha256);

  const tampered = structuredClone(source.manifest);
  tampered.inventory.files = tampered.inventory.files.filter((file) => file.path !== 'test.test.mjs');
  const tamperedPath = path.join(evidence, 'source-manifest-incomplete.json');
  await writeFile(tamperedPath, `${JSON.stringify(tampered)}\n`);
  await assert.rejects(readSourceManifest(tamperedPath), /exact tracked\/untracked path union/);

  await writeFile(path.join(repository, 'source.js'), 'export const value = 3; // drift\n');
  await assert.rejects(verifySourceManifest({ repositoryRoot: repository, sourceManifestPath }), /Frozen source files changed/);
});

test('vault profile registration is explicit and durable evidence refuses overlap or overwrite', async (t) => {
  const registry = buildVaultRegistry('/tmp/polaris-origin', '/tmp/polaris-destination', 100);
  assert.equal(registry.current, '/tmp/polaris-origin');
  assert.deepEqual(registry.recent.map((entry) => entry.path), ['/tmp/polaris-origin', '/tmp/polaris-destination']);
  assert.throws(() => buildVaultRegistry('/tmp/same', '/tmp/same', 100), /must be distinct/);

  const scratch = await temporaryDirectory();
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const source = path.join(scratch, 'evidence');
  await mkdir(source);
  await writeFile(path.join(source, 'run.log'), 'synthetic evidence\n');
  const durableParent = path.join(os.homedir(), '.local/state/morrow/checks/issue-151/unit-tests');
  await mkdir(durableParent, { recursive: true, mode: 0o700 });
  const durableRoot = await mkdtemp(path.join(durableParent, `native-prep-${process.pid}-`));
  t.after(() => rm(durableRoot, { recursive: true, force: true }));
  const destination = path.join(durableRoot, 'retained');
  const receipt = await copyEvidenceDurably({ sourceDirectory: source, destinationDirectory: destination });
  assert.equal(receipt.fileCount, 1);
  assert.equal(await readFile(path.join(destination, 'run.log'), 'utf8'), 'synthetic evidence\n');
  await assert.rejects(copyEvidenceDurably({ sourceDirectory: source, destinationDirectory: destination }), /exists; refusing to overwrite/);
  await assert.rejects(copyEvidenceDurably({ sourceDirectory: source, destinationDirectory: path.join(source, 'nested') }), /must not overlap/);
});
