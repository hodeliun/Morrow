import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseDef, ViewDef } from '../core/model';
import { MemoryVault } from '../storage/memoryVault';
import { WorkspaceSession } from '../storage/session';
import { VaultRepository } from '../storage/vaultRepository';
import { clearPropertyHistory, propertyChangeCount, runAll, setSession, stepProperties } from './workspace';

let repositorySequence = 0;
const openSessions: Array<{ session: WorkspaceSession; repository: VaultRepository }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  clearPropertyHistory();
  while (openSessions.length > 0) {
    const { session, repository } = openSessions.pop()!;
    await session.close();
    repository.close?.();
  }
});

function view(id: string, name: string): ViewDef {
  return {
    id,
    name,
    type: 'table',
    filters: [],
    sorts: [],
    groupBy: null,
    dateProp: null,
    hidden: [],
  };
}

function database(): DatabaseDef {
  return {
    properties: [{ id: 'note', name: 'Note', type: 'text', options: [] }],
    views: [view('view-a', 'View A'), view('view-b', 'View B')],
  };
}

async function openWorkspace(): Promise<WorkspaceSession> {
  const repository = new VaultRepository(new MemoryVault(), () => `context-history-${repositorySequence++}`);
  const opened = await WorkspaceSession.open(repository, { delayMs: 60_000 });
  if (!opened.ok) throw new Error(opened.error);
  const session = opened.value;
  openSessions.push({ session, repository });
  const seeded = session.executeHistoryReplay([
    {
      type: 'page.create',
      id: 'database',
      parentId: null,
      title: 'Synthetic database',
      kind: 'database',
      database: database(),
      now: 1,
    },
    {
      type: 'page.create',
      id: 'row',
      parentId: 'database',
      title: 'Synthetic row',
      properties: { note: 'seed' },
      now: 1,
    },
  ]);
  if (!seeded.ok) throw new Error(seeded.error);
  setSession(session);
  return session;
}

describe('workspace contextual history integration', () => {
  it('keeps an isolated view edit out of the legacy property stack', async () => {
    const session = await openWorkspace();
    const legacyCountBefore = propertyChangeCount();
    const current = session.getState().pages.database!.database!;
    const next = {
      ...current,
      views: current.views.map((item) => (item.id === 'view-a' ? { ...item, name: 'Renamed A' } : item)),
    };

    expect(runAll([{ type: 'database.set', id: 'database', database: next, now: 2 }]).ok).toBe(true);
    expect(propertyChangeCount() - legacyCountBefore).toBe(0);
    expect(session.getDataHistory('database').undo).toBeNull();
    expect(session.getViewHistory({ kind: 'database', databaseId: 'database', viewId: 'view-a' }).undo).not.toBeNull();
  });

  it('keeps a later view change when the earlier legacy schema and row action is undone', async () => {
    const session = await openWorkspace();
    const legacyCountBefore = propertyChangeCount();
    const current = session.getState().pages.database!.database!;
    const schemaAndRow = runAll([
      {
        type: 'database.set',
        id: 'database',
        database: {
          ...current,
          properties: [...current.properties, { id: 'extra', name: 'Extra', type: 'text', options: [] }],
        },
        now: 2,
      },
      { type: 'page.setProperties', id: 'row', values: { note: 'changed with schema' }, now: 2 },
    ]);
    expect(schemaAndRow.ok).toBe(true);
    expect(propertyChangeCount() - legacyCountBefore).toBe(1);

    const schemaState = session.getState().pages.database!.database!;
    const laterView = {
      ...schemaState,
      views: schemaState.views.map((item) => (item.id === 'view-a' ? { ...item, name: 'View A after schema' } : item)),
    };
    expect(runAll([{ type: 'database.set', id: 'database', database: laterView, now: 3 }]).ok).toBe(true);
    expect(propertyChangeCount() - legacyCountBefore).toBe(1);
    expect(session.getViewHistory({ kind: 'database', databaseId: 'database', viewId: 'view-a' }).undo).not.toBeNull();

    expect(stepProperties('undo')).toBe(true);
    const restored = session.getState();
    expect(restored.pages.database?.database?.properties.map((item) => item.id)).toEqual(['note']);
    expect(restored.pages.row?.properties.note).toBe('seed');
    expect(restored.pages.database?.database?.views.find((item) => item.id === 'view-a')?.name).toBe('View A after schema');
  });

  it('does not submit a legacy replay when a changed view field has a newer conflicting value', async () => {
    const session = await openWorkspace();
    const legacyCountBefore = propertyChangeCount();
    const current = session.getState().pages.database!.database!;
    const schemaAndViewAndRow = runAll([
      {
        type: 'database.set',
        id: 'database',
        database: {
          ...current,
          properties: [...current.properties, { id: 'extra', name: 'Extra', type: 'text', options: [] }],
          views: current.views.map((item) => item.id === 'view-a'
            ? { ...item, name: 'View A changed with schema' }
            : item),
        },
        now: 2,
      },
      { type: 'page.setProperties', id: 'row', values: { note: 'changed with schema' }, now: 2 },
    ]);
    expect(schemaAndViewAndRow.ok).toBe(true);
    expect(propertyChangeCount() - legacyCountBefore).toBe(1);

    const afterLegacy = session.getState().pages.database!.database!;
    const laterView = {
      ...afterLegacy,
      views: afterLegacy.views.map((item) => item.id === 'view-a'
        ? { ...item, name: 'View A changed later' }
        : item),
    };
    expect(runAll([{ type: 'database.set', id: 'database', database: laterView, now: 3 }]).ok).toBe(true);
    await session.flush();
    const beforeUndo = session.getState();
    const replay = vi.spyOn(session, 'executeHistoryReplay');

    expect(stepProperties('undo')).toBe(true);
    expect(replay).not.toHaveBeenCalled();
    expect(session.getState()).toBe(beforeUndo);
    expect(session.queue.hasPending()).toBe(false);
    expect(propertyChangeCount() - legacyCountBefore).toBe(1);
    expect(stepProperties('redo')).toBe(false);
    expect(stepProperties('undo')).toBe(true);
    expect(replay).not.toHaveBeenCalled();
    expect(session.getState()).toBe(beforeUndo);
    expect(session.queue.hasPending()).toBe(false);
  });

  it('preserves a view added after a schema-only legacy action is undone', async () => {
    const session = await openWorkspace();
    const legacyCountBefore = propertyChangeCount();
    const current = session.getState().pages.database!.database!;
    const schemaAndRow = runAll([
      {
        type: 'database.set',
        id: 'database',
        database: {
          ...current,
          properties: [...current.properties, { id: 'extra', name: 'Extra', type: 'text', options: [] }],
        },
        now: 2,
      },
      { type: 'page.setProperties', id: 'row', values: { note: 'changed with schema' }, now: 2 },
    ]);
    expect(schemaAndRow.ok).toBe(true);
    expect(propertyChangeCount() - legacyCountBefore).toBe(1);

    const schemaState = session.getState().pages.database!.database!;
    const withLaterView = { ...schemaState, views: [...schemaState.views, view('view-c', 'View C')] };
    expect(session.execute({ type: 'database.set', id: 'database', database: withLaterView, now: 3 }).ok).toBe(true);
    await session.flush();

    expect(stepProperties('undo')).toBe(true);
    const restored = session.getState();
    expect(restored.pages.database?.database?.properties.map((item) => item.id)).toEqual(['note']);
    expect(restored.pages.row?.properties.note).toBe('seed');
    expect(restored.pages.database?.database?.views.map((item) => item.id)).toEqual(['view-a', 'view-b', 'view-c']);
    expect(propertyChangeCount() - legacyCountBefore).toBe(1);
    expect(session.queue.hasPending()).toBe(true);
  });

  it('keeps an incompatible schema undo atomic when a newer view uses its column', async () => {
    const session = await openWorkspace();
    const legacyCountBefore = propertyChangeCount();
    const current = session.getState().pages.database!.database!;
    const schemaAndRow = runAll([
      {
        type: 'database.set',
        id: 'database',
        database: {
          ...current,
          properties: [...current.properties, { id: 'extra', name: 'Extra', type: 'text', options: [] }],
        },
        now: 2,
      },
      { type: 'page.setProperties', id: 'row', values: { note: 'changed with schema' }, now: 2 },
    ]);
    expect(schemaAndRow.ok).toBe(true);
    expect(propertyChangeCount() - legacyCountBefore).toBe(1);

    const schemaState = session.getState().pages.database!.database!;
    const viewUsingNewColumn = {
      ...schemaState,
      views: schemaState.views.map((item) => item.id === 'view-a'
        ? { ...item, filters: [{ id: 'extra-filter', prop: 'extra', op: 'notEmpty' as const, value: null }] }
        : item),
    };
    expect(runAll([{ type: 'database.set', id: 'database', database: viewUsingNewColumn, now: 3 }]).ok).toBe(true);
    await session.flush();
    expect(session.queue.hasPending()).toBe(false);

    const beforeUndo = session.getState();
    const replay = vi.spyOn(session, 'executeHistoryReplay');
    expect(stepProperties('undo')).toBe(true);

    // The real database.set validator refuses to remove a column still referenced by a view.
    // The replay batch is atomic: the row, schema, view and save queue remain untouched.
    expect(replay).toHaveBeenCalledOnce();
    const firstReplay = replay.mock.results[0];
    expect(firstReplay?.type).toBe('return');
    if (firstReplay?.type === 'return') {
      expect(firstReplay.value.ok).toBe(false);
      if (!firstReplay.value.ok) expect(firstReplay.value.error).toMatch(/still used by 1 view configuration/i);
    }
    expect(session.getState()).toBe(beforeUndo);
    expect(session.queue.hasPending()).toBe(false);
    expect(session.getState().pages.database?.database?.properties.map((item) => item.id)).toEqual(['note', 'extra']);
    expect(session.getState().pages.database?.database?.views[0]?.filters[0]?.prop).toBe('extra');
    expect(session.getState().pages.row?.properties.note).toBe('changed with schema');
    expect(propertyChangeCount() - legacyCountBefore).toBe(1);
    expect(stepProperties('redo')).toBe(false);
    expect(stepProperties('undo')).toBe(true);
    expect(replay).toHaveBeenCalledTimes(2);
    expect(session.getState()).toBe(beforeUndo);
    expect(session.queue.hasPending()).toBe(false);
    replay.mockRestore();
  });

  it('keeps schema, view and adopted row changes in one legacy undo action for a mixed batch', async () => {
    const session = await openWorkspace();
    const legacyCountBefore = propertyChangeCount();
    const current = session.getState().pages.database!.database!;
    const changedDatabase: DatabaseDef = {
      ...current,
      properties: [...current.properties, { id: 'extra', name: 'Extra', type: 'text', options: [] }],
      views: current.views.map((item) => (item.id === 'view-a' ? { ...item, name: 'Renamed A' } : item)),
    };

    const result = runAll([
      { type: 'database.set', id: 'database', database: changedDatabase, now: 2 },
      { type: 'page.setProperties', id: 'row', values: { note: 'adopted' }, now: 2 },
    ]);
    expect(result.ok).toBe(true);
    expect(propertyChangeCount() - legacyCountBefore).toBe(1);
    expect(session.getViewHistory({ kind: 'database', databaseId: 'database', viewId: 'view-a' }).undo).toBeNull();
    expect(session.getDataHistory('database').undo).toBeNull();
    expect(session.getState().pages.row?.properties.note).toBe('adopted');

    expect(stepProperties('undo')).toBe(true);
    const restored = session.getState();
    expect(restored.pages.database?.database?.properties.map((item) => item.id)).toEqual(['note']);
    expect(restored.pages.database?.database?.views[0]?.name).toBe('View A');
    expect(restored.pages.database?.database?.views[1]?.name).toBe('View B');
    expect(restored.pages.row?.properties.note).toBe('seed');
  });
});
