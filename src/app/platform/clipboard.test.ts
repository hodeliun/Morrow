import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  clipboard: {
    readText: vi.fn<() => Promise<string>>(),
    readGrid:
      vi.fn<() => Promise<{ text: string; hasGridPayload: boolean; gridPayloadJson: string | null }>>(),
    writeText: vi.fn<(text: string) => Promise<boolean>>(),
    writeGrid: vi.fn<(text: string, envelopeJson: string) => Promise<boolean>>(),
  },
}));

vi.mock('./desktop', () => ({ desktop: bridge }));

import { readClipboardText, readGridClipboard, writeClipboardText, writeGridClipboard } from './clipboard';

describe('desktop clipboard adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the current system text for each request without a cache', async () => {
    bridge.clipboard.readText.mockResolvedValueOnce('first value').mockResolvedValueOnce('external value');

    await expect(readClipboardText()).resolves.toBe('first value');
    await expect(readClipboardText()).resolves.toBe('external value');
    expect(bridge.clipboard.readText).toHaveBeenCalledTimes(2);
  });

  it('returns one native read containing both TSV and typed metadata', async () => {
    const current = { text: '42', hasGridPayload: true, gridPayloadJson: '{"version":1}' };
    bridge.clipboard.readGrid.mockResolvedValue(current);

    await expect(readGridClipboard()).resolves.toEqual(current);
    expect(bridge.clipboard.readGrid).toHaveBeenCalledTimes(1);
  });

  it('writes TSV and a text-bound typed envelope through the restricted desktop bridge', async () => {
    bridge.clipboard.writeGrid.mockResolvedValue(true);
    const payload = {
      version: 1 as const,
      kind: 'morrow-grid-range' as const,
      rowCount: 1,
      colCount: 1,
      colTypes: ['number' as const],
      rows: [[{ type: 'number' as const, value: 42 }]],
    };

    await writeGridClipboard('42', payload);

    const [text, encoded] = bridge.clipboard.writeGrid.mock.calls[0] ?? [];
    expect(text).toBe('42');
    expect(JSON.parse(encoded ?? '')).toEqual({
      version: 1,
      kind: 'morrow-grid-clipboard',
      text: '42',
      payload,
    });
  });

  it('does not fall back to renderer clipboard when the desktop write fails', async () => {
    const rendererWrite = vi.fn<() => Promise<void>>().mockResolvedValue();
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText: rendererWrite } },
    });
    bridge.clipboard.writeText.mockRejectedValue(new Error('native write failed'));

    try {
      await expect(writeClipboardText('synthetic')).rejects.toThrow('native write failed');
      expect(rendererWrite).not.toHaveBeenCalled();
    } finally {
      if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
      else Reflect.deleteProperty(globalThis, 'navigator');
    }
  });

  it('fails closed when a desktop bridge exists without its clipboard API', async () => {
    const clipboard = bridge.clipboard;
    Object.defineProperty(bridge, 'clipboard', { configurable: true, value: undefined });

    try {
      await expect(readClipboardText()).rejects.toThrow('Desktop clipboard is unavailable.');
      await expect(writeClipboardText('synthetic')).rejects.toThrow(
        'Desktop clipboard is unavailable.',
      );
    } finally {
      Object.defineProperty(bridge, 'clipboard', { configurable: true, value: clipboard });
    }
  });

  it('surfaces native read errors without using the renderer clipboard', async () => {
    const rendererRead = vi.fn<() => Promise<string>>().mockResolvedValue('stale renderer text');
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { readText: rendererRead } },
    });
    bridge.clipboard.readText.mockRejectedValue(new Error('native read failed'));

    try {
      await expect(readClipboardText()).rejects.toThrow('native read failed');
      expect(rendererRead).not.toHaveBeenCalled();
    } finally {
      if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
      else Reflect.deleteProperty(globalThis, 'navigator');
    }
  });

  it('surfaces a rejected native write result without using the renderer clipboard', async () => {
    const rendererWrite = vi.fn<() => Promise<void>>().mockResolvedValue();
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText: rendererWrite } },
    });
    bridge.clipboard.writeText.mockResolvedValue(false);

    try {
      await expect(writeClipboardText('synthetic')).rejects.toThrow(
        'Could not write to the system clipboard.',
      );
      expect(rendererWrite).not.toHaveBeenCalled();
    } finally {
      if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
      else Reflect.deleteProperty(globalThis, 'navigator');
    }
  });

  it('surfaces native grid read errors without using the renderer clipboard', async () => {
    const rendererRead = vi.fn<() => Promise<string>>().mockResolvedValue('stale renderer text');
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { readText: rendererRead } },
    });
    bridge.clipboard.readGrid.mockRejectedValue(new Error('native grid read failed'));

    try {
      await expect(readGridClipboard()).rejects.toThrow('native grid read failed');
      expect(rendererRead).not.toHaveBeenCalled();
    } finally {
      if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
      else Reflect.deleteProperty(globalThis, 'navigator');
    }
  });
});
