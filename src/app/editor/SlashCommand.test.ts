import { afterEach, describe, expect, it } from 'vitest';
import { filterBlocks } from './SlashCommand';
import { getPreferences, setPreferences } from '../platform/preferences';

const originalLocale = getPreferences().locale;

afterEach(() => setPreferences({ locale: originalLocale }));

describe('named control slash catalog', () => {
  it('finds each existing control type from English, Spanish, and Portuguese aliases', () => {
    const cases = [
      { type: 'controlText', aliases: { en: 'plain text', es: 'texto simple', pt: 'texto simples' } },
      { type: 'controlNumber', aliases: { en: 'numeric', es: 'numérico', pt: 'numérico' } },
      { type: 'controlSlider', aliases: { en: 'range', es: 'deslizador', pt: 'deslizante' } },
      { type: 'controlSelect', aliases: { en: 'dropdown', es: 'lista', pt: 'lista' } },
      { type: 'controlCheckbox', aliases: { en: 'boolean', es: 'casilla', pt: 'caixa' } },
      { type: 'controlDate', aliases: { en: 'calendar', es: 'calendario', pt: 'calendário' } },
      { type: 'controlRelation', aliases: { en: 'linked row', es: 'fila vinculada', pt: 'linha vinculada' } },
    ] as const;

    for (const locale of ['en', 'es', 'pt'] as const) {
      setPreferences({ locale });
      for (const item of cases) {
        expect(filterBlocks(item.aliases[locale]).some((block) => block.id === item.type), `${locale}:${item.type}`).toBe(true);
      }
    }
  });
});
