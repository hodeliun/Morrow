// Detect Markdown data the upstream model cannot represent before pageFile normalizes it.
import MarkdownIt from 'markdown-it';
import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { isRecord, validateDoc, walk } from '../doc';
import {
  inspectBlockBackgroundMarkers,
  markdownToDoc,
  markdownToDocWithDetailsHtmlBlocks,
  parseToggleSummaryInline,
} from '../markdown/parse';
import type { ParsedDetailsHtmlBlock } from '../markdown/parse';
import { supportsHexBlockBackgroundOwner } from '../markdown/blockBackground';
import {
  inspectToggleMarkup,
  isSupportedDetailsTag,
  isSupportedSummaryTag,
  toggleExtensionAttributeNames,
} from '../markdown/toggleSummary';
import type { DocNode } from '../model';
import {
  countLegacyFormulaNodes,
  LEGACY_FORMULA_NODE,
  legacyFormulaDocIssue,
  legacyFormulaInlineRule,
} from '../legacyFormula';
import {
  COLORS,
  MAX_DOC_DEPTH,
  MAX_ICON_LENGTH,
  MAX_TITLE_LENGTH,
  normalizeDatabasePropertyFormat,
  PROP_TYPES,
  validCover,
  VIEW_TYPES,
  WIDGET_KINDS,
} from '../model';
import { decodePolarisDadosViewMarker } from '../polarisDadosView';
import { parseColumnLayoutTag, parseHtmlTag, parseLegacyColumnWidths } from '../columnWidths';
import {
  isUnambiguousFrontmatter,
  MANAGED_KEYS,
  normalizeExtra,
  readTags,
  splitFrontmatter,
} from './frontmatter';

const markerMarkdown = new MarkdownIt('commonmark', { html: true }).enable(['table', 'strikethrough']);
markerMarkdown.inline.ruler.before('html_inline', LEGACY_FORMULA_NODE, legacyFormulaInlineRule);

const PAGE_KINDS = new Set(['page', 'journal', 'templates', 'database']);
const FILTER_OPS = new Set([
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
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PROPERTY_KEYS = new Set([
  'id',
  'name',
  'type',
  'options',
  'format',
  'formula',
  'formulaResultType',
  'display',
  'max',
  'wrap',
]);
const OPTION_KEYS = new Set(['id', 'name', 'color']);
const VIEW_KEYS = new Set([
  'id',
  'name',
  'type',
  'filters',
  'sorts',
  'groupBy',
  'dateProp',
  'hidden',
  'widths',
  'columns',
  'groupOrder',
  'hiddenGroups',
  'collapsedGroups',
  'hideEmptyGroups',
  'limit',
  'widgets',
]);
const WIDGET_KEYS = new Set(['id', 'kind', 'prop', 'title', 'wide']);
const FILTER_KEYS = new Set(['id', 'prop', 'op', 'value']);
const SORT_KEYS = new Set(['prop', 'dir']);
const REGISTRY_ENTRY_KEYS = new Set([
  'id',
  'created',
  'order',
  'favorite',
  'archived',
  'hideTasks',
  'trashed',
  'parent',
  'icon',
]);
const REGISTRY_KEYS = new Set(['version', 'pages']);
const RECENT_KEYS = new Set(['version', 'opened', 'activity']);
const MAX_RECENT = 300;
const MAX_ACTIVITY_DAYS = 400;

export interface PageContentSafetyOptions {
  /** Reports local files which Markdown parsing would promote out of their paragraph. */
  resolveAttachmentHref?: (href: string) => boolean;
}

/**
 * Returns a readable reason when saving this Markdown through the upstream model
 * could drop or change data. This must run on the file text before readPageText.
 */
export function findUnrepresentablePageContent(
  text: string,
  options: PageContentSafetyOptions = {},
): string | null {
  const split = splitFrontmatter(text);
  if (split.error) return null; // The normal loader already protects malformed YAML.

  const data = split.data;
  if (data) {
    const metadataIssue = pageMetadataIssue(data);
    if (metadataIssue) return metadataIssue;
    const typedFormulaFrontmatterIssue = typedFormulaResultFrontmatterIssue(split.yaml, data);
    if (typedFormulaFrontmatterIssue) return typedFormulaFrontmatterIssue;
    const extraIssue = unknownFrontmatterIssue(data);
    if (extraIssue) return extraIssue;
  }

  const explicitTitle = typeof data?.title === 'string' && data.title.trim().length > 0;
  return unsupportedMarkerIssue(split.body, explicitTitle, options);
}

export function hasUnrepresentableDatabaseSchema(text: string): boolean {
  const split = splitFrontmatter(text);
  const data = split.data;
  if (!data || data.kind !== 'database') return false;
  if (typedFormulaResultFrontmatterIssue(split.yaml, data)) return true;
  return databaseMetadataIssue(data) !== null;
}

function typedFormulaResultFrontmatterIssue(yaml: string, data: Record<string, unknown>): string | null {
  // A conflicting kind/database pair is already rejected by databaseMetadataIssue above.
  if (data.kind !== 'database') return null;
  const database = data.database;
  const effectiveDeclaration =
    isRecord(database) &&
    Array.isArray(database.properties) &&
    database.properties.some(isTypedFormulaResultProperty);
  const yamlInspection = inspectTypedFormulaResultYaml(yaml, effectiveDeclaration);
  const declaresTypedFormula = effectiveDeclaration || yamlInspection.declaresTypedFormula;
  if (
    !declaresTypedFormula ||
    (!yamlInspection.hasResolvedKeyCollision && isUnambiguousFrontmatter(yaml, data))
  ) {
    return null;
  }
  return 'The Polaris Dados typed formula result schema has ambiguous YAML frontmatter.';
}

function isTypedFormulaResultProperty(property: unknown): boolean {
  return (
    isRecord(property) &&
    property.type === 'formula' &&
    (property.formulaResultType === 'number' ||
      property.formulaResultType === 'percent' ||
      property.formulaResultType === 'currency')
  );
}

interface TypedFormulaYamlInspection {
  readonly declaresTypedFormula: boolean;
  readonly hasResolvedKeyCollision: boolean;
}

/** Checks every YAML mapping occurrence so an overwritten database/property cannot hide a typed declaration. */
function inspectTypedFormulaResultYaml(yaml: string, effectiveDeclaration: boolean): TypedFormulaYamlInspection {
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(yaml, { uniqueKeys: false });
  } catch {
    return { declaresTypedFormula: false, hasResolvedKeyCollision: false };
  }
  if (document.errors.length > 0) return { declaresTypedFormula: false, hasResolvedKeyCollision: false };

  let declaresTypedFormula = false;
  for (const database of yamlValuesForKey(document.contents, 'database', document)) {
    for (const properties of yamlValuesForKey(database, 'properties', document)) {
      if (!isSeq(properties)) continue;
      for (const property of properties.items) {
        const hasFormulaType = yamlValuesForKey(property, 'type', document).some(
          (value) => isYamlString(value, 'formula', document),
        );
        if (!hasFormulaType) continue;
        const hasTypedResult = yamlValuesForKey(property, 'formulaResultType', document).some(
          (value) =>
            isYamlString(value, 'number', document) ||
            isYamlString(value, 'percent', document) ||
            isYamlString(value, 'currency', document),
        );
        if (hasTypedResult) declaresTypedFormula = true;
      }
    }
  }
  return {
    declaresTypedFormula,
    hasResolvedKeyCollision:
      (effectiveDeclaration || declaresTypedFormula) && hasResolvedYamlKeyCollision(document.contents, document),
  };
}

function yamlValuesForKey(
  node: unknown,
  key: string,
  document: ReturnType<typeof parseDocument>,
): unknown[] {
  const pending = [node];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const resolved = resolveYamlAlias(pending.pop(), document);
    if (!isMap(resolved) || visited.has(resolved)) continue;
    visited.add(resolved);
    const direct: unknown[] = [];
    const mergeSources: unknown[] = [];
    for (const pair of resolved.items) {
      if (isYamlString(pair.key, key, document)) direct.push(resolveYamlAlias(pair.value, document));
      else if (isYamlMergeKey(pair.key)) mergeSources.push(pair.value);
    }
    if (direct.length > 0) return direct;

    // YAML merges supply only keys absent from the destination; earlier sequence maps win.
    for (let sourceIndex = mergeSources.length - 1; sourceIndex >= 0; sourceIndex -= 1) {
      const mergeSource = mergeSources[sourceIndex];
      const source = resolveYamlAlias(mergeSource, document);
      if (isSeq(source)) {
        for (let itemIndex = source.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
          pending.push(source.items[itemIndex]);
        }
      } else {
        pending.push(source);
      }
    }
  }
  return [];
}

function isYamlString(node: unknown, value: string, document: ReturnType<typeof parseDocument>): boolean {
  const resolved = resolveYamlAlias(node, document);
  return isScalar(resolved) && typeof resolved.value === 'string' && resolved.value === value;
}

function isYamlMergeKey(node: unknown): boolean {
  return isScalar(node) && node.tag === 'tag:yaml.org,2002:merge';
}

/** Detects scalar/alias key collisions that the parser's unique-key check does not report. */
function hasResolvedYamlKeyCollision(
  node: unknown,
  document: ReturnType<typeof parseDocument>,
): boolean {
  type Context = 'direct' | 'merge';
  const pending: { node: unknown; context: Context }[] = [{ node, context: 'direct' }];
  const visitedDirect = new WeakSet<object>();
  const visitedMerge = new WeakSet<object>();
  while (pending.length > 0) {
    const visit = pending.pop()!;
    const resolved = resolveYamlAlias(visit.node, document);
    if (!isMap(resolved) && !isSeq(resolved)) continue;
    const visited = visit.context === 'merge' ? visitedMerge : visitedDirect;
    if (visited.has(resolved)) continue;
    visited.add(resolved);

    if (isSeq(resolved)) {
      for (const item of resolved.items) pending.push({ node: item, context: visit.context });
      continue;
    }

    const keys = new Set<string | symbol>();
    for (const pair of resolved.items) {
      if (isYamlMergeKey(pair.key)) {
        pending.push({ node: pair.value, context: 'merge' });
        continue;
      }
      const key = resolvedYamlScalarKey(pair.key, document, visit.context);
      if (key !== undefined) {
        if (keys.has(key)) return true;
        keys.add(key);
      }
      pending.push({ node: pair.value, context: 'direct' });
    }
  }
  return false;
}

function resolvedYamlScalarKey(
  node: unknown,
  document: ReturnType<typeof parseDocument>,
  context: 'direct' | 'merge',
): string | symbol | undefined {
  const resolved = resolveYamlAlias(node, document);
  if (!isScalar(resolved)) return undefined;
  const value = resolved.value;
  if (value === null) return context === 'merge' ? 'null' : '';
  if (typeof value === 'symbol') return context === 'merge' ? value : String(value);
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'undefined'
  ) {
    return String(value);
  }
  return undefined;
}

function resolveYamlAlias(node: unknown, document: ReturnType<typeof parseDocument>): unknown {
  if (!isAlias(node)) return node;
  try {
    return node.resolve(document);
  } catch {
    return undefined;
  }
}

/** The readers for these files keep only the fields listed below. */
export function findUnrepresentableVaultMetadata(raw: unknown, kind: 'workspace' | 'recent'): string | null {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) return `The Morrow ${kind} metadata is not a supported object.`;

  if (kind === 'workspace') {
    if (
      unknownKey(raw, REGISTRY_KEYS) ||
      (raw.version !== undefined && raw.version !== 1) ||
      !isRecord(raw.pages)
    ) {
      return 'The Morrow workspace registry has fields this version cannot preserve.';
    }
    const seen = new Set<string>();
    for (const entry of Object.values(raw.pages)) {
      if (!isRecord(entry) || unknownKey(entry, REGISTRY_ENTRY_KEYS)) {
        return 'The Morrow workspace registry contains an unsupported page record.';
      }
      if (typeof entry.id !== 'string' || !ID.test(entry.id) || seen.has(entry.id)) {
        return 'The Morrow workspace registry contains an unsupported or duplicate page ID.';
      }
      seen.add(entry.id);
      for (const field of ['created', 'order', 'archived', 'trashed'] as const) {
        if (
          entry[field] !== undefined &&
          (typeof entry[field] !== 'number' || !Number.isFinite(entry[field]))
        ) {
          return 'The Morrow workspace registry contains a number this version cannot preserve.';
        }
      }
      for (const field of ['favorite', 'hideTasks'] as const) {
        if (entry[field] !== undefined && typeof entry[field] !== 'boolean') {
          return 'The Morrow workspace registry contains a flag this version cannot preserve.';
        }
      }
      if (
        entry.parent !== undefined &&
        entry.parent !== null &&
        (typeof entry.parent !== 'string' || !ID.test(entry.parent))
      ) {
        return 'The Morrow workspace registry contains a parent ID this version cannot preserve.';
      }
      if (entry.icon !== undefined && (typeof entry.icon !== 'string' || entry.icon.length > 32)) {
        return 'The Morrow workspace registry contains an icon this version cannot preserve.';
      }
    }
    return null;
  }

  if (unknownKey(raw, RECENT_KEYS) || (raw.version !== undefined && raw.version !== 1)) {
    return 'The Morrow recent-items file has fields this version cannot preserve.';
  }
  if (raw.opened !== undefined) {
    if (!isRecord(raw.opened) || Object.keys(raw.opened).length > MAX_RECENT) {
      return 'The Morrow recent-items list is not supported.';
    }
    for (const [id, time] of Object.entries(raw.opened)) {
      if (!ID.test(id) || typeof time !== 'number' || !Number.isFinite(time)) {
        return 'The Morrow recent-items list contains a value this version cannot preserve.';
      }
    }
  }
  if (raw.activity !== undefined) {
    if (!isRecord(raw.activity) || Object.keys(raw.activity).length > MAX_ACTIVITY_DAYS) {
      return 'The Morrow activity history is not supported.';
    }
    for (const [day, count] of Object.entries(raw.activity)) {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
        typeof count !== 'number' ||
        !Number.isFinite(count) ||
        count <= 0
      ) {
        return 'The Morrow activity history contains a value this version cannot preserve.';
      }
    }
  }
  return null;
}

function pageMetadataIssue(data: Record<string, unknown>): string | null {
  if (Object.hasOwn(data, 'title')) {
    const title = data.title;
    if (
      title !== null &&
      title !== '' &&
      (typeof title !== 'string' || title !== title.replace(/[\r\n\t]+/g, ' ').slice(0, MAX_TITLE_LENGTH))
    ) {
      return 'The title uses a value this version cannot preserve.';
    }
  }

  if (Object.hasOwn(data, 'icon')) {
    const icon = data.icon;
    if (icon !== null && icon !== '' && (typeof icon !== 'string' || [...icon].length > MAX_ICON_LENGTH)) {
      return 'The page icon uses a format this version cannot preserve.';
    }
  }

  if (Object.hasOwn(data, 'cover')) {
    const cover = data.cover;
    if (cover !== null && cover !== '' && (typeof cover !== 'string' || validCover(cover) !== cover)) {
      return 'The page cover uses a format this version cannot preserve.';
    }
  }

  if (Object.hasOwn(data, 'kind')) {
    const kind = data.kind;
    if (kind !== null && kind !== 'page' && (typeof kind !== 'string' || !PAGE_KINDS.has(kind))) {
      return 'The page kind is not supported by this version.';
    }
  }

  const tagsKey = Object.hasOwn(data, 'tags') ? 'tags' : Object.hasOwn(data, 'tag') ? 'tag' : null;
  if (tagsKey) {
    const tags = data[tagsKey];
    if (!representableTags(tags)) return 'The page tags contain values this version cannot preserve.';
    if (Object.hasOwn(data, 'tags') && Object.hasOwn(data, 'tag')) {
      const primary = readTags(data.tags).join('\n');
      const legacy = readTags(data.tag).join('\n');
      if (primary !== legacy) return 'The page has two different tag fields.';
    }
  }

  const databaseReason = databaseMetadataIssue(data);
  if (databaseReason) return databaseReason;

  return null;
}

function databaseMetadataIssue(data: Record<string, unknown>): string | null {
  const hasDatabase = Object.hasOwn(data, 'database');
  const hasMarker = Object.hasOwn(data, 'polarisDados');
  const validMarker = hasMarker && isValidPolarisDadosMarker(data.polarisDados);
  const kind = data.kind;

  if (hasDatabase && kind !== 'database') {
    return 'Database metadata is attached to a page that is not a database.';
  }
  if (kind === 'database' && hasDatabase) {
    const reason = databaseIssue(data.database, validMarker);
    if (reason) return reason;
  }

  if (hasMarker) {
    if (!validMarker) return 'The Polaris Dados page metadata is from an unsupported format.';
    if (kind !== 'database' || !hasDatabase || !isRecord(data.database)) {
      return 'The Polaris Dados metadata needs a database schema this version can represent.';
    }
  }
  return null;
}

function isValidPolarisDadosMarker(raw: unknown): boolean {
  return (
    isRecord(raw) &&
    raw.version === 1 &&
    raw.provider === 'polaris-dados' &&
    Object.keys(raw).every((key) => key === 'version' || key === 'provider')
  );
}

function representableTags(raw: unknown): boolean {
  if (typeof raw === 'string') return true;
  if (!Array.isArray(raw)) return false;
  return raw.every((tag) => {
    if (typeof tag !== 'string' && typeof tag !== 'number') return false;
    const normalized = readTags([tag]);
    return normalized.length === 1;
  });
}

function unknownFrontmatterIssue(data: Record<string, unknown>): string | null {
  const extras = Object.fromEntries(Object.entries(data).filter(([key]) => !MANAGED_KEYS.has(key)));
  const normalized = normalizeExtra(extras);
  try {
    if (JSON.stringify(extras) !== JSON.stringify(normalized)) {
      return 'The page has frontmatter values this version cannot safely preserve when editing.';
    }
  } catch {
    return 'The page has frontmatter values this version cannot safely preserve when editing.';
  }
  const managedNames = new Set([...MANAGED_KEYS].map((key) => key.toLowerCase()));
  if (Object.keys(extras).some((key) => managedNames.has(key.toLowerCase()))) {
    return 'The page has frontmatter fields that conflict with Morrow-managed properties.';
  }
  return null;
}

function databaseIssue(raw: unknown, polarisDadosOptIn = false): string | null {
  if (!isRecord(raw)) return 'The database schema is not a supported object.';
  if (unknownKey(raw, new Set(['properties', 'views']))) return 'The database schema has unsupported fields.';
  if (raw.properties !== undefined && !Array.isArray(raw.properties)) {
    return 'The database properties are not in a supported format.';
  }
  if (raw.views !== undefined && !Array.isArray(raw.views)) {
    return 'The database views are not in a supported format.';
  }

  for (const property of raw.properties ?? []) {
    const reason = propertyIssue(property, polarisDadosOptIn);
    if (reason) return reason;
  }
  for (const view of raw.views ?? []) {
    const reason = viewIssue(view);
    if (reason) return reason;
  }
  return null;
}

function propertyIssue(raw: unknown, polarisDadosOptIn: boolean): string | null {
  if (!isRecord(raw)) return 'A database property is not a supported object.';
  if (unknownKey(raw, PROPERTY_KEYS)) return 'A database property has fields this version cannot preserve.';
  if (typeof raw.id !== 'string' || !ID.test(raw.id) || typeof raw.name !== 'string') {
    return 'A database property has an unsupported identifier or name.';
  }
  if (!PROP_TYPES.includes(raw.type as never))
    return 'A database property type is not supported by this version.';
  if (raw.name.length > 200) return 'A database property name is too long to preserve.';
  if (
    Object.hasOwn(raw, 'formulaResultType') &&
    (!polarisDadosOptIn ||
      raw.type !== 'formula' ||
      (raw.formulaResultType !== 'number' &&
        raw.formulaResultType !== 'percent' &&
        raw.formulaResultType !== 'currency') ||
      Object.hasOwn(raw, 'display') ||
      Object.hasOwn(raw, 'max'))
  ) {
    return 'A database formula result type is not supported by this version.';
  }
  if (Object.hasOwn(raw, 'format') && normalizeDatabasePropertyFormat(raw) === null) {
    return 'A number property format is not supported by this version.';
  }

  if (raw.options !== undefined) {
    if (!Array.isArray(raw.options)) return 'A database property option list is not supported.';
    for (const option of raw.options) {
      if (!isRecord(option) || unknownKey(option, OPTION_KEYS)) {
        return 'A database property option has fields this version cannot preserve.';
      }
      if (
        typeof option.id !== 'string' ||
        !ID.test(option.id) ||
        typeof option.name !== 'string' ||
        option.name.length > 200 ||
        (option.color !== undefined && !COLORS.includes(option.color as never))
      ) {
        return 'A database property option contains values this version cannot preserve.';
      }
    }
  }

  if (Object.hasOwn(raw, 'formula')) {
    if (raw.type !== 'formula' || typeof raw.formula !== 'string' || raw.formula.length > 2000) {
      return 'A database property formula uses a format this version cannot preserve.';
    }
  }
  if (Object.hasOwn(raw, 'display') && raw.display !== 'bar') {
    return 'A database property display mode is not supported by this version.';
  }
  if (Object.hasOwn(raw, 'max')) {
    if (
      typeof raw.max !== 'number' ||
      !Number.isFinite(raw.max) ||
      raw.max <= 0 ||
      raw.display !== 'bar' ||
      raw.max === 100
    ) {
      return 'A database property maximum uses a format this version cannot preserve.';
    }
  }
  if (Object.hasOwn(raw, 'wrap') && (raw.type !== 'text' || typeof raw.wrap !== 'boolean')) {
    return 'A database text wrapping setting uses a format this version cannot preserve.';
  }
  return null;
}

function viewIssue(raw: unknown): string | null {
  if (!isRecord(raw)) return 'A database view is not a supported object.';
  if (unknownKey(raw, VIEW_KEYS)) return 'A database view has fields this version cannot preserve.';
  if (
    typeof raw.id !== 'string' ||
    !ID.test(raw.id) ||
    typeof raw.name !== 'string' ||
    raw.name.length > 200 ||
    !VIEW_TYPES.includes(raw.type as never)
  ) {
    return 'A database view identifier, name, or type is not supported by this version.';
  }

  for (const field of ['filters', 'sorts'] as const) {
    if (raw[field] !== undefined && !Array.isArray(raw[field])) {
      return `A database view ${field} list is not supported.`;
    }
  }
  const filters = Array.isArray(raw.filters) ? raw.filters : [];
  for (const filter of filters) {
    if (!isRecord(filter) || unknownKey(filter, FILTER_KEYS)) {
      return 'A database filter has fields this version cannot preserve.';
    }
    if (
      typeof filter.id !== 'string' ||
      !ID.test(filter.id) ||
      typeof filter.prop !== 'string' ||
      !filter.prop ||
      filter.prop.length > 64 ||
      !FILTER_OPS.has(String(filter.op)) ||
      !representablePropertyValue(filter.value)
    ) {
      return 'A database filter uses values this version cannot preserve.';
    }
  }
  const sorts = Array.isArray(raw.sorts) ? raw.sorts : [];
  for (const sort of sorts) {
    if (!isRecord(sort) || unknownKey(sort, SORT_KEYS)) {
      return 'A database sort has fields this version cannot preserve.';
    }
    if (
      typeof sort.prop !== 'string' ||
      !sort.prop ||
      sort.prop.length > 64 ||
      (sort.dir !== 'asc' && sort.dir !== 'desc')
    ) {
      return 'A database sort uses values this version cannot preserve.';
    }
  }

  for (const field of ['groupBy', 'dateProp'] as const) {
    if (Object.hasOwn(raw, field) && raw[field] !== null && raw[field] !== undefined) {
      if (typeof raw[field] !== 'string' || raw[field].length > 64) {
        return `A database view ${field} is not supported.`;
      }
    }
  }
  if (Object.hasOwn(raw, 'hidden')) {
    if (!Array.isArray(raw.hidden) || raw.hidden.some((id) => typeof id !== 'string' || id.length > 64)) {
      return 'A database view column list is not supported.';
    }
  }
  if (Object.hasOwn(raw, 'columns')) {
    if (!Array.isArray(raw.columns) || raw.columns.length === 0 || raw.columns.length > 200) {
      return 'A database view column order is not supported.';
    }
    const seen = new Set<string>();
    for (const id of raw.columns) {
      if (typeof id !== 'string' || id.length === 0 || id.length > 64 || seen.has(id)) {
        return 'A database view column order contains values this version cannot preserve.';
      }
      seen.add(id);
    }
  }
  if (Object.hasOwn(raw, 'widths')) {
    if (!isRecord(raw.widths) || Object.keys(raw.widths).length > 200) {
      return 'A database view width map is not supported.';
    }
    for (const [id, width] of Object.entries(raw.widths)) {
      if (
        id.length > 64 ||
        typeof width !== 'number' ||
        !Number.isFinite(width) ||
        !Number.isInteger(width) ||
        width < 80 ||
        width > 1200
      ) {
        return 'A database view width uses values this version cannot preserve.';
      }
    }
  }

  for (const field of ['groupOrder', 'hiddenGroups', 'collapsedGroups'] as const) {
    const value = raw[field];
    if (
      Object.hasOwn(raw, field) &&
      (!Array.isArray(value) ||
        value.length > 200 ||
        value.some((key) => typeof key !== 'string' || key.length === 0 || key.length > 64))
    ) {
      return `A database view ${field} list contains values this version cannot preserve.`;
    }
  }
  if (Object.hasOwn(raw, 'hideEmptyGroups') && typeof raw.hideEmptyGroups !== 'boolean') {
    return 'A database view empty-group setting is not supported.';
  }
  if (
    Object.hasOwn(raw, 'limit') &&
    (typeof raw.limit !== 'number' || !Number.isInteger(raw.limit) || raw.limit < 0 || raw.limit > 10_000)
  ) {
    return 'A database view row limit is not supported.';
  }
  if (Object.hasOwn(raw, 'widgets')) {
    if (!Array.isArray(raw.widgets) || raw.widgets.length > 40) {
      return 'A database view widget list is not supported.';
    }
    const ids = new Set<string>();
    for (const widget of raw.widgets) {
      if (!isRecord(widget) || unknownKey(widget, WIDGET_KEYS)) {
        return 'A dashboard widget has fields this version cannot preserve.';
      }
      if (
        typeof widget.id !== 'string' ||
        !ID.test(widget.id) ||
        ids.has(widget.id) ||
        !WIDGET_KINDS.includes(widget.kind as never) ||
        (widget.prop !== undefined &&
          widget.prop !== null &&
          (typeof widget.prop !== 'string' || widget.prop.length > 64))
      ) {
        return 'A dashboard widget uses a shape this version cannot preserve.';
      }
      ids.add(widget.id);
      if (
        Object.hasOwn(widget, 'title') &&
        (typeof widget.title !== 'string' || widget.title.trim().length === 0 || widget.title.length > 80)
      ) {
        return 'A dashboard widget title uses a format this version cannot preserve.';
      }
      if (Object.hasOwn(widget, 'wide') && typeof widget.wide !== 'boolean') {
        return 'A dashboard widget width setting is not supported.';
      }
    }
  }
  return null;
}

function representablePropertyValue(raw: unknown): boolean {
  return (
    raw === null ||
    typeof raw === 'string' ||
    typeof raw === 'boolean' ||
    (typeof raw === 'number' && Number.isFinite(raw)) ||
    (Array.isArray(raw) && raw.every((item) => typeof item === 'string'))
  );
}

function unknownKey(raw: Record<string, unknown>, accepted: ReadonlySet<string>): boolean {
  return Object.keys(raw).some((key) => !accepted.has(key));
}

function unsupportedMarkerIssue(
  body: string,
  explicitTitle: boolean,
  options: PageContentSafetyOptions,
): string | null {
  if (hasOverdeepPolarisDadosView(body)) {
    return 'The page contains a Polaris Dados view beyond the supported wrapper depth.';
  }
  const viewIds = new Set<string>();
  const allowedViewMarkers = new Map<string, number>();
  const hasBlockBackground = /<!--[ \t\r\n]*morrow:block-background(?=[\s:>])/i.test(body);
  const blockBackgroundMarkers = hasBlockBackground
    ? inspectBlockBackgroundMarkers(body, options.resolveAttachmentHref ?? mayResolveLocalAttachment)
    : [];
  const sourceLines = body.split(/\r?\n/);
  const approvedBlockBackgroundLines = new Map<number, string>();
  for (const marker of blockBackgroundMarkers) {
    if (
      marker.approved &&
      marker.tokenType === 'html_block' &&
      marker.sourceLine !== null &&
      hasOnlyMarkdownContainerPrefixes(sourceLines[marker.sourceLine] ?? '', marker.comment)
    ) {
      approvedBlockBackgroundLines.set(marker.sourceLine, marker.comment);
    }
  }
  let blockBackgroundTokenIndex = 0;
  let blockBackgroundIndex = 0;
  for (const token of markerTokens(body)) {
    const markers = /<!--[ \t\r\n]*morrow:([a-z][\w-]*)/gi;
    let match: RegExpExecArray | null;
    while ((match = markers.exec(token.content))) {
      const markerName = match[1]!.toLowerCase();
      const commentStart = match.index;
      const commentEnd = token.content.indexOf('-->', commentStart);
      if (commentEnd === -1) {
        return 'The page contains a Morrow block marker this version cannot safely edit.';
      }
      const comment = token.content.slice(commentStart, commentEnd + 3).trim();
      if (markerName === 'header-column') continue;
      if (markerName === 'block-background') {
        const inspected = blockBackgroundMarkers[blockBackgroundTokenIndex++];
        if (
          !inspected ||
          inspected.comment !== comment ||
          !inspected.approved ||
          !inspected.color ||
          (inspected.titleHeading && !explicitTitle) ||
          token.type !== 'html_block' ||
          token.content.trim() !== comment
        ) {
          return 'The page contains a Morrow block marker this version cannot safely edit.';
        }
        continue;
      }
      if (markerName !== 'polaris-dados-view') {
        return 'The page contains a Morrow block marker this version cannot safely edit.';
      }
      if (token.type !== 'html_block' || token.content.trim() !== comment || token.invalidListPosition) {
        return 'The page contains a Morrow block marker this version cannot safely edit.';
      }
      const view = decodePolarisDadosViewMarker(comment);
      if (!view || viewIds.has(view.viewId)) {
        return 'The page contains an unsupported or duplicate Polaris Dados view marker.';
      }
      viewIds.add(view.viewId);
      allowedViewMarkers.set(comment, (allowedViewMarkers.get(comment) ?? 0) + 1);
    }
  }
  for (const marker of rawMorrowComments(body, approvedBlockBackgroundLines)) {
    if (marker.name === 'header-column' && marker.closed) continue;
    if (marker.name === 'block-background' && marker.closed) {
      const inspected = blockBackgroundMarkers[blockBackgroundIndex++];
      if (
        !inspected ||
        inspected.comment !== marker.comment ||
        !inspected.approved ||
        !inspected.color ||
        (inspected.titleHeading && !explicitTitle)
      ) {
        return 'The page contains a Morrow block marker this version cannot safely edit.';
      }
      continue;
    }
    if (marker.name !== 'polaris-dados-view' || !marker.closed) {
      return 'The page contains a Morrow block marker this version cannot safely edit.';
    }
    const remaining = allowedViewMarkers.get(marker.comment) ?? 0;
    if (remaining === 0) return 'The page contains a Morrow block marker this version cannot safely edit.';
    allowedViewMarkers.set(marker.comment, remaining - 1);
  }
  const columnLayout = columnLayoutIssue(body);
  if (columnLayout.issue) return columnLayout.issue;
  const parsedTokens = markerMarkdown.parse(body, {});
  const hasDetailsMarkup = /<\/?details\b/i.test(body);
  let detailsParse: ReturnType<typeof markdownToDocWithDetailsHtmlBlocks> | null = null;
  if (hasDetailsMarkup) {
    try {
      detailsParse = markdownToDocWithDetailsHtmlBlocks(body);
    } catch {
      return 'A toggle summary is not in a structure this version can safely preserve.';
    }
  }
  const toggleIssue = toggleSummaryIssue(parsedTokens, detailsParse?.detailsHtmlBlocks ?? []);
  if (toggleIssue.issue) return toggleIssue.issue;
  let parsedDocument: DocNode | null = detailsParse?.doc ?? null;
  if (toggleIssue.blockBackgroundCount > 0 || viewIds.size > 0) {
    try {
      parsedDocument ??= markdownToDoc(body);
    } catch {
      return toggleIssue.blockBackgroundCount > 0
        ? 'A toggle summary background is not in a structure this version can safely preserve.'
        : 'The page contains a Polaris Dados view this version cannot safely represent.';
    }
  }
  if (
    toggleIssue.blockBackgroundCount > 0 &&
    parsedDocument &&
    hasUnsupportedToggleSummaryBackgroundOwner(parsedDocument)
  ) {
    return 'A toggle summary background is not in a structure this version can safely preserve.';
  }
  const formulaIssue = legacyFormulaIssue(body, parsedTokens);
  if (formulaIssue) return formulaIssue;
  if (viewIds.size > 0) {
    const parsed = parsedDocument!;
    if (!validateDoc(parsed).ok) {
      return 'The page contains a Polaris Dados view this version cannot safely represent.';
    }
    const parsedViewIds: string[] = [];
    walk(parsed, (node) => {
      if (node.type === 'polarisDadosView' && typeof node.attrs?.viewId === 'string') {
        parsedViewIds.push(node.attrs.viewId);
      }
    });
    if (parsedViewIds.length !== viewIds.size || parsedViewIds.some((viewId) => !viewIds.has(viewId))) {
      return 'The page contains a Polaris Dados view this version cannot safely represent.';
    }
  }
  if (hasUnsupportedMorrowDataAttribute(body, parsedTokens, toggleIssue.summaryFormatCount)) {
    return 'The page contains a Polaris data extension this version cannot safely edit.';
  }
  if (
    countAttribute(body, 'data-block-background') !== toggleIssue.blockBackgroundCount ||
    countAttribute(body, 'data-widths') !== columnLayout.widthsAttributeCount ||
    /\bdata-block-id\b/i.test(body)
  ) {
    return 'The page contains a layout or block identifier this version cannot safely edit.';
  }
  return null;
}

function isSelfContainedOrdinaryDivTree(fragment: string): boolean {
  const scanFragment = fragment.replace(/<!--[\s\S]*?-->/g, '');
  if (/<!--|-->/.test(scanFragment)) return false;

  const divTags = [...scanFragment.matchAll(/<\/?div\b[^>]*>/gi)];
  if (divTags.length < 2) return false;

  const attributePattern = /\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g;
  let depth = 0;
  let previousEnd = 0;

  for (const match of divTags) {
    const start = match.index!;
    const tag = match[0]!.trim();
    if (/^<\//.test(tag)) {
      if (!/^<\/div\s*>$/i.test(tag) || depth === 0) return false;
      depth--;
    } else {
      if (/\/\s*>$/.test(tag)) return false;
      const attributeSource = /^<div\b([\s\S]*?)\s*>$/i.exec(tag)?.[1];
      if (attributeSource === undefined) return false;
      const attributes = [...attributeSource.matchAll(attributePattern)];
      if (
        attributeSource.replace(attributePattern, '').trim() !== '' ||
        new Set(attributes.map((attribute) => attribute[1]!.toLowerCase())).size !== attributes.length ||
        attributes.some((attribute) => ['data-columns', 'data-column'].includes(attribute[1]!.toLowerCase()))
      ) {
        return false;
      }
      depth++;
    }

    previousEnd = start + match[0]!.length;
  }

  return (
    depth === 0 &&
    scanFragment.slice(0, divTags[0]!.index!).trim() === '' &&
    scanFragment.slice(previousEnd).trim() === ''
  );
}

interface ColumnLayoutValidation {
  issue: string | null;
  widthsAttributeCount: number;
}

function columnLayoutIssue(body: string): ColumnLayoutValidation {
  const invalid = (issue: string): ColumnLayoutValidation => ({ issue, widthsAttributeCount: 0 });
  if (!/<div\b[^>]*\bdata-columns?\b/i.test(body)) return { issue: null, widthsAttributeCount: 0 };

  type ColumnFrame = { kind: 'columns'; count: number; widths: string | null };
  type Frame = ColumnFrame | { kind: 'column' | 'other' };
  const frames: Frame[] = [];
  let groupCount = 0;
  let columnCount = 0;
  const expectedWidths: string[] = [];
  const opaqueColumnFragments: string[] = [];
  const tokens = markerMarkdown.parse(body, {});

  for (const token of tokens) {
    if (token.type !== 'html_block' && token.type !== 'inline') continue;
    const inlineTags = token.type === 'inline' ? token.children?.filter((child) => child.type === 'html_inline') ?? [] : [];
    if (inlineTags.some((child) => /<div\b[^>]*\bdata-columns?\b/i.test(child.content))) {
      return invalid('A column layout is embedded in inline HTML this version cannot preserve.');
    }
    const fragments = token.type === 'inline' ? [] : [token.content];

    for (const fragment of fragments) {
      if (
        frames.some((frame) => frame.kind === 'columns' || frame.kind === 'column') &&
        isSelfContainedOrdinaryDivTree(fragment)
      ) {
        opaqueColumnFragments.push(fragment.replace(/\n+$/, ''));
        continue;
      }

      const html = fragment.replace(/<!--[\s\S]*?-->/g, '');
      const divTags = [...html.matchAll(/<\/?div\b[^>]*>/gi)];
      const consumedDivTags = [...fragment.matchAll(/<\/?div\b[^>]*>/gi)];
      const parsedLayoutTags = consumedDivTags.map((match) => parseColumnLayoutTag(match[0]!.trim()));
      const codecConsumesLayoutTags =
        consumedDivTags.length > 0 &&
        parsedLayoutTags.every((tag) => tag !== null) &&
        fragment.replace(/<\/?div\b[^>]*>/gi, '').trim() === '';
      let closedLayoutGroupInToken = false;

      for (const match of divTags) {
        const tag = match[0]!.trim();
        if (/^<\//.test(tag)) {
          const frame = frames.pop();
          if (frame?.kind === 'columns') closedLayoutGroupInToken = true;
          if (!frame && closedLayoutGroupInToken && codecConsumesLayoutTags) {
            return invalid('A column group has an extra closing wrapper this version cannot preserve.');
          }
          if (frame?.kind === 'columns') {
            if (frame.count < 2 || frame.count > 7) {
              return invalid('A column group must contain between two and seven columns.');
            }
            if (frame.widths !== null && parseLegacyColumnWidths(frame.widths, frame.count) === null) {
              return invalid('A column group has a number of widths that does not match its columns.');
            }
          }
          continue;
        }

        const parsedTag = parseHtmlTag(tag);
        const attributes = parsedTag?.attributes ?? [];
        const names = attributes.map((attribute) => attribute.name);
        const isColumns = names.includes('data-columns');
        const isColumn = names.includes('data-column');
        if (!parsedTag && /\bdata-columns?\b/i.test(tag)) {
          return invalid('A column layout uses wrapper attributes or markup this version cannot preserve.');
        }
        if (isColumns || isColumn) {
          const layoutTag = parseColumnLayoutTag(tag);
          if (!layoutTag || layoutTag.kind === 'close') {
            return invalid('A column layout uses wrapper attributes or markup this version cannot preserve.');
          }
          if (layoutTag.kind === 'columns') {
            const parent = frames.at(-1);
            if (parent && parent.kind !== 'column') {
              return invalid('A column group is nested in an unsupported HTML wrapper.');
            }
            groupCount++;
            if (layoutTag.widths !== null) expectedWidths.push(layoutTag.widths);
            frames.push({ kind: 'columns', count: 0, widths: layoutTag.widths });
          } else {
            const parent = frames.at(-1);
            if (!parent || parent.kind !== 'columns') {
              return invalid('A column wrapper is not a direct child of a column group.');
            }
            parent.count++;
            columnCount++;
            frames.push({ kind: 'column' });
          }
          continue;
        }

        if (frames.some((frame) => frame.kind === 'columns' || frame.kind === 'column')) {
          return invalid('A column layout contains a nested div this version cannot preserve.');
        }
        frames.push({ kind: 'other' });
      }
    }
  }

  if (frames.some((frame) => frame.kind === 'columns' || frame.kind === 'column')) {
    return invalid('A column layout has unmatched wrappers this version cannot preserve.');
  }
  if (groupCount > 0) {
    let parsed: DocNode;
    try {
      parsed = markdownToDoc(body);
    } catch {
      return invalid('A column layout could not be represented by this version.');
    }
    let parsedGroups = 0;
    let parsedColumns = 0;
    let invalidParsedGroup = false;
    const parsedWidths: string[] = [];
    const columnDescendants = new WeakSet<DocNode>();
    const rawBlockCountsInColumns = new Map<string, number>();
    walk(parsed, (node, parent) => {
      const insideColumn =
        node.type === 'column' || (parent !== null && columnDescendants.has(parent));
      if (insideColumn) columnDescendants.add(node);

      if (node.type === 'columns') {
        parsedGroups++;
        const children = node.content ?? [];
        if (
          children.length < 2 ||
          children.length > 7 ||
          children.some((child) => child.type !== 'column')
        ) {
          invalidParsedGroup = true;
        }
        const widths = node.attrs?.widths;
        if (widths !== undefined && widths !== null) {
          if (typeof widths !== 'string' || parseLegacyColumnWidths(widths, children.length) === null) {
            invalidParsedGroup = true;
          } else {
            parsedWidths.push(widths);
          }
        }
      }
      if (node.type === 'column') parsedColumns++;
      if (node.type === 'rawBlock' && insideColumn) {
        const text = String(node.attrs?.text ?? '');
        rawBlockCountsInColumns.set(text, (rawBlockCountsInColumns.get(text) ?? 0) + 1);
      }
    });
    let preservesOpaqueFragments = true;
    for (const fragment of opaqueColumnFragments) {
      const count = rawBlockCountsInColumns.get(fragment) ?? 0;
      if (count === 0) {
        preservesOpaqueFragments = false;
        break;
      }
      if (count === 1) rawBlockCountsInColumns.delete(fragment);
      else rawBlockCountsInColumns.set(fragment, count - 1);
    }
    if (
      invalidParsedGroup ||
      parsedGroups !== groupCount ||
      parsedColumns !== columnCount ||
      JSON.stringify(parsedWidths) !== JSON.stringify(expectedWidths) ||
      !preservesOpaqueFragments
    ) {
      return invalid('A column layout could not be represented by this version.');
    }
  }
  return { issue: null, widthsAttributeCount: expectedWidths.length };
}

function mayResolveLocalAttachment(href: string): boolean {
  return (
    !!href &&
    !/^[a-z][a-z0-9+.-]*:/i.test(href) &&
    !href.startsWith('//') &&
    !href.startsWith('#') &&
    !/\.(?:md|canvas)(?:[?#]|$)/i.test(href)
  );
}

function legacyFormulaIssue(body: string, tokens: ReturnType<typeof markerMarkdown.parse>): string | null {
  const resultIds = new Set<string>();
  let expectedCount = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.type !== 'inline') continue;
    const supportedParagraph = token.level === 1 && tokens[index - 1]?.type === 'paragraph_open';
    const containsMedia = (token.children ?? []).some(
      (child) =>
        child.type === 'image' ||
        (child.type === 'wikilink' && (child.meta as { embed?: unknown } | null)?.embed === true),
    );
    let markdownLinkDepth = 0;
    let htmlAnchorDepth = 0;
    for (const child of token.children ?? []) {
      if (child.type === 'link_open') markdownLinkDepth++;
      if (child.type === 'html_inline') {
        if (/^\s*<a(?:\s|>)/i.test(child.content)) htmlAnchorDepth++;
      }
      if (child.type === LEGACY_FORMULA_NODE) {
        const meta = child.meta as { resultId?: unknown } | null;
        if (
          !supportedParagraph ||
          containsMedia ||
          markdownLinkDepth > 0 ||
          htmlAnchorDepth > 0 ||
          typeof meta?.resultId !== 'string'
        ) {
          return 'The page contains a legacy formula result outside a supported paragraph.';
        }
        if (resultIds.has(meta.resultId)) return 'The page contains duplicate legacy formula result IDs.';
        resultIds.add(meta.resultId);
        expectedCount++;
      }
      if (child.type === 'link_close') markdownLinkDepth = Math.max(0, markdownLinkDepth - 1);
      if (child.type === 'html_inline' && /^\s*<\/a\s*>/i.test(child.content))
        htmlAnchorDepth = Math.max(0, htmlAnchorDepth - 1);
    }
  }
  if (expectedCount === 0) return null;

  let parsed: DocNode;
  try {
    parsed = markdownToDoc(body);
  } catch {
    return 'The page contains a legacy formula result this version cannot safely represent.';
  }
  if (
    countLegacyFormulaNodes(parsed) !== expectedCount ||
    legacyFormulaDocIssue(parsed) ||
    !validateDoc(parsed).ok
  ) {
    return 'The page contains a legacy formula result this version cannot safely represent.';
  }
  if (hasMarkedLegacyFormula(parsed)) {
    return 'The page contains a legacy formula result with source formatting this version cannot safely edit.';
  }
  return null;
}

function hasMarkedLegacyFormula(doc: DocNode): boolean {
  let marked = false;
  walk(doc, (node) => {
    if (node.type === LEGACY_FORMULA_NODE && (node.marks?.length ?? 0) > 0) marked = true;
  });
  return marked;
}

function hasUnsupportedMorrowDataAttribute(
  body: string,
  tokens: ReturnType<typeof markerMarkdown.parse>,
  allowedSummaryFormatCount = 0,
): boolean {
  const formulaSpans: string[] = [];
  for (const token of tokens) {
    if (token.type === 'inline') {
      for (const child of token.children ?? []) {
        if (child.type === LEGACY_FORMULA_NODE) formulaSpans.push(child.content);
      }
    }
  }
  // Keep the former lexical guard for every occurrence except one exact span that passed all
  // formula validation above. This also preserves protection for definitions, code and escapes.
  let cursor = 0;
  let remaining = '';
  for (const span of formulaSpans) {
    const start = body.indexOf(span, cursor);
    if (start === -1) return true;
    remaining += `${body.slice(cursor, start)}${' '.repeat(span.length)}`;
    cursor = start + span.length;
  }
  remaining += body.slice(cursor);
  if (countAttribute(remaining, 'data-morrow-summary-format') !== allowedSummaryFormatCount) return true;
  remaining = remaining.replace(/\bdata-morrow-summary-format\b/gi, ' '.repeat('data-morrow-summary-format'.length));
  return /\bdata-morrow-[\w-]+\b/i.test(remaining);
}

function toggleSummaryIssue(
  tokens: ReturnType<typeof markerMarkdown.parse>,
  htmlBlocks: ParsedDetailsHtmlBlock[],
): {
  issue: string | null;
  summaryFormatCount: number;
  blockBackgroundCount: number;
} {
  let summaryFormatCount = 0;
  let blockBackgroundCount = 0;
  for (const token of tokens) {
    if (token.type === 'inline') {
      for (const child of token.children ?? []) {
        if (child.type !== 'html_inline') continue;
        const inlineTags = inspectToggleMarkup(child.content);
        if (
          inlineTags.detailsTags.some((tag) => tag.attributes.length > 0) ||
          inlineTags.summaryTags.some((tag) => tag.attributes.length > 0)
        ) {
          return {
            issue: 'Toggle attributes are supported only on a direct summary in a Markdown HTML block.',
            summaryFormatCount,
            blockBackgroundCount,
          };
        }
      }
    }
  }

  for (const block of htmlBlocks) {
    const inspected = inspectToggleMarkup(block.source);
    const structure = block.structure;
    const recognizedOpenTags = new Set(
      structure.kind === 'open'
        ? structure.events.flatMap((event) => (event.kind === 'open' ? [event.tag.start] : []))
        : [],
    );
    const structuralHeaders = inspected.headers.filter((header) =>
      recognizedOpenTags.has(header.details.start),
    );

    if (
      structure.kind === 'open' &&
      block.consumedSummaryStart !== null &&
      !structuralHeaders.some((header) => header.summary.start === block.consumedSummaryStart)
    ) {
      return {
        issue: 'A toggle summary is not in a structure this version can safely preserve.',
        summaryFormatCount,
        blockBackgroundCount,
      };
    }

    if (block.detailsOwner && inspected.unterminatedOpaqueStarts.length > 0) {
      return {
        issue: 'A toggle contains an unterminated opaque HTML element this version cannot safely preserve.',
        summaryFormatCount,
        blockBackgroundCount,
      };
    }

    if (
      structure.kind === 'close' &&
      block.source.slice(structure.close.end).trim()
    ) {
      return {
        issue: 'A toggle close tag has trailing HTML this version cannot safely preserve.',
        summaryFormatCount,
        blockBackgroundCount,
      };
    }

    if (
      structure.kind === 'open' &&
      structure.close &&
      block.source.slice(structure.close.end).trim()
    ) {
      return {
        issue: 'A toggle close tag has trailing HTML this version cannot safely preserve.',
        summaryFormatCount,
        blockBackgroundCount,
      };
    }

    for (const details of inspected.detailsTags.filter((tag) => recognizedOpenTags.has(tag.start))) {
      if (details.attributes.length > 0 && !isSupportedDetailsTag(details)) {
        return {
          issue: 'A details block uses attributes this version cannot safely preserve.',
          summaryFormatCount,
          blockBackgroundCount,
        };
      }
    }
    const representedSummaries = new Set<number>();
    for (const header of structuralHeaders) {
      const summary = header.summary;
      representedSummaries.add(summary.start);
      if (!header.supported || !isSupportedSummaryTag(summary)) {
        return {
          issue: 'A toggle summary uses attributes this version cannot safely preserve.',
          summaryFormatCount,
          blockBackgroundCount,
        };
      }
      for (const name of toggleExtensionAttributeNames(summary)) {
        if (name === 'data-morrow-summary-format') summaryFormatCount++;
        if (name === 'data-block-background') blockBackgroundCount++;
      }
    }
    for (const summary of inspected.summaryTags) {
      if (
        summary.attributes.length === 0 ||
        representedSummaries.has(summary.start) ||
        summary.start !== block.consumedSummaryStart
      ) {
        continue;
      }
      return {
        issue: 'A toggle summary uses attributes this version cannot safely preserve.',
        summaryFormatCount,
        blockBackgroundCount,
      };
    }
    for (const header of structuralHeaders) {
      const title = block.source.slice(header.titleStart, header.titleEnd);
      if (!parseToggleSummaryInline(title)) {
        return {
          issue: 'A toggle summary uses inline content this version cannot safely preserve.',
          summaryFormatCount,
          blockBackgroundCount,
        };
      }
    }
  }
  return { issue: null, summaryFormatCount, blockBackgroundCount };
}

function hasUnsupportedToggleSummaryBackgroundOwner(node: DocNode): boolean {
  const visit = (current: DocNode, ancestors: string[]): boolean => {
    if (
      current.type === 'detailsSummary' &&
      current.attrs?.backgroundColor != null &&
      !supportsHexBlockBackgroundOwner(current.type, ancestors)
    ) {
      return true;
    }
    return (current.content ?? []).some((child) => visit(child, [...ancestors, current.type]));
  };
  return visit(node, []);
}

function countAttribute(source: string, name: string): number {
  const pattern = new RegExp(`\\b${name}\\b`, 'gi');
  return [...source.matchAll(pattern)].length;
}

function hasOverdeepPolarisDadosView(body: string): boolean {
  const source = markdownOutsideFences(body);
  const structure =
    /<\/?(?:details|aside)\b[^>]*>|<div\b[^>]*data-(?:columns|column)\b[^>]*>|<\/div\s*>|<!--[ \t\r\n]*morrow:polaris-dados-view\s*:/gi;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = structure.exec(source))) {
    const token = match[0];
    if (/^<!--[ \t\r\n]*morrow:/i.test(token)) {
      if (depth > MAX_DOC_DEPTH) return true;
    } else if (/^<\/(?:details|aside|div)\b/i.test(token)) {
      depth = Math.max(0, depth - 1);
    } else {
      depth++;
    }
  }
  return false;
}

function rawMorrowComments(
  body: string,
  approvedBlockBackgroundLines: ReadonlyMap<number, string> = new Map(),
): Array<{ name: string; comment: string; closed: boolean }> {
  const visible = markdownOutsideFences(body, approvedBlockBackgroundLines);
  const comments: Array<{ name: string; comment: string; closed: boolean }> = [];
  const openings = /<!--[ \t\r\n]*morrow:([a-z][\w-]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = openings.exec(visible))) {
    const end = visible.indexOf('-->', match.index);
    comments.push({
      name: match[1]!.toLowerCase(),
      comment: (end === -1 ? visible.slice(match.index) : visible.slice(match.index, end + 3)).trim(),
      closed: end !== -1,
    });
  }
  return comments;
}

function markdownOutsideFences(
  markdown: string,
  approvedBlockBackgroundLines: ReadonlyMap<number, string> = new Map(),
): string {
  const lines = markdown.split(/\r?\n/);
  const output: string[] = [];
  let fence: { character: '`' | '~'; length: number } | null = null;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    const content = stripContainerMarkers(line);
    const run = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
    if (fence) {
      if (run && run[1]![0] === fence.character && run[1]!.length >= fence.length && run[2]!.trim() === '') {
        fence = null;
      }
      output.push('');
      continue;
    }
    if (run && !(run[1]![0] === '`' && run[2]!.includes('`'))) {
      fence = { character: run[1]![0] as '`' | '~', length: run[1]!.length };
      output.push('');
      continue;
    }
    const approvedBlockBackground = approvedBlockBackgroundLines.get(lineIndex);
    if (approvedBlockBackground) {
      output.push(approvedBlockBackground);
      continue;
    }
    if (/^(?: {4,}|\t)/.test(content)) {
      output.push('');
      continue;
    }
    output.push(withoutInlineCode(content));
  }
  return output.join('\n');
}

function hasOnlyMarkdownContainerPrefixes(line: string, expectedComment: string): boolean {
  let content = line;
  for (let depth = 0; depth < MAX_DOC_DEPTH; depth++) {
    content = content.replace(/^[ \t]*/, '');
    const quote = /^>[ \t]?/.exec(content);
    if (quote) {
      content = content.slice(quote[0].length);
      continue;
    }
    const list = /^(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(content);
    if (list) {
      content = content.slice(list[0].length);
      continue;
    }
    return content.trimEnd() === expectedComment;
  }
  return false;
}

function stripContainerMarkers(line: string): string {
  let content = line;
  for (let depth = 0; depth < MAX_DOC_DEPTH; depth++) {
    const quote = /^ {0,3}>[ \t]?/.exec(content);
    if (quote) {
      content = content.slice(quote[0].length);
      continue;
    }
    const list = /^ {0,3}(?:[-+*]|\d+[.)])(?:[ \t]+|$)/.exec(content);
    if (list) {
      content = content.slice(list[0].length);
      continue;
    }
    break;
  }
  return content;
}

function withoutInlineCode(line: string): string {
  let output = '';
  for (let index = 0; index < line.length;) {
    if (line[index] !== '`') {
      output += line[index]!;
      index++;
      continue;
    }
    let end = index + 1;
    while (line[end] === '`') end++;
    const delimiterLength = end - index;
    let close = end;
    let matched = false;
    while (close < line.length) {
      if (line[close] !== '`') {
        close++;
        continue;
      }
      let runEnd = close + 1;
      while (line[runEnd] === '`') runEnd++;
      if (runEnd - close === delimiterLength) {
        index = runEnd;
        matched = true;
        break;
      }
      close = runEnd;
    }
    if (!matched) {
      output += line.slice(index, end);
      index = end;
    }
  }
  return output;
}

interface MarkerToken {
  type: string;
  content: string;
  invalidListPosition: boolean;
}

function markerTokens(body: string, depth = 0, invalidListAncestor = false): MarkerToken[] {
  const found: MarkerToken[] = [];
  const listItems: Array<{ level: number; hasBlock: boolean; leadingParagraph: boolean }> = [];
  const blockTokens = new Set([
    'blockquote_open',
    'bullet_list_open',
    'ordered_list_open',
    'heading_open',
    'fence',
    'code_block',
    'hr',
    'table_open',
    'html_block',
  ]);
  for (const token of markerMarkdown.parse(body, {})) {
    if (token.type === 'list_item_open') {
      listItems.push({ level: token.level, hasBlock: false, leadingParagraph: false });
      continue;
    }
    if (token.type === 'list_item_close') {
      while (listItems.length > 0 && listItems[listItems.length - 1]!.level >= token.level) listItems.pop();
      continue;
    }
    const listItem = listItems[listItems.length - 1];
    const directListBlock = listItem !== undefined && token.level === listItem.level + 1;
    if (token.type === 'paragraph_open' && directListBlock && !listItem!.hasBlock) {
      listItem!.leadingParagraph = true;
    }
    if (token.type === 'html_block') {
      const invalidListPosition = invalidListAncestor || listItems.some((item) => !item.leadingParagraph);
      if (directListBlock && !listItem!.hasBlock && /^<br\s*\/?>$/i.test(token.content.trim())) {
        listItem!.leadingParagraph = true;
      }
      if (directListBlock) listItem!.hasBlock = true;
      const nested = depth < MAX_DOC_DEPTH ? nestedHtmlMarkdown(token.content) : null;
      if (nested) {
        if (/<!--[ \t\r\n]*morrow:/i.test(nested.outside)) {
          found.push({ type: token.type, content: token.content, invalidListPosition });
        } else {
          found.push(...markerTokens(nested.body, depth + 1, invalidListPosition));
        }
      } else {
        found.push({ type: token.type, content: token.content, invalidListPosition });
      }
    }
    if (
      directListBlock &&
      blockTokens.has(token.type) &&
      token.type !== 'html_block' &&
      token.type !== 'paragraph_open'
    ) {
      listItem!.hasBlock = true;
    }
    if (token.type === 'inline') {
      for (const child of token.children ?? []) {
        if (child.type === 'html_inline') {
          found.push({
            type: child.type,
            content: child.content,
            invalidListPosition: invalidListAncestor || listItems.some((item) => !item.leadingParagraph),
          });
        }
      }
    }
  }
  return found;
}

function nestedHtmlMarkdown(source: string): { body: string; outside: string } | null {
  const html = source.trim();
  const details = /^<details[^>]*>/i.exec(html);
  const aside = /^<aside[^>]*>/i.exec(html);
  if (!details && !aside) return null;

  let bodyStart = details?.[0].length ?? aside![0].length;
  const summary = details ? /<summary[^>]*>[\s\S]*?<\/summary>/i.exec(html) : null;
  if (summary) bodyStart = summary.index + summary[0].length;
  const after = html.slice(bodyStart);
  const inner = details ? after.replace(/<\/details>\s*$/i, '') : after.replace(/<\/aside>\s*$/i, '');
  const body = inner.trim();
  if (!body || !/<!--[ \t\r\n]*morrow:/i.test(body)) return null;

  const innerStart = html.indexOf(inner, bodyStart);
  if (innerStart < 0) return null;
  const outside = html.slice(0, innerStart) + html.slice(innerStart + inner.length);
  return { body, outside };
}
