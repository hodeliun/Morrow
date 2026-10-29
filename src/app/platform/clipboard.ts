import type { GridClipboardEnvelope, GridClipboardPayload } from '../../core/gridOperations';
import { desktop } from './desktop';

export const GRID_CLIPBOARD_MIME = 'web application/x.morrow-grid-range';

export interface GridClipboardContents {
  text: string;
  hasGridPayload: boolean;
  gridPayloadJson: string | null;
}

function requireDesktopClipboard() {
  if (!desktop?.clipboard) throw new Error('Desktop clipboard is unavailable.');
  return desktop.clipboard;
}

export async function readClipboardText(): Promise<string> {
  if (desktop) return requireDesktopClipboard().readText();
  if (!navigator.clipboard?.readText) throw new Error('System clipboard is unavailable.');
  return navigator.clipboard.readText();
}

export async function writeClipboardText(text: string): Promise<void> {
  if (desktop) {
    if (!(await requireDesktopClipboard().writeText(text)))
      throw new Error('Could not write to the system clipboard.');
    return;
  }
  if (!navigator.clipboard?.writeText) throw new Error('System clipboard is unavailable.');
  await navigator.clipboard.writeText(text);
}

export async function readGridClipboard(): Promise<GridClipboardContents> {
  if (desktop) return requireDesktopClipboard().readGrid();
  return { text: await readClipboardText(), hasGridPayload: false, gridPayloadJson: null };
}

export async function writeGridClipboard(text: string, payload: GridClipboardPayload): Promise<void> {
  const envelope: GridClipboardEnvelope = {
    version: 1,
    kind: 'morrow-grid-clipboard',
    text,
    payload,
  };
  const envelopeJson = JSON.stringify(envelope);
  if (desktop) {
    if (!(await requireDesktopClipboard().writeGrid(text, envelopeJson)))
      throw new Error('Could not write to the system clipboard.');
    return;
  }
  await writeClipboardText(text);
}
