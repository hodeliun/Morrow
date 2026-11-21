import { describe, expect, it } from 'vitest';
import type { DataApiRow } from '../../../../src/app/plugins/dataApi';
import { evaluateCell } from './formulas';
import type { EvaluatedCell, ProviderProperty } from './formulas';

function scalar(id: string, name: string, type: 'number' | 'text' = 'number'): ProviderProperty {
  return { id, name, type, options: [] };
}

function checkbox(id: string, name: string): ProviderProperty {
  return { id, name, type: 'checkbox', options: [] };
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
