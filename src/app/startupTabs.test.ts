import { afterEach, expect, it, vi } from 'vitest';
import { createPaneLayout, focusPane, visiblePaneLeaves } from './paneLayout';
import { writePaneTabsSnapshot } from './paneLayoutStorage';

afterEach(() => vi.unstubAllGlobals());

function startupStorage(raw: string, hash: string) {
  vi.resetModules();
  const values = new Map([['morrow.tabs', raw]]);
  const location = { hash };
  const listeners = new Map<string, () => void>();
  vi.stubGlobal('window', {
    location,
    history: {
      replaceState: (_state: unknown, _title: string, target: string) => {
        location.hash = target;
      },
    },
    addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  });
  vi.stubGlobal('localStorage', {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => values.set(name, value),
  });
  return {
    location,
    values,
    dispatch: (name: string) => listeners.get(name)?.(),
  };
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

it('sanitizes restored URL targets and histories before hash restore or storage rewrite', async () => {
  const rejectedUrl = `#/url/${encodeURIComponent(
    'https://synthetic-user:synthetic-pass@example.invalid/path?token=synthetic-sentinel',
  )}`;
  const legacyPage = '#/page/saved%20page?anchor=Heading';
  const legacyFile = '#/file/root/Images/saved.png?download=0';
  const search = '#/search?q=saved&sort=recent';
  const layout = createPaneLayout(
    'startup-url-sanitization',
    [{ id: 'tab-a', groupId: 'group-a', target: '#/page/initial', back: [], forward: [] }],
    'tab-a',
  );
  const persisted = JSON.parse(writePaneTabsSnapshot(layout, [])) as {
    tabs: { id: string; groupId: string; target: string; back: string[]; forward: string[] }[];
    closed: string[];
  };
  persisted.tabs[0] = {
    ...persisted.tabs[0]!,
    target: rejectedUrl,
    back: [legacyPage, rejectedUrl],
    forward: [search, rejectedUrl],
  };
  persisted.closed = [rejectedUrl, legacyFile];
  const { location, values } = startupStorage(JSON.stringify(persisted), '#/');

  const tabs = await import('./tabs');
  const state = tabs.getTabs();
  const restored = tabs.getTabForPane(state.pane)!;
  expect(restored).toMatchObject({
    target: '#/url/invalid',
    back: [legacyPage, '#/url/invalid'],
    forward: [search, '#/url/invalid'],
  });
  expect(state.closed).toEqual(['#/url/invalid', legacyFile]);
  expect(location.hash).toBe('#/url/invalid');
  expect(tabs.initialLaunchHash()).toBe('#/');

  const rewritten = values.get('morrow.tabs')!;
  expect(rewritten).not.toContain('synthetic-user');
  expect(rewritten).not.toContain('synthetic-pass');
  expect(rewritten).not.toContain('synthetic-sentinel');
  expect(rewritten).toContain(legacyPage);
  expect(rewritten).toContain(legacyFile);
  expect(rewritten).toContain(search);
});

it('canonicalizes an unsafe URL arriving through hashchange before tracking or persisting it', async () => {
  const rejectedUrl = `#/url/${encodeURIComponent(
    'https://synthetic-user:synthetic-pass@example.invalid/path?token=hashchange-sentinel',
  )}`;
  const layout = createPaneLayout(
    'startup-url-hashchange',
    [{ id: 'tab-a', groupId: 'group-a', target: '#/page/saved', back: [], forward: [] }],
    'tab-a',
  );
  const { location, values, dispatch } = startupStorage(writePaneTabsSnapshot(layout, []), '#/page/launch');
  const tabs = await import('./tabs');
  const removeListeners = tabs.startTabs();

  location.hash = rejectedUrl;
  dispatch('hashchange');

  const state = tabs.getTabs();
  const active = tabs.getTabForPane(state.pane)!;
  expect(location.hash).toBe('#/url/invalid');
  expect(active.target).toBe('#/url/invalid');
  expect(active.back).toEqual(['#/page/saved', '#/page/launch']);
  const saved = values.get('morrow.tabs')!;
  expect(saved).not.toContain('synthetic-user');
  expect(saved).not.toContain('synthetic-pass');
  expect(saved).not.toContain('hashchange-sentinel');
  removeListeners();
});

it('canonicalizes an unsafe route passed directly to showInPane before state and browser navigation', async () => {
  const rejectedUrl = `#/url/${encodeURIComponent(
    'https://synthetic-user:synthetic-pass@example.invalid/path?token=showinpane-sentinel',
  )}`;
  const layout = createPaneLayout(
    'startup-url-show-in-pane',
    [{ id: 'tab-a', groupId: 'group-a', target: '#/page/saved', back: [], forward: [] }],
    'tab-a',
  );
  const { location, values } = startupStorage(writePaneTabsSnapshot(layout, []), '#/page/saved');
  const tabs = await import('./tabs');
  const state = tabs.getTabs();

  tabs.showInPane(rejectedUrl, state.pane);

  const updated = tabs.getTabs();
  expect(tabs.getTabForPane(updated.pane)).toMatchObject({
    target: '#/url/invalid',
    back: ['#/page/saved'],
  });
  expect(location.hash).toBe('#/url/invalid');
  const saved = values.get('morrow.tabs')!;
  expect(saved).not.toContain('synthetic-user');
  expect(saved).not.toContain('synthetic-pass');
  expect(saved).not.toContain('showinpane-sentinel');
});

for (const [label, raw] of [
  ['future', JSON.stringify({ schemaVersion: 3, unknown: 'synthetic-future-data' })],
  ['invalid', JSON.stringify({ schemaVersion: 2, tabs: [], unknown: 'synthetic-invalid-data' })],
] as const) {
  it(`leaves ${label} tab snapshots untouched when URL navigation is memory-only`, async () => {
    const rejectedUrl = `#/url/${encodeURIComponent(
      'https://synthetic-user:synthetic-pass@example.invalid/path?token=readonly-sentinel',
    )}`;
    const { location, values } = startupStorage(raw, '#/');
    const tabs = await import('./tabs');
    expect(tabs.getTabs().persistenceWritable).toBe(false);

    tabs.showInPane(rejectedUrl);

    expect(tabs.getTabForPane(tabs.getTabs().pane)?.target).toBe('#/url/invalid');
    expect(location.hash).toBe('#/url/invalid');
    expect(values.get('morrow.tabs')).toBe(raw);
  });
}
