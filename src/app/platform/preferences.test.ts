// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

const KEY = 'morrow.preferences';

afterEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('legacy default note style preference', () => {
  it('keeps a valid profile default when another preference is saved', async () => {
    const style = {
      font: 'serif',
      fontSize: 20,
      lineHeight: 1.7,
      blockSpacing: 10,
      width: 'full',
    };
    localStorage.setItem(KEY, JSON.stringify({ defaultNoteStyle: style }));
    const preferences = await import('./preferences');

    expect(preferences.getPreferences().defaultNoteStyle).toEqual(style);
    preferences.setPreferences({ locale: 'es' });
    expect(JSON.parse(localStorage.getItem(KEY) ?? '{}')).toMatchObject({
      locale: 'es',
      defaultNoteStyle: style,
    });
  });

  it('drops an invalid legacy default rather than passing partial values to restore', async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ defaultNoteStyle: { font: 'serif', fontSize: 50, lineHeight: 1.7 } }),
    );
    const preferences = await import('./preferences');

    expect(preferences.getPreferences().defaultNoteStyle).toBeUndefined();
  });
});
