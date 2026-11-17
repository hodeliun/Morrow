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
import { createDataApi } from '../app/plugins/dataApi';
import type { DataApiSnapshot } from '../app/plugins/dataApi';
import type { VaultBridge, VaultChange, VaultFileInfo } from './vaultBridge';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';

const ORIGINAL_FIXTURE = {
  database: new URL('../../plugins/polaris-dados/fixture/Inventory.md', import.meta.url),
  row: new URL('../../plugins/polaris-dados/fixture/Inventory/Widget.md', import.meta.url),
};

class NodeFileVaultBridge implements VaultBridge {
  private readonly listeners = new Set<(changes: VaultChange[]) => void>();

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
      return text === null ? null : (JSON.parse(text) as unknown);
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

  async external(path: string, text: string): Promise<void> {
    await mkdir(dirname(this.path(path)), { recursive: true });
    await writeFile(this.path(path), text, 'utf8');
    const info = await stat(this.path(path));
    const change: VaultChange = {
      path,
      text,
      mtime: info.mtimeMs,
      birthtime: info.birthtimeMs,
    };
    for (const listener of this.listeners) listener([change]);
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
      const path = `${directory}/${entry.name}`;
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

async function makeVault(): Promise<NodeFileVaultBridge> {
  const root = await mkdtemp(join(tmpdir(), 'morrow-e003-navigation-'));
  const [database, row] = await Promise.all([
    readFile(ORIGINAL_FIXTURE.database),
    readFile(ORIGINAL_FIXTURE.row),
  ]);
  await mkdir(join(root, 'Inventory'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'Inventory.md'), database),
    writeFile(join(root, 'Inventory', 'Widget.md'), row),
  ]);
  return new NodeFileVaultBridge(root);
}

async function fingerprint(bridge: NodeFileVaultBridge, path: string) {
  const absolute = join(bridge.root, ...path.split('/'));
  const [content, info] = await Promise.all([readFile(absolute), stat(absolute, { bigint: true })]);
  return {
    sha256: createHash('sha256').update(content).digest('hex'),
    mtimeNs: info.mtimeNs.toString(),
  };
}

async function open(bridge: NodeFileVaultBridge): Promise<WorkspaceSession> {
  let nextId = 0;
  const result = await WorkspaceSession.open(new VaultRepository(bridge, () => `navigation-${++nextId}`), {
    delayMs: 60_000,
  });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function idAt(session: WorkspaceSession, path: string): string {
  const id = Object.keys(session.getState().pages).find((candidate) => session.pathOf(candidate) === path);
  if (!id) throw new Error(`No page at ${path}`);
  return id;
}

function ready(snapshot: DataApiSnapshot) {
  if (snapshot.status !== 'ready') throw new Error(`Expected ready snapshot, received ${snapshot.status}.`);
  return snapshot;
}

function dataApi(session: WorkspaceSession) {
  let cleanup = () => {};
  const api = createDataApi({
    session,
    ownerIsActive: () => true,
    isProviderActive: () => true,
    isHostReadonly: () => false,
    registerCleanup: (onCleanup) => {
      cleanup = onCleanup;
    },
  });
  return { api, cleanup };
}

describe('Polaris Dados source preservation during navigation', () => {
  it('preserves original opted-in database and row bytes/mtime when markOpened updates recent metadata', async () => {
    const bridge = await makeVault();
    const paths = ['Inventory.md', 'Inventory/Widget.md'];
    try {
      const originalDatabase = await bridge.readText('Inventory.md');
      expect(originalDatabase).toContain('filters: []');
      expect(originalDatabase).toContain('sorts: []');
      expect(originalDatabase).toContain('groupBy: null');
      expect(originalDatabase).toContain('dateProp: null');
      expect(originalDatabase).toContain('hidden: []');
      const before = await Promise.all(paths.map((path) => fingerprint(bridge, path)));
      const session = await open(bridge);
      const databaseId = idAt(session, 'Inventory.md');
      expect(session.execute({ type: 'page.markOpened', id: databaseId, now: 123 }).ok).toBe(true);
      expect(await session.flush()).toBe(true);
      expect(await Promise.all(paths.map((path) => fingerprint(bridge, path)))).toEqual(before);

      const recent = JSON.parse((await bridge.readText('.morrow/recent.json')) ?? 'null') as {
        opened: Record<string, number>;
      };
      expect(recent.opened[databaseId]).toBe(123);

      const rowId = idAt(session, 'Inventory/Widget.md');
      expect(session.execute({ type: 'page.markOpened', id: rowId, now: 124 }).ok).toBe(true);
      expect(await session.flush()).toBe(true);
      expect(await Promise.all(paths.map((path) => fingerprint(bridge, path)))).toEqual(before);
      const recentAfterRowOpen = JSON.parse((await bridge.readText('.morrow/recent.json')) ?? 'null') as {
        opened: Record<string, number>;
      };
      expect(recentAfterRowOpen.opened[rowId]).toBe(124);

      await session.close();
      const reopened = await open(bridge);
      expect(idAt(reopened, 'Inventory.md')).toBe(databaseId);
      expect(reopened.getState().pages[databaseId]?.lastOpenedAt).toBe(123);
      expect(reopened.getState().pages[rowId]?.lastOpenedAt).toBe(124);
      expect(await Promise.all(paths.map((path) => fingerprint(bridge, path)))).toEqual(before);
      await reopened.close();
    } finally {
      await rm(bridge.root, { recursive: true, force: true });
    }
  });

  it('keeps the source freshness guard active when an opted-in source changes externally', async () => {
    const bridge = await makeVault();
    try {
      const session = await open(bridge);
      const databaseId = idAt(session, 'Inventory.md');
      const externalText = `${await bridge.readText('Inventory.md')}\nExternal edit.\n`;
      await writeFile(join(bridge.root, 'Inventory.md'), externalText, 'utf8');

      expect(session.execute({ type: 'page.markOpened', id: databaseId, now: 456 }).ok).toBe(true);
      expect(await session.flush()).toBe(false);
      expect(session.saveStatus).toMatchObject({ state: 'error', errorCode: 'save-conflict' });
      expect(await bridge.readText('Inventory.md')).toBe(externalText);
      expect(await bridge.readText('.morrow/recent.json')).toBeNull();
      await session.close();
    } finally {
      await rm(bridge.root, { recursive: true, force: true });
    }
  });

  it('does not mistake a reentrant dirty patch for the external file state accepted by the watcher', async () => {
    const bridge = await makeVault();
    try {
      const session = await open(bridge);
      const databaseId = idAt(session, 'Inventory.md');
      const rowId = idAt(session, 'Inventory/Widget.md');
      const { api, cleanup } = dataApi(session);
      let staged = false;
      const unsubscribe = api.subscribe(databaseId, (snapshot) => {
        if (
          staged ||
          snapshot.status !== 'ready' ||
          snapshot.rows.find((row) => row.id === rowId)?.properties.quantity !== 4
        ) {
          return;
        }
        staged = true;
        expect(
          api.patchCell({
            databaseId,
            rowId,
            propertyId: 'quantity',
            value: 3,
            expectedRevision: snapshot.revision,
          }),
        ).toMatchObject({ status: 'staged' });
      });

      const externalText = (await bridge.readText('Inventory/Widget.md'))!.replace('Quantity: 2', 'Quantity: 4');
      await bridge.external('Inventory/Widget.md', externalText);
      expect(staged).toBe(true);
      expect(session.queue.isDirty(rowId)).toBe(true);
      expect(await api.flush(databaseId)).toMatchObject({ status: 'persisted' });
      expect(await bridge.readText('Inventory/Widget.md')).toContain('Quantity: 3');

      unsubscribe();
      cleanup();
      await session.close();
      const reopened = await open(bridge);
      const reopenedApi = dataApi(reopened);
      expect(ready(reopenedApi.api.snapshot(idAt(reopened, 'Inventory.md'))).rows.find((row) => row.id === rowId)?.properties.quantity).toBe(3);
      reopenedApi.cleanup();
      await reopened.close();
    } finally {
      await rm(bridge.root, { recursive: true, force: true });
    }
  });

  it('writes a real Quantity 2-to-3 patch while preserving the database source and reopening as 3', async () => {
    const bridge = await makeVault();
    try {
      const databaseBefore = await fingerprint(bridge, 'Inventory.md');
      const session = await open(bridge);
      const databaseId = idAt(session, 'Inventory.md');
      const rowId = idAt(session, 'Inventory/Widget.md');
      const { api, cleanup } = dataApi(session);
      const initial = ready(api.snapshot(databaseId));
      expect(initial.rows.find((row) => row.id === rowId)?.properties.quantity).toBe(2);

      expect(
        api.patchCell({
          databaseId,
          rowId,
          propertyId: 'quantity',
          value: 3,
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'staged' });
      expect(await api.flush(databaseId)).toMatchObject({ status: 'persisted' });
      expect(await fingerprint(bridge, 'Inventory.md')).toEqual(databaseBefore);
      expect((await bridge.readText('Inventory/Widget.md'))).toContain('Quantity: 3');

      cleanup();
      await session.close();
      const reopened = await open(bridge);
      const reopenedDatabaseId = idAt(reopened, 'Inventory.md');
      const reopenedApi = dataApi(reopened);
      const afterRestart = ready(reopenedApi.api.snapshot(reopenedDatabaseId));
      const reopenedRow = afterRestart.rows.find((row) => row.id === rowId);
      expect(reopenedRow?.properties.quantity).toBe(3);
      expect(await fingerprint(bridge, 'Inventory.md')).toEqual(databaseBefore);
      reopenedApi.cleanup();
      await reopened.close();
    } finally {
      await rm(bridge.root, { recursive: true, force: true });
    }
  });
});
