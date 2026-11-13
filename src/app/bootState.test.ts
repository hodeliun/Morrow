import { describe, expect, it } from 'vitest';
import { sampleCommands } from '../core/sample';
import { MemoryVault } from '../storage/memoryVault';
import { WorkspaceSession } from '../storage/session';
import { VaultRepository } from '../storage/vaultRepository';
import { createBootState } from './bootState';

let fixtureId = 0;
const newId = () => `boot-state-${++fixtureId}`;

async function openSyntheticSession(): Promise<WorkspaceSession> {
  const opened = await WorkspaceSession.open(new VaultRepository(new MemoryVault(), newId), {
    delayMs: 60_000,
  });
  if (!opened.ok) throw new Error(opened.error);
  return opened.value;
}

describe('private workspace boot state', () => {
  it('records a known promise while the current generation is still opening', () => {
    const boot = createBootState<{ id: string }>();
    expect(boot.snapshot()).toEqual({ kind: 'idle', generation: 0 });

    const generation = boot.begin();
    const promise = Promise.resolve('boot');
    boot.knowPromise(generation, promise);

    expect(boot.snapshot()).toEqual({
      kind: 'opening',
      generation,
      promise,
      candidate: null,
    });
  });

  it('settles without a session only when no candidate was accepted', () => {
    const boot = createBootState<object>();
    const generation = boot.begin();
    const promise = Promise.resolve();
    boot.knowPromise(generation, promise);

    boot.settle(generation, { kind: 'no-session', reason: 'choose' });

    expect(boot.snapshot()).toEqual({
      kind: 'settled-no-session',
      generation,
      promise,
      reason: 'choose',
    });
  });

  it('preserves the exact accepted session and its seeded work when later boot work fails', async () => {
    const boot = createBootState<WorkspaceSession>();
    const generation = boot.begin();
    const promise = Promise.resolve('boot');
    boot.knowPromise(generation, promise);

    const session = await openSyntheticSession();
    expect(session.firstRun).toBe(true);
    expect(boot.retainCandidate(generation, session)).toBe(true);

    const seeded = session.executeAll(sampleCommands(newId, Date.UTC(2026, 10, 13)));
    if (!seeded.ok) throw new Error(seeded.error);
    const acceptedState = session.getState();
    expect(Object.keys(acceptedState.pages).length).toBeGreaterThan(0);

    await session.flush();
    await session.markInitialized();
    const error = new Error('synthetic post-initialization failure');
    boot.fail(generation, error);

    const snapshot = boot.snapshot();
    expect(snapshot.kind).toBe('error-with-work');
    if (snapshot.kind !== 'error-with-work') throw new Error('expected a candidate after the failure');
    expect(snapshot.candidate).toBe(session);
    expect(snapshot.promise).toBe(promise);
    expect(snapshot.error).toBe(error);
    expect(session.getState()).toBe(acceptedState);
    expect(session.getState().pages).toEqual(acceptedState.pages);
  });

  it('settles as a session only with the retained candidate', () => {
    const boot = createBootState<object>();
    const generation = boot.begin();
    const promise = Promise.resolve();
    const candidate = { id: 'candidate' };
    boot.knowPromise(generation, promise);
    boot.retainCandidate(generation, candidate);

    boot.settle(generation, { kind: 'session' });

    expect(boot.snapshot()).toEqual({ kind: 'session', generation, promise, candidate });
  });

  it('does not discard a candidate if a no-session settlement arrives afterward', () => {
    const boot = createBootState<object>();
    const generation = boot.begin();
    const promise = Promise.resolve();
    const candidate = { id: 'candidate' };
    const error = new Error('the no-session result conflicts with accepted work');
    boot.knowPromise(generation, promise);
    boot.retainCandidate(generation, candidate);

    boot.settle(generation, { kind: 'no-session', reason: 'choose', error });

    expect(boot.snapshot()).toEqual({ kind: 'error-with-work', generation, promise, candidate, error });
  });

  it('refuses a different candidate for the same generation', () => {
    const boot = createBootState<object>();
    const generation = boot.begin();
    const candidate = { id: 'first' };
    boot.retainCandidate(generation, candidate);

    expect(boot.retainCandidate(generation, candidate)).toBe(true);
    expect(() => boot.retainCandidate(generation, { id: 'replacement' })).toThrow(
      'Workspace boot candidate cannot be replaced within a generation.',
    );
    const snapshot = boot.snapshot();
    expect(snapshot.kind).toBe('opening');
    if (snapshot.kind === 'opening') expect(snapshot.candidate).toBe(candidate);
  });

  it('rejects a missing-candidate session settlement without changing the opening snapshot', () => {
    const boot = createBootState<object>();
    const generation = boot.begin();
    const promise = Promise.resolve();
    boot.knowPromise(generation, promise);
    const opening = boot.snapshot();

    expect(() => boot.settle(generation, { kind: 'session' })).toThrow(
      'Workspace boot settled without an accepted session.',
    );

    expect(boot.snapshot()).toBe(opening);
  });

  it('ignores stale promise, candidate, and completion callbacks from an older generation', () => {
    const boot = createBootState<object>();
    const oldGeneration = boot.begin();
    const oldPromise = Promise.resolve('old');
    const oldCandidate = { id: 'old' };
    const generation = boot.begin();
    const promise = Promise.resolve('current');
    boot.knowPromise(generation, promise);

    boot.knowPromise(oldGeneration, oldPromise);
    expect(boot.retainCandidate(oldGeneration, oldCandidate)).toBe(false);
    boot.settle(oldGeneration, { kind: 'session' });
    boot.fail(oldGeneration, new Error('stale failure'));

    expect(boot.snapshot()).toEqual({ kind: 'opening', generation, promise, candidate: null });
  });
});
