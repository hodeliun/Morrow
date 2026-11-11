// Detect Markdown data the upstream model cannot represent before pageFile normalizes it.
import { isRecord } from '../doc';
import { COLORS, MAX_ICON_LENGTH, MAX_TITLE_LENGTH, PROP_TYPES, validCover, VIEW_TYPES } from '../model';
import { MANAGED_KEYS, normalizeExtra, readTags, splitFrontmatter } from './frontmatter';

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
const PROPERTY_KEYS = new Set(['id', 'name', 'type', 'options', 'formula', 'display', 'max']);
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
]);
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

/**
 * Returns a readable reason when saving this Markdown through the upstream model
 * could drop or change data. This must run on the file text before readPageText.
 */
export function findUnrepresentablePageContent(text: string): string | null {
  const split = splitFrontmatter(text);
  if (split.error) return null; // The normal loader already protects malformed YAML.

  const data = split.data;
  if (data) {
    const metadataIssue = pageMetadataIssue(data);
    if (metadataIssue) return metadataIssue;
    const extraIssue = unknownFrontmatterIssue(data);
    if (extraIssue) return extraIssue;
  }

  return unsupportedMarkerIssue(split.body);
}

export function hasUnrepresentableDatabaseSchema(text: string): boolean {
  const data = splitFrontmatter(text).data;
  if (!data || data.kind !== 'database') return false;
  if (Object.hasOwn(data, 'database') && databaseIssue(data.database)) return true;
  if (!Object.hasOwn(data, 'polarisDados')) return false;
  const extension = data.polarisDados;
  return (
    !Object.hasOwn(data, 'database') ||
    !isRecord(data.database) ||
    !!databaseIssue(data.database) ||
    !isRecord(extension) ||
    extension.version !== 1 ||
    extension.provider !== 'polaris-dados' ||
    Object.keys(extension).some((key) => key !== 'version' && key !== 'provider')
  );
}

/** The readers for these files keep only the fields listed below. */
export function findUnrepresentableVaultMetadata(
  raw: unknown,
  kind: 'workspace' | 'recent',
): string | null {
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
        if (entry[field] !== undefined && (typeof entry[field] !== 'number' || !Number.isFinite(entry[field]))) {
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
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || typeof count !== 'number' || !Number.isFinite(count) || count <= 0) {
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
      (typeof title !== 'string' ||
        title !== title.replace(/[\r\n\t]+/g, ' ').slice(0, MAX_TITLE_LENGTH))
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

  const hasDatabase = Object.hasOwn(data, 'database');
  const kind = data.kind;
  if (hasDatabase && kind !== 'database') {
    return 'Database metadata is attached to a page that is not a database.';
  }
  if (kind === 'database' && hasDatabase) {
    const reason = databaseIssue(data.database);
    if (reason) return reason;
  }

  if (Object.hasOwn(data, 'polarisDados')) {
    const extension = data.polarisDados;
    if (
      !isRecord(extension) ||
      extension.version !== 1 ||
      extension.provider !== 'polaris-dados' ||
      Object.keys(extension).some((key) => key !== 'version' && key !== 'provider')
    ) {
      return 'The Polaris Dados page metadata is from an unsupported format.';
    }
    if (kind !== 'database' || !hasDatabase || !isRecord(data.database) || databaseIssue(data.database)) {
      return 'The Polaris Dados metadata needs a database schema this version can represent.';
    }
  }

  return null;
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

function databaseIssue(raw: unknown): string | null {
  if (!isRecord(raw)) return 'The database schema is not a supported object.';
  if (unknownKey(raw, new Set(['properties', 'views']))) return 'The database schema has unsupported fields.';
  if (raw.properties !== undefined && !Array.isArray(raw.properties)) {
    return 'The database properties are not in a supported format.';
  }
  if (raw.views !== undefined && !Array.isArray(raw.views)) {
    return 'The database views are not in a supported format.';
  }

  for (const property of raw.properties ?? []) {
    const reason = propertyIssue(property);
    if (reason) return reason;
  }
  for (const view of raw.views ?? []) {
    const reason = viewIssue(view);
    if (reason) return reason;
  }
  return null;
}

function propertyIssue(raw: unknown): string | null {
  if (!isRecord(raw)) return 'A database property is not a supported object.';
  if (unknownKey(raw, PROPERTY_KEYS)) return 'A database property has fields this version cannot preserve.';
  if (typeof raw.id !== 'string' || !ID.test(raw.id) || typeof raw.name !== 'string') {
    return 'A database property has an unsupported identifier or name.';
  }
  if (!PROP_TYPES.includes(raw.type as never)) return 'A database property type is not supported by this version.';
  if (raw.name.length > 200) return 'A database property name is too long to preserve.';

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

function unsupportedMarkerIssue(body: string): string | null {
  const morrowComments = body.matchAll(/<!--\s*morrow:([a-z][\w:-]*)\b[\s\S]*?-->/gi);
  for (const match of morrowComments) {
    if (match[1]!.toLowerCase() !== 'header-column') {
      return 'The page contains a Morrow block marker this version cannot safely edit.';
    }
  }
  if (/\bdata-morrow-[\w-]+\b/i.test(body)) {
    return 'The page contains a Polaris data extension this version cannot safely edit.';
  }
  if (/\bdata-(?:widths|block-background|block-id)\b/i.test(body)) {
    return 'The page contains a layout or block identifier this version cannot safely edit.';
  }
  return null;
}
