// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { allocateSideInstanceId, isSideInstanceIdFor, visiblePaneLeaves } from './paneLayout';
import { PANE_TABS_STORAGE_KEY, readPaneTabsSnapshot } from './paneLayoutStorage';

// Synthetic export only. A migration pilot can obtain the source by reading
// localStorage.getItem('morrow.tabs') inside a disposable Electron profile; this suite
// deliberately never opens or copies a real Electron profile.
function twoPaneForkSnapshot(): string {
  return JSON.stringify({
    schemaVersion: 2,
    paneLayout: {
      version: 1,
      id: 'two-pane-layout',
      root: {
        kind: 'split',
        id: 'two-pane-root',
        axis: 'columns',
        ratio: 0.61,
        first: { kind: 'leaf', id: 'main-pane', tabId: 'two-pane-tab' },
        second: { kind: 'leaf', id: 'side-pane', tabId: 'two-pane-tab:side' },
      },
      focusedPaneId: 'side-pane',
    },
    tabs: [
      {
        id: 'two-pane-tab',
        groupId: 'two-pane-tab',
        target: '#/page/main',
        back: ['#/page/main-before'],
        forward: [],
      },
      {
        id: 'two-pane-tab:side',
        groupId: 'two-pane-tab',
        target: '#/page/side',
        back: ['#/page/side-before'],
        forward: ['#/page/side-after'],
      },
    ],
    closed: ['#/page/closed'],
  });
}

function latestForkSnapshot(): string {
  return JSON.stringify({
    schemaVersion: 2,
    paneLayout: {
      version: 1,
      id: 'electron-layout',
      root: {
        kind: 'split',
        id: 'root',
        axis: 'columns',
        ratio: 0.63,
        first: {
          kind: 'split',
          id: 'left',
          axis: 'rows',
          ratio: 0.47,
          first: { kind: 'leaf', id: 'a-main', tabId: 'group-a' },
          second: { kind: 'leaf', id: 'a-side', tabId: 'group-a:side' },
        },
        second: {
          kind: 'split',
          id: 'right',
          axis: 'rows',
          ratio: 0.52,
          first: { kind: 'leaf', id: 'b-main', tabId: 'group-b' },
          second: { kind: 'leaf', id: 'b-side', tabId: 'group-b:side' },
        },
      },
      focusedPaneId: 'b-side',
    },
    tabs: [
      {
        id: 'group-a',
        groupId: 'group-a',
        target: '#/page/a-main',
        back: ['#/page/a-main-before'],
        forward: [],
        pinned: true,
      },
      {
        id: 'group-a:side',
        groupId: 'group-a',
        target: '#/page/a-side',
        back: ['#/page/a-side-before'],
        forward: [],
        pinned: true,
      },
      {
        id: 'group-b',
        groupId: 'group-b',
        target: '#/page/b-main',
        back: ['#/page/b-main-before'],
        forward: ['#/page/b-main-after'],
      },
      {
        id: 'group-b:side',
        groupId: 'group-b',
        target: '#/page/b-side',
        back: ['#/page/b-side-before'],
        forward: [],
      },
    ],
    closed: ['#/page/closed-one'],
  });
}

function overflowForkSnapshot(): string {
  const tabs = Array.from({ length: 21 }, (_, index) => ({
    id: `group-${index}`,
    groupId: `group-${index}`,
    target: `#/page/${index}`,
    back: index === 20 ? ['#/page/previous'] : [],
    forward: index === 20 ? ['#/page/next'] : [],
  }));
  return JSON.stringify({
    schemaVersion: 2,
    paneLayout: {
      version: 1,
      id: 'fallback-layout',
      root: { kind: 'leaf', id: 'fallback-pane', tabId: 'group-20' },
      focusedPaneId: 'fallback-pane',
    },
    tabs,
    closed: [],
  });
}

function legacySideCollisionSnapshot(collisionCount: number, withSide: boolean): string {
  const collisionIds = [
    'main:side',
    ...Array.from({ length: collisionCount - 1 }, (_, index) => `main:side:${index + 2}`),
  ];
  return JSON.stringify({
    tabs: [
      {
        id: 'main',
        hash: '#/page/main',
        back: ['#/page/main-before'],
        forward: ['#/page/main-after'],
        side: withSide
          ? { hash: '#/page/side', back: ['#/page/side-before'], forward: ['#/page/side-after'] }
          : null,
      },
      ...collisionIds.map((id, index) => ({
        id,
        hash: `#/page/collision-${index}`,
        back: [],
        forward: [],
        side: null,
      })),
    ],
    active: 'main',
    pane: withSide ? 'side' : 'main',
    closed: [],
  });
}

async function freshTabs(raw: string | null, initialHash = '') {
  window.history.replaceState(null, '', `/${initialHash}`);
  window.localStorage.clear();
  if (raw !== null) window.localStorage.setItem(PANE_TABS_STORAGE_KEY, raw);
  const writes: string[] = [];
  const originalSetItem = window.localStorage.setItem.bind(window.localStorage);
  const originalGetItem = window.localStorage.getItem.bind(window.localStorage);
  vi.spyOn(window.localStorage, 'setItem').mockImplementation((key, value) => {
    if (key === PANE_TABS_STORAGE_KEY) writes.push(value);
    originalSetItem(key, value);
  });
  vi.resetModules();
  const tabs = await import('./tabs');
  const router = await import('./router');
  const writeFromOtherContext = (value: string) => originalSetItem(PANE_TABS_STORAGE_KEY, value);
  const readFromStorage = () => originalGetItem(PANE_TABS_STORAGE_KEY);
  return { tabs, router, writes, writeFromOtherContext, readFromStorage };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('two-pane runtime snapshot compatibility', () => {
  it('shares an exact side-instance suffix contract between the allocator and matcher', () => {
    expect(isSideInstanceIdFor('main', 'main:side')).toBe(true);
    expect(isSideInstanceIdFor('main', 'main:side:2')).toBe(true);
    expect(isSideInstanceIdFor('main', 'main:side:10')).toBe(true);
    expect(isSideInstanceIdFor('main', 'main:side2')).toBe(false);
    expect(isSideInstanceIdFor('main', 'main:side:1')).toBe(false);
    expect(isSideInstanceIdFor('main', 'main:side:02')).toBe(false);
    expect(isSideInstanceIdFor('main', 'other:side:2')).toBe(false);

    const usedIds = new Set([
      'main',
      'main:side',
      ...Array.from({ length: 8 }, (_, index) => `main:side:${index + 2}`),
    ]);
    expect(allocateSideInstanceId('main', usedIds)).toBe('main:side:10');
    expect(usedIds.has('main:side:10')).toBe(true);
  });

  it.each([
    [1, 'main:side:2'],
    [9, 'main:side:10'],
  ] as const)('recognizes migrated and newly allocated side collision id %s', async (collisions, sideId) => {
    const { tabs, readFromStorage } = await freshTabs(legacySideCollisionSnapshot(collisions, true));
    const restored = tabs.getTabs();

    expect(restored).toMatchObject({ active: 'main', pane: 'side' });
    expect(restored.tabs[0]).toMatchObject({
      id: 'main',
      side: {
        hash: '#/page/side',
        back: ['#/page/side-before'],
        forward: ['#/page/side-after'],
      },
    });
    expect(restored.layout.tabs.map((tab) => tab.id)).toContain(sideId);
    expect(tabs.routeHashForPane('side')).toBe('#/page/side');

    tabs.openTab('#/page/background', { background: true });
    const afterBackground = readPaneTabsSnapshot(readFromStorage());
    expect(afterBackground.kind).toBe('legacy');
    if (afterBackground.kind === 'legacy') {
      expect(afterBackground.snapshot.tabs.find((tab) => tab.id === 'main')?.side).toMatchObject({
        hash: '#/page/side',
        back: ['#/page/side-before'],
        forward: ['#/page/side-after'],
      });
      expect(afterBackground.snapshot.tabs.some((tab) => tab.hash === '#/page/background')).toBe(true);
    }

    const withoutSide = await freshTabs(legacySideCollisionSnapshot(collisions, false));
    withoutSide.tabs.openSide('#/page/new-side');
    expect(withoutSide.tabs.getTabs().pane).toBe('side');
    expect(withoutSide.tabs.routeHashForPane('side')).toBe('#/page/new-side');
    expect(withoutSide.tabs.getTabs().layout.tabs.map((tab) => tab.id)).toContain(sideId);
    const afterSplit = readPaneTabsSnapshot(withoutSide.readFromStorage());
    expect(afterSplit.kind).toBe('legacy');
    if (afterSplit.kind === 'legacy') {
      expect(afterSplit.snapshot.tabs.find((tab) => tab.id === 'main')?.side?.hash).toBe('#/page/new-side');
    }
  });

  it('loads the 2.2 snapshot into the existing two-panel state and writes only its old wire shape', async () => {
    const raw = JSON.stringify({
      tabs: [
        {
          id: 'legacy',
          hash: '#/page/main',
          back: ['#/page/before'],
          forward: ['#/page/after'],
          side: { hash: '#/page/side', back: ['#/page/side-before'], forward: [] },
          pinned: true,
        },
        { id: 'other', hash: '#/tasks', back: [], forward: [], side: null },
      ],
      active: 'legacy',
      pane: 'side',
      closed: ['#/page/closed'],
    });
    const { tabs, writes } = await freshTabs(raw, '#/page/main');

    const restored = tabs.getTabs();
    expect(restored.tabs[0]).toMatchObject({
      id: 'legacy',
      hash: '#/page/main',
      back: ['#/page/before'],
      forward: ['#/page/after'],
      side: { hash: '#/page/side', back: ['#/page/side-before'], forward: [] },
      pinned: true,
    });
    expect(restored.active).toBe('legacy');
    expect(restored.pane).toBe('side');
    expect(restored.closed).toEqual(['#/page/closed']);
    expect(window.location.hash).toBe('#/page/main');
    expect(writes).toEqual([]);

    tabs.openTab('#/page/new');
    expect(writes).toHaveLength(1);
    const saved = JSON.parse(writes[0]!) as Record<string, unknown>;
    expect(Object.keys(saved).sort()).toEqual(['active', 'closed', 'pane', 'tabs']);
    expect(saved).not.toHaveProperty('schemaVersion');
    expect(saved.closed).toEqual(['#/page/closed']);
    expect(readPaneTabsSnapshot(writes[0]!)).toMatchObject({ kind: 'legacy' });
  });

  it('saves and reopens v0 main and side instances with independent histories for the same note', async () => {
    const raw = JSON.stringify({
      tabs: [
        {
          id: 'shared-note',
          hash: '#/page/shared-note',
          back: ['#/page/main-before'],
          forward: ['#/page/main-forward'],
          side: {
            hash: '#/page/shared-note',
            back: ['#/page/side-before'],
            forward: ['#/page/side-forward'],
          },
        },
      ],
      active: 'shared-note',
      pane: 'side',
      closed: [],
    });
    const first = await freshTabs(raw, '#/page/shared-note');
    const stop = first.tabs.startTabs();

    expect(first.tabs.getTabs().layout.tabs.map((tab) => tab.id)).toEqual([
      'shared-note',
      'shared-note:side',
    ]);
    expect(first.tabs.getTabs().layout.tabs[0]?.target).toBe('#/page/shared-note');
    expect(first.tabs.getTabs().layout.tabs[1]?.target).toBe('#/page/shared-note');

    first.router.navigate({ name: 'page', id: 'side-next', find: null }, { pane: 'side' });
    first.router.navigate({ name: 'page', id: 'main-next', find: null }, { pane: 'main' });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    first.tabs.setActivePane('main');
    first.tabs.setTabPinned('shared-note', true);
    stop();

    expect(window.location.hash).toBe('#/page/main-next');
    expect(first.tabs.routeHashForPane('main')).toBe('#/page/main-next');
    expect(first.tabs.routeHashForPane('side')).toBe('#/page/side-next');
    const saved = first.writes.at(-1)!;
    expect(readPaneTabsSnapshot(saved).kind).toBe('legacy');

    const reopened = await freshTabs(saved, '#/page/main-next');
    expect(reopened.tabs.getTabs()).toMatchObject({ active: 'shared-note', pane: 'main' });
    expect(reopened.tabs.getTabs().layout.tabs).toEqual([
      {
        id: 'shared-note',
        groupId: 'shared-note',
        target: '#/page/main-next',
        back: ['#/page/main-before', '#/page/shared-note'],
        forward: [],
        pinned: true,
      },
      {
        id: 'shared-note:side',
        groupId: 'shared-note',
        target: '#/page/side-next',
        back: ['#/page/side-before', '#/page/shared-note'],
        forward: [],
      },
    ]);
    expect(reopened.tabs.routeHashForPane('main')).toBe('#/page/main-next');
    expect(reopened.tabs.routeHashForPane('side')).toBe('#/page/side-next');
  });

  it('unassigns a legacy split leaf for a solo tab and restores the inactive side on return', async () => {
    const raw = JSON.stringify({
      tabs: [
        {
          id: 'split-a',
          hash: '#/page/a-main',
          back: ['#/page/a-before'],
          forward: [],
          side: { hash: '#/page/a-side', back: ['#/page/side-before'], forward: ['#/page/side-next'] },
        },
        { id: 'solo-b', hash: '#/page/b', back: [], forward: [], side: null },
      ],
      active: 'split-a',
      pane: 'side',
      closed: [],
    });
    const { tabs } = await freshTabs(raw, '#/page/a-main');
    const originalSide = tabs.getTabs().layout.tabs.find((tab) => tab.id === 'split-a:side');
    expect(originalSide).toMatchObject({
      target: '#/page/a-side',
      back: ['#/page/side-before'],
      forward: ['#/page/side-next'],
    });

    tabs.activateTab('solo-b');
    expect(tabs.getTabs().tabs.find((tab) => tab.id === 'solo-b')?.side).toBeNull();
    expect(tabs.getTabs().layout.root.kind).toBe('split');
    expect(visiblePaneLeaves(tabs.getTabs().layout).map((leaf) => leaf.tabId)).toEqual(['solo-b', null]);
    expect(tabs.getTabs().layout.tabs.find((tab) => tab.id === 'split-a:side')).toBe(originalSide);

    tabs.activateTab('split-a');
    expect(tabs.getTabs().tabs.find((tab) => tab.id === 'split-a')?.side).toMatchObject({
      hash: '#/page/a-side',
      back: ['#/page/side-before'],
      forward: ['#/page/side-next'],
    });
    expect(tabs.getTabs().layout.root.kind).toBe('split');
    expect(visiblePaneLeaves(tabs.getTabs().layout).map((leaf) => leaf.tabId)).toEqual([
      'split-a',
      'split-a:side',
    ]);
    expect(tabs.getTabs().layout.tabs.find((tab) => tab.id === 'split-a:side')).toBe(originalSide);
  });

  it('projects a two-pane Electron snapshot with its focused side while keeping the v2 source unchanged', async () => {
    const raw = twoPaneForkSnapshot();
    const { tabs, writes } = await freshTabs(raw);

    const restored = tabs.getTabs();
    expect(restored.tabs).toHaveLength(1);
    expect(restored.tabs[0]).toMatchObject({
      id: 'two-pane-tab',
      hash: '#/',
      back: ['#/page/main-before', '#/page/main'],
      side: {
        hash: '#/page/side',
        back: ['#/page/side-before'],
        forward: ['#/page/side-after'],
      },
    });
    expect(restored.pane).toBe('side');
    expect(restored.closed).toEqual(['#/page/closed']);
    expect(window.location.hash).toBe('');

    tabs.openSide('#/page/temporary-side');
    tabs.showInMain('#/page/temporary-main');
    expect(window.localStorage.getItem(PANE_TABS_STORAGE_KEY)).toBe(raw);
    expect(writes).toEqual([]);
  });

  it('projects a four-pane Electron fixture into the focused pair and never rewrites its v2 bytes', async () => {
    const raw = latestForkSnapshot();
    const { tabs, writes } = await freshTabs(raw);

    const restored = tabs.getTabs();
    expect(restored.tabs).toHaveLength(2);
    expect(restored.tabs[0]).toMatchObject({
      id: 'group-a',
      hash: '#/page/a-main',
      side: { hash: '#/page/a-side', back: ['#/page/a-side-before'] },
      pinned: true,
    });
    expect(restored.tabs[1]).toMatchObject({
      id: 'group-b',
      hash: '#/',
      back: ['#/page/b-main-before', '#/page/b-main'],
      forward: ['#/page/b-main-after'],
      side: { hash: '#/page/b-side', back: ['#/page/b-side-before'] },
    });
    expect(restored.active).toBe('group-b');
    expect(restored.pane).toBe('side');
    expect(restored.closed).toEqual(['#/page/closed-one']);
    expect(window.location.hash).toBe('');
    expect(writes).toEqual([]);

    const stop = tabs.startTabs();
    tabs.showInMain('#/page/temporary-navigation');
    tabs.openTab('#/page/temporary-tab');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true }));
    tabs.closeTab();
    tabs.openSide('#/page/temporary-side');
    tabs.closeSide();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    stop();

    expect(window.localStorage.getItem(PANE_TABS_STORAGE_KEY)).toBe(raw);
    expect(writes).toEqual([]);
  });

  it('keeps a direct external hash as the main route before the tabs listener starts', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const raw = JSON.stringify({
      tabs: [
        {
          id: 'legacy-split',
          hash: '#/page/saved-main',
          back: [],
          forward: [],
          side: { hash: '#/page/saved-side', back: [], forward: [] },
        },
      ],
      active: 'legacy-split',
      pane: 'main',
      closed: [],
    });
    const { tabs, router } = await freshTabs(raw, '#/page/saved-main');
    tabs.getTabs();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const RouteContent = ({ id }: { id: string }) =>
      createElement('output', { id }, router.routeHash(router.useRoute()));
    const RouteProbe = ({ pane, id }: { pane: 'main' | 'side'; id: string }) =>
      createElement(tabs.PaneContext.Provider, { value: pane }, createElement(RouteContent, { id }));

    try {
      await act(async () => {
        root.render(
          createElement(
            Fragment,
            null,
            createElement(RouteProbe, { pane: 'main', id: 'main-route' }),
            createElement(RouteProbe, { pane: 'side', id: 'side-route' }),
          ),
        );
      });
      expect(container.querySelector('#main-route')?.textContent).toBe('#/page/saved-main');
      expect(container.querySelector('#side-route')?.textContent).toBe('#/page/saved-side');

      await act(async () => {
        window.location.hash = '#/page/external';
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });

      expect(container.querySelector('#main-route')?.textContent).toBe('#/page/external');
      expect(container.querySelector('#side-route')?.textContent).toBe('#/page/saved-side');
      expect(tabs.routeHashForPane('main')).toBe('#/page/saved-main');
      expect(tabs.activeHash()).toBe('#/page/external');
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('routes each pane from its instance while the URL remains the main anchor and hidden instances survive', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const raw = latestForkSnapshot();
    const { tabs, router, writes } = await freshTabs(raw, '#/page/launch');
    const stop = tabs.startTabs();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const RouteContent = ({ id }: { id: string }) =>
      createElement('output', { id }, router.routeHash(router.useRoute()));
    const RouteProbe = ({ pane, id }: { pane: 'main' | 'side'; id: string }) =>
      createElement(tabs.PaneContext.Provider, { value: pane }, createElement(RouteContent, { id }));

    try {
      await act(async () => {
        root.render(
          createElement(
            Fragment,
            null,
            createElement(RouteProbe, { pane: 'main', id: 'main-route' }),
            createElement(RouteProbe, { pane: 'side', id: 'side-route' }),
          ),
        );
      });

      const loaded = tabs.getTabs();
      expect(tabs.getTabs()).toBe(loaded);
      const nodeIds = (node: typeof loaded.layout.root): string[] =>
        node.kind === 'leaf' ? [node.id] : [node.id, ...nodeIds(node.first), ...nodeIds(node.second)];
      expect(nodeIds(loaded.layout.root)).toEqual([
        'root',
        'left',
        'a-main',
        'a-side',
        'right',
        'b-main',
        'b-side',
      ]);
      expect(loaded.layout.tabs.map((tab) => tab.id)).toEqual([
        'group-a',
        'group-a:side',
        'group-b',
        'group-b:side',
      ]);
      expect(container.querySelector('#main-route')?.textContent).toBe('#/page/launch');
      expect(container.querySelector('#side-route')?.textContent).toBe('#/page/b-side');

      await act(async () => {
        router.navigate({ name: 'page', id: 'side-next', find: null }, { pane: 'side' });
      });
      expect(window.location.hash).toBe('#/page/launch');
      expect(container.querySelector('#main-route')?.textContent).toBe('#/page/launch');
      expect(container.querySelector('#side-route')?.textContent).toBe('#/page/side-next');

      await act(async () => {
        router.navigate({ name: 'tasks' }, { pane: 'main' });
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      expect(window.location.hash).toBe('#/tasks');
      expect(container.querySelector('#main-route')?.textContent).toBe('#/tasks');
      expect(container.querySelector('#side-route')?.textContent).toBe('#/page/side-next');

      await act(async () => tabs.goBack('side'));
      expect(window.location.hash).toBe('#/tasks');
      expect(container.querySelector('#side-route')?.textContent).toBe('#/page/b-side');
      expect(tabs.activeHash()).toBe('#/page/b-side');
      tabs.setActivePane('main');
      expect(tabs.getTabs().pane).toBe('main');
      expect(tabs.activeHash()).toBe('#/tasks');
      expect(window.location.hash).toBe('#/tasks');

      const updated = tabs.getTabs();
      expect(updated).not.toBe(loaded);
      expect(updated.layout.tabs.map((tab) => tab.id)).toEqual([
        'group-a',
        'group-a:side',
        'group-b',
        'group-b:side',
      ]);
      expect(nodeIds(updated.layout.root)).toEqual(nodeIds(loaded.layout.root));
      expect(updated.layout.root).toBe(loaded.layout.root);
      expect(updated.layout.tabs[0]).toBe(loaded.layout.tabs[0]);
      expect(updated.layout.tabs[1]).toBe(loaded.layout.tabs[1]);
      expect(updated.layout.tabs.slice(0, 2)).toEqual(loaded.layout.tabs.slice(0, 2));
      expect(updated.layout.tabs[2]).toMatchObject({
        id: 'group-b',
        target: '#/tasks',
        back: ['#/page/b-main-before', '#/page/b-main', '#/page/launch'],
      });
      expect(updated.layout.tabs[3]).toMatchObject({
        id: 'group-b:side',
        target: '#/page/b-side',
        back: ['#/page/b-side-before'],
        forward: ['#/page/side-next'],
      });
      expect(window.localStorage.getItem(PANE_TABS_STORAGE_KEY)).toBe(raw);
      expect(writes).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      stop();
    }
  });

  it.each([
    ['future version', '{"schemaVersion":3,"tabs":[{"future":"kept"}]}'],
    ['malformed JSON', '{malformed bytes'],
  ])('keeps %s unchanged while navigation, shortcuts, and close work in memory', async (_name, raw) => {
    const { tabs, writes } = await freshTabs(raw);
    const stop = tabs.startTabs();
    tabs.openTab('#/page/temporary');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true }));
    tabs.showInMain('#/tasks');
    tabs.openSide('#/journal');
    tabs.closeSide();
    tabs.closeTab();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    stop();

    expect(window.localStorage.getItem(PANE_TABS_STORAGE_KEY)).toBe(raw);
    expect(writes).toEqual([]);
  });

  it('matches the 2.2 empty-hash startup history without assigning the saved route to the URL', async () => {
    const raw = JSON.stringify({
      tabs: [
        {
          id: 'legacy',
          hash: '#/page/saved',
          back: ['#/page/before'],
          forward: ['#/page/forward'],
          side: null,
        },
      ],
      active: 'legacy',
      pane: 'main',
      closed: [],
    });
    const { tabs } = await freshTabs(raw);

    expect(tabs.getTabs().tabs[0]).toMatchObject({
      hash: '#/',
      back: ['#/page/before', '#/page/saved'],
      forward: ['#/page/forward'],
    });
    expect(window.location.hash).toBe('');
  });

  it('keeps 2.2 forward history when an explicit deep link overrides the saved route', async () => {
    const raw = JSON.stringify({
      tabs: [
        {
          id: 'legacy',
          hash: '#/page/saved',
          back: ['#/page/before'],
          forward: ['#/page/forward'],
          side: null,
        },
      ],
      active: 'legacy',
      pane: 'main',
      closed: [],
    });
    const { tabs } = await freshTabs(raw, '#/page/deep-link');

    expect(tabs.getTabs().tabs[0]).toMatchObject({
      hash: '#/page/deep-link',
      back: ['#/page/before', '#/page/saved'],
      forward: ['#/page/forward'],
    });
    expect(window.location.hash).toBe('#/page/deep-link');
  });

  it.each([
    ['v2', twoPaneForkSnapshot()],
    ['future', '{"schemaVersion":3,"opaque":[1,2,3]}'],
    ['malformed', '{external bytes'],
  ])('does not overwrite a %s written by another context after loading v0', async (_name, externalRaw) => {
    const legacyRaw = JSON.stringify({
      tabs: [{ id: 'legacy', hash: '#/page/saved', back: [], forward: [], side: null }],
      active: 'legacy',
      pane: 'main',
      closed: [],
    });
    const { tabs, writes, writeFromOtherContext } = await freshTabs(legacyRaw, '#/page/saved');
    tabs.getTabs();

    writeFromOtherContext(externalRaw);
    tabs.openTab('#/page/new');
    tabs.setTabPinned(tabs.getTabs().active, true);

    expect(window.localStorage.getItem(PANE_TABS_STORAGE_KEY)).toBe(externalRaw);
    expect(writes).toEqual([]);
  });

  it('does not write when the pre-write storage read fails', async () => {
    const raw = JSON.stringify({
      tabs: [{ id: 'legacy', hash: '#/page/saved', back: [], forward: [], side: null }],
      active: 'legacy',
      pane: 'main',
      closed: [],
    });
    const { tabs, writes, readFromStorage } = await freshTabs(raw, '#/page/saved');
    tabs.getTabs();
    const getItemSpy = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });

    tabs.openTab('#/page/new');
    getItemSpy.mockRestore();

    expect(writes).toEqual([]);
    expect(readFromStorage()).toBe(raw);
  });

  it('lets Onde parei return to the focused v2 main target without skipping it', async () => {
    const raw = twoPaneForkSnapshot();
    const { tabs, writes } = await freshTabs(raw);
    const stop = tabs.startTabs();

    expect(window.location.hash).toBe('');
    expect(tabs.getTabs()).toMatchObject({
      active: 'two-pane-tab',
      pane: 'side',
      tabs: [
        {
          hash: '#/',
          back: ['#/page/main-before', '#/page/main'],
          forward: [],
          side: {
            hash: '#/page/side',
            back: ['#/page/side-before'],
            forward: ['#/page/side-after'],
          },
        },
      ],
    });

    tabs.goBack('main');
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    stop();

    expect(tabs.getTabs().tabs[0]).toMatchObject({
      hash: '#/page/main',
      back: ['#/page/main-before'],
      forward: ['#/'],
    });
    expect(window.location.hash).toBe('#/page/main');
    expect(window.localStorage.getItem(PANE_TABS_STORAGE_KEY)).toBe(raw);
    expect(writes).toEqual([]);
  });

  it('leaves an empty v2 launch at Home instead of navigating to the projected last page', async () => {
    const raw = twoPaneForkSnapshot();
    const { tabs, router, writes } = await freshTabs(raw);

    expect(tabs.getTabs().tabs[0]).toMatchObject({
      hash: '#/',
      back: ['#/page/main-before', '#/page/main'],
      side: { hash: '#/page/side' },
    });
    expect(window.location.hash).toBe('');
    expect(router.parseRoute(window.location.hash)).toEqual({ name: 'home' });
    expect(window.localStorage.getItem(PANE_TABS_STORAGE_KEY)).toBe(raw);
    expect(writes).toEqual([]);
  });

  it('lets the Today startup navigation replace the v2 launch overlay without writing storage', async () => {
    const raw = twoPaneForkSnapshot();
    const { tabs, router, writes } = await freshTabs(raw);
    const stop = tabs.startTabs();
    tabs.getTabs();

    // useStartPage's real Today action, with a synthetic daily-note id.
    router.navigate({ name: 'page', id: 'today-note', find: null }, { replace: true, pane: 'main' });

    expect(router.parseRoute(window.location.hash)).toEqual({
      name: 'page',
      id: 'today-note',
      find: null,
      anchor: null,
    });
    expect(tabs.getTabs().tabs[0]).toMatchObject({
      hash: '#/page/today-note',
      back: ['#/page/main-before', '#/page/main'],
      forward: [],
      side: { hash: '#/page/side', forward: ['#/page/side-after'] },
    });
    stop();
    expect(window.localStorage.getItem(PANE_TABS_STORAGE_KEY)).toBe(raw);
    expect(writes).toEqual([]);
  });

  it('applies an explicit v2 deep link over the projected main route and retains histories', async () => {
    const raw = twoPaneForkSnapshot();
    const { tabs, writes } = await freshTabs(raw, '#/page/deep-link');

    expect(tabs.getTabs()).toMatchObject({
      active: 'two-pane-tab',
      pane: 'side',
      tabs: [
        {
          hash: '#/page/deep-link',
          back: ['#/page/main-before', '#/page/main'],
          forward: [],
          side: {
            hash: '#/page/side',
            back: ['#/page/side-before'],
            forward: ['#/page/side-after'],
          },
        },
      ],
    });
    expect(window.location.hash).toBe('#/page/deep-link');
    expect(window.localStorage.getItem(PANE_TABS_STORAGE_KEY)).toBe(raw);
    expect(writes).toEqual([]);
  });

  it('applies the same launch overlay to a v2 snapshot that needs a temporary fallback', async () => {
    const raw = overflowForkSnapshot();
    const { tabs, writes } = await freshTabs(raw);

    expect(readPaneTabsSnapshot(raw).kind).toBe('current');
    expect(tabs.getTabs()).toMatchObject({
      tabs: [
        {
          id: 'group-20',
          hash: '#/',
          back: ['#/page/previous', '#/page/20'],
          forward: ['#/page/next'],
          side: null,
        },
      ],
    });
    expect(window.location.hash).toBe('');
    expect(window.localStorage.getItem(PANE_TABS_STORAGE_KEY)).toBe(raw);
    expect(writes).toEqual([]);
  });

  it('keeps an overflow snapshot usable through foreground, background, close, reopen, and navigation', async () => {
    const raw = overflowForkSnapshot();
    const { tabs, writes } = await freshTabs(raw);
    const stop = tabs.startTabs();
    const hiddenInstances = tabs.getTabs().layout.tabs.slice(0, 20);

    expect(tabs.getTabs().tabs.map((tab) => tab.id)).toEqual(['group-20']);
    tabs.openTab('#/page/foreground');
    expect(tabs.getTabs().tabs.map((tab) => tab.hash)).toEqual(['#/', '#/page/foreground']);
    expect(tabs.getTabs().active).not.toBe('group-20');
    tabs.showInMain('#/page/foreground-next');
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(tabs.getTabs().tabs.find((tab) => tab.id === tabs.getTabs().active)?.hash).toBe(
      '#/page/foreground-next',
    );

    tabs.openTab('#/page/background', { background: true });
    const background = tabs.getTabs().tabs.find((tab) => tab.hash === '#/page/background')!;
    expect(tabs.getTabs().active).not.toBe(background.id);
    tabs.activateTab(background.id);
    expect(tabs.getTabs().active).toBe(background.id);
    tabs.showInMain('#/page/background-next');
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    tabs.closeTab(background.id);
    expect(tabs.getTabs().tabs.some((tab) => tab.hash === '#/page/background-next')).toBe(false);
    tabs.reopenClosedTab();
    expect(tabs.getTabs().tabs.find((tab) => tab.id === tabs.getTabs().active)?.hash).toBe(
      '#/page/background-next',
    );
    stop();

    expect(tabs.getTabs().tabs.map((tab) => tab.id)).toContain('group-20');
    const runtimeInstances = tabs.getTabs().layout.tabs;
    expect(runtimeInstances.slice(0, 21).map((tab) => tab.id)).toEqual(
      Array.from({ length: 21 }, (_, index) => `group-${index}`),
    );
    expect(runtimeInstances.slice(21).map((tab) => tab.target)).toEqual([
      '#/page/foreground-next',
      '#/page/background-next',
    ]);
    for (const [index, instance] of hiddenInstances.entries()) {
      expect(runtimeInstances[index]).toBe(instance);
    }
    expect(window.localStorage.getItem(PANE_TABS_STORAGE_KEY)).toBe(raw);
    expect(writes).toEqual([]);
  });

  it('keeps a same-group member without the legacy side suffix as an independent focused tab', async () => {
    const raw = JSON.stringify({
      schemaVersion: 2,
      paneLayout: {
        version: 1,
        id: 'member-layout',
        root: {
          kind: 'split',
          id: 'member-root',
          axis: 'columns',
          ratio: 0.5,
          first: { kind: 'leaf', id: 'group-pane', tabId: 'group' },
          second: { kind: 'leaf', id: 'member-pane', tabId: 'member' },
        },
        focusedPaneId: 'member-pane',
      },
      tabs: [
        { id: 'group', groupId: 'group', target: '#/page/group', back: ['#/page/group-before'], forward: [] },
        { id: 'other', groupId: 'other', target: '#/page/other', back: [], forward: ['#/page/other-next'] },
        {
          id: 'member',
          groupId: 'group',
          target: '#/page/member',
          back: ['#/page/member-before'],
          forward: ['#/page/member-next'],
        },
      ],
      closed: [],
    });
    const { tabs, writes } = await freshTabs(raw, '#/page/launch');

    expect(tabs.getTabs()).toMatchObject({
      active: 'member',
      pane: 'main',
      tabs: [
        { id: 'group', hash: '#/page/group', back: ['#/page/group-before'], side: null },
        { id: 'other', hash: '#/page/other', forward: ['#/page/other-next'], side: null },
        {
          id: 'member',
          hash: '#/page/launch',
          back: ['#/page/member-before', '#/page/member'],
          forward: ['#/page/member-next'],
          side: null,
        },
      ],
    });
    expect(tabs.getTabs().layout.tabs.map((tab) => tab.id)).toEqual(['group', 'other', 'member']);
    expect(tabs.getTabs().layout.tabs[0]?.target).toBe('#/page/group');
    expect(tabs.getTabs().layout.tabs[1]?.target).toBe('#/page/other');
    expect(tabs.getTabs().layout.tabs[2]?.target).toBe('#/page/launch');
    expect(tabs.getTabs().layout.focusedPaneId).toBe('member-pane');

    tabs.activateTab('other');
    expect(tabs.getTabs().active).toBe('other');
    tabs.activateTab('member');
    expect(tabs.getTabs().active).toBe('member');
    expect(tabs.getTabs().layout.tabs.map((tab) => tab.id)).toEqual(['group', 'other', 'member']);
    expect(window.localStorage.getItem(PANE_TABS_STORAGE_KEY)).toBe(raw);
    expect(writes).toEqual([]);
  });

  it('preserves interleaved v2 instance order during side navigation and changes it only on move', async () => {
    const raw = JSON.stringify({
      schemaVersion: 2,
      paneLayout: {
        version: 1,
        id: 'interleaved-layout',
        root: {
          kind: 'split',
          id: 'interleaved-root',
          axis: 'columns',
          ratio: 0.5,
          first: { kind: 'leaf', id: 'main-pane', tabId: 'main' },
          second: { kind: 'leaf', id: 'side-pane', tabId: 'main:side' },
        },
        focusedPaneId: 'main-pane',
      },
      tabs: [
        { id: 'main', groupId: 'main', target: '#/page/main', back: [], forward: [] },
        { id: 'other', groupId: 'other', target: '#/page/other', back: ['#/page/other-before'], forward: [] },
        {
          id: 'main:side',
          groupId: 'main',
          target: '#/page/side',
          back: ['#/page/side-before'],
          forward: ['#/page/side-after'],
        },
      ],
      closed: [],
    });
    const { tabs, writes } = await freshTabs(raw, '#/page/main');

    expect(tabs.getTabs().layout.tabs.map((tab) => tab.id)).toEqual(['main', 'other', 'main:side']);
    tabs.showInSide('#/page/side-next');
    expect(tabs.getTabs().layout.tabs.map((tab) => tab.id)).toEqual(['main', 'other', 'main:side']);
    expect(tabs.routeHashForPane('side')).toBe('#/page/side-next');
    tabs.goBack('side');
    expect(tabs.getTabs().layout.tabs.map((tab) => tab.id)).toEqual(['main', 'other', 'main:side']);
    expect(tabs.routeHashForPane('side')).toBe('#/page/side');
    expect(window.localStorage.getItem(PANE_TABS_STORAGE_KEY)).toBe(raw);
    expect(writes).toEqual([]);

    tabs.moveTab('other', 0);
    expect(tabs.getTabs().tabs.map((tab) => tab.id)).toEqual(['other', 'main']);
    expect(tabs.getTabs().layout.tabs.map((tab) => tab.id)).toEqual(['other', 'main', 'main:side']);
    expect(tabs.getTabs().layout.tabs.map((tab) => tab.id)).toContain('main:side');
    expect(window.localStorage.getItem(PANE_TABS_STORAGE_KEY)).toBe(raw);
    expect(writes).toEqual([]);
  });
});
