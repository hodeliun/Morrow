import type { Editor, EditorEvents } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { isEffectivelyTrashed } from '../../core/tree';
import {
  LEGACY_FORMULA_NODE,
  legacyFormulaDocIssue,
  parseEditableLegacyFormula,
  updateLegacyFormulaMarker,
} from '../../core/legacyFormula';
import type { DocNode } from '../../core/model';
import { getPreferences, subscribePreferences } from '../platform/preferences';
import { activeHash, getTabs, isPrimaryPane, isSidePane, subscribeTabs, targetPane } from '../tabs';
import { parseRoute } from '../router';
import {
  canInsertPageEditorTarget,
  isPageEditorInsertionPeerCurrent,
  pageEditorInsertionPeerFor,
  subscribePageEditorInsertionPeer,
} from '../editor/pageEditorCoordination';
import type { PageEditorInsertionPeer } from '../editor/pageEditorCoordination';
import type { EditorInsertionOwner } from '../editor/editorInsertion';
import { getSession, getWorkspaceSessionGeneration, subscribeWorkspaceSession } from '../workspace';
import type {
  PluginInlineFormulaEditConfirmation,
  PluginInlineFormulaEditHost,
  PluginInlineFormulaEditInitial,
  PluginInlineFormulaInsertionFailureReason,
  PluginInlineFormulaInsertionResult,
} from './inlineFormulaApi';

const EDIT_META = 'morrowInlineFormulaEditCapture';

interface NavigationSnapshot {
  readonly activeTab: string;
  readonly pane: string;
  readonly hash: string;
  readonly pageId: string;
}

interface EditSnapshot {
  readonly owner: EditorInsertionOwner;
  readonly ownerGeneration: number;
  readonly editor: Editor;
  readonly position: number;
  readonly raw: string;
  readonly fallback: string;
  readonly initial: Readonly<PluginInlineFormulaEditInitial>;
  readonly peer: PageEditorInsertionPeer;
  readonly navigation: NavigationSnapshot;
  readonly session: ReturnType<typeof getSession>;
  readonly sessionGeneration: number;
  readonly sessionDoc: DocNode;
  readonly editorDoc: ProseMirrorNode;
  readonly selection: Editor['state']['selection'];
}

/** Captures one inline formula target without giving the plugin an editor or source Markdown. */
export function captureInlineFormulaEditTarget(
  owner: EditorInsertionOwner,
  editor: Editor,
  position: number,
  raw: string,
  fallback: string,
): PluginInlineFormulaEditHost | null {
  const snapshot = captureSnapshot(owner, editor, position, raw, fallback);
  if (!snapshot) return null;

  let live = true;
  let consumed = false;
  let acceptedFocusTarget: { readonly raw: string; readonly fallback: string } | null = null;
  let invalidReason: PluginInlineFormulaInsertionFailureReason | null = null;
  const cleanups: Array<() => void> = [];
  const clean = () => {
    if (!live) return;
    live = false;
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        cleanup();
      } catch {
        // A stale listener must not keep the edit action alive.
      }
    }
  };
  const invalidate = (reason: PluginInlineFormulaInsertionFailureReason) => {
    if (!live || consumed) return;
    invalidReason = reason;
    clean();
  };
  const addCleanup = (cleanup: () => void) => {
    if (live) cleanups.push(cleanup);
    else cleanup();
  };

  const currentFailure = (): PluginInlineFormulaInsertionFailureReason | null => {
    if (!ownerIsCurrent(snapshot.owner, snapshot.ownerGeneration)) return 'owner-ended';
    try {
      if (
        getWorkspaceSessionGeneration() !== snapshot.sessionGeneration ||
        getSession() !== snapshot.session
      ) return 'session-changed';
    } catch {
      return 'session-changed';
    }
    if (snapshot.session.isClosed) return 'session-closed';
    if (getPreferences().readingMode || !editor.isEditable) return 'read-only';
    const currentPeer = pageEditorInsertionPeerFor(editor);
    if (!currentPeer || currentPeer.identity !== snapshot.peer.identity) return 'peer-unavailable';
    if (currentPeer.pane !== snapshot.peer.pane) return 'target-changed';
    if (currentPeer.editableGeneration !== snapshot.peer.editableGeneration) return 'read-only';
    if (!isPageEditorInsertionPeerCurrent(editor, snapshot.peer)) return 'peer-unavailable';
    const navigation = navigationSnapshot();
    if (!navigation || !sameNavigation(snapshot.navigation, navigation)) return 'target-changed';
    if (editor.isDestroyed || !editor.view.dom.isConnected) return 'peer-unavailable';
    if (!editor.state.doc.eq(snapshot.editorDoc)) return 'document-changed';
    if (!editor.state.selection.eq(snapshot.selection)) return 'selection-changed';
    const node = editor.state.doc.nodeAt(snapshot.position);
    if (
      !node || node.type.name !== LEGACY_FORMULA_NODE ||
      node.attrs.raw !== snapshot.raw || node.attrs.fallback !== snapshot.fallback
    ) return 'document-changed';
    const currentSessionDoc = snapshot.session.getState().docs[snapshot.peer.pageId];
    if (
      !currentSessionDoc ||
      (!sameDoc(currentSessionDoc, snapshot.sessionDoc) &&
        !sameDocContent(currentSessionDoc, snapshot.editorDoc.toJSON() as DocNode))
    ) return 'document-changed';
    if (!pageIsWritable(snapshot.session, snapshot.peer.pageId)) return 'read-only';
    if (!canInsertPageEditorTarget(editor, snapshot.peer)) return 'peer-unavailable';
    return null;
  };

  const onTransaction = ({ transaction, appendedTransactions }: EditorEvents['transaction']) => {
    if (transaction.docChanged || appendedTransactions.some((item) => item.docChanged)) {
      invalidate('document-changed');
    } else if (!editor.state.selection.eq(snapshot.selection)) {
      invalidate('selection-changed');
    }
  };
  const onNavigationChanged = () => {
    const navigation = navigationSnapshot();
    if (!navigation || !sameNavigation(snapshot.navigation, navigation)) invalidate('target-changed');
  };
  const onHashChanged = () => onNavigationChanged();
  const onPreferencesChanged = () => {
    if (getPreferences().readingMode) invalidate('read-only');
  };
  const onSessionChanged = () => {
    const current = snapshot.session.getState().docs[snapshot.peer.pageId];
    if (
      !current ||
      (!sameDoc(current, snapshot.sessionDoc) &&
        !sameDocContent(current, snapshot.editorDoc.toJSON() as DocNode))
    ) invalidate('document-changed');
  };

  editor.on('transaction', onTransaction);
  addCleanup(() => editor.off('transaction', onTransaction));
  addCleanup(subscribeTabs(onNavigationChanged));
  window.addEventListener('hashchange', onHashChanged);
  addCleanup(() => window.removeEventListener('hashchange', onHashChanged));
  addCleanup(subscribePreferences(onPreferencesChanged));
  addCleanup(subscribeWorkspaceSession(() => invalidate('session-changed')));
  addCleanup(snapshot.session.subscribeMutationFence(() => {
    if (snapshot.session.isMutationFenced) invalidate('read-only');
  }));
  addCleanup(snapshot.session.subscribe(onSessionChanged));
  addCleanup(snapshot.session.onClose(() => invalidate('session-closed')));
  addCleanup(subscribePageEditorInsertionPeer(editor, snapshot.peer, () => {
    const current = pageEditorInsertionPeerFor(editor);
    if (!current || current.identity !== snapshot.peer.identity) invalidate('peer-unavailable');
    else if (current.pane !== snapshot.peer.pane) invalidate('target-changed');
    else if (current.editableGeneration !== snapshot.peer.editableGeneration) invalidate('read-only');
    else invalidate('peer-unavailable');
  }));

  const fail = (reason: PluginInlineFormulaInsertionFailureReason): PluginInlineFormulaInsertionResult => ({
    ok: false,
    reason,
  });
  const cancel = () => {
    if (consumed) return;
    consumed = true;
    acceptedFocusTarget = null;
    clean();
  };
  const host: PluginInlineFormulaEditHost = Object.freeze({
    initial: snapshot.initial,
    canRestoreFocus() {
      if (consumed || !live || invalidReason) return false;
      const reason = currentFailure();
      if (reason) {
        invalidate(reason);
        return false;
      }
      return true;
    },
    focusAfterEdit() {
      const expected = acceptedFocusTarget;
      acceptedFocusTarget = null;
      if (!expected || !ownerIsCurrent(snapshot.owner, snapshot.ownerGeneration)) return;
      try {
        const navigation = navigationSnapshot();
        if (
          getWorkspaceSessionGeneration() !== snapshot.sessionGeneration ||
          getSession() !== snapshot.session || snapshot.session.isClosed ||
          snapshot.session.isMutationFenced || getPreferences().readingMode || !editor.isEditable ||
          editor.isDestroyed || !editor.view.dom.isConnected ||
          !isPageEditorInsertionPeerCurrent(editor, snapshot.peer) ||
          !navigation || !sameNavigation(snapshot.navigation, navigation) ||
          !pageIsWritable(snapshot.session, snapshot.peer.pageId) ||
          !canInsertPageEditorTarget(editor, snapshot.peer)
        ) return;
        const node = editor.state.doc.nodeAt(snapshot.position);
        if (
          !node || node.type.name !== LEGACY_FORMULA_NODE ||
          node.attrs.raw !== expected.raw || node.attrs.fallback !== expected.fallback
        ) return;
        editor.view.focus();
      } catch {
        // A switched pane/session must never receive focus from this stale form.
      }
    },
    confirm(input: PluginInlineFormulaEditConfirmation) {
      if (consumed) return fail('already-used');
      if (invalidReason) return fail(invalidReason);
      const reason = currentFailure();
      if (reason) {
        invalidate(reason);
        return fail(reason);
      }
      if (
        !input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some((key) => key !== 'formula' && key !== 'name') ||
        typeof input.formula !== 'string' || input.formula.length > 2000 ||
        typeof input.name !== 'string' || input.name.length > 100
      ) return fail('invalid-input');

      if (input.formula === snapshot.initial.formula && input.name === snapshot.initial.name) {
        consumed = true;
        acceptedFocusTarget = { raw: snapshot.raw, fallback: snapshot.fallback };
        clean();
        return { ok: true } as const;
      }

      const updated = updateLegacyFormulaMarker(snapshot.raw, snapshot.fallback, input);
      const node = editor.state.doc.nodeAt(snapshot.position);
      if (!updated || !node || node.type.name !== LEGACY_FORMULA_NODE) {
        consumed = true;
        clean();
        return fail('unsupported-target');
      }
      const nextAttrs = { ...node.attrs, raw: updated.raw, fallback: updated.fallback };
      const transaction = editor.state.tr;
      closeHistory(transaction);
      transaction.setNodeMarkup(snapshot.position, node.type, nextAttrs, node.marks);
      const nextDoc = transaction.doc.toJSON() as DocNode;
      // This update originates in the already validated local PageEditor draft.
      // canSynchronizePageEditorDoc is for external host sync and deliberately
      // rejects a dirty draft; the coordinator's normal transaction path fans
      // this single step to the same captured peers and autosaves with its CAS.
      if (legacyFormulaDocIssue(nextDoc) || !canInsertPageEditorTarget(editor, snapshot.peer)) {
        consumed = true;
        clean();
        return fail('peer-unavailable');
      }

      const token = {};
      transaction.setMeta(EDIT_META, token);
      let accepted = false;
      const onAcceptedTransaction = ({ transaction: acceptedTransaction }: EditorEvents['transaction']) => {
        if (acceptedTransaction.getMeta(EDIT_META) === token && acceptedTransaction.docChanged) accepted = true;
      };
      editor.on('transaction', onAcceptedTransaction);
      consumed = true;
      clean();
      try {
        editor.view.dispatch(transaction);
        if (!accepted || !editor.state.doc.eq(transaction.doc)) return fail('insert-rejected');
        editor.view.dispatch(closeHistory(editor.state.tr));
        acceptedFocusTarget = { raw: updated.raw, fallback: updated.fallback };
        return { ok: true } as const;
      } catch {
        return fail('insert-rejected');
      } finally {
        editor.off('transaction', onAcceptedTransaction);
      }
    },
    cancel,
  });
  return host;
}

function captureSnapshot(
  owner: EditorInsertionOwner,
  editor: Editor,
  position: number,
  raw: string,
  fallback: string,
): EditSnapshot | null {
  try {
    if (!editor || editor.isDestroyed || !editor.view.dom.isConnected || !ownerIsCurrent(owner, owner.generation)) return null;
    const session = getSession();
    const peer = pageEditorInsertionPeerFor(editor);
    const navigation = navigationSnapshot();
    const sessionGeneration = getWorkspaceSessionGeneration();
    const sessionDoc = session.getState().docs[peer?.pageId ?? ''];
    const editorDoc = editor.state.doc;
    const selection = editor.state.selection;
    if (
      !peer || peer.session !== session || !navigation || !paneMatches(navigation.pane, peer.pane) ||
      navigation.pageId !== peer.pageId || !sessionDoc || getPreferences().readingMode || !editor.isEditable ||
      session.isClosed || session.isMutationFenced || !pageIsWritable(session, peer.pageId) ||
      !canInsertPageEditorTarget(editor, peer)
    ) return null;
    const node = editorDoc.nodeAt(position);
    const resolved = editorDoc.resolve(position);
    const editable = parseEditableLegacyFormula(raw, fallback);
    if (
      !node || node.type.name !== LEGACY_FORMULA_NODE || node.attrs.raw !== raw || node.attrs.fallback !== fallback ||
      !editable || editable.pageId !== peer.pageId || resolved.depth !== 1 ||
      resolved.parent.type.name !== 'paragraph' || resolved.node(0).type.name !== 'doc' ||
      legacyFormulaDocIssue(editor.getJSON()) !== null
    ) return null;
    return {
      owner,
      ownerGeneration: owner.generation,
      editor,
      position,
      raw,
      fallback,
      initial: Object.freeze({
        formula: editable.formula,
        name: editable.name,
        outputType: editable.outputType,
        format: Object.freeze({ ...editable.format }),
      }),
      peer,
      navigation,
      session,
      sessionGeneration,
      sessionDoc,
      editorDoc,
      selection,
    };
  } catch {
    return null;
  }
}

function pageIsWritable(session: ReturnType<typeof getSession>, pageId: string): boolean {
  const state = session.getState();
  const page = state.pages[pageId];
  return Boolean(
    page && state.docs[pageId] && !session.isClosed && !session.isMutationFenced && !page.encrypted &&
    !session.unreadable.has(pageId) && !session.protectedReasons.has(pageId) &&
    !isEffectivelyTrashed(state.pages, pageId),
  );
}

function ownerIsCurrent(owner: EditorInsertionOwner, generation: number): boolean {
  try {
    return owner.generation === generation && owner.isActive();
  } catch {
    return false;
  }
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
  return first.activeTab === second.activeTab && first.pane === second.pane &&
    first.hash === second.hash && first.pageId === second.pageId;
}

function paneMatches(first: string, second: string): boolean {
  if (first === second) return true;
  if (first === 'main') return isPrimaryPane(second);
  if (first === 'side') return isSidePane(second);
  if (second === 'main') return isPrimaryPane(first);
  if (second === 'side') return isSidePane(first);
  return false;
}

function sameDoc(first: DocNode, second: DocNode): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
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
