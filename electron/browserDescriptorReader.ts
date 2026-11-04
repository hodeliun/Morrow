import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

export const MAX_BROWSER_DESCRIPTOR_BYTES = 64 * 1024;

export interface BrowserDescriptorVaultContext {
  readonly root: string;
  readonly realRoot: string;
  readonly generation: number;
}

export interface BrowserDescriptorFileSystem {
  lstat(location: string): Promise<Stats>;
  realpath(location: string): Promise<string>;
  open(location: string, flags: number): Promise<BrowserDescriptorOpenFile>;
}

export interface BrowserDescriptorOpenFile {
  stat(): Promise<Stats>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number; buffer: Buffer }>;
  close(): Promise<void>;
}

const nodeFileSystem: BrowserDescriptorFileSystem = { lstat, realpath, open };

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function sameContext(expected: BrowserDescriptorVaultContext, current: BrowserDescriptorVaultContext | null): boolean {
  return Boolean(
    current &&
      expected.generation === current.generation &&
      path.resolve(expected.root) === path.resolve(current.root) &&
      path.resolve(expected.realRoot) === path.resolve(current.realRoot),
  );
}

function sameFile(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

async function validatedPathStat(
  root: string,
  candidate: string,
  fileSystem: BrowserDescriptorFileSystem,
): Promise<Stats | null> {
  const absolute = path.resolve(candidate);
  if (!isInside(root, absolute) || absolute === root) return null;

  const relative = path.relative(root, absolute);
  const segments = relative.split(path.sep);
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;

  try {
    const rootInfo = await fileSystem.lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return null;
    if (path.resolve(await fileSystem.realpath(root)) !== root) return null;

    let cursor = root;
    let targetInfo: Stats | null = null;
    for (const [index, segment] of segments.entries()) {
      cursor = path.join(cursor, segment);
      const info = await fileSystem.lstat(cursor);
      const last = index === segments.length - 1;
      if (info.isSymbolicLink() || (last ? !info.isFile() : !info.isDirectory())) return null;
      if (last) targetInfo = info;
    }

    const real = path.resolve(await fileSystem.realpath(absolute));
    if (!isInside(root, real) || !targetInfo) return null;
    return targetInfo;
  } catch {
    return null;
  }
}

export async function readBoundedBrowserDescriptor(options: {
  readonly candidate: string;
  readonly context: BrowserDescriptorVaultContext;
  readonly getCurrentContext: () => BrowserDescriptorVaultContext | null;
  readonly fileSystem?: BrowserDescriptorFileSystem;
}): Promise<string | null> {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const root = path.resolve(options.context.realRoot);
  const candidate = path.resolve(options.candidate);
  if (!sameContext(options.context, options.getCurrentContext())) return null;

  const beforeOpenPath = await validatedPathStat(root, candidate, fileSystem);
  if (!beforeOpenPath || beforeOpenPath.size > MAX_BROWSER_DESCRIPTOR_BYTES) return null;

  let handle: BrowserDescriptorOpenFile | null = null;
  try {
    handle = await fileSystem.open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const afterOpenHandle = await handle.stat();
    const afterOpenPath = await validatedPathStat(root, candidate, fileSystem);
    if (
      !afterOpenPath ||
      !afterOpenHandle.isFile() ||
      afterOpenHandle.size > MAX_BROWSER_DESCRIPTOR_BYTES ||
      !sameFile(beforeOpenPath, afterOpenHandle) ||
      !sameFile(afterOpenHandle, afterOpenPath) ||
      !sameContext(options.context, options.getCurrentContext())
    )
      return null;

    const buffer = Buffer.alloc(MAX_BROWSER_DESCRIPTOR_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const afterReadHandle = await handle.stat();
    const afterReadPath = await validatedPathStat(root, candidate, fileSystem);
    if (
      bytesRead > MAX_BROWSER_DESCRIPTOR_BYTES ||
      afterReadHandle.size > MAX_BROWSER_DESCRIPTOR_BYTES ||
      !afterReadPath ||
      !sameFile(afterOpenHandle, afterReadHandle) ||
      !sameFile(afterReadHandle, afterReadPath) ||
      !sameContext(options.context, options.getCurrentContext())
    )
      return null;

    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
