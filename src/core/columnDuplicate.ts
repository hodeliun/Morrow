import type { Command } from './commands';
import type { PageId, PropDef, PropValue, WorkspaceState } from './model';

export interface ColumnDuplicatePlan {
  property: PropDef;
  commands: Command[];
}

export interface ColumnDuplicateSnapshot {
  property: PropDef;
  values: Record<PageId, PropValue | undefined>;
}

function copyName(source: string, existing: Set<string>, suffix: string): string {
  const base = `${source} ${suffix}`.trim();
  let candidate = base;
  let index = 2;
  while (existing.has(candidate.toLocaleLowerCase())) candidate = `${base} ${index++}`;
  return candidate;
}

// One command group changes the schema and every copied row together. executeAll rolls it all back on error.
export function planColumnDuplicate(
  state: WorkspaceState,
  databaseId: PageId,
  propertyId: string,
  newPropertyId: string,
  includeValues: boolean,
  now: number,
  suffix: string,
): ColumnDuplicatePlan | null {
  const page = state.pages[databaseId];
  const database = page?.database;
  if (!page || page.kind !== 'database' || !database || database.unsupportedProperties?.length) return null;
  const source = database.properties.find((property) => property.id === propertyId);
  if (!source || database.properties.some((property) => property.id === newPropertyId)) return null;
  // An inverse field belongs to the source relation. Cloning it would create a broken second endpoint.
  if (source.type === 'relation' && (source.relation?.isInverse || source.relation?.inversePropertyId)) return null;

  const name = copyName(source.name, new Set(database.properties.map((property) => property.name.toLocaleLowerCase())), suffix);
  const property: PropDef = {
    ...structuredClone(source),
    id: newPropertyId,
    name,
    ...(source.defaultSequence && !includeValues ? { sequenceNext: source.defaultSequence.start } : {}),
  };
  const sourceIndex = database.properties.findIndex((item) => item.id === propertyId);
  const properties = [...database.properties];
  properties.splice(sourceIndex + 1, 0, property);
  const views = database.views.map((view) => {
    const visibleOrder = view.order ?? database.properties.map((item) => item.id);
    const index = visibleOrder.indexOf(propertyId);
    if (index < 0) return view;
    const order = [...visibleOrder];
    order.splice(index + 1, 0, newPropertyId);
    return { ...view, order };
  });
  const commands: Command[] = [
    { type: 'database.set', id: databaseId, database: { ...database, properties, views }, now },
  ];
  if (includeValues && source.type !== 'formula' && source.type !== 'button') {
    for (const row of Object.values(state.pages)) {
      if (row.parentId !== databaseId || !Object.prototype.hasOwnProperty.call(row.properties, propertyId)) continue;
      const value: PropValue = structuredClone(row.properties[propertyId] ?? null);
      commands.push({
        type: 'page.setFields',
        id: row.id,
        properties: { ...row.properties, [newPropertyId]: value },
        now,
      });
    }
  }
  return { property, commands };
}

export function snapshotColumnDuplicate(
  state: WorkspaceState,
  databaseId: PageId,
  propertyId: string,
): ColumnDuplicateSnapshot | null {
  const property = state.pages[databaseId]?.database?.properties.find((item) => item.id === propertyId);
  if (!property) return null;
  const values: Record<PageId, PropValue | undefined> = {};
  for (const row of Object.values(state.pages))
    if (row.parentId === databaseId) values[row.id] = structuredClone(row.properties[propertyId]);
  return { property: structuredClone(property), values };
}

// The short-lived Undo action only removes an untouched copy. Other row fields and extra YAML are kept.
export function planColumnDuplicateUndo(
  state: WorkspaceState,
  databaseId: PageId,
  propertyId: string,
  snapshot: ColumnDuplicateSnapshot,
  now: number,
): Command[] | null {
  const database = state.pages[databaseId]?.database;
  const property = database?.properties.find((item) => item.id === propertyId);
  if (!database || !property || JSON.stringify(property) !== JSON.stringify(snapshot.property)) return null;
  const rows = Object.values(state.pages).filter((row) => row.parentId === databaseId);
  for (const row of rows) {
    const value = row.properties[propertyId];
    if (JSON.stringify(value) !== JSON.stringify(snapshot.values[row.id])) return null;
  }
  const commands: Command[] = [{
    type: 'database.set', id: databaseId, now,
    database: {
      ...database,
      properties: database.properties.filter((item) => item.id !== propertyId),
      views: database.views.map((view) => ({
        ...view,
        order: view.order?.filter((id) => id !== propertyId),
      })),
    },
  }];
  for (const row of rows) {
    if (!Object.prototype.hasOwnProperty.call(row.properties, propertyId)) continue;
    const properties = { ...row.properties };
    delete properties[propertyId];
    commands.push({ type: 'page.setFields', id: row.id, properties, extra: row.extra, now });
  }
  return commands;
}
