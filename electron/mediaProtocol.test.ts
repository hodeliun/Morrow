import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMediaProtocolHandler, parseMediaByteRange } from './mediaProtocol.js';
import { createMediaResourceRegistry } from './mediaResources.js';
import type { MediaResourceRegistry, MediaVaultContext } from './mediaResources.js';

const VAULT_ID = 'd4a1b5b5-55d4-4eb3-9c67-0a86191ac120';
const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const URL = `morrow-media://vault/${VAULT_ID}/${TOKEN}`;
const CONTENT = new TextEncoder().encode('0123456789');

function registrySpy() {
  const calls: Array<{ token: unknown; start: number; end: number; signal?: AbortSignal }> = [];
  const inspectSignals: AbortSignal[] = [];
  const registry = {
    issue: async () => ({ ok: false as const, code: 'invalid-resource' as const }),
    inspect: async (_token: unknown, signal?: AbortSignal) => {
      if (signal) inspectSignals.push(signal);
      return { kind: 'video' as const, mimeType: 'video/webm', size: CONTENT.byteLength };
    },
    open: async (token: unknown, start: number, end: number, signal?: AbortSignal) => {
      calls.push({ token, start, end, signal });
      const chunk = CONTENT.slice(start, end + 1);
      return {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(chunk);
            controller.close();
          },
        }),
        kind: 'video' as const,
        mimeType: 'video/webm',
        size: CONTENT.byteLength,
        start,
        end,
      };
    },
    release() {},
    clear() {},
  } satisfies MediaResourceRegistry;
  return { registry, calls, inspectSignals };
}

function createHandler(overrides: Partial<Parameters<typeof createMediaProtocolHandler>[0]> = {}) {
  const { registry, calls, inspectSignals } = registrySpy();
  const authorizations: Array<{ url: string; vaultId: string; token: string }> = [];
  let allowed = true;
  const handler = createMediaProtocolHandler({
    getRegistry: () => registry,
    authorize(request, vaultId, token) {
      authorizations.push({ url: request.url, vaultId, token });
      return allowed;
    },
    ...overrides,
  });
  return {
    handler,
    calls,
    inspectSignals,
    authorizations,
    setAllowed(value: boolean) {
      allowed = value;
    },
  };
}

async function text(response: Response): Promise<string> {
  return new TextDecoder().decode(await response.arrayBuffer());
}

describe('media byte ranges', () => {
  it('supports explicit, open-ended, and suffix byte ranges and clamps the end', () => {
    expect(parseMediaByteRange('bytes=2-5', 10)).toEqual({ kind: 'range', start: 2, end: 5 });
    expect(parseMediaByteRange('bytes=7-', 10)).toEqual({ kind: 'range', start: 7, end: 9 });
    expect(parseMediaByteRange('bytes=-4', 10)).toEqual({ kind: 'range', start: 6, end: 9 });
    expect(parseMediaByteRange('bytes=2-200', 10)).toEqual({ kind: 'range', start: 2, end: 9 });
    expect(parseMediaByteRange('bytes=-200', 10)).toEqual({ kind: 'range', start: 0, end: 9 });
  });

  it('returns 416 classification for valid but impossible ranges', () => {
    expect(parseMediaByteRange('bytes=10-', 10)).toEqual({ kind: 'unsatisfiable' });
    expect(parseMediaByteRange('bytes=7-2', 10)).toEqual({ kind: 'unsatisfiable' });
    expect(parseMediaByteRange('bytes=-0', 10)).toEqual({ kind: 'unsatisfiable' });
    expect(parseMediaByteRange('bytes=0-0', 0)).toEqual({ kind: 'unsatisfiable' });
  });

  it('ignores unknown, malformed, and multipart range headers', () => {
    for (const header of [null, 'items=0-1', 'bytes=', 'bytes=one-two', 'bytes=0-1,4-5'])
      expect(parseMediaByteRange(header, 10)).toEqual({ kind: 'ignored' });
  });
});

describe('media protocol response', () => {
  it('streams selected bytes from a real synthetic vault file without changing it', async () => {
    const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'morrow-media-protocol-')));
    const file = path.join(root, 'Audio', 'sample.wav');
    mkdirSync(path.dirname(file), { recursive: true });
    const original = Buffer.from('synthetic-wav-payload');
    writeFileSync(file, original);
    const context: MediaVaultContext = { root, realRoot: root, generation: 'protocol-test' };
    const registry = createMediaResourceRegistry({ getContext: () => context });
    try {
      const issued = await registry.issue('Audio/sample.wav');
      if (!issued.ok) throw new Error('Expected a selected media file.');
      const handler = createMediaProtocolHandler({
        getRegistry: () => registry,
        authorize: (_request, vaultId, token) => vaultId === VAULT_ID && token === issued.token,
      });
      const response = await handler(
        new Request(`morrow-media://vault/${VAULT_ID}/${issued.token}`, {
          headers: { Range: 'bytes=4-9' },
        }),
      );
      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe(`bytes 4-9/${original.length}`);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(original.subarray(4, 10));
      expect(readFileSync(file)).toEqual(original);
    } finally {
      registry.clear();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('streams a single requested range as 206 with exact byte headers', async () => {
    const { handler, calls } = createHandler();
    const response = await handler(new Request(URL, { headers: { Range: 'bytes=3-6' } }));
    expect(response.status).toBe(206);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-type')).toBe('video/webm');
    expect(response.headers.get('content-length')).toBe('4');
    expect(response.headers.get('content-range')).toBe('bytes 3-6/10');
    expect(await text(response)).toBe('3456');
    expect(calls).toEqual([{ token: TOKEN, start: 3, end: 6, signal: expect.any(AbortSignal) }]);
  });

  it('returns a bodyless HEAD with metadata and never opens a stream', async () => {
    const { handler, calls } = createHandler();
    const response = await handler(new Request(URL, { method: 'HEAD', headers: { Range: 'bytes=1-2' } }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('10');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.body).toBeNull();
    expect(calls).toEqual([]);
  });

  it('returns 416 and a wildcard content range for a valid unsatisfiable range', async () => {
    const { handler, calls } = createHandler();
    const response = await handler(new Request(URL, { headers: { Range: 'bytes=10-' } }));
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */10');
    expect(response.headers.get('content-length')).toBe('0');
    expect(response.body).toBeNull();
    expect(calls).toEqual([]);
  });

  it('ignores malformed and multipart ranges while keeping the response streamed', async () => {
    for (const range of ['bytes=bad', 'units=0-1', 'bytes=0-1,4-5']) {
      const { handler, calls } = createHandler();
      const response = await handler(new Request(URL, { headers: { Range: range } }));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-length')).toBe('10');
      expect(response.headers.get('content-range')).toBeNull();
      expect(await text(response)).toBe('0123456789');
      expect(calls).toMatchObject([{ start: 0, end: 9 }]);
    }
  });

  it('streams a full response when no Range header is present', async () => {
    const { handler, calls } = createHandler();
    const response = await handler(new Request(URL));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('10');
    expect(await text(response)).toBe('0123456789');
    expect(calls).toMatchObject([{ start: 0, end: 9 }]);
  });

  it('checks current authorization before metadata, after metadata, and after opening', async () => {
    const { handler, calls, setAllowed, authorizations } = createHandler();
    setAllowed(false);
    const denied = await handler(new Request(URL));
    expect(denied.status).toBe(404);
    expect(calls).toEqual([]);
    expect(authorizations).toHaveLength(1);

    let checks = 0;
    const staleAfterMetadata = createHandler({
      authorize() {
        checks += 1;
        return checks === 1;
      },
    });
    const metadataDenied = await staleAfterMetadata.handler(new Request(URL));
    expect(metadataDenied.status).toBe(404);
    expect(staleAfterMetadata.calls).toEqual([]);

    checks = 0;
    const staleAfterOpen = createHandler({
      authorize() {
        checks += 1;
        return checks < 3;
      },
    });
    const openedDenied = await staleAfterOpen.handler(new Request(URL));
    expect(openedDenied.status).toBe(404);
    expect(staleAfterOpen.calls).toHaveLength(1);
  });

  it('passes the request cancellation signal to the byte stream', async () => {
    const { handler, calls, inspectSignals } = createHandler();
    const controller = new AbortController();
    const request = new Request(URL, { signal: controller.signal });
    await handler(request);
    expect(calls).toHaveLength(1);
    expect(inspectSignals).toHaveLength(1);
    expect(inspectSignals[0]).toBe(request.signal);
    expect(calls[0]?.signal?.aborted).toBe(false);
    controller.abort();
    expect(calls[0]?.signal?.aborted).toBe(true);
  });

  it('rejects paths, methods, credentials, query strings and foreign vault identifiers', async () => {
    const { handler, calls } = createHandler();
    const credentials = new Request(URL);
    Object.defineProperty(credentials, 'url', {
      value: `morrow-media://user@vault/${VAULT_ID}/${TOKEN}`,
    });
    for (const invalid of [
      `morrow-media://vault/${VAULT_ID}/${TOKEN}/extra`,
      `morrow-media://vault/${VAULT_ID}/bad`,
      `morrow-media://vault/${VAULT_ID}/${TOKEN}?download=1`,
      `morrow-media://vault/${VAULT_ID}/${TOKEN}#fragment`,
      `morrow-media://vault.evil/${VAULT_ID}/${TOKEN}`,
    ])
      expect((await handler(new Request(invalid))).status).toBe(404);
    expect((await handler(credentials)).status).toBe(404);
    expect((await handler(new Request(URL, { method: 'POST' }))).status).toBe(404);
    expect(calls).toEqual([]);
  });
});
