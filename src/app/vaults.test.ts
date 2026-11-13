// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryVault } from '../storage/memoryVault';
import { WorkspaceSession } from '../storage/session';
import { VaultRepository } from '../storage/vaultRepository';
import { Toasts } from './components/primitives';
import { createBootState } from './bootState';
import { commitEditors, registerCommit } from './editor/commits';
import { acquireExitInteractionGate, isExitInteractionBlocked } from './exitInteraction';
import { createExitPreparer, type ExitPreparer } from './exitPreparation';
import { COPY_LEGACY_KEY } from './legacy';
import { setUi } from './ui';
import { registerExitPreparer } from './exitPreparationRegistry';
import { switchVault } from './vaults';

const desktopMocks = vi.hoisted(() => ({
  select: vi.fn(),
  choose: vi.fn(),
  createDefault: vi.fn(),
}));

vi.mock('./platform/desktop', () => ({
  desktop: {
    vault: {
      select: desktopMocks.select,
      choose: desktopMocks.choose,
      createDefault: desktopMocks.createDefault,
    },
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

let nextId = 0;
const sessions = new Set<WorkspaceSession>();
const heldLeases: Array<{ release(): void }> = [];
const unregisterPreparers: Array<() => void> = [];
const unregisterCommits: Array<() => void> = [];
const roots: Array<ReturnType<typeof createRoot>> = [];
const restoreReloadMocks: Array<() => void> = [];
const restoreStorageMocks: Array<() => void> = [];

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

async function openSession(vault = new MemoryVault()): Promise<WorkspaceSession> {
  const opened = await WorkspaceSession.open(new VaultRepository(vault, () => `vault-switch-${++nextId}`), {
    delayMs: 60_000,
  });
  if (!opened.ok) throw new Error(opened.error);
  sessions.add(opened.value);
  return opened.value;
}

function installSessionPreparer(
  session: WorkspaceSession,
  options: { generation?: number; getSession?: () => WorkspaceSession } = {},
): ExitPreparer {
  const boot = createBootState<WorkspaceSession>();
  const generation = boot.begin();
  boot.retainCandidate(generation, session);
  boot.settle(generation, { kind: 'session' });

  const preparer = createExitPreparer({
    getBootSnapshot: () => boot.snapshot(),
    getWorkspaceSessionGeneration: () => options.generation ?? 1,
    getSession: options.getSession ?? (() => session),
    commitEditors,
    flushPlaces: () => {},
    acquireInteractionGate: acquireExitInteractionGate,
    writeAutoBackup: async () => {},
  });

  return registerPreparer(preparer);
}

function installNoSessionPreparer(): ExitPreparer {
  const boot = createBootState<WorkspaceSession>();
  const generation = boot.begin();
  boot.settle(generation, { kind: 'no-session', reason: 'choose' });
  const preparer = createExitPreparer({
    getBootSnapshot: () => boot.snapshot(),
    getWorkspaceSessionGeneration: () => 0,
    getSession: () => {
      throw new Error('There is no active workspace before the first selection.');
    },
    commitEditors,
    flushPlaces: () => {},
    acquireInteractionGate: acquireExitInteractionGate,
    writeAutoBackup: async () => {},
  });
  return registerPreparer(preparer);
}

function registerPreparer(preparer: ExitPreparer): ExitPreparer {
  const registered: ExitPreparer = {
    async prepare() {
      const result = await preparer.prepare();
      if (result.ok) heldLeases.push(result.lease);
      return result;
    },
  };
  unregisterPreparers.push(registerExitPreparer(registered));
  return registered;
}

function mockReload(implementation: () => void = () => {}): void {
  const descriptor = Object.getOwnPropertyDescriptor(window.location, 'reload');
  Object.defineProperty(window.location, 'reload', { configurable: true, value: implementation });
  restoreReloadMocks.push(() => {
    if (descriptor) Object.defineProperty(window.location, 'reload', descriptor);
    else Reflect.deleteProperty(window.location, 'reload');
  });
}

function mockStorageSetItem(replacement: (original: Storage['setItem']) => Storage['setItem']): void {
  const storage = window.sessionStorage;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const original = storage.setItem.bind(storage);
  const shim = {
    get length() {
      return storage.length;
    },
    clear: () => storage.clear(),
    getItem: (key: string) => storage.getItem(key),
    key: (index: number) => storage.key(index),
    removeItem: (key: string) => storage.removeItem(key),
    setItem: replacement(original),
  } satisfies Storage;
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    writable: true,
    value: shim,
  });
  restoreStorageMocks.push(() => {
    if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  });
}

function mockStorageRemoveItem(
  replacement: (original: Storage['removeItem']) => Storage['removeItem'],
): void {
  const storage = window.sessionStorage;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const original = storage.removeItem.bind(storage);
  const shim = {
    get length() {
      return storage.length;
    },
    clear: () => storage.clear(),
    getItem: (key: string) => storage.getItem(key),
    key: (index: number) => storage.key(index),
    removeItem: replacement(original),
    setItem: storage.setItem.bind(storage),
  } satisfies Storage;
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    writable: true,
    value: shim,
  });
  restoreStorageMocks.push(() => {
    if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  });
}

function mountToasts(): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(createElement(Toasts)));
  return host;
}

async function flushUi(): Promise<void> {
  await act(async () => {});
}

beforeEach(() => {
  desktopMocks.select.mockReset().mockResolvedValue({ ok: true });
  desktopMocks.choose.mockReset().mockResolvedValue(null);
  desktopMocks.createDefault.mockReset().mockResolvedValue('/synthetic-vault');
  window.sessionStorage.clear();
  setUi({ toasts: [] });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const lease of heldLeases.splice(0)) lease.release();
  for (const unregister of unregisterPreparers.splice(0)) unregister();
  for (const unregister of unregisterCommits.splice(0)) unregister();
  for (const restore of restoreReloadMocks.splice(0)) restore();
  for (const restore of restoreStorageMocks.splice(0)) restore();
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  for (const session of sessions) await session.close();
  sessions.clear();
  window.sessionStorage.clear();
  setUi({ toasts: [] });
  document.body.replaceChildren();
});

describe('switchVault exit preparation', () => {
  it('shows a visible error and does not select when the preparer registry is missing', async () => {
    const host = mountToasts();
    const reload = vi.fn();
    mockReload(reload);

    let switched = true;
    await act(async () => {
      switched = await switchVault('/next-vault');
    });
    await flushUi();

    expect(switched).toBe(false);
    expect(desktopMocks.select).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not save');
  });

  it('allows the initial vault choice only after conclusive no-session boot', async () => {
    installNoSessionPreparer();
    const reload = vi.fn();
    mockReload(reload);

    await expect(switchVault('/first-vault')).resolves.toBe(true);

    expect(desktopMocks.select).toHaveBeenCalledWith('/first-vault');
    expect(reload).toHaveBeenCalledOnce();
    expect(isExitInteractionBlocked()).toBe(true);
  });

  it('refuses an unknown active session without calling select or reload', async () => {
    const session = await openSession();
    installSessionPreparer(session, {
      getSession: () => {
        throw new Error('Workspace getter is unavailable.');
      },
    });
    const reload = vi.fn();
    mockReload(reload);

    await expect(switchVault('/next-vault')).resolves.toBe(false);

    expect(desktopMocks.select).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(session.isMutationFenced).toBe(false);
    expect(isExitInteractionBlocked()).toBe(false);
  });

  it('commits and saves a draft, then keeps the real session fenced during select and reload', async () => {
    const vault = new MemoryVault();
    const session = await openSession(vault);
    installSessionPreparer(session);
    const draftId = 'switch-draft-before-select';
    unregisterCommits.push(
      registerCommit(
        () =>
          session.execute({
            type: 'page.create',
            id: draftId,
            parentId: null,
            title: 'Committed before selecting',
            now: 1,
            doc: { type: 'doc', content: [{ type: 'paragraph' }] },
          }).ok,
      ),
    );
    const selection = deferred<{ ok: boolean; error?: string }>();
    desktopMocks.select.mockReturnValueOnce(selection.promise);
    const reload = vi.fn(() => {
      expect(session.isMutationFenced).toBe(true);
      expect(isExitInteractionBlocked()).toBe(true);
    });
    mockReload(reload);

    const switching = switchVault('/next-vault');
    await vi.waitFor(() => expect(desktopMocks.select).toHaveBeenCalledOnce());
    expect(session.isMutationFenced).toBe(true);
    expect(isExitInteractionBlocked()).toBe(true);

    const before = session.getState();
    expect(before.pages[draftId]).toBeDefined();
    expect(vault.paths()).toHaveLength(1);
    const refused = session.execute({
      type: 'page.create',
      id: 'switch-during-select',
      parentId: null,
      title: 'Must stay in the old vault',
      now: 1,
      doc: { type: 'doc', content: [{ type: 'paragraph' }] },
    });
    expect(refused.ok).toBe(false);
    expect(session.getState()).toBe(before);

    selection.resolve({ ok: true });
    await expect(switching).resolves.toBe(true);
    expect(reload).toHaveBeenCalledOnce();
    expect(session.isMutationFenced).toBe(true);
    expect(isExitInteractionBlocked()).toBe(true);
  });

  it.each([
    ['a negative result', async () => ({ ok: false, error: 'The folder was rejected.' })],
    ['a rejected transport', async () => Promise.reject(new Error('Transport was interrupted.'))],
  ])('releases only its own lease after select fails with %s', async (_label, select) => {
    const session = await openSession();
    installSessionPreparer(session);
    desktopMocks.select.mockImplementationOnce(select);
    const reload = vi.fn();
    mockReload(reload);

    await expect(switchVault('/next-vault')).resolves.toBe(false);

    expect(reload).not.toHaveBeenCalled();
    expect(session.isMutationFenced).toBe(false);
    expect(isExitInteractionBlocked()).toBe(false);
  });

  it('clears stale copy intent on a false-option retry after a failed copy switch', async () => {
    installNoSessionPreparer();
    window.sessionStorage.setItem(COPY_LEGACY_KEY, '1');
    desktopMocks.select.mockResolvedValueOnce({ ok: false, error: 'The first selection failed.' });
    const reload = vi.fn(() => {
      expect(window.sessionStorage.getItem(COPY_LEGACY_KEY)).toBeNull();
    });
    mockReload(reload);

    await expect(switchVault('/first-attempt', { copyLegacy: true })).resolves.toBe(false);
    expect(window.sessionStorage.getItem(COPY_LEGACY_KEY)).toBe('1');
    expect(reload).not.toHaveBeenCalled();

    await expect(switchVault('/next-vault', { copyLegacy: false })).resolves.toBe(true);

    expect(window.sessionStorage.getItem(COPY_LEGACY_KEY)).toBeNull();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('restores only its own copy intent when storage mutation applies and then throws', async () => {
    installNoSessionPreparer();
    expect(globalThis.sessionStorage).toBe(window.sessionStorage);
    expect(window.sessionStorage.getItem(COPY_LEGACY_KEY)).toBeNull();
    const setCalls: Array<[string, string]> = [];
    mockStorageSetItem((original) => (key, value) => {
      setCalls.push([key, value]);
      original(key, value);
      throw new Error('Storage failed after writing.');
    });
    const reload = vi.fn();
    mockReload(reload);

    const switched = await switchVault('/next-vault', { copyLegacy: true });
    expect(setCalls).toContainEqual([COPY_LEGACY_KEY, '1']);
    expect(switched).toBe(false);
    expect(window.sessionStorage.getItem(COPY_LEGACY_KEY)).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    expect(isExitInteractionBlocked()).toBe(false);
  });

  it('restores the previous flag after reload throws but preserves a newer copy intent', async () => {
    installNoSessionPreparer();
    window.sessionStorage.setItem(COPY_LEGACY_KEY, 'older-intent');
    mockReload(() => {
      window.sessionStorage.setItem(COPY_LEGACY_KEY, 'newer-intent');
      throw new Error('Reload could not be emitted.');
    });

    await expect(switchVault('/next-vault', { copyLegacy: false })).resolves.toBe(false);

    expect(window.sessionStorage.getItem(COPY_LEGACY_KEY)).toBe('newer-intent');
    expect(isExitInteractionBlocked()).toBe(false);
  });

  it('restores the previous copy intent when clearing it throws after removal', async () => {
    installNoSessionPreparer();
    window.sessionStorage.setItem(COPY_LEGACY_KEY, '1');
    mockStorageRemoveItem((original) => (key) => {
      original(key);
      throw new Error('Storage failed after removal.');
    });
    const reload = vi.fn();
    mockReload(reload);

    await expect(switchVault('/next-vault', { copyLegacy: false })).resolves.toBe(false);

    expect(window.sessionStorage.getItem(COPY_LEGACY_KEY)).toBe('1');
    expect(reload).not.toHaveBeenCalled();
    expect(isExitInteractionBlocked()).toBe(false);
  });

  it('retains a new copy intent and its lease after reload is emitted', async () => {
    const session = await openSession();
    installSessionPreparer(session);
    const reload = vi.fn(() => {
      expect(window.sessionStorage.getItem(COPY_LEGACY_KEY)).toBe('1');
      expect(session.isMutationFenced).toBe(true);
    });
    mockReload(reload);

    await expect(switchVault('/next-vault', { copyLegacy: true })).resolves.toBe(true);

    expect(window.sessionStorage.getItem(COPY_LEGACY_KEY)).toBe('1');
    expect(session.isMutationFenced).toBe(true);
    expect(isExitInteractionBlocked()).toBe(true);
  });

  it('does not select when an editor commit is refused', async () => {
    const session = await openSession();
    installSessionPreparer(session);
    unregisterCommits.push(registerCommit(() => false));
    const reload = vi.fn();
    mockReload(reload);

    await expect(switchVault('/next-vault')).resolves.toBe(false);

    expect(desktopMocks.select).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(session.isMutationFenced).toBe(false);
    expect(isExitInteractionBlocked()).toBe(false);
  });
});
