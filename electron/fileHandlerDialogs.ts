export type FileHandlerLocale = 'en' | 'es' | 'pt';
export type FileHandlerChooserKind = 'file' | 'browser';

const titles: Record<FileHandlerLocale, Record<FileHandlerChooserKind, string>> = {
  en: { file: 'Choose an application', browser: 'Choose a browser' },
  es: { file: 'Elige una aplicación', browser: 'Elige un navegador' },
  pt: { file: 'Escolha um aplicativo', browser: 'Escolha um navegador' },
};

const applicationFilterNames: Record<FileHandlerLocale, string> = {
  en: 'Applications',
  es: 'Aplicaciones',
  pt: 'Aplicativos',
};

export function isFileHandlerLocale(value: unknown): value is FileHandlerLocale {
  return value === 'en' || value === 'es' || value === 'pt';
}

export function nativeApplicationDialogTitle(
  kind: FileHandlerChooserKind,
  locale: FileHandlerLocale,
): string {
  return titles[locale][kind];
}

export function nativeApplicationDialogFilterName(locale: FileHandlerLocale): string {
  return applicationFilterNames[locale];
}
