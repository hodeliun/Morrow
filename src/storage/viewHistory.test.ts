import { describe, expect, it } from 'vitest';
import type { ViewDef } from '../core/model';
import { SessionHistoryBudget } from './historyBudget';
import { SessionViewHistory } from './viewHistory';
import type { ViewConfigChange, ViewHistoryIdentity } from './viewHistoryCapture';

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

function change(identity: ViewHistoryIdentity, beforeName: string, afterName: string): ViewConfigChange {
  const viewId = identity.kind === 'database' ? identity.viewId : 'linked-view';
  return {
    identity,
    before: { view: view(viewId, beforeName) },
    after: { view: view(viewId, afterName) },
  };
}

const databaseView = (viewId: string): ViewHistoryIdentity => ({
  kind: 'database',
  databaseId: 'database',
  viewId,
});

describe('session view history', () => {
  it('keeps ten completed changes per view and stores one multi-view event once', () => {
    const budget = new SessionHistoryBudget();
    const history = new SessionViewHistory(budget);
    const firstIdentity = databaseView('first');
    const secondIdentity = { kind: 'linked', hostPageId: 'host', blockId: 'block' } as const;
    const sharedChanges = [change(firstIdentity, 'before A', 'after A'), change(secondIdentity, 'before B', 'after B')];
    const expectedBytes = new TextEncoder().encode(JSON.stringify(sharedChanges)).byteLength;
    const sharedId = history.record(sharedChanges)!;
    expect(history.getCandidate(firstIdentity, 'undo')?.id).toBe(sharedId);
    expect(history.getCandidate(secondIdentity, 'undo')?.id).toBe(sharedId);
    expect(budget.usedBytes).toBe(expectedBytes);

    for (let index = 0; index < 10; index += 1)
      history.record([change(firstIdentity, `before ${index}`, `after ${index}`)]);
    for (let index = 0; index < 10; index += 1)
      expect(history.step(firstIdentity, 'undo', () => ({ status: 'applied' })).status).toBe('applied');
    expect(history.getCandidate(firstIdentity, 'undo')).toBeNull();
    expect(history.getCandidate(secondIdentity, 'undo')).toBeNull();
  });

  it('orders redo by the latest undo transfer and invalidates redo only in the edited view', () => {
    const history = new SessionViewHistory(new SessionHistoryBudget());
    const first = databaseView('first');
    const second = databaseView('second');
    history.record([change(first, 'A0', 'A1')]);
    const secondId = history.record([change(second, 'B0', 'B1')])!;

    expect(history.step(second, 'undo', () => ({ status: 'applied' }), undefined, secondId).status).toBe('applied');
    expect(history.getCandidate(second, 'redo')?.id).toBe(secondId);
    history.record([change(first, 'A1', 'A2')]);
    expect(history.getCandidate(second, 'redo')?.id).toBe(secondId);
    expect(history.getCandidate(first, 'redo')).toBeNull();

    expect(history.step(second, 'redo', () => ({ status: 'applied' }), undefined, secondId).status).toBe('applied');
    expect(history.getCandidate(second, 'undo')?.sequence).toBeGreaterThan(history.getCandidate(first, 'undo')!.sequence);
  });

  it('makes a multi-scope event indivisible and protects conflicts from eviction', () => {
    const history = new SessionViewHistory(new SessionHistoryBudget());
    const first = databaseView('first');
    const second = databaseView('second');
    const sharedId = history.record([change(first, 'A0', 'A1'), change(second, 'B0', 'B1')])!;
    history.record([change(second, 'B1', 'B2')]);

    expect(history.getSnapshot(first).undo).toMatchObject({ id: sharedId, enabled: false, status: 'blocked' });
    expect(history.step(first, 'undo', () => ({ status: 'applied' }), undefined, sharedId)).toEqual({
      status: 'blocked',
      reason: 'related',
    });
    const latest = history.getCandidate(second, 'undo')!;
    expect(history.step(second, 'undo', () => ({ status: 'conflict' }), undefined, latest.id).status).toBe('conflict');
    expect(history.getSnapshot(second).undo?.status).toBe('conflict');
    expect(history.getSnapshot(first).undo?.id).toBe(sharedId);
  });
});
