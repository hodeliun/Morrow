import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { mediaFileType } from './mediaFileTypes.js';

export interface MediaVaultContext {
  root: string;
  realRoot: string;
  generation: string | number;
}

export interface MediaResourceMetadata {
  readonly kind: 'audio' | 'video';
  readonly mimeType: string;
  readonly size: number;
}

export interface OpenedMediaResource extends MediaResourceMetadata {
  readonly body: ReadableStream<Uint8Array>;
  readonly start: number;
  readonly end: number;
}

export type MediaResourceIssue =
  | ({ ok: true; token: string } & MediaResourceMetadata)
  | { ok: false; code: 'no-vault' | 'unsupported-type' | 'invalid-resource' | 'file-unavailable' };

export interface MediaResourceRegistry {
  issue(relativePath: unknown): Promise<MediaResourceIssue>;
  inspect(token: unknown, signal?: AbortSignal): Promise<MediaResourceMetadata | null>;
  open(token: unknown, start: number, end: number, signal?: AbortSignal): Promise<OpenedMediaResource | null>;
  release(token: unknown): void;
  clear(): void;
}

interface ValidatedMediaPath extends MediaResourceMetadata {
  readonly path: string;
  readonly realRoot: string;
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
}

interface MediaCapability extends MediaResourceMetadata {
  readonly relativePath: string;
  readonly realRoot: string;
  readonly generation: string | number;
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  availabilityReported: boolean;
}

type MediaResourceFileHandle = Pick<FileHandle, 'stat' | 'close' | 'createReadStream'>;

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

function sameContext(left: MediaVaultContext | null, right: MediaVaultContext): boolean {
  return Boolean(
    left &&
    left.generation === right.generation &&
    path.resolve(left.root) === path.resolve(right.root) &&
    path.resolve(left.realRoot) === path.resolve(right.realRoot),
  );
}

function parseRelativePath(value: unknown): string[] | null {
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
    )
  )
    return null;
  return mediaFileType(segments.at(-1)) ? segments : null;
}

async function validateMediaPath(
  context: MediaVaultContext,
  relativePath: unknown,
): Promise<ValidatedMediaPath | null> {
  const segments = parseRelativePath(relativePath);
  if (!segments) return null;
  const root = path.resolve(context.realRoot);
  const absolute = path.resolve(root, ...segments);
  if (!inside(root, absolute) || absolute === root) return null;

  let cursor = root;
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    let info;
    try {
      info = await lstat(cursor);
    } catch {
      return null;
    }
    if (info.isSymbolicLink()) return null;
    const last = index === segments.length - 1;
    if (last ? !info.isFile() : !info.isDirectory()) return null;
  }

  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    return null;
  }
  if (!inside(root, real)) return null;
  const type = mediaFileType(segments.at(-1));
  if (!type) return null;
  try {
    const info = await lstat(real);
    if (info.isSymbolicLink() || !info.isFile() || !Number.isSafeInteger(info.size) || info.size < 0)
      return null;
    return {
      path: real,
      realRoot: root,
      kind: type.kind,
      mimeType: type.mimeType,
      size: info.size,
      dev: info.dev,
      ino: info.ino,
      mtimeMs: info.mtimeMs,
    };
  } catch {
    return null;
  }
}

function sameFile(left: ValidatedMediaPath, right: ValidatedMediaPath): boolean {
  return (
    left.path === right.path &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.kind === right.kind &&
    left.mimeType === right.mimeType
  );
}

function createClosedBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { name?: unknown; code?: unknown };
  return value.name === 'AbortError' || value.code === 'ABORT_ERR';
}

export function createMediaResourceRegistry(options: {
  getContext: () => MediaVaultContext | null;
  createToken?: () => string;
  openFile?: (filePath: string, flags: number) => Promise<MediaResourceFileHandle>;
  onUnavailable?: (token: string) => void;
}): MediaResourceRegistry {
  const resources = new Map<string, MediaCapability>();
  const streams = new Map<string, Set<Readable>>();
  const current = () => options.getContext();
  const openFile = options.openFile ?? ((filePath, flags) => open(filePath, flags));

  function reportUnavailable(
    token: string,
    resource: MediaCapability,
    context: MediaVaultContext,
    signal?: AbortSignal,
  ): void {
    if (
      resource.availabilityReported ||
      resources.get(token) !== resource ||
      !sameContext(current(), context) ||
      signal?.aborted
    )
      return;
    resource.availabilityReported = true;
    try {
      options.onUnavailable?.(token);
    } catch {
      // Availability reporting must not turn a media read failure into a protocol failure.
    }
  }

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

  async function validatedResource(
    token: unknown,
  ): Promise<{ resource: MediaCapability; context: MediaVaultContext; file: ValidatedMediaPath } | null> {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
    const resource = resources.get(token);
    const context = current();
    if (
      !resource ||
      !context ||
      resource.generation !== context.generation ||
      path.resolve(resource.realRoot) !== path.resolve(context.realRoot)
    ) {
      if (resource) releaseToken(token);
      return null;
    }
    const file = await validateMediaPath(context, resource.relativePath);
    if (
      resources.get(token) !== resource ||
      !file ||
      !sameContext(current(), context) ||
      path.resolve(file.realRoot) !== path.resolve(resource.realRoot) ||
      file.dev !== resource.dev ||
      file.ino !== resource.ino ||
      file.size !== resource.size ||
      file.mtimeMs !== resource.mtimeMs ||
      file.mimeType !== resource.mimeType ||
      file.kind !== resource.kind
    ) {
      if (resources.get(token) === resource) releaseToken(token);
      return null;
    }
    return { resource, context, file };
  }

  async function openVerifiedFile(
    token: string,
    validated: { resource: MediaCapability; context: MediaVaultContext; file: ValidatedMediaPath },
    start: number,
    end: number,
    signal?: AbortSignal,
  ): Promise<OpenedMediaResource | null> {
    if (signal?.aborted) return null;
    let handle: MediaResourceFileHandle;
    try {
      handle = await openFile(validated.file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (!isAbortError(error)) reportUnavailable(token, validated.resource, validated.context, signal);
      if (!signal?.aborted && !isAbortError(error) && resources.get(token) === validated.resource)
        releaseToken(token);
      return null;
    }
    try {
      if (signal?.aborted) {
        await handle.close().catch(() => undefined);
        return null;
      }
      let openedInfo;
      try {
        openedInfo = await handle.stat();
      } catch (error) {
        await handle.close().catch(() => undefined);
        if (!isAbortError(error)) reportUnavailable(token, validated.resource, validated.context, signal);
        if (!signal?.aborted && !isAbortError(error) && resources.get(token) === validated.resource)
          releaseToken(token);
        return null;
      }
      if (signal?.aborted) {
        await handle.close().catch(() => undefined);
        return null;
      }
      const afterOpen = await validateMediaPath(validated.context, validated.resource.relativePath);
      if (
        resources.get(token) !== validated.resource ||
        !sameContext(current(), validated.context) ||
        !openedInfo.isFile() ||
        openedInfo.dev !== validated.file.dev ||
        openedInfo.ino !== validated.file.ino ||
        openedInfo.size !== validated.file.size ||
        openedInfo.mtimeMs !== validated.file.mtimeMs ||
        !afterOpen ||
        !sameFile(afterOpen, validated.file)
      ) {
        await handle.close();
        if (resources.get(token) === validated.resource) releaseToken(token);
        return null;
      }
      if (signal?.aborted) {
        await handle.close();
        return null;
      }
      if (validated.file.size === 0) {
        await handle.close();
        return {
          body: createClosedBody(),
          kind: validated.resource.kind,
          mimeType: validated.resource.mimeType,
          size: 0,
          start: 0,
          end: -1,
        };
      }
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        end >= validated.file.size
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
        if (!isAbortError(error)) reportUnavailable(token, validated.resource, validated.context, signal);
        await handle.close().catch(() => undefined);
        if (!signal?.aborted && !isAbortError(error) && resources.get(token) === validated.resource)
          releaseToken(token);
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
        reportUnavailable(token, validated.resource, validated.context, signal);
        if (resources.get(token) === validated.resource) releaseToken(token);
      });

      const openedContext = current();
      if (
        resources.get(token) !== validated.resource ||
        !sameContext(openedContext, validated.context) ||
        signal?.aborted
      ) {
        stream.destroy();
        if (!signal?.aborted && resources.get(token) === validated.resource) releaseToken(token);
        return null;
      }
      return {
        body: Readable.toWeb(stream, {
          strategy: { highWaterMark: STREAM_HIGH_WATER_MARK * 2, size: (chunk) => chunk.byteLength },
        }) as ReadableStream<Uint8Array>,
        kind: validated.resource.kind,
        mimeType: validated.resource.mimeType,
        size: validated.file.size,
        start,
        end,
      };
    } catch (error) {
      await handle.close().catch(() => undefined);
      if (!signal?.aborted && !isAbortError(error) && resources.get(token) === validated.resource)
        releaseToken(token);
      return null;
    }
  }

  return {
    async issue(relativePath) {
      const context = current();
      if (!context) return { ok: false, code: 'no-vault' };
      if (!mediaFileType(typeof relativePath === 'string' ? relativePath.split('/').at(-1) : relativePath))
        return { ok: false, code: 'unsupported-type' };
      const file = await validateMediaPath(context, relativePath);
      if (!file || !sameContext(current(), context)) return { ok: false, code: 'invalid-resource' };
      if (file.size === 0) return { ok: false, code: 'file-unavailable' };
      const token = options.createToken?.() ?? randomBytes(32).toString('base64url');
      if (!TOKEN_PATTERN.test(token) || resources.has(token)) return { ok: false, code: 'invalid-resource' };
      const normalizedPath = (relativePath as string).split('/').join('/');
      const resource: MediaCapability = {
        relativePath: normalizedPath,
        realRoot: context.realRoot,
        generation: context.generation,
        kind: file.kind,
        mimeType: file.mimeType,
        size: file.size,
        dev: file.dev,
        ino: file.ino,
        mtimeMs: file.mtimeMs,
        availabilityReported: false,
      };
      resources.set(token, resource);
      return { ok: true, token, kind: resource.kind, mimeType: resource.mimeType, size: resource.size };
    },

    async inspect(token, signal) {
      if (signal?.aborted) return null;
      const validated = await validatedResource(token);
      if (!validated) return null;
      if (signal?.aborted) return null;
      let handle: MediaResourceFileHandle;
      try {
        handle = await openFile(validated.file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      } catch (error) {
        if (!isAbortError(error))
          reportUnavailable(token as string, validated.resource, validated.context, signal);
        if (!signal?.aborted && !isAbortError(error) && resources.get(token as string) === validated.resource)
          releaseToken(token);
        return null;
      }
      try {
        if (signal?.aborted) return null;
        let openedInfo;
        try {
          openedInfo = await handle.stat();
        } catch (error) {
          if (!isAbortError(error))
            reportUnavailable(token as string, validated.resource, validated.context, signal);
          if (
            !signal?.aborted &&
            !isAbortError(error) &&
            resources.get(token as string) === validated.resource
          )
            releaseToken(token);
          return null;
        }
        if (signal?.aborted) return null;
        const afterOpen = await validateMediaPath(validated.context, validated.resource.relativePath);
        if (
          resources.get(token as string) !== validated.resource ||
          !sameContext(current(), validated.context) ||
          !openedInfo.isFile() ||
          openedInfo.dev !== validated.file.dev ||
          openedInfo.ino !== validated.file.ino ||
          openedInfo.size !== validated.file.size ||
          openedInfo.mtimeMs !== validated.file.mtimeMs ||
          !afterOpen ||
          !sameFile(afterOpen, validated.file)
        ) {
          if (resources.get(token as string) === validated.resource) releaseToken(token);
          return null;
        }
        if (signal?.aborted) return null;
        return {
          kind: validated.resource.kind,
          mimeType: validated.resource.mimeType,
          size: openedInfo.size,
        };
      } catch {
        if (resources.get(token as string) === validated.resource) releaseToken(token);
        return null;
      } finally {
        await handle.close().catch(() => undefined);
      }
    },

    async open(token, start, end, signal) {
      const validated = await validatedResource(token);
      if (!validated) return null;
      return openVerifiedFile(token as string, validated, start, end, signal);
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
