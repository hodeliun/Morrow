import { describe, expect, it } from 'vitest';
import { applyCommand } from './commands';
import { databaseRowLabel, formulaValueText } from './database';
import { newPageMeta } from './model';
import type { PropDef, WorkspaceState } from './model';
import { relationDisplayLabel } from './relations';

const property = (id: string): PropDef => ({ id, name: id, type: 'text', options: [] });

describe('database display column', () => {
  it('labels row references and relations with a default, while honoring relation overrides', () => {
    const db = newPageMeta({ id: 'db', parentId: null, title: 'People', kind: 'database',
      database: { properties: [property('name'), property('nickname')], views: [], displayPropertyId: 'name' } });
    const row = newPageMeta({ id: 'row', parentId: 'db', title: 'Original title',
      properties: { name: 'Bea', nickname: 'B' } });
    const state: WorkspaceState = { pages: { db, row }, docs: {} };
    expect(databaseRowLabel(state, row)).toBe('Bea');
    expect(formulaValueText(property('result'), { formulaKind: 'row', id: 'row', databaseId: 'db' }, state)).toBe('Bea');
    const relation: PropDef = { id: 'link', name: 'link', type: 'relation', options: [],
      relation: { targetDatabaseId: 'db', multiple: false, isInverse: false,
        displayPropertyId: 'nickname', inversePropertyId: null, filters: [] } };
    expect(relationDisplayLabel(state, relation, row)).toBe('B');
    expect(relationDisplayLabel(state, { ...relation, relation: { ...relation.relation!, displayPropertyId: null } }, row)).toBe('Bea');
  });

  it('falls back to the title when the selected value is blank or its property is removed', () => {
    const db = newPageMeta({ id: 'db', parentId: null, title: 'People', kind: 'database',
      database: { properties: [property('name')], views: [], displayPropertyId: 'name' } });
    const row = newPageMeta({ id: 'row', parentId: 'db', title: 'Original title' });
    const state: WorkspaceState = { pages: { db, row }, docs: {} };
    expect(databaseRowLabel(state, row)).toBe('Original title');
    const result = applyCommand(state, { type: 'database.set', id: 'db', now: 2,
      database: { properties: [], views: [], displayPropertyId: 'name' } });
    if (!result.ok) throw new Error(result.error);
    expect(result.value.state.pages.db?.database?.displayPropertyId).toBeUndefined();
    expect(databaseRowLabel(result.value.state, result.value.state.pages.row!)).toBe('Original title');
  });
});
