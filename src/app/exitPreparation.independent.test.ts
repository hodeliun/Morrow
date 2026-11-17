// @vitest-environment happy-dom
import type { Editor } from '@tiptap/core';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { docToMarkdown } from '../core/markdown/serialize';
import type { PageId } from '../core/model';
import { MemoryVault } from '../storage/memoryVault';
import { WorkspaceSession } from '../storage/session';
import { VaultRepository } from '../storage/vaultRepository';
import { acquireExitInteractionGate, isExitInteractionBlocked } from './exitInteraction';
import { createBootState } from './bootState';
import { createExitPreparer, reloadAfterPreparation } from './exitPreparation';
import type { ExitPreparationDependencies } from './exitPreparation';
import { PageEditor } from './editor/PageEditor';
import { captureEditorInsertionTarget } from './editor/editorInsertion';
import type { EditorInsertionOwner } from './editor/editorInsertion';
import { commitEditors, registerCommit, setFocusedEditor } from './editor/commits';
import { getPreferences, setPreferences } from './platform/preferences';
import { PaneContext, closeSide, setActivePane, startTabs } from './tabs';
import { navigate } from './router';
import { runAction } from './actions';
import { getSession, getWorkspaceSessionGeneration, setSession } from './workspace';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type TestBootState = ReturnType<typeof createBootState<WorkspaceSession>>;
type TestPreparer = ReturnType<typeof createExitPreparer<WorkspaceSession>>;
type TestPreparation = Awaited<ReturnType<TestPreparer['prepare']>>;

let nextSessionId = 0;
const sessions = new Set<WorkspaceSession>();
const heldLeases = new Set<{ release(): void }>();
const gateReleases = new Set<() => void>();
const unregisterCommits = new Set<() => void>();
const targets = new Set<NonNullable<ReturnType<typeof captureEditorInsertionTarget>>>();
const harnesses = new Set<PageEditorHarness>();
const tabStops = new Set<() => void>();
let preferencesBeforeTest = getPreferences();

interface PageEditorHarness {
  readonly container: HTMLElement;
  readonly editor: Editor | null;
  render(): Promise<void>;
  unmount(): Promise<void>;
}

interface OpenedSession {
  readonly session: WorkspaceSession;
  readonly vault: MemoryVault;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForPhase<T>(phase: Promise<void>, operation: Promise<T>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      phase,
      operation.then(() => {
        throw new Error(`Preparation finished before reaching ${label}.`);
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 2_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function acquireTrackedInteractionGate(): () => void {
  const release = acquireExitInteractionGate();
  let active = true;
  const wrapped = () => {
    if (!active) return;
    active = false;
    release();
    gateReleases.delete(wrapped);
  };
  gateReleases.add(wrapped);
  return wrapped;
}

function createPreparer(
  boot: TestBootState,
  overrides: Partial<ExitPreparationDependencies<WorkspaceSession>> = {},
): TestPreparer {
  const defaults: ExitPreparationDependencies<WorkspaceSession> = {
    getBootSnapshot: () => boot.snapshot(),
    getWorkspaceSessionGeneration: () => 0,
    getSession: () => {
      throw new Error('No global workspace session is installed.');
    },
    commitEditors: () => true,
    flushPlaces: () => {},
    acquireInteractionGate: acquireTrackedInteractionGate,
    writeAutoBackup: async () => {},
  };
  return createExitPreparer<WorkspaceSession>({ ...defaults, ...overrides });
}

function idleBoot(): TestBootState {
  return createBootState<WorkspaceSession>();
}

function openingBoot(): TestBootState {
  const boot = createBootState<WorkspaceSession>();
  const generation = boot.begin();
  const pending = deferred<void>();
  boot.knowPromise(generation, pending.promise);
  return boot;
}

function noSessionBoot(): TestBootState {
  const boot = createBootState<WorkspaceSession>();
  const generation = boot.begin();
  boot.knowPromise(generation, Promise.resolve());
  boot.settle(generation, { kind: 'no-session', reason: 'choose' });
  return boot;
}

function sessionBoot(session: WorkspaceSession, outcome: 'session' | 'error-with-work' = 'session') {
  const boot = createBootState<WorkspaceSession>();
  const generation = boot.begin();
  boot.knowPromise(generation, Promise.resolve());
  boot.retainCandidate(generation, session);
  if (outcome === 'session') boot.settle(generation, { kind: 'session' });
  else boot.fail(generation, new Error('Synthetic post-open boot failure.'));
  return boot;
}

function firstPageId(session: WorkspaceSession): PageId {
  const id = Object.keys(session.getState().pages)[0];
  if (!id) throw new Error('Expected the synthetic workspace to contain one page.');
  return id as PageId;
}

async function openSession(
  vault: MemoryVault = new MemoryVault({ 'Synthetic note.md': '# Note\n\nOriginal text.\n' }),
): Promise<OpenedSession> {
  const opened = await WorkspaceSession.open(
    new VaultRepository(vault, () => `exit-preparation-${++nextSessionId}`),
    { delayMs: 60_000 },
  );
  if (!opened.ok) throw new Error(opened.error);
  sessions.add(opened.value);
  return { session: opened.value, vault };
}

function addPageField(session: WorkspaceSession, pageId: PageId, value: string): void {
  const result = session.execute({
    type: 'page.setFields',
    id: pageId,
    extra: { preparationDraft: value },
    now: Date.now(),
  });
  if (!result.ok) throw new Error(result.error);
}

function mountPageEditor(session: WorkspaceSession, pageId: PageId): PageEditorHarness {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let editor: Editor | null = null;
  let disposed = false;
  const render = async (): Promise<void> => {
    await act(async () => {
      root.render(
        createElement(
          PaneContext.Provider,
          { value: 'main' },
          createElement(PageEditor, {
            pageId,
            doc: session.getState().docs[pageId]!,
            editable: true,
            find: null,
            onExitTop: () => {},
            onDirty: () => {},
            onReady: (readyEditor: Editor) => {
              editor = readyEditor;
            },
          }),
        ),
      );
    });
  };
  const unmount = async (): Promise<void> => {
    if (disposed) return;
    await act(async () => root.unmount());
    container.remove();
    disposed = true;
  };
  const harness: PageEditorHarness = {
    container,
    get editor() {
      return editor;
    },
    render,
    unmount,
  };
  harnesses.add(harness);
  return harness;
}

function activeOwner(): EditorInsertionOwner {
  return { generation: 1, isActive: () => true };
}

function setMainRoute(pageId: PageId): void {
  closeSide();
  setActivePane('main');
  navigate({ name: 'page', id: pageId, find: null }, { replace: true, pane: 'main' });
}

function trackLease(result: TestPreparation): TestPreparation {
  if (result.ok) heldLeases.add(result.lease);
  return result;
}

beforeEach(() => {
  preferencesBeforeTest = getPreferences();
  setPreferences({ locale: 'en', readingMode: false });
});

afterEach(async () => {
  for (const lease of [...heldLeases]) {
    lease.release();
    heldLeases.delete(lease);
  }
  for (const release of [...gateReleases]) release();
  for (const unregister of [...unregisterCommits]) {
    unregister();
    unregisterCommits.delete(unregister);
  }
  for (const target of [...targets]) {
    target.dispose();
    targets.delete(target);
  }
  for (const harness of [...harnesses]) {
    await harness.unmount();
    harnesses.delete(harness);
  }
  for (const stop of [...tabStops]) {
    stop();
    tabStops.delete(stop);
  }
  setFocusedEditor(null);
  for (const session of [...sessions]) {
    if (!session.isClosed) await session.close();
    sessions.delete(session);
  }
  closeSide();
  setActivePane('main');
  setPreferences({ locale: preferencesBeforeTest.locale, readingMode: preferencesBeforeTest.readingMode });
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('independent exit preparation checks', () => {
  it('requires conclusive no-session boot state and generation zero', async () => {
    const getSession = vi.fn(() => {
      throw new Error('A thrown getter is not proof that no session exists.');
    });
    const commitEditors = vi.fn(() => true);
    const acquireInteractionGate = vi.fn(acquireTrackedInteractionGate);

    for (const boot of [idleBoot(), openingBoot()]) {
      const result = await createPreparer(boot, {
        getSession,
        commitEditors,
        acquireInteractionGate,
      }).prepare();
      expect(result).toMatchObject({ ok: false, reason: 'boot-not-ready' });
    }

    expect(getSession).not.toHaveBeenCalled();
    expect(commitEditors).not.toHaveBeenCalled();
    expect(acquireInteractionGate).not.toHaveBeenCalled();

    const absent = await createPreparer(noSessionBoot(), {
      getWorkspaceSessionGeneration: () => 0,
      getSession,
      acquireInteractionGate,
    }).prepare();
    const successfulAbsence = trackLease(absent);
    if (!successfulAbsence.ok) throw new Error(`Expected known absence, got ${successfulAbsence.reason}.`);
    expect(successfulAbsence.lease.session).toBeNull();
    expect(getSession).not.toHaveBeenCalled();
    expect(isExitInteractionBlocked()).toBe(true);
    successfulAbsence.lease.release();
    expect(isExitInteractionBlocked()).toBe(false);

    const inconsistentAbsence = await createPreparer(noSessionBoot(), {
      getWorkspaceSessionGeneration: () => 1,
      getSession,
      acquireInteractionGate,
    }).prepare();
    expect(inconsistentAbsence).toMatchObject({ ok: false, reason: 'session-unknown' });
    expect(getSession).not.toHaveBeenCalled();

    const candidate = await openSession();
    getSession.mockClear();
    const unknown = await createPreparer(sessionBoot(candidate.session), {
      getWorkspaceSessionGeneration: () => 1,
      getSession,
      acquireInteractionGate,
    }).prepare();
    expect(unknown).toMatchObject({ ok: false, reason: 'session-unknown' });
    expect(getSession).toHaveBeenCalledOnce();
    expect(acquireInteractionGate).toHaveBeenCalledOnce();
    expect(isExitInteractionBlocked()).toBe(false);
  });

  it('flushes an error-state candidate before setSession and skips the global backup', async () => {
    const { session, vault } = await openSession();
    const pageId = firstPageId(session);
    addPageField(session, pageId, 'candidate-owned-draft');
    const getSession = vi.fn(() => {
      throw new Error('There is no global session yet.');
    });
    const writeAutoBackup = vi.fn(async () => {});

    const result = trackLease(
      await createPreparer(sessionBoot(session, 'error-with-work'), {
        getWorkspaceSessionGeneration: () => 0,
        getSession,
        writeAutoBackup,
      }).prepare(),
    );
    if (!result.ok) throw new Error(`Expected the candidate to save, got ${result.reason}.`);

    expect(result.lease.session).toBe(session);
    expect(vault.text('Synthetic note.md')).toContain('preparationDraft: candidate-owned-draft');
    expect(session.queue.hasPending()).toBe(false);
    expect(getSession).not.toHaveBeenCalled();
    expect(writeAutoBackup).not.toHaveBeenCalled();
    expect(session.isMutationFenced).toBe(true);
    expect(isExitInteractionBlocked()).toBe(true);

    result.lease.release();
    expect(session.isMutationFenced).toBe(false);
    expect(isExitInteractionBlocked()).toBe(false);
  });

  it('refuses false or throwing editor commits before fencing or flushing', async () => {
    for (const behavior of ['false', 'throw'] as const) {
      const { session } = await openSession();
      const pageId = firstPageId(session);
      addPageField(session, pageId, `held-${behavior}-draft`);
      let fencedDuringCommit: boolean | undefined;
      let blockedDuringCommit: boolean | undefined;
      const unregister = registerCommit(() => {
        fencedDuringCommit = session.isMutationFenced;
        blockedDuringCommit = isExitInteractionBlocked();
        if (behavior === 'throw') throw new Error('Synthetic editor commit failure.');
        return false;
      });
      unregisterCommits.add(unregister);
      const flushPlaces = vi.fn();
      const writeAutoBackup = vi.fn(async () => {});
      const flush = vi.spyOn(session, 'flush');

      const result = await createPreparer(sessionBoot(session, 'error-with-work'), {
        getWorkspaceSessionGeneration: () => 0,
        commitEditors,
        flushPlaces,
        writeAutoBackup,
      }).prepare();

      expect(result).toMatchObject({ ok: false, reason: 'commit-failed' });
      expect(fencedDuringCommit).toBe(false);
      expect(blockedDuringCommit).toBe(true);
      expect(session.isMutationFenced).toBe(false);
      expect(isExitInteractionBlocked()).toBe(false);
      expect(session.queue.hasPending()).toBe(true);
      expect(session.getState().pages[pageId]!.extra).toEqual({ preparationDraft: `held-${behavior}-draft` });
      expect(flush).not.toHaveBeenCalled();
      expect(flushPlaces).not.toHaveBeenCalled();
      expect(writeAutoBackup).not.toHaveBeenCalled();

      unregister();
      unregisterCommits.delete(unregister);
      flush.mockRestore();
      expect(await session.flush()).toBe(true);
    }
  });

  it('does not authorize a reentrant SaveQueue batch that remains pending', async () => {
    const applyStarted = deferred<void>();
    const finishApply = deferred<void>();
    class PausingMemoryVault extends MemoryVault {
      pauseNextApply: (() => Promise<void>) | null = null;

      override async apply(ops: Parameters<MemoryVault['apply']>[0]) {
        const pause = this.pauseNextApply;
        this.pauseNextApply = null;
        await pause?.();
        return super.apply(ops);
      }
    }

    const vault = new PausingMemoryVault({ 'Synthetic note.md': '# Note\n\nOriginal text.\n' });
    const { session } = await openSession(vault);
    const pageId = firstPageId(session);
    addPageField(session, pageId, 'reentrant-draft');
    vault.pauseNextApply = async () => {
      applyStarted.resolve(undefined);
      await finishApply.promise;
    };
    const writeAutoBackup = vi.fn(async () => {});

    const preparing = createPreparer(sessionBoot(session, 'error-with-work'), {
      getWorkspaceSessionGeneration: () => 0,
      writeAutoBackup,
    }).prepare();
    try {
      await waitForPhase(applyStarted.promise, preparing, 'the real vault write');
      expect(session.isMutationFenced).toBe(true);
      expect(isExitInteractionBlocked()).toBe(true);
      session.queue.enqueue({ pages: new Set([pageId]), docs: new Set(), removed: new Set() });
      finishApply.resolve(undefined);

      const result = await preparing;
      expect(result).toMatchObject({ ok: false, reason: 'flush-failed' });
      expect(session.queue.hasPending()).toBe(true);
      expect(writeAutoBackup).not.toHaveBeenCalled();
      expect(session.isMutationFenced).toBe(false);
      expect(isExitInteractionBlocked()).toBe(false);
      expect(await session.flush()).toBe(true);
    } finally {
      finishApply.resolve(undefined);
      await preparing.catch(() => undefined);
    }
  });

  it('refuses a rejected session flush without losing queued work or releasing someone else’s fence', async () => {
    const { session } = await openSession();
    const pageId = firstPageId(session);
    addPageField(session, pageId, 'flush-rejection-draft');
    const otherInteraction = acquireTrackedInteractionGate();
    const otherFence = session.beginMutationFence();
    const flush = vi.spyOn(session, 'flush').mockRejectedValueOnce(new Error('Synthetic flush rejection.'));
    const writeAutoBackup = vi.fn(async () => {});

    const result = await createPreparer(sessionBoot(session, 'error-with-work'), {
      getWorkspaceSessionGeneration: () => 0,
      writeAutoBackup,
    }).prepare();

    expect(result).toMatchObject({ ok: false, reason: 'flush-failed' });
    expect(flush).toHaveBeenCalledOnce();
    expect(session.isMutationFenced).toBe(true);
    expect(isExitInteractionBlocked()).toBe(true);
    expect(session.queue.hasPending()).toBe(true);
    expect(writeAutoBackup).not.toHaveBeenCalled();

    flush.mockRestore();
    otherFence();
    otherInteraction();
    expect(session.isMutationFenced).toBe(false);
    expect(isExitInteractionBlocked()).toBe(false);
    expect(await session.flush()).toBe(true);
  });

  it('keeps a committed editor draft and capture fenced through a delayed best-effort backup', async () => {
    const { session, vault } = await openSession();
    setSession(session);
    const pageId = firstPageId(session);
    const stopTabs = startTabs();
    tabStops.add(stopTabs);
    setMainRoute(pageId);
    const harness = mountPageEditor(session, pageId);
    await harness.render();
    const editor = harness.editor;
    if (!editor) throw new Error('PageEditor did not mount.');
    await act(async () => editor.commands.focus());

    const owner = activeOwner();
    const acceptedTarget = captureEditorInsertionTarget(owner);
    if (!acceptedTarget) throw new Error('Expected the active page editor to accept a capture.');
    targets.add(acceptedTarget);
    expect(acceptedTarget.insert('Accepted before exit preparation')).toMatchObject({ ok: true });
    await act(async () => {
      expect(commitEditors()).toBe(true);
    });
    expect(session.queue.isDirty(pageId)).toBe(true);
    await act(async () => {
      expect(await session.flush()).toBe(true);
    });
    expect(session.queue.hasPending()).toBe(false);

    await act(async () => {
      expect(editor.commands.insertContent('Draft waiting for exit preparation')).toBe(true);
    });
    expect(session.queue.hasPending()).toBe(false);
    expect(docToMarkdown(session.getState().docs[pageId]!)).not.toContain(
      'Draft waiting for exit preparation',
    );

    const staleTarget = captureEditorInsertionTarget(owner);
    if (!staleTarget) throw new Error('Expected a second capture before preparation.');
    targets.add(staleTarget);
    const acceptedDocument = editor.state.doc.toJSON();
    const boot = sessionBoot(session);
    const backupStarted = deferred<void>();
    const finishBackup = deferred<void>();
    const writeAutoBackup = vi.fn(async () => {
      backupStarted.resolve(undefined);
      await finishBackup.promise;
    });
    const commit = vi.fn(commitEditors);
    const flushPlaces = vi.fn();
    const originalFlush = session.flush.bind(session);
    const flush = vi.spyOn(session, 'flush').mockImplementation(async () => {
      expect(session.isMutationFenced).toBe(true);
      expect(flushPlaces).toHaveBeenCalledOnce();
      return originalFlush();
    });
    commit.mockImplementation(() => {
      expect(isExitInteractionBlocked()).toBe(true);
      expect(session.isMutationFenced).toBe(false);
      return commitEditors();
    });
    const prep = createPreparer(boot, {
      getWorkspaceSessionGeneration,
      getSession,
      commitEditors: commit,
      flushPlaces,
      writeAutoBackup,
    });

    let pendingPreparation: ReturnType<TestPreparer['prepare']> | undefined;
    try {
      await act(async () => {
        pendingPreparation = prep.prepare();
        await waitForPhase(backupStarted.promise, pendingPreparation, 'the delayed backup');
      });
      if (!pendingPreparation) throw new Error('Preparation did not start.');

      expect(session.isMutationFenced).toBe(true);
      expect(isExitInteractionBlocked()).toBe(true);
      expect(session.queue.hasPending()).toBe(false);
      expect(vault.text('Synthetic note.md')).toContain('Accepted before exit preparation');
      expect(vault.text('Synthetic note.md')).toContain('Draft waiting for exit preparation');
      expect(captureEditorInsertionTarget(owner)).toBeNull();
      expect(staleTarget.insert('Rejected during backup')).toMatchObject({ ok: false });
      const pageCount = Object.keys(session.getState().pages).length;
      const fencedMutation = session.execute({
        type: 'page.setFields',
        id: pageId,
        extra: { preparationDraft: 'must-not-apply' },
        now: Date.now(),
      });
      expect(fencedMutation.ok).toBe(false);
      runAction('page.new');
      expect(Object.keys(session.getState().pages)).toHaveLength(pageCount);
      expect(docToMarkdown(session.getState().docs[pageId]!)).toContain('Draft waiting for exit preparation');
      expect(editor.state.doc.toJSON()).toEqual(acceptedDocument);

      const competing = await prep.prepare();
      expect(competing).toMatchObject({ ok: false, reason: 'busy' });
      expect(commit).toHaveBeenCalledOnce();
      expect(writeAutoBackup).toHaveBeenCalledOnce();

      finishBackup.reject(new Error('Synthetic best-effort backup failure.'));
      const result = trackLease(await pendingPreparation);
      if (!result.ok) throw new Error(`Expected a prepared exit, got ${result.reason}.`);
      expect(flushPlaces).toHaveBeenCalledOnce();
      expect(flush).toHaveBeenCalledOnce();
      expect(session.isMutationFenced).toBe(true);
      expect(isExitInteractionBlocked()).toBe(true);
      flush.mockRestore();
      expect(await prep.prepare()).toMatchObject({ ok: false, reason: 'busy' });
      result.lease.release();
      expect(session.isMutationFenced).toBe(false);
      expect(isExitInteractionBlocked()).toBe(false);
      expect(staleTarget.insert('Still rejected after release')).toMatchObject({ ok: false });

      const freshTarget = captureEditorInsertionTarget(owner);
      if (!freshTarget) throw new Error('Expected a fresh capture after the fence released.');
      targets.add(freshTarget);
      expect(freshTarget.insert('Accepted after release')).toMatchObject({ ok: true });
      await act(async () => {
        expect(commitEditors()).toBe(true);
        expect(await session.flush()).toBe(true);
      });
      expect(vault.text('Synthetic note.md')).toContain('Accepted after release');
      expect(vault.text('Synthetic note.md')).not.toContain('Rejected during backup');
      expect(vault.text('Synthetic note.md')).not.toContain('must-not-apply');
    } finally {
      finishBackup.resolve(undefined);
      await pendingPreparation?.catch(() => undefined);
      flush.mockRestore();
    }
  });

  it('revalidates session identity after both flush and backup awaits', async () => {
    const firstVault = new MemoryVault({ 'Synthetic note.md': '# Note\n\nOriginal text.\n' });
    const first = await openSession(firstVault);
    const replacement = await openSession();
    const finalSession = await openSession();
    setSession(first.session);
    addPageField(first.session, firstPageId(first.session), 'identity-draft');
    const boot = sessionBoot(first.session);
    let swappedDuringFlush = false;
    firstVault.midway = () => {
      if (swappedDuringFlush) return;
      swappedDuringFlush = true;
      setSession(replacement.session);
    };
    const firstBackup = vi.fn(async () => {});
    const flushPrep = createPreparer(boot, {
      getWorkspaceSessionGeneration,
      getSession,
      writeAutoBackup: firstBackup,
    });

    const flushResult = await flushPrep.prepare();
    firstVault.midway = null;
    expect(flushResult).toMatchObject({ ok: false, reason: 'session-changed' });
    expect(swappedDuringFlush).toBe(true);
    expect(firstBackup).not.toHaveBeenCalled();
    expect(first.session.isMutationFenced).toBe(false);
    expect(replacement.session.isMutationFenced).toBe(false);
    expect(isExitInteractionBlocked()).toBe(false);

    const mismatched = await createPreparer(boot, {
      getWorkspaceSessionGeneration,
      getSession,
      writeAutoBackup: firstBackup,
    }).prepare();
    expect(mismatched).toMatchObject({ ok: false, reason: 'session-unknown' });
    expect(firstBackup).not.toHaveBeenCalled();
    expect(isExitInteractionBlocked()).toBe(false);

    addPageField(replacement.session, firstPageId(replacement.session), 'backup-identity-draft');
    const replacementBoot = sessionBoot(replacement.session);
    const backupStarted = deferred<void>();
    const finishBackup = deferred<void>();
    const writeAutoBackup = vi.fn(async () => {
      backupStarted.resolve(undefined);
      await finishBackup.promise;
    });
    const backupPrep = createPreparer(replacementBoot, {
      getWorkspaceSessionGeneration,
      getSession,
      writeAutoBackup,
    });
    const pending = backupPrep.prepare();
    try {
      await waitForPhase(backupStarted.promise, pending, 'the delayed backup');
      expect(replacement.session.isMutationFenced).toBe(true);
      setSession(finalSession.session);
      finishBackup.resolve(undefined);

      const result = await pending;
      expect(result).toMatchObject({ ok: false, reason: 'session-changed' });
      expect(replacement.session.isMutationFenced).toBe(false);
      expect(finalSession.session.isMutationFenced).toBe(false);
      expect(isExitInteractionBlocked()).toBe(false);
    } finally {
      finishBackup.resolve(undefined);
      await pending.catch(() => undefined);
    }
  });

  it('reloads only after preparation succeeds and releases a lease if reload throws', async () => {
    const noReload = vi.fn();
    expect(
      await reloadAfterPreparation(
        async () => ({ ok: false as const, reason: 'commit-failed' as const }),
        noReload,
      ),
    ).toBe(false);
    expect(
      await reloadAfterPreparation(
        async () => Promise.reject(new Error('synthetic preparation failure')),
        noReload,
      ),
    ).toBe(false);
    expect(noReload).not.toHaveBeenCalled();

    const { session } = await openSession();
    addPageField(session, firstPageId(session), 'retry-candidate-draft');
    const prep = createPreparer(sessionBoot(session, 'error-with-work'), {
      getWorkspaceSessionGeneration: () => 0,
    });
    let result: TestPreparation | undefined;
    const prepareForReload = async () => {
      const prepared = trackLease(await prep.prepare());
      result = prepared;
      return prepared;
    };
    const reload = vi.fn(() => {
      expect(isExitInteractionBlocked()).toBe(true);
      expect(session.isMutationFenced).toBe(true);
    });
    expect(await reloadAfterPreparation(prepareForReload, reload)).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
    expect(result?.ok).toBe(true);
    expect(isExitInteractionBlocked()).toBe(true);
    expect(session.isMutationFenced).toBe(true);
    if (!result?.ok) throw new Error('The successful preparation should retain its lease.');
    result.lease.release();
    expect(isExitInteractionBlocked()).toBe(false);
    expect(session.isMutationFenced).toBe(false);

    const throwingPrep = createPreparer(sessionBoot(session, 'error-with-work'), {
      getWorkspaceSessionGeneration: () => 0,
    });
    let throwingResult: TestPreparation | undefined;
    const prepareForThrowingReload = async () => {
      const prepared = trackLease(await throwingPrep.prepare());
      throwingResult = prepared;
      return prepared;
    };
    expect(
      await reloadAfterPreparation(prepareForThrowingReload, () => {
        throw new Error('Synthetic location.reload failure.');
      }),
    ).toBe(false);
    expect(throwingResult?.ok).toBe(true);
    expect(isExitInteractionBlocked()).toBe(false);
    expect(session.isMutationFenced).toBe(false);
    if (throwingResult?.ok) throwingResult.lease.release();
  });
});
