import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import path from 'node:path';

import {
  APP_STAGE_RUNTIME_ENVIRONMENT_KEYS,
  buildPrivateDbusClientArgs,
  buildPrivateDbusConfig,
  buildPrivateDbusLaunch,
  createPrivateRuntimeEnv,
  isFalseNameHasOwnerOutput,
  parseGdbusStringArray,
  summarizeAppStageRuntimeEnvironment,
  summarizeActivatableNames,
  summarizeRuntimeEnvironment,
} from './native-runtime-isolation.mjs';

const PROFILE = '/tmp/morrow-runtime-isolation-profile';
const XDG = {
  config: path.join(PROFILE, 'xdg', 'config'),
  data: path.join(PROFILE, 'xdg', 'data'),
  cache: path.join(PROFILE, 'xdg', 'cache'),
  runtime: path.join(PROFILE, 'xdg', 'runtime'),
};

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function appStageEnvironmentInput({
  inspectorAddress = '127.0.0.1:4317',
  listenerOwned = true,
  entries: entryOverrides,
  observedKeys: observedKeyOverrides,
  extraObservedKeys = [],
  forbiddenKeys = [],
} = {}) {
  const actualBase = createPrivateRuntimeEnv({
    profile: PROFILE,
    xdg: XDG,
    display: ':314',
    busAddress: `unix:path=${path.join(XDG.runtime, 'bus')}`,
  });
  const entries = entryOverrides ?? [
    { key: 'TAURI_AUTOMATION', value: 'true' },
    { key: 'TAURI_WEBVIEW_AUTOMATION', value: 'true' },
    { key: 'GTK_OVERLAY_SCROLLING', value: '0' },
    { key: 'WEBKIT_INSPECTOR_SERVER', value: inspectorAddress },
  ];
  const observedKeys = observedKeyOverrides ?? [
    ...Object.keys(actualBase),
    ...entries.map(({ key }) => key),
    ...extraObservedKeys,
  ];
  return {
    actualBase,
    expectedBase: actualBase,
    observedKeys,
    forbiddenKeys,
    appStageEntries: entries,
    inspectorListenerOwned: listenerOwned,
  };
}

test('private child environment contains only harness-owned values', () => {
  const poison = {
    HOME: '/synthetic-host-home',
    PATH: '/synthetic-host-path',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/synthetic-host/session-bus',
    DBUS_STARTER_ADDRESS: 'unix:path=/synthetic-host/starter-bus',
    GNOME_KEYRING_CONTROL: '/synthetic-host/keyring',
    SSH_AUTH_SOCK: '/synthetic-host/ssh-agent',
    GPG_AGENT_INFO: '/synthetic-host/gpg-agent:1:1',
  };
  const privateAddress = `unix:path=${path.join(XDG.runtime, 'bus')}`;
  const beforeDisplayAndBus = createPrivateRuntimeEnv({ profile: PROFILE, xdg: XDG, ...poison });
  const afterDisplayAndBus = createPrivateRuntimeEnv({
    profile: PROFILE,
    xdg: XDG,
    display: ':314',
    busAddress: privateAddress,
    ...poison,
  });

  assert.deepEqual(Object.keys(beforeDisplayAndBus).sort(), [
    'GDK_BACKEND',
    'HOME',
    'MORROW_USER_DATA',
    'PATH',
    'WEBKIT_DISABLE_DMABUF_RENDERER',
    'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_RUNTIME_DIR',
  ].sort());
  assert.equal(beforeDisplayAndBus.HOME, PROFILE);
  assert.equal(beforeDisplayAndBus.MORROW_USER_DATA, PROFILE);
  assert.equal(beforeDisplayAndBus.PATH, '/usr/bin:/bin');
  assert.equal('DISPLAY' in beforeDisplayAndBus, false);
  assert.equal('DBUS_SESSION_BUS_ADDRESS' in beforeDisplayAndBus, false);
  for (const marker of Object.values(poison)) {
    assert.ok(!Object.values(beforeDisplayAndBus).includes(marker));
    assert.ok(!Object.values(afterDisplayAndBus).includes(marker));
  }
  assert.equal(afterDisplayAndBus.DISPLAY, ':314');
  assert.equal(afterDisplayAndBus.DBUS_SESSION_BUS_ADDRESS, privateAddress);
});

test('private runtime environment rejects host-controlled or out-of-profile paths and addresses', () => {
  assert.throws(() => createPrivateRuntimeEnv({ profile: PROFILE, xdg: { ...XDG, runtime: '/tmp/host-runtime' } }), /private directory/);
  assert.throws(() => createPrivateRuntimeEnv({ profile: PROFILE, xdg: XDG, display: ':abc' }), /private Xvfb/);
  assert.throws(() => createPrivateRuntimeEnv({ profile: PROFILE, xdg: XDG, busAddress: 'unix:path=/tmp/host-bus' }), /owned private daemon/);
  assert.throws(() => createPrivateRuntimeEnv({ profile: PROFILE, xdg: XDG, busAddress: `unix:path=${path.join(XDG.runtime, 'bus')},guid=invalid` }), /invalid daemon GUID/);
});

test('private D-Bus config is hashed, EXTERNAL-only, denies secrets ownership, and has no activation sources', () => {
  const config = buildPrivateDbusConfig({ profile: PROFILE, runtimeDir: XDG.runtime });
  assert.equal(config.configPath, path.join(PROFILE, 'dbus-session.conf'));
  assert.equal(config.socketPath, path.join(XDG.runtime, 'bus'));
  assert.equal(config.sha256, sha256(config.contents));
  assert.match(config.contents, /<type>session<\/type>/);
  assert.match(config.contents, new RegExp(`<listen>unix:path=${config.socketPath}<\\/listen>`));
  assert.match(config.contents, /<auth>EXTERNAL<\/auth>/);
  assert.match(config.contents, /<deny own="org\.freedesktop\.secrets"\s*\/>/);
  assert.doesNotMatch(config.contents, /<(?:servicedir|standard_session_servicedirs|standard_system_servicedirs|include|includedir|servicehelper|systemd)\b/i);
  assert.throws(() => buildPrivateDbusConfig({ profile: PROFILE, runtimeDir: '/tmp/host-runtime' }), /private XDG runtime/);

  const argv = buildPrivateDbusLaunch(config.configPath);
  assert.deepEqual(argv, ['--config-file', config.configPath, '--nofork', '--print-address=1']);
  assert.ok(!argv.includes('--session') && !argv.includes('--systemd-activation') && !argv.some((arg) => arg === '--address' || arg.startsWith('--address=')));

  const clientArgs = buildPrivateDbusClientArgs({
    runtimeDir: XDG.runtime,
    busAddress: `unix:path=${config.socketPath}`,
    method: 'ListActivatableNames',
  });
  assert.ok(clientArgs.includes('--address'), 'the probe client must target the private bus explicitly');
  assert.ok(!clientArgs.includes('--session'), 'the probe client must not fall back to a personal session bus');
  assert.ok(clientArgs.includes(`unix:path=${config.socketPath}`));
  assert.throws(() => buildPrivateDbusClientArgs({
    runtimeDir: XDG.runtime,
    busAddress: 'unix:path=/tmp/host-bus',
    method: 'ListActivatableNames',
  }), /private XDG runtime socket/);
  assert.throws(() => buildPrivateDbusClientArgs({
    runtimeDir: XDG.runtime,
    busAddress: `unix:path=${config.socketPath}`,
    method: 'RequestName',
    parameters: ['org.freedesktop.secrets'],
  }), /fixed allowlist/);
  assert.throws(() => buildPrivateDbusClientArgs({
    runtimeDir: XDG.runtime,
    busAddress: `unix:path=${config.socketPath}`,
    method: 'StartServiceByName',
    parameters: ['org.freedesktop.secrets', '0'],
  }), /synthetic probe allowlist/);
});

test('runtime receipt records only hashes and booleans, and fails closed on mismatched or forbidden environment', () => {
  const expected = {
    HOME: PROFILE,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(XDG.runtime, 'bus')}`,
  };
  const match = summarizeRuntimeEnvironment({ actual: expected, expected });
  assert.equal(match.ok, true);
  assert.equal(match.expected.HOME.matches, true);
  assert.equal(match.expected.HOME.actualSha256, sha256(PROFILE));

  const mismatch = summarizeRuntimeEnvironment({
    actual: { ...expected, HOME: '/synthetic-host-home' },
    expected,
    forbiddenKeys: ['SSH_AUTH_SOCK', 'GNOME_KEYRING_CONTROL'],
    observedKeys: [...Object.keys(expected), 'DBUS_STARTER_ADDRESS'],
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.expected.HOME.matches, false);
  assert.equal(mismatch.forbidden.sshAgentPresent, true);
  assert.equal(mismatch.forbidden.keyringPresent, true);
  assert.equal(mismatch.unexpected.present, true);
  assert.ok(!JSON.stringify(mismatch).includes('/synthetic-host-home'));
  assert.ok(!JSON.stringify(mismatch).includes('GNOME_KEYRING_CONTROL'));
});

test('app-stage environment accepts only the four exact values and retains no raw inspector endpoint', () => {
  const input = appStageEnvironmentInput();
  const { summary, inspectorPort } = summarizeAppStageRuntimeEnvironment(input);

  assert.equal(summary.ok, true);
  assert.equal(summary.base.ok, true);
  assert.equal(summary.appStage.ok, true);
  assert.equal(inspectorPort, 4317);
  assert.deepEqual(Object.keys(summary.appStage.variables).sort(), [
    'GTK_OVERLAY_SCROLLING',
    'TAURI_AUTOMATION',
    'TAURI_WEBVIEW_AUTOMATION',
  ].sort());
  assert.deepEqual(summary.appStage.variables.TAURI_AUTOMATION, {
    present: true,
    count: 1,
    capturedCount: 1,
    valid: true,
  });
  assert.deepEqual(summary.appStage.inspector, {
    present: true,
    count: 1,
    capturedCount: 1,
    loopbackIpv4: true,
    portValid: true,
    listenerOwned: true,
  });
  assert.equal(JSON.stringify(summary).includes('127.0.0.1:4317'), false);
  assert.equal(JSON.stringify(summary).includes('"4317"'), false);
  assert.equal(JSON.stringify(summary).includes('"true"'), false);

  const generic = summarizeRuntimeEnvironment({
    actual: input.actualBase,
    expected: input.expectedBase,
    observedKeys: [...Object.keys(input.actualBase), ...APP_STAGE_RUNTIME_ENVIRONMENT_KEYS],
  });
  assert.equal(generic.ok, false, 'the generic base/daemon check continues to reject app-only additions');
  assert.equal(generic.unexpected.present, true);
});

test('app-stage inspector endpoint requires canonical loopback IPv4 and a valid owned listener port', () => {
  for (const [address, expectedPort] of [
    ['127.0.0.1:1', 1],
    ['127.0.0.1:65535', 65_535],
  ]) {
    const { summary, inspectorPort } = summarizeAppStageRuntimeEnvironment(appStageEnvironmentInput({ inspectorAddress: address }));
    assert.equal(summary.ok, true, address);
    assert.equal(inspectorPort, expectedPort, address);
  }

  for (const address of [
    '127.0.0.1:0',
    '127.0.0.1:65536',
    '127.0.0.1:04317',
    '127.0.0.2:4317',
    'localhost:4317',
    '[::1]:4317',
    '127.0.0.1:4317/path',
  ]) {
    const { summary, inspectorPort } = summarizeAppStageRuntimeEnvironment(appStageEnvironmentInput({ inspectorAddress: address }));
    assert.equal(summary.ok, false, address);
    assert.equal(summary.appStage.inspector.portValid, false, address);
    assert.equal(inspectorPort, null, address);
    assert.equal(JSON.stringify(summary).includes(address), false, 'invalid endpoint values are not retained');
  }

  const noOwnedListener = summarizeAppStageRuntimeEnvironment(appStageEnvironmentInput({ listenerOwned: false }));
  assert.equal(noOwnedListener.summary.ok, false);
  assert.equal(noOwnedListener.summary.appStage.inspector.listenerOwned, false);
  assert.equal(noOwnedListener.inspectorPort, 4317, 'port is returned only for the runner to check in memory');
  assert.equal(JSON.stringify(noOwnedListener.summary).includes('4317'), false);
});

test('app-stage environment rejects missing, duplicate, mismatched, unknown, and forbidden variables', () => {
  const validEntries = appStageEnvironmentInput().appStageEntries;
  const baseObserved = Object.keys(appStageEnvironmentInput().actualBase);
  const summarize = (entries, stageObserved, extra = {}) => summarizeAppStageRuntimeEnvironment({
    ...appStageEnvironmentInput(),
    appStageEntries: entries,
    observedKeys: [...baseObserved, ...stageObserved, ...(extra.observedKeys ?? [])],
    forbiddenKeys: extra.forbiddenKeys ?? [],
  });

  const missing = summarize(validEntries.filter(({ key }) => key !== 'TAURI_AUTOMATION'), [
    'TAURI_WEBVIEW_AUTOMATION', 'GTK_OVERLAY_SCROLLING', 'WEBKIT_INSPECTOR_SERVER',
  ]);
  assert.equal(missing.summary.ok, false);
  assert.equal(missing.summary.appStage.variables.TAURI_AUTOMATION.present, false);

  const duplicateObserved = summarize(validEntries, [
    'TAURI_AUTOMATION', 'TAURI_AUTOMATION', 'TAURI_WEBVIEW_AUTOMATION', 'GTK_OVERLAY_SCROLLING', 'WEBKIT_INSPECTOR_SERVER',
  ]);
  assert.equal(duplicateObserved.summary.ok, false);
  assert.equal(duplicateObserved.summary.appStage.variables.TAURI_AUTOMATION.count, 2);

  const duplicateCaptured = summarize([...validEntries, validEntries[0]], [
    'TAURI_AUTOMATION', 'TAURI_WEBVIEW_AUTOMATION', 'GTK_OVERLAY_SCROLLING', 'WEBKIT_INSPECTOR_SERVER',
  ]);
  assert.equal(duplicateCaptured.summary.ok, false);
  assert.equal(duplicateCaptured.summary.appStage.variables.TAURI_AUTOMATION.capturedCount, 2);

  for (const [key, value] of [
    ['TAURI_AUTOMATION', '1'],
    ['TAURI_WEBVIEW_AUTOMATION', 'TRUE'],
    ['GTK_OVERLAY_SCROLLING', '2'],
  ]) {
    const mismatched = summarize(validEntries.map((entry) => entry.key === key ? { ...entry, value } : entry), [
      'TAURI_AUTOMATION', 'TAURI_WEBVIEW_AUTOMATION', 'GTK_OVERLAY_SCROLLING', 'WEBKIT_INSPECTOR_SERVER',
    ]);
    assert.equal(mismatched.summary.ok, false, `${key}=${value}`);
    assert.equal(JSON.stringify(mismatched.summary).includes(JSON.stringify(value)), false, 'invalid config values are not retained');
  }

  const unknown = summarize(validEntries, [
    'TAURI_AUTOMATION', 'TAURI_WEBVIEW_AUTOMATION', 'GTK_OVERLAY_SCROLLING', 'WEBKIT_INSPECTOR_SERVER',
  ], { observedKeys: ['APP_EXTRA_PUBLIC_KEY'] });
  assert.equal(unknown.summary.ok, false);
  assert.equal(unknown.summary.base.unexpected.present, true);
  assert.deepEqual(unknown.summary.base.unexpected.names, ['APP_EXTRA_PUBLIC_KEY']);
  assert.equal(unknown.summary.base.unexpected.sha256, sha256('APP_EXTRA_PUBLIC_KEY'));

  const manyUnknown = summarize(validEntries, [
    'TAURI_AUTOMATION', 'TAURI_WEBVIEW_AUTOMATION', 'GTK_OVERLAY_SCROLLING', 'WEBKIT_INSPECTOR_SERVER',
  ], { observedKeys: Array.from({ length: 40 }, (_, index) => `APP_EXTRA_${index}`) });
  assert.equal(manyUnknown.summary.base.unexpected.names.length, 32);
  assert.equal(manyUnknown.summary.base.unexpected.namesTruncated, true);
  assert.equal(manyUnknown.summary.base.unexpected.count, 40);

  const longUnknownName = `APP_EXTRA_${'X'.repeat(200)}`;
  const boundedUnknown = summarize(validEntries, [
    'TAURI_AUTOMATION', 'TAURI_WEBVIEW_AUTOMATION', 'GTK_OVERLAY_SCROLLING', 'WEBKIT_INSPECTOR_SERVER',
  ], { observedKeys: [longUnknownName] });
  assert.equal(boundedUnknown.summary.base.unexpected.names[0].length, 128);
  assert.equal(boundedUnknown.summary.base.unexpected.namesTruncated, true);
  assert.equal(boundedUnknown.summary.base.unexpected.sha256, sha256(longUnknownName));

  const forbidden = summarize(validEntries, [
    'TAURI_AUTOMATION', 'TAURI_WEBVIEW_AUTOMATION', 'GTK_OVERLAY_SCROLLING', 'WEBKIT_INSPECTOR_SERVER', 'SSH_AUTH_SOCK',
  ], { forbiddenKeys: ['SSH_AUTH_SOCK'] });
  assert.equal(forbidden.summary.ok, false);
  assert.equal(forbidden.summary.base.forbidden.sshAgentPresent, true);
});

test('activatable-name receipt accepts only the intrinsic bus driver and bounds private name metadata', () => {
  const driverOnlyOutput = "(['org.freedesktop.DBus'],)\n";
  const driverOnly = summarizeActivatableNames(driverOnlyOutput);
  assert.equal(driverOnly.valid, true);
  assert.equal(driverOnly.parseable, true);
  assert.deepEqual(driverOnly.parsedNames, ['org.freedesktop.DBus']);
  assert.equal(driverOnly.namesTruncated, false);
  assert.equal(driverOnly.namesSha256, sha256('org.freedesktop.DBus'));
  assert.equal(driverOnly.externalActivatableCount, 0);
  assert.equal(driverOnly.intrinsicDriverOnly, true);
  assert.equal(driverOnly.noExternalServices, true);
  assert.equal(driverOnly.outputSha256, sha256(driverOnlyOutput));

  const empty = summarizeActivatableNames('(@as [],)');
  assert.equal(empty.valid, false);
  assert.equal(empty.parseable, true);
  assert.equal(empty.externalActivatableCount, 0);
  assert.equal(empty.intrinsicDriverOnly, false);

  const duplicate = summarizeActivatableNames("(['org.freedesktop.DBus', 'org.freedesktop.DBus'],)");
  assert.equal(duplicate.valid, false);
  assert.equal(duplicate.externalActivatableCount, 0);
  assert.equal(duplicate.intrinsicDriverOnly, false);
  assert.equal(duplicate.noExternalServices, true);

  const extra = summarizeActivatableNames("(['org.freedesktop.DBus', 'org.example.Service'],)");
  assert.equal(extra.valid, false);
  assert.deepEqual(extra.parsedNames, ['org.freedesktop.DBus', 'org.example.Service']);
  assert.equal(extra.externalActivatableCount, 1);
  assert.equal(extra.noExternalServices, false);

  const malformed = summarizeActivatableNames("('not an array',)");
  assert.equal(malformed.valid, false);
  assert.equal(malformed.parseable, false);
  assert.deepEqual(malformed.parsedNames, []);
  assert.equal(malformed.externalActivatableCount, null);

  const longNames = Array.from({ length: 33 }, (_, index) => `org.example.Service${index}`);
  const longOutput = `([${longNames.map((name) => `'${name}'`).join(', ')}],)`;
  const bounded = summarizeActivatableNames(longOutput);
  assert.equal(bounded.valid, false);
  assert.equal(bounded.namesTruncated, true);
  assert.equal(bounded.parsedNames.length, 32);
  assert.equal(bounded.externalActivatableCount, 33);
  assert.ok(!bounded.parsedNames.includes('org.example.Service32'));
  assert.equal(bounded.namesSha256, sha256(longNames.join('\0')));
  assert.equal(bounded.outputSha256, sha256(longOutput));

  assert.deepEqual(parseGdbusStringArray("(['org.freedesktop.DBus', ':1.7'],)"), ['org.freedesktop.DBus', ':1.7']);
  assert.equal(isFalseNameHasOwnerOutput('(false,)'), true);
  assert.equal(isFalseNameHasOwnerOutput('(true,)'), false);
});
