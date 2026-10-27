// how one page maps to its markdown file: frontmatter for metadata, the body for content
import { dailyTitle, parseDateKey } from '../daily';
import { isRecord } from '../doc';
import { normalizeDatabase } from '../migrations';
import { normalizeNamedControls } from '../controls';
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
    controls: controls ?? [],
    kind,
    tags: readTags(data.tags ?? data.tag),
    database: kind === 'database' ? normalizeDatabase(data.database) : null,
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
      (normalizedExtra === null
        ? 'Some frontmatter values exceed safe editing limits. The file was left read only.'
        : null),
  };
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
    properties: [
      ...database.properties.map((prop) => ({
        id: prop.id,
        name: prop.name,
        type: prop.type,
        ...(prop.options.length ? { options: prop.options.map((option) => ({ ...option })) } : {}),
        ...(prop.description ? { description: prop.description } : {}),
        ...(prop.format ? { format: { ...prop.format } } : {}),
        ...(prop.fillMode ? { fillMode: prop.fillMode } : {}),
        ...(Object.prototype.hasOwnProperty.call(prop, 'defaultValue')
          ? { defaultValue: prop.defaultValue }
          : {}),
        ...(prop.defaultFormula ? { defaultFormula: prop.defaultFormula } : {}),
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
      })),
      ...(database.unsupportedProperties ?? []),
    ],
    views: database.views.map((view) => ({
      id: view.id,
      name: view.name,
      type: view.type,
      ...(view.filters.length ? { filters: view.filters.map((filter) => ({ ...filter })) } : {}),
      ...(view.sorts.length ? { sorts: view.sorts.map((sort) => ({ ...sort })) } : {}),
      ...(view.groupBy ? { groupBy: view.groupBy } : {}),
      ...(view.dateProp ? { dateProp: view.dateProp } : {}),
      ...(view.hidden.length ? { hidden: [...view.hidden] } : {}),
      ...(view.widths && Object.keys(view.widths).length ? { widths: { ...view.widths } } : {}),
    })),
  };
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
