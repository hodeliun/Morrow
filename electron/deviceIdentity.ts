import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { arch, hostname, platform } from 'node:os';
import path from 'node:path';

const IDENTITY_FILE = 'file-handler-device.json';
const TOKEN = /^[0-9a-f-]{36}$/i;
const MACHINE_ANCHOR = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
const ALL_ZERO_ANCHOR = /^0+$/;
const PROTECTED_LINUX_BACKENDS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);

export interface DeviceIdentitySafeStorage {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
  getSelectedStorageBackend?():
    'basic_text' | 'gnome_libsecret' | 'kwallet' | 'kwallet5' | 'kwallet6' | 'unknown';
}

export interface DeviceIdentityOptions {
  userDataPath: string;
  safeStorage: DeviceIdentitySafeStorage;
  /** Supplies a fixed OS-owned machine identifier; its raw value never leaves main or enters preferences. */
  getMachineAnchor(): Promise<string | null>;
  /** Override these only in tests; production uses values from the main process host. */
  platform?: string;
  hostName?: string;
}

interface StoredIdentity {
  version: 1;
  ciphertext: string;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isStoredIdentity(value: unknown): value is StoredIdentity {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { version?: unknown }).version === 1 &&
    typeof (value as { ciphertext?: unknown }).ciphertext === 'string' &&
    /^[A-Za-z0-9+/]+={0,2}$/.test((value as { ciphertext: string }).ciphertext)
  );
}

export function createDeviceIdentityProvider(options: DeviceIdentityOptions): () => Promise<string> {
  const identityPath = path.join(options.userDataPath, IDENTITY_FILE);
  const osPlatform = options.platform ?? platform();
  let identityPromise: Promise<string> | null = null;

  async function getMachineAnchor(): Promise<string> {
    let value: string | null;
    try {
      value = await options.getMachineAnchor();
    } catch {
      value = null;
    }
    if (!value || !MACHINE_ANCHOR.test(value.trim()))
      throw new Error(
        osPlatform === 'linux'
          ? 'A reliable Linux machine ID is unavailable.'
          : 'A reliable OS machine identifier is unavailable.',
      );
    const normalized = value.trim().replaceAll('-', '').toLowerCase();
    if (ALL_ZERO_ANCHOR.test(normalized))
      throw new Error(
        osPlatform === 'linux'
          ? 'A reliable Linux machine ID is unavailable.'
          : 'A reliable OS machine identifier is unavailable.',
      );
    return normalized;
  }

  function machineFingerprint(machineAnchorHash: string): string {
    return digest(`${osPlatform}\0${options.hostName ?? hostname()}\0${arch()}\0${machineAnchorHash}`);
  }

  async function readToken(): Promise<{ token: string; shouldReEncrypt: boolean } | null> {
    try {
      const stored: unknown = JSON.parse(await readFile(identityPath, 'utf8'));
      if (!isStoredIdentity(stored)) return null;
      const decoded = await options.safeStorage.decryptStringAsync(Buffer.from(stored.ciphertext, 'base64'));
      return TOKEN.test(decoded.result)
        ? { token: decoded.result, shouldReEncrypt: decoded.shouldReEncrypt }
        : null;
    } catch {
      return null;
    }
  }

  async function writeToken(token: string): Promise<void> {
    const encrypted = await options.safeStorage.encryptStringAsync(token);
    await mkdir(options.userDataPath, { recursive: true });
    const temporaryPath = `${identityPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify({ version: 1, ciphertext: encrypted.toString('base64') } satisfies StoredIdentity)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
      await rename(temporaryPath, identityPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async function createIdentity(): Promise<string> {
    const machineAnchor = await getMachineAnchor();
    const fingerprint = machineFingerprint(digest(machineAnchor));

    if (osPlatform === 'linux') {
      let backend: string;
      try {
        backend = options.safeStorage.getSelectedStorageBackend?.() ?? 'unknown';
      } catch {
        backend = 'unknown';
      }
      if (backend === 'basic_text' || backend === 'unknown') {
        return digest(`morrow-device-linux-machine-v1\0${fingerprint}`);
      }
      if (!PROTECTED_LINUX_BACKENDS.has(backend))
        throw new Error('A protected Linux storage backend is unavailable.');
    } else if (osPlatform !== 'win32' && osPlatform !== 'darwin') {
      throw new Error('A supported device identity provider is unavailable.');
    }

    let encryptionAvailable: boolean;
    try {
      encryptionAvailable = await options.safeStorage.isAsyncEncryptionAvailable();
    } catch {
      throw new Error('Device encryption is unavailable.');
    }
    if (!encryptionAvailable) throw new Error('Device encryption is unavailable.');

    const stored = await readToken();
    if (stored) {
      if (stored.shouldReEncrypt) await writeToken(stored.token);
      return digest(`morrow-device-v1\0${fingerprint}\0${stored.token}`);
    }

    const token = randomUUID();
    await writeToken(token);
    return digest(`morrow-device-v1\0${fingerprint}\0${token}`);
  }

  return () => {
    if (!identityPromise) {
      identityPromise = createIdentity();
      void identityPromise.catch(() => {
        identityPromise = null;
      });
    }
    return identityPromise;
  };
}
