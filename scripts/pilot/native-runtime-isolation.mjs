import { createHash } from 'node:crypto';
import path from 'node:path';

const PRIVATE_PATH_SEGMENTS = /^[A-Za-z0-9._/-]+$/;
export const PRIVATE_DBUS_SYNTHETIC_SERVICE_NAME = 'org.example.Morrow.RuntimeIsolationProbe';
const PRIVATE_DBUS_DRIVER_NAME = 'org.freedesktop.DBus';
const MAX_ACTIVATABLE_NAMES_IN_RECEIPT = 32;
export const APP_STAGE_RUNTIME_ENVIRONMENT_KEYS = Object.freeze([
  'TAURI_AUTOMATION',
  'TAURI_WEBVIEW_AUTOMATION',
  'GTK_OVERLAY_SCROLLING',
  'WEBKIT_INSPECTOR_SERVER',
]);
const APP_STAGE_RUNTIME_ENVIRONMENT_KEY_SET = new Set(APP_STAGE_RUNTIME_ENVIRONMENT_KEYS);
const MAX_UNEXPECTED_ENVIRONMENT_NAMES_IN_RECEIPT = 32;
const MAX_UNEXPECTED_ENVIRONMENT_NAME_LENGTH = 128;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireAbsoluteDirectory(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  const resolved = path.resolve(value);
  if (resolved !== value || !PRIVATE_PATH_SEGMENTS.test(value)) {
    throw new Error(`${label} must use a normalized private Unix path`);
  }
  return resolved;
}

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function privateXdgDirectories(profile, xdg) {
  if (!xdg || typeof xdg !== 'object') throw new Error('xdg paths are required');
  const expected = {
    config: path.join(profile, 'xdg', 'config'),
    data: path.join(profile, 'xdg', 'data'),
    cache: path.join(profile, 'xdg', 'cache'),
    runtime: path.join(profile, 'xdg', 'runtime'),
  };
  for (const [key, expectedPath] of Object.entries(expected)) {
    const actual = requireAbsoluteDirectory(xdg[key], `XDG ${key}`);
    if (actual !== expectedPath || !isWithin(profile, actual) || actual === profile) {
      throw new Error(`XDG ${key} must be the owned private directory below the profile`);
    }
  }
  return expected;
}

export function createPrivateRuntimeEnv({ profile, xdg, display, busAddress } = {}) {
  const privateProfile = requireAbsoluteDirectory(profile, 'profile');
  const directories = privateXdgDirectories(privateProfile, xdg);
  const env = {
    HOME: privateProfile,
    MORROW_USER_DATA: privateProfile,
    XDG_CONFIG_HOME: directories.config,
    XDG_DATA_HOME: directories.data,
    XDG_CACHE_HOME: directories.cache,
    XDG_RUNTIME_DIR: directories.runtime,
    GDK_BACKEND: 'x11',
    WEBKIT_DISABLE_DMABUF_RENDERER: '1',
    PATH: '/usr/bin:/bin',
  };

  if (display !== undefined) {
    if (typeof display !== 'string' || !/^:\d+$/.test(display)) {
      throw new Error('display must be the number assigned by the private Xvfb process');
    }
    env.DISPLAY = display;
  }

  if (busAddress !== undefined) {
    const socketAddress = `unix:path=${path.join(directories.runtime, 'bus')}`;
    if (typeof busAddress !== 'string' || (busAddress !== socketAddress && !busAddress.startsWith(`${socketAddress},guid=`))) {
      throw new Error('busAddress must be the address printed by the owned private daemon');
    }
    if (busAddress !== socketAddress) {
      const guid = busAddress.slice(`${socketAddress},guid=`.length);
      if (!/^[a-f0-9]{32}$/i.test(guid)) throw new Error('private bus address contains an invalid daemon GUID');
    }
    env.DBUS_SESSION_BUS_ADDRESS = busAddress;
  }

  return env;
}

export function buildPrivateDbusConfig({ profile, runtimeDir } = {}) {
  const privateProfile = requireAbsoluteDirectory(profile, 'profile');
  const privateRuntime = requireAbsoluteDirectory(runtimeDir, 'runtimeDir');
  if (privateRuntime !== path.join(privateProfile, 'xdg', 'runtime') || !isWithin(privateProfile, privateRuntime)) {
    throw new Error('runtimeDir must be the private XDG runtime directory below profile');
  }

  const configPath = path.join(privateProfile, 'dbus-session.conf');
  const socketPath = path.join(privateRuntime, 'bus');
  const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:path=${socketPath}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" />
    <allow receive_sender="*" />
    <allow own="*" />
    <deny own="org.freedesktop.secrets" />
  </policy>
</busconfig>
`;
  return { configPath, socketPath, contents, sha256: sha256(contents) };
}

export function buildPrivateDbusLaunch(configPath) {
  const config = requireAbsoluteDirectory(configPath, 'configPath');
  return ['--config-file', config, '--nofork', '--print-address=1'];
}

export function buildPrivateDbusClientArgs({ runtimeDir, busAddress, method, parameters = [] } = {}) {
  const privateRuntime = requireAbsoluteDirectory(runtimeDir, 'runtimeDir');
  const socketAddress = `unix:path=${path.join(privateRuntime, 'bus')}`;
  if (busAddress !== socketAddress && !busAddress?.startsWith(`${socketAddress},guid=`)) {
    throw new Error('busAddress must target the private XDG runtime socket');
  }
  if (busAddress !== socketAddress) {
    const guid = busAddress.slice(`${socketAddress},guid=`.length);
    if (!/^[a-f0-9]{32}$/i.test(guid)) throw new Error('private bus address contains an invalid daemon GUID');
  }
  const acceptedMethods = new Set(['ListActivatableNames', 'ListNames', 'NameHasOwner', 'StartServiceByName']);
  if (!acceptedMethods.has(method) || !Array.isArray(parameters) || parameters.some((value) => typeof value !== 'string')) {
    throw new Error('D-Bus probe method and parameters must use the fixed allowlist');
  }
  const validParameters = method === 'ListActivatableNames' || method === 'ListNames'
    ? parameters.length === 0
    : method === 'NameHasOwner'
      ? parameters.length === 1 && ['org.freedesktop.secrets', PRIVATE_DBUS_SYNTHETIC_SERVICE_NAME].includes(parameters[0])
      : parameters.length === 2 && parameters[0] === PRIVATE_DBUS_SYNTHETIC_SERVICE_NAME && parameters[1] === '0';
  if (!validParameters) throw new Error('D-Bus probe method arguments must use the synthetic probe allowlist');
  return [
    'call',
    '--address', busAddress,
    '--dest', 'org.freedesktop.DBus',
    '--object-path', '/org/freedesktop/DBus',
    '--method', `org.freedesktop.DBus.${method}`,
    ...parameters,
  ];
}

export function summarizeActivatableNames(output) {
  const names = parseGdbusStringArray(output);
  const parseable = names !== null;
  const namesTruncated = parseable && names.length > MAX_ACTIVATABLE_NAMES_IN_RECEIPT;
  const parsedNames = parseable ? names.slice(0, MAX_ACTIVATABLE_NAMES_IN_RECEIPT) : [];
  const externalActivatableCount = parseable
    ? names.filter((name) => name !== PRIVATE_DBUS_DRIVER_NAME).length
    : null;
  const intrinsicDriverOnly = parseable
    && !namesTruncated
    && names.length === 1
    && names[0] === PRIVATE_DBUS_DRIVER_NAME;
  const noExternalServices = parseable && !namesTruncated && externalActivatableCount === 0;
  const namesSha256 = sha256(Buffer.from(parseable ? names.join('\0') : ''));
  const outputSha256 = sha256(Buffer.from(typeof output === 'string' ? output : ''));
  return {
    parseable,
    parsedNames,
    namesTruncated,
    namesSha256,
    externalActivatableCount,
    intrinsicDriverOnly,
    noExternalServices,
    valid: parseable && !namesTruncated && intrinsicDriverOnly && noExternalServices,
    outputSha256,
  };
}

export function isFalseNameHasOwnerOutput(output) {
  return typeof output === 'string' && /^\(\s*false\s*,?\s*\)$/.test(output.trim());
}

export function parseGdbusStringArray(output) {
  if (typeof output !== 'string') return null;
  const match = /^\(\s*(?:@as\s*)?\[(.*)\]\s*,?\s*\)$/s.exec(output.trim());
  if (!match) return null;
  let remaining = match[1].trim();
  if (!remaining) return [];
  const names = [];
  while (remaining) {
    const item = /^'([^'\\]*)'\s*(,|$)\s*/.exec(remaining);
    if (!item) return null;
    names.push(item[1]);
    remaining = remaining.slice(item[0].length).trim();
    if (!item[2] && remaining) return null;
  }
  return names;
}

const FORBIDDEN_ENVIRONMENT_KEYS = {
  dbusStarterPresent: (key) => key.startsWith('DBUS_STARTER_'),
  systemBusAddressPresent: (key) => key === 'DBUS_SYSTEM_BUS_ADDRESS' || key === 'DBUS_SYSTEM_BUS_PID',
  keyringPresent: (key) => key.startsWith('GNOME_KEYRING_'),
  sshAgentPresent: (key) => key === 'SSH_AUTH_SOCK',
  gpgAgentPresent: (key) => key === 'GPG_AGENT_INFO',
  accessibilityBusPresent: (key) => key === 'AT_SPI_BUS_ADDRESS',
  hostDisplayPresent: (key) => key === 'WAYLAND_DISPLAY' || key === 'XAUTHORITY',
  loaderInjectionPresent: (key) => key === 'LD_PRELOAD' || key === 'GTK_MODULES',
};

export function summarizeRuntimeEnvironment({ actual = {}, expected = {}, forbiddenKeys = [], observedKeys = [] } = {}) {
  const keys = [...new Set([...Object.keys(actual), ...forbiddenKeys, ...observedKeys])];
  const forbidden = Object.fromEntries(Object.entries(FORBIDDEN_ENVIRONMENT_KEYS).map(([label, matches]) => [
    label,
    keys.some((key) => typeof key === 'string' && matches(key)),
  ]));
  const expectedSummary = Object.fromEntries(Object.entries(expected).map(([key, expectedValue]) => {
    const present = Object.hasOwn(actual, key);
    const actualValue = present ? String(actual[key]) : '';
    const expectedText = String(expectedValue);
    return [key, {
      present,
      matches: present && actualValue === expectedText,
      actualSha256: sha256(actualValue),
      expectedSha256: sha256(expectedText),
    }];
  }));
  const unexpectedKeys = keys.filter((key) => typeof key === 'string' && !Object.hasOwn(expected, key)).sort();
  const unexpected = {
    present: unexpectedKeys.length > 0,
    sha256: sha256(unexpectedKeys.join('\0')),
  };
  const valuesMatch = Object.values(expectedSummary).every((value) => value.matches);
  const noForbiddenEnvironment = Object.values(forbidden).every((present) => !present);
  return { ok: valuesMatch && noForbiddenEnvironment && !unexpected.present, expected: expectedSummary, forbidden, unexpected };
}

export function summarizeAppStageRuntimeEnvironment({
  actualBase = {},
  expectedBase = {},
  forbiddenKeys = [],
  observedKeys = [],
  appStageEntries = [],
  inspectorListenerOwned = false,
} = {}) {
  const safeObservedKeys = observedKeys.filter((key) => typeof key === 'string');
  const baseObservedKeys = safeObservedKeys.filter((key) => !APP_STAGE_RUNTIME_ENVIRONMENT_KEY_SET.has(key));
  const base = summarizeRuntimeEnvironment({
    actual: actualBase,
    expected: expectedBase,
    forbiddenKeys,
    observedKeys: baseObservedKeys,
  });
  const unexpectedNames = [...new Set(baseObservedKeys.filter((key) => !Object.hasOwn(expectedBase, key)))].sort();
  const boundedUnexpectedNames = unexpectedNames
    .slice(0, MAX_UNEXPECTED_ENVIRONMENT_NAMES_IN_RECEIPT)
    .map((key) => key.replace(/[^\x20-\x7E]/g, '?').slice(0, MAX_UNEXPECTED_ENVIRONMENT_NAME_LENGTH));
  base.unexpected = {
    ...base.unexpected,
    count: unexpectedNames.length,
    names: boundedUnexpectedNames,
    namesTruncated: unexpectedNames.length > MAX_UNEXPECTED_ENVIRONMENT_NAMES_IN_RECEIPT
      || unexpectedNames.slice(0, MAX_UNEXPECTED_ENVIRONMENT_NAMES_IN_RECEIPT)
        .some((key) => key.length > MAX_UNEXPECTED_ENVIRONMENT_NAME_LENGTH),
  };

  const entries = Array.isArray(appStageEntries) ? appStageEntries : [];
  const summarizedValues = {};
  const entryCountByKey = new Map();
  const observedCountByKey = new Map();
  for (const key of safeObservedKeys) {
    if (APP_STAGE_RUNTIME_ENVIRONMENT_KEY_SET.has(key)) {
      observedCountByKey.set(key, (observedCountByKey.get(key) ?? 0) + 1);
    }
  }
  for (const entry of entries) {
    if (!entry || !APP_STAGE_RUNTIME_ENVIRONMENT_KEY_SET.has(entry.key)) continue;
    entryCountByKey.set(entry.key, (entryCountByKey.get(entry.key) ?? 0) + 1);
  }
  const entriesByKey = new Map();
  for (const entry of entries) {
    if (!entry || !APP_STAGE_RUNTIME_ENVIRONMENT_KEY_SET.has(entry.key)) continue;
    if (!entriesByKey.has(entry.key)) entriesByKey.set(entry.key, []);
    entriesByKey.get(entry.key).push(entry.value);
  }

  const exactValues = {
    TAURI_AUTOMATION: (value) => value === 'true',
    TAURI_WEBVIEW_AUTOMATION: (value) => value === 'true',
    GTK_OVERLAY_SCROLLING: (value) => value === '0' || value === '1',
  };
  for (const key of Object.keys(exactValues)) {
    const count = observedCountByKey.get(key) ?? 0;
    const capturedCount = entryCountByKey.get(key) ?? 0;
    const values = entriesByKey.get(key) ?? [];
    summarizedValues[key] = {
      present: count > 0,
      count,
      capturedCount,
      valid: count === 1 && capturedCount === 1 && exactValues[key](values[0]),
    };
  }

  const inspectorKey = 'WEBKIT_INSPECTOR_SERVER';
  const inspectorCount = observedCountByKey.get(inspectorKey) ?? 0;
  const inspectorCapturedCount = entryCountByKey.get(inspectorKey) ?? 0;
  const inspectorValues = entriesByKey.get(inspectorKey) ?? [];
  const inspectorValue = inspectorCount === 1 && inspectorCapturedCount === 1 && typeof inspectorValues[0] === 'string'
    ? inspectorValues[0]
    : null;
  const inspectorMatch = inspectorValue === null ? null : /^127\.0\.0\.1:([1-9]\d{0,4})$/.exec(inspectorValue);
  const inspectorPort = inspectorMatch ? Number(inspectorMatch[1]) : null;
  const inspectorPortValid = inspectorPort !== null
    && Number.isInteger(inspectorPort)
    && inspectorPort >= 1
    && inspectorPort <= 65_535
    && String(inspectorPort) === inspectorMatch[1];
  const unexpectedAppEntries = entries.some((entry) => !entry || !APP_STAGE_RUNTIME_ENVIRONMENT_KEY_SET.has(entry.key));
  const variablesValid = Object.values(summarizedValues).every((value) => value.valid);
  const inspectorValid = inspectorCount === 1
    && inspectorCapturedCount === 1
    && inspectorPortValid
    && inspectorListenerOwned === true;
  const appStage = {
    ok: variablesValid && inspectorValid && !unexpectedAppEntries,
    variables: summarizedValues,
    inspector: {
      present: inspectorCount > 0,
      count: inspectorCount,
      capturedCount: inspectorCapturedCount,
      loopbackIpv4: inspectorPortValid,
      portValid: inspectorPortValid,
      listenerOwned: inspectorListenerOwned === true,
    },
  };
  const summary = {
    ok: base.ok && appStage.ok,
    base,
    appStage,
  };
  return { summary, inspectorPort: inspectorPortValid ? inspectorPort : null };
}
