import { isRecord } from '../../core/doc';

export type SavedNoteFont = 'serif' | 'sans' | 'mono';
export type SavedNoteWidth = 'comfortable' | 'wide' | 'full';

export interface SavedNoteStyle {
  font: SavedNoteFont;
  fontSize: number;
  lineHeight: number;
  blockSpacing: number;
  width: SavedNoteWidth;
}

const DEFAULT_NOTE_STYLE: SavedNoteStyle = {
  font: 'sans',
  fontSize: 16,
  lineHeight: 1.68,
  blockSpacing: 9,
  width: 'comfortable',
};

function boundedNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback;
}

/**
 * Reads the fork's legacy per-note style as a presentation-only projection.
 * The raw YAML stays in `page.extra`; this function never normalizes or writes it.
 */
export function readSavedNoteStyle(extra: Readonly<Record<string, unknown>>): SavedNoteStyle | null {
  const raw = extra.morrowNoteStyle;
  if (!isRecord(raw)) return null;

  return {
    font: ['serif', 'sans', 'mono'].includes(raw.font as string)
      ? (raw.font as SavedNoteFont)
      : DEFAULT_NOTE_STYLE.font,
    fontSize: boundedNumber(raw.fontSize, 12, 32, DEFAULT_NOTE_STYLE.fontSize),
    lineHeight: boundedNumber(raw.lineHeight, 1.2, 2.4, DEFAULT_NOTE_STYLE.lineHeight),
    blockSpacing: boundedNumber(raw.blockSpacing, 0, 40, DEFAULT_NOTE_STYLE.blockSpacing),
    width: ['comfortable', 'wide', 'full'].includes(raw.width as string)
      ? (raw.width as SavedNoteWidth)
      : DEFAULT_NOTE_STYLE.width,
  };
}
