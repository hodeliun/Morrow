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
  detectPaneDropZone,
  duplicatePaneTab,
  focusPane,
  migrateLegacySplit,
  movePaneTab,
  panePresetOf,
  placeRouteInPane,
  previewPaneResize,
  removePaneTabs,
  resetPaneSplit,
  shouldIgnorePaneContentDragStart,
  splitPane,
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

  describe('T38 — splitting panes, drop zones, placing content, and gestures', () => {
    it('splits a pane on each edge up to four panes with valid topology and focus', () => {
      const tabs = [makeTab('tab-1'), makeTab('tab-2'), makeTab('tab-3'), makeTab('tab-4')];
      let layout = createPaneLayout('split-test', tabs, 'tab-1', 'single');
      expect(visiblePaneLeaves(layout)).toHaveLength(1);

      // Split 1: right edge (columns)
      const split1 = splitPane(layout, paneId('split-test', 1), 'right', 'tab-2');
      expect(split1.success).toBe(true);
      expect(split1.newPaneId).toBe(paneId('split-test', 2));
      layout = split1.layout;
      expect(visiblePaneLeaves(layout)).toHaveLength(2);
      expect(layout.focusedPaneId).toBe(paneId('split-test', 2));
      expect(tabIdsInPanes(layout)).toEqual(['tab-1', 'tab-2']);
      expectValid(layout);

      // Split 2: bottom edge of pane-2 (rows)
      const split2 = splitPane(layout, paneId('split-test', 2), 'bottom', 'tab-3');
      expect(split2.success).toBe(true);
      expect(split2.newPaneId).toBe(paneId('split-test', 3));
      layout = split2.layout;
      expect(visiblePaneLeaves(layout)).toHaveLength(3);
      expect(layout.focusedPaneId).toBe(paneId('split-test', 3));
      expect(tabIdsInPanes(layout)).toEqual(['tab-1', 'tab-2', 'tab-3']);
      expectValid(layout);

      // Split 3: left edge of pane-1 (columns)
      const split3 = splitPane(layout, paneId('split-test', 1), 'left', 'tab-4');
      expect(split3.success).toBe(true);
      expect(split3.newPaneId).toBe(paneId('split-test', 4));
      layout = split3.layout;
      expect(visiblePaneLeaves(layout)).toHaveLength(4);
      expect(layout.focusedPaneId).toBe(paneId('split-test', 4));
      expect(visiblePaneLeaves(layout).map((l) => l.tabId)).toContain('tab-4');
      expectValid(layout);

      // Split 4: attempted 5th pane must be rejected with too-many-panes and leave layout intact
      const split4 = splitPane(layout, paneId('split-test', 4), 'right', null);
      expect(split4.success).toBe(false);
      expect(split4.reason).toBe('too-many-panes');
      expect(split4.layout).toBe(layout);
      expect(visiblePaneLeaves(layout)).toHaveLength(4);
      expectValid(layout);
    });

    it('rejects splitting if target pane id is not found in layout', () => {
      const layout = createPaneLayout('split-missing', [makeTab('tab-1')], 'tab-1', 'single');
      const result = splitPane(layout, 'non-existent-pane', 'right');
      expect(result.success).toBe(false);
      expect(result.reason).toBe('target-not-found');
      expect(result.layout).toBe(layout);
    });

    it('clears prior leaf assignment when splitPane is given a tab already assigned elsewhere', () => {
      const tabs = [makeTab('tab-1'), makeTab('tab-2')];
      let layout = createPaneLayout('split-move', tabs, 'tab-1', 'two-columns');
      layout = movePaneTab(layout, 'tab-2', paneId('split-move', 2));
      expect(tabIdsInPanes(layout)).toEqual(['tab-1', 'tab-2']);

      // Split pane-1 with tab-2: tab-2 should move to the new pane and leave pane-2 empty
      const splitResult = splitPane(layout, paneId('split-move', 1), 'bottom', 'tab-2');
      expect(splitResult.success).toBe(true);
      const leaves = visiblePaneLeaves(splitResult.layout);
      expect(leaves).toHaveLength(3);
      const pane2 = leaves.find((l) => l.id === paneId('split-move', 2));
      expect(pane2?.tabId).toBeNull();
      const newLeaf = leaves.find((l) => l.id === splitResult.newPaneId);
      expect(newLeaf?.tabId).toBe('tab-2');
      expectValid(splitResult.layout);
    });

    it('places route in an empty pane, creating or assigning a tab', () => {
      const tabs = [makeTab('tab-1')];
      let layout = createPaneLayout('place-route', tabs, 'tab-1', 'two-columns');
      expect(tabIdsInPanes(layout)).toEqual(['tab-1', null]);

      layout = placeRouteInPane(layout, paneId('place-route', 2), '#/page/note-two');
      expect(visiblePaneLeaves(layout)[1]!.tabId).not.toBeNull();
      const newTabId = visiblePaneLeaves(layout)[1]!.tabId!;
      const assignedTab = layout.tabs.find((t) => t.id === newTabId);
      expect(assignedTab?.target).toBe('#/page/note-two');
      expect(layout.focusedPaneId).toBe(paneId('place-route', 2));
      expectValid(layout);
    });

    it('creates a new tab instance when opening the same note in a second pane, without emptying the first pane', () => {
      const tabs = [makeTab('tab-1')];
      let layout = createPaneLayout('same-note', tabs, 'tab-1', 'two-columns');
      expect(visiblePaneLeaves(layout)[0]!.tabId).toBe('tab-1');
      expect(visiblePaneLeaves(layout)[1]!.tabId).toBeNull();

      // Open the exact same note target in pane 2:
      layout = placeRouteInPane(layout, paneId('same-note', 2), '#/page/tab-1');

      const leaves = visiblePaneLeaves(layout);
      expect(leaves[0]!.tabId).toBe('tab-1'); // FIRST PANE NOT EMPTIED!
      expect(leaves[1]!.tabId).not.toBeNull();
      expect(leaves[1]!.tabId).not.toBe('tab-1'); // Second pane has distinct tab instance ID!

      const tab1 = layout.tabs.find((t) => t.id === leaves[0]!.tabId);
      const tab2 = layout.tabs.find((t) => t.id === leaves[1]!.tabId);
      expect(tab1?.target).toBe('#/page/tab-1');
      expect(tab2?.target).toBe('#/page/tab-1');
      expect(tab1?.id).not.toBe(tab2?.id);
      expect(layout.focusedPaneId).toBe(paneId('same-note', 2));
      expectValid(layout);
    });

    it('reuses an available unassigned tab with the matching target if one already exists', () => {
      const tab1 = makeTab('tab-1');
      const tab2: DraftTab = {
        ...makeTab('tab-2'),
        target: '#/page/target-x',
      };
      // tab-2 is in layout.tabs but unassigned (available)
      let layout = createPaneLayout('reuse-tab', [tab1, tab2], 'tab-1', 'two-columns');
      expect(availablePaneTabs(layout).map((t) => t.id)).toEqual(['tab-2']);

      layout = placeRouteInPane(layout, paneId('reuse-tab', 2), '#/page/target-x');
      expect(visiblePaneLeaves(layout)[1]!.tabId).toBe('tab-2');
      expect(availablePaneTabs(layout)).toHaveLength(0);
      expectValid(layout);
    });

    it('focuses target pane without creating tabs if target pane is already showing this route', () => {
      const tabs = [makeTab('tab-1')];
      let layout = createPaneLayout('already-showing', tabs, 'tab-1', 'two-columns');
      layout = focusPane(layout, paneId('already-showing', 2));
      expect(layout.focusedPaneId).toBe(paneId('already-showing', 2));

      const placed = placeRouteInPane(layout, paneId('already-showing', 1), '#/page/tab-1');
      expect(placed.focusedPaneId).toBe(paneId('already-showing', 1));
      expect(placed.tabs).toHaveLength(1);
      expect(placed.tabs[0]!.id).toBe('tab-1');
      expectValid(placed);
    });

    it('duplicates a tab instance into a target pane preserving distinct identities', () => {
      const tabs = [makeTab('tab-1')];
      let layout = createPaneLayout('duplicate-test', tabs, 'tab-1', 'two-columns');

      layout = duplicatePaneTab(layout, 'tab-1', paneId('duplicate-test', 2));
      const leaves = visiblePaneLeaves(layout);
      expect(leaves[0]!.tabId).toBe('tab-1');
      expect(leaves[1]!.tabId).not.toBeNull();
      expect(leaves[1]!.tabId).not.toBe('tab-1');
      expect(layout.tabs).toHaveLength(2);
      expect(layout.tabs[0]!.target).toBe('#/page/tab-1');
      expect(layout.tabs[1]!.target).toBe('#/page/tab-1');
      expectValid(layout);
    });

    it('preserves displaced tabs in layout.tabs when moving a tab into an occupied pane', () => {
      const tabA = makeTab('tab-a');
      const tabB = makeTab('tab-b');
      const tabC = makeTab('tab-c');
      let layout = createPaneLayout('displace-test', [tabA, tabB, tabC], 'tab-a', 'two-columns');
      layout = movePaneTab(layout, 'tab-b', paneId('displace-test', 2));
      expect(tabIdsInPanes(layout)).toEqual(['tab-a', 'tab-b']);

      // Move tab-c into pane 2 (which currently holds tab-b):
      layout = movePaneTab(layout, 'tab-c', paneId('displace-test', 2));
      expect(tabIdsInPanes(layout)).toEqual(['tab-a', 'tab-c']);
      // tab-b is still in layout.tabs and has draft preserved!
      expect(layout.tabs.some((t) => t.id === 'tab-b')).toBe(true);
      expect(availablePaneTabs(layout).map((t) => t.id)).toEqual(['tab-b']);
      const preservedB = layout.tabs.find((t) => t.id === 'tab-b') as DraftTab;
      expect(preservedB.draft?.text).toBe('draft:tab-b');
      expectValid(layout);
    });

    it('detects pane drop zones accurately by coordinate thresholds', () => {
      const bounds = { left: 100, top: 100, width: 200, height: 200 };

      // Center
      expect(detectPaneDropZone(bounds, { x: 200, y: 200 })).toBe('center');

      // Left edge (x = 110 => relX = 0.05 < 0.25)
      expect(detectPaneDropZone(bounds, { x: 110, y: 200 })).toBe('left');

      // Right edge (x = 290 => relX = 0.95 => 1 - relX = 0.05 < 0.25)
      expect(detectPaneDropZone(bounds, { x: 290, y: 200 })).toBe('right');

      // Top edge (y = 110 => relY = 0.05 < 0.25)
      expect(detectPaneDropZone(bounds, { x: 200, y: 110 })).toBe('top');

      // Bottom edge (y = 290 => relY = 0.95 => 1 - relY = 0.05 < 0.25)
      expect(detectPaneDropZone(bounds, { x: 200, y: 290 })).toBe('bottom');

      // Corner (x = 105, y = 115 => distLeft = 0.025, distTop = 0.075 => left is closer)
      expect(detectPaneDropZone(bounds, { x: 105, y: 115 })).toBe('left');

      // Corner (x = 115, y = 105 => distLeft = 0.075, distTop = 0.025 => top is closer)
      expect(detectPaneDropZone(bounds, { x: 115, y: 105 })).toBe('top');

      // Out of bounds or invalid dimensions defaults to center
      expect(detectPaneDropZone(bounds, { x: 50, y: 50 })).toBe('center');
      expect(detectPaneDropZone({ left: 0, top: 0, width: 0, height: 0 }, { x: 10, y: 10 })).toBe('center');
    });

    it('identifies media and database content that should ignore pane drag start', () => {
      // Tags
      expect(shouldIgnorePaneContentDragStart({ tagName: 'img' })).toBe(true);
      expect(shouldIgnorePaneContentDragStart({ tagName: 'VIDEO' })).toBe(true);
      expect(shouldIgnorePaneContentDragStart({ tagName: 'audio' })).toBe(true);
      expect(shouldIgnorePaneContentDragStart({ tagName: 'table' })).toBe(true);
      expect(shouldIgnorePaneContentDragStart({ tagName: 'td' })).toBe(true);
      expect(shouldIgnorePaneContentDragStart({ tagName: 'th' })).toBe(true);

      // Roles
      expect(shouldIgnorePaneContentDragStart({ role: 'gridcell' })).toBe(true);

      // Classes
      expect(shouldIgnorePaneContentDragStart({ className: 'image-block other' })).toBe(true);
      expect(shouldIgnorePaneContentDragStart({ className: 'image-file-view' })).toBe(true);
      expect(shouldIgnorePaneContentDragStart({ className: 'media-file-view' })).toBe(true);
      expect(shouldIgnorePaneContentDragStart({ className: 'pdf-file-view' })).toBe(true);
      expect(shouldIgnorePaneContentDragStart({ className: 'database-view database' })).toBe(true);
      expect(shouldIgnorePaneContentDragStart({ className: 'ProseMirror-focused ProseMirror' })).toBe(true);

      // DOM element with closest()
      const mockElement = {
        closest: (selector: string) => (selector.includes('img') ? {} : null),
      };
      expect(shouldIgnorePaneContentDragStart(mockElement)).toBe(true);

      // Regular UI elements should return false
      expect(shouldIgnorePaneContentDragStart({ tagName: 'button', className: 'tab-button' })).toBe(false);
      expect(shouldIgnorePaneContentDragStart({ tagName: 'div', className: 'tab-strip' })).toBe(false);
      expect(shouldIgnorePaneContentDragStart({ tagName: 'span', className: 'nav-item' })).toBe(false);
      expect(shouldIgnorePaneContentDragStart(null)).toBe(false);
      expect(shouldIgnorePaneContentDragStart(undefined)).toBe(false);
    });
  });
});
