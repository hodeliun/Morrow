import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { VaultScan } from '../core/vault/load';
import type { VaultOp, VaultOpResult } from '../core/vault/plan';
import type { VaultBridge, VaultChange, VaultFileInfo } from './vaultBridge';
import { E003_POLARIS_DADOS_FIXTURE } from './fixtures/e003-polaris-dados';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';

class NodeFileVaultBridge implements VaultBridge {
  private readonly listeners = new Set<(changes: VaultChange[]) => void>();
  beforeNextApply: (() => Promise<void>) | null = null;

  constructor(readonly root: string) {}

  private path(path: string): string {
    return join(this.root, ...path.split('/'));
  }

  async scan(): Promise<VaultScan> {
    const files: VaultScan['files'] = [];
    const folders: VaultScan['folders'] = [];
    const others: string[] = [];

    const visit = async (relative: string): Promise<void> => {
      const directory = relative ? this.path(relative) : this.root;
      const entries = await readdir(directory, { withFileTypes: true });
      if (relative) {
        const info = await stat(directory);
        folders.push({ path: relative, mtime: info.mtimeMs, empty: entries.length === 0 });
      }
      for (const entry of entries) {
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        const absolute = this.path(path);
        if (entry.isDirectory()) {
          await visit(path);
          continue;
        }
        const info = await stat(absolute);
        if (['.md', '.canvas'].includes(extname(path).toLowerCase())) {
          files.push({
            path,
            text: await readFile(absolute, 'utf8'),
            mtime: info.mtimeMs,
            birthtime: info.birthtimeMs,
          });
        } else {
          others.push(path);
        }
      }
    };

    await visit('');
    const json = async (path: string): Promise<unknown> => {
      const text = await this.readText(path);
      if (text === null) return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return null;
      }
    };
    return {
      files,
      folders,
      others,
      registry: await json('.morrow/workspace.json'),
      recent: await json('.morrow/recent.json'),
    };
  }

  async apply(ops: VaultOp[]): Promise<VaultOpResult[]> {
    const beforeApply = this.beforeNextApply;
    this.beforeNextApply = null;
    await beforeApply?.();
    const results: VaultOpResult[] = [];
    for (const op of ops) {
      try {
        if (op.op === 'check') {
          const current = await this.readText(op.path);
          if (current !== op.expect) {
            results.push({ ok: false, code: 'conflict', message: 'changed on disk', current });
            break;
          }
        } else if (op.op === 'write') {
          const current = await this.readText(op.path);
          if (op.expect !== undefined && current !== op.expect) {
            results.push({ ok: false, code: 'conflict', message: 'changed on disk', current });
            break;
          }
          await mkdir(dirname(this.path(op.path)), { recursive: true });
          await writeFile(this.path(op.path), op.text, 'utf8');
        } else if (op.op === 'rename') {
          try {
            await access(this.path(op.from));
          } catch {
            if (op.optional) {
              results.push({ ok: true });
              continue;
            }
            results.push({ ok: false, code: 'error', message: `missing: ${op.from}` });
            break;
          }
          try {
            await access(this.path(op.to));
            results.push({ ok: false, code: 'exists', message: `${op.to} exists` });
            break;
          } catch {
            await mkdir(dirname(this.path(op.to)), { recursive: true });
            await rename(this.path(op.from), this.path(op.to));
          }
        } else if (op.op === 'remove' || op.op === 'delete') {
          await unlink(this.path(op.path)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
        } else if (op.op === 'rmdir') {
          await rmdir(this.path(op.path)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
          });
        }
        results.push({ ok: true });
      } catch (error) {
        results.push({ ok: false, code: 'error', message: String(error) });
        break;
      }
    }
    return results;
  }

  async readText(path: string): Promise<string | null> {
    try {
      return await readFile(this.path(path), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async readBytes(path: string): Promise<ArrayBuffer | null> {
    try {
      const bytes = await readFile(this.path(path));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async createFile(path: string, data: ArrayBuffer): Promise<void> {
    await mkdir(dirname(this.path(path)), { recursive: true });
    await writeFile(this.path(path), new Uint8Array(data), { flag: 'wx' });
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(this.path(path));
      return true;
    } catch {
      return false;
    }
  }

  async listFiles(directory: string): Promise<VaultFileInfo[]> {
    const names = await readdir(this.path(directory), { withFileTypes: true });
    const files: VaultFileInfo[] = [];
    for (const entry of names) {
      if (!entry.isFile()) continue;
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      const info = await stat(this.path(path));
      files.push({ path, size: info.size, mtime: info.mtimeMs });
    }
    return files;
  }

  onChange(listener: (changes: VaultChange[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  fileUrl(): null {
    return null;
  }
}

async function makeVault(files: Record<string, string>): Promise<NodeFileVaultBridge> {
  const root = await mkdtemp(join(tmpdir(), 'morrow-e003-guard-'));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return new NodeFileVaultBridge(root);
}

async function dispose(bridge: NodeFileVaultBridge): Promise<void> {
  await rm(bridge.root, { recursive: true, force: true });
}

async function fingerprint(bridge: NodeFileVaultBridge, paths: string[]) {
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => {
        const content = await readFile(join(bridge.root, ...path.split('/')));
        const info = await stat(join(bridge.root, ...path.split('/')), { bigint: true });
        return [
          path,
          {
            sha256: createHash('sha256').update(content).digest('hex'),
            mtimeNs: info.mtimeNs.toString(),
          },
        ];
      }),
    ),
  );
}

async function open(bridge: NodeFileVaultBridge): Promise<WorkspaceSession> {
  let nextId = 0;
  const result = await WorkspaceSession.open(new VaultRepository(bridge, () => `node-${++nextId}`), {
    delayMs: 0,
  });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function idAt(session: WorkspaceSession, path: string) {
  const id = Object.keys(session.getState().pages).find((candidate) => session.pathOf(candidate) === path);
  if (!id) throw new Error(`No page at ${path}`);
  return id;
}

describe('independent Polaris Dados guard checks over real temporary files', () => {
  it('opens and closes a synthetic vault without changing Markdown, registry, or asset bytes/mtime', async () => {
    const fixture = {
      ...E003_POLARIS_DADOS_FIXTURE,
      'attachments/opaque-asset.bin': 'synthetic binary asset\u0000payload',
    };
    const bridge = await makeVault(fixture);
    const paths = Object.keys(fixture);
    try {
      const before = await fingerprint(bridge, paths);
      const session = await open(bridge);
      expect(await session.flush()).toBe(true);
      await session.close();
      expect(await fingerprint(bridge, paths)).toEqual(before);
    } finally {
      await dispose(bridge);
    }
  });

  it('allows editing a basic database with Morrow-written pretty metadata and survives restart', async () => {
    const basicFixture = { ...E003_POLARIS_DADOS_FIXTURE };
    basicFixture['Inventory.md'] = basicFixture['Inventory.md']!.replace(
      'polarisDados:\n  version: 1\n  provider: polaris-dados\n',
      '',
    );
    expect(basicFixture['Inventory.md']).not.toContain('polarisDados:');
    const bridge = await makeVault(basicFixture);
    try {
      const first = await open(bridge);
      const row = idAt(first, 'Inventory/Widget.md');
      const schemaBefore = await fingerprint(bridge, ['Inventory.md']);
      expect(first.execute({ type: 'page.setProperties', id: row, values: { quantity: 3 }, now: 10 }).ok).toBe(
        true,
      );
      expect(await first.flush()).toBe(true);
      const registry = await bridge.readText('.morrow/workspace.json');
      expect(registry).toContain('\n');
      await first.close();

      const second = await open(bridge);
      const reopenedRow = idAt(second, 'Inventory/Widget.md');
      expect(second.getState().pages[reopenedRow]?.properties.quantity).toBe(3);
      expect(
        second.execute({ type: 'page.setProperties', id: reopenedRow, values: { quantity: 4 }, now: 11 }).ok,
      ).toBe(true);
      expect(await second.flush()).toBe(true);
      await second.close();

      const final = await open(bridge);
      const finalRow = idAt(final, 'Inventory/Widget.md');
      expect(final.getState().pages[finalRow]?.properties.quantity).toBe(4);
      expect(await fingerprint(bridge, ['Inventory.md'])).toEqual(schemaBefore);
      expect(await bridge.readText('Inventory/Widget.md')).toContain('opaque-widget-7f21');
      await final.close();
    } finally {
      await dispose(bridge);
    }
  });

  it('rejects a future workspace registry added after open before renaming a page', async () => {
    const bridge = await makeVault({ 'Note.md': '# Stable note\n' });
    try {
      const session = await open(bridge);
      await session.markInitialized();
      const registryPath = join(bridge.root, '.morrow/workspace.json');
      const registry = JSON.parse(await readFile(registryPath, 'utf8')) as Record<string, unknown>;
      registry.futureField = { id: 'opaque-future-registry' };
      await writeFile(registryPath, `${JSON.stringify(registry, null, 1)}\n`);
      const protectedState = await fingerprint(bridge, ['Note.md', '.morrow/workspace.json']);

      const id = idAt(session, 'Note.md');
      expect(session.execute({ type: 'page.rename', id, title: 'Changed note', now: 12 }).ok).toBe(true);
      expect(await session.flush()).toBe(false);
      expect(await bridge.exists('Note.md')).toBe(true);
      expect(await bridge.exists('Changed note.md')).toBe(false);
      expect(await fingerprint(bridge, ['Note.md', '.morrow/workspace.json'])).toEqual(protectedState);
      await session.close();
    } finally {
      await dispose(bridge);
    }
  });

  it('does not overwrite future workspace metadata that arrives between preflight and apply', async () => {
    const bridge = await makeVault({ 'Note.md': '# Stable note\n' });
    try {
      const session = await open(bridge);
      await session.markInitialized();
      const registryPath = join(bridge.root, '.morrow/workspace.json');
      bridge.beforeNextApply = async () => {
        const registry = JSON.parse(await readFile(registryPath, 'utf8')) as Record<string, unknown>;
        registry.futureField = { id: 'raced-future-field' };
        await writeFile(registryPath, `${JSON.stringify(registry, null, 1)}\n`);
      };

      const id = idAt(session, 'Note.md');
      expect(session.execute({ type: 'page.rename', id, title: 'Changed note', now: 12 }).ok).toBe(true);
      const flush = await session.flush();
      const noteExists = await bridge.exists('Note.md');
      const renamedExists = await bridge.exists('Changed note.md');
      const metadata = JSON.parse((await bridge.readText('.morrow/workspace.json'))!) as Record<string, unknown>;
      await session.close();

      expect({
        flush,
        noteExists,
        renamedExists,
        futureFieldPreserved: Object.hasOwn(metadata, 'futureField'),
      }).toEqual({
        flush: false,
        noteExists: true,
        renamedExists: false,
        futureFieldPreserved: true,
      });
    } finally {
      await dispose(bridge);
    }
  });

  it('does not retry a page write over fork-only content that arrives after load', async () => {
    const bridge = await makeVault({ 'Note.md': '# Stable note\n' });
    try {
      const session = await open(bridge);
      const id = idAt(session, 'Note.md');
      const forkMarker = '<!-- morrow:image align="right" width="35%" -->';
      let externalState: Awaited<ReturnType<typeof fingerprint>> | null = null;
      bridge.beforeNextApply = async () => {
        await writeFile(join(bridge.root, 'Note.md'), `# Stable note\n\n${forkMarker}\n`);
        externalState = await fingerprint(bridge, ['Note.md']);
      };

      expect(
        session.execute({
          type: 'page.setDoc',
          id,
          doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Edited' }] }] },
          now: 16,
        }).ok,
      ).toBe(true);
      const flush = await session.flush();
      const after = await fingerprint(bridge, ['Note.md']);
      const finalText = await bridge.readText('Note.md');
      await session.close();

      expect({
        flush,
        markerPreserved: finalText?.includes(forkMarker) ?? false,
        hashAndMtimePreserved: externalState !== null && JSON.stringify(after) === JSON.stringify(externalState),
      }).toEqual({ flush: false, markerPreserved: true, hashAndMtimePreserved: true });
    } finally {
      await dispose(bridge);
    }
  });

  it('blocks edits to fork-only schemas and document formats without changing protected files or assets', async () => {
    const fixture = {
      ...E003_POLARIS_DADOS_FIXTURE,
      'attachments/opaque-asset.bin': 'synthetic binary asset\u0000payload',
    };
    const bridge = await makeVault(fixture);
    const paths = Object.keys(fixture);
    try {
      const before = await fingerprint(bridge, paths);
      const session = await open(bridge);
      const legacy = idAt(session, 'Archive/Legacy.md');
      const row = idAt(session, 'Archive/Legacy/Row.md');
      const inventory = idAt(session, 'Inventory.md');

      expect(session.unreadable.has(legacy)).toBe(true);
      expect(session.unreadable.has(row)).toBe(true);
      expect(session.execute({ type: 'page.rename', id: legacy, title: 'Unsafe rename', now: 13 }).ok).toBe(
        false,
      );
      expect(
        session.executeAll([
          { type: 'page.setIcon', id: inventory, icon: '📦', now: 14 },
          { type: 'page.setFields', id: row, extra: {}, now: 15 },
        ]).ok,
      ).toBe(false);
      expect(session.getState().pages[inventory]?.icon).toBeNull();
      expect(await session.flush()).toBe(true);
      await session.close();
      expect(await fingerprint(bridge, paths)).toEqual(before);

      const reopened = await open(bridge);
      expect(reopened.unreadable.has(idAt(reopened, 'Archive/Legacy.md'))).toBe(true);
      expect(reopened.unreadable.has(idAt(reopened, 'Archive/Legacy/Row.md'))).toBe(true);
      await reopened.close();
      expect(await fingerprint(bridge, paths)).toEqual(before);
    } finally {
      await dispose(bridge);
    }
  });
});
