import type { EditorEvents } from '@tiptap/core';
import { markdownToDoc } from '../../core/markdown/parse';
import type { DocNode } from '../../core/model';
import { isEffectivelyTrashed } from '../../core/tree';
import type {
  PluginEditorInsertionFailureReason,
  PluginEditorInsertionResultV1,
  PluginEditorInsertionTargetV1,
} from '../plugins/editorApi';
import { getPreferences, subscribePreferences } from '../platform/preferences';
import { activeHash, getTabs, subscribeTabs, targetPane } from '../tabs';
import { parseRoute } from '../router';
import {
  canInsertPageEditorTarget,
  isPageEditorInsertionPeerCurrent,
  pageEditorInsertionPeerFor,
  subscribePageEditorInsertionPeer,
} from './pageEditorCoordination';
import { focusedEditor } from './commits';
import { getSession, getWorkspaceSessionGeneration, subscribeWorkspaceSession } from '../workspace';

const INSERTION_CAPTURE_META = 'morrowPluginInsertionCapture';

/** The plugin owner identity is private and scoped to one load of the plugin. */
export interface EditorInsertionOwner {
  readonly generation: number;
  isActive(): boolean;
}

interface NavigationSnapshot {
  readonly activeTab: string;
  readonly pane: string;
  readonly hash: string;
  readonly pageId: string;
}

function navigationSnapshot(): NavigationSnapshot | null {
  try {
    const tabs = getTabs();
    const tab = tabs.tabs.find((item) => item.id === tabs.active);
    const pane = targetPane();
    const hash = activeHash();
    const route = parseRoute(hash);
    if (!tab || route.name !== 'page') return null;
    return { activeTab: tab.id, pane, hash, pageId: route.id };
  } catch {
    return null;
  }
}

function sameNavigation(first: NavigationSnapshot, second: NavigationSnapshot): boolean {
  return (
    first.activeTab === second.activeTab &&
    first.pane === second.pane &&
    first.hash === second.hash &&
    first.pageId === second.pageId
  );
}

function failed(reason: PluginEditorInsertionFailureReason): PluginEditorInsertionResultV1 {
  return { ok: false, reason };
}

function ownerIsCurrent(owner: EditorInsertionOwner, generation: number): boolean {
  try {
    return owner.generation === generation && owner.isActive();
  } catch {
    return false;
  }
}

function pageStillWritable(session: ReturnType<typeof getSession>, pageId: string): boolean {
  const state = session.getState();
  const page = state.pages[pageId];
  return Boolean(
    page &&
    state.docs[pageId] &&
    !session.isClosed &&
    !session.isMutationFenced &&
    !page.encrypted &&
    !session.unreadable.has(pageId) &&
    !session.protectedReasons.has(pageId) &&
    !isEffectivelyTrashed(state.pages, pageId),
  );
}

/**
 * Captures the currently focused page editor. The returned handle is deliberately opaque and one-shot;
 * every listener is removed when the handle is invalidated, disposed, or used.
 */
export function captureEditorInsertionTarget(
  owner: EditorInsertionOwner,
): PluginEditorInsertionTargetV1 | null {
  const editor = focusedEditor();
  if (!editor || editor.isDestroyed || !editor.view.dom.isConnected) return null;

  let session: ReturnType<typeof getSession>;
  try {
    session = getSession();
  } catch {
    return null;
  }
  const peer = pageEditorInsertionPeerFor(editor);
  const navigation = navigationSnapshot();
  const ownerGeneration = owner.generation;
  const sessionGeneration = getWorkspaceSessionGeneration();
  const capturedDoc = editor.state.doc;
  const capturedSelection = editor.state.selection;
  const capturedSessionDoc = session.getState().docs[peer?.pageId ?? ''];

  if (
    !peer ||
    peer.session !== session ||
    !navigation ||
    navigation.pane !== peer.pane ||
    navigation.pageId !== peer.pageId ||
    !ownerIsCurrent(owner, ownerGeneration) ||
    getPreferences().readingMode ||
    !canInsertPageEditorTarget(editor, peer) ||
    !capturedSessionDoc ||
    !pageStillWritable(session, peer.pageId)
  )
    return null;

  let live = true;
  let consumed = false;
  let invalidReason: PluginEditorInsertionFailureReason | null = null;
  const cleanups: Array<() => void> = [];
  const clean = () => {
    if (!live) return;
    live = false;
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  };
  const invalidate = (reason: PluginEditorInsertionFailureReason) => {
    if (!live) return;
    invalidReason = reason;
    clean();
  };
  const addCleanup = (cleanup: () => void) => {
    if (live) cleanups.push(cleanup);
    else cleanup();
  };

  const currentFailure = (): PluginEditorInsertionFailureReason | null => {
    if (!ownerIsCurrent(owner, ownerGeneration)) return 'owner-ended';
    try {
      if (getWorkspaceSessionGeneration() !== sessionGeneration || getSession() !== session)
        return 'session-changed';
    } catch {
      return 'session-changed';
    }
    if (session.isClosed) return 'session-closed';
    if (getPreferences().readingMode) return 'read-only';
    if (!editor.isEditable) return 'read-only';
    const currentPeer = pageEditorInsertionPeerFor(editor);
    if (!currentPeer || currentPeer.identity !== peer.identity) return 'peer-unavailable';
    if (currentPeer.pane !== peer.pane) return 'target-changed';
    if (currentPeer.editableGeneration !== peer.editableGeneration) return 'read-only';
    if (!isPageEditorInsertionPeerCurrent(editor, peer)) return 'peer-unavailable';
    const currentNavigation = navigationSnapshot();
    if (!currentNavigation || !sameNavigation(navigation, currentNavigation)) return 'target-changed';
    if (!editor.view.dom.isConnected || editor.isDestroyed) return 'peer-unavailable';
    if (!editor.state.doc.eq(capturedDoc)) return 'document-changed';
    if (!editor.state.selection.eq(capturedSelection)) return 'selection-changed';
    if (!pageStillWritable(session, peer.pageId)) return 'read-only';
    if (!canInsertPageEditorTarget(editor, peer)) return 'peer-unavailable';
    return null;
  };

  const onTransaction = ({ transaction, appendedTransactions }: EditorEvents['transaction']) => {
    if (transaction.docChanged || appendedTransactions.some((item) => item.docChanged)) {
      invalidate('document-changed');
    } else if (!editor.state.selection.eq(capturedSelection)) {
      invalidate('selection-changed');
    }
  };
  const onTabsChanged = () => {
    const current = navigationSnapshot();
    if (!current || !sameNavigation(navigation, current)) invalidate('target-changed');
  };
  const onHashChanged = (event: HashChangeEvent) => {
    if (navigation.pane === 'main' && hashFromUrl(event.oldURL) !== hashFromUrl(event.newURL)) {
      invalidate('target-changed');
      return;
    }
    onTabsChanged();
  };
  const onPreferencesChanged = () => {
    if (getPreferences().readingMode) invalidate('read-only');
  };
  const onSessionChanged = () => {
    if (!pageStillWritable(session, peer.pageId)) {
      invalidate('read-only');
      return;
    }
    const currentDoc = session.getState().docs[peer.pageId];
    if (
      !currentDoc ||
      (!sameDocContent(currentDoc, capturedSessionDoc) &&
        !sameDocContent(currentDoc, editor.getJSON() as DocNode))
    ) {
      invalidate('document-changed');
    }
  };

  editor.on('transaction', onTransaction);
  addCleanup(() => editor.off('transaction', onTransaction));
  addCleanup(subscribeTabs(onTabsChanged));
  window.addEventListener('hashchange', onHashChanged);
  addCleanup(() => window.removeEventListener('hashchange', onHashChanged));
  addCleanup(subscribePreferences(onPreferencesChanged));
  addCleanup(subscribeWorkspaceSession(() => invalidate('session-changed')));
  addCleanup(
    session.subscribeMutationFence(() => {
      if (session.isMutationFenced) invalidate('read-only');
    }),
  );
  addCleanup(session.subscribe(onSessionChanged));
  addCleanup(session.onClose(() => invalidate('session-closed')));
  addCleanup(
    subscribePageEditorInsertionPeer(editor, peer, () => {
      const currentPeer = pageEditorInsertionPeerFor(editor);
      if (!currentPeer || currentPeer.identity !== peer.identity) invalidate('peer-unavailable');
      else if (currentPeer.pane !== peer.pane) invalidate('target-changed');
      else if (currentPeer.editableGeneration !== peer.editableGeneration) invalidate('read-only');
      else invalidate('peer-unavailable');
    }),
  );

  const dispose = () => clean();
  const insert = (markdown: string): PluginEditorInsertionResultV1 => {
    if (invalidReason) return failed(invalidReason);
    const reason = currentFailure();
    if (reason) {
      invalidate(reason);
      return failed(reason);
    }
    if (consumed || !live) return failed('already-used');

    consumed = true;
    clean();
    let content: unknown[];
    try {
      content = markdownToDoc(String(markdown)).content ?? [];
    } catch {
      return failed('invalid-markdown');
    }
    if (content.length === 0) return failed('empty-content');

    const token = {};
    let accepted = false;
    const onAcceptedTransaction = ({ transaction }: EditorEvents['transaction']) => {
      if (transaction.getMeta(INSERTION_CAPTURE_META) === token && transaction.docChanged) accepted = true;
    };
    editor.on('transaction', onAcceptedTransaction);
    try {
      const ran = editor
        .chain()
        .focus()
        .command(({ tr }) => {
          tr.setMeta(INSERTION_CAPTURE_META, token);
          return true;
        })
        .insertContent(content as never)
        .run();
      return ran && accepted ? { ok: true } : failed('insert-rejected');
    } catch {
      return failed('insert-rejected');
    } finally {
      editor.off('transaction', onAcceptedTransaction);
    }
  };

  return Object.freeze({ version: 1 as const, insert, dispose });
}

function sameDocContent(first: DocNode, second: DocNode): boolean {
  const normalize = (doc: DocNode) => {
    const content = [...(doc.content ?? [])];
    while (content.length > 0) {
      const last = content[content.length - 1]!;
      if (last.type !== 'paragraph' || (last.content?.length ?? 0) > 0) break;
      content.pop();
    }
    return { ...doc, content };
  };
  return JSON.stringify(normalize(first)) === JSON.stringify(normalize(second));
}

function hashFromUrl(value: string): string {
  try {
    return new URL(value).hash || '#/';
  } catch {
    return '';
  }
}
