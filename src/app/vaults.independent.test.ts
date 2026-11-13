// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryVault } from '../storage/memoryVault';
import { WorkspaceSession } from '../storage/session';
import { VaultRepository } from '../storage/vaultRepository';
import { createBootState } from './bootState';
import { acquireExitInteractionGate, isExitInteractionBlocked } from './exitInteraction';
import { createExitPreparer } from './exitPreparation';
import type { ExitPreparationDependencies, ExitPreparationLease, ExitPreparer } from './exitPreparation';
import { commitEditors, registerCommit } from './editor/commits';
import { Toasts } from './components/primitives';
import { getUi, setUi } from './ui';
import { COPY_LEGACY_KEY } from './legacy';
import { registerExitPreparer } from './exitPreparationRegistry';
import { switchVault } from './vaults';

const desktopMocks = vi.hoisted(() => ({
  select: vi.fn(),
  choose: vi.fn(),
  createDefault: vi.fn(),
}));

vi.mock('./platform/desktop', () => ({
  isMac: false,
  desktop: {
    vault: {
      select: desktopMocks.select,
      choose: desktopMocks.choose,
      createDefault: desktopMocks.createDefault,
    },
  },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SESSION_FILE = 'Synthetic note.md';
let nextSessionId = 0;
const sessions = new Set<WorkspaceSession>();
const unregisterPreparers = new Set<() => void>();
const unregisterCommits = new Set<() => void>();
const cleanupLeases = new Set<ExitPreparationLease<WorkspaceSession>>();
const cleanupReleases = new Set<() => void>();
const restoreGlobals = new Set<() => void>();
const toastRoots = new Set<{ root: ReturnType<typeof createRoot>; container: HTMLElement }>();

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function openSession(): Promise<{ session: WorkspaceSession; vault: MemoryVault }> {
  const vault = new MemoryVault({ [SESSION_FILE]: '# Synthetic note\n\nOriginal content.\n' });
  const opened = await WorkspaceSession.open(
    new VaultRepository(vault, () => `vault-switch-${++nextSessionId}`),
    { delayMs: 60_000 },
  );
  if (!opened.ok) throw new Error(opened.error);
  sessions.add(opened.value);
  return { session: opened.value, vault };
}

function noSessionBoot() {
  const boot = createBootState<WorkspaceSession>();
  const generation = boot.begin();
  boot.knowPromise(generation, Promise.resolve());
  boot.settle(generation, { kind: 'no-session', reason: 'choose' });
  return boot;
}

function candidateBoot(session: WorkspaceSession) {
  const boot = createBootState<WorkspaceSession>();
  const generation = boot.begin();
  boot.knowPromise(generation, Promise.resolve());
  boot.retainCandidate(generation, session);
  boot.settle(generation, { kind: 'session' });
  return boot;
}

function trackRelease(release: () => void): () => void {
  let active = true;
  const tracked = () => {
    if (!active) return;
    active = false;
    release();
    cleanupReleases.delete(tracked);
  };
  cleanupReleases.add(tracked);
  return tracked;
}

function installPreparer(preparer: ExitPreparer<WorkspaceSession>): () => void {
  const tracked: ExitPreparer<WorkspaceSession> = {
    async prepare() {
      const result = await preparer.prepare();
      if (result.ok) cleanupLeases.add(result.lease);
      return result;
    },
  };
  const unregister = registerExitPreparer(tracked);
  unregisterPreparers.add(unregister);
  return unregister;
}

function sessionPreparer(
  session: WorkspaceSession,
  overrides: Partial<ExitPreparationDependencies<WorkspaceSession>> = {},
): ExitPreparer<WorkspaceSession> {
  const boot = candidateBoot(session);
  const dependencies: ExitPreparationDependencies<WorkspaceSession> = {
    getBootSnapshot: () => boot.snapshot(),
    getWorkspaceSessionGeneration: () => 1,
    getSession: () => session,
    commitEditors,
    flushPlaces: () => {},
    acquireInteractionGate: () => trackRelease(acquireExitInteractionGate()),
    writeAutoBackup: async () => {},
    ...overrides,
  };
  return createExitPreparer(dependencies);
}

function stubReload(callback: () => void = () => {}) {
  const descriptor = Object.getOwnPropertyDescriptor(window.location, 'reload');
  const reload = vi.fn(callback);
  Object.defineProperty(window.location, 'reload', {
    configurable: true,
    writable: true,
    value: reload,
  });
  let active = true;
  const restore = () => {
    if (!active) return;
    active = false;
    if (descriptor) Object.defineProperty(window.location, 'reload', descriptor);
    else Reflect.deleteProperty(window.location, 'reload');
    restoreGlobals.delete(restore);
  };
  restoreGlobals.add(restore);
  return reload;
}

function stubSessionStorageRemoveItemFailure(key: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const backing = window.sessionStorage;
  const storage: Storage = {
    get length() {
      return backing.length;
    },
    clear: () => backing.clear(),
    getItem: (item) => backing.getItem(item),
    key: (index) => backing.key(index),
    removeItem: (item) => {
      backing.removeItem(item);
      if (item === key) throw new Error('storage failed after applying the removal');
    },
    setItem: (item, next) => {
      backing.setItem(item, next);
    },
  };
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    writable: true,
    value: storage,
  });
  let active = true;
  const restore = () => {
    if (!active) return;
    active = false;
    if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
    restoreGlobals.delete(restore);
  };
  restoreGlobals.add(restore);
}

async function mountToasts(): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  toastRoots.add({ root, container });
  await act(async () => {
    root.render(createElement(Toasts));
  });
  return container;
}

beforeEach(() => {
  desktopMocks.select.mockReset().mockResolvedValue({ ok: true });
  desktopMocks.choose.mockReset().mockResolvedValue(null);
  desktopMocks.createDefault.mockReset().mockResolvedValue('/new-vault');
  sessionStorage.clear();
  setUi({ toasts: [] });
});

afterEach(async () => {
  for (const unregister of [...unregisterPreparers]) {
    unregister();
    unregisterPreparers.delete(unregister);
  }
  for (const unregister of [...unregisterCommits]) {
    unregister();
    unregisterCommits.delete(unregister);
  }
  for (const lease of [...cleanupLeases]) {
    lease.release();
    cleanupLeases.delete(lease);
  }
  for (const release of [...cleanupReleases]) release();
  for (const restore of [...restoreGlobals]) restore();
  for (const entry of [...toastRoots]) {
    await act(async () => entry.root.unmount());
    entry.container.remove();
    toastRoots.delete(entry);
  }
  for (const session of [...sessions]) {
    if (!session.isClosed) await session.close();
    sessions.delete(session);
  }
  setUi({ toasts: [] });
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('switchVault independent contract', () => {
  it('refuses when the preparer registry is missing and renders the existing error toast', async () => {
    const container = await mountToasts();
    const reload = stubReload();

    await act(async () => {
      expect(await switchVault('/new-vault')).toBe(false);
    });

    expect(desktopMocks.select).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(getUi().toasts.some((entry) => entry.tone === 'error')).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/save|salv|guardar/i);
  });

  it('stops on a real preparation failure before selecting or reloading', async () => {
    const { session } = await openSession();
    installPreparer(sessionPreparer(session));
    const unregisterCommit = registerCommit(() => false);
    unregisterCommits.add(unregisterCommit);
    const reload = stubReload();
    const flush = vi.spyOn(session, 'flush');

    expect(await switchVault('/new-vault')).toBe(false);

    expect(desktopMocks.select).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
    expect(session.isMutationFenced).toBe(false);
    expect(isExitInteractionBlocked()).toBe(false);
    expect(getUi().toasts.some((entry) => entry.tone === 'error')).toBe(true);
  });

  it('refuses a throwing registered preparer without selecting or reloading', async () => {
    const unregister = registerExitPreparer({
      prepare: async () => {
        throw new Error('synthetic preparation failure');
      },
    });
    unregisterPreparers.add(unregister);
    const reload = stubReload();

    expect(await switchVault('/new-vault')).toBe(false);

    expect(desktopMocks.select).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(getUi().toasts.some((entry) => entry.tone === 'error')).toBe(true);
  });

  it('allows a completed no-session boot to choose the first vault even when getSession would throw', async () => {
    const boot = noSessionBoot();
    const getSession = vi.fn<() => WorkspaceSession>(() => {
      throw new Error('No workspace exists before the first vault is chosen.');
    });
    const preparer = createExitPreparer<WorkspaceSession>({
      getBootSnapshot: () => boot.snapshot(),
      getWorkspaceSessionGeneration: () => 0,
      getSession,
      commitEditors: () => true,
      flushPlaces: () => {},
      acquireInteractionGate: () => trackRelease(acquireExitInteractionGate()),
      writeAutoBackup: async () => {},
    });
    installPreparer(preparer);
    const reload = stubReload(() => {
      expect(isExitInteractionBlocked()).toBe(true);
    });

    expect(await switchVault('/first-vault')).toBe(true);

    expect(getSession).not.toHaveBeenCalled();
    expect(desktopMocks.select).toHaveBeenCalledWith('/first-vault');
    expect(reload).toHaveBeenCalledOnce();
    expect(isExitInteractionBlocked()).toBe(true);
  });

  it('does not treat a throwing current-session getter as proof of absence after a session boot', async () => {
    const { session } = await openSession();
    const getSession = vi.fn<() => WorkspaceSession>(() => {
      throw new Error('The current session could not be confirmed.');
    });
    installPreparer(
      sessionPreparer(session, {
        getSession,
        getWorkspaceSessionGeneration: () => 1,
      }),
    );
    const reload = stubReload();

    expect(await switchVault('/new-vault')).toBe(false);

    expect(getSession).toHaveBeenCalledOnce();
    expect(desktopMocks.select).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(session.isMutationFenced).toBe(false);
    expect(isExitInteractionBlocked()).toBe(false);
  });

  it.each(['idle', 'opening'] as const)(
    'does not interpret a %s boot snapshot as a completed absence',
    async (kind) => {
      const boot = createBootState<WorkspaceSession>();
      if (kind === 'opening') {
        const generation = boot.begin();
        boot.knowPromise(generation, new Promise<void>(() => {}));
      }
      installPreparer(
        createExitPreparer<WorkspaceSession>({
          getBootSnapshot: () => boot.snapshot(),
          getWorkspaceSessionGeneration: () => 0,
          getSession: () => {
            throw new Error('A not-ready boot cannot prove the workspace is absent.');
          },
          commitEditors: () => true,
          flushPlaces: () => {},
          acquireInteractionGate: () => trackRelease(acquireExitInteractionGate()),
          writeAutoBackup: async () => {},
        }),
      );
      const reload = stubReload();

      expect(await switchVault('/new-vault')).toBe(false);

      expect(desktopMocks.select).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
      expect(isExitInteractionBlocked()).toBe(false);
    },
  );

  it('keeps a real session fenced while selection waits, persists its committed draft first, and holds through reload', async () => {
    const { session, vault } = await openSession();
    const pageId = Object.keys(session.getState().pages)[0];
    if (!pageId) throw new Error('Expected the synthetic vault to contain one page.');
    let draftPending = true;
    const unregisterCommit = registerCommit(() => {
      if (!draftPending) return true;
      const result = session.execute({
        type: 'page.setFields',
        id: pageId,
        extra: { vaultSwitchDraft: 'committed before selection' },
        now: Date.now(),
      });
      if (!result.ok) return false;
      draftPending = false;
      return true;
    });
    unregisterCommits.add(unregisterCommit);

    const writes: string[] = [];
    const apply = vi.spyOn(vault, 'apply').mockImplementation(async (ops) => {
      const result = await MemoryVault.prototype.apply.call(vault, ops);
      writes.push('saved');
      return result;
    });
    const selection = deferred<{ ok: boolean; error?: string }>();
    const selectionStarted = deferred<void>();
    let selectedPath: string | null = null;
    desktopMocks.select.mockImplementation(async (dir: string) => {
      selectedPath = dir;
      selectionStarted.resolve();
      expect(writes).toContain('saved');
      expect(session.queue.hasPending()).toBe(false);
      expect(vault.paths().some((path) => vault.text(path)?.includes('vaultSwitchDraft'))).toBe(true);
      return await selection.promise;
    });
    installPreparer(sessionPreparer(session));
    sessionStorage.setItem(COPY_LEGACY_KEY, 'stale-copy-intent');
    const reload = stubReload(() => {
      expect(session.isMutationFenced).toBe(true);
      expect(isExitInteractionBlocked()).toBe(true);
      expect(sessionStorage.getItem(COPY_LEGACY_KEY)).toBeNull();
    });

    const switching = switchVault('/new-vault', { copyLegacy: false });
    try {
      await Promise.race([
        selectionStarted.promise,
        switching.then(() => {
          throw new Error('switchVault finished before the pending selection reached the test.');
        }),
      ]);

      expect(draftPending).toBe(false);
      expect(selectedPath).toBe('/new-vault');
      expect(session.location).toBe('/vault');
      expect(session.isMutationFenced).toBe(true);
      expect(isExitInteractionBlocked()).toBe(true);
      const pageBefore = session.getState().pages[pageId];
      const rejected = session.execute({
        type: 'page.setFields',
        id: pageId,
        extra: { vaultSwitchDraft: 'must not apply during select' },
        now: Date.now(),
      });
      expect(rejected.ok).toBe(false);
      expect(session.getState().pages[pageId]).toBe(pageBefore);
      expect(session.queue.hasPending()).toBe(false);

      selection.resolve({ ok: true });
      expect(await switching).toBe(true);
    } finally {
      selection.resolve({ ok: false, error: 'cleanup selection' });
      await switching.catch(() => undefined);
    }

    expect(apply).toHaveBeenCalled();
    expect(reload).toHaveBeenCalledOnce();
    expect(session.location).toBe('/vault');
    expect(session.isMutationFenced).toBe(true);
    expect(isExitInteractionBlocked()).toBe(true);
    expect(sessionStorage.getItem(COPY_LEGACY_KEY)).toBeNull();
  });

  it.each([
    {
      label: 'a known false result',
      select: async (setMetadata: (value: string) => void) => {
        setMetadata('/new-vault');
        return { ok: false, error: 'select refused' };
      },
    },
    {
      label: 'a transport throw after metadata may have changed',
      select: async (setMetadata: (value: string) => void) => {
        setMetadata('/new-vault');
        throw new Error('select transport failed');
      },
    },
  ])('$label releases only this attempt and leaves the old OPEN session usable', async ({ select }) => {
    const { session } = await openSession();
    let metadataPath = '/old-vault';
    desktopMocks.select.mockImplementation(async () => select((path) => (metadataPath = path)));
    installPreparer(sessionPreparer(session));
    const reload = stubReload();
    const otherInteraction = trackRelease(acquireExitInteractionGate());
    const otherFence = trackRelease(session.beginMutationFence());

    expect(await switchVault('/new-vault')).toBe(false);

    expect(desktopMocks.select).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    expect(metadataPath).toBe('/new-vault');
    expect(session.location).toBe('/vault');
    expect(session.isMutationFenced).toBe(true);
    expect(isExitInteractionBlocked()).toBe(true);

    otherInteraction();
    otherFence();
    expect(session.isMutationFenced).toBe(false);
    expect(isExitInteractionBlocked()).toBe(false);
    const pageId = Object.keys(session.getState().pages)[0];
    if (!pageId) throw new Error('Expected the synthetic vault to contain one page.');
    expect(
      session.execute({
        type: 'page.setFields',
        id: pageId,
        extra: { retryAfterSelectFailure: true },
        now: Date.now(),
      }).ok,
    ).toBe(true);

    desktopMocks.select.mockResolvedValue({ ok: true });
    expect(await switchVault('/retry-vault')).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
    expect(session.location).toBe('/vault');
  });

  it('restores the previous copy intent when reload throws before navigating', async () => {
    const { session } = await openSession();
    installPreparer(sessionPreparer(session));
    sessionStorage.setItem(COPY_LEGACY_KEY, 'previous-intent');
    const reload = stubReload(() => {
      expect(session.isMutationFenced).toBe(true);
      expect(sessionStorage.getItem(COPY_LEGACY_KEY)).toBe('1');
      throw new Error('reload failed before navigation');
    });

    expect(await switchVault('/new-vault', { copyLegacy: true })).toBe(false);

    expect(desktopMocks.select).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(COPY_LEGACY_KEY)).toBe('previous-intent');
    expect(session.isMutationFenced).toBe(false);
    expect(isExitInteractionBlocked()).toBe(false);
  });

  it('restores its prior copy intent when sessionStorage removes the flag and then throws', async () => {
    const { session } = await openSession();
    installPreparer(sessionPreparer(session));
    sessionStorage.setItem(COPY_LEGACY_KEY, '1');
    stubSessionStorageRemoveItemFailure(COPY_LEGACY_KEY);
    const reload = stubReload();

    expect(await switchVault('/new-vault', { copyLegacy: false })).toBe(false);

    expect(desktopMocks.select).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(COPY_LEGACY_KEY)).toBe('1');
    expect(session.isMutationFenced).toBe(false);
    expect(isExitInteractionBlocked()).toBe(false);
  });

  it('does not overwrite a newer copy intent when restoring after a reload throw', async () => {
    const { session } = await openSession();
    installPreparer(sessionPreparer(session));
    sessionStorage.setItem(COPY_LEGACY_KEY, 'stale-intent');
    const reload = stubReload(() => {
      expect(sessionStorage.getItem(COPY_LEGACY_KEY)).toBeNull();
      sessionStorage.setItem(COPY_LEGACY_KEY, 'newer-intent');
      throw new Error('reload failed before navigation');
    });

    expect(await switchVault('/new-vault', { copyLegacy: false })).toBe(false);

    expect(reload).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(COPY_LEGACY_KEY)).toBe('newer-intent');
    expect(session.isMutationFenced).toBe(false);
    expect(isExitInteractionBlocked()).toBe(false);
  });
});
