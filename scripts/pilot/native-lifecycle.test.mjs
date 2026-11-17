import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  assertFileSnapshotsUnchanged,
  assertJsonSnapshotsSemanticallyEqual,
  assertMountTransitions,
  createUnsupportedSchemaBytes,
  sha256,
  waitFor,
  withSyntheticActivationFault,
  withSyntheticMarkdownOverride,
} from './native-lifecycle.mjs';

const RUNNER = fileURLToPath(new URL('./native-bank-smoke.mjs', import.meta.url));

async function makeCandidate(t) {
  const vault = await mkdtemp(path.join(os.tmpdir(), 'morrow-lifecycle-vault-'));
  const bundleRoot = await mkdtemp(path.join(os.tmpdir(), 'morrow-lifecycle-bundle-'));
  const installed = path.join(vault, '.morrow', 'plugins', 'polaris-dados', 'main.js');
  const bundle = path.join(bundleRoot, 'main.js');
  const bundleBytes = Buffer.from('export default function activate() {}\n');
  await mkdir(path.dirname(installed), { recursive: true });
  await writeFile(installed, bundleBytes);
  await writeFile(bundle, bundleBytes);
  t.after(async () => {
    await rm(vault, { recursive: true, force: true });
    await rm(bundleRoot, { recursive: true, force: true });
  });
  return { vault, bundle, bundleSha256: sha256(bundleBytes), installed, bundleBytes };
}

test('provider lifecycle assertion requires the exact alternating mount sequence', () => {
  assert.deepEqual(
    assertMountTransitions([{ kind: 'mount' }, { kind: 'unmount' }, { kind: 'mount' }], {
      mounts: 2,
      unmounts: 1,
    }),
    { mounts: 2, unmounts: 1, sequence: ['mount', 'unmount', 'mount'] },
  );
  assert.deepEqual(
    assertMountTransitions([{ kind: 'mount' }, { kind: 'unmount' }], { mounts: 1, unmounts: 1 }),
    { mounts: 1, unmounts: 1, sequence: ['mount', 'unmount'] },
  );
  assert.throws(
    () => assertMountTransitions([{ kind: 'mount' }, { kind: 'mount' }], { mounts: 2, unmounts: 0 }),
    /not paired/,
  );
  assert.throws(
    () => assertMountTransitions([{ kind: 'unmount' }, { kind: 'mount' }], { mounts: 1, unmounts: 1 }),
    /initially mounted provider/,
  );
  assert.throws(
    () => assertMountTransitions([{ kind: 'mount' }, { kind: 'unmount' }], { mounts: 1, unmounts: 2 }),
    /expected 1 mount\(s\) and 2 unmount\(s\)/,
  );
});

test('wait condition requires an explicit acceptance predicate', async () => {
  await assert.rejects(
    waitFor('missing predicate', async () => true),
    /requires read and accept callbacks/,
  );
  assert.equal(
    await waitFor(
      'accepted value',
      async () => 'ready',
      (value) => value === 'ready',
    ),
    'ready',
  );
});

test('synthetic Markdown override is allowlisted and restored even when its observation fails', async (t) => {
  const candidate = await makeCandidate(t);
  const rowPath = path.join(candidate.vault, 'Inventory', 'Widget.md');
  await mkdir(path.dirname(rowPath), { recursive: true });
  const original = Buffer.from('---\nQuantity: 2\nPrice: 10\n---\n');
  const replacement = Buffer.from('---\nQuantity: 7\nPrice: 10\n---\n');
  await writeFile(rowPath, original);

  await assert.rejects(
    withSyntheticMarkdownOverride(
      candidate,
      '.morrow/plugins/polaris-dados/main.js',
      replacement,
      async () => {},
    ),
    /allowlist/,
  );
  await assert.rejects(
    withSyntheticMarkdownOverride(candidate, 'Inventory/Widget.md', replacement, async ({ injected }) => {
      assert.equal(injected.hash, sha256(replacement));
      assert.deepEqual(await readFile(rowPath), replacement);
      throw new Error('synthetic observation failure');
    }),
    /synthetic observation failure/,
  );
  assert.deepEqual(await readFile(rowPath), original);
});

test('installed activation fault changes only the synthetic copy and restores it after observation', async (t) => {
  const candidate = await makeCandidate(t);
  const outcome = await withSyntheticActivationFault(
    candidate,
    async ({ installedPath, original, injected }) => {
      assert.equal(installedPath, candidate.installed);
      assert.equal(original.hash, candidate.bundleSha256);
      assert.notEqual(injected.hash, original.hash);
      assert.match(await readFile(installedPath, 'utf8'), /synthetic lifecycle activation fault/);
      return 'observed';
    },
  );
  assert.equal(outcome.result, 'observed');
  assert.equal(outcome.injected.hash !== outcome.original.hash, true);
  assert.equal(outcome.restored.hash, outcome.original.hash);
  assert.equal(outcome.bundleAfter.hash, outcome.bundleBefore.hash);
  assert.deepEqual(await readFile(candidate.installed), candidate.bundleBytes);
  assert.deepEqual(await readFile(candidate.bundle), candidate.bundleBytes);
});

test('activation fault restoration runs after a failing callback and leaves the bundle untouched', async (t) => {
  const candidate = await makeCandidate(t);
  await assert.rejects(
    withSyntheticActivationFault(candidate, async ({ injected }) => {
      assert.notEqual(injected.hash, candidate.bundleSha256);
      throw new Error('activation observation failed');
    }),
    /activation observation failed/,
  );
  assert.deepEqual(await readFile(candidate.installed), candidate.bundleBytes);
  assert.deepEqual(await readFile(candidate.bundle), candidate.bundleBytes);
});

test('unsupported schema fixture preserves the original and adds a duplicate property name', () => {
  const original = Buffer.from(
    [
      '---',
      'kind: database',
      'database:',
      '  properties:',
      '    - id: name',
      '      name: Name',
      '      type: text',
      '  views:',
      '    - id: table',
      '      name: Table',
      '      type: table',
      '---',
    ].join('\n'),
  );
  const unsupported = createUnsupportedSchemaBytes(original);
  assert.deepEqual(
    original,
    Buffer.from(
      [
        '---',
        'kind: database',
        'database:',
        '  properties:',
        '    - id: name',
        '      name: Name',
        '      type: text',
        '  views:',
        '    - id: table',
        '      name: Table',
        '      type: table',
        '---',
      ].join('\n'),
    ),
  );
  const decoded = unsupported.toString('utf8');
  assert.match(decoded, /id: lifecycle-name-duplicate/);
  assert.equal(decoded.match(/name: Name/g)?.length, 2);
  assert.equal(decoded.match(/^\x20{2}views:$/gm)?.length, 1);
});

test('file snapshot guard checks bytes and, when requested, modification time', () => {
  const before = { 'Inventory.md': { hash: 'same', size: 4, mtimeMs: 10 } };
  const bytesSameMtimeChanged = { 'Inventory.md': { hash: 'same', size: 4, mtimeMs: 11 } };
  assert.equal(
    assertFileSnapshotsUnchanged(before, bytesSameMtimeChanged, 'bytes only', { checkMtime: false }),
    true,
  );
  assert.throws(() => assertFileSnapshotsUnchanged(before, bytesSameMtimeChanged, 'strict'), /mtime changed/);
  assert.throws(
    () =>
      assertFileSnapshotsUnchanged(
        before,
        { 'Inventory.md': { hash: 'other', size: 5, mtimeMs: 10 } },
        'bytes',
      ),
    /bytes changed/,
  );
});

test('plugin configuration guard compares JSON meaning rather than rewrite formatting', () => {
  assert.equal(
    assertJsonSnapshotsSemanticallyEqual(
      { bytes: Buffer.from('{"enabled":["polaris-dados"],"version":1}') },
      { bytes: Buffer.from('{\n  "version": 1,\n  "enabled": ["polaris-dados"]\n}') },
      'settings toggle',
    ),
    true,
  );
  assert.throws(
    () =>
      assertJsonSnapshotsSemanticallyEqual(
        { bytes: Buffer.from('{"enabled":["polaris-dados"]}') },
        { bytes: Buffer.from('{"enabled":[]}') },
        'settings toggle',
      ),
    /changed semantically/,
  );
});

test('runner exposes both fixed lifecycle callbacks without launching for check-only', () => {
  const help = spawnSync(process.execPath, [RUNNER, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /lifecycle\|lifecycle-independent/);

  for (const scenario of ['lifecycle', 'lifecycle-independent']) {
    const check = spawnSync(process.execPath, [RUNNER, '--check-only', '--scenario', scenario], {
      encoding: 'utf8',
    });
    assert.equal(check.status, 1, `${scenario}: ${check.stderr}`);
    assert.match(check.stderr, /Missing --expected-commit/);
    assert.doesNotMatch(check.stderr, /Unknown fixed scenario/);
    assert.doesNotMatch(check.stderr, /--run-native/);
  }

  const unknown = spawnSync(process.execPath, [RUNNER, '--check-only', '--scenario', 'unknown-lifecycle'], {
    encoding: 'utf8',
  });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown fixed scenario unknown-lifecycle/);
});
