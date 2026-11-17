import { describe, expect, it } from 'vitest';
import { computeRuntimeFormula, parseFormula } from './formula';
import type { FormulaEvaluationContext } from './formula';

const now = new Date(2026, 9, 16, 12, 0, 0);

function compute(source: string, values: Record<string, number | string | boolean | null> = {}) {
  const context: FormulaEvaluationContext = {
    resolveIdentifier(name) {
      if (!Object.hasOwn(values, name)) throw new Error(`There is no formula value called “${name}”`);
      return values[name]!;
    },
  };
  return computeRuntimeFormula(source, context, now);
}

describe('independent Polaris Dados formula-engine semantics', () => {
  it('computes ordinary numeric formulas with the source engine precedence', () => {
    expect(compute('Quantity * Price', { Quantity: 2, Price: 10 })).toEqual({
      value: 20,
      error: null,
    });
    expect(compute('Quantity * Price', { Quantity: 3, Price: 10 })).toEqual({
      value: 30,
      error: null,
    });
    expect(compute('Quantity + Price', { Quantity: 20, Price: 10 })).toEqual({
      value: 30,
      error: null,
    });
    expect(compute('2 + 3 * 4')).toEqual({ value: 14, error: null });
    expect(compute('-(1 + 2) * 3')).toEqual({ value: -9, error: null });
    expect(compute('2 ^ 3 ^ 2')).toEqual({ value: 512, error: null });
    expect(compute('round(10 / 3, 2)')).toEqual({ value: 3.33, error: null });
  });

  it('preserves zero, false, and null as distinct formula values', () => {
    expect(compute('List(IfError(0, 1 / 0), IfError(false, 1 / 0), IfError(null, 1 / 0))')).toEqual({
      value: [0, false, null],
      error: null,
    });
    expect(compute('If(0, 99, 5)')).toEqual({ value: 5, error: null });
    expect(compute('IsBlank(null)')).toEqual({ value: true, error: null });
    expect(compute('IsBlank(false)')).toEqual({ value: false, error: null });
  });

  it('keeps conditional and logical branches lazy', () => {
    expect(compute('If(false, 1 / 0, 0)')).toEqual({ value: 0, error: null });
    expect(compute('false && MissingValue')).toEqual({ value: false, error: null });
    expect(compute('true || MissingValue')).toEqual({ value: true, error: null });
    expect(compute('IfError(MissingValue, 4)')).toEqual({ value: 4, error: null });
  });

  it('returns bounded arithmetic, parsing, and identifier failures as errors', () => {
    expect(compute('1 / 0').error).toContain('Division by zero');
    expect(compute('sqrt(-1)').error).toContain('non-negative');
    expect(compute('1e308 * 1e308').error).toContain('supported range');
    expect(compute('MissingValue').error).toContain('MissingValue');
    expect(compute('"unterminated').error).toContain('quote');
    expect(() => parseFormula('1'.repeat(2_001))).toThrow(/too long/i);
  });

  it('uses the injected clock consistently for dates and calendar arithmetic', () => {
    expect(compute('DateBetween("2026-10-20", Today(), "days")')).toEqual({ value: 4, error: null });
    expect(compute('DateAdd("2026-01-31", 1, "months")')).toEqual({
      value: '2026-02-28',
      error: null,
    });
    expect(compute('DateBetween("2026-10-16T10:00:00Z", "2026-10-16T08:00:00Z", "hours")')).toEqual({
      value: 2,
      error: null,
    });
    expect(compute('DateAdd("2026-02-30", 1, "days")').error).toContain('valid date');
  });
});
