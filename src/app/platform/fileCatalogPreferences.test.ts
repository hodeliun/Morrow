import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('file catalog preferences', () => {
  it('stores bounded per-vault settings in the local profile and resets only that vault', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('navigator', { platform: 'Win32', userAgent: 'Windows' });
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    const prefs = await import('./fileCatalogPreferences');
    const vaultA = 'C:\\Synthetic\\Vault A';
    const vaultB = 'C:\\Synthetic\\Vault B';

    prefs.setFileCatalogPreferences(vaultA, { mode: 'all', hiddenExtensions: ['pdf'] });
    prefs.setFileCatalogPreferences(vaultB, { mode: 'all', showAttachments: true });
    expect(prefs.getFileCatalogPreferences(vaultA).hiddenExtensions).toEqual(['pdf']);
    expect(prefs.getFileCatalogPreferences(vaultB).showAttachments).toBe(true);
    expect(storage.get('morrow.fileCatalogPreferences')).toContain('vault a');

    prefs.resetFileCatalogPreferences(vaultA);
    expect(prefs.getFileCatalogPreferences(vaultA).mode).toBe('selected');
    expect(prefs.getFileCatalogPreferences(vaultB).mode).toBe('all');
    expect(prefs.getFileCatalogPreferences(vaultB).showAttachments).toBe(true);
  });

  it('keeps Linux vault paths case-sensitive', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('navigator', { platform: 'Linux x86_64', userAgent: 'Linux' });
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    const prefs = await import('./fileCatalogPreferences');

    prefs.setFileCatalogPreferences('/tmp/Vault A', { mode: 'all' });
    prefs.setFileCatalogPreferences('/tmp/vault a', { showAttachments: true });

    expect(prefs.getFileCatalogPreferences('/tmp/Vault A')).toMatchObject({
      mode: 'all',
      showAttachments: false,
    });
    expect(prefs.getFileCatalogPreferences('/tmp/vault a')).toMatchObject({
      mode: 'selected',
      showAttachments: true,
    });
    expect(JSON.parse(storage.get('morrow.fileCatalogPreferences') ?? '{}')).toHaveProperty('/tmp/Vault A');
    expect(JSON.parse(storage.get('morrow.fileCatalogPreferences') ?? '{}')).toHaveProperty('/tmp/vault a');
  });

  it('uses checked visibility in all mode to add an exclusion and removes it when unchecked', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
    const { fileCatalogExtensionPatch } = await import('./fileCatalogPreferences');
    const preferences = {
      mode: 'all' as const,
      selectedExtensions: [],
      hiddenExtensions: ['jpg'],
      customExtensions: [],
      includeExtensionless: false,
      showAttachments: false,
    };

    expect(fileCatalogExtensionPatch(preferences, 'pdf', true)).toEqual({
      hiddenExtensions: ['jpg', 'pdf'],
    });
    expect(fileCatalogExtensionPatch(preferences, 'jpg', false)).toEqual({ hiddenExtensions: [] });
  });

  it('adds and removes types from the selected set in selected mode', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
    const { fileCatalogExtensionPatch } = await import('./fileCatalogPreferences');
    const preferences = {
      mode: 'selected' as const,
      selectedExtensions: ['pdf'],
      hiddenExtensions: [],
      customExtensions: [],
      includeExtensionless: false,
      showAttachments: false,
    };

    expect(fileCatalogExtensionPatch(preferences, 'jpg', true)).toEqual({
      selectedExtensions: ['pdf', 'jpg'],
    });
    expect(fileCatalogExtensionPatch(preferences, 'pdf', false)).toEqual({ selectedExtensions: [] });
  });
});
