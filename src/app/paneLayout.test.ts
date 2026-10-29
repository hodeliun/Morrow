import { describe, expect, it } from 'vitest';
import {
  MAX_VISIBLE_PANES,
  MIN_SPLIT_RATIO,
  applyPanePreset,
  availablePaneTabs,
  beginPaneResize,
  cancelPaneResize,
  closePane,
  createPaneLayout,
  focusPane,
  migrateLegacySplit,
  movePaneTab,
  panePresetOf,
  previewPaneResize,
  removePaneTabs,
  resetPaneSplit,
  swapPaneTabs,
  validatePaneLayout,
  visiblePaneLeaves,
} from './paneLayout';
import type { PaneLayout, PaneNode, PaneTabInstance } from './paneLayout';

interface DraftTab extends PaneTabInstance<string> {
  readonly draft: { text: string; saveQueueId: string } | null;
}

const makeTab = (id: string): DraftTab => ({
  id,
  groupId: id,
  target: `#/page/${id}`,
  back: [`#/page/${id}-previous`],
  forward: [],
  draft: { text: `draft:${id}`, saveQueueId: `queue:${id}` },
});

const leafIds = (layout: PaneLayout) => visiblePaneLeaves(layout).map((pane) => pane.id);
const tabIdsInPanes = (layout: PaneLayout) => visiblePaneLeaves(layout).map((pane) => pane.tabId);
const expectValid = (layout: PaneLayout) => expect(validatePaneLayout(layout)).toEqual([]);
const rootSplitId = (layoutId: string) => `${layoutId}:split:root`;
const rightSplitId = (layoutId: string) => `${layoutId}:split:right`;
const paneId = (layoutId: string, slot: number) => `${layoutId}:pane:${slot}`;

function findSplit(node: PaneNode, id: string): Extract<PaneNode, { kind: 'split' }> | null {
  if (node.kind === 'leaf') return null;
  if (node.id === id) return node;
  return findSplit(node.first, id) ?? findSplit(node.second, id);
}

function axisOrder(node: PaneNode): string[] {
  return node.kind === 'leaf' ? [] : [node.axis, ...axisOrder(node.first), ...axisOrder(node.second)];
}

describe('pane layout model', () => {
  it.each([
    ['single', 1, []],
    ['two-columns', 2, ['columns']],
    ['one-left-two-right', 3, ['columns', 'rows']],
    ['two-by-two', 4, ['columns', 'rows', 'rows']],
  ] as const)('builds the %s preset with at most four stable leaves', (preset, count, axes) => {
    const layout = createPaneLayout('layout-a', [makeTab('tab-a'), makeTab('tab-b')], 'tab-a', preset);
    expect(panePresetOf(layout)).toBe(preset);

    expect(visiblePaneLeaves(layout)).toHaveLength(count);
    expect(visiblePaneLeaves(layout).length).toBeLessThanOrEqual(MAX_VISIBLE_PANES);
    expect(axisOrder(layout.root)).toEqual(axes);
    expect(leafIds(layout)).toEqual(
      Array.from({ length: count }, (_, index) => paneId('layout-a', index + 1)),
    );
    expect(tabIdsInPanes(layout)).toEqual(['tab-a', ...Array(count - 1).fill(null)]);
    expect(availablePaneTabs(layout).map((tab) => tab.id)).toEqual(['tab-b']);
    expectValid(layout);
  });

  it('keeps the focused instance first, leaves new slots empty, and preserves every other tab', () => {
    const tabs = [makeTab('tab-a'), makeTab('tab-b'), makeTab('tab-c'), makeTab('tab-d')];
    let layout = createPaneLayout('layout-b', tabs, 'tab-a', 'two-by-two');
    layout = movePaneTab(layout, 'tab-b', paneId('layout-b', 2));
    layout = movePaneTab(layout, 'tab-c', paneId('layout-b', 3));
    layout = movePaneTab(layout, 'tab-d', paneId('layout-b', 4));
    layout = focusPane(layout, paneId('layout-b', 3));

    const switched = applyPanePreset(layout, 'two-columns');

    expect(tabIdsInPanes(switched)).toEqual(['tab-c', null]);
    expect(switched.focusedPaneId).toBe(paneId('layout-b', 1));
    expect(availablePaneTabs(switched).map((tab) => tab.id)).toEqual(['tab-a', 'tab-b', 'tab-d']);
    expect(switched.tabs).toBe(tabs);
    expect(switched.tabs[2]).toBe(tabs[2]);
    expect(leafIds(switched)).toEqual([paneId('layout-b', 1), paneId('layout-b', 2)]);
    expectValid(switched);

    const samePreset = applyPanePreset(switched, 'two-columns');
    expect(samePreset).toBe(switched);

    const restored = applyPanePreset(switched, 'two-by-two');
    expect(leafIds(restored)).toEqual(Array.from({ length: 4 }, (_, index) => paneId('layout-b', index + 1)));
    expect(tabIdsInPanes(restored)).toEqual(['tab-c', null, null, null]);
    expect(availablePaneTabs(restored).map((tab) => tab.id)).toEqual(['tab-a', 'tab-b', 'tab-d']);
    expectValid(restored);
  });

  it('moves an existing instance without cloning its history or draft and keeps displaced tabs available', () => {
    const first = makeTab('tab-a');
    const second = makeTab('tab-b');
    const tabs = [first, second];
    const initial = createPaneLayout('layout-move', tabs, first.id, 'two-columns');
    const placed = movePaneTab(initial, second.id, paneId('layout-move', 2));
    const moved = movePaneTab(placed, first.id, paneId('layout-move', 2));

    expect(tabIdsInPanes(moved)).toEqual([null, 'tab-a']);
    expect(availablePaneTabs(moved)).toEqual([second]);
    expect(moved.tabs).toBe(tabs);
    expect(moved.tabs[0]).toBe(first);
    expect(moved.tabs[1]).toBe(second);
    expect(moved.tabs[1]?.back).toEqual(['#/page/tab-b-previous']);
    expect(moved.tabs[1]?.draft).toEqual({ text: 'draft:tab-b', saveQueueId: 'queue:tab-b' });
    expect(moved.focusedPaneId).toBe(paneId('layout-move', 2));
    expectValid(moved);
  });

  it('removes closed instances from the registry and swaps visible assignments without cloning them', () => {
    const tabs = [makeTab('tab-a'), makeTab('tab-b'), makeTab('tab-c')];
    const layout = createPaneLayout('layout-assignments', tabs, 'tab-a', 'two-columns');
    const withSecond = movePaneTab(layout, 'tab-b', paneId('layout-assignments', 2));
    const swapped = swapPaneTabs(
      withSecond,
      paneId('layout-assignments', 1),
      paneId('layout-assignments', 2),
    );

    expect(tabIdsInPanes(swapped)).toEqual(['tab-b', 'tab-a']);
    expect(swapped.tabs).toBe(tabs);

    const removed = removePaneTabs(swapped, new Set(['tab-b']));
    expect(tabIdsInPanes(removed)).toEqual([null, 'tab-a']);
    expect(removed.tabs.map((tab) => tab.id)).toEqual(['tab-a', 'tab-c']);
    expect(removed.tabs[0]?.draft).toEqual({ text: 'draft:tab-a', saveQueueId: 'queue:tab-a' });
    expectValid(removed);
  });

  it('reduces by closing leaves while retaining tab instances, drafts, and valid focus', () => {
    const tabs = [makeTab('tab-a'), makeTab('tab-b'), makeTab('tab-c'), makeTab('tab-d')];
    let layout = createPaneLayout('layout-close', tabs, 'tab-a', 'two-by-two');
    layout = movePaneTab(layout, 'tab-b', paneId('layout-close', 2));
    layout = movePaneTab(layout, 'tab-c', paneId('layout-close', 3));
    layout = movePaneTab(layout, 'tab-d', paneId('layout-close', 4));
    layout = focusPane(layout, paneId('layout-close', 4));

    layout = closePane(layout, paneId('layout-close', 4));
    expect(leafIds(layout)).toEqual([
      paneId('layout-close', 1),
      paneId('layout-close', 2),
      paneId('layout-close', 3),
    ]);
    expect(layout.focusedPaneId).toBe(paneId('layout-close', 3));
    expect(availablePaneTabs(layout).map((tab) => tab.id)).toEqual(['tab-d']);
    expectValid(layout);

    layout = closePane(layout, paneId('layout-close', 3));
    layout = closePane(layout, paneId('layout-close', 2));
    expect(leafIds(layout)).toEqual([paneId('layout-close', 1)]);
    expect(tabIdsInPanes(layout)).toEqual(['tab-a']);
    expect(availablePaneTabs(layout).map((tab) => tab.id)).toEqual(['tab-b', 'tab-c', 'tab-d']);
    expect(layout.tabs).toBe(tabs);
    expect(layout.tabs[3]?.draft).toEqual({ text: 'draft:tab-d', saveQueueId: 'queue:tab-d' });
    expectValid(layout);
  });

  it('migrates legacy main and side histories and splitShare without losing other tab groups', () => {
    const legacy = {
      active: 'old-a',
      pane: 'side' as const,
      tabs: [
        {
          id: 'old-a',
          hash: '#/page/main-a',
          back: ['#/page/main-before-a'],
          forward: ['#/page/main-after-a'],
          side: {
            hash: '#/page/side-a',
            back: ['#/page/side-before-a'],
            forward: ['#/page/side-after-a'],
          },
        },
        {
          id: 'old-a:side',
          hash: '#/page/main-b',
          back: ['#/page/main-before-b'],
          forward: [],
          side: {
            hash: '#/page/side-b',
            back: [],
            forward: ['#/page/side-after-b'],
          },
        },
      ],
    };

    const migrated = migrateLegacySplit('layout-legacy', legacy, 0.64);
    const leaves = visiblePaneLeaves(migrated);
    const sideInstanceId = leaves[1]?.tabId;

    expect(leaves.map((pane) => pane.tabId)).toEqual(['old-a', 'old-a:side:2']);
    expect(migrated.focusedPaneId).toBe(paneId('layout-legacy', 2));
    expect(findSplit(migrated.root, rootSplitId('layout-legacy'))?.ratio).toBe(0.64);
    expect(migrated.tabs).toEqual([
      {
        id: 'old-a',
        groupId: 'old-a',
        target: '#/page/main-a',
        back: ['#/page/main-before-a'],
        forward: ['#/page/main-after-a'],
      },
      {
        id: 'old-a:side:2',
        groupId: 'old-a',
        target: '#/page/side-a',
        back: ['#/page/side-before-a'],
        forward: ['#/page/side-after-a'],
      },
      {
        id: 'old-a:side',
        groupId: 'old-a:side',
        target: '#/page/main-b',
        back: ['#/page/main-before-b'],
        forward: [],
      },
      {
        id: 'old-a:side:side',
        groupId: 'old-a:side',
        target: '#/page/side-b',
        back: [],
        forward: ['#/page/side-after-b'],
      },
    ]);
    expect(availablePaneTabs(migrated).map((tab) => tab.id)).toEqual(['old-a:side', 'old-a:side:side']);
    expect(sideInstanceId).toBe('old-a:side:2');
    expectValid(migrated);
  });

  it('falls back to the main pane if a legacy focused side is missing and normalizes splitShare', () => {
    const migrated = migrateLegacySplit(
      'layout-legacy-single',
      {
        active: 'old-a',
        pane: 'side',
        tabs: [{ id: 'old-a', hash: '#/page/a', back: [], forward: [], side: null }],
      },
      Number.NaN,
    );

    expect(migrated.root).toEqual({ kind: 'leaf', id: paneId('layout-legacy-single', 1), tabId: 'old-a' });
    expect(migrated.focusedPaneId).toBe(paneId('layout-legacy-single', 1));
    expectValid(migrated);
  });

  it('clamps each split independently, resets one branch, and cancels only its own resize', () => {
    let layout = createPaneLayout('layout-resize', [makeTab('tab-a')], 'tab-a', 'two-by-two');
    const root = beginPaneResize(layout, rootSplitId('layout-resize'))!;
    layout = previewPaneResize(layout, root, 0.4);
    const right = beginPaneResize(layout, rightSplitId('layout-resize'))!;
    layout = previewPaneResize(layout, right, 0.65);
    const activeRootResize = beginPaneResize(layout, rootSplitId('layout-resize'))!;
    layout = previewPaneResize(layout, activeRootResize, -0.5);
    expect(findSplit(layout.root, rootSplitId('layout-resize'))?.ratio).toBe(MIN_SPLIT_RATIO);
    layout = previewPaneResize(layout, activeRootResize, 0.95);
    layout = resetPaneSplit(layout, rightSplitId('layout-resize'));

    expect(findSplit(layout.root, rootSplitId('layout-resize'))?.ratio).toBe(0.8);
    expect(findSplit(layout.root, rightSplitId('layout-resize'))?.ratio).toBe(0.5);

    layout = cancelPaneResize(layout, activeRootResize);
    expect(findSplit(layout.root, rootSplitId('layout-resize'))?.ratio).toBe(0.4);
    expect(findSplit(layout.root, rightSplitId('layout-resize'))?.ratio).toBe(0.5);
    expect(previewPaneResize(layout, activeRootResize, Number.NaN)).toBe(layout);
    expect(MIN_SPLIT_RATIO).toBe(0.2);
    expectValid(layout);
  });

  it('invalidates an active resize when a preset changes the pane tree', () => {
    const initial = createPaneLayout('layout-stale-resize', [], null, 'two-by-two');
    const session = beginPaneResize(initial, rootSplitId('layout-stale-resize'))!;
    const changed = applyPanePreset(initial, 'two-columns');

    expect(changed.topologyRevision).toBe(initial.topologyRevision + 1);
    expect(previewPaneResize(changed, session, 0.7)).toBe(changed);
    expect(cancelPaneResize(changed, session)).toBe(changed);
    expect(findSplit(changed.root, rootSplitId('layout-stale-resize'))?.ratio).toBe(0.5);
    expectValid(changed);
  });

  it('reports broken assignment and ratio invariants instead of normalizing them silently', () => {
    const invalid: PaneLayout = {
      id: 'layout-invalid',
      focusedPaneId: 'missing-pane',
      topologyRevision: 0,
      tabs: [
        { id: 'tab-a', groupId: 'group-a', target: 'a', back: [], forward: [] },
        { id: 'tab-a', groupId: 'group-a', target: 'a-copy', back: [], forward: [] },
      ],
      root: {
        kind: 'split',
        id: 'split-root',
        axis: 'columns',
        ratio: 0.95,
        first: { kind: 'leaf', id: 'pane-1', tabId: 'tab-a' },
        second: { kind: 'leaf', id: 'pane-1', tabId: 'tab-a' },
      },
    };

    expect(validatePaneLayout(invalid)).toEqual(
      expect.arrayContaining([
        'invalid-split-ratio',
        'duplicate-node-id',
        'duplicate-tab-id',
        'duplicate-tab-assignment',
        'focused-pane-missing',
      ]),
    );

    const fourPanes = createPaneLayout('layout-too-many', [], null, 'two-by-two');
    const oversized: PaneLayout = {
      ...fourPanes,
      root: {
        kind: 'split',
        id: 'layout-too-many:split:outer',
        axis: 'columns',
        ratio: 0.5,
        first: fourPanes.root,
        second: { kind: 'leaf', id: 'layout-too-many:pane:5', tabId: null },
      },
    };
    expect(validatePaneLayout(oversized)).toContain('too-many-panes');
  });

  it('leaves an empty final slot rather than dropping the last open tab', () => {
    const layout = createPaneLayout('layout-last-pane', [makeTab('tab-a')], 'tab-a');
    const closed = closePane(layout, paneId('layout-last-pane', 1));

    expect(tabIdsInPanes(closed)).toEqual([null]);
    expect(availablePaneTabs(closed).map((tab) => tab.id)).toEqual(['tab-a']);
    expectValid(closed);
  });
});
