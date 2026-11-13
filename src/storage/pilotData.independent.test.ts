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
import { describe, expect, it, vi } from 'vitest';
import type { VaultScan } from '../core/vault/load';
import type { VaultOp, VaultOpResult } from '../core/vault/plan';
import { createDataApi } from '../app/plugins/dataApi';
import type { DataApi, DataApiSnapshot } from '../app/plugins/dataApi';
import { getDatabaseProvider, registerDatabaseProvider } from '../app/plugins/providerRegistry';
import type { VaultBridge, VaultChange, VaultFileInfo } from './vaultBridge';
import { E003_POLARIS_DADOS_FIXTURE } from './fixtures/e003-polaris-dados';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';

class NodeFileVaultBridge implements VaultBridge {
  private readonly listeners = new Set<(changes: VaultChange[]) => void>();
  applyCount = 0;
  failNextApply: string | null = null;

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
    this.applyCount += 1;
    if (this.failNextApply !== null) {
      const message = this.failNextApply;
      this.failNextApply = null;
      return [{ ok: false, code: 'error', message }];
    }
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

function fixture(): Record<string, string> {
  return {
    ...E003_POLARIS_DADOS_FIXTURE,
    'Inventory/Widget.md': E003_POLARIS_DADOS_FIXTURE['Inventory/Widget.md']!.replace(
      'Price: 10',
      'Price: null',
    ),
    'Inventory/Missing price.md': `---
Name: Missing price
Quantity: 1
---
An omitted price differs from an explicit null.
`,
  };
}

async function makeVault(files: Record<string, string>): Promise<NodeFileVaultBridge> {
  const root = await mkdtemp(join(tmpdir(), 'morrow-e003-pilot-data-'));
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

async function fingerprint(bridge: NodeFileVaultBridge, path: string) {
  try {
    const absolute = join(bridge.root, ...path.split('/'));
    const [content, info] = await Promise.all([readFile(absolute), stat(absolute, { bigint: true })]);
    return {
      sha256: createHash('sha256').update(content).digest('hex'),
      mtimeNs: info.mtimeNs.toString(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function open(bridge: NodeFileVaultBridge, delayMs = 60_000): Promise<WorkspaceSession> {
  let nextId = 0;
  const result = await WorkspaceSession.open(new VaultRepository(bridge, () => `pilot-data-${++nextId}`), {
    delayMs,
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
    ownerIsActive?: () => boolean;
    isProviderActive?: (databaseId: string) => boolean;
    isHostReadonly?: () => boolean;
  } = {},
): { api: DataApi; cleanup: () => void } {
  let cleanup = () => {};
  const api = createDataApi({
    session,
    ownerIsActive: options.ownerIsActive ?? (() => true),
    isProviderActive: options.isProviderActive ?? (() => true),
    isHostReadonly: options.isHostReadonly ?? (() => false),
    registerCleanup: (onCleanup) => {
      cleanup = onCleanup;
    },
  });
  return { api, cleanup: () => cleanup() };
}

function ready(snapshot: DataApiSnapshot) {
  if (snapshot.status !== 'ready') throw new Error(`Expected ready snapshot, got ${snapshot.status}.`);
  return snapshot;
}

describe('independent Polaris Dados API verification over real temporary files', () => {
  it('keeps null, missing, and zero distinct across a persisted edit and reopen', async () => {
    const bridge = await makeVault(fixture());
    let session: WorkspaceSession | undefined;
    let cleanup = () => {};
    try {
      session = await open(bridge);
      const handle = apiFor(session);
      cleanup = handle.cleanup;
      const databaseId = idAt(session, 'Inventory.md');
      const widgetId = idAt(session, 'Inventory/Widget.md');
      const missingPriceId = idAt(session, 'Inventory/Missing price.md');
      const initial = ready(handle.api.snapshot(databaseId));
      const widget = initial.rows.find((row) => row.id === widgetId)!;
      const missingPrice = initial.rows.find((row) => row.id === missingPriceId)!;

      expect(widget.properties.price).toBeNull();
      expect(Object.hasOwn(missingPrice.properties, 'price')).toBe(false);
      expect(widget.properties.quantity).toBe(2);
      expect(Object.isFrozen(initial)).toBe(true);
      expect(Object.isFrozen(initial.schema.properties)).toBe(true);
      expect(Object.isFrozen(widget.properties)).toBe(true);

      expect(
        handle.api.patchCell({
          databaseId,
          rowId: widgetId,
          propertyId: 'quantity',
          value: 0,
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'staged' });
      const staged = ready(handle.api.snapshot(databaseId));
      expect(staged.revision).not.toBe(initial.revision);
      expect(initial.rows.find((row) => row.id === widgetId)?.properties.quantity).toBe(2);
      expect(staged.rows.find((row) => row.id === widgetId)?.properties.quantity).toBe(0);
      expect(await handle.api.flush(databaseId)).toMatchObject({ status: 'persisted' });
      expect(await bridge.readText('Inventory/Widget.md')).toContain('Quantity: 0');
      expect(await bridge.readText('Inventory/Widget.md')).toContain('Price: null');

      cleanup();
      cleanup = () => {};
      await session.close();
      session = await open(bridge);
      const reopened = apiFor(session);
      cleanup = reopened.cleanup;
      const afterRestart = ready(reopened.api.snapshot(idAt(session, 'Inventory.md')));
      const reopenedWidget = afterRestart.rows.find((row) => row.id === widgetId)!;
      const reopenedMissingPrice = afterRestart.rows.find((row) => row.id === missingPriceId)!;
      expect(reopenedWidget.properties.quantity).toBe(0);
      expect(reopenedWidget.properties.price).toBeNull();
      expect(Object.hasOwn(reopenedMissingPrice.properties, 'price')).toBe(false);
      expect(afterRestart.revision).not.toBe(initial.revision);
    } finally {
      cleanup();
      if (session && !session.isClosed) await session.close();
      await dispose(bridge);
    }
  });

  it.each([
    [
      'property removal',
      (source: string) =>
        source.replace('    - id: quantity\n      name: Quantity\n      type: number\n', ''),
    ],
    ['property rename', (source: string) => source.replace('name: Quantity', 'name: Units')],
    ['database deletion', () => null],
  ])('refuses a staged row write when the source has an external %s', async (_label, transform) => {
    vi.useFakeTimers();
    const bridge = await makeVault(fixture());
    let session: WorkspaceSession | undefined;
    let cleanup = () => {};
    let stop = () => {};
    try {
      session = await open(bridge);
      const handle = apiFor(session);
      cleanup = handle.cleanup;
      const databaseId = idAt(session, 'Inventory.md');
      const rowId = idAt(session, 'Inventory/Widget.md');
      const events: DataApiSnapshot[] = [];
      stop = handle.api.subscribe(databaseId, (snapshot) => events.push(snapshot));
      const initial = ready(handle.api.snapshot(databaseId));
      expect(
        handle.api.patchCell({
          databaseId,
          rowId,
          propertyId: 'quantity',
          value: 3,
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'staged' });

      const rowBefore = await fingerprint(bridge, 'Inventory/Widget.md');
      const sourcePath = join(bridge.root, 'Inventory.md');
      const sourceBefore = await bridge.readText('Inventory.md');
      const externalSource = transform(sourceBefore!);
      if (externalSource === null) await unlink(sourcePath);
      else await writeFile(sourcePath, externalSource, 'utf8');
      const sourceAfter = await fingerprint(bridge, 'Inventory.md');
      const applyCountBeforeFlush = bridge.applyCount;

      expect(await handle.api.flush(databaseId)).toMatchObject({ status: 'error', code: 'save-conflict' });
      expect(bridge.applyCount).toBe(applyCountBeforeFlush + 1);
      expect(await fingerprint(bridge, 'Inventory.md')).toEqual(sourceAfter);
      expect(await fingerprint(bridge, 'Inventory/Widget.md')).toEqual(rowBefore);
      expect(session.getState().pages[rowId]!.properties.quantity).toBe(3);
      expect(session.saveStatus.errorCode).toBe('save-conflict');
      expect(ready(handle.api.snapshot(databaseId)).readonly).toBe(true);
      expect(events.some((snapshot) => snapshot.status === 'ready' && snapshot.readonly)).toBe(true);

      const appliesAfterConflict = bridge.applyCount;
      const ordinaryId = idAt(session, 'Archive.md');
      expect(session.execute({ type: 'page.setFavorite', id: ordinaryId, favorite: true }).ok).toBe(true);
      expect(session.queue.isDirty(ordinaryId)).toBe(true);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(bridge.applyCount).toBe(appliesAfterConflict);
      expect(
        handle.api.patchCell({
          databaseId,
          rowId,
          propertyId: 'quantity',
          value: 4,
          expectedRevision: ready(handle.api.snapshot(databaseId)).revision,
        }),
      ).toMatchObject({ status: 'error', code: 'save-conflict' });
    } finally {
      stop();
      cleanup();
      if (session && !session.isClosed) await session.close();
      await dispose(bridge);
      vi.useRealTimers();
    }
  });

  it('preserves an external row file and refuses automatic retry after a row conflict', async () => {
    vi.useFakeTimers();
    const bridge = await makeVault(fixture());
    let session: WorkspaceSession | undefined;
    let cleanup = () => {};
    try {
      session = await open(bridge);
      const handle = apiFor(session);
      cleanup = handle.cleanup;
      const databaseId = idAt(session, 'Inventory.md');
      const rowId = idAt(session, 'Inventory/Widget.md');
      const initial = ready(handle.api.snapshot(databaseId));
      expect(
        handle.api.patchCell({
          databaseId,
          rowId,
          propertyId: 'quantity',
          value: 3,
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'staged' });

      const externalRow = E003_POLARIS_DADOS_FIXTURE['Inventory/Widget.md']!.replace(
        'Price: 10',
        'Price: null',
      ).replace('Quantity: 2', 'Quantity: 4');
      await writeFile(join(bridge.root, 'Inventory/Widget.md'), externalRow, 'utf8');
      const externalFingerprint = await fingerprint(bridge, 'Inventory/Widget.md');
      const beforeFlush = bridge.applyCount;
      expect(await handle.api.flush(databaseId)).toMatchObject({ status: 'error', code: 'save-conflict' });
      expect(bridge.applyCount).toBe(beforeFlush + 1);
      expect(await bridge.readText('Inventory/Widget.md')).toBe(externalRow);
      expect(await fingerprint(bridge, 'Inventory/Widget.md')).toEqual(externalFingerprint);
      expect(session.getState().pages[rowId]!.properties.quantity).toBe(3);
      expect(ready(handle.api.snapshot(databaseId)).readonly).toBe(true);

      const appliesAfterConflict = bridge.applyCount;
      const ordinaryId = idAt(session, 'Archive.md');
      expect(session.execute({ type: 'page.setFavorite', id: ordinaryId, favorite: true }).ok).toBe(true);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(bridge.applyCount).toBe(appliesAfterConflict);
    } finally {
      cleanup();
      if (session && !session.isClosed) await session.close();
      await dispose(bridge);
      vi.useRealTimers();
    }
  });

  it('reflects provider and host read-only changes on each snapshot without reloading', async () => {
    const bridge = await makeVault(fixture());
    let session: WorkspaceSession | undefined;
    let cleanup = () => {};
    try {
      session = await open(bridge);
      let providerActive = true;
      let hostReadonly = false;
      const handle = apiFor(session, {
        isProviderActive: () => providerActive,
        isHostReadonly: () => hostReadonly,
      });
      cleanup = handle.cleanup;
      const databaseId = idAt(session, 'Inventory.md');
      const rowId = idAt(session, 'Inventory/Widget.md');
      const patch = (revision: string) =>
        handle.api.patchCell({
          databaseId,
          rowId,
          propertyId: 'quantity',
          value: 3,
          expectedRevision: revision,
        });

      const initial = ready(handle.api.snapshot(databaseId));
      expect(initial.readonly).toBe(false);
      providerActive = false;
      expect(ready(handle.api.snapshot(databaseId))).toMatchObject({
        readonly: true,
        diagnostic: { code: 'provider-inactive' },
      });
      expect(patch(initial.revision)).toMatchObject({ status: 'error', code: 'provider-inactive' });
      providerActive = true;
      hostReadonly = true;
      expect(ready(handle.api.snapshot(databaseId))).toMatchObject({
        readonly: true,
        diagnostic: { code: 'host-readonly' },
      });
      expect(patch(initial.revision)).toMatchObject({ status: 'error', code: 'host-readonly' });
      hostReadonly = false;
      expect(ready(handle.api.snapshot(databaseId)).readonly).toBe(false);
      expect(patch(initial.revision)).toMatchObject({ status: 'staged' });
    } finally {
      cleanup();
      if (session && !session.isClosed) await session.close();
      await dispose(bridge);
    }
  });

  it('delivers immediate and reentrant subscription snapshots, then stops after cleanup', async () => {
    const bridge = await makeVault(fixture());
    let session: WorkspaceSession | undefined;
    let cleanup = () => {};
    let unsubscribe = () => {};
    try {
      session = await open(bridge);
      const handle = apiFor(session);
      cleanup = handle.cleanup;
      const databaseId = idAt(session, 'Inventory.md');
      const rowId = idAt(session, 'Inventory/Widget.md');
      const events: DataApiSnapshot[] = [];
      let patchedInsideListener = false;
      unsubscribe = handle.api.subscribe(databaseId, (snapshot) => {
        events.push(snapshot);
        if (patchedInsideListener || snapshot.status !== 'ready') return;
        patchedInsideListener = true;
        expect(
          handle.api.patchCell({
            databaseId,
            rowId,
            propertyId: 'quantity',
            value: 0,
            expectedRevision: snapshot.revision,
          }),
        ).toMatchObject({ status: 'staged' });
      });

      expect(events).toHaveLength(2);
      expect(
        events.map((event) =>
          event.status === 'ready' ? event.rows.find((row) => row.id === rowId)?.properties.quantity : null,
        ),
      ).toEqual([2, 0]);
      expect(await handle.api.flush(databaseId)).toMatchObject({ status: 'persisted' });
      unsubscribe();
      const eventCount = events.length;
      const current = ready(handle.api.snapshot(databaseId));
      expect(
        handle.api.patchCell({
          databaseId,
          rowId,
          propertyId: 'quantity',
          value: 1,
          expectedRevision: current.revision,
        }),
      ).toMatchObject({ status: 'staged' });
      expect(await handle.api.flush(databaseId)).toMatchObject({ status: 'persisted' });
      expect(events).toHaveLength(eventCount);
    } finally {
      unsubscribe();
      cleanup();
      if (session && !session.isClosed) await session.close();
      await dispose(bridge);
    }
  });

  it('invalidates a closed owner across reopening the same database identity', async () => {
    const bridge = await makeVault(fixture());
    let first: WorkspaceSession | undefined;
    let second: WorkspaceSession | undefined;
    let firstCleanup = () => {};
    let secondCleanup = () => {};
    try {
      first = await open(bridge);
      await first.markInitialized();
      const firstDatabaseId = idAt(first, 'Inventory.md');
      const firstRowId = idAt(first, 'Inventory/Widget.md');
      const old = apiFor(first);
      firstCleanup = old.cleanup;
      const oldSnapshot = ready(old.api.snapshot(firstDatabaseId));
      firstCleanup();
      firstCleanup = () => {};
      await first.close();

      second = await open(bridge);
      const secondDatabaseId = idAt(second, 'Inventory.md');
      expect(secondDatabaseId).toBe(firstDatabaseId);
      const current = apiFor(second);
      secondCleanup = current.cleanup;
      expect(current.api.snapshot(secondDatabaseId).status).toBe('ready');
      expect(() => old.api.snapshot(firstDatabaseId)).toThrow(/no longer active/i);
      expect(
        old.api.patchCell({
          databaseId: firstDatabaseId,
          rowId: firstRowId,
          propertyId: 'quantity',
          value: 9,
          expectedRevision: oldSnapshot.revision,
        }),
      ).toMatchObject({ status: 'error', code: 'owner-inactive' });
    } finally {
      firstCleanup();
      secondCleanup();
      if (second && !second.isClosed) await second.close();
      if (first && !first.isClosed) await first.close();
      await dispose(bridge);
    }
  });

  it('never reports persisted for missing or unsupported databases or a failed write', async () => {
    const bridge = await makeVault(fixture());
    let session: WorkspaceSession | undefined;
    let cleanup = () => {};
    try {
      session = await open(bridge);
      const handle = apiFor(session);
      cleanup = handle.cleanup;
      const ordinaryId = idAt(session, 'Archive.md');
      expect(handle.api.snapshot('not-a-database').status).toBe('missing');
      expect(await handle.api.flush('not-a-database')).toMatchObject({
        status: 'error',
        code: 'not-opted-in',
      });
      expect(handle.api.snapshot(ordinaryId).status).toBe('missing');
      expect(await handle.api.flush(ordinaryId)).toMatchObject({ status: 'error', code: 'not-opted-in' });
    } finally {
      cleanup();
      if (session && !session.isClosed) await session.close();
      await dispose(bridge);
    }

    const malformed = fixture();
    malformed['Inventory/Widget.md'] = malformed['Inventory/Widget.md']!.replace(
      'Quantity: 2',
      'Quantity: many',
    );
    const unsupportedBridge = await makeVault(malformed);
    let unsupportedSession: WorkspaceSession | undefined;
    let unsupportedCleanup = () => {};
    try {
      unsupportedSession = await open(unsupportedBridge);
      const handle = apiFor(unsupportedSession);
      unsupportedCleanup = handle.cleanup;
      const databaseId = idAt(unsupportedSession, 'Inventory.md');
      const before = await fingerprint(unsupportedBridge, 'Inventory/Widget.md');
      const snapshot = handle.api.snapshot(databaseId);
      expect(snapshot.status).toBe('unsupported');
      if (snapshot.status === 'unsupported') {
        expect(Object.keys(snapshot).sort()).toEqual([
          'databaseId',
          'diagnostic',
          'revision',
          'status',
          'version',
        ]);
      }
      expect(await handle.api.flush(databaseId)).toMatchObject({ status: 'error', code: 'unsupported' });
      expect(await fingerprint(unsupportedBridge, 'Inventory/Widget.md')).toEqual(before);
    } finally {
      unsupportedCleanup();
      if (unsupportedSession && !unsupportedSession.isClosed) await unsupportedSession.close();
      await dispose(unsupportedBridge);
    }

    const failedBridge = await makeVault(fixture());
    let failedSession: WorkspaceSession | undefined;
    let failedCleanup = () => {};
    try {
      failedSession = await open(failedBridge);
      const handle = apiFor(failedSession);
      failedCleanup = handle.cleanup;
      const databaseId = idAt(failedSession, 'Inventory.md');
      const rowId = idAt(failedSession, 'Inventory/Widget.md');
      const initial = ready(handle.api.snapshot(databaseId));
      expect(
        handle.api.patchCell({
          databaseId,
          rowId,
          propertyId: 'quantity',
          value: 3,
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'staged' });
      failedBridge.failNextApply = 'synthetic disk write failure';
      expect(await handle.api.flush(databaseId)).toMatchObject({ status: 'error', code: 'save-failed' });
      expect(await failedBridge.readText('Inventory/Widget.md')).toBe(
        E003_POLARIS_DADOS_FIXTURE['Inventory/Widget.md']!.replace('Price: 10', 'Price: null'),
      );
      expect(failedSession.getState().pages[rowId]!.properties.quantity).toBe(3);
      expect(failedSession.saveStatus.state).toBe('error');
    } finally {
      failedCleanup();
      if (failedSession && !failedSession.isClosed) await failedSession.close();
      await dispose(failedBridge);
    }
  });

  it('keeps canvas database rows unsupported and leaves canvas and markdown bytes untouched', async () => {
    const canvasText = `${JSON.stringify(
      {
        nodes: [
          { id: 'board-note', type: 'text', x: 0, y: 0, width: 260, height: 80, text: 'Board content' },
        ],
        edges: [],
      },
      null,
      2,
    )}\n`;
    const bridge = await makeVault({
      ...fixture(),
      'Inventory/Board.canvas': canvasText,
    });
    const canvasBefore = await fingerprint(bridge, 'Inventory/Board.canvas');
    const rowBefore = await fingerprint(bridge, 'Inventory/Widget.md');
    let session: WorkspaceSession | undefined;
    let cleanup = () => {};
    try {
      session = await open(bridge);
      const handle = apiFor(session);
      cleanup = handle.cleanup;
      const databaseId = idAt(session, 'Inventory.md');
      const canvasId = idAt(session, 'Inventory/Board.canvas');
      const rowId = idAt(session, 'Inventory/Widget.md');
      expect(session.getState().pages[canvasId]?.kind).toBe('canvas');

      const applyCountBefore = bridge.applyCount;
      const initial = handle.api.snapshot(databaseId);
      expect(initial.status).toBe('unsupported');
      if (initial.status !== 'unsupported') {
        throw new Error('Expected the canvas row to make this database unsupported.');
      }
      expect(initial.diagnostic.code).toBe('unrepresentable-cell');
      expect(Object.keys(initial).sort()).toEqual([
        'databaseId',
        'diagnostic',
        'revision',
        'status',
        'version',
      ]);

      expect(
        handle.api.patchCell({
          databaseId,
          rowId: canvasId,
          propertyId: 'quantity',
          value: 3,
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'error', code: 'unsupported' });
      expect(
        handle.api.history({
          databaseId,
          direction: 'undo',
          expectedRevision: initial.revision,
        }),
      ).toMatchObject({ status: 'error', code: 'unsupported' });
      expect(await handle.api.flush(databaseId)).toMatchObject({ status: 'error', code: 'unsupported' });

      expect(bridge.applyCount).toBe(applyCountBefore);
      expect(session.queue.isDirty(canvasId)).toBe(false);
      expect(session.queue.isDirty(rowId)).toBe(false);
      expect(session.getState().pages[rowId]?.properties.quantity).toBe(2);
      expect(await fingerprint(bridge, 'Inventory/Board.canvas')).toEqual(canvasBefore);
      expect(await fingerprint(bridge, 'Inventory/Widget.md')).toEqual(rowBefore);

      cleanup();
      cleanup = () => {};
      await session.close();
      session = await open(bridge);
      const reopened = apiFor(session);
      cleanup = reopened.cleanup;
      const reopenedDatabaseId = idAt(session, 'Inventory.md');
      const reopenedCanvasId = idAt(session, 'Inventory/Board.canvas');
      expect(session.getState().pages[reopenedCanvasId]?.kind).toBe('canvas');
      expect(reopened.api.snapshot(reopenedDatabaseId).status).toBe('unsupported');
      expect(await fingerprint(bridge, 'Inventory/Board.canvas')).toEqual(canvasBefore);
      expect(await fingerprint(bridge, 'Inventory/Widget.md')).toEqual(rowBefore);
    } finally {
      cleanup();
      if (session && !session.isClosed) await session.close();
      await dispose(bridge);
    }
  });

  it(
    'does not make a plugin data handle writable when another owner registers the selected provider id',
    async () => {
      const bridge = await makeVault(fixture());
      let session: WorkspaceSession | undefined;
      let pluginCleanup = () => {};
      let foreignCleanup = () => {};
      let unregister = () => {};
      try {
        session = await open(bridge);
        let pluginData: DataApi | null = null;
        const plugin = apiFor(session, {
          isProviderActive: () => getDatabaseProvider('polaris-dados')?.data === pluginData,
        });
        pluginCleanup = plugin.cleanup;
        pluginData = plugin.api;
        const foreignOwner = apiFor(session);
        foreignCleanup = foreignOwner.cleanup;
        const databaseId = idAt(session, 'Inventory.md');
        const rowId = idAt(session, 'Inventory/Widget.md');

        unregister = registerDatabaseProvider('foreign-owner', () => true, foreignOwner.api, {
          id: 'polaris-dados',
          apiVersion: 1,
          mount: () => () => {},
        });
        expect(getDatabaseProvider('polaris-dados')?.owner).toBe('foreign-owner');
        expect(plugin.api.snapshot(databaseId)).toMatchObject({
          status: 'ready',
          readonly: true,
          diagnostic: { code: 'provider-inactive' },
        });
        const applyCountBefore = bridge.applyCount;
        expect(
          plugin.api.patchCell({
            databaseId,
            rowId,
            propertyId: 'quantity',
            value: 3,
            expectedRevision: ready(plugin.api.snapshot(databaseId)).revision,
          }),
        ).toMatchObject({ status: 'error', code: 'provider-inactive' });
        expect(session.queue.isDirty(rowId)).toBe(false);
        expect(bridge.applyCount).toBe(applyCountBefore);

        unregister();
        unregister = registerDatabaseProvider('matching-owner', () => true, plugin.api, {
          id: 'polaris-dados',
          apiVersion: 1,
          mount: () => () => {},
        });
        expect(plugin.api.snapshot(databaseId)).toMatchObject({
          status: 'ready',
          readonly: false,
          diagnostic: null,
        });
      } finally {
        unregister();
        pluginCleanup();
        foreignCleanup();
        if (session && !session.isClosed) await session.close();
        await dispose(bridge);
      }
    },
  );

  it('keeps ordinary unmarked database editing available through generic commands', async () => {
    const basic = { ...E003_POLARIS_DADOS_FIXTURE };
    basic['Inventory.md'] = basic['Inventory.md']!.replace(
      'polarisDados:\n  version: 1\n  provider: polaris-dados\n',
      '',
    );
    const bridge = await makeVault(basic);
    let session: WorkspaceSession | undefined;
    try {
      session = await open(bridge);
      const rowId = idAt(session, 'Inventory/Widget.md');
      expect(
        session.execute({ type: 'page.setProperties', id: rowId, values: { quantity: 3 }, now: 7 }).ok,
      ).toBe(true);
      expect(await session.flush()).toBe(true);
      expect(await bridge.readText('Inventory/Widget.md')).toContain('Quantity: 3');
    } finally {
      if (session && !session.isClosed) await session.close();
      await dispose(bridge);
    }
  });
});
