import type { WorkspaceSession } from '../storage/session';

export type BootNoSessionReason = 'desktopOnly' | 'choose' | 'error';

export type BootSettlement =
  { kind: 'session' } | { kind: 'no-session'; reason: BootNoSessionReason; error?: unknown };

export type BootSnapshot<Session> =
  | { kind: 'idle'; generation: 0 }
  | {
      kind: 'opening';
      generation: number;
      promise: Promise<unknown> | null;
      candidate: Session | null;
    }
  | {
      kind: 'settled-no-session';
      generation: number;
      promise: Promise<unknown> | null;
      reason: BootNoSessionReason;
      error?: unknown;
    }
  | {
      kind: 'session';
      generation: number;
      promise: Promise<unknown> | null;
      candidate: Session;
    }
  | {
      kind: 'error-with-work';
      generation: number;
      promise: Promise<unknown> | null;
      candidate: Session;
      error: unknown;
    };

const missingCandidateError = () => new Error('Workspace boot settled without an accepted session.');
const retainedCandidateError = () =>
  new Error('Workspace boot settled without a session after accepting a candidate.');

/**
 * Tracks the private session candidate while the desktop workspace boot finishes.
 * The caller still owns start deduplication; generations only make stale callbacks inert.
 */
export function createBootState<Session>() {
  let nextGeneration = 0;
  let current: BootSnapshot<Session> = { kind: 'idle', generation: 0 };

  function begin(): number {
    const generation = ++nextGeneration;
    current = { kind: 'opening', generation, promise: null, candidate: null };
    return generation;
  }

  function knowPromise(generation: number, promise: Promise<unknown>): void {
    if (current.kind !== 'opening' || current.generation !== generation) return;
    if (current.promise && current.promise !== promise) {
      throw new Error('Workspace boot promise cannot be replaced within a generation.');
    }
    current = { ...current, promise };
  }

  function retainCandidate(generation: number, candidate: Session): boolean {
    if (current.kind !== 'opening' || current.generation !== generation) return false;
    if (current.candidate !== null) {
      if (current.candidate !== candidate) {
        throw new Error('Workspace boot candidate cannot be replaced within a generation.');
      }
      return true;
    }
    current = { ...current, candidate };
    return true;
  }

  function settle(generation: number, outcome: BootSettlement): void {
    if (current.kind !== 'opening' || current.generation !== generation) return;
    const { promise, candidate } = current;

    if (outcome.kind === 'session') {
      if (!candidate) throw missingCandidateError();
      current = { kind: 'session', generation, promise, candidate };
      return;
    }

    if (candidate) {
      current = {
        kind: 'error-with-work',
        generation,
        promise,
        candidate,
        error: outcome.error ?? retainedCandidateError(),
      };
      return;
    }

    current = {
      kind: 'settled-no-session',
      generation,
      promise,
      reason: outcome.reason,
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    };
  }

  function fail(generation: number, error: unknown): void {
    if (current.kind !== 'opening' || current.generation !== generation) return;
    const { promise, candidate } = current;
    if (candidate) {
      current = { kind: 'error-with-work', generation, promise, candidate, error };
      return;
    }
    current = { kind: 'settled-no-session', generation, promise, reason: 'error', error };
  }

  function snapshot(): BootSnapshot<Session> {
    return current;
  }

  return { begin, knowPromise, retainCandidate, settle, fail, snapshot };
}

export const workspaceBootState = createBootState<WorkspaceSession>();
