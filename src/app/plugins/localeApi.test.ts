import { describe, expect, it } from 'vitest';
import { getLocale } from '../i18n';
import { getPreferences, setPreferences } from '../platform/preferences';
import { definePluginLocaleApi } from './localeApi';

describe('plugin locale API', () => {
  it('exposes a live readonly locale getter from host preferences', () => {
    const originalLocale = getPreferences().locale;
    try {
      setPreferences({ locale: 'pt' });
      const api = Object.freeze(definePluginLocaleApi({ version: 1 }, getLocale));

      expect(api.locale).toBe('pt');
      expect(Object.getOwnPropertyDescriptor(api, 'locale')).toMatchObject({
        enumerable: true,
        configurable: false,
        set: undefined,
      });

      setPreferences({ locale: 'es' });
      expect(api.locale).toBe('es');
      expect(Object.isFrozen(api)).toBe(true);
    } finally {
      setPreferences({ locale: originalLocale });
    }
  });
});
