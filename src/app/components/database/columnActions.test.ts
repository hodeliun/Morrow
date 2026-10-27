import { describe, expect, it } from 'vitest';
import type { DatabaseDef, PropDef, ViewDef } from '../../../core/model';
import { insertPropertyNear } from './columnActions';

const property = (id: string): PropDef => ({ id, name: id.toUpperCase(), type: 'text', options: [] });

const view: ViewDef = {
  id: 'view',
  name: 'Table',
  type: 'table',
  filters: [],
  sorts: [],
  groupBy: null,
  dateProp: null,
  hidden: [],
  order: ['c', 'a', 'b'],
};

describe('insertPropertyNear', () => {
  it('persists a new property next to its anchor in schema and view order', () => {
    const database: DatabaseDef = {
      properties: [property('a'), property('b'), property('c')],
      views: [view],
    };
    const next = insertPropertyNear(database, view, property('new'), 'b', 'before');

    expect(next?.database.properties.map((item) => item.id)).toEqual(['a', 'new', 'b', 'c']);
    expect(next?.view.order).toEqual(['c', 'a', 'new', 'b']);
    expect(database.properties.map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns no update when the selected column no longer exists', () => {
    const database: DatabaseDef = { properties: [property('a')], views: [view] };

    expect(insertPropertyNear(database, view, property('new'), 'missing', 'after')).toBeNull();
  });
});
