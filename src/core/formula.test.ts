import { describe, expect, it } from 'vitest';
import { computeFormula, computeRuntimeFormula } from './formula';

const props: Record<string, number | string | boolean | null> = {
  Price: 12.5,
  Count: 4,
  Done: true,
  Due: '2026-10-20',
  Name: 'Tea',
};
const run = (source: string) => computeFormula(source, (name) => props[name] ?? null, new Date(2026, 9, 16));
const runRuntime = (source: string) => computeRuntimeFormula(source, {}, new Date(2026, 9, 16));

describe('formulas', () => {
  it('does arithmetic with properties in the usual order', () => {
    expect(run('prop("Price") * prop("Count") + 1').value).toBe(51);
    expect(run('2 ^ 3 ^ 2').value).toBe(512);
    expect(run('-(1 + 2) * 3').value).toBe(-9);
    expect(run('round(10 / 3, 2)').value).toBe(3.33);
    expect(run('1 / 0').error).toContain('Division by zero');
    expect(run('Round(1.005, 2)').value).toBe(1.01);
    expect(run('If(false, 1 / 0, 0)').value).toBe(0);
  });

  it('handles text, conditions and logic', () => {
    expect(run('if(prop("Done"), "✅ done", "⏳ open")').value).toBe('✅ done');
    expect(run('concat(upper(prop("Name")), "!")').value).toBe('TEA!');
    expect(run('prop("Name") + " x" + prop("Count")').value).toBe('Tea x4');
    expect(run('prop("Count") > 3 and not empty(prop("Name"))').value).toBe(true);
    expect(run('contains(prop("Name"), "e")').value).toBe(true);
  });

  it('works with dates', () => {
    expect(run('dateBetween(prop("Due"), today(), "days")').value).toBe(4);
    expect(run('dateAdd(prop("Due"), 1, "months")').value).toBe('2026-11-20');
    expect(run('DateAdd("2026-01-31", 1, "months")').value).toBe('2026-02-28');
    expect(run('DateAdd("2026-02-30", 1, "days")').error).toContain('valid date');
    expect(run('DateBetween("2026-10-16T10:00:00Z", "2026-10-16T08:00:00Z", "hours")').value).toBe(2);
  });

  it('evaluates lists, aliases and typed list functions', () => {
    expect(run('WithName(5, x, x * 2)').value).toBe(10);
    expect(run('WithName(5, "x", WithName(x + 1, y, x + y))').value).toBe(11);
    expect(runRuntime('FormulaMap([1, 2, 3], CurrentValue * 2)').value).toEqual([2, 4, 6]);
    expect(runRuntime('ForEach(List(1, 2, 3), CurrentValue + 1)').value).toEqual([2, 3, 4]);
    expect(runRuntime('Unique([1, 1, 2])').value).toEqual([1, 2]);
    expect(runRuntime('[]').value).toEqual([]);
    expect(run('IsBlank([])').value).toBe(true);
    expect(run('Switch("paid", "open", 0, "paid", 2, 3)').value).toBe(2);
    expect(run('Mod(7, 4)').value).toBe(3);
    expect(run('ToNumber("no")').error).toContain('Expected a number');
  });

  it('handles evaluation errors lazily without treating blank, false or zero as errors', () => {
    expect(runRuntime('IfError(1 / 0, "fallback")')).toEqual({ value: 'fallback', error: null });
    expect(runRuntime('List(IfError(null, 1 / 0), IfError(false, 1 / 0), IfError(0, 1 / 0))').value)
      .toEqual([null, false, 0]);
    expect(runRuntime('IfError(MissingValue, 4)').value).toBe(4);
    expect(runRuntime('IfError(1 / 0, 2 / 0)').error).toContain('Division by zero');
    expect(runRuntime('1 / 0').error).toContain('Division by zero');
    expect(runRuntime('IfError(1 / 0)').error).toContain('two arguments');
  });

  it('reports mistakes instead of throwing', () => {
    expect(run('prop("Price" *').error).toBeTruthy();
    expect(run('nope(1)').error).toContain('nope');
    expect(run('"open').error).toContain('quote');
    expect(run('').value).toBeNull();
  });
});
