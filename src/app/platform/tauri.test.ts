// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultFilePage } from './desktop';
import { tauriBridge } from './tauri';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(async () => () => {}),
  getCurrentWindow: vi.fn(() => ({
    close: vi.fn(),
    minimize: vi.fn(),
    startDragging: vi.fn(),
    toggleMaximize: vi.fn(),
  })),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: mocks.getCurrentWindow }));

interface OpenResult {
  ok: boolean;
  root: string | null;
  generation: number;
  sessionGeneration: number | null;
}

interface TransitionResult {
  ok: boolean;
  generation: number;
  sessionGeneration: number | null;
  currentChanged: boolean;
  error: string | null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function openVaultApi() {
  const bridge = tauriBridge();
  if (!bridge?.vault) throw new Error('Tauri vault bridge was not created.');
  return bridge.vault;
}

let originalOpen: typeof window.open;

beforeEach(() => {
  vi.clearAllMocks();
  originalOpen = window.open;
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
  Object.defineProperty(window, '__MORROW_INFO__', {
    configurable: true,
    value: { version: 'test', dataPath: '', platform: 'darwin', capturesWindow: false },
  });
  mocks.listen.mockResolvedValue(() => {});
  mocks.getCurrentWindow.mockReturnValue({
    close: vi.fn(),
    minimize: vi.fn(),
    startDragging: vi.fn(),
    toggleMaximize: vi.fn(),
  });
});

afterEach(() => {
  window.open = originalOpen;
  delete window.__TAURI_INTERNALS__;
  delete window.__MORROW_INFO__;
  document.body.innerHTML = '';
});

describe('Tauri vault metadata session', () => {
  it('ignores an older open response and a late open response after close', async () => {
    const olderOpen = deferred<OpenResult>();
    const newerOpen = deferred<OpenResult>();
    const lateOpen = deferred<OpenResult>();
    const page = deferred<VaultFilePage>();
    const latePage = deferred<VaultFilePage>();
    const openRequests = [olderOpen, newerOpen, lateOpen];
    const pageRequests = [page, latePage];
    const pageArguments: Array<Record<string, unknown>> = [];

    mocks.invoke.mockImplementation((command, args) => {
      if (command === 'vault_open') return openRequests.shift()!.promise;
      if (command === 'vault_close') return Promise.resolve(undefined);
      if (command === 'vault_files_page') {
        pageArguments.push(args as Record<string, unknown>);
        return pageRequests.shift()!.promise;
      }
      return Promise.resolve(undefined);
    });

    const vault = openVaultApi();
    const oldResult = vault.open();
    const newResult = vault.open();
    newerOpen.resolve({ ok: true, root: '/new-vault', generation: 12, sessionGeneration: 12 });
    await expect(newResult).resolves.toEqual({ ok: true, root: '/new-vault' });
    olderOpen.resolve({ ok: true, root: '/old-vault', generation: 11, sessionGeneration: 11 });
    await expect(oldResult).resolves.toEqual({ ok: true, root: '/old-vault' });

    const listing = vault.listFilesPage('');
    expect(pageArguments[0]?.generation).toBe(12);
    page.resolve({
      generation: 12,
      status: 'ready',
      entries: [],
      nextCursor: null,
      error: null,
    });
    await expect(listing).resolves.toMatchObject({ status: 'ready' });

    const staleListing = vault.listFilesPage('');
    const pendingOpen = vault.open();
    await vault.close();
    latePage.resolve({
      generation: 12,
      status: 'ready',
      entries: [],
      nextCursor: null,
      error: null,
    });
    await expect(staleListing).resolves.toMatchObject({ status: 'stale', entries: [] });
    lateOpen.resolve({ ok: false, root: null, generation: 13, sessionGeneration: null });
    await pendingOpen;
    const afterClose = await vault.listFilesPage('');
    expect(afterClose.status).toBe('stale');
    expect(pageArguments).toHaveLength(2);
  });

  it('restores only the native session that survived failed, no-op and out-of-order transitions', async () => {
    const firstSelect = deferred<TransitionResult>();
    const secondSelect = deferred<TransitionResult>();
    const firstForget = deferred<TransitionResult>();
    const secondForget = deferred<TransitionResult>();
    const pageArguments: Array<Record<string, unknown>> = [];
    let selectIndex = 0;
    let forgetIndex = 0;
    let openIndex = 0;

    mocks.invoke.mockImplementation((command, args) => {
      if (command === 'vault_open') {
        const generation = [20, 22, 24][openIndex++]!;
        return Promise.resolve({
          ok: true,
          root: '/vault',
          generation,
          sessionGeneration: generation,
        } satisfies OpenResult);
      }
      if (command === 'vault_select') {
        const index = selectIndex++;
        if (index < 2) return [firstSelect, secondSelect][index]!.promise;
        return Promise.resolve({
          ok: true,
          generation: 22,
          sessionGeneration: 22,
          currentChanged: false,
          error: null,
        } satisfies TransitionResult);
      }
      if (command === 'vault_forget') return [firstForget, secondForget][forgetIndex++]!.promise;
      if (command === 'vault_files_page') {
        pageArguments.push(args as Record<string, unknown>);
        const generation = (args as { generation: number }).generation;
        return Promise.resolve({
          generation,
          status: 'ready',
          entries: [],
          nextCursor: null,
          error: null,
        } satisfies VaultFilePage);
      }
      return Promise.resolve(undefined);
    });

    const vault = openVaultApi();
    await vault.open();

    const selectA = vault.select('/vault-a');
    const selectB = vault.select('/vault-b');
    secondSelect.resolve({
      ok: false,
      generation: 20,
      sessionGeneration: 20,
      currentChanged: false,
      error: 'selection failed',
    });
    await selectB;
    await vault.listFilesPage('');
    expect(pageArguments[0]?.generation).toBe(20);

    firstSelect.resolve({
      ok: true,
      generation: 21,
      sessionGeneration: null,
      currentChanged: true,
      error: null,
    });
    await selectA;
    expect((await vault.listFilesPage('')).status).toBe('stale');
    expect(pageArguments).toHaveLength(1);

    await vault.open();
    await vault.select('/vault');
    await vault.listFilesPage('');
    expect(pageArguments[1]?.generation).toBe(22);

    const forgetA = vault.forget('/vault-a');
    const forgetB = vault.forget('/vault-b');
    secondForget.resolve({
      ok: true,
      generation: 22,
      sessionGeneration: 22,
      currentChanged: false,
      error: null,
    });
    await expect(forgetB).resolves.toBeUndefined();
    firstForget.resolve({
      ok: false,
      generation: 21,
      sessionGeneration: null,
      currentChanged: true,
      error: 'stale forget response',
    });
    await expect(forgetA).rejects.toThrow('stale forget response');
    await vault.listFilesPage('');
    expect(pageArguments[2]?.generation).toBe(22);

    mocks.invoke.mockImplementation((command, args) => {
      if (command === 'vault_forget')
        return Promise.resolve({
          ok: true,
          generation: 23,
          sessionGeneration: null,
          currentChanged: true,
          error: null,
        } satisfies TransitionResult);
      if (command === 'vault_open')
        return Promise.resolve({ ok: true, root: '/vault', generation: 24, sessionGeneration: 24 } satisfies OpenResult);
      if (command === 'vault_files_page') {
        pageArguments.push(args as Record<string, unknown>);
        const generation = (args as { generation: number }).generation;
        return Promise.resolve({
          generation,
          status: 'ready',
          entries: [],
          nextCursor: null,
          error: null,
        } satisfies VaultFilePage);
      }
      return Promise.resolve(undefined);
    });
    await vault.forget('/vault');
    expect((await vault.listFilesPage('')).status).toBe('stale');
    await vault.open();
    await vault.listFilesPage('');
    expect(pageArguments[3]?.generation).toBe(24);
  });

  it('keeps forget and reorder void promises while propagating native failures', async () => {
    const pageArguments: Array<Record<string, unknown>> = [];
    mocks.invoke.mockImplementation((command, args) => {
      if (command === 'vault_open')
        return Promise.resolve({
          ok: true,
          root: '/vault',
          generation: 30,
          sessionGeneration: 30,
        } satisfies OpenResult);
      if (command === 'vault_forget')
        return Promise.resolve({
          ok: false,
          generation: 30,
          sessionGeneration: 30,
          currentChanged: false,
          error: 'Could not update vault list.',
        } satisfies TransitionResult);
      if (command === 'vault_reorder')
        return Promise.resolve({
          ok: false,
          error: 'Could not save order.',
        });
      if (command === 'vault_files_page') {
        pageArguments.push(args as Record<string, unknown>);
        const generation = (args as { generation: number }).generation;
        return Promise.resolve({
          generation,
          status: 'ready',
          entries: [],
          nextCursor: null,
          error: null,
        } satisfies VaultFilePage);
      }
      return Promise.resolve(undefined);
    });

    const vault = openVaultApi();
    await vault.open();
    if (!vault.reorder) throw new Error('Tauri vault reorder bridge is missing.');
    await expect(vault.forget('/other-vault')).rejects.toThrow('Could not update vault list.');
    await expect(vault.reorder(['/vault'])).rejects.toThrow('Could not save order.');
    await vault.listFilesPage('');
    expect(pageArguments[0]?.generation).toBe(30);
  });
});
