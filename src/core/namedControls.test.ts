import { describe, expect, it } from 'vitest';
import { applyCommand } from './commands';
import type { Command } from './commands';
import { bindPageFormulaReferences, documentFormulaResult, formatValue, matchesFilter, rowsOf, visibleRows } from './database';
import { controlValueErrorInState } from './controls';
import { emptyWorkspace } from './model';
import { SCHEMA_VERSION } from './model';
import type { DocNode, NamedControlDef, PropDef, ViewDef, WorkspaceState } from './model';
import { normalizePage, readWorkspace } from './migrations';
import { markdownToDoc } from './markdown/parse';
import { docToMarkdown } from './markdown/serialize';
import { managedFrontmatter, readPageText, renderPageText } from './vault/pageFile';

function run(state: WorkspaceState, ...commands: Command[]): WorkspaceState {
  return commands.reduce((current, command) => {
    const result = applyCommand(current, command);
    if (!result.ok) throw new Error(result.error);
    return result.value.state;
  }, state);
}

const create = (id: string, parentId: string | null = null, extra: Partial<Command> = {}): Command =>
  ({ type: 'page.create', id, parentId, now: 1, title: id, ...extra }) as Command;

const control = (fields: Partial<NamedControlDef> & Pick<NamedControlDef, 'id' | 'name' | 'type'>): NamedControlDef => ({
  id: fields.id,
  name: fields.name,
  type: fields.type,
  value: fields.value ?? null,
  defaultValue: fields.defaultValue ?? null,
  options: fields.options ?? [],
  ...(fields.format ? { format: fields.format } : {}),
  ...(fields.relation ? { relation: fields.relation } : {}),
});

describe('named controls', () => {
  it('keeps false, zero, and empty values distinct from blank and preserves current value when renamed', () => {
    let state = run(emptyWorkspace(), create('page'));
    state = run(
      state,
      { type: 'page.control.configure', id: 'page', now: 2, control: control({ id: 'checked', name: 'Checked', type: 'checkbox', value: false, defaultValue: true }) },
      { type: 'page.control.configure', id: 'page', now: 3, control: control({ id: 'zero', name: 'Zero', type: 'number', value: 0, defaultValue: 1 }) },
      { type: 'page.control.configure', id: 'page', now: 4, control: control({ id: 'empty', name: 'Empty', type: 'text', value: '', defaultValue: 'default' }) },
    );
    expect(state.pages.page!.controls.map((item) => item.value)).toEqual([false, 0, '']);
    state = run(state, {
      type: 'page.control.configure', id: 'page', now: 5,
      control: control({ id: 'zero', name: 'Amount', type: 'number', value: 99, defaultValue: 2 }),
    });
    expect(state.pages.page!.controls.find((item) => item.id === 'zero')).toMatchObject({ name: 'Amount', value: 0, defaultValue: 2 });
    state = run(state, { type: 'page.control.reset', id: 'page', controlId: 'zero', now: 6 });
    expect(state.pages.page!.controls.find((item) => item.id === 'zero')?.value).toBe(2);
  });

  it('validates relation targets and rows against the selected database', () => {
    let state = run(emptyWorkspace(), create('authors', null, { kind: 'database' } as Partial<Command>), create('author', 'authors'), create('other'));
    const relation = control({
      id: 'authorControl', name: 'Author', type: 'relation', value: 'author', defaultValue: null,
      relation: { targetDatabaseId: 'authors', multiple: false },
    });
    state = run(state, { type: 'page.control.configure', id: 'other', control: relation, now: 2 });
    expect(state.pages.other!.controls[0]?.value).toBe('author');
    const multiple = control({
      id: 'authorsControl', name: 'Authors', type: 'relation', value: ['author'], defaultValue: [],
      relation: { targetDatabaseId: 'authors', multiple: true },
    });
    state = run(state, { type: 'page.control.configure', id: 'other', control: multiple, now: 3 });
    expect(state.pages.other!.controls.find((item) => item.id === 'authorsControl')?.value).toEqual(['author']);
    const invalid = applyCommand(state, {
      type: 'page.control.setValue', id: 'other', controlId: 'authorControl', value: 'other', now: 4,
    });
    expect(invalid.ok).toBe(false);
    const noTarget = applyCommand(state, {
      type: 'page.control.configure', id: 'other', now: 4,
      control: control({ id: 'broken', name: 'Broken', type: 'relation', value: null, defaultValue: null, relation: { targetDatabaseId: null, multiple: false } }),
    });
    expect(noTarget.ok).toBe(false);
    const unavailableTarget = {
      ...state,
      pages: { ...state.pages, authors: { ...state.pages.authors!, trashedAt: 5 } },
    };
    expect(controlValueErrorInState(relation, 'author', unavailableTarget)).toContain('available database');
    const unavailableRow = {
      ...state,
      pages: { ...state.pages, author: { ...state.pages.author!, trashedAt: 5 } },
    };
    expect(controlValueErrorInState(relation, 'author', unavailableRow)).toContain('rows in their selected database');
  });

  it('compares control filters without collapsing false, zero, or empty text', () => {
    const database = {
      properties: [
        { id: 'enabled', name: 'Enabled', type: 'checkbox' as const, options: [] },
        { id: 'amount', name: 'Amount', type: 'number' as const, options: [] },
        { id: 'note', name: 'Note', type: 'text' as const, options: [] },
      ],
      views: [],
    };
    let state = run(
      emptyWorkspace(),
      create('items', null, { kind: 'database', database } as Partial<Command>),
      create('row', 'items', { properties: { enabled: false, amount: 0, note: '' } } as Partial<Command>),
      create('summary'),
      { type: 'page.control.configure', id: 'summary', now: 2, control: control({ id: 'false', name: 'False', type: 'checkbox', value: false, defaultValue: true }) },
      { type: 'page.control.configure', id: 'summary', now: 2, control: control({ id: 'zero', name: 'Zero', type: 'number', value: 0, defaultValue: 1 }) },
      { type: 'page.control.configure', id: 'summary', now: 2, control: control({ id: 'empty', name: 'Empty', type: 'text', value: '', defaultValue: 'x' }) },
    );
    const row = state.pages.row!;
    const table = state.pages.items!.database!;
    const filter = (prop: string, controlId: string) => ({
      id: controlId, prop, op: 'is' as const, value: null,
      controlRef: { pageId: 'summary', controlId },
    });
    expect(matchesFilter(row, filter('enabled', 'false'), table, state)).toBe(true);
    expect(matchesFilter(row, filter('amount', 'zero'), table, state)).toBe(true);
    expect(matchesFilter(row, filter('note', 'empty'), table, state)).toBe(true);
    state = run(state, { type: 'page.control.setValue', id: 'summary', controlId: 'false', value: true, now: 3 });
    expect(matchesFilter(row, filter('enabled', 'false'), table, state)).toBe(false);
  });

  it('recalculates independent annual/monthly linked views and BRL totals, reopens them, and diagnoses deleted bindings', () => {
    const properties: PropDef[] = [
      { id: 'date', name: 'Date', type: 'date', options: [] },
      { id: 'amount', name: 'Amount', type: 'number', options: [] },
    ];
    let state = run(
      emptyWorkspace(),
      create('expenses', null, { kind: 'database', database: { properties, views: [] } } as Partial<Command>),
      create('summary'),
      create('one', 'expenses', { properties: { date: '2025-03-04', amount: 80 } } as Partial<Command>),
      create('two', 'expenses', { properties: { date: '2025-12-29', amount: 20 } } as Partial<Command>),
      create('three', 'expenses', { properties: { date: '2026-01-02', amount: 50 } } as Partial<Command>),
      {
        type: 'page.control.configure', id: 'summary', now: 2,
        control: control({ id: 'year', name: 'SelectedYear', type: 'number', value: 2025, defaultValue: 2025 }),
      },
      {
        type: 'page.control.configure', id: 'summary', now: 3,
        control: control({ id: 'month', name: 'SelectedMonth', type: 'number', value: 3, defaultValue: 1 }),
      },
    );
    const annualFilterFormula = 'Year(thisRow.Date) = SelectedYear';
    const monthlyFilterFormula = 'Year(thisRow.Date) = SelectedYear and Month(thisRow.Date) = SelectedMonth';
    const annualFilter = {
      id: 'annual-filter', prop: '$formula', op: 'is' as const, value: null,
      formula: annualFilterFormula,
      formulaBindings: bindPageFormulaReferences(annualFilterFormula, 'summary', state, 'expenses'),
    };
    const monthlyFilter = {
      id: 'monthly-filter', prop: '$formula', op: 'is' as const, value: null,
      formula: monthlyFilterFormula,
      formulaBindings: bindPageFormulaReferences(monthlyFilterFormula, 'summary', state, 'expenses'),
    };
    const annualView: ViewDef = { id: 'annual-view', name: 'Annual', type: 'table', filters: [annualFilter], sorts: [], groupBy: null, dateProp: null, hidden: [] };
    const monthlyView: ViewDef = { id: 'monthly-view', name: 'Monthly', type: 'table', filters: [monthlyFilter], sorts: [], groupBy: null, dateProp: null, hidden: [] };
    const annualSource = 'Expenses.filter(Year(CurrentValue.Date) = SelectedYear).Amount.sum()';
    const monthlySource = 'Expenses.filter(Year(CurrentValue.Date) = SelectedYear and Month(CurrentValue.Date) = SelectedMonth).Amount.sum()';
    const annualBindings = bindPageFormulaReferences(annualSource, 'summary', state, 'expenses');
    const monthlyBindings = bindPageFormulaReferences(monthlySource, 'summary', state, 'expenses');
    const currencyFormat = { locale: 'pt-BR', currency: 'BRL', precision: 2 };
    const doc: DocNode = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [
          { type: 'namedControl', attrs: { controlId: 'year', pageId: 'summary', label: 'SelectedYear' } },
          { type: 'namedControl', attrs: { controlId: 'month', pageId: 'summary', label: 'SelectedMonth' } },
          { type: 'calculatedResult', attrs: { resultId: 'annual-total', pageId: 'summary', name: 'Annual total', formula: annualSource, bindings: annualBindings, outputType: 'currency', format: currencyFormat } },
          { type: 'calculatedResult', attrs: { resultId: 'monthly-total', pageId: 'summary', name: 'Monthly total', formula: monthlySource, bindings: monthlyBindings, outputType: 'currency', format: currencyFormat } },
        ] },
        { type: 'linkedDatabaseView', attrs: { hostPageId: 'summary', sourceDatabaseId: 'expenses', blockId: 'annual-block', view: annualView } },
        { type: 'linkedDatabaseView', attrs: { hostPageId: 'summary', sourceDatabaseId: 'expenses', blockId: 'monthly-block', view: monthlyView } },
      ],
    };
    state = run(state, { type: 'page.setDoc', id: 'summary', doc, now: 4 });
    const database = state.pages.expenses!.database!;
    const rows = rowsOf(state, 'expenses');
    expect(visibleRows(rows, annualView, database, state).map((row) => row.id)).toEqual(['one', 'two']);
    expect(visibleRows(rows, monthlyView, database, state).map((row) => row.id)).toEqual(['one']);
    expect(documentFormulaResult('summary', 'annual-total', annualSource, annualBindings, state)).toEqual({ value: 100, error: null });
    expect(documentFormulaResult('summary', 'monthly-total', monthlySource, monthlyBindings, state)).toEqual({ value: 80, error: null });
    const currency = { id: 'currency', name: 'Currency', type: 'currency' as const, options: [], format: currencyFormat };
    expect(formatValue(currency, 80)).toContain('80,00');
    expect(state.pages.one!.properties.amount).toBe(80);
    state = run(state,
      { type: 'page.control.setValue', id: 'summary', controlId: 'year', value: 2026, now: 5 },
      { type: 'page.control.setValue', id: 'summary', controlId: 'month', value: 1, now: 6 },
    );
    expect(visibleRows(rowsOf(state, 'expenses'), annualView, database, state).map((row) => row.id)).toEqual(['three']);
    expect(visibleRows(rowsOf(state, 'expenses'), monthlyView, database, state).map((row) => row.id)).toEqual(['three']);
    expect(documentFormulaResult('summary', 'annual-total', annualSource, annualBindings, state)).toEqual({ value: 50, error: null });
    expect(documentFormulaResult('summary', 'monthly-total', monthlySource, monthlyBindings, state)).toEqual({ value: 50, error: null });
    expect(state.pages.one!.properties.amount).toBe(80);
    expect(state.pages.two!.properties.amount).toBe(20);
    expect(state.pages.three!.properties.amount).toBe(50);

    const page = state.pages.summary!;
    const frontmatter = managedFrontmatter(page, 'summary', null, state);
    const file = renderPageText(Object.fromEntries(frontmatter), null, docToMarkdown(doc));
    const reopenedPage = readPageText(file);
    const reopenedDoc = markdownToDoc(reopenedPage.body);
    expect(reopenedDoc.content?.map((node) => node.type)).toContain('linkedDatabaseView');
    const loaded = readWorkspace(SCHEMA_VERSION, {
      pages: Object.values(state.pages).map((item) => item.id === 'summary' ? { ...item, controls: reopenedPage.controls } : item),
      docs: { summary: reopenedDoc },
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.value.docs.summary?.content?.map((node) => node.type)).toContain('linkedDatabaseView');
    state = {
      ...emptyWorkspace(),
      pages: Object.fromEntries(loaded.value.pages.map((item) => [item.id, item])),
      docs: loaded.value.docs,
    };
    const reopenedViews = state.docs.summary!.content!.filter((node) => node.type === 'linkedDatabaseView');
    expect(reopenedViews).toHaveLength(2);
    expect(reopenedViews[0]!.attrs?.view).toMatchObject({ id: 'annual-view', filters: [{ formula: annualFilterFormula }] });
    expect(reopenedViews[1]!.attrs?.view).toMatchObject({ id: 'monthly-view', filters: [{ formula: monthlyFilterFormula }] });
    const reopenedResults = state.docs.summary!.content![0]!.content!;
    expect(reopenedResults[2]!.attrs).toMatchObject({ outputType: 'currency', format: currencyFormat });
    expect(reopenedResults[3]!.attrs).toMatchObject({ outputType: 'currency', format: currencyFormat });
    expect(state.pages.summary!.controls.map((item) => item.value)).toEqual([2026, 1]);
    expect(visibleRows(rowsOf(state, 'expenses'), reopenedViews[0]!.attrs!.view as ViewDef, state.pages.expenses!.database!, state).map((row) => row.id)).toEqual(['three']);
    expect(visibleRows(rowsOf(state, 'expenses'), reopenedViews[1]!.attrs!.view as ViewDef, state.pages.expenses!.database!, state).map((row) => row.id)).toEqual(['three']);
    expect(documentFormulaResult('summary', 'annual-total', annualSource, annualBindings, state)).toEqual({ value: 50, error: null });
    expect(documentFormulaResult('summary', 'monthly-total', monthlySource, monthlyBindings, state)).toEqual({ value: 50, error: null });

    state = run(state, {
      type: 'page.control.configure', id: 'summary', now: 7,
      control: control({ id: 'year', name: 'FiscalYear', type: 'number', value: 0, defaultValue: 2025 }),
    });
    expect(documentFormulaResult('summary', 'annual-total', annualSource, annualBindings, state)).toEqual({ value: 50, error: null });
    state = run(state, { type: 'page.control.delete', id: 'summary', controlId: 'year', now: 8 });
    expect(documentFormulaResult('summary', 'annual-total', annualSource, annualBindings, state).error).toContain('Bound control');
  });

  it('diagnoses scope collisions and duplicate names while preserving explicit bindings', () => {
    let state = run(
      emptyWorkspace(),
      create('items', null, {
        kind: 'database',
        database: { properties: [{ id: 'year', name: 'SelectedYear', type: 'number', options: [] }], views: [] },
      } as Partial<Command>),
      create('summary'),
      { type: 'page.control.configure', id: 'summary', now: 2, control: control({ id: 'year-control', name: 'SelectedYear', type: 'number', value: 2026, defaultValue: 2025 }) },
    );
    const source = 'SelectedYear';
    expect(bindPageFormulaReferences(source, 'summary', state, 'items')[0]?.kind).toBe('ambiguous');
    const explicit = [{
      kind: 'control' as const, pageId: 'summary', controlId: 'year-control',
      start: 0, end: source.length, source,
    }];
    expect(bindPageFormulaReferences(source, 'summary', state, 'items', explicit)).toMatchObject(explicit);
    state = run(state, {
      type: 'page.control.configure', id: 'summary', now: 3,
      control: control({ id: 'another-year', name: 'SelectedYear', type: 'number', value: 2027, defaultValue: 2025 }),
    });
    expect(bindPageFormulaReferences(source, 'summary', state, 'items')[0]?.kind).toBe('ambiguous');
  });

  it('reports a cycle between calculated document results', () => {
    let state = run(emptyWorkspace(), create('summary'));
    const resultA = { kind: 'result' as const, pageId: 'summary', resultId: 'result-a', start: 0, end: 1, source: 'B' };
    const resultB = { kind: 'result' as const, pageId: 'summary', resultId: 'result-b', start: 0, end: 1, source: 'A' };
    const doc: DocNode = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [
        { type: 'calculatedResult', attrs: { resultId: 'result-a', pageId: 'summary', name: 'A', formula: 'B', bindings: [resultA] } },
        { type: 'calculatedResult', attrs: { resultId: 'result-b', pageId: 'summary', name: 'B', formula: 'A', bindings: [resultB] } },
      ] }],
    };
    state = run(state, { type: 'page.setDoc', id: 'summary', doc, now: 2 });
    expect(documentFormulaResult('summary', 'result-a', 'B', [resultA], state).error).toContain('cycle detected');
  });

  it('gives a copied page independent control and result identities with internal bindings remapped', () => {
    let state = run(emptyWorkspace(), create('source'));
    const doc: DocNode = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [
        { type: 'namedControl', attrs: { controlId: 'year', pageId: 'source', label: 'YearValue' } },
        { type: 'calculatedResult', attrs: { resultId: 'total', pageId: 'source', name: 'Total', formula: 'YearValue + Total + SharedValue', bindings: [], outputType: 'currency', format: { currency: 'BRL' } } },
      ] }],
    };
    state = run(state,
      { type: 'page.control.configure', id: 'source', now: 2, control: control({ id: 'year', name: 'YearValue', type: 'number', value: 2025, defaultValue: 2025 }) },
      { type: 'page.setDoc', id: 'source', doc, now: 3 },
    );
    const binding = { kind: 'control' as const, pageId: 'source', controlId: 'year', start: 0, end: 9, source: 'YearValue' };
    const externalBinding = { kind: 'control' as const, pageId: 'external-page', controlId: 'shared', start: 20, end: 31, source: 'SharedValue' };
    const sourceDoc = state.docs.source!;
    const resultNode = sourceDoc.content![0]!.content![1]!;
    resultNode.attrs!.bindings = [binding, { kind: 'result', pageId: 'source', resultId: 'total', start: 12, end: 17, source: 'Total' }, externalBinding];
    state = { ...state, docs: { ...state.docs, source: sourceDoc } };
    state = run(state, { type: 'page.duplicate', id: 'source', newId: 'copy', now: 4 });
    const copied = state.docs.copy!.content![0]!.content!;
    const copiedControlId = String(copied[0]!.attrs?.controlId);
    const copiedResultId = String(copied[1]!.attrs?.resultId);
    expect(copiedControlId).not.toBe('year');
    expect(copiedResultId).not.toBe('total');
    expect(state.pages.copy!.controls[0]!.id).toBe(copiedControlId);
    expect(copied[1]!.attrs?.bindings).toMatchObject([
      { kind: 'control', pageId: 'copy', controlId: copiedControlId },
      { kind: 'result', pageId: 'copy', resultId: copiedResultId },
      { kind: 'control', pageId: 'external-page', controlId: 'shared' },
    ]);
  });

  it('migrates older page records with no controls and rejects malformed control metadata', () => {
    expect(normalizePage({ id: 'old', createdAt: 1 })?.controls).toEqual([]);
    expect(normalizePage({ id: 'bad', controls: [{ id: 'bad id' }] })).toBeNull();
  });

  it('writes current and default values to markdown frontmatter and restores them', () => {
    let state = run(emptyWorkspace(), create('page'));
    state = run(state, {
      type: 'page.control.configure', id: 'page', now: 2,
      control: control({ id: 'check', name: 'Check', type: 'checkbox', value: false, defaultValue: true }),
    });
    const page = state.pages.page!;
    const managed = managedFrontmatter(page, 'page', null, state);
    expect(managed.has('morrowControls')).toBe(true);
    const file = renderPageText(Object.fromEntries(managed), null, '');
    expect(readPageText(file).controls).toEqual(page.controls);
  });
});
