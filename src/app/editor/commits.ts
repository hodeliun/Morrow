import type { Editor } from '@tiptap/core';
import { redo, undo } from '@tiptap/pm/history';
import type { Transaction } from '@tiptap/pm/state';
import type { DocNode, PageId } from '../../core/model';
import type { DataHistoryStepResult } from '../../storage/dataHistory';
import type { ViewHistoryIdentity } from '../../storage/viewHistoryCapture';
import type { ViewHistoryStepResult } from '../../storage/viewHistory';
import { t } from '../i18n';
import { isMac } from '../platform/desktop';
import { toast } from '../ui';
import { dataHistoryEditGuard, getSession, stepProperties } from '../workspace';
import { pageEditorsMatchDocuments } from './pageEditorRegistry';

// open editors register here so exports and shutdown can save the latest keystrokes first
const pending = new Set<() => void>();
let focused: Editor | null = null;
let focusedPageId: PageId | null = null;

function usesNativeInputUndo(active: Element | null): boolean {
  if (!active) return false;
  if (
    (typeof HTMLTextAreaElement !== 'undefined' && active instanceof HTMLTextAreaElement) ||
    active.tagName === 'TEXTAREA'
  )
    return true;
  if (
    !(typeof HTMLInputElement !== 'undefined' && active instanceof HTMLInputElement) &&
    active.tagName !== 'INPUT'
  )
    return false;
  const input = active as HTMLInputElement;
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(input.type);
}

export function registerCommit(commit: () => void): () => void {
  pending.add(commit);
  return () => pending.delete(commit);
}

export function commitEditors(): void {
  for (const commit of pending) commit();
}

export function stepLinkedViewContextualHistory(
  databaseId: PageId,
  identity: Extract<ViewHistoryIdentity, { kind: 'linked' }>,
  direction: 'undo' | 'redo',
  canEditNow?: () => boolean,
): Promise<DataHistoryStepResult | ViewHistoryStepResult> {
  commitEditors();
  const session = getSession();
  const candidate = session.getContextualHistory(databaseId, identity)[direction];
  if (!candidate) return Promise.resolve({ status: 'empty' });

  // Data actions and disabled view entries keep the existing Session result and barriers.
  if (candidate.owner.kind === 'data' || candidate.status !== 'ready' || !candidate.enabled)
    return session.stepContextualHistory(databaseId, identity, direction, canEditNow, candidate.id);

  // Preserve Session's permission result instead of turning a readonly/busy editor into a
  // preflight conflict. The Session rechecks this guard synchronously when it applies the entry.
  if (canEditNow) {
    try {
      if (!canEditNow())
        return session.stepContextualHistory(databaseId, identity, direction, canEditNow, candidate.id);
    } catch {
      return session.stepContextualHistory(databaseId, identity, direction, canEditNow, candidate.id);
    }
  }

  const targets = session.linkedViewHistoryReplayTargets(identity, direction, candidate.id);
  if (targets.status === 'candidate-changed')
    return session.stepContextualHistory(databaseId, identity, direction, canEditNow, candidate.id);
  if (targets.status !== 'ready') return Promise.resolve({ status: 'conflict' });
  if (targets.entryId !== candidate.id) return Promise.resolve({ status: 'conflict' });

  if (
    !pageEditorsMatchDocuments(
      targets.hosts.map(({ hostPageId, doc }) => ({ pageId: hostPageId, doc })),
    )
  )
    return Promise.resolve({ status: 'conflict' });

  // No await between validating all affected pane editors and Session's expected-entry check.
  return session.stepContextualHistory(databaseId, identity, direction, canEditNow, candidate.id);
}

export function setFocusedEditor(editor: Editor | null, pageId: PageId | null = null): void {
  focused = editor;
  focusedPageId = pageId;
}

function routeDataHistoryUndo(active: Element | null, direction: 'undo' | 'redo'): boolean {
  const root = active?.closest<HTMLElement>('[data-data-history-database]') ?? null;
  if (!root) return false;
  const databaseId = root.dataset.dataHistoryDatabase;
  const canEditNow = dataHistoryEditGuard(root);
  if (root.dataset.dataHistoryEditable === 'true' && databaseId && canEditNow)
    void getSession()
      .stepDataHistory(databaseId, direction, canEditNow)
      .then((result) => {
        if (result.status === 'applied' || result.status === 'empty') return;
        const message =
          result.status === 'blocked'
            ? result.reason === 'related'
              ? t('database.historyBlocked')
              : t('database.historyPermissionChanged')
            : result.status === 'conflict'
              ? t('database.actionRecoveryConflict')
              : result.status === 'unavailable'
                ? t('database.dataHistoryUnavailable')
                : t('database.actionRecoveryPending');
        toast(message, {
          tone: result.status === 'conflict' || result.status === 'unavailable' ? 'error' : 'info',
        });
      });
  return true;
}

function routeContextualHistoryUndo(active: Element | null, direction: 'undo' | 'redo'): boolean {
  const root = active?.closest<HTMLElement>('[data-context-history-database]') ?? null;
  if (!root) return false;
  const databaseId = root.dataset.contextHistoryDatabase;
  const canEditNow = dataHistoryEditGuard(root);
  let identity: ViewHistoryIdentity | null = null;
  if (root.dataset.contextHistoryKind === 'linked') {
    const hostPageId = root.dataset.contextHistoryHostPage;
    const blockId = root.dataset.contextHistoryBlock;
    if (hostPageId && blockId) identity = { kind: 'linked', hostPageId, blockId };
  } else {
    const viewId = root.dataset.contextHistoryView;
    if (databaseId && viewId) identity = { kind: 'database', databaseId, viewId };
  }
  if (!databaseId || !identity) return false;
  const candidate = getSession().getContextualHistory(databaseId, identity)[direction];
  if (!candidate) return false;
  const step = identity.kind === 'linked'
    ? stepLinkedViewContextualHistory(databaseId, identity, direction, canEditNow ?? undefined)
    : getSession().stepContextualHistory(databaseId, identity, direction, canEditNow ?? undefined, candidate.id);
  void step
    .then((result) => {
      if (result.status === 'applied' || result.status === 'empty') return;
      const message =
        result.status === 'blocked'
          ? result.reason === 'related'
            ? t('database.historyBlocked')
            : t('database.historyPermissionChanged')
          : result.status === 'conflict'
            ? t('database.actionRecoveryConflict')
            : result.status === 'unavailable'
              ? t('database.dataHistoryUnavailable')
              : t('database.actionRecoveryPending');
      toast(message, {
        tone: result.status === 'conflict' || result.status === 'unavailable' ? 'error' : 'info',
      });
    });
  return true;
}

export function undoRedoEditor(editor: Editor, pageId: PageId, direction: 'undo' | 'redo'): boolean {
  const active = typeof document === 'undefined' ? null : document.activeElement;
  if (usesNativeInputUndo(active)) {
    document.execCommand(direction);
    return true;
  }
  commitEditors();
  if (routeContextualHistoryUndo(active, direction)) return true;
  if (routeDataHistoryUndo(active, direction)) return true;
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
  if (usesNativeInputUndo(active)) {
    document.execCommand(direction);
    return;
  }
  commitEditors();
  if (routeContextualHistoryUndo(active, direction)) return;
  if (routeDataHistoryUndo(active, direction)) return;
  // a canvas shown inside a page keeps its own history, the menu sends it the same keys
  const canvas = typeof HTMLElement !== 'undefined' && active instanceof HTMLElement
    ? active.closest('.canvas-view')
    : null;
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
  if (!target || typeof target !== 'object') return false;
  const tagName = 'tagName' in target ? (target as { tagName?: unknown }).tagName : undefined;
  if (
    (typeof HTMLInputElement !== 'undefined' && target instanceof HTMLInputElement) ||
    tagName === 'INPUT'
  ) {
    const input = target as HTMLInputElement;
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(
      input.type,
    );
  }
  if (
    (typeof HTMLTextAreaElement !== 'undefined' && target instanceof HTMLTextAreaElement) ||
    tagName === 'TEXTAREA'
  )
    return true;
  if (typeof HTMLElement !== 'undefined' && target instanceof HTMLElement)
    return target.isContentEditable || target.closest('.canvas-view') !== null;
  const element = target as EventTarget & {
    isContentEditable?: boolean;
    closest?: (selector: string) => Element | null;
  };
  return Boolean(
    element.isContentEditable ||
      (typeof element.closest === 'function' && element.closest('.canvas-view') !== null),
  );
}
