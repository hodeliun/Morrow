import { describe, expect, it } from 'vitest';
import { applyCommand } from './commands';
import { databaseRowLabel, formulaValueText, valueOf } from './database';
import { newPageMeta } from './model';
import type { PropDef, WorkspaceState } from './model';
import { relationDisplayLabel } from './relations';

const property = (id: string): PropDef => ({ id, name: id, type: 'text', options: [] });

describe('database display column', () => {
  it('keeps the title projection separate from the database default and relation override', () => {
    const db = newPageMeta({
      id: 'db',
      parentId: null,
      title: 'People',
      kind: 'database',
      database: {
        properties: [property('name'), property('nickname')],
        views: [],
        titleAlias: 'Preferred name',
        displayPropertyId: 'nickname',
      },
    });
    const row = newPageMeta({
      id: 'row',
      parentId: 'db',
      title: 'Original title',
      properties: { name: 'Bea', nickname: 'B' },
    });
    const state: WorkspaceState = { pages: { db, row }, docs: {} };
    const relation: PropDef = {
      id: 'link',
      name: 'link',
      type: 'relation',
      options: [],
      relation: {
        targetDatabaseId: 'db',
        multiple: false,
        isInverse: false,
        displayPropertyId: 'name',
        inversePropertyId: null,
        filters: [],
      },
    };
    const inheritedRelation: PropDef = {
      ...relation,
      relation: { ...relation.relation!, displayPropertyId: null },
    };

    expect(valueOf(row, 'title', db.database!)).toBe('Original title');
    expect(row.properties).not.toHaveProperty('title');
    expect(databaseRowLabel(state, row)).toBe('B');
    expect(
      formulaValueText(property('result'), { formulaKind: 'row', id: 'row', databaseId: 'db' }, state),
    ).toBe('B');
    expect(relationDisplayLabel(state, relation, row)).toBe('Bea');
    expect(relationDisplayLabel(state, inheritedRelation, row)).toBe('B');

    const restored = applyCommand(state, {
      type: 'database.set',
      id: 'db',
      now: 2,
      database: { ...db.database!, displayPropertyId: null },
    });
    if (!restored.ok) throw new Error(restored.error);

    const nextState = restored.value.state;
    expect(nextState.pages.db?.database?.displayPropertyId).toBeUndefined();
    expect(nextState.pages.db?.database?.titleAlias).toBe('Preferred name');
    expect(nextState.pages.row?.id).toBe('row');
    expect(nextState.pages.row?.title).toBe('Original title');
    expect(nextState.pages.row?.properties).toEqual({ name: 'Bea', nickname: 'B' });
    expect(databaseRowLabel(nextState, nextState.pages.row!)).toBe('Original title');
    expect(relationDisplayLabel(nextState, relation, nextState.pages.row!)).toBe('Bea');
    expect(relationDisplayLabel(nextState, inheritedRelation, nextState.pages.row!)).toBe('Original title');
  });

  it('falls back to the title when the selected value is blank or its property is removed', () => {
    const db = newPageMeta({
      id: 'db',
      parentId: null,
      title: 'People',
      kind: 'database',
      database: { properties: [property('name')], views: [], displayPropertyId: 'name' },
    });
    const row = newPageMeta({ id: 'row', parentId: 'db', title: 'Original title' });
    const state: WorkspaceState = { pages: { db, row }, docs: {} };
    expect(databaseRowLabel(state, row)).toBe('Original title');
    const result = applyCommand(state, {
      type: 'database.set',
      id: 'db',
      now: 2,
      database: { properties: [], views: [], displayPropertyId: 'name' },
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.value.state.pages.db?.database?.displayPropertyId).toBeUndefined();
    expect(databaseRowLabel(result.value.state, result.value.state.pages.row!)).toBe('Original title');
  });
});
