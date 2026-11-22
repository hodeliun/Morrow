import { describe, expect, it } from 'vitest';
import { migrateLegacySplit, visiblePaneLeaves } from './paneLayout';
import { MAX_PERSISTED_TABS_CHARS, readPaneTabsSnapshot } from './paneLayoutStorage';

function forkSnapshot(): string {
  const tabs = [
    {
      id: 'group-a',
      groupId: 'group-a',
      target: '#/page/a-main',
      back: ['#/page/a-main-before'],
      forward: ['#/page/a-main-after'],
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
  ];
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
    tabs,
    closed: ['#/page/closed-one', '#/page/closed-two'],
  });
}

describe('published pane snapshot reader', () => {
  it('reads an unsplit Morrow 2.2 window without inventing a side pane', () => {
    const result = readPaneTabsSnapshot(
      JSON.stringify({
        tabs: [{ id: 'base-single', hash: '#/tasks', back: [], forward: [], side: null }],
        active: 'base-single',
        pane: 'main',
        closed: [],
      }),
    );

    expect(result.kind).toBe('legacy');
    if (result.kind !== 'legacy') return;
    expect(result.snapshot.tabs[0]?.side).toBeNull();
    expect(result.snapshot.pane).toBe('main');
  });

  it('reads the Morrow 2.2 unversioned snapshot with and without a split', () => {
    const raw = JSON.stringify({
      tabs: [
        {
          id: 'base-main',
          hash: '#/page/base-main',
          back: ['#/page/base-before'],
          forward: [],
          side: {
            hash: '#/page/base-side',
            back: ['#/page/side-before'],
            forward: ['#/page/side-after'],
          },
          pinned: true,
        },
        { id: 'base-single', hash: '#/tasks', back: [], forward: [], side: null },
      ],
      active: 'base-main',
      pane: 'side',
      closed: ['#/page/closed'],
    });

    const result = readPaneTabsSnapshot(raw);

    expect(result.kind).toBe('legacy');
    if (result.kind !== 'legacy') return;
    expect(result.snapshot).toEqual({
      tabs: [
        {
          id: 'base-main',
          hash: '#/page/base-main',
          back: ['#/page/base-before'],
          forward: [],
          side: {
            hash: '#/page/base-side',
            back: ['#/page/side-before'],
            forward: ['#/page/side-after'],
          },
          pinned: true,
        },
        { id: 'base-single', hash: '#/tasks', back: [], forward: [], side: null },
      ],
      active: 'base-main',
      pane: 'side',
      closed: ['#/page/closed'],
    });
  });

  it('keeps long 2.2 targets and histories beyond the v2 payload and target limits', () => {
    const target = `#/page/${'target'.repeat(1_500)}`;
    const back = Array.from({ length: 50 }, (_, index) => `#/page/${index}-${'history'.repeat(3_200)}`);
    const raw = JSON.stringify({
      tabs: [{ id: 'base-large', hash: target, back, forward: [], side: null }],
      active: 'base-large',
      pane: 'main',
      closed: [],
    });

    expect(target.length).toBeGreaterThan(8192);
    expect(raw.length).toBeGreaterThan(MAX_PERSISTED_TABS_CHARS);
    const result = readPaneTabsSnapshot(raw);

    expect(result.kind).toBe('legacy');
    if (result.kind !== 'legacy') return;
    expect(result.snapshot.tabs[0]?.hash).toBe(target);
    expect(result.snapshot.tabs[0]?.back).toEqual(back);
  });

  it('uses splitShare only to seed a migrated tree from a 2.2 split', () => {
    const result = readPaneTabsSnapshot(
      JSON.stringify({
        tabs: [
          {
            id: 'base-main',
            hash: '#/page/main',
            back: [],
            forward: [],
            side: { hash: '#/page/side', back: [], forward: [] },
          },
        ],
        active: 'base-main',
        pane: 'side',
        closed: [],
      }),
    );
    expect(result.kind).toBe('legacy');
    if (result.kind !== 'legacy') return;

    const layout = migrateLegacySplit('migration-layout', result.snapshot, 0.63);
    const leaves = visiblePaneLeaves(layout);
    expect(layout.root).toMatchObject({ kind: 'split', ratio: 0.63 });
    expect(layout.focusedPaneId).toBe(leaves[1]?.id);
    expect(layout.tabs).toHaveLength(2);
  });

  it('reads the complete latest-fork v2 snapshot without normalizing its targets', () => {
    const result = readPaneTabsSnapshot(forkSnapshot());

    expect(result.kind).toBe('current');
    if (result.kind !== 'current') return;
    expect(result.snapshot.layout.root).toMatchObject({ kind: 'split', ratio: 0.63 });
    expect(result.snapshot.layout.focusedPaneId).toBe('b-side');
    expect(result.snapshot.layout.tabs).toHaveLength(4);
    expect(result.snapshot.layout.tabs[1]).toMatchObject({
      id: 'group-a:side',
      groupId: 'group-a',
      target: '#/page/a-side',
      back: ['#/page/a-side-before'],
    });
    expect(result.snapshot.layout.tabs[3]?.forward).toEqual([]);
    expect(result.snapshot.closed).toEqual(['#/page/closed-one', '#/page/closed-two']);
  });

  it('reads the latest-fork two-pane form with its focused side and proportion', () => {
    const result = readPaneTabsSnapshot(
      JSON.stringify({
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
      }),
    );

    expect(result.kind).toBe('current');
    if (result.kind !== 'current') return;
    expect(result.snapshot.layout.root).toMatchObject({ kind: 'split', ratio: 0.61 });
    expect(result.snapshot.layout.tabs[1]).toMatchObject({
      id: 'two-pane-tab:side',
      target: '#/page/side',
      back: ['#/page/side-before'],
      forward: ['#/page/side-after'],
    });
    expect(result.snapshot.layout.focusedPaneId).toBe('side-pane');
  });

  it('recognizes future and malformed bytes without turning them into a legacy session', () => {
    const future = '{"schemaVersion":3,"tabs":[{"unknown":"kept"}]}';
    expect(readPaneTabsSnapshot(future)).toEqual({ kind: 'future', version: 3 });
    expect(
      readPaneTabsSnapshot(JSON.stringify({ schemaVersion: 1, paneLayout: { version: 1, opaque: true } })),
    ).toEqual({ kind: 'future', version: 1 });
    expect(readPaneTabsSnapshot('{malformed')).toEqual({ kind: 'invalid', reason: 'malformed-json' });
    expect(
      readPaneTabsSnapshot(
        JSON.stringify({
          tabs: [{ id: 'legacy', hash: '#/page/a', back: [], forward: [], side: null, futureField: true }],
          active: 'legacy',
          pane: 'main',
          closed: [],
        }),
      ).kind,
    ).toBe('invalid');
  });
});
