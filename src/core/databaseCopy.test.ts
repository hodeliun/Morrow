import { describe, expect, it } from 'vitest';
import { applyCommand } from './commands';
import { planDatabaseCopy } from './databaseCopy';
import { emptyDoc, emptyWorkspace, newPageMeta } from './model';
import type { DatabaseDef, WorkspaceState } from './model';

const schema: DatabaseDef = {
  properties: [
    { id: 'amount', name: 'Amount', type: 'number', options: [] },
    {
      id: 'related', name: 'Related', type: 'relation', options: [],
      relation: { targetDatabaseId: 'db', multiple: false, isInverse: false, displayPropertyId: null, inversePropertyId: null, filters: [] },
    },
    {
      id: 'total', name: 'Total', type: 'formula', options: [], formula: 'Items.Amount.Sum()',
      formulaBindings: [{ kind: 'database', databaseId: 'db', start: 0, end: 5, source: 'Items' }],
    },
  ],
  views: [{ id: 'view', name: 'Table', type: 'table', filters: [], sorts: [], groupBy: null, dateProp: null, hidden: [] }],
};

function fixture(): WorkspaceState {
  const host = newPageMeta({ id: 'host', parentId: null, title: 'Host' });
  const db = newPageMeta({ id: 'db', parentId: null, title: 'Items', kind: 'database', database: schema });
  const first = newPageMeta({ id: 'row-a', parentId: 'db', title: 'A', properties: { amount: 10, related: 'row-b' } });
  const second = newPageMeta({ id: 'row-b', parentId: 'db', title: 'B', properties: { amount: 20, related: 'row-a' } });
  return {
    ...emptyWorkspace(),
    pages: Object.fromEntries([host, db, first, second].map((page) => [page.id, page])),
    docs: Object.fromEntries([host, db, first, second].map((page) => [page.id, emptyDoc()])),
  };
}

describe('database copy planning', () => {
  it('copies the schema without rows and preserves the source', () => {
    const source = fixture();
    let next = 0;
    const plan = planDatabaseCopy(source, 'db', 'host', false, () => `new-${++next}`, 5, '(copy)')!;
    expect(plan.pages).toHaveLength(1);
    expect(plan.pages[0]).toMatchObject({ id: 'new-1', parentId: 'host', title: 'Items (copy)', kind: 'database' });
    expect(plan.pages[0]!.database!.properties[2]!.formulaBindings![0]).toMatchObject({ databaseId: 'new-1' });
    expect(plan.pages[0]!.database!.properties[1]!.relation!.targetDatabaseId).toBe('new-1');
    expect(plan.pages[0]!.database!.views[0]!.id).not.toBe('view');
    const inserted = applyCommand(source, { type: 'pages.insert', pages: plan.pages, docs: plan.docs });
    expect(inserted.ok).toBe(true);
    expect(source.pages.db!.database!.views[0]!.id).toBe('view');
  });

  it('copies rows, their values, and internal relation targets to new identities', () => {
    const source = fixture();
    let next = 0;
    const plan = planDatabaseCopy(source, 'db', 'host', true, () => `new-${++next}`, 5, '(copy)')!;
    const rows = plan.pages.filter((page) => page.parentId === plan.databaseId);
    expect(rows).toHaveLength(2);
    const a = rows.find((page) => page.title === 'A')!;
    const b = rows.find((page) => page.title === 'B')!;
    expect(a.properties).toMatchObject({ amount: 10, related: b.id });
    expect(b.properties).toMatchObject({ amount: 20, related: a.id });
    expect(source.pages['row-a']!.properties.related).toBe('row-b');
    expect(applyCommand(source, { type: 'pages.insert', pages: plan.pages, docs: plan.docs }).ok).toBe(true);
  });
});
