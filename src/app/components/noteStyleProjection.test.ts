import { describe, expect, it } from 'vitest';
import { readSavedNoteStyle } from './noteStyleProjection';

describe('readSavedNoteStyle', () => {
  it('projects saved style values without replacing the raw metadata', () => {
    const extra = {
      morrowNoteStyle: {
        font: 'mono',
        fontSize: 21.5,
        lineHeight: 2.2,
        blockSpacing: 0,
        width: 'full',
        futureSetting: { enabled: true },
      },
      futureYaml: ['keep', { as: 'loaded' }],
    };
    const before = structuredClone(extra);

    expect(readSavedNoteStyle(extra)).toEqual({
      font: 'mono',
      fontSize: 21.5,
      lineHeight: 2.2,
      blockSpacing: 0,
      width: 'full',
    });
    expect(extra).toEqual(before);
  });

  it('uses the legacy projection fallbacks for invalid members and leaves absent or non-object values alone', () => {
    expect(readSavedNoteStyle({ morrowNoteStyle: {} })).toEqual({
      font: 'sans',
      fontSize: 16,
      lineHeight: 1.68,
      blockSpacing: 9,
      width: 'comfortable',
    });
    expect(
      readSavedNoteStyle({
        morrowNoteStyle: {
          font: 'future-font',
          fontSize: 100,
          lineHeight: Number.NaN,
          blockSpacing: -1,
          width: 'future-width',
        },
      }),
    ).toEqual({
      font: 'sans',
      fontSize: 16,
      lineHeight: 1.68,
      blockSpacing: 9,
      width: 'comfortable',
    });
    expect(readSavedNoteStyle({})).toBeNull();
    expect(readSavedNoteStyle({ morrowNoteStyle: 'future-format' })).toBeNull();
    expect(readSavedNoteStyle({ morrowNoteStyle: ['future-format'] })).toBeNull();
  });
});
