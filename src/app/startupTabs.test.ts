import { afterEach, expect, it, vi } from 'vitest';
import { createPaneLayout, focusPane, visiblePaneLeaves } from './paneLayout';
import { writePaneTabsSnapshot } from './paneLayoutStorage';

afterEach(() => vi.unstubAllGlobals());

function startupStorage(raw: string, hash: string) {
  vi.resetModules();
  const values = new Map([['morrow.tabs', raw]]);
  const location = { hash };
  vi.stubGlobal('window', {
    location,
    history: {
      replaceState: (_state: unknown, _title: string, target: string) => {
        location.hash = target;
      },
    },
    addEventListener: vi.fn(),
  });
  vi.stubGlobal('localStorage', {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => values.set(name, value),
  });
  return { location, values };
}

it('honors an explicit launch route in the focused pane while retaining its saved history and other panes', async () => {
  const layout = createPaneLayout(
    'startup',
    [
      { id: 'a', groupId: 'a', target: '#/page/saved-a', back: ['#/before'], forward: [] },
      { id: 'b', groupId: 'b', target: '#/page/saved-b', back: [], forward: [] },
    ],
    'a',
    'two-columns',
  );
  const { location, values } = startupStorage(writePaneTabsSnapshot(layout, []), '#/page/explicit');
  const tabs = await import('./tabs');
  const state = tabs.getTabs();
  const focused = tabs.getTabForPane(state.pane);
  expect(focused?.target).toBe('#/page/explicit');
  expect(focused?.back).toEqual(['#/before', '#/page/saved-a']);
  expect(state.tabs.find((tab) => tab.id === 'b')?.target).toBe('#/page/saved-b');
  expect(location.hash).toBe('#/page/explicit');
  const saved = JSON.parse(values.get('morrow.tabs')!);
  expect(saved.tabs.find((tab: { id: string }) => tab.id === focused?.id)).toMatchObject({
    target: '#/page/explicit',
    back: ['#/before', '#/page/saved-a'],
  });
  location.hash = '#/';
  vi.resetModules();
  const reopened = await import('./tabs');
  expect(reopened.getTabForPane(reopened.getTabs().pane)?.target).toBe('#/page/explicit');
  expect(reopened.getTabForPane(reopened.getTabs().pane)?.back).toEqual(['#/before', '#/page/saved-a']);
});

it('also honors an explicit launch route when migrating a legacy focused side pane', async () => {
  startupStorage(
    JSON.stringify({
      active: 'a',
      pane: 'side',
      closed: [],
      tabs: [
        {
          id: 'a',
          hash: '#/page/main',
          back: [],
          forward: [],
          side: { hash: '#/page/side', back: [], forward: [] },
        },
      ],
    }),
    '#/page/explicit',
  );
  const tabs = await import('./tabs');
  expect(tabs.getTabForPane(tabs.getTabs().pane)?.target).toBe('#/page/explicit');
});

it('retains the original empty launch URL after restoring a saved route so startup preferences still apply', async () => {
  const layout = createPaneLayout(
    'startup',
    [{ id: 'a', groupId: 'a', target: '#/page/saved', back: ['#/page/previous'], forward: [] }],
    'a',
  );
  const { location } = startupStorage(writePaneTabsSnapshot(layout, []), '#/');
  const tabs = await import('./tabs');
  const state = tabs.getTabs();
  expect(location.hash).toBe('#/page/saved');
  expect(tabs.initialLaunchHash()).toBe('#/');
  expect(tabs.getTabForPane(state.pane)?.back).toEqual(['#/page/previous']);
});

it('opens an explicit launch route in a restored empty pane without replacing another pane', async () => {
  let layout = createPaneLayout(
    'startup',
    [{ id: 'a', groupId: 'a', target: '#/page/saved-a', back: [], forward: [] }],
    'a',
    'two-columns',
  );
  const empty = visiblePaneLeaves(layout).find((pane) => pane.tabId === null)!;
  layout = focusPane(layout, empty.id);
  startupStorage(writePaneTabsSnapshot(layout, []), '#/page/explicit');
  const tabs = await import('./tabs');
  expect(tabs.getTabForPane(tabs.getTabs().pane)?.target).toBe('#/page/explicit');
  expect(tabs.getTabs().tabs.find((tab) => tab.id === 'a')?.target).toBe('#/page/saved-a');
  expect(tabs.getTabs().pane).toBe(empty.id);
});
