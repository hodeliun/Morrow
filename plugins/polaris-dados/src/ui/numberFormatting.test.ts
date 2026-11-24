import { describe, expect, it } from 'vitest';
import { formatFormulaNumber } from './numberFormatting';

describe('formula number formatting', () => {
  it('falls back to the raw numeric string when Intl rejects a locale', () => {
    const value = -12.345;

    expect(
      formatFormulaNumber(
        value,
        { locale: 'invalid locale', precision: 2 },
        'decimal',
        'en-US',
        2,
      ),
    ).toBe(String(value));
  });
});
