import { describe, expect, it, vi } from 'vitest';
import {
  FILE_CATALOG_PREFERENCES_KEY,
  fileCatalogVaultKey,
  readFileCatalogPreference,
  writeFileCatalogPreference,
} from './fileCatalogPreferences';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key)),
  };
}

describe('Polaris Arquivos profile preferences', () => {
  it('uses the published Windows path convention and preserves case elsewhere', () => {
    expect(fileCatalogVaultKey(' C:/Users/Carlos/Vault/ ', 'win32')).toBe('c:\\users\\carlos\\vault');
    expect(fileCatalogVaultKey('/Users/Carlos/Vault///', 'darwin')).toBe('/Users/Carlos/Vault');
    expect(fileCatalogVaultKey('/', 'linux')).toBe('');
    expect(fileCatalogVaultKey('  ', 'linux')).toBeNull();
  });

  it('reads and updates only the selected vault in the legacy key and map format', () => {
    const first = { mode: 'selected', selectedExtensions: ['pdf'] };
    const second = { mode: 'all', hiddenExtensions: ['zip'] };
    const storage = memoryStorage({
      [FILE_CATALOG_PREFERENCES_KEY]: JSON.stringify({
        '/home/carlos/One': first,
        '/home/carlos/Two': second,
      }),
    });

    expect(readFileCatalogPreference(storage, '/home/carlos/One/', 'linux')).toEqual({ status: 'ready', value: first });
    expect(writeFileCatalogPreference(storage, '/home/carlos/One', 'linux', { mode: 'all' })).toEqual({ status: 'saved' });
    expect(JSON.parse(storage.values.get(FILE_CATALOG_PREFERENCES_KEY)!)).toEqual({
      '/home/carlos/One': { mode: 'all' },
      '/home/carlos/Two': second,
    });

    expect(writeFileCatalogPreference(storage, '/home/carlos/One', 'linux', null)).toEqual({ status: 'saved' });
    expect(JSON.parse(storage.values.get(FILE_CATALOG_PREFERENCES_KEY)!)).toEqual({ '/home/carlos/Two': second });
  });

  it('shares a Windows preference across slash and case variants', () => {
    const storage = memoryStorage();
    expect(writeFileCatalogPreference(storage, 'C:/Vault/', 'win32', { mode: 'all' })).toEqual({ status: 'saved' });
    expect(readFileCatalogPreference(storage, 'c:\\vault', 'win32')).toEqual({
      status: 'ready',
      value: { mode: 'all' },
    });
  });

  it('refuses to overwrite malformed source and leaves its bytes untouched', () => {
    const raw = '{not json';
    const storage = memoryStorage({ [FILE_CATALOG_PREFERENCES_KEY]: raw });

    expect(readFileCatalogPreference(storage, '/vault', 'linux')).toEqual({ status: 'invalid' });
    expect(writeFileCatalogPreference(storage, '/vault', 'linux', { mode: 'all' })).toEqual({ status: 'invalid' });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.values.get(FILE_CATALOG_PREFERENCES_KEY)).toBe(raw);
  });

  it('reports source shapes, values, output sizes and storage failures without clearing other data', () => {
    const arrayStorage = memoryStorage({ [FILE_CATALOG_PREFERENCES_KEY]: '[]' });
    expect(readFileCatalogPreference(arrayStorage, '/vault', 'linux')).toEqual({ status: 'invalid' });
    expect(writeFileCatalogPreference(arrayStorage, '/vault', 'linux', { mode: 'all' })).toEqual({ status: 'invalid' });
    expect(arrayStorage.values.get(FILE_CATALOG_PREFERENCES_KEY)).toBe('[]');

    const invalidValueStorage = memoryStorage();
    expect(writeFileCatalogPreference(invalidValueStorage, '/vault', 'linux', undefined)).toEqual({ status: 'invalid' });

    const setFailure = memoryStorage();
    setFailure.setItem.mockImplementation(() => {
      throw new Error('quota');
    });
    expect(writeFileCatalogPreference(setFailure, '/vault', 'linux', { mode: 'all' })).toEqual({
      status: 'unavailable',
    });

    const getFailure = memoryStorage();
    getFailure.getItem.mockImplementation(() => {
      throw new Error('unavailable');
    });
    expect(readFileCatalogPreference(getFailure, '/vault', 'linux')).toEqual({ status: 'unavailable' });
    expect(writeFileCatalogPreference(getFailure, '/vault', 'linux', { mode: 'all' })).toEqual({
      status: 'unavailable',
    });

    const nearLimit = Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`/other/${index}`, 'x'.repeat(63_000)]));
    const initial = JSON.stringify(nearLimit);
    expect(initial.length).toBeLessThan(2_000_000);
    const boundedStorage = memoryStorage({ [FILE_CATALOG_PREFERENCES_KEY]: initial });
    expect(writeFileCatalogPreference(boundedStorage, '/vault', 'linux', { data: 'y'.repeat(63_000) })).toEqual({
      status: 'invalid',
    });
    expect(boundedStorage.setItem).not.toHaveBeenCalled();
    expect(boundedStorage.values.get(FILE_CATALOG_PREFERENCES_KEY)).toBe(initial);
  });
});
