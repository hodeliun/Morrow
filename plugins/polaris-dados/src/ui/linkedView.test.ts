import { describe, expect, it } from 'vitest';
import type { LinkedViewConfig } from '../../../../src/app/plugins/linkedViewApi';
import { mergePrioritizedColumnOrder, projectLinkedView } from './linkedView';
import type { ReadySnapshot } from './formulas';

function readySnapshot(): ReadySnapshot {
  return {
    version: 1,
    status: 'ready',
    databaseId: 'db',
    revision: 'r1',
    schema: {
      properties: [
        { id: 'name', name: 'Name', type: 'text', options: [] },
        { id: 'row.title', name: 'Internal title field', type: 'number', options: [] },
        { id: 'quantity', name: 'Quantity', type: 'number', options: [] },
      ],
      views: [],
    },
    rows: [
      { id: 'missing', title: 'Missing', properties: { name: 'Missing' } },
      { id: 'null', title: 'Null', properties: { name: 'Null', quantity: null } },
      { id: 'zero', title: 'Zero', properties: { name: 'Zero', quantity: 0 } },
      { id: 'five', title: 'Five', properties: { name: 'Five', quantity: 5 } },
    ],
    history: { canUndo: false, canRedo: false },
    readonly: false,
    diagnostic: null,
  } as ReadySnapshot;
}

function config(patch: Partial<LinkedViewConfig> = {}): LinkedViewConfig {
  return {
    title: 'Inventory view',
    columnOrder: [],
    filter: null,
    ...patch,
  };
}

describe('Polaris Dados linked view projection', () => {
  it('keeps the virtual row title distinct from an opaque real property ID with the same spelling', () => {
    const projected = projectLinkedView(readySnapshot(), config({ columnOrder: ['row.title'] }), 'Row title');

    expect(projected.properties.map((property) => property.name)).toEqual([
      'Row title',
      'Internal title field',
      'Name',
      'Quantity',
    ]);
    expect(projected.properties[0]).toMatchObject({ kind: 'row-title', key: 'row-title' });
    expect(projected.properties[1]).toMatchObject({
      kind: 'property',
      id: 'row.title',
      key: 'property:"row.title"',
    });
    expect(projected.properties[0]?.key).not.toBe(projected.properties[1]?.key);
  });

  it('filters only finite numeric values and keeps all rows visible for an unavailable reference', () => {
    const snapshot = readySnapshot();
    const filtered = projectLinkedView(
      snapshot,
      config({ filter: { propertyId: 'quantity', op: 'gte', value: 0 } }),
      'Row title',
    );
    expect(filtered.rows.map((row) => row.id)).toEqual(['zero', 'five']);
    expect(filtered.filterUnavailable).toBe(false);

    const unavailable = projectLinkedView(
      snapshot,
      config({ filter: { propertyId: 'deleted', op: 'gte', value: 0 } }),
      'Row title',
    );
    expect(unavailable.filterUnavailable).toBe(true);
    expect(unavailable.rows.map((row) => row.id)).toEqual(['missing', 'null', 'zero', 'five']);
  });

  it('uses partial priority while preserving unavailable references until explicit removal', () => {
    const projected = projectLinkedView(
      readySnapshot(),
      config({ columnOrder: ['quantity', 'deleted'] }),
      'Row title',
    );
    expect(projected.properties.map((property) => property.name)).toEqual([
      'Row title',
      'Quantity',
      'Name',
      'Internal title field',
    ]);
    expect(
      mergePrioritizedColumnOrder(
        ['missing-a', 'quantity', 'missing-b', 'name'],
        ['name', 'quantity'],
        ['name', 'quantity'],
      ),
    ).toEqual(['missing-a', 'name', 'missing-b', 'quantity']);
  });
});
