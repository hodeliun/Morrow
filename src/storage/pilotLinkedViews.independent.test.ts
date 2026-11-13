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
import type { DocNode } from '../core/model';
import type { VaultScan } from '../core/vault/load';
import { encodePolarisDadosViewMarker } from '../core/polarisDadosView';
import type { PolarisDadosViewData } from '../core/polarisDadosView';
import type { VaultOp, VaultOpResult } from '../core/vault/plan';
import { createPilotLinkedViewBackend } from './pilotLinkedViews';
import { E003_POLARIS_DADOS_FIXTURE } from './fixtures/e003-polaris-dados';
import { WorkspaceSession } from './session';
import type { VaultBridge, VaultChange, VaultFileInfo } from './vaultBridge';
import { VaultRepository } from './vaultRepository';

const NOTE_PATH = 'Views.md';
const SOURCE_PATH = 'Inventory.md';
const ROW_PATH = 'Inventory/Widget.md';
const WORKSPACE_PATH = '.morrow/workspace.json';
const RECENT_PATH = '.morrow/recent.json';
const NOTE_ID = 'linked-views-note';
const SOURCE_ID = 'inventory-source';
const ROW_ID = 'inventory-widget';

interface VaultOptions {
  sourceDatabaseId?: string;
  firstView?: Partial<PolarisDadosViewData>;
  secondView?: Partial<PolarisDadosViewData>;
  noteText?: string;
}

function viewData(
  viewId: string,
  sourceDatabaseId: string,
  overrides: Partial<PolarisDadosViewData> = {},
): PolarisDadosViewData {
  return {
    version: 1,
    viewId,
    sourceDatabaseId,
    title: viewId,
    columnOrder: ['name', 'quantity'],
    filter: null,
    ...overrides,
  };
}

function fixtureFiles(options: VaultOptions = {}): Record<string, string> {
  const sourceDatabaseId = options.sourceDatabaseId ?? SOURCE_ID;
  const first = viewData('view-one', sourceDatabaseId, options.firstView);
  const second = viewData('view-two', sourceDatabaseId, options.secondView);
  const viewNote = [
    '# Linked views',
    '',
    'Text before the first view.',
    '',
    encodePolarisDadosViewMarker(first),
    '',
    'Text between the views.',
    '',
    encodePolarisDadosViewMarker(second),
    '',
    'Text after the second view.',
    '',
  ].join('\n');
  return {
    ...E003_POLARIS_DADOS_FIXTURE,
    [NOTE_PATH]: options.noteText ?? viewNote,
    [WORKSPACE_PATH]: JSON.stringify({
      version: 1,
      pages: {
        [SOURCE_PATH]: { id: SOURCE_ID, created: 1, order: 0 },
        [ROW_PATH]: { id: ROW_ID, created: 2, order: 0 },
        [NOTE_PATH]: { id: NOTE_ID, created: 3, order: 1 },
      },
    }),
    [RECENT_PATH]: JSON.stringify({ version: 1, opened: {}, activity: {} }),
  };
}

class NodeFileVaultBridge implements VaultBridge {
  private readonly listeners = new Set<(changes: VaultChange[]) => void>();
  failNextApply: string | null = null;
  beforeNextApply: (() => Promise<void>) | null = null;
  applyCount = 0;

  constructor(readonly root: string) {}

  absolute(path: string): string {
    return join(this.root, ...path.split('/'));
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
      registry: await json(WORKSPACE_PATH),
      recent: await json(RECENT_PATH),
    };
  }

  async apply(ops: VaultOp[]): Promise<VaultOpResult[]> {
    this.applyCount += 1;
    const beforeApply = this.beforeNextApply;
    this.beforeNextApply = null;
    if (beforeApply) await beforeApply();
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

  fileUrl(): null {
    return null;
  }
}

async function makeVault(options: VaultOptions = {}): Promise<NodeFileVaultBridge> {
  const root = await mkdtemp(join(tmpdir(), 'morrow-e003-linked-config-'));
  for (const [path, text] of Object.entries(fixtureFiles(options))) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, text, 'utf8');
  }
  return new NodeFileVaultBridge(root);
}

async function dispose(bridge: NodeFileVaultBridge): Promise<void> {
  await rm(bridge.root, { recursive: true, force: true });
}

async function open(bridge: NodeFileVaultBridge): Promise<WorkspaceSession> {
  let generatedId = 0;
  const result = await WorkspaceSession.open(
    new VaultRepository(bridge, () => `unexpected-generated-${++generatedId}`),
    { delayMs: 60_000 },
  );
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

async function fingerprints(bridge: NodeFileVaultBridge): Promise<Record<string, string>> {
  const paths: string[] = [];
  const visit = async (relative: string): Promise<void> => {
    for (const entry of await readdir(relative ? bridge.absolute(relative) : bridge.root, {
      withFileTypes: true,
    })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path);
      else paths.push(path);
    }
  };
  await visit('');
  const entries = await Promise.all(
    paths.sort().map(async (path) => {
      const [bytes, info] = await Promise.all([
        readFile(bridge.absolute(path)),
        stat(bridge.absolute(path), { bigint: true }),
      ]);
      const fingerprint = [
        createHash('sha256').update(bytes).digest('hex'),
        info.mtimeNs.toString(),
        info.size.toString(),
      ].join(':');
      return [path, fingerprint] as const;
    }),
  );
  return Object.fromEntries(entries);
}

function pageAt(session: WorkspaceSession, path: string) {
  const id = Object.keys(session.getState().pages).find((candidate) => session.pathOf(candidate) === path);
  if (!id) throw new Error(`No page loaded at ${path}.`);
  return id;
}

function linkedView(session: WorkspaceSession, viewId: string, sourceDatabaseId: string) {
  return createPilotLinkedViewBackend(session, {
    pageId: NOTE_ID,
    viewId,
    sourceDatabaseId,
  });
}

describe('independent linked-view config persistence checks on a temporary NodeFS vault', () => {
  it('opens two views over the real opted-in G01 source without writing files or synthesizing IDs', async () => {
    const bridge = await makeVault({ secondView: { columnOrder: ['price'] } });
    let session: WorkspaceSession | undefined;
    try {
      const before = await fingerprints(bridge);
      session = await open(bridge);
      const doc = session.getState().docs[NOTE_ID];
      const views = doc?.content?.filter((node) => node.type === 'polarisDadosView') ?? [];
      const viewOne = linkedView(session, 'view-one', SOURCE_ID).snapshot();
      const viewTwo = linkedView(session, 'view-two', SOURCE_ID).snapshot();

      expect(pageAt(session, NOTE_PATH)).toBe(NOTE_ID);
      expect(pageAt(session, SOURCE_PATH)).toBe(SOURCE_ID);
      expect(pageAt(session, ROW_PATH)).toBe(ROW_ID);
      expect(session.getState().pages[SOURCE_ID]?.kind).toBe('database');
      expect(session.getState().pages[ROW_ID]?.parentId).toBe(SOURCE_ID);
      expect(views).toHaveLength(2);
      expect(views.map((node) => node.attrs?.viewId)).toEqual(['view-one', 'view-two']);
      expect(views.map((node) => node.attrs?.sourceDatabaseId)).toEqual([SOURCE_ID, SOURCE_ID]);
      expect(viewOne).toMatchObject({ status: 'ready', sourceStatus: { status: 'available' }, readonly: false });
      expect(viewTwo).toMatchObject({ status: 'ready', sourceStatus: { status: 'available' }, readonly: false });
      if (viewOne.status === 'ready' && viewTwo.status === 'ready') {
        expect(viewOne.diagnostic).toBeNull();
        expect(viewTwo.diagnostic).toBeNull();
        expect(viewOne.config.columnOrder).toEqual(['name', 'quantity']);
        expect(viewTwo.config.columnOrder).toEqual(['price']);
      }
      expect(await session.flush()).toBe(true);
      await session.close();
      session = undefined;

      expect(await fingerprints(bridge)).toEqual(before);
    } finally {
      if (session && !session.isClosed) await session.close();
      await dispose(bridge);
    }
  });

  it('keeps both requested view IDs bound to a missing source as inert input without creating files', async () => {
    const bridge = await makeVault({ sourceDatabaseId: 'missing-database' });
    let session: WorkspaceSession | undefined;
    try {
      const before = await fingerprints(bridge);
      session = await open(bridge);
      const doc = session.getState().docs[NOTE_ID];
      const views = doc?.content?.filter((node) => node.type === 'polarisDadosView') ?? [];
      const backend = linkedView(session, 'view-one', 'missing-database');
      const snapshot = backend.snapshot();

      expect(views).toHaveLength(2);
      expect(views.map((node) => node.attrs?.viewId)).toEqual(['view-one', 'view-two']);
      expect(views.every((node) => node.attrs?.sourceDatabaseId === 'missing-database')).toBe(true);
      expect(Object.keys(session.getState().pages)).not.toContain('missing-database');
      expect(await bridge.exists('missing-database.md')).toBe(false);
      expect(snapshot).toMatchObject({
        status: 'ready',
        readonly: true,
        sourceStatus: { status: 'missing', diagnostic: { code: 'source-missing' } },
      });
      if (snapshot.status !== 'ready') throw new Error('The missing source should retain a ready linked-view config.');
      expect(backend.patchConfig({ patch: { title: 'must not stage' }, expectedRevision: snapshot.revision })).toMatchObject({
        status: 'error', code: 'read-only',
      });
      expect(backend.snapshot()).toMatchObject({ status: 'ready', config: { title: 'view-one' } });
      expect(await session.flush()).toBe(true);
      await session.close();
      session = undefined;

      expect(await fingerprints(bridge)).toEqual(before);
    } finally {
      if (session && !session.isClosed) await session.close();
      await dispose(bridge);
    }
  });

  it('persists config changes for one view only and reopens the current config with a fresh empty stack', async () => {
    const bridge = await makeVault();
    let session: WorkspaceSession | undefined;
    try {
      session = await open(bridge);
      const first = linkedView(session, 'view-one', SOURCE_ID);
      const second = linkedView(session, 'view-two', SOURCE_ID);
      const beforeFirst = first.snapshot();
      const beforeSecond = second.snapshot();
      if (beforeFirst.status !== 'ready' || beforeSecond.status !== 'ready')
        throw new Error('Both linked views should bind to the existing G01 database.');

      expect(first.patchConfig({
        patch: { title: 'Persisted primary', columnOrder: ['quantity', 'name'] },
        expectedRevision: beforeFirst.revision,
      })).toMatchObject({ status: 'staged', viewId: 'view-one' });
      expect(first.snapshot()).toMatchObject({
        status: 'ready',
        config: { title: 'Persisted primary', columnOrder: ['quantity', 'name'] },
        history: { canUndo: true, canRedo: false },
      });
      expect(second.snapshot()).toMatchObject({
        status: 'ready',
        config: { title: 'view-two', columnOrder: ['name', 'quantity'] },
        history: { canUndo: false, canRedo: false },
      });
      expect(await session.flush()).toBe(true);

      const sourceBefore = await fingerprints(bridge);
      await session.close();
      session = await open(bridge);
      const reopened = linkedView(session, 'view-one', SOURCE_ID).snapshot();
      const reopenedSecond = linkedView(session, 'view-two', SOURCE_ID).snapshot();
      expect(reopened).toMatchObject({
        status: 'ready',
        config: { title: 'Persisted primary', columnOrder: ['quantity', 'name'] },
        history: { canUndo: false, canRedo: false },
      });
      expect(reopenedSecond).toMatchObject({
        status: 'ready',
        config: { title: 'view-two' },
        history: { canUndo: false, canRedo: false },
      });
      expect(await bridge.readText(SOURCE_PATH)).toBe(E003_POLARIS_DADOS_FIXTURE[SOURCE_PATH]);
      expect(await bridge.readText(ROW_PATH)).toBe(E003_POLARIS_DADOS_FIXTURE[ROW_PATH]);
      expect(await session.flush()).toBe(true);
      expect(await fingerprints(bridge)).toEqual(sourceBefore);
    } finally {
      if (session && !session.isClosed) await session.close();
      await dispose(bridge);
    }
  });

  it('keeps missing column and filter references intact until an explicit repair and accepts a partial schema order', async () => {
    const bridge = await makeVault({
      firstView: {
        title: 'Needs repair',
        columnOrder: ['name', 'removed-property'],
        filter: { propertyId: 'retired-number', op: 'gte', value: 2 },
      },
    });
    let session: WorkspaceSession | undefined;
    try {
      session = await open(bridge);
      const backend = linkedView(session, 'view-one', SOURCE_ID);
      const before = backend.snapshot();
      expect(before).toMatchObject({
        status: 'ready',
        readonly: false,
        config: {
          title: 'Needs repair',
          columnOrder: ['name', 'removed-property'],
          filter: { propertyId: 'retired-number', op: 'gte', value: 2 },
        },
        diagnostic: { code: 'column-order-property-missing' },
      });
      if (before.status !== 'ready') throw new Error('The original config should remain readable for repair.');

      expect(backend.patchConfig({
        patch: { columnOrder: ['name', 'quantity'], filter: { propertyId: 'quantity', op: 'gte', value: 1 } },
        expectedRevision: before.revision,
      })).toMatchObject({ status: 'staged' });
      expect(backend.snapshot()).toMatchObject({
        status: 'ready',
        readonly: false,
        config: { columnOrder: ['name', 'quantity'], filter: { propertyId: 'quantity', op: 'gte', value: 1 } },
        diagnostic: null,
      });
    } finally {
      if (session && !session.isClosed) await session.close();
      await dispose(bridge);
    }
  });

  it('caps config history at ten steps and preserves distinct bindings containing NUL characters', async () => {
    const bridge = await makeVault();
    let session: WorkspaceSession | undefined;
    try {
      session = await open(bridge);
      const backend = linkedView(session, 'view-one', SOURCE_ID);
      const initial = backend.snapshot();
      if (initial.status !== 'ready') throw new Error('The first linked view should be ready.');
      expect(backend.patchConfig({ patch: { title: initial.config.title }, expectedRevision: initial.revision })).toMatchObject({
        status: 'no-op',
      });
      expect(backend.snapshot()).toMatchObject({ status: 'ready', history: { canUndo: false, canRedo: false } });

      for (let version = 1; version <= 12; version++) {
        const current = backend.snapshot();
        if (current.status !== 'ready') throw new Error('The linked view disappeared while adding history.');
        expect(backend.patchConfig({ patch: { title: `Version ${version}` }, expectedRevision: current.revision })).toMatchObject({
          status: 'staged',
        });
      }
      for (let step = 0; step < 10; step++) {
        const current = backend.snapshot();
        if (current.status !== 'ready') throw new Error('The linked view disappeared while undoing history.');
        expect(backend.history({ direction: 'undo', expectedRevision: current.revision })).toMatchObject({ status: 'staged' });
      }
      const afterTenUndos = backend.snapshot();
      expect(afterTenUndos).toMatchObject({
        status: 'ready',
        config: { title: 'Version 2' },
        history: { canUndo: false, canRedo: true },
      });

      const collisionBridge = await makeVault({
        firstView: { viewId: 'alpha\u0000beta', sourceDatabaseId: 'gamma', title: 'Tuple A' },
        secondView: { viewId: 'alpha', sourceDatabaseId: 'beta\u0000gamma', title: 'Tuple B' },
      });
      let collisionSession: WorkspaceSession | undefined;
      try {
        collisionSession = await open(collisionBridge);
        const tupleA = linkedView(collisionSession, 'alpha\u0000beta', 'gamma').snapshot();
        const tupleB = linkedView(collisionSession, 'alpha', 'beta\u0000gamma').snapshot();
        expect(tupleA).toMatchObject({ status: 'ready', viewId: 'alpha\u0000beta', sourceDatabaseId: 'gamma', config: { title: 'Tuple A' } });
        expect(tupleB).toMatchObject({ status: 'ready', viewId: 'alpha', sourceDatabaseId: 'beta\u0000gamma', config: { title: 'Tuple B' } });
        if (tupleA.status === 'ready' && tupleB.status === 'ready') expect(tupleA.revision).not.toBe(tupleB.revision);
      } finally {
        if (collisionSession && !collisionSession.isClosed) await collisionSession.close();
        await dispose(collisionBridge);
      }
    } finally {
      if (session && !session.isClosed) await session.close();
      await dispose(bridge);
    }
  });

  it('retains a local config draft and refuses automatic rebase when the linked-view note changes on disk', async () => {
    const bridge = await makeVault();
    let session: WorkspaceSession | undefined;
    try {
      session = await open(bridge);
      const backend = linkedView(session, 'view-one', SOURCE_ID);
      const before = backend.snapshot();
      if (before.status !== 'ready') throw new Error('The linked view should be ready before the conflict.');
      expect(backend.patchConfig({ patch: { title: 'Local staged title' }, expectedRevision: before.revision })).toMatchObject({
        status: 'staged',
      });

      const externalText = '# External note edit\n\nRepresentable outside content.\n';
      await writeFile(bridge.absolute(NOTE_PATH), externalText, 'utf8');
      expect(await session.flush()).toBe(false);
      expect(session.saveStatus.errorCode).toBe('save-conflict');
      expect(bridge.applyCount).toBe(1);
      expect(await bridge.readText(NOTE_PATH)).toBe(externalText);
      expect(backend.snapshot()).toMatchObject({ status: 'ready', config: { title: 'Local staged title' } });
      expect(await bridge.exists('missing-database.md')).toBe(false);
    } finally {
      if (session && !session.isClosed) await session.close();
      await dispose(bridge);
    }
  });

  it('still guards a staged removal when the raw baseline had a view, and leaves the external bytes intact', async () => {
    const bridge = await makeVault();
    let session: WorkspaceSession | undefined;
    try {
      session = await open(bridge);
      const backend = linkedView(session, 'view-one', SOURCE_ID);
      const before = backend.snapshot();
      if (before.status !== 'ready') throw new Error('The linked view should be ready before removal.');
      expect(backend.patchConfig({ patch: { title: 'Local title before removal' }, expectedRevision: before.revision })).toMatchObject({
        status: 'staged',
      });

      const staged = session.getState().docs[NOTE_ID]!;
      const withoutFirstView = {
        ...staged,
        content: staged.content?.filter((node) => !(node.type === 'polarisDadosView' && node.attrs?.viewId === 'view-one')),
      };
      expect(session.execute({ type: 'page.setDoc', id: NOTE_ID, doc: withoutFirstView, now: Date.now() + 1 }).ok).toBe(true);
      expect(backend.snapshot().status).toBe('missing');

      const externalText = '# External edit after local view removal\n\nStill representable.\n';
      await writeFile(bridge.absolute(NOTE_PATH), externalText, 'utf8');
      expect(await session.flush()).toBe(false);
      expect(session.saveStatus.errorCode).toBe('save-conflict');
      expect(await bridge.readText(NOTE_PATH)).toBe(externalText);
      expect(session.getState().docs[NOTE_ID]?.content?.some(
        (node) => node.type === 'polarisDadosView' && node.attrs?.viewId === 'view-one',
      )).toBe(false);
      expect(session.getState().docs[NOTE_ID]?.content?.some(
        (node) => node.type === 'polarisDadosView' && node.attrs?.viewId === 'view-two',
      )).toBe(true);
    } finally {
      if (session && !session.isClosed) await session.close();
      await dispose(bridge);
    }
  });

  it('refuses automatic rebase when a linked view first appears in the staged target during an external write race', async () => {
    const bridge = await makeVault({ noteText: '# Plain note\n\nText before insertion.\n' });
    let session: WorkspaceSession | undefined;
    try {
      session = await open(bridge);
      const current = session.getState().docs[NOTE_ID]!;
      const target: DocNode = {
        ...structuredClone(current),
        content: [
          ...(current.content ?? []),
          { type: 'polarisDadosView', attrs: viewData('new-view', SOURCE_ID) },
        ],
      };
      expect(session.execute({ type: 'page.setDoc', id: NOTE_ID, doc: target, now: Date.now() + 1 }).ok).toBe(true);

      const externalText = '# External note edit\n\nKeep these bytes intact.\n';
      bridge.beforeNextApply = async () => {
        await writeFile(bridge.absolute(NOTE_PATH), externalText, 'utf8');
        const live = session!.getState().docs[NOTE_ID]!;
        const withoutInsertedView: DocNode = {
          ...structuredClone(live),
          content: live.content?.filter((node) => !(node.type === 'polarisDadosView' && node.attrs?.viewId === 'new-view')),
        };
        expect(session!.execute({
          type: 'page.setDoc',
          id: NOTE_ID,
          doc: withoutInsertedView,
          now: Date.now() + 2,
        }).ok).toBe(true);
      };

      expect(await session.flush()).toBe(false);
      expect(session.saveStatus.errorCode).toBe('save-conflict');
      expect(await bridge.readText(NOTE_PATH)).toBe(externalText);
      expect(session.getState().docs[NOTE_ID]?.content?.some(
        (node) => node.type === 'polarisDadosView' && node.attrs?.viewId === 'new-view',
      )).toBe(false);
    } finally {
      if (session && !session.isClosed) await session.close();
      await dispose(bridge);
    }
  });

  it('does not treat a fenced literal marker as a linked view or apply the strict view conflict path', async () => {
    const literal = encodePolarisDadosViewMarker(viewData('view-one', SOURCE_ID));
    const noteText = '```md\n' + literal + '\n```\n\nA literal follows.\n';
    const bridge = await makeVault({ noteText });
    let session: WorkspaceSession | undefined;
    try {
      const before = await fingerprints(bridge);
      session = await open(bridge);
      const backend = linkedView(session, 'view-one', SOURCE_ID);
      expect(backend.snapshot().status).toBe('missing');
      expect(session.protectedReasons.has(NOTE_ID)).toBe(false);

      const localDoc = structuredClone(session.getState().docs[NOTE_ID]!);
      localDoc.content = [...(localDoc.content ?? []), { type: 'paragraph', content: [{ type: 'text', text: 'Local edit.' }] }];
      expect(session.execute({ type: 'page.setDoc', id: NOTE_ID, doc: localDoc, now: Date.now() + 1 }).ok).toBe(true);
      const externalText = noteText + '\nExternal ordinary edit.\n';
      await writeFile(bridge.absolute(NOTE_PATH), externalText, 'utf8');

      expect(await session.flush()).toBe(true);
      expect(session.saveStatus.errorCode).toBeNull();
      expect(await bridge.readText(NOTE_PATH)).toContain(literal);
      expect(await bridge.readText(NOTE_PATH)).toContain('Local edit.');
      expect(await fingerprints(bridge)).not.toEqual(before);
    } finally {
      if (session && !session.isClosed) await session.close();
      await dispose(bridge);
    }
  });
});
