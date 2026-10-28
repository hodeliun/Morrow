import { validateDoc } from './doc';
import { emptyDoc } from './model';
import type { DocNode, PageId, PageMeta, PropDef, PropValue, WorkspaceState } from './model';
import { normalizeDatabase, normalizePage } from './migrations';
import { propertyValueError } from './typedValues';
import { childrenOf } from './tree';
import { fail, ok } from './result';
import type { Result } from './result';

export const ROW_CLIPBOARD_PREFIX = 'morrow-row-clipboard:v1\n';
export const MAX_ROW_CLIPBOARD_CHARS = 1_000_000;
export const MAX_ROW_CLIPBOARD_ROWS = 200;

export interface RowClipboardEntry {
  page: PageMeta;
  doc: DocNode;
}

export interface RowClipboardPayload {
  version: 1;
  kind: 'morrow-row-clipboard';
  sourceDatabaseId: PageId;
  sourceProperties: PropDef[];
  rows: RowClipboardEntry[];
}

const PAGE_KEYS = new Set([
  'id',
  'parentId',
  'title',
  'icon',
  'kind',
  'order',
  'createdAt',
  'updatedAt',
  'trashedAt',
  'favorite',
  'dailyDate',
  'lastOpenedAt',
  'tags',
  'controls',
  'properties',
  'extra',
  'database',
  'cover',
  'coverPosition',
  'noteStyle',
  'encrypted',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function isPropertyValue(value: unknown): value is PropValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string'))
  );
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
  });
}

export function createRowClipboardPayload(
  state: WorkspaceState,
  databaseId: PageId,
  rowIds: readonly PageId[],
): Result<RowClipboardPayload> {
  const databasePage = state.pages[databaseId];
  const database = databasePage?.kind === 'database' ? databasePage.database : null;
  if (!database || database.unsupportedProperties?.length)
    return fail('Rows cannot be copied from a table with an unsupported schema.');
  if (rowIds.length === 0) return fail('Select at least one row to copy.');
  if (rowIds.length > MAX_ROW_CLIPBOARD_ROWS)
    return fail(`A row clipboard action can include at most ${MAX_ROW_CLIPBOARD_ROWS} rows.`);
  if (new Set(rowIds).size !== rowIds.length) return fail('A row was selected more than once.');

  const rows: RowClipboardEntry[] = [];
  for (const id of rowIds) {
    const page = state.pages[id];
    if (!page || page.parentId !== databaseId || page.trashedAt !== null)
      return fail('A selected row is no longer part of this table. Refresh the selection and try again.');
    if (page.encrypted) return fail('Encrypted rows cannot be copied into an unencrypted table.');
    if (page.kind === 'database' || page.database) return fail('A nested table cannot be copied as a row.');
    const validDoc = validateDoc(state.docs[id] ?? emptyDoc());
    if (!validDoc.ok)
      return fail(`The content of “${page.title || 'Untitled'}” cannot be copied: ${validDoc.error}`);
    rows.push({ page: structuredClone(page), doc: structuredClone(validDoc.value) });
  }

  return ok({
    version: 1,
    kind: 'morrow-row-clipboard',
    sourceDatabaseId: databaseId,
    sourceProperties: structuredClone(database.properties),
    rows,
  });
}

export function serializeRowClipboard(value: unknown): Result<string> {
  const validated = validateRowClipboardPayload(value);
  if (!validated.ok) return validated;
  let text: string;
  try {
    text = `${ROW_CLIPBOARD_PREFIX}${JSON.stringify(validated.value)}`;
  } catch {
    return fail('The selected rows cannot be represented safely in the clipboard.');
  }
  if (text.length > MAX_ROW_CLIPBOARD_CHARS)
    return fail('The selected rows are too large for the row clipboard. Copy fewer rows.');
  return ok(text);
}

export function parseRowClipboardText(text: string): Result<RowClipboardPayload> {
  if (text.length > MAX_ROW_CLIPBOARD_CHARS) return fail('The row clipboard is larger than the safe limit.');
  const header = /^morrow-row-clipboard:v1\r?\n/.exec(text)?.[0];
  if (!header) return fail('The clipboard does not contain copied Morrow rows.');
  try {
    return validateRowClipboardPayload(JSON.parse(text.slice(header.length)));
  } catch {
    return fail('The copied rows could not be read. Copy them again from Morrow.');
  }
}

export function validateRowClipboardPayload(value: unknown): Result<RowClipboardPayload> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['version', 'kind', 'sourceDatabaseId', 'sourceProperties', 'rows']) ||
    value.version !== 1 ||
    value.kind !== 'morrow-row-clipboard' ||
    !validId(value.sourceDatabaseId) ||
    !Array.isArray(value.sourceProperties) ||
    value.sourceProperties.length > 200 ||
    !Array.isArray(value.rows) ||
    value.rows.length < 1 ||
    value.rows.length > MAX_ROW_CLIPBOARD_ROWS
  )
    return fail('Clipboard data is not a supported Morrow row payload.');

  const sourceDatabase = normalizeDatabase({ properties: value.sourceProperties, views: [] });
  const rawSourceProperties = value.sourceProperties.filter(isRecord);
  if (
    !sourceDatabase ||
    sourceDatabase.unsupportedProperties?.length ||
    sourceDatabase.properties.length !== value.sourceProperties.length ||
    rawSourceProperties.length !== value.sourceProperties.length ||
    new Set(sourceDatabase.properties.map((prop) => prop.id)).size !== value.sourceProperties.length
  )
    return fail('The copied table schema is not supported by this version of Morrow.');
  for (const rawProp of rawSourceProperties) {
    const normalized = sourceDatabase.properties.find((prop) => prop.id === rawProp.id);
    if (!normalized) return fail('The copied table schema is not supported by this version of Morrow.');
    if (rawProp.options !== undefined && canonical(rawProp.options) !== canonical(normalized.options))
      return fail(`The options for “${normalized.name}” could not be read exactly.`);
    if (rawProp.relation !== undefined && canonical(rawProp.relation) !== canonical(normalized.relation))
      return fail(`The relation for “${normalized.name}” could not be read exactly.`);
    if (rawProp.defaultValue !== undefined) {
      if (!isPropertyValue(rawProp.defaultValue))
        return fail(`The default for “${normalized.name}” is not a supported property value.`);
      const error = propertyValueError(normalized, rawProp.defaultValue);
      if (error) return fail(`The default for “${normalized.name}” is invalid: ${error}`);
      if (canonical(normalized.defaultValue) !== canonical(rawProp.defaultValue))
        return fail(`The default for “${normalized.name}” could not be read exactly.`);
    }
  }

  const ids = new Set<string>();
  const rows: RowClipboardEntry[] = [];
  for (const entry of value.rows) {
    if (!isRecord(entry) || !hasOnlyKeys(entry, ['page', 'doc']) || !isRecord(entry.page))
      return fail('Clipboard data contains an invalid row.');
    if (!hasOnlyKeys(entry.page, [...PAGE_KEYS]))
      return fail('Clipboard data contains unsupported row fields.');
    if (
      !isRecord(entry.page.properties) ||
      Object.entries(entry.page.properties).some(([key, item]) => !validId(key) || !isPropertyValue(item))
    )
      return fail('Clipboard data contains an invalid property value. The copied rows were not changed.');
    const page = normalizePage(entry.page);
    if (
      !page ||
      page.parentId !== value.sourceDatabaseId ||
      page.encrypted ||
      page.kind === 'database' ||
      page.database !== null ||
      page.trashedAt !== null ||
      ids.has(page.id)
    )
      return fail('Clipboard data contains a row that cannot be copied safely.');
    if (canonical(page.properties) !== canonical(entry.page.properties))
      return fail(
        'Clipboard data contains a property value that could not be read exactly. The copied rows were not changed.',
      );
    const doc = validateDoc(entry.doc);
    if (!doc.ok) return fail(`Clipboard row content is invalid: ${doc.error}`);
    ids.add(page.id);
    rows.push({ page, doc: doc.value });
  }

  return ok({
    version: 1,
    kind: 'morrow-row-clipboard',
    sourceDatabaseId: value.sourceDatabaseId,
    sourceProperties: sourceDatabase.properties,
    rows,
  });
}

export function rowClipboardRowsInTable(state: WorkspaceState, databaseId: PageId): PageMeta[] {
  return childrenOf(state.pages, databaseId);
}
