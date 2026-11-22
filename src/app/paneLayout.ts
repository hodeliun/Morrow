// Read-only pane-tree model adapted from hodeliun/Morrow v1.3.0-fork.1.2.0
// (778c6b6ef7d30aad8678dbbbcb50fdcab6bc1106). Tree editing stays in later workspace work.
export const DEFAULT_SPLIT_RATIO = 0.5;
export const MIN_SPLIT_RATIO = 0.2;
export const MAX_SPLIT_RATIO = 0.8;
export const MAX_VISIBLE_PANES = 4;

export interface PaneTabInstance<TTarget = unknown> {
  readonly id: string;
  readonly groupId: string;
  readonly target: TTarget;
  readonly back: readonly TTarget[];
  readonly forward: readonly TTarget[];
  readonly pinned?: boolean;
}

export interface PaneLeaf {
  readonly kind: 'leaf';
  readonly id: string;
  readonly tabId: string | null;
}

export interface PaneSplit {
  readonly kind: 'split';
  readonly id: string;
  readonly axis: 'columns' | 'rows';
  readonly ratio: number;
  readonly first: PaneNode;
  readonly second: PaneNode;
}

export type PaneNode = PaneLeaf | PaneSplit;

export interface PaneLayout<TTab extends PaneTabInstance = PaneTabInstance> {
  readonly id: string;
  readonly root: PaneNode;
  readonly focusedPaneId: string;
  readonly topologyRevision: number;
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
  readonly pinned?: boolean;
}

export interface LegacySplitState {
  readonly tabs: readonly LegacySplitTab[];
  readonly active: string;
  readonly pane: 'main' | 'side';
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
  axis: PaneSplit['axis'],
  first: PaneNode,
  second: PaneNode,
  ratio: number,
): PaneSplit {
  return { kind: 'split', id: splitId(layoutId, 'root'), axis, ratio, first, second };
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

export function clampSplitRatio(ratio: number): number {
  return Number.isFinite(ratio)
    ? Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio))
    : DEFAULT_SPLIT_RATIO;
}

function walkLeaves(node: PaneNode): PaneLeaf[] {
  return node.kind === 'leaf' ? [node] : [...walkLeaves(node.first), ...walkLeaves(node.second)];
}

export function visiblePaneLeaves(layout: PaneLayout): readonly PaneLeaf[] {
  return walkLeaves(layout.root);
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
    if (!Number.isFinite(node.ratio) || node.ratio < MIN_SPLIT_RATIO || node.ratio > MAX_SPLIT_RATIO)
      issues.add('invalid-split-ratio');
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
    const main = { ...legacyTabInstance(tab.id, tab.id, tab), ...(tab.pinned ? { pinned: true } : {}) };
    const sideId = sideIds.get(tab.id);
    return tab.side && sideId ? [main, legacyTabInstance(sideId, tab.id, tab.side)] : [main];
  });

  const activeSideId = sideIds.get(active.id);
  const ratio = clampSplitRatio(splitShare);
  const root =
    active.side && activeSideId
      ? split(layoutId, 'columns', leaf(layoutId, 1, active.id), leaf(layoutId, 2, activeSideId), ratio)
      : leaf(layoutId, 1, active.id);
  return {
    id: layoutId,
    root,
    focusedPaneId: paneId(layoutId, legacy.pane === 'side' && activeSideId ? 2 : 1),
    topologyRevision: 0,
    tabs,
  };
}
