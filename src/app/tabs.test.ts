// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('two-pane runtime snapshot compatibility', () => {
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
    const tabsSnapshot = Array.from({ length: 21 }, (_, index) => ({
      id: `group-${index}`,
      groupId: `group-${index}`,
      target: `#/page/${index}`,
      back: index === 20 ? ['#/page/previous'] : [],
      forward: index === 20 ? ['#/page/next'] : [],
    }));
    const raw = JSON.stringify({
      schemaVersion: 2,
      paneLayout: {
        version: 1,
        id: 'fallback-layout',
        root: { kind: 'leaf', id: 'fallback-pane', tabId: 'group-20' },
        focusedPaneId: 'fallback-pane',
      },
      tabs: tabsSnapshot,
      closed: [],
    });
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
});
