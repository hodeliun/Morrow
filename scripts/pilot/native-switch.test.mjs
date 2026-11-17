import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {
  assertSameNativeSwitchMarkdownFiles,
  buildVaultSelectBarrierScript,
  captureFinalNativeSwitchMarkdownFiles,
  captureNativeSwitchMarkdownFiles,
  SWITCH_MARKDOWN_PATHS,
  withSyntheticProfileDirectoryWriteDenied,
} from './native-switch.mjs';

const TARGET_PATH = '/tmp/morrow-switch-synthetic-destination';
const FILE_CONTENTS = {
  'Inventory.md': 'id: synthetic-source\n',
  'Inventory/Widget.md': 'Name: Widget\nQuantity: 2\nPrice: 10\n',
  'Views.md': '# Synthetic views\n\nSynthetic vault marker: OPEN-OLD\n',
};

function createBarrierExecutor(windowObject, initialArguments = []) {
  const context = vm.createContext({
    window: windowObject,
    __args: initialArguments,
    setTimeout,
    clearTimeout,
    performance: { now: () => performance.now() },
  });
  const script = new vm.Script(
    '(function() {\n' + buildVaultSelectBarrierScript() + '\n}).apply(window, __args)',
  );
  return (...args) => {
    context.__args = args;
    return script.runInContext(context);
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForState(execute, predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let state;
  while (Date.now() < deadline) {
    state = execute('read', 'barrier', TARGET_PATH, 100);
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail('Timed out waiting for serialized barrier state: ' + JSON.stringify(state));
}

async function createSyntheticVault(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'morrow-native-switch-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'Inventory'));
  for (const relative of SWITCH_MARKDOWN_PATHS) {
    await writeFile(path.join(root, relative), FILE_CONTENTS[relative], { mode: 0o640 });
  }
  await chmod(path.join(root, 'Inventory'), 0o750);
  return root;
}

async function createProfile(t) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'morrow-native-switch-profile-'));
  t.after(async () => rm(profile, { recursive: true, force: true }));
  await chmod(profile, 0o700);
  await writeFile(path.join(profile, 'vaults.json'), '{"current":"/tmp/a","recent":[]}\n', { mode: 0o600 });
  return profile;
}

test('captures the three canonical Markdown files including hash, size, mtime and mode', async (t) => {
  const vault = await createSyntheticVault(t);
  const snapshot = await captureNativeSwitchMarkdownFiles(vault);
  assert.deepEqual(Object.keys(snapshot).sort(), [...SWITCH_MARKDOWN_PATHS].sort());
  for (const relative of SWITCH_MARKDOWN_PATHS) {
    assert.match(snapshot[relative].sha256, /^[a-f0-9]{64}$/);
    assert.equal(snapshot[relative].size, Buffer.byteLength(FILE_CONTENTS[relative]));
    assert.ok(Number.isFinite(snapshot[relative].mtimeMs));
    assert.equal(snapshot[relative].mode, relative === 'Inventory/Widget.md' ? 0o640 : 0o640);
  }
  const changed = { ...snapshot, 'Inventory.md': { ...snapshot['Inventory.md'], sha256: '0'.repeat(64) } };
  assert.throws(() => assertSameNativeSwitchMarkdownFiles(snapshot, changed, 'test'), /changed sha256/);
  const bytes = await readFile(path.join(vault, 'Inventory.md'));
  assert.equal(bytes.toString('utf8'), FILE_CONTENTS['Inventory.md']);
});

test('final vault snapshots compare all three Markdown files with the initial state', async (t) => {
  const origin = await createSyntheticVault(t);
  const destination = await createSyntheticVault(t);
  const initial = {
    origin: await captureNativeSwitchMarkdownFiles(origin),
    destination: await captureNativeSwitchMarkdownFiles(destination),
  };
  const unchanged = {
    origin: await captureFinalNativeSwitchMarkdownFiles(origin, initial.origin),
    destination: await captureFinalNativeSwitchMarkdownFiles(destination, initial.destination),
  };
  assert.equal(unchanged.origin.status, 'captured');
  assert.equal(unchanged.origin.matchesInitial, true);
  assert.equal(unchanged.destination.matchesInitial, true);
  assert.deepEqual(Object.keys(unchanged.origin.files).sort(), [...SWITCH_MARKDOWN_PATHS].sort());
  assert.deepEqual(Object.keys(unchanged.destination.files).sort(), [...SWITCH_MARKDOWN_PATHS].sort());

  await writeFile(path.join(destination, 'Views.md'), 'Synthetic vault marker: changed\n');
  const changed = await captureFinalNativeSwitchMarkdownFiles(destination, initial.destination);
  assert.equal(changed.status, 'captured');
  assert.equal(changed.matchesInitial, false);
  assert.match(changed.comparisonError.message, /Views\.md changed sha256/);
});

test(
  'temporarily denies only profile-directory write bits and restores the exact mode',
  {
    skip: typeof process.geteuid !== 'function' || process.geteuid() === 0,
  },
  async (t) => {
    const profile = await createProfile(t);
    const originalMode = 0o700;
    const result = await withSyntheticProfileDirectoryWriteDenied(
      profile,
      async ({ mode }) => {
        assert.equal(mode.before, originalMode);
        assert.equal(mode.blocked, 0o500);
        assert.equal(mode.readExecutePreserved, true);
        await assert.rejects(
          writeFile(path.join(profile, 'vaults.json.tmp'), 'must be denied', { flag: 'wx' }),
          (error) => ['EACCES', 'EPERM'].includes(error.code),
        );
        return 'real permission denial';
      },
      { expectedUid: process.geteuid() },
    );
    assert.equal(result.value, 'real permission denial');
    assert.equal(result.watchdogFired, false);
    assert.equal(result.restore.before, originalMode);
    assert.equal(result.restore.blocked, 0o500);
    assert.equal(result.restore.restored, originalMode);
    assert.ok(result.restore.elapsedMs < 5_000);
  },
);

test(
  'restores profile mode while preserving the original callback error',
  {
    skip: typeof process.geteuid !== 'function' || process.geteuid() === 0,
  },
  async (t) => {
    const profile = await createProfile(t);
    const original = new Error('keep this callback error');
    await assert.rejects(
      withSyntheticProfileDirectoryWriteDenied(
        profile,
        async () => {
          throw original;
        },
        {
          expectedUid: process.geteuid(),
        },
      ),
      (error) => error === original,
    );
  },
);

test('serialized own-descriptor barrier preserves this, arguments, one call and result identity', async () => {
  const answer = { ok: true, token: 'same-object' };
  const result = deferred();
  let calls = 0;
  let observedThis = null;
  let observedArgs = null;
  const vault = {
    select(...args) {
      calls += 1;
      observedThis = this;
      observedArgs = args;
      return result.promise;
    },
  };
  const original = vault.select;
  const execute = createBarrierExecutor({ morrow: { vault } });
  const installed = execute('install', 'barrier', TARGET_PATH, 1_000);
  assert.equal(installed.phase, 'installed');
  assert.equal(installed.descriptor.owner, 'own');
  const pending = vault.select(TARGET_PATH, { source: 'Sidebar' });
  const pendingState = execute('read', 'barrier', TARGET_PATH, 1_000);
  assert.equal(pendingState.phase, 'original-pending');
  assert.equal(pendingState.callCount, 1);
  assert.equal(pendingState.originalCallCount, 1);
  assert.equal(pendingState.interceptedCallCount, 1);
  assert.equal(pendingState.thisMatched, true);
  assert.equal(pendingState.targetMatched, true);
  assert.equal(calls, 1);
  assert.equal(observedThis, vault);
  assert.deepEqual(observedArgs, [TARGET_PATH, { source: 'Sidebar' }]);

  result.resolve(answer);
  const state = await waitForState(execute, (value) => value.settlement !== null);
  assert.equal(state.phase, 'settled-held');
  assert.equal(state.callCount, 1);
  assert.equal(state.originalCallCount, 1);
  assert.equal(state.interceptedCallCount, 1);
  assert.equal(state.thisMatched, true);
  assert.equal(state.targetMatched, true);
  assert.equal(calls, 1);
  assert.equal(observedThis, vault);
  assert.deepEqual(observedArgs, [TARGET_PATH, { source: 'Sidebar' }]);
  assert.equal(execute('restore', 'barrier', TARGET_PATH, 1_000).restored, true);
  const release = execute('release', 'barrier', TARGET_PATH, 1_000);
  assert.equal(release.requested, true);
  assert.equal(await pending, answer);
  assert.equal(vault.select, original);
  assert.equal(execute('release', 'barrier', TARGET_PATH, 1_000).requested, false);
  assert.equal(calls, 1);
});

test('serialized inherited-descriptor barrier shadows and then removes only its own wrapper', async () => {
  const answer = { ok: true };
  const result = deferred();
  const prototype = {
    select(...args) {
      assert.equal(this, vault);
      assert.deepEqual(args, [TARGET_PATH]);
      return result.promise;
    },
  };
  const original = prototype.select;
  const vault = Object.create(prototype);
  const execute = createBarrierExecutor({ morrow: { vault } });
  const installed = execute('install', 'barrier', TARGET_PATH, 1_000);
  assert.equal(installed.descriptor.owner, 'inherited');
  assert.equal(installed.descriptor.depth, 1);
  const pending = vault.select(TARGET_PATH);
  result.resolve(answer);
  await waitForState(execute, (value) => value.settlement?.resultOk === true);
  assert.equal(Object.hasOwn(vault, 'select'), true);
  assert.equal(execute('restore', 'barrier', TARGET_PATH, 1_000).restored, true);
  assert.equal(Object.hasOwn(vault, 'select'), false);
  assert.equal(vault.select, original);
  execute('release', 'barrier', TARGET_PATH, 1_000);
  assert.equal(await pending, answer);
});

test('releases the same real rejection object after conditional restoration', async () => {
  const originalError = new Error('real native rejection');
  const result = deferred();
  const vault = {
    select() {
      return result.promise;
    },
  };
  const execute = createBarrierExecutor({ morrow: { vault } });
  execute('install', 'barrier', TARGET_PATH, 1_000);
  const pending = vault.select(TARGET_PATH);
  const observed = pending.then(
    (value) => ({ kind: 'fulfilled', value }),
    (error) => ({ kind: 'rejected', error }),
  );
  result.reject(originalError);
  await waitForState(execute, (value) => value.settlement?.kind === 'rejected');
  assert.equal(execute('restore', 'barrier', TARGET_PATH, 1_000).restored, true);
  execute('release', 'barrier', TARGET_PATH, 1_000);
  const delivered = await observed;
  assert.equal(delivered.kind, 'rejected');
  assert.equal(delivered.error, originalError);
});

test('page watchdog restores conditionally and forwards only a later real settlement', async () => {
  const answer = { ok: true, late: true };
  const result = deferred();
  const vault = {
    select() {
      return result.promise;
    },
  };
  const execute = createBarrierExecutor({ morrow: { vault } });
  execute('install', 'barrier', TARGET_PATH, 15);
  const pending = vault.select(TARGET_PATH);
  const observed = pending.then((value) => value);
  await new Promise((resolve) => setTimeout(resolve, 35));
  const state = execute('read', 'barrier', TARGET_PATH, 15);
  assert.equal(state.watchdogFired, true);
  assert.equal(state.restoreOutcome, 'restored');
  assert.equal(state.releaseRequested, true);
  assert.equal(state.delivered, false);
  result.resolve(answer);
  assert.equal(await observed, answer);
  const after = execute('read', 'barrier', TARGET_PATH, 15);
  assert.equal(after.delivered, true);
  assert.equal(after.originalCallCount, 1);
});

test('watchdog releases the real settlement when freezing the vault makes restore fail', async () => {
  const answer = { ok: true, token: 'settled-after-restore-error' };
  const result = deferred();
  const vault = {
    select() {
      return result.promise;
    },
  };
  const original = vault.select;
  const execute = createBarrierExecutor({ morrow: { vault } });
  execute('install', 'barrier', TARGET_PATH, 15);
  const pending = vault.select(TARGET_PATH);
  const observed = pending.then(
    (value) => ({ kind: 'fulfilled', value }),
    (error) => ({ kind: 'rejected', error }),
  );
  Object.freeze(vault);

  await new Promise((resolve) => setTimeout(resolve, 35));
  const during = execute('read', 'barrier', TARGET_PATH, 15);
  assert.equal(during.watchdogFired, true);
  assert.equal(during.restoreOutcome, 'restore-error');
  assert.match(during.restoreError.message, /Cannot redefine property/);
  assert.equal(during.releaseRequested, true);
  assert.equal(during.releaseSource, 'page-watchdog');
  assert.equal(during.delivered, false);
  assert.equal(Object.isFrozen(vault), true);

  result.resolve(answer);
  const delivered = await observed;
  assert.equal(delivered.kind, 'fulfilled');
  assert.equal(delivered.value, answer);
  const after = execute('read', 'barrier', TARGET_PATH, 15);
  assert.equal(after.delivered, true);
  assert.equal(after.originalCallCount, 1);
  assert.equal(vault.select === original, false);
  assert.equal(Object.isFrozen(vault), true);
});

test(
  'profile mode watchdog restores within the bound and reports its forced restore',
  {
    skip: typeof process.geteuid !== 'function' || process.geteuid() === 0,
  },
  async (t) => {
    const profile = await createProfile(t);
    const result = await withSyntheticProfileDirectoryWriteDenied(
      profile,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 35));
        return 'callback finished after watchdog';
      },
      { expectedUid: process.geteuid(), watchdogMs: 10 },
    );
    assert.equal(result.value, 'callback finished after watchdog');
    assert.equal(result.watchdogFired, true);
    assert.equal(result.restore.reason, 'node-watchdog');
    assert.equal(result.restore.restored, 0o700);
    assert.ok(result.restore.elapsedMs < 5_000);
  },
);

test('conditional restore never overwrites a newer public select method', async () => {
  const answer = { ok: true };
  const result = deferred();
  const vault = {
    select() {
      return result.promise;
    },
  };
  const execute = createBarrierExecutor({ morrow: { vault } });
  execute('install', 'barrier', TARGET_PATH, 1_000);
  const pending = vault.select(TARGET_PATH);
  result.resolve(answer);
  await waitForState(execute, (value) => value.settlement?.resultOk === true);
  const replacement = function replacement() {
    return Promise.resolve({ ok: false });
  };
  Object.defineProperty(vault, 'select', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: replacement,
  });
  const restore = execute('restore', 'barrier', TARGET_PATH, 1_000);
  assert.equal(restore.restored, false);
  assert.equal(restore.state.restoreOutcome, 'not-owned');
  assert.equal(vault.select, replacement);
  execute('release', 'barrier', TARGET_PATH, 1_000);
  assert.equal(await pending, answer);
  assert.equal(vault.select, replacement);
});
