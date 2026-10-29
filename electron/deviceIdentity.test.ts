import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeviceIdentityProvider } from './deviceIdentity.js';
import type { DeviceIdentitySafeStorage } from './deviceIdentity.js';

const temporaryRoots: string[] = [];

function safeStorage(
  scope: string,
  machineBound: boolean,
  backend?: 'basic_text' | 'gnome_libsecret' | 'kwallet' | 'kwallet5' | 'kwallet6' | 'unknown',
): DeviceIdentitySafeStorage {
  return {
    isAsyncEncryptionAvailable: async () => true,
    ...(backend ? { getSelectedStorageBackend: () => backend } : {}),
    encryptStringAsync: async (value) => Buffer.from(machineBound ? `${scope}\0${value}` : value, 'utf8'),
    decryptStringAsync: async (value) => {
      const decrypted = value.toString('utf8');
      if (!machineBound) return { result: decrypted, shouldReEncrypt: false };
      const prefix = `${scope}\0`;
      if (!decrypted.startsWith(prefix)) throw new Error('Synthetic machine key mismatch.');
      return { result: decrypted.slice(prefix.length), shouldReEncrypt: false };
    },
  };
}

function machineAnchor(value: string | null = 'a'.repeat(32)) {
  return async () => value;
}

async function profilePath(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'morrow-device-identity-'));
  temporaryRoots.push(root);
  const profile = path.join(root, 'profile');
  await mkdir(profile, { recursive: true });
  return profile;
}

describe('device-local handler identity', () => {
  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('changes when a copied profile cannot be decrypted on the second device', async () => {
    const profileA = await profilePath();
    const idA = await createDeviceIdentityProvider({
      userDataPath: profileA,
      safeStorage: safeStorage('device-a', true),
      getMachineAnchor: machineAnchor(),
      platform: 'win32',
      hostName: 'same-computer-name',
    })();
    const copyRoot = path.join(path.dirname(profileA), 'profile-copy');
    await cp(profileA, copyRoot, { recursive: true });
    const identityOnB = createDeviceIdentityProvider({
      userDataPath: copyRoot,
      safeStorage: safeStorage('device-b', true),
      getMachineAnchor: machineAnchor(),
      platform: 'win32',
      hostName: 'same-computer-name',
    });

    expect(await identityOnB()).not.toBe(idA);
    expect(await identityOnB()).toBe(await identityOnB());
  });

  it('binds copied basic-text profiles to the machine id', async () => {
    const profileA = await profilePath();
    const idA = await createDeviceIdentityProvider({
      userDataPath: profileA,
      safeStorage: safeStorage('shared-basic-text', false, 'basic_text'),
      getMachineAnchor: machineAnchor('a'.repeat(32)),
      platform: 'linux',
      hostName: 'same-computer-name',
    })();
    const copyRoot = path.join(path.dirname(profileA), 'profile-copy');
    await cp(profileA, copyRoot, { recursive: true });
    const idB = await createDeviceIdentityProvider({
      userDataPath: copyRoot,
      safeStorage: safeStorage('shared-basic-text', false, 'basic_text'),
      getMachineAnchor: machineAnchor('b'.repeat(32)),
      platform: 'linux',
      hostName: 'same-computer-name',
    })();

    expect(idB).not.toBe(idA);
  });

  it('changes a copied roaming profile even when protected storage decrypts on both Windows devices', async () => {
    const profileA = await profilePath();
    const idA = await createDeviceIdentityProvider({
      userDataPath: profileA,
      safeStorage: safeStorage('roaming-dpapi-token', false),
      getMachineAnchor: machineAnchor('a'.repeat(32)),
      platform: 'win32',
      hostName: 'same-computer-name',
    })();
    const copyRoot = path.join(path.dirname(profileA), 'roaming-profile-copy');
    await cp(profileA, copyRoot, { recursive: true });
    const idB = await createDeviceIdentityProvider({
      userDataPath: copyRoot,
      safeStorage: safeStorage('roaming-dpapi-token', false),
      getMachineAnchor: machineAnchor('b'.repeat(32)),
      platform: 'win32',
      hostName: 'same-computer-name',
    })();

    expect(idB).not.toBe(idA);
  });

  it.each(['win32', 'darwin'] as const)(
    'fails closed when %s safeStorage is unavailable',
    async (osPlatform) => {
      const storage = safeStorage('unavailable', true);
      storage.isAsyncEncryptionAvailable = async () => false;
      const identity = createDeviceIdentityProvider({
        userDataPath: await profilePath(),
        safeStorage: storage,
        getMachineAnchor: machineAnchor(),
        platform: osPlatform,
        hostName: 'same-computer-name',
      });

      await expect(identity()).rejects.toThrow('Device encryption is unavailable.');
    },
  );

  it.each(['win32', 'darwin'] as const)(
    'fails closed when %s has no valid OS machine anchor',
    async (osPlatform) => {
      const identity = createDeviceIdentityProvider({
        userDataPath: await profilePath(),
        safeStorage: safeStorage('missing-machine-anchor', true),
        getMachineAnchor: machineAnchor(null),
        platform: osPlatform,
        hostName: 'same-computer-name',
      });

      await expect(identity()).rejects.toThrow('A reliable OS machine identifier is unavailable.');
    },
  );

  it('fails closed when protected token encryption fails', async () => {
    const storage = safeStorage('persist-fails', true);
    storage.encryptStringAsync = async () => {
      throw new Error('Synthetic safe-storage failure.');
    };
    const identity = createDeviceIdentityProvider({
      userDataPath: await profilePath(),
      safeStorage: storage,
      getMachineAnchor: machineAnchor(),
      platform: 'win32',
      hostName: 'same-computer-name',
    });

    await expect(identity()).rejects.toThrow('Synthetic safe-storage failure.');
  });

  it('fails closed when the protected identity token cannot be written to userData', async () => {
    const profile = await profilePath();
    const userDataFile = path.join(path.dirname(profile), 'profile-is-a-file');
    await writeFile(userDataFile, 'not a directory');
    const identity = createDeviceIdentityProvider({
      userDataPath: userDataFile,
      safeStorage: safeStorage('disk-write-fails', true),
      getMachineAnchor: machineAnchor(),
      platform: 'darwin',
      hostName: 'same-computer-name',
    });

    await expect(identity()).rejects.toThrow();
  });

  it('fails closed when Linux basic-text storage has no valid machine id', async () => {
    const identity = createDeviceIdentityProvider({
      userDataPath: await profilePath(),
      safeStorage: safeStorage('basic-text', false, 'basic_text'),
      getMachineAnchor: machineAnchor(null),
      platform: 'linux',
      hostName: 'same-computer-name',
    });

    await expect(identity()).rejects.toThrow('A reliable Linux machine ID is unavailable.');
  });

  it('uses only the machine id when Linux backend lookup fails', async () => {
    const storage = safeStorage('unknown-backend', false);
    storage.getSelectedStorageBackend = () => {
      throw new Error('Synthetic backend lookup failure.');
    };
    const identity = createDeviceIdentityProvider({
      userDataPath: await profilePath(),
      safeStorage: storage,
      getMachineAnchor: machineAnchor('c'.repeat(32)),
      platform: 'linux',
      hostName: 'same-computer-name',
    });

    await expect(identity()).resolves.toMatch(/^[a-f0-9]{64}$/);
    const noMachineId = createDeviceIdentityProvider({
      userDataPath: await profilePath(),
      safeStorage: storage,
      getMachineAnchor: machineAnchor(null),
      platform: 'linux',
      hostName: 'same-computer-name',
    });
    await expect(noMachineId()).rejects.toThrow('A reliable Linux machine ID is unavailable.');
  });

  it('uses protected tokens when Linux has a keyring backend', async () => {
    const profileA = await profilePath();
    const idA = await createDeviceIdentityProvider({
      userDataPath: profileA,
      safeStorage: safeStorage('keyring-a', true, 'gnome_libsecret'),
      getMachineAnchor: machineAnchor(),
      platform: 'linux',
      hostName: 'same-computer-name',
    })();
    const copyRoot = path.join(path.dirname(profileA), 'profile-copy');
    await cp(profileA, copyRoot, { recursive: true });
    const idB = await createDeviceIdentityProvider({
      userDataPath: copyRoot,
      safeStorage: safeStorage('keyring-b', true, 'kwallet6'),
      getMachineAnchor: machineAnchor(),
      platform: 'linux',
      hostName: 'same-computer-name',
    })();

    expect(idB).not.toBe(idA);
  });
});
