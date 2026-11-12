// Minimal pure date helpers extracted from hodeliun/Morrow
// `src/core/typedValues.ts` at commit 778c6b6ef7d30aad8678dbbbcb50fdcab6bc1106
// (blob a071a4a8506e9f1680328901dace009b9ee6c6ab), under Apache-2.0.
// isValidTime remains local because isValidDateTime depends on it.

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

function isValidTime(value: string): boolean {
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
