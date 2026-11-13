// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import type { VaultOp, VaultOpResult } from '../core/vault/plan';
import { MemoryVault } from '../storage/memoryVault';
import { WorkspaceSession } from '../storage/session';
import { VaultRepository } from '../storage/vaultRepository';
import { acquireExitInteractionGate, isExitInteractionBlocked } from './exitInteraction';
import { createBootState } from './bootState';
import { createExitPreparer, reloadAfterPreparation } from './exitPreparation';
import type { ExitPreparationDependencies, ExitPreparationResult } from './exitPreparation';
import { runAction } from './actions';
import {
  getSession as getWorkspaceSession,
  getWorkspaceSessionGeneration,
  setSession,
} from './workspace';
import { getExitPreparer, registerExitPreparer } from './exitPreparationRegistry';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let nextId = 0;
const sessions = new Set<WorkspaceSession>();
const leases: Array<{ release(): void }> = [];

async function openSession(
  vault = new MemoryVault(),
): Promise<{ session: WorkspaceSession; vault: MemoryVault }> {
  const opened = await WorkspaceSession.open(
    new VaultRepository(vault, () => `exit-preparation-${++nextId}`),
    { delayMs: 60_000 },
  );
  if (!opened.ok) throw new Error(opened.error);
  sessions.add(opened.value);
  return { session: opened.value, vault };
}

function stagePage(session: WorkspaceSession): string {
  const id = `exit-preparation-page-${++nextId}`;
  const result = session.execute({
    type: 'page.create',
    id,
    parentId: null,
    title: 'Pending page',
    now: nextId,
    doc: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Pending page body' }] }],
    },
  });
  if (!result.ok) throw new Error(result.error);
  return id;
}

function sessionBoot(session: WorkspaceSession, outcome: 'session' | 'error' = 'session') {
  const boot = createBootState<WorkspaceSession>();
  const generation = boot.begin();
  boot.retainCandidate(generation, session);
  if (outcome === 'session') boot.settle(generation, { kind: 'session' });
  else boot.fail(generation, new Error('boot failed after retaining the workspace'));
  return boot;
}

function noSessionBoot() {
  const boot = createBootState<WorkspaceSession>();
  const generation = boot.begin();
  boot.settle(generation, { kind: 'no-session', reason: 'error' });
  return boot;
}

function preparationDependencies(
  boot: ReturnType<typeof createBootState<WorkspaceSession>>,
  options: {
    generation?: number;
    getGeneration?: () => number;
    session?: WorkspaceSession;
    getSession?: () => WorkspaceSession;
    commitEditors?: () => boolean;
    flushPlaces?: () => void;
    backup?: () => Promise<void>;
  } = {},
): ExitPreparationDependencies<WorkspaceSession> {
  return {
    getBootSnapshot: () => boot.snapshot(),
    getWorkspaceSessionGeneration: options.getGeneration ?? (() => options.generation ?? 1),
    getSession:
      options.getSession ??
      (() => {
        if (!options.session) throw new Error('Workspace is not open.');
        return options.session;
      }),
    commitEditors: options.commitEditors ?? (() => true),
    flushPlaces: options.flushPlaces ?? (() => {}),
    acquireInteractionGate: acquireExitInteractionGate,
    writeAutoBackup: options.backup ?? (async () => {}),
  };
}

function trackLease(
  result: ExitPreparationResult<WorkspaceSession>,
): ExitPreparationResult<WorkspaceSession> {
  if (result.ok) leases.push(result.lease);
  return result;
}

afterEach(async () => {
  for (const lease of leases.splice(0)) lease.release();
  for (const session of sessions) await session.close();
  sessions.clear();
  document.body.replaceChildren();
});

describe('private exit preparation', () => {
  it('accepts only a terminal no-session snapshot with workspace generation zero', async () => {
    const boot = noSessionBoot();
    let getterCalls = 0;
    let placeFlushes = 0;
    const preparer = createExitPreparer(
      preparationDependencies(boot, {
        generation: 0,
        getSession: () => {
          getterCalls += 1;
          throw new Error('there is no published workspace');
        },
        flushPlaces: () => placeFlushes++,
      }),
    );

    const result = trackLease(await preparer.prepare());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`Preparation failed: ${result.reason}`);
    expect(result.lease.session).toBeNull();
    expect(getterCalls).toBe(0);
    expect(placeFlushes).toBe(1);
    expect(isExitInteractionBlocked()).toBe(true);
    result.lease.release();
    expect(isExitInteractionBlocked()).toBe(false);
  });

  it('refuses idle and opening boot states before committing editors', async () => {
    const idle = createBootState<WorkspaceSession>();
    const opening = createBootState<WorkspaceSession>();
    opening.begin();
    for (const boot of [idle, opening]) {
      let commits = 0;
      const result = await createExitPreparer(
        preparationDependencies(boot, { generation: 0, commitEditors: () => (commits += 1) > 0 }),
      ).prepare();

      expect(result).toEqual({ ok: false, reason: 'boot-not-ready' });
      expect(commits).toBe(0);
      expect(isExitInteractionBlocked()).toBe(false);
    }
  });

  it('flushes a retained pre-setSession candidate after boot error and skips the global backup', async () => {
    const { session, vault } = await openSession();
    const pageId = stagePage(session);
    const boot = sessionBoot(session, 'error');
    let backups = 0;
    let getterCalls = 0;
    const preparer = createExitPreparer(
      preparationDependencies(boot, {
        generation: 0,
        getSession: () => {
          getterCalls += 1;
          throw new Error('candidate has not been published globally');
        },
        backup: async () => {
          backups += 1;
        },
      }),
    );

    const result = trackLease(await preparer.prepare());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`Preparation failed: ${result.reason}`);
    expect(result.lease.session).toBe(session);
    expect(getterCalls).toBe(0);
    expect(backups).toBe(0);
    expect(session.queue.hasPending()).toBe(false);
    expect(vault.text(session.pathOf(pageId)!)).toContain('Pending page body');
    expect(session.isMutationFenced).toBe(true);
    result.lease.release();
  });

  it('commits a globally published session, then runs its best-effort backup under both gates', async () => {
    const { session } = await openSession();
    setSession(session);
    const boot = sessionBoot(session);
    let backups = 0;
    const fenceStatesDuringCommit: boolean[] = [];
    const preparer = createExitPreparer(
      preparationDependencies(boot, {
        getGeneration: getWorkspaceSessionGeneration,
        getSession: getWorkspaceSession,
        commitEditors: () => {
          fenceStatesDuringCommit.push(session.isMutationFenced);
          return true;
        },
        backup: async () => {
          backups += 1;
        },
      }),
    );

    const result = trackLease(await preparer.prepare());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`Preparation failed: ${result.reason}`);
    expect(backups).toBe(1);
    expect(fenceStatesDuringCommit).toEqual([false]);
    expect(result.lease.session).toBe(session);
    expect(session.isMutationFenced).toBe(true);
    expect(isExitInteractionBlocked()).toBe(true);
    result.lease.release();
  });

  it('preserves pending work when editor commit returns false or throws before the session fence', async () => {
    for (const commitEditors of [
      () => false,
      () => {
        throw new Error('editor still has an uncommitted draft');
      },
    ]) {
      const { session } = await openSession();
      stagePage(session);
      const boot = sessionBoot(session, 'error');
      const actualFlush = session.flush.bind(session);
      let flushCalls = 0;
      session.flush = async () => {
        flushCalls += 1;
        return actualFlush();
      };
      const result = trackLease(
        await createExitPreparer(
          preparationDependencies(boot, { generation: 0, session, commitEditors }),
        ).prepare(),
      );

      expect(result.ok).toBe(false);
      if (result.ok) result.lease.release();
      expect(session.isMutationFenced).toBe(false);
      expect(session.queue.hasPending()).toBe(true);
      expect(flushCalls).toBe(0);
      expect(isExitInteractionBlocked()).toBe(false);
    }
  });

  it('rejects a real reentrant SaveQueue batch left pending after one flush', async () => {
    class BlockingMemoryVault extends MemoryVault {
      readonly firstWriteStarted = deferred<void>();
      readonly finishFirstWrite = deferred<void>();
      applyCalls = 0;

      override async apply(ops: VaultOp[]): Promise<VaultOpResult[]> {
        this.applyCalls += 1;
        if (this.applyCalls === 1) {
          this.firstWriteStarted.resolve();
          await this.finishFirstWrite.promise;
        }
        return super.apply(ops);
      }
    }

    const vault = new BlockingMemoryVault();
    const { session } = await openSession(vault);
    const pageId = stagePage(session);
    const boot = sessionBoot(session);
    let reentered = false;
    const unsubscribe = session.queue.subscribe(() => {
      if (reentered || session.queue.status.state !== 'saving') return;
      reentered = true;
      session.queue.enqueue({ pages: new Set([pageId]), docs: new Set(), removed: new Set() }, [pageId]);
    });
    const preparer = createExitPreparer(preparationDependencies(boot, { generation: 1, session }));
    const preparing = preparer.prepare();

    await vault.firstWriteStarted.promise;
    expect(reentered).toBe(true);
    expect(session.queue.hasPending()).toBe(true);
    expect(session.isMutationFenced).toBe(true);
    expect(isExitInteractionBlocked()).toBe(true);
    vault.finishFirstWrite.resolve();
    const result = trackLease(await preparing);
    unsubscribe();

    expect(result).toEqual({ ok: false, reason: 'flush-failed' });
    expect(vault.applyCalls).toBe(1);
    expect(session.queue.hasPending()).toBe(true);
    expect(session.isMutationFenced).toBe(false);
    expect(isExitInteractionBlocked()).toBe(false);
  });

  it('keeps the UI gate and session fence through a pending backup and blocks further edits', async () => {
    const { session } = await openSession();
    setSession(session);
    const boot = sessionBoot(session);
    const input = document.createElement('input');
    input.value = 'unsaved draft';
    document.body.append(input);
    const backupStarted = deferred<void>();
    const finishBackup = deferred<void>();
    const preparer = createExitPreparer(
      preparationDependencies(boot, {
        getGeneration: getWorkspaceSessionGeneration,
        getSession: getWorkspaceSession,
        backup: async () => {
          backupStarted.resolve();
          await finishBackup.promise;
        },
      }),
    );
    const preparing = preparer.prepare();

    await backupStarted.promise;
    expect(isExitInteractionBlocked()).toBe(true);
    expect(session.isMutationFenced).toBe(true);
    const inputEvent = new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: 'x' });
    input.dispatchEvent(inputEvent);
    expect(inputEvent.defaultPrevented).toBe(true);
    expect(input.value).toBe('unsaved draft');
    const beforeCount = Object.keys(session.getState().pages).length;
    runAction('page.new');
    expect(Object.keys(session.getState().pages)).toHaveLength(beforeCount);
    const refused = session.execute({
      type: 'page.create',
      id: `blocked-${++nextId}`,
      parentId: null,
      title: 'Blocked while preparing exit',
      now: nextId,
    });
    expect(refused.ok).toBe(false);
    expect(Object.keys(session.getState().pages)).toHaveLength(beforeCount);
    finishBackup.resolve();
    const result = trackLease(await preparing);

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      result.lease.release();
    }
  });

  it('revalidates the captured session after backup finishes and releases only its own lease', async () => {
    const { session: original } = await openSession();
    const { session: replacement } = await openSession();
    setSession(original);
    const boot = sessionBoot(original);
    const backupStarted = deferred<void>();
    const finishBackup = deferred<void>();
    const preparer = createExitPreparer(
      preparationDependencies(boot, {
        getGeneration: getWorkspaceSessionGeneration,
        getSession: () => getWorkspaceSession(),
        backup: async () => {
          backupStarted.resolve();
          await finishBackup.promise;
        },
      }),
    );
    const preparing = preparer.prepare();

    await backupStarted.promise;
    setSession(replacement);
    finishBackup.resolve();
    const result = await preparing;

    expect(result).toEqual({ ok: false, reason: 'session-changed' });
    expect(original.isMutationFenced).toBe(false);
    expect(replacement.isMutationFenced).toBe(false);
    expect(isExitInteractionBlocked()).toBe(false);
  });

  it('refuses a concurrent preparer call and releases idempotently after the caller is done', async () => {
    const { session } = await openSession();
    const boot = sessionBoot(session);
    const backupStarted = deferred<void>();
    const finishBackup = deferred<void>();
    const preparer = createExitPreparer(
      preparationDependencies(boot, {
        generation: 1,
        session,
        backup: async () => {
          backupStarted.resolve();
          await finishBackup.promise;
        },
      }),
    );
    const first = preparer.prepare();
    await backupStarted.promise;
    const overlap = await preparer.prepare();

    expect(overlap).toEqual({ ok: false, reason: 'busy' });
    expect(session.isMutationFenced).toBe(true);
    finishBackup.resolve();
    const result = trackLease(await first);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`Preparation failed: ${result.reason}`);
    result.lease.release();
    result.lease.release();
    expect(session.isMutationFenced).toBe(false);
    expect(isExitInteractionBlocked()).toBe(false);
  });

  it('retries only after preparation succeeds and retains the lease until reload', async () => {
    let reloads = 0;
    const failed = await reloadAfterPreparation(
      async () => ({ ok: false, reason: 'commit-failed' }),
      () => reloads++,
    );
    const thrown = await reloadAfterPreparation(
      async () => {
        throw new Error('preparation failed');
      },
      () => reloads++,
    );
    expect(failed).toBe(false);
    expect(thrown).toBe(false);
    expect(reloads).toBe(0);

    const { session } = await openSession();
    const boot = sessionBoot(session, 'error');
    const preparer = createExitPreparer(preparationDependencies(boot, { generation: 0, session }));
    const results: ExitPreparationResult<WorkspaceSession>[] = [];
    const reloaded = await reloadAfterPreparation(
      async () => {
        const result = trackLease(await preparer.prepare());
        results.push(result);
        return result;
      },
      () => {
        reloads += 1;
        expect(isExitInteractionBlocked()).toBe(true);
        expect(session.isMutationFenced).toBe(true);
      },
    );

    expect(reloaded).toBe(true);
    expect(reloads).toBe(1);
    expect(isExitInteractionBlocked()).toBe(true);
    expect(session.isMutationFenced).toBe(true);
    const result = results[0];
    if (result?.ok) {
      result.lease.release();
    }
  });

  it('releases the successful lease if the reload callback itself throws', async () => {
    const { session } = await openSession();
    const boot = sessionBoot(session, 'error');
    const preparer = createExitPreparer(preparationDependencies(boot, { generation: 0, session }));
    const reloaded = await reloadAfterPreparation(
      () => preparer.prepare(),
      () => {
        throw new Error('reload was rejected');
      },
    );

    expect(reloaded).toBe(false);
    expect(session.isMutationFenced).toBe(false);
    expect(isExitInteractionBlocked()).toBe(false);
  });

  it('keeps a newer registration when cleanup from the same older preparer runs', async () => {
    const { session } = await openSession();
    const preparer = createExitPreparer(
      preparationDependencies(sessionBoot(session, 'error'), { generation: 0, session }),
    );
    const cleanupOlder = registerExitPreparer(preparer);
    const cleanupNewer = registerExitPreparer(preparer);

    cleanupOlder();
    expect(getExitPreparer()).toBe(preparer);
    cleanupNewer();
    expect(getExitPreparer()).toBeNull();
  });
});
