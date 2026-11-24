export const FILE_CATALOG_PREFERENCES_KEY = 'morrow.fileCatalogPreferences';

const MAX_VAULTS = 200;
const MAX_STORE_LENGTH = 2_000_000;
const MAX_PREFERENCE_LENGTH = 65_536;

export interface FileCatalogPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type FileCatalogPreferenceReadResult =
  | { status: 'ready'; value: unknown | null }
  | { status: 'invalid' | 'unavailable' };

export type FileCatalogPreferenceWriteResult =
  | { status: 'saved' }
  | { status: 'invalid' | 'unavailable' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function fileCatalogVaultKey(location: string, platform: string): string | null {
  if (typeof location !== 'string' || !location.trim() || location.length > 4096) return null;
  const trimmed = location.trim();
  const windows = /^(?:win|windows)/i.test(platform.trim());
  const normalized = windows
    ? trimmed.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
    : trimmed.replace(/\/+$/, '');
  return normalized.length <= 4096 ? normalized : null;
}

function readMap(storage: FileCatalogPreferenceStorage):
  | { status: 'ready'; values: Record<string, unknown> }
  | { status: 'invalid' | 'unavailable' } {
  let raw: string | null;
  try {
    raw = storage.getItem(FILE_CATALOG_PREFERENCES_KEY);
  } catch {
    return { status: 'unavailable' };
  }
  if (raw === null) return { status: 'ready', values: {} };
  if (raw.length > MAX_STORE_LENGTH) return { status: 'invalid' };
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? { status: 'ready', values: parsed } : { status: 'invalid' };
  } catch {
    return { status: 'invalid' };
  }
}

export function readFileCatalogPreference(
  storage: FileCatalogPreferenceStorage,
  location: string,
  platform: string,
): FileCatalogPreferenceReadResult {
  const key = fileCatalogVaultKey(location, platform);
  if (key === null) return { status: 'invalid' };
  const stored = readMap(storage);
  if (stored.status !== 'ready') return stored;
  return {
    status: 'ready',
    value: Object.prototype.hasOwnProperty.call(stored.values, key) ? stored.values[key] : null,
  };
}

export function writeFileCatalogPreference(
  storage: FileCatalogPreferenceStorage,
  location: string,
  platform: string,
  value: unknown | null,
): FileCatalogPreferenceWriteResult {
  const key = fileCatalogVaultKey(location, platform);
  if (key === null) return { status: 'invalid' };

  let encodedValue: string | null = null;
  if (value !== null) {
    try {
      encodedValue = JSON.stringify(value);
    } catch {
      return { status: 'invalid' };
    }
    if (typeof encodedValue !== 'string' || encodedValue.length > MAX_PREFERENCE_LENGTH) {
      return { status: 'invalid' };
    }
  }

  const stored = readMap(storage);
  if (stored.status !== 'ready') return stored;
  const values = { ...stored.values };
  if (value === null) delete values[key];
  else {
    try {
      values[key] = JSON.parse(encodedValue!);
    } catch {
      return { status: 'invalid' };
    }
  }

  // Match the published cap while leaving every other vault's value intact unless a new
  // vault would exceed it. Existing data is only touched after its source parsed cleanly.
  if (!Object.prototype.hasOwnProperty.call(stored.values, key) && Object.keys(values).length > MAX_VAULTS) {
    const oldest = Object.keys(values)[0];
    if (oldest !== undefined) delete values[oldest];
  }
  try {
    if (Object.keys(values).length === 0) storage.removeItem(FILE_CATALOG_PREFERENCES_KEY);
    else {
      const encoded = JSON.stringify(values);
      if (encoded.length > MAX_STORE_LENGTH) return { status: 'invalid' };
      storage.setItem(FILE_CATALOG_PREFERENCES_KEY, encoded);
    }
    return { status: 'saved' };
  } catch {
    return { status: 'unavailable' };
  }
}
