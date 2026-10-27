import { describe, expect, it } from 'vitest';
import { applyCommand } from './commands';
import {
  formatValue,
  matchesFilter,
  moveSelectOption,
  parseCellValue,
  tryConvertValue,
  valueOf,
} from './database';
import { emptyWorkspace } from './model';
import type { DatabaseDef, PropDef, WorkspaceState } from './model';
import { isValidDateKey, isValidDateTime, propertyValueError } from './typedValues';
import { readProperty, writeProperty } from './vault/pageFile';

function apply(state: WorkspaceState, command: Parameters<typeof applyCommand>[1]): WorkspaceState {
  const result = applyCommand(state, command);
  if (!result.ok) throw new Error(result.error);
  return result.value.state;
}

function checked(state: WorkspaceState, command: Parameters<typeof applyCommand>[1]) {
  return applyCommand(state, command);
}

function database(state: WorkspaceState, id: string, properties: PropDef[]): WorkspaceState {
  const next = apply(state, {
    type: 'page.create',
    id,
    parentId: null,
    now: 10,
    title: id,
    kind: 'database',
  });
  const db: DatabaseDef = { properties, views: [] };
  return apply(next, { type: 'database.set', id, database: db, now: 10 });
}

const prop = (id: string, name: string, type: PropDef['type'], more: Partial<PropDef> = {}): PropDef => ({
  id,
  name,
  type,
  options: [],
  ...more,
});

describe('typed scalar values', () => {
  it('moves ordered select choices without changing their identities', () => {
    const options = [
      { id: 'todo', name: 'To do', color: 'gray' as const },
      { id: 'doing', name: 'Doing', color: 'blue' as const },
      { id: 'done', name: 'Done', color: 'green' as const },
    ];
    expect(moveSelectOption(options, 1, -1).map((option) => option.id)).toEqual(['doing', 'todo', 'done']);
    expect(options.map((option) => option.id)).toEqual(['todo', 'doing', 'done']);
  });

  it('formats BRL and fractional percentages without changing their stored numbers', () => {
    const money = prop('money', 'Budget', 'currency', {
      format: { currency: 'BRL', locale: 'pt-BR', precision: 2 },
    });
    const percent = prop('share', 'Share', 'percent', { format: { locale: 'pt-BR', precision: 1 } });
    const number = prop('count', 'Count', 'number', { format: { locale: 'pt-BR', precision: 2 } });
    expect(formatValue(money, 1234.5).replace(/[\s\u00a0\u202f]/g, '')).toBe('R$1.234,50');
    expect(formatValue(percent, 0.25).replace(/[\s\u00a0\u202f]/g, '')).toBe('25,0%');
    expect(formatValue(number, 2)).toBe('2,00');
    expect(formatValue(number, 2.345)).toBe('2,35');
    expect(tryConvertValue(prop('n', 'Number', 'number'), percent, 25)).toEqual({ ok: true, value: 0.25 });
    expect(tryConvertValue(percent, prop('n', 'Number', 'number'), 0.25)).toEqual({ ok: true, value: 25 });
    expect(tryConvertValue(prop('raw', 'Raw', 'text'), prop('n', 'Amount', 'number'), 'R$ 1.234,56')).toEqual(
      {
        ok: true,
        value: 1234.56,
      },
    );
    expect(
      tryConvertValue(prop('raw', 'Raw', 'text'), prop('n', 'Amount', 'number'), 'abc123'),
    ).toMatchObject({
      ok: false,
    });
    expect(readProperty(money, 'R$ 1.234,56', () => 'option').value).toBe(1234.56);
  });

  it('blocks multiselect to single-select conversion when it would drop values', () => {
    const options = [
      { id: 'a', name: 'Alpha', color: 'gray' as const },
      { id: 'b', name: 'Beta', color: 'blue' as const },
    ];
    const multi = prop('tags', 'Tags', 'multiSelect', { options });
    const single = { ...multi, type: 'select' as const };
    expect(tryConvertValue(multi, single, ['a', 'b'])).toMatchObject({ ok: false });
    expect(tryConvertValue(multi, single, ['a'])).toEqual({ ok: true, value: 'a' });
  });

  it('rejects bad values before conversion and validates calendar dates and zoned datetimes', () => {
    const number = prop('n', 'Amount', 'number');
    const date = prop('d', 'Date', 'date');
    const datetime = prop('dt', 'Date time', 'datetime');
    expect(tryConvertValue(prop('t', 'Text', 'text'), number, 'not a number')).toMatchObject({ ok: false });
    expect(isValidDateKey('2024-02-29')).toBe(true);
    expect(isValidDateKey('2026-02-29')).toBe(false);
    expect(isValidDateKey('0099-02-28')).toBe(true);
    expect(isValidDateTime('2026-02-30T10:00:00Z')).toBe(false);
    expect(isValidDateTime('2026-01-02T10:00:00+14:30')).toBe(false);
    expect(propertyValueError(date, '2026-02-30')).toContain('real calendar date');
    expect(propertyValueError(datetime, '2026-01-02T10:00:00')).toContain('timezone');
    expect(propertyValueError(datetime, '2026-01-02T10:00:00-03:00')).toBeNull();
    expect(parseCellValue(datetime, '2026-02-30T10:00:00Z')).toBeNull();
    expect(parseCellValue(date, '2026-02-30')).toBeNull();
  });

  it('compares datetime filters as instants and exposes timestamp filters as dates', () => {
    const meeting = prop('meeting', 'Meeting', 'datetime');
    const created = prop('created-on', 'Created on', 'createdTime');
    let state = database(emptyWorkspace(), 'events', [meeting, created]);
    state = apply(state, {
      type: 'page.create',
      id: 'event',
      parentId: 'events',
      now: Date.parse('2026-01-01T03:00:00Z'),
      title: 'Event',
      properties: { meeting: '2026-01-01T03:00:00Z' },
    });
    const row = state.pages.event!;
    const db = state.pages.events!.database!;
    expect(
      matchesFilter(
        row,
        {
          id: 'meeting-filter',
          prop: meeting.id,
          op: 'is',
          value: '2026-01-01T00:00:00-03:00',
        },
        db,
        state,
      ),
    ).toBe(true);
    expect(
      matchesFilter(
        row,
        {
          id: 'created-filter',
          prop: created.id,
          op: 'is',
          value: row.createdAt,
        },
        db,
        state,
      ),
    ).toBe(true);
    expect(
      matchesFilter(
        row,
        {
          id: 'later-filter',
          prop: meeting.id,
          op: 'gt',
          value: '2025-12-31T23:00:00Z',
        },
        db,
        state,
      ),
    ).toBe(true);
  });

  it('keeps date-only values stable and displays datetime in the selected timezone', () => {
    const date = prop('d', 'Day', 'date', { format: { locale: 'en-US', dateStyle: 'full' } });
    const datetime = prop('dt', 'Meeting', 'datetime', {
      format: { locale: 'en-US', dateStyle: 'short', timeZone: 'America/Sao_Paulo' },
    });
    const zoned = prop('z', 'Zone', 'datetime', {
      format: { locale: 'en-US', timeStyle: 'short', timeZone: 'UTC' },
    });
    expect(formatValue(date, '2026-01-01')).toContain('January 1, 2026');
    expect(formatValue(datetime, '2026-01-01T03:00:00Z')).toContain('12:00 AM');
    expect(formatValue(zoned, '2026-01-01T03:00:00Z')).toContain('3:00 AM');
  });

  it('stores durations in seconds so a display-unit change preserves the amount', () => {
    const minutes = prop('duration', 'Elapsed', 'duration', {
      format: { locale: 'en-US', durationUnit: 'minutes' },
    });
    const hours = { ...minutes, format: { locale: 'en-US', durationUnit: 'hours' as const } };
    expect(formatValue(minutes, 5400)).toContain('90');
    expect(formatValue(hours, 5400)).toContain('1.5');
    expect(readProperty(minutes, 5400, () => 'option').value).toBe(5400);
    expect(writeProperty(hours, 5400)).toBe(5400);
  });
});

describe('creation defaults and calculated properties', () => {
  it('applies defaults only to new rows and lets explicit false, zero, and empty text win', () => {
    const properties = [
      prop('done', 'Done', 'checkbox', { fillMode: 'default', defaultValue: true }),
      prop('count', 'Count', 'number', { fillMode: 'default', defaultValue: 7 }),
      prop('note', 'Note', 'text', { fillMode: 'default', defaultValue: 'fallback' }),
      prop('tag', 'Tag', 'text', { fillMode: 'default', defaultValue: '' }),
    ];
    let state = database(emptyWorkspace(), 'tasks', properties);
    state = apply(state, {
      type: 'page.create',
      id: 'explicit',
      parentId: 'tasks',
      now: 20,
      title: 'Explicit values',
      properties: { done: false, count: 0, note: '' },
    });
    state = apply(state, {
      type: 'page.create',
      id: 'defaults',
      parentId: 'tasks',
      now: 21,
      title: 'Defaults',
    });
    expect(state.pages.explicit!.properties).toMatchObject({ done: false, count: 0, note: '' });
    expect(state.pages.defaults!.properties).toMatchObject({
      done: true,
      count: 7,
      note: 'fallback',
      tag: '',
    });

    const changed = {
      ...state.pages.tasks!.database!,
      properties: properties.map((item) => (item.id === 'count' ? { ...item, defaultValue: 42 } : item)),
    };
    state = apply(state, { type: 'database.set', id: 'tasks', database: changed, now: 22 });
    expect(state.pages.defaults!.properties.count).toBe(7);
    state = apply(state, { type: 'page.create', id: 'later', parentId: 'tasks', now: 23, title: 'Later' });
    expect(state.pages.later!.properties.count).toBe(42);
  });

  it('keeps calculated values typed, formatted, and read only', () => {
    const money = prop('money', 'Price', 'currency', {
      format: { locale: 'pt-BR', currency: 'BRL', precision: 2 },
    });
    const total = prop('total', 'Total', 'currency', {
      fillMode: 'calculated',
      formula: 'prop("Price") * 2',
      format: { locale: 'pt-BR', currency: 'BRL', precision: 2 },
    });
    let state = database(emptyWorkspace(), 'orders', [money, total]);
    state = apply(state, {
      type: 'page.create',
      id: 'order',
      parentId: 'orders',
      now: 20,
      properties: { money: 15.25 },
    });
    const row = state.pages.order!;
    expect(valueOf(row, 'total', state.pages.orders!.database!)).toBe(30.5);
    expect(
      formatValue(total, valueOf(row, 'total', state.pages.orders!.database!)).replace(
        /[\s\u00a0\u202f]/g,
        '',
      ),
    ).toBe('R$30,50');
    expect(writeProperty(total, 30.5)).toBeUndefined();
    expect(
      checked(state, { type: 'page.setProperties', id: 'order', now: 21, values: { total: 31 } }),
    ).toMatchObject({ ok: false });
  });

  it('lets a type change clear stored values when the destination becomes computed', () => {
    const amount = prop('amount', 'Amount', 'number');
    let state = database(emptyWorkspace(), 'items', [amount]);
    state = apply(state, {
      type: 'page.create',
      id: 'item',
      parentId: 'items',
      now: 20,
      title: 'Item',
      properties: { amount: 12 },
    });
    const db = state.pages.items!.database!;
    state = apply(state, {
      type: 'database.set',
      id: 'items',
      now: 21,
      database: {
        ...db,
        properties: [{ ...amount, type: 'createdTime' }],
      },
    });
    state = apply(state, {
      type: 'page.setProperties',
      id: 'item',
      now: 22,
      values: { amount: null },
    });
    expect(state.pages.item!.properties.amount).toBeUndefined();
    expect(
      checked(state, {
        type: 'page.setProperties',
        id: 'item',
        now: 23,
        values: { amount: 12 },
      }),
    ).toMatchObject({ ok: false });
  });
});

describe('relation creation constraints', () => {
  it('rejects IDs outside the target and honors single-valued inverses on creation', () => {
    const owner = prop('owner', 'Owner', 'relation', {
      relation: {
        targetDatabaseId: 'targets',
        multiple: false,
        isInverse: false,
        displayPropertyId: null,
        inversePropertyId: 'backref',
        filters: [],
      },
    });
    const backref = prop('backref', 'Backref', 'relation', {
      relation: {
        targetDatabaseId: 'sources',
        multiple: false,
        isInverse: true,
        displayPropertyId: null,
        inversePropertyId: 'owner',
        filters: [],
      },
    });
    let state = database(emptyWorkspace(), 'targets', [backref]);
    state = database(state, 'sources', [owner]);
    state = apply(state, {
      type: 'page.create',
      id: 'target',
      parentId: 'targets',
      now: 20,
      title: 'Target',
    });
    expect(
      checked(state, {
        type: 'page.create',
        id: 'bad',
        parentId: 'sources',
        now: 21,
        properties: { owner: 'missing' },
      }),
    ).toMatchObject({ ok: false });
    state = apply(state, {
      type: 'page.create',
      id: 'first',
      parentId: 'sources',
      now: 22,
      properties: { owner: 'target' },
    });
    expect(valueOf(state.pages.target!, 'backref', state.pages.targets!.database!, state)).toBe('first');
    expect(
      checked(state, {
        type: 'page.create',
        id: 'second',
        parentId: 'sources',
        now: 23,
        properties: { owner: 'target' },
      }),
    ).toMatchObject({ ok: false });

    const legacyRow = state.pages.first!;
    const withLegacyValue = {
      ...state,
      pages: {
        ...state.pages,
        first: { ...legacyRow, properties: { ...legacyRow.properties, owner: 'missing-target' } },
      },
    };
    const preserved = checked(withLegacyValue, {
      type: 'page.setFields',
      id: 'first',
      now: 24,
      properties: { owner: 'missing-target' },
      extra: legacyRow.extra,
    });
    expect(preserved.ok).toBe(true);
    expect(preserved.ok && preserved.value.state.pages.first!.properties.owner).toBe('missing-target');
    expect(
      checked(withLegacyValue, {
        type: 'page.setFields',
        id: 'first',
        now: 25,
        properties: { owner: 'another-missing-target' },
      }),
    ).toMatchObject({ ok: false });
  });
});
