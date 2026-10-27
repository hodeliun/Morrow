import { describe, expect, it } from 'vitest';
import { applyCommand } from './commands';
import { planDatabaseCopy } from './databaseCopy';
import { emptyDoc, emptyWorkspace, newPageMeta } from './model';
import type { DatabaseDef, NamedControlDef, WorkspaceState } from './model';

const schema: DatabaseDef = {
  properties: [
    { id: 'amount', name: 'Amount', type: 'number', options: [] },
    {
      id: 'related', name: 'Related', type: 'relation', options: [],
      defaultValue: 'row-a',
      relation: { targetDatabaseId: 'db', multiple: false, isInverse: false, displayPropertyId: null, inversePropertyId: null, filters: [] },
    },
    {
      id: 'related-many', name: 'Related many', type: 'relation', options: [],
      defaultValue: ['row-a', 'row-b'],
      relation: { targetDatabaseId: 'db', multiple: true, isInverse: false, displayPropertyId: null, inversePropertyId: null, filters: [] },
    },
    {
      id: 'external', name: 'External', type: 'relation', options: [],
      defaultValue: 'external-row',
      relation: { targetDatabaseId: 'external-db', multiple: false, isInverse: false, displayPropertyId: null, inversePropertyId: null, filters: [] },
    },
    {
      id: 'total', name: 'Total', type: 'formula', options: [], formula: 'Items.Amount.Sum()',
      formulaBindings: [{ kind: 'database', databaseId: 'db', start: 0, end: 5, source: 'Items' }],
    },
  ],
  views: [{ id: 'view', name: 'Table', type: 'table', filters: [], sorts: [], groupBy: null, dateProp: null, hidden: [] }],
};

function relationControl(
  id: string,
  targetDatabaseId: string,
  multiple: boolean,
  value: string | string[] | null,
  defaultValue: string | string[] | null,
): NamedControlDef {
  return {
    id,
    name: id,
    type: 'relation',
    value,
    defaultValue,
    options: [],
    relation: { targetDatabaseId, multiple },
  };
}

function fixture(): WorkspaceState {
  const host = newPageMeta({ id: 'host', parentId: null, title: 'Host' });
  const db = newPageMeta({
    id: 'db', parentId: null, title: 'Items', kind: 'database', database: schema,
    controls: [
      relationControl('single', 'db', false, 'row-a', 'row-b'),
      relationControl('multiple', 'db', true, ['row-a', 'row-b'], ['row-b']),
      relationControl('external-control', 'external-db', false, 'external-row', 'external-row'),
    ],
  });
  const first = newPageMeta({
    id: 'row-a', parentId: 'db', title: 'A',
    properties: { amount: 10, related: 'row-b', 'related-many': ['row-b', 'row-a'], external: 'external-row' },
    controls: [relationControl('row-control', 'db', false, 'row-b', 'row-a')],
  });
  const second = newPageMeta({
    id: 'row-b', parentId: 'db', title: 'B',
    properties: { amount: 20, related: 'row-a', 'related-many': ['row-a'], external: 'external-row' },
  });
  const externalDatabase = newPageMeta({
    id: 'external-db', parentId: null, title: 'External items', kind: 'database',
    database: { properties: [], views: [] },
  });
  const externalRow = newPageMeta({ id: 'external-row', parentId: 'external-db', title: 'External row' });
  return {
    ...emptyWorkspace(),
    pages: Object.fromEntries([host, db, first, second, externalDatabase, externalRow].map((page) => [page.id, page])),
    docs: Object.fromEntries([host, db, first, second, externalDatabase, externalRow].map((page) => [page.id, emptyDoc()])),
  };
}

describe('database copy planning', () => {
  it('copies the schema without rows and preserves the source', () => {
    const source = fixture();
    let next = 0;
    const plan = planDatabaseCopy(source, 'db', 'host', false, () => `new-${++next}`, 5, '(copy)')!;
    expect(plan.pages).toHaveLength(1);
    expect(plan.pages[0]).toMatchObject({ id: 'new-1', parentId: 'host', title: 'Items (copy)', kind: 'database' });
    expect(plan.pages[0]!.database!.properties.find((property) => property.id === 'total')!.formulaBindings![0]).toMatchObject({ databaseId: 'new-1' });
    expect(plan.pages[0]!.database!.properties.find((property) => property.id === 'related')!.relation!.targetDatabaseId).toBe('new-1');
    expect(plan.pages[0]!.database!.views[0]!.id).not.toBe('view');
    const inserted = applyCommand(source, { type: 'pages.insert', pages: plan.pages, docs: plan.docs });
    expect(inserted.ok).toBe(true);
    expect(source.pages.db!.database!.views[0]!.id).toBe('view');
  });

  it('clears selections for a self-relation when only the table structure is copied', () => {
    const source = fixture();
    let next = 0;
    const plan = planDatabaseCopy(source, 'db', 'host', false, () => `new-${++next}`, 5, '(copy)')!;
    const copied = plan.pages[0]!;
    const single = copied.controls.find((control) => control.id === 'single')!;
    const multiple = copied.controls.find((control) => control.id === 'multiple')!;
    const external = copied.controls.find((control) => control.id === 'external-control')!;
    const copiedSingleProperty = copied.database!.properties.find((property) => property.id === 'related')!;
    const copiedMultipleProperty = copied.database!.properties.find((property) => property.id === 'related-many')!;

    expect(single).toMatchObject({ value: null, defaultValue: null, relation: { targetDatabaseId: plan.databaseId } });
    expect(multiple).toMatchObject({ value: [], defaultValue: [], relation: { targetDatabaseId: plan.databaseId } });
    expect(external).toMatchObject({
      value: 'external-row', defaultValue: 'external-row', relation: { targetDatabaseId: 'external-db' },
    });
    expect(copiedSingleProperty).toMatchObject({ defaultValue: null, relation: { targetDatabaseId: plan.databaseId } });
    expect(copiedMultipleProperty).toMatchObject({ defaultValue: [], relation: { targetDatabaseId: plan.databaseId } });
    expect(copied.database!.properties.find((property) => property.id === 'external')!).toMatchObject({
      defaultValue: 'external-row', relation: { targetDatabaseId: 'external-db' },
    });
    expect(source.pages.db!.controls.find((control) => control.id === 'single')!.value).toBe('row-a');
  });

  it('copies rows, their values, and internal relation targets to new identities', () => {
    const source = fixture();
    let next = 0;
    const plan = planDatabaseCopy(source, 'db', 'host', true, () => `new-${++next}`, 5, '(copy)')!;
    const rows = plan.pages.filter((page) => page.parentId === plan.databaseId);
    expect(rows).toHaveLength(2);
    const a = rows.find((page) => page.title === 'A')!;
    const b = rows.find((page) => page.title === 'B')!;
    expect(a.properties).toMatchObject({ amount: 10, related: b.id, 'related-many': [b.id, a.id], external: 'external-row' });
    expect(b.properties).toMatchObject({ amount: 20, related: a.id, 'related-many': [a.id], external: 'external-row' });
    const copiedDatabase = plan.pages.find((page) => page.id === plan.databaseId)!;
    expect(copiedDatabase.controls.find((control) => control.id === 'single')).toMatchObject({
      value: a.id, defaultValue: b.id, relation: { targetDatabaseId: plan.databaseId, multiple: false },
    });
    expect(copiedDatabase.controls.find((control) => control.id === 'multiple')).toMatchObject({
      value: [a.id, b.id], defaultValue: [b.id], relation: { targetDatabaseId: plan.databaseId, multiple: true },
    });
    expect(copiedDatabase.controls.find((control) => control.id === 'external-control')).toMatchObject({
      value: 'external-row', defaultValue: 'external-row', relation: { targetDatabaseId: 'external-db' },
    });
    expect(copiedDatabase.database!.properties.find((property) => property.id === 'related')).toMatchObject({
      defaultValue: a.id, relation: { targetDatabaseId: plan.databaseId },
    });
    expect(copiedDatabase.database!.properties.find((property) => property.id === 'related-many')).toMatchObject({
      defaultValue: [a.id, b.id], relation: { targetDatabaseId: plan.databaseId },
    });
    expect(copiedDatabase.database!.properties.find((property) => property.id === 'external')).toMatchObject({
      defaultValue: 'external-row', relation: { targetDatabaseId: 'external-db' },
    });
    expect(a.controls[0]).toMatchObject({ value: b.id, defaultValue: a.id, relation: { targetDatabaseId: plan.databaseId } });
    expect(source.pages['row-a']!.properties.related).toBe('row-b');
    expect(source.pages.db!.controls.find((control) => control.id === 'single')!.defaultValue).toBe('row-b');
    expect(applyCommand(source, { type: 'pages.insert', pages: plan.pages, docs: plan.docs }).ok).toBe(true);
  });
});
