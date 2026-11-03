import { describe, expect, it } from 'vitest';
import { MEDIA_FILE_TYPES, mediaFileType } from './mediaFileTypes.js';

describe('local media file types', () => {
  it('maps explicit audio and video extensions to MIME types without asserting codec support', () => {
    expect(mediaFileType('Samples/Voice.WAV')).toEqual({ kind: 'audio', mimeType: 'audio/wav' });
    expect(mediaFileType('素材/interview.weba')).toEqual({ kind: 'audio', mimeType: 'audio/webm' });
    expect(mediaFileType('Clips/short.WEBM')).toEqual({ kind: 'video', mimeType: 'video/webm' });
    expect(mediaFileType('Clips/movie.MP4')).toEqual({ kind: 'video', mimeType: 'video/mp4' });
    expect(mediaFileType('Clips/movie.mov')).toEqual({ kind: 'video', mimeType: 'video/quicktime' });
    expect(Object.keys(MEDIA_FILE_TYPES)).toHaveLength(15);
  });

  it('rejects unknown, empty, hidden-only, extensionless, and non-string paths', () => {
    for (const path of [null, undefined, 3, '', '.webm', 'folder/no-extension', 'clip.xyz'])
      expect(mediaFileType(path)).toBeNull();
  });

  it('uses only the final path segment for classification', () => {
    expect(mediaFileType('folder.wav/recording.unknown')).toBeNull();
    expect(mediaFileType('folder.mp4/recording.WAV')).toEqual({ kind: 'audio', mimeType: 'audio/wav' });
  });
});
