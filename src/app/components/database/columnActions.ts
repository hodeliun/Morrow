import type { DatabaseDef, PropDef, ViewDef } from '../../../core/model';

export type ColumnInsertPosition = 'before' | 'after';

function orderedProperties(database: DatabaseDef, view: ViewDef): PropDef[] {
  const order = view.order ?? [];
  return database.properties
    .map((prop, index) => ({ prop, index }))
    .sort((a, b) => {
      const aOrder = order.indexOf(a.prop.id);
      const bOrder = order.indexOf(b.prop.id);
      if (aOrder >= 0 || bOrder >= 0) {
        if (aOrder < 0) return 1;
        if (bOrder < 0) return -1;
        if (aOrder !== bOrder) return aOrder - bOrder;
      }
      return a.index - b.index;
    })
    .map(({ prop }) => prop);
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
  const ordered = orderedProperties(database, view);
  const viewIndex = ordered.findIndex((candidate) => candidate.id === anchorPropertyId);
  if (schemaIndex < 0 || viewIndex < 0) return null;

  const properties = [...database.properties];
  properties.splice(schemaIndex + (position === 'after' ? 1 : 0), 0, property);

  const order = ordered.map((candidate) => candidate.id);
  order.splice(viewIndex + (position === 'after' ? 1 : 0), 0, property.id);

  return {
    database: { ...database, properties },
    view: { ...view, order },
  };
}
