import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HELPER_PATH = path.join(REPO_ROOT, 'scripts', 'pilot', 'native-runtime-isolation.mjs');

const poison = Object.freeze({
  HOME: 'synthetic-poison-home',
  PATH: 'synthetic-poison-path',
  XDG_CONFIG_HOME: 'synthetic-poison-xdg-config',
  XDG_DATA_HOME: 'synthetic-poison-xdg-data',
  XDG_CACHE_HOME: 'synthetic-poison-xdg-cache',
  XDG_RUNTIME_DIR: 'synthetic-poison-xdg-runtime',
  DISPLAY: ':987',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/synthetic-poison/session-bus',
  DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/synthetic-poison/system-bus',
  DBUS_STARTER_ADDRESS: 'unix:path=/synthetic-poison/starter-bus',
  DBUS_STARTER_BUS_TYPE: 'synthetic-poison-starter-type',
  DBUS_SESSION_BUS_PID: '918273',
  GNOME_KEYRING_CONTROL: '/synthetic-poison/keyring',
  SSH_AUTH_SOCK: '/synthetic-poison/ssh-agent',
  GPG_AGENT_INFO: '/synthetic-poison/gpg-agent:918273:1',
  AT_SPI_BUS_ADDRESS: 'unix:path=/synthetic-poison/a11y-bus',
  WAYLAND_DISPLAY: 'synthetic-poison-wayland',
  XAUTHORITY: '/synthetic-poison/xauthority',
  LD_PRELOAD: '/synthetic-poison/nonexistent-library.so',
  GTK_MODULES: 'synthetic-poison-module',
});

const PRIVATE_ENV_KEYS = new Set([
  'HOME',
  'MORROW_USER_DATA',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'DISPLAY',
  'DBUS_SESSION_BUS_ADDRESS',
  'GDK_BACKEND',
  'WEBKIT_DISABLE_DMABUF_RENDERER',
  'PATH',
]);

const FORBIDDEN_INHERITED_KEY = /^(?:DBUS_(?:SESSION|SYSTEM|STARTER)|GNOME_KEYRING_|SSH_AUTH_SOCK$|GPG_AGENT_INFO$|AT_SPI_BUS_ADDRESS$|WAYLAND_DISPLAY$|XAUTHORITY$|LD_PRELOAD$|GTK_MODULES$)/;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assertSafeSummary(value) {
  const leaves = [];
  const visit = (item) => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) visit(child);
      return;
    }
    leaves.push(item);
  };
  visit(value);
  assert.ok(leaves.length > 0, 'runtime summary must contain evidence');
  for (const leaf of leaves) {
    assert.ok(
      typeof leaf === 'boolean' || (typeof leaf === 'string' && /^[a-f0-9]{64}$/i.test(leaf)),
      'runtime summary leaves must contain only booleans or SHA-256 values',
    );
  }
}

test('runtime environment is rebuilt from private values and ignores inherited session, agent, display, and loader variables', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'morrow-runtime-env-independent-'));
  try {
    const profile = path.join(root, 'profile');
    const xdg = {
      config: path.join(profile, 'xdg', 'config'),
      data: path.join(profile, 'xdg', 'data'),
      cache: path.join(profile, 'xdg', 'cache'),
      runtime: path.join(profile, 'xdg', 'runtime'),
    };
    const helperUrl = pathToFileURL(HELPER_PATH).href;
    const childScript = `
      const { createPrivateRuntimeEnv, summarizeRuntimeEnvironment } = await import(${JSON.stringify(helperUrl)});
      const profile = ${JSON.stringify(profile)};
      const xdg = ${JSON.stringify(xdg)};
      const beforeDisplayAndBus = createPrivateRuntimeEnv({ profile, xdg });
      const privateBusAddress = 'unix:path=' + xdg.runtime + '/bus';
      const afterDisplayAndBus = createPrivateRuntimeEnv({ profile, xdg, display: ':814', busAddress: privateBusAddress });
      const privateBusAddressWithGuid = privateBusAddress + ',guid=' + 'a'.repeat(32);
      const afterDisplayAndBusWithGuid = createPrivateRuntimeEnv({ profile, xdg, display: ':814', busAddress: privateBusAddressWithGuid });
      let rejectsOtherBusAddress = false;
      try {
        createPrivateRuntimeEnv({ profile, xdg, display: ':814', busAddress: 'unix:path=/synthetic-poison/session-bus' });
      } catch {
        rejectsOtherBusAddress = true;
      }
      let rejectsMalformedGuid = false;
      try {
        createPrivateRuntimeEnv({ profile, xdg, display: ':814', busAddress: privateBusAddress + ',guid=not-a-guid' });
      } catch {
        rejectsMalformedGuid = true;
      }
      const expected = {
        HOME: profile,
        MORROW_USER_DATA: profile,
        XDG_CONFIG_HOME: xdg.config,
        XDG_DATA_HOME: xdg.data,
        XDG_CACHE_HOME: xdg.cache,
        XDG_RUNTIME_DIR: xdg.runtime,
        DISPLAY: ':814',
        DBUS_SESSION_BUS_ADDRESS: privateBusAddress,
        GDK_BACKEND: 'x11',
        WEBKIT_DISABLE_DMABUF_RENDERER: '1',
        PATH: '/usr/bin:/bin',
      };
      const summary = summarizeRuntimeEnvironment({ actual: afterDisplayAndBus, expected });
      const forbiddenKeys = ['DBUS_STARTER_ADDRESS', 'DBUS_SYSTEM_BUS_ADDRESS', 'SSH_AUTH_SOCK'];
      const poisonedActual = {
        ...afterDisplayAndBus,
        DBUS_STARTER_ADDRESS: ${JSON.stringify(poison.DBUS_STARTER_ADDRESS)},
        DBUS_SYSTEM_BUS_ADDRESS: ${JSON.stringify(poison.DBUS_SYSTEM_BUS_ADDRESS)},
        SSH_AUTH_SOCK: ${JSON.stringify(poison.SSH_AUTH_SOCK)},
      };
      const forbiddenSummary = summarizeRuntimeEnvironment({ actual: poisonedActual, expected, forbiddenKeys });
      const mismatchedSummary = summarizeRuntimeEnvironment({
        actual: afterDisplayAndBus,
        expected: { ...expected, HOME: ${JSON.stringify(poison.HOME)} },
      });
      process.stdout.write(JSON.stringify({ beforeDisplayAndBus, afterDisplayAndBus, afterDisplayAndBusWithGuid, rejectsOtherBusAddress, rejectsMalformedGuid, summary, forbiddenSummary, mismatchedSummary }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
      cwd: REPO_ROOT,
      env: { ...poison },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.error, undefined, 'synthetic environment probe should start');
    assert.equal(result.status, 0, 'synthetic environment probe should complete');
    const observed = JSON.parse(result.stdout);

    const privateBusAddress = `unix:path=${xdg.runtime}/bus`;
    const allowedPrivateBusAddresses = new Set([
      privateBusAddress,
      `${privateBusAddress},guid=${'a'.repeat(32)}`,
    ]);
    for (const env of [observed.beforeDisplayAndBus, observed.afterDisplayAndBus, observed.afterDisplayAndBusWithGuid]) {
      assert.ok(Object.keys(env).every((key) => PRIVATE_ENV_KEYS.has(key)), 'child environment must use the harness allowlist');
      assert.ok(
        Object.entries(env).every(([key, value]) =>
          !FORBIDDEN_INHERITED_KEY.test(key) || (key === 'DBUS_SESSION_BUS_ADDRESS' && allowedPrivateBusAddresses.has(value))),
        'no forbidden inherited key may reach a child; only the exact private session address is permitted',
      );
      for (const marker of Object.values(poison)) {
        assert.ok(!Object.values(env).includes(marker), 'poisoned inherited values must not reach a child');
      }
      assert.equal(env.HOME, profile, 'HOME must point at the private profile');
      assert.equal(env.MORROW_USER_DATA, profile, 'Morrow profile must point at the private profile');
      assert.equal(env.XDG_CONFIG_HOME, xdg.config, 'config XDG path must be private');
      assert.equal(env.XDG_DATA_HOME, xdg.data, 'data XDG path must be private');
      assert.equal(env.XDG_CACHE_HOME, xdg.cache, 'cache XDG path must be private');
      assert.equal(env.XDG_RUNTIME_DIR, xdg.runtime, 'runtime XDG path must be private');
      assert.notEqual(env.PATH, poison.PATH, 'PATH must not inherit the poisoned value');
    }

    assert.equal('DISPLAY' in observed.beforeDisplayAndBus, false, 'display must be unset before private Xvfb starts');
    assert.equal('DBUS_SESSION_BUS_ADDRESS' in observed.beforeDisplayAndBus, false, 'session address must be unset before private DBus starts');
    assert.equal(observed.afterDisplayAndBus.DISPLAY, ':814', 'only the explicit private display may be added');
    assert.equal(
      observed.afterDisplayAndBus.DBUS_SESSION_BUS_ADDRESS,
      privateBusAddress,
      'only the private bus address may be added',
    );
    assert.equal(
      observed.afterDisplayAndBusWithGuid.DBUS_SESSION_BUS_ADDRESS,
      `${privateBusAddress},guid=${'a'.repeat(32)}`,
      'the owned daemon GUID may accompany the exact private socket address',
    );
    assert.equal(observed.rejectsOtherBusAddress, true, 'a bus address outside the private runtime must be rejected');
    assert.equal(observed.rejectsMalformedGuid, true, 'an invalid daemon GUID must be rejected');
    assertSafeSummary(observed.summary);
    assert.equal(observed.summary.ok, true, 'a sanitized environment must match its private contract');
    assert.equal(observed.forbiddenSummary.ok, false, 'a poisoned environment must be marked unsafe');
    assert.equal(observed.forbiddenSummary.forbidden.dbusStarterPresent, true, 'a DBus starter marker must be reported by presence');
    assert.equal(observed.forbiddenSummary.forbidden.systemBusAddressPresent, true, 'a system bus marker must be reported by presence');
    assert.equal(observed.forbiddenSummary.forbidden.sshAgentPresent, true, 'an SSH agent marker must be reported by presence');
    assert.equal(observed.forbiddenSummary.unexpected.present, true, 'unexpected environment keys must be reported by presence');
    assert.equal(observed.mismatchedSummary.ok, false, 'a contract mismatch must be marked unsafe');
    assert.equal(observed.mismatchedSummary.expected.HOME.matches, false, 'a mismatched value must be reported only as a failed comparison');
    for (const summary of [observed.summary, observed.forbiddenSummary, observed.mismatchedSummary]) {
      assertSafeSummary(summary);
      const summaryText = JSON.stringify(summary);
      for (const marker of Object.values(poison)) {
        assert.ok(!summaryText.includes(marker), 'runtime evidence must not contain inherited or expected values');
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('DBus configuration is explicit, private, EXTERNAL-only, and has no activation sources', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'morrow-dbus-config-independent-'));
  try {
    const profile = path.join(root, 'profile');
    const runtimeDir = path.join(profile, 'xdg', 'runtime');
    await mkdir(runtimeDir, { recursive: true });

    const { buildPrivateDbusConfig, buildPrivateDbusLaunch } = await import(pathToFileURL(HELPER_PATH).href);
    const config = await buildPrivateDbusConfig({ profile, runtimeDir });
    assert.ok(config.configPath.startsWith(`${profile}${path.sep}`), 'DBus config must be inside the private profile');
    assert.equal(config.socketPath, path.join(runtimeDir, 'bus'), 'DBus socket must be inside the private runtime directory');
    assert.equal(config.sha256, sha256(config.contents), 'config receipt must hash the exact generated contents');

    const listenEntries = config.contents.match(/<listen>[^<]*<\/listen>/gi) ?? [];
    assert.deepEqual(listenEntries, [`<listen>unix:path=${config.socketPath}</listen>`], 'config must expose exactly the private Unix socket');
    assert.match(config.contents, /<auth>\s*EXTERNAL\s*<\/auth>/i, 'config must allow EXTERNAL authentication');
    assert.match(config.contents, /<deny\b[^>]*\bown="org\.freedesktop\.secrets"/i, 'config must deny secret-service ownership');
    assert.doesNotMatch(
      config.contents,
      /<\s*(?:servicedir|standard_session_servicedirs|standard_system_servicedirs|include|includedir|servicehelper|systemd_activation)\b/i,
      'config must contain no service directory, include, helper, or activation element',
    );
    assert.throws(() => buildPrivateDbusConfig({ profile, runtimeDir: path.join(root, 'outside-runtime') }));

    const args = buildPrivateDbusLaunch(config.configPath);
    const configArgIndex = args.findIndex((arg) => arg === '--config-file' || arg.startsWith('--config-file='));
    assert.notEqual(configArgIndex, -1, 'DBus must use an explicit --config-file');
    const configuredPath = args[configArgIndex] === '--config-file' ? args[configArgIndex + 1] : args[configArgIndex].slice('--config-file='.length);
    assert.equal(configuredPath, config.configPath, 'DBus must launch with the generated config');
    assert.ok(args.includes('--nofork'), 'private DBus should remain an owned foreground process');
    assert.ok(args.some((arg) => arg === '--print-address' || arg.startsWith('--print-address=')), 'private address must come from the owned daemon');
    assert.ok(
      !args.some((arg) => ['--session', '--system', '--systemd-activation'].includes(arg) || arg === '--address' || arg.startsWith('--address=')),
      'DBus launch must not use standard session/system configs, an address override, or systemd activation',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('DBus probe client can address only the private bus and cannot activate a real service', async () => {
  const { buildPrivateDbusClientArgs } = await import(pathToFileURL(HELPER_PATH).href);
  const runtimeDir = '/tmp/morrow-runtime-isolation-client/xdg/runtime';
  const busAddress = `unix:path=${path.join(runtimeDir, 'bus')}`;
  const listArgs = buildPrivateDbusClientArgs({ runtimeDir, busAddress, method: 'ListActivatableNames' });

  assert.deepEqual(listArgs, [
    'call',
    '--address', busAddress,
    '--dest', 'org.freedesktop.DBus',
    '--object-path', '/org/freedesktop/DBus',
    '--method', 'org.freedesktop.DBus.ListActivatableNames',
  ]);
  assert.ok(!listArgs.includes('--session'), 'probe client must never fall back to a personal session bus');

  const ownerQuery = buildPrivateDbusClientArgs({
    runtimeDir,
    busAddress,
    method: 'NameHasOwner',
    parameters: ['org.freedesktop.secrets'],
  });
  assert.equal(ownerQuery.at(-1), 'org.freedesktop.secrets', 'read-only owner query may inspect only the secret-service name');
  const syntheticOwnerQuery = buildPrivateDbusClientArgs({
    runtimeDir,
    busAddress,
    method: 'NameHasOwner',
    parameters: ['org.example.Morrow.RuntimeIsolationProbe'],
  });
  assert.equal(syntheticOwnerQuery.at(-1), 'org.example.Morrow.RuntimeIsolationProbe');

  const syntheticActivation = buildPrivateDbusClientArgs({
    runtimeDir,
    busAddress,
    method: 'StartServiceByName',
    parameters: ['org.example.Morrow.RuntimeIsolationProbe', '0'],
  });
  assert.deepEqual(syntheticActivation.slice(-2), ['org.example.Morrow.RuntimeIsolationProbe', '0']);

  assert.throws(() => buildPrivateDbusClientArgs({
    runtimeDir,
    busAddress,
    method: 'NameHasOwner',
    parameters: ['org.gnome.keyring'],
  }));
  assert.throws(() => buildPrivateDbusClientArgs({
    runtimeDir,
    busAddress,
    method: 'StartServiceByName',
    parameters: ['org.freedesktop.secrets', '0'],
  }));
  assert.throws(() => buildPrivateDbusClientArgs({
    runtimeDir,
    busAddress,
    method: 'StartServiceByName',
    parameters: ['org.example.Morrow.RuntimeIsolationProbe', '1'],
  }));
  assert.throws(() => buildPrivateDbusClientArgs({
    runtimeDir,
    busAddress: 'unix:path=/synthetic-poison/session-bus',
    method: 'ListActivatableNames',
  }));
  assert.throws(() => buildPrivateDbusClientArgs({
    runtimeDir,
    busAddress,
    method: 'ListActivatableNames',
    parameters: ['org.freedesktop.secrets'],
  }));
  assert.throws(() => buildPrivateDbusClientArgs({
    runtimeDir,
    busAddress,
    method: 'RequestName',
    parameters: ['org.freedesktop.secrets'],
  }));
});

test('activatable-name summary accepts only the intrinsic bus driver and bounds retained metadata', async () => {
  const { summarizeActivatableNames } = await import(pathToFileURL(HELPER_PATH).href);
  const validOutput = "(['org.freedesktop.DBus'],)\n";
  const valid = summarizeActivatableNames(validOutput);

  assert.equal(valid.parseable, true);
  assert.deepEqual(valid.parsedNames, ['org.freedesktop.DBus']);
  assert.equal(valid.namesTruncated, false);
  assert.equal(valid.namesSha256, sha256('org.freedesktop.DBus'));
  assert.equal(valid.externalActivatableCount, 0);
  assert.equal(valid.intrinsicDriverOnly, true);
  assert.equal(valid.noExternalServices, true);
  assert.equal(valid.valid, true, 'the sole intrinsic bus driver is the only acceptable list');
  assert.equal(valid.outputSha256, sha256(validOutput));
  assert.ok(!JSON.stringify(valid).includes(validOutput), 'receipt summary must retain hashes and bounded names, not raw output');

  const empty = summarizeActivatableNames('(@as [],)\n');
  assert.equal(empty.parseable, true);
  assert.deepEqual(empty.parsedNames, []);
  assert.equal(empty.externalActivatableCount, 0);
  assert.equal(empty.intrinsicDriverOnly, false);
  assert.equal(empty.noExternalServices, true);
  assert.equal(empty.valid, false, 'an empty list must fail the exact singleton criterion');

  const duplicate = summarizeActivatableNames("(['org.freedesktop.DBus', 'org.freedesktop.DBus'],)\n");
  assert.equal(duplicate.parseable, true);
  assert.deepEqual(duplicate.parsedNames, ['org.freedesktop.DBus', 'org.freedesktop.DBus']);
  assert.equal(duplicate.externalActivatableCount, 0);
  assert.equal(duplicate.intrinsicDriverOnly, false);
  assert.equal(duplicate.noExternalServices, true);
  assert.equal(duplicate.valid, false, 'duplicates must fail even when every entry is the intrinsic name');

  const extra = summarizeActivatableNames("(['org.freedesktop.DBus', 'org.example.Morrow.Unexpected'],)\n");
  assert.deepEqual(extra.parsedNames, ['org.freedesktop.DBus', 'org.example.Morrow.Unexpected']);
  assert.equal(extra.externalActivatableCount, 1);
  assert.equal(extra.intrinsicDriverOnly, false);
  assert.equal(extra.noExternalServices, false);
  assert.equal(extra.valid, false, 'any additional activatable name must fail');

  const malformed = summarizeActivatableNames('synthetic malformed output');
  assert.equal(malformed.parseable, false);
  assert.deepEqual(malformed.parsedNames, []);
  assert.equal(malformed.externalActivatableCount, null);
  assert.equal(malformed.intrinsicDriverOnly, false);
  assert.equal(malformed.noExternalServices, false);
  assert.equal(malformed.valid, false, 'unparseable output must fail closed');
  assert.ok(!JSON.stringify(malformed).includes('synthetic malformed output'), 'malformed raw output must not be retained');

  const oversizedNames = Array.from({ length: 33 }, (_, index) => `org.example.Morrow.Synthetic${index}`);
  const oversizedOutput = `([${oversizedNames.map((name) => `'${name}'`).join(', ')}],)\n`;
  const oversized = summarizeActivatableNames(oversizedOutput);
  assert.equal(oversized.parseable, true);
  assert.equal(oversized.parsedNames.length, 32, 'receipt metadata must be bounded');
  assert.equal(oversized.namesTruncated, true);
  assert.equal(oversized.namesSha256, sha256(oversizedNames.join('\0')), 'name hash must cover the full parsed list');
  assert.equal(oversized.externalActivatableCount, 33);
  assert.equal(oversized.intrinsicDriverOnly, false);
  assert.equal(oversized.noExternalServices, false);
  assert.equal(oversized.valid, false, 'truncation must never make an oversized list acceptable');
  assert.ok(!JSON.stringify(oversized).includes(oversizedOutput), 'receipt summary must not retain the full raw list');
});
