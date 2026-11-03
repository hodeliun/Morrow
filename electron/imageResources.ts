import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';

export interface ImageVaultContext {
  root: string;
  realRoot: string;
  generation: string | number;
}

export interface OpenedImageResource {
  body: ReadableStream<Uint8Array>;
  mimeType: string;
  size: number;
}

export type ImageResourceIssue =
  | { ok: true; token: string; mimeType: string; size: number }
  | { ok: false; code: 'no-vault' | 'vault-changed' | 'invalid-resource' };

export interface ImageResourceRegistry {
  getVaultId(): Promise<string | null>;
  issue(relativePath: unknown, expectedVaultId: unknown): Promise<ImageResourceIssue>;
  release(token: unknown): void;
  clear(): void;
  open(token: unknown): Promise<OpenedImageResource | null>;
}

export const IMAGE_RESOURCE_MIME_TYPES: Readonly<Record<string, string>> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

const MAX_RELATIVE_PATH_LENGTH = 4096;
const MAX_VAULT_ID_FILE_BYTES = 1024 * 1024;
const MAX_STORED_VAULT_IDS = 512;
const VAULT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,48}$/;
const RESERVED_SEGMENTS = new Set(['.morrow', '.git']);

type VaultIdMap = Record<string, string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalRootKey(realRoot: string): string {
  const normalized = path.resolve(realRoot).replace(/[\\/]+$/, '');
  return createHash('sha256')
    .update(process.platform === 'win32' ? normalized.toLowerCase() : normalized)
    .digest('hex');
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

function sameContext(left: ImageVaultContext | null, right: ImageVaultContext): boolean {
  return Boolean(
    left &&
    left.generation === right.generation &&
    path.resolve(left.root) === path.resolve(right.root) &&
    path.resolve(left.realRoot) === path.resolve(right.realRoot),
  );
}

function parseRelativeImagePath(value: unknown): string[] | null {
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
  const extension = path.posix.extname(segments.at(-1)!).slice(1).toLowerCase();
  return Object.hasOwn(IMAGE_RESOURCE_MIME_TYPES, extension) ? segments : null;
}

async function readVaultIdMap(file: string): Promise<VaultIdMap> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_VAULT_ID_FILE_BYTES) return {};
    const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!isRecord(raw)) return {};
    const ids: VaultIdMap = {};
    for (const [key, id] of Object.entries(raw)) {
      if (/^[a-f0-9]{64}$/.test(key) && typeof id === 'string' && VAULT_ID_PATTERN.test(id)) ids[key] = id;
    }
    return ids;
  } catch {
    return {};
  }
}

async function saveVaultIdMap(file: string, map: VaultIdMap): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(map)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function validateImagePath(
  context: ImageVaultContext,
  relativePath: unknown,
): Promise<{ path: string; mimeType: string; size: number; dev: number; ino: number } | null> {
  const segments = parseRelativeImagePath(relativePath);
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
  const extension = path.posix.extname(segments.at(-1)!).slice(1).toLowerCase();
  const mimeType = IMAGE_RESOURCE_MIME_TYPES[extension];
  if (!mimeType) return null;
  try {
    const info = await lstat(real);
    if (info.isSymbolicLink() || !info.isFile()) return null;
    return { path: real, mimeType, size: info.size, dev: info.dev, ino: info.ino };
  } catch {
    return null;
  }
}

export function createImageResourceRegistry(options: {
  getContext: () => ImageVaultContext | null;
  userDataPath: string;
  createToken?: () => string;
  createVaultId?: () => string;
}): ImageResourceRegistry {
  const vaultIdFile = path.join(options.userDataPath, 'image-viewer-vaults.json');
  const resources = new Map<
    string,
    { relativePath: string; realRoot: string; generation: string | number; mimeType: string }
  >();
  const streams = new Map<string, Set<Readable>>();
  const idReads = new Map<string, Promise<string | null>>();
  let storedIds: Promise<VaultIdMap> | null = null;
  let idSaveQueue: Promise<void> = Promise.resolve();

  const current = () => options.getContext();

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

  async function vaultIdFor(context: ImageVaultContext): Promise<string | null> {
    const key = canonicalRootKey(context.realRoot);
    const existing = idReads.get(key);
    if (existing) return existing;
    const pending = (async () => {
      storedIds ??= readVaultIdMap(vaultIdFile);
      const ids = await storedIds;
      let id = ids[key];
      if (!id) {
        id = options.createVaultId?.() ?? randomUUID();
        if (!VAULT_ID_PATTERN.test(id)) return null;
        const createdId = id;
        const save = idSaveQueue.then(async () => {
          const latest = await readVaultIdMap(vaultIdFile);
          const resolvedId = latest[key] ?? createdId;
          const entries = Object.entries(latest).filter(([entryKey]) => entryKey !== key);
          const bounded = Object.fromEntries(
            [...entries, [key, resolvedId]].slice(-MAX_STORED_VAULT_IDS),
          ) as VaultIdMap;
          await saveVaultIdMap(vaultIdFile, bounded);
          storedIds = Promise.resolve(bounded);
          return resolvedId;
        });
        idSaveQueue = save.then(
          () => undefined,
          () => undefined,
        );
        id = await save;
      }
      return id;
    })().catch(() => null);
    idReads.set(key, pending);
    return pending;
  }

  return {
    async getVaultId() {
      const context = current();
      if (!context) return null;
      const id = await vaultIdFor(context);
      return sameContext(current(), context) ? id : null;
    },

    async issue(relativePath, expectedVaultId) {
      const context = current();
      if (!context) return { ok: false, code: 'no-vault' };
      const vaultId = await vaultIdFor(context);
      if (!sameContext(current(), context)) return { ok: false, code: 'vault-changed' };
      if (!vaultId || expectedVaultId !== vaultId) return { ok: false, code: 'vault-changed' };
      const file = await validateImagePath(context, relativePath);
      if (!file || !sameContext(current(), context)) return { ok: false, code: 'invalid-resource' };
      const token = options.createToken?.() ?? randomBytes(32).toString('base64url');
      if (!TOKEN_PATTERN.test(token) || resources.has(token)) return { ok: false, code: 'invalid-resource' };
      const normalizedPath = (relativePath as string).split('/').join('/');
      resources.set(token, {
        relativePath: normalizedPath,
        realRoot: context.realRoot,
        generation: context.generation,
        mimeType: file.mimeType,
      });
      return { ok: true, token, mimeType: file.mimeType, size: file.size };
    },

    release(token) {
      releaseToken(token);
    },

    clear() {
      for (const token of streams.keys()) stopStreams(token);
      resources.clear();
    },

    async open(token) {
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

      const file = await validateImagePath(context, resource.relativePath);
      if (
        resources.get(token) !== resource ||
        !file ||
        file.mimeType !== resource.mimeType ||
        !sameContext(current(), context)
      ) {
        if (resources.get(token) === resource) releaseToken(token);
        return null;
      }
      let handle: FileHandle | null = null;
      try {
        handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const openedInfo = await handle.stat();
        if (resources.get(token) !== resource || !sameContext(current(), context)) {
          await handle.close();
          return null;
        }
        const afterOpen = await validateImagePath(context, resource.relativePath);
        if (
          resources.get(token) !== resource ||
          !openedInfo.isFile() ||
          !afterOpen ||
          afterOpen.mimeType !== resource.mimeType ||
          openedInfo.dev !== afterOpen.dev ||
          openedInfo.ino !== afterOpen.ino ||
          openedInfo.size !== afterOpen.size ||
          !sameContext(current(), context)
        ) {
          await handle.close();
          if (resources.get(token) === resource) releaseToken(token);
          return null;
        }
        const stream = handle.createReadStream({ autoClose: true, highWaterMark: 64 * 1024 });
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
        stream.once('error', forget);
        return {
          body: Readable.toWeb(stream, {
            strategy: { highWaterMark: 128 * 1024, size: (chunk) => chunk.byteLength },
          }) as ReadableStream<Uint8Array>,
          mimeType: resource.mimeType,
          size: openedInfo.size,
        };
      } catch {
        await handle?.close().catch(() => undefined);
        if (resources.get(token) === resource) releaseToken(token);
        return null;
      }
    },
  };
}
