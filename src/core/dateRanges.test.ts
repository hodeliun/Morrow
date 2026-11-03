import { describe, expect, it } from 'vitest';
import { dateRangeForPreset } from './dateRanges';

describe('date range presets', () => {
  it('returns ordered bounds spanning seven inclusive local calendar dates', () => {
    const now = new Date(2024, 2, 1, 23, 45);

    expect(dateRangeForPreset('today', now)).toEqual(['2024-03-01', '2024-03-01']);
    expect(dateRangeForPreset('lastSevenDays', now)).toEqual(['2024-02-24', '2024-03-01']);
    expect(dateRangeForPreset('nextSevenDays', now)).toEqual(['2024-03-01', '2024-03-07']);
  });

  it('uses the first and last local dates of a leap-year month', () => {
    expect(dateRangeForPreset('currentMonth', new Date(2024, 1, 29, 18))).toEqual([
      '2024-02-01',
      '2024-02-29',
    ]);
  });

  it('crosses the year boundary with an ordered seven-day range', () => {
    const yearEnd = new Date(2024, 11, 31, 22);
    expect(dateRangeForPreset('lastSevenDays', yearEnd)).toEqual(['2024-12-25', '2024-12-31']);
    expect(dateRangeForPreset('nextSevenDays', yearEnd)).toEqual(['2024-12-31', '2025-01-06']);
  });

  it('adds calendar days across a local daylight-saving transition', () => {
    const priorTimezone = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const justAfterSpringForward = new Date(2024, 2, 11, 0, 30);
      expect(dateRangeForPreset('lastSevenDays', justAfterSpringForward)).toEqual([
        '2024-03-05',
        '2024-03-11',
      ]);
    } finally {
      if (priorTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = priorTimezone;
    }
  });

  it('returns no range for an invalid injected clock', () => {
    expect(dateRangeForPreset('today', new Date(Number.NaN))).toBeNull();
    expect(dateRangeForPreset('future' as never, new Date(2024, 0, 1))).toBeNull();
  });
});
