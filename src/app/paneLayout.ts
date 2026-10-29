// Pure pane-tree state. Content targets and their histories stay opaque to the layout module.
export const DEFAULT_SPLIT_RATIO = 0.5;
export const MIN_SPLIT_RATIO = 0.2;
export const MAX_SPLIT_RATIO = 0.8;
export const MAX_VISIBLE_PANES = 4;

export type PanePreset = 'single' | 'two-columns' | 'one-left-two-right' | 'two-by-two';
// `columns` places children side by side; `rows` stacks them vertically.
export type PaneSplitAxis = 'columns' | 'rows';

export interface PaneTabInstance<TTarget = unknown> {
  readonly id: string;
  // Legacy main/side content shares the browser-tab group id during migration.
  readonly groupId: string;
  readonly target: TTarget;
  readonly back: readonly TTarget[];
  readonly forward: readonly TTarget[];
}

export interface PaneLeaf {
  readonly kind: 'leaf';
  readonly id: string;
  readonly tabId: string | null;
}

export interface PaneSplit {
  readonly kind: 'split';
  readonly id: string;
  readonly axis: PaneSplitAxis;
  // Fraction assigned to `first`; each branch keeps its own ratio.
  readonly ratio: number;
  readonly first: PaneNode;
  readonly second: PaneNode;
}

export type PaneNode = PaneLeaf | PaneSplit;

export interface PaneLayout<TTab extends PaneTabInstance = PaneTabInstance> {
  readonly id: string;
  readonly root: PaneNode;
  readonly focusedPaneId: string;
  // In-memory token for invalidating resize gestures after a topology change.
  readonly topologyRevision: number;
  // Includes assigned and available instances; layout edits never discard this registry.
  readonly tabs: readonly TTab[];
}

export interface LegacyPaneHistory {
  readonly hash: string;
  readonly back: readonly string[];
  readonly forward: readonly string[];
}

export interface LegacySplitTab extends LegacyPaneHistory {
  readonly id: string;
  readonly side?: LegacyPaneHistory | null;
}

export interface LegacySplitState {
  readonly tabs: readonly LegacySplitTab[];
  readonly active: string;
  readonly pane: 'main' | 'side';
}

export interface PaneResizeSession {
  readonly layoutId: string;
  readonly splitId: string;
  readonly topologyRevision: number;
  readonly initialRatio: number;
}

export type PaneLayoutIssue =
  | 'empty-layout-id'
  | 'invalid-node'
  | 'duplicate-node-id'
  | 'invalid-split-axis'
  | 'invalid-split-ratio'
  | 'split-missing-child'
  | 'too-many-panes'
  | 'duplicate-tab-id'
  | 'duplicate-tab-assignment'
  | 'unknown-tab-assignment'
  | 'focused-pane-missing';

const paneId = (layoutId: string, slot: number) => `${layoutId}:pane:${slot}`;
const splitId = (layoutId: string, branch: string) => `${layoutId}:split:${branch}`;

function assertLayoutId(layoutId: string): void {
  if (!layoutId.trim()) throw new Error('A pane layout needs a stable id.');
}

function leaf(layoutId: string, slot: number, tabId: string | null = null): PaneLeaf {
  return { kind: 'leaf', id: paneId(layoutId, slot), tabId };
}

function split(
  layoutId: string,
  branch: string,
  axis: PaneSplitAxis,
  first: PaneNode,
  second: PaneNode,
  ratio = DEFAULT_SPLIT_RATIO,
): PaneSplit {
  return { kind: 'split', id: splitId(layoutId, branch), axis, ratio, first, second };
}

function buildPreset(layoutId: string, preset: PanePreset, firstTabId: string | null): PaneNode {
  const first = leaf(layoutId, 1, firstTabId);
  switch (preset) {
    case 'single':
      return first;
    case 'two-columns':
      return split(layoutId, 'root', 'columns', first, leaf(layoutId, 2));
    case 'one-left-two-right':
      return split(
        layoutId,
        'root',
        'columns',
        first,
        split(layoutId, 'right', 'rows', leaf(layoutId, 2), leaf(layoutId, 3)),
      );
    case 'two-by-two':
      return split(
        layoutId,
        'root',
        'columns',
        split(layoutId, 'left', 'rows', first, leaf(layoutId, 2)),
        split(layoutId, 'right', 'rows', leaf(layoutId, 3), leaf(layoutId, 4)),
      );
  }
}

function sameTopology(node: PaneNode, preset: PanePreset): boolean {
  if (preset === 'single') return node.kind === 'leaf';
  if (node.kind !== 'split' || node.axis !== 'columns') return false;
  if (preset === 'two-columns') return node.first.kind === 'leaf' && node.second.kind === 'leaf';
  if (preset === 'one-left-two-right') {
    return (
      node.first.kind === 'leaf' &&
      node.second.kind === 'split' &&
      node.second.axis === 'rows' &&
      node.second.first.kind === 'leaf' &&
      node.second.second.kind === 'leaf'
    );
  }
  return (
    node.first.kind === 'split' &&
    node.first.axis === 'rows' &&
    node.first.first.kind === 'leaf' &&
    node.first.second.kind === 'leaf' &&
    node.second.kind === 'split' &&
    node.second.axis === 'rows' &&
    node.second.first.kind === 'leaf' &&
    node.second.second.kind === 'leaf'
  );
}

export function panePresetOf(layout: PaneLayout): PanePreset | null {
  for (const preset of ['single', 'two-columns', 'one-left-two-right', 'two-by-two'] as const) {
    if (sameTopology(layout.root, preset)) return preset;
  }
  return null;
}

function walkLeaves(node: PaneNode, leaves: PaneLeaf[] = []): PaneLeaf[] {
  if (node.kind === 'leaf') {
    leaves.push(node);
    return leaves;
  }
  walkLeaves(node.first, leaves);
  walkLeaves(node.second, leaves);
  return leaves;
}

function findLeaf(node: PaneNode, id: string): PaneLeaf | null {
  if (node.kind === 'leaf') return node.id === id ? node : null;
  return findLeaf(node.first, id) ?? findLeaf(node.second, id);
}

function findSplit(node: PaneNode, id: string): PaneSplit | null {
  if (node.kind === 'leaf') return null;
  if (node.id === id) return node;
  return findSplit(node.first, id) ?? findSplit(node.second, id);
}

function updateNode(node: PaneNode, id: string, update: (match: PaneNode) => PaneNode): PaneNode {
  if (node.id === id) return update(node);
  if (node.kind === 'leaf') return node;
  const first = updateNode(node.first, id, update);
  const second = updateNode(node.second, id, update);
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

function focusedTabId(layout: PaneLayout): string | null {
  const focused = findLeaf(layout.root, layout.focusedPaneId);
  return focused?.tabId ?? walkLeaves(layout.root).find((item) => item.tabId !== null)?.tabId ?? null;
}

function allocateSideId(legacyTabId: string, usedIds: Set<string>): string {
  const base = `${legacyTabId}:side`;
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) candidate = `${base}:${suffix++}`;
  usedIds.add(candidate);
  return candidate;
}

function legacyTabInstance(id: string, groupId: string, history: LegacyPaneHistory): PaneTabInstance<string> {
  return {
    id,
    groupId,
    target: history.hash,
    back: [...history.back],
    forward: [...history.forward],
  };
}

export function createPaneLayout<TTab extends PaneTabInstance>(
  layoutId: string,
  tabs: readonly TTab[],
  initialTabId: string | null,
  preset: PanePreset = 'single',
): PaneLayout<TTab> {
  assertLayoutId(layoutId);
  if (new Set(tabs.map((tab) => tab.id)).size !== tabs.length)
    throw new Error('Pane tab ids must be unique.');
  if (initialTabId !== null && !tabs.some((tab) => tab.id === initialTabId))
    throw new Error('The initial pane tab must exist in the tab registry.');
  return {
    id: layoutId,
    root: buildPreset(layoutId, preset, initialTabId),
    focusedPaneId: paneId(layoutId, 1),
    topologyRevision: 0,
    tabs,
  };
}

export function applyPanePreset<TTab extends PaneTabInstance>(
  layout: PaneLayout<TTab>,
  preset: PanePreset,
): PaneLayout<TTab> {
  if (sameTopology(layout.root, preset)) return layout;
  return {
    ...layout,
    root: buildPreset(layout.id, preset, focusedTabId(layout)),
    focusedPaneId: paneId(layout.id, 1),
    topologyRevision: layout.topologyRevision + 1,
  };
}

export function migrateLegacySplit(
  layoutId: string,
  legacy: LegacySplitState,
  splitShare: number,
): PaneLayout<PaneTabInstance<string>> {
  assertLayoutId(layoutId);
  if (new Set(legacy.tabs.map((tab) => tab.id)).size !== legacy.tabs.length)
    throw new Error('Legacy tab ids must be unique.');
  const active = legacy.tabs.find((tab) => tab.id === legacy.active);
  if (!active) throw new Error('The legacy active tab must exist.');

  const usedIds = new Set(legacy.tabs.map((tab) => tab.id));
  const sideIds = new Map<string, string>();
  for (const tab of legacy.tabs) {
    if (tab.side) sideIds.set(tab.id, allocateSideId(tab.id, usedIds));
  }
  const tabs = legacy.tabs.flatMap((tab) => {
    const main = legacyTabInstance(tab.id, tab.id, tab);
    const sideId = sideIds.get(tab.id);
    return tab.side && sideId ? [main, legacyTabInstance(sideId, tab.id, tab.side)] : [main];
  });

  const activeSideId = sideIds.get(active.id);
  const root =
    active.side && activeSideId
      ? split(
          layoutId,
          'root',
          'columns',
          leaf(layoutId, 1, active.id),
          leaf(layoutId, 2, activeSideId),
          clampSplitRatio(splitShare),
        )
      : leaf(layoutId, 1, active.id);
  return {
    id: layoutId,
    root,
    focusedPaneId: paneId(layoutId, legacy.pane === 'side' && activeSideId ? 2 : 1),
    topologyRevision: 0,
    tabs,
  };
}

export function visiblePaneLeaves(layout: PaneLayout): readonly PaneLeaf[] {
  return walkLeaves(layout.root);
}

export function availablePaneTabs<TTab extends PaneTabInstance>(layout: PaneLayout<TTab>): readonly TTab[] {
  const assigned = new Set(
    walkLeaves(layout.root)
      .map((item) => item.tabId)
      .filter((tabId): tabId is string => tabId !== null),
  );
  return layout.tabs.filter((tab) => !assigned.has(tab.id));
}

export function focusPane<TTab extends PaneTabInstance>(
  layout: PaneLayout<TTab>,
  paneIdToFocus: string,
): PaneLayout<TTab> {
  return findLeaf(layout.root, paneIdToFocus) ? { ...layout, focusedPaneId: paneIdToFocus } : layout;
}

export function movePaneTab<TTab extends PaneTabInstance>(
  layout: PaneLayout<TTab>,
  tabId: string,
  targetPaneId: string,
): PaneLayout<TTab> {
  if (!layout.tabs.some((tab) => tab.id === tabId) || !findLeaf(layout.root, targetPaneId)) return layout;
  const currentTarget = findLeaf(layout.root, targetPaneId);
  if (currentTarget?.tabId === tabId) return focusPane(layout, targetPaneId);

  const root = (function move(node: PaneNode): PaneNode {
    if (node.kind === 'leaf') {
      if (node.id === targetPaneId) return { ...node, tabId };
      return node.tabId === tabId ? { ...node, tabId: null } : node;
    }
    const first = move(node.first);
    const second = move(node.second);
    return first === node.first && second === node.second ? node : { ...node, first, second };
  })(layout.root);
  return { ...layout, root, focusedPaneId: targetPaneId };
}

export function removePaneTabs<TTab extends PaneTabInstance>(
  layout: PaneLayout<TTab>,
  tabIdsToRemove: ReadonlySet<string>,
): PaneLayout<TTab> {
  if (tabIdsToRemove.size === 0 || !layout.tabs.some((tab) => tabIdsToRemove.has(tab.id))) return layout;
  const root = (function clearRemoved(node: PaneNode): PaneNode {
    if (node.kind === 'leaf')
      return node.tabId !== null && tabIdsToRemove.has(node.tabId) ? { ...node, tabId: null } : node;
    const first = clearRemoved(node.first);
    const second = clearRemoved(node.second);
    return first === node.first && second === node.second ? node : { ...node, first, second };
  })(layout.root);
  return {
    ...layout,
    root,
    tabs: layout.tabs.filter((tab) => !tabIdsToRemove.has(tab.id)),
  };
}

export function swapPaneTabs<TTab extends PaneTabInstance>(
  layout: PaneLayout<TTab>,
  firstPaneId: string,
  secondPaneId: string,
): PaneLayout<TTab> {
  const first = findLeaf(layout.root, firstPaneId);
  const second = findLeaf(layout.root, secondPaneId);
  if (!first || !second || first === second) return layout;
  const root = (function swap(node: PaneNode): PaneNode {
    if (node.kind === 'leaf') {
      if (node.id === firstPaneId) return { ...node, tabId: second.tabId };
      if (node.id === secondPaneId) return { ...node, tabId: first.tabId };
      return node;
    }
    const left = swap(node.first);
    const right = swap(node.second);
    return left === node.first && right === node.second ? node : { ...node, first: left, second: right };
  })(layout.root);
  return { ...layout, root };
}

export function closePane<TTab extends PaneTabInstance>(
  layout: PaneLayout<TTab>,
  paneIdToClose: string,
): PaneLayout<TTab> {
  const oldLeaves = walkLeaves(layout.root);
  const closingIndex = oldLeaves.findIndex((item) => item.id === paneIdToClose);
  if (closingIndex < 0) return layout;

  if (layout.root.kind === 'leaf') {
    return { ...layout, root: { ...layout.root, tabId: null }, focusedPaneId: layout.root.id };
  }

  const remove = (node: PaneNode): PaneNode | null => {
    if (node.kind === 'leaf') return node.id === paneIdToClose ? null : node;
    const first = remove(node.first);
    const second = remove(node.second);
    if (!first) return second;
    if (!second) return first;
    if (first === node.first && second === node.second) return node;
    return { ...node, first, second };
  };
  const root = remove(layout.root);
  if (!root) return layout;
  if (layout.focusedPaneId !== paneIdToClose)
    return { ...layout, root, topologyRevision: layout.topologyRevision + 1 };

  const remainingIds = new Set(walkLeaves(root).map((item) => item.id));
  const nextFocus = [
    ...oldLeaves.slice(closingIndex + 1),
    ...oldLeaves.slice(0, closingIndex).reverse(),
  ].find((item) => remainingIds.has(item.id));
  return {
    ...layout,
    root,
    focusedPaneId: nextFocus?.id ?? walkLeaves(root)[0]!.id,
    topologyRevision: layout.topologyRevision + 1,
  };
}

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_SPLIT_RATIO;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

export function beginPaneResize(layout: PaneLayout, targetSplitId: string): PaneResizeSession | null {
  const target = findSplit(layout.root, targetSplitId);
  return target
    ? {
        layoutId: layout.id,
        splitId: targetSplitId,
        topologyRevision: layout.topologyRevision,
        initialRatio: target.ratio,
      }
    : null;
}

function setSplitRatio<TTab extends PaneTabInstance>(
  layout: PaneLayout<TTab>,
  targetSplitId: string,
  ratio: number,
): PaneLayout<TTab> {
  if (!Number.isFinite(ratio)) return layout;
  const current = findSplit(layout.root, targetSplitId);
  if (!current) return layout;
  const nextRatio = clampSplitRatio(ratio);
  if (current.ratio === nextRatio) return layout;
  const root = updateNode(layout.root, targetSplitId, (node) =>
    node.kind === 'split' ? { ...node, ratio: nextRatio } : node,
  );
  return { ...layout, root };
}

export function previewPaneResize<TTab extends PaneTabInstance>(
  layout: PaneLayout<TTab>,
  session: PaneResizeSession,
  ratio: number,
): PaneLayout<TTab> {
  if (session.layoutId !== layout.id || session.topologyRevision !== layout.topologyRevision) return layout;
  return setSplitRatio(layout, session.splitId, ratio);
}

export function cancelPaneResize<TTab extends PaneTabInstance>(
  layout: PaneLayout<TTab>,
  session: PaneResizeSession,
): PaneLayout<TTab> {
  if (session.layoutId !== layout.id || session.topologyRevision !== layout.topologyRevision) return layout;
  return setSplitRatio(layout, session.splitId, session.initialRatio);
}

export function resetPaneSplit<TTab extends PaneTabInstance>(
  layout: PaneLayout<TTab>,
  targetSplitId: string,
): PaneLayout<TTab> {
  return setSplitRatio(layout, targetSplitId, DEFAULT_SPLIT_RATIO);
}

export function validatePaneLayout(layout: PaneLayout): readonly PaneLayoutIssue[] {
  const issues = new Set<PaneLayoutIssue>();
  if (!layout.id.trim()) issues.add('empty-layout-id');
  const nodeIds = new Set<string>();
  const leaves: PaneLeaf[] = [];
  const visit = (node: PaneNode | null | undefined): void => {
    if (!node || typeof node !== 'object') {
      issues.add('invalid-node');
      return;
    }
    if (!node.id || nodeIds.has(node.id)) issues.add('duplicate-node-id');
    nodeIds.add(node.id);
    if (node.kind === 'leaf') {
      leaves.push(node);
      return;
    }
    if (node.kind !== 'split') {
      issues.add('invalid-node');
      return;
    }
    if (node.axis !== 'columns' && node.axis !== 'rows') issues.add('invalid-split-axis');
    if (!Number.isFinite(node.ratio) || node.ratio < MIN_SPLIT_RATIO || node.ratio > MAX_SPLIT_RATIO) {
      issues.add('invalid-split-ratio');
    }
    if (!node.first || !node.second) {
      issues.add('split-missing-child');
      return;
    }
    visit(node.first);
    visit(node.second);
  };
  visit(layout.root);
  if (leaves.length > MAX_VISIBLE_PANES) issues.add('too-many-panes');

  const tabIds = new Set<string>();
  for (const tab of layout.tabs) {
    if (tabIds.has(tab.id)) issues.add('duplicate-tab-id');
    tabIds.add(tab.id);
  }
  const assigned = new Set<string>();
  for (const pane of leaves) {
    if (pane.tabId === null) continue;
    if (!tabIds.has(pane.tabId)) issues.add('unknown-tab-assignment');
    if (assigned.has(pane.tabId)) issues.add('duplicate-tab-assignment');
    assigned.add(pane.tabId);
  }
  if (!leaves.some((pane) => pane.id === layout.focusedPaneId)) issues.add('focused-pane-missing');
  return [...issues];
}
