export interface NumberDisplayFormat {
  readonly locale?: string;
  readonly precision?: number;
  readonly negativeFormat?: 'minus' | 'parentheses';
  readonly currency?: string;
}

/** Shared number formatter for database cells and legacy inline results. */
export function formatNumberCell(
  value: number,
  format: NumberDisplayFormat | undefined,
  locale: string,
): string {
  if (!format) return new Intl.NumberFormat(locale, { maximumFractionDigits: 10 }).format(value);
  return formatNumber(
    value,
    format,
    format.locale || locale,
    'decimal',
    format.precision ?? 2,
    Object.hasOwn(format, 'precision'),
  );
}

/** Mirrors the published calculated-result formatter for supported scalar number formats. */
export function formatFormulaNumber(
  value: number,
  format: NumberDisplayFormat,
  style: 'decimal' | 'currency' | 'percent',
  defaultLocale: string,
  defaultPrecision: number,
  defaultCurrency = 'BRL',
): string {
  return formatNumber(
    value,
    format,
    format.locale || defaultLocale,
    style,
    format.precision ?? defaultPrecision,
    style === 'currency' || Object.hasOwn(format, 'precision'),
    format.currency ?? defaultCurrency,
  );
}

function formatNumber(
  value: number,
  format: NumberDisplayFormat,
  locale: string,
  style: 'decimal' | 'currency' | 'percent',
  precision: number,
  showMinimumFractionDigits: boolean,
  currency = 'BRL',
): string {
  if (!Number.isFinite(value)) return String(value);
  try {
    const formatter = new Intl.NumberFormat(locale, {
      ...(style !== 'decimal' ? { style } : {}),
      ...(style === 'currency' ? { currency } : {}),
      maximumFractionDigits: precision,
      ...(showMinimumFractionDigits ? { minimumFractionDigits: precision } : {}),
    });
    if (format.negativeFormat === 'parentheses' && value < 0)
      return `(${formatter.format(Math.abs(value))})`;
    return formatter.format(value);
  } catch {
    return String(value);
  }
}
