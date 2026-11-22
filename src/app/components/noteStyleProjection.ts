import { projectNoteStyle } from '../../core/noteStyle';
import type { NoteStyle } from '../../core/noteStyle';

export type SavedNoteFont = NoteStyle['font'];
export type SavedNoteWidth = NoteStyle['width'];
export type SavedNoteStyle = NoteStyle;

/**
 * Reads the fork's legacy per-note style as a presentation-only projection.
 * The raw YAML stays in `page.extra`; this function never normalizes or writes it.
 */
export function readSavedNoteStyle(extra: Readonly<Record<string, unknown>>): SavedNoteStyle | null {
  return projectNoteStyle(extra.morrowNoteStyle);
}
