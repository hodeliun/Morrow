import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isFileHandlerLocale } from './fileHandlerDialogs.js';
import type { FileHandlerChooserKind, FileHandlerLocale } from './fileHandlerDialogs.js';

const SETTINGS_FILE = 'file-handlers.json';
const MAX_RELATIVE_PATH_LENGTH = 4096;
const MAX_URL_LENGTH = 8192;
const MAX_APPLICATION_PATH_LENGTH = 4096;
const EXTENSION = /^\.[a-z0-9][a-z0-9+_-]{0,31}$/i;
const RESERVED_SEGMENTS = new Set(['.morrow', '.git']);
const BLOCKED_SYSTEM_EXTENSIONS = new Set([
  '.app',
  '.appimage',
  '.apk',
  '.bash',
  '.bat',
  '.cjs',
  '.cmd',
  '.com',
  '.command',
  '.desktop',
  '.dmg',
  '.exe',
  '.hta',
  '.html',
  '.htm',
  '.jar',
  '.js',
  '.jse',
  '.lnk',
  '.mjs',
  '.msi',
  '.msp',
  '.mht',
  '.mhtml',
  '.pif',
  '.pkg',
  '.ps1',
  '.ps1xml',
  '.psm1',
  '.psd1',
  '.pl',
  '.py',
  '.rb',
  '.reg',
  '.run',
  '.scr',
  '.sh',
  '.svg',
  '.url',
  '.vbe',
  '.vbs',
  '.wsf',
  '.wsh',
  '.xsl',
  '.xslt',
  '.xhtml',
]);

export type FileHandlerMode = 'system' | 'internal' | 'application';
export type BrowserHandlerMode = 'system' | 'application';
export type RecoveryAction = 'choose-application' | 'open-folder';

export interface FileHandlerNativePort {
  getCurrentVaultContext(): { root: string; realRoot: string; generation: string | number } | null;
  isTrustedSender(sender: unknown): boolean;
  getInternalExtensions(): string[];
  chooseApplication(
    kind: FileHandlerChooserKind,
    extension: string | null,
    locale: FileHandlerLocale,
  ): Promise<string | null>;
  isExecutableApplication(absolutePath: string): Promise<boolean>;
  /** Electron shell.openPath contract: an empty string means success; a nonempty string describes failure. */
  openDefaultFile(absolutePath: string): Promise<string>;
  openDefaultUrl(url: string): Promise<void>;
  revealInFolder(absolutePath: string): void | Promise<void>;
}

export interface SpawnOptions {
  shell: false;
  detached: true;
  windowsHide: true;
  stdio: 'ignore';
}

export type SpawnStart = (executable: string, args: string[], options: SpawnOptions) => Promise<void>;

export type LaunchApplication = (executable: string, argument: string) => Promise<void>;

export interface FileHandlerModuleOptions {
  /** Electron app.getPath('userData'); preferences are always stored beneath this device-local directory. */
  userDataPath: string;
  /** Opaque identity supplied by main; never returned to the renderer. */
  getDeviceIdentity(): Promise<string>;
  native: FileHandlerNativePort;
  launchApplication: LaunchApplication;
}

type SavedFileHandler =
  { mode: 'system' } | { mode: 'internal' } | { mode: 'application'; executable: string; deviceId: string };

type SavedBrowserHandler =
  { mode: 'system' } | { mode: 'application'; executable: string; deviceId: string } | null;

interface SavedPreferences {
  version: 2;
  files: Record<string, SavedFileHandler>;
  browser: SavedBrowserHandler;
}

export interface PublicFileHandlerPreference {
  mode: FileHandlerMode;
  applicationName?: string;
  needsReselection?: boolean;
}

export interface PublicBrowserHandlerPreference {
  mode: BrowserHandlerMode;
  applicationName?: string;
  needsReselection?: boolean;
}

export type FileHandlerResult =
  | { ok: true; destination?: FileHandlerMode | BrowserHandlerMode }
  | {
      ok: false;
      code: string;
      message: string;
      recovery?: RecoveryAction[];
    };

export interface FileHandlerModule {
  getPreferences(sender: unknown): Promise<
    | {
        ok: true;
        preferences: {
          files: Record<string, PublicFileHandlerPreference>;
          browser: PublicBrowserHandlerPreference;
          internalExtensions: string[];
        };
      }
    | Extract<FileHandlerResult, { ok: false }>
  >;
  setFileHandler(
    sender: unknown,
    extension: unknown,
    mode: unknown,
    locale?: unknown,
  ): Promise<FileHandlerResult>;
  setBrowserHandler(sender: unknown, mode: unknown, locale?: unknown): Promise<FileHandlerResult>;
  openFile(sender: unknown, relativePath: unknown, options?: unknown): Promise<FileHandlerResult>;
  openUrl(sender: unknown, url: unknown, options?: unknown): Promise<FileHandlerResult>;
  openContainingFolder(sender: unknown, relativePath: unknown): Promise<FileHandlerResult>;
}

interface ValidatedFile {
  relativePath: string;
  absolutePath: string;
  extension: string;
  vaultContext: { root: string; realRoot: string; generation: string | number };
}

const emptyPreferences = (): SavedPreferences => ({ version: 2, files: {}, browser: null });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function normalizeExtension(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const extension = value.trim().toLowerCase();
  return EXTENSION.test(extension) ? extension : null;
}

function isDeviceIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9-]{16,128}$/i.test(value);
}

function isAbsoluteLocalPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_APPLICATION_PATH_LENGTH)
    return false;
  if (value.includes('\0') || !path.isAbsolute(value)) return false;
  if (process.platform === 'win32' && value.startsWith('\\\\')) return false;
  return true;
}

function parseFileHandler(value: unknown, version: number): SavedFileHandler | null {
  if (!isRecord(value) || typeof value.mode !== 'string') return null;
  if (value.mode === 'system' && hasOnlyKeys(value, ['mode'])) return { mode: 'system' };
  if (value.mode === 'internal' && hasOnlyKeys(value, ['mode'])) return { mode: 'internal' };
  if (
    value.mode === 'application' &&
    hasOnlyKeys(value, version === 1 ? ['mode', 'executable'] : ['mode', 'executable', 'deviceId']) &&
    isAbsoluteLocalPath(value.executable)
  )
    return {
      mode: 'application',
      executable: value.executable,
      deviceId: version === 1 ? '' : isDeviceIdentity(value.deviceId) ? value.deviceId : '',
    };
  return null;
}

function parseBrowserHandler(value: unknown, version: number): SavedBrowserHandler {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.mode !== 'string') return null;
  if (value.mode === 'system' && hasOnlyKeys(value, ['mode'])) return { mode: 'system' };
  if (
    value.mode === 'application' &&
    hasOnlyKeys(value, version === 1 ? ['mode', 'executable'] : ['mode', 'executable', 'deviceId']) &&
    isAbsoluteLocalPath(value.executable)
  )
    return {
      mode: 'application',
      executable: value.executable,
      deviceId: version === 1 ? '' : isDeviceIdentity(value.deviceId) ? value.deviceId : '',
    };
  return null;
}

function parsePreferences(value: unknown): SavedPreferences | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['version', 'files', 'browser']) ||
    (value.version !== 1 && value.version !== 2) ||
    !isRecord(value.files)
  )
    return null;

  const files: Record<string, SavedFileHandler> = {};
  for (const [key, stored] of Object.entries(value.files)) {
    const extension = normalizeExtension(key);
    const handler = parseFileHandler(stored, value.version);
    if (!extension || !handler) return null;
    files[extension] = handler;
  }

  const browser = parseBrowserHandler(value.browser, value.version);
  if (value.browser !== null && browser === null) return null;
  return { version: 2, files, browser };
}

function toPublicFilePreference(value: SavedFileHandler, deviceId: string): PublicFileHandlerPreference {
  if (value.mode === 'application' && value.deviceId !== deviceId)
    return { mode: value.mode, needsReselection: true };
  return value.mode === 'application'
    ? { mode: value.mode, applicationName: path.basename(value.executable) }
    : { mode: value.mode };
}

function toPublicBrowserPreference(
  value: SavedBrowserHandler,
  deviceId: string,
): PublicBrowserHandlerPreference {
  if (!value || value.mode === 'system') return { mode: 'system' };
  if (value.deviceId !== deviceId) return { mode: 'application', needsReselection: true };
  return { mode: 'application', applicationName: path.basename(value.executable) };
}

function safeFailure(
  code: string,
  message: string,
  recovery?: RecoveryAction[],
): Extract<FileHandlerResult, { ok: false }> {
  return recovery ? { ok: false, code, message, recovery } : { ok: false, code, message };
}

function validOptions(
  value: unknown,
): { ok: true; chooseOnce: boolean; locale: FileHandlerLocale } | { ok: false } {
  if (value === undefined) return { ok: true, chooseOnce: false, locale: 'en' };
  if (!isRecord(value) || !hasOnlyKeys(value, ['chooseOnce', 'locale'])) return { ok: false };
  if (value.chooseOnce !== undefined && typeof value.chooseOnce !== 'boolean') return { ok: false };
  if (value.locale !== undefined && !isFileHandlerLocale(value.locale)) return { ok: false };
  return {
    ok: true,
    chooseOnce: value.chooseOnce === true,
    locale: value.locale === undefined ? 'en' : value.locale,
  };
}

function requestedLocale(value: unknown): FileHandlerLocale | null {
  if (value === undefined) return 'en';
  return isFileHandlerLocale(value) ? value : null;
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

function captureVaultContext(
  native: FileHandlerNativePort,
): { root: string; realRoot: string; generation: string | number } | null {
  try {
    const context = native.getCurrentVaultContext();
    if (
      !context ||
      typeof context.root !== 'string' ||
      !path.isAbsolute(context.root) ||
      typeof context.realRoot !== 'string' ||
      !path.isAbsolute(context.realRoot) ||
      (typeof context.generation !== 'string' && typeof context.generation !== 'number')
    )
      return null;
    return { root: context.root, realRoot: context.realRoot, generation: context.generation };
  } catch {
    return null;
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function normalizeVaultRelativePath(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_RELATIVE_PATH_LENGTH ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    path.isAbsolute(value)
  )
    return null;
  const segments = value.split('/');
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.includes(':') ||
        RESERVED_SEGMENTS.has(segment.toLowerCase()) ||
        segment.toLowerCase().startsWith('.morrow-tmp-'),
    )
  )
    return null;
  return segments.join('/');
}

async function validateVaultFile(
  relativePath: unknown,
  vaultContext: { root: string; realRoot: string; generation: string | number } | null,
): Promise<ValidatedFile | null> {
  const normalized = normalizeVaultRelativePath(relativePath);
  if (!normalized || !vaultContext || !path.isAbsolute(vaultContext.root)) return null;

  try {
    const currentRealRoot = await realpath(vaultContext.root);
    if (
      path.relative(path.resolve(currentRealRoot), path.resolve(vaultContext.realRoot)) !== '' ||
      path.relative(path.resolve(vaultContext.realRoot), path.resolve(currentRealRoot)) !== '' ||
      !(await lstat(vaultContext.realRoot)).isDirectory()
    )
      return null;

    const segments = normalized.split('/');
    let cursor = vaultContext.root;
    for (let index = 0; index < segments.length; index += 1) {
      cursor = path.join(cursor, segments[index]!);
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) return null;
      if (index < segments.length - 1 && !info.isDirectory()) return null;
      if (index === segments.length - 1 && !info.isFile()) return null;
    }

    const canonicalFile = await realpath(cursor);
    if (!isInside(vaultContext.realRoot, canonicalFile) || !(await lstat(canonicalFile)).isFile())
      return null;
    return {
      relativePath: normalized,
      absolutePath: canonicalFile,
      extension: path.extname(normalized).toLowerCase(),
      vaultContext,
    };
  } catch {
    return null;
  }
}

async function validateApplication(
  executable: unknown,
  native: FileHandlerNativePort,
): Promise<string | null> {
  if (!isAbsoluteLocalPath(executable)) return null;
  try {
    const root = path.parse(executable).root;
    let cursor = root;
    const segments = executable.slice(root.length).split(path.sep).filter(Boolean);
    if (segments.length === 0) return null;
    for (let index = 0; index < segments.length; index += 1) {
      cursor = path.join(cursor, segments[index]!);
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) return null;
      if (index < segments.length - 1 && !info.isDirectory()) return null;
      const isMacApplicationBundle =
        process.platform === 'darwin' &&
        path.extname(executable).toLowerCase() === '.app' &&
        info.isDirectory();
      if (index === segments.length - 1 && !info.isFile() && !isMacApplicationBundle) return null;
    }
    const canonical = await realpath(executable);
    if (
      path.relative(path.resolve(canonical), path.resolve(executable)) !== '' ||
      path.relative(path.resolve(executable), path.resolve(canonical)) !== ''
    )
      return null;
    await access(canonical, constants.X_OK);
    if (!(await native.isExecutableApplication(canonical))) return null;
    return canonical;
  } catch {
    return null;
  }
}

function startDetachedProcess(executable: string, args: string[], options: SpawnOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, options);
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/** Starts a selected executable with exactly one user resource argument and never invokes a shell. */
export function createSpawnLauncher(start: SpawnStart = startDetachedProcess): LaunchApplication {
  return (executable, argument) => {
    const isMacApplicationBundle =
      process.platform === 'darwin' && path.extname(executable).toLowerCase() === '.app';
    return start(
      isMacApplicationBundle ? '/usr/bin/open' : executable,
      isMacApplicationBundle ? ['-a', executable, argument] : [argument],
      {
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
      },
    );
  };
}

export function createFileHandlerModule(options: FileHandlerModuleOptions): FileHandlerModule {
  const settingsPath = path.join(options.userDataPath, SETTINGS_FILE);
  let settingsLock: Promise<void> = Promise.resolve();
  let deviceIdentityPromise: Promise<string> | null = null;

  function currentDeviceIdentity(): Promise<string> {
    if (!deviceIdentityPromise) {
      deviceIdentityPromise = Promise.resolve()
        .then(() => options.getDeviceIdentity())
        .then((identity) => {
          if (!isDeviceIdentity(identity)) throw new Error('Device identity is unavailable.');
          return identity;
        });
      void deviceIdentityPromise.catch(() => {
        deviceIdentityPromise = null;
      });
    }
    return deviceIdentityPromise;
  }

  async function tryDeviceIdentity(): Promise<string | null> {
    try {
      return await currentDeviceIdentity();
    } catch {
      return null;
    }
  }

  async function withSettingsLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = settingsLock;
    let unlock: () => void = () => {};
    settingsLock = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      unlock();
    }
  }

  async function readSettings(): Promise<SavedPreferences> {
    let contents: string;
    try {
      contents = await readFile(settingsPath, 'utf8');
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') return emptyPreferences();
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(contents);
    } catch {
      return emptyPreferences();
    }
    return parsePreferences(raw) ?? emptyPreferences();
  }

  async function saveSettings(settings: SavedPreferences): Promise<void> {
    await mkdir(options.userDataPath, { recursive: true });
    const temporaryPath = `${settingsPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporaryPath, settingsPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async function updateSettings(update: (settings: SavedPreferences) => void): Promise<void> {
    await withSettingsLock(async () => {
      const settings = await readSettings();
      update(settings);
      await saveSettings(settings);
    });
  }

  async function currentSettings(): Promise<SavedPreferences> {
    return withSettingsLock(readSettings);
  }

  function isTrusted(sender: unknown): boolean {
    try {
      return options.native.isTrustedSender(sender) === true;
    } catch {
      return false;
    }
  }

  function ensureTrusted(sender: unknown): Extract<FileHandlerResult, { ok: false }> | null {
    return isTrusted(sender) ? null : safeFailure('not-allowed', 'Not allowed.');
  }

  function getInternalExtensions(): string[] {
    try {
      return [
        ...new Set(
          options.native
            .getInternalExtensions()
            .map((extension) => normalizeExtension(extension))
            .filter((extension): extension is string => extension !== null),
        ),
      ];
    } catch {
      return [];
    }
  }

  function supportsInternal(extension: string): boolean {
    return getInternalExtensions().includes(extension);
  }

  async function chooseAndValidateApplication(
    kind: FileHandlerChooserKind,
    extension: string | null,
    locale: FileHandlerLocale,
  ): Promise<string | null | 'invalid'> {
    let selected: string | null;
    try {
      selected = await options.native.chooseApplication(kind, extension, locale);
    } catch {
      return 'invalid';
    }
    if (selected === null) return null;
    return (await validateApplication(selected, options.native)) ?? 'invalid';
  }

  function vaultHasNotChanged(captured: {
    root: string;
    realRoot: string;
    generation: string | number;
  }): boolean {
    const current = captureVaultContext(options.native);
    return (
      current !== null &&
      current.generation === captured.generation &&
      path.resolve(current.root) === path.resolve(captured.root) &&
      path.resolve(current.realRoot) === path.resolve(captured.realRoot)
    );
  }

  async function openValidatedFile(
    requestedFile: ValidatedFile,
    handler: SavedFileHandler,
  ): Promise<FileHandlerResult> {
    if (!vaultHasNotChanged(requestedFile.vaultContext))
      return safeFailure('vault-changed', 'The vault changed. Try opening the file again.');
    const file = await validateVaultFile(requestedFile.relativePath, requestedFile.vaultContext);
    if (!file)
      return safeFailure('invalid-resource', 'This file is no longer available in the current vault.');
    if (!vaultHasNotChanged(file.vaultContext))
      return safeFailure('vault-changed', 'The vault changed. Try opening the file again.');

    if (handler.mode === 'internal') {
      if (!supportsInternal(file.extension))
        return safeFailure('internal-viewer-unavailable', 'There is no internal viewer for this file type.', [
          'choose-application',
          'open-folder',
        ]);
      return { ok: true, destination: 'internal' };
    }

    if (handler.mode === 'application') {
      let deviceId: string;
      try {
        deviceId = await currentDeviceIdentity();
      } catch {
        return safeFailure('device-identity-unavailable', 'This device identity could not be verified.', [
          'choose-application',
          'open-folder',
        ]);
      }
      if (handler.deviceId !== deviceId)
        return safeFailure(
          'device-mismatch',
          'Choose this application again on this device before opening the file.',
          ['choose-application', 'open-folder'],
        );

      const executable = await validateApplication(handler.executable, options.native);
      if (!executable)
        return safeFailure('application-missing', 'The selected application is no longer available.', [
          'choose-application',
          'open-folder',
        ]);
      const finalFile = await validateVaultFile(file.relativePath, file.vaultContext);
      if (!finalFile)
        return safeFailure('invalid-resource', 'This file is no longer available in the current vault.');
      if (!vaultHasNotChanged(finalFile.vaultContext))
        return safeFailure('vault-changed', 'The vault changed. Try opening the file again.');
      try {
        await options.launchApplication(executable, finalFile.absolutePath);
        return { ok: true, destination: 'application' };
      } catch {
        return safeFailure('launch-failed', 'The selected application could not open this file.', [
          'choose-application',
          'open-folder',
        ]);
      }
    }

    if (!vaultHasNotChanged(file.vaultContext))
      return safeFailure('vault-changed', 'The vault changed. Try opening the file again.');
    if (BLOCKED_SYSTEM_EXTENSIONS.has(file.extension))
      return safeFailure(
        'active-content-blocked',
        'This active file type needs an explicitly chosen application.',
        ['choose-application', 'open-folder'],
      );
    try {
      const error = await options.native.openDefaultFile(file.absolutePath);
      return error === ''
        ? { ok: true, destination: 'system' }
        : safeFailure('no-association', 'No system application is available for this file type.', [
            'choose-application',
            'open-folder',
          ]);
    } catch {
      return safeFailure('open-failed', 'The system could not open this file.', [
        'choose-application',
        'open-folder',
      ]);
    }
  }

  async function setFileHandler(
    sender: unknown,
    extensionValue: unknown,
    modeValue: unknown,
    localeValue?: unknown,
  ): Promise<FileHandlerResult> {
    const denied = ensureTrusted(sender);
    if (denied) return denied;
    const locale = requestedLocale(localeValue);
    if (!locale) return safeFailure('invalid-request', 'The opening request is invalid.');
    const extension = normalizeExtension(extensionValue);
    if (!extension) return safeFailure('invalid-extension', 'Choose a valid file extension.');
    if (typeof modeValue !== 'string' || !['system', 'internal', 'application', 'reset'].includes(modeValue))
      return safeFailure('invalid-mode', 'Choose a supported opening method.');

    if (modeValue === 'reset') {
      try {
        await updateSettings((settings) => delete settings.files[extension]);
        return { ok: true };
      } catch {
        return safeFailure('settings-write-failed', 'The opening preference could not be saved.');
      }
    }
    if (modeValue === 'internal' && !supportsInternal(extension))
      return safeFailure('internal-viewer-unavailable', 'There is no internal viewer for this file type.');

    let handler: SavedFileHandler;
    if (modeValue === 'application') {
      const executable = await chooseAndValidateApplication('file', extension, locale);
      if (executable === null) return safeFailure('cancelled', 'Application selection was cancelled.');
      if (executable === 'invalid')
        return safeFailure('application-invalid', 'Choose an available application executable.');
      const deviceId = await tryDeviceIdentity();
      if (!deviceId)
        return safeFailure('device-identity-unavailable', 'This device identity could not be verified.');
      handler = { mode: 'application', executable, deviceId };
    } else if (modeValue === 'internal') handler = { mode: 'internal' };
    else handler = { mode: 'system' };

    try {
      await updateSettings((settings) => {
        settings.files[extension] = handler;
      });
      return { ok: true };
    } catch {
      return safeFailure('settings-write-failed', 'The opening preference could not be saved.');
    }
  }

  async function setBrowserHandler(
    sender: unknown,
    modeValue: unknown,
    localeValue?: unknown,
  ): Promise<FileHandlerResult> {
    const denied = ensureTrusted(sender);
    if (denied) return denied;
    const locale = requestedLocale(localeValue);
    if (!locale) return safeFailure('invalid-request', 'The opening request is invalid.');
    if (typeof modeValue !== 'string' || !['system', 'application', 'reset'].includes(modeValue))
      return safeFailure('invalid-mode', 'Choose a supported browser opening method.');
    if (modeValue === 'reset') {
      try {
        await updateSettings((settings) => {
          settings.browser = null;
        });
        return { ok: true };
      } catch {
        return safeFailure('settings-write-failed', 'The browser preference could not be saved.');
      }
    }

    let browser: SavedBrowserHandler;
    if (modeValue === 'application') {
      const executable = await chooseAndValidateApplication('browser', null, locale);
      if (executable === null) return safeFailure('cancelled', 'Browser selection was cancelled.');
      if (executable === 'invalid')
        return safeFailure('application-invalid', 'Choose an available browser executable.');
      const deviceId = await tryDeviceIdentity();
      if (!deviceId)
        return safeFailure('device-identity-unavailable', 'This device identity could not be verified.');
      browser = { mode: 'application', executable, deviceId };
    } else browser = { mode: 'system' };

    try {
      await updateSettings((settings) => {
        settings.browser = browser;
      });
      return { ok: true };
    } catch {
      return safeFailure('settings-write-failed', 'The browser preference could not be saved.');
    }
  }

  async function openFile(
    sender: unknown,
    relativePath: unknown,
    optionsValue?: unknown,
  ): Promise<FileHandlerResult> {
    const denied = ensureTrusted(sender);
    if (denied) return denied;
    const openOptions = validOptions(optionsValue);
    if (!openOptions.ok) return safeFailure('invalid-request', 'The file-opening request is invalid.');
    const capturedVault = captureVaultContext(options.native);
    const file = await validateVaultFile(relativePath, capturedVault);
    if (!file) return safeFailure('invalid-resource', 'This file is unavailable in the current vault.');
    if (!vaultHasNotChanged(file.vaultContext))
      return safeFailure('vault-changed', 'The vault changed. Try opening the file again.');

    const stored = await currentSettings();
    let handler = stored.files[file.extension] ?? { mode: 'system' as const };
    if (openOptions.chooseOnce) {
      const executable = await chooseAndValidateApplication('file', file.extension, openOptions.locale);
      if (executable === null) return safeFailure('cancelled', 'Application selection was cancelled.');
      if (executable === 'invalid')
        return safeFailure('application-invalid', 'Choose an available application executable.', [
          'choose-application',
          'open-folder',
        ]);
      if (!vaultHasNotChanged(file.vaultContext))
        return safeFailure('vault-changed', 'The vault changed. Try opening the file again.');
      const deviceId = await tryDeviceIdentity();
      if (!deviceId)
        return safeFailure('device-identity-unavailable', 'This device identity could not be verified.', [
          'choose-application',
          'open-folder',
        ]);
      if (!vaultHasNotChanged(file.vaultContext))
        return safeFailure('vault-changed', 'The vault changed. Try opening the file again.');
      handler = { mode: 'application', executable, deviceId };
    }
    return openValidatedFile(file, handler);
  }

  async function openUrl(
    sender: unknown,
    urlValue: unknown,
    optionsValue?: unknown,
  ): Promise<FileHandlerResult> {
    const denied = ensureTrusted(sender);
    if (denied) return denied;
    const openOptions = validOptions(optionsValue);
    if (!openOptions.ok) return safeFailure('invalid-request', 'The browser-opening request is invalid.');
    if (
      typeof urlValue !== 'string' ||
      urlValue.length === 0 ||
      urlValue.length > MAX_URL_LENGTH ||
      urlValue !== urlValue.trim() ||
      hasControlCharacters(urlValue)
    )
      return safeFailure('invalid-url', 'Enter a valid HTTP or HTTPS address.');

    let url: URL;
    try {
      url = new URL(urlValue);
    } catch {
      return safeFailure('invalid-url', 'Enter a valid HTTP or HTTPS address.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      return safeFailure(
        'invalid-url',
        'Only HTTP and HTTPS addresses without embedded credentials can be opened.',
      );

    const stored = await currentSettings();
    let browser = stored.browser ?? { mode: 'system' as const };
    if (openOptions.chooseOnce) {
      const executable = await chooseAndValidateApplication('browser', null, openOptions.locale);
      if (executable === null) return safeFailure('cancelled', 'Browser selection was cancelled.');
      if (executable === 'invalid')
        return safeFailure('application-invalid', 'Choose an available browser executable.', [
          'choose-application',
        ]);
      const deviceId = await tryDeviceIdentity();
      if (!deviceId)
        return safeFailure('device-identity-unavailable', 'This device identity could not be verified.', [
          'choose-application',
        ]);
      browser = { mode: 'application', executable, deviceId };
    }

    if (browser.mode === 'application') {
      let deviceId: string;
      try {
        deviceId = await currentDeviceIdentity();
      } catch {
        return safeFailure('device-identity-unavailable', 'This device identity could not be verified.', [
          'choose-application',
        ]);
      }
      if (browser.deviceId !== deviceId)
        return safeFailure(
          'device-mismatch',
          'Choose this browser again on this device before opening the address.',
          ['choose-application'],
        );
      const executable = await validateApplication(browser.executable, options.native);
      if (!executable)
        return safeFailure('application-missing', 'The selected browser is no longer available.', [
          'choose-application',
        ]);
      try {
        await options.launchApplication(executable, url.href);
        return { ok: true, destination: 'application' };
      } catch {
        return safeFailure('launch-failed', 'The selected browser could not open this address.', [
          'choose-application',
        ]);
      }
    }

    try {
      await options.native.openDefaultUrl(url.href);
      return { ok: true, destination: 'system' };
    } catch {
      return safeFailure('open-failed', 'The system browser could not open this address.', [
        'choose-application',
      ]);
    }
  }

  async function openContainingFolder(sender: unknown, relativePath: unknown): Promise<FileHandlerResult> {
    const denied = ensureTrusted(sender);
    if (denied) return denied;
    const capturedVault = captureVaultContext(options.native);
    const file = await validateVaultFile(relativePath, capturedVault);
    if (!file || !vaultHasNotChanged(file.vaultContext))
      return safeFailure('invalid-resource', 'This file is unavailable in the current vault.');
    try {
      await options.native.revealInFolder(file.absolutePath);
      return { ok: true };
    } catch {
      return safeFailure('open-folder-failed', 'The containing folder could not be opened.');
    }
  }

  async function getPreferences(sender: unknown) {
    const denied = ensureTrusted(sender);
    if (denied) return denied;
    try {
      const stored = await currentSettings();
      const deviceId = await currentDeviceIdentity();
      const files = Object.fromEntries(
        Object.entries(stored.files).map(([extension, handler]) => [
          extension,
          toPublicFilePreference(handler, deviceId),
        ]),
      );
      return {
        ok: true as const,
        preferences: {
          files,
          browser: toPublicBrowserPreference(stored.browser, deviceId),
          internalExtensions: getInternalExtensions(),
        },
      };
    } catch {
      return safeFailure('settings-read-failed', 'Opening preferences are unavailable.');
    }
  }

  return {
    getPreferences,
    setFileHandler,
    setBrowserHandler,
    openFile,
    openUrl,
    openContainingFolder,
  };
}
