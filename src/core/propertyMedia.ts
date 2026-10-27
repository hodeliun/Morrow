import { docToPlainText, fileIdsInDoc, isRecord, remapFileIds, validateDoc } from './doc';
import type { DatabaseDef, DocNode, PageId, PageMeta, PropDef, PropValue } from './model';

export const MAX_PROPERTY_ATTACHMENTS = 200;
export const MAX_RICH_CANVAS_BYTES = 1_000_000;
export const MAX_ATTACHMENT_VALUE_LENGTH = 128_000;
const MAX_MEDIA_NAME_LENGTH = 255;
const MAX_MEDIA_TYPE_LENGTH = 120;
const MAX_MEDIA_ID_LENGTH = 512;

export function validPropertyFileId(id: unknown): id is string {
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > MAX_MEDIA_ID_LENGTH ||
    id.startsWith('/') ||
    id.includes('\\') ||
    /[<>:"|?*]/.test(id) ||
    [...id].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  )
    return false;
  return id.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

export interface PropertyAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  createdAt: number;
}

interface AttachmentDocument {
  format: 'morrow-property-attachments';
  version: 1;
  files: PropertyAttachment[];
}

const richNodes = new Set([
  'doc',
  'paragraph',
  'text',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'blockquote',
  'hardBreak',
  'horizontalRule',
  'image',
  'fileAttachment',
]);
const richMarks = new Set(['bold', 'italic', 'underline', 'strike', 'code', 'link']);

export function isMediaProperty(type: PropDef['type']): boolean {
  return type === 'image' || type === 'file' || type === 'richCanvas';
}

export function allowsMultipleAttachments(prop: PropDef): boolean {
  return (prop.type === 'image' || prop.type === 'file') && prop.media?.multiple === true;
}

export function encodeAttachmentValue(files: PropertyAttachment[]): string | null {
  if (files.length === 0) return null;
  return JSON.stringify({ format: 'morrow-property-attachments', version: 1, files } satisfies AttachmentDocument);
}

export function readAttachmentValue(value: unknown): PropertyAttachment[] | null {
  if (typeof value !== 'string' || value.length > MAX_ATTACHMENT_VALUE_LENGTH) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.format !== 'morrow-property-attachments' || parsed.version !== 1) return null;
  if (!Array.isArray(parsed.files) || parsed.files.length === 0 || parsed.files.length > MAX_PROPERTY_ATTACHMENTS)
    return null;
  const files: PropertyAttachment[] = [];
  const ids = new Set<string>();
  for (const raw of parsed.files) {
    if (!isRecord(raw)) return null;
    if (
      typeof raw.id !== 'string' ||
      !validPropertyFileId(raw.id) ||
      ids.has(raw.id) ||
      typeof raw.name !== 'string' ||
      raw.name.length === 0 ||
      raw.name.length > MAX_MEDIA_NAME_LENGTH ||
      typeof raw.type !== 'string' ||
      raw.type.length === 0 ||
      raw.type.length > MAX_MEDIA_TYPE_LENGTH ||
      typeof raw.size !== 'number' ||
      !Number.isSafeInteger(raw.size) ||
      raw.size < 0 ||
      typeof raw.createdAt !== 'number' ||
      !Number.isFinite(raw.createdAt) ||
      raw.createdAt < 0
    )
      return null;
    ids.add(raw.id);
    files.push({
      id: raw.id,
      name: raw.name,
      type: raw.type,
      size: raw.size,
      createdAt: raw.createdAt,
    });
  }
  return files;
}

export function attachmentValueError(prop: PropDef, value: PropValue): string | null {
  if (value === null) return null;
  const files = readAttachmentValue(value);
  if (!files) return `${prop.name} must contain valid local file references.`;
  if (!allowsMultipleAttachments(prop) && files.length > 1)
    return `${prop.name} accepts one attachment.`;
  if (prop.type === 'image' && files.some((file) => !file.type.toLowerCase().startsWith('image/')))
    return `${prop.name} accepts image files only.`;
  return null;
}

export function parseRichCanvas(value: unknown): DocNode | null {
  if (typeof value !== 'string' || value.length > MAX_RICH_CANVAS_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const checked = validateDoc(parsed);
  if (!checked.ok || checked.value.type !== 'doc') return null;
  let safe = true;
  const visit = (node: DocNode) => {
    if (!richNodes.has(node.type)) safe = false;
    for (const mark of node.marks ?? []) {
      if (!richMarks.has(mark.type)) safe = false;
      if (mark.type === 'link') {
        const href = mark.attrs?.href;
        if (typeof href !== 'string' || !safeLink(href)) safe = false;
      }
    }
    if (node.type === 'image') {
      const id = node.attrs?.fileId;
      const src = node.attrs?.src;
      if (id !== null && id !== undefined && !validPropertyFileId(id)) safe = false;
      if (src !== null && src !== undefined && (typeof src !== 'string' || src.length > 2048)) safe = false;
      if (!id && !src) safe = false;
    }
    if (node.type === 'fileAttachment') {
      const id = node.attrs?.fileId;
      if (!validPropertyFileId(id)) safe = false;
      if (typeof node.attrs?.name === 'string' && node.attrs.name.length > MAX_MEDIA_NAME_LENGTH) safe = false;
    }
    for (const child of node.content ?? []) visit(child);
  };
  visit(checked.value);
  return safe ? checked.value : null;
}

function safeLink(href: string): boolean {
  if (href.length > 2048) return false;
  if (/^(https?:|mailto:)/i.test(href)) return true;
  return href.startsWith('#') || (href.startsWith('/') && !href.startsWith('//'));
}

export function richCanvasValueError(prop: PropDef, value: PropValue): string | null {
  if (value === null) return null;
  return parseRichCanvas(value) ? null : `${prop.name} must contain a supported rich document.`;
}

export function emptyRichCanvasValue(): string {
  return JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] } satisfies DocNode);
}

export function richCanvasText(value: unknown): string {
  const doc = parseRichCanvas(value);
  return doc ? docToPlainText(doc) : '';
}

export function propertyMediaLabel(prop: PropDef, value: PropValue): string {
  if (prop.type === 'richCanvas') return richCanvasText(value) || (typeof value === 'string' ? value : '');
  const files = readAttachmentValue(value);
  return files ? files.map((file) => file.name).join(', ') : typeof value === 'string' ? value : '';
}

export function fileIdsInPropertyValue(prop: PropDef, value: PropValue): string[] {
  if (prop.type === 'image' || prop.type === 'file') return (readAttachmentValue(value) ?? []).map((file) => file.id);
  if (prop.type === 'richCanvas') {
    const doc = parseRichCanvas(value);
    return doc ? fileIdsInDoc(doc) : [];
  }
  return [];
}

export function remapPropertyFileIds(
  prop: PropDef,
  value: PropValue,
  ids: ReadonlyMap<string, string>,
): PropValue {
  if (ids.size === 0 || value === null) return value;
  if (prop.type === 'image' || prop.type === 'file') {
    const files = readAttachmentValue(value);
    if (!files) return value;
    return encodeAttachmentValue(files.map((file) => ({ ...file, id: ids.get(file.id) ?? file.id })));
  }
  if (prop.type === 'richCanvas') {
    const doc = parseRichCanvas(value);
    return doc ? JSON.stringify(remapFileIds(doc, ids)) : value;
  }
  return value;
}

export function fileIdsInPropertyValues(properties: Record<string, PropValue>, database: DatabaseDef): string[] {
  const ids = new Set<string>();
  for (const prop of database.properties) {
    const value = properties[prop.id] ?? null;
    for (const id of fileIdsInPropertyValue(prop, value)) ids.add(id);
    if (prop.fillMode === 'default' && prop.defaultValue !== undefined) {
      for (const id of fileIdsInPropertyValue(prop, prop.defaultValue)) ids.add(id);
    }
  }
  return [...ids];
}

export function fileIdsInPageProperties(
  page: PageMeta,
  pages: Readonly<Record<PageId, PageMeta>>,
): string[] {
  const database = page.parentId ? pages[page.parentId]?.database : undefined;
  const ids = new Set<string>(database ? fileIdsInPropertyValues(page.properties, database) : []);
  if (page.database) for (const id of fileIdsInPropertyValues({}, page.database)) ids.add(id);
  return [...ids];
}

export function remapPagePropertyFiles(
  page: PageMeta,
  database: DatabaseDef | null | undefined,
  ids: ReadonlyMap<string, string>,
): PageMeta {
  if (!database || ids.size === 0) return page;
  const properties = { ...page.properties };
  for (const prop of database.properties) {
    if (Object.hasOwn(properties, prop.id))
      properties[prop.id] = remapPropertyFileIds(prop, properties[prop.id]!, ids);
  }
  const mappedDatabase: DatabaseDef = {
    ...database,
    properties: database.properties.map((prop) =>
      prop.defaultValue === undefined
        ? prop
        : { ...prop, defaultValue: remapPropertyFileIds(prop, prop.defaultValue, ids) },
    ),
  };
  return {
    ...page,
    properties,
    ...(page.database ? { database: mappedDatabase } : {}),
  };
}
