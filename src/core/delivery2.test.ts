import { describe, expect, it } from 'vitest';
import {
  summarizeProperty,
  conditionalFormatForRow,
  conditionalFormatForCell,
} from './database';
import { normalizeDatabase } from './migrations';
import { managedFrontmatter, composeFrontmatter, renderPageText, readPageText } from './vault/pageFile';
import type { DatabaseDef, PageMeta, PropDef, PropValue, WorkspaceState } from './model';

function testState(props: PropDef[], rowsData: Array<{ id: string; title: string; values: Record<string, PropValue> }>): {
  database: DatabaseDef;
  rows: PageMeta[];
  state: WorkspaceState;
} {
  const dbPageId = 'test-db';
  const database: DatabaseDef = {
    properties: props,
    views: [
      {
        id: 'view-1',
        name: 'Default',
        type: 'table',
        filters: [],
        sorts: [],
        groupBy: null,
        dateProp: null,
        hidden: [],
      },
    ],
  };

  const pages: Record<string, PageMeta> = {
    [dbPageId]: {
      id: dbPageId,
      parentId: null,
      title: 'Test DB',
      icon: null,
      kind: 'database',
      order: 0,
      createdAt: 1000,
      updatedAt: 1000,
      trashedAt: null,
      favorite: false,
      dailyDate: null,
      lastOpenedAt: null,
      tags: [],
      controls: [],
      properties: {},
      extra: {},
      database,
      cover: null,
      coverPosition: 50,
      noteStyle: null,
      encrypted: false,
    },
  };

  const rows: PageMeta[] = rowsData.map((data, index) => {
    const row: PageMeta = {
      id: data.id,
      parentId: dbPageId,
      title: data.title,
      icon: null,
      kind: 'page',
      order: index,
      createdAt: 1000 + index,
      updatedAt: 1000 + index,
      trashedAt: null,
      favorite: false,
      dailyDate: null,
      lastOpenedAt: null,
      tags: [],
      controls: [],
      properties: data.values,
      extra: {},
      database: null,
      cover: null,
      coverPosition: 50,
      noteStyle: null,
      encrypted: false,
    };
    pages[data.id] = row;
    return row;
  });

  const state: WorkspaceState = { pages, docs: {} };

  return { database, rows, state };
}

describe('Delivery 2: Column Summaries & Calculations (#39)', () => {
  const scoreProp: PropDef = { id: 'score', name: 'Score', type: 'number', options: [] };
  const dateProp: PropDef = { id: 'date', name: 'Due Date', type: 'date', options: [] };
  const doneProp: PropDef = { id: 'done', name: 'Done', type: 'checkbox', options: [] };
  const tagProp: PropDef = { id: 'tag', name: 'Tag', type: 'select', options: [] };

  it('calculates numeric sum, average, min, max, range, and median correctly', () => {
    const { database, rows, state } = testState([scoreProp], [
      { id: '1', title: 'Row 1', values: { score: 10 } },
      { id: '2', title: 'Row 2', values: { score: 20 } },
      { id: '3', title: 'Row 3', values: { score: 30 } },
      { id: '4', title: 'Row 4', values: { score: 40 } },
    ]);

    expect(summarizeProperty(rows, scoreProp, 'sum', database, state)).toEqual({ value: 100, error: null });
    expect(summarizeProperty(rows, scoreProp, 'average', database, state)).toEqual({ value: 25, error: null });
    expect(summarizeProperty(rows, scoreProp, 'min', database, state)).toEqual({ value: 10, error: null });
    expect(summarizeProperty(rows, scoreProp, 'max', database, state)).toEqual({ value: 40, error: null });
    expect(summarizeProperty(rows, scoreProp, 'range', database, state)).toEqual({ value: 30, error: null });
    // Even number of elements: median of [10, 20, 30, 40] is (20 + 30) / 2 = 25
    expect(summarizeProperty(rows, scoreProp, 'median', database, state)).toEqual({ value: 25, error: null });

    // Odd number of elements
    const { rows: oddRows } = testState([scoreProp], [
      { id: '1', title: 'Row 1', values: { score: 5 } },
      { id: '2', title: 'Row 2', values: { score: 15 } },
      { id: '3', title: 'Row 3', values: { score: 100 } },
    ]);
    expect(summarizeProperty(oddRows, scoreProp, 'median', database, state)).toEqual({ value: 15, error: null });
  });

  it('treats 0 as a valid filled numeric value and handles empty set without NaN', () => {
    const { database, rows, state } = testState([scoreProp], [
      { id: '1', title: 'Row 1', values: { score: 0 } },
      { id: '2', title: 'Row 2', values: { score: 10 } },
      { id: '3', title: 'Row 3', values: { score: null } },
    ]);

    expect(summarizeProperty(rows, scoreProp, 'sum', database, state)).toEqual({ value: 10, error: null });
    expect(summarizeProperty(rows, scoreProp, 'average', database, state)).toEqual({ value: 5, error: null });
    expect(summarizeProperty(rows, scoreProp, 'min', database, state)).toEqual({ value: 0, error: null });
    expect(summarizeProperty(rows, scoreProp, 'countValues', database, state)).toEqual({ value: 2, error: null });
    expect(summarizeProperty(rows, scoreProp, 'countEmpty', database, state)).toEqual({ value: 1, error: null });

    // Empty rows set
    expect(summarizeProperty([], scoreProp, 'sum', database, state)).toEqual({ value: null, error: null });
    expect(summarizeProperty([], scoreProp, 'average', database, state)).toEqual({ value: null, error: null });
    expect(summarizeProperty([], scoreProp, 'median', database, state)).toEqual({ value: null, error: null });
    expect(summarizeProperty([], scoreProp, 'range', database, state)).toEqual({ value: null, error: null });
    expect(summarizeProperty([], scoreProp, 'percentEmpty', database, state)).toEqual({ value: null, error: null });
  });

  it('calculates counts, unique values, and percentages', () => {
    const { database, rows, state } = testState([tagProp], [
      { id: '1', title: 'Row 1', values: { tag: 'apple' } },
      { id: '2', title: 'Row 2', values: { tag: 'banana' } },
      { id: '3', title: 'Row 3', values: { tag: 'apple' } },
      { id: '4', title: 'Row 4', values: { tag: null } },
    ]);

    expect(summarizeProperty(rows, tagProp, 'count', database, state)).toEqual({ value: 4, error: null });
    expect(summarizeProperty(rows, tagProp, 'countValues', database, state)).toEqual({ value: 3, error: null });
    expect(summarizeProperty(rows, tagProp, 'countUnique', database, state)).toEqual({ value: 2, error: null });
    expect(summarizeProperty(rows, tagProp, 'countEmpty', database, state)).toEqual({ value: 1, error: null });
    expect(summarizeProperty(rows, tagProp, 'percentEmpty', database, state)).toEqual({ value: 25, error: null });
    expect(summarizeProperty(rows, tagProp, 'percentNotEmpty', database, state)).toEqual({ value: 75, error: null });
  });

  it('calculates checkbox checked, unchecked, and percentChecked (treating false as filled)', () => {
    const { database, rows, state } = testState([doneProp], [
      { id: '1', title: 'Row 1', values: { done: true } },
      { id: '2', title: 'Row 2', values: { done: false } },
      { id: '3', title: 'Row 3', values: { done: true } },
      { id: '4', title: 'Row 4', values: { done: false } },
    ]);

    expect(summarizeProperty(rows, doneProp, 'checked', database, state)).toEqual({ value: 2, error: null });
    expect(summarizeProperty(rows, doneProp, 'unchecked', database, state)).toEqual({ value: 2, error: null });
    expect(summarizeProperty(rows, doneProp, 'percentChecked', database, state)).toEqual({ value: 50, error: null });
    // False is filled, so countValues is 4 and countEmpty is 0
    expect(summarizeProperty(rows, doneProp, 'countValues', database, state)).toEqual({ value: 4, error: null });
    expect(summarizeProperty(rows, doneProp, 'countEmpty', database, state)).toEqual({ value: 0, error: null });
  });

  it('calculates min, max, and range (in days) for date properties', () => {
    const { database, rows, state } = testState([dateProp], [
      { id: '1', title: 'Row 1', values: { date: '2026-10-01' } },
      { id: '2', title: 'Row 2', values: { date: '2026-10-15' } },
      { id: '3', title: 'Row 3', values: { date: '2026-10-05' } },
    ]);

    expect(summarizeProperty(rows, dateProp, 'min', database, state)).toEqual({ value: '2026-10-01', error: null });
    expect(summarizeProperty(rows, dateProp, 'max', database, state)).toEqual({ value: '2026-10-15', error: null });
    expect(summarizeProperty(rows, dateProp, 'range', database, state)).toEqual({ value: 14, error: null });
  });
});

describe('Delivery 2: Conditional Formatting with Formulas & Custom Colors (#38)', () => {
  const scoreProp: PropDef = { id: 'score', name: 'Score', type: 'number', options: [] };
  const statusProp: PropDef = { id: 'status', name: 'Status', type: 'text', options: [] };

  it('matches simple criteria rules for cell and row', () => {
    const { database, rows, state } = testState([scoreProp, statusProp], [
      { id: '1', title: 'High', values: { score: 100, status: 'active' } },
      { id: '2', title: 'Low', values: { score: 10, status: 'pending' } },
    ]);

    const rowRule = {
      id: 'rule-1',
      prop: 'score',
      op: 'gt' as const,
      value: 50,
      scope: 'row' as const,
      color: 'green' as const,
    };

    expect(conditionalFormatForRow(rows[0]!, [rowRule], database, state)).toBe(rowRule);
    expect(conditionalFormatForRow(rows[1]!, [rowRule], database, state)).toBeNull();

    const cellRule = {
      id: 'rule-2',
      prop: 'status',
      op: 'is' as const,
      value: 'active',
      scope: 'cell' as const,
      color: '#34d399' as const,
    };
    expect(conditionalFormatForCell(rows[0]!, 'status', [cellRule], database, state)).toBe(cellRule);
    expect(conditionalFormatForCell(rows[0]!, 'score', [cellRule], database, state)).toBeNull();
  });

  it('evaluates boolean formulas with thisRow context and custom hex colors', () => {
    const { database, rows, state } = testState([scoreProp], [
      { id: '1', title: 'Pass', values: { score: 85 } },
      { id: '2', title: 'Fail', values: { score: 45 } },
    ]);

    const formulaRule = {
      id: 'rule-formula-1',
      prop: 'score',
      op: 'is' as const,
      value: null,
      scope: 'row' as const,
      color: '#22c55e' as const,
      mode: 'formula' as const,
      formula: 'Score >= 80',
    };

    expect(conditionalFormatForRow(rows[0]!, [formulaRule], database, state)).toBe(formulaRule);
    expect(conditionalFormatForRow(rows[1]!, [formulaRule], database, state)).toBeNull();
  });

  it('does not format when formula yields non-boolean, error, or null', () => {
    const { database, rows, state } = testState([scoreProp], [
      { id: '1', title: 'Row 1', values: { score: 85 } },
    ]);

    // Formula returning string, not boolean
    const stringRule = {
      id: 'rule-invalid-1',
      prop: 'score',
      op: 'is' as const,
      value: null,
      scope: 'row' as const,
      color: 'red' as const,
      mode: 'formula' as const,
      formula: '"hello"',
    };
    expect(conditionalFormatForRow(rows[0]!, [stringRule], database, state)).toBeNull();

    // Formula referencing nonexistent column
    const brokenRule = {
      id: 'rule-invalid-2',
      prop: 'score',
      op: 'is' as const,
      value: null,
      scope: 'row' as const,
      color: 'red' as const,
      mode: 'formula' as const,
      formula: 'NonExistentColumn > 10',
    };
    expect(conditionalFormatForRow(rows[0]!, [brokenRule], database, state)).toBeNull();
  });

  it('respects rule priority order (first matching rule wins)', () => {
    const { database, rows, state } = testState([scoreProp], [
      { id: '1', title: 'High', values: { score: 95 } },
    ]);

    const firstRule = {
      id: 'rule-1',
      prop: 'score',
      op: 'gt' as const,
      value: 90,
      scope: 'row' as const,
      color: 'green' as const,
    };
    const secondRule = {
      id: 'rule-2',
      prop: 'score',
      op: 'gt' as const,
      value: 50,
      scope: 'row' as const,
      color: 'yellow' as const,
    };

    expect(conditionalFormatForRow(rows[0]!, [firstRule, secondRule], database, state)).toBe(firstRule);
  });
});

describe('Delivery 2: View Presentation, hideTitle, and collapsed (#28, #29)', () => {
  it('migrates and preserves hideTitle, collapsed, expanded summaries, and hex conditional rules', () => {
    const rawView = {
      id: 'view-1',
      name: 'Custom View',
      type: 'table',
      hideTitle: true,
      collapsed: true,
      summaries: {
        score: 'median',
        done: 'percentChecked',
      },
      conditionalFormats: [
        {
          id: 'cf-1',
          prop: 'score',
          op: 'is',
          value: null,
          scope: 'row',
          color: '#10b981',
          mode: 'formula',
          formula: 'Score > 50',
        },
      ],
    };

    const rawPage = {
      id: 'db-1',
      title: 'Database with presentation',
      kind: 'database',
      database: {
        properties: [{ id: 'score', name: 'Score', type: 'number' }],
        views: [rawView],
      },
    };

    const migrated = normalizeDatabase(rawPage.database);
    const view = migrated?.views[0];
    expect(view).toBeDefined();
    expect(view?.hideTitle).toBe(true);
    expect(view?.collapsed).toBe(true);
    expect(view?.summaries?.score).toBe('median');
    expect(view?.summaries?.done).toBe('percentChecked');
    expect(view?.conditionalFormats?.[0]?.color).toBe('#10b981');
    expect(view?.conditionalFormats?.[0]?.mode).toBe('formula');
    expect(view?.conditionalFormats?.[0]?.formula).toBe('Score > 50');

        // Frontmatter serialization preserves hideTitle and collapsed
    const dummyPage: PageMeta = {
      id: 'db-1',
      parentId: null,
      title: 'Database with presentation',
      icon: null,
      kind: 'database',
      order: 0,
      createdAt: 1000,
      updatedAt: 1000,
      trashedAt: null,
      favorite: false,
      dailyDate: null,
      lastOpenedAt: null,
      tags: [],
      controls: [],
      properties: {},
      extra: {},
      database: migrated,
      cover: null,
      coverPosition: 50,
      noteStyle: null,
      encrypted: false,
    };
    const testStateObj: WorkspaceState = { pages: { [dummyPage.id]: dummyPage }, docs: {} };
    const frontmatter = managedFrontmatter(dummyPage, 'Database with presentation', null, testStateObj);
    const dbYaml = frontmatter.get('database') as Record<string, unknown> | undefined;
    const viewsYaml = (dbYaml as { views?: Array<Record<string, unknown>> })?.views;
    expect(viewsYaml?.[0]?.hideTitle).toBe(true);
    expect(viewsYaml?.[0]?.collapsed).toBe(true);

    // Markdown roundtrip
    const fullFrontmatter = composeFrontmatter(frontmatter, {}, null);
    const rendered = renderPageText(fullFrontmatter, null, '');
    const parsed = readPageText(rendered);
    const roundtripDb = parsed.database;
    expect(roundtripDb?.views[0]?.hideTitle).toBe(true);
    expect(roundtripDb?.views[0]?.collapsed).toBe(true);
  });
});
