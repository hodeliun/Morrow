import { describe, expect, it } from 'vitest';
import { computeRuntimeFormula } from './formula';
import { applyCommand } from './commands';
import { bindPageFormulaReferences, documentFormulaResult } from './database';
import { emptyWorkspace } from './model';

describe('date range list endpoints', () => {
  it('returns the last ISO endpoint without converting it into a relation identity', () => {
    expect(computeRuntimeFormula('First(["2024-02-29", "2024-03-01"])', {})).toEqual({ value: '2024-02-29', error: null });
    expect(computeRuntimeFormula('Last(["2024-02-29", "2024-03-01"])', {})).toEqual({ value: '2024-03-01', error: null });
  });

  it('preserves empty, null, false and zero endpoint semantics', () => {
    for (const [source, value] of [['Last([])', null], ['Last(null)', null], ['Last([1,0])', 0], ['Last([true,false])', false], ['Last(["a",""])', '']] as const)
      expect(computeRuntimeFormula(source, {})).toEqual({ value, error: null });
  });

  it('mirrors First scalar coercion and rejects invalid arity', () => {
    expect(computeRuntimeFormula('Last(5)', {})).toEqual(computeRuntimeFormula('First(5)', {}));
    expect(computeRuntimeFormula('Last()', {}).error).not.toBeNull();
    expect(computeRuntimeFormula('Last([1],2)', {}).error).not.toBeNull();
  });

  it('binds global and method endpoint calls to the same typed date-range control', () => {
    const created = applyCommand(emptyWorkspace(), { type: 'page.create', id: 'range-note', parentId: null, title: 'Range', now: 1 });
    if (!created.ok) throw new Error(created.error);
    const configured = applyCommand(created.value.state, { type: 'page.control.configure', id: 'range-note', now: 2,
      control: { id: 'period', name: 'Period', type: 'dateRange', value: ['2024-02-29', '2024-03-01'], defaultValue: null, options: [] } });
    if (!configured.ok) throw new Error(configured.error);
    const state = configured.value.state;
    for (const [source, value] of [['First(Period)', '2024-02-29'], ['Period.First()', '2024-02-29'], ['Last(Period)', '2024-03-01'], ['Period.Last()', '2024-03-01']] as const) {
      const bindings = bindPageFormulaReferences(source, 'range-note', state);
      expect(bindings.some(binding => binding.kind === 'control' && binding.pageId === 'range-note' && binding.controlId === 'period')).toBe(true);
      expect(documentFormulaResult('range-note', source, source, bindings, state)).toEqual({ value, error: null });
    }
  });
});
