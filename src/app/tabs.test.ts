// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { allocateSideInstanceId, findPaneSplit, isSideInstanceIdFor, visiblePaneLeaves } from './paneLayout';
import { PANE_TABS_STORAGE_KEY, readPaneTabsSnapshot } from './paneLayoutStorage';
import type { CurrentTabsSnapshot } from './paneLayoutStorage';

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

function legacyPinnedSplitSnapshot(): string {
  return JSON.stringify({
    tabs: [
      {
        id: 'a',
        hash: '#/page/a',
        back: ['#/page/a-before'],
        forward: [],
        side: {
          hash: '#/page/b',
          back: ['#/page/b-before'],
          forward: ['#/page/b-forward'],
        },
      },
    ],
    active: 'a',
    pane: 'main',
    closed: [],
  });
}

function interleavedPairForkSnapshot(): string {
  return JSON.stringify({
    schemaVersion: 2,
    paneLayout: {
      version: 1,
      id: 'interleaved-layout',
      root: {
        kind: 'split',
        id: 'interleaved-root',
        axis: 'columns',
        ratio: 0.5,
        first: { kind: 'leaf', id: 'interleaved-main', tabId: 'group-a' },
        second: { kind: 'leaf', id: 'interleaved-side', tabId: 'group-a:side' },
      },
      focusedPaneId: 'interleaved-main',
    },
    tabs: [
      {
        id: 'group-a',
        groupId: 'group-a',
        target: '#/page/a',
        back: ['#/page/a-before'],
        forward: ['#/page/a-forward'],
      },
      {
        id: 'group-c',
        groupId: 'group-c',
        target: '#/page/c',
        back: ['#/page/c-before'],
        forward: ['#/page/c-forward'],
      },
      {
        id: 'group-a:side',
        groupId: 'group-a',
        target: '#/page/b',
        back: ['#/page/b-before'],
        forward: ['#/page/b-forward'],
      },
    ],
    closed: [],
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

function unassignedFocusedFourPaneSnapshot(): string {
  return JSON.stringify({
    schemaVersion: 2,
    paneLayout: {
      version: 1,
      id: 'unassigned-four-pane-layout',
      root: {
        kind: 'split',
        id: 'unassigned-four-pane-root',
        axis: 'columns',
        ratio: 0.5,
        first: {
          kind: 'split',
          id: 'unassigned-left-root',
          axis: 'rows',
          ratio: 0.5,
          first: { kind: 'leaf', id: 'unassigned-a-main', tabId: 'group-a' },
          second: { kind: 'leaf', id: 'unassigned-a-side', tabId: 'group-a:side' },
        },
        second: {
          kind: 'split',
          id: 'unassigned-right-root',
          axis: 'rows',
          ratio: 0.5,
          first: { kind: 'leaf', id: 'unassigned-b-main', tabId: 'group-b' },
          second: { kind: 'leaf', id: 'unassigned-slot', tabId: null },
        },
      },
      focusedPaneId: 'unassigned-slot',
    },
    // Keep this unassigned instance first so the startup route resolves through the empty focus slot.
    tabs: [
      {
        id: 'hidden-waiting',
        groupId: 'hidden-waiting',
        target: '#/page/waiting',
        back: ['#/page/waiting-before'],
        forward: ['#/page/waiting-after'],
      },
      { id: 'group-a', groupId: 'group-a', target: '#/page/a', back: ['#/page/a-before'], forward: [] },
      {
        id: 'group-a:side',
        groupId: 'group-a',
        target: '#/page/a-side',
        back: ['#/page/a-side-before'],
        forward: [],
      },
      { id: 'group-b', groupId: 'group-b', target: '#/page/b', back: ['#/page/b-before'], forward: [] },
    ],
    closed: ['#/page/closed'],
  });
}

function blankFirstFocusedFourPaneSnapshot(): string {
  return JSON.stringify({
    schemaVersion: 2,
    paneLayout: {
      version: 1,
      id: 'blank-first-four-pane-layout',
      root: {
        kind: 'split',
        id: 'blank-first-root',
        axis: 'columns',
        ratio: 0.5,
        first: {
          kind: 'split',
          id: 'blank-first-left',
          axis: 'rows',
          ratio: 0.5,
          first: { kind: 'leaf', id: 'startup-blank', tabId: null },
          second: { kind: 'leaf', id: 'real-a-pane', tabId: 'real-a' },
        },
        second: {
          kind: 'split',
          id: 'blank-first-right',
          axis: 'rows',
          ratio: 0.5,
          first: { kind: 'leaf', id: 'real-b-pane', tabId: 'real-b' },
          second: { kind: 'leaf', id: 'real-c-pane', tabId: 'real-c' },
        },
      },
      focusedPaneId: 'startup-blank',
    },
    tabs: [
      {
        id: 'hidden-waiting',
        groupId: 'hidden-waiting',
        target: '#/page/waiting-before-startup',
        back: ['#/page/waiting-back'],
        forward: ['#/page/waiting-forward'],
      },
      { id: 'real-a', groupId: 'real-a', target: '#/page/a', back: ['#/page/a-back'], forward: [] },
      { id: 'real-b', groupId: 'real-b', target: '#/page/b', back: ['#/page/b-back'], forward: [] },
      { id: 'real-c', groupId: 'real-c', target: '#/page/c', back: ['#/page/c-back'], forward: [] },
    ],
    closed: ['#/page/closed-before-layout'],
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

async function freshTabs(
  raw: string | null,
  initialHash = '',
  preferences?: { readonly splitShare: number },
) {
  window.history.replaceState(null, '', `/${initialHash}`);
  window.localStorage.clear();
  if (raw !== null) window.localStorage.setItem(PANE_TABS_STORAGE_KEY, raw);
  if (preferences) window.localStorage.setItem('morrow.preferences', JSON.stringify(preferences));
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

function currentSnapshot(raw = window.localStorage.getItem(PANE_TABS_STORAGE_KEY)): CurrentTabsSnapshot {
  const snapshot = readPaneTabsSnapshot(raw);
  if (snapshot.kind !== 'current') throw new Error('Expected a persisted v2 pane snapshot.');
  return snapshot.snapshot;
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
    expect(afterBackground.kind).toBe('current');
    if (afterBackground.kind === 'current') {
      expect(afterBackground.snapshot.layout.tabs.find((tab) => tab.id === sideId)).toMatchObject({
        target: '#/page/side',
        back: ['#/page/side-before'],
        forward: ['#/page/side-after'],
      });
      expect(afterBackground.snapshot.layout.tabs.some((tab) => tab.target === '#/page/background')).toBe(true);
    }

    const withoutSide = await freshTabs(legacySideCollisionSnapshot(collisions, false));
    withoutSide.tabs.openSide('#/page/new-side');
    expect(withoutSide.tabs.getTabs().pane).toBe('side');
    expect(withoutSide.tabs.routeHashForPane('side')).toBe('#/page/new-side');
    expect(withoutSide.tabs.getTabs().layout.tabs.map((tab) => tab.id)).toContain(sideId);
    const afterSplit = readPaneTabsSnapshot(withoutSide.readFromStorage());
    expect(afterSplit.kind).toBe('current');
    if (afterSplit.kind === 'current')
      expect(afterSplit.snapshot.layout.tabs.find((tab) => tab.id === sideId)?.target).toBe('#/page/new-side');
  });

  it('loads the 2.2 snapshot and migrates it to the complete v2 wire shape on an explicit tab change', async () => {
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
    const saved = readPaneTabsSnapshot(writes[0]!);
    expect(saved.kind).toBe('current');
    if (saved.kind === 'current') {
      expect(saved.snapshot.closed).toEqual(['#/page/closed']);
      expect(saved.snapshot.layout.tabs).toMatchObject([
        { id: 'legacy', target: '#/page/main', back: ['#/page/before'], forward: ['#/page/after'], pinned: true },
        { id: 'legacy:side', target: '#/page/side', back: ['#/page/side-before'], forward: [] },
        { id: expect.stringMatching(/^t/), target: '#/page/new' },
        { id: 'other', target: '#/tasks' },
      ]);
    }
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
    expect(readPaneTabsSnapshot(saved).kind).toBe('current');

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
        pinned: true,
      },
    ]);
    expect(reopened.tabs.routeHashForPane('main')).toBe('#/page/main-next');
    expect(reopened.tabs.routeHashForPane('side')).toBe('#/page/side-next');
  });

  it('routes normal navigation away from a pinned v0 main tab through the router', async () => {
    const raw = JSON.stringify({
      tabs: [
        {
          id: 'pinned-split',
          hash: '#/page/pinned-main',
          back: ['#/page/main-before'],
          forward: [],
          side: { hash: '#/page/side', back: ['#/page/side-before'], forward: [] },
          pinned: true,
        },
      ],
      active: 'pinned-split',
      pane: 'main',
      closed: [],
    });
    const { tabs, router } = await freshTabs(raw, '#/page/pinned-main');
    const stop = tabs.startTabs();

    router.navigate({ name: 'page', id: 'new-route', find: null });
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(tabs.routeHashForTabId('pinned-split')).toBe('#/page/pinned-main');
    expect(tabs.getTabs().tabs.find((tab) => tab.id === 'pinned-split')?.side?.hash).toBe('#/page/side');
    expect(tabs.getTabs().tabs.some((tab) => tab.hash === '#/page/new-route')).toBe(true);
    expect(tabs.getTabs().active).not.toBe('pinned-split');
    expect(window.location.hash).toBe('#/page/new-route');
    stop();
  });

  it('persists v0 split history in physical order after swap and reopens that order', async () => {
    const raw = JSON.stringify({
      tabs: [
        {
          id: 'physical-split',
          hash: '#/page/a',
          back: ['#/page/a-before'],
          forward: ['#/page/a-forward'],
          side: { hash: '#/page/b', back: ['#/page/b-before'], forward: ['#/page/b-forward'] },
        },
      ],
      active: 'physical-split',
      pane: 'main',
      closed: [],
    });
    const first = await freshTabs(raw, '#/page/a');
    const stop = first.tabs.startTabs();
    const originalIds = first.tabs.getTabs().layout.tabs.map((tab) => tab.id);

    first.tabs.swapSides();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(first.tabs.getTabs().layout.tabs.map((tab) => tab.id)).toEqual(originalIds);
    expect(first.tabs.paneAssignments().map((assignment) => assignment.tabId)).toEqual([
      'physical-split:side',
      'physical-split',
    ]);
    expect(first.tabs.routeHashForPane('main')).toBe('#/page/b');
    expect(first.tabs.routeHashForPane('side')).toBe('#/page/a');
    expect(first.tabs.getTabs().pane).toBe('side');
    expect(window.location.hash).toBe('#/page/b');
    stop();

    const saved = first.readFromStorage()!;
    const persisted = currentSnapshot(saved);
    expect(visiblePaneLeaves(persisted.layout).map((leaf) => leaf.tabId)).toEqual([
      'physical-split:side',
      'physical-split',
    ]);
    expect(persisted.layout.tabs).toMatchObject([
      { id: 'physical-split', target: '#/page/a', back: ['#/page/a-before'], forward: ['#/page/a-forward'] },
      { id: 'physical-split:side', target: '#/page/b', back: ['#/page/b-before'], forward: ['#/page/b-forward'] },
    ]);
    expect(persisted.layout.focusedPaneId).toBe(visiblePaneLeaves(persisted.layout)[1]?.id);

    const reopened = await freshTabs(saved, '#/page/b');
    expect(reopened.tabs.paneAssignments().map((assignment) => assignment.tabId)).toEqual([
      'physical-split:side',
      'physical-split',
    ]);
    expect(reopened.tabs.routeHashForPane('main')).toBe('#/page/b');
    expect(reopened.tabs.routeHashForPane('side')).toBe('#/page/a');
    expect(reopened.tabs.getTabs().pane).toBe('side');
    expect(reopened.tabs.getTabs().layout.tabs).toMatchObject([
      { id: 'physical-split', back: ['#/page/a-before'], forward: ['#/page/a-forward'] },
      { id: 'physical-split:side', back: ['#/page/b-before'], forward: ['#/page/b-forward'] },
    ]);
  });

  it('closes the physical side after swap while retaining the other instance and its history', async () => {
    const raw = JSON.stringify({
      tabs: [
        {
          id: 'close-split',
          hash: '#/page/a',
          back: ['#/page/a-before'],
          forward: [],
          side: { hash: '#/page/b', back: ['#/page/b-before'], forward: ['#/page/b-forward'] },
        },
      ],
      active: 'close-split',
      pane: 'main',
      closed: [],
    });
    const { tabs, readFromStorage } = await freshTabs(raw, '#/page/a');
    const retained = tabs.getTabs().layout.tabs.find((tab) => tab.id === 'close-split:side')!;
    tabs.swapSides();
    tabs.closeSide();

    expect(tabs.getTabs().layout.tabs).toEqual([retained]);
    expect(tabs.paneAssignments().map((assignment) => assignment.tabId)).toEqual(['close-split:side']);
    expect(tabs.routeHashForPane('main')).toBe('#/page/b');
    expect(tabs.routeHashForTabId('close-split:side')).toBe('#/page/b');
    expect(tabs.getTabs().pane).toBe('main');
    expect(tabs.getTabs().active).toBe('close-split:side');
    const persisted = currentSnapshot(readFromStorage()).layout;
    expect(persisted.tabs).toEqual([retained]);
    expect(visiblePaneLeaves(persisted).map((leaf) => leaf.tabId)).toEqual(['close-split:side', null]);
  });

  it('opens a route in the physical side after swap without moving the main hash anchor', async () => {
    const raw = JSON.stringify({
      tabs: [
        {
          id: 'open-split',
          hash: '#/page/a',
          back: ['#/page/a-before'],
          forward: [],
          side: { hash: '#/page/b', back: ['#/page/b-before'], forward: [] },
        },
      ],
      active: 'open-split',
      pane: 'main',
      closed: [],
    });
    const { tabs } = await freshTabs(raw, '#/page/a');
    tabs.swapSides();

    tabs.openSide('#/page/new-side');

    expect(tabs.paneAssignments().map((assignment) => assignment.tabId)).toEqual([
      'open-split:side',
      'open-split',
    ]);
    expect(tabs.routeHashForPane('main')).toBe('#/page/b');
    expect(tabs.routeHashForPane('side')).toBe('#/page/new-side');
    expect(tabs.getTabs().pane).toBe('side');
    expect(window.location.hash).toBe('#/page/b');
  });

  it('keeps v0 bytes when a swapped pair becomes hidden and v2 cannot represent its inactive orientation', async () => {
    const raw = JSON.stringify({
      tabs: [
        {
          id: 'a',
          hash: '#/page/a',
          back: ['#/page/a-before'],
          forward: ['#/page/a-forward'],
          side: { hash: '#/page/b', back: ['#/page/b-before'], forward: ['#/page/b-forward'] },
        },
        {
          id: 'c',
          hash: '#/page/c',
          back: ['#/page/c-before'],
          forward: ['#/page/c-forward'],
          side: null,
        },
      ],
      active: 'a',
      pane: 'main',
      closed: [],
    });
    const first = await freshTabs(raw, '#/page/a');
    const stop = first.tabs.startTabs();
    const registryIds = first.tabs.getTabs().layout.tabs.map((tab) => tab.id);

    first.tabs.swapSides();
    first.tabs.setTabPinned('a', true);
    expect(first.tabs.getTabs().layout.tabs.map((tab) => tab.id)).toEqual(registryIds);
    expect(first.tabs.getTabs().tabs.find((tab) => tab.id === 'a')).toMatchObject({
      hash: '#/page/b',
      side: { hash: '#/page/a' },
      pinned: true,
    });
    first.tabs.activateTab('c');
    const writesBeforeHidingPair = first.writes.length;
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const savedWhileCActive = first.readFromStorage()!;
    expect(savedWhileCActive).toBe(first.writes.at(-1));
    expect(first.writes).toHaveLength(writesBeforeHidingPair);
    const beforeHide = currentSnapshot(savedWhileCActive);
    expect(visiblePaneLeaves(beforeHide.layout).map((leaf) => leaf.tabId)).toEqual(['a:side', 'a']);
    expect(beforeHide.layout.tabs.find((tab) => tab.id === 'a')).toMatchObject({ pinned: true });
    stop();

    const reopened = await freshTabs(savedWhileCActive, '#/page/b');
    reopened.tabs.activateTab('a');
    expect(reopened.tabs.paneAssignments().map((assignment) => assignment.tabId)).toEqual(['a:side', 'a']);
    expect(reopened.tabs.routeHashForPane('main')).toBe('#/page/b');
    expect(reopened.tabs.routeHashForPane('side')).toBe('#/page/a');
    expect(reopened.tabs.getTabs().tabs.find((tab) => tab.id === 'a')?.pinned).toBe(true);
    expect(reopened.tabs.getTabs().layout.tabs.map((tab) => tab.id)).toEqual(registryIds);
  });

  it('keeps an interleaved v2 registry while restoring pair orientation and the surviving closed-side projection', async () => {
    const raw = interleavedPairForkSnapshot();
    const { tabs } = await freshTabs(raw, '#/page/a');
    const registryIds = tabs.getTabs().layout.tabs.map((tab) => tab.id);

    tabs.swapSides();
    expect(tabs.getTabs().layout.tabs.map((tab) => tab.id)).toEqual(registryIds);
    tabs.activateTab('group-c');
    tabs.activateTab('group-a');

    expect(tabs.getTabs().layout.tabs.map((tab) => tab.id)).toEqual(registryIds);
    expect(tabs.paneAssignments().map((assignment) => assignment.tabId)).toEqual(['group-a:side', 'group-a']);
    expect(tabs.routeHashForPane('main')).toBe('#/page/b');
    expect(tabs.routeHashForPane('side')).toBe('#/page/a');
    expect(window.location.hash).toBe('#/page/b');

    const closeCase = await freshTabs(raw, '#/page/a');
    const sideInstance = closeCase.tabs.getTabs().layout.tabs.find((tab) => tab.id === 'group-a:side')!;
    const otherInstance = closeCase.tabs.getTabs().layout.tabs.find((tab) => tab.id === 'group-c')!;
    closeCase.tabs.swapSides();
    closeCase.tabs.closeSide();

    const afterClose = closeCase.tabs.getTabs();
    expect(afterClose.tabs.map((tab) => tab.id)).toEqual(['group-a:side', 'group-c']);
    expect(afterClose.active).toBe('group-a:side');
    expect(afterClose.projectionOrder).toEqual(['group-a:side', 'group-c']);
    expect(afterClose.layout.tabs).toEqual([otherInstance, sideInstance]);
    expect(afterClose.layout.tabs[0]).toBe(otherInstance);
    expect(afterClose.layout.tabs[1]).toBe(sideInstance);
    expect(visiblePaneLeaves(afterClose.layout).map((leaf) => leaf.tabId)).toEqual(['group-a:side', null]);
    expect(closeCase.tabs.paneAssignments().map((assignment) => assignment.tabId)).toEqual(['group-a:side']);
    expect(closeCase.tabs.routeHashForPane('main')).toBe('#/page/b');
    expect(afterClose.layout.focusedPaneId).toBe(visiblePaneLeaves(afterClose.layout)[0]?.id);
    expect(window.location.hash).toBe('#/page/b');
    const persisted = currentSnapshot();
    expect(persisted.layout.tabs).toEqual(afterClose.layout.tabs);
    expect(persisted.layout.root).toEqual(afterClose.layout.root);
    expect(closeCase.writes.length).toBeGreaterThan(0);
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

  it('projects a two-pane Electron snapshot and persists explicit navigation in the full v2 wire', async () => {
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
    const persisted = currentSnapshot();
    expect(persisted.layout.tabs.find((tab) => tab.id === 'two-pane-tab')).toMatchObject({
      target: '#/page/temporary-main',
      back: ['#/page/main-before', '#/page/main', '#/'],
    });
    expect(persisted.layout.tabs.find((tab) => tab.id === 'two-pane-tab:side')?.target).toBe(
      '#/page/temporary-side',
    );
    expect(writes.length).toBeGreaterThan(0);
  });

  it('keeps an explicit launch hash on the first physical pane after a saved side swap', async () => {
    const snapshot = JSON.parse(twoPaneForkSnapshot()) as {
      paneLayout: { root: { first: { tabId: string }; second: { tabId: string } } };
    };
    snapshot.paneLayout.root.first.tabId = 'two-pane-tab:side';
    snapshot.paneLayout.root.second.tabId = 'two-pane-tab';
    const { tabs } = await freshTabs(JSON.stringify(snapshot), '#/page/launch');

    expect(tabs.routeHashForPane('main')).toBe('#/page/launch');
    expect(tabs.routeHashForPane('side')).toBe('#/page/main');
    expect(tabs.paneAssignments().map((assignment) => assignment.tabId)).toEqual([
      'two-pane-tab:side',
      'two-pane-tab',
    ]);
    expect(tabs.getTabs().layout.tabs.find((tab) => tab.id === 'two-pane-tab:side')).toMatchObject({
      target: '#/page/launch',
      back: ['#/page/side-before', '#/page/side'],
    });
  });

  it('projects a four-pane Electron fixture and persists explicit workspace changes without dropping instances', async () => {
    const raw = latestForkSnapshot();
    const { tabs, writes } = await freshTabs(raw);

    const restored = tabs.getTabs();
    expect(restored.tabs).toHaveLength(2);
    expect(restored.tabs[0]).toMatchObject({
      id: 'group-a',
      hash: '#/page/a-main',
      back: ['#/page/a-main-before'],
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

    const persisted = currentSnapshot();
    expect(persisted.layout.tabs).toEqual(tabs.getTabs().layout.tabs);
    expect(persisted.closed).toEqual(tabs.getTabs().closed);
    expect(writes.length).toBeGreaterThan(0);
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

  it('keeps the two instance routes and main URL anchored while editor hosts swap physical leaves', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const raw = JSON.stringify({
      tabs: [
        {
          id: 'shared-note',
          hash: '#/page/shared-note',
          back: ['#/page/main-before'],
          forward: [],
          side: { hash: '#/page/shared-note', back: ['#/page/side-before'], forward: [] },
        },
      ],
      active: 'shared-note',
      pane: 'side',
      closed: [],
    });
    const { tabs, router } = await freshTabs(raw, '#/page/shared-note');
    const stop = tabs.startTabs();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const RouteContent = ({ tabId }: { tabId: string }) =>
      createElement('output', { id: tabId }, router.routeHash(router.useRoute()));
    const routeText = (tabId: string) => container.ownerDocument.getElementById(tabId)?.textContent;
    const Hosts = () => {
      const state = tabs.useTabs();
      return createElement(
        Fragment,
        null,
        ...tabs
          .paneAssignments(state.layout)
          .map((assignment) =>
            createElement(
              tabs.PaneContext.Provider,
              { key: assignment.tabId, value: assignment.paneId },
              createElement(
                tabs.PaneTabContext.Provider,
                { value: assignment.tabId },
                createElement(RouteContent, { tabId: assignment.tabId }),
              ),
            ),
          ),
      );
    };

    try {
      await act(async () => root.render(createElement(Hosts)));
      const initialAssignments = tabs.paneAssignments();
      const main = initialAssignments[0]!;
      const side = initialAssignments[1]!;
      expect(routeText(main.tabId)).toBe('#/page/shared-note');
      expect(routeText(side.tabId)).toBe('#/page/shared-note');

      await act(async () => {
        router.navigate({ name: 'page', id: 'side-next', find: null }, { pane: side.paneId });
      });
      expect(routeText(side.tabId)).toBe('#/page/side-next');
      expect(window.location.hash).toBe('#/page/shared-note');
      await act(async () => {
        router.navigate({ name: 'page', id: 'main-next', find: null }, { pane: main.paneId });
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      expect(window.location.hash).toBe('#/page/main-next');

      tabs.setActivePane(main.paneId);
      tabs.swapSides();
      await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
      const swappedAssignments = tabs.paneAssignments();
      expect(swappedAssignments.map((assignment) => assignment.tabId)).toEqual([side.tabId, main.tabId]);
      expect(swappedAssignments.map((assignment) => assignment.paneId)).toEqual([main.paneId, side.paneId]);
      expect(routeText(side.tabId)).toBe('#/page/side-next');
      expect(routeText(main.tabId)).toBe('#/page/main-next');
      expect(window.location.hash).toBe('#/page/side-next');
      expect(tabs.getTabs().layout.focusedPaneId).toBe(side.paneId);
      expect(tabs.getTabs().layout.tabs.find((tab) => tab.id === main.tabId)?.back).toEqual([
        '#/page/main-before',
        '#/page/shared-note',
      ]);
      expect(tabs.getTabs().layout.tabs.find((tab) => tab.id === side.tabId)?.back).toEqual([
        '#/page/side-before',
        '#/page/shared-note',
      ]);
    } finally {
      await act(async () => root.unmount());
      stop();
    }
  });

  it('routes each pane from its instance while the v2 launch anchor remains stable and hidden instances survive', async () => {
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
      const persisted = currentSnapshot();
      expect(persisted.layout.tabs).toEqual(updated.layout.tabs);
      expect(persisted.closed).toEqual(updated.closed);
      expect(writes.length).toBeGreaterThan(0);
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

  it.each(['wheel', 'touchstart'] as const)(
    'gates startup reading focus on %s without canceling general startup navigation',
    async (type) => {
      const { tabs } = await freshTabs(twoPaneForkSnapshot());
      const stop = tabs.startTabs();
      try {
        let navigationRan = false;
        let readingFocusRan = false;
        document.body.dispatchEvent(new Event(type, { bubbles: true }));

        expect(tabs.runStartupNavigation(() => (navigationRan = true))).toBe(true);
        expect(navigationRan).toBe(true);
        expect(tabs.runStartupReadingFocus(() => (readingFocusRan = true))).toBe(false);
        expect(readingFocusRan).toBe(false);
      } finally {
        stop();
      }
    },
  );

  it('restores the v2 snapshot exactly for Onde parei without consuming history or focus', async () => {
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

    expect(tabs.runStartupNavigation(() => tabs.restoreLastPosition())).toBe(true);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    stop();

    const original = currentSnapshot(raw).layout;
    expect(tabs.getTabs().layout).toEqual(original);
    expect(tabs.getTabs().tabs[0]).toMatchObject({
      hash: '#/page/main',
      back: ['#/page/main-before'],
      forward: [],
      side: {
        hash: '#/page/side',
        back: ['#/page/side-before'],
        forward: ['#/page/side-after'],
      },
    });
    expect(window.location.hash).toBe('#/page/main');
    expect(window.localStorage.getItem(PANE_TABS_STORAGE_KEY)).toBe(raw);
    expect(writes).toEqual([]);
  });

  it('restores a focused four-pane v2 snapshot without altering a Home target or its history', async () => {
    const snapshot = JSON.parse(latestForkSnapshot()) as {
      paneLayout: { focusedPaneId: string };
      tabs: Array<{ id: string; target: string; back: string[]; forward: string[] }>;
    };
    snapshot.tabs[2] = {
      ...snapshot.tabs[2]!,
      target: '#/',
      back: ['#/page/older'],
      forward: ['#/page/newer'],
    };
    const raw = JSON.stringify(snapshot);
    const { tabs, writes } = await freshTabs(raw);
    const stop = tabs.startTabs();

    expect(tabs.getTabs().layout.focusedPaneId).toBe('b-side');
    expect(tabs.runStartupNavigation(() => tabs.restoreLastPosition())).toBe(true);
    stop();

    expect(tabs.getTabs().layout).toEqual(currentSnapshot(raw).layout);
    expect(tabs.getTabs().layout.focusedPaneId).toBe('b-side');
    expect(tabs.getTabs().layout.tabs.find((tab) => tab.id === 'group-b')).toMatchObject({
      target: '#/',
      back: ['#/page/older'],
      forward: ['#/page/newer'],
    });
    expect(tabs.routeHashForPane('b-main')).toBe('#/');
    expect(window.location.hash).toBe('');
    expect(window.localStorage.getItem(PANE_TABS_STORAGE_KEY)).toBe(raw);
    expect(writes).toEqual([]);
  });

  it('restores the selected main route in a four-pane snapshot while retaining side focus and histories', async () => {
    const raw = latestForkSnapshot();
    const { tabs, writes } = await freshTabs(raw);
    const stop = tabs.startTabs();

    expect(tabs.getTabs().layout.focusedPaneId).toBe('b-side');
    expect(tabs.getTabs().layout.tabs.find((tab) => tab.id === 'group-b')).toMatchObject({
      target: '#/',
      back: ['#/page/b-main-before', '#/page/b-main'],
      forward: ['#/page/b-main-after'],
    });
    expect(tabs.runStartupNavigation(() => tabs.restoreLastPosition())).toBe(true);
    stop();

    const restored = tabs.getTabs().layout;
    expect(restored).toEqual(currentSnapshot(raw).layout);
    expect(restored.focusedPaneId).toBe('b-side');
    expect(restored.tabs.find((tab) => tab.id === 'group-b')).toMatchObject({
      target: '#/page/b-main',
      back: ['#/page/b-main-before'],
      forward: ['#/page/b-main-after'],
    });
    expect(restored.tabs.find((tab) => tab.id === 'group-b:side')).toMatchObject({
      target: '#/page/b-side',
      back: ['#/page/b-side-before'],
      forward: [],
    });
    expect(window.location.hash).toBe('#/page/b-main');
    expect(window.localStorage.getItem(PANE_TABS_STORAGE_KEY)).toBe(raw);
    expect(writes).toEqual([]);
  });

  it('keeps the established v0 Onde parei back-navigation behavior', async () => {
    const raw = JSON.stringify({
      tabs: [
        {
          id: 'legacy-last',
          hash: '#/page/saved',
          back: ['#/page/older'],
          forward: ['#/page/newer'],
          side: null,
        },
      ],
      active: 'legacy-last',
      pane: 'main',
      closed: [],
    });
    const { tabs, writes } = await freshTabs(raw);
    const stop = tabs.startTabs();

    expect(tabs.runStartupNavigation(() => tabs.restoreLastPosition())).toBe(true);
    stop();

    expect(tabs.getTabs().tabs[0]).toMatchObject({
      hash: '#/page/saved',
      back: ['#/page/older'],
      forward: ['#/page/newer', '#/'],
    });
    expect(window.location.hash).toBe('#/page/saved');
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
    expect(
      tabs.runStartupNavigation(() =>
        router.navigate({ name: 'page', id: 'today-note', find: null }, { replace: true, pane: 'main' }),
      ),
    ).toBe(true);

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

  it.each(['pointerdown', 'keydown'] as const)(
    'abandons the preferred start page after a %s interaction',
    async (eventName) => {
    const raw = twoPaneForkSnapshot();
    const { tabs, writes } = await freshTabs(raw);
    const stop = tabs.startTabs();
    let ran = false;

    window.dispatchEvent(
      eventName === 'pointerdown'
        ? new Event('pointerdown', { bubbles: true })
        : new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    expect(
      tabs.runStartupNavigation(() => {
        ran = true;
        tabs.goBack('main');
      }),
    ).toBe(false);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    stop();

    expect(ran).toBe(false);
    expect(tabs.getTabs().layout.tabs.find((tab) => tab.id === 'two-pane-tab')).toMatchObject({
      target: '#/',
      back: ['#/page/main-before', '#/page/main'],
      forward: [],
    });
    expect(window.localStorage.getItem(PANE_TABS_STORAGE_KEY)).toBe(raw);
    expect(writes).toEqual([]);
    },
  );

  it('keeps startup deep links transient when another pane or focus is saved', async () => {
    const raw = twoPaneForkSnapshot();
    const { tabs, writes } = await freshTabs(raw, '#/page/launch');
    tabs.setActivePane('main-pane');

    let persisted = currentSnapshot();
    expect(persisted.layout.focusedPaneId).toBe('main-pane');
    expect(persisted.layout.tabs.find((tab) => tab.id === 'two-pane-tab')).toMatchObject({
      target: '#/page/main',
      back: ['#/page/main-before'],
      forward: [],
    });

    tabs.showInSide('#/page/side-after-user-action');
    persisted = currentSnapshot();
    expect(persisted.layout.tabs.find((tab) => tab.id === 'two-pane-tab')).toMatchObject({
      target: '#/page/main',
      back: ['#/page/main-before'],
    });
    expect(persisted.layout.tabs.find((tab) => tab.id === 'two-pane-tab:side')?.target).toBe(
      '#/page/side-after-user-action',
    );
    expect(writes.length).toBeGreaterThan(0);
  });

  it.each([
    ['neutral startup', '', '#/'],
    ['external deep link', '#/page/external-launch', '#/page/external-launch'],
  ] as const)(
    'keeps a startup assignment in an empty v2 pane out of another pane’s write (%s)',
    async (_name, launchHash, expectedLaunchRoute) => {
      const raw = unassignedFocusedFourPaneSnapshot();
      const { tabs, writes } = await freshTabs(raw, launchHash);
      const stop = tabs.startTabs();

      expect(tabs.paneAssignments().find((item) => item.paneId === 'unassigned-slot')?.tabId).toBe(
        'hidden-waiting',
      );
      expect(tabs.routeHashForPane('unassigned-slot')).toBe(expectedLaunchRoute);
      tabs.showInPane('#/page/b-after-startup', 'unassigned-b-main');

      const persisted = currentSnapshot();
      expect(persisted.layout.tabs.map((tab) => tab.id)).toEqual([
        'hidden-waiting',
        'group-a',
        'group-a:side',
        'group-b',
      ]);
      expect(persisted.layout.root).toMatchObject({
        kind: 'split',
        second: {
          kind: 'split',
          second: { kind: 'leaf', id: 'unassigned-slot', tabId: null },
        },
      });
      expect(persisted.layout.tabs.find((tab) => tab.id === 'hidden-waiting')).toMatchObject({
        target: '#/page/waiting',
        back: ['#/page/waiting-before'],
        forward: ['#/page/waiting-after'],
      });
      expect(persisted.layout.tabs.find((tab) => tab.id === 'group-b')?.target).toBe(
        '#/page/b-after-startup',
      );
      expect(persisted.closed).toEqual(['#/page/closed']);
      expect(tabs.paneAssignments().find((item) => item.paneId === 'unassigned-slot')?.tabId).toBe(
        'hidden-waiting',
      );
      expect(writes.length).toBeGreaterThan(0);
      stop();
    },
  );

  it('commits a transient empty-pane launch only after that pane is intentionally opened', async () => {
    const raw = unassignedFocusedFourPaneSnapshot();
    const { tabs, writes } = await freshTabs(raw, '#/page/external-launch');
    expect(tabs.paneAssignments().find((item) => item.paneId === 'unassigned-slot')?.tabId).toBe(
      'hidden-waiting',
    );
    expect(writes).toEqual([]);

    tabs.showInPane('#/page/external-launch', 'unassigned-slot');

    const persisted = currentSnapshot();
    expect(persisted.layout.root).toMatchObject({
      kind: 'split',
      second: {
        kind: 'split',
        second: { kind: 'leaf', id: 'unassigned-slot', tabId: 'hidden-waiting' },
      },
    });
    expect(persisted.layout.tabs.find((tab) => tab.id === 'hidden-waiting')).toMatchObject({
      target: '#/page/external-launch',
      back: ['#/page/waiting-before', '#/page/waiting'],
      forward: ['#/page/waiting-after'],
    });
    expect(writes).toHaveLength(1);
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
    const persisted = currentSnapshot();
    expect(persisted.layout.tabs.map((tab) => tab.id)).toEqual(['group', 'other', 'member']);
    expect(persisted.layout.tabs.find((tab) => tab.id === 'member')).toMatchObject({
      target: '#/page/member',
      back: ['#/page/member-before'],
      forward: ['#/page/member-next'],
    });
    expect(persisted.layout.focusedPaneId).toBe('member-pane');
    expect(writes.length).toBeGreaterThan(0);
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
    expect(currentSnapshot().layout.tabs).toEqual(tabs.getTabs().layout.tabs);
    expect(writes.length).toBeGreaterThan(0);

    tabs.moveTab('other', 0);
    expect(tabs.getTabs().tabs.map((tab) => tab.id)).toEqual(['other', 'main']);
    expect(tabs.getTabs().layout.tabs.map((tab) => tab.id)).toEqual(['other', 'main', 'main:side']);
    expect(tabs.getTabs().layout.tabs.map((tab) => tab.id)).toContain('main:side');
    expect(currentSnapshot().layout.tabs).toEqual(tabs.getTabs().layout.tabs);
    expect(writes.length).toBeGreaterThan(0);
  });
});

describe('legacy pinning and empty address anchors', () => {
  it('keeps a pinned legacy main as a split group while opening the next route as a solo tab', async () => {
    const { tabs, router, readFromStorage } = await freshTabs(legacyPinnedSplitSnapshot(), '#/page/a');
    tabs.setTabPinned('a', true);

    router.navigate({ name: 'page', id: 'c', find: null }, { pane: 'main' });

    const opened = tabs.getTabs().layout.tabs.find((tab) => tab.target === '#/page/c')!;
    const instances = tabs.getTabs().layout.tabs;
    expect(instances.map((tab) => tab.id)).toEqual(['a', 'a:side', opened.id]);
    expect(instances.find((tab) => tab.id === 'a')).toMatchObject({
      target: '#/page/a',
      pinned: true,
    });
    expect(instances.find((tab) => tab.id === 'a:side')).toMatchObject({
      target: '#/page/b',
      back: ['#/page/b-before'],
      forward: ['#/page/b-forward'],
    });
    expect(tabs.paneAssignments().map((assignment) => assignment.tabId)).toEqual([opened.id]);
    expect(tabs.getTabs().persistenceWritable).toBe(true);

    const saved = readFromStorage()!;
    const savedSnapshot = currentSnapshot(saved);
    expect(savedSnapshot.layout.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'a', target: '#/page/a', pinned: true }),
        expect.objectContaining({ id: 'a:side', target: '#/page/b' }),
        expect.objectContaining({ id: opened.id, target: '#/page/c' }),
      ]),
    );
    expect(visiblePaneLeaves(savedSnapshot.layout).map((leaf) => leaf.tabId)).toEqual([opened.id, null]);

    const reopened = await freshTabs(saved, '#/page/c');
    expect(reopened.tabs.getTabs().layout.tabs.map((tab) => tab.id)).toEqual(['a', 'a:side', opened.id]);
    expect(reopened.tabs.getTabs().persistenceWritable).toBe(true);
    expect(reopened.tabs.getTabs().layout.tabs.find((tab) => tab.id === 'a')).toMatchObject({
      pinned: true,
      target: '#/page/a',
    });
    expect(reopened.tabs.getTabs().layout.tabs.find((tab) => tab.id === 'a:side')?.target).toBe('#/page/b');
  });

  it('keeps a pinned legacy lateral instance navigable in its own history', async () => {
    const { tabs, router, readFromStorage } = await freshTabs(legacyPinnedSplitSnapshot(), '#/page/a');
    tabs.setTabPinned('a', true);
    tabs.setActivePane('side');

    router.navigate({ name: 'page', id: 'd', find: null }, { pane: 'side' });

    expect(tabs.getTabs().layout.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'a', target: '#/page/a', pinned: true }),
        expect.objectContaining({
          id: 'a:side',
          target: '#/page/d',
          back: ['#/page/b-before', '#/page/b'],
          forward: [],
          pinned: true,
        }),
      ]),
    );
    expect(tabs.getTabs().tabs).toHaveLength(1);
    expect(tabs.getTabs().persistenceWritable).toBe(true);
    expect(currentSnapshot(readFromStorage()).layout.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'a', target: '#/page/a', pinned: true }),
        expect.objectContaining({
          id: 'a:side',
          target: '#/page/d',
          back: ['#/page/b-before', '#/page/b'],
          forward: [],
          pinned: true,
        }),
      ]),
    );
  });

  it.each(['first', 'second'] as const)(
    'replaces the URL with neutral state when the anchor tab is removed while pane %s is focused',
    async (focused) => {
      const raw = JSON.stringify({
        tabs: [
          { id: 'a', hash: '#/page/a', back: [], forward: [], side: null },
          { id: 'b', hash: '#/page/b', back: [], forward: [], side: null },
        ],
        active: 'a',
        pane: 'main',
        closed: [],
      });
      const { tabs, writes } = await freshTabs(raw, '#/page/a');
      tabs.setPanePreset('two-columns');
      const [first, second] = tabs.paneSlots();
      tabs.assignTabToPane('b', second!.paneId);
      tabs.setActivePane(focused === 'first' ? first!.paneId : second!.paneId);
      const stop = tabs.startTabs();

      tabs.closeTab('a');
      await new Promise((resolve) => window.setTimeout(resolve, 0));

      expect(tabs.paneSlots().find((slot) => slot.paneId === first!.paneId)?.tabId).toBeNull();
      expect(tabs.getTabs().layout.tabs.map((tab) => tab.id)).toEqual(['b']);
      expect(tabs.getTabs().tabs.map((tab) => tab.id)).toEqual(['b']);
      expect(window.location.hash).toBe('#/');
      expect(currentSnapshot().layout.tabs).toEqual(tabs.getTabs().layout.tabs);
      expect(writes.length).toBeGreaterThan(0);
      stop();
    },
  );

  it('keeps a first empty v2 anchor neutral on preset and opens it only for an external deep link', async () => {
    const raw = JSON.stringify({
      schemaVersion: 2,
      paneLayout: {
        version: 1,
        id: 'empty-first-layout',
        root: {
          kind: 'split',
          id: 'empty-first-root',
          axis: 'columns',
          ratio: 0.5,
          first: { kind: 'leaf', id: 'empty-first-pane', tabId: null },
          second: { kind: 'leaf', id: 'occupied-pane', tabId: 'occupied' },
        },
        focusedPaneId: 'occupied-pane',
      },
      tabs: [
        { id: 'occupied', groupId: 'occupied', target: '#/page/occupied', back: [], forward: [] },
      ],
      closed: [],
    });
    const { tabs, writes } = await freshTabs(raw, '#/page/occupied');
    const stop = tabs.startTabs();
    const [empty, occupied] = tabs.paneSlots();

    tabs.setPanePreset('two-columns');
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(tabs.paneSlots().map((slot) => slot.tabId)).toEqual([null, 'occupied']);
    expect(tabs.getTabs().layout.tabs).toHaveLength(1);
    expect(tabs.routeHashForPane(empty!.paneId)).toBe('#/');
    expect(tabs.routeHashForPane(occupied!.paneId)).toBe('#/page/occupied');
    expect(window.location.hash).toBe('#/');
    expect(currentSnapshot().layout.root).toEqual(tabs.getTabs().layout.root);

    window.location.hash = '#/page/external-open';
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(tabs.routeHashForPane(empty!.paneId)).toBe('#/page/external-open');
    expect(tabs.getTabs().layout.tabs).toHaveLength(2);
    expect(currentSnapshot().layout.tabs).toEqual(tabs.getTabs().layout.tabs);
    expect(writes.length).toBeGreaterThan(0);
    stop();
  });
});

describe('multi-pane presets', () => {
  it('persists a v2 split resize without changing projection, focus, tabs or navigation history', async () => {
    const { tabs, writes } = await freshTabs(latestForkSnapshot());
    const before = tabs.getTabs();

    expect(
      tabs.setPaneSplitRatio('left', 0.94, {
        layoutId: before.layout.id,
        topologyRevision: before.layout.topologyRevision,
      }),
    ).toBe(true);

    const after = tabs.getTabs();
    expect(findPaneSplit(after.layout.root, 'root')?.ratio).toBe(0.63);
    expect(findPaneSplit(after.layout.root, 'left')?.ratio).toBe(0.8);
    expect(findPaneSplit(after.layout.root, 'right')?.ratio).toBe(0.52);
    expect(after).toMatchObject({
      active: before.active,
      pane: before.pane,
      closed: before.closed,
      projectionKind: before.projectionKind,
      explicitLayout: before.explicitLayout,
    });
    expect(after.layout).toMatchObject({
      focusedPaneId: before.layout.focusedPaneId,
      topologyRevision: before.layout.topologyRevision,
      tabs: before.layout.tabs,
    });
    expect(currentSnapshot().layout.root).toMatchObject({
      kind: 'split',
      first: { kind: 'split', id: 'left', ratio: 0.8 },
      second: { kind: 'split', id: 'right', ratio: 0.52 },
    });
    expect(writes).toHaveLength(1);
  });

  it('moves a 2.2 legacy split to the v2 writer only after the user changes its ratio', async () => {
    const raw = legacyPinnedSplitSnapshot();
    const { tabs, writes } = await freshTabs(raw, '', { splitShare: 0.64 });
    const before = tabs.getTabs();
    const split = before.layout.root;
    expect(split.kind).toBe('split');
    if (split.kind !== 'split') return;
    expect(split.ratio).toBe(0.64);

    expect(writes).toEqual([]);
    expect(
      tabs.setPaneSplitRatio(split.id, 0.73, {
        layoutId: before.layout.id,
        topologyRevision: before.layout.topologyRevision,
      }),
    ).toBe(true);

    expect(writes).toHaveLength(1);
    expect(currentSnapshot().layout.root).toMatchObject({ kind: 'split', ratio: 0.73 });
    expect(tabs.getTabs().layout.tabs).toEqual(before.layout.tabs);
    expect(tabs.getTabs().layout.focusedPaneId).toBe(before.layout.focusedPaneId);
    const preferences = await import('./platform/preferences');
    expect(preferences.getPreferences().splitShare).toBe(0.73);
  });

  it('keeps protected session bytes untouched while allowing an in-memory resize', async () => {
    const raw = JSON.stringify({ schemaVersion: 999, opaque: 'preserve this session' });
    const { tabs, writes, readFromStorage } = await freshTabs(raw);
    tabs.setPanePreset('two-by-two');
    const layout = tabs.getTabs().layout;
    const root = findPaneSplit(layout.root, `${layout.id}:split:root`);
    expect(root).not.toBeNull();

    expect(
      tabs.setPaneSplitRatio(root!.id, 0.72, {
        layoutId: layout.id,
        topologyRevision: layout.topologyRevision,
      }),
    ).toBe(true);

    expect(findPaneSplit(tabs.getTabs().layout.root, root!.id)?.ratio).toBe(0.72);
    expect(writes).toEqual([]);
    expect(readFromStorage()).toBe(raw);
  });

  it.each(['single', 'two-columns', 'one-left-two-right', 'two-by-two'] as const)(
    'opens beside the source tab by physical pane identity in the %s preset without adding a fifth pane',
    async (preset) => {
      const raw = JSON.stringify({
        tabs: [
          { id: 'a', hash: '#/page/a', back: ['#/page/a-before'], forward: [], side: null },
          { id: 'b', hash: '#/page/b', back: [], forward: [], side: null },
        ],
        active: 'a',
        pane: 'main',
        closed: [],
      });
      const { tabs, writes } = await freshTabs(raw, '#/page/a');
      tabs.setPanePreset(preset);
      const source = tabs.paneSlots().find((slot) => slot.tabId === 'a')!;

      tabs.openSide('#/page/open-beside-a', 'a');

      const opened = tabs.paneSlots().find((slot) => {
        if (!slot.tabId) return false;
        return (
          tabs.getTabs().layout.tabs.find((item) => item.id === slot.tabId)?.target ===
          '#/page/open-beside-a'
        );
      })!;
      expect(opened.paneId).not.toBe(source.paneId);
      expect(tabs.targetPane()).toBe(opened.paneId);
      expect(tabs.routeHashForPane(opened.paneId)).toBe('#/page/open-beside-a');
      expect(tabs.routeHashForPane(source.paneId)).toBe('#/page/a');
      expect(visiblePaneLeaves(tabs.getTabs().layout)).toHaveLength(
        preset === 'single' || preset === 'two-columns' ? 2 : preset === 'one-left-two-right' ? 3 : 4,
      );
      expect(tabs.getTabs().layout.tabs.find((item) => item.id === 'a')).toMatchObject({
        target: '#/page/a',
        back: ['#/page/a-before'],
      });
      expect(tabs.getTabs().tabs.find((item) => item.id === 'a')?.side).toBeNull();
      expect(window.location.hash).toBe('#/page/a');
      expect(currentSnapshot().layout.tabs).toEqual(tabs.getTabs().layout.tabs);
      expect(writes.length).toBeGreaterThan(0);
    },
  );

  it('keeps v2 startup and external hashes on the selected pair anchor until a preset is chosen', async () => {
    const raw = JSON.stringify({
      schemaVersion: 2,
      paneLayout: {
        version: 1,
        id: 'startup-anchor-layout',
        root: {
          kind: 'split',
          id: 'startup-anchor-root',
          axis: 'columns',
          ratio: 0.5,
          first: { kind: 'leaf', id: 'anchor-pane', tabId: 'anchor' },
          second: {
            kind: 'split',
            id: 'focused-pair-root',
            axis: 'rows',
            ratio: 0.5,
            first: { kind: 'leaf', id: 'focused-main-pane', tabId: 'focused' },
            second: { kind: 'leaf', id: 'focused-side-pane', tabId: 'focused:side' },
          },
        },
        focusedPaneId: 'focused-side-pane',
      },
      tabs: [
        { id: 'anchor', groupId: 'anchor', target: '#/page/anchor-before', back: ['#/page/anchor-back'], forward: [] },
        { id: 'focused', groupId: 'focused', target: '#/page/focused-main', back: ['#/page/focused-main-before'], forward: [] },
        {
          id: 'focused:side',
          groupId: 'focused',
          target: '#/page/focused-side',
          back: ['#/page/focused-side-before'],
          forward: ['#/page/focused-side-forward'],
        },
      ],
      closed: [],
    });
    const { tabs, writes } = await freshTabs(raw, '#/page/launch');
    const stop = tabs.startTabs();

    expect(tabs.routeHashForPane('anchor-pane')).toBe('#/page/anchor-before');
    expect(tabs.routeHashForPane('focused-main-pane')).toBe('#/page/launch');
    expect(tabs.routeHashForPane('focused-side-pane')).toBe('#/page/focused-side');
    expect(tabs.targetPane()).toBe('focused-side-pane');
    expect(tabs.isPrimaryPane('focused-main-pane')).toBe(true);
    expect(tabs.getTabs().layout.tabs.find((item) => item.id === 'anchor')?.back).toEqual(['#/page/anchor-back']);
    expect(tabs.getTabs().layout.tabs.find((item) => item.id === 'focused')?.back).toEqual([
      '#/page/focused-main-before',
      '#/page/focused-main',
    ]);

    window.location.hash = '#/page/external-after-startup';
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(tabs.routeHashForPane('anchor-pane')).toBe('#/page/anchor-before');
    expect(tabs.routeHashForPane('focused-main-pane')).toBe('#/page/external-after-startup');
    expect(tabs.routeHashForPane('focused-side-pane')).toBe('#/page/focused-side');
    expect(tabs.targetPane()).toBe('focused-side-pane');
    expect(tabs.getTabs().layout.tabs.find((item) => item.id === 'anchor')?.back).toEqual(['#/page/anchor-back']);
    expect(tabs.getTabs().layout.tabs.find((item) => item.id === 'focused')?.back).toEqual([
      '#/page/focused-main-before',
      '#/page/focused-main',
      '#/page/launch',
    ]);

    tabs.setPanePreset('two-by-two');
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const [physicalAnchor] = tabs.paneSlots();
    const focusedMain = tabs.paneAssignments().find((assignment) => assignment.tabId === 'focused')!;
    expect(tabs.isPrimaryPane(physicalAnchor!.paneId)).toBe(true);
    expect(tabs.routeHashForPane(physicalAnchor!.paneId)).toBe('#/page/anchor-before');
    expect(tabs.isPrimaryPane(focusedMain.paneId)).toBe(false);
    expect(window.location.hash).toBe('#/page/anchor-before');

    window.location.hash = '#/page/external-after-preset';
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(tabs.routeHashForPane(physicalAnchor!.paneId)).toBe('#/page/external-after-preset');
    expect(tabs.routeHashForTabId('focused')).toBe('#/page/external-after-startup');
    expect(currentSnapshot().layout.tabs).toEqual(tabs.getTabs().layout.tabs);
    expect(writes.length).toBeGreaterThan(0);
    stop();
  });

  it('does not write or navigate when reselecting an explicitly chosen preset', async () => {
    const raw = JSON.stringify({
      schemaVersion: 2,
      paneLayout: {
        version: 1,
        id: 'same-preset-layout',
        root: {
          kind: 'split',
          id: 'same-preset-root',
          axis: 'columns',
          ratio: 0.5,
          first: { kind: 'leaf', id: 'same-preset-a', tabId: 'same-preset-tab-a' },
          second: { kind: 'leaf', id: 'same-preset-b', tabId: 'same-preset-tab-b' },
        },
        focusedPaneId: 'same-preset-b',
      },
      tabs: [
        { id: 'same-preset-tab-a', groupId: 'a', target: '#/page/a', back: ['#/page/a-before'], forward: [] },
        { id: 'same-preset-tab-b', groupId: 'b', target: '#/page/b', back: ['#/page/b-before'], forward: [] },
      ],
      closed: [],
    });
    const { tabs, writes, readFromStorage } = await freshTabs(raw, '#/page/transient-deep-link');
    const secondPane = tabs.paneSlots()[1]!;

    expect(tabs.routeHashForPane(secondPane.paneId)).toBe('#/page/transient-deep-link');
    expect(window.location.hash).toBe('#/page/transient-deep-link');
    expect(writes).toEqual([]);

    tabs.setPanePreset('two-by-two');

    const expandedSecondPane = tabs.paneSlots()[1]!;
    expect(tabs.paneSlots().map((slot) => slot.tabId)).toEqual([
      'same-preset-tab-a',
      'same-preset-tab-b',
      null,
      null,
    ]);
    expect(tabs.routeHashForPane(expandedSecondPane.paneId)).toBe('#/page/transient-deep-link');
    expect(currentSnapshot().layout.tabs.find((tab) => tab.id === 'same-preset-tab-b')?.target).toBe(
      '#/page/b',
    );
    const writesAfterChange = writes.length;
    const hashAfterChange = window.location.hash;
    const storedAfterChange = readFromStorage();
    expect(writesAfterChange).toBeGreaterThan(0);

    tabs.setPanePreset('two-by-two');

    expect(writes).toHaveLength(writesAfterChange);
    expect(readFromStorage()).toBe(storedAfterChange);
    expect(window.location.hash).toBe(hashAfterChange);
    expect(tabs.routeHashForPane(expandedSecondPane.paneId)).toBe('#/page/transient-deep-link');
  });

  it('keeps an assigned startup deep link visible across 2-to-4 panes until directed navigation', async () => {
    const { tabs, writes } = await freshTabs(twoPaneForkSnapshot(), '#/page/startup-deep-link');

    expect(tabs.getTabs().layout.tabs.find((tab) => tab.id === 'two-pane-tab')?.target).toBe(
      '#/page/startup-deep-link',
    );
    expect(writes).toEqual([]);

    tabs.setPanePreset('two-by-two');

    const firstPane = tabs.paneSlots()[0]!;
    expect(tabs.paneSlots().map((slot) => slot.tabId)).toEqual([
      'two-pane-tab',
      'two-pane-tab:side',
      null,
      null,
    ]);
    expect(tabs.routeHashForPane(firstPane.paneId)).toBe('#/page/startup-deep-link');
    expect(tabs.getTabs().layout.tabs.find((tab) => tab.id === 'two-pane-tab')).toMatchObject({
      target: '#/page/startup-deep-link',
      back: ['#/page/main-before', '#/page/main'],
      forward: [],
    });
    expect(window.location.hash).toBe('#/page/startup-deep-link');
    expect(currentSnapshot().layout.tabs.find((tab) => tab.id === 'two-pane-tab')).toMatchObject({
      target: '#/page/main',
      back: ['#/page/main-before'],
      forward: [],
    });
    const writesAfterLayoutChange = writes.length;
    expect(writesAfterLayoutChange).toBeGreaterThan(0);

    tabs.setPanePreset('two-by-two');

    expect(writes).toHaveLength(writesAfterLayoutChange);
    expect(window.location.hash).toBe('#/page/startup-deep-link');
    expect(tabs.getTabs().layout.tabs.find((tab) => tab.id === 'two-pane-tab')?.target).toBe(
      '#/page/startup-deep-link',
    );

    tabs.showInPane('#/page/directed-navigation', firstPane.paneId);

    expect(tabs.getTabs().layout.tabs.find((tab) => tab.id === 'two-pane-tab')?.target).toBe(
      '#/page/directed-navigation',
    );
    expect(currentSnapshot().layout.tabs.find((tab) => tab.id === 'two-pane-tab')).toMatchObject({
      target: '#/page/directed-navigation',
      back: ['#/page/main-before', '#/page/main', '#/page/startup-deep-link'],
    });
    expect(writes.length).toBeGreaterThan(writesAfterLayoutChange);
  });

  it('keeps an empty first physical leaf separate from the selected v2 URL anchor', async () => {
    const raw = JSON.stringify({
      schemaVersion: 2,
      paneLayout: {
        version: 1,
        id: 'empty-anchor-layout',
        root: {
          kind: 'split',
          id: 'empty-anchor-root',
          axis: 'columns',
          ratio: 0.5,
          first: { kind: 'leaf', id: 'empty-anchor-pane', tabId: null },
          second: { kind: 'leaf', id: 'occupied-focused-pane', tabId: 'focused' },
        },
        focusedPaneId: 'occupied-focused-pane',
      },
      tabs: [
        {
          id: 'focused',
          groupId: 'focused',
          target: '#/page/focused-before',
          back: ['#/page/focused-history'],
          forward: ['#/page/focused-forward'],
        },
      ],
      closed: [],
    });
    const { tabs, writes } = await freshTabs(raw, '#/page/launch-empty-anchor');
    const [emptyPhysical, focused] = tabs.paneSlots();
    const stop = tabs.startTabs();

    expect(emptyPhysical!.tabId).toBeNull();
    expect(tabs.routeHashForPane(focused!.paneId)).toBe('#/page/launch-empty-anchor');
    expect(tabs.getTabs().layout.tabs.find((item) => item.id === 'focused')).toMatchObject({
      target: '#/page/launch-empty-anchor',
      back: ['#/page/focused-history', '#/page/focused-before'],
    });
    expect(tabs.targetPane()).toBe(focused!.paneId);
    expect(tabs.isPrimaryPane(focused!.paneId)).toBe(true);
    tabs.setActivePane(emptyPhysical!.paneId);
    expect(window.location.hash).toBe('#/page/launch-empty-anchor');

    window.location.hash = '#/page/external-empty-anchor';
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(emptyPhysical!.tabId).toBeNull();
    expect(tabs.routeHashForPane(focused!.paneId)).toBe('#/page/external-empty-anchor');
    expect(tabs.getTabs().layout.tabs.find((item) => item.id === 'focused')).toMatchObject({
      target: '#/page/external-empty-anchor',
      back: ['#/page/focused-history', '#/page/focused-before', '#/page/launch-empty-anchor'],
    });
    expect(tabs.targetPane()).toBe(emptyPhysical!.paneId);
    expect(currentSnapshot().layout.tabs).toEqual(tabs.getTabs().layout.tabs);
    expect(writes.length).toBeGreaterThan(0);
    stop();
  });

  it('assigns a launch route to the selected empty v2 anchor only in memory', async () => {
    const raw = JSON.stringify({
      schemaVersion: 2,
      paneLayout: {
        version: 1,
        id: 'selected-empty-anchor-layout',
        root: {
          kind: 'split',
          id: 'selected-empty-anchor-root',
          axis: 'columns',
          ratio: 0.5,
          first: { kind: 'leaf', id: 'physical-first-empty', tabId: null },
          second: { kind: 'leaf', id: 'selected-empty-anchor', tabId: null },
        },
        focusedPaneId: 'selected-empty-anchor',
      },
      tabs: [
        {
          id: 'waiting',
          groupId: 'waiting',
          target: '#/page/waiting-before-launch',
          back: ['#/page/waiting-history'],
          forward: ['#/page/waiting-forward'],
        },
      ],
      closed: [],
    });
    const { tabs, writes } = await freshTabs(raw, '#/page/launch-empty-selected');
    const [physicalFirst, selected] = tabs.paneSlots();
    const stop = tabs.startTabs();

    expect(physicalFirst!.tabId).toBeNull();
    expect(selected!.tabId).toBe('waiting');
    expect(tabs.routeHashForPane(selected!.paneId)).toBe('#/page/launch-empty-selected');
    expect(tabs.isPrimaryPane(selected!.paneId)).toBe(true);
    expect(tabs.getTabs().layout.tabs.find((item) => item.id === 'waiting')).toMatchObject({
      target: '#/page/launch-empty-selected',
      back: ['#/page/waiting-history', '#/page/waiting-before-launch'],
      forward: ['#/page/waiting-forward'],
    });

    tabs.setActivePane(physicalFirst!.paneId);
    window.location.hash = '#/page/external-empty-selected';
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(physicalFirst!.tabId).toBeNull();
    expect(tabs.routeHashForPane(selected!.paneId)).toBe('#/page/external-empty-selected');
    expect(tabs.getTabs().layout.tabs.find((item) => item.id === 'waiting')).toMatchObject({
      target: '#/page/external-empty-selected',
      back: ['#/page/waiting-history', '#/page/waiting-before-launch', '#/page/launch-empty-selected'],
    });
    expect(tabs.getTabs().layout.tabs).toHaveLength(1);
    expect(currentSnapshot().layout.tabs).toEqual(tabs.getTabs().layout.tabs);
    expect(writes.length).toBeGreaterThan(0);
    stop();
  });

  it('resolves pin protection and new-tab assignment from the requested physical pane', async () => {
    const raw = JSON.stringify({
      tabs: [
        { id: 'a', hash: '#/page/a', back: ['#/page/a-before'], forward: [], side: null },
        { id: 'b', hash: '#/page/b', back: ['#/page/b-before'], forward: [], side: null },
      ],
      active: 'a',
      pane: 'main',
      closed: [],
    });

    const pinnedTarget = await freshTabs(raw, '#/page/a');
    pinnedTarget.tabs.setPanePreset('two-columns');
    const [aPane, bPane] = pinnedTarget.tabs.paneSlots();
    pinnedTarget.tabs.assignTabToPane('b', bPane!.paneId);
    pinnedTarget.tabs.setTabPinned('a', true);
    pinnedTarget.tabs.setActivePane(bPane!.paneId);
    pinnedTarget.router.navigate({ name: 'page', id: 'opened-from-pinned-a', find: null }, { pane: aPane!.paneId });

    const replacementId = pinnedTarget.tabs.paneSlots()[0]!.tabId!;
    expect(replacementId).not.toBe('a');
    expect(pinnedTarget.tabs.getTabs().layout.tabs.find((item) => item.id === 'a')).toMatchObject({
      target: '#/page/a',
      back: ['#/page/a-before'],
      pinned: true,
    });
    expect(pinnedTarget.tabs.routeHashForPane(aPane!.paneId)).toBe('#/page/opened-from-pinned-a');
    expect(pinnedTarget.tabs.routeHashForPane(bPane!.paneId)).toBe('#/page/b');
    expect(pinnedTarget.tabs.targetPane()).toBe(aPane!.paneId);
    expect(pinnedTarget.tabs.getTabs().layout.tabs.find((item) => item.id === replacementId)?.target).toBe(
      '#/page/opened-from-pinned-a',
    );
    expect(pinnedTarget.tabs.getTabs().tabs).toHaveLength(3);
    expect(pinnedTarget.tabs.getTabs().persistenceWritable).toBe(true);
    expect(currentSnapshot().layout.tabs).toEqual(pinnedTarget.tabs.getTabs().layout.tabs);
    expect(pinnedTarget.writes.length).toBeGreaterThan(0);

    const pinnedOther = await freshTabs(raw, '#/page/a');
    pinnedOther.tabs.setPanePreset('two-columns');
    const [otherA, otherB] = pinnedOther.tabs.paneSlots();
    pinnedOther.tabs.assignTabToPane('b', otherB!.paneId);
    pinnedOther.tabs.setTabPinned('b', true);
    pinnedOther.tabs.setActivePane(otherB!.paneId);
    pinnedOther.router.navigate({ name: 'page', id: 'navigated-in-unpinned-a', find: null }, { pane: otherA!.paneId });

    expect(pinnedOther.tabs.paneSlots().map((slot) => slot.tabId)).toEqual(['a', 'b']);
    expect(pinnedOther.tabs.getTabs().layout.tabs.find((item) => item.id === 'a')).toMatchObject({
      target: '#/page/navigated-in-unpinned-a',
      back: ['#/page/a-before', '#/page/a'],
    });
    expect(pinnedOther.tabs.getTabs().layout.tabs.find((item) => item.id === 'b')).toMatchObject({
      target: '#/page/b',
      pinned: true,
    });
    expect(pinnedOther.tabs.routeHashForPane(otherA!.paneId)).toBe('#/page/navigated-in-unpinned-a');
    expect(pinnedOther.tabs.routeHashForPane(otherB!.paneId)).toBe('#/page/b');
    expect(pinnedOther.tabs.targetPane()).toBe(otherA!.paneId);
    expect(pinnedOther.tabs.getTabs().tabs).toHaveLength(2);
    expect(currentSnapshot().layout.tabs).toEqual(pinnedOther.tabs.getTabs().layout.tabs);
    expect(pinnedOther.writes.length).toBeGreaterThan(0);
  });

  it('keeps the address bar anchored to the first physical pane while activeHash follows focus', async () => {
    const raw = JSON.stringify({
      tabs: [{ id: 'legacy-main', hash: '#/page/a', back: [], forward: [], side: null }],
      active: 'legacy-main',
      pane: 'main',
      closed: [],
    });
    const { tabs } = await freshTabs(raw, '#/page/a');
    const stop = tabs.startTabs();
    tabs.setPanePreset('two-by-two');
    const [anchor, second, third, fourth] = tabs.paneSlots();

    tabs.showInPane('#/page/b', second!.paneId);
    tabs.showInPane('#/page/c', third!.paneId);
    tabs.showInPane('#/page/d', fourth!.paneId);
    expect(tabs.routeHashForPane('side')).toBe('#/page/b');
    expect(tabs.routeHashForPane('third')).toBe('#/page/c');
    expect(tabs.routeHashForPane('fourth')).toBe('#/page/d');
    tabs.setActivePane(second!.paneId);
    expect(tabs.activeHash()).toBe('#/page/b');
    tabs.setActivePane(third!.paneId);
    expect(tabs.routeHashForPane(third!.paneId)).toBe('#/page/c');
    expect(tabs.activeHash()).toBe('#/page/c');
    expect(window.location.hash).toBe('#/page/a');

    window.location.hash = '#/page/external';
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(tabs.routeHashForPane(anchor!.paneId)).toBe('#/page/external');
    expect(tabs.routeHashForPane(third!.paneId)).toBe('#/page/c');
    expect(tabs.activeHash()).toBe('#/page/c');
    expect(window.location.hash).toBe('#/page/external');
    stop();
  });

  it('migrates a legacy split losslessly before exposing an independent pane', async () => {
    const raw = JSON.stringify({
      tabs: [
        {
          id: 'legacy-main',
          hash: '#/page/a',
          back: ['#/page/a-before'],
          forward: [],
          side: { hash: '#/page/b', back: ['#/page/b-before'], forward: [] },
        },
      ],
      active: 'legacy-main',
      pane: 'main',
      closed: [],
    });
    const { tabs, writes } = await freshTabs(raw, '#/page/a');

    tabs.closeSide();
    expect(tabs.getTabs().persistenceWritable).toBe(true);
    expect(tabs.paneSlots().map((slot) => slot.tabId)).toEqual(['legacy-main']);
    const closedSnapshot = window.localStorage.getItem(PANE_TABS_STORAGE_KEY)!;
    expect(currentSnapshot(closedSnapshot).layout.tabs).toEqual(tabs.getTabs().layout.tabs);
    expect(currentSnapshot(closedSnapshot).layout.tabs.map((tab) => tab.id)).toEqual(['legacy-main']);

    tabs.setPanePreset('two-columns');
    expect(tabs.getTabs().persistenceWritable).toBe(true);
    const empty = tabs.paneSlots()[1]!;
    expect(empty.tabId).toBeNull();
    tabs.showInPane('#/page/c', empty.paneId);

    expect(tabs.paneAssignments().map((assignment) => assignment.tabId)).toEqual([
      'legacy-main',
      expect.any(String),
    ]);
    expect(tabs.getTabs().persistenceWritable).toBe(true);
    expect(currentSnapshot().layout.tabs).toEqual(tabs.getTabs().layout.tabs);
    expect(writes.length).toBeGreaterThan(1);
  });

  it('keeps explicit two-column assignments and histories when pinning the focused tab', async () => {
    const raw = JSON.stringify({
      tabs: [{ id: 'legacy-main', hash: '#/page/a', back: ['#/page/a-before'], forward: [], side: null }],
      active: 'legacy-main',
      pane: 'main',
      closed: [],
    });
    const { tabs, writes } = await freshTabs(raw, '#/page/a');
    tabs.setPanePreset('two-columns');
    const [first, second] = tabs.paneSlots();
    tabs.showInPane('#/page/b', second!.paneId);
    const secondTabId = tabs.paneSlots()[1]!.tabId!;
    tabs.setActivePane(second!.paneId);
    const before = tabs.getTabs().layout.tabs.map((tab) => ({
      id: tab.id,
      target: tab.target,
      back: [...tab.back],
      forward: [...tab.forward],
    })).sort((left, right) => left.id.localeCompare(right.id));

    tabs.setTabPinned(secondTabId, true);

    expect(tabs.paneSlots().map((slot) => slot.tabId)).toEqual(['legacy-main', secondTabId]);
    expect(tabs.getTabs().layout.tabs.map((tab) => ({
      id: tab.id,
      target: tab.target,
      back: [...tab.back],
      forward: [...tab.forward],
    })).sort((left, right) => left.id.localeCompare(right.id))).toEqual(before);
    expect(tabs.targetPane()).toBe(second!.paneId);
    expect(tabs.getTabs().tabs[0]).toMatchObject({ id: secondTabId, pinned: true });
    expect(first!.tabId).toBe('legacy-main');
    expect(currentSnapshot().layout.tabs).toEqual(tabs.getTabs().layout.tabs);
    expect(writes.length).toBeGreaterThan(0);
  });

  it('writes a two-column preset as v2 before navigating from its empty pane', async () => {
    const raw = JSON.stringify({
      tabs: [{ id: 'legacy-main', hash: '#/page/start', back: [], forward: [], side: null }],
      active: 'legacy-main',
      pane: 'main',
      closed: [],
    });
    const { tabs, writes } = await freshTabs(raw, '#/page/start');

    tabs.setPanePreset('two-columns');
    expect(tabs.paneSlots().map((slot) => slot.tabId)).toEqual(['legacy-main', null]);
    expect(tabs.getTabs().persistenceWritable).toBe(true);
    tabs.showInMain('#/page/navigated-after-layout-change');

    expect(currentSnapshot().layout.tabs).toEqual(tabs.getTabs().layout.tabs);
    expect(currentSnapshot().layout.root).toEqual(tabs.getTabs().layout.root);
    expect(writes.length).toBeGreaterThan(0);
  });

  it('opens any note in the exact focused empty pane and persists the complete rich layout', async () => {
    const raw = JSON.stringify({
      tabs: [{ id: 'legacy-main', hash: '#/page/start', back: ['#/page/before'], forward: [], side: null }],
      active: 'legacy-main',
      pane: 'main',
      closed: [],
    });
    const { tabs, router, writes } = await freshTabs(raw, '#/page/start');

    tabs.setPanePreset('two-by-two');
    const slots = tabs.paneSlots();
    expect(slots).toHaveLength(4);
    expect(slots.map((slot) => slot.tabId)).toEqual(['legacy-main', null, null, null]);

    const primaryHash = window.location.hash;
    const targetPane = slots[2]!.paneId;
    tabs.setActivePane(targetPane);
    expect(tabs.targetPane()).toBe(targetPane);
    router.openPage('opened-in-third-pane');
    const thirdId = tabs.paneSlots()[2]!.tabId;
    expect(thirdId).not.toBeNull();
    expect(tabs.routeHashForPane(targetPane)).toBe('#/page/opened-in-third-pane');
    expect(window.location.hash).toBe(primaryHash);

    tabs.openTab('#/page/foreground-in-third-pane');
    const foreground = tabs.paneSlots()[2]!.tabId;
    expect(foreground).not.toBeNull();
    expect(foreground).not.toBe(thirdId);
    expect(tabs.routeHashForPane(targetPane)).toBe('#/page/foreground-in-third-pane');
    expect(window.location.hash).toBe(primaryHash);

    tabs.openTab('#/page/background', { background: true });
    const background = tabs.getTabs().tabs.find((tab) => tab.hash === '#/page/background')!;
    expect(tabs.paneSlots()[2]!.tabId).toBe(foreground);
    tabs.activateTab(background.id);
    expect(tabs.targetPane()).toBe(targetPane);
    expect(tabs.paneSlots()[2]!.tabId).toBe(background.id);
    expect(window.location.hash).toBe(primaryHash);
    expect(tabs.activeHash()).toBe('#/page/background');

    const histories = tabs.getTabs().layout.tabs.map((tab) => ({ id: tab.id, back: tab.back, forward: tab.forward }));
    tabs.setPanePreset('two-columns');
    expect(tabs.paneSlots().map((slot) => slot.tabId)).toEqual(['legacy-main', background.id]);
    expect(tabs.getTabs().layout.tabs.map((tab) => tab.id)).toContain(thirdId);
    expect(tabs.getTabs().layout.tabs.map((tab) => tab.id)).toContain(foreground);
    expect(tabs.getTabs().layout.tabs.map((tab) => ({ id: tab.id, back: tab.back, forward: tab.forward }))).toEqual(
      histories,
    );
    expect(currentSnapshot().layout.tabs).toEqual(tabs.getTabs().layout.tabs);
    expect(writes.length).toBeGreaterThan(0);

    tabs.showInMain('#/page/after-reduction');
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(currentSnapshot().layout.tabs).toEqual(tabs.getTabs().layout.tabs);
    expect(writes.length).toBeGreaterThan(0);
  });

  it('does not suspend or persist a startup-only blank-slot assignment when reducing and reopening a preset', async () => {
    const raw = blankFirstFocusedFourPaneSnapshot();
    const { tabs, writes } = await freshTabs(raw, '#/page/startup-link');
    const initialSlots = tabs.paneSlots();
    const blankFirst = initialSlots[0]!;
    expect(blankFirst.tabId).toBe('hidden-waiting');
    expect(tabs.routeHashForPane(blankFirst.paneId)).toBe('#/page/startup-link');
    expect(writes).toEqual([]);

    // Choosing another real pane is deliberate focus and must survive the reduction.
    tabs.setActivePane(initialSlots[3]!.paneId);
    tabs.setPanePreset('two-columns');

    expect(tabs.paneSlots().map((slot) => slot.tabId)).toEqual(['real-a', 'real-c']);
    expect(tabs.targetPane()).toBe(tabs.paneSlots()[1]!.paneId);
    expect(tabs.getTabs().layout.tabs).toEqual(
      expect.arrayContaining([
        {
          id: 'hidden-waiting',
          groupId: 'hidden-waiting',
          target: '#/page/waiting-before-startup',
          back: ['#/page/waiting-back'],
          forward: ['#/page/waiting-forward'],
        },
        expect.objectContaining({ id: 'real-a', target: '#/page/a', back: ['#/page/a-back'] }),
        expect.objectContaining({ id: 'real-b', target: '#/page/b', back: ['#/page/b-back'] }),
        expect.objectContaining({ id: 'real-c', target: '#/page/c', back: ['#/page/c-back'] }),
      ]),
    );
    expect(visiblePaneLeaves(tabs.getTabs().layout).map((leaf) => leaf.tabId)).toEqual(['real-a', 'real-c']);
    expect(currentSnapshot().layout.tabs).toEqual(tabs.getTabs().layout.tabs);
    expect(currentSnapshot().closed).toEqual(['#/page/closed-before-layout']);
    expect(writes.length).toBeGreaterThan(0);

    tabs.setPanePreset('two-by-two');

    expect(tabs.paneSlots().map((slot) => slot.tabId)).toEqual(['real-a', 'real-c', 'real-b', null]);
    expect(tabs.getTabs().layout.tabs.map((tab) => tab.id)).toEqual([
      'hidden-waiting',
      'real-a',
      'real-b',
      'real-c',
    ]);
    expect(tabs.getTabs().layout.tabs.find((tab) => tab.id === 'hidden-waiting')).toMatchObject({
      target: '#/page/waiting-before-startup',
      back: ['#/page/waiting-back'],
      forward: ['#/page/waiting-forward'],
    });
    expect(tabs.paneSlots().find((slot) => slot.paneId === tabs.targetPane())?.tabId).toBe('real-c');
    expect(currentSnapshot().layout.root).toEqual(tabs.getTabs().layout.root);
    expect(currentSnapshot().layout.tabs).toEqual(tabs.getTabs().layout.tabs);
  });

  it('persists the launch assignment only after an explicit open in its original blank pane', async () => {
    const { tabs, writes } = await freshTabs(blankFirstFocusedFourPaneSnapshot(), '#/page/startup-link');
    const originalSlot = tabs.paneSlots()[0]!;

    expect(originalSlot.tabId).toBe('hidden-waiting');
    expect(writes).toEqual([]);

    tabs.showInPane('#/page/startup-link', originalSlot.paneId);

    expect(writes.length).toBeGreaterThan(0);
    expect(tabs.paneSlots()[0]?.tabId).toBe('hidden-waiting');
    expect(currentSnapshot().layout.root).toEqual(tabs.getTabs().layout.root);
    expect(currentSnapshot().layout.tabs.find((tab) => tab.id === 'hidden-waiting')).toMatchObject({
      target: '#/page/startup-link',
      back: ['#/page/waiting-back', '#/page/waiting-before-startup'],
      forward: ['#/page/waiting-forward'],
    });
  });

  it('persists v2 preset changes and retains the complete instance registry', async () => {
    const raw = twoPaneForkSnapshot();
    const { tabs, writes } = await freshTabs(raw, '#/page/main');
    const originalInstances = tabs.getTabs().layout.tabs;

    tabs.setPanePreset('two-by-two');
    expect(tabs.paneSlots()).toHaveLength(4);
    tabs.setActivePane(tabs.paneSlots()[3]!.paneId);
    tabs.setPanePreset('two-columns');

    expect(tabs.getTabs().layout.tabs).toEqual(originalInstances);
    expect(currentSnapshot().layout.tabs).toEqual(tabs.getTabs().layout.tabs);
    expect(currentSnapshot().layout.root).toEqual(tabs.getTabs().layout.root);
    expect(writes.length).toBeGreaterThan(0);
  });

  it('restores suspended instances and histories when a reduced layout expands again', async () => {
    const raw = JSON.stringify({
      tabs: [{ id: 'legacy-main', hash: '#/page/start', back: [], forward: [], side: null }],
      active: 'legacy-main',
      pane: 'main',
      closed: [],
    });
    const { tabs, router, writes } = await freshTabs(raw, '#/page/start');
    tabs.setPanePreset('two-by-two');

    for (const slot of tabs.paneSlots().slice(1)) {
      tabs.setActivePane(slot.paneId);
      router.openPage(`note-${slot.role}`);
      if (slot.role === 'side') router.openPage('note-side-followup');
    }
    const originalTabs = tabs.getTabs().layout.tabs.map((tab) => ({
      id: tab.id,
      target: tab.target,
      back: [...tab.back],
      forward: [...tab.forward],
    }));
    const focusedTabId = tabs.paneSlots().find((slot) => slot.paneId === tabs.targetPane())?.tabId;

    tabs.setPanePreset('two-columns');
    expect(tabs.paneSlots().map((slot) => slot.tabId)).toEqual([
      'legacy-main',
      focusedTabId,
    ]);
    tabs.setPanePreset('two-by-two');

    const reopenedIds = tabs.paneSlots().map((slot) => slot.tabId);
    expect(reopenedIds).toHaveLength(4);
    expect(new Set(reopenedIds).size).toBe(4);
    expect(new Set(reopenedIds)).toEqual(new Set(originalTabs.map((tab) => tab.id)));
    expect(tabs.getTabs().layout.tabs.map((tab) => ({
      id: tab.id,
      target: tab.target,
      back: tab.back,
      forward: tab.forward,
    }))).toEqual(originalTabs);
    expect(tabs.paneSlots().find((slot) => slot.paneId === tabs.targetPane())?.tabId).toBe(focusedTabId);
    expect(currentSnapshot().layout.tabs).toEqual(tabs.getTabs().layout.tabs);
    expect(currentSnapshot().layout.root).toEqual(tabs.getTabs().layout.root);
    expect(writes.length).toBeGreaterThan(0);
  });

  it('opens the command palette from a blank pane using that pane id as the router target', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    class ResizeObserverStub {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    const { tabs, router } = await freshTabs(null, '#/page/main');
    tabs.setPanePreset('one-left-two-right');
    const slot = tabs.paneSlots()[2]!;
    const { Pane } = await import('./App');
    const ui = await import('./ui');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () =>
        root.render(
          createElement(Pane, {
            role: slot.role,
            paneId: slot.paneId,
            tabId: null,
            route: null,
            active: false,
          }),
        ),
      );
      const button = container.querySelector('button');
      expect(button?.textContent).toContain('Open a note or database here');
      await act(async () => button?.click());
      expect(tabs.targetPane()).toBe(slot.paneId);
      expect(ui.getUi().palette).toBe(true);

      router.openPage('opened-from-palette');
      expect(tabs.routeHashForPane(slot.paneId)).toBe('#/page/opened-from-palette');
      expect(window.location.hash).toBe('#/page/main');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  }, 15_000);
});
