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
import { parse } from 'yaml';
import type { VaultScan } from '../core/vault/load';
import type { VaultOp, VaultOpResult } from '../core/vault/plan';
import { createDataApi } from '../app/plugins/dataApi';
import type { DataApi, DataApiSnapshot } from '../app/plugins/dataApi';
import { createProviderDataScope } from '../app/plugins/providerDataScope';
import { splitFrontmatter } from '../core/vault/frontmatter';
import type { VaultBridge, VaultChange, VaultFileInfo } from './vaultBridge';
import { MemoryVault } from './memoryVault';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';

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
    - id: calculated
      name: Calculated
      type: formula
      formula: Quantity * 2
  views:
    - id: table
      name: Table
      type: table
---
# Inventory
`;

const NORMAL_ROW = `---
Message: "  opening  "
Quantity: 2
Flag: true
vendorRecord:
  id: opaque-widget-7f21
  audit:
    source: synthetic
    tags: [retain, nested]
---
Synthetic row.
`;

class DiskVault implements VaultBridge {
  private readonly listeners = new Set<(changes: VaultChange[]) => void>();
  applyCount = 0;
  readonly writtenPaths: string[] = [];

  constructor(readonly root: string) {}

  private path(path: string): string {
    return join(this.root, ...path.split('/'));
  }

  async scan(): Promise<VaultScan> {
    const files: VaultScan['files'] = [];
    const folders: VaultScan['folders'] = [];
    const others: string[] = [];
    const visit = async (relative: string): Promise<void> => {
      const absolute = relative ? this.path(relative) : this.root;
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
        const info = await stat(this.path(path));
        if (['.md', '.canvas'].includes(extname(path).toLowerCase())) {
          files.push({
            path,
            text: await readFile(this.path(path), 'utf8'),
            mtime: info.mtimeMs,
            birthtime: info.birthtimeMs,
          });
        } else others.push(path);
      }
    };
    await visit('');
    const readJson = async (path: string): Promise<unknown> => {
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
      registry: await readJson('.morrow/workspace.json'),
      recent: await readJson('.morrow/recent.json'),
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
          await mkdir(dirname(this.path(op.path)), { recursive: true });
          await writeFile(this.path(op.path), op.text, 'utf8');
          this.writtenPaths.push(op.path);
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
          if (await this.exists(op.to)) {
            results.push({ ok: false, code: 'exists', message: `${op.to} exists` });
            break;
          }
          await mkdir(dirname(this.path(op.to)), { recursive: true });
          await rename(this.path(op.from), this.path(op.to));
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
    const entries = await readdir(this.path(directory), { withFileTypes: true });
    const files: VaultFileInfo[] = [];
    for (const entry of entries) {
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

function sourceFiles(row = NORMAL_ROW, extraFiles: Record<string, string> = {}): Record<string, string> {
  return {
    'Inventory.md': DATABASE,
    'Inventory/Widget.md': row,
    'Inventory/Null.md': `---\nMessage: null\n---\nExplicit null.\n`,
    'Inventory/Missing.md': `---\nQuantity: 1\n---\nMissing text.\n`,
    'Inventory/Empty.md': `---\n---\nEmpty text.\n`,
    'Inventory/Limit.md': `---\n---\nMaximum text length.\n`,
    ...extraFiles,
  };
}

function withDiskRegistry(files: Record<string, string>): Record<string, string> {
  const orderByParent = new Map<string, number>();
  const pages = Object.fromEntries(
    Object.keys(files)
      .filter((path) => ['.md', '.canvas'].includes(extname(path).toLowerCase()))
      .sort()
      .map((path, index) => {
        const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        const order = orderByParent.get(parent) ?? 0;
        orderByParent.set(parent, order + 1);
        const id = `disk-${path.replace(/[^A-Za-z0-9_-]/g, '-')}`;
        return [path, { id, created: index + 1, order }];
      }),
  );
  return {
    ...files,
    '.morrow/workspace.json': `${JSON.stringify({ version: 1, pages }, null, 1)}\n`,
    '.morrow/recent.json': `${JSON.stringify({ version: 1, opened: {}, activity: {} }, null, 1)}\n`,
  };
}

async function makeVault(files: Record<string, string>): Promise<DiskVault> {
  const root = await mkdtemp(join(tmpdir(), 'morrow-e003-text-'));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }
  return new DiskVault(root);
}

async function open(bridge: VaultBridge): Promise<WorkspaceSession> {
  let nextId = 0;
  const result = await WorkspaceSession.open(new VaultRepository(bridge, () => `text-${++nextId}`), {
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

function apiFor(
  session: WorkspaceSession,
  options: {
    isProviderActive?: (databaseId: string) => boolean;
    isHostReadonly?: () => boolean;
  } = {},
): { api: DataApi; cleanup: () => void } {
  let cleanup = () => {};
  const api = createDataApi({
    session,
    ownerIsActive: () => true,
    isProviderActive: options.isProviderActive ?? (() => true),
    isHostReadonly: options.isHostReadonly ?? (() => false),
    registerCleanup: (onCleanup) => {
      cleanup = onCleanup;
    },
  });
  return { api, cleanup: () => cleanup() };
}

function ready(snapshot: DataApiSnapshot) {
  if (snapshot.status !== 'ready') throw new Error(`Expected ready snapshot, received ${snapshot.status}.`);
  return snapshot;
}

function rowOf(snapshot: ReturnType<typeof ready>, rowId: string) {
  const row = snapshot.rows.find((candidate) => candidate.id === rowId);
  if (!row) throw new Error(`No row ${rowId} in snapshot.`);
  return row;
}

describe('Polaris Dados exact opt-in text storage', () => {
  it('supports a text property ID of __proto__ through load, edit, undo, redo, flush, and reopen', async () => {
    const database = DATABASE.replace('id: message', 'id: __proto__');
    const vault = new MemoryVault({ ...sourceFiles(), 'Inventory.md': database });
    let session: WorkspaceSession | undefined = await open(vault);
    let handle = apiFor(session);
    try {
      const databaseId = idAt(session, 'Inventory.md');
      const widgetId = idAt(session, 'Inventory/Widget.md');
      const missingId = idAt(session, 'Inventory/Missing.md');
      const initialMarkdown = vault.text('Inventory/Widget.md');
      const initial = ready(handle.api.snapshot(databaseId));
      const initialWidget = rowOf(initial, widgetId).properties as Record<string, unknown>;
      expect(initial.status).toBe('ready');
      expect(Object.hasOwn(initialWidget, '__proto__')).toBe(true);
      expect(initialWidget.__proto__).toBe('  opening  ');
      expect(Object.hasOwn(rowOf(initial, missingId).properties, '__proto__')).toBe(false);

      expect(
        handle.api.patchTextCell?.({
          databaseId,
          rowId: widgetId,
          propertyId: '__proto__',
          value: 'updated',
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'staged' });
      let current = ready(handle.api.snapshot(databaseId));
      expect((rowOf(current, widgetId).properties as Record<string, unknown>).__proto__).toBe('updated');
      expect(vault.text('Inventory/Widget.md')).toBe(initialMarkdown);

      expect(handle.api.history({ databaseId, direction: 'undo', expectedRevision: current.revision })).toMatchObject({
        status: 'staged',
      });
      current = ready(handle.api.snapshot(databaseId));
      expect((rowOf(current, widgetId).properties as Record<string, unknown>).__proto__).toBe('  opening  ');
      expect(handle.api.history({ databaseId, direction: 'redo', expectedRevision: current.revision })).toMatchObject({
        status: 'staged',
      });
      current = ready(handle.api.snapshot(databaseId));
      expect((rowOf(current, widgetId).properties as Record<string, unknown>).__proto__).toBe('updated');

      const missingInitial = current.revision;
      expect(
        handle.api.patchTextCell?.({
          databaseId,
          rowId: missingId,
          propertyId: '__proto__',
          value: 'added',
          expectedRevision: missingInitial,
        }),
      ).toMatchObject({ status: 'staged' });
      current = ready(handle.api.snapshot(databaseId));
      expect(Object.hasOwn(rowOf(current, missingId).properties, '__proto__')).toBe(true);
      expect(handle.api.history({ databaseId, direction: 'undo', expectedRevision: current.revision })).toMatchObject({
        status: 'staged',
      });
      current = ready(handle.api.snapshot(databaseId));
      expect(Object.hasOwn(rowOf(current, missingId).properties, '__proto__')).toBe(false);
      expect(handle.api.history({ databaseId, direction: 'redo', expectedRevision: current.revision })).toMatchObject({
        status: 'staged',
      });
      current = ready(handle.api.snapshot(databaseId));
      expect((rowOf(current, missingId).properties as Record<string, unknown>).__proto__).toBe('added');

      expect(await handle.api.flush(databaseId)).toMatchObject({ status: 'persisted' });
      const persistedMarkdown = vault.text('Inventory/Widget.md');
      expect(persistedMarkdown).not.toBe(initialMarkdown);
      expect(persistedMarkdown).toContain('Message: "updated"');
      expect(persistedMarkdown).toContain('vendorRecord:');

      handle.cleanup();
      await session.close();
      session = await open(vault);
      handle = apiFor(session);
      const reopenedDatabaseId = idAt(session, 'Inventory.md');
      const reopenedWidgetId = idAt(session, 'Inventory/Widget.md');
      const reopenedMissingId = idAt(session, 'Inventory/Missing.md');
      const reopened = ready(handle.api.snapshot(reopenedDatabaseId));
      const reopenedWidget = rowOf(reopened, reopenedWidgetId).properties as Record<string, unknown>;
      expect(Object.hasOwn(reopenedWidget, '__proto__')).toBe(true);
      expect(reopenedWidget.__proto__).toBe('updated');
      expect(Object.hasOwn(rowOf(reopened, reopenedMissingId).properties, '__proto__')).toBe(true);
      expect(session.getState().pages[reopenedWidgetId]!.extra.vendorRecord).toEqual({
        id: 'opaque-widget-7f21',
        audit: { source: 'synthetic', tags: ['retain', 'nested'] },
      });
    } finally {
      handle.cleanup();
      await session?.close();
    }
  });

  it('turns revoked Proxy payloads into invalid-value without throwing or mutating', async () => {
    const bridge = await makeVault(sourceFiles());
    const session = await open(bridge);
    const databaseId = idAt(session, 'Inventory.md');
    const widgetId = idAt(session, 'Inventory/Widget.md');
    let hostReadonly = false;
    const { api, cleanup } = apiFor(session, { isHostReadonly: () => hostReadonly });
    let scopeEditable = true;
    let scopeActive = true;
    const scope = createProviderDataScope(api, databaseId, {
      isActive: () => scopeActive,
      editable: () => scopeEditable,
    });
    const rawPatchText = api.patchTextCell as unknown as (input: unknown) => unknown;
    const scopedPatchText = scope.api.patchTextCell as unknown as (input: unknown) => unknown;
    const rawHistory = api.history as unknown as (input: unknown) => unknown;
    const scopedHistory = scope.api.history as unknown as (input: unknown) => unknown;
    const rawSessionPatch = (input: unknown) =>
      session.patchPilotDataCell(input as Parameters<WorkspaceSession['patchPilotDataCell']>[0]);
    const rawSessionHistory = (input: unknown) =>
      session.pilotDataHistoryChange(input as Parameters<WorkspaceSession['pilotDataHistoryChange']>[0]);
    try {
      const initial = ready(api.snapshot(databaseId));
      const revoked = Proxy.revocable({}, {});
      revoked.revoke();

      expect(() => rawPatchText(revoked.proxy)).not.toThrow();
      expect(rawPatchText(revoked.proxy)).toMatchObject({ status: 'error', code: 'invalid-value' });
      expect(() => scopedPatchText(revoked.proxy)).not.toThrow();
      expect(scopedPatchText(revoked.proxy)).toMatchObject({ status: 'error', code: 'invalid-value' });
      expect(() => rawHistory(revoked.proxy)).not.toThrow();
      expect(rawHistory(revoked.proxy)).toMatchObject({ status: 'error', code: 'invalid-value' });
      expect(() => scopedHistory(revoked.proxy)).not.toThrow();
      expect(scopedHistory(revoked.proxy)).toMatchObject({ status: 'error', code: 'invalid-value' });
      expect(() => rawSessionPatch(revoked.proxy)).not.toThrow();
      expect(rawSessionPatch(revoked.proxy)).toMatchObject({ ok: false, code: 'invalid-value' });
      expect(() => rawSessionHistory(revoked.proxy)).not.toThrow();
      expect(rawSessionHistory(revoked.proxy)).toMatchObject({ ok: false, code: 'invalid-value' });

      scopeEditable = false;
      expect(() => scopedPatchText(revoked.proxy)).not.toThrow();
      expect(scopedPatchText(revoked.proxy)).toMatchObject({ status: 'error', code: 'host-readonly' });
      scopeEditable = true;
      hostReadonly = true;
      expect(() => rawPatchText(revoked.proxy)).not.toThrow();
      expect(rawPatchText(revoked.proxy)).toMatchObject({ status: 'error', code: 'host-readonly' });
      hostReadonly = false;
      scopeActive = false;
      expect(() => scopedPatchText(revoked.proxy)).not.toThrow();
      expect(scopedPatchText(revoked.proxy)).toMatchObject({ status: 'error', code: 'owner-inactive' });

      expect(rowOf(ready(api.snapshot(databaseId)), widgetId).properties.message).toBe('  opening  ');
      expect(session.queue.isDirty(widgetId)).toBe(false);
      expect(bridge.applyCount).toBe(0);
      expect(initial.revision).toBe(ready(api.snapshot(databaseId)).revision);
    } finally {
      scope.dispose();
      cleanup();
      await session.close();
      await rm(bridge.root, { recursive: true, force: true });
    }
  });

  it('rejects unstable patch accessors at both base and provider entry points without writes', async () => {
    const bridge = await makeVault({
      ...sourceFiles(),
      'Other.md': DATABASE,
      'Other/Widget.md': NORMAL_ROW,
    });
    const session = await open(bridge);
    const databaseId = idAt(session, 'Inventory.md');
    const otherDatabaseId = idAt(session, 'Other.md');
    const rowId = idAt(session, 'Other/Widget.md');
    const otherRowId = idAt(session, 'Inventory/Widget.md');
    let providerChecks: string[] = [];
    const { api, cleanup } = apiFor(session, {
      isProviderActive: (id) => {
        providerChecks.push(id);
        return id === databaseId;
      },
    });
    const makeUnstablePatch = (expectedRevision: string) => {
      let reads = 0;
      return Object.defineProperties({}, {
        databaseId: {
          enumerable: true,
          get: () => (reads++ === 0 ? databaseId : otherDatabaseId),
        },
        rowId: { enumerable: true, value: rowId },
        propertyId: { enumerable: true, value: 'message' },
        value: { enumerable: true, value: 'must not write' },
        expectedRevision: { enumerable: true, value: expectedRevision },
      });
    };
    try {
      const otherRevision = ready(api.snapshot(otherDatabaseId)).revision;
      providerChecks = [];
      const rawPatchText = api.patchTextCell as unknown as (input: unknown) => unknown;

      const baseResult = rawPatchText(makeUnstablePatch(otherRevision));
      expect(baseResult).toMatchObject({ status: 'error', code: 'invalid-value' });
      expect(providerChecks).toEqual([]);

      const scopedHandle = apiFor(session);
      const scope = createProviderDataScope(scopedHandle.api, databaseId, { isActive: () => true, editable: true });
      try {
        const scopedResult = (scope.api.patchTextCell as unknown as (input: unknown) => unknown)(
          makeUnstablePatch(otherRevision),
        );
        expect(scopedResult).toMatchObject({ status: 'error', code: 'invalid-value' });
        expect(rowOf(ready(api.snapshot(otherDatabaseId)), rowId).properties.message).toBe('  opening  ');
        expect(rowOf(ready(api.snapshot(databaseId)), otherRowId).properties.message).toBe('  opening  ');
        expect(session.queue.isDirty(rowId)).toBe(false);
        expect(bridge.applyCount).toBe(0);
      } finally {
        scope.dispose();
        scopedHandle.cleanup();
      }
    } finally {
      cleanup();
      await session.close();
      await rm(bridge.root, { recursive: true, force: true });
    }
  });

  it('passes opaque provider patch and history revisions through unchanged', () => {
    const databaseId = 'scoped-db';
    let patchRevision: string | undefined;
    let textRevision: string | undefined;
    let historyRevision: string | undefined;
    const source: DataApi = {
      version: 1,
      snapshot(id) {
        return {
          version: 1,
          status: 'ready',
          databaseId: id,
          revision: 'r0',
          schema: { properties: [], views: [] },
          rows: [],
          history: { canUndo: false, canRedo: false },
          readonly: false,
          diagnostic: null,
        };
      },
      patchCell(input) {
        patchRevision = input.expectedRevision;
        return {
          status: 'staged',
          databaseId: input.databaseId,
          rowId: input.rowId,
          propertyId: input.propertyId,
          revision: input.expectedRevision,
        };
      },
      patchTextCell(input) {
        textRevision = input.expectedRevision;
        return {
          status: 'staged',
          databaseId: input.databaseId,
          rowId: input.rowId,
          propertyId: input.propertyId,
          revision: input.expectedRevision,
        };
      },
      history(input) {
        historyRevision = input.expectedRevision;
        return {
          status: 'staged',
          databaseId: input.databaseId,
          revision: input.expectedRevision,
          direction: input.direction,
        };
      },
      subscribe() {
        return () => {};
      },
      async flush(id) {
        return { status: 'persisted', databaseId: id, revision: 'r0' };
      },
    };
    const scope = createProviderDataScope(source, databaseId, { isActive: () => true, editable: true });
    try {
      expect(scope.api.patchCheckboxCell).toBeUndefined();
      expect(
        scope.api.patchCell({
          databaseId,
          rowId: 'row',
          propertyId: 'quantity',
          value: 3,
          expectedRevision: 'r0',
        }),
      ).toMatchObject({ status: 'staged', revision: 'r0' });
      expect(
        scope.api.patchTextCell?.({
          databaseId,
          rowId: 'row',
          propertyId: 'message',
          value: 'updated',
          expectedRevision: 'revision-2',
        }),
      ).toMatchObject({ status: 'staged', revision: 'revision-2' });
      expect(scope.api.history({ databaseId, direction: 'undo', expectedRevision: 'r0' })).toMatchObject({
        status: 'staged',
        revision: 'r0',
      });
      expect(patchRevision).toBe('r0');
      expect(textRevision).toBe('revision-2');
      expect(historyRevision).toBe('r0');
      expect(
        scope.api.patchCell({
          databaseId,
          rowId: 'row',
          propertyId: 'quantity',
          value: 4,
          expectedRevision: '',
        }),
      ).toMatchObject({ status: 'error', code: 'invalid-value' });
      expect(scope.api.history({ databaseId, direction: 'undo', expectedRevision: '' })).toMatchObject({
        status: 'error',
        code: 'invalid-value',
      });
    } finally {
      scope.dispose();
    }
  });

  it('treats prototype names as missing IDs and preserves real opaque IDs with those spellings', async () => {
    const emptyBridge = await makeVault({});
    const emptySession = await open(emptyBridge);
    const emptyHandle = apiFor(emptySession);
    try {
      for (const databaseId of ['constructor', '__proto__', 'ordinary-missing']) {
        expect(() => emptyHandle.api.snapshot(databaseId)).not.toThrow();
        expect(emptyHandle.api.snapshot(databaseId)).toMatchObject({ status: 'missing' });
        expect(
          emptySession.patchPilotDataCell({
            databaseId,
            rowId: 'row',
            propertyId: 'message',
            value: 'x',
            expectedRevision: emptySession.pilotDataRevision(databaseId),
          }),
        ).toMatchObject({ ok: false, code: 'not-opted-in' });
        expect(
          emptySession.pilotDataHistoryChange({
            databaseId,
            direction: 'undo',
            expectedRevision: emptySession.pilotDataRevision(databaseId),
          }),
        ).toMatchObject({ ok: false, code: 'not-opted-in' });
      }
    } finally {
      emptyHandle.cleanup();
      await emptySession.close();
      await rm(emptyBridge.root, { recursive: true, force: true });
    }

    const registry = {
      version: 1,
      pages: {
        'Inventory.md': { id: 'constructor' },
        'Inventory/Widget.md': { id: '__proto__' },
        'Inventory/Null.md': { id: 'null-row' },
        'Inventory/Missing.md': { id: 'missing-row' },
        'Inventory/Empty.md': { id: 'empty-row' },
        'Inventory/Limit.md': { id: 'limit-row' },
      },
    };
    const bridge = await makeVault({
      ...sourceFiles(),
      '.morrow/workspace.json': JSON.stringify(registry),
    });
    const session = await open(bridge);
    const { api, cleanup } = apiFor(session);
    try {
      expect(Object.hasOwn(session.getState().pages, 'constructor')).toBe(true);
      expect(Object.hasOwn(session.getState().pages, '__proto__')).toBe(true);
      const initial = ready(api.snapshot('constructor'));
      expect(rowOf(initial, '__proto__').properties.message).toBe('  opening  ');
      expect(
        api.patchTextCell?.({
          databaseId: 'constructor',
          rowId: '__proto__',
          propertyId: 'message',
          value: 'updated',
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'staged' });
      const updated = ready(api.snapshot('constructor'));
      expect(rowOf(updated, '__proto__').properties.message).toBe('updated');
      expect(api.history({ databaseId: 'constructor', direction: 'undo', expectedRevision: updated.revision })).toMatchObject({
        status: 'staged',
      });
      expect(rowOf(ready(api.snapshot('constructor')), '__proto__').properties.message).toBe('  opening  ');
    } finally {
      cleanup();
      await session.close();
      await rm(bridge.root, { recursive: true, force: true });
    }
  });

  it('preserves Unicode, edge spaces, LF, empty, null and absent through API, history, flush and disk re-open', async () => {
    const bridge = await makeVault(sourceFiles());
    let session: WorkspaceSession | undefined;
    let cleanup = () => {};
    try {
      session = await open(bridge);
      const handle = apiFor(session);
      const databaseId = idAt(session, 'Inventory.md');
      const scope = createProviderDataScope(handle.api, databaseId, { isActive: () => true, editable: true });
      cleanup = () => {
        scope.dispose();
        handle.cleanup();
      };
      const { api } = scope;
      const widgetId = idAt(session, 'Inventory/Widget.md');
      const nullId = idAt(session, 'Inventory/Null.md');
      const missingId = idAt(session, 'Inventory/Missing.md');
      const emptyId = idAt(session, 'Inventory/Empty.md');
      const limitId = idAt(session, 'Inventory/Limit.md');
      const originalSchema = await bridge.readText('Inventory.md');
      const initial = ready(api.snapshot(databaseId));
      expect(rowOf(initial, widgetId).properties.message).toBe('  opening  ');
      expect(rowOf(initial, widgetId).properties.quantity).toBe(2);
      expect(rowOf(initial, widgetId).properties.flag).toBe(true);
      expect(rowOf(initial, nullId).properties.message).toBeNull();
      expect(Object.hasOwn(rowOf(initial, missingId).properties, 'message')).toBe(false);
      expect(bridge.applyCount).toBe(0);
      const rawPatchText = api.patchTextCell as unknown as (input: unknown) => unknown;
      expect(rawPatchText(null)).toMatchObject({ status: 'error', code: 'invalid-value' });

      const exact = '  初め 🌿  \nline two\n\nlast\t  ';
      expect(
        api.patchTextCell?.({
          databaseId,
          rowId: widgetId,
          propertyId: 'message',
          value: exact,
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'staged' });
      expect(rowOf(ready(api.snapshot(databaseId)), widgetId).properties.message).toBe(exact);
      expect(await api.flush(databaseId)).toMatchObject({ status: 'persisted' });

      let current = ready(api.snapshot(databaseId));
      expect(
        api.history({ databaseId, direction: 'undo', expectedRevision: current.revision }),
      ).toMatchObject({ status: 'staged' });
      expect(await api.flush(databaseId)).toMatchObject({ status: 'persisted' });
      expect(rowOf(ready(api.snapshot(databaseId)), widgetId).properties.message).toBe('  opening  ');

      current = ready(api.snapshot(databaseId));
      expect(
        api.history({ databaseId, direction: 'redo', expectedRevision: current.revision }),
      ).toMatchObject({ status: 'staged' });
      expect(await api.flush(databaseId)).toMatchObject({ status: 'persisted' });

      current = ready(api.snapshot(databaseId));
      expect(
        api.patchTextCell?.({
          databaseId,
          rowId: emptyId,
          propertyId: 'message',
          value: '',
          expectedRevision: current.revision,
        }),
      ).toMatchObject({ status: 'staged' });
      expect(await api.flush(databaseId)).toMatchObject({ status: 'persisted' });
      const emptySnapshot = ready(api.snapshot(databaseId));
      const emptyRow = rowOf(emptySnapshot, emptyId);
      expect(Object.hasOwn(emptyRow.properties, 'message')).toBe(true);
      expect(emptyRow.properties.message).toBe('');

      current = ready(api.snapshot(databaseId));
      expect(
        api.patchTextCell?.({
          databaseId,
          rowId: missingId,
          propertyId: 'message',
          value: null,
          expectedRevision: current.revision,
        }),
      ).toMatchObject({ status: 'staged' });
      expect(await api.flush(databaseId)).toMatchObject({ status: 'persisted' });
      current = ready(api.snapshot(databaseId));
      expect(Object.hasOwn(rowOf(current, missingId).properties, 'message')).toBe(true);
      expect(rowOf(current, missingId).properties.message).toBeNull();
      expect(
        api.history({ databaseId, direction: 'undo', expectedRevision: current.revision }),
      ).toMatchObject({ status: 'staged' });
      expect(await api.flush(databaseId)).toMatchObject({ status: 'persisted' });
      current = ready(api.snapshot(databaseId));
      expect(Object.hasOwn(rowOf(current, missingId).properties, 'message')).toBe(false);
      expect(
        api.history({ databaseId, direction: 'redo', expectedRevision: current.revision }),
      ).toMatchObject({ status: 'staged' });
      expect(await api.flush(databaseId)).toMatchObject({ status: 'persisted' });

      current = ready(api.snapshot(databaseId));
      const maximumText = 'x'.repeat(10_000);
      expect(
        api.patchTextCell?.({
          databaseId,
          rowId: limitId,
          propertyId: 'message',
          value: maximumText,
          expectedRevision: current.revision,
        }),
      ).toMatchObject({ status: 'staged' });
      expect(rowOf(ready(api.snapshot(databaseId)), limitId).properties.message).toBe(maximumText);
      expect(await api.flush(databaseId)).toMatchObject({ status: 'persisted' });
      expect(rowOf(ready(api.snapshot(databaseId)), widgetId).properties.quantity).toBe(2);

      cleanup();
      cleanup = () => {};
      await session.close();
      session = await open(bridge);
      const reopenedApi = apiFor(session);
      cleanup = reopenedApi.cleanup;
      const reopened = ready(reopenedApi.api.snapshot(idAt(session, 'Inventory.md')));
      expect(rowOf(reopened, idAt(session, 'Inventory/Widget.md')).properties.message).toBe(exact);
      expect(rowOf(reopened, idAt(session, 'Inventory/Widget.md')).properties.quantity).toBe(2);
      expect(rowOf(reopened, idAt(session, 'Inventory/Widget.md')).properties.flag).toBe(true);
      const reopenedEmpty = rowOf(reopened, idAt(session, 'Inventory/Empty.md'));
      expect(Object.hasOwn(reopenedEmpty.properties, 'message')).toBe(true);
      expect(reopenedEmpty.properties.message).toBe('');
      const reopenedMissing = rowOf(reopened, idAt(session, 'Inventory/Missing.md'));
      expect(Object.hasOwn(reopenedMissing.properties, 'message')).toBe(true);
      expect(reopenedMissing.properties.message).toBeNull();
      expect(rowOf(reopened, idAt(session, 'Inventory/Null.md')).properties.message).toBeNull();
      expect(rowOf(reopened, idAt(session, 'Inventory/Limit.md')).properties.message).toBe(
        'x'.repeat(10_000),
      );
      expect(await bridge.readText('Inventory/Widget.md')).toContain('Message:');
      expect(await bridge.readText('Inventory/Widget.md')).toContain('vendorRecord:');
      expect(await bridge.readText('Inventory.md')).toBe(originalSchema);
    } finally {
      cleanup();
      if (session && !session.isClosed) await session.close();
      await rm(bridge.root, { recursive: true, force: true });
    }
  });

  it('rejects wrong scalar types, malformed ids/revisions, stale writes and writes behind guards', async () => {
    const bridge = await makeVault(sourceFiles());
    const session = await open(bridge);
    const databaseId = idAt(session, 'Inventory.md');
    const widgetId = idAt(session, 'Inventory/Widget.md');
    let providerActive = true;
    let hostReadonly = false;
    const { api, cleanup } = apiFor(session, {
      isProviderActive: () => providerActive,
      isHostReadonly: () => hostReadonly,
    });
    let scopeActive = true;
    let scopeEditable = true;
    const scope = createProviderDataScope(api, databaseId, {
      isActive: () => scopeActive,
      editable: () => scopeEditable,
    });
    const scopedPatchText = scope.api.patchTextCell as unknown as (input: unknown) => unknown;
    const patchText = (input: object) =>
      api.patchTextCell?.(input as Parameters<NonNullable<DataApi['patchTextCell']>>[0]);
    try {
      const initial = ready(api.snapshot(databaseId));
      const scopedPatchNumber = scope.api.patchCell as unknown as (input: unknown) => unknown;
      const scopedHistory = scope.api.history as unknown as (input: unknown) => unknown;
      scopeActive = false;
      expect(scopedPatchText(null)).toMatchObject({ status: 'error', code: 'owner-inactive' });
      scopeActive = true;
      scopeEditable = false;
      expect(scopedPatchNumber(null)).toMatchObject({ status: 'error', code: 'host-readonly' });
      expect(scopedPatchText(null)).toMatchObject({ status: 'error', code: 'host-readonly' });
      expect(scopedHistory(null)).toMatchObject({ status: 'error', code: 'host-readonly' });
      expect(
        scopedPatchText({
          databaseId,
          rowId: 'bad/id',
          propertyId: 'message',
          value: 'x',
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'error', code: 'host-readonly' });
      scopeEditable = true;
      expect(scopedPatchText(null)).toMatchObject({ status: 'error', code: 'invalid-value' });
      expect(scopedPatchNumber(null)).toMatchObject({ status: 'error', code: 'invalid-value' });
      expect(scopedHistory(null)).toMatchObject({ status: 'error', code: 'invalid-value' });
      const patchTextRaw = api.patchTextCell as unknown as (input: unknown) => unknown;
      hostReadonly = true;
      expect(patchTextRaw(null)).toMatchObject({ status: 'error', code: 'host-readonly' });
      hostReadonly = false;
      providerActive = false;
      expect(
        patchTextRaw({
          databaseId,
          rowId: 'bad/id',
          propertyId: 'message',
          value: 'x',
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'error', code: 'provider-inactive' });
      providerActive = true;
      expect(
        patchText({
          databaseId,
          rowId: widgetId,
          propertyId: 'message',
          value: 3,
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'error', code: 'invalid-value' });
      const patchNumberRaw = api.patchCell as unknown as (input: unknown) => unknown;
      expect(
        patchNumberRaw({
          databaseId,
          rowId: widgetId,
          propertyId: 'quantity',
          value: '3',
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'error', code: 'invalid-value' });
      expect(
        patchText({
          databaseId,
          rowId: widgetId,
          propertyId: 'quantity',
          value: '3',
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'error', code: 'invalid-value' });
      expect(
        patchText({
          databaseId,
          rowId: widgetId,
          propertyId: 'flag',
          value: 'true',
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'error', code: 'invalid-value' });
      expect(
        patchText({
          databaseId,
          rowId: widgetId,
          propertyId: 'calculated',
          value: '3',
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'error', code: 'read-only' });
      expect(
        patchText({
          databaseId: 'bad/id',
          rowId: widgetId,
          propertyId: 'message',
          value: 'x',
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'error', code: 'invalid-value' });
      expect(
        patchText({
          databaseId,
          rowId: 'bad/id',
          propertyId: 'message',
          value: 'x',
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'error', code: 'invalid-value' });
      expect(
        patchText({
          databaseId,
          rowId: widgetId,
          propertyId: 'bad/id',
          value: 'x',
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'error', code: 'invalid-value' });
      expect(
        patchText({
          databaseId,
          rowId: widgetId,
          propertyId: 'message',
          value: 'x',
          expectedRevision: 'bad',
        }),
      ).toMatchObject({ status: 'error', code: 'invalid-value' });
      expect(
        patchText({
          databaseId,
          rowId: widgetId,
          propertyId: 'message',
          value: 'x'.repeat(10_001),
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'error', code: 'invalid-value' });
      expect(session.queue.isDirty(widgetId)).toBe(false);
      expect(rowOf(ready(api.snapshot(databaseId)), widgetId).properties.message).toBe('  opening  ');

      expect(
        api.patchCell({
          databaseId,
          rowId: widgetId,
          propertyId: 'quantity',
          value: 3,
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'staged' });
      expect(
        patchText({
          databaseId,
          rowId: widgetId,
          propertyId: 'message',
          value: 'stale',
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'error', code: 'stale-revision' });
      const revision = ready(api.snapshot(databaseId)).revision;
      providerActive = false;
      expect(
        patchText({
          databaseId,
          rowId: widgetId,
          propertyId: 'message',
          value: 'provider',
          expectedRevision: revision,
        }),
      ).toMatchObject({ status: 'error', code: 'provider-inactive' });
      providerActive = true;
      hostReadonly = true;
      expect(
        patchText({
          databaseId,
          rowId: widgetId,
          propertyId: 'message',
          value: 'readonly',
          expectedRevision: revision,
        }),
      ).toMatchObject({ status: 'error', code: 'host-readonly' });
      hostReadonly = false;
      const releaseFence = session.beginMutationFence();
      expect(
        patchText({
          databaseId,
          rowId: widgetId,
          propertyId: 'message',
          value: 'fenced',
          expectedRevision: revision,
        }),
      ).toMatchObject({ status: 'error', code: 'read-only' });
      releaseFence();
      expect(rowOf(ready(api.snapshot(databaseId)), widgetId).properties.quantity).toBe(3);
      expect(rowOf(ready(api.snapshot(databaseId)), widgetId).properties.message).toBe('  opening  ');
    } finally {
      scope.dispose();
      cleanup();
      await session.close();
      await rm(bridge.root, { recursive: true, force: true });
    }
    expect(
      api.patchCell({
        databaseId,
        rowId: widgetId,
        propertyId: 'quantity',
        value: 4,
        expectedRevision: '00000000-0000-0000-0000-000000000000:r0',
      }),
    ).toMatchObject({ status: 'error', code: 'owner-inactive' });
  });

  it('keeps a staged text draft read only after an external save conflict', async () => {
    const bridge = await makeVault(sourceFiles());
    const session = await open(bridge);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const rowId = idAt(session, 'Inventory/Widget.md');
    try {
      const initial = ready(api.snapshot(databaseId));
      expect(
        api.patchTextCell?.({
          databaseId,
          rowId,
          propertyId: 'message',
          value: 'local draft',
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'staged' });
      const original = await bridge.readText('Inventory/Widget.md');
      if (!original) throw new Error('Expected source row text.');
      await writeFile(join(bridge.root, 'Inventory', 'Widget.md'), original.replace('opening', 'external'));

      expect(await api.flush(databaseId)).toMatchObject({ status: 'error', code: 'save-conflict' });
      const conflicted = ready(api.snapshot(databaseId));
      expect(conflicted).toMatchObject({ readonly: true, diagnostic: { code: 'save-conflict' } });
      expect(rowOf(conflicted, rowId).properties.message).toBe('local draft');
      expect(
        api.patchTextCell?.({
          databaseId,
          rowId,
          propertyId: 'message',
          value: 'retry',
          expectedRevision: conflicted.revision,
        }),
      ).toMatchObject({ status: 'error', code: 'save-conflict' });
      expect(await bridge.readText('Inventory/Widget.md')).toContain('external');
      expect(await bridge.readText('Inventory/Widget.md')).not.toContain('local draft');
    } finally {
      cleanup();
      await session.close();
      await rm(bridge.root, { recursive: true, force: true });
    }
  });

  it('preserves the existing opted-in number and checkbox load behavior', async () => {
    const legacyRow = `---\nMessage: "  legacy  "\nQuantity: "2"\nFlag: "true"\n---\nLegacy scalar spellings.\n`;
    const bridge = await makeVault(sourceFiles(legacyRow));
    const original = await bridge.readText('Inventory/Widget.md');
    const session = await open(bridge);
    const handle = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const rowId = idAt(session, 'Inventory/Widget.md');
    try {
      const snapshot = ready(handle.api.snapshot(databaseId));
      expect(rowOf(snapshot, rowId).properties.message).toBe('  legacy  ');
      expect(rowOf(snapshot, rowId).properties.quantity).toBe(2);
      expect(rowOf(snapshot, rowId).properties.flag).toBe(true);
      expect(snapshot.readonly).toBe(false);
      expect(bridge.applyCount).toBe(0);
      expect(await bridge.readText('Inventory/Widget.md')).toBe(original);

      expect(
        handle.api.patchTextCell?.({
          databaseId,
          rowId,
          propertyId: 'message',
          value: '  updated text  ',
          expectedRevision: snapshot.revision,
        }),
      ).toMatchObject({ status: 'staged' });
      expect(await handle.api.flush(databaseId)).toMatchObject({ status: 'persisted' });
      const updated = ready(handle.api.snapshot(databaseId));
      expect(rowOf(updated, rowId).properties.quantity).toBe(2);
      expect(rowOf(updated, rowId).properties.flag).toBe(true);
      expect(await bridge.readText('Inventory/Widget.md')).toContain('Quantity: 2');
      expect(await bridge.readText('Inventory/Widget.md')).toContain('Flag: true');
    } finally {
      handle.cleanup();
      await session.close();
      await rm(bridge.root, { recursive: true, force: true });
    }
  });

  it.each([
    ['number in text', `Message: 7\n`],
    ['object in text', `Message:\n  nested: value\n`],
    ['raw formula value', `Calculated: "1"\n`],
  ])(
    'leaves incompatible text/formula raw values available to the guard (%s)',
    async (name, rawProperties) => {
      const row = `---\n${rawProperties}---\nUnrepresentable row.\n`;
      const bridge = await makeVault(sourceFiles(row));
      const original = await bridge.readText('Inventory/Widget.md');
      const session = await open(bridge);
      const handle = apiFor(session);
      const databaseId = idAt(session, 'Inventory.md');
      try {
        const rowId = idAt(session, 'Inventory/Widget.md');
        const stateRow = session.getState().pages[rowId]!;
        expect(stateRow.properties).not.toHaveProperty('message');
        expect(stateRow.properties).not.toHaveProperty('quantity');
        expect(stateRow.properties).not.toHaveProperty('flag');
        expect(handle.api.snapshot(databaseId)).toMatchObject({
          status: 'unsupported',
          diagnostic: { code: 'unrepresentable-cell' },
        });
        expect(await handle.api.flush(databaseId)).toMatchObject({ status: 'error', code: 'unsupported' });
        expect(session.queue.isDirty(rowId)).toBe(false);
        expect(bridge.applyCount).toBe(0);
        expect(await bridge.readText('Inventory/Widget.md')).toBe(original);
        if (name === 'number in text') expect(stateRow.extra.Message).toBe(7);
        else if (name === 'object in text') expect(stateRow.extra.Message).toEqual({ nested: 'value' });
        else expect(stateRow.extra.Calculated).toBe('1');
      } finally {
        handle.cleanup();
        await session.close();
        await rm(bridge.root, { recursive: true, force: true });
      }
    },
  );
});

describe('Polaris Dados checkbox host contract', () => {
  it('undoes a checkbox added to a body-only row back to its exact original bytes', async () => {
    const original = 'Body only checkbox row.\n';
    const bridge = await makeVault(
      withDiskRegistry(sourceFiles(NORMAL_ROW, { 'Inventory/Body only checkbox.md': original })),
    );
    const session = await open(bridge);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const rowId = idAt(session, 'Inventory/Body only checkbox.md');
    try {
      const initial = ready(api.snapshot(databaseId));
      expect(Object.keys(rowOf(initial, rowId).properties)).toEqual([]);
      expect(
        api.patchCheckboxCell?.({
          databaseId,
          rowId,
          propertyId: 'flag',
          value: false,
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'staged' });
      expect(await api.flush(databaseId)).toMatchObject({ status: 'persisted' });
      expect(await bridge.readText('Inventory/Body only checkbox.md')).toContain('Flag: false');

      expect(
        api.history({
          databaseId,
          direction: 'undo',
          expectedRevision: ready(api.snapshot(databaseId)).revision,
        }),
      ).toMatchObject({ status: 'staged' });
      expect(await api.flush(databaseId)).toMatchObject({ status: 'persisted' });
      expect(await bridge.readText('Inventory/Body only checkbox.md')).toBe(original);
    } finally {
      cleanup();
      await session.close();
      await rm(bridge.root, { recursive: true, force: true });
    }
  });

  it('writes booleans through the scoped API, preserves null and absence in history, and reopens from disk', async () => {
    const files = withDiskRegistry(
      sourceFiles(NORMAL_ROW, {
        'Inventory.md': DATABASE.replace('id: flag', 'id: __proto__'),
        'Inventory/Null checkbox.md': `---\nFlag: null\n---\nExplicit null checkbox.\n`,
        'Inventory/Missing checkbox.md': `---\nMessage: absent\n---\nMissing checkbox.\n`,
      }),
    );
    const bridge = await makeVault(files);
    let session = await open(bridge);
    let handle = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const widgetId = idAt(session, 'Inventory/Widget.md');
    const nullId = idAt(session, 'Inventory/Null checkbox.md');
    const missingId = idAt(session, 'Inventory/Missing checkbox.md');
    let active = true;
    const scope = createProviderDataScope(handle.api, databaseId, { isActive: () => active, editable: true });
    const api = scope.api;
    const rowWrites = () => bridge.writtenPaths.filter((path) => !path.startsWith('.morrow/'));
    const flushAt = async (expectedPath: string) => {
      const before = rowWrites().length;
      expect(await api.flush(databaseId)).toMatchObject({ status: 'persisted' });
      expect(rowWrites().slice(before)).toEqual([expectedPath]);
    };
    const patchCheckbox = (rowId: string, value: boolean) => {
      if (!api.patchCheckboxCell) throw new Error('This provider scope has no checkbox capability.');
      return api.patchCheckboxCell({
        databaseId,
        rowId,
        propertyId: '__proto__',
        value,
        expectedRevision: ready(api.snapshot(databaseId)).revision,
      });
    };
    const history = (direction: 'undo' | 'redo') =>
      api.history({
        databaseId,
        direction,
        expectedRevision: ready(api.snapshot(databaseId)).revision,
      });

    try {
      const initial = ready(api.snapshot(databaseId));
      const widgetProperties = rowOf(initial, widgetId).properties as Record<string, unknown>;
      expect(Object.hasOwn(widgetProperties, '__proto__')).toBe(true);
      expect(widgetProperties.__proto__).toBe(true);
      expect(Object.hasOwn(rowOf(initial, nullId).properties, '__proto__')).toBe(true);
      expect(rowOf(initial, nullId).properties.__proto__).toBeNull();
      expect(Object.hasOwn(rowOf(initial, missingId).properties, '__proto__')).toBe(false);
      expect(bridge.applyCount).toBe(0);

      expect(patchCheckbox(widgetId, false)).toMatchObject({ status: 'staged' });
      expect(rowOf(ready(api.snapshot(databaseId)), widgetId).properties.__proto__).toBe(false);
      await flushAt('Inventory/Widget.md');
      expect(await bridge.readText('Inventory/Widget.md')).toContain('Flag: false');

      expect(history('undo')).toMatchObject({ status: 'staged' });
      expect(rowOf(ready(api.snapshot(databaseId)), widgetId).properties.__proto__).toBe(true);
      await flushAt('Inventory/Widget.md');
      expect(await bridge.readText('Inventory/Widget.md')).toContain('Flag: true');
      expect(history('redo')).toMatchObject({ status: 'staged' });
      expect(rowOf(ready(api.snapshot(databaseId)), widgetId).properties.__proto__).toBe(false);
      await flushAt('Inventory/Widget.md');
      expect(await bridge.readText('Inventory/Widget.md')).toContain('Flag: false');

      expect(patchCheckbox(nullId, true)).toMatchObject({ status: 'staged' });
      await flushAt('Inventory/Null checkbox.md');
      expect(history('undo')).toMatchObject({ status: 'staged' });
      expect(Object.hasOwn(rowOf(ready(api.snapshot(databaseId)), nullId).properties, '__proto__')).toBe(
        true,
      );
      expect(rowOf(ready(api.snapshot(databaseId)), nullId).properties.__proto__).toBeNull();
      await flushAt('Inventory/Null checkbox.md');
      expect(await bridge.readText('Inventory/Null checkbox.md')).toContain('Flag: null');
      expect(history('redo')).toMatchObject({ status: 'staged' });
      await flushAt('Inventory/Null checkbox.md');

      expect(patchCheckbox(missingId, false)).toMatchObject({ status: 'staged' });
      await flushAt('Inventory/Missing checkbox.md');
      expect(history('undo')).toMatchObject({ status: 'staged' });
      expect(Object.hasOwn(rowOf(ready(api.snapshot(databaseId)), missingId).properties, '__proto__')).toBe(
        false,
      );
      await flushAt('Inventory/Missing checkbox.md');
      expect(await bridge.readText('Inventory/Missing checkbox.md')).not.toContain('Flag:');
      expect(history('redo')).toMatchObject({ status: 'staged' });
      await flushAt('Inventory/Missing checkbox.md');

      expect(new Set(rowWrites())).toEqual(
        new Set(['Inventory/Widget.md', 'Inventory/Null checkbox.md', 'Inventory/Missing checkbox.md']),
      );
      active = false;
      scope.dispose();
      handle.cleanup();
      await session.close();

      session = await open(bridge);
      handle = apiFor(session);
      const reopenedDatabaseId = idAt(session, 'Inventory.md');
      const reopenedWidgetId = idAt(session, 'Inventory/Widget.md');
      const reopenedNullId = idAt(session, 'Inventory/Null checkbox.md');
      const reopenedMissingId = idAt(session, 'Inventory/Missing checkbox.md');
      const reopened = ready(handle.api.snapshot(reopenedDatabaseId));
      expect((rowOf(reopened, reopenedWidgetId).properties as Record<string, unknown>).__proto__).toBe(false);
      expect(Object.hasOwn(rowOf(reopened, reopenedNullId).properties, '__proto__')).toBe(true);
      expect(rowOf(reopened, reopenedNullId).properties.__proto__).toBe(true);
      expect(Object.hasOwn(rowOf(reopened, reopenedMissingId).properties, '__proto__')).toBe(true);
      expect(rowOf(reopened, reopenedMissingId).properties.__proto__).toBe(false);
      expect(reopened.history).toEqual({ canUndo: false, canRedo: false });
    } finally {
      scope.dispose();
      handle.cleanup();
      await session.close();
      await rm(bridge.root, { recursive: true, force: true });
    }
  });

  it('reads only published boolean aliases without opening-time writes and guards unknown raw values', async () => {
    const aliases: Array<[string, string, boolean]> = [
      ['true-yaml', 'true', true],
      ['false-yaml', 'false', false],
      ['true-string', '"true"', true],
      ['true-yes', '" YES "', true],
      ['true-x', '"x"', true],
      ['true-one', '"1"', true],
      ['false-string', '"false"', false],
      ['false-no', '"no"', false],
      ['false-zero', '"0"', false],
    ];
    const aliasFiles = Object.fromEntries(
      aliases.map(([name, raw]) => [
        `Inventory/Legacy ${name}.md`,
        `---\nFlag: ${raw}\n---\nLegacy alias.\n`,
      ]),
    );
    const source = sourceFiles(NORMAL_ROW, aliasFiles);
    const originalAliases = Object.fromEntries(Object.entries(aliasFiles));
    const bridge = await makeVault(withDiskRegistry(source));
    const session = await open(bridge);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    try {
      const snapshot = ready(api.snapshot(databaseId));
      for (const [name, , expected] of aliases) {
        const rowId = idAt(session, `Inventory/Legacy ${name}.md`);
        expect(rowOf(snapshot, rowId).properties.flag).toBe(expected);
        expect(await bridge.readText(`Inventory/Legacy ${name}.md`)).toBe(
          originalAliases[`Inventory/Legacy ${name}.md`],
        );
      }
      expect(await api.flush(databaseId)).toMatchObject({ status: 'persisted' });
      expect(bridge.applyCount).toBe(0);
      expect(bridge.writtenPaths).toEqual([]);
    } finally {
      cleanup();
      await session.close();
      await rm(bridge.root, { recursive: true, force: true });
    }

    const unsafePath = 'Inventory/Unknown checkbox.md';
    const unsafeOriginal = `---\nFlag: maybe\n---\nUnknown scalar.\n`;
    const unsafeBridge = await makeVault(
      withDiskRegistry(sourceFiles(NORMAL_ROW, { [unsafePath]: unsafeOriginal })),
    );
    const unsafeSession = await open(unsafeBridge);
    const unsafeHandle = apiFor(unsafeSession);
    try {
      const rowId = idAt(unsafeSession, unsafePath);
      expect(unsafeSession.getState().pages[rowId]!.extra.Flag).toBe('maybe');
      expect(Object.hasOwn(unsafeSession.getState().pages[rowId]!.properties, 'flag')).toBe(false);
      expect(unsafeHandle.api.snapshot(idAt(unsafeSession, 'Inventory.md'))).toMatchObject({
        status: 'unsupported',
        diagnostic: { code: 'unrepresentable-cell' },
      });
      expect(
        unsafeHandle.api.patchCheckboxCell?.({
          databaseId: idAt(unsafeSession, 'Inventory.md'),
          rowId,
          propertyId: 'flag',
          value: false,
          expectedRevision: unsafeSession.pilotDataRevision(idAt(unsafeSession, 'Inventory.md')),
        }),
      ).toMatchObject({ status: 'error', code: 'unsupported' });
      expect(await unsafeHandle.api.flush(idAt(unsafeSession, 'Inventory.md'))).toMatchObject({
        status: 'error',
        code: 'unsupported',
      });
      expect(unsafeBridge.applyCount).toBe(0);
      expect(await unsafeBridge.readText(unsafePath)).toBe(unsafeOriginal);
    } finally {
      unsafeHandle.cleanup();
      await unsafeSession.close();
      await rm(unsafeBridge.root, { recursive: true, force: true });
    }
  });

  it('rejects non-boolean values, wrong property modes, accessor payloads, fences, and stale revisions', async () => {
    const bridge = await makeVault(withDiskRegistry(sourceFiles()));
    const session = await open(bridge);
    const databaseId = idAt(session, 'Inventory.md');
    const rowId = idAt(session, 'Inventory/Widget.md');
    let providerActive = true;
    let hostReadonly = false;
    const { api, cleanup } = apiFor(session, {
      isProviderActive: () => providerActive,
      isHostReadonly: () => hostReadonly,
    });
    let scopeActive = true;
    let editable = true;
    const scope = createProviderDataScope(api, databaseId, {
      isActive: () => scopeActive,
      editable: () => editable,
    });
    const rawPatch = api.patchCheckboxCell as unknown as (input: unknown) => unknown;
    const initial = ready(api.snapshot(databaseId));
    const diskBefore = await bridge.readText('Inventory/Widget.md');
    try {
      expect(api.patchCheckboxCell).toBeTypeOf('function');
      for (const value of [null, 'false', 'true', 0, 1, {}, []]) {
        expect(
          rawPatch({ databaseId, rowId, propertyId: 'flag', value, expectedRevision: initial.revision }),
        ).toMatchObject({
          status: 'error',
          code: 'invalid-value',
        });
        expect(
          (scope.api.patchCheckboxCell as unknown as (input: unknown) => unknown)({
            databaseId,
            rowId,
            propertyId: 'flag',
            value,
            expectedRevision: initial.revision,
          }),
        ).toMatchObject({ status: 'error', code: 'invalid-value' });
      }
      expect(
        rawPatch({
          databaseId,
          rowId,
          propertyId: 'quantity',
          value: false,
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({
        status: 'error',
        code: 'read-only',
      });
      expect(
        rawPatch({
          databaseId,
          rowId,
          propertyId: 'message',
          value: false,
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({
        status: 'error',
        code: 'read-only',
      });
      expect(
        api.patchTextCell?.({
          databaseId,
          rowId,
          propertyId: 'flag',
          value: null,
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({
        status: 'error',
        code: 'read-only',
      });
      expect(
        session.patchPilotDataCell({
          databaseId,
          rowId,
          propertyId: 'flag',
          value: null,
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ ok: false, code: 'invalid-value' });

      let accessorCalls = 0;
      const accessorPayload = Object.defineProperties(
        {},
        {
          databaseId: { enumerable: true, value: databaseId },
          rowId: { enumerable: true, value: rowId },
          propertyId: { enumerable: true, value: 'flag' },
          value: {
            enumerable: true,
            get: () => {
              accessorCalls += 1;
              return false;
            },
          },
          expectedRevision: { enumerable: true, value: initial.revision },
        },
      );
      expect(rawPatch(accessorPayload)).toMatchObject({ status: 'error', code: 'invalid-value' });
      expect(accessorCalls).toBe(0);

      editable = false;
      expect(
        scope.api.patchCheckboxCell?.({
          databaseId,
          rowId,
          propertyId: 'flag',
          value: false,
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({
        status: 'error',
        code: 'host-readonly',
      });
      editable = true;
      scopeActive = false;
      expect(
        scope.api.patchCheckboxCell?.({
          databaseId,
          rowId,
          propertyId: 'flag',
          value: false,
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({
        status: 'error',
        code: 'owner-inactive',
      });
      scopeActive = true;
      hostReadonly = true;
      expect(
        rawPatch({ databaseId, rowId, propertyId: 'flag', value: false, expectedRevision: initial.revision }),
      ).toMatchObject({
        status: 'error',
        code: 'host-readonly',
      });
      hostReadonly = false;
      providerActive = false;
      expect(
        rawPatch({ databaseId, rowId, propertyId: 'flag', value: false, expectedRevision: initial.revision }),
      ).toMatchObject({
        status: 'error',
        code: 'provider-inactive',
      });
      providerActive = true;
      const releaseFence = session.beginMutationFence();
      try {
        expect(
          rawPatch({
            databaseId,
            rowId,
            propertyId: 'flag',
            value: false,
            expectedRevision: initial.revision,
          }),
        ).toMatchObject({
          status: 'error',
          code: 'read-only',
        });
      } finally {
        releaseFence();
      }

      expect(
        scope.api.patchCheckboxCell?.({
          databaseId,
          rowId,
          propertyId: 'flag',
          value: false,
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({
        status: 'staged',
      });
      expect(
        rawPatch({ databaseId, rowId, propertyId: 'flag', value: true, expectedRevision: initial.revision }),
      ).toMatchObject({
        status: 'error',
        code: 'stale-revision',
      });
      expect(rowOf(ready(api.snapshot(databaseId)), rowId).properties.flag).toBe(false);
      expect(ready(api.snapshot(databaseId)).history).toEqual({ canUndo: true, canRedo: false });
      expect(await bridge.readText('Inventory/Widget.md')).toBe(diskBefore);
      expect(bridge.applyCount).toBe(0);
    } finally {
      scope.dispose();
      cleanup();
      await session.close();
      await rm(bridge.root, { recursive: true, force: true });
    }
  });

  it('removes an incompatible string tag and persists a boolean in the raw frontmatter', async () => {
    const row = `---
Message: "  opening  "
Quantity: 2
# Keep this comment beside the property.
fLaG: !!str yes # Checkbox annotation.
vendorNote: "keep this exact value" # Unknown property annotation.
---
Tagged checkbox row.
`;
    const bridge = await makeVault(withDiskRegistry(sourceFiles(row)));
    const session = await open(bridge);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const rowId = idAt(session, 'Inventory/Widget.md');
    try {
      const initial = ready(api.snapshot(databaseId));
      expect(rowOf(initial, rowId).properties.flag).toBe(true);
      expect(
        api.patchCheckboxCell?.({
          databaseId,
          rowId,
          propertyId: 'flag',
          value: false,
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'staged' });
      expect(await api.flush(databaseId)).toMatchObject({ status: 'persisted' });

      const written = await bridge.readText('Inventory/Widget.md');
      const raw = parse(splitFrontmatter(written!).yaml) as Record<string, unknown>;
      expect(raw.fLaG).toBe(false);
      expect(typeof raw.fLaG).toBe('boolean');
      expect(written).toContain('# Keep this comment beside the property.');
      expect(written).toContain('fLaG: false # Checkbox annotation.');
      expect(written).toContain('vendorNote: "keep this exact value" # Unknown property annotation.');
      expect(written).toContain('Message: "  opening  "');
    } finally {
      cleanup();
      await session.close();
      await rm(bridge.root, { recursive: true, force: true });
    }
  });

  it('preserves an unchanged schema property exact raw value during a checkbox write', async () => {
    const row = `---
Message: "  opening  "
Quantity: !!str 2
Flag: true
---
Tagged untouched schema value.
`;
    const bridge = await makeVault(withDiskRegistry(sourceFiles(row)));
    const session = await open(bridge);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const rowId = idAt(session, 'Inventory/Widget.md');
    try {
      const initial = ready(api.snapshot(databaseId));
      expect(rowOf(initial, rowId).properties.quantity).toBe(2);
      expect(
        api.patchCheckboxCell?.({
          databaseId,
          rowId,
          propertyId: 'flag',
          value: false,
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'staged' });
      expect(await api.flush(databaseId)).toMatchObject({ status: 'persisted' });

      const written = await bridge.readText('Inventory/Widget.md');
      const raw = parse(splitFrontmatter(written!).yaml) as Record<string, unknown>;
      expect(raw.Flag).toBe(false);
      expect(typeof raw.Flag).toBe('boolean');
      expect(raw.Quantity).toBe('2');
      expect(typeof raw.Quantity).toBe('string');
      expect(written).toContain('Quantity: !!str 2');
    } finally {
      cleanup();
      await session.close();
      await rm(bridge.root, { recursive: true, force: true });
    }
  });

  it('writes a checkbox in a flow-map row and leaves the other schema value unchanged', async () => {
    const row = `---
{Flag: true, Quantity: 2}
---
Flow-map checkbox row.
`;
    const bridge = await makeVault(withDiskRegistry(sourceFiles(row)));
    const session = await open(bridge);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const rowId = idAt(session, 'Inventory/Widget.md');
    try {
      const initial = ready(api.snapshot(databaseId));
      expect(rowOf(initial, rowId).properties.quantity).toBe(2);
      expect(
        api.patchCheckboxCell?.({
          databaseId,
          rowId,
          propertyId: 'flag',
          value: false,
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'staged' });
      expect(await api.flush(databaseId)).toMatchObject({ status: 'persisted' });

      const written = await bridge.readText('Inventory/Widget.md');
      const raw = parse(splitFrontmatter(written!).yaml) as Record<string, unknown>;
      expect(raw.Flag).toBe(false);
      expect(typeof raw.Flag).toBe('boolean');
      expect(raw.Quantity).toBe(2);
    } finally {
      cleanup();
      await session.close();
      await rm(bridge.root, { recursive: true, force: true });
    }
  });

  it.each([
    ['duplicate keys', `---\nFlag: !!str yes\nFlag: !!str no\n---\nDuplicate checkbox key.\n`],
    ['dependent alias', `---\nFlag: &checkbox !!str yes\nMirror: *checkbox\n---\nAliased checkbox key.\n`],
  ])('refuses an unsafe checkbox YAML update with %s before writing files', async (_name, row) => {
    const bridge = await makeVault(withDiskRegistry(sourceFiles(row)));
    const session = await open(bridge);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const rowId = idAt(session, 'Inventory/Widget.md');
    const original = await bridge.readText('Inventory/Widget.md');
    try {
      const initial = ready(api.snapshot(databaseId));
      const currentValue = rowOf(initial, rowId).properties.flag;
      expect(typeof currentValue).toBe('boolean');
      expect(
        api.patchCheckboxCell?.({
          databaseId,
          rowId,
          propertyId: 'flag',
          value: !currentValue,
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'staged' });

      expect(await api.flush(databaseId)).toMatchObject({
        status: 'error',
        code: 'save-failed',
        message: expect.stringContaining('cannot be changed without risking another value'),
      });
      expect(session.saveStatus.errorCode).toBe('unsafe-checkbox-frontmatter');
      expect(bridge.applyCount).toBe(0);
      expect(bridge.writtenPaths).toEqual([]);
      expect(await bridge.readText('Inventory/Widget.md')).toBe(original);
    } finally {
      cleanup();
      await session.close();
      await rm(bridge.root, { recursive: true, force: true });
    }
  });
});
