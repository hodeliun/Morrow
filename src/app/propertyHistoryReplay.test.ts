import { describe, expect, it } from 'vitest';
import type { DatabaseDef, ViewDef } from '../core/model';
import { rebaseDatabaseHistory } from './propertyHistoryReplay';

function view(id: string, name: string): ViewDef {
  return {
    id,
    name,
    type: 'table',
    filters: [],
    sorts: [],
    groupBy: null,
    dateProp: null,
    hidden: [],
  };
}

function database(views: ViewDef[] = [view('view-a', 'View A'), view('view-b', 'View B')]): DatabaseDef {
  return {
    properties: [{ id: 'note', name: 'Note', type: 'text', options: [] }],
    views,
  };
}

describe('legacy database history rebasing', () => {
  it('inverts changed schema and view fields while keeping untouched current fields', () => {
    const before = database();
    const after: DatabaseDef = {
      ...before,
      properties: [...before.properties, { id: 'extra', name: 'Extra', type: 'text', options: [] }],
      views: before.views.map((item) => (item.id === 'view-a' ? { ...item, name: 'Changed by schema action' } : item)),
    };
    after.titleAlias = 'Changed by action';
    const current: DatabaseDef = {
      ...after,
      displayPropertyId: 'note',
      views: after.views.map((item) =>
        item.id === 'view-a'
          ? { ...item, search: 'later search' }
          : { ...item, name: 'Unrelated later view edit' },
      ),
    };

    expect(rebaseDatabaseHistory(current, after, before)).toEqual({
      ...current,
      properties: before.properties,
      titleAlias: undefined,
      views: [
        { ...before.views[0]!, search: 'later search' },
        { ...current.views[1]! },
      ],
    });
  });

  it('refuses to overwrite a later edit to a field changed by the legacy action', () => {
    const before = database();
    const after = {
      ...before,
      views: before.views.map((item) => (item.id === 'view-a' ? { ...item, name: 'Changed by action' } : item)),
    };
    const current = {
      ...after,
      views: after.views.map((item) => (item.id === 'view-a' ? { ...item, name: 'Changed later' } : item)),
    };

    expect(rebaseDatabaseHistory(current, after, before)).toBeNull();
  });

  it('requires the expected view membership and order before rebasing', () => {
    const before = database();
    const after = { ...before, views: [...before.views, view('view-c', 'Created by action')] };
    const current = { ...after, views: [after.views[1]!, after.views[0]!, after.views[2]!] };

    expect(rebaseDatabaseHistory(current, after, before)).toBeNull();
  });

  it('preserves later view membership and ordering when the event changed only schema', () => {
    const before = database();
    const after: DatabaseDef = {
      ...before,
      properties: [...before.properties, { id: 'extra', name: 'Extra', type: 'text', options: [] }],
    };
    const currentViews = [
      { ...before.views[1]!, search: 'later search' },
      view('view-c', 'Later view'),
      { ...before.views[0]!, collapsed: true },
    ];
    const current = { ...after, views: currentViews };

    expect(rebaseDatabaseHistory(current, after, before)).toEqual({
      ...before,
      views: currentViews,
    });
  });

  it('keeps compatible non-overlapping legacy edits atomic across redo', () => {
    const before = database();
    const after: DatabaseDef = {
      ...before,
      properties: [...before.properties, { id: 'extra', name: 'Extra', type: 'text', options: [] }],
    };
    const current = { ...before, views: before.views.map((item) => ({ ...item, collapsed: true })) };

    expect(rebaseDatabaseHistory(current, before, after)).toEqual({ ...after, views: current.views });
  });
});
