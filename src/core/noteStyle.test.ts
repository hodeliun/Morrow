import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTE_STYLE,
  isValidNoteStyle,
  isValidNoteStyleInput,
  legacyNoteStyle,
  mergeNoteStyleExtra,
  projectNoteStyle,
  resolveDefaultNoteStyle,
} from './noteStyle';

describe('note style values', () => {
  it('validates the supported enums and release limits', () => {
    expect(
      isValidNoteStyle({
        font: 'mono',
        fontSize: 32,
        lineHeight: 2.4,
        blockSpacing: 40,
        width: 'full',
      }),
    ).toBe(true);
    expect(isValidNoteStyle({ ...DEFAULT_NOTE_STYLE, fontSize: 11.99 })).toBe(false);
    expect(isValidNoteStyle({ ...DEFAULT_NOTE_STYLE, lineHeight: 2.401 })).toBe(false);
    expect(isValidNoteStyle({ ...DEFAULT_NOTE_STYLE, blockSpacing: -0.1 })).toBe(false);
    expect(isValidNoteStyle({ ...DEFAULT_NOTE_STYLE, font: 'display' })).toBe(false);
    expect(isValidNoteStyle({ ...DEFAULT_NOTE_STYLE, width: 'ultra' })).toBe(false);
    expect(isValidNoteStyleInput({ ...DEFAULT_NOTE_STYLE, future: 'ignored' })).toBe(false);
    expect(isValidNoteStyleInput({ ...DEFAULT_NOTE_STYLE })).toBe(true);
  });

  it('projects partial values without changing the source or discarding future fields', () => {
    const extra = {
      morrowNoteStyle: { font: 'serif', futureSetting: { mode: 'keep' } },
      futureYaml: ['untouched'],
    };
    const before = structuredClone(extra);
    expect(projectNoteStyle(extra.morrowNoteStyle)).toEqual({
      ...DEFAULT_NOTE_STYLE,
      font: 'serif',
    });
    expect(extra).toEqual(before);

    expect(
      mergeNoteStyleExtra(extra, {
        font: 'mono',
        fontSize: 14.5,
        lineHeight: 1.75,
        blockSpacing: 8,
        width: 'wide',
      }),
    ).toEqual({
      morrowNoteStyle: {
        font: 'mono',
        fontSize: 14.5,
        lineHeight: 1.75,
        blockSpacing: 8,
        width: 'wide',
        futureSetting: { mode: 'keep' },
      },
      futureYaml: ['untouched'],
    });
    expect(mergeNoteStyleExtra({ morrowNoteStyle: 'future-format' }, DEFAULT_NOTE_STYLE)).toBeNull();
    expect(mergeNoteStyleExtra({ morrowNoteStyle: null }, DEFAULT_NOTE_STYLE)).toBeNull();
  });

  it('restores a valid profile default or derives the legacy fields from current 2.2 preferences', () => {
    const profile = { ...DEFAULT_NOTE_STYLE, font: 'serif' as const, fontSize: 19 };
    expect(resolveDefaultNoteStyle(profile, 'mono', 'wide')).toEqual(profile);
    expect(resolveDefaultNoteStyle({ ...profile, width: 'future' }, 'mono', 'wide')).toEqual(
      legacyNoteStyle('mono', 'wide'),
    );
    expect(resolveDefaultNoteStyle(null, 'serif', 'comfortable')).toEqual(
      legacyNoteStyle('serif', 'comfortable'),
    );
    expect(resolveDefaultNoteStyle(null, 'sans', 'full')).toEqual(legacyNoteStyle('sans', 'full'));
  });
});
