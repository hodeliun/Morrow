import type { DatabaseDef, DocNode, PageId, PageMeta, PropValue, WorkspaceState } from './model';
import { childrenOf, descendantsOf, isEffectivelyTrashed } from './tree';

export interface DatabaseCopyPlan {
  databaseId: PageId;
  pages: PageMeta[];
  docs: Record<PageId, DocNode>;
}

// Build one pages.insert command so a duplicated table and its rows save and undo together.
export function planDatabaseCopy(
  state: WorkspaceState,
  sourceId: PageId,
  parentId: PageId,
  includeRows: boolean,
  nextId: () => PageId,
  now: number,
  copySuffix: string,
): DatabaseCopyPlan | null {
  const source = state.pages[sourceId];
  const parent = state.pages[parentId];
  if (!source?.database || source.kind !== 'database' || !parent || isEffectivelyTrashed(state.pages, sourceId) || isEffectivelyTrashed(state.pages, parentId)) return null;
  const originals = [source, ...(includeRows ? descendantsOf(state.pages, sourceId) : [])];
  if (originals.some((page) => page.encrypted)) return null;
  const ids = new Map(originals.map((page) => [page.id, nextId()]));
  if (new Set(ids.values()).size !== ids.size || [...ids.values()].some((id) => state.pages[id])) return null;
  const databaseId = ids.get(sourceId)!;
  const remapId = (id: unknown) => (typeof id === 'string' ? ids.get(id) ?? id : id);
  const remapReferences = <T>(value: T): T => {
    if (Array.isArray(value)) return value.map(remapReferences) as T;
    if (!value || typeof value !== 'object') return value;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = ['databaseId', 'targetDatabaseId', 'sourceDatabaseId', 'hostPageId', 'pageId'].includes(key)
        ? remapId(item)
        : remapReferences(item);
    }
    return result as T;
  };
  const copiedSchema = (database: DatabaseDef): DatabaseDef => {
    const copy = remapReferences(structuredClone(database));
    copy.views = copy.views.map((view) => ({ ...view, id: nextId() }));
    return copy;
  };
  const pages = originals.map((original): PageMeta => {
    const sourceParent = original.parentId ? state.pages[original.parentId] : null;
    const values = structuredClone(original.properties);
    if (sourceParent?.database) {
      for (const property of sourceParent.database.properties) {
        if (property.type !== 'relation' || !property.relation?.targetDatabaseId || !ids.has(property.relation.targetDatabaseId)) continue;
        const value: PropValue | undefined = values[property.id];
        if (Array.isArray(value)) values[property.id] = value.map((item) => String(remapId(item)));
        else if (typeof value === 'string') values[property.id] = String(remapId(value));
      }
    }
    return {
      ...original,
      id: ids.get(original.id)!,
      parentId: original.id === sourceId ? parentId : ids.get(original.parentId!)!,
      title: original.id === sourceId ? `${original.title} ${copySuffix}`.trim() : original.title,
      order: original.id === sourceId ? childrenOf(state.pages, parentId).length : original.order,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: null,
      trashedAt: null,
      favorite: false,
      dailyDate: null,
      controls: remapReferences(structuredClone(original.controls)),
      properties: values,
      extra: structuredClone(original.extra),
      database: original.database ? copiedSchema(original.database) : null,
    };
  });
  const docs: Record<PageId, DocNode> = {};
  for (const original of originals) {
    const document = state.docs[original.id];
    if (!document) continue;
    const visit = (node: DocNode): DocNode => ({
      ...node,
      ...(node.attrs
        ? {
            attrs: {
              ...remapReferences(structuredClone(node.attrs)),
              ...(node.type === 'pageLink' && typeof node.attrs.id === 'string'
                ? { id: remapId(node.attrs.id) }
                : {}),
            },
          }
        : {}),
      ...(node.content ? { content: node.content.map(visit) } : {}),
    });
    docs[ids.get(original.id)!] = visit(document);
  }
  return { databaseId, pages, docs };
}
