import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindFormulaReferences, formulaResult, formulaValueText, valueOf } from './database';
import { newPageMeta } from './model';
import type { DatabaseDef, PageMeta, PropDef, WorkspaceState } from './model';

function property(id: string, name: string, type: PropDef['type'], extra: Partial<PropDef> = {}): PropDef {
  return { id, name, type, options: [], ...extra };
}

function database(id: string, title: string, properties: PropDef[]): PageMeta {
  const schema: DatabaseDef = { properties, views: [] };
  return newPageMeta({ id, parentId: null, title, kind: 'database', database: schema });
}

function row(id: string, parentId: string, properties: Record<string, string | number | boolean | string[] | null> = {}): PageMeta {
  return newPageMeta({ id, parentId, title: id, properties });
}

function workspace(...pages: PageMeta[]): WorkspaceState {
  return { pages: Object.fromEntries(pages.map((page) => [page.id, page])), docs: {} };
}

function boundFormula(source: string, databaseId: string, state: WorkspaceState, propId = 'result'): PropDef {
  const formula = property(propId, 'Result', 'formula', { formula: source });
  return { ...formula, formulaBindings: bindFormulaReferences(source, databaseId, state) };
}

describe('relational formulas', () => {
  afterEach(() => vi.useRealTimers());
  it('projects relation fields and filters a named table before aggregation', () => {
    const transactions = database('tx', 'Transactions', [
      property('status', 'Status', 'select', { options: [
        { id: 'paid-option', name: 'Paid', color: 'green' },
        { id: 'open-option', name: 'Open', color: 'gray' },
      ] }),
      property('tags', 'Tags', 'multiSelect', { options: [
        { id: 'done-option', name: 'Concluído', color: 'green' },
      ] }),
      property('amount', 'Amount', 'currency'),
    ]);
    const summaryDb = database('summary', 'Summary', []);
    const paid = row('paid', 'tx', { status: 'paid-option', tags: ['done-option'], amount: 12.5 });
    const open = row('open', 'tx', { status: 'open-option', tags: [], amount: 90 });
    const summaryRow = row('summary-row', 'summary');
    const state = workspace(transactions, summaryDb, paid, open, summaryRow);
    const relation = property('related', 'Related rows', 'relation', {
      relation: {
        targetDatabaseId: 'tx', multiple: true, isInverse: false,
        displayPropertyId: null, inversePropertyId: null, filters: [],
      },
    });
    const relationDb = database('source', 'Source', [relation]);
    const relationRow = row('source-row', 'source', { related: ['paid', 'open'] });
    const relationState = workspace(transactions, relationDb, paid, open, relationRow);
    const projected = boundFormula('thisRow.`Related rows`.Filter(CurrentValue.Amount > 0).Amount.Sum()', 'source', relationState);
    expect(formulaResult(relationRow, projected, relationDb.database!, 0, relationState)).toEqual({ value: 102.5, error: null });

    const source = '`Transactions`.Filter(CurrentValue.Status = "Paid" and Contains(CurrentValue.Tags, "Concluído")).Amount.Sum()';
    const filtered = boundFormula(source, 'summary', state);
    expect(formulaResult(summaryRow, filtered, summaryDb.database!, 0, state)).toEqual({ value: 12.5, error: null });
  });

  it('keeps table and column bindings stable across renames, including empty schemas', () => {
    const target = database('target', 'Old table', [property('amount', 'Old amount', 'number')]);
    const owner = database('owner', 'Owner', []);
    const targetRow = row('target-row', 'target', { amount: 44 });
    const ownerRow = row('owner-row', 'owner');
    const state = workspace(target, owner, targetRow, ownerRow);
    const source = '`Old table`.Filter(CurrentValue.`Old amount` > 0).`Old amount`.Sum()';
    const bound = boundFormula(source, 'owner', state);
    const renamed = database('target', 'Renamed table', [property('amount', 'Renamed amount', 'number')]);
    const changedState = workspace(renamed, owner, targetRow, ownerRow);
    expect(formulaResult(ownerRow, bound, owner.database!, 0, changedState)).toEqual({ value: 44, error: null });

    const empty = database('empty', 'Empty table', [property('amount', 'Amount', 'number')]);
    const emptyOwner = database('empty-owner', 'Empty owner', []);
    const emptyRow = row('empty-row', 'empty-owner');
    const emptyState = workspace(empty, emptyOwner, emptyRow);
    const emptyFormula = boundFormula('`Empty table`.Filter(CurrentValue.Amount > 0).Amount.Sum()', 'empty-owner', emptyState);
    expect(formulaResult(emptyRow, emptyFormula, emptyOwner.database!, 0, emptyState)).toEqual({ value: 0, error: null });
    const renamedEmpty = database('empty', 'Renamed empty table', [property('amount', 'Renamed amount', 'number')]);
    const renamedEmptyState = workspace(renamedEmpty, emptyOwner, emptyRow);
    expect(formulaResult(emptyRow, emptyFormula, emptyOwner.database!, 0, renamedEmptyState)).toEqual({ value: 0, error: null });
    const invalid = boundFormula('`Empty table`.Filter(CurrentValue.Amount > 0).Missing.Sum()', 'empty-owner', emptyState, 'invalid');
    expect(formulaResult(emptyRow, invalid, emptyOwner.database!, 0, emptyState).error).toContain('no column called “Missing”');
  });

  it('preserves typed formula lists and validates calculated relation references', () => {
    const target = database('target', 'Targets', [property('amount', 'Amount', 'number')]);
    const related = property('related', 'Related', 'relation', {
      relation: {
        targetDatabaseId: 'target', multiple: true, isInverse: false,
        displayPropertyId: null, inversePropertyId: null, filters: [],
      },
    });
    const listFormula = property('list-result', 'Typed list', 'formula', { formula: 'List(0, false, null, 1.5)' });
    const relationFormula = property('relation-result', 'Calculated relation', 'relation', {
      fillMode: 'calculated', formula: 'thisRow.Related',
      relation: { ...related.relation!, multiple: true },
    });
    const amountFormula = property('amount-result', 'Related amount', 'formula', { formula: 'thisRow.`Calculated relation`.Amount' });
    const withNameFormula = property('with-name-result', 'Named relation amount', 'formula', {
      formula: 'WithName(First(thisRow.Related), target, target.Amount)',
    });
    const owner = database('owner', 'Owner', [related, listFormula, relationFormula, amountFormula, withNameFormula]);
    const targetRow = row('target-row', 'target', { amount: 4 });
    const ownerRow = row('owner-row', 'owner', { related: ['target-row'] });
    const state = workspace(target, owner, targetRow, ownerRow);
    const typedList = { ...listFormula, formulaBindings: bindFormulaReferences(listFormula.formula!, 'owner', state) };
    expect(formulaResult(ownerRow, typedList, owner.database!, 0, state)).toEqual({ value: [0, false, null, 1.5], error: null });
    expect(formulaResult(ownerRow, relationFormula, owner.database!, 0, state)).toEqual({ value: ['target-row'], error: null });
    expect(valueOf(ownerRow, 'relation-result', owner.database!, state)).toEqual(['target-row']);
    const boundAmount = { ...amountFormula, formulaBindings: bindFormulaReferences(amountFormula.formula!, 'owner', state) };
    expect(formulaResult(ownerRow, boundAmount, owner.database!, 0, state)).toEqual({ value: [4], error: null });
    const boundWithName = { ...withNameFormula, formulaBindings: bindFormulaReferences(withNameFormula.formula!, 'owner', state) };
    expect(formulaResult(ownerRow, boundWithName, owner.database!, 0, state)).toEqual({ value: 4, error: null });
    expect(formulaValueText(listFormula, [0, false, null, 1.5], state)).toBe('0, No, , 1.5');

    const brokenRow = row('broken-row', 'owner', { related: ['missing-target'] });
    const brokenState = workspace(target, owner, targetRow, brokenRow);
    const brokenProjection = property('broken-projection', 'Broken projection', 'formula', { formula: 'thisRow.Related.Amount.Sum()' });
    const boundBroken = { ...brokenProjection, formulaBindings: bindFormulaReferences(brokenProjection.formula!, 'owner', brokenState) };
    expect(formulaResult(brokenRow, boundBroken, owner.database!, 0, brokenState).error).toContain('unavailable row');
  });

  it('reports duplicate names, broken bindings, and cycles without substituting values', () => {
    const owner = database('owner', 'Owner', [
      property('same-a', 'Same', 'number'),
      property('same-b', 'Same', 'number'),
      property('first', 'First', 'formula', { formula: 'thisRow.Second' }),
      property('second', 'Second', 'formula', { formula: 'thisRow.First' }),
      property('flag', 'Flag', 'checkbox'),
      property('zero', 'Zero', 'formula', { formula: '0' }),
    ]);
    const rowMeta = row('r', 'owner', { 'same-a': 1, 'same-b': 2, flag: false });
    const duplicateTable = database('duplicate-owner', 'Owner', []);
    const duplicate = database('duplicate-table', 'Owner', []);
    const state = workspace(owner, rowMeta, duplicateTable, duplicate);
    const duplicateColumn = formulaResult(rowMeta, property('test', 'Test', 'formula', { formula: 'thisRow.Same' }), owner.database!, 0, state);
    expect(duplicateColumn.error).toContain('ambiguous');

    const cycle = property('first', 'First', 'formula', { formula: 'thisRow.Second' });
    const first = { ...cycle, formulaBindings: bindFormulaReferences(cycle.formula!, 'owner', state) };
    expect(formulaResult(rowMeta, first, owner.database!, 0, state).error).toContain('cycle');
    expect(valueOf(rowMeta, 'flag', owner.database!, state)).toBe(false);
    expect(valueOf(rowMeta, 'zero', owner.database!, state)).toBe(0);

    const oldOwner = database('owner', 'Owner', [property('old', 'Value', 'number')]);
    const oldState = workspace(oldOwner, row('old-row', 'owner'));
    const oldBinding = boundFormula('thisRow.Value', 'owner', oldState, 'stale');
    const replacement = database('owner', 'Owner', [property('new', 'Value', 'number')]);
    const replacementState = workspace(replacement, row('r', 'owner', { new: 7 }));
    expect(formulaResult(replacementState.pages.r!, oldBinding, replacement.database!, 0, replacementState).error).toContain('Bound column');

    const tableFormula = property('table-test', 'Table test', 'formula', { formula: 'Owner.Filter(CurrentValue.Score > 0).Count()' });
    const duplicateState = workspace(
      database('one', 'Owner', [property('score-one', 'Score', 'number')]),
      database('two', 'Owner', [property('score-two', 'Score', 'number')]),
      database('summary', 'Summary', []),
      row('summary-row', 'summary'),
    );
    expect(formulaResult(duplicateState.pages['summary-row']!, tableFormula, duplicateState.pages.summary!.database!, 0, duplicateState).error).toContain('Table name “Owner” is ambiguous');
  });

  it('recalculates time values and measures a representative 1,000-row filter', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T12:00:00Z'));
    const timeDb = database('time-db', 'Time', [
      property('today', 'Today', 'formula', { formula: 'Today()' }),
      property('now', 'Now', 'formula', { formula: 'Now()' }),
      property('dependent-now', 'Dependent Now', 'formula', { formula: 'thisRow.Now' }),
    ]);
    const timeRow = row('time-row', 'time-db');
    const timeState = workspace(timeDb, timeRow);
    const first = valueOf(timeRow, 'today', timeDb.database!, timeState);
    const nowFormula = timeDb.database!.properties.find((item) => item.id === 'now')!;
    const dependentFormula = timeDb.database!.properties.find((item) => item.id === 'dependent-now')!;
    const boundDependent = {
      ...dependentFormula,
      formulaBindings: bindFormulaReferences(dependentFormula.formula!, timeDb.id, timeState),
    };
    const firstNow = formulaResult(timeRow, nowFormula, timeDb.database!, 0, timeState).value;
    const firstDependentNow = formulaResult(timeRow, boundDependent, timeDb.database!, 0, timeState).value;
    vi.setSystemTime(new Date('2026-10-26T12:00:00.100Z'));
    const second = valueOf(timeRow, 'today', timeDb.database!, timeState);
    const secondNow = formulaResult(timeRow, nowFormula, timeDb.database!, 0, timeState).value;
    const secondDependentNow = formulaResult(timeRow, boundDependent, timeDb.database!, 0, timeState).value;
    expect(first).toBe('2026-10-26');
    expect(second).toBe('2026-10-26');
    expect(secondNow).toBe((firstNow as number) + 100);
    expect(secondDependentNow).toBe((firstDependentNow as number) + 100);
    vi.useRealTimers();

    const transactions = database('benchmark-table', 'Transactions', [
      property('status', 'Status', 'text'), property('amount', 'Amount', 'number'),
    ]);
    const summary = database('benchmark-summary', 'Summary', []);
    const summaryRow = row('benchmark-row', 'benchmark-summary');
    const rows = Array.from({ length: 1000 }, (_, index) => row(`transaction-${index}`, 'benchmark-table', {
      status: index % 2 === 0 ? 'Paid' : 'Open', amount: index,
    }));
    const state = workspace(transactions, summary, summaryRow, ...rows);
    const source = '`Transactions`.Filter(CurrentValue.Status = "Paid").Amount.Sum()';
    const formula = boundFormula(source, 'benchmark-summary', state);
    const started = performance.now();
    const result = formulaResult(summaryRow, formula, summary.database!, 0, state);
    const elapsedMs = performance.now() - started;
    console.info(`Formula 1,000-row filter: ${elapsedMs.toFixed(2)} ms (${process.version}, ${process.platform}/${process.arch})`);
    expect(result).toEqual({ value: 249500, error: null });
  });
});
