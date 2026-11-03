import { describe, expect, it } from 'vitest';
import type { DatabaseDef, PropDef, ViewDef } from '../../../core/model';
import {
  insertPropertyNear,
  moveColumnInView,
  movePropertyInViewOrder,
  orderedColumnIds,
} from './columnActions';

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
    expect(next?.view.order).toEqual(['title', 'c', 'a', 'new', 'b']);
    expect(database.properties.map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns no update when the selected column no longer exists', () => {
    const database: DatabaseDef = { properties: [property('a')], views: [view] };

    expect(insertPropertyNear(database, view, property('new'), 'missing', 'after')).toBeNull();
  });

  it('keeps title placement and opaque IDs while inserting beside a property', () => {
    const database: DatabaseDef = {
      properties: [property('a'), property('b'), property('c')],
      views: [],
    };
    const sourceView = { ...view, order: ['a', 'future-column', 'title', 'c', 'b'] };
    const next = insertPropertyNear(database, sourceView, property('new'), 'b', 'before');

    expect(next?.view.order).toEqual(['a', 'future-column', 'title', 'c', 'new', 'b']);
    expect(next?.view.order?.indexOf('title')).toBe(sourceView.order.indexOf('title'));
    expect(next?.view.order?.includes('future-column')).toBe(true);
    expect(database.properties.map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('view column order', () => {
  const database: DatabaseDef = {
    properties: [property('a'), property('b'), property('c')],
    views: [],
  };

  it('keeps the virtual title first for legacy views and honors an explicit title position', () => {
    expect(orderedColumnIds(database, { ...view, order: ['c', 'a'] })).toEqual(['title', 'c', 'a', 'b']);
    expect(orderedColumnIds(database, { ...view, order: ['c', 'title', 'a'] })).toEqual([
      'c',
      'title',
      'a',
      'b',
    ]);
  });

  it('moves a visible column without changing schema or hidden/opaque order slots', () => {
    const sourceView: ViewDef = {
      ...view,
      order: ['c', 'a', 'future-column', 'b'],
      hidden: ['a'],
    };
    const moved = moveColumnInView(database, sourceView, 'title', 'c', 'after');

    expect(moved?.order).toEqual(['c', 'title', 'a', 'future-column', 'b']);
    expect(moved?.hidden).toEqual(['a']);
    expect(database.properties.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(sourceView.order).toEqual(['c', 'a', 'future-column', 'b']);
    expect(new Set(moved?.order ?? []).size).toBe(moved?.order?.length);
  });

  it('supports independent views and returns no operation for a no-op or hidden target', () => {
    const firstView = { ...view, id: 'first', order: ['title', 'a', 'b', 'c'] };
    const secondView = { ...view, id: 'second', order: ['c', 'b', 'a', 'title'] };
    const moved = moveColumnInView(database, firstView, 'a', 'b', 'after');

    expect(moved?.order).toEqual(['title', 'b', 'a', 'c']);
    expect(secondView.order).toEqual(['c', 'b', 'a', 'title']);
    expect(moveColumnInView(database, firstView, 'a', 'a', 'before')).toBeNull();
    expect(moveColumnInView(database, { ...firstView, hidden: ['b'] }, 'a', 'b', 'after')).toBeNull();
  });

  it('moves properties from the settings list without resetting the title or opaque order slots', () => {
    const sourceView = {
      ...view,
      order: ['a', 'future-column', 'title', 'c', 'b'],
      hidden: ['c'],
    };
    const moved = movePropertyInViewOrder(database, sourceView, 'b', -1);

    expect(moved?.order).toEqual(['a', 'future-column', 'title', 'b', 'c']);
    expect(moved?.order?.indexOf('title')).toBe(sourceView.order?.indexOf('title'));
    expect(moved?.hidden).toEqual(['c']);
    expect(database.properties.map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });
});
