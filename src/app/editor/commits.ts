import type { Editor } from '@tiptap/core';
import { redo, undo } from '@tiptap/pm/history';
import type { Transaction } from '@tiptap/pm/state';
import type { DocNode, PageId } from '../../core/model';
import { t } from '../i18n';
import { isMac } from '../platform/desktop';
import { toast } from '../ui';
import { getSession, stepProperties } from '../workspace';

// open editors register here so exports and shutdown can save the latest keystrokes first
const pending = new Set<() => void>();
let focused: Editor | null = null;
let focusedPageId: PageId | null = null;

export function registerCommit(commit: () => void): () => void {
  pending.add(commit);
  return () => pending.delete(commit);
}

export function commitEditors(): void {
  for (const commit of pending) commit();
}

export function setFocusedEditor(editor: Editor | null, pageId: PageId | null = null): void {
  focused = editor;
  focusedPageId = pageId;
}

export function undoRedoEditor(editor: Editor, pageId: PageId, direction: 'undo' | 'redo'): boolean {
  const active = typeof document === 'undefined' ? null : document.activeElement;
  if (
    active !== null &&
    ((typeof HTMLInputElement !== 'undefined' && active instanceof HTMLInputElement) ||
      (typeof HTMLTextAreaElement !== 'undefined' && active instanceof HTMLTextAreaElement))
  ) {
    document.execCommand(direction);
    return true;
  }
  commitEditors();
  const previous = editor.state.doc.toJSON() as DocNode;
  const transaction: { value: Transaction | null } = { value: null };
  const handled = (direction === 'undo' ? undo : redo)(editor.state, (next) => (transaction.value = next));
  const next = transaction.value;
  if (!handled || !next) return false;

  const databaseIds = getSession().databasePastesForHistory(
    pageId,
    previous,
    next.doc.toJSON() as DocNode,
    direction,
  );
  if (databaseIds.length > 0) {
    const result = getSession().transitionDatabasePastes(
      databaseIds,
      direction,
      next.doc.toJSON() as DocNode,
    );
    if (!result.ok) {
      toast(t('database.pasteUndoBlocked'), { tone: 'error' });
      return true;
    }
  }

  try {
    editor.view.dispatch(next);
  } catch (error) {
    if (databaseIds.length > 0) {
      const rollback = getSession().transitionDatabasePastes(
        databaseIds,
        direction === 'undo' ? 'redo' : 'undo',
        direction === 'redo' ? previous : undefined,
      );
      if (!rollback.ok) toast(t('database.copyUnavailable'), { tone: 'error' });
    }
    throw error;
  }
  commitEditors();
  return true;
}

// routes native menu undo and redo to the editor, or to a plain text field
export function undoRedo(direction: 'undo' | 'redo'): void {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    document.execCommand(direction);
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
    if (focusedPageId) undoRedoEditor(focused, focusedPageId, direction);
    else if (direction === 'undo') focused.commands.undo();
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
