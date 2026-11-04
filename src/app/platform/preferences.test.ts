import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('web link opening preference', () => {
  it('keeps old profiles external by default and persists an explicit internal choice', async () => {
    const storage = new Map<string, string>([
      ['morrow.preferences', JSON.stringify({ locale: 'en', theme: 'dark' })],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });

    let preferences = await import('./preferences');
    expect(preferences.getPreferences().webLinkOpening).toBe('external');

    preferences.setPreferences({ webLinkOpening: 'internal' });
    expect(JSON.parse(storage.get('morrow.preferences') ?? '{}').webLinkOpening).toBe('internal');

    vi.resetModules();
    preferences = await import('./preferences');
    expect(preferences.getPreferences().webLinkOpening).toBe('internal');
  });
});
