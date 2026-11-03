import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseDef, DocNode, ViewDef } from '../core/model';
import { MemoryVault } from './memoryVault';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';
import type { SessionViewHistory } from './viewHistory';
import type { ViewConfigChange, ViewHistoryIdentity } from './viewHistoryCapture';

let repositorySequence = 0;
const openSessions: Array<{ session: WorkspaceSession; repository: VaultRepository }> = [];

afterEach(async () => {
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

function linkedDoc(hostPageId: string, blockId: string, viewName: string, viewId = `view-${blockId}`): DocNode {
  return {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: `Text for ${hostPageId}` }] },
      {
        type: 'linkedDatabaseView',
        attrs: {
          hostPageId,
          sourceDatabaseId: 'source-db',
          blockId,
          view: view(viewId, viewName),
          viewRawState: {
            raw: { sourceDatabaseId: 'source-db', blockId, futureLinkedFlag: { keep: blockId } },
            baseline: { sourceDatabaseId: 'source-db', blockId },
          },
        },
      },
    ],
  };
}

function linkedDocWithClonedViewIds(hostPageId: string, viewId: string, viewName: string): DocNode {
  const first = linkedDoc(hostPageId, 'block-a', viewName, viewId).content![1]!;
  const second = linkedDoc(hostPageId, 'block-b', viewName, viewId).content![1]!;
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: `Text for ${hostPageId}` }] }, first, second],
  };
}

function linkedChange(hostPageId: string, blockId: string, viewId: string, before: string, after: string): ViewConfigChange {
  const rawState = {
    raw: { sourceDatabaseId: 'source-db', blockId, futureLinkedFlag: { keep: blockId } },
    baseline: { sourceDatabaseId: 'source-db', blockId },
  };
  return {
    identity: { kind: 'linked', hostPageId, blockId },
    before: { view: view(viewId, before), viewRawState: rawState },
    after: { view: view(viewId, after), viewRawState: rawState },
  };
}

async function open(hosts: readonly string[]): Promise<WorkspaceSession> {
  const vault = new MemoryVault();
  const repository = new VaultRepository(vault, () => `linked-view-target-${repositorySequence++}`);
  const opened = await WorkspaceSession.open(repository, { delayMs: 60_000 });
  if (!opened.ok) throw new Error(opened.error);
  const session = opened.value;
  openSessions.push({ session, repository });

  const seeded = session.executeHistoryReplay([
    {
      type: 'page.create',
      id: 'source-db',
      parentId: null,
      title: 'Source database',
      kind: 'database',
      database: { properties: [], views: [view('source-view', 'Source')] } satisfies DatabaseDef,
      now: 1,
    },
    ...hosts.map((id, index) => ({
      type: 'page.create' as const,
      id,
      parentId: null,
      title: `Host ${index + 1}`,
      now: 1,
    })),
  ]);
  if (!seeded.ok) throw new Error(seeded.error);

  const docs = session.executeHistoryReplay(
    hosts.map((hostPageId) => ({
      type: 'page.setDoc' as const,
      id: hostPageId,
      doc: linkedDoc(hostPageId, `block-${hostPageId}`, 'Primary'),
      now: 2,
    })),
  );
  if (!docs.ok) throw new Error(docs.error);
  return session;
}

describe('linked view history replay targets', () => {
  it('returns the live candidate ID and current expected host document', async () => {
    const session = await open(['host-a']);
    const identity: Extract<ViewHistoryIdentity, { kind: 'linked' }> = {
      kind: 'linked',
      hostPageId: 'host-a',
      blockId: 'block-host-a',
    };
    const before = linkedDoc('host-a', 'block-host-a', 'Primary');
    const after = linkedDoc('host-a', 'block-host-a', 'Renamed');
    const changed = session.executeLinkedViewConfigChange(identity, before, after, () => true, () => true);
    if (!changed.ok) throw new Error(changed.error);

    expect(session.linkedViewHistoryReplayTargets(identity, 'undo', changed.value.id)).toEqual({
      status: 'ready',
      entryId: changed.value.id,
      hosts: [{ hostPageId: 'host-a', doc: after }],
    });
    expect(session.linkedViewHistoryReplayTargets(identity, 'undo', 'stale-entry')).toEqual({
      status: 'candidate-changed',
    });
  });

  it('collects every affected host from one multi-host candidate and validates its current docs', async () => {
    const session = await open(['host-a', 'host-b']);
    const identity: Extract<ViewHistoryIdentity, { kind: 'linked' }> = {
      kind: 'linked',
      hostPageId: 'host-a',
      blockId: 'block-host-a',
    };
    const changes = [
      linkedChange('host-a', 'block-host-a', 'view-block-host-a', 'Primary A', 'Renamed A'),
      linkedChange('host-b', 'block-host-b', 'view-block-host-b', 'Primary B', 'Renamed B'),
    ];
    const updated = session.executeHistoryReplay([
      { type: 'page.setDoc', id: 'host-a', doc: linkedDoc('host-a', 'block-host-a', 'Renamed A'), now: 3 },
      { type: 'page.setDoc', id: 'host-b', doc: linkedDoc('host-b', 'block-host-b', 'Renamed B'), now: 3 },
    ]);
    if (!updated.ok) throw new Error(updated.error);
    const history = (session as unknown as { viewHistory: SessionViewHistory }).viewHistory;
    const entryId = history.record(changes);
    if (!entryId) throw new Error('Expected a linked view history entry.');

    const targets = session.linkedViewHistoryReplayTargets(identity, 'undo', entryId);
    expect(targets.status).toBe('ready');
    if (targets.status !== 'ready') throw new Error('Expected multi-host linked history targets.');
    expect(targets.entryId).toBe(entryId);
    expect(targets.hosts).toEqual([
      { hostPageId: 'host-a', doc: session.getState().docs['host-a'] },
      { hostPageId: 'host-b', doc: session.getState().docs['host-b'] },
    ]);
  });

  it('reports a linked config conflict or missing linked source without exposing stale targets', async () => {
    const session = await open(['host-a']);
    const identity: Extract<ViewHistoryIdentity, { kind: 'linked' }> = {
      kind: 'linked',
      hostPageId: 'host-a',
      blockId: 'block-host-a',
    };
    const before = linkedDoc('host-a', 'block-host-a', 'Primary');
    const after = linkedDoc('host-a', 'block-host-a', 'Renamed');
    const changed = session.executeLinkedViewConfigChange(identity, before, after, () => true, () => true);
    if (!changed.ok) throw new Error(changed.error);

    const staleDoc = linkedDoc('host-a', 'block-host-a', 'Concurrent change');
    const stale = session.executeHistoryReplay([
      { type: 'page.setDoc', id: 'host-a', doc: staleDoc, now: 3 },
    ]);
    if (!stale.ok) throw new Error(stale.error);
    expect(session.linkedViewHistoryReplayTargets(identity, 'undo', changed.value.id)).toEqual({
      status: 'conflict',
    });

    const missingSourceDoc = linkedDoc('host-a', 'block-host-a', 'Renamed');
    missingSourceDoc.content![1]!.attrs!.sourceDatabaseId = null;
    const sourceChange = session.executeHistoryReplay([
      { type: 'page.setDoc', id: 'host-a', doc: missingSourceDoc, now: 4 },
    ]);
    if (!sourceChange.ok) throw new Error(sourceChange.error);
    expect(session.linkedViewHistoryReplayTargets(identity, 'undo', changed.value.id)).toEqual({
      status: 'conflict',
    });
  });

  it('replays mixed linked and primary view changes as one atomic history action', async () => {
    const session = await open(['host-a']);
    const identity: Extract<ViewHistoryIdentity, { kind: 'linked' }> = {
      kind: 'linked',
      hostPageId: 'host-a',
      blockId: 'block-host-a',
    };
    const after = linkedDoc('host-a', 'block-host-a', 'Renamed');
    const database = session.getState().pages['source-db']!.database!;
    const updatedDatabase = {
      ...database,
      views: database.views.map((candidate) =>
        candidate.id === 'source-view' ? view('source-view', 'Changed source view') : candidate,
      ),
    };
    const updated = session.executeHistoryReplay([
      { type: 'page.setDoc', id: 'host-a', doc: after, now: 3 },
      { type: 'database.set', id: 'source-db', database: updatedDatabase, now: 3 },
    ]);
    if (!updated.ok) throw new Error(updated.error);

    const history = (session as unknown as { viewHistory: SessionViewHistory }).viewHistory;
    const entryId = history.record([
      linkedChange('host-a', 'block-host-a', 'view-block-host-a', 'Primary', 'Renamed'),
      {
        identity: { kind: 'database', databaseId: 'source-db', viewId: 'source-view' },
        before: { view: view('source-view', 'Source') },
        after: { view: view('source-view', 'Changed source view') },
      },
    ]);
    if (!entryId) throw new Error('Expected a mixed view history entry.');

    const targets = session.linkedViewHistoryReplayTargets(identity, 'undo', entryId);
    expect(targets.status).toBe('ready');
    if (targets.status !== 'ready') throw new Error('Expected linked targets from a mixed entry.');
    expect(targets.hosts).toEqual([{ hostPageId: 'host-a', doc: after }]);

    await expect(
      session.stepContextualHistory('source-db', identity, 'undo', () => true, entryId),
    ).resolves.toEqual({ status: 'applied' });
    expect(session.getState().docs['host-a']!.content![1]!.attrs!.view).toEqual(
      view('view-block-host-a', 'Primary'),
    );
    expect(session.getState().pages['source-db']!.database!.views[0]!.name).toBe('Source');
    const historyAfterUndo = session.getContextualHistory('source-db', identity);
    expect(historyAfterUndo.undo).toBeNull();
    expect(historyAfterUndo.redo?.id).toBe(entryId);
  });

  it('accepts distinct linked blocks that share a cloned view ID', async () => {
    const session = await open(['host-a']);
    const identity: Extract<ViewHistoryIdentity, { kind: 'linked' }> = {
      kind: 'linked',
      hostPageId: 'host-a',
      blockId: 'block-a',
    };
    const after = linkedDocWithClonedViewIds('host-a', 'shared-view', 'Renamed');
    const updated = session.executeHistoryReplay([
      { type: 'page.setDoc', id: 'host-a', doc: after, now: 3 },
    ]);
    if (!updated.ok) throw new Error(updated.error);

    const history = (session as unknown as { viewHistory: SessionViewHistory }).viewHistory;
    const entryId = history.record([
      linkedChange('host-a', 'block-a', 'shared-view', 'Primary', 'Renamed'),
      linkedChange('host-a', 'block-b', 'shared-view', 'Primary', 'Renamed'),
    ]);
    if (!entryId) throw new Error('Expected a multi-block linked entry.');

    const targets = session.linkedViewHistoryReplayTargets(identity, 'undo', entryId);
    expect(targets.status).toBe('ready');
    if (targets.status !== 'ready') throw new Error('Expected shared-view-ID linked targets.');
    expect(targets.hosts).toEqual([{ hostPageId: 'host-a', doc: after }]);
    await expect(
      session.stepContextualHistory('source-db', identity, 'undo', () => true, entryId),
    ).resolves.toEqual({ status: 'applied' });
    expect(session.getState().docs['host-a']!.content!.slice(1).map((node) => node.attrs!.view)).toEqual([
      view('shared-view', 'Primary'),
      view('shared-view', 'Primary'),
    ]);
  });
});
