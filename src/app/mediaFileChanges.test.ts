import { describe, expect, it } from 'vitest';
import { affectsMediaFile } from './mediaFileChanges';

describe('media file watcher changes', () => {
  it('matches explicit changes to the selected non-page file', () => {
    expect(affectsMediaFile([{ path: 'Audio/voice.wav', other: true, size: 32 }], 'Audio/voice.wav')).toBe(true);
    expect(affectsMediaFile([{ path: 'Audio/other.wav', other: true }], 'Audio/voice.wav')).toBe(false);
    expect(affectsMediaFile([{ path: 'Audio/voice.wav', text: '# page' }], 'Audio/voice.wav')).toBe(false);
    expect(affectsMediaFile(undefined, 'Audio/voice.wav')).toBe(false);
  });

  it('invalidates nested media when a containing directory is removed', () => {
    expect(
      affectsMediaFile([{ path: 'Audio/Interviews', text: null, other: true, dir: true }], 'Audio/Interviews/voice.wav'),
    ).toBe(true);
    expect(
      affectsMediaFile([{ path: 'Audio/Interviews-old', text: null, other: true, dir: true }], 'Audio/Interviews/voice.wav'),
    ).toBe(false);
    expect(
      affectsMediaFile([{ path: 'Audio/Interviews', text: '', other: true, dir: true }], 'Audio/Interviews/voice.wav'),
    ).toBe(false);
  });
});
