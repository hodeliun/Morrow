import { describe, expect, it } from 'vitest';
import { computeFormula, computeRuntimeFormula, formulaUsesCurrentTime, parseFormula } from './formula';

const fixedNow = new Date(2026, 9, 16, 12);
const defaultProperties: Record<string, number | string | boolean | null> = {
  Price: 12.5,
  Count: 4,
  Done: true,
  Due: '2026-10-20',
  Name: 'Tea',
};
const run = (
  source: string,
  properties: Record<string, number | string | boolean | null> = defaultProperties,
) =>
  computeRuntimeFormula(
    source,
    {
      resolveIdentifier(name) {
        if (!Object.prototype.hasOwnProperty.call(properties, name))
          throw new Error(`There is no value or table called “${name}”`);
        return properties[name]!;
      },
    },
    fixedNow,
  );

describe('Polaris Dados formula engine extraction', () => {
  it('evaluates the P1 quantity and price formula with independent rows', () => {
    expect(run('Quantity * Price', { Quantity: 2, Price: 10 })).toEqual({ value: 20, error: null });
    expect(run('Quantity * Price', { Quantity: 3, Price: 10 })).toEqual({ value: 30, error: null });
  });

  it('preserves fork arithmetic, operator precedence, and rounding behavior', () => {
    expect(run('prop("Price") * prop("Count") + 1').value).toBe(51);
    expect(run('2 ^ 3 ^ 2').value).toBe(512);
    expect(run('-(1 + 2) * 3').value).toBe(-9);
    expect(run('round(10 / 3, 2)').value).toBe(3.33);
    expect(run('Round(1.005, 2)').value).toBe(1.01);
    expect(run('If(false, 1 / 0, 0)').value).toBe(0);
  });

  it('preserves fork text, conditional, and logical behavior', () => {
    expect(run('if(prop("Done"), "✅ done", "⏳ open")').value).toBe('✅ done');
    expect(run('concat(upper(prop("Name")), "!")').value).toBe('TEA!');
    expect(run('prop("Name") + " x" + prop("Count")').value).toBe('Tea x4');
    expect(run('prop("Count") > 3 and not empty(prop("Name"))').value).toBe(true);
    expect(run('contains(prop("Name"), "e")').value).toBe(true);
  });

  it('keeps zero, false, blank, and evaluation errors distinct', () => {
    expect(run('List(0, false, null)')).toEqual({ value: [0, false, null], error: null });
    expect(run('null')).toEqual({ value: null, error: null });
    expect(run('1 / 0')).toEqual({ value: null, error: 'Division by zero is not allowed' });
    expect(run('IfError(1 / 0, "fallback")')).toEqual({ value: 'fallback', error: null });
    expect(run('IfError(List(null, false, 0), 1 / 0)').value).toEqual([null, false, 0]);
  });

  it('retains pure date formula behavior from the fork', () => {
    expect(run('dateBetween(prop("Due"), today(), "days")').value).toBe(4);
    expect(run('DateAdd("2026-01-31", 1, "months")').value).toBe('2026-02-28');
    expect(run('DateAdd("2026-02-30", 1, "days")').error).toContain('valid date');
    expect(run('DateBetween("2026-10-16T10:00:00Z", "2026-10-16T08:00:00Z", "hours")').value).toBe(2);
  });

  it('preserves fork list functions and aliases', () => {
    expect(run('WithName(5, x, x * 2)').value).toBe(10);
    expect(run('WithName(5, "x", WithName(x + 1, y, x + y))').value).toBe(11);
    expect(run('FormulaMap([1, 2, 3], CurrentValue * 2)').value).toEqual([2, 4, 6]);
    expect(run('ForEach(List(1, 2, 3), CurrentValue + 1)').value).toEqual([2, 3, 4]);
    expect(run('Unique([1, 1, 2])').value).toEqual([1, 2]);
    expect(run('[]').value).toEqual([]);
    expect(run('IsBlank([])').value).toBe(true);
    expect(run('Switch("paid", "open", 0, "paid", 2, 3)').value).toBe(2);
    expect(run('Mod(7, 4)').value).toBe(3);
    expect(run('ToNumber("no")').error).toContain('Expected a number');
  });

  it('reports invalid syntax and preserves parser length and depth bounds', () => {
    expect(run('Quantity *').error).toBeTruthy();
    expect(run('"open').error).toContain('quote');
    expect(() => parseFormula('1'.repeat(2001))).toThrow('This formula is too long');
    expect(() => parseFormula(`${'('.repeat(70)}1${')'.repeat(70)}`)).toThrow('This formula is nested too deeply');
    expect(run('nope(1)').error).toContain('nope');
    expect(run('').value).toBeNull();
  });

  it('reports whether a parsed formula depends on current time', () => {
    expect(formulaUsesCurrentTime('Now()')).toBe(true);
    expect(formulaUsesCurrentTime('Today()')).toBe(true);
    expect(formulaUsesCurrentTime('Quantity * Price')).toBe(false);
    expect(formulaUsesCurrentTime('Today(')).toBe(false);
  });

  it('retains the scalar compatibility API', () => {
    const properties = { Price: 12.5, Count: 4 };
    expect(computeFormula('prop("Price") * prop("Count")', (name) => properties[name as keyof typeof properties] ?? null))
      .toEqual({ value: 50, error: null });
  });

  it('preserves the evaluator work bound for nested list functions', () => {
    expect(run('FormulaMap(Sequence(1, 100), FormulaMap(Sequence(1, 100), CurrentValue))').error)
      .toContain('This formula takes too long');
  });
});
