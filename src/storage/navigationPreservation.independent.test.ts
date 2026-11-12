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
import type { DataApi, DataApiPatchResult, DataApiSnapshot } from '../app/plugins/dataApi';
import type { VaultBridge, VaultChange, VaultFileInfo } from './vaultBridge';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';

const DATABASE_PATH = 'Inventory.md';
const ROW_PATH = 'Inventory/Widget.md';
const BASIC_PATH = 'Basic.md';
const WORKSPACE_PATH = '.morrow/workspace.json';
const RECENT_PATH = '.morrow/recent.json';
const BASIC_HISTORY_PATH = '.morrow/history/basic-note.json';
const databaseId = 'inventory-db';
const rowId = 'widget-row';

const DATABASE_MARKDOWN = `---
kind: database
polarisDados:
  version: 1
  provider: polaris-dados
database:
  properties:
    - id: name
      name: Name
      type: text
    - id: quantity
      name: Quantity
      type: number
    - id: price
      name: Price
      type: number
    - id: total
      name: Total
      type: formula
      formula: Quantity * Price
  views:
    - id: inventory-table-v1
      name: Table
      type: table
      filters: []
      sorts: []
      groupBy: null
      dateProp: null
      hidden: []
---
# Inventory
`;

const ROW_MARKDOWN = `---
Name: Widget
Quantity: 2
Price: 10
vendorRecord:
  id: opaque-widget-7f21
  audit:
    source: synthetic
    tags: [retain, nested]
---
Basic upstream row.
`;

const WORKSPACE_TEXT = `${JSON.stringify({
  version: 1,
  pages: {
    [BASIC_PATH]: { id: 'basic-note', created: 1794470400000, order: 1 },
    [DATABASE_PATH]: { id: databaseId, created: 1794470400000, order: 0 },
    [ROW_PATH]: { id: rowId, created: 1794470400000, order: 0 },
  },
}, null, 1)}\n`;

const RECENT_TEXT = `${JSON.stringify({
  version: 1,
  opened: { [rowId]: 222 },
  activity: { '2026-11-10': 4 },
})}\n`;

const FILES: Readonly<Record<string, string>> = {
  [DATABASE_PATH]: DATABASE_MARKDOWN,
  [ROW_PATH]: ROW_MARKDOWN,
  [BASIC_PATH]: '# Basic\nOriginal basic note.\n',
  [WORKSPACE_PATH]: WORKSPACE_TEXT,
  [RECENT_PATH]: RECENT_TEXT,
};

const TRACKED_PATHS = [DATABASE_PATH, ROW_PATH, BASIC_PATH, WORKSPACE_PATH, RECENT_PATH] as const;

class NodeFileVaultBridge implements VaultBridge {
  private readonly listeners = new Set<(changes: VaultChange[]) => void>();
  applyCount = 0;
  readonly appliedOps: VaultOp[][] = [];
  readonly applyResults: VaultOpResult[][] = [];
  afterSuccessfulCheck: ((path: string) => Promise<void>) | null = null;

  constructor(readonly root: string) {}

  private absolute(path: string): string {
    return join(this.root, ...path.split('/'));
  }

  absoluteForTest(path: string): string {
    return this.absolute(path);
  }

  async scan(): Promise<VaultScan> {
    const files: VaultScan['files'] = [];
    const folders: VaultScan['folders'] = [];
    const others: string[] = [];
    const visit = async (relative: string): Promise<void> => {
      const directory = relative ? this.absolute(relative) : this.root;
      const entries = await readdir(directory, { withFileTypes: true });
      if (relative) {
        const info = await stat(directory);
        folders.push({ path: relative, mtime: info.mtimeMs, empty: entries.length === 0 });
      }
      for (const entry of entries) {
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        const absolute = this.absolute(path);
        if (entry.isDirectory()) {
          await visit(path);
          continue;
        }
        const info = await stat(absolute);
        if (['.md', '.canvas'].includes(extname(path).toLowerCase())) {
          files.push({ path, text: await readFile(absolute, 'utf8'), mtime: info.mtimeMs, birthtime: info.birthtimeMs });
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
      registry: await json(WORKSPACE_PATH),
      recent: await json(RECENT_PATH),
    };
  }

  async apply(ops: VaultOp[]): Promise<VaultOpResult[]> {
    this.applyCount += 1;
    this.appliedOps.push(ops.map((op) => ({ ...op })) as VaultOp[]);
    const results: VaultOpResult[] = [];
    for (const op of ops) {
      try {
        if (op.op === 'check') {
          const current = await this.readText(op.path);
          if (current !== op.expect) {
            results.push({ ok: false, code: 'conflict', message: 'changed on disk', current });
            break;
          }
          await this.afterSuccessfulCheck?.(op.path);
        } else if (op.op === 'write') {
          const current = await this.readText(op.path);
          if (op.expect !== undefined && current !== op.expect) {
            results.push({ ok: false, code: 'conflict', message: 'changed on disk', current });
            break;
          }
          await mkdir(dirname(this.absolute(op.path)), { recursive: true });
          await writeFile(this.absolute(op.path), op.text, 'utf8');
        } else if (op.op === 'rename') {
          try {
            await access(this.absolute(op.from));
          } catch {
            if (op.optional) {
              results.push({ ok: true });
              continue;
            }
            results.push({ ok: false, code: 'error', message: `missing: ${op.from}` });
            break;
          }
          try {
            await access(this.absolute(op.to));
            results.push({ ok: false, code: 'exists', message: `${op.to} exists` });
            break;
          } catch {
            await mkdir(dirname(this.absolute(op.to)), { recursive: true });
            await rename(this.absolute(op.from), this.absolute(op.to));
          }
        } else if (op.op === 'remove' || op.op === 'delete') {
          await unlink(this.absolute(op.path)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
        } else if (op.op === 'rmdir') {
          await rmdir(this.absolute(op.path)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
          });
        }
        results.push({ ok: true });
      } catch (error) {
        results.push({ ok: false, code: 'error', message: String(error) });
        break;
      }
    }
    this.applyResults.push(results);
    return results;
  }

  async readText(path: string): Promise<string | null> {
    try {
      return await readFile(this.absolute(path), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async readBytes(path: string): Promise<ArrayBuffer | null> {
    try {
      const bytes = await readFile(this.absolute(path));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async createFile(path: string, data: ArrayBuffer): Promise<void> {
    await mkdir(dirname(this.absolute(path)), { recursive: true });
    await writeFile(this.absolute(path), new Uint8Array(data), { flag: 'wx' });
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(this.absolute(path));
      return true;
    } catch {
      return false;
    }
  }

  async listFiles(directory: string): Promise<VaultFileInfo[]> {
    const files: VaultFileInfo[] = [];
    for (const entry of await readdir(this.absolute(directory), { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      const info = await stat(this.absolute(path));
      files.push({ path, size: info.size, mtime: info.mtimeMs });
    }
    return files;
  }

  onChange(listener: (changes: VaultChange[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async externalWrite(path: string, text: string): Promise<void> {
    await writeFile(this.absolute(path), text, 'utf8');
    const info = await stat(this.absolute(path));
    const change: VaultChange = { path, text, mtime: info.mtimeMs, birthtime: info.birthtimeMs };
    for (const listener of [...this.listeners]) listener([change]);
  }

  async externalDelete(path: string): Promise<void> {
    const info = await stat(this.absolute(path));
    await unlink(this.absolute(path));
    const change: VaultChange = { path, text: null, mtime: info.mtimeMs, birthtime: info.birthtimeMs };
    for (const listener of [...this.listeners]) listener([change]);
  }

  fileUrl(): null {
    return null;
  }
}

async function makeVault(overrides: Readonly<Record<string, string>> = {}): Promise<NodeFileVaultBridge> {
  const root = await mkdtemp(join(tmpdir(), 'morrow-e003-navigation-'));
  for (const [path, content] of Object.entries({ ...FILES, ...overrides })) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }
  return new NodeFileVaultBridge(root);
}

async function open(bridge: NodeFileVaultBridge): Promise<WorkspaceSession> {
  let nextId = 0;
  const opened = await WorkspaceSession.open(new VaultRepository(bridge, () => `navigation-${++nextId}`), {
    delayMs: 60_000,
  });
  if (!opened.ok) throw new Error(opened.error);
  return opened.value;
}

function idAt(session: WorkspaceSession, path: string): string {
  const id = Object.keys(session.getState().pages).find((candidate) => session.pathOf(candidate) === path);
  if (!id) throw new Error(`No page at ${path}`);
  return id;
}

function readySnapshot(snapshot: DataApiSnapshot) {
  if (snapshot.status !== 'ready') throw new Error(`Expected ready snapshot, received ${snapshot.status}.`);
  return snapshot;
}

function apiFor(session: WorkspaceSession): { api: DataApi; cleanup: () => void } {
  let cleanup = () => {};
  const api = createDataApi({
    session,
    ownerIsActive: () => true,
    isProviderActive: () => true,
    isHostReadonly: () => false,
    registerCleanup: (dispose) => { cleanup = dispose; },
  });
  return { api, cleanup };
}

async function fingerprintPath(bridge: NodeFileVaultBridge, path: string) {
  const absolute = bridge.absoluteForTest(path);
  const [bytes, info] = await Promise.all([readFile(absolute), stat(absolute, { bigint: true })]);
  return {
    bytes: bytes.toString('utf8'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mtimeNs: info.mtimeNs.toString(),
    size: info.size.toString(),
  };
}

async function fingerprints(bridge: NodeFileVaultBridge) {
  const entries = await Promise.all(TRACKED_PATHS.map(async (path) => [path, await fingerprintPath(bridge, path)] as const));
  return Object.fromEntries(entries) as Record<(typeof TRACKED_PATHS)[number], {
    bytes: string;
    sha256: string;
    mtimeNs: string;
    size: string;
  }>;
}

function writePaths(ops: readonly VaultOp[] | undefined): string[] {
  return (ops ?? [])
    .filter((op): op is Extract<VaultOp, { op: 'write' }> => op.op === 'write')
    .map((op) => op.path);
}

function expectSourceCheckBeforeWrite(ops: readonly VaultOp[]) {
  const sourceCheck = ops.findIndex((op) => op.op === 'check' && op.path === DATABASE_PATH);
  const firstWrite = ops.findIndex((op) => op.op === 'write');
  expect(sourceCheck).toBeGreaterThanOrEqual(0);
  expect(firstWrite).toBeGreaterThan(sourceCheck);
}

async function dispose(bridge: NodeFileVaultBridge) {
  await rm(bridge.root, { recursive: true, force: true });
}

describe('database navigation preserves source files on real temporary filesystem', () => {
  it('records database navigation in recent metadata without rewriting its source or row', async () => {
    const bridge = await makeVault();
    let session: WorkspaceSession | undefined;
    try {
      const before = await fingerprints(bridge);
      session = await open(bridge);
      expect(bridge.applyCount).toBe(0);
      const resolvedDatabaseId = idAt(session, DATABASE_PATH);
      const resolvedRowId = idAt(session, ROW_PATH);
      const opened = session.execute({ type: 'page.markOpened', id: resolvedDatabaseId, now: 123 });
      expect(opened.ok).toBe(true);
      expect(session.getState().pages[databaseId]?.lastOpenedAt).toBe(123);
      expect(await session.flush()).toBe(true);

      const after = await fingerprints(bridge);
      expect(after[DATABASE_PATH]).toEqual(before[DATABASE_PATH]);
      expect(after[ROW_PATH]).toEqual(before[ROW_PATH]);
      expect(after[WORKSPACE_PATH]).toEqual(before[WORKSPACE_PATH]);
      expect(after[RECENT_PATH].bytes).not.toBe(before[RECENT_PATH].bytes);
      expect(after[RECENT_PATH].mtimeNs).not.toBe(before[RECENT_PATH].mtimeNs);
      expect(writePaths(bridge.appliedOps[0])).toEqual([RECENT_PATH]);
      expectSourceCheckBeforeWrite(bridge.appliedOps[0]!);
      expect(JSON.parse(after[RECENT_PATH].bytes)).toEqual({
        version: 1,
        opened: { [resolvedRowId]: 222, [resolvedDatabaseId]: 123 },
        activity: { '2026-11-10': 4 },
      });
      expect(DATABASE_MARKDOWN).toContain('filters: []');
      expect(after[DATABASE_PATH].bytes).toContain('filters: []');
    } finally {
      if (session && !session.isClosed) await session.close();
      await dispose(bridge);
    }
  });

  it('checks an opted-in parent before writing metadata for row-only navigation', async () => {
    const bridge = await makeVault();
    let session: WorkspaceSession | undefined;
    try {
      session = await open(bridge);
      const resolvedDatabaseId = idAt(session, DATABASE_PATH);
      const resolvedRowId = idAt(session, ROW_PATH);
      expect(session.execute({ type: 'page.markOpened', id: resolvedRowId, now: 234 }).ok).toBe(true);
      expect(session.queue.isDirty(resolvedRowId)).toBe(true);
      expect(session.queue.isDirty(resolvedDatabaseId)).toBe(false);

      const externalSource = DATABASE_MARKDOWN.replace(
        '# Inventory',
        '# Inventory\n\nExternal parent edit after load.',
      );
      await writeFile(bridge.absoluteForTest(DATABASE_PATH), externalSource, 'utf8');
      const external = await fingerprints(bridge);

      expect(await session.flush()).toBe(false);
      expect(session.saveStatus.errorCode).toBe('save-conflict');
      expect(bridge.applyCount).toBe(1);
      expect(await fingerprints(bridge)).toEqual(external);
      expect(external[DATABASE_PATH].bytes).toBe(externalSource);

      const operations = bridge.appliedOps[0]!;
      const parentCheck = operations.findIndex(
        (op) => op.op === 'check' && op.path === DATABASE_PATH && op.id === resolvedDatabaseId,
      );
      const firstMutation = operations.findIndex((op) => op.op !== 'check');
      expect(parentCheck).toBeGreaterThanOrEqual(0);
      expect(firstMutation).toBeGreaterThan(parentCheck);

      const results = bridge.applyResults[0]!;
      const failedAt = results.findIndex((result) => !result.ok);
      expect(failedAt).toBe(parentCheck);
      expect(results[failedAt]).toMatchObject({ ok: false, code: 'conflict' });
      expect(results).toHaveLength(failedAt + 1);
      expect(results.slice(0, failedAt).every((result) => result.ok)).toBe(true);
      expect(operations.slice(0, failedAt).every((op) => op.op === 'check')).toBe(true);
    } finally {
      if (session && !session.isClosed) await session.close();
      await dispose(bridge);
    }
  });

  it('keeps load, empty flush, and initialization as no-write operations', async () => {
    const bridge = await makeVault();
    let session: WorkspaceSession | undefined;
    try {
      const before = await fingerprints(bridge);
      session = await open(bridge);
      expect(bridge.applyCount).toBe(0);
      expect(await session.flush()).toBe(true);
      await session.markInitialized();
      expect(bridge.applyCount).toBe(0);
      expect(await fingerprints(bridge)).toEqual(before);
    } finally {
      if (session && !session.isClosed) await session.close();
      await dispose(bridge);
    }
  });

  it('keeps generic opted-in row writes guarded while a public Quantity=3 patch persists only the row', async () => {
    const bridge = await makeVault();
    let session: WorkspaceSession | undefined;
    let apiHandle: { api: DataApi; cleanup: () => void } | undefined;
    try {
      const before = await fingerprints(bridge);
      session = await open(bridge);
      const resolvedDatabaseId = idAt(session, DATABASE_PATH);
      const resolvedRowId = idAt(session, ROW_PATH);
      apiHandle = apiFor(session);
      const generic = session.execute({
        type: 'page.setProperties',
        id: resolvedRowId,
        values: { quantity: 3 },
        now: 456,
      });
      expect(generic.ok).toBe(false);
      const genericBatch = session.executeAll([{
        type: 'page.setProperties',
        id: resolvedRowId,
        values: { quantity: 3 },
        now: 457,
      }]);
      expect(genericBatch.ok).toBe(false);
      expect(session.queue.isDirty(resolvedRowId)).toBe(false);
      expect(await session.flush()).toBe(true);
      expect(bridge.applyCount).toBe(0);
      expect(await fingerprints(bridge)).toEqual(before);

      const snapshot = readySnapshot(apiHandle.api.snapshot(resolvedDatabaseId));
      const patch = apiHandle.api.patchCell({
        databaseId: resolvedDatabaseId,
        rowId: resolvedRowId,
        propertyId: 'quantity',
        value: 3,
        expectedRevision: snapshot.revision,
      });
      expect(patch).toMatchObject({ status: 'staged', databaseId, rowId, propertyId: 'quantity' });
      expect(await apiHandle.api.flush(resolvedDatabaseId)).toMatchObject({ status: 'persisted', databaseId: resolvedDatabaseId });
      expect(bridge.applyCount).toBe(1);

      const after = await fingerprints(bridge);
      expect(after[DATABASE_PATH]).toEqual(before[DATABASE_PATH]);
      expect(after[WORKSPACE_PATH]).toEqual(before[WORKSPACE_PATH]);
      expect(after[RECENT_PATH]).toEqual(before[RECENT_PATH]);
      expect(after[ROW_PATH].bytes).not.toBe(before[ROW_PATH].bytes);
      expect(after[ROW_PATH].bytes).toContain('Quantity: 3');
      expect(after[ROW_PATH].bytes).toContain('Price: 10');
      expect(after[ROW_PATH].bytes).toContain('vendorRecord:');
      expect(writePaths(bridge.appliedOps[0])).toEqual([ROW_PATH]);
      const finalSnapshot = readySnapshot(apiHandle.api.snapshot(resolvedDatabaseId));
      expect(finalSnapshot.rows.find((row) => row.id === resolvedRowId)?.properties.quantity).toBe(3);
    } finally {
      apiHandle?.cleanup();
      if (session && !session.isClosed) await session.close();
      await dispose(bridge);
    }
  });

  it('coalesces database navigation with a public Quantity=3 patch without dropping either write', async () => {
    const bridge = await makeVault();
    let session: WorkspaceSession | undefined;
    let apiHandle: { api: DataApi; cleanup: () => void } | undefined;
    try {
      const before = await fingerprints(bridge);
      session = await open(bridge);
      const resolvedDatabaseId = idAt(session, DATABASE_PATH);
      const resolvedRowId = idAt(session, ROW_PATH);
      apiHandle = apiFor(session);
      const initial = readySnapshot(apiHandle.api.snapshot(resolvedDatabaseId));

      expect(session.execute({ type: 'page.markOpened', id: resolvedDatabaseId, now: 333 }).ok).toBe(true);
      const afterNavigation = readySnapshot(apiHandle.api.snapshot(resolvedDatabaseId));
      expect(afterNavigation.revision).toBe(initial.revision);
      expect(apiHandle.api.patchCell({
        databaseId: resolvedDatabaseId,
        rowId: resolvedRowId,
        propertyId: 'quantity',
        value: 3,
        expectedRevision: afterNavigation.revision,
      })).toMatchObject({ status: 'staged', databaseId: resolvedDatabaseId, rowId: resolvedRowId });
      expect(bridge.applyCount).toBe(0);
      expect(await apiHandle.api.flush(resolvedDatabaseId)).toMatchObject({ status: 'persisted' });

      const after = await fingerprints(bridge);
      expect(after[DATABASE_PATH]).toEqual(before[DATABASE_PATH]);
      expect(after[WORKSPACE_PATH]).toEqual(before[WORKSPACE_PATH]);
      expect(after[ROW_PATH].bytes).toContain('Quantity: 3');
      expect(after[ROW_PATH].bytes).toContain('vendorRecord:');
      expect(JSON.parse(after[RECENT_PATH].bytes).opened).toEqual({
        [resolvedRowId]: 222,
        [resolvedDatabaseId]: 333,
      });
      const batch = bridge.appliedOps[0]!;
      expectSourceCheckBeforeWrite(batch);
      expect(writePaths(batch)).toEqual([ROW_PATH, RECENT_PATH]);
      const finalSnapshot = readySnapshot(apiHandle.api.snapshot(resolvedDatabaseId));
      expect(finalSnapshot.rows.find((row) => row.id === resolvedRowId)?.properties.quantity).toBe(3);
    } finally {
      apiHandle?.cleanup();
      if (session && !session.isClosed) await session.close();
      await dispose(bridge);
    }
  });

  it('persists a reentrant Quantity=3 patch after an accepted external row update and reopens as 3', async () => {
    const initialRow = ROW_MARKDOWN.replace('Quantity: 2', 'Quantity: 1');
    const bridge = await makeVault({ [ROW_PATH]: initialRow });
    let session: WorkspaceSession | undefined;
    let reopened: WorkspaceSession | undefined;
    let apiHandle: { api: DataApi; cleanup: () => void } | undefined;
    let unsubscribe = () => {};
    try {
      const before = await fingerprints(bridge);
      session = await open(bridge);
      const resolvedDatabaseId = idAt(session, DATABASE_PATH);
      const resolvedRowId = idAt(session, ROW_PATH);
      apiHandle = apiFor(session);
      expect(readySnapshot(apiHandle.api.snapshot(resolvedDatabaseId))
        .rows.find((row) => row.id === resolvedRowId)?.properties.quantity).toBe(1);

      let sawExternalTwo = false;
      let reentrantPatch: DataApiPatchResult | undefined;
      const observedQuantities: number[] = [];
      unsubscribe = apiHandle.api.subscribe(resolvedDatabaseId, (snapshot) => {
        if (snapshot.status !== 'ready') return;
        const quantity = snapshot.rows.find((row) => row.id === resolvedRowId)?.properties.quantity;
        if (typeof quantity !== 'number') return;
        observedQuantities.push(quantity);
        if (quantity !== 2 || sawExternalTwo) return;
        sawExternalTwo = true;
        reentrantPatch = apiHandle!.api.patchCell({
          databaseId: resolvedDatabaseId,
          rowId: resolvedRowId,
          propertyId: 'quantity',
          value: 3,
          expectedRevision: snapshot.revision,
        });
      });

      await bridge.externalWrite(ROW_PATH, ROW_MARKDOWN);
      expect(sawExternalTwo).toBe(true);
      expect(reentrantPatch).toMatchObject({ status: 'staged', databaseId: resolvedDatabaseId, rowId: resolvedRowId });
      expect(observedQuantities).toContain(2);
      expect(observedQuantities).toContain(3);
      expect(await bridge.readText(ROW_PATH)).toBe(ROW_MARKDOWN);
      expect(readySnapshot(apiHandle.api.snapshot(resolvedDatabaseId))
        .rows.find((row) => row.id === resolvedRowId)?.properties.quantity).toBe(3);

      expect(await apiHandle.api.flush(resolvedDatabaseId)).toMatchObject({ status: 'persisted' });
      expect(bridge.applyCount).toBe(1);
      const after = await fingerprints(bridge);
      expect(after[DATABASE_PATH]).toEqual(before[DATABASE_PATH]);
      expect(after[WORKSPACE_PATH]).toEqual(before[WORKSPACE_PATH]);
      expect(after[RECENT_PATH]).toEqual(before[RECENT_PATH]);
      expect(after[ROW_PATH].bytes).toContain('Quantity: 3');
      expect(after[ROW_PATH].bytes).toContain('vendorRecord:');
      expectSourceCheckBeforeWrite(bridge.appliedOps[0]!);
      expect(writePaths(bridge.appliedOps[0])).toEqual([ROW_PATH]);

      unsubscribe();
      unsubscribe = () => {};
      apiHandle.cleanup();
      apiHandle = undefined;
      await session.close();
      session = undefined;
      reopened = await open(bridge);
      const reopenedApi = apiFor(reopened);
      try {
        const afterRestart = readySnapshot(reopenedApi.api.snapshot(idAt(reopened, DATABASE_PATH)));
        expect(afterRestart.rows.find((row) => row.id === resolvedRowId)?.properties.quantity).toBe(3);
        expect(await fingerprints(bridge)).toMatchObject({
          [DATABASE_PATH]: before[DATABASE_PATH],
          [WORKSPACE_PATH]: before[WORKSPACE_PATH],
          [RECENT_PATH]: before[RECENT_PATH],
        });
      } finally {
        reopenedApi.cleanup();
      }
    } finally {
      unsubscribe();
      apiHandle?.cleanup();
      if (session && !session.isClosed) await session.close();
      if (reopened && !reopened.isClosed) await reopened.close();
      await dispose(bridge);
    }
  });

  it('keeps a held external row event and its reentrant Quantity=3 patch through flush and reopen', async () => {
    const initialRow = ROW_MARKDOWN.replace('Quantity: 2', 'Quantity: 1');
    const bridge = await makeVault({ [ROW_PATH]: initialRow });
    let session: WorkspaceSession | undefined;
    let reopened: WorkspaceSession | undefined;
    let apiHandle: { api: DataApi; cleanup: () => void } | undefined;
    let unsubscribe = () => {};
    try {
      const before = await fingerprints(bridge);
      session = await open(bridge);
      const resolvedDatabaseId = idAt(session, DATABASE_PATH);
      const resolvedRowId = idAt(session, ROW_PATH);
      apiHandle = apiFor(session);
      expect(readySnapshot(apiHandle.api.snapshot(resolvedDatabaseId))
        .rows.find((row) => row.id === resolvedRowId)?.properties.quantity).toBe(1);

      let sawHeldExternalTwo = false;
      let reentrantPatch: DataApiPatchResult | undefined;
      const observedQuantities: number[] = [];
      let heldExternalRow: Awaited<ReturnType<typeof fingerprintPath>> | undefined;
      unsubscribe = apiHandle.api.subscribe(resolvedDatabaseId, (snapshot) => {
        if (snapshot.status !== 'ready') return;
        const quantity = snapshot.rows.find((row) => row.id === resolvedRowId)?.properties.quantity;
        if (typeof quantity !== 'number') return;
        observedQuantities.push(quantity);
        if (quantity !== 2 || sawHeldExternalTwo) return;
        sawHeldExternalTwo = true;
        reentrantPatch = apiHandle!.api.patchCell({
          databaseId: resolvedDatabaseId,
          rowId: resolvedRowId,
          propertyId: 'quantity',
          value: 3,
          expectedRevision: snapshot.revision,
        });
      });

      expect(session.execute({ type: 'page.markOpened', id: resolvedDatabaseId, now: 777 }).ok).toBe(true);
      let externalInjectedDuringWrite = false;
      bridge.afterSuccessfulCheck = async (path) => {
        if (path !== ROW_PATH || externalInjectedDuringWrite) return;
        externalInjectedDuringWrite = true;
        await bridge.externalWrite(ROW_PATH, ROW_MARKDOWN);
        heldExternalRow = await fingerprintPath(bridge, ROW_PATH);
      };
      expect(await session.flush()).toBe(false);
      bridge.afterSuccessfulCheck = null;
      expect(externalInjectedDuringWrite).toBe(true);
      expect(sawHeldExternalTwo).toBe(true);
      expect(reentrantPatch).toMatchObject({ status: 'staged', databaseId: resolvedDatabaseId, rowId: resolvedRowId });
      expect(observedQuantities).toContain(2);
      expect(observedQuantities).toContain(3);
      expect(heldExternalRow).toBeDefined();
      expect(await fingerprintPath(bridge, ROW_PATH)).toEqual(heldExternalRow);
      expect(await bridge.readText(ROW_PATH)).toBe(ROW_MARKDOWN);
      expect(readySnapshot(apiHandle.api.snapshot(resolvedDatabaseId))
        .rows.find((row) => row.id === resolvedRowId)?.properties.quantity).toBe(3);
      expect(session.queue.isDirty(resolvedRowId)).toBe(true);
      expect(session.queue.hasPending()).toBe(true);
      expect(session.saveStatus.state).toBe('pending');
      expect(bridge.applyCount).toBe(1);
      expect(writePaths(bridge.appliedOps[0])).toEqual([RECENT_PATH]);
      expect(await fingerprintPath(bridge, DATABASE_PATH)).toEqual(before[DATABASE_PATH]);
      expect(await fingerprintPath(bridge, WORKSPACE_PATH)).toEqual(before[WORKSPACE_PATH]);

      expect(await session.flush()).toBe(true);
      expect(session.queue.hasPending()).toBe(false);
      expect(bridge.applyCount).toBe(2);
      expect(writePaths(bridge.appliedOps[1])).toEqual([ROW_PATH]);
      const after = await fingerprints(bridge);
      expect(after[DATABASE_PATH]).toEqual(before[DATABASE_PATH]);
      expect(after[WORKSPACE_PATH]).toEqual(before[WORKSPACE_PATH]);
      expect(after[RECENT_PATH].bytes).toContain(resolvedDatabaseId);
      expect(after[ROW_PATH].bytes).toContain('Quantity: 3');
      expect(after[ROW_PATH].bytes).toContain('vendorRecord:');

      unsubscribe();
      unsubscribe = () => {};
      apiHandle.cleanup();
      apiHandle = undefined;
      await session.close();
      session = undefined;
      reopened = await open(bridge);
      const reopenedApi = apiFor(reopened);
      try {
        const afterRestart = readySnapshot(reopenedApi.api.snapshot(idAt(reopened, DATABASE_PATH)));
        expect(afterRestart.rows.find((row) => row.id === resolvedRowId)?.properties.quantity).toBe(3);
      } finally {
        reopenedApi.cleanup();
      }
    } finally {
      bridge.afterSuccessfulCheck = null;
      unsubscribe();
      apiHandle?.cleanup();
      if (session && !session.isClosed) await session.close();
      if (reopened && !reopened.isClosed) await reopened.close();
      await dispose(bridge);
    }
  });

  it('commits an accepted external delete without restoring the missing document', async () => {
    const bridge = await makeVault();
    let session: WorkspaceSession | undefined;
    let reopened: WorkspaceSession | undefined;
    try {
      const before = await fingerprints(bridge);
      session = await open(bridge);
      const basicId = idAt(session, BASIC_PATH);
      expect(session.getState().docs[basicId]).toBeDefined();

      await bridge.externalDelete(BASIC_PATH);
      expect(session.getState().pages[basicId]).toBeUndefined();
      expect(Object.hasOwn(session.getState().docs, basicId)).toBe(false);
      expect(await bridge.readText(BASIC_PATH)).toBeNull();
      expect(await session.flush()).toBe(true);
      expect(bridge.applyCount).toBe(0);
      expect(await fingerprintPath(bridge, DATABASE_PATH)).toEqual(before[DATABASE_PATH]);
      expect(await fingerprintPath(bridge, ROW_PATH)).toEqual(before[ROW_PATH]);
      expect(await fingerprintPath(bridge, WORKSPACE_PATH)).toEqual(before[WORKSPACE_PATH]);
      expect(await fingerprintPath(bridge, RECENT_PATH)).toEqual(before[RECENT_PATH]);

      await session.close();
      session = undefined;
      reopened = await open(bridge);
      expect(Object.keys(reopened.getState().pages).some((id) => reopened?.pathOf(id) === BASIC_PATH)).toBe(false);
      expect(await bridge.readText(BASIC_PATH)).toBeNull();
      expect(await reopened.flush()).toBe(true);
      expect(bridge.applyCount).toBe(0);
    } finally {
      if (session && !session.isClosed) await session.close();
      if (reopened && !reopened.isClosed) await reopened.close();
      await dispose(bridge);
    }
  });

  it('refuses to normalize or overwrite an external database source change before the prewrite check', async () => {
    const bridge = await makeVault();
    let session: WorkspaceSession | undefined;
    try {
      const before = await fingerprints(bridge);
      session = await open(bridge);
      const resolvedDatabaseId = idAt(session, DATABASE_PATH);
      expect(session.execute({ type: 'page.markOpened', id: resolvedDatabaseId, now: 444 }).ok).toBe(true);
      const externalSource = DATABASE_MARKDOWN.replace('# Inventory', '# Inventory\n\nExternal source change.');
      await writeFile(bridge.absoluteForTest(DATABASE_PATH), externalSource, 'utf8');
      const external = await fingerprints(bridge);

      expect(await session.flush()).toBe(false);
      expect(session.saveStatus.errorCode).toBe('save-conflict');
      expect(await fingerprints(bridge)).toEqual(external);
      expect(external[DATABASE_PATH].bytes).not.toBe(before[DATABASE_PATH].bytes);
      expect(bridge.applyCount).toBe(1);
      const operations = bridge.appliedOps[0]!;
      expectSourceCheckBeforeWrite(operations);
      const results = bridge.applyResults[0]!;
      const failedAt = results.findIndex((result) => !result.ok);
      expect(failedAt).toBeGreaterThanOrEqual(0);
      expect(operations[failedAt]).toMatchObject({ op: 'check', path: DATABASE_PATH });
      expect(results).toHaveLength(failedAt + 1);
      expect(writePaths(operations.slice(0, failedAt))).toEqual([]);
    } finally {
      if (session && !session.isClosed) await session.close();
      await dispose(bridge);
    }
  });

  it('keeps an external source edit made immediately after the successful check', async () => {
    const bridge = await makeVault();
    let session: WorkspaceSession | undefined;
    let injectedSource: Awaited<ReturnType<typeof fingerprints>> | undefined;
    try {
      const before = await fingerprints(bridge);
      session = await open(bridge);
      const resolvedDatabaseId = idAt(session, DATABASE_PATH);
      expect(session.execute({ type: 'page.markOpened', id: resolvedDatabaseId, now: 555 }).ok).toBe(true);
      const externalSource = DATABASE_MARKDOWN.replace('# Inventory', '# Inventory\n\nExternal race update.');
      let injected = false;
      bridge.afterSuccessfulCheck = async (path) => {
        if (path !== DATABASE_PATH || injected) return;
        injected = true;
        await writeFile(bridge.absoluteForTest(DATABASE_PATH), externalSource, 'utf8');
        injectedSource = await fingerprints(bridge);
      };

      await session.flush();
      bridge.afterSuccessfulCheck = null;
      expect(injected).toBe(true);
      expect(injectedSource).toBeDefined();
      const after = await fingerprints(bridge);
      expect(after[DATABASE_PATH]).toEqual(injectedSource![DATABASE_PATH]);
      expect(after[ROW_PATH]).toEqual(before[ROW_PATH]);
      expect(after[WORKSPACE_PATH]).toEqual(before[WORKSPACE_PATH]);
      const operations = bridge.appliedOps[0]!;
      expectSourceCheckBeforeWrite(operations);
      expect(writePaths(operations)).not.toContain(DATABASE_PATH);
      expect(bridge.applyResults[0]!.some((result, index) =>
        !result.ok && operations[index]?.op === 'write' && operations[index]?.path === DATABASE_PATH,
      )).toBe(false);
    } finally {
      bridge.afterSuccessfulCheck = null;
      if (session && !session.isClosed) await session.close();
      await dispose(bridge);
    }
  });

  it('keeps ordinary non-opted-in page saves on the generic storage path', async () => {
    const bridge = await makeVault();
    let session: WorkspaceSession | undefined;
    try {
      const before = await fingerprints(bridge);
      const beforeRecent = JSON.parse(before[RECENT_PATH].bytes) as {
        opened: Record<string, number>;
        activity: Record<string, number>;
      };
      session = await open(bridge);
      const basicId = idAt(session, BASIC_PATH);
      const result = session.execute({
        type: 'page.setDoc',
        id: basicId,
        doc: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Edited through the ordinary page path.' }] }],
        },
        now: 666,
      });
      expect(result.ok).toBe(true);
      expect(await session.flush()).toBe(true);

      const after = await fingerprints(bridge);
      expect(after[BASIC_PATH].bytes).toContain('Edited through the ordinary page path.');
      expect(after[BASIC_PATH].bytes).not.toBe(before[BASIC_PATH].bytes);
      expect(after[DATABASE_PATH]).toEqual(before[DATABASE_PATH]);
      expect(after[ROW_PATH]).toEqual(before[ROW_PATH]);
      expect(after[WORKSPACE_PATH]).toEqual(before[WORKSPACE_PATH]);
      expect(after[RECENT_PATH].bytes).not.toBe(before[RECENT_PATH].bytes);
      expect(after[RECENT_PATH].mtimeNs).not.toBe(before[RECENT_PATH].mtimeNs);
      const afterRecent = JSON.parse(after[RECENT_PATH].bytes) as typeof beforeRecent;
      expect(afterRecent.opened).toEqual(beforeRecent.opened);
      const today = new Date();
      const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      const expectedActivity = { ...beforeRecent.activity };
      expectedActivity[todayKey] = (expectedActivity[todayKey] ?? 0) + 1;
      expect(afterRecent.activity).toEqual(expectedActivity);
      expect(writePaths(bridge.appliedOps[0])).toEqual([BASIC_PATH, BASIC_HISTORY_PATH, RECENT_PATH]);
      expect(await bridge.readText(BASIC_HISTORY_PATH)).not.toBeNull();
    } finally {
      if (session && !session.isClosed) await session.close();
      await dispose(bridge);
    }
  });
});
