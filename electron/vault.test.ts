import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import Module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import type * as NodeFsPromises from 'node:fs/promises';

const mutableFsPromises = createRequire(import.meta.url)('node:fs/promises') as typeof NodeFsPromises;

interface ScanResult {
  files: Array<{ path: string; text: string }>;
  folders: Array<{ path: string; empty: boolean }>;
  others: string[];
  resources: Array<{ path: string; extension: string; size: number | null; mtime: number }>;
}

const temporaryRoots: string[] = [];

interface CompiledCommonJsModule {
  filename: string;
  paths: string[];
  exports: unknown;
  _compile(code: string, filename: string): void;
}

interface CommonJsModuleLoader {
  new (id: string): CompiledCommonJsModule;
  _nodeModulePaths(directory: string): string[];
  _load(request: string, parent: CompiledCommonJsModule | null, isMain: boolean): unknown;
}

const CommonJsModule = Module as unknown as CommonJsModuleLoader;

interface VaultModule {
  closeVault(): void;
  openVault(
    dir: string,
    onChanges: (
      changes: Array<{
        path: string;
        text: string | null;
        other?: boolean;
        size?: number;
        emptyFolder?: boolean;
      }>,
    ) => void,
  ): Promise<void>;
  scanVault(): Promise<unknown>;
}

function makeRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function makeDirectoryLink(target: string, link: string): void {
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

function makeFileLink(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, process.platform === 'win32' ? 'file' : undefined);
    return true;
  } catch {
    return false;
  }
}

function loadVaultModule(): VaultModule {
  const output = makeRoot('morrow-vault-test-code-');
  const sourceRoot = path.join(process.cwd(), 'electron');
  const vaultSource = readFileSync(path.join(sourceRoot, 'vault.cts'), 'utf8');
  const cloudSource = readFileSync(path.join(sourceRoot, 'cloud.cts'), 'utf8');
  const compilerOptions = {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  };
  const vaultCode = ts.transpileModule(vaultSource, { compilerOptions }).outputText;
  const cloudCode = ts.transpileModule(cloudSource, { compilerOptions }).outputText;
  const vaultPath = path.join(output, 'vault.cjs');
  writeFileSync(vaultPath, vaultCode);
  writeFileSync(path.join(output, 'cloud.cjs'), cloudCode);
  const compiled = new CommonJsModule(vaultPath);
  compiled.filename = vaultPath;
  compiled.paths = CommonJsModule._nodeModulePaths(output);
  const originalLoad = CommonJsModule._load;
  CommonJsModule._load = function (request, parent, isMain) {
    if (request === 'electron')
      return {
        app: { getPath: () => output },
        clipboard: { write: vi.fn() },
        ClipboardItem: class ClipboardItem {},
        dialog: {},
        nativeImage: { createFromPath: () => null },
        shell: { showItemInFolder: vi.fn() },
      };
    return originalLoad(request, parent, isMain);
  };
  try {
    compiled._compile(vaultCode, vaultPath);
  } finally {
    CommonJsModule._load = originalLoad;
  }
  return compiled.exports as VaultModule;
}

const { closeVault, openVault, scanVault } = loadVaultModule();

function digest(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for a vault watcher event.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

afterEach(() => {
  closeVault();
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('vault file catalog scanner', () => {
  it('collects metadata without reading or changing ordinary files and excludes links and technical paths', async () => {
    const root = makeRoot('morrow-catalog-scan-');
    const outside = makeRoot('morrow-catalog-outside-');
    mkdirSync(path.join(root, 'Only PDFs', 'Nested'), { recursive: true });
    mkdirSync(path.join(root, 'Mixed'), { recursive: true });
    mkdirSync(path.join(root, 'empty'), { recursive: true });
    mkdirSync(path.join(root, '.morrow'), { recursive: true });
    mkdirSync(path.join(root, '.git'), { recursive: true });
    mkdirSync(path.join(root, '.hidden'), { recursive: true });
    const tooDeep = path.join(root, ...Array.from({ length: 65 }, () => 'd'));
    mkdirSync(tooDeep, { recursive: true });
    mkdirSync(path.join(outside, 'Sentinel'), { recursive: true });
    writeFileSync(path.join(root, 'Only PDFs', 'Nested', 'Report.PDF'), Buffer.from('%PDF synthetic'));
    writeFileSync(path.join(root, 'Mixed', 'Clip.Mp4'), Buffer.from('synthetic video'));
    writeFileSync(path.join(root, 'Mixed', 'No extension'), Buffer.from('synthetic bytes'));
    writeFileSync(path.join(root, 'Mixed', 'Note.md'), '---\nunknown: keep\n---\n<!-- untouched -->\n');
    writeFileSync(path.join(root, '.morrow', 'workspace.json'), '{"pages":{}}');
    writeFileSync(path.join(root, '.git', 'private.bin'), 'technical');
    writeFileSync(path.join(root, '.hidden', 'private.pdf'), 'hidden');
    writeFileSync(path.join(root, 'Mixed', '.morrow-tmp-upload.bin'), 'temporary');
    writeFileSync(path.join(tooDeep, 'over-limit.pdf'), 'too deep');
    writeFileSync(path.join(outside, 'Sentinel', 'outside.pdf'), 'outside sentinel');
    makeDirectoryLink(outside, path.join(root, 'external-link'));
    const noteHash = digest(path.join(root, 'Mixed', 'Note.md'));
    const pdfHash = digest(path.join(root, 'Only PDFs', 'Nested', 'Report.PDF'));
    const entriesBefore = readdirSync(root).sort();
    const readSpy = vi.spyOn(mutableFsPromises, 'readFile');
    await openVault(root, () => undefined);

    const scan = (await scanVault()) as ScanResult;
    const resourcePaths = scan.resources.map((resource) => resource.path);
    const readPaths = readSpy.mock.calls.map(([file]) => String(file).toLowerCase());

    expect(resourcePaths).toHaveLength(3);
    expect(resourcePaths).toEqual(
      expect.arrayContaining(['Only PDFs/Nested/Report.PDF', 'Mixed/Clip.Mp4', 'Mixed/No extension']),
    );
    expect(scan.files.map((file) => file.path)).toEqual(['Mixed/Note.md']);
    expect(scan.others).not.toContain('Mixed/Note.md');
    expect(scan.resources.some((resource) => resource.path.toLowerCase().includes('outside'))).toBe(false);
    expect(scan.resources.some((resource) => resource.path.includes('over-limit'))).toBe(false);
    expect(readPaths.some((file) => /\.(pdf|mp4|bin)$/.test(file))).toBe(false);
    expect(readPaths.some((file) => file.endsWith('note.md'))).toBe(true);
    expect(entriesBefore).toEqual(readdirSync(root).sort());
    expect(digest(path.join(root, 'Mixed', 'Note.md'))).toBe(noteHash);
    expect(digest(path.join(root, 'Only PDFs', 'Nested', 'Report.PDF'))).toBe(pdfHash);
    expect(lstatSync(path.join(root, 'external-link')).isSymbolicLink()).toBe(true);
    readSpy.mockRestore();
  });

  it('scans more than ten thousand metadata entries within the configured bounds', async () => {
    const root = makeRoot('morrow-catalog-scale-');
    const directory = path.join(root, 'Many files');
    mkdirSync(directory);
    for (let index = 0; index < 10_005; index++)
      writeFileSync(path.join(directory, `item-${String(index).padStart(5, '0')}.bin`), Buffer.alloc(0));
    const readSpy = vi.spyOn(mutableFsPromises, 'readFile');
    await openVault(root, () => undefined);
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    const scan = (await scanVault()) as ScanResult;
    const elapsedMs = performance.now() - started;
    const heapDelta = process.memoryUsage().heapUsed - heapBefore;

    expect(scan.resources).toHaveLength(10_005);
    expect(scan.resources[0]?.size).toBe(0);
    expect(readSpy).not.toHaveBeenCalled();
    console.info(
      `T31 scanner scale: entries=${scan.resources.length}, elapsedMs=${elapsedMs.toFixed(1)}, heapDeltaBytes=${heapDelta}`,
    );
    readSpy.mockRestore();
  }, 30_000);

  it('describes an externally moved ten-thousand-file folder without reading its contents', async () => {
    const root = makeRoot('morrow-watch-scale-root-');
    const staged = makeRoot('morrow-watch-scale-stage-');
    const incoming = path.join(staged, 'Incoming');
    mkdirSync(incoming);
    for (let index = 0; index < 10_000; index++)
      writeFileSync(path.join(incoming, `item-${String(index).padStart(5, '0')}.bin`), Buffer.alloc(0));
    const events: Array<{ path: string; text: string | null; other?: boolean; size?: number }> = [];
    const readSpy = vi.spyOn(mutableFsPromises, 'readFile');
    await openVault(root, (changes) => events.push(...changes));
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    renameSync(incoming, path.join(root, 'Incoming'));
    await waitFor(
      () => events.filter((change) => change.other && change.text !== null).length === 10_000,
      30_000,
    );
    const elapsedMs = performance.now() - started;
    const heapDelta = process.memoryUsage().heapUsed - heapBefore;

    expect(events.filter((change) => change.other && change.text !== null)).toHaveLength(10_000);
    expect(readSpy).not.toHaveBeenCalled();
    console.info(
      `T31 watcher scale: entries=${events.length}, elapsedMs=${elapsedMs.toFixed(1)}, heapDeltaBytes=${heapDelta}`,
    );
    readSpy.mockRestore();
  }, 30_000);

  it('rejects a scan when the vault is switched while its initial directory read is pending', async () => {
    const first = makeRoot('morrow-catalog-old-');
    const second = makeRoot('morrow-catalog-new-');
    mkdirSync(path.join(first, 'Folder'));
    writeFileSync(path.join(first, 'Folder', 'Old.pdf'), 'old');
    await openVault(first, () => undefined);
    const pending = scanVault();
    closeVault();
    await openVault(second, () => undefined);

    await expect(pending).rejects.toThrow('The vault changed during the scan.');
  });

  it('reports empty folders and file create, rename and removal while ignoring stale vault events and junctions', async () => {
    const first = makeRoot('morrow-watch-old-');
    const second = makeRoot('morrow-watch-new-');
    const outside = makeRoot('morrow-watch-outside-');
    mkdirSync(path.join(first, 'Media'), { recursive: true });
    mkdirSync(path.join(outside, 'External'), { recursive: true });
    const firstEvents: Array<{
      path: string;
      text: string | null;
      other?: boolean;
      size?: number;
      emptyFolder?: boolean;
    }> = [];
    const secondEvents: Array<{
      path: string;
      text: string | null;
      other?: boolean;
      size?: number;
      emptyFolder?: boolean;
    }> = [];
    await openVault(first, (changes) => firstEvents.push(...changes));

    mkdirSync(path.join(first, 'Empty folder'));
    await waitFor(() => firstEvents.some((change) => change.path === 'Empty folder' && change.emptyFolder));
    writeFileSync(path.join(first, 'Media', 'One.PDF'), 'one');
    await waitFor(() => firstEvents.some((change) => change.path === 'Media/One.PDF' && change.size === 3));
    renameSync(path.join(first, 'Media', 'One.PDF'), path.join(first, 'Media', 'Renamed.PDF'));
    await waitFor(() =>
      firstEvents.some((change) => change.path === 'Media/Renamed.PDF' && change.text === ''),
    );
    rmSync(path.join(first, 'Media', 'Renamed.PDF'));
    await waitFor(() =>
      firstEvents.some((change) => change.path === 'Media/Renamed.PDF' && change.text === null),
    );

    makeDirectoryLink(outside, path.join(first, 'external-link'));
    await new Promise((resolve) => setTimeout(resolve, 220));
    writeFileSync(path.join(outside, 'External', 'Outside.pdf'), 'outside');
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(firstEvents.some((change) => change.path.toLowerCase().includes('external-link'))).toBe(false);

    writeFileSync(path.join(first, 'Late-old-vault.pdf'), 'late');
    await openVault(second, (changes) => secondEvents.push(...changes));
    await new Promise((resolve) => setTimeout(resolve, 240));
    expect(secondEvents.some((change) => change.path.includes('Late-old-vault'))).toBe(false);
    writeFileSync(path.join(second, 'Current.pdf'), 'current');
    await waitFor(() => secondEvents.some((change) => change.path === 'Current.pdf'));
    expect(secondEvents.every((change) => !change.path.startsWith('Media/'))).toBe(true);
  });

  it('ignores internal directory junction and file symlink aliases in scans and watcher events', async () => {
    const root = makeRoot('morrow-watch-internal-links-');
    const target = path.join(root, 'Target');
    const aliasPaths = ['internal-directory-alias', 'late-directory-alias', 'internal-file-alias.pdf'];
    const file = path.join(target, 'Inside.pdf');
    mkdirSync(target);
    writeFileSync(file, 'original');
    makeDirectoryLink(target, path.join(root, aliasPaths[0]!));
    const initialFileLinkCreated = makeFileLink(file, path.join(root, aliasPaths[2]!));
    if (process.platform !== 'win32') expect(initialFileLinkCreated).toBe(true);
    const events: Array<{ path: string; text: string | null; other?: boolean }> = [];

    await openVault(root, (changes) => events.push(...changes));
    const scan = (await scanVault()) as ScanResult;
    expect(scan.resources.map((resource) => resource.path)).toEqual(['Target/Inside.pdf']);

    makeDirectoryLink(target, path.join(root, aliasPaths[1]!));
    const lateFileLinkCreated = makeFileLink(file, path.join(root, 'late-file-alias.pdf'));
    if (process.platform !== 'win32') expect(lateFileLinkCreated).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 350));

    writeFileSync(file, 'updated');
    await waitFor(() => events.some((change) => change.path === 'Target/Inside.pdf'));
    const reportedAliases = events.filter(
      (change) => aliasPaths.includes(change.path) || change.path === 'late-file-alias.pdf',
    );

    expect(reportedAliases).toEqual([]);
  });

  it('does not publish changes from a stale read after a vault switch', async () => {
    const first = makeRoot('morrow-watch-stale-old-');
    const second = makeRoot('morrow-watch-stale-new-');
    mkdirSync(path.join(first, 'Media'));
    mkdirSync(path.join(first, '.morrow'));
    writeFileSync(path.join(first, 'Media', 'Original.md'), 'old page');
    writeFileSync(path.join(first, '.morrow', 'workspace.json'), '{"pages":{}}');
    let enterRead: () => void = () => {};
    let release: () => void = () => {};
    const delayed = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (enterRead = resolve));
    const originalReadFile = mutableFsPromises.readFile.bind(mutableFsPromises);
    const readSpy = vi.spyOn(mutableFsPromises, 'readFile').mockImplementation(async (file, ...args) => {
      if (String(file).endsWith(path.join('.morrow', 'workspace.json'))) {
        enterRead();
        await delayed;
      }
      return originalReadFile(file, ...args);
    });
    await openVault(first, () => undefined);
    const pending = scanVault();
    await started;
    await openVault(second, () => undefined);
    release();

    await expect(pending).rejects.toThrow('The vault changed during the scan.');
    expect(readSpy.mock.calls.some(([file]) => String(file).startsWith(second))).toBe(false);
    readSpy.mockRestore();
  });

  it('does not publish an in-flight watcher read after switching vaults', async () => {
    const first = makeRoot('morrow-watch-read-old-');
    const second = makeRoot('morrow-watch-read-new-');
    const watchedFile = path.join(first, 'Delayed.md');
    writeFileSync(watchedFile, 'before');
    const firstEvents: Array<{ path: string; text: string | null }> = [];
    const secondEvents: Array<{ path: string; text: string | null }> = [];
    await openVault(first, (changes) => firstEvents.push(...changes));

    let enterRead: () => void = () => {};
    let releaseRead: () => void = () => {};
    const started = new Promise<void>((resolve) => (enterRead = resolve));
    const delayedRead = new Promise<void>((resolve) => (releaseRead = resolve));
    const originalReadFile = mutableFsPromises.readFile.bind(mutableFsPromises);
    const readSpy = vi.spyOn(mutableFsPromises, 'readFile').mockImplementation(async (file, ...args) => {
      if (String(file) === watchedFile) {
        enterRead();
        await delayedRead;
      }
      return originalReadFile(file, ...args);
    });

    writeFileSync(watchedFile, 'after');
    await started;
    await openVault(second, (changes) => secondEvents.push(...changes));
    releaseRead();
    await new Promise((resolve) => setTimeout(resolve, 220));

    expect(firstEvents.some((change) => change.path === 'Delayed.md')).toBe(false);
    expect(secondEvents.some((change) => change.path === 'Delayed.md')).toBe(false);
    readSpy.mockRestore();
  });
});
