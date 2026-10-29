import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const webClipboard = vi.hoisted(() => ({
  readText: vi.fn<() => Promise<string>>(),
  writeText: vi.fn<(text: string) => Promise<void>>(),
}));

vi.mock('./desktop', () => ({ desktop: null }));

import { readClipboardText, readGridClipboard, writeClipboardText } from './clipboard';

describe('browser clipboard fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('navigator', { clipboard: webClipboard });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the browser API only when the desktop bridge is absent', async () => {
    webClipboard.readText.mockResolvedValue('external text');
    webClipboard.writeText.mockResolvedValue(undefined);

    await expect(readClipboardText()).resolves.toBe('external text');
    await expect(readGridClipboard()).resolves.toEqual({
      text: 'external text',
      hasGridPayload: false,
      gridPayloadJson: null,
    });
    await expect(writeClipboardText('synthetic text')).resolves.toBeUndefined();
    expect(webClipboard.writeText).toHaveBeenCalledWith('synthetic text');
  });

  it('surfaces a missing browser clipboard API', async () => {
    vi.stubGlobal('navigator', { clipboard: undefined });
    await expect(readClipboardText()).rejects.toThrow('System clipboard is unavailable.');
    await expect(writeClipboardText('synthetic')).rejects.toThrow('System clipboard is unavailable.');
  });
});
