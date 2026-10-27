import { isRecord } from './doc';
import type { NamedControlDef, NamedControlType, PageId, PropDef, PropValue, PropertyFormat, SelectOption } from './model';
import { COLORS } from './model';
import { isValidDateKey, scalarValueError } from './typedValues';
import { isEffectivelyTrashed } from './tree';
import type { WorkspaceState } from './model';

const CONTROL_TYPES = new Set<NamedControlType>(['text', 'number', 'slider', 'select', 'checkbox', 'date', 'relation']);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function controlValueError(control: NamedControlDef, value: PropValue): string | null {
  if (value === null) return null;
  switch (control.type) {
    case 'text':
      return typeof value === 'string' && value.length <= 20_000 ? null : 'Text controls need text up to 20,000 characters.';
    case 'number':
    case 'slider': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'Numeric controls need a finite number.';
      const prop = { id: control.id, name: control.name, type: control.type, options: [], format: control.format } as PropDef;
      return scalarValueError(prop, value);
    }
    case 'checkbox':
      return typeof value === 'boolean' ? null : 'Checkbox controls need true, false, or blank.';
    case 'date':
      return typeof value === 'string' && (value === '' || isValidDateKey(value)) ? null : 'Date controls need a real date.';
    case 'select':
      return typeof value === 'string' && control.options.some((option) => option.id === value)
        ? null
        : 'Select controls need one of their configured options.';
    case 'relation': {
      const multiple = control.relation?.multiple === true;
      const ids = Array.isArray(value) ? value : typeof value === 'string' ? [value] : null;
      if (!ids || (!multiple && ids.length > 1) || ids.length > 500 || ids.some((id) => !ID_PATTERN.test(id)))
        return multiple ? 'Relation controls need a list of row IDs.' : 'Relation controls need one row ID.';
      return null;
    }
  }
}

export function normalizeNamedControls(raw: unknown): NamedControlDef[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 100) return null;
  const controls: NamedControlDef[] = [];
  const ids = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item)) return null;
    const allowed = new Set(['id', 'name', 'type', 'value', 'defaultValue', 'options', 'format', 'relation']);
    if (Object.keys(item).some((key) => !allowed.has(key))) return null;
    if (!ID_PATTERN.test(String(item.id ?? '')) || ids.has(String(item.id))) return null;
    if (typeof item.name !== 'string' || !item.name.trim() || item.name.trim().length > 100) return null;
    if (!CONTROL_TYPES.has(item.type as NamedControlType)) return null;
    const type = item.type as NamedControlType;
    const options = normalizeOptions(item.options);
    if (!options) return null;
    const format = normalizeControlFormat(item.format);
    if (item.format !== undefined && !format) return null;
    const relation = normalizeControlRelation(item.relation, type === 'relation');
    if (item.relation !== undefined && !relation) return null;
    const value = normalizePropValue(item.value);
    const defaultValue = normalizePropValue(item.defaultValue);
    if (value === undefined || defaultValue === undefined) return null;
    const control: NamedControlDef = {
      id: String(item.id),
      name: item.name.trim(),
      type,
      value,
      defaultValue,
      options,
      ...(format ? { format } : {}),
      ...(relation ? { relation } : {}),
    };
    if (controlValueError(control, control.value) || controlValueError(control, control.defaultValue)) return null;
    controls.push(control);
    ids.add(control.id);
  }
  return controls;
}

function normalizePropValue(value: unknown): PropValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value) && value.length <= 500 && value.every((item) => typeof item === 'string' && ID_PATTERN.test(item)))
    return value as string[];
  return undefined;
}

function normalizeOptions(raw: unknown): SelectOption[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 100) return null;
  const options: SelectOption[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item) || Object.keys(item).some((key) => !['id', 'name', 'color'].includes(key))) return null;
    if (!ID_PATTERN.test(String(item.id ?? '')) || ids.has(String(item.id))) return null;
    if (typeof item.name !== 'string' || !item.name.trim() || item.name.trim().length > 100) return null;
    const name = item.name.trim();
    const folded = name.toLocaleLowerCase();
    if (names.has(folded) || !COLORS.includes(item.color as (typeof COLORS)[number])) return null;
    options.push({ id: String(item.id), name, color: item.color as (typeof COLORS)[number] });
    ids.add(String(item.id));
    names.add(folded);
  }
  return options;
}

function normalizeControlRelation(raw: unknown, required: boolean): NamedControlDef['relation'] | null {
  if (raw === undefined && !required) return null;
  if (!isRecord(raw) || Object.keys(raw).some((key) => !['targetDatabaseId', 'multiple'].includes(key))) return null;
  const targetDatabaseId = raw.targetDatabaseId;
  if (targetDatabaseId !== null && !ID_PATTERN.test(String(targetDatabaseId))) return null;
  if (typeof raw.multiple !== 'boolean') return null;
  return { targetDatabaseId: targetDatabaseId as PageId | null, multiple: raw.multiple };
}

export function normalizeControlFormat(raw: unknown): PropertyFormat | null {
  if (raw === undefined) return null;
  if (!isRecord(raw)) return null;
  const allowed = new Set([
    'locale', 'currency', 'precision', 'negativeFormat', 'min', 'max', 'step', 'dateStyle', 'timeStyle',
    'timeZone', 'durationUnit', 'scaleIcon', 'color', 'showValue', 'linkLabel',
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return null;
  const out: PropertyFormat = {};
  if (raw.locale !== undefined) {
    if (typeof raw.locale !== 'string' || raw.locale.length > 40) return null;
    try { new Intl.NumberFormat(raw.locale); out.locale = raw.locale; } catch { return null; }
  }
  if (raw.currency !== undefined) {
    if (typeof raw.currency !== 'string' || !/^[A-Z]{3}$/.test(raw.currency)) return null;
    try { new Intl.NumberFormat('en-US', { style: 'currency', currency: raw.currency }); out.currency = raw.currency; } catch { return null; }
  }
  const finite = (key: 'precision' | 'min' | 'max' | 'step', min: number, max: number) => {
    if (raw[key] === undefined) return true;
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || raw[key] < min || raw[key] > max) return false;
    out[key] = raw[key] as number;
    return true;
  };
  if (!finite('precision', 0, 8) || !finite('min', -1e12, 1e12) || !finite('max', -1e12, 1e12) || !finite('step', 1e-9, 1e12)) return null;
  if (raw.negativeFormat !== undefined) {
    if (raw.negativeFormat !== 'minus' && raw.negativeFormat !== 'parentheses') return null;
    out.negativeFormat = raw.negativeFormat;
  }
  if (raw.color !== undefined) {
    if (!COLORS.includes(raw.color as (typeof COLORS)[number])) return null;
    out.color = raw.color as (typeof COLORS)[number];
  }
  if (raw.showValue !== undefined) {
    if (typeof raw.showValue !== 'boolean') return null;
    out.showValue = raw.showValue;
  }
  if (raw.dateStyle !== undefined) {
    if (!['short', 'medium', 'long', 'full'].includes(raw.dateStyle as string)) return null;
    out.dateStyle = raw.dateStyle as NonNullable<PropertyFormat['dateStyle']>;
  }
  if (raw.timeStyle !== undefined) {
    if (!['short', 'medium', 'long', 'full'].includes(raw.timeStyle as string)) return null;
    out.timeStyle = raw.timeStyle as NonNullable<PropertyFormat['timeStyle']>;
  }
  if (raw.timeZone !== undefined) {
    if (typeof raw.timeZone !== 'string' || raw.timeZone.length > 100) return null;
    try { new Intl.DateTimeFormat('en-US', { timeZone: raw.timeZone }); out.timeZone = raw.timeZone; } catch { return null; }
  }
  if (raw.durationUnit !== undefined) {
    if (!['seconds', 'minutes', 'hours', 'days'].includes(raw.durationUnit as string)) return null;
    out.durationUnit = raw.durationUnit as NonNullable<PropertyFormat['durationUnit']>;
  }
  if (raw.scaleIcon !== undefined) {
    if (!['star', 'number'].includes(raw.scaleIcon as string)) return null;
    out.scaleIcon = raw.scaleIcon as NonNullable<PropertyFormat['scaleIcon']>;
  }
  if (raw.linkLabel !== undefined) {
    if (typeof raw.linkLabel !== 'string' || raw.linkLabel.length > 100) return null;
    out.linkLabel = raw.linkLabel;
  }
  if (out.min !== undefined && out.max !== undefined && out.min > out.max) return null;
  // Empty format objects are valid and stay distinguishable from malformed formats.
  return out;
}

export function controlValueErrorInState(
  control: NamedControlDef,
  value: PropValue,
  state: WorkspaceState,
): string | null {
  const error = controlValueError(control, value);
  if (error || control.type !== 'relation') return error;
  const targetId = control.relation?.targetDatabaseId;
  const target = targetId ? state.pages[targetId] : undefined;
  if (!targetId || !target || target.kind !== 'database' || isEffectivelyTrashed(state.pages, targetId))
    return 'Choose an available database for this relation control.';
  if (value === null) return null;
  const ids = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  if (ids.some((id) => !state.pages[id] || state.pages[id]!.parentId !== targetId || isEffectivelyTrashed(state.pages, id)))
    return 'Relation control values must be rows in their selected database.';
  return null;
}

export function namedControlIdentifier(name: string): string {
  return /^[\p{L}_][\p{L}\p{N}_]*$/u.test(name) ? name : `\`${name.replaceAll('`', '\\`')}\``;
}

