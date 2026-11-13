import type { BootSnapshot } from './bootState';

export interface ExitPreparationSession {
  flush(): Promise<boolean>;
  beginMutationFence(): () => void;
}

export interface ExitPreparationLease<Session> {
  readonly session: Session | null;
  release(): void;
}

export type ExitPreparationFailureReason =
  | 'busy'
  | 'boot-not-ready'
  | 'session-unknown'
  | 'commit-failed'
  | 'flush-failed'
  | 'session-changed'
  | 'preparation-failed';

export type ExitPreparationResult<Session> =
  | { ok: true; lease: ExitPreparationLease<Session> }
  | { ok: false; reason: ExitPreparationFailureReason };

export interface ExitPreparer<Session extends ExitPreparationSession = ExitPreparationSession> {
  prepare(): Promise<ExitPreparationResult<Session>>;
}

export interface ExitPreparationDependencies<Session extends ExitPreparationSession> {
  getBootSnapshot(): BootSnapshot<Session>;
  getWorkspaceSessionGeneration(): number;
  getSession(): Session;
  commitEditors(): boolean;
  flushPlaces(): void;
  acquireInteractionGate(): () => void;
  writeAutoBackup(): Promise<void>;
}

interface CapturedTarget<Session> {
  readonly boot: BootSnapshot<Session>;
  readonly workspaceGeneration: number;
  readonly session: Session | null;
  readonly backupAllowed: boolean;
}

/**
 * Creates one private preparation lease owner for an entrypoint. Successful leases hold the
 * interaction gate and session fence until the eventual caller has a safe ACK or reload boundary.
 */
export function createExitPreparer<Session extends ExitPreparationSession>(
  dependencies: ExitPreparationDependencies<Session>,
): ExitPreparer<Session> {
  let busy = false;

  function captureTarget(): CapturedTarget<Session> | ExitPreparationFailureReason {
    const boot = dependencies.getBootSnapshot();
    if (boot.kind === 'idle' || boot.kind === 'opening') return 'boot-not-ready';

    const workspaceGeneration = dependencies.getWorkspaceSessionGeneration();
    if (boot.kind === 'settled-no-session') {
      if (workspaceGeneration !== 0) return 'session-unknown';
      return { boot, workspaceGeneration, session: null, backupAllowed: false };
    }

    const session = boot.candidate;
    if (workspaceGeneration === 0) {
      if (boot.kind !== 'error-with-work') return 'session-unknown';
      return { boot, workspaceGeneration, session, backupAllowed: false };
    }

    try {
      if (dependencies.getSession() !== session) return 'session-unknown';
    } catch {
      return 'session-unknown';
    }
    return { boot, workspaceGeneration, session, backupAllowed: true };
  }

  function isCurrent(target: CapturedTarget<Session>): boolean {
    const boot = dependencies.getBootSnapshot();
    if (boot.kind !== target.boot.kind || boot.generation !== target.boot.generation) return false;
    if (
      (boot.kind === 'session' || boot.kind === 'error-with-work') &&
      boot.candidate !== target.session
    )
      return false;
    if (dependencies.getWorkspaceSessionGeneration() !== target.workspaceGeneration) return false;

    if (target.session && target.workspaceGeneration > 0) {
      try {
        return dependencies.getSession() === target.session;
      } catch {
        return false;
      }
    }

    return true;
  }

  async function prepare(): Promise<ExitPreparationResult<Session>> {
    if (busy) return { ok: false, reason: 'busy' };
    busy = true;

    let releaseInteraction: (() => void) | null = null;
    let releaseFence: (() => void) | null = null;
    let released = false;

    const release = (): void => {
      if (released) return;
      released = true;
      try {
        // Keep the session fence active while the UI gate restores focus and event handling.
        releaseInteraction?.();
      } catch {
        // A caller-owned gate cleanup cannot strand the session fence or preparer instance.
      }
      try {
        releaseFence?.();
      } catch {
        // Continue to free this preparer's own busy slot even if a cleanup callback fails.
      }
      busy = false;
    };

    const failed = (reason: ExitPreparationFailureReason): ExitPreparationResult<Session> => {
      release();
      return { ok: false, reason };
    };

    try {
      const captured = captureTarget();
      if (typeof captured === 'string') return failed(captured);

      releaseInteraction = dependencies.acquireInteractionGate();
      let committed: boolean;
      try {
        committed = dependencies.commitEditors();
      } catch {
        return failed('commit-failed');
      }
      if (committed !== true) return failed('commit-failed');
      if (!isCurrent(captured)) return failed('session-changed');

      if (captured.session) {
        releaseFence = captured.session.beginMutationFence();
        if (!isCurrent(captured)) return failed('session-changed');
      }

      dependencies.flushPlaces();
      if (!isCurrent(captured)) return failed('session-changed');

      if (captured.session) {
        let persisted: boolean;
        try {
          persisted = await captured.session.flush();
        } catch {
          if (!isCurrent(captured)) return failed('session-changed');
          return failed('flush-failed');
        }
        if (!isCurrent(captured)) return failed('session-changed');
        if (persisted !== true) return failed('flush-failed');

        if (captured.backupAllowed) {
          try {
            await dependencies.writeAutoBackup();
          } catch {
            // The backup is best-effort and does not establish whether the session was saved.
          }
          if (!isCurrent(captured)) return failed('session-changed');
        }
      }

      if (!isCurrent(captured)) return failed('session-changed');
      return {
        ok: true,
        lease: {
          session: captured.session,
          release,
        },
      };
    } catch {
      return failed('preparation-failed');
    }
  }

  return { prepare };
}

/** Run the existing boot retry only after the private preparer returns a held lease. */
export async function reloadAfterPreparation<Session extends ExitPreparationSession>(
  prepare: () => Promise<ExitPreparationResult<Session>>,
  reload: () => void,
): Promise<boolean> {
  let result: ExitPreparationResult<Session>;
  try {
    result = await prepare();
  } catch {
    return false;
  }
  if (!result.ok) return false;

  try {
    reload();
    return true;
  } catch {
    result.lease.release();
    return false;
  }
}
