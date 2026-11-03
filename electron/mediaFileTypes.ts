export type MediaFileKind = 'audio' | 'video';

export interface MediaFileType {
  readonly kind: MediaFileKind;
  readonly mimeType: string;
}

export const MEDIA_FILE_TYPES: Readonly<Record<string, MediaFileType>> = Object.freeze({
  aac: { kind: 'audio', mimeType: 'audio/aac' },
  flac: { kind: 'audio', mimeType: 'audio/flac' },
  m4a: { kind: 'audio', mimeType: 'audio/mp4' },
  mp3: { kind: 'audio', mimeType: 'audio/mpeg' },
  oga: { kind: 'audio', mimeType: 'audio/ogg' },
  ogg: { kind: 'audio', mimeType: 'audio/ogg' },
  opus: { kind: 'audio', mimeType: 'audio/ogg' },
  wav: { kind: 'audio', mimeType: 'audio/wav' },
  wave: { kind: 'audio', mimeType: 'audio/wav' },
  weba: { kind: 'audio', mimeType: 'audio/webm' },
  m4v: { kind: 'video', mimeType: 'video/mp4' },
  mov: { kind: 'video', mimeType: 'video/quicktime' },
  mp4: { kind: 'video', mimeType: 'video/mp4' },
  ogv: { kind: 'video', mimeType: 'video/ogg' },
  webm: { kind: 'video', mimeType: 'video/webm' },
});

export function mediaFileType(relativePath: unknown): MediaFileType | null {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return null;
  const name = relativePath.split(/[\\/]/).at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  return MEDIA_FILE_TYPES[name.slice(dot + 1).toLowerCase()] ?? null;
}
