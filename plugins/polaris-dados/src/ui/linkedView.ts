import type { DataApiRow } from '../../../../src/app/plugins/dataApi';
import type { LinkedViewConfig } from '../../../../src/app/plugins/linkedViewApi';
import type { ProviderProperty, ReadySnapshot } from './formulas';

export const ROW_TITLE_COLUMN_KEY = 'row-title';

export type PresentedProperty =
  | {
      readonly kind: 'row-title';
      readonly key: typeof ROW_TITLE_COLUMN_KEY;
      readonly name: string;
    }
  | {
      readonly kind: 'property';
      readonly key: string;
      readonly id: string;
      readonly name: string;
      readonly property: ProviderProperty;
    };

export interface LinkedViewProjection {
  readonly title: string;
  readonly properties: readonly PresentedProperty[];
  readonly rows: readonly DataApiRow[];
  readonly filterUnavailable: boolean;
}

/** Build a view-local projection while keeping its rows and schema owned by the shared data API. */
export function projectLinkedView(
  snapshot: ReadySnapshot,
  config: LinkedViewConfig,
  rowTitleLabel: string,
): LinkedViewProjection {
  const schemaProperties = snapshot.schema.properties;
  const schemaById = new Map(schemaProperties.map((property) => [property.id, property]));
  const ordered = [
    ...config.columnOrder.flatMap((id) => {
      const property = schemaById.get(id);
      return property ? [property] : [];
    }),
    ...schemaProperties.filter((property) => !config.columnOrder.includes(property.id)),
  ];
  const properties: PresentedProperty[] = [
    { kind: 'row-title', key: ROW_TITLE_COLUMN_KEY, name: rowTitleLabel },
    ...ordered.map((property) => ({
      kind: 'property' as const,
      key: `property:${JSON.stringify(property.id)}`,
      id: property.id,
      name: property.name,
      property,
    })),
  ];
  if (!config.filter) {
    return { title: config.title, properties, rows: snapshot.rows, filterUnavailable: false };
  }

  const filterProperty = schemaById.get(config.filter.propertyId);
  if (!filterProperty || filterProperty.type !== 'number') {
    return { title: config.title, properties, rows: snapshot.rows, filterUnavailable: true };
  }
  const rows = snapshot.rows.filter((row) => {
    const value = row.properties[filterProperty.id];
    return typeof value === 'number' && Number.isFinite(value) && value >= config.filter!.value;
  });
  return { title: config.title, properties, rows, filterUnavailable: false };
}

/** Reorder selectable column IDs while preserving unsupported references in their existing slots. */
export function mergePrioritizedColumnOrder(
  currentOrder: readonly string[],
  knownIds: readonly string[],
  prioritizedIds: readonly string[],
): string[] {
  const known = new Set(knownIds);
  const prioritized = prioritizedIds.filter((id) => known.has(id));
  const remaining = [...prioritized];
  const result: string[] = [];
  for (const id of currentOrder) {
    if (!known.has(id)) {
      result.push(id);
      continue;
    }
    const next = remaining.shift();
    if (next) result.push(next);
  }
  result.push(...remaining);
  return result;
}
