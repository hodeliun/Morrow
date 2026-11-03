import { describe, expect, it } from 'vitest';
import {
  currencyCatalog,
  currencyCatalogStatus,
  isValidFormatLocale,
  timeZoneCatalog,
  timeZoneCatalogStatus,
  withCurrentCatalogOption,
} from './formatCatalogs';

describe('property format catalogs', () => {
  it('exposes searchable currency codes and localized names', () => {
    const options = currencyCatalog('en', ['USD', 'EUR']);

    expect(options.map((option) => option.value)).toEqual(['EUR', 'USD']);
    expect(options.find((option) => option.value === 'USD')?.label).toBe('USD');
    expect(options.find((option) => option.value === 'USD')?.detail).toBeTruthy();
  });

  it('keeps a valid currency value when the available catalog omits it', () => {
    const options = currencyCatalog('en', ['EUR']);
    const current = withCurrentCatalogOption(options, 'USD');

    expect(currencyCatalogStatus('USD', ['EUR'])).toBe('valid-unlisted');
    expect(current.find((option) => option.value === 'USD')).toMatchObject({
      value: 'USD',
      label: 'USD',
    });
    expect(options.some((option) => option.value === 'USD')).toBe(false);
  });

  it('keeps a valid time zone value when the available catalog omits it', () => {
    const options = timeZoneCatalog(['Europe/London']);
    const current = withCurrentCatalogOption(options, 'UTC');

    expect(timeZoneCatalogStatus('UTC', ['Europe/London'])).toBe('valid-unlisted');
    expect(current.find((option) => option.value === 'UTC')).toMatchObject({
      value: 'UTC',
      label: 'UTC',
    });
    expect(options.some((option) => option.value === 'UTC')).toBe(false);
  });

  it('keeps a valid time zone alias outside the canonical catalog', () => {
    expect(timeZoneCatalogStatus('US/Eastern', ['America/New_York'])).toBe('valid-unlisted');
  });

  it('marks malformed and unsupported values without changing them', () => {
    expect(currencyCatalogStatus('not-a-code', ['USD'])).toBe('invalid');
    expect(timeZoneCatalogStatus('Not/A_Time_Zone', ['UTC'])).toBe('invalid');
    expect(withCurrentCatalogOption([], 'legacy-value')).toEqual([
      { value: 'legacy-value', label: 'legacy-value' },
    ]);
  });

  it('keeps free-form locale input valid outside a fixed catalog', () => {
    expect(isValidFormatLocale('en-AU', true)).toBe(true);
    expect(isValidFormatLocale('not a locale', true)).toBe(false);
  });
});
