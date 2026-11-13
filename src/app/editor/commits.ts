import type { Editor } from '@tiptap/core';
import { isMac } from '../platform/desktop';
import { isExitInteractionBlocked } from '../exitInteraction';
import { stepProperties } from '../workspace';
import { focusedDatabaseProviderRoot } from '../plugins/providerRegistry';

// open editors register here so exports and shutdown can save the latest keystrokes first
const pending = new Map<() => boolean, number>();
let focused: Editor | null = null;

export function registerCommit(commit: () => boolean): () => void {
  pending.set(commit, (pending.get(commit) ?? 0) + 1);
  return () => {
    const count = pending.get(commit);
    if (count === undefined) return;
    if (count <= 1) pending.delete(commit);
    else pending.set(commit, count - 1);
  };
}

export function commitEditors(): boolean {
  let saved = true;
  for (const commit of pending.keys()) {
    try {
      if (!commit()) saved = false;
    } catch {
      saved = false;
    }
  }
  return saved;
}

export function setFocusedEditor(editor: Editor | null): void {
  focused = editor;
}

export function focusedEditor(): Editor | null {
  return focused && !focused.isDestroyed ? focused : null;
}

// routes native menu undo and redo to the editor, or to a plain text field
export function undoRedo(direction: 'undo' | 'redo'): void {
  if (isExitInteractionBlocked()) return;
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    document.execCommand(direction);
    return;
  }
  const providerRoot = active instanceof HTMLElement ? focusedDatabaseProviderRoot(active) : null;
  if (providerRoot) {
    // Keep this event local to the provider root; bubbling to the app shortcut listener would route it again.
    providerRoot.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'z',
        shiftKey: direction === 'redo',
        bubbles: false,
        cancelable: true,
        ...(isMac ? { metaKey: true } : { ctrlKey: true }),
      }),
    );
    return;
  }
  // a canvas shown inside a page keeps its own history, the menu sends it the same keys
  const canvas = active instanceof HTMLElement ? active.closest('.canvas-view') : null;
  if (canvas) {
    canvas.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'z',
        shiftKey: direction === 'redo',
        bubbles: true,
        ...(isMac ? { metaKey: true } : { ctrlKey: true }),
      }),
    );
    return;
  }
  if (focused && !focused.isDestroyed && focused.view.dom.contains(active)) {
    if (direction === 'undo') focused.commands.undo();
    else focused.commands.redo();
    return;
  }
  // anywhere else, such as a property's menu, it steps back through property changes
  stepProperties(direction);
}

// true when ctrl+z belongs to whatever has focus, text being typed, the page editor or a canvas
export function ownsUndo(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement) return !['checkbox', 'radio', 'button'].includes(target.type);
  if (target instanceof HTMLTextAreaElement) return true;
  return (
    target instanceof HTMLElement && (target.isContentEditable || target.closest('.canvas-view') !== null)
  );
}
