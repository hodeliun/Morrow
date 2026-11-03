import { boundedNumericControlFormatError } from '../../core/controls';
import type { PropertyFormat } from '../../core/model';

export function calculatedResultFormatError(
  outputType: 'scale' | 'progress',
  format: PropertyFormat,
): string | null {
  if (outputType === 'scale') return boundedNumericControlFormatError('scale', format);
  const min = format.min ?? 0;
  const max = format.max ?? 100;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min)
    return 'Calculated progress maximum must be greater than its minimum.';
  return null;
}
