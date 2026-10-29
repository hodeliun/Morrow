export const GRID_CLIPBOARD_MIME = 'web application/x.morrow-grid-range';
const MAX_SYSTEM_CLIPBOARD_CHARS = 16_000_000;
const MAX_GRID_CLIPBOARD_CHARS = 1_000_000;
const GRID_CLIPBOARD_TYPES = new Set([
  'title',
  'text',
  'email',
  'url',
  'phone',
  'number',
  'currency',
  'percent',
  'slider',
  'progress',
  'scale',
  'select',
  'multiSelect',
  'date',
  'time',
  'datetime',
  'duration',
  'createdTime',
  'lastEditedTime',
  'checkbox',
  'relation',
  'formula',
  'image',
  'file',
  'richCanvas',
  'button',
]);

interface ClipboardDataItem {
  types: string[];
  getType(type: string): Promise<Blob>;
}

export interface SystemClipboard {
  readText(): Promise<string>;
  read(): Promise<ClipboardDataItem[]>;
  writeText(text: string): Promise<void>;
  write(items: unknown[]): Promise<void>;
}

export type ClipboardIpcHandler = (event: unknown, ...args: unknown[]) => unknown;

export interface ClipboardIpcMainLike {
  handle(channel: string, handler: ClipboardIpcHandler): void;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isClipboardPrimitive(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (Array.isArray(value) && value.length <= 200 && value.every((item) => typeof item === 'string'))
  );
}

function matchesClipboardCellType(type: string, value: unknown): boolean {
  if (value === null || type === 'formula') return true;
  if (
    type === 'title' ||
    ['text', 'email', 'url', 'phone', 'select', 'date', 'time', 'datetime', 'richCanvas'].includes(type)
  )
    return typeof value === 'string';
  if (
    [
      'number',
      'currency',
      'percent',
      'slider',
      'progress',
      'scale',
      'duration',
      'createdTime',
      'lastEditedTime',
    ].includes(type)
  )
    return typeof value === 'number' && Number.isFinite(value);
  if (type === 'checkbox') return typeof value === 'boolean';
  if (['multiSelect', 'relation', 'image', 'file'].includes(type))
    return (
      typeof value === 'string' || (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    );
  if (type === 'button') return value === null;
  return false;
}

export function isGridClipboardEnvelope(text: string, envelopeJson: string): boolean {
  if (text.length > MAX_GRID_CLIPBOARD_CHARS || envelopeJson.length > MAX_GRID_CLIPBOARD_CHARS * 2)
    return false;
  let value: unknown;
  try {
    value = JSON.parse(envelopeJson);
  } catch {
    return false;
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['version', 'kind', 'text', 'payload']) ||
    value.version !== 1 ||
    value.kind !== 'morrow-grid-clipboard' ||
    typeof value.text !== 'string' ||
    value.text.length > MAX_GRID_CLIPBOARD_CHARS ||
    value.text.replace(/\r\n?/g, '\n') !== text.replace(/\r\n?/g, '\n')
  )
    return false;

  const payload = value.payload;
  if (
    !isRecord(payload) ||
    !hasOnlyKeys(payload, ['version', 'kind', 'rowCount', 'colCount', 'colTypes', 'rows']) ||
    payload.version !== 1 ||
    payload.kind !== 'morrow-grid-range' ||
    !Number.isInteger(payload.rowCount) ||
    !Number.isInteger(payload.colCount) ||
    (payload.rowCount as number) < 1 ||
    (payload.colCount as number) < 1 ||
    (payload.rowCount as number) * (payload.colCount as number) > 1000 ||
    !Array.isArray(payload.colTypes) ||
    !Array.isArray(payload.rows) ||
    payload.rows.length !== payload.rowCount ||
    payload.colTypes.length !== payload.colCount
  )
    return false;

  const colTypes = payload.colTypes as unknown[];
  const rows = payload.rows as unknown[];
  if (colTypes.some((type) => typeof type !== 'string' || !GRID_CLIPBOARD_TYPES.has(type)))
    return false;
  return rows.every(
    (row) =>
      Array.isArray(row) &&
      row.length === payload.colCount &&
      row.every((cell, columnIndex) => {
        if (
          !isRecord(cell) ||
          !hasOnlyKeys(cell, ['type', 'value']) ||
          typeof cell.type !== 'string' ||
          cell.type !== colTypes[columnIndex] ||
          !GRID_CLIPBOARD_TYPES.has(cell.type) ||
          !isClipboardPrimitive(cell.value)
        )
          return false;
        return matchesClipboardCellType(cell.type, cell.value);
      }),
  );
}

async function readGridClipboardContents(clipboard: SystemClipboard): Promise<{
  text: string;
  hasGridPayload: boolean;
  gridPayloadJson: string | null;
}> {
  const items = await clipboard.read();
  const gridItem = items.find((item) => item.types.includes(GRID_CLIPBOARD_MIME));
  const textItem = gridItem
    ? gridItem.types.includes('text/plain')
      ? gridItem
      : undefined
    : items.find((item) => item.types.includes('text/plain'));
  const text = textItem ? await (await textItem.getType('text/plain')).text() : '';
  const gridPayloadJson = gridItem ? await (await gridItem.getType(GRID_CLIPBOARD_MIME)).text() : null;
  return { text, hasGridPayload: gridItem !== undefined, gridPayloadJson };
}

export function registerClipboardHandlers(
  ipcMain: ClipboardIpcMainLike,
  clipboard: SystemClipboard,
  fromApp: (event: unknown) => boolean,
  createClipboardItem: (data: Record<string, string>) => unknown,
): void {
  ipcMain.handle('morrow:copy-text', async (event, text) => {
    if (!fromApp(event) || typeof text !== 'string' || text.length > MAX_SYSTEM_CLIPBOARD_CHARS) return false;
    await clipboard.writeText(text);
    return true;
  });
  ipcMain.handle('morrow:clipboard-read-text', (event) => {
    if (!fromApp(event)) throw new Error('Not allowed.');
    return clipboard.readText();
  });
  ipcMain.handle('morrow:clipboard-read-grid', (event) => {
    if (!fromApp(event)) throw new Error('Not allowed.');
    return readGridClipboardContents(clipboard);
  });
  ipcMain.handle('morrow:clipboard-write-grid', async (event, text, envelopeJson) => {
    if (
      !fromApp(event) ||
      typeof text !== 'string' ||
      typeof envelopeJson !== 'string' ||
      !isGridClipboardEnvelope(text, envelopeJson)
    )
      return false;
    await clipboard.write([
      createClipboardItem({
        'text/plain': text,
        [GRID_CLIPBOARD_MIME]: envelopeJson,
      }),
    ]);
    return true;
  });
}
