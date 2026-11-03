import type { MediaResourceRegistry } from './mediaResources.js';

export type ParsedMediaRange =
  { kind: 'ignored' } | { kind: 'unsatisfiable' } | { kind: 'range'; start: number; end: number };

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,48}$/;
const VAULT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseMediaByteRange(header: string | null, size: number): ParsedMediaRange {
  if (header === null) return { kind: 'ignored' };
  if (!Number.isSafeInteger(size) || size < 0) return { kind: 'ignored' };
  const value = header.trim();
  if (!/^bytes=/i.test(value) || value.includes(',')) return { kind: 'ignored' };
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value);
  if (!match) return { kind: 'ignored' };
  const [, first = '', last = ''] = match;
  if (!first && !last) return { kind: 'ignored' };

  try {
    if (!first) {
      const suffix = BigInt(last);
      if (suffix === 0n || size === 0) return { kind: 'unsatisfiable' };
      const length = suffix > BigInt(size) ? BigInt(size) : suffix;
      return { kind: 'range', start: size - Number(length), end: size - 1 };
    }

    const startBig = BigInt(first);
    if (startBig >= BigInt(size)) return { kind: 'unsatisfiable' };
    const start = Number(startBig);
    if (!last) return { kind: 'range', start, end: size - 1 };
    const endBig = BigInt(last);
    if (endBig < startBig) return { kind: 'unsatisfiable' };
    const end = endBig >= BigInt(size) ? size - 1 : Number(endBig);
    return { kind: 'range', start, end };
  } catch {
    return { kind: 'ignored' };
  }
}

export interface MediaProtocolHandlerOptions {
  getRegistry(): MediaResourceRegistry | null;
  authorize(request: Request, vaultId: string, token: string): boolean | Promise<boolean>;
  scheme?: string;
}

function unavailable(): Response {
  return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
}

function mediaHeaders(mimeType: string, length: number): Headers {
  return new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Length': String(length),
    'Content-Type': mimeType,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
}

export function createMediaProtocolHandler(
  options: MediaProtocolHandlerOptions,
): (request: Request) => Promise<Response> {
  const scheme = options.scheme ?? 'morrow-media';
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return unavailable();
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return unavailable();
    }
    if (
      url.protocol !== `${scheme}:` ||
      url.hostname !== 'vault' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return unavailable();

    const parts = url.pathname.slice(1).split('/');
    if (parts.length !== 2) return unavailable();
    const [vaultId, token] = parts;
    if (!vaultId || !VAULT_ID_PATTERN.test(vaultId) || !token || !TOKEN_PATTERN.test(token))
      return unavailable();
    if (!(await options.authorize(request, vaultId, token))) return unavailable();

    const registry = options.getRegistry();
    if (!registry) return unavailable();
    const metadata = await registry.inspect(token, request.signal);
    if (!metadata || request.signal.aborted || !(await options.authorize(request, vaultId, token)))
      return unavailable();

    const range =
      request.method === 'GET'
        ? parseMediaByteRange(request.headers.get('range'), metadata.size)
        : { kind: 'ignored' as const };
    if (range.kind === 'unsatisfiable') {
      const headers = mediaHeaders(metadata.mimeType, 0);
      headers.set('Content-Range', `bytes */${metadata.size}`);
      return new Response(null, { status: 416, headers });
    }

    if (request.method === 'HEAD')
      return new Response(null, { status: 200, headers: mediaHeaders(metadata.mimeType, metadata.size) });

    const start = range.kind === 'range' ? range.start : 0;
    const end = range.kind === 'range' ? range.end : metadata.size - 1;
    const status = range.kind === 'range' ? 206 : 200;
    const length = metadata.size === 0 ? 0 : end - start + 1;
    if (metadata.size === 0) {
      if (range.kind === 'range') {
        const headers = mediaHeaders(metadata.mimeType, 0);
        headers.set('Content-Range', 'bytes */0');
        return new Response(null, { status: 416, headers });
      }
      return new Response(null, { status: 200, headers: mediaHeaders(metadata.mimeType, 0) });
    }

    const opened = await registry.open(token, start, end, request.signal);
    if (!opened || request.signal.aborted) {
      await opened?.body.cancel().catch(() => undefined);
      return unavailable();
    }
    if (!(await options.authorize(request, vaultId, token))) {
      await opened.body.cancel().catch(() => undefined);
      return unavailable();
    }

    const headers = mediaHeaders(opened.mimeType, length);
    if (status === 206) headers.set('Content-Range', `bytes ${start}-${end}/${opened.size}`);
    return new Response(opened.body, { status, headers });
  };
}
