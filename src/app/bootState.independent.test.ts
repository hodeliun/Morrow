import { describe, expect, it } from 'vitest';
import { createBootState } from './bootState';
import { MemoryVault } from '../storage/memoryVault';
import { WorkspaceSession } from '../storage/session';
import { VaultRepository } from '../storage/vaultRepository';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let nextSessionId = 0;

async function openSyntheticSession(): Promise<WorkspaceSession> {
  const opened = await WorkspaceSession.open(
    new VaultRepository(new MemoryVault({}), () => `boot-state-${++nextSessionId}`),
    { delayMs: 60_000 },
  );
  if (!opened.ok) throw new Error(opened.error);
  return opened.value;
}

describe('createBootState independent contract', () => {
  it('keeps a pending opening distinct from a completed no-session boot', async () => {
    const boot = createBootState<object>();
    expect(boot.snapshot()).toEqual({ kind: 'idle', generation: 0 });

    const generation = boot.begin();
    const completion = deferred<unknown>();
    boot.knowPromise(generation, completion.promise);
    expect(boot.snapshot()).toMatchObject({
      kind: 'opening',
      generation,
      promise: completion.promise,
      candidate: null,
    });

    completion.resolve({ kind: 'choose' });
    await completion.promise;
    boot.settle(generation, { kind: 'no-session', reason: 'choose' });

    const settled = boot.snapshot();
    expect(settled).toMatchObject({
      kind: 'settled-no-session',
      generation,
      promise: completion.promise,
      reason: 'choose',
    });
  });

  it('retains the exact candidate and boot promise through successful settlement', () => {
    const boot = createBootState<{ id: string }>();
    const generation = boot.begin();
    const promise = Promise.resolve({ kind: 'ready' });
    const candidate = { id: 'session-a' };
    boot.knowPromise(generation, promise);

    expect(boot.retainCandidate(generation, candidate)).toBe(true);
    expect(boot.retainCandidate(generation, candidate)).toBe(true);
    expect(() => boot.retainCandidate(generation, { id: 'replacement' })).toThrow(
      'Workspace boot candidate cannot be replaced within a generation.',
    );

    const opening = boot.snapshot();
    expect(opening.kind).toBe('opening');
    if (opening.kind !== 'opening') throw new Error('Expected opening state.');
    expect(opening.promise).toBe(promise);
    expect(opening.candidate).toBe(candidate);

    boot.settle(generation, { kind: 'session' });
    const settled = boot.snapshot();
    expect(settled.kind).toBe('session');
    if (settled.kind !== 'session') throw new Error('Expected session state.');
    expect(settled.promise).toBe(promise);
    expect(settled.candidate).toBe(candidate);
  });

  it('preserves accepted in-memory work when boot fails after retaining the candidate', async () => {
    const session = await openSyntheticSession();
    try {
      const boot = createBootState<WorkspaceSession>();
      const generation = boot.begin();
      const completion = deferred<unknown>();
      boot.knowPromise(generation, completion.promise);
      expect(boot.retainCandidate(generation, session)).toBe(true);

      const accepted = session.execute({
        type: 'page.create',
        id: 'boot-state-seed',
        parentId: null,
        title: 'Synthetic seed',
        now: 1,
      });
      expect(accepted.ok).toBe(true);
      expect(session.queue.hasPending()).toBe(true);

      const markError = new Error('markInitialized failed after seed');
      boot.fail(generation, markError);
      completion.resolve({ kind: 'error', message: markError.message });
      await completion.promise;

      const snapshot = boot.snapshot();
      expect(snapshot.kind).toBe('error-with-work');
      if (snapshot.kind !== 'error-with-work') throw new Error('Expected error-with-work state.');
      expect(snapshot.candidate).toBe(session);
      expect(snapshot.promise).toBe(completion.promise);
      expect(snapshot.error).toBe(markError);
      expect(session.queue.hasPending()).toBe(true);
      expect(Object.values(session.getState().pages)).toHaveLength(1);
    } finally {
      await session.close();
    }
  });

  it('does not claim no-session when a candidate exists or session settlement lacks one', () => {
    const missing = createBootState<object>();
    const missingGeneration = missing.begin();
    const missingPromise = Promise.resolve({ kind: 'ready' });
    missing.knowPromise(missingGeneration, missingPromise);
    const opening = missing.snapshot();
    expect(() => missing.settle(missingGeneration, { kind: 'session' })).toThrow(
      'Workspace boot settled without an accepted session.',
    );
    expect(missing.snapshot()).toBe(opening);
    expect(missing.snapshot()).toMatchObject({
      kind: 'opening',
      generation: missingGeneration,
      promise: missingPromise,
      candidate: null,
    });

    const contradictory = createBootState<object>();
    const generation = contradictory.begin();
    const promise = Promise.resolve({ kind: 'choose' });
    const candidate = {};
    const error = new Error('boot reported no session after retaining work');
    contradictory.knowPromise(generation, promise);
    contradictory.retainCandidate(generation, candidate);
    contradictory.settle(generation, { kind: 'no-session', reason: 'choose', error });

    const snapshot = contradictory.snapshot();
    expect(snapshot.kind).toBe('error-with-work');
    if (snapshot.kind !== 'error-with-work') throw new Error('Expected error-with-work state.');
    expect(snapshot.promise).toBe(promise);
    expect(snapshot.candidate).toBe(candidate);
    expect(snapshot.error).toBe(error);
  });

  it('settles an error before any candidate as no-session with the original promise', () => {
    const boot = createBootState<object>();
    const generation = boot.begin();
    const promise = Promise.resolve({ kind: 'error' });
    const error = new Error('vault open failed before a session existed');
    boot.knowPromise(generation, promise);
    boot.fail(generation, error);

    expect(boot.snapshot()).toMatchObject({
      kind: 'settled-no-session',
      generation,
      promise,
      reason: 'error',
      error,
    });
  });

  it('ignores callbacks from an older generation without replacing the current opening', () => {
    const boot = createBootState<{ id: string }>();
    const older = boot.begin();
    const olderPromise = Promise.resolve({ kind: 'old' });
    const olderCandidate = { id: 'old-session' };
    boot.knowPromise(older, olderPromise);
    boot.retainCandidate(older, olderCandidate);

    const current = boot.begin();
    expect(current).toBeGreaterThan(older);
    const beforeStaleCallbacks = boot.snapshot();
    boot.knowPromise(older, Promise.resolve({ kind: 'stale' }));
    expect(boot.retainCandidate(older, { id: 'stale-session' })).toBe(false);
    boot.settle(older, { kind: 'session' });
    boot.fail(older, new Error('stale failure'));
    expect(boot.snapshot()).toBe(beforeStaleCallbacks);

    const promise = Promise.resolve({ kind: 'current' });
    const candidate = { id: 'current-session' };
    boot.knowPromise(current, promise);
    boot.retainCandidate(current, candidate);
    boot.settle(current, { kind: 'session' });
    expect(boot.snapshot()).toMatchObject({
      kind: 'session',
      generation: current,
      promise,
      candidate,
    });
  });
});
