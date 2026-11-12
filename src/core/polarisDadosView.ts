export interface PolarisDadosViewFilter {
  propertyId: string;
  op: 'gte';
  value: number;
}

export interface PolarisDadosViewData extends Record<string, unknown> {
  version: 1;
  viewId: string;
  sourceDatabaseId: string;
  title: string;
  columnOrder: string[];
  filter: PolarisDadosViewFilter | null;
}

export const POLARIS_DADOS_VIEW_NODE = 'polarisDadosView';
export const POLARIS_DADOS_VIEW_MAX_PAYLOAD_BYTES = 64 * 1024;

const MAX_ID_LENGTH = 128;
const MAX_TITLE_LENGTH = 300;
const MAX_COLUMN_COUNT = 1000;
const DATA_KEYS = ['version', 'viewId', 'sourceDatabaseId', 'title', 'columnOrder', 'filter'];
const FILTER_KEYS = ['propertyId', 'op', 'value'];
const VIEW_BLOCK_PARENTS = new Set([
  'doc',
  'blockquote',
  'listItem',
  'taskItem',
  'callout',
  'detailsContent',
  'column',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_ID_LENGTH;
}

function hasValidShape(value: unknown): value is PolarisDadosViewData {
  if (!isRecord(value) || !hasExactKeys(value, DATA_KEYS) || value.version !== 1) return false;
  if (!isId(value.viewId) || !isId(value.sourceDatabaseId)) return false;
  if (typeof value.title !== 'string' || value.title.length > MAX_TITLE_LENGTH) return false;
  if (!Array.isArray(value.columnOrder) || value.columnOrder.length > MAX_COLUMN_COUNT) return false;
  const columns = new Set<string>();
  for (const id of value.columnOrder) {
    if (!isId(id) || columns.has(id)) return false;
    columns.add(id);
  }
  if (value.filter !== null) {
    if (!isRecord(value.filter) || !hasExactKeys(value.filter, FILTER_KEYS)) return false;
    if (
      !isId(value.filter.propertyId) ||
      value.filter.op !== 'gte' ||
      typeof value.filter.value !== 'number' ||
      !Number.isFinite(value.filter.value)
    ) {
      return false;
    }
  }
  return true;
}

function orderedData(value: PolarisDadosViewData): PolarisDadosViewData {
  return {
    version: 1,
    viewId: value.viewId,
    sourceDatabaseId: value.sourceDatabaseId,
    title: value.title,
    columnOrder: [...value.columnOrder],
    filter:
      value.filter === null
        ? null
        : { propertyId: value.filter.propertyId, op: 'gte', value: value.filter.value },
  };
}

function payloadBytes(value: PolarisDadosViewData): Uint8Array | null {
  try {
    return new TextEncoder().encode(JSON.stringify(orderedData(value)));
  } catch {
    return null;
  }
}

export function isPolarisDadosViewData(value: unknown): value is PolarisDadosViewData {
  if (!hasValidShape(value)) return false;
  const bytes = payloadBytes(value);
  return bytes !== null && bytes.length <= POLARIS_DADOS_VIEW_MAX_PAYLOAD_BYTES;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): Uint8Array | null {
  const maxEncodedLength = Math.ceil((POLARIS_DADOS_VIEW_MAX_PAYLOAD_BYTES * 4) / 3);
  if (
    value.length === 0 ||
    value.length > maxEncodedLength ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length % 4 === 1
  ) {
    return null;
  }
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.length > POLARIS_DADOS_VIEW_MAX_PAYLOAD_BYTES || encodeBase64Url(bytes) !== value) return null;
    return bytes;
  } catch {
    return null;
  }
}

export function encodePolarisDadosViewMarker(value: unknown): string {
  if (!isPolarisDadosViewData(value)) throw new TypeError('Invalid Polaris Dados view payload.');
  const bytes = payloadBytes(value);
  if (!bytes) throw new TypeError('Invalid Polaris Dados view payload.');
  return `<!-- morrow:polaris-dados-view:v1:${encodeBase64Url(bytes)} -->`;
}

export function decodePolarisDadosViewMarker(marker: string): PolarisDadosViewData | null {
  const match = /^<!-- morrow:polaris-dados-view:v1:([A-Za-z0-9_-]+) -->$/.exec(marker);
  if (!match) return null;
  const bytes = decodeBase64Url(match[1]!);
  if (!bytes) return null;
  try {
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(json);
    if (!isPolarisDadosViewData(parsed)) return null;
    const normalized = orderedData(parsed);
    if (encodePolarisDadosViewMarker(normalized) !== marker) return null;
    return normalized;
  } catch {
    return null;
  }
}

/** Returns a reason when a DocNode contains a malformed or duplicate linked-view atom. */
export function polarisDadosViewDocIssue(value: unknown): string | null {
  if (!isRecord(value) || value.type !== 'doc' || !Array.isArray(value.content)) return null;
  const seen = new Set<string>();
  const stack: Array<{ node: unknown; parentType: string; invalidListAncestor: boolean }> = [];
  for (const node of value.content) stack.push({ node, parentType: 'doc', invalidListAncestor: false });
  while (stack.length > 0) {
    const { node: candidate, parentType, invalidListAncestor } = stack.pop()!;
    if (!isRecord(candidate) || typeof candidate.type !== 'string') continue;
    if (candidate.type === POLARIS_DADOS_VIEW_NODE) {
      const keys = Object.keys(candidate);
      if (keys.length !== 2 || !keys.includes('type') || !keys.includes('attrs')) {
        return 'A Polaris Dados view node must be an atom without content, text, or marks.';
      }
      if (!VIEW_BLOCK_PARENTS.has(parentType)) {
        return 'A Polaris Dados view node is not supported in this document position.';
      }
      if (invalidListAncestor) {
        return 'A Polaris Dados view node in a list item requires a leading paragraph.';
      }
      if (!isPolarisDadosViewData(candidate.attrs)) {
        return 'A Polaris Dados view node has unsupported attributes or payload.';
      }
      if (seen.has(candidate.attrs.viewId)) return 'A document contains a duplicate Polaris Dados view ID.';
      seen.add(candidate.attrs.viewId);
    }
    const firstChild = Array.isArray(candidate.content) ? candidate.content[0] : null;
    const invalidChildListContext =
      invalidListAncestor ||
      ((candidate.type === 'listItem' || candidate.type === 'taskItem') &&
        (!isRecord(firstChild) || firstChild.type !== 'paragraph'));
    if (Array.isArray(candidate.content)) {
      for (const child of candidate.content)
        stack.push({ node: child, parentType: candidate.type, invalidListAncestor: invalidChildListContext });
    }
  }
  return null;
}

