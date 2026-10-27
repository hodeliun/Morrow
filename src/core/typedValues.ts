import type { PropDef, PropType, PropValue } from './model';
import { attachmentValueError, richCanvasValueError } from './propertyMedia';

export const NUMERIC_PROPERTY_TYPES: readonly PropType[] = [
  'number',
  'currency',
  'percent',
  'slider',
  'progress',
  'scale',
  'duration',
];

export const DATE_PROPERTY_TYPES: readonly PropType[] = [
  'date',
  'time',
  'datetime',
  'createdTime',
  'lastEditedTime',
];

export function isNumericPropertyType(type: PropType): boolean {
  return NUMERIC_PROPERTY_TYPES.includes(type);
}

export function isDatePropertyType(type: PropType): boolean {
  return DATE_PROPERTY_TYPES.includes(type);
}

export function isComputedProperty(prop: PropDef): boolean {
  return (
    prop.type === 'formula' ||
    prop.type === 'createdTime' ||
    prop.type === 'lastEditedTime' ||
    prop.fillMode === 'calculated'
  );
}

// Duration values are stored in seconds; this unit controls the UI and defaults to minutes.
export function durationUnitFactor(unit: NonNullable<PropDef['format']>['durationUnit'] = 'minutes'): number {
  return { seconds: 1, minutes: 60, hours: 3600, days: 86400 }[unit];
}

export function durationUnitFromText(value: string): NonNullable<PropDef['format']>['durationUnit'] | null {
  return /\b(days?|d)\b/i.test(value)
    ? 'days'
    : /\b(hours?|hrs?|h)\b/i.test(value)
      ? 'hours'
      : /\b(minutes?|mins?|m)\b/i.test(value)
        ? 'minutes'
        : /\b(seconds?|secs?|s)\b/i.test(value)
          ? 'seconds'
          : null;
}

export function parseLocalizedNumber(
  raw: string,
  locale = 'en-US',
  currency?: string,
  allowUnitSuffix = false,
): number | null {
  let text = raw.trim();
  if (!text) return null;
  const parenthesized = /^\(.*\)$/.test(text);
  if (parenthesized) text = text.slice(1, -1).trim();
  text = text.replace(/R\$/gi, ' ');
  if (currency) {
    try {
      const symbol = new Intl.NumberFormat(locale, { style: 'currency', currency })
        .formatToParts(1)
        .find((part) => part.type === 'currency')?.value;
      if (symbol) text = text.split(symbol).join(' ');
    } catch {
      return null;
    }
    const escapedCurrency = currency.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`\\b${escapedCurrency}\\b`, 'gi'), ' ');
  }
  text = text
    .replace(/\p{Sc}/gu, ' ')
    .replace(/\s*%$/, '')
    .trim();
  if (allowUnitSuffix) text = text.replace(/\s+[A-Za-z]+$/, '').trim();
  if (!text) return null;
  const sign = /^[+-]/.test(text) ? text[0] : '';
  if (parenthesized && sign) return null;
  if (sign) text = text.slice(1).trim();

  let parts: Intl.NumberFormatPart[];
  try {
    parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
  } catch {
    return null;
  }
  const groupRaw = parts.find((part) => part.type === 'group')?.value;
  const group = groupRaw && /\s/u.test(groupRaw) ? ' ' : groupRaw;
  const decimal = parts.find((part) => part.type === 'decimal')?.value ?? '.';
  text = text.replace(/[\u00a0\u202f]/g, ' ').trim();
  if (group && group !== decimal && /\s/u.test(groupRaw ?? '')) text = text.replace(/\s+/g, group);

  const decimalParts = text.split(decimal);
  if (decimalParts.length > 2) return null;
  const rawInteger = decimalParts[0] ?? '';
  const fraction = decimalParts[1] ?? '';
  let integer = rawInteger;
  if (group && integer.includes(group)) {
    const groups = integer.split(group);
    if (
      groups.length < 2 ||
      !/^\d{1,3}$/.test(groups[0]!) ||
      groups.slice(1).some((part) => !/^\d{3}$/.test(part))
    )
      return null;
    integer = groups.join('');
  }
  if (/[.,]/.test(integer) || (fraction && !/^\d+$/.test(fraction))) return null;
  if (integer && !/^\d+$/.test(integer)) return null;
  if (!integer && !fraction) return null;
  const number = Number(`${parenthesized ? '-' : sign}${integer || '0'}${fraction ? `.${fraction}` : ''}`);
  return Number.isFinite(number) ? number : null;
}

export function isValidDateKey(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function isValidTime(value: string): boolean {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return false;
  return Number(match[1]) <= 23 && Number(match[2]) <= 59 && Number(match[3] ?? 0) <= 59;
}

export function isValidDateTime(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)(Z|[+-]\d{2}:\d{2})$/i.exec(
    value,
  );
  if (!match || !isValidDateKey(match[1]!)) return false;
  const time = match[2]!.slice(0, 8).padEnd(8, ':00');
  if (!isValidTime(time)) return false;
  const zone = match[3]!;
  if (zone.toUpperCase() !== 'Z') {
    const offset = /[+-](\d{2}):(\d{2})$/.exec(zone);
    const hours = Number(offset?.[1]);
    const minutes = Number(offset?.[2]);
    if (!offset || hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return false;
  }
  return Number.isFinite(Date.parse(value));
}

export function scalarValueError(prop: PropDef, value: PropValue): string | null {
  if (value === null) return null;
  const isString = typeof value === 'string';
  const isNumber = typeof value === 'number' && Number.isFinite(value);
  const format = prop.format;

  if (isNumericPropertyType(prop.type)) {
    if (!isNumber) return `${prop.name} must be a finite number.`;
    const amount = value;
    const min =
      format?.min ?? (prop.type === 'scale' ? 1 : ['slider', 'progress'].includes(prop.type) ? 0 : undefined);
    const max =
      format?.max ??
      prop.max ??
      (prop.type === 'scale' ? 5 : ['slider', 'progress'].includes(prop.type) ? 100 : undefined);
    if (min !== undefined && amount < min) return `${prop.name} must be at least ${min}.`;
    if (max !== undefined && amount > max) return `${prop.name} must be at most ${max}.`;
    if (prop.type === 'scale' && !Number.isInteger(amount)) return `${prop.name} must be a whole number.`;
    if (format?.step !== undefined) {
      const base = format.min ?? 0;
      const steps = (amount - base) / format.step;
      if (Math.abs(steps - Math.round(steps)) > 1e-8) return `${prop.name} must use steps of ${format.step}.`;
    }
    return null;
  }

  switch (prop.type) {
    case 'image':
    case 'file':
      return attachmentValueError(prop, value);
    case 'richCanvas':
      return richCanvasValueError(prop, value);
    case 'text':
    case 'email':
    case 'phone':
    case 'url':
      if (!isString) return `${prop.name} must be text.`;
      if (prop.type === 'email' && value !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
        return `${prop.name} must be a valid email address.`;
      if (
        prop.type === 'phone' &&
        value !== '' &&
        (value.replace(/\D/g, '').length < 5 || !/^[+(\d][\d\s()./-]{3,39}$/.test(value))
      )
        return `${prop.name} must be a valid phone number.`;
      if (prop.type === 'url' && value !== '') {
        try {
          const url = new URL(value);
          if (!['http:', 'https:'].includes(url.protocol))
            return `${prop.name} must be an HTTP or HTTPS link.`;
        } catch {
          return `${prop.name} must be a valid link.`;
        }
      }
      return null;
    case 'date':
      return isString && isValidDateKey(value) ? null : `${prop.name} must be a real calendar date.`;
    case 'time':
      return isString && isValidTime(value) ? null : `${prop.name} must be a valid time.`;
    case 'datetime':
      return isString && isValidDateTime(value)
        ? null
        : `${prop.name} must include a valid date, time, and timezone.`;
    case 'checkbox':
      return typeof value === 'boolean' ? null : `${prop.name} must be checked or unchecked.`;
    case 'select':
      return isString && prop.options.some((option) => option.id === value)
        ? null
        : `${prop.name} must use one of its configured options.`;
    case 'multiSelect':
      return Array.isArray(value) &&
        value.length <= 200 &&
        new Set(value).size === value.length &&
        value.every((id) => prop.options.some((option) => option.id === id))
        ? null
        : `${prop.name} must use a unique list of configured options.`;
    case 'relation':
      return isString || (Array.isArray(value) && value.every((item) => typeof item === 'string'))
        ? null
        : `${prop.name} must contain relation ids.`;
    case 'formula':
    case 'createdTime':
    case 'lastEditedTime':
      return `${prop.name} is calculated and cannot be edited.`;
    case 'button':
      return `${prop.name} runs an action and does not store a cell value.`;
    default:
      return `${prop.name} has an unsupported value.`;
  }
}

export function propertyValueError(prop: PropDef, value: PropValue): string | null {
  if (isComputedProperty(prop) && value !== null) return `${prop.name} is calculated and cannot be edited.`;
  return scalarValueError(prop, value);
}
