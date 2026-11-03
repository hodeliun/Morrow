import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseDef, DocNode, PageId, ViewDef } from '../core/model';
import { MemoryVault } from './memoryVault';
import { VaultRepository } from './vaultRepository';
import { WorkspaceSession } from './session';
import type { ViewConfigChange, ViewHistoryIdentity } from './viewHistoryCapture';
import { commitEditors, registerCommit } from '../app/editor/commits';
import { PageEditorDocumentTracker } from '../app/editor/pageEditorCommit';

interface LinkedViewCommitReceipt {
  id: string;
  identity: Extract<ViewHistoryIdentity, { kind: 'linked' }>;
  change: ViewConfigChange;
  status: 'ready' | 'conflict' | 'unavailable' | 'busy';
  mirrored: boolean;
}

type LinkedViewCommitResult =
  | { ok: true; value: LinkedViewCommitReceipt }
  | { ok: false; error: string };

type LinkedViewCommit = (
  identity: Extract<ViewHistoryIdentity, { kind: 'linked' }>,
  expectedDoc: DocNode,
  nextDoc: DocNode,
  canEditNow: () => boolean,
  mirror: (receipt: LinkedViewCommitReceipt) => boolean,
) => LinkedViewCommitResult;

let repositorySequence = 0;
const openSessions: Array<{ session: WorkspaceSession; repository: VaultRepository }> = [];

afterEach(async () => {
  while (openSessions.length > 0) {
    const { session, repository } = openSessions.pop()!;
    await session.close();
    repository.close?.();
  }
});

function view(id: string, name: string, changes: Partial<ViewDef> = {}): ViewDef {
  return {
    id,
    name,
    type: 'table',
    filters: [],
    sorts: [],
    groupBy: null,
    dateProp: null,
    hidden: [],
    ...changes,
  };
}

function database(views: ViewDef[], properties: DatabaseDef['properties'] = []): DatabaseDef {
  return { properties, views };
}

const hostDoc = (viewDef: ViewDef, text = 'host text'): DocNode => ({
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text }] },
    {
      type: 'linkedDatabaseView',
      attrs: {
        hostPageId: 'host-page',
        sourceDatabaseId: 'database',
        blockId: 'linked-block',
        view: viewDef,
        viewRawState: { raw: { source: 'synthetic-fixture' } },
      },
    },
  ],
});

async function openWorkspace(
  initialDatabase = database([view('view-a', 'A'), view('view-b', 'B')], [
    { id: 'note', name: 'Note', type: 'text', options: [] },
  ]),
  rowCount = 1,
): Promise<WorkspaceSession> {
  const vault = new MemoryVault();
  const repository = new VaultRepository(vault, () => `view-history-${repositorySequence++}`);
  const opened = await WorkspaceSession.open(repository, { delayMs: 60_000 });
  if (!opened.ok) throw new Error(opened.error);
  const session = opened.value;
  openSessions.push({ session, repository });
  const seedCommands = [
    {
      type: 'page.create',
      id: 'database',
      parentId: null,
      title: 'Database',
      kind: 'database',
      database: initialDatabase,
      now: 1,
    },
    {
      type: 'page.create',
      id: 'row',
      parentId: 'database',
      title: 'Row',
      properties: { note: '' },
      now: 1,
    },
    { type: 'page.create', id: 'host-page', parentId: null, title: 'Host', now: 1 },
  ] as const;
  const seeded = session.executeHistoryReplay([
    ...seedCommands,
    ...Array.from({ length: Math.max(0, rowCount - 1) }, (_, index) => ({
      type: 'page.create' as const,
      id: `row-${index + 1}`,
      parentId: 'database',
      title: `Row ${index + 1}`,
      properties: { note: '' },
      now: 1,
    })),
  ]);
  if (!seeded.ok) throw new Error(seeded.error);
  const linkedSeed = session.executeHistoryReplay([{
    type: 'page.setDoc',
    id: 'host-page',
    doc: hostDoc(view('linked-view', 'Linked')),
    now: 2,
  }]);
  if (!linkedSeed.ok) throw new Error(linkedSeed.error);
  return session;
}

function primaryIdentity(viewId: string): { kind: 'database'; databaseId: PageId; viewId: string } {
  return { kind: 'database', databaseId: 'database', viewId };
}

describe('workspace contextual view history', () => {
  it('keeps view history session-only and does not write when the saved workspace is reopened', async () => {
    const vault = new MemoryVault();
    const firstRepository = new VaultRepository(vault, () => `view-history-reopen-${repositorySequence++}`);
    const firstOpened = await WorkspaceSession.open(firstRepository, { delayMs: 60_000 });
    if (!firstOpened.ok) throw new Error(firstOpened.error);
    const firstSession = firstOpened.value;
    openSessions.push({ session: firstSession, repository: firstRepository });
    const seeded = firstSession.executeHistoryReplay([{
      type: 'page.create',
      id: 'database',
      parentId: null,
      title: 'Database',
      kind: 'database',
      database: database([view('view-a', 'A')], [{ id: 'note', name: 'Note', type: 'text', options: [] }]),
      now: 1,
    }]);
    if (!seeded.ok) throw new Error(seeded.error);
    expect(await firstSession.flush()).toBe(true);

    const current = firstSession.getState().pages.database!.database!;
    expect(firstSession.execute({
      type: 'database.set',
      id: 'database',
      database: database([view('view-a', 'Renamed')], current.properties),
      now: 2,
    }).ok).toBe(true);
    expect(await firstSession.flush()).toBe(true);
    expect(firstSession.getViewHistory(primaryIdentity('view-a')).undo).not.toBeNull();
    const persistedFiles = [...vault.files.entries()];

    await firstSession.close();
    openSessions.pop();
    firstRepository.close?.();

    const reopenedRepository = new VaultRepository(vault, () => `view-history-reopen-next-${repositorySequence++}`);
    const reopenedResult = await WorkspaceSession.open(reopenedRepository, { delayMs: 60_000 });
    if (!reopenedResult.ok) throw new Error(reopenedResult.error);
    const reopened = reopenedResult.value;
    openSessions.push({ session: reopened, repository: reopenedRepository });
    expect(reopened.getViewHistory(primaryIdentity('view-a')).undo).toBeNull();
    expect(await reopened.flush()).toBe(true);
    expect([...vault.files.entries()]).toEqual(persistedFiles);
  });

  it('orders undo by applied events and redo by the latest undo transfer across data and view stores', async () => {
    const session = await openWorkspace();
    const identity = primaryIdentity('view-a');
    const changedDatabase = database([
      view('view-a', 'A renamed'),
      view('view-b', 'B'),
    ], session.getState().pages.database!.database!.properties);
    expect(session.execute({ type: 'database.set', id: 'database', database: changedDatabase, now: 3 }).ok).toBe(true);
    expect(session.execute({ type: 'page.setProperties', id: 'row', values: { note: 'data step' }, now: 4 }).ok).toBe(true);

    const newestUndo = session.getContextualHistory('database', identity).undo;
    expect(newestUndo?.owner.kind).toBe('data');
    expect((await session.stepContextualHistory('database', identity, 'undo')).status).toBe('applied');
    expect(session.getState().pages.row?.properties.note).toBe('');
    expect(session.getContextualHistory('database', identity).undo?.owner).toEqual({ kind: 'view', name: 'A renamed' });

    expect((await session.stepContextualHistory('database', identity, 'undo')).status).toBe('applied');
    expect(session.getState().pages.database?.database?.views[0]?.name).toBe('A');
    expect(session.getState().pages.database?.database?.views[1]?.name).toBe('B');

    expect(session.getContextualHistory('database', identity).redo?.owner).toEqual({ kind: 'view', name: 'A renamed' });
    expect((await session.stepContextualHistory('database', identity, 'redo')).status).toBe('applied');
    expect(session.getState().pages.database?.database?.views[0]?.name).toBe('A renamed');
    expect(session.getContextualHistory('database', identity).redo?.owner.kind).toBe('data');
    expect((await session.stepContextualHistory('database', identity, 'redo')).status).toBe('applied');
    expect(session.getState().pages.row?.properties.note).toBe('data step');
  });

  it('keeps contextual snapshot references stable until the selected history item changes', async () => {
    const session = await openWorkspace();
    const firstIdentity = primaryIdentity('view-a');
    const secondIdentity = primaryIdentity('view-b');
    const linkedIdentity = { kind: 'linked', hostPageId: 'host-page', blockId: 'linked-block' } as const;

    const emptyFirst = session.getContextualHistory('database', firstIdentity);
    const emptySecond = session.getContextualHistory('database', secondIdentity);
    const emptyLinked = session.getContextualHistory('database', linkedIdentity);
    expect(session.getContextualHistory('database', firstIdentity)).toBe(emptyFirst);
    expect(session.getContextualHistory('database', secondIdentity)).toBe(emptySecond);
    expect(session.getContextualHistory('database', linkedIdentity)).toBe(emptyLinked);

    expect(session.execute({
      type: 'page.setProperties',
      id: 'row',
      values: { note: 'data first' },
      now: 3,
    }).ok).toBe(true);
    const dataFirst = session.getContextualHistory('database', firstIdentity);
    const dataSecond = session.getContextualHistory('database', secondIdentity);
    expect(dataFirst).not.toBe(emptyFirst);
    expect(dataFirst.undo).toMatchObject({ owner: { kind: 'data' }, status: 'ready', enabled: true });
    expect(session.getContextualHistory('database', firstIdentity)).toBe(dataFirst);
    expect(dataSecond).not.toBe(emptySecond);
    expect(dataSecond.undo?.id).toBe(dataFirst.undo?.id);
    expect(session.getContextualHistory('database', secondIdentity)).toBe(dataSecond);
    const linkedData = session.getContextualHistory('database', linkedIdentity);
    expect(linkedData).not.toBe(emptyLinked);
    expect(linkedData.undo?.owner.kind).toBe('data');
    expect(session.getContextualHistory('database', linkedIdentity)).toBe(linkedData);

    const current = session.getState().pages.database!.database!;
    expect(session.execute({
      type: 'database.set',
      id: 'database',
      database: database([view('view-a', 'A renamed'), current.views[1]!], current.properties),
      now: 4,
    }).ok).toBe(true);
    const viewFirst = session.getContextualHistory('database', firstIdentity);
    expect(viewFirst).not.toBe(dataFirst);
    expect(viewFirst.undo).toMatchObject({ owner: { kind: 'view', name: 'A renamed' }, status: 'ready', enabled: true });
    expect(viewFirst.undo!.sequence).toBeGreaterThan(dataFirst.undo!.sequence);
    expect(session.getContextualHistory('database', firstIdentity)).toBe(viewFirst);
    expect(session.getContextualHistory('database', secondIdentity)).toBe(dataSecond);
    expect(session.getContextualHistory('database', linkedIdentity)).toBe(linkedData);

    expect((await session.stepContextualHistory('database', firstIdentity, 'undo')).status).toBe('applied');
    const afterUndoView = session.getContextualHistory('database', firstIdentity);
    expect(afterUndoView).not.toBe(viewFirst);
    expect(afterUndoView.undo?.owner.kind).toBe('data');
    expect(afterUndoView.redo?.owner).toEqual({ kind: 'view', name: 'A renamed' });
    expect(session.getContextualHistory('database', firstIdentity)).toBe(afterUndoView);

    expect((await session.stepContextualHistory('database', firstIdentity, 'redo')).status).toBe('applied');
    const afterRedoView = session.getContextualHistory('database', firstIdentity);
    expect(afterRedoView).not.toBe(afterUndoView);
    expect(afterRedoView.undo).toMatchObject({ owner: { kind: 'view', name: 'A renamed' }, status: 'ready', enabled: true });
    expect(afterRedoView.undo!.sequence).toBeGreaterThan(viewFirst.undo!.sequence);
    expect(session.getContextualHistory('database', firstIdentity)).toBe(afterRedoView);
  });

  it('changes cached contextual items when a shared view candidate becomes blocked', async () => {
    const session = await openWorkspace();
    const firstIdentity = primaryIdentity('view-a');
    const secondIdentity = primaryIdentity('view-b');
    const linkedIdentity = { kind: 'linked', hostPageId: 'host-page', blockId: 'linked-block' } as const;
    const linkedBefore = session.getContextualHistory('database', linkedIdentity);

    const current = session.getState().pages.database!.database!;
    expect(session.execute({
      type: 'database.set',
      id: 'database',
      database: database([view('view-a', 'A shared'), view('view-b', 'B shared')], current.properties),
      now: 3,
    }).ok).toBe(true);
    const sharedFirst = session.getContextualHistory('database', firstIdentity);
    const sharedSecond = session.getContextualHistory('database', secondIdentity);
    expect(sharedFirst.undo?.id).toBe(sharedSecond.undo?.id);
    expect(sharedFirst.undo).toMatchObject({ owner: { kind: 'view', name: 'A shared' }, status: 'ready', enabled: true });
    expect(session.getContextualHistory('database', firstIdentity)).toBe(sharedFirst);
    expect(session.getContextualHistory('database', secondIdentity)).toBe(sharedSecond);

    const afterShared = session.getState().pages.database!.database!;
    expect(session.execute({
      type: 'database.set',
      id: 'database',
      database: database([view('view-a', 'A latest'), afterShared.views[1]!], afterShared.properties),
      now: 4,
    }).ok).toBe(true);
    const latestFirst = session.getContextualHistory('database', firstIdentity);
    const blockedSecond = session.getContextualHistory('database', secondIdentity);
    expect(latestFirst).not.toBe(sharedFirst);
    expect(latestFirst.undo).toMatchObject({ owner: { kind: 'view', name: 'A latest' }, status: 'ready', enabled: true });
    expect(blockedSecond).not.toBe(sharedSecond);
    expect(blockedSecond.undo).toMatchObject({
      id: sharedSecond.undo!.id,
      owner: { kind: 'view', name: 'A shared' },
      status: 'blocked',
      enabled: false,
      sequence: sharedSecond.undo!.sequence,
    });
    expect(session.getContextualHistory('database', firstIdentity)).toBe(latestFirst);
    expect(session.getContextualHistory('database', secondIdentity)).toBe(blockedSecond);
    expect(session.getContextualHistory('database', linkedIdentity)).toBe(linkedBefore);
  });

  it('replays linked view attributes without replacing host text and rejects mixed edits', async () => {
    const session = await openWorkspace();
    const identity = { kind: 'linked', hostPageId: 'host-page', blockId: 'linked-block' } as const;
    const first = session.getState().docs['host-page']!;
    const changed = hostDoc(view('linked-view', 'Linked renamed'));
    expect(session.execute({ type: 'page.setDoc', id: 'host-page', doc: changed, now: 3 }).ok).toBe(true);
    const firstEntry = session.getContextualHistory('database', identity).undo;
    expect(firstEntry?.owner).toEqual({ kind: 'view', name: 'Linked renamed' });

    expect((await session.stepContextualHistory('database', identity, 'undo')).status).toBe('applied');
    expect(session.getState().docs['host-page']?.content?.[0]).toEqual(first.content?.[0]);
    expect((session.getState().docs['host-page']?.content?.[1]?.attrs?.view as ViewDef).name).toBe('Linked');
    expect((await session.stepContextualHistory('database', identity, 'redo')).status).toBe('applied');

    const mixed = hostDoc(view('linked-view', 'Mixed edit'), 'host text changed');
    expect(session.execute({ type: 'page.setDoc', id: 'host-page', doc: mixed, now: 4 }).ok).toBe(true);
    expect(session.getContextualHistory('database', identity).undo?.id).toBe(firstEntry?.id);
  });

  it('captures and replays a legacy linked config without persisting a hostPageId', async () => {
    const session = await openWorkspace();
    const identity = { kind: 'linked', hostPageId: 'host-page', blockId: 'linked-block' } as const;
    const before = structuredClone(session.getState().docs['host-page']!);
    const linked = before.content!.find((node) => node.type === 'linkedDatabaseView')!;
    delete linked.attrs!.hostPageId;
    const seeded = session.executeHistoryReplay([{ type: 'page.setDoc', id: 'host-page', doc: before, now: 2 }]);
    expect(seeded.ok).toBe(true);

    const after = structuredClone(before);
    const afterLinked = after.content!.find((node) => node.type === 'linkedDatabaseView')!;
    (afterLinked.attrs!.view as ViewDef).name = 'Legacy linked renamed';
    const execute = (session as unknown as { executeLinkedViewConfigChange: LinkedViewCommit })
      .executeLinkedViewConfigChange.bind(session);
    const result = execute(identity, before, after, () => true, () => true);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.status).toBe('ready');
    expect(session.getState().docs['host-page']?.content?.[1]?.attrs?.hostPageId).toBeUndefined();
    expect((await session.stepContextualHistory('database', identity, 'undo')).status).toBe('applied');
    expect((session.getState().docs['host-page']?.content?.[1]?.attrs?.view as ViewDef).name).toBe('Linked');
    expect(session.getState().docs['host-page']?.content?.[1]?.attrs?.hostPageId).toBeUndefined();
    expect((await session.stepContextualHistory('database', identity, 'redo')).status).toBe('applied');
    expect((session.getState().docs['host-page']?.content?.[1]?.attrs?.view as ViewDef).name).toBe('Legacy linked renamed');
    expect(session.getState().docs['host-page']?.content?.[1]?.attrs?.hostPageId).toBeUndefined();
  });

  it('mirrors an accepted linked change before history and session listeners publish', async () => {
    const session = await openWorkspace();
    await session.flush();
    const identity = { kind: 'linked', hostPageId: 'host-page', blockId: 'linked-block' } as const;
    const openedDoc = session.getState().docs['host-page']!;
    const pendingTextDoc: DocNode = {
      ...openedDoc,
      content: openedDoc.content?.map((entry, index) =>
        index === 0 ? { ...entry, content: [{ type: 'text', text: 'committed pending text' }] } : entry,
      ),
    };
    const tracker = new PageEditorDocumentTracker(openedDoc);
    expect(tracker.recordUpdate(true, true, pendingTextDoc)).toMatchObject({ type: 'track' });
    const unregisterCommit = registerCommit(() => {
      const commit = session.execute({ type: 'page.setDoc', id: 'host-page', doc: pendingTextDoc, now: 2 });
      if (!commit.ok) throw new Error(commit.error);
      tracker.syncFromSource(session.getState().docs['host-page']!);
    });
    try {
      commitEditors();
    } finally {
      unregisterCommit();
    }
    await session.flush();
    const beforeDoc = session.getState().docs['host-page']!;
    expect(beforeDoc.content?.[0]?.content?.[0]?.text).toBe('committed pending text');
    const afterDoc: DocNode = {
      ...beforeDoc,
      content: beforeDoc.content?.map((node) => {
        if (node.type !== 'linkedDatabaseView') return node;
        const currentView = node.attrs?.view as ViewDef;
        return { ...node, attrs: { ...node.attrs, view: { ...currentView, name: 'Linked mirrored' } } };
      }),
    };
    const execute = (session as unknown as { executeLinkedViewConfigChange: LinkedViewCommit })
      .executeLinkedViewConfigChange.bind(session);
    const events: string[] = [];
    let mirroredDoc = beforeDoc;
    tracker.syncFromSource(beforeDoc);
    let receiptId = '';
    const unsubscribeView = session.subscribeViewHistory(identity, () => {
      events.push('view-history');
      expect(mirroredDoc).toEqual(afterDoc);
    });
    const unsubscribeSession = session.subscribe(() => {
      events.push('session');
      expect(mirroredDoc).toEqual(session.getState().docs['host-page']);
      expect(session.getViewHistory(identity).undo?.id).toBe(receiptId);
      tracker.syncFromSource(session.getState().docs['host-page']!);
    });

    try {
      const result = execute(identity, beforeDoc, afterDoc, () => true, (receipt) => {
        expect(session.getState().docs['host-page']).toEqual(afterDoc);
        expect(session.queue.hasPending()).toBe(true);
        expect(session.getViewHistory(identity).undo).toBeNull();
        const candidate = session.getContextualHistory('database', identity).undo;
        expect(candidate?.id).toBe(receipt.id);
        expect(candidate?.status).toBe(receipt.status);
        expect(receipt.identity).toEqual(identity);
        expect(receipt.change.before.view.name).toBe('Linked');
        expect(receipt.change.after.view.name).toBe('Linked mirrored');
        expect(receipt.status).toBe('ready');
        expect(receipt.mirrored).toBe(false);
        receiptId = receipt.id;
        mirroredDoc = afterDoc;
        expect(tracker.recordUpdate(true, true, mirroredDoc)).toMatchObject({ type: 'track' });
        events.push('mirror');
        return true;
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(receiptId).not.toBe('');
      expect(result.value.id).toBe(receiptId);
      expect(result.value.status).toBe('ready');
      expect(result.value.mirrored).toBe(true);
      expect(session.getViewHistory(identity).undo?.id).toBe(receiptId);
      expect(events).toEqual(['mirror', 'view-history', 'session']);
      expect(tracker.takePending()).toBeNull();
      expect(session.getState().docs['host-page']?.content?.[0]).toEqual(beforeDoc.content?.[0]);
    } finally {
      unsubscribeView();
      unsubscribeSession();
    }
  });

  it('keeps the accepted history entry when a linked editor mirror fails', async () => {
    const session = await openWorkspace();
    await session.flush();
    const identity = { kind: 'linked', hostPageId: 'host-page', blockId: 'linked-block' } as const;
    const beforeDoc = session.getState().docs['host-page']!;
    const afterDoc: DocNode = {
      ...beforeDoc,
      content: beforeDoc.content?.map((node) => {
        if (node.type !== 'linkedDatabaseView') return node;
        const currentView = node.attrs?.view as ViewDef;
        return { ...node, attrs: { ...node.attrs, view: { ...currentView, name: 'Accepted without mirror' } } };
      }),
    };
    const execute = (session as unknown as { executeLinkedViewConfigChange: LinkedViewCommit })
      .executeLinkedViewConfigChange.bind(session);

    const result = execute(identity, beforeDoc, afterDoc, () => true, () => false);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.id).not.toBe('');
    expect(result.value.status).toBe('ready');
    expect(result.value.mirrored).toBe(false);
    expect(session.getState().docs['host-page']).toEqual(afterDoc);
    expect(session.getViewHistory(identity).undo).toMatchObject({
      id: result.value.id,
      status: 'ready',
    });
    expect(session.queue.hasPending()).toBe(true);
  });

  it('rejects a mixed linked document update before mirroring or queueing', async () => {
    const session = await openWorkspace();
    await session.flush();
    const identity = { kind: 'linked', hostPageId: 'host-page', blockId: 'linked-block' } as const;
    const beforeDoc = session.getState().docs['host-page']!;
    const mixedDoc: DocNode = {
      ...beforeDoc,
      content: beforeDoc.content?.map((node, index) => {
        if (index === 0 && node.type === 'paragraph')
          return { ...node, content: [{ type: 'text', text: 'changed host text' }] };
        if (node.type !== 'linkedDatabaseView') return node;
        const currentView = node.attrs?.view as ViewDef;
        return { ...node, attrs: { ...node.attrs, view: { ...currentView, name: 'Rejected mixed edit' } } };
      }),
    };
    const execute = (session as unknown as { executeLinkedViewConfigChange: LinkedViewCommit })
      .executeLinkedViewConfigChange.bind(session);
    const mirror = vi.fn(() => true);

    const result = execute(identity, beforeDoc, mixedDoc, () => true, mirror);

    expect(result.ok).toBe(false);
    expect(mirror).not.toHaveBeenCalled();
    expect(session.getState().docs['host-page']).toBe(beforeDoc);
    expect(session.queue.hasPending()).toBe(false);
    expect(session.getViewHistory(identity).undo).toBeNull();
  });

  it('blocks replay in readonly context and keeps configuration histories per view', async () => {
    const session = await openWorkspace();
    const firstIdentity = primaryIdentity('view-a');
    const secondIdentity = primaryIdentity('view-b');
    const current = session.getState().pages.database!.database!;
    expect(
      session.execute({
        type: 'database.set',
        id: 'database',
        database: database(
          [view('view-a', 'A readonly test'), current.views[1]!],
          current.properties,
        ),
        now: 3,
      }).ok,
    ).toBe(true);
    expect(session.getContextualHistory('database', secondIdentity).undo).toBeNull();
    expect(
      await session.stepContextualHistory('database', firstIdentity, 'undo', () => false),
    ).toMatchObject({ status: 'blocked', reason: 'permission' });
    expect(session.getState().pages.database?.database?.views[0]?.name).toBe('A readonly test');
  });

  it('shares the 32 MiB session budget between view and data payloads', async () => {
    const largeFilters = Array.from({ length: 9_200 }, (_, index) => ({
      id: `filter-${index}`,
      prop: 'note',
      op: 'contains' as const,
      value: 'x'.repeat(2_000),
    }));
    const session = await openWorkspace(database([view('view-a', 'A', { filters: largeFilters })], [
      { id: 'note', name: 'Note', type: 'text', options: [] },
    ]), 50);
    const identity = primaryIdentity('view-a');
    const current = session.getState().pages.database!.database!;
    expect(session.execute({
      type: 'database.set',
      id: 'database',
      database: database([view('view-a', 'A', { filters: [] })], current.properties),
      now: 3,
    }).ok).toBe(true);
    expect(session.getViewHistory(identity).undo).not.toBeNull();

    for (let index = 0; index < 10; index += 1) {
      const value = `${index}`.repeat(10_000);
      const commands = Array.from({ length: 50 }, (_, rowIndex) => ({
        type: 'page.setProperties' as const,
        id: rowIndex === 0 ? 'row' : `row-${rowIndex}`,
        values: { note: value },
        now: 4 + index,
      }));
      expect(session.executeAll(commands).ok).toBe(true);
    }
    expect(session.getViewHistory(identity).undo).toBeNull();
    expect(session.getDataHistory('database').undo).not.toBeNull();
  });
});
