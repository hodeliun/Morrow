import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseDef, ViewDef } from '../../../core/model';
import { MemoryVault } from '../../../storage/memoryVault';
import { WorkspaceSession } from '../../../storage/session';
import { VaultRepository } from '../../../storage/vaultRepository';
import { commitColumnDrop, createColumnResizeGesture } from './viewGestures';
import { transitionViewSearchDraft } from './viewDrafts';

let repositorySequence = 0;
const openSessions: Array<{ session: WorkspaceSession; repository: VaultRepository }> = [];

afterEach(async () => {
  while (openSessions.length > 0) {
    const { session, repository } = openSessions.pop()!;
    await session.close();
    repository.close?.();
  }
});

function makeView(id: string, name: string, changes: Partial<ViewDef> = {}): ViewDef {
  return {
    id,
    name,
    type: 'table',
    filters: [],
    sorts: [],
    groupBy: null,
    dateProp: null,
    hidden: [],
    order: ['title', 'a', 'b', 'c'],
    ...changes,
  };
}

function makeDatabase(): DatabaseDef {
  return {
    properties: [
      { id: 'a', name: 'A', type: 'text', options: [] },
      { id: 'b', name: 'B', type: 'text', options: [] },
      { id: 'c', name: 'C', type: 'text', options: [] },
    ],
    views: [
      makeView('view-a', 'A', { widths: { a: 180 } }),
      makeView('view-b', 'B'),
    ],
  };
}

async function openWorkspace(): Promise<WorkspaceSession> {
  const vault = new MemoryVault();
  const repository = new VaultRepository(vault, () => `view-gesture-${repositorySequence++}`);
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
      database: makeDatabase(),
      now: 1,
    },
  ]);
  if (!seeded.ok) throw new Error(seeded.error);
  return session;
}

function applyView(session: WorkspaceSession, view: ViewDef): void {
  const current = session.getState().pages.database!.database!;
  const nextDatabase = {
    ...current,
    views: current.views.map((candidate) => (candidate.id === view.id ? view : candidate)),
  };
  const result = session.execute({ type: 'database.set', id: 'database', database: nextDatabase, now: 2 });
  if (!result.ok) throw new Error(result.error);
}

describe('view history gesture commits', () => {
  it('keeps search keystrokes local, commits once on blur or Enter, and cancels Escape without another entry', async () => {
    const session = await openWorkspace();
    const identity = { kind: 'database', databaseId: 'database', viewId: 'view-a' } as const;
    const saved = session.getState().pages.database!.database!.views[0]!.search;
    let draft = saved ?? '';

    for (const value of ['A', 'Al', 'Alp', 'Alpha']) {
      const resolution = transitionViewSearchDraft(saved, draft, { type: 'input', value });
      expect(resolution.commit).toBeNull();
      draft = resolution.draft;
      expect(session.getState().pages.database!.database!.views[0]!.search).toBeUndefined();
      expect(session.getViewHistory(identity).undo).toBeNull();
    }

    const blurCommit = transitionViewSearchDraft(saved, draft, { type: 'commit' });
    expect(blurCommit.commit).toBe('Alpha');
    if (blurCommit.commit !== null) {
      const current = session.getState().pages.database!.database!.views[0]!;
      applyView(session, { ...current, search: blurCommit.commit });
    }
    const firstEntryId = session.getViewHistory(identity).undo?.id;
    expect(firstEntryId).toBeTruthy();

    const enterAfterBlur = transitionViewSearchDraft('Alpha', 'Alpha', { type: 'commit' });
    expect(enterAfterBlur.commit).toBeNull();
    expect(session.getViewHistory(identity).undo?.id).toBe(firstEntryId);

    const changedDraft = transitionViewSearchDraft('Alpha', 'Alpha', { type: 'input', value: 'Alpha beta' });
    const cancelled = transitionViewSearchDraft('Alpha', changedDraft.draft, { type: 'cancel' });
    expect(cancelled).toEqual({ draft: 'Alpha', commit: null });
    expect(session.getState().pages.database!.database!.views[0]!.search).toBe('Alpha');
    expect(session.getViewHistory(identity).undo?.id).toBe(firstEntryId);
  });

  it('records a resize gesture once after pointer movement and applies a column drop once', async () => {
    const session = await openWorkspace();
    const identity = { kind: 'database', databaseId: 'database', viewId: 'view-a' } as const;
    const database = session.getState().pages.database!.database!;
    const view = database.views[0]!;
    const previews: number[] = [];
    const resizeDone = vi.fn((width: number) => {
      applyView(session, { ...view, widths: { ...view.widths, a: width } });
    });
    const resize = createColumnResizeGesture(180, 100, (width) => previews.push(width), resizeDone);

    resize.move(120);
    resize.move(135);
    expect(previews).toEqual([200, 215]);
    expect(resizeDone).not.toHaveBeenCalled();
    expect(session.getViewHistory(identity).undo).toBeNull();
    resize.finish();
    resize.finish();
    expect(resizeDone).toHaveBeenCalledTimes(1);
    expect(session.getState().pages.database!.database!.views[0]!.widths?.a).toBe(215);
    const resizeEntryId = session.getViewHistory(identity).undo?.id;
    expect(resizeEntryId).toBeTruthy();

    const currentDatabase = session.getState().pages.database!.database!;
    const currentView = currentDatabase.views[0]!;
    const commitDrop = vi.fn((nextView: ViewDef) => applyView(session, nextView));
    expect(commitColumnDrop(currentDatabase, currentView, 'a', 'c', 'after', commitDrop)).toBe(true);
    expect(commitDrop).toHaveBeenCalledTimes(1);
    expect(session.getState().pages.database!.database!.views[0]!.order).toEqual(['title', 'b', 'c', 'a']);
    expect(session.getViewHistory(identity).undo?.id).not.toBe(resizeEntryId);
    expect(session.getViewHistory({ kind: 'database', databaseId: 'database', viewId: 'view-b' }).undo).toBeNull();
  });
});
