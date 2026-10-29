import { useSyncExternalStore } from 'react';
import {
  DEFAULT_FILE_CATALOG_PREFERENCES,
  normalizeFileCatalogPreferences,
} from '../../core/vault/fileCatalog';
import type { FileCatalogPreferences } from '../../core/vault/fileCatalog';

const KEY = 'morrow.fileCatalogPreferences';
const MAX_VAULTS = 200;
const defaults = normalizeFileCatalogPreferences(DEFAULT_FILE_CATALOG_PREFERENCES);

function vaultKey(location: string): string {
  const normalized = location.trim().replace(/\//g, '\\').replace(/\\+$/, '');
  const windows =
    typeof navigator !== 'undefined' &&
    (/win/i.test(navigator.platform) || /windows/i.test(navigator.userAgent));
  return windows ? normalized.toLowerCase() : location.trim().replace(/\/+$/, '');
}

function read(): Map<string, FileCatalogPreferences> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map();
    const result = new Map<string, FileCatalogPreferences>();
    for (const [location, value] of Object.entries(parsed as Record<string, unknown>).slice(0, MAX_VAULTS)) {
      if (!location || location.length > 4096) continue;
      result.set(location, normalizeFileCatalogPreferences(value));
    }
    return result;
  } catch {
    return new Map();
  }
}

let values = read();
const defaultSnapshots = new Map<string, FileCatalogPreferences>();
const listeners = new Map<string, Set<() => void>>();

function defaultFor(key: string): FileCatalogPreferences {
  let snapshot = defaultSnapshots.get(key);
  if (!snapshot) {
    snapshot = normalizeFileCatalogPreferences(defaults);
    defaultSnapshots.set(key, snapshot);
  }
  return snapshot;
}

export function getFileCatalogPreferences(location: string): FileCatalogPreferences {
  const key = vaultKey(location);
  return values.get(key) ?? defaultFor(key);
}

function notify(key: string): void {
  for (const listener of listeners.get(key) ?? []) listener();
}

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(values)));
  } catch {
    // the preference still applies for this session if the profile store is unavailable
  }
}

export function setFileCatalogPreferences(location: string, patch: Partial<FileCatalogPreferences>): void {
  const key = vaultKey(location);
  const next = normalizeFileCatalogPreferences({ ...getFileCatalogPreferences(location), ...patch });
  values = new Map(values);
  values.delete(key);
  if (JSON.stringify(next) !== JSON.stringify(defaultFor(key))) values.set(key, next);
  while (values.size > MAX_VAULTS) {
    const oldest = values.keys().next().value;
    if (oldest === undefined) break;
    values.delete(oldest);
  }
  defaultSnapshots.delete(key);
  persist();
  notify(key);
}

export function resetFileCatalogPreferences(location: string): void {
  const key = vaultKey(location);
  values = new Map(values);
  values.delete(key);
  defaultSnapshots.delete(key);
  persist();
  notify(key);
}

export function fileCatalogExtensionPatch(
  preferences: FileCatalogPreferences,
  extension: string,
  checked: boolean,
): Partial<FileCatalogPreferences> {
  const extensions =
    preferences.mode === 'all' ? preferences.hiddenExtensions : preferences.selectedExtensions;
  const next = new Set(extensions);
  if (preferences.mode === 'all') {
    if (checked) next.add(extension);
    else next.delete(extension);
    return { hiddenExtensions: [...next] };
  }
  if (checked) next.add(extension);
  else next.delete(extension);
  return { selectedExtensions: [...next] };
}

export function useFileCatalogPreferences(location: string): FileCatalogPreferences {
  const key = vaultKey(location);
  return useSyncExternalStore(
    (listener) => {
      const bucket = listeners.get(key) ?? new Set<() => void>();
      bucket.add(listener);
      listeners.set(key, bucket);
      return () => {
        bucket.delete(listener);
        if (bucket.size === 0) listeners.delete(key);
      };
    },
    () => getFileCatalogPreferences(location),
    () => getFileCatalogPreferences(location),
  );
}
