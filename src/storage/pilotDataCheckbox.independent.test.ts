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
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import type { VaultScan } from '../core/vault/load';
import type { VaultOp, VaultOpResult } from '../core/vault/plan';
import { createDataApi } from '../app/plugins/dataApi';
import type { DataApi, DataApiPatchResult, DataApiSnapshot } from '../app/plugins/dataApi';
import { createProviderDataScope } from '../app/plugins/providerDataScope';
import type { VaultBridge, VaultChange, VaultFileInfo } from './vaultBridge';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';

const DATABASE_PATH = 'Inventory.md';
const WIDGET_PATH = 'Inventory/Widget.md';
const NULL_PATH = 'Inventory/Null checkbox.md';
const MISSING_PATH = 'Inventory/Missing checkbox.md';

const DATABASE = `---
kind: database
polarisDados:
  version: 1
  provider: polaris-dados
database:
  properties:
    - id: flag
      name: Flag
      type: checkbox
    - id: quantity
      name: Quantity
      type: number
    - id: message
      name: Message
      type: text
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

const WIDGET = `---
Flag: !!str yes
Quantity: 2
Message: "  opening  "
vendorRecord:
  id: opaque-widget-7f21
  audit:
    source: synthetic
    tags: [retain, nested]
---
Synthetic widget row.
`;

class DiskVault implements VaultBridge {
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
    const names = await readdir(this.path(directory), { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      },
    );
    const files: VaultFileInfo[] = [];
    for (const entry of names) {
      if (!entry.isFile()) continue;
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      const info = await stat(this.path(path));
      files.push({ path, size: info.size, mtime: info.mtimeMs });
    }
    return files;
  }

  onChange(_listener: (changes: VaultChange[]) => void): () => void {
    return () => {};
  }

  fileUrl(): null {
    return null;
  }
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
  const root = await mkdtemp(join(tmpdir(), 'morrow-e003-checkbox-'));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }
  return new DiskVault(root);
}

async function open(bridge: VaultBridge): Promise<WorkspaceSession> {
  let nextId = 0;
  const result = await WorkspaceSession.open(new VaultRepository(bridge, () => `checkbox-${++nextId}`), {
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

function parsedRawFrontmatter(text: string): Record<string, unknown> {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error('Expected YAML frontmatter in the disk file.');
  const value: unknown = parseYaml(match[1]!, { uniqueKeys: false });
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a mapping in the disk frontmatter.');
  }
  return value as Record<string, unknown>;
}

function checkboxPatch(api: DataApi, databaseId: string, rowId: string, value: boolean) {
  if (!api.patchCheckboxCell) throw new Error('The DataApi does not expose checkbox edits.');
  return api.patchCheckboxCell({
    databaseId,
    rowId,
    propertyId: 'flag',
    value,
    expectedRevision: ready(api.snapshot(databaseId)).revision,
  });
}

async function flush(api: DataApi, databaseId: string): Promise<void> {
  expect(await api.flush(databaseId)).toMatchObject({ status: 'persisted' });
}

function coreFiles(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    [DATABASE_PATH]: DATABASE,
    [WIDGET_PATH]: WIDGET,
    [NULL_PATH]: `---\nFlag: null\n---\nExplicit null checkbox.\n`,
    [MISSING_PATH]: `---\nQuantity: 1\n---\nMissing checkbox.\n`,
    ...overrides,
  };
}

describe('independent Polaris Dados checkbox contract', () => {
  it('reads published aliases without opening-time writes and leaves unsupported raw values guarded', async () => {
    const aliases: Array<[string, string, boolean]> = [
      ['bool-true', 'true', true],
      ['bool-false', 'false', false],
      ['tagged-true', '!!str yes', true],
      ['tagged-false', '!!str no', false],
      ['quoted-one', '"1"', true],
      ['quoted-zero', '"0"', false],
      ['quoted-x', '"x"', true],
    ];
    const legacyFiles = Object.fromEntries(
      aliases.map(([name, raw]) => [
        `Inventory/Legacy ${name}.md`,
        `---\nFlag: ${raw}\n---\nLegacy checkbox alias.\n`,
      ]),
    );
    const source = withDiskRegistry(coreFiles(legacyFiles));
    const bridge = await makeVault(source);
    const session = await open(bridge);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, DATABASE_PATH);
    try {
      const snapshot = ready(api.snapshot(databaseId));
      for (const [name, , expected] of aliases) {
        const path = `Inventory/Legacy ${name}.md`;
        const rowId = idAt(session, path);
        expect(rowOf(snapshot, rowId).properties.flag).toBe(expected);
        expect(await bridge.readText(path)).toBe(source[path]);
      }
      expect(bridge.applyCount).toBe(0);
      expect(bridge.writtenPaths).toEqual([]);
    } finally {
      cleanup();
      await session.close();
      await rm(bridge.root, { recursive: true, force: true });
    }

    const unsafePath = 'Inventory/Unsupported checkbox.md';
    const unsafeRaw = `---\nFlag: !!str maybe\n---\nUnknown checkbox spelling.\n`;
    const unsafeBridge = await makeVault(withDiskRegistry(coreFiles({ [unsafePath]: unsafeRaw })));
    const unsafeSession = await open(unsafeBridge);
    const unsafeHandle = apiFor(unsafeSession);
    try {
      const unsafeDatabaseId = idAt(unsafeSession, DATABASE_PATH);
      const unsafeRowId = idAt(unsafeSession, unsafePath);
      expect(unsafeSession.getState().pages[unsafeRowId]!.extra.Flag).toBe('maybe');
      expect(unsafeHandle.api.snapshot(unsafeDatabaseId)).toMatchObject({
        status: 'unsupported',
        diagnostic: { code: 'unrepresentable-cell' },
      });
      expect(
        unsafeHandle.api.patchCheckboxCell?.({
          databaseId: unsafeDatabaseId,
          rowId: unsafeRowId,
          propertyId: 'flag',
          value: false,
          expectedRevision: unsafeSession.pilotDataRevision(unsafeDatabaseId),
        }),
      ).toMatchObject({ status: 'error', code: 'unsupported' });
      expect(unsafeBridge.applyCount).toBe(0);
      expect(await unsafeBridge.readText(unsafePath)).toBe(unsafeRaw);
      expect(parsedRawFrontmatter((await unsafeBridge.readText(unsafePath))!).Flag).toBe('maybe');
    } finally {
      unsafeHandle.cleanup();
      await unsafeSession.close();
      await rm(unsafeBridge.root, { recursive: true, force: true });
    }
  });

  it('writes actual YAML false and restores null versus absence through history, redo, and reopen', async () => {
    const bridge = await makeVault(withDiskRegistry(coreFiles()));
    let session = await open(bridge);
    let handle = apiFor(session);
    const databaseId = idAt(session, DATABASE_PATH);
    const widgetId = idAt(session, WIDGET_PATH);
    const nullId = idAt(session, NULL_PATH);
    const missingId = idAt(session, MISSING_PATH);
    const scope = createProviderDataScope(handle.api, databaseId, { isActive: () => true, editable: true });
    const api = scope.api;
    try {
      const initial = ready(api.snapshot(databaseId));
      expect(rowOf(initial, widgetId).properties.flag).toBe(true);
      expect(Object.hasOwn(rowOf(initial, nullId).properties, 'flag')).toBe(true);
      expect(rowOf(initial, nullId).properties.flag).toBeNull();
      expect(Object.hasOwn(rowOf(initial, missingId).properties, 'flag')).toBe(false);
      expect(bridge.applyCount).toBe(0);

      const originalWidget = await bridge.readText(WIDGET_PATH);
      expect(checkboxPatch(api, databaseId, widgetId, false)).toMatchObject({ status: 'staged' });
      expect(rowOf(ready(api.snapshot(databaseId)), widgetId).properties.flag).toBe(false);
      expect(await bridge.readText(WIDGET_PATH)).toBe(originalWidget);
      await flush(api, databaseId);
      const widgetDisk = (await bridge.readText(WIDGET_PATH))!;
      expect(parsedRawFrontmatter(widgetDisk).Flag).toBe(false);
      expect(typeof parsedRawFrontmatter(widgetDisk).Flag).toBe('boolean');

      expect(
        api.history({
          databaseId,
          direction: 'undo',
          expectedRevision: ready(api.snapshot(databaseId)).revision,
        }),
      ).toMatchObject({ status: 'staged' });
      expect(rowOf(ready(api.snapshot(databaseId)), widgetId).properties.flag).toBe(true);
      await flush(api, databaseId);
      expect(parsedRawFrontmatter((await bridge.readText(WIDGET_PATH))!).Flag).toBe(true);
      expect(
        api.history({
          databaseId,
          direction: 'redo',
          expectedRevision: ready(api.snapshot(databaseId)).revision,
        }),
      ).toMatchObject({ status: 'staged' });
      await flush(api, databaseId);
      expect(parsedRawFrontmatter((await bridge.readText(WIDGET_PATH))!).Flag).toBe(false);

      expect(checkboxPatch(api, databaseId, nullId, false)).toMatchObject({ status: 'staged' });
      await flush(api, databaseId);
      expect(rowOf(ready(api.snapshot(databaseId)), nullId).properties.flag).toBe(false);
      expect(
        api.history({
          databaseId,
          direction: 'undo',
          expectedRevision: ready(api.snapshot(databaseId)).revision,
        }),
      ).toMatchObject({ status: 'staged' });
      const nullAfterUndo = rowOf(ready(api.snapshot(databaseId)), nullId).properties;
      expect(Object.hasOwn(nullAfterUndo, 'flag')).toBe(true);
      expect(nullAfterUndo.flag).toBeNull();
      await flush(api, databaseId);
      expect(parsedRawFrontmatter((await bridge.readText(NULL_PATH))!).Flag).toBeNull();
      expect(
        api.history({
          databaseId,
          direction: 'redo',
          expectedRevision: ready(api.snapshot(databaseId)).revision,
        }),
      ).toMatchObject({ status: 'staged' });
      await flush(api, databaseId);

      expect(checkboxPatch(api, databaseId, missingId, false)).toMatchObject({ status: 'staged' });
      await flush(api, databaseId);
      expect(Object.hasOwn(rowOf(ready(api.snapshot(databaseId)), missingId).properties, 'flag')).toBe(true);
      expect(rowOf(ready(api.snapshot(databaseId)), missingId).properties.flag).toBe(false);
      expect(
        api.history({
          databaseId,
          direction: 'undo',
          expectedRevision: ready(api.snapshot(databaseId)).revision,
        }),
      ).toMatchObject({ status: 'staged' });
      const missingAfterUndo = rowOf(ready(api.snapshot(databaseId)), missingId).properties;
      expect(Object.hasOwn(missingAfterUndo, 'flag')).toBe(false);
      await flush(api, databaseId);
      expect(Object.hasOwn(parsedRawFrontmatter((await bridge.readText(MISSING_PATH))!), 'Flag')).toBe(false);
      expect(
        api.history({
          databaseId,
          direction: 'redo',
          expectedRevision: ready(api.snapshot(databaseId)).revision,
        }),
      ).toMatchObject({ status: 'staged' });
      await flush(api, databaseId);
      expect(parsedRawFrontmatter((await bridge.readText(MISSING_PATH))!).Flag).toBe(false);

      scope.dispose();
      handle.cleanup();
      await session.close();
      session = await open(bridge);
      handle = apiFor(session);
      const reopenedDatabaseId = idAt(session, DATABASE_PATH);
      const reopened = ready(handle.api.snapshot(reopenedDatabaseId));
      expect(rowOf(reopened, idAt(session, WIDGET_PATH)).properties.flag).toBe(false);
      expect(rowOf(reopened, idAt(session, NULL_PATH)).properties.flag).toBe(false);
      expect(rowOf(reopened, idAt(session, MISSING_PATH)).properties.flag).toBe(false);
      expect(reopened.history).toEqual({ canUndo: false, canRedo: false });
      for (const path of [WIDGET_PATH, NULL_PATH, MISSING_PATH]) {
        expect(typeof parsedRawFrontmatter((await bridge.readText(path))!).Flag).toBe('boolean');
        expect(parsedRawFrontmatter((await bridge.readText(path))!).Flag).toBe(false);
      }
    } finally {
      scope.dispose();
      handle.cleanup();
      await session.close();
      await rm(bridge.root, { recursive: true, force: true });
    }
  });

  it('rejects invalid checkbox inputs and wrong targets while preserving older optional scopes', async () => {
    const plainDatabase = `---\nkind: database\ndatabase:\n  properties:\n    - id: flag\n      name: Flag\n      type: checkbox\n  views: []\n---\n# Plain database\n`;
    const bridge = await makeVault(
      withDiskRegistry({
        ...coreFiles(),
        'Plain.md': plainDatabase,
        'Plain/Row.md': `---\nFlag: true\n---\nNot opted in.\n`,
      }),
    );
    const session = await open(bridge);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, DATABASE_PATH);
    const rowId = idAt(session, WIDGET_PATH);
    const revision = ready(api.snapshot(databaseId)).revision;
    const scoped = createProviderDataScope(api, databaseId, { isActive: () => true, editable: true });
    const rawPatch = scoped.api.patchCheckboxCell as unknown as (input: unknown) => DataApiPatchResult;
    const diskBefore = await bridge.readText(WIDGET_PATH);
    const before = ready(api.snapshot(databaseId));
    try {
      for (const value of [undefined, null, 'false', 'true', 0, 1, {}, []]) {
        expect(
          rawPatch({ databaseId, rowId, propertyId: 'flag', value, expectedRevision: revision }),
        ).toMatchObject({ status: 'error', code: 'invalid-value' });
      }
      expect(
        rawPatch({ databaseId, rowId, propertyId: 'quantity', value: false, expectedRevision: revision }),
      ).toMatchObject({ status: 'error', code: 'read-only' });
      expect(
        rawPatch({ databaseId, rowId, propertyId: 'message', value: false, expectedRevision: revision }),
      ).toMatchObject({ status: 'error', code: 'read-only' });

      const legacySource = { ...api, patchCheckboxCell: undefined } as unknown as DataApi;
      const legacyScope = createProviderDataScope(legacySource, databaseId, {
        isActive: () => true,
        editable: true,
      });
      expect(legacyScope.api.patchCheckboxCell).toBeUndefined();
      expect(legacyScope.api.patchCell).toBeTypeOf('function');
      legacyScope.dispose();

      const plainDatabaseId = idAt(session, 'Plain.md');
      const plainRowId = idAt(session, 'Plain/Row.md');
      const plainSnapshot = api.snapshot(plainDatabaseId);
      expect(plainSnapshot.status).toBe('missing');
      expect(
        api.patchCheckboxCell?.({
          databaseId: plainDatabaseId,
          rowId: plainRowId,
          propertyId: 'flag',
          value: false,
          expectedRevision: plainSnapshot.revision,
        }),
      ).toMatchObject({ status: 'error', code: 'not-opted-in' });

      expect(ready(api.snapshot(databaseId))).toEqual(before);
      expect(await bridge.readText(WIDGET_PATH)).toBe(diskBefore);
      expect(bridge.applyCount).toBe(0);
      expect(bridge.writtenPaths).toEqual([]);
    } finally {
      scoped.dispose();
      cleanup();
      await session.close();
      await rm(bridge.root, { recursive: true, force: true });
    }
  });

  it('enforces provider, scope, host-readonly, mutation-fence, stale-revision, and save-conflict checks', async () => {
    const bridge = await makeVault(withDiskRegistry(coreFiles()));
    const session = await open(bridge);
    const databaseId = idAt(session, DATABASE_PATH);
    const rowId = idAt(session, WIDGET_PATH);
    let providerActive = true;
    let hostReadonly = false;
    const { api, cleanup } = apiFor(session, {
      isProviderActive: () => providerActive,
      isHostReadonly: () => hostReadonly,
    });
    let scopeActive = true;
    let editable = true;
    const scoped = createProviderDataScope(api, databaseId, {
      isActive: () => scopeActive,
      editable: () => editable,
    });
    const original = await bridge.readText(WIDGET_PATH);
    try {
      const initial = ready(api.snapshot(databaseId));
      editable = false;
      expect(checkboxPatch(scoped.api, databaseId, rowId, false)).toMatchObject({
        status: 'error',
        code: 'host-readonly',
      });
      editable = true;
      scopeActive = false;
      expect(
        scoped.api.patchCheckboxCell?.({
          databaseId,
          rowId,
          propertyId: 'flag',
          value: false,
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'error', code: 'owner-inactive' });
      scopeActive = true;
      hostReadonly = true;
      expect(checkboxPatch(api, databaseId, rowId, false)).toMatchObject({
        status: 'error',
        code: 'host-readonly',
      });
      hostReadonly = false;
      providerActive = false;
      expect(checkboxPatch(api, databaseId, rowId, false)).toMatchObject({
        status: 'error',
        code: 'provider-inactive',
      });
      providerActive = true;

      const releaseFence = session.beginMutationFence();
      try {
        expect(checkboxPatch(api, databaseId, rowId, false)).toMatchObject({
          status: 'error',
          code: 'read-only',
        });
      } finally {
        releaseFence();
      }

      expect(checkboxPatch(scoped.api, databaseId, rowId, false)).toMatchObject({ status: 'staged' });
      expect(
        api.patchCheckboxCell?.({
          databaseId,
          rowId,
          propertyId: 'flag',
          value: true,
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'error', code: 'stale-revision' });
      expect(rowOf(ready(api.snapshot(databaseId)), rowId).properties.flag).toBe(false);
      expect(await bridge.readText(WIDGET_PATH)).toBe(original);
      await flush(scoped.api, databaseId);
      expect(parsedRawFrontmatter((await bridge.readText(WIDGET_PATH))!).Flag).toBe(false);
    } finally {
      scoped.dispose();
      cleanup();
      await session.close();
      await rm(bridge.root, { recursive: true, force: true });
    }

    const conflictBridge = await makeVault(withDiskRegistry(coreFiles()));
    const conflictSession = await open(conflictBridge);
    const conflictHandle = apiFor(conflictSession);
    const conflictDatabaseId = idAt(conflictSession, DATABASE_PATH);
    const conflictRowId = idAt(conflictSession, WIDGET_PATH);
    try {
      expect(checkboxPatch(conflictHandle.api, conflictDatabaseId, conflictRowId, false)).toMatchObject({
        status: 'staged',
      });
      const current = (await conflictBridge.readText(WIDGET_PATH))!;
      const external = current.replace('Message: "  opening  "', 'Message: external edit');
      expect(external).not.toBe(current);
      await writeFile(join(conflictBridge.root, ...WIDGET_PATH.split('/')), external, 'utf8');

      expect(await conflictHandle.api.flush(conflictDatabaseId)).toMatchObject({
        status: 'error',
        code: 'save-conflict',
      });
      expect(ready(conflictHandle.api.snapshot(conflictDatabaseId))).toMatchObject({
        readonly: true,
        diagnostic: { code: 'save-conflict' },
      });
      expect(
        rowOf(ready(conflictHandle.api.snapshot(conflictDatabaseId)), conflictRowId).properties.flag,
      ).toBe(false);
      expect(checkboxPatch(conflictHandle.api, conflictDatabaseId, conflictRowId, true)).toMatchObject({
        status: 'error',
        code: 'save-conflict',
      });
      expect((await conflictBridge.readText(WIDGET_PATH))!).toContain('Message: external edit');
      expect(parsedRawFrontmatter((await conflictBridge.readText(WIDGET_PATH))!).Flag).toBe('yes');
      expect(conflictBridge.writtenPaths).not.toContain(WIDGET_PATH);
    } finally {
      conflictHandle.cleanup();
      await conflictSession.close();
      await rm(conflictBridge.root, { recursive: true, force: true });
    }
  });
});
