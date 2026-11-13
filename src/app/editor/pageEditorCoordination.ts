import { Extension } from '@tiptap/core';
import type { AnyExtension, Editor, EditorEvents } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';
import { Step } from '@tiptap/pm/transform';
import type { DocNode, PageId } from '../../core/model';
import { isEffectivelyTrashed } from '../../core/tree';
import type { WorkspaceSession } from '../../storage/session';
import type { PaneId } from '../tabs';
import { registerCommit } from './commits';
import { toast } from '../ui';

const HOST_SYNC = 'morrowPageEditorHostSync';
const entries = new WeakMap<WorkspaceSession, Map<PageId, Entry>>();
const peersByEditor = new WeakMap<Editor, Peer>();

type ConflictKind = 'external' | 'peer-sync' | 'external-clean-sync' | 'unrepresentable';

interface Entry {
  session: WorkspaceSession;
  pageId: PageId;
  baselineSessionDoc: DocNode;
  baselinePMDoc: DocNode | null;
  draftPMDoc: DocNode;
  observedSessionDoc: DocNode;
  projected: boolean;
  dirty: boolean;
  conflict: ConflictKind | null;
  error: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  timerOwner: Peer | null;
  peers: Set<Peer>;
  preservedPeerDrafts: DocNode[];
  owner: Peer | null;
  commitInProgress: boolean;
  commitAuthorized: boolean;
  pendingCommitDoc: DocNode | null;
  pendingAckDoc: DocNode | null;
  unregisterCommit: (() => void) | null;
  unsubscribeSession: (() => void) | null;
  unsubscribeClose: (() => void) | null;
  commit: () => boolean;
}

interface Peer {
  entry: Entry;
  editor: Editor | null;
  pane: PaneId;
  editable: boolean;
  editableGeneration: number;
  ready: boolean;
  disposed: boolean;
  insertionListeners: Set<() => void>;
  hostSyncDepth: number;
  pendingRoot: Transaction | null;
  pendingExpected: DocNode | null;
  onDirty: (dirty: boolean) => void;
}

/** Private host identity used by the plugin insertion capture; it never crosses the plugin API. */
export interface PageEditorInsertionPeer {
  readonly identity: object;
  readonly session: WorkspaceSession;
  readonly pageId: PageId;
  readonly pane: PaneId;
  readonly editableGeneration: number;
}

export function pageEditorInsertionPeerFor(editor: Editor): PageEditorInsertionPeer | null {
  const peer = peersByEditor.get(editor);
  if (!peer || peer.disposed || peer.editor !== editor) return null;
  return {
    identity: peer,
    session: peer.entry.session,
    pageId: peer.entry.pageId,
    pane: peer.pane,
    editableGeneration: peer.editableGeneration,
  };
}

export function isPageEditorInsertionPeerCurrent(editor: Editor, expected: PageEditorInsertionPeer): boolean {
  const peer = peersByEditor.get(editor);
  return Boolean(
    peer &&
    peer === expected.identity &&
    peer.editor === editor &&
    !peer.disposed &&
    peer.entry.session === expected.session &&
    peer.entry.pageId === expected.pageId &&
    peer.pane === expected.pane &&
    peer.editableGeneration === expected.editableGeneration,
  );
}

export function canInsertPageEditorTarget(editor: Editor, expected: PageEditorInsertionPeer): boolean {
  const peer = peersByEditor.get(editor);
  if (
    !peer ||
    !isPageEditorInsertionPeerCurrent(editor, expected) ||
    !peer.ready ||
    !peer.editable ||
    peer.disposed ||
    !editor.isEditable ||
    editor.isDestroyed ||
    peer.entry.session.isClosed
  )
    return false;

  const entry = peer.entry;
  if (entry.conflict || entry.error || entry.commitInProgress || !entry.projected || !entry.draftPMDoc)
    return false;
  const state = entry.session.getState();
  const page = state.pages[entry.pageId];
  const current = state.docs[entry.pageId];
  if (
    !page ||
    page.encrypted ||
    isEffectivelyTrashed(state.pages, entry.pageId) ||
    entry.session.unreadable.has(entry.pageId) ||
    entry.session.protectedReasons.has(entry.pageId) ||
    !current ||
    !samePageContent(current, entry.baselineSessionDoc) ||
    !samePageContent(current, entry.observedSessionDoc) ||
    !jsonEqual(editor.getJSON(), entry.draftPMDoc)
  )
    return false;

  return [...entry.peers].every((item) => {
    if (!item.ready || item.disposed) return true;
    return Boolean(
      item.editor && !item.editor.isDestroyed && jsonEqual(item.editor.getJSON(), entry.draftPMDoc),
    );
  });
}

export function subscribePageEditorInsertionPeer(
  editor: Editor,
  expected: PageEditorInsertionPeer,
  listener: () => void,
): () => void {
  const peer = peersByEditor.get(editor);
  if (!peer || peer !== expected.identity || peer.disposed) return () => {};
  peer.insertionListeners.add(listener);
  return () => peer.insertionListeners.delete(listener);
}

export interface PageEditorCoordinator {
  extension: AnyExtension;
  attach(editor: Editor): void;
  ready(): void;
  content(): DocNode;
  handleUpdate(update: EditorEvents['update']): void;
  observeSessionDoc(doc: DocNode): void;
  setEditable(editable: boolean): void;
  setPane(pane: PaneId): void;
  commit(): boolean;
  dispose(): void;
}

function jsonEqual(first: unknown, second: unknown): boolean {
  if (Object.is(first, second)) return true;
  if (Array.isArray(first) || Array.isArray(second)) {
    return (
      Array.isArray(first) &&
      Array.isArray(second) &&
      first.length === second.length &&
      first.every((value, index) => jsonEqual(value, second[index]))
    );
  }
  if (first && second && typeof first === 'object' && typeof second === 'object') {
    const firstKeys = Object.keys(first).sort();
    const secondKeys = Object.keys(second).sort();
    return (
      firstKeys.length === secondKeys.length &&
      firstKeys.every(
        (key, index) => key === secondKeys[index] && jsonEqual((first as Record<string, unknown>)[key], (second as Record<string, unknown>)[key]),
      )
    );
  }
  return false;
}

function withoutTrailingEmpty(doc: DocNode): DocNode {
  const content = [...(doc.content ?? [])];
  while (content.length > 0) {
    const last = content[content.length - 1]!;
    if (last.type !== 'paragraph' || (last.content?.length ?? 0) > 0) break;
    content.pop();
  }
  return { ...doc, content };
}

function samePageContent(first: DocNode, second: DocNode): boolean {
  return jsonEqual(withoutTrailingEmpty(first), withoutTrailingEmpty(second));
}

function trailingEmptyParagraphs(doc: DocNode): DocNode[] {
  const content = doc.content ?? [];
  let count = 0;
  for (let index = content.length - 1; index >= 0; index--) {
    const node = content[index]!;
    if (node.type !== 'paragraph' || (node.content?.length ?? 0) > 0) break;
    count += 1;
  }
  return content.slice(content.length - count);
}

function preserveTrailingEmptyParagraphs(projected: DocNode, current: DocNode): DocNode {
  const projectedPads = trailingEmptyParagraphs(projected);
  const currentPads = trailingEmptyParagraphs(current);
  if (currentPads.length <= projectedPads.length) return projected;
  return {
    ...projected,
    content: [...(projected.content ?? []), ...currentPads.slice(projectedPads.length)],
  };
}

function projectDoc(editor: Editor, doc: DocNode): DocNode {
  return editor.schema.nodeFromJSON(doc).toJSON() as DocNode;
}

function projectHostSyncDoc(editor: Editor, doc: DocNode): DocNode {
  return preserveTrailingEmptyParagraphs(projectDoc(editor, doc), editor.getJSON() as DocNode);
}

interface NodeAttributeChange {
  position: number;
  target: ProseNode;
}

function collectAttributeChanges(
  current: ProseNode,
  target: ProseNode,
  position: number,
  changes: NodeAttributeChange[],
): boolean {
  if (current.type !== target.type || current.childCount !== target.childCount) return false;
  if (current.isText || target.isText) return current.eq(target);
  if (!jsonEqual(current.marks.map((mark) => mark.toJSON()), target.marks.map((mark) => mark.toJSON())))
    return false;

  if (!jsonEqual(current.attrs, target.attrs)) changes.push({ position, target });
  let offset = 0;
  for (let index = 0; index < current.childCount; index++) {
    const child = current.child(index);
    if (!collectAttributeChanges(child, target.child(index), position + 1 + offset, changes)) return false;
    offset += child.nodeSize;
  }
  return true;
}

function attributeOnlyTransaction(editor: Editor, target: ProseNode): Transaction | null {
  const changes: NodeAttributeChange[] = [];
  if (!collectAttributeChanges(editor.state.doc, target, -1, changes) || changes.length === 0) return null;
  const transaction = editor.state.tr;
  for (const change of changes) {
    transaction.setNodeMarkup(change.position, change.target.type, change.target.attrs, change.target.marks);
  }
  return jsonEqual(transaction.doc.toJSON(), target.toJSON()) ? transaction : null;
}

function preflightHostSync(peer: Peer, transaction: Transaction, expectedDoc: DocNode): void {
  const editor = peer.editor;
  if (!editor || editor.isDestroyed) throw new Error('An open page editor closed before its changes could be shared.');
  const pendingRoot = peer.pendingRoot;
  const pendingExpected = peer.pendingExpected;
  peer.hostSyncDepth++;
  try {
    const simulation = editor.state.applyTransaction(transaction);
    if (!jsonEqual(simulation.state.doc.toJSON(), expectedDoc)) {
      throw new Error('The page could not be synchronized across all open views.');
    }
  } finally {
    peer.hostSyncDepth--;
    peer.pendingRoot = pendingRoot;
    peer.pendingExpected = pendingExpected;
  }
}

function prepareHostSync(peer: Peer, target: DocNode): Transaction | null {
  const editor = peer.editor;
  if (!editor || editor.isDestroyed) throw new Error('An open page editor closed before its changes could be shared.');
  const current = editor.state.doc;
  const targetNode = editor.schema.nodeFromJSON(target);
  let transaction = attributeOnlyTransaction(editor, targetNode);
  if (!transaction) {
    const start = current.content.findDiffStart(targetNode.content);
    if (start === null) return null;
    const end = current.content.findDiffEnd(targetNode.content);
    if (!end) throw new Error('The page change could not be applied to all open views.');
    const overlap = start - Math.min(end.a, end.b);
    const endA = end.a + Math.max(0, overlap);
    const endB = end.b + Math.max(0, overlap);
    transaction = editor.state.tr.replace(start, endA, targetNode.slice(start, endB));
  }
  if (!jsonEqual(transaction.doc.toJSON(), target)) {
    throw new Error('The page change could not be applied safely to all open views.');
  }
  transaction.setMeta('addToHistory', false).setMeta(HOST_SYNC, true);
  preflightHostSync(peer, transaction, target);
  return transaction;
}

/** Checks that every ready peer can accept a host document without applying it. */
export function canSynchronizePageEditorDoc(
  session: WorkspaceSession,
  pageId: PageId,
  currentDoc: DocNode,
  nextDoc: DocNode,
): boolean {
  if (session.isClosed || session.getState().docs[pageId] !== currentDoc) return false;
  const entry = entries.get(session)?.get(pageId);
  if (!entry) return true;
  if (!isPageEditorDocumentSynchronized(session, pageId)) return false;
  const livePeers = [...entry.peers].filter(
    (peer) => peer.ready && peer.editor && !peer.editor.isDestroyed,
  );
  try {
    const targetByPeer = livePeers.map((peer) => ({ peer, target: projectHostSyncDoc(peer.editor!, nextDoc) }));
    const firstTarget = targetByPeer[0]?.target;
    if (firstTarget && targetByPeer.some(({ target }) => !jsonEqual(target, firstTarget))) return false;
    for (const { peer, target } of targetByPeer) prepareHostSync(peer, target);
    return true;
  } catch {
    return false;
  }
}

/** Returns whether the coordinator and all ready editors reflect the session's current page. */
export function isPageEditorDocumentSynchronized(session: WorkspaceSession, pageId: PageId): boolean {
  if (session.isClosed) return false;
  const entry = entries.get(session)?.get(pageId);
  if (!entry) return true;
  const current = session.getState().docs[pageId];
  if (
    !current ||
    entry.dirty ||
    entry.conflict ||
    entry.error ||
    entry.commitInProgress ||
    !entry.projected ||
    !jsonEqual(current, entry.baselineSessionDoc) ||
    !jsonEqual(current, entry.observedSessionDoc)
  ) return false;
  return [...entry.peers].every((peer) => {
    if (!peer.ready || !peer.editor || peer.editor.isDestroyed) return true;
    return jsonEqual(peer.editor.getJSON(), entry.draftPMDoc);
  });
}

function clearTimer(entry: Entry): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  entry.timerOwner = null;
}

function notifyDirty(entry: Entry): void {
  for (const peer of entry.peers) peer.onDirty(entry.dirty);
}

function reportError(entry: Entry, message: string, conflict: ConflictKind | null = null): void {
  if (conflict) entry.conflict = conflict;
  const changed = entry.error !== message;
  entry.error = message;
  clearTimer(entry);
  if (changed) toast(message, { tone: 'error' });
}

function removeEntry(entry: Entry): void {
  entry.unregisterCommit?.();
  entry.unregisterCommit = null;
  entry.unsubscribeSession?.();
  entry.unsubscribeSession = null;
  entry.unsubscribeClose?.();
  entry.unsubscribeClose = null;
  const byPage = entries.get(entry.session);
  byPage?.delete(entry.pageId);
  if (byPage?.size === 0) entries.delete(entry.session);
}

function preservePeerDrafts(entry: Entry): void {
  entry.preservedPeerDrafts = [...entry.peers]
    .filter((peer) => peer.editor && !peer.editor.isDestroyed)
    .map((peer) => peer.editor!.getJSON() as DocNode);
}

function setClean(entry: Entry, rawDoc: DocNode, projectedDoc: DocNode, notify = true): void {
  clearTimer(entry);
  entry.baselineSessionDoc = rawDoc;
  entry.observedSessionDoc = rawDoc;
  entry.baselinePMDoc = projectedDoc;
  entry.draftPMDoc = projectedDoc;
  entry.projected = true;
  entry.dirty = false;
  entry.conflict = null;
  entry.error = null;
  entry.owner = null;
  entry.commitAuthorized = false;
  entry.preservedPeerDrafts = [];
  if (notify) notifyDirty(entry);
}

function scheduleCommit(entry: Entry, owner: Peer): void {
  clearTimer(entry);
  if (
    !entry.dirty ||
    entry.conflict ||
    entry.session.isClosed ||
    ![...entry.peers].some((peer) => peer.ready && peer.editable)
  )
    return;
  entry.timerOwner = owner;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    const timerOwner = entry.timerOwner;
    entry.timerOwner = null;
    if (!timerOwner || timerOwner.disposed) {
      const writable = [...entry.peers].find((peer) => peer.ready && peer.editable);
      if (!writable) return;
    }
    commitEntry(entry);
  }, 250);
}

function updateFromSession(entry: Entry, doc: DocNode | undefined): void {
  if (!doc) {
    if (entry.dirty) {
      reportError(entry, 'This page is no longer available. The editor draft is being kept.', 'external');
      notifyDirty(entry);
    }
    return;
  }

  if (entry.commitInProgress && entry.pendingCommitDoc && jsonEqual(doc, entry.pendingCommitDoc)) {
    entry.pendingAckDoc = doc;
    entry.observedSessionDoc = doc;
    return;
  }

  if (jsonEqual(doc, entry.baselineSessionDoc) && entry.conflict !== 'external-clean-sync') {
    entry.observedSessionDoc = doc;
    if (entry.conflict === 'external') {
      entry.conflict = null;
      entry.error = null;
      const owner = entry.owner ?? [...entry.peers].find((peer) => peer.ready && peer.editable) ?? null;
      if (entry.dirty && entry.commitAuthorized && owner) scheduleCommit(entry, owner);
    }
    return;
  }

  if (entry.dirty) {
    if (jsonEqual(doc, entry.observedSessionDoc) && entry.conflict === 'external') return;
    entry.observedSessionDoc = doc;
    reportError(
      entry,
      'The page changed outside this editor. Its draft is kept, and autosave stopped to avoid overwriting the newer page.',
      'external',
    );
    notifyDirty(entry);
    return;
  }

  if (entry.conflict === 'peer-sync' || entry.conflict === 'unrepresentable') {
    entry.observedSessionDoc = doc;
    return;
  }
  if (entry.conflict !== 'external-clean-sync' && jsonEqual(doc, entry.observedSessionDoc)) return;

  const livePeers = [...entry.peers].filter(
    (peer) => peer.ready && peer.editor && !peer.editor.isDestroyed,
  );
  if (livePeers.length === 0) {
    entry.baselineSessionDoc = doc;
    entry.observedSessionDoc = doc;
    entry.baselinePMDoc = null;
    entry.draftPMDoc = doc;
    entry.projected = false;
    entry.conflict = null;
    entry.error = null;
    entry.preservedPeerDrafts = [];
    return;
  }

  try {
    const targetByPeer = livePeers.map((peer) => ({ peer, target: projectHostSyncDoc(peer.editor!, doc) }));
    const firstTarget = targetByPeer[0]!.target;
    if (targetByPeer.some(({ target }) => !jsonEqual(target, firstTarget))) {
      throw new Error('The page could not be loaded consistently in all open views.');
    }

    const prepared: Array<{ peer: Peer; transaction: Transaction }> = [];
    for (const { peer, target } of targetByPeer) {
      const editor = peer.editor!;
      const current = editor.state.doc;
      const targetNode = editor.schema.nodeFromJSON(target);
      let transaction = attributeOnlyTransaction(editor, targetNode);
      if (!transaction) {
        const start = current.content.findDiffStart(targetNode.content);
        if (start === null) continue;
        const end = current.content.findDiffEnd(targetNode.content);
        if (!end) throw new Error('The page change could not be applied to all open views.');
        const overlap = start - Math.min(end.a, end.b);
        const endA = end.a + Math.max(0, overlap);
        const endB = end.b + Math.max(0, overlap);
        transaction = editor.state.tr.replace(start, endA, targetNode.slice(start, endB));
      }
      if (!jsonEqual(transaction.doc.toJSON(), target)) {
        throw new Error('The page change could not be applied safely to all open views.');
      }
      transaction.setMeta('addToHistory', false).setMeta(HOST_SYNC, true);
      preflightHostSync(peer, transaction, target);
      prepared.push({ peer, transaction });
    }

    setClean(entry, doc, firstTarget, false);
    for (const { peer, transaction } of prepared) {
      peer.hostSyncDepth++;
      try {
        peer.editor!.view.dispatch(transaction);
        if (!jsonEqual(peer.editor!.state.doc.toJSON(), firstTarget)) {
          throw new Error('An editor changed the page during synchronization.');
        }
      } finally {
        peer.hostSyncDepth--;
      }
    }
    notifyDirty(entry);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    entry.baselineSessionDoc = doc;
    entry.observedSessionDoc = doc;
    entry.baselinePMDoc = null;
    entry.draftPMDoc = doc;
    entry.projected = false;
    entry.conflict = 'external-clean-sync';
    reportError(entry, `${message} The editor kept its current content and blocked writes.`, 'external-clean-sync');
    notifyDirty(entry);
  }
}

function buildFanoutTransaction(peer: Peer, stepJSON: unknown[], targetDoc: DocNode): Transaction {
  const editor = peer.editor;
  if (!editor || editor.isDestroyed) throw new Error('An open page editor closed before its changes could be shared.');
  const transaction = editor.state.tr;
  for (const serialized of stepJSON) transaction.step(Step.fromJSON(editor.schema, serialized));
  if (!jsonEqual(transaction.doc.toJSON(), targetDoc)) {
    throw new Error('The page draft could not be applied to all open views.');
  }
  transaction.setMeta('addToHistory', false).setMeta(HOST_SYNC, true);
  preflightHostSync(peer, transaction, targetDoc);
  return transaction;
}

function collectLocalSteps(peer: Peer, update: EditorEvents['update'], initial: DocNode): {
  steps: unknown[];
  finalDoc: DocNode;
} {
  let expected = initial;
  const steps: unknown[] = [];
  for (const transaction of [update.transaction, ...update.appendedTransactions]) {
    if (!jsonEqual(transaction.before.toJSON(), expected)) {
      throw new Error('The page editor is behind the latest draft.');
    }
    if (!transaction.docChanged) continue;
    for (const step of transaction.steps) steps.push(step.toJSON());
    expected = transaction.doc.toJSON() as DocNode;
  }
  const editorDoc = peer.editor?.state.doc.toJSON() as DocNode | undefined;
  if (!editorDoc || !jsonEqual(expected, editorDoc)) {
      throw new Error('The page update could not be matched across open views.');
  }
  return { steps, finalDoc: expected };
}

function failLocalSync(entry: Entry, peer: Peer, finalDoc: DocNode, message: string): void {
  preservePeerDrafts(entry);
  entry.draftPMDoc = finalDoc;
  entry.dirty = !entry.baselinePMDoc || !samePageContent(entry.baselinePMDoc, finalDoc);
  entry.owner = peer;
  entry.commitAuthorized = peer.editable && !entry.session.isClosed;
  reportError(entry, `${message} Drafts are kept in the open editors; autosave stopped.`, 'peer-sync');
  notifyDirty(entry);
}

function handleUpdate(entry: Entry, peer: Peer, update: EditorEvents['update']): void {
  if (update.transaction.getMeta(HOST_SYNC) || peer.hostSyncDepth > 0 || !peer.ready) return;
  if (entry.conflict === 'external-clean-sync' || entry.conflict === 'peer-sync' || entry.conflict === 'unrepresentable') {
    return;
  }
  const initial = entry.draftPMDoc;
  let local: { steps: unknown[]; finalDoc: DocNode };
  try {
    if (!initial) throw new Error('The editor page has not been normalized safely.');
    local = collectLocalSteps(peer, update, initial);
  } catch (error) {
    const doc = (peer.editor?.getJSON() ?? initial) as DocNode;
    failLocalSync(entry, peer, doc, error instanceof Error ? error.message : String(error));
    return;
  }

  const prepared: Array<{ peer: Peer; transaction: Transaction }> = [];
  try {
    for (const other of entry.peers) {
      if (other === peer || !other.ready || !other.editor || other.editor.isDestroyed) continue;
      if (!jsonEqual(other.editor.state.doc.toJSON(), initial)) {
        throw new Error('Another open view has a different page draft.');
      }
      prepared.push({
        peer: other,
        transaction: buildFanoutTransaction(other, local.steps, local.finalDoc),
      });
    }
  } catch (error) {
    failLocalSync(entry, peer, local.finalDoc, error instanceof Error ? error.message : String(error));
    return;
  }

  for (const { peer: other, transaction } of prepared) {
    other.hostSyncDepth++;
    try {
      other.editor!.view.dispatch(transaction);
      if (!jsonEqual(other.editor!.state.doc.toJSON(), local.finalDoc)) {
        failLocalSync(
          entry,
          peer,
          local.finalDoc,
          'The page changed differently in another open view.',
        );
        return;
      }
    } finally {
      other.hostSyncDepth--;
    }
  }

  entry.draftPMDoc = local.finalDoc;
  entry.owner = peer;
  entry.dirty = !entry.baselinePMDoc || !samePageContent(entry.baselinePMDoc, local.finalDoc);
  entry.commitAuthorized = peer.editable && !entry.session.isClosed;
  entry.error = entry.conflict ? entry.error : null;
  if (entry.dirty && !entry.conflict) scheduleCommit(entry, peer);
  else clearTimer(entry);
  notifyDirty(entry);
}

function finishCommit(entry: Entry, doc: DocNode, committedDraft: DocNode): boolean {
  entry.commitInProgress = false;
  entry.pendingCommitDoc = null;
  entry.pendingAckDoc = null;
  entry.baselineSessionDoc = doc;
  const currentSessionDoc = entry.session.getState().docs[entry.pageId];
  entry.observedSessionDoc = currentSessionDoc ?? doc;
  entry.baselinePMDoc = committedDraft;
  entry.projected = true;
  if (!currentSessionDoc || !jsonEqual(currentSessionDoc, doc)) {
    entry.dirty = true;
    reportError(
      entry,
      'The page changed again while the editor was saving. Its draft is kept and autosave stopped.',
      'external',
    );
    notifyDirty(entry);
    return false;
  }
  if (entry.conflict) {
    // The synchronous session listener may have found a new conflict while the save ran.
    // Keep that decision and the newer draft instead of treating the save echo as clean.
    entry.dirty = true;
    notifyDirty(entry);
    return false;
  }
  entry.conflict = null;
  entry.error = null;
  if (samePageContent(committedDraft, entry.draftPMDoc)) {
    setClean(entry, doc, committedDraft);
    return !entry.dirty && !entry.conflict && !entry.error;
  }
  entry.dirty = true;
  entry.commitAuthorized = entry.commitAuthorized || [...entry.peers].some((peer) => peer.ready && peer.editable);
  const owner = entry.owner ?? [...entry.peers].find((peer) => peer.ready && peer.editable) ?? null;
  if (owner && entry.commitAuthorized) scheduleCommit(entry, owner);
  else clearTimer(entry);
  notifyDirty(entry);
  return false;
}

function commitEntry(entry: Entry): boolean {
  if (!entry.dirty) return !entry.error;
  if (entry.commitInProgress) return false;
  if (entry.session.isClosed) {
    reportError(entry, 'The workspace session is closed. The editor draft is being kept.');
    return false;
  }
  if (entry.conflict && entry.conflict !== 'external') return false;
  const current = entry.session.getState().docs[entry.pageId];
  if (!current || !jsonEqual(current, entry.baselineSessionDoc)) {
    entry.observedSessionDoc = current ?? entry.observedSessionDoc;
    reportError(
      entry,
      'The page changed outside this editor. Its draft is kept, and autosave stopped to avoid overwriting the newer page.',
      'external',
    );
    return false;
  }
  if (entry.conflict === 'external') {
    entry.conflict = null;
    entry.error = null;
  }
  if (!entry.commitAuthorized && ![...entry.peers].some((peer) => peer.ready && peer.editable)) {
    reportError(entry, 'The editor is read-only. Its draft is being kept until editing is available.');
    return false;
  }

  if (!entry.baselinePMDoc || samePageContent(entry.baselinePMDoc, entry.draftPMDoc)) {
    setClean(entry, current, entry.draftPMDoc);
    return !entry.dirty && !entry.conflict && !entry.error;
  }

  const doc = entry.draftPMDoc;
  entry.pendingAckDoc = null;
  entry.commitInProgress = true;
  entry.pendingCommitDoc = doc;
  let result: ReturnType<WorkspaceSession['execute']>;
  try {
    result = entry.session.execute({ type: 'page.setDoc', id: entry.pageId, doc, now: Date.now() });
  } catch (error) {
    entry.commitInProgress = false;
    entry.pendingCommitDoc = null;
    entry.pendingAckDoc = null;
    reportError(entry, error instanceof Error ? error.message : String(error));
    notifyDirty(entry);
    return false;
  }
  if (!result.ok) {
    entry.commitInProgress = false;
    entry.pendingCommitDoc = null;
    entry.pendingAckDoc = null;
    reportError(entry, result.error);
    notifyDirty(entry);
    return false;
  }

  const saved = result.value.docs[entry.pageId];
  if (!saved) {
    entry.commitInProgress = false;
    entry.pendingCommitDoc = null;
    entry.pendingAckDoc = null;
    reportError(entry, 'The page save was accepted without a saved document. The editor draft is being kept.');
    return false;
  }
  return finishCommit(entry, saved, doc);
}

/** Drains a page's shared editor draft for host operations such as closing its view. */
export function commitPageEditorDraft(session: WorkspaceSession, pageId: PageId): boolean {
  if (session.isClosed) return false;
  const entry = entries.get(session)?.get(pageId);
  if (!entry) return true;
  return commitEntry(entry);
}

function getEntry(session: WorkspaceSession, pageId: PageId, initialDoc: DocNode): Entry {
  let byPage = entries.get(session);
  if (!byPage) {
    byPage = new Map();
    entries.set(session, byPage);
  }
  let entry = byPage.get(pageId);
  const currentDoc = session.getState().docs[pageId] ?? initialDoc;
  if (!entry) {
    entry = {
      session,
      pageId,
      baselineSessionDoc: currentDoc,
      baselinePMDoc: null,
      draftPMDoc: currentDoc,
      observedSessionDoc: currentDoc,
      projected: false,
      dirty: false,
      conflict: null,
      error: null,
      timer: null,
      timerOwner: null,
      peers: new Set(),
      preservedPeerDrafts: [],
      owner: null,
      commitInProgress: false,
      commitAuthorized: false,
      pendingCommitDoc: null,
      pendingAckDoc: null,
      unregisterCommit: null,
      unsubscribeSession: null,
      unsubscribeClose: null,
      commit: () => false,
    };
    entry.commit = () => commitEntry(entry!);
    byPage.set(pageId, entry);
    entry.unsubscribeSession = session.subscribe(() => updateFromSession(entry!, session.getState().docs[pageId]));
    entry.unsubscribeClose = session.onClose(() => {
      clearTimer(entry!);
      entry!.unsubscribeSession?.();
      entry!.unsubscribeSession = null;
      entry!.unregisterCommit?.();
      entry!.unregisterCommit = null;
      entry!.commitAuthorized = false;
      entry!.unsubscribeClose = null;
      for (const peer of entry!.peers) {
        peer.editable = false;
        peer.editor?.setEditable(false, false);
      }
      entry!.error = 'The workspace session is closed. The editor draft remains isolated from new sessions.';
    });
  } else if (entry.peers.size === 0 && !entry.dirty && !session.isClosed) {
    entry.baselineSessionDoc = currentDoc;
    entry.observedSessionDoc = currentDoc;
    entry.baselinePMDoc = null;
    entry.draftPMDoc = currentDoc;
    entry.projected = false;
    entry.conflict = null;
    entry.error = null;
  } else if (entry.dirty && !jsonEqual(currentDoc, entry.baselineSessionDoc)) {
    entry.observedSessionDoc = currentDoc;
    reportError(
      entry,
      'The page changed outside this editor. Its draft is kept, and autosave stopped to avoid overwriting the newer page.',
      'external',
    );
  }
  return entry;
}

export function registerPageEditorCoordinator(
  session: WorkspaceSession,
  pageId: PageId,
  initialDoc: DocNode,
  editable: boolean,
  onDirty: (dirty: boolean) => void,
  pane: PaneId = 'main',
): PageEditorCoordinator {
  const entry = getEntry(session, pageId, initialDoc);
  const peer: Peer = {
    entry,
    editor: null,
    pane,
    editable: editable && !session.isClosed,
    editableGeneration: 0,
    ready: false,
    disposed: false,
    insertionListeners: new Set(),
    hostSyncDepth: 0,
    pendingRoot: null,
    pendingExpected: null,
    onDirty,
  };
  entry.peers.add(peer);
  if (!session.isClosed && !entry.unregisterCommit) {
    entry.unregisterCommit = registerCommit(entry.commit);
  }
  if (entry.dirty) onDirty(true);

  const extension = Extension.create({
    name: 'morrowPageEditorCoordinator',
    priority: 1000,
    dispatchTransaction({ transaction, next }) {
      if (!peer.ready || peer.disposed || peer.hostSyncDepth > 0 || transaction.getMeta(HOST_SYNC)) {
        next(transaction);
        return;
      }
      if (!transaction.docChanged) {
        next(transaction);
        return;
      }
      if (session.isClosed) {
        reportError(entry, 'The workspace session is closed. The editor draft is being kept.');
        return;
      }
      if (!peer.editable) {
        reportError(entry, 'This page is read-only. Its current draft is being kept.');
        return;
      }
      if (
        entry.conflict === 'external' ||
        entry.conflict === 'external-clean-sync' ||
        entry.conflict === 'peer-sync' ||
        entry.conflict === 'unrepresentable'
      ) {
        return;
      }
      if (!entry.draftPMDoc || !jsonEqual(transaction.before.toJSON(), entry.draftPMDoc)) {
        reportError(entry, 'This page editor is behind the latest draft. The change was refused and the draft was kept.', 'peer-sync');
        return;
      }

      const previousRoot = peer.pendingRoot;
      const previousExpected = peer.pendingExpected;
      peer.pendingRoot = transaction;
      peer.pendingExpected = transaction.doc.toJSON() as DocNode;
      try {
        next(transaction);
      } finally {
        peer.pendingRoot = previousRoot;
        peer.pendingExpected = previousExpected;
      }
    },
    addProseMirrorPlugins() {
      return [
        new Plugin({
          filterTransaction: (transaction) => {
            if (!peer.ready || peer.disposed) return true;
            if (peer.hostSyncDepth > 0 || transaction.getMeta(HOST_SYNC)) return true;
            if (!transaction.docChanged) return true;
            if (session.isClosed) {
              reportError(entry, 'The workspace session is closed. The editor draft is being kept.');
              return false;
            }
            if (!peer.editable) {
              reportError(entry, 'This page is read-only. Its current draft is being kept.');
              return false;
            }
            if (
              entry.conflict === 'external' ||
              entry.conflict === 'external-clean-sync' ||
              entry.conflict === 'peer-sync' ||
              entry.conflict === 'unrepresentable'
            ) return false;

            if (peer.pendingRoot && peer.pendingRoot !== transaction) {
              if (!peer.pendingExpected) return false;
              if (!jsonEqual(transaction.before.toJSON(), peer.pendingExpected)) {
                reportError(entry, 'A block update could not be synchronized; the draft was kept.', 'peer-sync');
                return false;
              }
              peer.pendingExpected = transaction.doc.toJSON() as DocNode;
              return true;
            }

            if (peer.pendingRoot === transaction) return true;

            if (!entry.draftPMDoc || !jsonEqual(transaction.before.toJSON(), entry.draftPMDoc)) {
              reportError(entry, 'This page editor is behind the latest draft. The change was refused and the draft was kept.', 'peer-sync');
              return false;
            }
            return true;
          },
        }),
      ];
    },
  });

  return {
    extension,
    attach(editor) {
      peer.editor = editor;
      peersByEditor.set(editor, peer);
      try {
        if (!entry.projected || !entry.baselinePMDoc) {
          entry.baselinePMDoc = projectDoc(editor, entry.baselineSessionDoc);
          entry.draftPMDoc = entry.dirty ? projectDoc(editor, entry.draftPMDoc) : entry.baselinePMDoc;
          entry.projected = true;
        } else {
          entry.baselinePMDoc = projectDoc(editor, entry.baselinePMDoc);
          entry.draftPMDoc = projectDoc(editor, entry.draftPMDoc);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        entry.projected = false;
        entry.conflict = 'unrepresentable';
        reportError(entry, `This page cannot be represented safely in the editor (${message}). Writes are blocked.`, 'unrepresentable');
      }
    },
    ready() {
      peer.ready = true;
      if (entry.dirty) peer.onDirty(true);
    },
    content() {
      return entry.draftPMDoc;
    },
    handleUpdate(update) {
      handleUpdate(entry, peer, update);
    },
    observeSessionDoc(doc) {
      const current = session.getState().docs[pageId];
      if (current && jsonEqual(current, doc)) updateFromSession(entry, current);
    },
    setEditable(next) {
      const editableNow = next && !session.isClosed;
      if (peer.editable !== editableNow) {
        peer.editable = editableNow;
        peer.editableGeneration += 1;
        for (const listener of [...peer.insertionListeners]) listener();
      }
      if (![...entry.peers].some((item) => item.ready && item.editable)) {
        clearTimer(entry);
        if (entry.dirty) entry.commitAuthorized = false;
      }
    },
    setPane(next) {
      if (peer.pane === next) return;
      peer.pane = next;
      for (const listener of [...peer.insertionListeners]) listener();
    },
    commit() {
      return commitEntry(entry);
    },
    dispose() {
      if (peer.disposed) return;
      if (entry.peers.size === 1 && entry.dirty && peer.editable && !session.isClosed) commitEntry(entry);
      peer.disposed = true;
      peer.ready = false;
      if (peer.editor && peersByEditor.get(peer.editor) === peer) peersByEditor.delete(peer.editor);
      for (const listener of [...peer.insertionListeners]) listener();
      entry.peers.delete(peer);
      if (entry.peers.size === 0) {
        clearTimer(entry);
        if (!entry.dirty && !session.isClosed) removeEntry(entry);
        else if (!entry.dirty) {
          entry.unregisterCommit?.();
          entry.unregisterCommit = null;
        }
      } else if (![...entry.peers].some((item) => item.ready && item.editable) && entry.dirty) {
        clearTimer(entry);
        entry.commitAuthorized = false;
      }
    },
  };
}
