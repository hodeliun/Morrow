// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NoteStyle } from '../../core/noteStyle';

const KEY = 'morrow.preferences';

afterEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('legacy default note style preference', () => {
  it('keeps a valid profile default when another preference is saved', async () => {
    const style: NoteStyle = {
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

  it('persists a Documento default across reloads and clears it when restored', async () => {
    const style: NoteStyle = {
      font: 'mono',
      fontSize: 15.5,
      lineHeight: 1.82,
      blockSpacing: 13,
      width: 'wide',
    };
    const preferences = await import('./preferences');
    preferences.setPreferences({ defaultNoteStyle: style });

    expect(JSON.parse(localStorage.getItem(KEY) ?? '{}').defaultNoteStyle).toEqual(style);
    vi.resetModules();
    const reloaded = await import('./preferences');
    expect(reloaded.getPreferences().defaultNoteStyle).toEqual(style);

    reloaded.setPreferences({ defaultNoteStyle: undefined });
    expect(JSON.parse(localStorage.getItem(KEY) ?? '{}')).not.toHaveProperty('defaultNoteStyle');
  });
});
