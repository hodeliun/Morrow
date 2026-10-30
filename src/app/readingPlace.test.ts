import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const values = new Map<string, string>();
const key = 'morrow.readingPlaces.v2';
const scope = { vaultKey: 'vault-a', tabId: 'tab-a', pane: 'pane-a', pageId: 'page-a' };

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  values.clear();
  vi.stubGlobal('localStorage', {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => values.set(name, value),
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('vault and pane reading places', () => {
  it('restores both cursor and scroll after restart without sharing another live tab', async () => {
    let store = await import('./readingPlace');
    store.setReadingVaultScope('vault-a');
    store.rememberScopedPlace(scope, { scroll: 700, from: 12, to: 19 });
    store.flushPlaces();
    vi.resetModules();
    store = await import('./readingPlace');
    store.setReadingVaultScope('vault-a');
    expect(store.resolveReadingPlace(scope)).toEqual({ scroll: 700, from: 12, to: 19 });
    expect(store.resolveReadingPlace({ ...scope, tabId: 'tab-b' })).toEqual({ scroll: 0, from: 0, to: 0 });
    expect(store.resolveReadingPlace(scope)).toEqual({ scroll: 700, from: 12, to: 19 });
  });

  it('isolates equal page and tab identifiers across vault changes', async () => {
    const store = await import('./readingPlace');
    store.setReadingVaultScope('vault-a');
    store.rememberScopedPlace(scope, { scroll: 700, from: 12, to: 19 });
    store.setReadingVaultScope('vault-b');
    expect(store.resolveReadingPlace({ ...scope, vaultKey: 'vault-b' })?.scroll).toBe(0);
    store.rememberScopedPlace({ ...scope, vaultKey: 'vault-b' }, { scroll: 240 });
    store.setReadingVaultScope('vault-a');
    expect(store.resolveReadingPlace(scope)).toEqual({ scroll: 700, from: 12, to: 19 });
  });

  it('migrates legacy reading places once and preserves unknown future storage', async () => {
    values.set('morrow.readingPlaces', JSON.stringify({ 'page-a': { scroll: 700, from: 12, to: 19 } }));
    let store = await import('./readingPlace');
    store.setReadingVaultScope('vault-a');
    expect(store.readingPlace('page-a')?.scroll).toBe(700);
    store.setReadingVaultScope('vault-b');
    expect(store.readingPlace('page-a')).toBeNull();
    store.flushPlaces();
    const future = JSON.stringify({ version: 99, entries: ['unknown'] });
    values.set(key, future);
    vi.resetModules();
    store = await import('./readingPlace');
    store.setReadingVaultScope('vault-a');
    store.rememberScopedPlace(scope, { scroll: 240 });
    store.flushPlaces();
    expect(values.get(key)).toBe(future);
  });
});
