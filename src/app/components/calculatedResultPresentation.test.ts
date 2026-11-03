import { describe, expect, it } from 'vitest';
import { emptyWorkspace } from '../../core/model';
import { calculatedResultPresentation } from './NamedData';

describe('calculated result display values', () => {
  it('shows null and empty lists as a quiet empty result', () => {
    expect(calculatedResultPresentation(null, 'auto', {}, emptyWorkspace())).toMatchObject({
      display: '[]',
      diagnostic: null,
    });
    expect(calculatedResultPresentation([], 'auto', {}, emptyWorkspace())).toMatchObject({
      display: '[]',
      diagnostic: null,
    });
    expect(calculatedResultPresentation('', 'auto', {}, emptyWorkspace())).toMatchObject({
      display: '[]',
      diagnostic: null,
    });
  });

  it('keeps zero and false distinct from blank and reports typed mismatches', () => {
    const state = emptyWorkspace();
    const zero = calculatedResultPresentation(0, 'number', { locale: 'en-US', precision: 0 }, state);
    const unchecked = calculatedResultPresentation(false, 'checkbox', {}, state);
    const automaticFalse = calculatedResultPresentation(false, 'auto', {}, state);
    const mismatch = calculatedResultPresentation(false, 'number', {}, state);

    expect(zero).toMatchObject({ display: '0', diagnostic: null });
    expect(unchecked.display).not.toBe('[]');
    expect(unchecked.diagnostic).toBeNull();
    expect(automaticFalse.display).not.toBe('[]');
    expect(mismatch).toMatchObject({ diagnostic: expect.any(String) });
  });

  it('keeps bounded calculated scale and progress outputs numeric and diagnoses invalid domains', () => {
    const state = emptyWorkspace();
    const progressFormat = { locale: 'en-US', min: 0, max: 0.3, step: 0.1, color: 'blue' as const, showValue: true };
    const scaleFormat = { min: 1, max: 5, step: 1, scaleIcon: 'star' as const, color: 'blue' as const, showValue: true };

    expect(calculatedResultPresentation(0.3, 'progress', progressFormat, state)).toMatchObject({
      display: '0.3', diagnostic: null, progress: 0.3,
    });
    expect(calculatedResultPresentation(0.31, 'progress', progressFormat, state)).toMatchObject({
      diagnostic: expect.any(String), progress: null,
    });
    expect(calculatedResultPresentation(3, 'scale', scaleFormat, state)).toMatchObject({
      display: '3', diagnostic: null, progress: null,
    });
    expect(calculatedResultPresentation(3.5, 'scale', scaleFormat, state)).toMatchObject({
      diagnostic: expect.any(String), progress: null,
    });
    expect(calculatedResultPresentation(null, 'scale', scaleFormat, state)).toMatchObject({
      display: '[]', diagnostic: null, progress: null,
    });
  });

  it('preserves legacy fractional progress results with a maximum-only format', () => {
    expect(calculatedResultPresentation(4.7, 'progress', { locale: 'en-US', max: 100 }, emptyWorkspace())).toMatchObject({
      display: '4.7', diagnostic: null, progress: 4.7,
    });
  });

  it('keeps the published calculated-format diagnostic for a degenerate progress domain', () => {
    expect(calculatedResultPresentation(5, 'progress', { min: 5, max: 5 }, emptyWorkspace())).toMatchObject({
      diagnostic: expect.any(String), progress: null,
    });
  });
});
