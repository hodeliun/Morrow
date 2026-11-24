import { describe, expect, it } from 'vitest';
import type { DataApiRow } from '../../../../src/app/plugins/dataApi';
import { createFormulaEvaluationScope, evaluateCell, resolveFormulaDatabaseTitle } from './formulas';
import type { EvaluatedCell, ProviderProperty, ReadySnapshot } from './formulas';

function scalar(id: string, name: string, type: 'number' | 'text' = 'number'): ProviderProperty {
  return { id, name, type, options: [] };
}

function checkbox(id: string, name: string): ProviderProperty {
  return { id, name, type: 'checkbox', options: [] };
}

function selection(id: string, name: string, options: ProviderProperty['options']): ProviderProperty {
  return { id, name, type: 'select', options };
}

function formula(id: string, name: string, expression: string): ProviderProperty {
  return { id, name, type: 'formula', options: [], formula: expression };
}

function evaluate(
  properties: readonly ProviderProperty[],
  rowProperties: Record<string, unknown>,
  formulaId: string,
): EvaluatedCell {
  const row: DataApiRow = {
    id: 'row-1',
    title: 'Row 1',
    properties: rowProperties as DataApiRow['properties'],
  };
  const target = properties.find((property) => property.id === formulaId);
  if (!target) throw new Error(`Missing test formula ${formulaId}.`);
  return evaluateCell(row, properties, target);
}

describe('Polaris Dados formula row context', () => {
  it('reads current-row scalars, including zero, false, empty, null, and an absent cell', () => {
    const properties = [
      scalar('zero', 'Zero'),
      checkbox('flag', 'Flag'),
      scalar('empty', 'Empty Text', 'text'),
      scalar('nullable', 'Nullable', 'text'),
      scalar('missing', 'Missing Cell', 'text'),
      formula('zero-result', 'Zero result', 'thisRow.Zero'),
      formula('false-result', 'False result', 'thisRow.Flag'),
      formula('empty-result', 'Empty result', 'thisRow["Empty Text"]'),
      formula('null-result', 'Null result', 'thisRow.Nullable'),
      formula('missing-result', 'Missing result', 'thisRow["Missing Cell"]'),
    ] satisfies readonly ProviderProperty[];
    const rowProperties = { zero: 0, flag: false, empty: '', nullable: null };

    expect(evaluate(properties, rowProperties, 'zero-result')).toEqual({ kind: 'number', value: 0 });
    expect(evaluate(properties, rowProperties, 'false-result')).toEqual({ kind: 'boolean', value: false });
    expect(evaluate(properties, rowProperties, 'empty-result')).toEqual({ kind: 'text', value: '' });
    expect(evaluate(properties, rowProperties, 'null-result')).toEqual({ kind: 'null' });
    expect(evaluate(properties, rowProperties, 'missing-result')).toEqual({ kind: 'null' });
  });

  it('uses the same resolver for calculated fields and does not write results to the row', () => {
    const properties = [
      scalar('quantity', 'Quantity'),
      scalar('price', 'Price'),
      formula('subtotal', 'Subtotal', 'thisRow.Quantity * thisRow.Price'),
      formula('total', 'Total', 'thisRow.Subtotal + 5'),
    ] satisfies readonly ProviderProperty[];
    const rowProperties = { quantity: 3, price: 7 };
    const before = structuredClone(rowProperties);

    expect(evaluate(properties, rowProperties, 'total')).toEqual({ kind: 'number', value: 26 });
    expect(rowProperties).toEqual(before);
    expect(Object.hasOwn(rowProperties, 'subtotal')).toBe(false);
    expect(Object.hasOwn(rowProperties, 'total')).toBe(false);
  });

  it('accepts only finite numbers or null for explicit percent results and forwards type errors', () => {
    const properties = [
      scalar('amount', 'Amount'),
      checkbox('flag', 'Flag'),
      scalar('label', 'Label', 'text'),
      scalar('optional', 'Optional'),
      { ...formula('valid', 'Valid percent', 'thisRow.Amount'), formulaResultType: 'percent' },
      { ...formula('null', 'Null percent', 'thisRow.Optional'), formulaResultType: 'percent' },
      { ...formula('boolean', 'Boolean percent', 'thisRow.Flag'), formulaResultType: 'percent' },
      { ...formula('text', 'Text percent', 'thisRow.Label'), formulaResultType: 'percent' },
      { ...formula('list', 'List percent', 'List(1, 2)'), formulaResultType: 'percent' },
      { ...formula('division-zero', 'Division zero percent', '1 / 0'), formulaResultType: 'percent' },
      { ...formula('broken', 'Broken percent', 'NoSuchFunction()'), formulaResultType: 'percent' },
      { ...formula('missing', 'Missing percent', 'thisRow["Missing"]'), formulaResultType: 'percent' },
      { ...formula('reference', 'Reference percent', 'thisRow'), formulaResultType: 'percent' },
      formula('dependent', 'Dependent', 'prop("Boolean percent") + 1'),
    ] satisfies readonly ProviderProperty[];
    const rowProperties = { amount: 0.375, flag: false, label: 'done', optional: null };

    expect(evaluate(properties, rowProperties, 'valid')).toEqual({ kind: 'number', value: 0.375 });
    expect(evaluate(properties, rowProperties, 'null')).toEqual({ kind: 'null' });
    expect(evaluate(properties, rowProperties, 'boolean')).toEqual({
      kind: 'error',
      message: 'Formula “Boolean percent” declared as percent must return a finite number or null.',
    });
    expect(evaluate(properties, rowProperties, 'text')).toEqual({
      kind: 'error',
      message: 'Formula “Text percent” declared as percent must return a finite number or null.',
    });
    expect(evaluate(properties, rowProperties, 'list')).toEqual({
      kind: 'error',
      message: 'Formula “List percent” declared as percent must return a finite number or null.',
    });
    expect(evaluate(properties, rowProperties, 'division-zero')).toEqual({
      kind: 'error',
      message: 'Division by zero is not allowed',
    });
    expect(evaluate(properties, rowProperties, 'broken')).toEqual({
      kind: 'error',
      message: 'There is no function called NoSuchFunction()',
    });
    expect(evaluate(properties, rowProperties, 'missing')).toEqual({
      kind: 'error',
      message: 'There is no property called “Missing”.',
    });
    expect(evaluate(properties, rowProperties, 'reference')).toEqual({
      kind: 'error',
      message: 'This table does not display row references or tables.',
    });
    expect(evaluate(properties, rowProperties, 'dependent')).toEqual({
      kind: 'error',
      message: 'Formula “Boolean percent” declared as percent must return a finite number or null.',
    });
  });

  it('resolves an explicit property named thisRow and keeps the bare identifier contextual', () => {
    const properties = [
      scalar('legacy', 'thisRow', 'text'),
      formula('explicit', 'Explicit property', 'prop("thisRow")'),
      formula('field', 'Same-named field', 'thisRow.thisRow'),
      formula('bare', 'Bare row reference', 'thisRow'),
    ] satisfies readonly ProviderProperty[];

    expect(evaluate(properties, { legacy: 'legacy value' }, 'explicit')).toEqual({
      kind: 'text',
      value: 'legacy value',
    });
    expect(evaluate(properties, { legacy: 'legacy value' }, 'field')).toEqual({
      kind: 'text',
      value: 'legacy value',
    });
    expect(evaluate(properties, { legacy: 'legacy value' }, 'bare')).toEqual({
      kind: 'error',
      message: 'This table does not display row references or tables.',
    });
  });

  it('does not treat a computed prop() name as the thisRow receiver identifier', () => {
    const properties = [
      scalar('legacy', 'thisRow', 'text'),
      scalar('selector', 'FieldName', 'text'),
      formula('dynamic', 'Dynamic property', 'prop(FieldName)'),
    ] satisfies readonly ProviderProperty[];

    expect(evaluate(properties, { legacy: 'literal column value', selector: 'thisRow' }, 'dynamic')).toEqual({
      kind: 'text',
      value: 'literal column value',
    });
  });

  it('preserves a WithName alias while prop() reads its literal property name', () => {
    const properties = [
      scalar('legacy', 'thisRow', 'text'),
      formula('with-name', 'WithName property', 'WithName("thisRow", thisRow, prop(thisRow))'),
    ] satisfies readonly ProviderProperty[];

    expect(evaluate(properties, { legacy: 'literal column value' }, 'with-name')).toEqual({
      kind: 'text',
      value: 'literal column value',
    });
  });

  it('reports unknown fields and identifiers through the existing property resolver', () => {
    const properties = [
      formula('unknown-field', 'Unknown field', 'thisRow["Not a field"]'),
      formula('unknown-name', 'Unknown identifier', 'Missing + 1'),
    ] satisfies readonly ProviderProperty[];

    expect(evaluate(properties, {}, 'unknown-field')).toMatchObject({
      kind: 'error',
      message: 'There is no property called “Not a field”.',
    });
    expect(evaluate(properties, {}, 'unknown-name')).toMatchObject({
      kind: 'error',
      message: 'There is no property called “Missing”.',
    });
  });

  it('rejects row references inside lists while preserving nested scalar lists', () => {
    const properties = [
      formula('row-list', 'Row list', '[thisRow]'),
      formula('nested-row-list', 'Nested row list', '[[thisRow]]'),
      formula('valid-list', 'Valid list', '[1, [2, "safe", false]]'),
    ] satisfies readonly ProviderProperty[];

    const unsupported = {
      kind: 'error',
      message: 'This table does not display row references or tables.',
    };
    expect(evaluate(properties, {}, 'row-list')).toEqual(unsupported);
    expect(evaluate(properties, {}, 'nested-row-list')).toEqual(unsupported);
    expect(evaluate(properties, {}, 'valid-list')).toEqual({
      kind: 'list',
      value: [1, [2, 'safe', false]],
    });
  });

  it('detects cycles that mix thisRow members and legacy prop references', () => {
    const properties = [
      formula('first', 'First', 'thisRow.Second'),
      formula('second', 'Second', 'prop("First")'),
    ] satisfies readonly ProviderProperty[];

    expect(evaluate(properties, {}, 'first')).toMatchObject({
      kind: 'error',
      message: 'Formula cycle at “First”.',
    });
  });

  it('keeps the existing formula depth and referenced-property limits', () => {
    const chain = Array.from({ length: 27 }, (_, index) =>
      formula(`chain-${index}`, `Chain ${index}`, index === 0 ? '1' : `thisRow["Chain ${index - 1}"] + 1`),
    );
    expect(evaluate(chain, {}, 'chain-26')).toMatchObject({
      kind: 'error',
      message: 'Formula references are nested too deeply.',
    });

    const leaves = Array.from({ length: 65 }, (_, index) => formula(`leaf-${index}`, `Leaf${index}`, '1'));
    const aggregate = formula(
      'aggregate',
      'Aggregate',
      leaves.map((property) => `thisRow.${property.name}`).join(' + '),
    );
    expect(evaluate([...leaves, aggregate], {}, 'aggregate')).toMatchObject({
      kind: 'error',
      message: 'This formula references too many calculated properties.',
    });
  });
});

describe('Polaris Dados local list methods', () => {
  it('implements the published aggregation, count, and positional semantics', () => {
    const properties = [
      formula('sum', 'Sum', 'List(2, 3).Sum()'),
      formula('average', 'Average', 'List(2, 4).Average()'),
      formula('avg', 'Avg', 'List(2, 4).Avg()'),
      formula('min', 'Min', 'List(2, 4).Min()'),
      formula('max', 'Max', 'List(2, 4).Max()'),
      formula('count', 'Count', 'List(null, false, 0, "").Count()'),
      formula('first', 'First', 'List(false, "middle", 0).First()'),
      formula('last', 'Last', 'List(false, "middle", 0).Last()'),
      formula('sum-empty', 'Empty sum', 'List().Sum()'),
      formula('average-empty', 'Empty average', 'List().Average()'),
      formula('min-empty', 'Empty min', 'List().Min()'),
      formula('max-empty', 'Empty max', 'List().Max()'),
      formula('count-empty', 'Empty count', 'List().Count()'),
      formula('first-empty', 'Empty first', 'List().First()'),
      formula('last-empty', 'Empty last', 'List().Last()'),
    ] satisfies readonly ProviderProperty[];

    expect(evaluate(properties, {}, 'sum')).toEqual({ kind: 'number', value: 5 });
    expect(evaluate(properties, {}, 'average')).toEqual({ kind: 'number', value: 3 });
    expect(evaluate(properties, {}, 'avg')).toEqual({ kind: 'number', value: 3 });
    expect(evaluate(properties, {}, 'min')).toEqual({ kind: 'number', value: 2 });
    expect(evaluate(properties, {}, 'max')).toEqual({ kind: 'number', value: 4 });
    expect(evaluate(properties, {}, 'count')).toEqual({ kind: 'number', value: 3 });
    expect(evaluate(properties, {}, 'first')).toEqual({ kind: 'boolean', value: false });
    expect(evaluate(properties, {}, 'last')).toEqual({ kind: 'number', value: 0 });
    expect(evaluate(properties, {}, 'sum-empty')).toEqual({ kind: 'number', value: 0 });
    for (const id of ['average-empty', 'min-empty', 'max-empty', 'first-empty', 'last-empty']) {
      expect(evaluate(properties, {}, id)).toEqual({ kind: 'null' });
    }
    expect(evaluate(properties, {}, 'count-empty')).toEqual({ kind: 'number', value: 0 });
  });

  it('keeps errors visible, lets IfError recover, and preserves free Sum coercion', () => {
    const properties = [
      formula('wrong-receiver', 'Wrong receiver', '1.Sum()'),
      formula('wrong-arity', 'Wrong arity', 'List(1).Sum(2)'),
      formula('numeric-only', 'Numeric only', 'List(1, "2").Sum()'),
      formula('recovered', 'Recovered', 'IfError(List(1, "2").Sum(), 9)'),
      formula('free-sum', 'Free Sum', 'Sum("2", 3)'),
      formula('free-sum-empty', 'Free empty Sum', 'Sum()'),
      formula('unknown-method', 'Unknown method', 'List(1).Median()'),
    ] satisfies readonly ProviderProperty[];

    expect(evaluate(properties, {}, 'wrong-receiver')).toMatchObject({
      kind: 'error',
      message: 'Sum() needs a local list of values.',
    });
    expect(evaluate(properties, {}, 'wrong-arity')).toMatchObject({
      kind: 'error',
      message: 'Sum() takes no arguments.',
    });
    expect(evaluate(properties, {}, 'numeric-only')).toMatchObject({
      kind: 'error',
      message: 'Sum() only accepts finite numbers.',
    });
    expect(evaluate(properties, {}, 'recovered')).toEqual({ kind: 'number', value: 9 });
    expect(evaluate(properties, {}, 'free-sum')).toEqual({ kind: 'number', value: 5 });
    expect(evaluate(properties, {}, 'free-sum-empty')).toEqual({ kind: 'number', value: 0 });
    expect(evaluate(properties, {}, 'unknown-method')).toMatchObject({ kind: 'error' });
  });

  it('accepts 2,000 values and rejects 2,001', () => {
    const properties = [
      scalar('values', 'Values'),
      formula('sum', 'Sum', 'thisRow.Values.Sum()'),
    ] satisfies readonly ProviderProperty[];
    const values = Array.from({ length: 2000 }, () => 1);

    expect(evaluate(properties, { values }, 'sum')).toEqual({ kind: 'number', value: 2000 });
    expect(evaluate(properties, { values: [...values, 1] }, 'sum')).toMatchObject({
      kind: 'error',
      message: 'Sum() is limited to 2000 values.',
    });
  });
});

describe('Polaris Dados current-database formula projections', () => {
  const databaseId = 'inventory-database';
  const pages = [
    { id: databaseId, title: 'Inventory', kind: 'database' },
    { id: 'inventory-note', title: 'Inventory', kind: 'note' },
  ] as const;

  function readySnapshot(
    properties: readonly ProviderProperty[],
    rows: readonly DataApiRow[],
    id = databaseId,
  ): ReadySnapshot {
    return {
      version: 1,
      status: 'ready',
      databaseId: id,
      revision: 'test-revision',
      schema: { properties, views: [] },
      rows,
      history: { canUndo: false, canRedo: false },
      readonly: false,
      diagnostic: null,
    } as ReadySnapshot;
  }

  function row(id: string, properties: Record<string, unknown>): DataApiRow {
    return { id, title: id, properties: properties as DataApiRow['properties'] };
  }

  function value(
    snapshot: ReadySnapshot,
    properties: readonly ProviderProperty[],
    formulaId: string,
    scope = createFormulaEvaluationScope(snapshot, resolveFormulaDatabaseTitle(snapshot.databaseId, pages)),
  ): EvaluatedCell {
    const target = properties.find((candidate) => candidate.id === formulaId);
    if (!target) throw new Error(`Missing test formula ${formulaId}.`);
    return evaluateCell(snapshot.rows[0] ?? row('empty-owner', {}), properties, target, scope);
  }

  it('aggregates a backtick-named local numeric column and preserves exact empty, null, and zero rules', () => {
    const properties = [
      scalar('quantity', 'Order Quantity'),
      formula('sum', 'Sum', '`Inventory`.`Order Quantity`.Sum()'),
      formula('average', 'Average', 'Inventory["Order Quantity"].Average()'),
      formula('avg', 'Avg', 'Inventory["Order Quantity"].Avg()'),
      formula('min', 'Min', 'Inventory["Order Quantity"].Min()'),
      formula('max', 'Max', 'Inventory["Order Quantity"].Max()'),
      formula('count', 'Count', 'Inventory["Order Quantity"].Count()'),
    ] satisfies readonly ProviderProperty[];
    const rows = [row('r1', { quantity: 2 }), row('r2', { quantity: 0 }), row('r3', { quantity: 3 })];
    const snapshot = readySnapshot(properties, rows);
    const scope = createFormulaEvaluationScope(snapshot, resolveFormulaDatabaseTitle(databaseId, pages));

    expect(value(snapshot, properties, 'sum', scope)).toEqual({ kind: 'number', value: 5 });
    expect(value(snapshot, properties, 'average', scope)).toEqual({ kind: 'number', value: 5 / 3 });
    expect(value(snapshot, properties, 'avg', scope)).toEqual({ kind: 'number', value: 5 / 3 });
    expect(value(snapshot, properties, 'min', scope)).toEqual({ kind: 'number', value: 0 });
    expect(value(snapshot, properties, 'max', scope)).toEqual({ kind: 'number', value: 3 });
    expect(value(snapshot, properties, 'count', scope)).toEqual({ kind: 'number', value: 3 });
  });

  it('counts non-null entries including zero and rejects nulls or missing values in numeric aggregates', () => {
    const properties = [
      scalar('quantity', 'Quantity'),
      formula('sum', 'Sum', 'Inventory.Quantity.Sum()'),
      formula('average', 'Average', 'Inventory.Quantity.Average()'),
      formula('min', 'Min', 'Inventory.Quantity.Min()'),
      formula('max', 'Max', 'Inventory.Quantity.Max()'),
      formula('count', 'Count', 'Inventory.Quantity.Count()'),
    ] satisfies readonly ProviderProperty[];
    const snapshot = readySnapshot(properties, [
      row('zero', { quantity: 0 }),
      row('null', { quantity: null }),
      row('missing', {}),
    ]);
    const scope = createFormulaEvaluationScope(snapshot, resolveFormulaDatabaseTitle(databaseId, pages));

    expect(value(snapshot, properties, 'count', scope)).toEqual({ kind: 'number', value: 1 });
    for (const formulaId of ['sum', 'average', 'min', 'max']) {
      expect(value(snapshot, properties, formulaId, scope)).toMatchObject({
        kind: 'error',
        message: expect.stringContaining('only accepts finite numbers'),
      });
    }
  });

  it('rejects text and checkbox columns without coercion while Count ignores only null', () => {
    const properties = [
      scalar('quantity', 'Quantity'),
      scalar('memo', 'Memo', 'text'),
      checkbox('flag', 'Flag'),
      formula('bad-number', 'Bad numeric data', 'Inventory.Quantity.Sum()'),
      formula('bad-column', 'Text column', 'Inventory.Memo.Sum()'),
      formula('flag-column', 'Checkbox column', 'Inventory.Flag.Sum()'),
      formula('count', 'Count', 'Inventory.Quantity.Count()'),
    ] satisfies readonly ProviderProperty[];
    const snapshot = readySnapshot(properties, [
      row('r1', { quantity: 2, memo: '3', flag: true }),
      row('r2', { quantity: '4', memo: '8', flag: false }),
    ]);
    const scope = createFormulaEvaluationScope(snapshot, resolveFormulaDatabaseTitle(databaseId, pages));

    expect(value(snapshot, properties, 'bad-number', scope)).toMatchObject({ kind: 'error' });
    expect(value(snapshot, properties, 'bad-column', scope)).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('manual number columns'),
    });
    expect(value(snapshot, properties, 'flag-column', scope)).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('manual number columns'),
    });
    expect(value(snapshot, properties, 'count', scope)).toEqual({ kind: 'number', value: 2 });
  });

  it('returns fork-compatible empty aggregates and keeps the projection boundary to six methods', () => {
    const properties = [
      scalar('quantity', 'Quantity'),
      formula('sum', 'Sum', 'Inventory.Quantity.Sum()'),
      formula('average', 'Average', 'Inventory.Quantity.Average()'),
      formula('min', 'Min', 'Inventory.Quantity.Min()'),
      formula('max', 'Max', 'Inventory.Quantity.Max()'),
      formula('count', 'Count', 'Inventory.Quantity.Count()'),
      formula('first-method', 'First method', 'Inventory.Quantity.First()'),
      formula('first-function', 'First function', 'First(Inventory.Quantity)'),
      formula('raw-column', 'Raw column', 'Inventory.Quantity'),
      formula('caught-first', 'Caught First', 'IfError(Inventory.Quantity.First(), 9)'),
    ] satisfies readonly ProviderProperty[];
    const snapshot = readySnapshot(properties, []);
    const scope = createFormulaEvaluationScope(snapshot, resolveFormulaDatabaseTitle(databaseId, pages));

    expect(value(snapshot, properties, 'sum', scope)).toEqual({ kind: 'number', value: 0 });
    for (const formulaId of ['average', 'min', 'max']) {
      expect(value(snapshot, properties, formulaId, scope)).toEqual({ kind: 'null' });
    }
    expect(value(snapshot, properties, 'count', scope)).toEqual({ kind: 'number', value: 0 });
    for (const formulaId of ['first-method', 'first-function', 'raw-column']) {
      expect(value(snapshot, properties, formulaId, scope)).toMatchObject({ kind: 'error' });
    }
    expect(value(snapshot, properties, 'caught-first', scope)).toEqual({ kind: 'number', value: 9 });
  });

  it('preserves local properties and WithName aliases over a same-named database', () => {
    const properties = [
      scalar('inventory', 'Inventory'),
      formula('property', 'Property', 'Inventory * 2'),
      formula('alias', 'Alias', 'WithName(6, Inventory, Inventory + 1)'),
    ] satisfies readonly ProviderProperty[];
    const snapshot = readySnapshot(properties, [row('owner', { inventory: 4 })]);
    const scope = createFormulaEvaluationScope(snapshot, resolveFormulaDatabaseTitle(databaseId, pages));

    expect(value(snapshot, properties, 'property', scope)).toEqual({ kind: 'number', value: 8 });
    expect(value(snapshot, properties, 'alias', scope)).toEqual({ kind: 'number', value: 7 });
  });

  it('keeps a same-named property in ordinary identifier, function, and alias contexts', () => {
    const properties = [
      { id: 'inventory', name: 'Inventory', type: 'multiSelect', options: [] },
      scalar('quantity', 'Quantity'),
      formula('fallback', 'Fallback', 'IfError(Inventory, 9)'),
      formula('comparison', 'Comparison', 'Inventory = Inventory'),
      formula('text', 'Text', 'ToText(Inventory)'),
      formula('alias', 'Alias', 'WithName(Inventory, t, t.Quantity.Sum())'),
    ] satisfies readonly ProviderProperty[];
    const snapshot = readySnapshot(properties, [row('owner', { inventory: ['local', 'value'], quantity: 6 })]);
    const scope = createFormulaEvaluationScope(snapshot, resolveFormulaDatabaseTitle(databaseId, pages));

    expect(value(snapshot, properties, 'fallback', scope)).toEqual({ kind: 'list', value: ['local', 'value'] });
    expect(value(snapshot, properties, 'comparison', scope)).toEqual({ kind: 'boolean', value: false });
    expect(value(snapshot, properties, 'text', scope)).toEqual({ kind: 'text', value: 'local, value' });
    expect(value(snapshot, properties, 'alias', scope)).toMatchObject({ kind: 'error' });
  });

  it('diagnoses a property that shadows the table title only when a table projection is requested', () => {
    const properties = [
      scalar('inventory', 'Inventory'),
      scalar('quantity', 'Quantity'),
      formula('ordinary', 'Ordinary property', 'IfError(Inventory, 9)'),
      formula('projection', 'Projection', 'Inventory.Quantity.Sum()'),
    ] satisfies readonly ProviderProperty[];
    const snapshot = readySnapshot(properties, [row('owner', { inventory: 4, quantity: 6 })]);
    const scope = createFormulaEvaluationScope(snapshot, resolveFormulaDatabaseTitle(databaseId, pages));

    expect(value(snapshot, properties, 'ordinary', scope)).toEqual({ kind: 'number', value: 4 });
    expect(value(snapshot, properties, 'projection', scope)).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('current-database property has the same name'),
    });
  });

  it('keeps projection lookup lazy and supports aliased column keys with parenthesized roots', () => {
    const properties = [
      scalar('quantity', 'Quantity'),
      formula('lazy', 'Lazy', 'IfError(7, Inventory.Quantity.Sum())'),
      formula('with-name-key', 'WithName key', 'WithName("Quantity", q, ( Inventory )[q].Sum())'),
    ] satisfies readonly ProviderProperty[];
    const snapshot = readySnapshot(properties, [row('r1', { quantity: 2 }), row('r2', { quantity: 5 })]);
    const scope = createFormulaEvaluationScope(snapshot, resolveFormulaDatabaseTitle(databaseId, pages));

    expect(value(snapshot, properties, 'lazy', scope)).toEqual({ kind: 'number', value: 7 });
    expect(value(snapshot, properties, 'with-name-key', scope)).toEqual({ kind: 'number', value: 7 });
  });

  it('preserves ordinary table-title identifiers outside a projection receiver', () => {
    const properties = [
      scalar('quantity', 'Quantity'),
      formula('fallback', 'Fallback', 'IfError(Inventory, 9)'),
      formula('comparison', 'Comparison', 'IfError(Inventory = Inventory, false)'),
      formula('text', 'Text', 'ToText(Inventory)'),
      formula('alias', 'Alias', 'WithName(Inventory, t, t.Quantity.Sum())'),
    ] satisfies readonly ProviderProperty[];
    const snapshot = readySnapshot(properties, [row('owner', { quantity: 3 })]);
    const scope = createFormulaEvaluationScope(snapshot, resolveFormulaDatabaseTitle(databaseId, pages));

    expect(value(snapshot, properties, 'fallback', scope)).toEqual({ kind: 'number', value: 9 });
    expect(value(snapshot, properties, 'comparison', scope)).toEqual({ kind: 'boolean', value: false });
    expect(value(snapshot, properties, 'text', scope)).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('There is no property called'),
    });
    expect(value(snapshot, properties, 'alias', scope)).toMatchObject({ kind: 'error' });
  });

  it('preserves local numeric and dynamic list indexes when a table title is ambiguous', () => {
    const properties = [
      formula('inventory', 'Inventory', 'List(List(3, 5))'),
      formula('numeric-index', 'Numeric index', 'Inventory[0].Sum()'),
      formula('dynamic-index', 'Dynamic index', 'WithName(0, i, Inventory[i].Sum())'),
    ] satisfies readonly ProviderProperty[];
    const snapshot = readySnapshot(properties, [row('owner', {})]);
    const ambiguousTitle = resolveFormulaDatabaseTitle(databaseId, [
      ...pages,
      { id: 'other-inventory', title: ' inventory ', kind: 'database' },
    ]);
    const scope = createFormulaEvaluationScope(snapshot, ambiguousTitle);

    expect(value(snapshot, properties, 'numeric-index', scope)).toEqual({ kind: 'number', value: 8 });
    expect(value(snapshot, properties, 'dynamic-index', scope)).toEqual({ kind: 'number', value: 8 });
  });

  it('reports a bracket projection collision only for a literal column name and scalar local property', () => {
    const properties = [
      scalar('inventory', 'Inventory'),
      scalar('quantity', 'Quantity'),
      formula('projection', 'Projection', 'Inventory["Quantity"].Sum()'),
    ] satisfies readonly ProviderProperty[];
    const snapshot = readySnapshot(properties, [row('owner', { inventory: 4, quantity: 6 })]);
    const ambiguousTitle = resolveFormulaDatabaseTitle(databaseId, [
      ...pages,
      { id: 'other-inventory', title: 'Inventory', kind: 'database' },
    ]);
    const scope = createFormulaEvaluationScope(snapshot, ambiguousTitle);

    expect(value(snapshot, properties, 'projection', scope)).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('current-database property has the same name as the table'),
    });
  });

  it('diagnoses duplicate database titles without resolving a second snapshot', () => {
    const properties = [
      scalar('quantity', 'Quantity'),
      formula('sum', 'Sum', 'Inventory.Quantity.Sum()'),
    ] satisfies readonly ProviderProperty[];
    const snapshot = readySnapshot(properties, [row('r1', { quantity: 3 })]);
    const title = resolveFormulaDatabaseTitle(databaseId, [
      ...pages,
      { id: 'other-inventory', title: ' inventory ', kind: 'database' },
    ]);
    const scope = createFormulaEvaluationScope(snapshot, title);

    expect(title).toMatchObject({
      status: 'ambiguous',
      competingDatabaseIds: [databaseId, 'other-inventory'],
    });
    expect(value(snapshot, properties, 'sum', scope)).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('ambiguous'),
    });
  });

  it('filters the current snapshot by a manual checkbox, caches by predicate and column, and skips excluded values', () => {
    const properties = [
      checkbox('flag', 'Flag'),
      scalar('quantity', 'Quantity'),
      formula('filtered', 'Filtered total', 'Inventory.Filter(CurrentValue.Flag).Quantity.Sum()'),
      formula('filtered-again', 'Filtered again', 'Inventory.Filter(CurrentValue.Flag).Quantity.Sum()'),
    ] satisfies readonly ProviderProperty[];
    let flagReads = 0;
    let quantityReads = 0;
    const trackedRow = (id: string, flag: boolean, quantity: number | null): DataApiRow => {
      const rowProperties = Object.defineProperties({}, {
        flag: {
          enumerable: true,
          get() {
            flagReads += 1;
            return flag;
          },
        },
        quantity: {
          enumerable: true,
          get() {
            quantityReads += 1;
            if (!flag) throw new Error('An excluded quantity was read.');
            return quantity;
          },
        },
      }) as DataApiRow['properties'];
      return { id, title: id, properties: rowProperties };
    };
    const snapshot = readySnapshot(properties, [
      trackedRow('included-one', true, 2),
      trackedRow('excluded-null', false, null),
      trackedRow('included-two', true, 3),
    ]);
    const scope = createFormulaEvaluationScope(snapshot, resolveFormulaDatabaseTitle(databaseId, pages));

    expect(value(snapshot, properties, 'filtered', scope)).toEqual({ kind: 'number', value: 5 });
    expect(value(snapshot, properties, 'filtered-again', scope)).toEqual({ kind: 'number', value: 5 });
    expect(flagReads).toBe(3);
    expect(quantityReads).toBe(2);
    expect(scope.filteredRows.size).toBe(1);
    expect(scope.filteredColumns.size).toBe(1);
  });

  it('filters manual text by an exact literal and separates cached predicates by literal', () => {
    const properties = [
      scalar('status', 'Status', 'text'),
      scalar('amount', 'Amount'),
      formula('paid', 'Paid total', 'Inventory.Filter(CurrentValue.Status = "Pago").Amount.Sum()'),
      formula(
        'paid-equals',
        'Paid total with ==',
        'Inventory.Filter(CurrentValue.Status == "Pago").Amount.Sum()',
      ),
      formula('pending', 'Pending total', 'Inventory.Filter(CurrentValue.Status = "Pendente").Amount.Sum()'),
      formula('empty', 'Empty status total', 'Inventory.Filter(CurrentValue.Status = "").Amount.Sum()'),
      formula(
        'unmatched',
        'Unmatched total',
        'Inventory.Filter(CurrentValue.Status = "Cancelado").Amount.Sum()',
      ),
    ] satisfies readonly ProviderProperty[];
    const snapshot = readySnapshot(properties, [
      row('paid', { status: 'Pago', amount: 2 }),
      row('case-mismatch', { status: 'pago', amount: 3 }),
      row('pending', { status: 'Pendente', amount: 7 }),
      row('empty', { status: '', amount: 5 }),
      row('null', { status: null, amount: 11 }),
      row('missing', { amount: 13 }),
    ]);
    const scope = createFormulaEvaluationScope(snapshot, resolveFormulaDatabaseTitle(databaseId, pages));

    expect(value(snapshot, properties, 'paid', scope)).toEqual({ kind: 'number', value: 2 });
    expect(value(snapshot, properties, 'paid-equals', scope)).toEqual({ kind: 'number', value: 2 });
    expect(value(snapshot, properties, 'pending', scope)).toEqual({ kind: 'number', value: 7 });
    expect(value(snapshot, properties, 'empty', scope)).toEqual({ kind: 'number', value: 5 });
    expect(value(snapshot, properties, 'unmatched', scope)).toEqual({ kind: 'number', value: 0 });
    expect(scope.filteredRows.size).toBe(4);
    expect(scope.filteredColumns.size).toBe(4);
  });

  it('resolves select IDs through the snapshot options and keeps distinct option-name filters', () => {
    const properties = [
      selection('status', 'Status', [
        { id: 'paid-option', name: 'Pago', color: 'green' },
        { id: 'pending-option', name: 'Pendente', color: 'gray' },
      ]),
      scalar('amount', 'Amount'),
      formula('paid', 'Paid total', 'Inventory.Filter(CurrentValue.Status = "Pago").Amount.Sum()'),
      formula('pending', 'Pending total', 'Inventory.Filter(CurrentValue.Status == "Pendente").Amount.Sum()'),
      formula(
        'option-id',
        'Option ID literal',
        'Inventory.Filter(CurrentValue.Status = "paid-option").Amount.Sum()',
      ),
    ] satisfies readonly ProviderProperty[];
    const snapshot = readySnapshot(properties, [
      row('paid', { status: 'paid-option', amount: 2 }),
      row('pending', { status: 'pending-option', amount: 7 }),
      row('null', { status: null, amount: 11 }),
      row('missing', { amount: 13 }),
    ]);
    const scope = createFormulaEvaluationScope(snapshot, resolveFormulaDatabaseTitle(databaseId, pages));

    expect(value(snapshot, properties, 'paid', scope)).toEqual({ kind: 'number', value: 2 });
    expect(value(snapshot, properties, 'pending', scope)).toEqual({ kind: 'number', value: 7 });
    expect(value(snapshot, properties, 'option-id', scope)).toEqual({ kind: 'number', value: 0 });
    expect(scope.filteredRows.size).toBe(3);
    expect(scope.filteredColumns.size).toBe(3);

    const invalid = readySnapshot(properties, [
      row('unknown-option', { status: 'removed-option', amount: 1 }),
    ]);
    expect(value(invalid, properties, 'paid')).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('unknown select option'),
    });
  });

  it('diagnoses conflicting labels only when a row uses the repeated select ID', () => {
    const properties = [
      selection('status', 'Status', [
        { id: 'same-label', name: 'Pago', color: 'green' },
        { id: 'same-label', name: 'Pago', color: 'gray' },
        { id: 'conflicting-labels', name: 'Pago', color: 'green' },
        { id: 'conflicting-labels', name: 'Pendente', color: 'gray' },
      ]),
      scalar('amount', 'Amount'),
      formula('paid', 'Paid total', 'Inventory.Filter(CurrentValue.Status = "Pago").Amount.Sum()'),
      formula(
        'fallback',
        'Error fallback',
        'IfError(Inventory.Filter(CurrentValue.Status = "Pago").Amount.Sum(), 44)',
      ),
    ] satisfies readonly ProviderProperty[];
    const normalSnapshot = readySnapshot(properties, [row('normal', { status: 'same-label', amount: 2 })]);
    const normalScope = createFormulaEvaluationScope(
      normalSnapshot,
      resolveFormulaDatabaseTitle(databaseId, pages),
    );
    expect(value(normalSnapshot, properties, 'paid', normalScope)).toEqual({ kind: 'number', value: 2 });

    const conflictingSnapshot = readySnapshot(properties, [
      row('conflicting', { status: 'conflicting-labels', amount: 3 }),
    ]);
    const conflictingScope = createFormulaEvaluationScope(
      conflictingSnapshot,
      resolveFormulaDatabaseTitle(databaseId, pages),
    );
    expect(value(conflictingSnapshot, properties, 'paid', conflictingScope)).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('conflicting labels for select option ID “conflicting-labels”'),
    });
    expect(value(conflictingSnapshot, properties, 'fallback', conflictingScope)).toEqual({
      kind: 'number',
      value: 44,
    });
  });

  it('diagnoses unknown, ambiguous and non-text predicate columns and preserves IfError fallback', () => {
    const properties = [
      scalar('status', 'Status', 'text'),
      scalar('duplicate-status', ' status ', 'text'),
      scalar('amount', 'Amount'),
      scalar('quantity', 'Quantity'),
      formula('unknown', 'Unknown column', 'Inventory.Filter(CurrentValue.Missing = "Pago").Quantity.Sum()'),
      formula(
        'ambiguous',
        'Ambiguous column',
        'Inventory.Filter(CurrentValue.Status = "Pago").Quantity.Sum()',
      ),
      formula('wrong-type', 'Wrong type', 'Inventory.Filter(CurrentValue.Amount == "2").Quantity.Sum()'),
      formula(
        'fallback',
        'Error fallback',
        'IfError(Inventory.Filter(CurrentValue.Amount = "2").Quantity.Sum(), 44)',
      ),
    ] satisfies readonly ProviderProperty[];
    const snapshot = readySnapshot(properties, [
      row('r1', { status: 'Pago', 'duplicate-status': 'Pago', amount: 2, quantity: 1 }),
    ]);
    const scope = createFormulaEvaluationScope(snapshot, resolveFormulaDatabaseTitle(databaseId, pages));

    expect(value(snapshot, properties, 'unknown', scope)).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('There is no column called'),
    });
    expect(value(snapshot, properties, 'ambiguous', scope)).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('is ambiguous'),
    });
    expect(value(snapshot, properties, 'wrong-type', scope)).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('manual text or select columns'),
    });
    expect(value(snapshot, properties, 'fallback', scope)).toEqual({ kind: 'number', value: 44 });
  });

  it('rejects malformed text cells and non-direct equality predicates without reading rows', () => {
    const properties = [
      scalar('status', 'Status', 'text'),
      scalar('amount', 'Amount'),
      scalar('quantity', 'Quantity'),
      formula(
        'malformed-cell',
        'Malformed cell',
        'Inventory.Filter(CurrentValue.Status = "Pago").Quantity.Sum()',
      ),
      formula(
        'computed-predicate',
        'Computed predicate',
        'Inventory.Filter(CurrentValue.Status = ToText("Pago")).Quantity.Sum()',
      ),
      formula(
        'compound-predicate',
        'Compound predicate',
        'Inventory.Filter(CurrentValue.Status = "Pago" && true).Quantity.Sum()',
      ),
    ] satisfies readonly ProviderProperty[];
    const snapshot = readySnapshot(properties, [
      row('invalid-status', { status: true, amount: 2, quantity: 1 }),
    ]);
    const scope = createFormulaEvaluationScope(snapshot, resolveFormulaDatabaseTitle(databaseId, pages));

    expect(value(snapshot, properties, 'malformed-cell', scope)).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('must contain text'),
    });
    for (const formulaId of ['computed-predicate', 'compound-predicate']) {
      expect(value(snapshot, properties, formulaId, scope)).toMatchObject({ kind: 'error' });
    }
  });

  it('rejects missing or null checkbox predicates and reads quantities only for selected rows', () => {
    const properties = [
      checkbox('flag', 'Flag'),
      scalar('quantity', 'Quantity'),
      formula('filtered', 'Filtered total', 'Inventory.Filter(CurrentValue.Flag).Quantity.Sum()'),
    ] satisfies readonly ProviderProperty[];
    const formulaId = 'filtered';
    for (const [id, propertiesValue] of [
      ['missing-flag', { quantity: 9 }],
      ['null-flag', { flag: null, quantity: 9 }],
    ] as const) {
      const snapshot = readySnapshot(properties, [row(id, propertiesValue)]);
      const scope = createFormulaEvaluationScope(snapshot, resolveFormulaDatabaseTitle(databaseId, pages));
      expect(value(snapshot, properties, formulaId, scope)).toMatchObject({
        kind: 'error',
        message: expect.stringContaining(id === 'missing-flag' ? 'is missing' : 'non-null boolean'),
      });
      expect(scope.filteredColumns.size).toBe(0);
    }

    const selectedNull = readySnapshot(properties, [row('selected-null', { flag: true, quantity: null })]);
    expect(value(selectedNull, properties, formulaId)).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('only accepts finite numbers'),
    });

    const excludedNull = readySnapshot(properties, [row('excluded-null', { flag: false, quantity: null })]);
    expect(value(excludedNull, properties, formulaId)).toEqual({ kind: 'number', value: 0 });

    const selectedMissing = readySnapshot(properties, [row('selected-missing', { flag: true })]);
    expect(value(selectedMissing, properties, formulaId)).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('only accepts finite numbers'),
    });

    const excludedMissing = readySnapshot(properties, [row('excluded-missing', { flag: false })]);
    expect(value(excludedMissing, properties, formulaId)).toEqual({ kind: 'number', value: 0 });
  });

  it('keeps filtered table access to the direct checkbox Sum chain', () => {
    const properties = [
      checkbox('flag', 'Flag'),
      scalar('quantity', 'Quantity'),
      scalar('name', 'Name', 'text'),
      formula('general', 'General predicate', 'Inventory.Filter(CurrentValue.Flag && true).Quantity.Sum()'),
      formula('average', 'Filtered average', 'Inventory.Filter(CurrentValue.Flag).Quantity.Average()'),
      formula('chained', 'Chained filter', 'Inventory.Filter(CurrentValue.Flag).Filter(CurrentValue.Flag).Quantity.Sum()'),
      formula('text-filter', 'Text filter', 'Inventory.Filter(CurrentValue.Name).Quantity.Sum()'),
    ] satisfies readonly ProviderProperty[];
    let reads = 0;
    const snapshot = readySnapshot(properties, [
      {
        id: 'r1',
        title: 'R1',
        get properties() {
          reads += 1;
          return { flag: true, quantity: 2, name: 'one' } as DataApiRow['properties'];
        },
      } as DataApiRow,
    ]);
    const scope = createFormulaEvaluationScope(snapshot, resolveFormulaDatabaseTitle(databaseId, pages));

    for (const formulaId of ['general', 'average', 'chained', 'text-filter']) {
      expect(value(snapshot, properties, formulaId, scope)).toMatchObject({ kind: 'error' });
    }
    expect(reads).toBe(0);
    expect(scope.filteredRows.size).toBe(0);
  });

  it('checks built-in CurrentValue identity before cache access in both evaluation orders', () => {
    const properties = [
      checkbox('flag', 'Flag'),
      scalar('status', 'Status', 'text'),
      scalar('quantity', 'Quantity'),
      formula('filtered', 'Filtered total', 'Inventory.Filter(CurrentValue.Flag).Quantity.Sum()'),
      formula(
        'filtered-text',
        'Filtered text total',
        'Inventory.Filter(CurrentValue.Status = "Pago").Quantity.Sum()',
      ),
      formula(
        'shadowed-current-value',
        'Shadowed CurrentValue',
        'WithName(9, CurrentValue, Inventory.Filter(CurrentValue.Flag).Quantity.Sum())',
      ),
      formula(
        'shadowed-text-current-value',
        'Shadowed text CurrentValue',
        'WithName(9, CurrentValue, Inventory.Filter(CurrentValue.Status = "Pago").Quantity.Sum())',
      ),
    ] satisfies readonly ProviderProperty[];
    const snapshot = readySnapshot(properties, [row('r1', { flag: true, status: 'Pago', quantity: 2 })]);
    const title = resolveFormulaDatabaseTitle(databaseId, pages);
    const aliasFirstScope = createFormulaEvaluationScope(snapshot, title);

    expect(value(snapshot, properties, 'shadowed-current-value', aliasFirstScope)).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('shadows the built-in CurrentValue'),
    });
    expect(value(snapshot, properties, 'shadowed-text-current-value', aliasFirstScope)).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('shadows the built-in CurrentValue'),
    });
    expect(aliasFirstScope.filteredRows.size).toBe(0);
    expect(value(snapshot, properties, 'filtered', aliasFirstScope)).toEqual({ kind: 'number', value: 2 });
    expect(value(snapshot, properties, 'filtered-text', aliasFirstScope)).toEqual({
      kind: 'number',
      value: 2,
    });

    const warmedScope = createFormulaEvaluationScope(snapshot, title);
    expect(value(snapshot, properties, 'filtered', warmedScope)).toEqual({ kind: 'number', value: 2 });
    expect(value(snapshot, properties, 'shadowed-current-value', warmedScope)).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('shadows the built-in CurrentValue'),
    });
    expect(value(snapshot, properties, 'shadowed-text-current-value', warmedScope)).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('shadows the built-in CurrentValue'),
    });
    expect(value(snapshot, properties, 'filtered', warmedScope)).toEqual({ kind: 'number', value: 2 });
  });

  it('checks the filter row limit before reading any row properties', () => {
    const properties = [
      checkbox('flag', 'Flag'),
      scalar('status', 'Status', 'text'),
      scalar('quantity', 'Quantity'),
      formula('filtered', 'Filtered total', 'Inventory.Filter(CurrentValue.Flag).Quantity.Sum()'),
      formula(
        'filtered-text',
        'Filtered text total',
        'Inventory.Filter(CurrentValue.Status = "Pago").Quantity.Sum()',
      ),
    ] satisfies readonly ProviderProperty[];
    let rowPropertyReads = 0;
    const rows = Array.from({ length: 2001 }, (_, index) => ({
      id: `oversized-${index}`,
      title: `Oversized ${index}`,
      get properties() {
        rowPropertyReads += 1;
        return { flag: true, quantity: 1 } as DataApiRow['properties'];
      },
    })) as DataApiRow[];
    const snapshot = readySnapshot(properties, rows);
    const scope = createFormulaEvaluationScope(snapshot, resolveFormulaDatabaseTitle(databaseId, pages));

    for (const formulaId of ['filtered', 'filtered-text']) {
      expect(value(snapshot, properties, formulaId, scope)).toMatchObject({
        kind: 'error',
        message: expect.stringContaining('limited to 2000 rows'),
      });
    }
    expect(rowPropertyReads).toBe(0);
  });

  it('accepts exactly 2,000 rows for a text filter', () => {
    const properties = [
      scalar('status', 'Status', 'text'),
      scalar('quantity', 'Quantity'),
      formula('filtered', 'Filtered total', 'Inventory.Filter(CurrentValue.Status = "Pago").Quantity.Sum()'),
    ] satisfies readonly ProviderProperty[];
    const rows = Array.from({ length: 2000 }, (_, index) =>
      row(`included-${index}`, { status: 'Pago', quantity: 1 }),
    );
    const snapshot = readySnapshot(properties, rows);
    const scope = createFormulaEvaluationScope(snapshot, resolveFormulaDatabaseTitle(databaseId, pages));

    expect(value(snapshot, properties, 'filtered', scope)).toEqual({ kind: 'number', value: 2000 });
  });

  it('caches each projected property within the snapshot and checks the 2,000-row limit before reading rows', () => {
    const properties = [
      scalar('quantity', 'Quantity'),
      formula('sum-one', 'Sum one', 'Inventory.Quantity.Sum()'),
      formula('sum-two', 'Sum two', 'Inventory.Quantity.Sum()'),
    ] satisfies readonly ProviderProperty[];
    let reads = 0;
    const rows = Array.from({ length: 2000 }, (_, index) => ({
      id: `row-${index}`,
      title: `Row ${index}`,
      get properties() {
        reads += 1;
        return { quantity: 1 } as DataApiRow['properties'];
      },
    })) as DataApiRow[];
    const snapshot = readySnapshot(properties, rows);
    const scope = createFormulaEvaluationScope(snapshot, resolveFormulaDatabaseTitle(databaseId, pages));

    expect(value(snapshot, properties, 'sum-one', scope)).toEqual({ kind: 'number', value: 2000 });
    expect(value(snapshot, properties, 'sum-two', scope)).toEqual({ kind: 'number', value: 2000 });
    expect(reads).toBe(2000);

    let oversizedRowReads = 0;
    const oversizedRows = Array.from({ length: 2001 }, (_, index) => ({
      id: `oversized-${index}`,
      title: `Oversized ${index}`,
      get properties() {
        oversizedRowReads += 1;
        return { quantity: 1 } as DataApiRow['properties'];
      },
    })) as DataApiRow[];
    const oversized = readySnapshot(properties, oversizedRows);
    const oversizedScope = createFormulaEvaluationScope(
      oversized,
      resolveFormulaDatabaseTitle(databaseId, pages),
    );
    expect(value(oversized, properties, 'sum-one', oversizedScope)).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('limited to 2000 rows'),
    });
    expect(oversizedRowReads).toBe(0);
  });
});
