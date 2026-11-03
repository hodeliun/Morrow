export interface FormatCatalogOption {
  value: string;
  label: string;
  detail?: string;
}

export type FormatCatalogStatus = 'listed' | 'valid-unlisted' | 'invalid';

type CatalogKey = 'currency' | 'timeZone';
type IntlWithSupportedValues = typeof Intl & {
  supportedValuesOf?: (key: CatalogKey) => string[];
};

const FALLBACK_CURRENCIES = [
  'AUD',
  'BRL',
  'CAD',
  'CHF',
  'CNY',
  'EUR',
  'GBP',
  'INR',
  'JPY',
  'MXN',
  'NOK',
  'NZD',
  'SEK',
  'USD',
  'ZAR',
];

const FALLBACK_TIME_ZONES = [
  'America/Los_Angeles',
  'America/New_York',
  'America/Sao_Paulo',
  'America/Toronto',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Europe/Berlin',
  'Europe/London',
  'Europe/Paris',
  'UTC',
];

function supportedValues(key: CatalogKey, fallback: readonly string[]): string[] {
  try {
    const values = (Intl as IntlWithSupportedValues).supportedValuesOf?.(key);
    return [...new Set(values?.length ? values : fallback)].sort((a, b) => a.localeCompare(b));
  } catch {
    return [...fallback].sort((a, b) => a.localeCompare(b));
  }
}

export function currencyCatalogCodes(): string[] {
  return supportedValues('currency', FALLBACK_CURRENCIES);
}

export function timeZoneCatalogCodes(): string[] {
  return supportedValues('timeZone', FALLBACK_TIME_ZONES);
}

export function currencyCatalog(
  locale: string,
  codes: readonly string[] = currencyCatalogCodes(),
): FormatCatalogOption[] {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([locale], { type: 'currency' });
  } catch {
    // the code remains a useful searchable label when a locale is unavailable
  }

  return [...new Set(codes)]
    .sort((a, b) => a.localeCompare(b))
    .map((code) => ({
      value: code,
      label: code,
      detail: names?.of(code) ?? code,
    }));
}

export function timeZoneCatalog(
  codes: readonly string[] = timeZoneCatalogCodes(),
): FormatCatalogOption[] {
  return [...new Set(codes)]
    .sort((a, b) => a.localeCompare(b))
    .map((zone) => ({
      value: zone,
      label: zone,
      detail: zone.split('/').at(-1)?.replaceAll('_', ' ') ?? zone,
    }));
}

export function withCurrentCatalogOption(
  options: readonly FormatCatalogOption[],
  current: string,
  detail?: string,
): FormatCatalogOption[] {
  if (options.some((option) => option.value === current)) return [...options];
  const canonical = options.find((option) => option.value.toLowerCase() === current.toLowerCase());
  const currentDetail = canonical?.detail ?? detail;
  return [
    ...options,
    {
      value: current,
      label: current,
      ...(currentDetail ? { detail: currentDetail } : {}),
    },
  ];
}

export function currencyCatalogStatus(
  value: string,
  codes: readonly string[] = currencyCatalogCodes(),
): FormatCatalogStatus {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) return 'invalid';
  try {
    new Intl.NumberFormat('en', { style: 'currency', currency: normalized });
  } catch {
    return 'invalid';
  }
  return codes.some((code) => code.toUpperCase() === normalized) ? 'listed' : 'valid-unlisted';
}

export function timeZoneCatalogStatus(
  value: string,
  zones: readonly string[] = timeZoneCatalogCodes(),
): FormatCatalogStatus {
  if (!value.trim()) return 'invalid';
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    const normalized = value.trim().toLowerCase();
    return zones.some((zone) => zone.toLowerCase() === normalized) ? 'listed' : 'valid-unlisted';
  } catch {
    return 'invalid';
  }
}

export function isValidFormatLocale(value: string, numeric: boolean): boolean {
  const locale = value.trim();
  if (!locale) return false;
  try {
    Intl.getCanonicalLocales(locale);
    if (numeric) new Intl.NumberFormat(locale);
    else new Intl.DateTimeFormat(locale);
    return true;
  } catch {
    return false;
  }
}
