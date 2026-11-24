// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceSession } from '../../storage/session';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot> | null = null;
let stopTabs: (() => void) | null = null;
let session: WorkspaceSession | null = null;
let rootElement: HTMLDivElement | null = null;

async function prepareWorkspace(withFourPaneLayout = true) {
  window.history.replaceState(null, '', '/#/page/main');
  window.localStorage.clear();
  vi.resetModules();

  const paneStorage = await import('../paneLayoutStorage');
  if (!withFourPaneLayout) {
    window.localStorage.setItem(
      paneStorage.PANE_TABS_STORAGE_KEY,
      JSON.stringify({
        tabs: [{ id: 'legacy-main', hash: '#/page/main', back: [], forward: [], side: null }],
        active: 'legacy-main',
        pane: 'main',
        closed: [],
      }),
    );
  }
  const tabs = await import('../tabs');
  const ui = await import('../ui');
  const workspace = await import('../workspace');
  const { WorkspaceSession: Session } = await import('../../storage/session');
  const { MemoryVault } = await import('../../storage/memoryVault');
  const { VaultRepository } = await import('../../storage/vaultRepository');
  const { createPage } = await import('../operations');
  const { Pane } = await import('../App');
  const { CommandPalette } = await import('./CommandPalette');

  let id = 0;
  const opened = await Session.open(
    new VaultRepository(new MemoryVault(), () => `palette-scope-${++id}`),
    { delayMs: 0 },
  );
  if (!opened.ok) throw new Error(opened.error);
  session = opened.value;
  workspace.setSession(opened.value);

  const noteId = createPage({ title: 'Gamma note', open: false });
  const databaseId = createPage({ title: 'Gamma database', kind: 'database', open: false });
  const canvasId = createPage({ title: 'Gamma canvas', kind: 'canvas', open: false });
  if (!noteId || !databaseId || !canvasId)
    throw new Error('Could not create test pages in the MemoryVault.');
  const markedCanvas = workspace.run({ type: 'page.markOpened', id: canvasId, now: 1 });
  if (!markedCanvas.ok) throw new Error('Could not mark the Canvas as recently opened.');
  await opened.value.flush();

  let mainPaneId: string;
  let secondPaneId: string | null = null;
  let empty: ReturnType<typeof tabs.paneSlots>[number] | null = null;
  if (withFourPaneLayout) {
    tabs.setPanePreset('two-by-two');
    const [main, second] = tabs.paneSlots();
    if (!main || !second) throw new Error('The two-by-two layout did not expose its first panes.');
    tabs.showInPane('#/page/second', second.paneId);
    const slots = tabs.paneSlots();
    empty = slots[2] ?? null;
    if (!empty || empty.tabId !== null) throw new Error('The third pane is not empty.');
    mainPaneId = main.paneId;
    secondPaneId = second.paneId;
  } else {
    const main = tabs.paneSlots()[0];
    if (!main) throw new Error('The legacy tab did not expose its main pane.');
    mainPaneId = main.paneId;
  }

  class ResizeObserverStub {
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);

  const PaletteHost = () => {
    const currentUi = ui.useUi();
    if (!currentUi.palette) return null;
    const key = currentUi.paletteForSide
      ? 'side'
      : currentUi.palettePaneScope
        ? `pane:${currentUi.palettePaneScope.sessionGeneration}:${currentUi.palettePaneScope.topologyRevision}:${currentUi.palettePaneScope.paneId}`
        : 'main';
    return createElement(CommandPalette, { key });
  };

  rootElement = document.createElement('div');
  document.body.append(rootElement);
  root = createRoot(rootElement);
  await act(async () => {
    root!.render(
      createElement(
        Fragment,
        null,
        empty
          ? createElement(Pane, {
              role: empty.role,
              paneId: empty.paneId,
              tabId: null,
              route: null,
              active: false,
            })
          : null,
        createElement(PaletteHost),
      ),
    );
  });

  return {
    tabs,
    ui,
    mainPaneId,
    secondPaneId,
    targetPaneId: empty?.paneId ?? null,
    noteId,
    databaseId,
    canvasId,
    workspace,
  };
}

async function openScopedPalette(container: HTMLElement): Promise<HTMLInputElement> {
  const button = container.querySelector('button');
  if (!button) throw new Error('The empty-pane action is missing.');
  await act(async () => button.click());
  const input = container.querySelector<HTMLInputElement>('.palette-input');
  if (!input) throw new Error('The command palette did not open.');
  return input;
}

async function searchPalette(input: HTMLInputElement, query: string): Promise<void> {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setValue?.call(input, query);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function choosePaletteEntry(container: HTMLElement, title: string): Promise<void> {
  const entry = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]')).find((item) =>
    item.textContent?.includes(title),
  );
  if (!entry) throw new Error(`The command palette result “${title}” is missing.`);
  await act(async () => entry.click());
}

function paletteEntryTitles(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="option"]')).map(
    (entry) => entry.querySelector('.palette-item-title')?.firstChild?.textContent?.trim() ?? '',
  );
}

function fillTabsToCapacity(tabs: Awaited<ReturnType<typeof prepareWorkspace>>['tabs'], reusable?: string): void {
  if (reusable) tabs.openTab(reusable, { background: true });
  let index = 0;
  while (tabs.getTabs().layout.tabs.length < 20) {
    tabs.openTab(`#/page/capacity-${index++}`, { background: true });
  }
  if (tabs.getTabs().layout.tabs.length !== 20) throw new Error('Could not fill the tab registry to its limit.');
}

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  stopTabs?.();
  stopTabs = null;
  if (session) await session.flush();
  session = null;
  rootElement?.remove();
  rootElement = null;
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

describe('pane-scoped command palette', () => {
  describe('captured-pane routing', () => {
    let fixture: Awaited<ReturnType<typeof prepareWorkspace>>;

    // The first App import is cold in a fresh Vitest worker. Keep this budget on setup,
    // outside the 5s interaction assertions, so a slow module graph cannot leak into
    // the next case after a timed-out fixture.
    beforeEach(async () => {
      fixture = await prepareWorkspace();
    }, 20_000);

    it.each([
      ['note', 'Gamma note'],
      ['database', 'Gamma database'],
    ] as const)('opens a selected %s in its captured pane after Ctrl+Tab changes focus', async (_, title) => {
      const { targetPaneId, mainPaneId, secondPaneId } = fixture;
      if (!targetPaneId || !secondPaneId) throw new Error('Missing scoped pane fixture.');
      stopTabs = fixture.tabs.startTabs();
      const input = await openScopedPalette(rootElement!);

      expect(fixture.tabs.targetPane()).toBe(targetPaneId);
      await act(async () => {
        input.dispatchEvent(
          new window.KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true }),
        );
      });
      expect(fixture.tabs.targetPane()).toBe(mainPaneId);

      await searchPalette(input, title);
      await choosePaletteEntry(rootElement!, title);

      const selectedId = title === 'Gamma note' ? fixture.noteId : fixture.databaseId;
      expect(fixture.tabs.routeHashForPane(targetPaneId)).toBe(`#/page/${selectedId}`);
      expect(fixture.tabs.routeHashForPane(mainPaneId)).toBe('#/page/main');
      expect(fixture.tabs.routeHashForPane(secondPaneId)).toBe('#/page/second');
      expect(window.location.hash).toBe('#/page/main');
    });

    it.each([
      ['Ctrl+Enter', { ctrlKey: true }],
      ['Meta+Enter', { metaKey: true }],
    ] as const)('routes the %s search into the captured empty pane', async (_, modifiers) => {
      const { targetPaneId, mainPaneId, secondPaneId } = fixture;
      if (!targetPaneId || !secondPaneId) throw new Error('Missing scoped pane fixture.');
      stopTabs = fixture.tabs.startTabs();
      const input = await openScopedPalette(rootElement!);
      await searchPalette(input, 'Gamma note');

      await act(async () => {
        input.dispatchEvent(
          new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...modifiers }),
        );
      });

      expect(fixture.ui.getUi().palette).toBe(false);
      expect(fixture.tabs.routeHashForPane(targetPaneId)).toBe('#/search?q=Gamma%20note');
      expect(fixture.tabs.routeHashForPane(mainPaneId)).toBe('#/page/main');
      expect(fixture.tabs.routeHashForPane(secondPaneId)).toBe('#/page/second');
      expect(window.location.hash).toBe('#/page/main');
    });
  });

  it.each([
    ['occupied', { ctrlKey: true }],
    ['session changed', { metaKey: true }],
  ] as const)('refuses the search shortcut when its captured pane is %s', async (change, modifiers) => {
    const fixture = await prepareWorkspace();
    const targetPaneId = fixture.targetPaneId;
    if (!targetPaneId) throw new Error('Missing scoped pane fixture.');
    const input = await openScopedPalette(rootElement!);

    if (change === 'occupied') fixture.tabs.showInPane('#/page/occupied', targetPaneId);
    else {
      const { WorkspaceSession: Session } = await import('../../storage/session');
      const { MemoryVault } = await import('../../storage/memoryVault');
      const { VaultRepository } = await import('../../storage/vaultRepository');
      const opened = await Session.open(new VaultRepository(new MemoryVault(), () => 'replacement'), {
        delayMs: 0,
      });
      if (!opened.ok) throw new Error(opened.error);
      fixture.workspace.setSession(opened.value);
      session = opened.value;
    }

    await searchPalette(input, 'Gamma note');
    await act(async () => {
      input.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...modifiers }),
      );
    });

    expect(fixture.ui.getUi().palette).toBe(false);
    expect(fixture.ui.getUi().toasts.some((toast) => toast.tone === 'error')).toBe(true);
    expect(fixture.tabs.getTabs().layout.tabs.some((tab) => tab.target.startsWith('#/search'))).toBe(
      false,
    );
    if (change === 'occupied') {
      expect(fixture.tabs.routeHashForPane(targetPaneId)).toBe('#/page/occupied');
    }
    expect(window.location.hash).toBe('#/page/main');
  });

  it('limits the empty-pane palette to note creation and routed note/database search, then restores global commands', async () => {
    const fixture = await prepareWorkspace();
    const input = await openScopedPalette(rootElement!);

    await searchPalette(input, '>');
    const scopedActions = Array.from(rootElement!.querySelectorAll<HTMLElement>('[role="option"]')).map(
      (entry) => entry.textContent?.trim(),
    );
    expect(scopedActions).toEqual(['New page']);

    await act(async () => {
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(fixture.ui.getUi().palette).toBe(false);
    expect(fixture.ui.getUi().palettePaneScope).toBeNull();

    await act(async () => fixture.ui.setUi({ palette: true, palettePaneScope: null }));
    const globalInput = rootElement!.querySelector<HTMLInputElement>('.palette-input');
    if (!globalInput) throw new Error('The global command palette did not reopen.');
    await searchPalette(globalInput, '>new database');
    expect(rootElement!.querySelector('[role="option"]')?.textContent).toContain('New database');
  });

  it('keeps Canvas in global recents and exact search results', async () => {
    const fixture = await prepareWorkspace();
    await act(async () => fixture.ui.setUi({ palette: true, palettePaneScope: null }));
    const input = rootElement!.querySelector<HTMLInputElement>('.palette-input');
    if (!input) throw new Error('The global command palette did not open.');
    expect(paletteEntryTitles(rootElement!)).toContain('Gamma canvas');

    await searchPalette(input, 'Gamma canvas');
    expect(paletteEntryTitles(rootElement!)).toContain('Gamma canvas');
    expect(paletteEntryTitles(rootElement!).some((title) => title.startsWith('Search every page'))).toBe(
      true,
    );
    expect(fixture.tabs.getTabs().layout.tabs.some((tab) => tab.target === `#/page/${fixture.canvasId}`)).toBe(
      false,
    );
  });

  it('keeps Canvas visible and openable in the legacy Open beside palette', async () => {
    const fixture = await prepareWorkspace(false);
    await act(async () =>
      fixture.ui.setUi({ palette: true, paletteForSide: false, palettePaneScope: null }),
    );
    let input = rootElement!.querySelector<HTMLInputElement>('.palette-input');
    if (!input) throw new Error('The global command palette did not open.');
    await searchPalette(input, '>open beside');
    await choosePaletteEntry(rootElement!, 'Open beside, in a split');

    input = rootElement!.querySelector<HTMLInputElement>('.palette-input');
    if (!input) throw new Error('The legacy side palette did not reopen.');
    await searchPalette(input, 'Gamma canvas');
    expect(paletteEntryTitles(rootElement!)).toContain('Gamma canvas');
    await choosePaletteEntry(rootElement!, 'Gamma canvas');
    expect(fixture.tabs.routeHashForPane('side')).toBe(`#/page/${fixture.canvasId}`);
  });

  it('hides Canvas in the empty-pane scope without offering a duplicate title', async () => {
    await prepareWorkspace();
    const input = await openScopedPalette(rootElement!);
    expect(paletteEntryTitles(rootElement!)).not.toContain('Gamma canvas');

    await searchPalette(input, 'Gamma canvas');
    const titles = paletteEntryTitles(rootElement!);
    expect(titles).not.toContain('Gamma canvas');
    expect(titles.some((title) => title.startsWith('Create'))).toBe(false);
  });

  it('reuses an unassigned matching tab at capacity without changing its history', async () => {
    const fixture = await prepareWorkspace();
    const reusableHash = `#/page/${fixture.noteId}`;
    const fourth = fixture.tabs.paneSlots()[3];
    const main = fixture.tabs.paneAssignments().find((assignment) => assignment.role === 'main');
    if (!fourth || !main) throw new Error('Missing empty pane or main assignment fixture.');

    fixture.tabs.showInPane(reusableHash, fourth.paneId);
    fixture.tabs.showInPane('#/page/reusable-history', fourth.paneId);
    fixture.tabs.goBack(fourth.paneId);
    const reusable = fixture.tabs.getTabs().layout.tabs.find((tab) => tab.target === reusableHash);
    if (!reusable) throw new Error('Could not create the reusable route fixture.');
    const history = { back: [...reusable.back], forward: [...reusable.forward] };
    fixture.tabs.assignTabToPane(main.tabId, fourth.paneId);
    fillTabsToCapacity(fixture.tabs);
    const targetPaneId = fixture.targetPaneId;
    if (!targetPaneId) throw new Error('Missing scoped pane fixture.');

    const input = await openScopedPalette(rootElement!);
    await searchPalette(input, 'Gamma note');
    await choosePaletteEntry(rootElement!, 'Gamma note');

    expect(fixture.tabs.getTabs().layout.tabs).toHaveLength(20);
    expect(fixture.tabs.paneAssignments().find((assignment) => assignment.paneId === targetPaneId)?.tabId).toBe(
      reusable.id,
    );
    const reusedAfterOpen = fixture.tabs.getTabs().layout.tabs.find((tab) => tab.id === reusable.id);
    expect(reusedAfterOpen?.back).toEqual(history.back);
    expect(reusedAfterOpen?.forward).toEqual(history.forward);
  });

  it('reports capacity and creates no note when an empty pane cannot accept another tab', async () => {
    const fixture = await prepareWorkspace();
    fillTabsToCapacity(fixture.tabs);
    const pageCount = Object.keys(fixture.workspace.getState().pages).length;

    let input = await openScopedPalette(rootElement!);
    await searchPalette(input, 'Gamma note');
    await choosePaletteEntry(rootElement!, 'Gamma note');
    expect(fixture.tabs.getTabs().layout.tabs).toHaveLength(20);
    expect(fixture.tabs.getTabs().layout.tabs.some((tab) => tab.target === `#/page/${fixture.noteId}`)).toBe(
      false,
    );
    expect(fixture.ui.getUi().toasts.at(-1)?.message).toBe(
      'The tab limit is reached. Close a tab and try again.',
    );

    input = await openScopedPalette(rootElement!);
    await searchPalette(input, '>');
    await choosePaletteEntry(rootElement!, 'New page');
    expect(Object.keys(fixture.workspace.getState().pages)).toHaveLength(pageCount);
    expect(fixture.tabs.getTabs().layout.tabs).toHaveLength(20);
    expect(fixture.ui.getUi().toasts.at(-1)?.message).toBe(
      'The tab limit is reached. Close a tab and try again.',
    );
  });

  it.each(['occupied', 'removed', 'session changed'] as const)(
    'refuses to route through a pane scope that became %s before selection',
    async (change) => {
      const fixture = await prepareWorkspace();
      const targetPaneId = fixture.targetPaneId;
      if (!targetPaneId) throw new Error('Missing scoped pane fixture.');
      const input = await openScopedPalette(rootElement!);

      if (change === 'occupied') fixture.tabs.showInPane('#/page/occupied', targetPaneId);
      else if (change === 'removed') fixture.tabs.setPanePreset('two-columns');
      else {
        const { WorkspaceSession: Session } = await import('../../storage/session');
        const { MemoryVault } = await import('../../storage/memoryVault');
        const { VaultRepository } = await import('../../storage/vaultRepository');
        const opened = await Session.open(new VaultRepository(new MemoryVault(), () => 'replacement'), {
          delayMs: 0,
        });
        if (!opened.ok) throw new Error(opened.error);
        fixture.workspace.setSession(opened.value);
        session = opened.value;
      }

      await searchPalette(input, 'Gamma note');
      await choosePaletteEntry(rootElement!, 'Gamma note');

      expect(fixture.ui.getUi().palette).toBe(false);
      expect(fixture.ui.getUi().toasts.some((toast) => toast.tone === 'error')).toBe(true);
      expect(fixture.tabs.getTabs().layout.tabs.some((tab) => tab.target === `#/page/${fixture.noteId}`)).toBe(
        false,
      );
      expect(window.location.hash).toBe('#/page/main');
    },
  );

  it('keeps the legacy Open beside palette lane live and unscoped', async () => {
    const fixture = await prepareWorkspace(false);
    await act(async () =>
      fixture.ui.setUi({ palette: true, paletteForSide: false, palettePaneScope: null }),
    );
    const input = rootElement!.querySelector<HTMLInputElement>('.palette-input');
    if (!input) throw new Error('The global command palette did not open.');

    await searchPalette(input, '>open beside');
    await choosePaletteEntry(rootElement!, 'Open beside, in a split');

    expect(fixture.ui.getUi().palette).toBe(true);
    expect(fixture.ui.getUi().paletteForSide).toBe(true);
    expect(fixture.ui.getUi().palettePaneScope).toBeNull();
    const sideInput = rootElement!.querySelector<HTMLInputElement>('.palette-input');
    if (!sideInput) throw new Error('The legacy side palette did not reopen.');

    await searchPalette(sideInput, 'Gamma note');
    await choosePaletteEntry(rootElement!, 'Gamma note');

    expect(fixture.tabs.routeHashForPane('main')).toBe('#/page/main');
    expect(fixture.tabs.routeHashForPane('side')).toBe(`#/page/${fixture.noteId}`);
    expect(fixture.ui.getUi().palettePaneScope).toBeNull();
  });
});
