import type { DocNode, PageId, ViewDef, DatabaseDef } from '../core/model';
import { sameTableActionValue } from './tableActions';

export type ViewHistoryIdentity =
  | { kind: 'database'; databaseId: PageId; viewId: string }
  | { kind: 'linked'; hostPageId: PageId; blockId: string };

export interface ViewConfigSnapshot {
  view: ViewDef;
  viewRawState?: unknown;
}

export interface ViewConfigChange {
  identity: ViewHistoryIdentity;
  before: ViewConfigSnapshot;
  after: ViewConfigSnapshot;
}

/** JSON encoding keeps identities unambiguous even when IDs contain punctuation. */
export function viewHistoryIdentityKey(identity: ViewHistoryIdentity): string {
  return identity.kind === 'database'
    ? JSON.stringify(['database', identity.databaseId, identity.viewId])
    : JSON.stringify(['linked', identity.hostPageId, identity.blockId]);
}

/**
 * Captures only changes to existing views when the rest of the database definition is stable.
 * Schema, view creation/deletion, and ambiguous duplicate IDs stay outside view history.
 */
export function primaryViewConfigChanges(
  databaseId: PageId,
  before: DatabaseDef,
  after: DatabaseDef,
): ViewConfigChange[] {
  if (!sameTableActionValue(withoutViews(before), withoutViews(after))) return [];

  const beforeById = uniqueViewsById(before.views);
  const afterById = uniqueViewsById(after.views);
  if (
    beforeById.size !== before.views.length ||
    afterById.size !== after.views.length ||
    beforeById.size !== afterById.size ||
    [...beforeById.keys()].some((viewId) => !afterById.has(viewId))
  )
    return [];
  const changes: ViewConfigChange[] = [];
  for (const [viewId, beforeView] of beforeById) {
    const afterView = afterById.get(viewId);
    if (!afterView || sameTableActionValue(beforeView, afterView)) continue;
    changes.push({
      identity: { kind: 'database', databaseId, viewId },
      before: { view: beforeView },
      after: { view: afterView },
    });
  }
  return changes;
}

/**
 * Captures an isolated linked-view configuration edit. The document must be identical after
 * removing only `view` and `viewRawState` from the unique node identified by host page and block.
 * Mixed text/structure edits are deliberately not classified as view history.
 */
export function linkedViewConfigChange(
  hostPageId: PageId,
  blockId: string,
  before: DocNode,
  after: DocNode,
): ViewConfigChange | null {
  const identity: ViewHistoryIdentity = { kind: 'linked', hostPageId, blockId };
  const beforeMatches = findLinkedViews(before, identity);
  const afterMatches = findLinkedViews(after, identity);
  if (beforeMatches.length !== 1 || afterMatches.length !== 1) return null;

  const beforeMatch = beforeMatches[0]!;
  const afterMatch = afterMatches[0]!;
  if (!samePath(beforeMatch.path, afterMatch.path)) return null;
  if (beforeMatch.snapshot.view.id !== afterMatch.snapshot.view.id) return null;
  if (
    sameTableActionValue(beforeMatch.snapshot.view, afterMatch.snapshot.view) &&
    sameTableActionValue(beforeMatch.snapshot.viewRawState, afterMatch.snapshot.viewRawState)
  )
    return null;
  if (
    !sameTableActionValue(stripLinkedConfig(before, beforeMatch.path), stripLinkedConfig(after, afterMatch.path))
  )
    return null;

  return {
    identity,
    before: beforeMatch.snapshot,
    after: afterMatch.snapshot,
  };
}

export function linkedViewConfigChanges(hostPageId: PageId, before: DocNode, after: DocNode): ViewConfigChange[] {
  const beforeIdentities = linkedViewIdentities(before);
  const afterKeys = new Set(linkedViewIdentities(after).map(viewHistoryIdentityKey));
  const changes: ViewConfigChange[] = [];
  for (const identity of beforeIdentities) {
    if (!afterKeys.has(viewHistoryIdentityKey(identity))) continue;
    const change = linkedViewConfigChange(hostPageId, identity.blockId, before, after);
    if (change) changes.push(change);
  }
  return changes;
}

/** Checks the exact view payload expected before applying an undo or redo. */
export function viewConfigMatches(current: ViewConfigSnapshot, expected: ViewConfigSnapshot): boolean {
  return (
    sameTableActionValue(current.view, expected.view) &&
    sameTableActionValue(current.viewRawState, expected.viewRawState)
  );
}

export function primaryViewConfigSnapshot(database: DatabaseDef, viewId: string): ViewConfigSnapshot | null {
  const matches = database.views.filter((view) => view.id === viewId);
  return matches.length === 1 ? { view: matches[0]! } : null;
}

export function replacePrimaryViewConfig(
  database: DatabaseDef,
  viewId: string,
  expected: ViewConfigSnapshot,
  replacement: ViewConfigSnapshot,
): DatabaseDef | null {
  const current = primaryViewConfigSnapshot(database, viewId);
  if (!current || !viewConfigMatches(current, expected) || replacement.view.id !== viewId) return null;
  return {
    ...database,
    views: database.views.map((view) => (view.id === viewId ? replacement.view : view)),
  };
}

export function linkedViewConfigSnapshot(
  doc: DocNode,
  hostPageId: PageId,
  blockId: string,
): ViewConfigSnapshot | null {
  const identity: ViewHistoryIdentity = { kind: 'linked', hostPageId, blockId };
  const matches = findLinkedViews(doc, identity);
  return matches.length === 1 ? matches[0]!.snapshot : null;
}

export function replaceLinkedViewConfig(
  doc: DocNode,
  hostPageId: PageId,
  blockId: string,
  expected: ViewConfigSnapshot,
  replacement: ViewConfigSnapshot,
): DocNode | null {
  const identity: ViewHistoryIdentity = { kind: 'linked', hostPageId, blockId };
  const matches = findLinkedViews(doc, identity);
  if (
    matches.length !== 1 ||
    !viewConfigMatches(matches[0]!.snapshot, expected) ||
    matches[0]!.snapshot.view.id !== replacement.view.id
  )
    return null;
  return replaceAtPath(doc, matches[0]!.path, replacement);
}

function withoutViews(database: DatabaseDef): Omit<DatabaseDef, 'views'> {
  const { views: _views, ...schema } = database;
  return schema;
}

function uniqueViewsById(views: readonly ViewDef[]): Map<string, ViewDef> {
  const counts = new Map<string, number>();
  for (const view of views) counts.set(view.id, (counts.get(view.id) ?? 0) + 1);
  return new Map(views.filter((view) => counts.get(view.id) === 1).map((view) => [view.id, view]));
}

interface LinkedViewMatch {
  path: number[];
  snapshot: ViewConfigSnapshot;
}

function findLinkedViews(doc: DocNode, identity: Extract<ViewHistoryIdentity, { kind: 'linked' }>): LinkedViewMatch[] {
  const matches: LinkedViewMatch[] = [];
  const visit = (node: DocNode, path: number[]) => {
    if (node.type === 'linkedDatabaseView' && node.attrs?.hostPageId === identity.hostPageId && node.attrs.blockId === identity.blockId) {
      const view = node.attrs.view;
      if (isViewDef(view)) {
        matches.push({
          path,
          snapshot: {
            view,
            ...(Object.hasOwn(node.attrs, 'viewRawState') ? { viewRawState: node.attrs.viewRawState } : {}),
          },
        });
      }
    }
    node.content?.forEach((child, index) => visit(child, [...path, index]));
  };
  visit(doc, []);
  return matches;
}

function linkedViewIdentities(doc: DocNode): Array<Extract<ViewHistoryIdentity, { kind: 'linked' }>> {
  const identities: Array<Extract<ViewHistoryIdentity, { kind: 'linked' }>> = [];
  const visit = (node: DocNode) => {
    if (
      node.type === 'linkedDatabaseView' &&
      typeof node.attrs?.hostPageId === 'string' &&
      typeof node.attrs.blockId === 'string' &&
      isViewDef(node.attrs.view)
    )
      identities.push({
        kind: 'linked',
        hostPageId: node.attrs.hostPageId,
        blockId: node.attrs.blockId,
      });
    node.content?.forEach(visit);
  };
  visit(doc);
  return identities;
}

function isViewDef(value: unknown): value is ViewDef {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { id?: unknown }).id === 'string';
}

function stripLinkedConfig(doc: DocNode, path: readonly number[], depth = 0): DocNode {
  if (depth === path.length) {
    if (!doc.attrs) return doc;
    const { view: _view, viewRawState: _viewRawState, ...attrs } = doc.attrs;
    return { ...doc, attrs };
  }
  const childIndex = path[depth]!;
  if (!doc.content || !doc.content[childIndex]) return doc;
  return {
    ...doc,
    content: doc.content.map((child, index) =>
      index === childIndex ? stripLinkedConfig(child, path, depth + 1) : child,
    ),
  };
}

function replaceAtPath(doc: DocNode, path: readonly number[], replacement: ViewConfigSnapshot, depth = 0): DocNode {
  if (depth === path.length) {
    const attrs: Record<string, unknown> = { ...(doc.attrs ?? {}), view: replacement.view };
    if (Object.hasOwn(replacement, 'viewRawState')) attrs.viewRawState = replacement.viewRawState;
    else delete attrs.viewRawState;
    return { ...doc, attrs };
  }
  const childIndex = path[depth]!;
  if (!doc.content || !doc.content[childIndex]) return doc;
  return {
    ...doc,
    content: doc.content.map((child, index) =>
      index === childIndex ? replaceAtPath(child, path, replacement, depth + 1) : child,
    ),
  };
}

function samePath(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}
