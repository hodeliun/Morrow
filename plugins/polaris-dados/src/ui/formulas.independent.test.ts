import { describe, expect, it } from 'vitest';
import type { DataApiRow } from '../../../../src/app/plugins/dataApi';
import { computeRuntimeFormula } from '../engine/formula';
import { evaluateCell } from './formulas';
import type { EvaluatedCell, ProviderProperty } from './formulas';

function scalar(id: string, name: string, type: 'number' | 'text' | 'checkbox' = 'text'): ProviderProperty {
  return { id, name, type, options: [] };
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
    id: 'synthetic-row',
    title: 'Synthetic row',
    properties: rowProperties as DataApiRow['properties'],
  };
  const target = properties.find((property) => property.id === formulaId);
  if (!target) throw new Error(`Missing formula ${formulaId}.`);
  return evaluateCell(row, properties, target);
}

describe('independent Polaris Dados thisRow verification', () => {
  it('resolves literal, dynamic, member, and WithName property names independently', () => {
    const properties = [
      scalar('this-row', 'thisRow'),
      scalar('title', 'Title'),
      scalar('field-name', 'FieldName'),
      formula('literal', 'Literal property', 'prop("thisRow")'),
      formula('dynamic', 'Dynamic property', 'prop(FieldName)'),
      formula('member', 'Member property', 'thisRow.thisRow'),
      formula('alias', 'thisRow alias', 'WithName("thisRow", thisRow, prop(thisRow))'),
      formula('other-alias', 'Other alias', 'WithName("Title", "lookup", prop(lookup))'),
    ] satisfies readonly ProviderProperty[];
    const row = { 'this-row': 'literal thisRow value', title: 'Page title', 'field-name': 'thisRow' };

    expect(evaluate(properties, row, 'literal')).toEqual({ kind: 'text', value: 'literal thisRow value' });
    expect(evaluate(properties, row, 'dynamic')).toEqual({ kind: 'text', value: 'literal thisRow value' });
    expect(evaluate(properties, row, 'member')).toEqual({ kind: 'text', value: 'literal thisRow value' });
    expect(evaluate(properties, row, 'alias')).toEqual({ kind: 'text', value: 'literal thisRow value' });
    expect(evaluate(properties, row, 'other-alias')).toEqual({ kind: 'text', value: 'Page title' });
  });

  it('uses the optional prop resolver and preserves the legacy fallback receiver', () => {
    const calls: string[] = [];
    const context = {
      prefix: 'legacy',
      resolveIdentifier(this: { readonly prefix: string }, name: string) {
        calls.push(`${this.prefix}:${name}`);
        return name === 'FieldName' ? 'thisRow' : `fallback:${name}`;
      },
      resolveProperty(name: string) {
        calls.push(`property:${name}`);
        return `resolved:${name}`;
      },
    };

    expect(computeRuntimeFormula('prop(FieldName)', context)).toEqual({
      value: 'resolved:thisRow',
      error: null,
    });
    expect(calls).toEqual(['legacy:FieldName', 'property:thisRow']);

    const fallback = {
      prefix: 'original-context',
      resolveIdentifier(this: { readonly prefix: string }, name: string) {
        return `${this.prefix}:${name}`;
      },
    };
    expect(computeRuntimeFormula('prop("Name")', fallback)).toEqual({
      value: 'original-context:Name',
      error: null,
    });
  });

  it('preserves zero, false, empty, null, and absent values without changing the row', () => {
    const properties = [
      scalar('zero', 'Zero', 'number'),
      scalar('flag', 'Flag', 'checkbox'),
      scalar('empty', 'Empty text'),
      scalar('nullable', 'Nullable'),
      scalar('optional', 'Optional'),
      formula('zero-result', 'Zero result', 'thisRow.Zero'),
      formula('false-result', 'False result', 'thisRow.Flag'),
      formula('empty-result', 'Empty result', 'thisRow["Empty text"]'),
      formula('null-result', 'Null result', 'thisRow.Nullable'),
      formula('absent-result', 'Absent result', 'thisRow.Optional'),
    ] satisfies readonly ProviderProperty[];
    const rowProperties = Object.freeze({ zero: 0, flag: false, empty: '', nullable: null });
    const row: DataApiRow = {
      id: 'synthetic-row',
      title: 'Synthetic row',
      properties: rowProperties as DataApiRow['properties'],
    };
    const before = structuredClone(row.properties);

    for (const [propertyId, expected] of [
      ['zero-result', { kind: 'number', value: 0 }],
      ['false-result', { kind: 'boolean', value: false }],
      ['empty-result', { kind: 'text', value: '' }],
      ['null-result', { kind: 'null' }],
      ['absent-result', { kind: 'null' }],
    ] as const) {
      const target = properties.find((property) => property.id === propertyId)!;
      expect(evaluateCell(row, properties, target)).toEqual(expected);
    }
    expect(Object.hasOwn(row.properties, 'optional')).toBe(false);
    expect(row.properties).toEqual(before);
    expect(Object.keys(row.properties)).not.toContain('zero-result');
  });

  it('rejects prototype and host-global member access as unknown properties', () => {
    const expressions = [
      'thisRow.constructor',
      'thisRow.toString',
      'thisRow.__proto__',
      'thisRow.valueOf',
      'prop("constructor")',
      'globalThis',
      'process',
      'window',
    ];
    const properties = expressions.map((expression, index) =>
      formula(`unsafe-${index}`, `Unsafe ${index}`, expression),
    );

    for (const property of properties) {
      expect(evaluate(properties, {}, property.id)).toMatchObject({ kind: 'error' });
    }
  });

  it('rejects row references recursively but preserves nested scalar lists', () => {
    const properties = [
      formula('direct-row', 'Direct row', 'thisRow'),
      formula('row-list', 'Row list', '[thisRow]'),
      formula('nested-row-list', 'Nested row list', '[[thisRow]]'),
      formula('alias-row-list', 'Alias row list', 'WithName(thisRow, "row", [[row]])'),
      formula('scalar-list', 'Scalar list', '[0, [false, ["", null]]]'),
    ] satisfies readonly ProviderProperty[];
    const rowProperties = { value: 0 };
    const before = structuredClone(rowProperties);
    const unsupported = {
      kind: 'error',
      message: 'This table does not display row references or tables.',
    };

    expect(evaluate(properties, rowProperties, 'direct-row')).toEqual(unsupported);
    expect(evaluate(properties, rowProperties, 'row-list')).toEqual(unsupported);
    expect(evaluate(properties, rowProperties, 'nested-row-list')).toEqual(unsupported);
    expect(evaluate(properties, rowProperties, 'alias-row-list')).toEqual(unsupported);
    expect(evaluate(properties, rowProperties, 'scalar-list')).toEqual({
      kind: 'list',
      value: [0, [false, ['', null]]],
    });
    expect(rowProperties).toEqual(before);
  });

  it('detects mixed cycles and enforces formula depth and work budgets', () => {
    const cyclic = [
      formula('first', 'First', 'thisRow.Second'),
      formula('second', 'Second', 'WithName("first", "alias", prop(alias))'),
    ] satisfies readonly ProviderProperty[];
    expect(evaluate(cyclic, {}, 'first')).toMatchObject({ kind: 'error', message: /cycle/i });

    const depthChain = Array.from({ length: 25 }, (_, index) =>
      formula(`depth-${index}`, `Depth ${index}`, index === 0 ? '1' : `thisRow["Depth ${index - 1}"] + 1`),
    );
    expect(evaluate(depthChain, {}, 'depth-24')).toMatchObject({
      kind: 'error',
      message: 'Formula references are nested too deeply.',
    });

    const leaves = Array.from({ length: 64 }, (_, index) => formula(`leaf-${index}`, `Leaf ${index}`, '1'));
    const aggregate = formula(
      'aggregate',
      'Aggregate',
      leaves.map((property) => `thisRow["${property.name}"]`).join(' + '),
    );
    expect(evaluate([...leaves, aggregate], {}, 'aggregate')).toMatchObject({
      kind: 'error',
      message: 'This formula references too many calculated properties.',
    });
  });
});
