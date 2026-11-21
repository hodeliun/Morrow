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
import type { PageId } from '../core/model';
import type { VaultScan } from '../core/vault/load';
import type { VaultOp, VaultOpResult } from '../core/vault/plan';
import { createDataApi } from '../app/plugins/dataApi';
import type { DataApi, DataApiSnapshot } from '../app/plugins/dataApi';
import { createProviderDataScope } from '../app/plugins/providerDataScope';
import type { VaultBridge, VaultChange, VaultFileInfo } from './vaultBridge';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';

const DATABASE_ID = 'inventory-db' as PageId;
const ROW_ID = 'widget-row' as PageId;
const NULL_ROW_ID = 'null-row' as PageId;
const MISSING_ROW_ID = 'missing-row' as PageId;
const EMPTY_ROW_ID = 'empty-row' as PageId;
const DATABASE_PATH = 'Inventory.md';
const ROW_PATH = 'Inventory/Widget.md';

const DATABASE = `---
kind: database
polarisDados:
  version: 1
  provider: polaris-dados
database:
  properties:
    - id: message
      name: Message
      type: text
    - id: quantity
      name: Quantity
      type: number
    - id: flag
      name: Flag
      type: checkbox
    - id: total
      name: Total
      type: formula
      formula: Quantity * 2
  views:
    - id: table
      name: Table
      type: table
---
# Inventory
`;

const ROW = `---
Message: "  opening  "
Quantity: 2
Flag: true
vendorRecord:
  id: opaque-widget-7f21
  audit:
    source: synthetic
    tags: [retain, nested]
---
Synthetic widget row.
`;

const FILES: Record<string, string> = {
  [DATABASE_PATH]: DATABASE,
  [ROW_PATH]: ROW,
  'Inventory/Null.md': `---\nMessage: null\nQuantity: 0\nFlag: true\n---\nExplicit null.\n`,
  'Inventory/Missing.md': `---\nQuantity: 1\nFlag: true\n---\nMissing text.\n`,
  'Inventory/Empty.md': `---\nQuantity: 0\nFlag: true\n---\nEmpty text.\n`,
};

interface DiskFixtureOptions {
  readonly propertyId?: string;
  readonly databaseId?: string;
  readonly rowId?: string;
  readonly includeUnsafeTextRow?: boolean;
}

class IndependentDiskVault implements VaultBridge {
  private readonly listeners = new Set<(changes: VaultChange[]) => void>();
  applyCount = 0;

  constructor(readonly root: string) {}

  private absolute(path: string): string {
    return join(this.root, ...path.split('/'));
  }

  async scan(): Promise<VaultScan> {
    const files: VaultScan['files'] = [];
    const folders: VaultScan['folders'] = [];
    const others: string[] = [];
    const visit = async (relative: string): Promise<void> => {
      const absolute = relative ? this.absolute(relative) : this.root;
      const entries = await readdir(absolute, { withFileTypes: true });
      if (relative) {
        const info = await stat(absolute);
        folders.push({ path: relative, mtime: info.mtimeMs, empty: entries.length === 0 });
      }
      for (const entry of entries) {
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await visit(path);
          continue;
        }
        const info = await stat(this.absolute(path));
        if (['.md', '.canvas'].includes(extname(path).toLowerCase())) {
          files.push({
            path,
            text: await readFile(this.absolute(path), 'utf8'),
            mtime: info.mtimeMs,
            birthtime: info.birthtimeMs,
          });
        } else others.push(path);
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
    this.applyCount += 1;
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
          await mkdir(dirname(this.absolute(op.path)), { recursive: true });
          await writeFile(this.absolute(op.path), op.text, 'utf8');
        } else if (op.op === 'rename') {
          if (!(await this.exists(op.from))) {
            if (op.optional) {
              results.push({ ok: true });
              continue;
            }
            results.push({ ok: false, code: 'error', message: `missing: ${op.from}` });
            break;
          }
          if (await this.exists(op.to)) {
            results.push({ ok: false, code: 'exists', message: `${op.to} exists` });
            break;
          }
          await mkdir(dirname(this.absolute(op.to)), { recursive: true });
          await rename(this.absolute(op.from), this.absolute(op.to));
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
    const entries = await readdir(this.absolute(directory), { withFileTypes: true });
    const files: VaultFileInfo[] = [];
    for (const entry of entries) {
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

  fileUrl(): null {
    return null;
  }

  async external(path: string, text: string): Promise<void> {
    await mkdir(dirname(this.absolute(path)), { recursive: true });
    await writeFile(this.absolute(path), text, 'utf8');
    const info = await stat(this.absolute(path));
    const change: VaultChange = { path, text, mtime: info.mtimeMs, birthtime: info.birthtimeMs };
    for (const listener of this.listeners) listener([change]);
  }
}

function fixtureFiles(options: DiskFixtureOptions = {}): Record<string, string> {
  const databaseId = options.databaseId ?? String(DATABASE_ID);
  const rowId = options.rowId ?? String(ROW_ID);
  const schema = options.propertyId ? DATABASE.replace('id: message', `id: ${options.propertyId}`) : DATABASE;
  const pages: Record<string, { id: string; created: number; order: number }> = {
    [DATABASE_PATH]: { id: databaseId, created: 1, order: 0 },
    [ROW_PATH]: { id: rowId, created: 2, order: 0 },
    'Inventory/Null.md': { id: String(NULL_ROW_ID), created: 3, order: 1 },
    'Inventory/Missing.md': { id: String(MISSING_ROW_ID), created: 4, order: 2 },
    'Inventory/Empty.md': { id: String(EMPTY_ROW_ID), created: 5, order: 3 },
  };
  const files: Record<string, string> = {
    ...FILES,
    [DATABASE_PATH]: schema,
    '.morrow/workspace.json': JSON.stringify({ version: 1, pages }),
    '.morrow/recent.json': JSON.stringify({ version: 1, opened: {}, activity: {} }),
  };
  if (options.includeUnsafeTextRow) {
    files['Unsafe.md'] = DATABASE.replace('# Inventory', '# Unsafe');
    files['Unsafe/Bad.md'] = `---\nMessage: 7\nQuantity: 1\nFlag: true\n---\nRaw incompatible text scalar.\n`;
    pages['Unsafe.md'] = { id: 'unsafe-db', created: 6, order: 1 };
    pages['Unsafe/Bad.md'] = { id: 'unsafe-row', created: 7, order: 0 };
    files['.morrow/workspace.json'] = JSON.stringify({ version: 1, pages });
  }
  return files;
}

async function createDiskVault(options: DiskFixtureOptions = {}): Promise<IndependentDiskVault> {
  const root = await mkdtemp(join(tmpdir(), 'morrow-e003-independent-text-'));
  for (const [path, content] of Object.entries(fixtureFiles(options))) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }
  return new IndependentDiskVault(root);
}

async function openSession(vault: IndependentDiskVault): Promise<WorkspaceSession> {
  let generated = 0;
  const opened = await WorkspaceSession.open(
    new VaultRepository(vault, () => `independent-generated-${++generated}`),
    { delayMs: 60_000 },
  );
  if (!opened.ok) throw new Error(opened.error);
  return opened.value;
}

interface MutableState {
  ownerActive: boolean;
  providerActive: boolean;
  hostReadonly: boolean;
  scopeActive: boolean;
  editable: boolean;
}

interface Harness {
  readonly vault: IndependentDiskVault;
  readonly state: MutableState;
  readonly databaseId: PageId;
  readonly session: WorkspaceSession;
  readonly base: DataApi;
  readonly api: DataApi;
  reopen(): Promise<void>;
  closeCurrent(): Promise<void>;
  close(): Promise<void>;
}

async function openHarness(options: DiskFixtureOptions = {}): Promise<Harness> {
  const vault = await createDiskVault(options);
  const databaseId = (options.databaseId ?? String(DATABASE_ID)) as PageId;
  const state: MutableState = {
    ownerActive: true,
    providerActive: true,
    hostReadonly: false,
    scopeActive: true,
    editable: true,
  };
  let session = await openSession(vault);
  let base!: DataApi;
  let api!: DataApi;
  let baseCleanup = () => {};
  let scopeCleanup = () => {};
  const installHandle = () => {
    base = createDataApi({
      session,
      ownerIsActive: () => state.ownerActive,
      isProviderActive: (candidate) => state.providerActive && candidate === databaseId,
      isHostReadonly: () => state.hostReadonly,
      registerCleanup: (cleanup) => {
        baseCleanup = cleanup;
      },
    });
    const scope = createProviderDataScope(base, databaseId, {
      isActive: () => state.scopeActive,
      editable: () => state.editable,
    });
    api = scope.api;
    scopeCleanup = () => scope.dispose();
  };
  installHandle();
  return {
    vault,
    state,
    databaseId,
    get session() {
      return session;
    },
    get base() {
      return base;
    },
    get api() {
      return api;
    },
    async closeCurrent() {
      scopeCleanup();
      baseCleanup();
      if (!session.isClosed) await session.close();
    },
    async reopen() {
      scopeCleanup();
      baseCleanup();
      if (!session.isClosed) await session.close();
      session = await openSession(vault);
      installHandle();
    },
    async close() {
      scopeCleanup();
      baseCleanup();
      if (!session.isClosed) await session.close();
      await rm(vault.root, { recursive: true, force: true });
    },
  };
}

function ready(api: DataApi, databaseId: PageId = DATABASE_ID) {
  const snapshot = api.snapshot(databaseId);
  if (snapshot.status !== 'ready') {
    throw new Error(`Expected ready snapshot, received ${JSON.stringify(snapshot)}.`);
  }
  return snapshot;
}

function row(api: DataApi, rowId: PageId, databaseId: PageId = DATABASE_ID) {
  const snapshot = ready(api, databaseId);
  const selected = snapshot.rows.find((candidate) => candidate.id === rowId);
  if (!selected) throw new Error(`Missing row ${rowId}.`);
  return selected;
}

function patchText(
  api: DataApi,
  rowId: PageId,
  value: string | null,
  options: { databaseId?: PageId; propertyId?: string; expectedRevision?: string } = {},
) {
  if (!api.patchTextCell) throw new Error('This DataApi does not expose patchTextCell.');
  const databaseId = options.databaseId ?? DATABASE_ID;
  return api.patchTextCell({
    databaseId,
    rowId,
    propertyId: options.propertyId ?? 'message',
    value,
    expectedRevision: options.expectedRevision ?? ready(api, databaseId).revision,
  });
}

function history(api: DataApi, databaseId: PageId, direction: 'undo' | 'redo') {
  return api.history({ databaseId, direction, expectedRevision: ready(api, databaseId).revision });
}

async function flush(api: DataApi, databaseId: PageId) {
  return api.flush(databaseId);
}

function createOpaqueRevisionAdapter(source: DataApi) {
  let revision = 'r0';
  let nextRevision = 1;
  const forwarded: Array<{ operation: 'number' | 'text' | 'history'; expectedRevision: string }> = [];
  const staleRevision = () => ({
    status: 'error' as const,
    code: 'stale-revision' as const,
    message: 'The opaque revision is stale.',
  });
  const withOpaqueRevision = (snapshot: DataApiSnapshot): DataApiSnapshot =>
    Object.freeze({ ...snapshot, revision });
  const advance = <T extends { readonly revision: string }>(result: T): T => {
    revision = `revision-${nextRevision++}`;
    return Object.freeze({ ...result, revision });
  };

  const api: DataApi = {
    version: 1,
    snapshot(databaseId) {
      return withOpaqueRevision(source.snapshot(databaseId));
    },
    patchCell(input) {
      forwarded.push({ operation: 'number', expectedRevision: input.expectedRevision });
      if (input.expectedRevision !== revision) return staleRevision();
      const snapshot = source.snapshot(input.databaseId);
      if (snapshot.status !== 'ready') {
        return { status: 'error', code: 'not-opted-in', message: 'Database is unavailable.' };
      }
      const result = source.patchCell({ ...input, expectedRevision: snapshot.revision });
      return result.status === 'error' ? result : advance(result);
    },
    patchTextCell(input) {
      forwarded.push({ operation: 'text', expectedRevision: input.expectedRevision });
      if (input.expectedRevision !== revision) return staleRevision();
      const snapshot = source.snapshot(input.databaseId);
      if (snapshot.status !== 'ready') {
        return { status: 'error', code: 'not-opted-in', message: 'Database is unavailable.' };
      }
      const result = source.patchTextCell?.({ ...input, expectedRevision: snapshot.revision });
      if (!result) return { status: 'error', code: 'invalid-value', message: 'Text edits are unavailable.' };
      return result.status === 'error' ? result : advance(result);
    },
    history(input) {
      forwarded.push({ operation: 'history', expectedRevision: input.expectedRevision });
      if (input.expectedRevision !== revision) return staleRevision();
      const snapshot = source.snapshot(input.databaseId);
      if (snapshot.status !== 'ready') {
        return { status: 'error', code: 'not-opted-in', message: 'Database is unavailable.' };
      }
      const result = source.history({ ...input, expectedRevision: snapshot.revision });
      return result.status === 'error' ? result : advance(result);
    },
    subscribe(databaseId, listener) {
      return source.subscribe(databaseId, (snapshot) => listener(withOpaqueRevision(snapshot)));
    },
    async flush(databaseId) {
      const result = await source.flush(databaseId);
      return result.status === 'error' ? result : Object.freeze({ ...result, revision });
    },
  };

  return { api, forwarded };
}

async function readDisk(vault: IndependentDiskVault, path: string): Promise<string> {
  const value = await vault.readText(path);
  if (value === null) throw new Error(`Missing file ${path}.`);
  return value;
}

describe('independent #218 exact text API and storage verification', () => {
  it('opens without writes, keeps absent/null distinct, and guards raw non-text YAML', async () => {
    const harness = await openHarness({ includeUnsafeTextRow: true });
    try {
      expect(row(harness.api, NULL_ROW_ID).properties.message).toBeNull();
      expect(Object.hasOwn(row(harness.api, MISSING_ROW_ID).properties, 'message')).toBe(false);
      expect(row(harness.api, EMPTY_ROW_ID).properties.message).toBeUndefined();
      const unsafe = harness.base.snapshot('unsafe-db' as PageId);
      expect(unsafe.status).toBe('unsupported');
      expect(await readDisk(harness.vault, 'Unsafe/Bad.md')).toContain('Message: 7');
      expect(harness.vault.applyCount).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('round-trips exact Unicode, edge spaces, multiline text, and YAML-looking strings through disk reopen', async () => {
    const harness = await openHarness();
    try {
      const exact = '  Café e\u0301 🌿  \nline two\n\nlast\t  ';
      expect(patchText(harness.api, ROW_ID, exact)).toMatchObject({ status: 'staged' });
      expect(await flush(harness.api, DATABASE_ID)).toMatchObject({ status: 'persisted' });
      expect(row(harness.api, ROW_ID).properties.message).toBe(exact);

      expect(patchText(harness.api, EMPTY_ROW_ID, '2')).toMatchObject({ status: 'staged' });
      expect(await flush(harness.api, DATABASE_ID)).toMatchObject({ status: 'persisted' });
      expect(patchText(harness.api, NULL_ROW_ID, 'true')).toMatchObject({ status: 'staged' });
      expect(await flush(harness.api, DATABASE_ID)).toMatchObject({ status: 'persisted' });
      expect(row(harness.api, EMPTY_ROW_ID).properties.message).toBe('2');
      expect(row(harness.api, NULL_ROW_ID).properties.message).toBe('true');

      await harness.reopen();
      expect(row(harness.api, ROW_ID).properties.message).toBe(exact);
      expect(row(harness.api, EMPTY_ROW_ID).properties.message).toBe('2');
      expect(row(harness.api, NULL_ROW_ID).properties.message).toBe('true');
      expect(typeof row(harness.api, EMPTY_ROW_ID).properties.message).toBe('string');
      expect(typeof row(harness.api, NULL_ROW_ID).properties.message).toBe('string');
    } finally {
      await harness.close();
    }
  });

  it('persists empty string, explicit null, and missing property as three distinct states', async () => {
    const harness = await openHarness();
    try {
      expect(patchText(harness.api, EMPTY_ROW_ID, '')).toMatchObject({ status: 'staged' });
      expect(await flush(harness.api, DATABASE_ID)).toMatchObject({ status: 'persisted' });
      expect(patchText(harness.api, ROW_ID, null)).toMatchObject({ status: 'staged' });
      expect(await flush(harness.api, DATABASE_ID)).toMatchObject({ status: 'persisted' });
      expect(Object.hasOwn(row(harness.api, EMPTY_ROW_ID).properties, 'message')).toBe(true);
      expect(row(harness.api, EMPTY_ROW_ID).properties.message).toBe('');
      expect(Object.hasOwn(row(harness.api, ROW_ID).properties, 'message')).toBe(true);
      expect(row(harness.api, ROW_ID).properties.message).toBeNull();
      expect(Object.hasOwn(row(harness.api, MISSING_ROW_ID).properties, 'message')).toBe(false);

      await harness.reopen();
      expect(row(harness.api, EMPTY_ROW_ID).properties.message).toBe('');
      expect(row(harness.api, ROW_ID).properties.message).toBeNull();
      expect(Object.hasOwn(row(harness.api, MISSING_ROW_ID).properties, 'message')).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('flushes text history undo and redo, then reopens with the final exact value', async () => {
    const harness = await openHarness();
    try {
      const original = row(harness.api, ROW_ID).properties.message;
      const changed = 'after 🌙\nsecond line';
      expect(patchText(harness.api, ROW_ID, changed)).toMatchObject({ status: 'staged' });
      expect(await flush(harness.api, DATABASE_ID)).toMatchObject({ status: 'persisted' });
      expect(history(harness.api, DATABASE_ID, 'undo')).toMatchObject({ status: 'staged' });
      expect(await flush(harness.api, DATABASE_ID)).toMatchObject({ status: 'persisted' });
      expect(row(harness.api, ROW_ID).properties.message).toBe(original);
      expect(history(harness.api, DATABASE_ID, 'redo')).toMatchObject({ status: 'staged' });
      expect(await flush(harness.api, DATABASE_ID)).toMatchObject({ status: 'persisted' });
      expect(row(harness.api, ROW_ID).properties.message).toBe(changed);

      await harness.reopen();
      expect(row(harness.api, ROW_ID).properties.message).toBe(changed);
      expect(ready(harness.api).history).toEqual({ canUndo: false, canRedo: false });
    } finally {
      await harness.close();
    }
  });

  it('undoes and redoes property presence while restoring explicit null separately', async () => {
    const harness = await openHarness();
    try {
      expect(Object.hasOwn(row(harness.api, MISSING_ROW_ID).properties, 'message')).toBe(false);
      expect(patchText(harness.api, MISSING_ROW_ID, 'added')).toMatchObject({ status: 'staged' });
      expect(await flush(harness.api, DATABASE_ID)).toMatchObject({ status: 'persisted' });
      expect(history(harness.api, DATABASE_ID, 'undo')).toMatchObject({ status: 'staged' });
      expect(await flush(harness.api, DATABASE_ID)).toMatchObject({ status: 'persisted' });
      expect(Object.hasOwn(row(harness.api, MISSING_ROW_ID).properties, 'message')).toBe(false);
      expect(history(harness.api, DATABASE_ID, 'redo')).toMatchObject({ status: 'staged' });
      expect(await flush(harness.api, DATABASE_ID)).toMatchObject({ status: 'persisted' });
      expect(row(harness.api, MISSING_ROW_ID).properties.message).toBe('added');

      expect(patchText(harness.api, NULL_ROW_ID, 'replaced null')).toMatchObject({ status: 'staged' });
      expect(await flush(harness.api, DATABASE_ID)).toMatchObject({ status: 'persisted' });
      expect(history(harness.api, DATABASE_ID, 'undo')).toMatchObject({ status: 'staged' });
      expect(await flush(harness.api, DATABASE_ID)).toMatchObject({ status: 'persisted' });
      expect(Object.hasOwn(row(harness.api, NULL_ROW_ID).properties, 'message')).toBe(true);
      expect(row(harness.api, NULL_ROW_ID).properties.message).toBeNull();
      expect(history(harness.api, DATABASE_ID, 'redo')).toMatchObject({ status: 'staged' });
      expect(await flush(harness.api, DATABASE_ID)).toMatchObject({ status: 'persisted' });
      expect(row(harness.api, NULL_ROW_ID).properties.message).toBe('replaced null');
    } finally {
      await harness.close();
    }
  });

  it('rejects wrong scalar types and string-to-number/checkbox/formula edits without mutation', async () => {
    const harness = await openHarness();
    try {
      const before = ready(harness.api);
      const beforeDisk = await readDisk(harness.vault, ROW_PATH);
      const beforeWrites = harness.vault.applyCount;
      const rawPatch = harness.api.patchTextCell as unknown as (input: unknown) => unknown;
      for (const value of [2, false, {}, []]) {
        expect(
          rawPatch({
            databaseId: DATABASE_ID,
            rowId: ROW_ID,
            propertyId: 'message',
            value,
            expectedRevision: before.revision,
          }),
        ).toMatchObject({ status: 'error', code: 'invalid-value' });
      }
      expect(patchText(harness.api, ROW_ID, '3', { propertyId: 'quantity' })).toMatchObject({
        status: 'error',
      });
      expect(patchText(harness.api, ROW_ID, 'false', { propertyId: 'flag' })).toMatchObject({
        status: 'error',
      });
      expect(patchText(harness.api, ROW_ID, 'formula', { propertyId: 'total' })).toMatchObject({
        status: 'error',
      });
      expect(
        harness.api.patchCell({
          databaseId: DATABASE_ID,
          rowId: ROW_ID,
          propertyId: 'message',
          value: 9,
          expectedRevision: before.revision,
        }),
      ).toMatchObject({ status: 'error' });
      expect(
        harness.api.patchCell({
          databaseId: DATABASE_ID,
          rowId: ROW_ID,
          propertyId: 'flag',
          value: 9,
          expectedRevision: before.revision,
        }),
      ).toMatchObject({ status: 'error' });
      expect(ready(harness.api)).toEqual(before);
      expect(await readDisk(harness.vault, ROW_PATH)).toBe(beforeDisk);
      expect(harness.vault.applyCount).toBe(beforeWrites);
    } finally {
      await harness.close();
    }
  });

  it('forwards opaque provider revisions for number, text, and history while preserving guards', async () => {
    const harness = await openHarness();
    const opaque = createOpaqueRevisionAdapter(harness.base);
    const scope = createProviderDataScope(opaque.api, DATABASE_ID, {
      isActive: () => harness.state.scopeActive,
      editable: () => harness.state.editable,
    });
    const api = scope.api;
    try {
      expect(ready(api).revision).toBe('r0');
      expect(
        api.patchCell({
          databaseId: DATABASE_ID,
          rowId: ROW_ID,
          propertyId: 'quantity',
          value: 0,
          expectedRevision: 'r0',
        }),
      ).toMatchObject({ status: 'staged', revision: 'revision-1' });
      expect(await flush(api, DATABASE_ID)).toMatchObject({ status: 'persisted', revision: 'revision-1' });
      expect(
        api.patchTextCell?.({
          databaseId: DATABASE_ID,
          rowId: ROW_ID,
          propertyId: 'message',
          value: 'opaque revision text',
          expectedRevision: 'revision-1',
        }),
      ).toMatchObject({ status: 'staged', revision: 'revision-2' });
      expect(await flush(api, DATABASE_ID)).toMatchObject({ status: 'persisted', revision: 'revision-2' });
      expect(
        api.history({ databaseId: DATABASE_ID, direction: 'undo', expectedRevision: 'revision-2' }),
      ).toMatchObject({ status: 'staged', revision: 'revision-3' });
      expect(await flush(api, DATABASE_ID)).toMatchObject({ status: 'persisted', revision: 'revision-3' });
      expect(opaque.forwarded).toEqual([
        { operation: 'number', expectedRevision: 'r0' },
        { operation: 'text', expectedRevision: 'revision-1' },
        { operation: 'history', expectedRevision: 'revision-2' },
      ]);
      expect(row(api, ROW_ID).properties.quantity).toBe(0);
      expect(row(api, ROW_ID).properties.message).toBe('  opening  ');

      const beforeGuards = ready(api);
      const diskBeforeGuards = await readDisk(harness.vault, ROW_PATH);
      const writesBeforeGuards = harness.vault.applyCount;
      harness.state.editable = false;
      expect(
        api.patchCell({
          databaseId: DATABASE_ID,
          rowId: ROW_ID,
          propertyId: 'quantity',
          value: 9,
          expectedRevision: 'revision-3',
        }),
      ).toMatchObject({ status: 'error', code: 'host-readonly' });
      expect(
        api.patchTextCell?.({
          databaseId: DATABASE_ID,
          rowId: ROW_ID,
          propertyId: 'message',
          value: 'blocked',
          expectedRevision: 'revision-3',
        }),
      ).toMatchObject({ status: 'error', code: 'host-readonly' });
      expect(
        api.history({ databaseId: DATABASE_ID, direction: 'redo', expectedRevision: 'revision-3' }),
      ).toMatchObject({ status: 'error', code: 'host-readonly' });
      harness.state.editable = true;

      const rawNumber = api.patchCell as unknown as (input: unknown) => unknown;
      const rawText = api.patchTextCell as unknown as (input: unknown) => unknown;
      const rawHistory = api.history as unknown as (input: unknown) => unknown;
      expect(
        rawNumber({
          databaseId: DATABASE_ID,
          rowId: ROW_ID,
          propertyId: 'quantity',
          value: 7,
          expectedRevision: '',
        }),
      ).toMatchObject({ status: 'error', code: 'invalid-value' });
      expect(
        rawText({
          databaseId: DATABASE_ID,
          rowId: ROW_ID,
          propertyId: 'message',
          value: 'invalid token',
          expectedRevision: '',
        }),
      ).toMatchObject({ status: 'error', code: 'invalid-value' });
      expect(rawHistory({ databaseId: DATABASE_ID, direction: 'undo', expectedRevision: '' })).toMatchObject({
        status: 'error',
        code: 'invalid-value',
      });

      let getterCalls = 0;
      const accessorPayload = Object.defineProperties(
        {},
        {
          databaseId: { enumerable: true, value: DATABASE_ID },
          rowId: { enumerable: true, value: ROW_ID },
          propertyId: { enumerable: true, value: 'message' },
          value: { enumerable: true, value: 'must not stage' },
          expectedRevision: {
            enumerable: true,
            get() {
              getterCalls += 1;
              return 'revision-3';
            },
          },
        },
      );
      expect(rawText(accessorPayload)).toMatchObject({ status: 'error', code: 'invalid-value' });
      expect(getterCalls).toBe(0);

      const revokedHistory = Proxy.revocable(
        { databaseId: DATABASE_ID, direction: 'undo', expectedRevision: 'revision-3' },
        {},
      );
      revokedHistory.revoke();
      expect(() => rawHistory(revokedHistory.proxy)).not.toThrow();
      expect(rawHistory(revokedHistory.proxy)).toMatchObject({ status: 'error', code: 'invalid-value' });

      expect(opaque.forwarded).toHaveLength(3);
      expect(ready(api)).toEqual(beforeGuards);
      expect(await readDisk(harness.vault, ROW_PATH)).toBe(diskBeforeGuards);
      expect(harness.vault.applyCount).toBe(writesBeforeGuards);

      scope.dispose();
      await harness.reopen();
      expect(row(harness.api, ROW_ID).properties.quantity).toBe(0);
      expect(row(harness.api, ROW_ID).properties.message).toBe('  opening  ');
    } finally {
      scope.dispose();
      await harness.close();
    }
  });

  it('rejects stale revisions, malformed IDs, missing rows/properties, and out-of-scope targets', async () => {
    const harness = await openHarness();
    try {
      const initial = ready(harness.api);
      expect(patchText(harness.api, ROW_ID, 'new value')).toMatchObject({ status: 'staged' });
      expect(await flush(harness.api, DATABASE_ID)).toMatchObject({ status: 'persisted' });
      const current = ready(harness.api);
      expect(patchText(harness.api, ROW_ID, 'stale', { expectedRevision: initial.revision })).toMatchObject({
        status: 'error',
        code: 'stale-revision',
      });
      expect(
        harness.api.history({
          databaseId: DATABASE_ID,
          direction: 'undo',
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'error', code: 'stale-revision' });
      const rawPatch = harness.api.patchTextCell as unknown as (input: unknown) => unknown;
      for (const invalid of [
        {
          databaseId: '',
          rowId: ROW_ID,
          propertyId: 'message',
          value: 'x',
          expectedRevision: current.revision,
        },
        {
          databaseId: DATABASE_ID,
          rowId: '',
          propertyId: 'message',
          value: 'x',
          expectedRevision: current.revision,
        },
        {
          databaseId: DATABASE_ID,
          rowId: ROW_ID,
          propertyId: '',
          value: 'x',
          expectedRevision: current.revision,
        },
      ]) {
        expect(rawPatch(invalid)).toMatchObject({ status: 'error', code: 'invalid-value' });
      }
      expect(patchText(harness.api, 'nonexistent-row' as PageId, 'x')).toMatchObject({
        status: 'error',
        code: 'row-not-found',
      });
      expect(patchText(harness.api, ROW_ID, 'x', { propertyId: 'missing-property' })).toMatchObject({
        status: 'error',
        code: 'property-not-found',
      });
      expect(
        harness.api.patchTextCell?.({
          databaseId: 'other-database' as PageId,
          rowId: ROW_ID,
          propertyId: 'message',
          value: 'out of scope',
          expectedRevision: current.revision,
        }),
      ).toMatchObject({ status: 'error', code: 'out-of-scope' });
      expect(ready(harness.api)).toEqual(current);
      expect(harness.vault.applyCount).toBe(1);
    } finally {
      await harness.close();
    }
  });

  it('enforces readonly, provider disable, owner disposal, and unmount before mutation', async () => {
    const harness = await openHarness();
    try {
      expect(patchText(harness.api, ROW_ID, 'guard baseline')).toMatchObject({ status: 'staged' });
      expect(await flush(harness.api, DATABASE_ID)).toMatchObject({ status: 'persisted' });
      const initial = ready(harness.api);
      const diskBefore = await readDisk(harness.vault, ROW_PATH);
      const writesBefore = harness.vault.applyCount;
      harness.state.editable = false;
      expect(patchText(harness.api, ROW_ID, 'readonly')).toMatchObject({
        status: 'error',
        code: 'host-readonly',
      });
      expect(
        harness.api.history({
          databaseId: DATABASE_ID,
          direction: 'undo',
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'error', code: 'host-readonly' });
      harness.state.editable = true;

      harness.state.hostReadonly = true;
      expect(patchText(harness.base, ROW_ID, 'host readonly')).toMatchObject({
        status: 'error',
        code: 'host-readonly',
      });
      expect(
        harness.base.history({
          databaseId: DATABASE_ID,
          direction: 'undo',
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'error', code: 'host-readonly' });
      harness.state.hostReadonly = false;

      harness.state.providerActive = false;
      expect(patchText(harness.base, ROW_ID, 'inactive provider')).toMatchObject({
        status: 'error',
        code: 'provider-inactive',
      });
      expect(
        harness.base.history({
          databaseId: DATABASE_ID,
          direction: 'undo',
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'error', code: 'provider-inactive' });
      harness.state.providerActive = true;

      harness.state.scopeActive = false;
      expect(
        harness.api.patchTextCell?.({
          databaseId: DATABASE_ID,
          rowId: ROW_ID,
          propertyId: 'message',
          value: 'unmounted',
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'error', code: 'owner-inactive' });
      expect(
        harness.api.history({
          databaseId: DATABASE_ID,
          direction: 'undo',
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'error', code: 'owner-inactive' });
      harness.state.scopeActive = true;

      harness.state.ownerActive = false;
      expect(
        harness.base.patchTextCell?.({
          databaseId: DATABASE_ID,
          rowId: ROW_ID,
          propertyId: 'message',
          value: 'must not stage',
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'error', code: 'owner-inactive' });
      expect(
        harness.base.history({
          databaseId: DATABASE_ID,
          direction: 'undo',
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'error', code: 'owner-inactive' });
      expect(() => harness.base.snapshot(DATABASE_ID)).toThrow(/no longer active/i);
      expect(await readDisk(harness.vault, ROW_PATH)).toBe(diskBefore);
      expect(harness.vault.applyCount).toBe(writesBefore);
      expect(harness.session.getState().pages[ROW_ID]?.properties.message).toBe('guard baseline');
    } finally {
      await harness.close();
    }
  });

  it('blocks patch and history behind the real session mutation fence, then recovers', async () => {
    const harness = await openHarness();
    try {
      expect(patchText(harness.api, ROW_ID, 'baseline')).toMatchObject({ status: 'staged' });
      expect(await flush(harness.api, DATABASE_ID)).toMatchObject({ status: 'persisted' });
      const before = ready(harness.api);
      const diskBefore = await readDisk(harness.vault, ROW_PATH);
      const writesBefore = harness.vault.applyCount;
      const release = harness.session.beginMutationFence();
      try {
        expect(patchText(harness.api, ROW_ID, 'blocked')).toMatchObject({ status: 'error' });
        expect(history(harness.api, DATABASE_ID, 'undo')).toMatchObject({ status: 'error' });
        expect(ready(harness.api)).toEqual(before);
        expect(await readDisk(harness.vault, ROW_PATH)).toBe(diskBefore);
        expect(harness.vault.applyCount).toBe(writesBefore);
      } finally {
        release();
      }
      expect(patchText(harness.api, ROW_ID, 'after fence')).toMatchObject({ status: 'staged' });
      expect(await flush(harness.api, DATABASE_ID)).toMatchObject({ status: 'persisted' });
      expect(row(harness.api, ROW_ID).properties.message).toBe('after fence');
    } finally {
      await harness.close();
    }
  });

  it('rejects old API handles after session close and reopens only persisted bytes', async () => {
    const harness = await openHarness();
    try {
      expect(patchText(harness.api, ROW_ID, 'persisted before close')).toMatchObject({ status: 'staged' });
      expect(await flush(harness.api, DATABASE_ID)).toMatchObject({ status: 'persisted' });
      const oldApi = harness.api;
      const oldRevision = ready(oldApi).revision;
      const beforeClose = await readDisk(harness.vault, ROW_PATH);
      await harness.closeCurrent();
      expect(() => oldApi.snapshot(DATABASE_ID)).toThrow();
      expect(
        oldApi.patchTextCell?.({
          databaseId: DATABASE_ID,
          rowId: ROW_ID,
          propertyId: 'message',
          value: 'after close',
          expectedRevision: oldRevision,
        }),
      ).toMatchObject({ status: 'error', code: 'owner-inactive' });
      expect(await oldApi.flush(DATABASE_ID)).toMatchObject({ status: 'error', code: 'owner-inactive' });
      expect(await readDisk(harness.vault, ROW_PATH)).toBe(beforeClose);

      await harness.reopen();
      expect(row(harness.api, ROW_ID).properties.message).toBe('persisted before close');
    } finally {
      await harness.close();
    }
  });

  it('preserves an external disk edit on save conflict and blocks follow-up edits', async () => {
    const harness = await openHarness();
    try {
      expect(patchText(harness.api, ROW_ID, 'staged text')).toMatchObject({ status: 'staged' });
      const external = (await readDisk(harness.vault, ROW_PATH)).replace('Quantity: 2', 'Quantity: 8');
      await harness.vault.external(ROW_PATH, external);
      const writesBeforeFlush = harness.vault.applyCount;
      expect(await flush(harness.api, DATABASE_ID)).toMatchObject({ status: 'error', code: 'save-conflict' });
      expect(harness.vault.applyCount).toBeGreaterThan(writesBeforeFlush);
      expect(await readDisk(harness.vault, ROW_PATH)).toBe(external);
      expect(harness.base.snapshot(DATABASE_ID)).toMatchObject({
        status: 'ready',
        readonly: true,
        diagnostic: { code: 'save-conflict' },
      });
      const afterConflict = ready(harness.base);
      const writesAfterConflict = harness.vault.applyCount;
      expect(patchText(harness.base, ROW_ID, 'must not replace external')).toMatchObject({
        status: 'error',
        code: 'save-conflict',
      });
      expect(history(harness.base, DATABASE_ID, 'undo')).toMatchObject({
        status: 'error',
        code: 'save-conflict',
      });
      expect(ready(harness.base)).toEqual(afterConflict);
      expect(harness.vault.applyCount).toBe(writesAfterConflict);
      expect(await readDisk(harness.vault, ROW_PATH)).toBe(external);
    } finally {
      await harness.close();
    }
  });

  it('keeps number/checkbox behavior, formula schema, and opaque row metadata through text and numeric flushes', async () => {
    const harness = await openHarness();
    try {
      const schemaBefore = await readDisk(harness.vault, DATABASE_PATH);
      expect(row(harness.api, ROW_ID).properties.quantity).toBe(2);
      expect(row(harness.api, ROW_ID).properties.flag).toBe(true);
      expect(patchText(harness.api, ROW_ID, 'message update')).toMatchObject({ status: 'staged' });
      expect(await flush(harness.api, DATABASE_ID)).toMatchObject({ status: 'persisted' });
      expect(
        harness.api.patchCell({
          databaseId: DATABASE_ID,
          rowId: ROW_ID,
          propertyId: 'quantity',
          value: 0,
          expectedRevision: ready(harness.api).revision,
        }),
      ).toMatchObject({ status: 'staged' });
      expect(await flush(harness.api, DATABASE_ID)).toMatchObject({ status: 'persisted' });
      const current = row(harness.api, ROW_ID);
      expect(current.properties.quantity).toBe(0);
      expect(typeof current.properties.quantity).toBe('number');
      expect(current.properties.flag).toBe(true);
      expect(typeof current.properties.flag).toBe('boolean');
      expect(Object.hasOwn(current.properties, 'total')).toBe(false);
      expect(await readDisk(harness.vault, DATABASE_PATH)).toBe(schemaBefore);
      const storedRow = await readDisk(harness.vault, ROW_PATH);
      expect(storedRow).toContain('vendorRecord:');
      expect(storedRow).toContain('id: opaque-widget-7f21');
      expect(storedRow).toContain('tags: [retain, nested]');

      await harness.reopen();
      const reopened = row(harness.api, ROW_ID);
      expect(reopened.properties.message).toBe('message update');
      expect(reopened.properties.quantity).toBe(0);
      expect(typeof reopened.properties.quantity).toBe('number');
      expect(reopened.properties.flag).toBe(true);
      expect(typeof reopened.properties.flag).toBe('boolean');
      expect(Object.hasOwn(reopened.properties, 'total')).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('rejects accessor and revoked Proxy payloads without invoking getters or throwing', async () => {
    const harness = await openHarness();
    try {
      const initial = ready(harness.base);
      const diskBefore = await readDisk(harness.vault, ROW_PATH);
      const writesBefore = harness.vault.applyCount;
      const providerChecks: string[] = [];
      const handleCleanup = (() => {
        const scopedBase = createDataApi({
          session: harness.session,
          ownerIsActive: () => true,
          isProviderActive: (id) => {
            providerChecks.push(id);
            return id === DATABASE_ID;
          },
          isHostReadonly: () => false,
          registerCleanup: () => {},
        });
        return scopedBase;
      })();
      const rawPatch = handleCleanup.patchTextCell as unknown as (input: unknown) => unknown;
      const accessorFields = ['databaseId', 'rowId', 'propertyId', 'value', 'expectedRevision'] as const;
      for (const field of accessorFields) {
        let getterCalls = 0;
        const values: Record<string, unknown> = {
          databaseId: DATABASE_ID,
          rowId: ROW_ID,
          propertyId: 'message',
          value: 'should not stage',
          expectedRevision: initial.revision,
        };
        const payload = Object.defineProperties(
          {},
          {
            databaseId: { configurable: true, enumerable: true, value: values.databaseId },
            rowId: { configurable: true, enumerable: true, value: values.rowId },
            propertyId: { configurable: true, enumerable: true, value: values.propertyId },
            value: { configurable: true, enumerable: true, value: values.value },
            expectedRevision: { configurable: true, enumerable: true, value: values.expectedRevision },
          },
        );
        Object.defineProperty(payload, field, {
          enumerable: true,
          get() {
            const read = getterCalls;
            getterCalls += 1;
            if (field === 'databaseId') return read === 0 ? DATABASE_ID : 'other-database';
            return values[field];
          },
        });
        expect(rawPatch(payload)).toMatchObject({ status: 'error', code: 'invalid-value' });
        expect(getterCalls).toBe(0);

        const scopedRawPatch = harness.api.patchTextCell as unknown as (input: unknown) => unknown;
        expect(scopedRawPatch(payload)).toMatchObject({ status: 'error', code: 'invalid-value' });
        expect(getterCalls).toBe(0);
      }
      expect(providerChecks).toHaveLength(accessorFields.length - 1);
      expect(providerChecks.every((id) => id === DATABASE_ID)).toBe(true);

      const revokedPatch = Proxy.revocable(
        {
          databaseId: DATABASE_ID,
          rowId: ROW_ID,
          propertyId: 'message',
          value: 'revoked',
          expectedRevision: initial.revision,
        },
        {},
      );
      revokedPatch.revoke();
      expect(() => rawPatch(revokedPatch.proxy)).not.toThrow();
      expect(rawPatch(revokedPatch.proxy)).toMatchObject({ status: 'error', code: 'invalid-value' });

      const rawHistory = handleCleanup.history as unknown as (input: unknown) => unknown;
      let historyGetterCalls = 0;
      const unstableHistory = Object.defineProperties(
        {},
        {
          databaseId: {
            configurable: true,
            enumerable: true,
            get() {
              const read = historyGetterCalls;
              historyGetterCalls += 1;
              return read === 0 ? DATABASE_ID : 'other-database';
            },
          },
          direction: { enumerable: true, value: 'undo' },
          expectedRevision: { enumerable: true, value: initial.revision },
        },
      );
      expect(rawHistory(unstableHistory)).toMatchObject({ status: 'error', code: 'invalid-value' });
      expect(historyGetterCalls).toBe(0);
      const scopedRawHistory = harness.api.history as unknown as (input: unknown) => unknown;
      expect(scopedRawHistory(unstableHistory)).toMatchObject({ status: 'error', code: 'invalid-value' });
      expect(historyGetterCalls).toBe(0);

      const revokedHistory = Proxy.revocable(
        { databaseId: DATABASE_ID, direction: 'undo', expectedRevision: initial.revision },
        {},
      );
      revokedHistory.revoke();
      expect(() => rawHistory(revokedHistory.proxy)).not.toThrow();
      expect(rawHistory(revokedHistory.proxy)).toMatchObject({ status: 'error', code: 'invalid-value' });

      expect(ready(harness.base)).toEqual(initial);
      expect(await readDisk(harness.vault, ROW_PATH)).toBe(diskBefore);
      expect(harness.vault.applyCount).toBe(writesBefore);
    } finally {
      await harness.close();
    }
  });

  it('handles inherited-looking missing IDs and preserves actual own IDs constructor and __proto__', async () => {
    const emptyHarness = await openHarness();
    let missingHandleCleanup = () => {};
    const missingHandle = createDataApi({
      session: emptyHarness.session,
      ownerIsActive: () => true,
      isProviderActive: () => true,
      isHostReadonly: () => false,
      registerCleanup: (cleanup) => {
        missingHandleCleanup = cleanup;
      },
    });
    try {
      for (const id of ['constructor', '__proto__'] as PageId[]) {
        expect(() => missingHandle.snapshot(id)).not.toThrow();
        expect(missingHandle.snapshot(id)).toMatchObject({ status: 'missing' });
        expect(
          missingHandle.patchTextCell?.({
            databaseId: id,
            rowId: 'absent-row' as PageId,
            propertyId: 'message',
            value: 'x',
            expectedRevision: missingHandle.snapshot(id).revision,
          }),
        ).toMatchObject({ status: 'error', code: 'not-opted-in' });
        expect(
          missingHandle.history({
            databaseId: id,
            direction: 'undo',
            expectedRevision: missingHandle.snapshot(id).revision,
          }),
        ).toMatchObject({ status: 'error', code: 'not-opted-in' });
      }
    } finally {
      missingHandleCleanup();
      await emptyHarness.close();
    }

    const actualHarness = await openHarness({ databaseId: 'constructor', rowId: '__proto__' });
    try {
      expect(Object.hasOwn(actualHarness.session.getState().pages, 'constructor')).toBe(true);
      expect(Object.hasOwn(actualHarness.session.getState().pages, '__proto__')).toBe(true);
      expect(row(actualHarness.api, '__proto__' as PageId, 'constructor' as PageId).properties.message).toBe(
        '  opening  ',
      );
      expect(
        patchText(actualHarness.api, '__proto__' as PageId, 'updated', {
          databaseId: 'constructor' as PageId,
        }),
      ).toMatchObject({ status: 'staged' });
      expect(await flush(actualHarness.api, 'constructor' as PageId)).toMatchObject({ status: 'persisted' });
      expect(history(actualHarness.api, 'constructor' as PageId, 'undo')).toMatchObject({ status: 'staged' });
      expect(await flush(actualHarness.api, 'constructor' as PageId)).toMatchObject({ status: 'persisted' });
      expect(row(actualHarness.api, '__proto__' as PageId, 'constructor' as PageId).properties.message).toBe(
        '  opening  ',
      );
      expect(history(actualHarness.api, 'constructor' as PageId, 'redo')).toMatchObject({ status: 'staged' });
      expect(await flush(actualHarness.api, 'constructor' as PageId)).toMatchObject({ status: 'persisted' });
      await actualHarness.reopen();
      expect(row(actualHarness.api, '__proto__' as PageId, 'constructor' as PageId).properties.message).toBe(
        'updated',
      );
    } finally {
      await actualHarness.close();
    }
  });

  it('loads, edits, undoes, redoes, flushes, and reopens a real own text property named __proto__', async () => {
    const harness = await openHarness({ propertyId: '__proto__' });
    try {
      const before = row(harness.api, ROW_ID);
      expect(Object.hasOwn(before.properties, '__proto__')).toBe(true);
      expect(before.properties['__proto__']).toBe('  opening  ');
      expect(harness.vault.applyCount).toBe(0);

      expect(patchText(harness.api, ROW_ID, 'edited proto value', { propertyId: '__proto__' })).toMatchObject(
        {
          status: 'staged',
        },
      );
      expect(Object.hasOwn(row(harness.api, ROW_ID).properties, '__proto__')).toBe(true);
      expect(row(harness.api, ROW_ID).properties['__proto__']).toBe('edited proto value');
      expect(await flush(harness.api, DATABASE_ID)).toMatchObject({ status: 'persisted' });
      expect((await readDisk(harness.vault, ROW_PATH)).match(/^Message:/m)).not.toBeNull();

      expect(history(harness.api, DATABASE_ID, 'undo')).toMatchObject({ status: 'staged' });
      expect(await flush(harness.api, DATABASE_ID)).toMatchObject({ status: 'persisted' });
      expect(Object.hasOwn(row(harness.api, ROW_ID).properties, '__proto__')).toBe(true);
      expect(row(harness.api, ROW_ID).properties['__proto__']).toBe('  opening  ');
      expect(history(harness.api, DATABASE_ID, 'redo')).toMatchObject({ status: 'staged' });
      expect(await flush(harness.api, DATABASE_ID)).toMatchObject({ status: 'persisted' });

      await harness.reopen();
      const reopened = row(harness.api, ROW_ID);
      expect(Object.hasOwn(reopened.properties, '__proto__')).toBe(true);
      expect(reopened.properties['__proto__']).toBe('edited proto value');
    } finally {
      await harness.close();
    }
  });
});
