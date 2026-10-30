import { describe, expect, it, vi } from 'vitest';
import { readBoundedImage } from './imageFetch.js';

describe('bounded pasted images', () => {
  it('reads a complete image within the limit', async () => {
    const response = new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-type': 'image/png; charset=binary' },
    });
    const image = await readBoundedImage(response, 3);
    expect(image?.type).toBe('image/png');
    expect(image && [...new Uint8Array(image.data)]).toEqual([1, 2, 3]);
  });

  it.each([undefined, '1'])('cancels oversized chunked images despite content-length %s', async (length) => {
    const cancel = vi.fn();
    let pull = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pull++;
          controller.enqueue(new Uint8Array([1, 2]));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const response = new Response(body, {
      headers: { 'content-type': 'image/png', ...(length ? { 'content-length': length } : {}) },
    });
    expect(await readBoundedImage(response, 3)).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
    expect(pull).toBe(2);
  });

  it('cancels rejected MIME types and advertised oversize without consuming them', async () => {
    const rejectedHeaders: Record<string, string>[] = [
      { 'content-type': 'text/html' },
      { 'content-type': 'image/png', 'content-length': '4' },
    ];
    for (const headers of rejectedHeaders) {
      const pull = vi.fn();
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
      expect(await readBoundedImage(new Response(body, { headers }), 3)).toBeNull();
      expect(pull).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
    }
  });
});
