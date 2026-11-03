export type DateRangePreset = 'today' | 'lastSevenDays' | 'currentMonth' | 'nextSevenDays';
export type DateRangePair = [start: string, end: string];

function localCalendarDate(year: number, month: number, day: number): Date {
  const date = new Date(0);
  date.setFullYear(year, month, day);
  // Noon avoids local timezone transitions that occur at midnight.
  date.setHours(12, 0, 0, 0);
  return date;
}

function localDateKey(date: Date): string | null {
  const year = date.getFullYear();
  if (!Number.isFinite(date.getTime()) || year < 0 || year > 9999) return null;
  return `${String(year).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function range(start: Date, end: Date): DateRangePair | null {
  const startKey = localDateKey(start);
  const endKey = localDateKey(end);
  return startKey && endKey ? [startKey, endKey] : null;
}

export function dateRangeForPreset(preset: DateRangePreset, now: Date): DateRangePair | null {
  if (!Number.isFinite(now.getTime())) return null;
  const year = now.getFullYear();
  const month = now.getMonth();
  const today = localCalendarDate(year, month, now.getDate());

  switch (preset) {
    case 'today':
      return range(today, today);
    case 'lastSevenDays': {
      const start = new Date(today);
      start.setDate(start.getDate() - 6);
      return range(start, today);
    }
    case 'currentMonth': {
      const start = localCalendarDate(year, month, 1);
      const end = localCalendarDate(year, month + 1, 0);
      return range(start, end);
    }
    case 'nextSevenDays': {
      const end = new Date(today);
      end.setDate(end.getDate() + 6);
      return range(today, end);
    }
    default:
      return null;
  }
}
