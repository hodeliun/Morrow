import { describe, expect, it } from 'vitest';
import { applyCommand } from './commands';
import type { Command } from './commands';
import {
  bindFormulaReferences,
  calendarDayForRow,
  formatDisplayValue,
  formatValue,
  groupRows,
  formulaResult,
  summarizeProperty,
  valueOf,
  visibleRows,
} from './database';
import { emptyWorkspace } from './model';
import type { DatabaseDef, FilterGroup, PropDef, PropValue, ViewDef, WorkspaceState } from './model';
import { childrenOf } from './tree';

const run = (state: WorkspaceState, command: Command): WorkspaceState => {
  const result = applyCommand(state, command);
  if (!result.ok) throw new Error(result.error);
  return result.value.state;
};

const view = (change: Partial<ViewDef> = {}): ViewDef => ({
  id: 'view',
  name: 'Table',
  type: 'table',
  filters: [],
  sorts: [],
  groupBy: null,
  dateProp: null,
  hidden: [],
  ...change,
});

function databaseState(properties: PropDef[]): WorkspaceState {
  return run(emptyWorkspace(), {
    type: 'page.create',
    id: 'db',
    parentId: null,
    now: 1,
    title: 'Records',
    kind: 'database',
    database: { properties, views: [view()] } satisfies DatabaseDef,
  });
}

function addRow(state: WorkspaceState, id: string, properties: Record<string, PropValue>) {
  return run(state, {
    type: 'page.create',
    id,
    parentId: 'db',
    now: 2,
    title: id,
    properties,
  });
}

describe('view filters, search and summaries', () => {
  const properties: PropDef[] = [
    { id: 'note', name: 'Note', type: 'text', options: [] },
    {
      id: 'status',
      name: 'Status',
      type: 'select',
      options: [
        { id: 'todo', name: 'To do', color: 'gray' },
        { id: 'done', name: 'Done', color: 'green' },
      ],
    },
    { id: 'score', name: 'Score', type: 'number', options: [] },
  ];

  it('combines rules within groups and groups with AND or OR, then searches and sorts', () => {
    let state = databaseState(properties);
    state = addRow(state, 'a', { note: 'Record A', status: 'done', score: 5 });
    state = addRow(state, 'b', { note: 'Record B', status: 'todo', score: 9 });
    state = addRow(state, 'c', { note: 'Record C', status: 'todo', score: 2 });
    const rows = childrenOf(state.pages, 'db');
    const groups: FilterGroup[] = [
      {
        id: 'g1',
        logic: 'and',
        filters: [
          { id: 'f1', prop: 'title', op: 'contains', value: 'a' },
          { id: 'f2', prop: 'score', op: 'gt', value: 3 },
        ],
      },
      {
        id: 'g2',
        logic: 'and',
        filters: [
          { id: 'f3', prop: 'status', op: 'is', value: 'todo' },
          { id: 'f4', prop: 'score', op: 'gt', value: 8 },
        ],
      },
    ];
    const database = state.pages.db!.database!;
    const either = visibleRows(
      rows,
      view({
        filterGroups: groups,
        filterGroupLogic: 'or',
        search: 'record',
        sorts: [{ prop: 'score', dir: 'desc' }],
      }),
      database,
      state,
    );
    expect(either.map((row) => row.id)).toEqual(['b', 'a']);
    expect(
      visibleRows(rows, view({ filterGroups: groups, filterGroupLogic: 'and' }), database, state),
    ).toEqual([]);
  });

  it('summarizes visible numeric values and exposes formula failures', () => {
    let state = databaseState([
      { id: 'score', name: 'Score', type: 'number', options: [] },
      { id: 'broken', name: 'Broken', type: 'formula', options: [], formula: 'MissingField + 1' },
    ]);
    state = addRow(state, 'a', { score: 2 });
    state = addRow(state, 'b', { score: 4 });
    const database = state.pages.db!.database!;
    const rows = childrenOf(state.pages, 'db');
    expect(summarizeProperty(rows, database.properties[0]!, 'sum', database, state)).toEqual({
      value: 6,
      error: null,
    });
    expect(summarizeProperty(rows, database.properties[1]!, 'sum', database, state).error).toContain(
      'MissingField',
    );
  });
});

describe('localized display values', () => {
  it('localizes checkbox and mixed formula booleans only in the display formatter', () => {
    const checkbox: PropDef = { id: 'done', name: 'Done', type: 'checkbox', options: [] };
    const formula: PropDef = { id: 'flags', name: 'Flags', type: 'formula', options: [] };
    expect(formatValue(checkbox, true)).toBe('Yes');
    expect(formatDisplayValue(checkbox, true, 'pt')).toBe('Sim');
    expect(formatDisplayValue(checkbox, false, 'pt')).toBe('Não');
    expect(formatDisplayValue(formula, 'Yes, No', 'pt-BR')).toBe('Sim, Não');
    expect(formatDisplayValue(formula, 'Yes, No', 'es')).toBe('Sí, No');
  });
});

describe('calculated grouping and dates', () => {
  it('groups calculated select and multi-select values in option order and reuses option colors', () => {
    const options = [
      { id: 'todo', name: 'To do', color: 'gray' as const },
      { id: 'done', name: 'Done', color: 'green' as const },
    ];
    const properties: PropDef[] = [
      { id: 'sourceStatus', name: 'SourceStatus', type: 'select', options },
      {
        id: 'status',
        name: 'Status',
        type: 'select',
        options,
        fillMode: 'calculated',
        formula: 'ThisRow.SourceStatus',
      },
      { id: 'sourceTags', name: 'SourceTags', type: 'multiSelect', options },
      {
        id: 'tags',
        name: 'Tags',
        type: 'multiSelect',
        options,
        fillMode: 'calculated',
        formula: 'ThisRow.SourceTags',
      },
      { id: 'sourceDate', name: 'SourceDate', type: 'date', options: [] },
      {
        id: 'computedDate',
        name: 'Computed date',
        type: 'formula',
        options: [],
        formula: 'ThisRow.SourceDate',
      },
    ];
    let state = databaseState(properties);
    let database = state.pages.db!.database!;
    database = {
      ...database,
      properties: database.properties.map((prop) =>
        prop.id === 'status'
          ? { ...prop, formulaBindings: bindFormulaReferences(prop.formula!, 'db', state) }
          : prop.id === 'tags'
            ? { ...prop, formulaBindings: bindFormulaReferences(prop.formula!, 'db', state) }
            : prop.id === 'computedDate'
              ? { ...prop, formulaBindings: bindFormulaReferences(prop.formula!, 'db', state) }
              : prop,
      ),
    };
    state = run(state, { type: 'database.set', id: 'db', database, now: 3 });
    state = addRow(state, 'first', {
      sourceStatus: 'done',
      sourceTags: ['todo', 'done'],
      sourceDate: '2026-10-26',
    });
    state = addRow(state, 'second', { sourceStatus: 'todo', sourceTags: ['todo'], sourceDate: '2026-10-27' });
    database = state.pages.db!.database!;
    const rows = childrenOf(state.pages, 'db');
    expect(
      formulaResult(
        rows[0]!,
        database.properties.find((prop) => prop.id === 'status')!,
        database,
        0,
        state,
      ),
    ).toEqual({ value: 'done', error: null });
    const status = groupRows(rows, 'status', database, state);
    expect(status.map((group) => [group.key, group.color, group.rows.map((row) => row.id)])).toEqual([
      [null, 'gray', []],
      ['todo', 'gray', ['second']],
      ['done', 'green', ['first']],
    ]);
    const tags = groupRows(rows, 'tags', database, state);
    expect(tags[1]!.rows.map((row) => row.id)).toEqual(['first', 'second']);
    expect(tags[2]!.rows.map((row) => row.id)).toEqual(['first']);
    const dateProp = database.properties.find((prop) => prop.id === 'computedDate')!;
    expect(valueOf(rows[0]!, dateProp.id, database, state)).toBe('2026-10-26');
    expect(calendarDayForRow(rows[0]!, dateProp, database, state)).toBe('2026-10-26');
  });
});
