import type { DocNode, PageId, PageMeta, ViewDef, WorkspaceState } from './model';
import { walk } from './doc';
import { descendantsOf, isEffectivelyTrashed } from './tree';

export interface LinkedViewReference {
  hostPageId: PageId;
  databaseId: PageId;
  viewId: string | null;
  viewName: string;
  view?: ViewDef;
  blockId: string | null;
}

export function linkedViewsInDoc(doc: DocNode, hostPageId: PageId): LinkedViewReference[] {
  const references: LinkedViewReference[] = [];
  walk(doc, (node) => {
    if (node.type !== 'linkedDatabaseView') return;
    const databaseId = node.attrs?.sourceDatabaseId;
    if (typeof databaseId !== 'string' || !databaseId) return;
    references.push({
      hostPageId,
      databaseId,
      viewId:
        typeof node.attrs?.view === 'object' &&
        node.attrs.view !== null &&
        typeof (node.attrs.view as Record<string, unknown>).id === 'string'
          ? String((node.attrs.view as Record<string, unknown>).id)
          : null,
      viewName:
        typeof node.attrs?.view === 'object' &&
        node.attrs.view !== null &&
        typeof (node.attrs.view as Record<string, unknown>).name === 'string'
          ? String((node.attrs.view as Record<string, unknown>).name)
          : '',
      ...(typeof node.attrs?.view === 'object' && node.attrs.view !== null
        ? { view: node.attrs.view as ViewDef }
        : {}),
      blockId: typeof node.attrs?.blockId === 'string' ? node.attrs.blockId : null,
    });
  });
  return references;
}

export function linkedViewReferences(state: WorkspaceState, databaseId: PageId): LinkedViewReference[] {
  return Object.entries(state.docs).flatMap(([hostPageId, doc]) =>
    isEffectivelyTrashed(state.pages, hostPageId)
      ? []
      : linkedViewsInDoc(doc, hostPageId).filter((reference) => reference.databaseId === databaseId),
  );
}

// A page may link to several databases, but following those links must never lead back to the page.
export function wouldCreateLinkedViewCycle(
  state: WorkspaceState,
  hostPageId: PageId,
  databaseId: PageId,
  excludeBlockId?: string | null,
): boolean {
  if (hostPageId === databaseId) return true;
  const graph = new Map<PageId, PageId[]>();
  for (const [pageId, doc] of Object.entries(state.docs)) {
    if (isEffectivelyTrashed(state.pages, pageId)) continue;
    const edges = linkedViewsInDoc(doc, pageId)
      .filter(
        (reference) => !(pageId === hostPageId && excludeBlockId && reference.blockId === excludeBlockId),
      )
      .map((reference) => reference.databaseId);
    graph.set(pageId, edges);
  }
  const pending = [databaseId];
  const visited = new Set<PageId>();
  while (pending.length) {
    const current = pending.pop()!;
    if (current === hostPageId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(graph.get(current) ?? []));
  }
  return false;
}

export function linkedViewSourceError(
  state: WorkspaceState,
  hostPageId: PageId,
  databaseId: unknown,
  blockId?: string | null,
): string | null {
  if (typeof databaseId !== 'string' || !databaseId) return 'Choose a source database for this linked view.';
  const source = state.pages[databaseId];
  if (source?.kind !== 'database' || !source.database || isEffectivelyTrashed(state.pages, databaseId))
    return 'The linked view source is unavailable. Choose another database.';
  if (wouldCreateLinkedViewCycle(state, hostPageId, databaseId, blockId))
    return 'This linked view would create a recursive database view. Choose another source.';
  return null;
}

export function viewUsesProperty(view: ViewDef, propertyId: string): boolean {
  return (
    view.filters.some((rule) => rule.prop === propertyId) ||
    view.filterGroups?.some((group) => group.filters.some((rule) => rule.prop === propertyId)) === true ||
    view.sorts.some((sort) => sort.prop === propertyId) ||
    view.groupBy === propertyId ||
    view.dateProp === propertyId ||
    view.hidden.includes(propertyId) ||
    view.order?.includes(propertyId) === true ||
    view.wrap?.includes(propertyId) === true ||
    Object.prototype.hasOwnProperty.call(view.widths ?? {}, propertyId) ||
    view.frozenThrough === propertyId ||
    Object.prototype.hasOwnProperty.call(view.align ?? {}, propertyId) ||
    Object.prototype.hasOwnProperty.call(view.summaries ?? {}, propertyId) ||
    view.conditionalFormats?.some((rule) => rule.prop === propertyId) === true ||
    view.cardProperties?.includes(propertyId) === true ||
    view.cardImageProp === propertyId
  );
}

export function databaseViewDependents(state: WorkspaceState, databaseId: PageId): PageMeta[] {
  const ids = new Set(linkedViewReferences(state, databaseId).map((reference) => reference.hostPageId));
  return [...ids].flatMap((id) => (state.pages[id] ? [state.pages[id]!] : []));
}

export function linkedViewsBlockingTrash(state: WorkspaceState, pageId: PageId): LinkedViewReference[] {
  const subtreeIds = new Set([pageId, ...descendantsOf(state.pages, pageId).map((page) => page.id)]);
  const databases = Object.values(state.pages).filter(
    (page) => subtreeIds.has(page.id) && page.kind === 'database' && page.database,
  );
  return databases.flatMap((database) =>
    linkedViewReferences(state, database.id).filter((reference) => !subtreeIds.has(reference.hostPageId)),
  );
}
