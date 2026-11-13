import { describe, expect, it } from 'vitest';
import type { DocNode, PageId } from '../../core/model';
import { encodePolarisDadosViewMarker } from '../../core/polarisDadosView';
import type { PolarisDadosViewData } from '../../core/polarisDadosView';
import { createDataApi } from './dataApi';
import { createLinkedViewApi } from './linkedViewApi';
import type { LinkedViewApi, LinkedViewSnapshot } from './linkedViewApi';
import { E003_POLARIS_DADOS_FIXTURE } from '../../storage/fixtures/e003-polaris-dados';
import { MemoryVault } from '../../storage/memoryVault';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';

const NOTE_ID = 'linked-views-note' as PageId;
const SOURCE_ID = 'inventory-source' as PageId;
const ROW_ID = 'inventory-widget' as PageId;

function viewData(viewId: string): PolarisDadosViewData {
  return {
    version: 1,
    viewId,
    sourceDatabaseId: SOURCE_ID,
    title: `${viewId} title`,
    columnOrder: ['name', 'quantity', 'price', 'total'],
    filter: null,
  };
}

function files(): Record<string, string> {
  return {
    ...E003_POLARIS_DADOS_FIXTURE,
    'Views.md': [
      '# Linked views',
      '',
      'Text before.',
      '',
      encodePolarisDadosViewMarker(viewData('view-one')),
      '',
      'Text between.',
      '',
      encodePolarisDadosViewMarker(viewData('view-two')),
      '',
      'Text after.',
      '',
    ].join('\n'),
    '.morrow/workspace.json': JSON.stringify({
      version: 1,
      pages: {
        'Inventory.md': { id: SOURCE_ID, created: 1, order: 0 },
        'Inventory/Widget.md': { id: ROW_ID, created: 2, order: 0 },
        'Views.md': { id: NOTE_ID, created: 3, order: 1 },
      },
    }),
    '.morrow/recent.json': JSON.stringify({ version: 1, opened: {}, activity: {} }),
  };
}

async function openSession(vault: MemoryVault): Promise<WorkspaceSession> {
  let generatedId = 0;
  const result = await WorkspaceSession.open(new VaultRepository(vault, () => `unexpected-id-${++generatedId}`), { delayMs: 60_000 });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function linkedApi(session: WorkspaceSession, viewId: string): { api: LinkedViewApi; cleanup: () => void } {
  let cleanup = () => {};
  const api = createLinkedViewApi({
    session,
    pageId: NOTE_ID,
    viewId,
    sourceDatabaseId: SOURCE_ID,
    mountGeneration: `mount-${viewId}`,
    ownerIsActive: () => true,
    isMountGenerationActive: () => true,
    isHostReadonly: () => false,
    registerCleanup: (onCleanup) => { cleanup = onCleanup; },
  });
  return { api, cleanup: () => cleanup() };
}

function ready(snapshot: LinkedViewSnapshot): Extract<LinkedViewSnapshot, { status: 'ready' }> {
  if (snapshot.status !== 'ready') throw new Error(`Expected ready linked-view snapshot; got ${snapshot.status}.`);
  return snapshot;
}

function linkedNode(doc: DocNode, viewId: string): DocNode | undefined {
  return doc.content?.find((node) => node.type === 'polarisDadosView' && node.attrs?.viewId === viewId);
}

describe('LinkedViewApi v1', () => {
  it('keeps each view config and history separate and patches only its own marker attrs', async () => {
    const vault = new MemoryVault(files());
    const session = await openSession(vault);
    const first = linkedApi(session, 'view-one');
    const second = linkedApi(session, 'view-two');
    try {
      const initialFirst = ready(first.api.snapshot());
      const initialSecond = ready(second.api.snapshot());
      expect(first.api.version).toBe(1);
      expect(initialFirst.revision).not.toBe(initialSecond.revision);
      expect(initialFirst.sourceStatus.status).toBe('available');
      expect(Object.isFrozen(initialFirst.config)).toBe(true);
      expect(Object.isFrozen(initialFirst.config.columnOrder)).toBe(true);

      expect(first.api.patchConfig({
        patch: { title: 'Only first view', columnOrder: ['quantity'] },
        expectedRevision: initialFirst.revision,
      })).toMatchObject({ status: 'staged', pageId: NOTE_ID, viewId: 'view-one' });
      const changedFirst = ready(first.api.snapshot());
      expect(changedFirst).toMatchObject({
        config: { title: 'Only first view', columnOrder: ['quantity'] },
        history: { canUndo: true, canRedo: false },
      });
      expect(changedFirst.readonly).toBe(false);
      expect(ready(second.api.snapshot()).config.title).toBe(initialSecond.config.title);

      const note = session.getState().docs[NOTE_ID]!;
      expect(linkedNode(note, 'view-one')?.attrs).toMatchObject({
        version: 1,
        viewId: 'view-one',
        sourceDatabaseId: SOURCE_ID,
        title: 'Only first view',
        columnOrder: ['quantity'],
      });
      expect(linkedNode(note, 'view-two')?.attrs).toEqual(viewData('view-two'));

      expect(first.api.history({ direction: 'undo', expectedRevision: changedFirst.revision })).toMatchObject({
        status: 'staged',
        direction: 'undo',
      });
      const undone = ready(first.api.snapshot());
      expect(undone.config.title).toBe(initialFirst.config.title);
      expect(undone.history).toEqual({ canUndo: false, canRedo: true });
      expect(ready(second.api.snapshot()).history).toEqual({ canUndo: false, canRedo: false });

      expect(first.api.patchConfig({
        patch: { title: undone.config.title },
        expectedRevision: undone.revision,
      })).toMatchObject({ status: 'no-op' });
      expect(ready(first.api.snapshot()).history).toEqual({ canUndo: false, canRedo: true });
    } finally {
      first.cleanup();
      second.cleanup();
      await session.close();
    }
  });

  it('rejects malformed runtime patches without throwing or staging changes', async () => {
    const session = await openSession(new MemoryVault(files()));
    const view = linkedApi(session, 'view-one');
    try {
      const initial = ready(view.api.snapshot());
      for (const columnOrder of [null, 7, 'quantity,price']) {
        let result: ReturnType<LinkedViewApi['patchConfig']> | undefined;
        expect(() => {
          result = view.api.patchConfig({
            patch: { columnOrder } as unknown as Parameters<LinkedViewApi['patchConfig']>[0]['patch'],
            expectedRevision: initial.revision,
          });
        }).not.toThrow();
        expect(result).toMatchObject({ status: 'error', code: 'invalid-config' });
      }
      expect(ready(view.api.snapshot())).toMatchObject({
        revision: initial.revision,
        config: initial.config,
        history: { canUndo: false, canRedo: false },
      });
    } finally {
      view.cleanup();
      await session.close();
    }
  });

  it('does not report an outer stage as current when a subscriber stages a newer config', async () => {
    const session = await openSession(new MemoryVault(files()));
    const view = linkedApi(session, 'view-one');
    let nestedResult: ReturnType<LinkedViewApi['patchConfig']> | undefined;
    let triggered = false;
    const stop = view.api.subscribe((snapshot) => {
      if (triggered || snapshot.status !== 'ready' || snapshot.config.title !== 'Reentrant outer') return;
      triggered = true;
      nestedResult = view.api.patchConfig({
        patch: { title: 'Reentrant inner' },
        expectedRevision: snapshot.revision,
      });
    });
    try {
      const initial = ready(view.api.snapshot());
      const outerResult = view.api.patchConfig({
        patch: { title: 'Reentrant outer' },
        expectedRevision: initial.revision,
      });
      expect(nestedResult).toMatchObject({ status: 'staged' });
      expect(outerResult).toMatchObject({ status: 'error', code: 'stale-revision', staged: true });
      expect(ready(view.api.snapshot()).config.title).toBe('Reentrant inner');
      expect(await view.api.flush()).toMatchObject({ status: 'persisted' });
      expect(ready(view.api.snapshot()).history.canUndo).toBe(true);
    } finally {
      stop();
      view.cleanup();
      await session.close();
    }
  });

  it('keeps the config revision across text/data edits and makes a removed handle terminal', async () => {
    const vault = new MemoryVault(files());
    const session = await openSession(vault);
    const first = linkedApi(session, 'view-one');
    const data = createDataApi({
      session,
      ownerIsActive: () => true,
      isProviderActive: () => true,
      isHostReadonly: () => false,
      registerCleanup: () => {},
    });
    try {
      const initial = ready(first.api.snapshot());
      expect(first.api.patchConfig({ patch: { title: 'Local config' }, expectedRevision: initial.revision })).toMatchObject({
        status: 'staged',
      });
      const afterConfig = ready(first.api.snapshot());
      expect(afterConfig.history.canUndo).toBe(true);

      const note = session.getState().docs[NOTE_ID]!;
      const textEdit: DocNode = {
        ...note,
        content: [...(note.content ?? []), { type: 'paragraph', content: [{ type: 'text', text: 'adjacent edit' }] }],
      };
      expect(session.execute({ type: 'page.setDoc', id: NOTE_ID, doc: textEdit, now: Date.now() }).ok).toBe(true);
      expect(ready(first.api.snapshot()).revision).toBe(afterConfig.revision);
      expect(ready(first.api.snapshot()).history.canUndo).toBe(true);

      const dataSnapshot = data.snapshot(SOURCE_ID);
      if (dataSnapshot.status !== 'ready') throw new Error('Expected ready source data.');
      expect(data.patchCell({
        databaseId: SOURCE_ID,
        rowId: ROW_ID,
        propertyId: 'quantity',
        value: 3,
        expectedRevision: dataSnapshot.revision,
      }).status).toBe('staged');
      expect(ready(first.api.snapshot()).revision).toBe(afterConfig.revision);
      expect(ready(first.api.snapshot()).history.canUndo).toBe(true);

      const latest = session.getState().docs[NOTE_ID]!;
      const removed: DocNode = {
        ...latest,
        content: latest.content?.filter((node) => !(node.type === 'polarisDadosView' && node.attrs?.viewId === 'view-one')),
      };
      expect(session.execute({ type: 'page.setDoc', id: NOTE_ID, doc: removed, now: Date.now() }).ok).toBe(true);
      expect(first.api.snapshot().status).toBe('missing');
      expect(session.execute({
        type: 'page.setDoc',
        id: NOTE_ID,
        doc: latest,
        now: Date.now(),
      }).ok).toBe(true);
      expect(first.api.snapshot().status).toBe('missing');
      expect(first.api.patchConfig({ patch: { title: 'must stay terminal' }, expectedRevision: afterConfig.revision })).toMatchObject({
        status: 'error',
        code: 'missing',
      });
    } finally {
      first.cleanup();
      await session.close();
    }
  });
});
