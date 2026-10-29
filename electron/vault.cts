// file system access for the vault, every path is checked to stay inside the chosen folder
import { app, clipboard, ClipboardItem, dialog, nativeImage, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isInside } from './cloud.cjs';

export type VaultOp =
  | { op: 'write'; path: string; text: string; expect?: string | null }
  | { op: 'rename'; from: string; to: string; optional?: boolean }
  | { op: 'remove'; path: string }
  | { op: 'rmdir'; path: string }
  | { op: 'delete'; path: string };

export type VaultOpResult =
  | { ok: true }
  | { ok: false; code: 'conflict'; message: string; current: string | null }
  | { ok: false; code: 'exists' | 'error'; message: string };

interface VaultChange {
  path: string;
  text: string | null;
  mtime: number;
  birthtime: number;
  dir?: boolean;
  other?: boolean;
  size?: number;
  emptyFolder?: boolean;
}

interface VaultList {
  current: string | null;
  recent: Array<{ path: string; openedAt: number }>;
}

const MAX_FILES = 200_000;
const MAX_DEPTH = 64;
const MAX_TEXT_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const TEMP_MARK = '.morrow-tmp-';
const READ_AT_ONCE = 64;

const listFile = () => path.join(app.getPath('userData'), 'vaults.json');

let root: string | null = null;
let realRoot: string | null = null;
let vaultGeneration = 0;
let watcher: FSWatcher | null = null;
// on linux every folder gets its own watcher, see startWatching
const folderWatchers = new Map<string, FSWatcher>();
const MAX_WATCHED_FOLDERS = 20_000;

export async function readVaultList(): Promise<VaultList> {
  try {
    const raw = JSON.parse(await readFile(listFile(), 'utf8')) as Partial<VaultList>;
    const recent = Array.isArray(raw.recent)
      ? raw.recent
          .filter((item) => item && typeof item.path === 'string' && path.isAbsolute(item.path))
          .slice(0, 20)
      : [];
    return {
      current: typeof raw.current === 'string' && path.isAbsolute(raw.current) ? raw.current : null,
      recent,
    };
  } catch {
    return { current: null, recent: [] };
  }
}

async function writeVaultList(list: VaultList): Promise<void> {
  const file = listFile();
  await writeFile(`${file}.tmp`, JSON.stringify(list, null, 2), 'utf8');
  await rename(`${file}.tmp`, file);
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

export async function vaultState(): Promise<{
  current: string | null;
  recent: Array<{ path: string; name: string; exists: boolean }>;
}> {
  const list = await readVaultList();
  const recent = await Promise.all(
    list.recent.map(async (item) => ({
      path: item.path,
      name: path.basename(item.path),
      exists: await isDirectory(item.path),
    })),
  );
  const current = list.current && (await isDirectory(list.current)) ? list.current : null;
  return { current, recent };
}

export async function selectVault(dir: string): Promise<{ ok: boolean; error?: string }> {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return { ok: false, error: 'Choose a folder.' };
  const resolved = path.resolve(dir);
  if (!(await isDirectory(resolved))) return { ok: false, error: 'That folder does not exist any more.' };
  if (resolved === path.parse(resolved).root || resolved === app.getPath('home'))
    return {
      ok: false,
      error: 'Choose a folder of its own for your notes, not your whole drive or home folder.',
    };
  const list = await readVaultList();
  list.current = resolved;
  list.recent = [
    { path: resolved, openedAt: Date.now() },
    ...list.recent.filter((item) => item.path !== resolved),
  ].slice(0, 20);
  await writeVaultList(list);
  return { ok: true };
}

export async function forgetVault(dir: string): Promise<void> {
  const list = await readVaultList();
  list.recent = list.recent.filter((item) => item.path !== dir);
  if (list.current === dir) list.current = null;
  await writeVaultList(list);
}

export async function chooseFolder(window: BrowserWindow | null, start?: unknown): Promise<string | null> {
  const options = {
    title: 'Choose a folder for your notes',
    buttonLabel: 'Use this folder',
    properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
    defaultPath:
      typeof start === 'string' && path.isAbsolute(start) && (await isDirectory(start))
        ? start
        : app.getPath('documents'),
  };
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

// copies the open vault, history and all, into another folder such as a cloud app's, and returns the copy
export async function copyVaultInto(
  parent: unknown,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  if (!root) return { ok: false, error: 'No vault is open.' };
  if (typeof parent !== 'string' || !path.isAbsolute(parent) || !(await isDirectory(parent)))
    return { ok: false, error: 'That folder does not exist.' };
  const from = path.resolve(root);
  const into = path.resolve(parent);
  if (isInside(into, from)) return { ok: false, error: 'Choose a folder outside this vault.' };
  let target = path.join(into, path.basename(from));
  for (let n = 2; await exists(target); n++) target = path.join(into, `${path.basename(from)} ${n}`);
  try {
    await cp(from, target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  } catch (error) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    return {
      ok: false,
      error: `The vault could not be copied: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { ok: true, path: target };
}

// default vault folder in documents
const DEFAULT_VAULT_NAME = 'Morrow';
export async function createDefaultVault(): Promise<string> {
  const documents = app.getPath('documents');
  let candidate = path.join(documents, DEFAULT_VAULT_NAME);
  for (let n = 2; await exists(candidate); n++)
    candidate = path.join(documents, `${DEFAULT_VAULT_NAME} ${n}`);
  await mkdir(candidate, { recursive: true });
  return candidate;
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

export async function openVault(dir: string, onChanges: (changes: VaultChange[]) => void): Promise<void> {
  closeVault();
  const generation = vaultGeneration;
  const nextRoot = path.resolve(dir);
  const nextRealRoot = await realpath(nextRoot);
  if (generation !== vaultGeneration) return;
  root = nextRoot;
  realRoot = nextRealRoot;
  startWatching(onChanges);
}

export function closeVault(): void {
  vaultGeneration++;
  watcher?.close();
  watcher = null;
  for (const folder of folderWatchers.values()) folder.close();
  folderWatchers.clear();
  root = null;
  realRoot = null;
}

export function currentVault(): string | null {
  return root;
}

// Process-main only: callers can bind asynchronous work to this vault generation and real root.
export function currentVaultContext(): { root: string; realRoot: string; generation: number } | null {
  return root && realRoot ? { root, realRoot, generation: vaultGeneration } : null;
}

// a vault relative path to an absolute one, refusing anything that would leave the vault
function resolveInVault(relative: unknown): string {
  if (!root) throw new Error('No vault is open.');
  if (
    typeof relative !== 'string' ||
    relative.length === 0 ||
    relative.length > 4096 ||
    relative.includes('\0')
  )
    throw new Error('Invalid path.');
  if (path.isAbsolute(relative) || relative.includes('\\')) throw new Error('Invalid path.');
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(root + path.sep))
    throw new Error('That path is outside the vault.');
  return absolute;
}

// writes must not follow a link out of the vault
async function checkReal(absolute: string): Promise<void> {
  let dir = path.dirname(absolute);
  while (!(await exists(dir))) dir = path.dirname(dir);
  const real = await realpath(dir);
  if (!realRoot || (real !== realRoot && !real.startsWith(realRoot + path.sep)))
    throw new Error('That path is outside the vault.');
}

const toRelative = (absolute: string) => path.relative(root!, absolute).split(path.sep).join('/');
const isHidden = (relative: string) =>
  relative.split('/').some((part, index) => part.startsWith('.') && !(index === 0 && part === '.trash'));
const isPage = (relative: string) => /\.(md|canvas)$/i.test(relative);

export async function scanVault(): Promise<unknown> {
  if (!root) throw new Error('No vault is open.');
  const scanRoot = root;
  const scanRealRoot = realRoot;
  const scanGeneration = vaultGeneration;
  if (!scanRealRoot) throw new Error('No vault is open.');
  const files: Array<{ path: string; text: string; mtime: number; birthtime: number }> = [];
  const folders: Array<{ path: string; mtime: number; empty: boolean }> = [];
  const others: string[] = [];
  const resources: Array<{ path: string; extension: string; size: number | null; mtime: number }> = [];
  let count = 0;
  const relativeToScanRoot = (absolute: string) =>
    path.relative(scanRoot, absolute).split(path.sep).join('/');
  const insideScanRoot = async (absolute: string) => {
    const real = await realpath(absolute).catch(() => null);
    return (
      vaultGeneration === scanGeneration &&
      root === scanRoot &&
      realRoot === scanRealRoot &&
      real !== null &&
      isInside(real, scanRealRoot)
    );
  };
  // files are read many at a time, which is far quicker than one by one on every kind of disk, and capped
  // so a folder of thousands never runs out of file handles
  const readPage = async (absolute: string, relative: string): Promise<void> => {
    if (root !== scanRoot || !(await insideScanRoot(absolute))) return;
    const info = await stat(absolute).catch(() => null);
    if (!info || info.size > MAX_TEXT_BYTES) {
      others.push(relative);
      return;
    }
    const text = await readFile(absolute, 'utf8').catch(() => null);
    if (text === null) return;
    files.push({ path: relative, text, mtime: info.mtimeMs, birthtime: info.birthtimeMs || info.ctimeMs });
  };
  const pending = new Set<Promise<void>>();
  const queue = async (task: () => Promise<void>): Promise<void> => {
    while (pending.size >= READ_AT_ONCE) await Promise.race(pending);
    const run = task().finally(() => pending.delete(run));
    pending.add(run);
  };
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (
      depth > MAX_DEPTH ||
      count >= MAX_FILES ||
      root !== scanRoot ||
      realRoot !== scanRealRoot ||
      vaultGeneration !== scanGeneration
    )
      return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (count >= MAX_FILES) return;
      count++;
      const absolute = path.join(dir, entry.name);
      const relative = relativeToScanRoot(absolute);
      if (entry.name.includes(TEMP_MARK) || entry.isSymbolicLink() || isHidden(relative)) continue;
      if (!(await insideScanRoot(absolute))) continue;
      if (entry.isDirectory()) {
        const info = await stat(absolute).catch(() => null);
        const children = await readdir(absolute).catch(() => ['?']);
        folders.push({ path: relative, mtime: info?.mtimeMs ?? 0, empty: children.length === 0 });
        await walk(absolute, depth + 1);
      } else if (entry.isFile()) {
        if (isPage(relative)) await queue(() => readPage(absolute, relative));
        else {
          others.push(relative);
          const info = await stat(absolute).catch(() => null);
          resources.push({
            path: relative,
            extension: path.extname(entry.name).replace(/^\./, '').toLowerCase(),
            size: info?.size ?? null,
            mtime: info?.mtimeMs ?? 0,
          });
        }
      }
    }
  };
  await walk(scanRoot, 0);
  await Promise.all(pending);
  if (root !== scanRoot || realRoot !== scanRealRoot || vaultGeneration !== scanGeneration)
    throw new Error('The vault changed during the scan.');
  const json = async (relative: string) => {
    try {
      const absolute = path.join(scanRoot, relative);
      if (!(await insideScanRoot(absolute))) return null;
      return JSON.parse(await readFile(absolute, 'utf8')) as unknown;
    } catch {
      return null;
    }
  };
  const registry = await json('.morrow/workspace.json');
  const recent = await json('.morrow/recent.json');
  if (root !== scanRoot || realRoot !== scanRealRoot || vaultGeneration !== scanGeneration)
    throw new Error('The vault changed during the scan.');
  return {
    files,
    folders,
    others,
    resources,
    registry,
    recent,
  };
}

async function readTextOrNull(absolute: string): Promise<string | null> {
  try {
    return await readFile(absolute, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// writes beside the target first, so a crash never leaves half a file
async function writeAtomic(absolute: string, data: string | Uint8Array): Promise<void> {
  await checkReal(absolute);
  await mkdir(path.dirname(absolute), { recursive: true });
  const temp = path.join(path.dirname(absolute), `${TEMP_MARK}${randomBytes(6).toString('hex')}`);
  await writeFile(temp, data);
  await rename(temp, absolute);
}

async function applyOne(op: VaultOp): Promise<VaultOpResult> {
  switch (op.op) {
    case 'write': {
      const absolute = resolveInVault(op.path);
      if (typeof op.text !== 'string') return { ok: false, code: 'error', message: 'Invalid text.' };
      if (op.expect !== undefined) {
        const current = await readTextOrNull(absolute);
        if (current !== op.expect)
          return { ok: false, code: 'conflict', message: `${op.path} changed on disk.`, current };
      }
      await writeAtomic(absolute, op.text);
      return { ok: true };
    }
    case 'rename': {
      const from = resolveInVault(op.from);
      const to = resolveInVault(op.to);
      if (!(await exists(from)))
        return op.optional ? { ok: true } : { ok: false, code: 'error', message: `${op.from} is missing.` };
      const caseOnly = from.toLowerCase() === to.toLowerCase();
      if (!caseOnly && (await exists(to)))
        return { ok: false, code: 'exists', message: `${op.to} already exists.` };
      await checkReal(from);
      await checkReal(to);
      await mkdir(path.dirname(to), { recursive: true });
      await rename(from, to);
      return { ok: true };
    }
    case 'remove': {
      const absolute = resolveInVault(op.path);
      if (!(await exists(absolute))) return { ok: true };
      await checkReal(absolute);
      try {
        await shell.trashItem(absolute);
      } catch {
        // without a system trash the file is kept in the vault's own deleted folder instead
        const keep = path.join(root!, '.morrow', 'deleted', `${Date.now()}-${path.basename(absolute)}`);
        await mkdir(path.dirname(keep), { recursive: true });
        await rename(absolute, keep);
      }
      return { ok: true };
    }
    case 'delete': {
      // only morrow's own bookkeeping is ever deleted outright, pages always go to the trash
      if (!op.path.startsWith('.morrow/'))
        return { ok: false, code: 'error', message: 'Only Morrow files can be deleted.' };
      const absolute = resolveInVault(op.path);
      await rm(absolute, { force: true });
      return { ok: true };
    }
    case 'rmdir': {
      const absolute = resolveInVault(op.path);
      try {
        await rmdir(absolute);
      } catch {
        // folders that still hold something stay
      }
      return { ok: true };
    }
    default:
      return { ok: false, code: 'error', message: 'Unknown operation.' };
  }
}

export async function applyOps(ops: unknown): Promise<VaultOpResult[]> {
  if (!Array.isArray(ops)) return [{ ok: false, code: 'error', message: 'Invalid operations.' }];
  const results: VaultOpResult[] = [];
  for (const op of ops as VaultOp[]) {
    let result: VaultOpResult;
    try {
      result = await applyOne(op);
    } catch (error) {
      result = { ok: false, code: 'error', message: error instanceof Error ? error.message : String(error) };
    }
    results.push(result);
    if (!result.ok) break;
  }
  return results;
}

export async function readText(relative: unknown): Promise<string | null> {
  return readTextOrNull(resolveInVault(relative));
}

export async function readBytes(relative: unknown): Promise<Uint8Array | null> {
  try {
    const absolute = resolveInVault(relative);
    const info = await stat(absolute);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    return await readFile(absolute);
  } catch {
    return null;
  }
}

export async function createFile(relative: unknown, data: unknown): Promise<void> {
  const absolute = resolveInVault(relative);
  if (!(data instanceof Uint8Array) && !(data instanceof ArrayBuffer)) throw new Error('Invalid file data.');
  if (await exists(absolute)) throw new Error('A file with that name already exists.');
  await writeAtomic(absolute, data instanceof ArrayBuffer ? new Uint8Array(data) : data);
}

export async function pathExists(relative: unknown): Promise<boolean> {
  return exists(resolveInVault(relative));
}

export async function listDir(
  relative: unknown,
): Promise<Array<{ path: string; size: number; mtime: number }>> {
  const dir = resolveInVault(relative);
  const result: Array<{ path: string; size: number; mtime: number }> = [];
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > 16) return;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.name.includes(TEMP_MARK) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(absolute, depth + 1);
      else if (entry.isFile()) {
        const info = await stat(absolute).catch(() => null);
        if (info) result.push({ path: toRelative(absolute), size: info.size, mtime: info.mtimeMs });
      }
    }
  };
  await walk(dir, 0);
  return result;
}

// ---- for sync between computers

// files every computer shares: pages, attachments, the trash and the shared part of morrow's bookkeeping
export function isSyncedPath(relative: string): boolean {
  if (!relative || relative.includes(TEMP_MARK) || relative.includes('.morrow-move-')) return false;
  if (relative === '.morrow/workspace.json' || relative === '.morrow/review.json') return true;
  return !relative
    .split('/')
    .some((part, index) => part.startsWith('.') && !(index === 0 && part === '.trash'));
}

const hashCache = new Map<string, { size: number; mtime: number; hash: string }>();

async function hashFile(absolute: string, size: number, mtime: number): Promise<string | null> {
  const cached = hashCache.get(absolute);
  if (cached && cached.size === size && cached.mtime === mtime) return cached.hash;
  const data = await readFile(absolute).catch(() => null);
  if (!data) return null;
  const hash = createHash('sha256').update(data).digest('hex');
  hashCache.set(absolute, { size, mtime, hash });
  return hash;
}

// every synced file in the open vault with a hash of its bytes
export async function vaultManifest(): Promise<Record<string, string>> {
  if (!root) throw new Error('No vault is open.');
  const manifest: Record<string, string> = {};
  let count = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || count > MAX_FILES) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (++count > MAX_FILES) return;
      const absolute = path.join(dir, entry.name);
      const relative = toRelative(absolute);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (isSyncedPath(relative) || relative === '.morrow') await walk(absolute, depth + 1);
      } else if (entry.isFile() && isSyncedPath(relative)) {
        const info = await stat(absolute).catch(() => null);
        if (!info || info.size > MAX_FILE_BYTES) continue;
        const hash = await hashFile(absolute, info.size, info.mtimeMs);
        if (hash) manifest[relative] = hash;
      }
    }
  };
  await walk(root, 0);
  return manifest;
}

export async function syncedFileBase64(relative: unknown): Promise<string | null> {
  if (typeof relative !== 'string' || !isSyncedPath(relative)) return null;
  const bytes = await readBytes(relative);
  return bytes ? Buffer.from(bytes).toString('base64') : null;
}

// writes a file that came from another computer, only when this computer's copy is still the one the plan saw
export async function writeSyncedFile(
  relative: unknown,
  base64: unknown,
  expectHash: unknown,
): Promise<VaultOpResult> {
  if (typeof relative !== 'string' || !isSyncedPath(relative) || typeof base64 !== 'string')
    return { ok: false, code: 'error', message: 'Invalid file.' };
  const absolute = resolveInVault(relative);
  const current = await readFile(absolute).catch(() => null);
  const currentHash = current ? createHash('sha256').update(current).digest('hex') : null;
  if (currentHash !== (typeof expectHash === 'string' ? expectHash : null))
    return { ok: false, code: 'conflict', message: `${relative} changed meanwhile.`, current: null };
  await writeAtomic(absolute, Buffer.from(base64, 'base64'));
  return { ok: true };
}

// each vault has an id, so two computers only sync folders that are copies of the same vault
export async function vaultIdentity(): Promise<{ id: string; name: string }> {
  if (!root) throw new Error('No vault is open.');
  const file = path.join(root, '.morrow', 'vault.json');
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as { id?: unknown };
    if (typeof raw.id === 'string' && /^[\w-]{8,64}$/.test(raw.id))
      return { id: raw.id, name: path.basename(root) };
  } catch {
    // made below
  }
  const id = randomUUID();
  await writeAtomic(file, `${JSON.stringify({ version: 1, id }, null, 1)}\n`);
  return { id, name: path.basename(root) };
}

// prepares an empty folder to become a copy of a vault on another computer
export async function prepareCopy(dir: string, vaultId: string): Promise<{ ok: boolean; error?: string }> {
  if (!path.isAbsolute(dir) || !/^[\w-]{8,64}$/.test(vaultId)) return { ok: false, error: 'Invalid folder.' };
  const entries = await readdir(dir).catch(() => null);
  if (entries === null) return { ok: false, error: 'That folder does not exist.' };
  if (entries.some((name) => !name.startsWith('.')))
    return { ok: false, error: 'Choose an empty folder for the copy.' };
  await mkdir(path.join(dir, '.morrow'), { recursive: true });
  await writeFile(
    path.join(dir, '.morrow', 'vault.json'),
    `${JSON.stringify({ version: 1, id: vaultId }, null, 1)}\n`,
  );
  return { ok: true };
}

export async function readSyncBase(peerId: string): Promise<Record<string, string>> {
  if (!root || !/^[\w-]{8,64}$/.test(peerId)) return {};
  try {
    const raw = JSON.parse(await readFile(path.join(root, '.morrow', 'sync', `${peerId}.json`), 'utf8')) as {
      files?: unknown;
    };
    return raw.files && typeof raw.files === 'object' ? (raw.files as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export async function writeSyncBase(peerId: string, files: unknown): Promise<void> {
  if (!root || !/^[\w-]{8,64}$/.test(peerId) || !files || typeof files !== 'object') return;
  await writeAtomic(
    path.join(root, '.morrow', 'sync', `${peerId}.json`),
    JSON.stringify({ version: 1, files }),
  );
}

// pictures, sound, video and pdfs open in the app the system uses for them. nothing that could run as a
// program is ever opened this way, whatever is in the vault
const OPENABLE =
  /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico|tiff?|heic|mp3|m4a|wav|ogg|oga|flac|aac|opus|mp4|m4v|webm|mov|mkv|pdf)$/i;

export async function openInDefaultApp(relative: unknown): Promise<boolean> {
  if (typeof relative !== 'string' || !OPENABLE.test(relative)) return false;
  const absolute = vaultFilePath(relative);
  if (!absolute) return false;
  return (await shell.openPath(absolute)) === '';
}

// electron reads png and jpeg everywhere, and more kinds on some systems. false when it can not
export async function copyImage(relative: unknown): Promise<boolean> {
  if (typeof relative !== 'string' || !OPENABLE.test(relative)) return false;
  const absolute = vaultFilePath(relative);
  const image = absolute ? nativeImage.createFromPath(absolute) : null;
  if (!image || image.isEmpty()) return false;
  const png = new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' });
  await clipboard.write([new ClipboardItem({ 'image/png': png })]);
  return true;
}

export function revealInFolder(relative: unknown): void {
  shell.showItemInFolder(relative === '' || relative === undefined ? (root ?? '') : resolveInVault(relative));
}

// the absolute path of a vault file for the file protocol, null when it is outside the vault
export function vaultFilePath(relative: string): string | null {
  try {
    return resolveInVault(relative);
  } catch {
    return null;
  }
}

// changes are gathered for a moment, then each path is looked at once
function startWatching(onChanges: (changes: VaultChange[]) => void): void {
  if (!root || !realRoot) return;
  const watchRoot = root;
  const watchRealRoot = realRoot;
  const watchGeneration = vaultGeneration;
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const queue = (relative: string) => {
    const segments = relative.split('/');
    if (
      root !== watchRoot ||
      vaultGeneration !== watchGeneration ||
      !relative ||
      relative.startsWith('/') ||
      relative.includes('\\') ||
      segments.some((part) => !part || part === '.' || part === '..') ||
      relative.includes(TEMP_MARK) ||
      isHidden(relative)
    )
      return;
    pending.add(relative);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), 150);
  };
  const flush = async () => {
    timer = null;
    if (root !== watchRoot || realRoot !== watchRealRoot || vaultGeneration !== watchGeneration) return;
    const paths = [...pending];
    pending.clear();
    const changes: VaultChange[] = [];
    for (const relative of paths) {
      if (root !== watchRoot || realRoot !== watchRealRoot || vaultGeneration !== watchGeneration) return;
      const absolute = path.join(watchRoot, relative);
      if (await hasSymlinkComponent(absolute, watchRoot)) continue;
      const info = await stat(absolute).catch(() => null);
      if (!info) {
        unwatchFolders(absolute);
        changes.push({
          path: relative,
          text: null,
          mtime: Date.now(),
          birthtime: 0,
          dir: !isPage(relative),
          other: !isPage(relative),
        });
      } else if (!(await isSafeWatcherPath(absolute, watchRoot, watchRealRoot, watchGeneration))) {
        continue;
      } else if (info.isDirectory()) {
        // a folder moved in from elsewhere arrives as one event, its contents are reported one by one
        if (perFolder) await watchTree(absolute, queue, 0, watchRoot, watchRealRoot, watchGeneration);
        changes.push(...(await describeFolder(absolute, 0, watchRoot, watchRealRoot, watchGeneration)));
      } else if (info.isFile()) {
        changes.push(
          ...(await describeFile(
            absolute,
            info.mtimeMs,
            info.birthtimeMs || info.ctimeMs,
            info.size,
            watchRoot,
            watchRealRoot,
            watchGeneration,
          )),
        );
      }
    }
    if (root !== watchRoot || realRoot !== watchRealRoot || vaultGeneration !== watchGeneration) return;
    if (changes.length) onChanges(changes);
  };
  // linux's recursive watching follows files by inode and loses a file once it is replaced by a save,
  // watching each folder sees every name that changes inside it, however the file was written
  const perFolder = process.platform === 'linux';
  if (perFolder) {
    void watchTree(watchRoot, queue, 0, watchRoot, watchRealRoot, watchGeneration);
    return;
  }
  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (filename) queue(filename.toString().split(path.sep).join('/'));
    });
    watcher.on('error', () => undefined);
  } catch {
    watcher = null;
  }
}

async function isInsideCurrentVault(
  absolute: string,
  expectedRealRoot: string,
  expectedGeneration: number,
): Promise<boolean> {
  const real = await realpath(absolute).catch(() => null);
  return (
    root !== null &&
    realRoot === expectedRealRoot &&
    vaultGeneration === expectedGeneration &&
    real !== null &&
    isInside(real, expectedRealRoot)
  );
}

async function hasSymlinkComponent(absolute: string, watchRoot: string): Promise<boolean> {
  const relative = path.relative(watchRoot, absolute);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return true;
  if (!relative) return false;

  let current = watchRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const info = await lstat(current).catch(() => null);
    if (!info) return false;
    if (info.isSymbolicLink()) return true;
  }
  return false;
}

async function isSafeWatcherPath(
  absolute: string,
  watchRoot: string,
  watchRealRoot: string,
  watchGeneration: number,
): Promise<boolean> {
  if (await hasSymlinkComponent(absolute, watchRoot)) return false;
  return isInsideCurrentVault(absolute, watchRealRoot, watchGeneration);
}

async function watchTree(
  dir: string,
  queue: (relative: string) => void,
  depth = 0,
  watchRoot = root,
  watchRealRoot = realRoot,
  watchGeneration = vaultGeneration,
): Promise<void> {
  if (
    !watchRoot ||
    !watchRealRoot ||
    root !== watchRoot ||
    realRoot !== watchRealRoot ||
    vaultGeneration !== watchGeneration ||
    depth > MAX_DEPTH ||
    folderWatchers.size >= MAX_WATCHED_FOLDERS ||
    !(await isSafeWatcherPath(dir, watchRoot, watchRealRoot, watchGeneration))
  )
    return;
  const relative = path.relative(watchRoot, dir).split(path.sep).join('/');
  if (relative && isHidden(relative)) return;
  if (!folderWatchers.has(dir)) {
    try {
      const folder = watch(dir, (_event, name) => {
        if (name) queue(toRelative(path.join(dir, name.toString())));
      });
      folder.on('error', () => unwatchFolders(dir));
      folderWatchers.set(dir, folder);
    } catch {
      return;
    }
  }
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const child = path.join(dir, entry.name);
      if (await isSafeWatcherPath(child, watchRoot, watchRealRoot, watchGeneration))
        await watchTree(child, queue, depth + 1, watchRoot, watchRealRoot, watchGeneration);
    }
  }
}

function unwatchFolders(dir: string): void {
  for (const [folder, handle] of folderWatchers) {
    if (folder === dir || folder.startsWith(dir + path.sep)) {
      handle.close();
      folderWatchers.delete(folder);
    }
  }
}

async function describeFile(
  absolute: string,
  mtime: number,
  birthtime: number,
  size: number,
  watchRoot = root,
  watchRealRoot = realRoot,
  watchGeneration = vaultGeneration,
): Promise<VaultChange[]> {
  if (
    !watchRoot ||
    !watchRealRoot ||
    root !== watchRoot ||
    realRoot !== watchRealRoot ||
    vaultGeneration !== watchGeneration ||
    !(await isSafeWatcherPath(absolute, watchRoot, watchRealRoot, watchGeneration))
  )
    return [];
  const relative = path.relative(watchRoot, absolute).split(path.sep).join('/');
  if (!isPage(relative)) return [{ path: relative, text: '', mtime, birthtime, other: true, size }];
  if (size > MAX_TEXT_BYTES) return [];
  const text = await readFile(absolute, 'utf8').catch(() => null);
  if (
    root !== watchRoot ||
    realRoot !== watchRealRoot ||
    vaultGeneration !== watchGeneration ||
    !(await isSafeWatcherPath(absolute, watchRoot, watchRealRoot, watchGeneration))
  )
    return [];
  return text === null ? [] : [{ path: relative, text, mtime, birthtime }];
}

async function describeFolder(
  dir: string,
  depth = 0,
  watchRoot = root,
  watchRealRoot = realRoot,
  watchGeneration = vaultGeneration,
  budget = { count: 0 },
): Promise<VaultChange[]> {
  if (
    !watchRoot ||
    !watchRealRoot ||
    root !== watchRoot ||
    realRoot !== watchRealRoot ||
    vaultGeneration !== watchGeneration ||
    depth > MAX_DEPTH ||
    budget.count >= MAX_FILES ||
    !(await isSafeWatcherPath(dir, watchRoot, watchRealRoot, watchGeneration))
  )
    return [];
  const changes: VaultChange[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  if (entries.length === 0) {
    const relative = path.relative(watchRoot, dir).split(path.sep).join('/');
    if (relative) {
      const info = await stat(dir).catch(() => null);
      if (info)
        changes.push({
          path: relative,
          text: '',
          mtime: info.mtimeMs,
          birthtime: info.birthtimeMs || info.ctimeMs,
          dir: true,
          emptyFolder: true,
        });
    }
    return changes;
  }
  for (const entry of entries) {
    if (budget.count >= MAX_FILES) break;
    budget.count++;
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(watchRoot, absolute).split(path.sep).join('/');
    if (entry.name.includes(TEMP_MARK) || entry.isSymbolicLink() || isHidden(relative)) continue;
    if (!(await isSafeWatcherPath(absolute, watchRoot, watchRealRoot, watchGeneration))) continue;
    if (entry.isDirectory())
      changes.push(
        ...(await describeFolder(absolute, depth + 1, watchRoot, watchRealRoot, watchGeneration, budget)),
      );
    else if (entry.isFile()) {
      const info = await stat(absolute).catch(() => null);
      if (info)
        changes.push(
          ...(await describeFile(
            absolute,
            info.mtimeMs,
            info.birthtimeMs || info.ctimeMs,
            info.size,
            watchRoot,
            watchRealRoot,
            watchGeneration,
          )),
        );
    }
  }
  return changes;
}
