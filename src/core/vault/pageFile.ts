// how one page maps to its markdown file: frontmatter for metadata, the body for content
import { dailyTitle, parseDateKey } from '../daily';
import { isRecord } from '../doc';
import { normalizeDatabase } from '../migrations';
import { normalizeNamedControls } from '../controls';
import { serializeConditionalFormats } from '../conditionalFormats';
import { validPageIcon } from '../icons';
import {
  COLORS,
  DEFAULT_COVER_POSITION,
  displayTitle,
  MAX_ICON_LENGTH,
  MAX_TITLE_LENGTH,
  normalizeCoverPosition,
  normalizeNoteStyle,
  validCover,
} from '../model';
import type {
  DatabaseDef,
  NoteStyle,
  NamedControlDef,
  PageKind,
  PageMeta,
  PropDef,
  PropValue,
  SelectOption,
  WorkspaceState,
} from '../model';
import { relationDisplayLabel, relationIds } from '../relations';
import {
  durationUnitFactor,
  durationUnitFromText,
  isComputedProperty,
  scalarValueError,
  isValidDateKey,
  isValidDateTime,
  isValidTime,
  parseLocalizedNumber,
} from '../typedValues';
import {
  findKey,
  joinFrontmatter,
  MANAGED_KEYS,
  normalizeExtra,
  readTags,
  splitFrontmatter,
  updateFrontmatter,
} from './frontmatter';

export { MANAGED_KEYS };
const FILE_KINDS = new Set<PageKind>(['journal', 'templates', 'database']);
const DATABASE_FIELDS = new Set(['titleAlias', 'displayPropertyId', 'properties', 'views']);
const PROPERTY_FIELDS = new Set([
  'id', 'name', 'type', 'options', 'description', 'icon', 'formulaResultType', 'format', 'fillMode',
  'defaultValue', 'defaultFormula', 'defaultSequence', 'sequenceNext', 'defaultFormulaBindings',
  'formula', 'formulaBindings', 'display', 'max', 'relation', 'action', 'media',
]);
const FORMAT_FIELDS = new Set([
  'locale', 'linkLabel', 'currency', 'precision', 'negativeFormat', 'min', 'max', 'step', 'dateStyle',
  'timeStyle', 'timeZone', 'durationUnit', 'scaleIcon', 'color', 'showValue',
]);
const OPTION_FIELDS = new Set(['id', 'name', 'color']);
const RELATION_FIELDS = new Set([
  'targetDatabaseId', 'multiple', 'isInverse', 'displayPropertyId', 'inversePropertyId', 'filters',
]);
const ACTION_FIELDS = new Set(['label', 'icon', 'color', 'disabled', 'steps']);
const ACTION_FORMULA_FIELDS = new Set(['source', 'bindings']);
const VIEW_FIELDS = new Set([
  'id', 'name', 'type', 'filters', 'sorts', 'groupBy', 'dateProp', 'hidden', 'widths', 'frozenThrough',
  'rowHeight', 'hideTitle', 'collapsed', 'collapseEnabled', 'filterGroups', 'filterGroupLogic', 'search',
  'order', 'wrap', 'align', 'summaries', 'conditionalFormats',
  'cardProperties', 'cardImageProp',
]);
const FILTER_FIELDS = new Set(['id', 'prop', 'op', 'value', 'controlRef', 'formula', 'formulaBindings']);
const FILTER_GROUP_FIELDS = new Set(['id', 'logic', 'filters']);
const SORT_FIELDS = new Set(['prop', 'dir']);
// a database property can not use a name morrow already gives a meaning to
export function reservedPropertyName(name: string): boolean {
  return MANAGED_KEYS.has(name.trim()) || name.trim() === 'aliases';
}

export interface PageSource {
  // frontmatter keys in the order the file had them
  keyOrder: string[];
  // the frontmatter as it was read, and its exact text, reused when nothing in it changed
  rawData: Record<string, unknown> | null;
  rawHead: string;
  rawYaml: string;
  // the body as read from disk, kept while the page has not been edited in morrow
  body: string | null;
  // other names the page answers to in [[links]], from obsidian's aliases property
  aliases: string[];
}

export interface ReadPage {
  title: string | null;
  icon: string | null;
  cover: string | null;
  coverPosition: number;
  noteStyle: NoteStyle | null;
  calculatedResultBackground: boolean | null;
  controls: NamedControlDef[];
  kind: PageKind | null;
  tags: string[];
  database: DatabaseDef | null;
  // every frontmatter value, property values are mapped once the parent database is known
  data: Record<string, unknown>;
  // the values morrow does not manage, database rows take theirs out of here
  extra: Record<string, unknown>;
  source: PageSource;
  body: string;
  error: string | null;
}

export function readPageText(text: string): ReadPage {
  const split = splitFrontmatter(text);
  const data = split.data ?? {};
  const title =
    typeof data.title === 'string' && data.title.trim()
      ? data.title.replace(/[\r\n\t]+/g, ' ').slice(0, MAX_TITLE_LENGTH)
      : null;
  const icon = validPageIcon(data.icon) && [...data.icon].length <= MAX_ICON_LENGTH ? data.icon : null;
  const kind = FILE_KINDS.has(data.kind as PageKind) ? (data.kind as PageKind) : null;
  const rawExtra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data))
    if (!MANAGED_KEYS.has(key))
      Object.defineProperty(rawExtra, key, { value, enumerable: true, writable: true, configurable: true });
  const normalizedExtra = normalizeExtra(rawExtra);
  const extra = normalizedExtra ?? {};
  const controls = normalizeNamedControls(data.morrowControls);
  const hasCalculatedResultBackground = Object.hasOwn(data, 'morrowCalculatedResultBackground');
  const calculatedResultBackground = data.morrowCalculatedResultBackground;
  const calculatedResultBackgroundProblem = hasCalculatedResultBackground && typeof calculatedResultBackground !== 'boolean'
    ? 'Calculated result background metadata is invalid. The file was left read only.'
    : null;
  const database = kind === 'database' ? normalizeDatabase(data.database) : null;
  const databaseProblem =
    kind === 'database' && data.database !== undefined ? databaseSourceProblem(data.database, database) : null;
  const aliases = (
    Array.isArray(data.aliases) ? data.aliases : typeof data.aliases === 'string' ? [data.aliases] : []
  )
    .filter((alias): alias is string => typeof alias === 'string' && alias.trim().length > 0)
    .map((alias) => alias.trim());
  return {
    title,
    icon,
    cover: validCover(data.cover),
    coverPosition:
      validCover(data.cover) === null
        ? DEFAULT_COVER_POSITION
        : normalizeCoverPosition(data.morrowCoverPosition),
    noteStyle: normalizeNoteStyle(data.morrowNoteStyle),
    calculatedResultBackground:
      typeof calculatedResultBackground === 'boolean' ? calculatedResultBackground : null,
    controls: controls ?? [],
    kind,
    tags: readTags(data.tags ?? data.tag),
    database,
    data,
    extra,
    source: {
      keyOrder: Object.keys(data),
      rawData: split.data,
      rawHead: split.head,
      rawYaml: split.yaml,
      body: split.body,
      aliases,
    },
    body: split.body,
    error:
      split.error ??
      (controls === null ? 'Named control metadata could not be read. The file was left read only.' : null) ??
      calculatedResultBackgroundProblem ??
      (databaseProblem
        ? `Database metadata could not be preserved because ${databaseProblem}. The file was left read only.`
        : null) ??
      (normalizedExtra === null
        ? 'Some frontmatter values exceed safe editing limits. The file was left read only.'
        : null),
  };
}

function databaseSourceProblem(raw: unknown, database: DatabaseDef | null): string | null {
  const validId = (value: unknown): value is string =>
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
  if (!isRecord(raw) || !database) return 'database metadata is not a readable mapping';
  if (raw.properties !== undefined && !Array.isArray(raw.properties)) return 'properties is not a list';
  if (raw.views !== undefined && !Array.isArray(raw.views)) return 'views is not a list';
  if (Array.isArray(raw.properties) && raw.properties.length > 200) return 'properties exceeds the supported limit';
  if (raw.titleAlias !== undefined && typeof raw.titleAlias !== 'string') return 'titleAlias is not text';
  if (
    raw.displayPropertyId !== undefined &&
    raw.displayPropertyId !== null &&
    (!validId(raw.displayPropertyId) || !database.properties.some((prop) => prop.id === raw.displayPropertyId))
  )
    return 'displayPropertyId does not identify a supported property';

  const propertyIds = new Set<string>();
  for (const entry of Array.isArray(raw.properties) ? raw.properties : []) {
    if (!isRecord(entry) || !validId(entry.id)) continue;
    if (propertyIds.has(entry.id)) return 'property IDs are ambiguous';
    propertyIds.add(entry.id);
    const property = database.properties.find((candidate) => candidate.id === entry.id);
    if (!property) continue;
    if (entry.format !== undefined && !isRecord(entry.format)) return 'property format is not a mapping';
    if (isRecord(entry.format)) {
      const normalizedFormat = property.format as Record<string, unknown> | undefined;
      for (const field of FORMAT_FIELDS) {
        if (!Object.hasOwn(entry.format, field)) continue;
        if (
          !normalizedFormat ||
          !Object.hasOwn(normalizedFormat, field) ||
          !sameValue(entry.format[field], normalizedFormat[field])
        )
          return 'a property format field could not be normalized';
      }
    }
    if (entry.type !== 'button' && entry.options !== undefined) {
      if (!Array.isArray(entry.options)) return 'property options is not a list';
      const optionIds = new Set<string>();
      for (const option of entry.options) {
        if (!isRecord(option) || !validId(option.id) || optionIds.has(option.id))
          return 'an option has no unique stable ID';
        optionIds.add(option.id);
      }
      if (optionIds.size !== property.options.length) return 'a property option could not be normalized';
    }
    if (property.type === 'relation' && isRecord(entry.relation)) {
      const problem = identifiedListProblem(
        entry.relation.filters,
        property.relation?.filters ?? [],
        'relation filters',
        validId,
      );
      if (problem) return problem;
    } else if (property.type === 'relation' && entry.relation !== undefined) {
      return 'relation settings are not a mapping';
    }
  }

  const viewIds = new Set<string>();
  for (const entry of Array.isArray(raw.views) ? raw.views : []) {
    if (!isRecord(entry) || !validId(entry.id)) return 'a view has no stable ID';
    if (viewIds.has(entry.id)) return 'view IDs are ambiguous';
    viewIds.add(entry.id);
    const view = database.views.find((candidate) => candidate.id === entry.id);
    if (!view) return 'a view uses an unsupported type or structure';
    const filtersProblem = identifiedListProblem(entry.filters, view.filters, 'view filters', validId);
    if (filtersProblem) return filtersProblem;
    const sortsProblem = sortListProblem(entry.sorts, view.sorts);
    if (sortsProblem) return sortsProblem;
    if (entry.filterGroups !== undefined) {
      if (!Array.isArray(entry.filterGroups) || entry.filterGroups.length > 50)
        return 'filter groups are not a supported list';
      const groupIds = new Set<string>();
      for (const group of entry.filterGroups) {
        if (!isRecord(group) || !validId(group.id) || groupIds.has(group.id))
          return 'a filter group has no unique stable ID';
        groupIds.add(group.id);
        const normalizedGroup = view.filterGroups?.find((candidate) => candidate.id === group.id);
        if (!normalizedGroup) return 'a filter group could not be normalized';
        const problem = identifiedListProblem(
          group.filters,
          normalizedGroup.filters,
          'group filters',
          validId,
        );
        if (problem) return problem;
      }
      if (groupIds.size !== (view.filterGroups?.length ?? 0)) return 'a filter group could not be normalized';
    }
    for (const field of ['hidden', 'order', 'wrap', 'cardProperties'] as const) {
      if (entry[field] !== undefined && (!Array.isArray(entry[field]) || entry[field].some((id) => typeof id !== 'string')))
        return `${field} is not a supported ID list`;
    }
    for (const field of ['widths', 'align', 'summaries'] as const) {
      if (entry[field] !== undefined && !isRecord(entry[field])) return `${field} is not a mapping`;
    }
  }
  return null;
}

function identifiedListProblem<T extends { id: string }>(
  raw: unknown,
  normalized: T[],
  label: string,
  validId: (value: unknown) => value is string,
): string | null {
  if (raw === undefined) return normalized.length === 0 ? null : `${label} source is missing`;
  if (!Array.isArray(raw)) return `${label} is not a list`;
  const normalizedIds = new Set(normalized.map((entry) => entry.id));
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry) || !validId(entry.id) || seen.has(entry.id) || !normalizedIds.has(entry.id))
      return `a ${label} entry could not be normalized by ID`;
    seen.add(entry.id);
  }
  return seen.size === normalizedIds.size ? null : `a ${label} entry could not be normalized by ID`;
}

function sortListProblem(raw: unknown, normalized: DatabaseDef['views'][number]['sorts']): string | null {
  if (raw === undefined) return normalized.length === 0 ? null : 'sort source is missing';
  if (!Array.isArray(raw)) return 'sorts is not a list';
  if (
    raw.length !== normalized.length ||
    raw.some(
      (entry) =>
        !isRecord(entry) ||
        typeof entry.prop !== 'string' ||
        entry.prop.length > 64 ||
        (entry.dir !== undefined && entry.dir !== 'asc' && entry.dir !== 'desc'),
    )
  )
    return 'a sort entry could not be normalized';
  return null;
}

// the title a file implies on its own, so frontmatter only carries a title when it differs
export function impliedTitle(fileBase: string, dailyDate: string | null): string {
  const date = dailyDate ? parseDateKey(dailyDate) : null;
  return date ? dailyTitle(date) : fileBase;
}

export function managedFrontmatter(
  page: PageMeta,
  fileBase: string,
  parentDatabase: DatabaseDef | null,
  state?: WorkspaceState,
): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const title = displayTitle(page);
  if (title !== impliedTitle(fileBase, page.dailyDate)) out.set('title', title);
  if (page.icon && page.kind !== 'canvas') out.set('icon', page.icon);
  if (page.cover && page.kind !== 'canvas') out.set('cover', page.cover);
  if (page.cover && page.kind !== 'canvas' && page.coverPosition !== DEFAULT_COVER_POSITION)
    out.set('morrowCoverPosition', page.coverPosition);
  if (page.noteStyle && page.kind !== 'canvas') out.set('morrowNoteStyle', page.noteStyle);
  if (page.calculatedResultBackground !== null && page.kind !== 'canvas')
    out.set('morrowCalculatedResultBackground', page.calculatedResultBackground);
  if (page.controls.length > 0 && page.kind !== 'canvas') out.set('morrowControls', page.controls);
  if (FILE_KINDS.has(page.kind)) out.set('kind', page.kind);
  if (page.tags.length > 0) out.set('tags', [...page.tags]);
  for (const prop of parentDatabase?.properties ?? []) {
    const value = writeProperty(prop, page.properties[prop.id], state);
    if (value !== undefined) out.set(prop.name, value);
  }
  if (page.kind === 'database' && page.database) out.set('database', databaseToYaml(page.database));
  return out;
}

// keeps the order and unknown keys of the existing frontmatter, adds new keys at the end
export function composeFrontmatter(
  managed: Map<string, unknown>,
  extra: Record<string, unknown>,
  source: PageSource | null,
): Record<string, unknown> {
  const keyOrder = source?.keyOrder ?? [];
  // morrow's own values win over other keys of the same name
  const values = new Map<string, unknown>(managed);
  if (source?.rawData && values.has('database'))
    values.set('database', preserveDatabaseYaml(values.get('database'), source.rawData.database));
  for (const [key, value] of Object.entries(extra)) if (!values.has(key)) values.set(key, value);
  // a key keeps the spelling its file already uses, so date stays date rather than turning into Date
  const spellings = new Map<string, string>();
  for (const key of keyOrder) if (!spellings.has(key.toLowerCase())) spellings.set(key.toLowerCase(), key);
  const named = new Map<string, unknown>();
  for (const [key, value] of values) {
    const existing = keyOrder.includes(key) ? key : spellings.get(key.toLowerCase());
    const spelling = existing && (existing === key || !values.has(existing)) ? existing : key;
    named.set(named.has(spelling) ? key : spelling, value);
  }
  const out: Record<string, unknown> = {};
  for (const key of keyOrder)
    if (named.has(key))
      Object.defineProperty(out, key, {
        value: named.get(key),
        enumerable: true,
        writable: true,
        configurable: true,
      });
  for (const [key, value] of named)
    if (!Object.hasOwn(out, key))
      Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  return out;
}

export function renderPageText(
  frontmatter: Record<string, unknown>,
  source: PageSource | null,
  body: string,
): string {
  if (source?.rawData && source.rawHead && sameValue(frontmatter, source.rawData))
    return source.rawHead + body;
  if (source?.rawData && source.rawHead) {
    const updated = updateFrontmatter(source.rawYaml, source.rawData, frontmatter, body);
    if (updated !== null) return updated;
  }
  return joinFrontmatter(frontmatter, body);
}

export function writeProperty(prop: PropDef, value: PropValue | undefined, state?: WorkspaceState): unknown {
  if (value === null || value === undefined) return undefined;
  if (isComputedProperty(prop)) return undefined;
  switch (prop.type) {
    case 'number':
    case 'currency':
    case 'percent':
    case 'slider':
    case 'progress':
    case 'scale':
    case 'duration':
      return typeof value === 'number' ? value : undefined;
    case 'checkbox':
      return typeof value === 'boolean' ? value : undefined;
    case 'select': {
      const option = prop.options.find((candidate) => candidate.id === value);
      return option?.name;
    }
    case 'formula':
      return undefined;
    case 'relation': {
      if (prop.relation?.isInverse) return undefined;
      const targets = relationIds(value);
      if (prop.relation?.targetDatabaseId) {
        const refs = targets.map((id) => {
          const target = state?.pages[id];
          return {
            id,
            title: target && state ? relationDisplayLabel(state, prop, target) : id,
          };
        });
        return refs.length === 0 ? undefined : prop.relation.multiple || refs.length > 1 ? refs : refs[0];
      }
      // links in the frontmatter, the way obsidian writes them, so legacy references stay readable
      const legacy = (Array.isArray(value) ? value : [String(value)]).filter(Boolean);
      return legacy.length ? legacy.map((target) => `[[${target}]]`) : undefined;
    }
    case 'multiSelect': {
      const names = (Array.isArray(value) ? value : [])
        .map((id) => prop.options.find((option) => option.id === id)?.name)
        .filter((name): name is string => typeof name === 'string');
      return names.length > 0 ? names : undefined;
    }
    default:
      return typeof value === 'string' ? value : String(value);
  }
}

// reads a frontmatter value as the property's type, adding select options it has not seen yet
export function readProperty(
  prop: PropDef,
  raw: unknown,
  newOptionId: () => string,
): { value: PropValue; added: SelectOption[] } {
  const added: SelectOption[] = [];
  const optionFor = (name: string): string => {
    const known = [...prop.options, ...added].find(
      (option) => option.name.toLowerCase() === name.toLowerCase(),
    );
    if (known) return known.id;
    const option: SelectOption = {
      id: newOptionId(),
      name: name.slice(0, 200),
      color: COLORS[(prop.options.length + added.length) % COLORS.length]!,
    };
    added.push(option);
    return option.id;
  };
  switch (prop.type) {
    case 'number':
    case 'currency':
    case 'percent':
    case 'slider':
    case 'progress':
    case 'scale':
    case 'duration': {
      let value =
        typeof raw === 'number' ? raw : typeof raw === 'string' ? (localizedNumber(prop, raw) ?? NaN) : NaN;
      if (prop.type === 'percent' && typeof raw === 'string' && raw.trim().endsWith('%')) value /= 100;
      if (prop.type === 'duration' && typeof raw === 'string') {
        const unit = durationUnitFromText(raw);
        if (unit) value *= durationUnitFactor(unit);
      }
      return {
        value: Number.isFinite(value) && raw !== '' && scalarValueError(prop, value) === null ? value : null,
        added,
      };
    }
    case 'checkbox': {
      if (typeof raw === 'boolean') return { value: raw, added };
      const text = typeof raw === 'string' ? raw.trim() : '';
      if (/^(true|yes|x|1)$/i.test(text)) return { value: true, added };
      if (/^(false|no|0)$/i.test(text)) return { value: false, added };
      return {
        value: null,
        added,
      };
    }
    case 'select': {
      const name = scalarText(Array.isArray(raw) ? raw[0] : raw);
      return { value: name ? optionFor(name) : null, added };
    }
    case 'multiSelect': {
      const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
      const ids = list
        .map(scalarText)
        .filter((name): name is string => !!name)
        .map(optionFor);
      return { value: ids.length ? [...new Set(ids)] : null, added };
    }
    case 'formula':
      return { value: null, added };
    case 'relation': {
      const list = Array.isArray(raw)
        ? raw
        : isRecord(raw)
          ? [raw]
          : typeof raw === 'string'
            ? raw.split(/,(?![^[]*\]\])/)
            : [];
      if (list.length > 500) return { value: null, added };
      const targets: string[] = [];
      for (const item of list) {
        if (isRecord(item)) {
          if (
            typeof item.id !== 'string' ||
            !item.id.trim() ||
            (item.title !== undefined && typeof item.title !== 'string') ||
            Object.keys(item).some((key) => key !== 'id' && key !== 'title')
          )
            return { value: null, added };
          targets.push(item.id.trim());
          continue;
        }
        const text = scalarText(item);
        if (text === null) return { value: null, added };
        const target = text
          .replace(/^\[\[|\]\]$/g, '')
          .split('|')[0]!
          .trim();
        if (target) targets.push(target);
        else if (list.length > 1) return { value: null, added };
      }
      const unique = [...new Set(targets)];
      if (unique.length === 0) return { value: null, added };
      if (prop.relation?.multiple) return { value: unique, added };
      return { value: unique.length === 1 ? unique[0]! : unique, added };
    }
    case 'date': {
      const text = raw instanceof Date ? raw.toISOString() : scalarText(raw);
      const key = text?.slice(0, 10) ?? '';
      return { value: isValidDateKey(key) ? key : null, added };
    }
    case 'time': {
      const text = scalarText(raw) ?? '';
      return { value: isValidTime(text) ? text : null, added };
    }
    case 'datetime': {
      const text = raw instanceof Date ? raw.toISOString() : (scalarText(raw) ?? '');
      return { value: isValidDateTime(text) ? new Date(text).toISOString() : null, added };
    }
    case 'createdTime':
    case 'lastEditedTime':
      return { value: null, added };
    default: {
      const text = scalarText(raw);
      if (text === null) return { value: null, added };
      return { value: scalarValueError(prop, text) === null ? text : null, added };
    }
  }
}

// moves a row's values for the database's properties out of its other frontmatter, matching names the way
// obsidian does, without caring about case. adds the select options it meets to the properties it is given
export function takeProperties(
  database: DatabaseDef,
  extra: Record<string, unknown>,
  properties: Record<string, PropValue>,
  newOptionId: () => string,
): void {
  for (const prop of database.properties) {
    if (isComputedProperty(prop) || (prop.type === 'relation' && prop.relation?.isInverse)) continue;
    const key = findKey(extra, prop.name);
    if (key === undefined) continue;
    const raw = extra[key];
    const read = readProperty(prop, raw, newOptionId);
    if (read.added.length) prop.options.push(...read.added);
    if (read.value !== null) properties[prop.id] = read.value;
    // a value the property can not hold, like a date written in words, stays so saving never drops it
    if (
      read.value !== null ||
      raw === null ||
      raw === '' ||
      (prop.type === 'relation' && Array.isArray(raw) && raw.length === 0)
    )
      delete extra[key];
  }
}

function scalarText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function localizedNumber(prop: PropDef, raw: string): number | null {
  const currency = prop.type === 'currency' ? (prop.format?.currency ?? 'BRL') : undefined;
  const locale =
    prop.format?.locale ??
    (/^\s*R\$/i.test(raw) || (prop.type === 'currency' && currency === 'BRL') ? 'pt-BR' : 'en-US');
  return parseLocalizedNumber(raw, locale, currency, prop.type === 'duration');
}

function databaseToYaml(database: DatabaseDef): Record<string, unknown> {
  return {
    ...(database.titleAlias?.trim() ? { titleAlias: database.titleAlias.trim() } : {}),
    ...(database.displayPropertyId ? { displayPropertyId: database.displayPropertyId } : {}),
    properties: [
      ...database.properties.map((prop) => ({
        id: prop.id,
        name: prop.name,
        type: prop.type,
        ...(prop.options.length ? { options: prop.options.map((option) => ({ ...option })) } : {}),
        ...(prop.description ? { description: prop.description } : {}),
        ...(prop.icon ? { icon: prop.icon } : {}),
        ...(prop.formulaResultType ? { formulaResultType: prop.formulaResultType } : {}),
        ...(prop.format ? { format: { ...prop.format } } : {}),
        ...(prop.fillMode ? { fillMode: prop.fillMode } : {}),
        ...(Object.prototype.hasOwnProperty.call(prop, 'defaultValue')
          ? { defaultValue: prop.defaultValue }
          : {}),
        ...(prop.defaultFormula ? { defaultFormula: prop.defaultFormula } : {}),
        ...(prop.defaultSequence ? { defaultSequence: { ...prop.defaultSequence } } : {}),
        ...(prop.sequenceNext !== undefined ? { sequenceNext: prop.sequenceNext } : {}),
        ...(prop.defaultFormulaBindings?.length ? { defaultFormulaBindings: prop.defaultFormulaBindings.map((binding) => ({ ...binding })) } : {}),
        ...(prop.formula ? { formula: prop.formula } : {}),
        ...(prop.formulaBindings?.length ? { formulaBindings: prop.formulaBindings.map((binding) => ({ ...binding })) } : {}),
        ...(prop.display === 'bar' ? { display: 'bar' } : {}),
        ...(prop.display === 'bar' && prop.max && prop.max !== 100 ? { max: prop.max } : {}),
        ...(prop.type === 'relation' && prop.relation
          ? {
              relation: {
                targetDatabaseId: prop.relation.targetDatabaseId,
                multiple: prop.relation.multiple,
                isInverse: prop.relation.isInverse,
                displayPropertyId: prop.relation.displayPropertyId,
                inversePropertyId: prop.relation.inversePropertyId,
                ...(prop.relation.filters.length
                  ? { filters: prop.relation.filters.map((filter) => ({ ...filter })) }
                  : {}),
              },
            }
          : {}),
        ...(prop.type === 'button' && prop.action ? { action: prop.action } : {}),
        ...((prop.type === 'image' || prop.type === 'file') && prop.media ? { media: { ...prop.media } } : {}),
      })),
      ...(database.unsupportedProperties ?? []),
    ],
    views: database.views.map((view) => ({
      id: view.id,
      name: view.name,
      type: view.type,
      ...(view.filters.length ? { filters: view.filters.map((filter) => ({ ...filter })) } : {}),
      ...(view.filterGroups?.length
        ? {
            filterGroups: view.filterGroups.map((group) => ({
              id: group.id,
              logic: group.logic,
              filters: group.filters.map((filter) => ({ ...filter })),
            })),
          }
        : {}),
      ...(view.filterGroupLogic ? { filterGroupLogic: view.filterGroupLogic } : {}),
      ...(view.sorts.length ? { sorts: view.sorts.map((sort) => ({ ...sort })) } : {}),
      ...(view.groupBy ? { groupBy: view.groupBy } : {}),
      ...(view.dateProp ? { dateProp: view.dateProp } : {}),
      ...(view.hidden.length ? { hidden: [...view.hidden] } : {}),
      ...(view.widths && Object.keys(view.widths).length ? { widths: { ...view.widths } } : {}),
      ...(view.frozenThrough ? { frozenThrough: view.frozenThrough } : {}),
      ...(view.rowHeight ? { rowHeight: view.rowHeight } : {}),
      ...(view.hideTitle ? { hideTitle: true } : {}),
      ...(view.collapsed ? { collapsed: true } : {}),
      ...(view.collapseEnabled === false ? { collapseEnabled: false } : {}),
      ...(view.search ? { search: view.search } : {}),
      ...(view.order?.length ? { order: [...view.order] } : {}),
      ...(view.wrap?.length ? { wrap: [...view.wrap] } : {}),
      ...(view.align && Object.keys(view.align).length ? { align: { ...view.align } } : {}),
      ...(view.summaries && Object.keys(view.summaries).length ? { summaries: { ...view.summaries } } : {}),
      ...(view.conditionalFormats?.length || view.unsupportedConditionalFormats?.length
        ? { conditionalFormats: serializeConditionalFormats(view.conditionalFormats, view.unsupportedConditionalFormats) }
        : {}),
      ...(view.cardProperties?.length ? { cardProperties: [...view.cardProperties] } : {}),
      ...(view.cardImageProp !== undefined ? { cardImageProp: view.cardImageProp } : {}),
    })),
  };
}

function uniqueRecordsById(raw: unknown): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  const duplicates = new Set<string>();
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!isRecord(entry) || typeof entry.id !== 'string') continue;
    if (result.has(entry.id)) duplicates.add(entry.id);
    else result.set(entry.id, entry);
  }
  for (const id of duplicates) result.delete(id);
  return result;
}

function mergeUnknownFields<T extends Record<string, unknown>>(
  canonical: T,
  raw: unknown,
  knownFields: ReadonlySet<string>,
): T {
  if (!isRecord(raw)) return canonical;
  const merged = { ...canonical } as T;
  for (const [key, value] of Object.entries(raw)) {
    if (knownFields.has(key) || Object.hasOwn(canonical, key)) continue;
    Object.defineProperty(merged, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return merged;
}

function preserveDatabaseYaml(canonical: unknown, raw: unknown): unknown {
  if (!isRecord(canonical) || !isRecord(raw)) return canonical;
  const rawProperties = uniqueRecordsById(raw.properties);
  const rawViews = uniqueRecordsById(raw.views);
  const preserved = mergeUnknownFields({ ...canonical }, raw, DATABASE_FIELDS);
  if (Array.isArray(canonical.properties))
    preserved.properties = canonical.properties.map((entry) =>
      isRecord(entry) ? preservePropertyYaml(entry, rawProperties.get(String(entry.id))) : entry,
    );
  if (Array.isArray(canonical.views))
    preserved.views = canonical.views.map((entry) =>
      isRecord(entry) ? preserveViewYaml(entry, rawViews.get(String(entry.id))) : entry,
    );
  return preserved;
}

function preservePropertyYaml(canonical: Record<string, unknown>, raw: Record<string, unknown> | undefined) {
  const preserved = mergeUnknownFields({ ...canonical }, raw, PROPERTY_FIELDS);
  if (isRecord(canonical.format))
    preserved.format = mergeUnknownFields({ ...canonical.format }, raw?.format, FORMAT_FIELDS);
  else if (isRecord(raw?.format)) {
    const unknownFormat = mergeUnknownFields({}, raw.format, FORMAT_FIELDS);
    if (Object.keys(unknownFormat).length) preserved.format = unknownFormat;
  }
  if (Array.isArray(canonical.options)) {
    const rawOptions = uniqueRecordsById(raw?.options);
    preserved.options = canonical.options.map((entry) =>
      isRecord(entry) ? mergeUnknownFields({ ...entry }, rawOptions.get(String(entry.id)), OPTION_FIELDS) : entry,
    );
  }
  if (isRecord(canonical.defaultSequence))
    preserved.defaultSequence = mergeUnknownFields(
      { ...canonical.defaultSequence },
      raw?.defaultSequence,
      new Set(['start', 'increment']),
    );
  if (isRecord(canonical.media))
    preserved.media = mergeUnknownFields({ ...canonical.media }, raw?.media, new Set(['multiple']));
  if (isRecord(canonical.action)) preserved.action = preserveActionYaml(canonical.action, raw?.action);
  if (isRecord(canonical.relation) && isRecord(raw?.relation)) {
    const relation = mergeUnknownFields({ ...canonical.relation }, raw.relation, RELATION_FIELDS);
    if (Array.isArray(canonical.relation.filters)) {
      const rawFilters = uniqueRecordsById(raw.relation.filters);
      relation.filters = canonical.relation.filters.map((entry) =>
        isRecord(entry) ? preserveFilterYaml(entry, rawFilters.get(String(entry.id))) : entry,
      );
    }
    preserved.relation = relation;
  }
  for (const field of ['formulaBindings', 'defaultFormulaBindings'] as const) {
    const bindings = preserveUnidentifiedList(canonical[field], raw?.[field], BINDING_FIELDS, 'formula binding');
    if (bindings.length) preserved[field] = bindings;
  }
  return preserved;
}

function preserveActionYaml(canonical: Record<string, unknown>, raw: unknown) {
  const preserved = mergeUnknownFields({ ...canonical }, raw, ACTION_FIELDS);
  if (!isRecord(raw)) return preserved;
  if (isRecord(canonical.disabled))
    preserved.disabled = preserveActionFormulaYaml(canonical.disabled, raw.disabled);
  if (Array.isArray(canonical.steps)) {
    const rawSteps = uniqueRecordsById(raw.steps);
    preserved.steps = canonical.steps.map((entry) => {
      if (!isRecord(entry)) return entry;
      const original = rawSteps.get(String(entry.id));
      const fields = entry.type === 'addRows'
        ? new Set(['id', 'type', 'count', 'title', 'values'])
        : entry.type === 'modifyRows'
          ? new Set(['id', 'type', 'target', 'where', 'values'])
          : new Set(['id', 'type', 'controlIds']);
      const step = mergeUnknownFields({ ...entry }, original, fields);
      for (const field of ['count', 'title', 'where'] as const) {
        if (isRecord(entry[field])) step[field] = preserveActionFormulaYaml(entry[field], original?.[field]);
      }
      if (isRecord(entry.values) && isRecord(original?.values)) {
        const values: Record<string, unknown> = { ...entry.values };
        for (const [propertyId, formula] of Object.entries(entry.values)) {
          if (isRecord(formula))
            values[propertyId] = preserveActionFormulaYaml(formula, original.values[propertyId]);
        }
        step.values = values;
      }
      return step;
    });
  }
  return preserved;
}

function preserveActionFormulaYaml(canonical: Record<string, unknown>, raw: unknown) {
  const preserved = mergeUnknownFields({ ...canonical }, raw, ACTION_FORMULA_FIELDS);
  const rawBindings = isRecord(raw) ? raw.bindings : undefined;
  const bindings = preserveUnidentifiedList(canonical.bindings, rawBindings, BINDING_FIELDS, 'formula binding');
  preserved.bindings = bindings;
  return preserved;
}

function preserveViewYaml(canonical: Record<string, unknown>, raw: Record<string, unknown> | undefined) {
  const preserved = mergeUnknownFields({ ...canonical }, raw, VIEW_FIELDS);
  if (Array.isArray(canonical.filters)) {
    const rawFilters = uniqueRecordsById(raw?.filters);
    preserved.filters = canonical.filters.map((entry) =>
      isRecord(entry) ? preserveFilterYaml(entry, rawFilters.get(String(entry.id))) : entry,
    );
  }
  if (Array.isArray(canonical.filterGroups)) {
    const rawGroups = uniqueRecordsById(raw?.filterGroups);
    preserved.filterGroups = canonical.filterGroups.map((entry) => {
      if (!isRecord(entry)) return entry;
      const rawGroup = rawGroups.get(String(entry.id));
      const group = mergeUnknownFields({ ...entry }, rawGroup, FILTER_GROUP_FIELDS);
      if (Array.isArray(entry.filters)) {
        const rawFilters = uniqueRecordsById(rawGroup?.filters);
        group.filters = entry.filters.map((filter) =>
          isRecord(filter) ? preserveFilterYaml(filter, rawFilters.get(String(filter.id))) : filter,
        );
      }
      return group;
    });
  }
  const sorts = serializeSortRecords(canonical.sorts, raw?.sorts);
  if (sorts.length) preserved.sorts = sorts;
  return preserved;
}

function preserveFilterYaml(canonical: Record<string, unknown>, raw: Record<string, unknown> | undefined) {
  const preserved = mergeUnknownFields({ ...canonical }, raw, FILTER_FIELDS);
  if (isRecord(canonical.controlRef))
    preserved.controlRef = mergeUnknownFields(
      { ...canonical.controlRef },
      raw?.controlRef,
      new Set(['pageId', 'controlId']),
    );
  const bindings = preserveUnidentifiedList(
    canonical.formulaBindings,
    raw?.formulaBindings,
    BINDING_FIELDS,
    'formula binding',
  );
  if (bindings.length) preserved.formulaBindings = bindings;
  return preserved;
}

const BINDING_FIELDS = new Set([
  'start', 'end', 'source', 'kind', 'databaseId', 'propertyId', 'pageId', 'controlId', 'resultId',
]);

function preserveUnidentifiedList(
  canonical: unknown,
  raw: unknown,
  knownFields: ReadonlySet<string>,
  label: string,
): unknown[] {
  const current = Array.isArray(canonical) ? canonical : [];
  if (!Array.isArray(raw)) return current;
  const hasUnknownFields = raw.some(
    (entry) => isRecord(entry) && Object.keys(entry).some((key) => !knownFields.has(key)),
  );
  if (!hasUnknownFields) return current;
  const projection = raw.map((entry) => {
    if (!isRecord(entry)) return entry;
    return Object.fromEntries(Object.entries(entry).filter(([key]) => knownFields.has(key)));
  });
  if (!sameValue(projection, current))
    throw new Error(`This database has ${label} fields this version cannot safely rewrite. The source was left unchanged.`);
  return raw;
}

function serializeSortRecords(canonical: unknown, raw: unknown): Array<Record<string, unknown>> {
  const current = Array.isArray(canonical)
    ? canonical.filter(isRecord).map((entry) => ({ prop: entry.prop, dir: entry.dir as 'asc' | 'desc' }))
    : [];
  if (!Array.isArray(raw)) return current;
  const hasUnknownFields = raw.some(
    (entry) => isRecord(entry) && Object.keys(entry).some((key) => !SORT_FIELDS.has(key)),
  );
  if (!hasUnknownFields) return current;
  const sameKnownEntries = raw.length === current.length && raw.every(
    (entry, index) =>
      isRecord(entry) &&
      entry.prop === current[index]?.prop &&
      (entry.dir === 'desc' ? 'desc' : 'asc') === current[index]?.dir,
  );
  if (!sameKnownEntries)
    throw new Error('This database has sort fields this version cannot safely rewrite. The source was left unchanged.');
  return raw as Array<Record<string, unknown>>;
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]))
    );
  }
  return false;
}
