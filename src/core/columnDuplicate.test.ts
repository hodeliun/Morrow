import { describe, expect, it } from 'vitest';
import { applyCommand } from './commands';
import { planColumnDuplicate, planColumnDuplicateUndo, snapshotColumnDuplicate } from './columnDuplicate';
import { newPageMeta } from './model';
import type { DatabaseDef, PropDef, WorkspaceState } from './model';

const prop = (id: string, type: PropDef['type'] = 'number', extra: Partial<PropDef> = {}): PropDef => ({
  id, name: id, type, options: [], ...extra,
});

function fixture(property: PropDef, values: Record<string, number | string | string[] | null> = {}): WorkspaceState {
  const database: DatabaseDef = {
    properties: [property],
    views: [{ id: 'view', name: 'Table', type: 'table', filters: [], sorts: [], groupBy: null,
      dateProp: null, hidden: [], order: [property.id] }],
  };
  const db = newPageMeta({ id: 'db', parentId: null, title: 'Data', kind: 'database', database });
  const row = newPageMeta({ id: 'row', parentId: 'db', title: 'One', properties: values });
  return { pages: { db, row }, docs: {} };
}

function apply(state: WorkspaceState, commands: NonNullable<ReturnType<typeof planColumnDuplicate>>['commands']) {
  return commands.reduce((current, command) => {
    const result = applyCommand(current, command);
    if (!result.ok) throw new Error(result.error);
    return result.value.state;
  }, state);
}

describe('column duplication', () => {
  it('copies formatting and sequence settings without copying existing values', () => {
    const state = fixture(prop('amount', 'number', {
      format: { precision: 2 }, description: 'Currency amount',
      fillMode: 'default', defaultSequence: { start: 1, increment: 2 }, sequenceNext: 9,
    }), { amount: 7 });
    const plan = planColumnDuplicate(state, 'db', 'amount', 'copy', false, 10, '(copy)')!;
    const next = apply(state, plan.commands);
    expect(next.pages.db?.database?.properties.map((item) => item.id)).toEqual(['amount', 'copy']);
    expect(next.pages.db?.database?.views[0]?.order).toEqual(['amount', 'copy']);
    expect(next.pages.db?.database?.properties[1]).toMatchObject({
      name: 'amount (copy)', description: 'Currency amount', format: { precision: 2 }, sequenceNext: 1,
    });
    expect(next.pages.row?.properties).toEqual({ amount: 7 });
    expect(state.pages.db?.database?.properties).toHaveLength(1);
  });

  it('copies values under a distinct property ID and chooses a unique name', () => {
    const state = fixture(prop('amount', 'number', { format: { precision: 2 } }), { amount: 7 });
    const first = planColumnDuplicate(state, 'db', 'amount', 'copy', true, 10, '(copy)')!;
    const once = apply(state, first.commands);
    const second = planColumnDuplicate(once, 'db', 'amount', 'copy2', true, 11, '(copy)')!;
    const twice = apply(once, second.commands);
    expect(twice.pages.row?.properties).toEqual({ amount: 7, copy: 7, copy2: 7 });
    expect(twice.pages.db?.database?.properties.map((item) => item.name)).toEqual([
      'amount', 'amount (copy) 2', 'amount (copy)',
    ]);
  });

  it('keeps formula bindings aimed at the original column and rejects inverse relations', () => {
    const formula = prop('result', 'formula', {
      formula: 'thisRow.amount',
      formulaBindings: [{ kind: 'property', source: 'amount', start: 8, end: 14, databaseId: 'db', propertyId: 'amount' }],
    });
    const plan = planColumnDuplicate(fixture(formula), 'db', 'result', 'copy', true, 10, '(copy)')!;
    expect(plan.property.formulaBindings?.[0]).toMatchObject({ propertyId: 'amount' });
    expect(plan.commands).toHaveLength(1);

    const inverse = prop('related', 'relation', {
      relation: { targetDatabaseId: 'other', multiple: true, isInverse: true,
        displayPropertyId: null, inversePropertyId: 'source', filters: [] },
    });
    expect(planColumnDuplicate(fixture(inverse), 'db', 'related', 'copy', false, 10, '(copy)')).toBeNull();
  });

  it('undoes an untouched copy without leaving archived YAML and rejects undo after editing it', () => {
    const state = fixture(prop('amount'), { amount: 7 });
    const plan = planColumnDuplicate(state, 'db', 'amount', 'copy', true, 10, '(copy)')!;
    const copied = apply(state, plan.commands);
    const snapshot = snapshotColumnDuplicate(copied, 'db', 'copy')!;
    const undo = planColumnDuplicateUndo(copied, 'db', 'copy', snapshot, 11)!;
    const restored = apply(copied, undo);
    expect(restored.pages.db?.database?.properties.map((item) => item.id)).toEqual(['amount']);
    expect(restored.pages.row?.properties).toEqual({ amount: 7 });
    expect(restored.pages.row?.extra).toEqual(state.pages.row?.extra);

    const edited = { ...copied, pages: {
      ...copied.pages,
      row: { ...copied.pages.row!, properties: { ...copied.pages.row!.properties, copy: 9 } },
    } };
    expect(planColumnDuplicateUndo(edited, 'db', 'copy', snapshot, 12)).toBeNull();
  });
});
