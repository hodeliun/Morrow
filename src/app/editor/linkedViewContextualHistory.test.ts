import type { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocNode } from '../../core/model';
import type { ContextualHistoryItem } from '../../storage/session';
import { registerCommit, stepLinkedViewContextualHistory } from './commits';
import { registerPageEditor } from './pageEditorRegistry';
import type { ViewHistoryIdentity } from '../../storage/viewHistoryCapture';
import { getSession } from '../workspace';

const harness = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock('../workspace', () => ({
  dataHistoryEditGuard: () => true,
  getSession: harness.getSession,
  stepProperties: () => undefined,
}));

const identity: Extract<ViewHistoryIdentity, { kind: 'linked' }> = {
  kind: 'linked',
  hostPageId: 'host-a',
  blockId: 'block-a',
};
const hostDoc = (pageId: string): DocNode => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: pageId }] }],
});

const registrations: Array<() => void> = [];
let unregisterCommit: (() => void) | null = null;

afterEach(() => {
  unregisterCommit?.();
  unregisterCommit = null;
  while (registrations.length > 0) registrations.pop()!();
  vi.clearAllMocks();
});

function registerEditor(pageId: string, current: () => DocNode): void {
  registrations.push(
    registerPageEditor(pageId, { isDestroyed: false } as Editor, (expected) =>
      JSON.stringify(current()) === JSON.stringify(expected),
    ),
  );
}

function viewCandidate(overrides: Partial<ContextualHistoryItem> = {}): ContextualHistoryItem {
  return {
    id: 'entry-1',
    label: 'database.historyViewChange',
    owner: { kind: 'view', name: 'Renamed view' },
    status: 'ready',
    enabled: true,
    sequence: 5,
    ...overrides,
  };
}

function sessionHarness(
  candidate: ContextualHistoryItem | null,
  targets: { status: 'candidate-changed' | 'conflict' } | {
    status: 'ready';
    entryId: string;
    hosts: readonly { hostPageId: string; doc: DocNode }[];
  },
  events: string[] = [],
) {
  const session = {
    getContextualHistory: vi.fn(() => {
      events.push('candidate');
      return { undo: candidate, redo: null };
    }),
    linkedViewHistoryReplayTargets: vi.fn(() => {
      events.push('preflight');
      return targets;
    }),
    stepContextualHistory: vi.fn(() => {
      events.push('step');
      return Promise.resolve({ status: 'applied' as const });
    }),
  };
  vi.mocked(getSession).mockReturnValue(session as unknown as ReturnType<typeof getSession>);
  return session;
}

describe('linked view contextual history preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('commits first, checks every affected pane across multiple hosts, then replays the same entry synchronously', async () => {
    const events: string[] = [];
    const candidate = viewCandidate();
    const docs = { 'host-a': hostDoc('host-a'), 'host-b': hostDoc('host-b') };
    const session = sessionHarness(candidate, {
      status: 'ready',
      entryId: candidate.id,
      hosts: [
        { hostPageId: 'host-a', doc: docs['host-a'] },
        { hostPageId: 'host-b', doc: docs['host-b'] },
      ],
    }, events);
    registerEditor('host-a', () => docs['host-a']);
    registerEditor('host-b', () => docs['host-b']);
    unregisterCommit = registerCommit(() => events.push('commit'));

    const pending = stepLinkedViewContextualHistory('source-db', identity, 'undo');
    expect(events).toEqual(['commit', 'candidate', 'preflight', 'step']);
    expect(session.stepContextualHistory).toHaveBeenCalledWith(
      'source-db',
      identity,
      'undo',
      undefined,
      candidate.id,
    );
    await expect(pending).resolves.toEqual({ status: 'applied' });
  });

  it('blocks a stale affected pane without entering Session replay', async () => {
    const candidate = viewCandidate();
    const expected = hostDoc('host-a');
    const session = sessionHarness(candidate, {
      status: 'ready',
      entryId: candidate.id,
      hosts: [{ hostPageId: 'host-a', doc: expected }],
    });
    registerEditor('host-a', () => hostDoc('stale pane draft'));

    await expect(stepLinkedViewContextualHistory('source-db', identity, 'undo')).resolves.toEqual({
      status: 'conflict',
    });
    expect(session.stepContextualHistory).not.toHaveBeenCalled();
  });

  it('keeps data-owned, disabled, busy, and stale-candidate routing in Session', async () => {
    const disabled = viewCandidate({ enabled: false, status: 'blocked' });
    const session = sessionHarness(disabled, { status: 'conflict' });
    registerEditor('host-a', () => hostDoc('stale pane'));
    await stepLinkedViewContextualHistory('source-db', identity, 'undo');
    expect(session.linkedViewHistoryReplayTargets).not.toHaveBeenCalled();
    expect(session.stepContextualHistory).toHaveBeenCalledWith(
      'source-db',
      identity,
      'undo',
      undefined,
      disabled.id,
    );

    const busy = viewCandidate({ status: 'busy', enabled: false });
    const busySession = sessionHarness(busy, { status: 'conflict' });
    await stepLinkedViewContextualHistory('source-db', identity, 'undo');
    expect(busySession.linkedViewHistoryReplayTargets).not.toHaveBeenCalled();
    expect(busySession.stepContextualHistory).toHaveBeenCalledWith(
      'source-db',
      identity,
      'undo',
      undefined,
      busy.id,
    );

    const dataOwned = viewCandidate({ owner: { kind: 'data' } });
    const dataSession = sessionHarness(dataOwned, { status: 'conflict' });
    await stepLinkedViewContextualHistory('source-db', identity, 'undo');
    expect(dataSession.linkedViewHistoryReplayTargets).not.toHaveBeenCalled();
    expect(dataSession.stepContextualHistory).toHaveBeenCalledWith(
      'source-db',
      identity,
      'undo',
      undefined,
      dataOwned.id,
    );

    const changedSession = sessionHarness(candidateForChanged(), { status: 'candidate-changed' });
    await stepLinkedViewContextualHistory('source-db', identity, 'undo');
    expect(changedSession.stepContextualHistory).toHaveBeenCalledWith(
      'source-db',
      identity,
      'undo',
      undefined,
      'entry-1',
    );
  });

  it('does not replay when the actual candidate preflight reports an entry conflict', async () => {
    const candidate = viewCandidate();
    const session = sessionHarness(candidate, { status: 'conflict' });
    registerEditor('host-a', () => hostDoc('host-a'));
    await expect(stepLinkedViewContextualHistory('source-db', identity, 'undo')).resolves.toEqual({
      status: 'conflict',
    });
    expect(session.stepContextualHistory).not.toHaveBeenCalled();
  });

  it('preserves Session permission results without converting readonly state into a pane conflict', async () => {
    const candidate = viewCandidate();
    const session = sessionHarness(candidate, {
      status: 'ready',
      entryId: candidate.id,
      hosts: [{ hostPageId: 'host-a', doc: hostDoc('host-a') }],
    });
    registerEditor('host-a', () => hostDoc('stale readonly pane'));
    const canEditNow = vi.fn(() => false);

    await stepLinkedViewContextualHistory('source-db', identity, 'undo', canEditNow);

    expect(session.linkedViewHistoryReplayTargets).not.toHaveBeenCalled();
    expect(session.stepContextualHistory).toHaveBeenCalledWith(
      'source-db',
      identity,
      'undo',
      canEditNow,
      candidate.id,
    );
  });

  it('returns empty without changing native history when no contextual item remains', async () => {
    const session = sessionHarness(null, { status: 'conflict' });
    await expect(stepLinkedViewContextualHistory('source-db', identity, 'undo')).resolves.toEqual({
      status: 'empty',
    });
    expect(session.linkedViewHistoryReplayTargets).not.toHaveBeenCalled();
    expect(session.stepContextualHistory).not.toHaveBeenCalled();
  });
});

function candidateForChanged(): ContextualHistoryItem {
  return viewCandidate();
}
