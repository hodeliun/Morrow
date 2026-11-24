import { isRecord } from './doc';
import type { PageKind } from './model';

export type NoteStyleFont = 'serif' | 'sans' | 'mono';
export type NoteStyleWidth = 'comfortable' | 'wide' | 'full';
export type BasePageWidth = NoteStyleWidth;

export interface NoteStyle {
  font: NoteStyleFont;
  fontSize: number;
  lineHeight: number;
  blockSpacing: number;
  width: NoteStyleWidth;
}

export const DEFAULT_NOTE_STYLE: NoteStyle = {
  font: 'sans',
  fontSize: 16,
  lineHeight: 1.68,
  blockSpacing: 9,
  width: 'comfortable',
};

const NOTE_STYLE_FIELDS = ['font', 'fontSize', 'lineHeight', 'blockSpacing', 'width'] as const;

/** Page kinds whose metadata and physical Markdown source can carry a note style. */
export function supportsNoteStyleKind(kind: PageKind): boolean {
  return kind === 'page' || kind === 'journal' || kind === 'templates';
}

export function isValidNoteStyle(value: unknown): value is NoteStyle {
  if (!isRecord(value)) return false;
  return (
    ['serif', 'sans', 'mono'].includes(value.font as string) &&
    typeof value.fontSize === 'number' &&
    Number.isFinite(value.fontSize) &&
    value.fontSize >= 12 &&
    value.fontSize <= 32 &&
    typeof value.lineHeight === 'number' &&
    Number.isFinite(value.lineHeight) &&
    value.lineHeight >= 1.2 &&
    value.lineHeight <= 2.4 &&
    typeof value.blockSpacing === 'number' &&
    Number.isFinite(value.blockSpacing) &&
    value.blockSpacing >= 0 &&
    value.blockSpacing <= 40 &&
    ['comfortable', 'wide', 'full'].includes(value.width as string)
  );
}

/** Validates an API input with exactly the five fields this version owns. */
export function isValidNoteStyleInput(value: unknown): value is NoteStyle {
  if (!isRecord(value) || Reflect.ownKeys(value).length !== NOTE_STYLE_FIELDS.length) return false;
  for (const field of NOTE_STYLE_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
  }
  return isValidNoteStyle(value);
}

/** Reads a presentation projection while leaving the raw extra value untouched. */
export function projectNoteStyle(value: unknown): NoteStyle | null {
  if (!isRecord(value)) return null;
  return {
    font: ['serif', 'sans', 'mono'].includes(value.font as string)
      ? (value.font as NoteStyleFont)
      : DEFAULT_NOTE_STYLE.font,
    fontSize: bounded(value.fontSize, 12, 32, DEFAULT_NOTE_STYLE.fontSize),
    lineHeight: bounded(value.lineHeight, 1.2, 2.4, DEFAULT_NOTE_STYLE.lineHeight),
    blockSpacing: bounded(value.blockSpacing, 0, 40, DEFAULT_NOTE_STYLE.blockSpacing),
    width: ['comfortable', 'wide', 'full'].includes(value.width as string)
      ? (value.width as NoteStyleWidth)
      : DEFAULT_NOTE_STYLE.width,
  };
}

/** Defaults from the old per-note editor, used when the profile has no valid saved default. */
export function legacyNoteStyle(font: NoteStyleFont, width: BasePageWidth): NoteStyle {
  if (font === 'serif') return { font, fontSize: 18, lineHeight: 1.7, blockSpacing: 10, width };
  if (font === 'mono') return { font, fontSize: 14.5, lineHeight: 1.75, blockSpacing: 8, width };
  return { font, fontSize: 16, lineHeight: 1.68, blockSpacing: 9, width };
}

/** A valid legacy profile default wins; otherwise preserve the active 2.2 font and width. */
export function resolveDefaultNoteStyle(
  profileValue: unknown,
  font: NoteStyleFont,
  width: BasePageWidth,
): NoteStyle {
  if (isValidNoteStyle(profileValue)) return projectNoteStyle(profileValue)!;
  return legacyNoteStyle(font, width);
}

/** Merges only the five owned fields and refuses an unknown non-object representation. */
export function mergeNoteStyleExtra(
  extra: Readonly<Record<string, unknown>>,
  style: NoteStyle,
): Record<string, unknown> | null {
  const current = extra.morrowNoteStyle;
  if (current !== undefined && !isRecord(current)) return null;
  const nextStyle = { ...(isRecord(current) ? current : {}), ...style };
  return { ...extra, morrowNoteStyle: nextStyle };
}

function bounded(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback;
}
