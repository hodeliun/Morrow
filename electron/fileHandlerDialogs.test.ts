import { describe, expect, it } from 'vitest';
import {
  isFileHandlerLocale,
  nativeApplicationDialogFilterName,
  nativeApplicationDialogTitle,
} from './fileHandlerDialogs.js';

describe('native file-handler chooser labels', () => {
  it.each([
    ['en', 'Choose an application', 'Choose a browser'],
    ['es', 'Elige una aplicación', 'Elige un navegador'],
    ['pt', 'Escolha um aplicativo', 'Escolha um navegador'],
  ] as const)('uses fixed %s labels', (locale, fileTitle, browserTitle) => {
    expect(isFileHandlerLocale(locale)).toBe(true);
    expect(nativeApplicationDialogTitle('file', locale)).toBe(fileTitle);
    expect(nativeApplicationDialogTitle('browser', locale)).toBe(browserTitle);
    expect(nativeApplicationDialogFilterName(locale)).toBe(
      { en: 'Applications', es: 'Aplicaciones', pt: 'Aplicativos' }[locale],
    );
  });

  it('rejects unsupported locales', () => {
    expect(isFileHandlerLocale('fr')).toBe(false);
    expect(isFileHandlerLocale('Choose this app')).toBe(false);
  });
});
