import { describe, expect, it, vi } from 'vitest';
import { encodePolarisDadosViewMarker } from '../core/polarisDadosView';
import type { PageId } from '../core/model';
import { createDataApi, type DataApi, type DataApiSnapshot } from '../app/plugins/dataApi';
import {
  createLinkedViewApi,
  type LinkedViewApi,
  type LinkedViewSnapshot,
} from '../app/plugins/linkedViewApi';
import { MemoryVault } from './memoryVault';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';

let fixtureClock = 0;

interface Fixture {
  readonly session: WorkspaceSession;
  readonly vault: MemoryVault;
  readonly sourceId: PageId;
  readonly rowId: PageId;
  readonly noteId: PageId;
  readonly viewId: string;
}

function fixtureFiles(
  ids: Pick<Fixture, 'sourceId' | 'rowId' | 'noteId' | 'viewId'>,
): Record<string, string> {
  const view = encodePolarisDadosViewMarker({
    version: 1,
    viewId: ids.viewId,
    sourceDatabaseId: ids.sourceId,
    title: 'Synthetic view',
    columnOrder: ['name', 'quantity', 'total'],
    filter: null,
  });
  return {
    'Inventory.md': `---
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
`,
    'Inventory/Widget.md': `---
Name: Widget
Quantity: 2
---
Synthetic row.
`,
    'Views.md': `# Views

${view}
`,
    '.morrow/workspace.json': JSON.stringify({
      version: 1,
      pages: {
        'Inventory.md': { id: ids.sourceId, created: 1, order: 0 },
        'Inventory/Widget.md': { id: ids.rowId, created: 2, order: 0 },
        'Views.md': { id: ids.noteId, created: 3, order: 1 },
      },
    }),
    '.morrow/recent.json': JSON.stringify({ version: 1, opened: {}, activity: {} }),
  };
}

async function openFixture(): Promise<Fixture> {
  const suffix = ++fixtureClock;
  const ids = {
    sourceId: `issue143-source-${suffix}` as PageId,
    rowId: `issue143-row-${suffix}` as PageId,
    noteId: `issue143-note-${suffix}` as PageId,
    viewId: `issue143-view-${suffix}`,
  };
  const vault = new MemoryVault(fixtureFiles(ids));
  let generated = 0;
  const opened = await WorkspaceSession.open(
    new VaultRepository(vault, () => `issue143-generated-${suffix}-${++generated}`),
    { delayMs: 60_000 },
  );
  if (!opened.ok) throw new Error(opened.error);
  return { ...ids, session: opened.value, vault };
}

function createData(session: WorkspaceSession): { api: DataApi; cleanup: () => void } {
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
  return { api, cleanup: () => cleanup() };
}

function createLinkedView(
  session: WorkspaceSession,
  ids: Pick<Fixture, 'sourceId' | 'noteId' | 'viewId'>,
): { api: LinkedViewApi; cleanup: () => void } {
  let cleanup = () => {};
  const api = createLinkedViewApi({
    session,
    pageId: ids.noteId,
    viewId: ids.viewId,
    sourceDatabaseId: ids.sourceId,
    mountGeneration: `issue143-mount-${ids.viewId}`,
    ownerIsActive: () => true,
    isMountGenerationActive: () => true,
    isHostReadonly: () => false,
    registerCleanup: (onCleanup) => {
      cleanup = onCleanup;
    },
  });
  return { api, cleanup: () => cleanup() };
}

function readyData(snapshot: DataApiSnapshot): Extract<DataApiSnapshot, { status: 'ready' }> {
  if (snapshot.status !== 'ready')
    throw new Error(`Expected ready data snapshot, received ${snapshot.status}.`);
  return snapshot;
}

function readyView(snapshot: LinkedViewSnapshot): Extract<LinkedViewSnapshot, { status: 'ready' }> {
  if (snapshot.status !== 'ready')
    throw new Error(`Expected ready view snapshot, received ${snapshot.status}.`);
  return snapshot;
}

describe('WorkspaceSession mutation fence', () => {
  it('refuses generic and structured data writes without changing state, revision, history, or queue', async () => {
    const { session, vault, sourceId, rowId, noteId } = await openFixture();
    const { api: data, cleanup } = createData(session);
    let releaseFence: (() => void) | undefined;
    try {
      const initial = readyData(data.snapshot(sourceId));
      expect(
        data.patchCell({
          databaseId: sourceId,
          rowId,
          propertyId: 'quantity',
          value: 3,
          expectedRevision: initial.revision,
        }).status,
      ).toBe('staged');
      expect(session.queue.isDirty(sourceId)).toBe(true);

      const before = session.getState();
      const revision = session.pilotDataRevision(sourceId);
      const history = session.pilotDataHistorySnapshot(sourceId);
      const apiBefore = readyData(data.snapshot(sourceId));
      const queueStatus = session.queue.status;
      const enqueue = vi.spyOn(session.queue, 'enqueue');
      releaseFence = session.beginMutationFence();

      expect(session.isMutationFenced).toBe(true);
      expect(session.execute({ type: 'page.rename', id: noteId, title: 'Rejected rename', now: 5 }).ok).toBe(
        false,
      );
      expect(
        session.executeAll([
          { type: 'page.setFavorite', id: noteId, favorite: true },
          { type: 'page.rename', id: noteId, title: 'Rejected batch rename', now: 6 },
        ]).ok,
      ).toBe(false);
      expect(
        session.patchPilotDataCell({
          databaseId: sourceId,
          rowId,
          propertyId: 'quantity',
          value: 4,
          expectedRevision: revision,
        }),
      ).toMatchObject({ ok: false, code: 'read-only' });
      expect(
        session.pilotDataHistoryChange({
          databaseId: sourceId,
          direction: 'undo',
          expectedRevision: revision,
        }),
      ).toMatchObject({ ok: false, code: 'read-only' });
      expect(
        data.patchCell({
          databaseId: sourceId,
          rowId,
          propertyId: 'quantity',
          value: 4,
          expectedRevision: revision,
        }),
      ).toMatchObject({ status: 'error', code: 'read-only' });
      expect(
        data.history({ databaseId: sourceId, direction: 'undo', expectedRevision: revision }),
      ).toMatchObject({
        status: 'error',
        code: 'read-only',
      });

      expect(session.getState()).toBe(before);
      expect(session.pilotDataRevision(sourceId)).toBe(revision);
      expect(session.pilotDataHistorySnapshot(sourceId)).toEqual(history);
      expect(readyData(data.snapshot(sourceId))).toMatchObject({
        revision: apiBefore.revision,
        history: apiBefore.history,
        rows: apiBefore.rows,
      });
      expect(session.queue.status).toEqual(queueStatus);
      expect(enqueue).not.toHaveBeenCalled();
      expect(await data.flush(sourceId)).toMatchObject({ status: 'persisted' });
      expect(session.getState()).toBe(before);
      expect(session.pilotDataRevision(sourceId)).toBe(revision);
      expect(session.pilotDataHistorySnapshot(sourceId)).toEqual(history);
      expect(session.queue.isDirty(sourceId)).toBe(false);
      expect(vault.text('Inventory/Widget.md')).toContain('Quantity: 3');

      releaseFence();
      releaseFence = undefined;
      expect(session.isMutationFenced).toBe(false);
      expect(session.execute({ type: 'page.rename', id: noteId, title: 'Retry rename', now: 7 }).ok).toBe(
        true,
      );
      expect(
        data.patchCell({
          databaseId: sourceId,
          rowId,
          propertyId: 'quantity',
          value: 4,
          expectedRevision: readyData(data.snapshot(sourceId)).revision,
        }).status,
      ).toBe('staged');
    } finally {
      releaseFence?.();
      cleanup();
      await session.close();
    }
  });

  it('refuses linked-view config changes and undo/redo without creating or consuming history', async () => {
    const fixture = await openFixture();
    const { session } = fixture;
    const { api, cleanup } = createLinkedView(session, fixture);
    let releaseFence: (() => void) | undefined;
    try {
      const initial = readyView(api.snapshot());
      expect(
        api.patchConfig({ patch: { title: 'First config' }, expectedRevision: initial.revision }).status,
      ).toBe('staged');
      let current = readyView(api.snapshot());
      expect(
        api.patchConfig({ patch: { title: 'Second config' }, expectedRevision: current.revision }).status,
      ).toBe('staged');
      current = readyView(api.snapshot());
      expect(api.history({ direction: 'undo', expectedRevision: current.revision }).status).toBe('staged');
      current = readyView(api.snapshot());
      expect(current.config.title).toBe('First config');
      expect(current.history).toEqual({ canUndo: true, canRedo: true });

      const before = session.getState();
      const queueStatus = session.queue.status;
      const enqueue = vi.spyOn(session.queue, 'enqueue');
      releaseFence = session.beginMutationFence();
      try {
        expect(
          api.patchConfig({ patch: { title: 'Rejected config' }, expectedRevision: current.revision }),
        ).toMatchObject({
          status: 'error',
          code: 'read-only',
        });
        expect(api.history({ direction: 'undo', expectedRevision: current.revision })).toMatchObject({
          status: 'error',
          code: 'read-only',
        });
        expect(api.history({ direction: 'redo', expectedRevision: current.revision })).toMatchObject({
          status: 'error',
          code: 'read-only',
        });
        expect(session.getState()).toBe(before);
        expect(session.queue.status).toEqual(queueStatus);
        expect(enqueue).not.toHaveBeenCalled();
        expect(readyView(api.snapshot())).toMatchObject({
          revision: current.revision,
          config: current.config,
          history: { canUndo: true, canRedo: true },
        });
      } finally {
        releaseFence();
        releaseFence = undefined;
      }

      expect(api.history({ direction: 'redo', expectedRevision: current.revision }).status).toBe('staged');
    } finally {
      releaseFence?.();
      cleanup();
      await session.close();
    }
  });

  it('uses unique idempotent leases and notifies safely around reentrant mutations', async () => {
    const { session, noteId } = await openFixture();
    let releaseOld: (() => void) | undefined;
    let releaseNew: (() => void) | undefined;
    let unsubscribeThrowing: (() => void) | undefined;
    let unsubscribeReentrant: (() => void) | undefined;
    let releaseAfterUnsubscribe: (() => void) | undefined;
    try {
      const notifications: boolean[] = [];
      const mutationResults: boolean[] = [];
      unsubscribeThrowing = session.subscribeMutationFence(() => {
        throw new Error('listener failure');
      });
      unsubscribeReentrant = session.subscribeMutationFence(() => {
        notifications.push(session.isMutationFenced);
        mutationResults.push(
          session.execute({
            type: 'page.rename',
            id: noteId,
            title: `Reentrant ${notifications.length}`,
            now: 8,
          }).ok,
        );
      });

      releaseOld = session.beginMutationFence();
      expect(session.isMutationFenced).toBe(true);
      expect(notifications).toEqual([true]);
      expect(mutationResults).toEqual([false]);
      releaseNew = session.beginMutationFence();

      releaseOld();
      releaseOld();
      expect(session.isMutationFenced).toBe(true);
      expect(notifications).toEqual([true]);

      releaseNew();
      expect(session.isMutationFenced).toBe(false);
      expect(notifications).toEqual([true, false]);
      expect(mutationResults).toEqual([false, true]);
      releaseNew();

      unsubscribeThrowing();
      unsubscribeThrowing();
      unsubscribeReentrant();
      unsubscribeReentrant();
      releaseAfterUnsubscribe = session.beginMutationFence();
      expect(notifications).toEqual([true, false]);
      releaseAfterUnsubscribe();
      releaseAfterUnsubscribe = undefined;
      expect(session.isMutationFenced).toBe(false);
    } finally {
      releaseOld?.();
      releaseNew?.();
      releaseAfterUnsubscribe?.();
      unsubscribeThrowing?.();
      unsubscribeReentrant?.();
      await session.close();
    }
  });
});
