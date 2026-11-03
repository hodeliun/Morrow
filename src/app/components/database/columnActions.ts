import type { DatabaseDef, PropDef, ViewDef } from '../../../core/model';
import { TITLE_PROP } from '../../../core/database';

export type ColumnInsertPosition = 'before' | 'after';

export function orderedColumnIds(database: DatabaseDef, view: ViewDef): string[] {
  const order = view.order ?? [];
  const titleIsExplicit = order.includes(TITLE_PROP);
  const columns = [...new Set([TITLE_PROP, ...database.properties.map((prop) => prop.id)])];
  return columns
    .map((id, index) => ({ id, index, orderIndex: order.indexOf(id) }))
    .sort((a, b) => {
      if (!titleIsExplicit) {
        if (a.id === TITLE_PROP) return -1;
        if (b.id === TITLE_PROP) return 1;
      }
      if (a.orderIndex >= 0 || b.orderIndex >= 0) {
        if (a.orderIndex < 0) return 1;
        if (b.orderIndex < 0) return -1;
        if (a.orderIndex !== b.orderIndex) return a.orderIndex - b.orderIndex;
      }
      return a.index - b.index;
    })
    .map(({ id }) => id);
}

export function moveColumnInView(
  database: DatabaseDef,
  view: ViewDef,
  columnId: string,
  targetId: string,
  position: ColumnInsertPosition,
): ViewDef | null {
  if (columnId === targetId) return null;
  const ordered = orderedColumnIds(database, view);
  const visible = ordered.filter((id) => id === TITLE_PROP || !view.hidden.includes(id));
  const fromIndex = visible.indexOf(columnId);
  const toIndex = visible.indexOf(targetId);
  if (fromIndex < 0 || toIndex < 0) return null;

  const reordered = visible.filter((id) => id !== columnId);
  const targetIndex = reordered.indexOf(targetId);
  reordered.splice(targetIndex + (position === 'after' ? 1 : 0), 0, columnId);
  if (reordered.every((id, index) => id === visible[index])) return null;

  const fullOrder = [...new Set(view.order ?? [])];
  if (!fullOrder.includes(TITLE_PROP)) fullOrder.unshift(TITLE_PROP);
  for (const id of database.properties.map((prop) => prop.id)) {
    if (!fullOrder.includes(id)) fullOrder.push(id);
  }
  const visibleIds = new Set(visible);
  const visibleSlots = fullOrder.flatMap((id, index) => (visibleIds.has(id) ? [index] : []));
  if (visibleSlots.length !== reordered.length) return null;
  visibleSlots.forEach((slot, index) => {
    fullOrder[slot] = reordered[index]!;
  });
  return { ...view, order: fullOrder };
}

export function movePropertyInViewOrder(
  database: DatabaseDef,
  view: ViewDef,
  propertyId: string,
  direction: -1 | 1,
): ViewDef | null {
  const propertyIds = orderedColumnIds(database, view).filter((id) => id !== TITLE_PROP);
  const index = propertyIds.indexOf(propertyId);
  const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= propertyIds.length) return null;
  [propertyIds[index], propertyIds[targetIndex]] = [propertyIds[targetIndex]!, propertyIds[index]!];

  const fullOrder = [...new Set(view.order ?? [])];
  if (!fullOrder.includes(TITLE_PROP)) fullOrder.unshift(TITLE_PROP);
  for (const id of database.properties.map((prop) => prop.id)) {
    if (!fullOrder.includes(id)) fullOrder.push(id);
  }
  const propertySet = new Set(database.properties.map((prop) => prop.id));
  const propertySlots = fullOrder.flatMap((id, slot) => (propertySet.has(id) ? [slot] : []));
  if (propertySlots.length !== propertyIds.length) return null;
  propertySlots.forEach((slot, position) => {
    fullOrder[slot] = propertyIds[position]!;
  });
  return { ...view, order: fullOrder };
}

// A column is part of the database schema, while a view may have its own order.
// Keep the new property next to the chosen header in both places.
export function insertPropertyNear(
  database: DatabaseDef,
  view: ViewDef,
  property: PropDef,
  anchorPropertyId: string,
  position: ColumnInsertPosition,
): { database: DatabaseDef; view: ViewDef } | null {
  const schemaIndex = database.properties.findIndex((candidate) => candidate.id === anchorPropertyId);
  const orderedIds = orderedColumnIds(database, view);
  const viewIndex = orderedIds.indexOf(anchorPropertyId);
  if (
    schemaIndex < 0 ||
    viewIndex < 0 ||
    database.properties.some((candidate) => candidate.id === property.id) ||
    view.order?.includes(property.id)
  )
    return null;

  const properties = [...database.properties];
  properties.splice(schemaIndex + (position === 'after' ? 1 : 0), 0, property);

  const order = [...new Set(view.order ?? [])];
  if (!order.includes(TITLE_PROP)) order.unshift(TITLE_PROP);
  for (const id of orderedIds) {
    if (!order.includes(id)) order.push(id);
  }
  const anchorIndex = order.indexOf(anchorPropertyId);
  order.splice(anchorIndex + (position === 'after' ? 1 : 0), 0, property.id);

  return {
    database: { ...database, properties },
    view: { ...view, order },
  };
}
