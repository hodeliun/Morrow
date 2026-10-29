import { isRecord, validateDoc } from './doc';
import { normalizeExtra } from './vault/frontmatter';
import { validPageIcon } from './icons';
import {
  COLORS,
  MAX_ICON_LENGTH,
  MAX_TITLE_LENGTH,
  PAGE_KINDS,
  PROP_TYPES,
  SCHEMA_VERSION,
  normalizeCoverPosition,
  normalizeNoteStyle,
  validCover,
  validColor,
  VIEW_TYPES,
} from './model';
import type {
  ActionFormulaDef,
  ColorName,
  DatabaseDef,
  DocNode,
  FilterOp,
  FilterRule,
  FilterGroup,
  PageId,
  PageKind,
  PageMeta,
  PropDef,
  FormulaReferenceBinding,
  PropertyFormat,
  PropType,
  PropValue,
  RelationConfig,
  ConditionalFormatRule,
  UnsupportedConditionalFormat,
  ViewDef,
  ViewType,
  SummaryOperation,
} from './model';
import { normalizeNamedControls } from './controls';
import { isNumericPropertyType } from './typedValues';
import { parseFormula } from './formula';
import { fail, ok } from './result';
import type { Result } from './result';

export interface RawWorkspace {
  pages: unknown[];
  docs: Record<string, unknown>;
}

export interface LoadedWorkspace {
  pages: PageMeta[];
  docs: Record<PageId, DocNode>;
  // records that could not be read, reported to the user and left untouched in storage
  problems: string[];
  // pages whose stored content failed validation, opened read only so nothing overwrites it
  unreadable: PageId[];
}

// each entry upgrades data from version n to n + 1
const MIGRATIONS: Record<number, (data: RawWorkspace) => RawWorkspace> = {
  // version 2 added stored files and page history, pages and documents kept their shape
  1: (data) => data,
  // version 3 added tags, database properties and new page kinds, normalizePage fills their defaults
  2: (data) => data,
  // version 4 adds cover/note styles and scoped relations; legacy values keep safe defaults
  3: (data) => data,
  // version 5 adds typed scalar formats and creation defaults; existing rows are unchanged
  4: (data) => data,
  // version 6 adds local media/rich-canvas values and stable relational formula bindings
  5: (data) => data,
  // version 7 adds independent linked-view blocks and per-view presentation/filter settings
  6: (data) => data,
  // version 8 adds page-scoped named controls and their formula/filter bindings
  7: (data) => data,
  // version 9 adds persisted table action configurations; older values remain unchanged
  8: (data) => data,
  // version 10 adds optional sequential defaults, prose column proportions and full-width note style
  9: (data) => data,
  // version 11 adds view-local frozen columns, bounded row heights and database display labels
  10: (data) => data,
  // version 12 adds typed conditional text styles while keeping legacy background colors
  11: (data) => data,
};

export function migrate(version: number, data: RawWorkspace): Result<RawWorkspace> {
  if (!Number.isInteger(version) || version < 1) return fail('The data has an unknown format version.');
  if (version > SCHEMA_VERSION) {
    return fail(
      `This data was written by a newer version of Morrow (format ${version}). Please update Morrow.`,
    );
  }
  let current = data;
  for (let v = version; v < SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) return fail(`No migration from format ${v}.`);
    current = step(current);
  }
  return ok(current);
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// fills safe defaults for missing optional fields, rejects records without a usable id
export function normalizePage(raw: unknown): PageMeta | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) return null;
  const extra = normalizeExtra(raw.extra);
  if (!extra) return null;
  const controls = normalizeNamedControls(raw.controls);
  if (!controls) return null;
  const num = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const updatedAt = num(raw.updatedAt, num(raw.createdAt, 0));
  const icon = validPageIcon(raw.icon) && [...raw.icon].length <= MAX_ICON_LENGTH ? raw.icon : null;
  return {
    id: raw.id,
    parentId:
      typeof raw.parentId === 'string' && ID_PATTERN.test(raw.parentId) && raw.parentId !== raw.id
        ? raw.parentId
        : null,
    title:
      typeof raw.title === 'string' ? raw.title.replace(/[\r\n\t]+/g, ' ').slice(0, MAX_TITLE_LENGTH) : '',
    icon,
    kind: PAGE_KINDS.includes(raw.kind as PageKind) ? (raw.kind as PageKind) : 'page',
    order: num(raw.order, 0),
    createdAt: num(raw.createdAt, updatedAt),
    updatedAt,
    trashedAt: typeof raw.trashedAt === 'number' && Number.isFinite(raw.trashedAt) ? raw.trashedAt : null,
    favorite: raw.favorite === true,
    dailyDate:
      typeof raw.dailyDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.dailyDate) ? raw.dailyDate : null,
    lastOpenedAt:
      typeof raw.lastOpenedAt === 'number' && Number.isFinite(raw.lastOpenedAt) ? raw.lastOpenedAt : null,
    tags: Array.isArray(raw.tags)
      ? [...new Set(raw.tags.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0))]
      : [],
    controls,
    properties: normalizeProperties(raw.properties),
    extra,
    database: normalizeDatabase(raw.database),
    cover: validCover(raw.cover),
    coverPosition: normalizeCoverPosition(raw.coverPosition),
    noteStyle: normalizeNoteStyle(raw.noteStyle),
    encrypted: raw.encrypted === true,
  };
}

const MAX_NAME_LENGTH = 200;
const FILTER_OPS = new Set<FilterOp>([
  'contains',
  'notContains',
  'is',
  'isNot',
  'empty',
  'notEmpty',
  'gt',
  'lt',
  'checked',
  'unchecked',
]);

const nameOf = (value: unknown, fallback: string) =>
  typeof value === 'string' ? value.slice(0, MAX_NAME_LENGTH) : fallback;
const validId = (value: unknown): value is string => typeof value === 'string' && ID_PATTERN.test(value);
const records = (value: unknown) => (Array.isArray(value) ? value.filter(isRecord) : []);

function normalizeValue(value: unknown): PropValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value as string[];
  return undefined;
}

function normalizeProperties(raw: unknown): Record<string, PropValue> {
  if (!isRecord(raw)) return {};
  const result: Record<string, PropValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    const normalized = normalizeValue(value);
    if (ID_PATTERN.test(key) && normalized !== undefined) result[key] = normalized;
  }
  return result;
}

function normalizeProp(raw: Record<string, unknown>): PropDef | null {
  if (!validId(raw.id) || !PROP_TYPES.includes(raw.type as PropType)) return null;
  const action = raw.type === 'button' ? normalizeTableAction(raw.action, nameOf(raw.name, 'Action')) : null;
  if (raw.type === 'button' && !action) return null;
  const defaultSequence = normalizeDefaultSequence(raw.defaultSequence);
  if (
    (raw.defaultSequence !== undefined &&
      (!defaultSequence || !isNumericPropertyType(raw.type as PropType) || raw.defaultFormula !== undefined)) ||
    (raw.sequenceNext !== undefined &&
      (typeof raw.sequenceNext !== 'number' || !Number.isFinite(raw.sequenceNext)))
  )
    return null;
  const defaultValue = normalizeValue(raw.defaultValue);
  const fillMode = ['manual', 'default', 'calculated'].includes(raw.fillMode as string)
    ? (raw.fillMode as PropDef['fillMode'])
    : defaultSequence
      ? 'default'
      : undefined;
  return {
    id: raw.id,
    name: nameOf(raw.name, ''),
    type: raw.type as PropType,
    options:
      raw.type === 'button'
        ? []
        : records(raw.options)
            .filter((option) => validId(option.id))
            .map((option) => ({
              id: option.id as string,
              name: nameOf(option.name, ''),
              color: COLORS.includes(option.color as ColorName) ? (option.color as ColorName) : 'gray',
            })),
    ...(typeof raw.description === 'string' ? { description: raw.description.slice(0, 2000) } : {}),
    ...(validPageIcon(raw.icon) ? { icon: raw.icon } : {}),
    ...(PROP_TYPES.includes(raw.formulaResultType as PropType) ? { formulaResultType: raw.formulaResultType as PropType } : {}),
    ...(raw.type !== 'button' && normalizePropertyFormat(raw.format) ? { format: normalizePropertyFormat(raw.format)! } : {}),
    ...(raw.type !== 'button' && fillMode ? { fillMode } : {}),
    ...(raw.type !== 'button' && defaultValue !== undefined ? { defaultValue } : {}),
    ...(raw.type !== 'button' && typeof raw.defaultFormula === 'string' ? { defaultFormula: raw.defaultFormula.slice(0, 2000) } : {}),
    ...(defaultSequence ? { defaultSequence } : {}),
    ...(raw.sequenceNext !== undefined ? { sequenceNext: raw.sequenceNext as number } : {}),
    ...(raw.type !== 'button' && typeof raw.defaultFormula === 'string'
      ? { defaultFormulaBindings: normalizeFormulaBindings(raw.defaultFormula, raw.defaultFormulaBindings) }
      : {}),
    ...(raw.type !== 'button' && typeof raw.formula === 'string' ? { formula: raw.formula.slice(0, 2000) } : {}),
    ...(raw.type !== 'button' && typeof raw.formula === 'string'
      ? { formulaBindings: normalizeFormulaBindings(raw.formula, raw.formulaBindings) }
      : {}),
    ...(raw.type !== 'button' && raw.display === 'bar' ? { display: 'bar' as const } : {}),
    ...(raw.type !== 'button' && typeof raw.max === 'number' && Number.isFinite(raw.max) && raw.max > 0 ? { max: raw.max } : {}),
    ...(raw.type === 'relation' && isRecord(raw.relation)
      ? { relation: normalizeRelation(raw.relation) }
      : {}),
    ...((raw.type === 'image' || raw.type === 'file') && isRecord(raw.media)
      ? { media: { multiple: raw.media.multiple === true } }
      : {}),
    ...(action ? { action } : {}),
  };
}

function normalizeDefaultSequence(raw: unknown): PropDef['defaultSequence'] | null {
  if (!isRecord(raw)) return null;
  if (
    typeof raw.start !== 'number' ||
    !Number.isFinite(raw.start) ||
    typeof raw.increment !== 'number' ||
    !Number.isFinite(raw.increment) ||
    raw.increment <= 0 ||
    !Number.isFinite(raw.start + raw.increment) ||
    raw.start + raw.increment <= raw.start
  )
    return null;
  return { start: raw.start, increment: raw.increment };
}

function defaultTableAction(label: string): NonNullable<PropDef['action']> {
  return { label: label.trim().slice(0, 100) || 'Action', icon: 'play', color: 'blue', steps: [] };
}

function normalizeActionFormula(raw: unknown): ActionFormulaDef | null {
  if (!isRecord(raw) || typeof raw.source !== 'string' || raw.source.length > 2000) return null;
  return { source: raw.source, bindings: normalizeFormulaBindings(raw.source, raw.bindings) };
}

function normalizeTableAction(raw: unknown, label: string): PropDef['action'] | null {
  if (raw === undefined) return defaultTableAction(label);
  if (!isRecord(raw)) return null;
  const icon = ['play', 'plus', 'check', 'refresh'].includes(String(raw.icon))
    ? (raw.icon as NonNullable<PropDef['action']>['icon'])
    : null;
  const color = COLORS.includes(raw.color as ColorName) ? (raw.color as ColorName) : null;
  if (
    typeof raw.label !== 'string' ||
    raw.label.trim().length === 0 ||
    raw.label.length > 100 ||
    !icon ||
    !color ||
    !Array.isArray(raw.steps) ||
    raw.steps.length > 12
  )
    return null;
  const disabled = raw.disabled === undefined ? undefined : normalizeActionFormula(raw.disabled);
  if (raw.disabled !== undefined && !disabled) return null;
  const steps: NonNullable<PropDef['action']>['steps'] = [];
  for (const item of raw.steps) {
    if (!isRecord(item) || !validId(item.id)) return null;
    if (item.type === 'addRows') {
      const count = normalizeActionFormula(item.count);
      const title = normalizeActionFormula(item.title);
      const values = normalizeActionValues(item.values);
      if (!count || !title || !values) return null;
      steps.push({ id: item.id, type: 'addRows', count, title, values });
    } else if (item.type === 'modifyRows') {
      const target = item.target === 'matchingRows' ? 'matchingRows' : item.target === 'currentRow' ? 'currentRow' : null;
      const where = item.where === undefined ? undefined : normalizeActionFormula(item.where);
      const values = normalizeActionValues(item.values);
      if (!target || (item.where !== undefined && !where) || !values) return null;
      steps.push({ id: item.id, type: 'modifyRows', target, ...(where ? { where } : {}), values });
    } else if (item.type === 'resetControls') {
      if (!Array.isArray(item.controlIds) || item.controlIds.length > 200) return null;
      const controlIds = item.controlIds.filter(validId);
      if (controlIds.length !== item.controlIds.length || new Set(controlIds).size !== controlIds.length) return null;
      steps.push({ id: item.id, type: 'resetControls', controlIds });
    } else return null;
  }
  return {
    label: raw.label.trim(),
    icon,
    color,
    ...(disabled ? { disabled } : {}),
    steps,
  };
}

function normalizeActionValues(raw: unknown): Record<string, ActionFormulaDef> | null {
  if (!isRecord(raw) || Object.keys(raw).length > 200) return null;
  const values: Record<string, ActionFormulaDef> = {};
  for (const [id, item] of Object.entries(raw)) {
    if (!validId(id)) return null;
    const formula = normalizeActionFormula(item);
    if (!formula) return null;
    values[id] = formula;
  }
  return values;
}

function normalizeFormulaBindings(source: string, raw: unknown): FormulaReferenceBinding[] {
  if (!Array.isArray(raw)) return [];
  const result: FormulaReferenceBinding[] = [];
  for (const item of raw.slice(0, 500)) {
    if (!isRecord(item)) continue;
    const { start, end, kind, databaseId, propertyId, pageId, controlId, resultId } = item;
    if (
      typeof start !== 'number' ||
      !Number.isInteger(start) ||
      start < 0 ||
      typeof end !== 'number' ||
      !Number.isInteger(end) ||
      end <= start ||
      end > source.length ||
      typeof item.source !== 'string' ||
      item.source.length > 256 ||
      source.slice(start, end) !== item.source ||
      !['database', 'property', 'control', 'result', 'ambiguous'].includes(String(kind)) ||
      ((kind === 'database' || kind === 'property') && !validId(databaseId)) ||
      (kind === 'property' && !validId(propertyId)) ||
      ((kind === 'control' || kind === 'result' || kind === 'ambiguous') && !validId(pageId)) ||
      (kind === 'control' && !validId(controlId)) ||
      (kind === 'result' && !validId(resultId))
    ) continue;
    const span = { start, end, source: item.source };
    if (kind === 'control') result.push({ ...span, kind, pageId: pageId as string, controlId: controlId as string });
    else if (kind === 'result') result.push({ ...span, kind, pageId: pageId as string, resultId: resultId as string });
    else if (kind === 'ambiguous') result.push({ ...span, kind, pageId: pageId as string });
    else if (kind === 'property') result.push({ ...span, kind, databaseId: databaseId as string, propertyId: propertyId as string });
    else if (kind === 'database') result.push({ ...span, kind, databaseId: databaseId as string });
  }
  return result;
}

const MAX_CONDITIONAL_FORMATS = 100;
const CONDITIONAL_FORMAT_FIELDS = new Set([
  'id', 'prop', 'op', 'value', 'controlRef', 'formula', 'formulaBindings', 'scope', 'color', 'mode',
  'textColor', 'bold', 'italic',
]);

interface ConditionalFormatParse {
  rule: ConditionalFormatRule | null;
  reason: string | null;
}

function parseConditionalFormatRule(raw: unknown): ConditionalFormatParse {
  if (!isRecord(raw)) return { rule: null, reason: 'Rule must be an object.' };
  if (Object.keys(raw).some((key) => !CONDITIONAL_FORMAT_FIELDS.has(key)))
    return { rule: null, reason: 'Rule contains fields this version does not understand.' };
  if (!validId(raw.id)) return { rule: null, reason: 'Rule has an invalid ID.' };
  if (typeof raw.prop !== 'string' || !raw.prop || raw.prop.length > 64)
    return { rule: null, reason: 'Rule has an invalid property reference.' };
  if (raw.scope !== 'row' && raw.scope !== 'cell')
    return { rule: null, reason: 'Rule scope must be row or cell.' };
  if (!FILTER_OPS.has(raw.op as FilterOp)) return { rule: null, reason: 'Rule has an invalid condition operator.' };
  const value = normalizeValue(raw.value);
  if (value === undefined) return { rule: null, reason: 'Rule has an invalid condition value.' };
  if (raw.mode !== undefined && raw.mode !== 'simple' && raw.mode !== 'formula')
    return { rule: null, reason: 'Rule mode must be simple or formula.' };
  if (raw.formula !== undefined && (typeof raw.formula !== 'string' || raw.formula.length > 2000))
    return { rule: null, reason: 'Rule formula must be text up to 2000 characters.' };

  const mode = raw.mode === 'formula'
    ? 'formula'
    : raw.mode === 'simple'
      ? 'simple'
      : typeof raw.formula === 'string' && raw.formula.trim()
        ? 'formula'
        : 'simple';
  const formula = typeof raw.formula === 'string' ? raw.formula : '';
  if (mode === 'formula' && !formula.trim())
    return { rule: null, reason: 'Formula mode requires a non-empty formula.' };
  if (mode === 'formula') {
    try {
      parseFormula(formula);
    } catch (error) {
      return {
        rule: null,
        reason: `Formula is invalid: ${error instanceof Error ? error.message : 'syntax error.'}`,
      };
    }
  }

  let controlRef: FilterRule['controlRef'];
  if (raw.controlRef !== undefined) {
    if (
      !isRecord(raw.controlRef) ||
      Object.keys(raw.controlRef).some((key) => key !== 'pageId' && key !== 'controlId') ||
      !validId(raw.controlRef.pageId) ||
      !validId(raw.controlRef.controlId)
    ) return { rule: null, reason: 'Rule has an invalid control reference.' };
    controlRef = { pageId: raw.controlRef.pageId, controlId: raw.controlRef.controlId };
  }

  let formulaBindings: FormulaReferenceBinding[] | undefined;
  if (raw.formulaBindings !== undefined) {
    if (!Array.isArray(raw.formulaBindings) || raw.formulaBindings.length > 500)
      return { rule: null, reason: 'Rule has invalid formula bindings.' };
    const allowedBindingFields = [
      'start', 'end', 'source', 'kind', 'databaseId', 'propertyId', 'pageId', 'controlId', 'resultId',
    ];
    if (raw.formulaBindings.some((binding) =>
      !isRecord(binding) || Object.keys(binding).some((key) => !allowedBindingFields.includes(key))))
      return { rule: null, reason: 'Rule has formula bindings with fields this version does not understand.' };
    formulaBindings = normalizeFormulaBindings(formula, raw.formulaBindings);
    if (formulaBindings.length !== raw.formulaBindings.length)
      return { rule: null, reason: 'Rule has invalid formula bindings.' };
  }

  const color = raw.color === undefined ? null : validColor(raw.color);
  if (raw.color !== undefined && !color) return { rule: null, reason: 'Rule has an invalid background color.' };
  const textColor = raw.textColor === undefined ? null : validColor(raw.textColor);
  if (raw.textColor !== undefined && !textColor)
    return { rule: null, reason: 'Rule has an invalid text color.' };
  if (raw.bold !== undefined && typeof raw.bold !== 'boolean')
    return { rule: null, reason: 'Rule bold style must be true or false.' };
  if (raw.italic !== undefined && typeof raw.italic !== 'boolean')
    return { rule: null, reason: 'Rule italic style must be true or false.' };
  if (color === null && textColor === null && raw.bold === undefined && raw.italic === undefined)
    return { rule: null, reason: 'Rule does not specify a style.' };

  return {
    rule: {
      id: raw.id,
      prop: raw.prop,
      op: raw.op as FilterOp,
      value,
      scope: raw.scope,
      ...(controlRef ? { controlRef } : {}),
      mode,
      formula,
      ...(formulaBindings ? { formulaBindings } : {}),
      ...(color ? { color } : {}),
      ...(textColor ? { textColor } : {}),
      ...(raw.bold !== undefined ? { bold: raw.bold } : {}),
      ...(raw.italic !== undefined ? { italic: raw.italic } : {}),
    },
    reason: null,
  };
}

export function conditionalFormatRulesProblem(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) return 'Conditional formatting rules must be a list.';
  if (raw.length > MAX_CONDITIONAL_FORMATS)
    return `A view can contain at most ${MAX_CONDITIONAL_FORMATS} conditional formatting rules.`;
  const ids = new Set<string>();
  for (const entry of raw) {
    const parsed = parseConditionalFormatRule(entry);
    if (!parsed.rule) return parsed.reason ?? 'Conditional formatting rule is invalid.';
    if (ids.has(parsed.rule.id)) return `Conditional formatting rule ID “${parsed.rule.id}” is duplicated.`;
    ids.add(parsed.rule.id);
  }
  return null;
}

function copyUnsupportedConditionalFormats(raw: unknown): UnsupportedConditionalFormat[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!isRecord(entry) || !Number.isInteger(entry.index) || (entry.index as number) < 0 ||
      !Object.prototype.hasOwnProperty.call(entry, 'raw') || typeof entry.reason !== 'string') return [];
    return [{
      index: entry.index as number,
      raw: entry.raw,
      reason: entry.reason,
      ...(entry.wholeList === true ? { wholeList: true } : {}),
      ...(validId(entry.beforeRuleId) ? { beforeRuleId: entry.beforeRuleId } : {}),
      ...(validId(entry.afterRuleId) ? { afterRuleId: entry.afterRuleId } : {}),
    }];
  });
}

function normalizePropertyFormat(raw: unknown): PropertyFormat | null {
  if (!isRecord(raw)) return null;
  const finite = (value: unknown, min: number, max: number) =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
  const locale = validLocale(raw.locale) ? raw.locale : undefined;
  const currency = validCurrency(raw.currency) ? raw.currency : undefined;
  const precision = finite(raw.precision, 0, 8);
  const min = finite(raw.min, -1e12, 1e12);
  const max = finite(raw.max, -1e12, 1e12);
  const step = finite(raw.step, 1e-9, 1e12);
  const dateStyle = ['short', 'medium', 'long', 'full'].includes(raw.dateStyle as string)
    ? (raw.dateStyle as PropertyFormat['dateStyle'])
    : undefined;
  const timeStyle = ['short', 'medium', 'long', 'full'].includes(raw.timeStyle as string)
    ? (raw.timeStyle as PropertyFormat['timeStyle'])
    : undefined;
  const timeZone = validTimeZone(raw.timeZone) ? raw.timeZone : undefined;
  const durationUnit = ['seconds', 'minutes', 'hours', 'days'].includes(raw.durationUnit as string)
    ? (raw.durationUnit as PropertyFormat['durationUnit'])
    : undefined;
  const negativeFormat = ['minus', 'parentheses'].includes(raw.negativeFormat as string)
    ? (raw.negativeFormat as PropertyFormat['negativeFormat'])
    : undefined;
  const scaleIcon = ['star', 'number'].includes(raw.scaleIcon as string)
    ? (raw.scaleIcon as PropertyFormat['scaleIcon'])
    : undefined;
  const color = COLORS.includes(raw.color as ColorName) ? (raw.color as ColorName) : undefined;
  const normalized = {
    ...(locale ? { locale } : {}),
    ...(typeof raw.linkLabel === 'string' ? { linkLabel: raw.linkLabel.slice(0, 200) } : {}),
    ...(currency ? { currency } : {}),
    ...(precision !== undefined ? { precision } : {}),
    ...(negativeFormat ? { negativeFormat } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(step !== undefined ? { step } : {}),
    ...(dateStyle ? { dateStyle } : {}),
    ...(timeStyle ? { timeStyle } : {}),
    ...(timeZone ? { timeZone } : {}),
    ...(durationUnit ? { durationUnit } : {}),
    ...(scaleIcon ? { scaleIcon } : {}),
    ...(color ? { color } : {}),
    ...(typeof raw.showValue === 'boolean' ? { showValue: raw.showValue } : {}),
  } satisfies PropertyFormat;
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function validLocale(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  try {
    new Intl.NumberFormat(value);
    return true;
  } catch {
    return false;
  }
}

function validCurrency(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) return false;
  try {
    new Intl.NumberFormat('en-US', { style: 'currency', currency: value });
    return true;
  } catch {
    return false;
  }
}

function validTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function normalizeRelation(raw: Record<string, unknown>): RelationConfig {
  const propRef = (value: unknown) => (validId(value) ? value : null);
  return {
    targetDatabaseId: propRef(raw.targetDatabaseId),
    multiple: raw.multiple === true,
    isInverse: raw.isInverse === true,
    displayPropertyId: propRef(raw.displayPropertyId),
    inversePropertyId: propRef(raw.inversePropertyId),
    filters: records(raw.filters).flatMap((filter) => {
      const prop = propRef(filter.prop);
      const value = normalizeValue(filter.value);
      if (!validId(filter.id) || !prop || !FILTER_OPS.has(filter.op as FilterOp) || value === undefined)
        return [];
      return [{ id: filter.id, prop, op: filter.op as FilterOp, value }];
    }),
  };
}

function normalizeView(raw: Record<string, unknown>): ViewDef | null {
  if (!validId(raw.id) || !VIEW_TYPES.includes(raw.type as ViewType)) return null;
  const propRef = (value: unknown) => (typeof value === 'string' && value.length <= 64 ? value : null);
  const filtersOf = (value: unknown) =>
    records(value).flatMap((filter) => {
      const prop = propRef(filter.prop);
      const normalizedValue = normalizeValue(filter.value);
      const formula = typeof filter.formula === 'string' ? filter.formula.slice(0, 2000) : undefined;
      const controlRef = isRecord(filter.controlRef) && validId(filter.controlRef.pageId) && validId(filter.controlRef.controlId)
        ? { pageId: filter.controlRef.pageId, controlId: filter.controlRef.controlId }
        : undefined;
      if (
        !validId(filter.id) ||
        !prop ||
        !FILTER_OPS.has(filter.op as FilterOp) ||
        normalizedValue === undefined ||
        (filter.formula !== undefined && formula === undefined)
      )
        return [];
      return [{
        id: filter.id, prop, op: filter.op as FilterOp, value: normalizedValue,
        ...(controlRef ? { controlRef } : {}),
        ...(formula !== undefined ? { formula, formulaBindings: normalizeFormulaBindings(formula, filter.formulaBindings) } : {}),
      }];
    });
  const filterGroups: FilterGroup[] = records(raw.filterGroups)
    .slice(0, 50)
    .flatMap((group) => {
      if (!validId(group.id) || (group.logic !== 'and' && group.logic !== 'or')) return [];
      return [{ id: group.id, logic: group.logic, filters: filtersOf(group.filters).slice(0, 100) }];
    });
  const summaryOps = new Set<SummaryOperation>(['sum', 'average', 'median', 'min', 'max', 'range', 'count', 'countValues', 'countUnique', 'countEmpty', 'countNotEmpty', 'percentEmpty', 'percentNotEmpty', 'checked', 'unchecked', 'percentChecked']);
  const summaries = isRecord(raw.summaries)
    ? (Object.fromEntries(
        Object.entries(raw.summaries)
          .slice(0, 200)
          .filter(([key, value]) => key.length <= 64 && summaryOps.has(value as SummaryOperation)),
      ) as Record<string, SummaryOperation>)
    : undefined;
  const conditionalFormats: ConditionalFormatRule[] = [];
  const unsupportedConditionalFormats = copyUnsupportedConditionalFormats(raw.unsupportedConditionalFormats);
  if (raw.conditionalFormats !== undefined && !Array.isArray(raw.conditionalFormats)) {
    unsupportedConditionalFormats.push({
      index: 0,
      raw: raw.conditionalFormats,
      reason: 'Conditional formatting rules must be a list.',
      wholeList: true,
    });
  }
  const conditionalFormatEntries = Array.isArray(raw.conditionalFormats) ? raw.conditionalFormats : [];
  const supportedRuleIds = new Set<string>();
  const parsedWithinLimit: Array<{
    entry: unknown;
    index: number;
    ruleId?: string;
    unsupportedReason?: string;
    opaque?: UnsupportedConditionalFormat;
  }> = [];
  for (let index = 0; index < Math.min(conditionalFormatEntries.length, MAX_CONDITIONAL_FORMATS); index++) {
    const entry = conditionalFormatEntries[index];
    const parsed = parseConditionalFormatRule(entry);
    if (!parsed.rule) {
      parsedWithinLimit.push({ entry, index, unsupportedReason: parsed.reason ?? 'Rule is invalid.' });
      continue;
    }
    if (supportedRuleIds.has(parsed.rule.id)) {
      parsedWithinLimit.push({ entry, index, unsupportedReason: 'Rule ID is duplicated.' });
      continue;
    }
    supportedRuleIds.add(parsed.rule.id);
    parsedWithinLimit.push({ entry, index, ruleId: parsed.rule.id });
    conditionalFormats.push(parsed.rule);
  }
  let previousRuleId: string | undefined;
  for (const entry of parsedWithinLimit) {
    if (entry.ruleId) {
      previousRuleId = entry.ruleId;
      continue;
    }
    const opaque: UnsupportedConditionalFormat = {
      index: entry.index,
      raw: entry.entry,
      reason: entry.unsupportedReason!,
      ...(previousRuleId ? { beforeRuleId: previousRuleId } : {}),
    };
    entry.opaque = opaque;
    unsupportedConditionalFormats.push(opaque);
  }
  const lastSupportedRuleId = previousRuleId;
  let nextRuleId: string | undefined;
  for (let index = parsedWithinLimit.length - 1; index >= 0; index--) {
    const entry = parsedWithinLimit[index]!;
    if (entry.ruleId) {
      nextRuleId = entry.ruleId;
      continue;
    }
    if (entry.opaque && nextRuleId) entry.opaque.afterRuleId = nextRuleId;
  }
  for (let index = MAX_CONDITIONAL_FORMATS; index < conditionalFormatEntries.length; index++) {
    const entry = conditionalFormatEntries[index];
    unsupportedConditionalFormats.push({
      index,
      raw: entry,
      reason: `Rule is beyond this version's ${MAX_CONDITIONAL_FORMATS}-rule limit.`,
      ...(lastSupportedRuleId ? { beforeRuleId: lastSupportedRuleId } : {}),
    });
  }
  const align = isRecord(raw.align)
    ? (Object.fromEntries(
        Object.entries(raw.align)
          .slice(0, 200)
          .filter(
            ([key, value]) => key.length <= 64 && ['left', 'center', 'right'].includes(value as string),
          ),
      ) as Record<string, 'left' | 'center' | 'right'>)
    : undefined;
  return {
    id: raw.id,
    name: nameOf(raw.name, ''),
    type: raw.type as ViewType,
    filters: filtersOf(raw.filters),
    sorts: records(raw.sorts).flatMap((sort) => {
      const prop = propRef(sort.prop);
      return prop ? [{ prop, dir: sort.dir === 'desc' ? ('desc' as const) : ('asc' as const) }] : [];
    }),
    groupBy: propRef(raw.groupBy),
    dateProp: propRef(raw.dateProp),
    hidden: Array.isArray(raw.hidden) ? raw.hidden.filter((id): id is string => propRef(id) !== null) : [],
    ...(isRecord(raw.widths) ? { widths: normalizeWidths(raw.widths) } : {}),
    ...(propRef(raw.frozenThrough) ? { frozenThrough: propRef(raw.frozenThrough)! } : {}),
    ...(typeof raw.rowHeight === 'number' && Number.isInteger(raw.rowHeight) && raw.rowHeight >= 34 && raw.rowHeight <= 240
      ? { rowHeight: raw.rowHeight }
      : {}),
    ...(raw.hideTitle === true ? { hideTitle: true } : {}),
    ...(raw.collapsed === true ? { collapsed: true } : {}),
    ...(raw.collapseEnabled === false ? { collapseEnabled: false } : {}),
    ...(filterGroups.length ? { filterGroups } : {}),
    ...(raw.filterGroupLogic === 'and' || raw.filterGroupLogic === 'or'
      ? { filterGroupLogic: raw.filterGroupLogic }
      : {}),
    ...(typeof raw.search === 'string' ? { search: raw.search.slice(0, 500) } : {}),
    ...(Array.isArray(raw.order)
      ? { order: [...new Set(raw.order.filter((id): id is string => propRef(id) !== null))].slice(0, 200) }
      : {}),
    ...(Array.isArray(raw.wrap)
      ? { wrap: [...new Set(raw.wrap.filter((id): id is string => propRef(id) !== null))].slice(0, 200) }
      : {}),
    ...(align && Object.keys(align).length ? { align } : {}),
    ...(summaries && Object.keys(summaries).length ? { summaries } : {}),
    ...(conditionalFormats.length ? { conditionalFormats } : {}),
    ...(unsupportedConditionalFormats.length ? { unsupportedConditionalFormats } : {}),
    ...(Array.isArray(raw.cardProperties)
      ? {
          cardProperties: [
            ...new Set(raw.cardProperties.filter((id): id is string => propRef(id) !== null)),
          ].slice(0, 200),
        }
      : {}),
    ...(propRef(raw.cardImageProp) !== null
      ? { cardImageProp: propRef(raw.cardImageProp) }
      : raw.cardImageProp === null
        ? { cardImageProp: null }
        : {}),
  };
}

export const MIN_COLUMN_WIDTH = 80;
export const MAX_COLUMN_WIDTH = 1200;

function normalizeWidths(raw: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw).slice(0, 200)) {
    if (key.length > 64 || typeof value !== 'number' || !Number.isFinite(value)) continue;
    out[key] = Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, value)));
  }
  return out;
}

export function normalizeDatabase(raw: unknown): DatabaseDef | null {
  if (!isRecord(raw)) return null;
  const properties: PropDef[] = [];
  const unsupportedProperties: unknown[] = Array.isArray(raw.unsupportedProperties)
    ? raw.unsupportedProperties.slice(0, 200)
    : [];
  const rawProperties = Array.isArray(raw.properties) ? raw.properties.slice(0, 200) : [];
  for (const item of rawProperties) {
    const normalized = isRecord(item) ? normalizeProp(item) : null;
    if (normalized) properties.push(normalized);
    else unsupportedProperties.push(item);
  }
  return {
    properties,
    ...(typeof raw.displayPropertyId === 'string' && properties.some((prop) => prop.id === raw.displayPropertyId)
      ? { displayPropertyId: raw.displayPropertyId }
      : {}),
    ...(unsupportedProperties.length ? { unsupportedProperties } : {}),
    views: records(raw.views).flatMap((view) => normalizeView(view) ?? []),
  };
}

// validates every record independently so one bad record never blocks the rest
export function readWorkspace(version: number, raw: RawWorkspace): Result<LoadedWorkspace> {
  const migrated = migrate(version, raw);
  if (!migrated.ok) return migrated;
  const problems: string[] = [];
  const pages: PageMeta[] = [];
  const docs: Record<PageId, DocNode> = {};
  const unreadable: PageId[] = [];
  const seen = new Set<PageId>();
  for (const record of migrated.value.pages) {
    const page = normalizePage(record);
    if (!page) {
      problems.push('A page record could not be read and was skipped.');
      continue;
    }
    if (seen.has(page.id)) continue;
    seen.add(page.id);
    pages.push(page);
    const doc = migrated.value.docs[page.id];
    if (doc === undefined) continue;
    const valid = validateDoc(doc);
    if (valid.ok) docs[page.id] = valid.value;
    else {
      unreadable.push(page.id);
      problems.push(`The content of "${page.title || 'Untitled'}" could not be read: ${valid.error}`);
    }
  }
  problems.push(...relationMigrationProblems(pages));
  return ok({ pages, docs, problems, unreadable });
}

function relationMigrationProblems(pages: PageMeta[]): string[] {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const problems: string[] = [];
  for (const database of pages) {
    if (database.kind !== 'database' || !database.database) continue;
    const rows = pages.filter((page) => page.parentId === database.id);
    for (const prop of database.database.properties.filter((item) => item.type === 'relation')) {
      const values = rows.flatMap((row) => {
        const value = row.properties[prop.id];
        return Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
      });
      if (values.length === 0) continue;
      const targetId = prop.relation?.targetDatabaseId;
      if (!targetId) {
        problems.push(
          `Relation "${prop.name}" in "${database.title || 'Untitled'}" has legacy title references. Choose a target database to migrate unambiguous titles; unresolved references remain available for manual repair.`,
        );
        continue;
      }
      const target = byId.get(targetId);
      if (!target || target.kind !== 'database') {
        problems.push(
          `Relation "${prop.name}" in "${database.title || 'Untitled'}" has a missing target database.`,
        );
        continue;
      }
      const invalid = values.filter((value) => byId.get(value)?.parentId !== targetId);
      if (invalid.length > 0) {
        problems.push(
          `Relation "${prop.name}" in "${database.title || 'Untitled'}" has ${invalid.length} unresolved, ambiguous, or deleted target${invalid.length === 1 ? '' : 's'}.`,
        );
      }
    }
  }
  return problems;
}
