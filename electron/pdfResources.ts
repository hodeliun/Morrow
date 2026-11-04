import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { parseMediaByteRange } from './mediaProtocol.js';
import type { MediaVaultContext } from './mediaResources.js';

export interface PdfVaultContext extends MediaVaultContext {
  readonly vaultId: string;
}

export interface PdfResourceMetadata {
  readonly mimeType: 'application/pdf';
  readonly size: number;
}

export interface OpenedPdfResource extends PdfResourceMetadata {
  readonly body: ReadableStream<Uint8Array>;
  readonly start: number;
  readonly end: number;
}

export type PdfResourceIssue =
  | ({ readonly ok: true; readonly token: string } & PdfResourceMetadata)
  | {
      readonly ok: false;
      readonly code:
        'no-vault' | 'vault-changed' | 'unsupported-type' | 'invalid-resource' | 'file-unavailable';
    };

export interface PdfResourceRegistry {
  issue(relativePath: unknown, expectedVaultId: unknown): Promise<PdfResourceIssue>;
  inspect(token: unknown, signal?: AbortSignal): Promise<PdfResourceMetadata | null>;
  open(token: unknown, start: number, end: number, signal?: AbortSignal): Promise<OpenedPdfResource | null>;
  release(token: unknown): void;
  clear(): void;
}

export interface PdfProtocolHandlerOptions {
  readonly getRegistry: () => PdfResourceRegistry | null;
  readonly authorize?: (request: Request, token: string) => boolean | Promise<boolean>;
  readonly scheme?: string;
}

type PdfHandle = Pick<FileHandle, 'stat' | 'close' | 'createReadStream'>;

interface PdfFileIdentity extends PdfResourceMetadata {
  readonly path: string;
  readonly realRoot: string;
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
}

interface PdfCapability extends PdfResourceMetadata {
  readonly relativePath: string;
  readonly realRoot: string;
  readonly generation: string | number;
  readonly vaultId: string;
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  unavailableReported: boolean;
}

const PDF_MIME = 'application/pdf' as const;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,48}$/;
const MAX_RELATIVE_PATH_LENGTH = 4096;
const RESERVED_SEGMENTS = new Set(['.morrow', '.git']);
const STREAM_HIGH_WATER_MARK = 64 * 1024;

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

function sameContext(left: PdfVaultContext | null, right: PdfVaultContext): boolean {
  return Boolean(
    left &&
    left.vaultId === right.vaultId &&
    left.generation === right.generation &&
    path.resolve(left.root) === path.resolve(right.root) &&
    path.resolve(left.realRoot) === path.resolve(right.realRoot),
  );
}

function parseRelativePdfPath(value: unknown): string[] | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_RELATIVE_PATH_LENGTH ||
    value.includes('\0') ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  )
    return null;
  const segments = value.split('/');
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.includes(':') ||
        RESERVED_SEGMENTS.has(segment.toLowerCase()) ||
        segment.toLowerCase().startsWith('.morrow-tmp-'),
    ) ||
    path.posix.extname(segments.at(-1)!).toLowerCase() !== '.pdf'
  )
    return null;
  return segments;
}

function unavailableCode(error: unknown): 'invalid-resource' | 'file-unavailable' {
  if (!error || typeof error !== 'object') return 'file-unavailable';
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ELOOP' || code === 'ENOTDIR' ? 'invalid-resource' : 'file-unavailable';
}

async function validatePdfPath(
  context: PdfVaultContext,
  relativePath: unknown,
): Promise<
  | { readonly ok: true; readonly file: PdfFileIdentity }
  | { readonly ok: false; readonly code: 'invalid-resource' | 'file-unavailable' }
> {
  const segments = parseRelativePdfPath(relativePath);
  if (!segments || !context.vaultId || !context.realRoot) return { ok: false, code: 'invalid-resource' };
  const root = path.resolve(context.realRoot);
  const absolute = path.resolve(root, ...segments);
  if (!inside(root, absolute) || absolute === root) return { ok: false, code: 'invalid-resource' };

  let cursor = root;
  try {
    for (const [index, segment] of segments.entries()) {
      cursor = path.join(cursor, segment);
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) return { ok: false, code: 'invalid-resource' };
      const last = index === segments.length - 1;
      if (last ? !info.isFile() : !info.isDirectory()) return { ok: false, code: 'invalid-resource' };
    }
    const resolvedRoot = await realpath(root);
    const resolvedFile = await realpath(absolute);
    if (!inside(resolvedRoot, resolvedFile)) return { ok: false, code: 'invalid-resource' };
    const info = await lstat(resolvedFile);
    if (info.isSymbolicLink() || !info.isFile()) return { ok: false, code: 'invalid-resource' };
    if (!Number.isSafeInteger(info.size) || info.size <= 0) return { ok: false, code: 'file-unavailable' };
    return {
      ok: true,
      file: {
        path: resolvedFile,
        realRoot: resolvedRoot,
        mimeType: PDF_MIME,
        size: info.size,
        dev: info.dev,
        ino: info.ino,
        mtimeMs: info.mtimeMs,
      },
    };
  } catch (error) {
    return { ok: false, code: unavailableCode(error) };
  }
}

function sameFile(left: PdfFileIdentity, right: PdfFileIdentity): boolean {
  return (
    left.path === right.path &&
    left.realRoot === right.realRoot &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.mimeType === right.mimeType
  );
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    ((error as { name?: unknown }).name === 'AbortError' ||
      (error as { code?: unknown }).code === 'ABORT_ERR'),
  );
}

export function createPdfResourceRegistry(options: {
  readonly getContext: () => PdfVaultContext | null;
  readonly createToken?: () => string;
  readonly openFile?: (filePath: string, flags: number) => Promise<PdfHandle>;
  readonly onUnavailable?: (token: string) => void;
}): PdfResourceRegistry {
  const resources = new Map<string, PdfCapability>();
  const streams = new Map<string, Set<Readable>>();
  const current = () => options.getContext();
  const openFile = options.openFile ?? ((filePath, flags) => open(filePath, flags));

  function stopStreams(token: string): void {
    const active = streams.get(token);
    streams.delete(token);
    for (const stream of active ?? []) stream.destroy();
  }

  function releaseToken(token: unknown): void {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return;
    resources.delete(token);
    stopStreams(token);
  }

  function reportUnavailable(
    token: string,
    resource: PdfCapability,
    context: PdfVaultContext,
    signal?: AbortSignal,
  ): void {
    if (
      resource.unavailableReported ||
      resources.get(token) !== resource ||
      !sameContext(current(), context) ||
      signal?.aborted
    )
      return;
    resource.unavailableReported = true;
    try {
      options.onUnavailable?.(token);
    } catch {
      /* Status reporting cannot fail the response. */
    }
  }

  async function validated(
    token: unknown,
  ): Promise<{
    readonly resource: PdfCapability;
    readonly context: PdfVaultContext;
    readonly file: PdfFileIdentity;
  } | null> {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
    const resource = resources.get(token);
    const context = current();
    if (
      !resource ||
      !context ||
      !sameContext(context, {
        root: context.root,
        realRoot: resource.realRoot,
        generation: resource.generation,
        vaultId: resource.vaultId,
      })
    ) {
      if (resource) releaseToken(token);
      return null;
    }
    const check = await validatePdfPath(context, resource.relativePath);
    if (!check.ok) {
      if (check.code === 'file-unavailable') reportUnavailable(token, resource, context);
      if (resources.get(token) === resource) releaseToken(token);
      return null;
    }
    if (
      resources.get(token) !== resource ||
      !sameContext(current(), context) ||
      check.file.dev !== resource.dev ||
      check.file.ino !== resource.ino ||
      check.file.size !== resource.size ||
      check.file.mtimeMs !== resource.mtimeMs ||
      check.file.realRoot !== resource.realRoot
    ) {
      if (resources.get(token) === resource) releaseToken(token);
      return null;
    }
    return { resource, context, file: check.file };
  }

  async function verifyOpenedHandle(
    token: string,
    state: {
      readonly resource: PdfCapability;
      readonly context: PdfVaultContext;
      readonly file: PdfFileIdentity;
    },
    handle: PdfHandle,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    const stat = await handle.stat();
    const afterOpen = await validatePdfPath(state.context, state.resource.relativePath);
    return Boolean(
      !signal?.aborted &&
      resources.get(token) === state.resource &&
      sameContext(current(), state.context) &&
      stat.isFile() &&
      stat.dev === state.file.dev &&
      stat.ino === state.file.ino &&
      stat.size === state.file.size &&
      stat.mtimeMs === state.file.mtimeMs &&
      afterOpen.ok &&
      sameFile(afterOpen.file, state.file),
    );
  }

  async function openVerified(
    token: string,
    state: {
      readonly resource: PdfCapability;
      readonly context: PdfVaultContext;
      readonly file: PdfFileIdentity;
    },
    start: number,
    end: number,
    signal?: AbortSignal,
  ): Promise<OpenedPdfResource | null> {
    if (signal?.aborted) return null;
    let handle: PdfHandle;
    try {
      handle = await openFile(state.file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (!isAbortError(error)) reportUnavailable(token, state.resource, state.context, signal);
      if (!signal?.aborted && resources.get(token) === state.resource) releaseToken(token);
      return null;
    }
    try {
      if (!(await verifyOpenedHandle(token, state, handle, signal))) {
        await handle.close().catch(() => undefined);
        if (!signal?.aborted && resources.get(token) === state.resource) releaseToken(token);
        return null;
      }
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        end >= state.file.size
      ) {
        await handle.close();
        return null;
      }
      let stream: Readable;
      try {
        stream = handle.createReadStream({
          autoClose: true,
          start,
          end,
          highWaterMark: STREAM_HIGH_WATER_MARK,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        await handle.close().catch(() => undefined);
        if (!isAbortError(error)) reportUnavailable(token, state.resource, state.context, signal);
        if (!signal?.aborted && resources.get(token) === state.resource) releaseToken(token);
        return null;
      }
      const active = streams.get(token) ?? new Set<Readable>();
      active.add(stream);
      streams.set(token, active);
      const forget = () => {
        const currentStreams = streams.get(token);
        currentStreams?.delete(stream);
        if (currentStreams?.size === 0) streams.delete(token);
      };
      stream.once('close', forget);
      stream.once('end', forget);
      stream.once('error', (error) => {
        forget();
        if (isAbortError(error) || signal?.aborted) return;
        reportUnavailable(token, state.resource, state.context, signal);
        if (resources.get(token) === state.resource) releaseToken(token);
      });
      if (
        resources.get(token) !== state.resource ||
        !sameContext(current(), state.context) ||
        signal?.aborted
      ) {
        stream.destroy();
        return null;
      }
      return {
        body: Readable.toWeb(stream, {
          strategy: { highWaterMark: STREAM_HIGH_WATER_MARK * 2, size: (chunk) => chunk.byteLength },
        }) as ReadableStream<Uint8Array>,
        mimeType: PDF_MIME,
        size: state.file.size,
        start,
        end,
      };
    } catch (error) {
      await handle.close().catch(() => undefined);
      if (!signal?.aborted && !isAbortError(error) && resources.get(token) === state.resource)
        releaseToken(token);
      return null;
    }
  }

  return {
    async issue(relativePath, expectedVaultId) {
      const context = current();
      if (!context) return { ok: false, code: 'no-vault' };
      if (typeof expectedVaultId !== 'string' || expectedVaultId !== context.vaultId)
        return { ok: false, code: 'vault-changed' };
      if (
        typeof relativePath === 'string' &&
        path.posix.extname(relativePath.split('/').at(-1) ?? '').toLowerCase() !== '.pdf'
      )
        return { ok: false, code: 'unsupported-type' };
      const checked = await validatePdfPath(context, relativePath);
      if (!checked.ok) return { ok: false, code: checked.code };
      if (!sameContext(current(), context)) return { ok: false, code: 'vault-changed' };
      let handle: PdfHandle;
      try {
        handle = await openFile(checked.file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      } catch {
        return { ok: false, code: 'file-unavailable' };
      }
      let verified: boolean;
      try {
        const stat = await handle.stat();
        const afterOpen = await validatePdfPath(context, relativePath);
        verified =
          sameContext(current(), context) &&
          stat.isFile() &&
          stat.dev === checked.file.dev &&
          stat.ino === checked.file.ino &&
          stat.size === checked.file.size &&
          stat.mtimeMs === checked.file.mtimeMs &&
          afterOpen.ok &&
          sameFile(afterOpen.file, checked.file);
      } catch {
        verified = false;
      } finally {
        await handle.close().catch(() => undefined);
      }
      if (!verified)
        return { ok: false, code: sameContext(current(), context) ? 'file-unavailable' : 'vault-changed' };
      const token = options.createToken?.() ?? randomBytes(32).toString('base64url');
      if (!TOKEN_PATTERN.test(token) || resources.has(token)) return { ok: false, code: 'invalid-resource' };
      resources.set(token, {
        relativePath: (relativePath as string).split('/').join('/'),
        realRoot: checked.file.realRoot,
        generation: context.generation,
        vaultId: context.vaultId,
        mimeType: PDF_MIME,
        size: checked.file.size,
        dev: checked.file.dev,
        ino: checked.file.ino,
        mtimeMs: checked.file.mtimeMs,
        unavailableReported: false,
      });
      return { ok: true, token, mimeType: PDF_MIME, size: checked.file.size };
    },

    async inspect(token, signal) {
      if (signal?.aborted) return null;
      const state = await validated(token);
      if (!state || signal?.aborted) return null;
      let handle: PdfHandle;
      try {
        handle = await openFile(state.file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      } catch (error) {
        if (!isAbortError(error)) reportUnavailable(token as string, state.resource, state.context, signal);
        if (!signal?.aborted) releaseToken(token);
        return null;
      }
      try {
        if (!(await verifyOpenedHandle(token as string, state, handle, signal))) return null;
        return { mimeType: PDF_MIME, size: state.file.size };
      } catch {
        return null;
      } finally {
        await handle.close().catch(() => undefined);
      }
    },

    async open(token, start, end, signal) {
      if (signal?.aborted) return null;
      const state = await validated(token);
      if (!state || signal?.aborted) return null;
      return openVerified(token as string, state, start, end, signal);
    },

    release(token) {
      releaseToken(token);
    },

    clear() {
      for (const token of streams.keys()) stopStreams(token);
      resources.clear();
    },
  };
}

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
}

function pdfHeaders(length: number): Headers {
  return new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Length': String(length),
    'Content-Type': PDF_MIME,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
}

export function createPdfProtocolHandler(
  options: PdfProtocolHandlerOptions,
): (request: Request) => Promise<Response> {
  const scheme = options.scheme ?? 'morrow-pdf';
  return async (request) => {
    if ((request.method !== 'GET' && request.method !== 'HEAD') || request.signal.aborted) return notFound();
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return notFound();
    }
    if (
      url.protocol !== `${scheme}:` ||
      url.hostname !== 'document' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return notFound();
    const parts = url.pathname.slice(1).split('/');
    if (parts.length !== 2 || !TOKEN_PATTERN.test(parts[0] ?? '') || parts[1] !== 'selected.pdf')
      return notFound();
    const token = parts[0]!;
    if (options.authorize && !(await options.authorize(request, token))) return notFound();
    const registry = options.getRegistry();
    if (!registry) return notFound();
    const metadata = await registry.inspect(token, request.signal);
    if (
      !metadata ||
      request.signal.aborted ||
      (options.authorize && !(await options.authorize(request, token)))
    )
      return notFound();
    const range =
      request.method === 'GET'
        ? parseMediaByteRange(request.headers.get('range'), metadata.size)
        : { kind: 'ignored' as const };
    if (range.kind === 'unsatisfiable') {
      const headers = pdfHeaders(0);
      headers.set('Content-Range', `bytes */${metadata.size}`);
      return new Response(null, { status: 416, headers });
    }
    if (request.method === 'HEAD')
      return new Response(null, { status: 200, headers: pdfHeaders(metadata.size) });
    const start = range.kind === 'range' ? range.start : 0;
    const end = range.kind === 'range' ? range.end : metadata.size - 1;
    const opened = await registry.open(token, start, end, request.signal);
    if (
      !opened ||
      request.signal.aborted ||
      (options.authorize && !(await options.authorize(request, token)))
    ) {
      await opened?.body.cancel().catch(() => undefined);
      return notFound();
    }
    const partial = range.kind === 'range';
    const headers = pdfHeaders(partial ? end - start + 1 : opened.size);
    if (partial) headers.set('Content-Range', `bytes ${start}-${end}/${opened.size}`);
    return new Response(opened.body, { status: partial ? 206 : 200, headers });
  };
}
