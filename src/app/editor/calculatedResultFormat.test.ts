import { describe, expect, it } from 'vitest';
import { boundedNumericControlFormatError } from '../../core/controls';
import { calculatedResultFormatError } from './calculatedResultFormat';

describe('calculated numeric output format', () => {
  it('keeps legacy maximum-only progress valid without adding a manual input grid', () => {
    const legacy = { max: 100 };
    expect(boundedNumericControlFormatError('progress', legacy)).not.toBeNull();
    expect(calculatedResultFormatError('progress', legacy)).toBeNull();
    expect(legacy).toEqual({ max: 100 });
  });

  it('accepts a fractional calculated range without a manual step', () => {
    expect(calculatedResultFormatError('progress', { min: 0.1, max: 0.9 })).toBeNull();
    expect(calculatedResultFormatError('progress', {})).toBeNull();
  });

  it('rejects nonfinite and reversed calculated progress bounds', () => {
    for (const format of [{ min: 1, max: 1 }, { min: 2, max: 1 }, { min: NaN, max: 100 }, { max: Infinity }])
      expect(calculatedResultFormatError('progress', format)).not.toBeNull();
  });

  it('retains the explicit integer grid contract for a calculated scale', () => {
    expect(calculatedResultFormatError('scale', { min: 1, max: 5, step: 1 })).toBeNull();
    expect(calculatedResultFormatError('scale', { max: 5 })).not.toBeNull();
    expect(calculatedResultFormatError('scale', { min: 1, max: 5, step: 0.5 })).not.toBeNull();
  });
});
