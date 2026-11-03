import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Fragment } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import type { DocNode, PageId } from '../../core/model';
import type { ViewDef } from '../../core/model';
import { linkedViewHostMatches } from '../../storage/viewHistoryCapture';
import type { ViewConfigChange, ViewConfigSnapshot } from '../../storage/viewHistoryCapture';
import { pageEditorsMatchDocuments } from './pageEditorRegistry';

export type LinkedViewConfigSyncResult =
  | { status: 'not-linked-only' }
  | { status: 'already-current'; changes: readonly ViewConfigChange[] }
  | { status: 'conflict'; changes: readonly ViewConfigChange[] }
  | { status: 'transaction'; changes: readonly ViewConfigChange[]; transaction: Transaction };

export type LinkedViewConfigWriteResult<T> =
  | { status: 'not-linked-only' }
  | { status: 'conflict' }
  | { status: 'invalid' }
  | { status: 'written'; doc: DocNode; result: T };

/**
 * Prepare a history-free mirror only when the source documents differ by an exact list of linked
 * view configuration changes and this editor still has the full expected document. Other external
 * changes remain on PageEditor's ordinary source-sync path.
 */
export function prepareLinkedViewConfigSync(
  state: EditorState,
  hostPageId: PageId,
  expectedDoc: DocNode,
  nextDoc: DocNode,
): LinkedViewConfigSyncResult {
  const changes = exactLinkedViewConfigChanges(hostPageId, expectedDoc, nextDoc);
  if (!changes) return { status: 'not-linked-only' };

  let expected: ProseMirrorNode;
  let next: ProseMirrorNode;
  try {
    expected = state.schema.nodeFromJSON(expectedDoc);
    next = state.schema.nodeFromJSON(nextDoc);
  } catch {
    return { status: 'conflict', changes };
  }

  if (sameEditorDocument(state.doc, next)) return { status: 'already-current', changes };
  if (!sameEditorDocument(state.doc, expected)) return { status: 'conflict', changes };

  const transaction = state.tr;
  for (const change of changes) {
    if (change.identity.kind !== 'linked' || change.identity.hostPageId !== hostPageId)
      return { status: 'conflict', changes };
    const beforeMatches = findLinkedNodes(expected, hostPageId, change.identity.blockId);
    const afterMatches = findLinkedNodes(next, hostPageId, change.identity.blockId);
    const currentMatches = findLinkedNodes(transaction.doc, hostPageId, change.identity.blockId);
    if (
      beforeMatches.length !== 1 ||
      afterMatches.length !== 1 ||
      currentMatches.length !== 1 ||
      beforeMatches[0]!.position !== afterMatches[0]!.position ||
      currentMatches[0]!.position !== beforeMatches[0]!.position ||
      beforeMatches[0]!.node.attrs.sourceDatabaseId !== afterMatches[0]!.node.attrs.sourceDatabaseId ||
      beforeMatches[0]!.node.attrs.view?.id !== change.before.view.id ||
      afterMatches[0]!.node.attrs.view?.id !== change.after.view.id
    )
      return { status: 'conflict', changes };

    transaction.setNodeMarkup(
      currentMatches[0]!.position,
      undefined,
      afterMatches[0]!.node.attrs,
      currentMatches[0]!.node.marks,
    );
  }

  if (!sameEditorDocument(transaction.doc, next)) return { status: 'conflict', changes };
  transaction.setMeta('addToHistory', false);
  transaction.setMeta('preventUpdate', true);
  return { status: 'transaction', changes, transaction };
}

/**
 * Guard a writer that reparses a linked-view-only source edit. Call after awaiting any preceding
 * work; pending editors are committed first, then the source and all affected pane documents are
 * checked immediately before the synchronous write callback.
 */
export function runLinkedViewConfigWrite<T>(options: {
  hostPageId: PageId;
  expectedDoc: DocNode;
  proposedDoc: DocNode;
  commitPending: () => void;
  currentDoc: () => DocNode | undefined;
  reparse: (currentDoc: DocNode) => DocNode | null;
  write: (doc: DocNode) => T;
}): LinkedViewConfigWriteResult<T> {
  const proposedDoc = restoreLinkedViewHostPageIds(
    options.hostPageId,
    options.expectedDoc,
    options.proposedDoc,
  );
  if (!exactLinkedViewConfigChanges(options.hostPageId, options.expectedDoc, proposedDoc))
    return { status: 'not-linked-only' };

  options.commitPending();
  const currentDoc = options.currentDoc();
  if (!currentDoc || !sameJson(currentDoc, options.expectedDoc)) return { status: 'conflict' };

  const reparsed = options.reparse(currentDoc);
  if (!reparsed) return { status: 'invalid' };
  const nextDoc = restoreLinkedViewHostPageIds(options.hostPageId, currentDoc, reparsed);
  if (!exactLinkedViewConfigChanges(options.hostPageId, currentDoc, nextDoc))
    return { status: 'invalid' };
  if (!pageEditorsMatchDocuments([{ pageId: options.hostPageId, doc: currentDoc }]))
    return { status: 'conflict' };

  return { status: 'written', doc: nextDoc, result: options.write(nextDoc) };
}

function exactLinkedViewConfigChanges(
  hostPageId: PageId,
  expected: DocNode,
  next: DocNode,
): ViewConfigChange[] | null {
  const before = collectLinkedViews(expected, hostPageId);
  const after = collectLinkedViews(next, hostPageId);
  if (!before || !after || before.length !== after.length) return null;

  const beforeById = new Map(before.map((entry) => [entry.blockId, entry]));
  const afterById = new Map(after.map((entry) => [entry.blockId, entry]));
  if (
    beforeById.size !== before.length ||
    afterById.size !== after.length ||
    [...beforeById.keys()].some((blockId) => !afterById.has(blockId))
  )
    return null;

  const changes: ViewConfigChange[] = [];
  const changedBlockIds = new Set<string>();
  for (const [blockId, oldEntry] of beforeById) {
    const newEntry = afterById.get(blockId)!;
    if (!samePath(oldEntry.path, newEntry.path)) return null;
    if (!oldEntry.snapshot || !newEntry.snapshot) {
      if (!sameJson(oldEntry.node, newEntry.node)) return null;
      continue;
    }
    if (oldEntry.snapshot.view.id !== newEntry.snapshot.view.id) return null;
    if (sameJson(oldEntry.snapshot, newEntry.snapshot)) continue;
    changes.push({
      identity: { kind: 'linked', hostPageId, blockId },
      before: oldEntry.snapshot,
      after: newEntry.snapshot,
    });
    changedBlockIds.add(blockId);
  }
  if (changes.length === 0) return null;

  return sameJson(stripLinkedViewConfigs(expected, changedBlockIds), stripLinkedViewConfigs(next, changedBlockIds))
    ? changes
    : null;
}

function restoreLinkedViewHostPageIds(hostPageId: PageId, expected: DocNode, next: DocNode): DocNode {
  const expectedBlockCounts = linkedBlockCounts(expected, hostPageId);
  const nextBlockCounts = linkedBlockCounts(next);
  const visit = (node: DocNode): DocNode => {
    const content = node.content?.map(visit);
    const blockId = node.attrs?.blockId;
    const restoreHost =
      node.type === 'linkedDatabaseView' &&
      node.attrs?.hostPageId === undefined &&
      typeof blockId === 'string' &&
      expectedBlockCounts.get(blockId) === 1 &&
      nextBlockCounts.get(blockId) === 1;
    if (!restoreHost && !content?.some((child, index) => child !== node.content?.[index])) return node;
    return {
      ...node,
      ...(restoreHost ? { attrs: { ...node.attrs, hostPageId } } : {}),
      ...(content ? { content } : {}),
    };
  };
  return visit(next);
}

function linkedBlockCounts(doc: DocNode, hostPageId?: PageId): Map<string, number> {
  const counts = new Map<string, number>();
  const visit = (node: DocNode) => {
    const blockId = node.attrs?.blockId;
    if (
      node.type === 'linkedDatabaseView' &&
      typeof blockId === 'string' &&
      (hostPageId === undefined || node.attrs?.hostPageId === hostPageId)
    )
      counts.set(blockId, (counts.get(blockId) ?? 0) + 1);
    node.content?.forEach(visit);
  };
  visit(doc);
  return counts;
}

interface LinkedViewEntry {
  blockId: string;
  path: number[];
  node: DocNode;
  snapshot: ViewConfigSnapshot | null;
}

function collectLinkedViews(doc: DocNode, hostPageId: PageId): LinkedViewEntry[] | null {
  const entries: LinkedViewEntry[] = [];
  let valid = true;
  const visit = (node: DocNode, path: number[]) => {
    if (!valid) return;
    if (node.type === 'linkedDatabaseView') {
      const attrs = node.attrs;
      if (
        !linkedViewHostMatches(attrs, hostPageId) ||
        typeof attrs.blockId !== 'string' ||
        !attrs.blockId
      ) {
        valid = false;
        return;
      }
      const snapshot = isViewDef(attrs.view)
        ? {
            view: attrs.view,
            ...(Object.hasOwn(attrs, 'viewRawState') ? { viewRawState: attrs.viewRawState } : {}),
          }
        : null;
      entries.push({ blockId: attrs.blockId, path, node, snapshot });
    }
    node.content?.forEach((child, index) => visit(child, [...path, index]));
  };
  visit(doc, []);
  return valid ? entries : null;
}

function stripLinkedViewConfigs(doc: DocNode, changedBlockIds: ReadonlySet<string>): DocNode {
  const visit = (node: DocNode): DocNode => {
    const content = node.content?.map(visit);
    if (node.type !== 'linkedDatabaseView' || !changedBlockIds.has(node.attrs?.blockId as string))
      return { ...node, ...(content ? { content } : {}) };
    const { view: _view, viewRawState: _raw, ...attrs } = node.attrs ?? {};
    return { ...node, attrs, ...(content ? { content } : {}) };
  };
  return visit(doc);
}

function isViewDef(value: unknown): value is ViewDef {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { id?: unknown }).id === 'string'
  );
}

function samePath(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function findLinkedNodes(
  doc: ProseMirrorNode,
  hostPageId: PageId,
  blockId: string,
): Array<{ node: ProseMirrorNode; position: number }> {
  const matches: Array<{ node: ProseMirrorNode; position: number }> = [];
  doc.descendants((node, position) => {
    if (
      node.type.name === 'linkedDatabaseView' &&
      node.attrs.hostPageId === hostPageId &&
      node.attrs.blockId === blockId
    )
      matches.push({ node, position });
  });
  return matches;
}

function sameEditorDocument(left: ProseMirrorNode, right: ProseMirrorNode): boolean {
  return withoutTrailingEmpty(left).eq(withoutTrailingEmpty(right));
}

function withoutTrailingEmpty(doc: ProseMirrorNode): ProseMirrorNode {
  let count = doc.childCount;
  while (
    count > 0 &&
    doc.child(count - 1).type.name === 'paragraph' &&
    doc.child(count - 1).content.size === 0
  )
    count--;
  if (count === doc.childCount) return doc;
  const children: ProseMirrorNode[] = [];
  for (let index = 0; index < count; index++) children.push(doc.child(index));
  return doc.copy(Fragment.from(children));
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameJson(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sameJson(leftRecord[key], rightRecord[key]))
  );
}
