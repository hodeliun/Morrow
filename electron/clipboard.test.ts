import { describe, expect, it, vi } from 'vitest';
import { GRID_CLIPBOARD_MIME, isGridClipboardEnvelope, registerClipboardHandlers } from './clipboard.js';
import type { ClipboardIpcHandler, SystemClipboard } from './clipboard.js';

const payload = {
  version: 1,
  kind: 'morrow-grid-range',
  rowCount: 1,
  colCount: 1,
  colTypes: ['number'],
  rows: [[{ type: 'number', value: 42 }]],
};
const envelope = (text: string) =>
  JSON.stringify({
    version: 1,
    kind: 'morrow-grid-clipboard',
    text,
    payload,
  });

function makeHandlers(clipboard: SystemClipboard, allowed = true) {
  const handlers = new Map<string, ClipboardIpcHandler>();
  const ipcMain = {
    handle(channel: string, handler: ClipboardIpcHandler) {
      handlers.set(channel, handler);
    },
  };
  const createClipboardItem = vi.fn((data: Record<string, string>) => ({ data }));
  registerClipboardHandlers(ipcMain, clipboard, () => allowed, createClipboardItem);
  return { handlers, createClipboardItem };
}

function makeClipboard() {
  return {
    readText: vi.fn<() => Promise<string>>().mockResolvedValue('external TSV'),
    read: vi
      .fn<() => Promise<{ types: string[]; getType: (type: string) => Promise<Blob> }[]>>()
      .mockResolvedValue([]),
    writeText: vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined),
    write: vi.fn<(items: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
  };
}

describe('clipboard IPC contract', () => {
  it('validates typed clipboard shape, text binding, and safe limits before write', () => {
    expect(isGridClipboardEnvelope('42', envelope('42'))).toBe(true);
    expect(isGridClipboardEnvelope('43', envelope('42'))).toBe(false);
    expect(isGridClipboardEnvelope('42', '{')).toBe(false);
    expect(
      isGridClipboardEnvelope('42', JSON.stringify({ ...JSON.parse(envelope('42')), extra: true })),
    ).toBe(false);
    const invalid = JSON.parse(envelope('42'));
    invalid.payload.rows[0][0].value = { arbitrary: true };
    expect(isGridClipboardEnvelope('42', JSON.stringify(invalid))).toBe(false);
    expect(isGridClipboardEnvelope('x'.repeat(1_000_001), envelope('42'))).toBe(false);
  });

  it('rejects untrusted IPC senders without touching the native clipboard', async () => {
    const clipboard = makeClipboard();
    const { handlers } = makeHandlers(clipboard, false);
    const writeText = handlers.get('morrow:copy-text')!;
    const writeGrid = handlers.get('morrow:clipboard-write-grid')!;
    const readGrid = handlers.get('morrow:clipboard-read-grid')!;

    await expect(writeText({ url: 'https://example.invalid' }, 'synthetic')).resolves.toBe(false);
    await expect(writeGrid({}, '42', envelope('42'))).resolves.toBe(false);
    await expect(Promise.resolve().then(() => readGrid({}))).rejects.toThrow('Not allowed.');
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(clipboard.write).not.toHaveBeenCalled();
    expect(clipboard.read).not.toHaveBeenCalled();
  });

  it('keeps database marker and row payload text on the interoperable text path', async () => {
    const clipboard = makeClipboard();
    const { handlers } = makeHandlers(clipboard);
    const writeText = handlers.get('morrow:copy-text')!;
    const marker = 'morrow://database-copy/synthetic-db/opaque-id';
    const rows = 'morrow-row-clipboard:v1\n{}';

    await expect(writeText({}, marker)).resolves.toBe(true);
    await expect(writeText({}, rows)).resolves.toBe(true);
    expect(clipboard.writeText).toHaveBeenNthCalledWith(1, marker);
    expect(clipboard.writeText).toHaveBeenNthCalledWith(2, rows);
  });

  it('writes interoperable TSV and typed metadata together in one clipboard item', async () => {
    const clipboard = makeClipboard();
    const { handlers, createClipboardItem } = makeHandlers(clipboard);
    const writeGrid = handlers.get('morrow:clipboard-write-grid')!;

    await expect(writeGrid({ url: 'morrow://app/index.html' }, '42', envelope('42'))).resolves.toBe(true);

    expect(createClipboardItem).toHaveBeenCalledWith({
      'text/plain': '42',
      [GRID_CLIPBOARD_MIME]: envelope('42'),
    });
    expect(clipboard.write).toHaveBeenCalledTimes(1);
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it('reads current text and typed metadata from one native clipboard snapshot', async () => {
    const clipboard = makeClipboard();
    const expectedEnvelope = envelope('42');
    const item = {
      types: ['text/plain', GRID_CLIPBOARD_MIME],
      getType: vi.fn(async (type: string) => new Blob([type === 'text/plain' ? '42' : expectedEnvelope])),
    };
    clipboard.read.mockResolvedValue([item]);
    const { handlers } = makeHandlers(clipboard);
    const readGrid = handlers.get('morrow:clipboard-read-grid')!;

    await expect(readGrid({})).resolves.toEqual({
      text: '42',
      hasGridPayload: true,
      gridPayloadJson: expectedEnvelope,
    });
    expect(clipboard.read).toHaveBeenCalledTimes(1);
  });

  it('surfaces native read failures without substituting cached data', async () => {
    const clipboard = makeClipboard();
    clipboard.read.mockRejectedValue(new Error('native read failed'));
    const { handlers } = makeHandlers(clipboard);
    const readGrid = handlers.get('morrow:clipboard-read-grid')!;

    await expect(readGrid({})).rejects.toThrow('native read failed');
    expect(clipboard.readText).not.toHaveBeenCalled();
  });

  it('reports invalid IPC data, missing writers, and native errors without fallback', async () => {
    const clipboard = makeClipboard();
    clipboard.writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValue(new Error('native refused'));
    const { handlers } = makeHandlers(clipboard);
    const writeText = handlers.get('morrow:copy-text')!;
    const writeGrid = handlers.get('morrow:clipboard-write-grid')!;

    await expect(writeText({}, 42)).resolves.toBe(false);
    await expect(writeGrid({}, '42', envelope('43'))).resolves.toBe(false);
    await expect(writeText({}, 'synthetic')).rejects.toThrow('native refused');
    expect(clipboard.write).not.toHaveBeenCalled();
  });
});
