// Detect Markdown data the upstream model cannot represent before pageFile normalizes it.
import MarkdownIt from 'markdown-it';
import { isRecord, validateDoc, walk } from '../doc';
import { markdownToDoc } from '../markdown/parse';
import type { DocNode } from '../model';
import {
  COLORS,
  MAX_DOC_DEPTH,
  MAX_ICON_LENGTH,
  MAX_TITLE_LENGTH,
  PROP_TYPES,
  validCover,
  VIEW_TYPES,
} from '../model';
import { decodePolarisDadosViewMarker } from '../polarisDadosView';
import { MANAGED_KEYS, normalizeExtra, readTags, splitFrontmatter } from './frontmatter';

const markerMarkdown = new MarkdownIt('commonmark', { html: true });

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
  if (hasOverdeepPolarisDadosView(body)) {
    return 'The page contains a Polaris Dados view beyond the supported wrapper depth.';
  }
  const viewIds = new Set<string>();
  const allowedViewMarkers = new Map<string, number>();
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
  for (const marker of rawMorrowComments(body)) {
    if (marker.name === 'header-column' && marker.closed) continue;
    if (marker.name !== 'polaris-dados-view' || !marker.closed) {
      return 'The page contains a Morrow block marker this version cannot safely edit.';
    }
    const remaining = allowedViewMarkers.get(marker.comment) ?? 0;
    if (remaining === 0) return 'The page contains a Morrow block marker this version cannot safely edit.';
    allowedViewMarkers.set(marker.comment, remaining - 1);
  }
  if (viewIds.size > 0) {
    let parsed: DocNode;
    try {
      parsed = markdownToDoc(body);
    } catch {
      return 'The page contains a Polaris Dados view this version cannot safely represent.';
    }
    if (!validateDoc(parsed).ok) {
      return 'The page contains a Polaris Dados view this version cannot safely represent.';
    }
    const parsedViewIds: string[] = [];
    walk(parsed, (node) => {
      if (node.type === 'polarisDadosView' && typeof node.attrs?.viewId === 'string') {
        parsedViewIds.push(node.attrs.viewId);
      }
    });
    if (
      parsedViewIds.length !== viewIds.size ||
      parsedViewIds.some((viewId) => !viewIds.has(viewId))
    ) {
      return 'The page contains a Polaris Dados view this version cannot safely represent.';
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

function hasOverdeepPolarisDadosView(body: string): boolean {
  const source = markdownOutsideFences(body);
  const structure = /<\/?(?:details|aside)\b[^>]*>|<div\b[^>]*data-(?:columns|column)\b[^>]*>|<\/div\s*>|<!--[ \t\r\n]*morrow:polaris-dados-view\s*:/gi;
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

function rawMorrowComments(body: string): Array<{ name: string; comment: string; closed: boolean }> {
  const visible = markdownOutsideFences(body);
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

function markdownOutsideFences(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const output: string[] = [];
  let fence: { character: '`' | '~'; length: number } | null = null;
  for (const line of lines) {
    const content = stripContainerMarkers(line);
    const run = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
    if (fence) {
      if (
        run &&
        run[1]![0] === fence.character &&
        run[1]!.length >= fence.length &&
        run[2]!.trim() === ''
      ) {
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
    if (/^(?: {4,}|\t)/.test(content)) {
      output.push('');
      continue;
    }
    output.push(withoutInlineCode(content));
  }
  return output.join('\n');
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
  for (let index = 0; index < line.length; ) {
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
  const inner = details
    ? after.replace(/<\/details>\s*$/i, '')
    : after.replace(/<\/aside>\s*$/i, '');
  const body = inner.trim();
  if (!body || !/<!--[ \t\r\n]*morrow:/i.test(body)) return null;

  const innerStart = html.indexOf(inner, bodyStart);
  if (innerStart < 0) return null;
  const outside = html.slice(0, innerStart) + html.slice(innerStart + inner.length);
  return { body, outside };
}
