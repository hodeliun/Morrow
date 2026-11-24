import { describe, expect, it } from 'vitest';
import { encodePolarisDadosViewMarker } from '../core/polarisDadosView';
import type { PageId } from '../core/model';
import { createDataApi } from '../app/plugins/dataApi';
import { createLinkedViewApi } from '../app/plugins/linkedViewApi';
import { MemoryVault } from './memoryVault';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';

const SOURCE_ID = 'fence-source' as PageId;
const ROW_ID = 'fence-row' as PageId;
const NOTE_ID = 'fence-note' as PageId;
const VIEW_ID = 'fence-view';
const ROW_PATH = 'Fence source/Row.md';
const NOTE_PATH = 'Fence note.md';
const view = {
  version: 1 as const,
  viewId: VIEW_ID,
  sourceDatabaseId: SOURCE_ID,
  title: 'Before fence',
  columnOrder: ['quantity'],
  filter: null,
};

function syntheticVault(): MemoryVault {
  return new MemoryVault({
    'Fence source.md': `---
kind: database
polarisDados:
  version: 1
  provider: polaris-dados
database:
  properties:
    - id: quantity
      name: Quantity
      type: number
  views:
    - id: table
      name: Table
      type: table
---
# Fence source
`,
    [ROW_PATH]: `---
Quantity: 2
---
Synthetic row.
`,
    [NOTE_PATH]: `# Fence note

${encodePolarisDadosViewMarker(view)}
`,
    '.morrow/workspace.json': JSON.stringify({
      version: 1,
      pages: {
        'Fence source.md': { id: SOURCE_ID, created: 1, order: 0 },
        [ROW_PATH]: { id: ROW_ID, created: 2, order: 0 },
        [NOTE_PATH]: { id: NOTE_ID, created: 3, order: 1 },
      },
    }),
    '.morrow/recent.json': JSON.stringify({ version: 1, opened: {}, activity: {} }),
  });
}

async function openSession(vault: MemoryVault): Promise<WorkspaceSession> {
  let generatedId = 0;
  const opened = await WorkspaceSession.open(
    new VaultRepository(vault, () => `unexpected-fence-page-${++generatedId}`),
    { delayMs: 60_000 },
  );
  if (!opened.ok) throw new Error(opened.error);
  return opened.value;
}

function apisFor(session: WorkspaceSession) {
  let stopData = () => {};
  let stopView = () => {};
  const data = createDataApi({
    session,
    ownerIsActive: () => true,
    isProviderActive: () => true,
    isHostReadonly: () => false,
    registerCleanup: (cleanup) => (stopData = cleanup),
  });
  const linkedView = createLinkedViewApi({
    session,
    pageId: NOTE_ID,
    viewId: VIEW_ID,
    sourceDatabaseId: SOURCE_ID,
    mountGeneration: 'fence-independent-test',
    ownerIsActive: () => true,
    isMountGenerationActive: () => true,
    isHostReadonly: () => false,
    registerCleanup: (cleanup) => (stopView = cleanup),
  });
  return {
    data,
    linkedView,
    cleanup: () => {
      stopData();
      stopView();
    },
  };
}

describe('independent mutation fence checks', () => {
  it('refuses direct, data, history, and configuration mutations without changing staged state', async () => {
    const vault = syntheticVault();
    const session = await openSession(vault);
    const { data, linkedView, cleanup } = apisFor(session);
    try {
      const initialData = data.snapshot(SOURCE_ID);
      if (initialData.status !== 'ready') throw new Error('Synthetic database did not load.');
      expect(
        data.patchCell({
          databaseId: SOURCE_ID,
          rowId: ROW_ID,
          propertyId: 'quantity',
          value: 3,
          expectedRevision: initialData.revision,
        }).status,
      ).toBe('staged');

      const initialView = linkedView.snapshot();
      if (initialView.status !== 'ready') throw new Error('Synthetic linked view did not load.');
      expect(
        linkedView.patchConfig({
          patch: { title: 'Accepted before fence' },
          expectedRevision: initialView.revision,
        }).status,
      ).toBe('staged');

      const beforeFenceState = structuredClone(session.getState());
      const beforeFenceData = data.snapshot(SOURCE_ID);
      const beforeFenceView = linkedView.snapshot();
      const beforeFenceQueue = { ...session.saveStatus };
      const beforeFencePending = session.queue.hasPending();
      const beforeFenceRowDirty = session.queue.isDirty(ROW_ID);
      const beforeFenceNoteDirty = session.queue.isDirty(NOTE_ID);
      expect(beforeFencePending).toBe(true);
      expect(beforeFenceRowDirty).toBe(true);
      expect(beforeFenceNoteDirty).toBe(true);

      const release = session.beginMutationFence();
      try {
        expect(session.isMutationFenced).toBe(true);
        expect(
          session.execute({
            type: 'page.rename',
            id: NOTE_ID,
            title: 'Rejected direct rename',
            now: 5,
          }),
        ).toMatchObject({ ok: false });
        expect(
          session.executeAll([
            { type: 'page.setFavorite', id: NOTE_ID, favorite: true },
            { type: 'page.rename', id: NOTE_ID, title: 'Rejected batch rename', now: 6 },
          ]),
        ).toMatchObject({ ok: false });

        expect(
          data.patchCell({
            databaseId: SOURCE_ID,
            rowId: ROW_ID,
            propertyId: 'quantity',
            value: 4,
            expectedRevision: beforeFenceData.revision,
          }),
        ).toMatchObject({ status: 'error', code: 'read-only' });
        expect(
          data.history({
            databaseId: SOURCE_ID,
            direction: 'undo',
            expectedRevision: beforeFenceData.revision,
          }),
        ).toMatchObject({ status: 'error', code: 'read-only' });
        expect(
          session.patchPilotDataCell({
            databaseId: SOURCE_ID,
            rowId: ROW_ID,
            propertyId: 'quantity',
            value: 5,
            expectedRevision: beforeFenceData.revision,
          }),
        ).toMatchObject({ ok: false, code: 'read-only' });
        expect(
          session.pilotDataHistoryChange({
            databaseId: SOURCE_ID,
            direction: 'undo',
            expectedRevision: beforeFenceData.revision,
          }),
        ).toMatchObject({ ok: false, code: 'read-only' });

        expect(
          linkedView.patchConfig({
            patch: { title: 'Rejected config' },
            expectedRevision: beforeFenceView.revision,
          }),
        ).toMatchObject({ status: 'error', code: 'read-only' });
        expect(
          linkedView.history({
            direction: 'undo',
            expectedRevision: beforeFenceView.revision,
          }),
        ).toMatchObject({ status: 'error', code: 'read-only' });

        expect(session.getState()).toEqual(beforeFenceState);
        expect(data.snapshot(SOURCE_ID)).toMatchObject({
          status: 'ready',
          revision: beforeFenceData.revision,
          history: beforeFenceData.status === 'ready' ? beforeFenceData.history : undefined,
        });
        expect(linkedView.snapshot()).toMatchObject({
          status: 'ready',
          revision: beforeFenceView.revision,
          config: beforeFenceView.status === 'ready' ? beforeFenceView.config : undefined,
          history: beforeFenceView.status === 'ready' ? beforeFenceView.history : undefined,
        });
        expect(session.saveStatus).toEqual(beforeFenceQueue);
        expect(session.queue.hasPending()).toBe(beforeFencePending);
        expect(session.queue.isDirty(ROW_ID)).toBe(beforeFenceRowDirty);
        expect(session.queue.isDirty(NOTE_ID)).toBe(beforeFenceNoteDirty);

        expect(await session.flush()).toBe(true);
        expect(vault.text(ROW_PATH)).toContain('Quantity: 3');
        expect(vault.text(NOTE_PATH)).toContain(
          encodePolarisDadosViewMarker({ ...view, title: 'Accepted before fence' }),
        );
        expect(session.isMutationFenced).toBe(true);
      } finally {
        release();
      }
      expect(session.isMutationFenced).toBe(false);
    } finally {
      cleanup();
      await session.close();
    }
  });

  it('keeps overlapping leases, reentrant mutation, and throwing listeners contained', async () => {
    const session = await openSession(syntheticVault());
    try {
      const transitions: boolean[] = [];
      const refusedReentrant: boolean[] = [];
      const stopFirst = session.subscribeMutationFence(() => {
        transitions.push(session.isMutationFenced);
        if (session.isMutationFenced) {
          refusedReentrant.push(
            !session.execute({
              type: 'page.rename',
              id: NOTE_ID,
              title: 'Reentrant during fence notification',
              now: 10,
            }).ok,
          );
        }
      });
      const stopThrowing = session.subscribeMutationFence(() => {
        throw new Error('synthetic listener failure');
      });
      const releaseFirst = session.beginMutationFence();
      const releaseSecond = session.beginMutationFence();
      expect(session.isMutationFenced).toBe(true);
      releaseFirst();
      releaseFirst();
      expect(session.isMutationFenced).toBe(true);
      expect(
        session.execute({
          type: 'page.rename',
          id: NOTE_ID,
          title: 'Still fenced after stale release',
          now: 11,
        }),
      ).toMatchObject({ ok: false });
      releaseSecond();

      expect(session.isMutationFenced).toBe(false);
      expect(transitions).toEqual([true, false]);
      expect(refusedReentrant).toEqual([true]);
      expect(
        session.execute({
          type: 'page.rename',
          id: NOTE_ID,
          title: 'Allowed after final release',
          now: 12,
        }).ok,
      ).toBe(true);
      stopFirst();
      stopThrowing();
    } finally {
      await session.close();
    }
  });
});
