// tabs remember a place each, like a browser: the open tab follows wherever you go.
// a tab can be split in two, each side with its own back and forward history
import { createContext, useContext, useSyncExternalStore } from 'react';
import {
  allocateSideInstanceId,
  applyPanePresetPreservingAssignments,
  DEFAULT_SPLIT_RATIO,
  isSideInstanceIdFor,
  migrateLegacySplit,
  visiblePaneLeaves,
} from './paneLayout';
import type { PaneLayout, PaneLeaf, PaneNode, PanePreset, PaneTabInstance } from './paneLayout';
import {
  PANE_TABS_STORAGE_KEY,
  persistPaneTabsSnapshot,
  persistPaneTabsSnapshotAfterLegacyEquivalence,
  readPaneTabsSnapshot,
  writePaneTabsSnapshot,
} from './paneLayoutStorage';
import type { CurrentTabsSnapshot, LegacyTabsSnapshot } from './paneLayoutStorage';
import { getPreferences } from './platform/preferences';

export type PaneId = string;
export type PaneRole = 'main' | 'side' | 'third' | 'fourth';

export interface PaneHistory {
  hash: string;
  back: string[];
  forward: string[];
}

export interface Tab extends PaneHistory {
  id: string;
  // the second page shown beside the first, null when the tab is not split
  side: PaneHistory | null;
  // a pinned tab sits at the start, shows only its icon and is never closed by accident
  pinned?: boolean;
}

interface TabState {
  tabs: Tab[];
  active: string;
  // the side of a split tab that navigation goes to, the one last clicked or typed in
  pane: PaneRole;
  // recently closed tabs, newest last, so they can be opened again
  closed: string[];
  // The pane layout is the sole runtime source for tab instances, visible leaves, and focus.
  layout: PaneLayout<PaneTabInstance<string>>;
  // Runtime orientation is keyed by the persisted tab ids; it is never written as a new snapshot field.
  physicalOrderByGroup: ReadonlyMap<string, readonly [string, string]>;
  // A >20-instance fork snapshot keeps an ordinary, bounded temporary tab strip in memory.
  projectionIds: readonly string[] | null;
  // Fork layouts keep their canonical instance order while the in-memory tab strip can evolve.
  projectionOrder: readonly string[] | null;
  // Legacy tabs use one dynamic two-pane tree; fork snapshots retain their own full tree.
  projectionKind: 'legacy-two-pane' | 'fork-layout';
  // Fork v2, malformed and future snapshots stay byte-exact until a lossless writer is available.
  persistenceWritable: boolean;
  // A user-selected preset owns its leaf assignments; it is not the legacy two-pane projection.
  explicitLayout: boolean;
  // Raw value observed during load or the last successful write; prevents overwriting another window.
  observedStorageRaw: string | null;
  // The parsed v0 baseline, reconstructed through the same projection used by the v2 writer.
  legacyMigrationBaseline: LegacyTabsSnapshot | null;
  // Full v2 bytes for the same reconstructed v0 baseline, excluding startup route overlays.
  legacyMigrationBaselineV2Raw: string | null;
  // Startup routing is an in-memory overlay until the user navigates that instance themselves.
  transientLaunchRoute: TransientLaunchRoute | null;
  // A launch route may temporarily put an unassigned instance in an empty persisted pane.
  transientLaunchAssignment: TransientLaunchAssignment | null;
}

const MAX_TABS = 20;
const MAX_HISTORY = 50;
const MAX_CLOSED = 10;
const LAYOUT_ID = 'morrow-pane-layout';
const listeners = new Set<() => void>();
let counter = 0;
let urlAnchorPaneId: PaneId | null = null;
let startupNavigationCancelled = false;
let startupNavigationSuppressionDepth = 0;
let activeTabsLifecycles = 0;
const newTabId = () => `t${Date.now().toString(36)}${(counter++).toString(36)}`;

type PaneLayoutState = PaneLayout<PaneTabInstance<string>>;

interface PanePair {
  readonly main: PaneTabInstance<string>;
  readonly side: PaneTabInstance<string>;
}

interface TransientLaunchRoute {
  readonly tabId: string;
  readonly original: PaneTabInstance<string>;
}

interface TransientLaunchAssignment {
  readonly paneId: PaneId;
  readonly tabId: string;
  readonly created: boolean;
}

function pairInPhysicalOrder(
  layout: PaneLayoutState,
  pair: PanePair,
  physicalOrderByGroup?: ReadonlyMap<string, readonly [string, string]>,
): readonly [PaneTabInstance<string>, PaneTabInstance<string>] {
  const order = physicalOrderByGroup?.get(pair.main.id);
  const first = order?.[0] === pair.main.id ? pair.main : order?.[0] === pair.side.id ? pair.side : null;
  const second = order?.[1] === pair.main.id ? pair.main : order?.[1] === pair.side.id ? pair.side : null;
  if (first && second && first.id !== second.id) return [first, second];

  const ids = new Set([pair.main.id, pair.side.id]);
  const visible = visiblePaneLeaves(layout).flatMap((leaf) =>
    leaf.tabId && ids.has(leaf.tabId) ? [layout.tabs.find((tab) => tab.id === leaf.tabId)!] : [],
  );
  return visible.length === 2 ? [visible[0]!, visible[1]!] : [pair.main, pair.side];
}

function normalizePhysicalOrderByGroup(
  layout: PaneLayoutState,
  physicalOrderByGroup?: ReadonlyMap<string, readonly [string, string]>,
): ReadonlyMap<string, readonly [string, string]> {
  const normalized = new Map<string, readonly [string, string]>();
  for (const instance of layout.tabs) {
    const pair = pairForInstance(layout.tabs, instance);
    if (!pair || normalized.has(pair.main.id)) continue;
    const [first, second] = pairInPhysicalOrder(layout, pair, physicalOrderByGroup);
    normalized.set(pair.main.id, [first.id, second.id]);
  }
  return normalized;
}

function pairForInstance(
  tabs: readonly PaneTabInstance<string>[],
  instance: PaneTabInstance<string>,
): PanePair | null {
  // Only the 2.2 split encoding is a pair: its main id is the group id and its side id is
  // the generated `main:side` form. Other same-group instances remain independent tabs.
  const group = tabs.filter((tab) => tab.groupId === instance.groupId);
  const main = group.find((tab) => tab.id === instance.groupId);
  if (!main) return null;
  const sides = group.filter((tab) => isSideInstanceIdFor(main.id, tab.id));
  if (sides.length !== 1 || (instance.id !== main.id && instance.id !== sides[0]!.id)) return null;
  return { main, side: sides[0]! };
}

function projectionIdentity(
  layout: PaneLayoutState,
  instance: PaneTabInstance<string>,
): { readonly id: string; readonly pane: PaneId } {
  const pair = pairForInstance(layout.tabs, instance);
  if (pair && instance.id === pair.side.id) return { id: pair.main.id, pane: 'side' };
  if (pair && instance.id === pair.main.id) return { id: pair.main.id, pane: 'main' };
  return { id: instance.id, pane: 'main' };
}

function compatibilityTab(
  pair: PanePair,
  layout: PaneLayoutState,
  physicalOrderByGroup: ReadonlyMap<string, readonly [string, string]>,
): Tab {
  const [main, side] = pairInPhysicalOrder(layout, pair, physicalOrderByGroup);
  return {
    id: pair.main.id,
    hash: main.target,
    back: [...main.back],
    forward: [...main.forward],
    side: { hash: side.target, back: [...side.back], forward: [...side.forward] },
    ...(pair.main.pinned || pair.side.pinned ? { pinned: true } : {}),
  };
}

function projectTabs(
  layout: PaneLayoutState,
  projectionIds: readonly string[] | null = null,
  physicalOrderByGroup: ReadonlyMap<string, readonly [string, string]> = normalizePhysicalOrderByGroup(
    layout,
  ),
): Tab[] {
  const projected: Tab[] = [];
  const consumed = new Set<string>();
  for (const instance of layout.tabs) {
    if (consumed.has(instance.id)) continue;
    const pair = pairForInstance(layout.tabs, instance);
    if (pair) {
      projected.push(compatibilityTab(pair, layout, physicalOrderByGroup));
      consumed.add(pair.main.id);
      consumed.add(pair.side.id);
      continue;
    }
    projected.push({
      id: instance.id,
      hash: instance.target,
      back: [...instance.back],
      forward: [...instance.forward],
      side: null,
      ...(instance.pinned ? { pinned: true } : {}),
    });
    consumed.add(instance.id);
  }
  if (projectionIds === null) return projected;
  const byId = new Map(projected.map((tab) => [tab.id, tab]));
  return projectionIds.flatMap((id) => {
    const tab = byId.get(id);
    return tab ? [tab] : [];
  });
}

function focusedInstance(layout: PaneLayoutState): PaneTabInstance<string> | null {
  const leaf = visiblePaneLeaves(layout).find((item) => item.id === layout.focusedPaneId);
  return leaf?.tabId ? (layout.tabs.find((tab) => tab.id === leaf.tabId) ?? null) : null;
}

function selectedPaneLeaves(layout: PaneLayoutState): PaneLeaf[] {
  const focused = focusedInstance(layout) ?? layout.tabs.find((tab) => tab.id === current().active) ?? null;
  if (!focused) return [];
  const pair = pairForInstance(layout.tabs, focused);
  const ids = new Set(pair ? [pair.main.id, pair.side.id] : [focused.id]);
  // Tree order is physical pane order. Swapping assignments must move the same editor host to the
  // opposite surface while the first surface remains the address-bar anchor.
  return visiblePaneLeaves(layout).filter((leaf) => leaf.tabId !== null && ids.has(leaf.tabId));
}

function paneForTabGroup(tabId: string, layout: PaneLayoutState): PaneId | null {
  const instance = layout.tabs.find((tab) => tab.id === tabId);
  if (!instance) return null;
  const pair = pairForInstance(layout.tabs, instance);
  const ids = new Set(pair ? [pair.main.id, pair.side.id] : [instance.id]);
  return visiblePaneLeaves(layout).find((leaf) => leaf.tabId !== null && ids.has(leaf.tabId))?.id ?? null;
}

interface PaneBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function adjacentPaneId(layout: PaneLayoutState, sourcePaneId: PaneId): PaneId | null {
  const leaves = visiblePaneLeaves(layout);
  if (leaves.length < 2) return null;
  const bounds = new Map<PaneId, PaneBounds>();
  const collect = (node: PaneNode, rect: PaneBounds): void => {
    if (node.kind === 'leaf') {
      bounds.set(node.id, rect);
      return;
    }
    if (node.axis === 'columns') {
      const firstWidth = rect.width * node.ratio;
      collect(node.first, { ...rect, width: firstWidth });
      collect(node.second, {
        ...rect,
        x: rect.x + firstWidth,
        width: rect.width - firstWidth,
      });
      return;
    }
    const firstHeight = rect.height * node.ratio;
    collect(node.first, { ...rect, height: firstHeight });
    collect(node.second, {
      ...rect,
      y: rect.y + firstHeight,
      height: rect.height - firstHeight,
    });
  };
  collect(layout.root, { x: 0, y: 0, width: 1, height: 1 });
  const source = bounds.get(sourcePaneId);
  if (!source) return null;
  const sourceCenterY = source.y + source.height / 2;
  const overlapsVertically = (candidate: PaneBounds) =>
    Math.min(source.y + source.height, candidate.y + candidate.height) - Math.max(source.y, candidate.y) > 1e-8;
  const right: PaneId[] = [];
  const left: PaneId[] = [];
  for (const leaf of leaves) {
    if (leaf.id === sourcePaneId) continue;
    const candidate = bounds.get(leaf.id)!;
    if (overlapsVertically(candidate) && Math.abs(source.x + source.width - candidate.x) < 1e-8)
      right.push(leaf.id);
    if (overlapsVertically(candidate) && Math.abs(candidate.x + candidate.width - source.x) < 1e-8)
      left.push(leaf.id);
  }
  const candidates = right.length ? right : left;
  if (candidates.length) {
    return candidates.sort((first, second) => {
      const firstY = bounds.get(first)!.y + bounds.get(first)!.height / 2;
      const secondY = bounds.get(second)!.y + bounds.get(second)!.height / 2;
      return Math.abs(firstY - sourceCenterY) - Math.abs(secondY - sourceCenterY);
    })[0]!;
  }
  return leaves
    .filter((leaf) => leaf.id !== sourcePaneId)
    .sort((first, second) => {
      const firstBounds = bounds.get(first.id)!;
      const secondBounds = bounds.get(second.id)!;
      const firstDistance =
        Math.abs(firstBounds.x + firstBounds.width / 2 - (source.x + source.width / 2)) +
        Math.abs(firstBounds.y + firstBounds.height / 2 - sourceCenterY);
      const secondDistance =
        Math.abs(secondBounds.x + secondBounds.width / 2 - (source.x + source.width / 2)) +
        Math.abs(secondBounds.y + secondBounds.height / 2 - sourceCenterY);
      return firstDistance - secondDistance;
    })[0]?.id ?? null;
}

function resolvePaneId(pane: PaneId, layout = current().layout): PaneId | null {
  const leaves = visiblePaneLeaves(layout);
  if (leaves.some((leaf) => leaf.id === pane)) return pane;
  const selected = selectedPaneLeaves(layout);
  if (pane === 'main') return selected[0]?.id ?? leaves[0]?.id ?? null;
  if (pane === 'side') return selected[1]?.id ?? leaves[1]?.id ?? null;
  if (pane === 'third') return leaves[2]?.id ?? null;
  if (pane === 'fourth') return leaves[3]?.id ?? null;
  return null;
}

function primaryPaneId(layout = current().layout): PaneId | null {
  // A v2 snapshot keeps the selected pair's launch target as the URL anchor until the user
  // explicitly chooses a preset. Presets then return URL ownership to the first physical leaf.
  const leaves = visiblePaneLeaves(layout);
  return leaves.find((leaf) => leaf.id === urlAnchorPaneId)?.id ?? leaves[0]?.id ?? null;
}

function assignedTabForPane(pane: PaneId, layout = current().layout): PaneTabInstance<string> | null {
  const paneId = resolvePaneId(pane, layout);
  if (!paneId) return null;
  const leaf = visiblePaneLeaves(layout).find((item) => item.id === paneId);
  return leaf?.tabId ? (layout.tabs.find((tab) => tab.id === leaf.tabId) ?? null) : null;
}

function stateFromLayout(
  layout: PaneLayoutState,
  closed: readonly string[],
  persistenceWritable: boolean,
  observedStorageRaw: string | null,
  previousActive = '',
  projectionIds: readonly string[] | null = null,
  projectionKind: TabState['projectionKind'] = 'legacy-two-pane',
  projectionOrder?: readonly string[] | null,
  physicalOrderByGroup?: ReadonlyMap<string, readonly [string, string]>,
  explicitLayout = projectionKind === 'fork-layout',
  legacyMigrationBaseline: LegacyTabsSnapshot | null = null,
  legacyMigrationBaselineV2Raw: string | null = null,
  transientLaunchRoute: TransientLaunchRoute | null = null,
  transientLaunchAssignment: TransientLaunchAssignment | null = null,
): TabState {
  const normalizedPhysicalOrder = normalizePhysicalOrderByGroup(layout, physicalOrderByGroup);
  const focused = focusedInstance(layout);
  const focusedProjection = focused ? projectionIdentity(layout, focused) : null;
  const defaultOrder =
    projectionKind === 'fork-layout'
      ? projectTabs(layout, null, normalizedPhysicalOrder).map((tab) => tab.id)
      : null;
  const effectiveProjectionOrder = projectionOrder === undefined ? defaultOrder : projectionOrder;
  const allTabs = effectiveProjectionOrder
    ? projectTabs(layout, effectiveProjectionOrder, normalizedPhysicalOrder)
    : projectTabs(layout, null, normalizedPhysicalOrder);
  const fallbackActive =
    focusedProjection?.id ??
    (allTabs.some((tab) => tab.id === previousActive) ? previousActive : (allTabs[0]?.id ?? ''));
  const visibleProjectionIds = projectionIds ?? (allTabs.length > MAX_TABS ? [fallbackActive] : null);
  const tabs =
    visibleProjectionIds === null
      ? allTabs
      : projectTabs(layout, visibleProjectionIds, normalizedPhysicalOrder);
  const active =
    focusedProjection && tabs.some((tab) => tab.id === focusedProjection.id)
      ? focusedProjection.id
      : tabs.some((tab) => tab.id === previousActive)
        ? previousActive
        : (tabs[0]?.id ?? '');
  const activeTab = tabs.find((tab) => tab.id === active);
  const selectedLeaves = focusedProjection ? selectedPaneLeaves(layout) : [];
  const focusedPosition = selectedLeaves.findIndex((leaf) => leaf.id === layout.focusedPaneId);
  const pane = focusedPosition === 1 && activeTab?.side ? 'side' : 'main';
  return {
    tabs,
    active,
    pane,
    layout,
    physicalOrderByGroup: normalizedPhysicalOrder,
    projectionIds: visibleProjectionIds,
    projectionOrder: effectiveProjectionOrder,
    projectionKind,
    explicitLayout,
    closed: [...closed].slice(-MAX_CLOSED),
    persistenceWritable,
    observedStorageRaw,
    legacyMigrationBaseline,
    legacyMigrationBaselineV2Raw,
    transientLaunchRoute,
    transientLaunchAssignment,
  };
}

function replaceLeafAssignments(node: PaneNode, updates: ReadonlyMap<string, string | null>): PaneNode {
  if (node.kind === 'leaf') {
    if (!updates.has(node.id)) return node;
    const tabId = updates.get(node.id) ?? null;
    return tabId === node.tabId ? node : { ...node, tabId };
  }
  const first = replaceLeafAssignments(node.first, updates);
  const second = replaceLeafAssignments(node.second, updates);
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

function clearMissingAssignments(layout: PaneLayoutState): PaneLayoutState {
  const ids = new Set(layout.tabs.map((tab) => tab.id));
  const clear = (node: PaneNode): PaneNode => {
    if (node.kind === 'leaf') return node.tabId && !ids.has(node.tabId) ? { ...node, tabId: null } : node;
    const first = clear(node.first);
    const second = clear(node.second);
    return first === node.first && second === node.second ? node : { ...node, first, second };
  };
  const root = clear(layout.root);
  return root === layout.root ? layout : { ...layout, root };
}

function uniqueTreeId(layout: PaneLayoutState, preferred: string): string {
  const ids = new Set<string>();
  const collect = (node: PaneNode): void => {
    ids.add(node.id);
    if (node.kind === 'split') {
      collect(node.first);
      collect(node.second);
    }
  };
  collect(layout.root);
  let candidate = preferred;
  let suffix = 2;
  while (ids.has(candidate)) candidate = `${preferred}:${suffix++}`;
  return candidate;
}

function splitSinglePane(
  layout: PaneLayoutState,
  mainLeaf: PaneLeaf,
  mainTabId: string,
  sideTabId: string,
): PaneLayoutState {
  if (layout.root.kind !== 'leaf') return layout;
  const first = mainLeaf.tabId === mainTabId ? mainLeaf : { ...mainLeaf, tabId: mainTabId };
  const second = {
    kind: 'leaf' as const,
    id: uniqueTreeId(layout, `${layout.id}:pane:side`),
    tabId: sideTabId,
  };
  return {
    ...layout,
    root: {
      kind: 'split',
      id: uniqueTreeId(layout, `${layout.id}:split:runtime`),
      axis: 'columns',
      ratio: DEFAULT_SPLIT_RATIO,
      first,
      second,
    },
    topologyRevision: layout.topologyRevision + 1,
  };
}

function layoutForProjection(
  layout: PaneLayoutState,
  activeId: string,
  requestedPane: PaneId,
  projectionKind: TabState['projectionKind'],
  physicalOrderByGroup: ReadonlyMap<string, readonly [string, string]>,
): PaneLayoutState {
  const exact = layout.tabs.find((tab) => tab.id === activeId);
  if (!exact) return layout;
  const pair = pairForInstance(layout.tabs, exact);
  const [first, second] = pair ? pairInPhysicalOrder(layout, pair, physicalOrderByGroup) : [exact, null];
  let next = clearMissingAssignments(layout);
  let leaves = visiblePaneLeaves(next);
  let firstLeaf = leaves.find((leaf) => leaf.tabId === first.id) ?? leaves[0];
  if (!firstLeaf) return next;
  let secondLeaf = second
    ? leaves.find((leaf) => leaf.tabId === second.id && leaf.id !== firstLeaf!.id)
    : undefined;

  if (second && !secondLeaf && leaves.length === 1) {
    next = splitSinglePane(next, firstLeaf, first.id, second.id);
    leaves = visiblePaneLeaves(next);
    const splitFirstLeaf = leaves.find((leaf) => leaf.tabId === first.id) ?? leaves[0];
    if (!splitFirstLeaf) return next;
    firstLeaf = splitFirstLeaf;
    secondLeaf = leaves.find((leaf) => leaf.id !== splitFirstLeaf.id && leaf.tabId === second.id);
  }
  if (second && !secondLeaf) {
    secondLeaf =
      leaves.find((leaf) => leaf.id !== firstLeaf!.id && leaf.tabId === null) ??
      leaves.find((leaf) => leaf.id !== firstLeaf!.id);
  }

  const pairIds = new Set(second ? [first.id, second.id] : [first.id]);
  const updates = new Map<string, string | null>();
  for (const leaf of leaves) {
    if (
      (leaf.tabId !== null &&
        pairIds.has(leaf.tabId) &&
        leaf.id !== firstLeaf.id &&
        leaf.id !== secondLeaf?.id) ||
      // In the legacy runtime, a lone tab has no visible side; keep its former side instance
      // in layout.tabs but detach it from the two-pane projection so it can return later.
      (!second && projectionKind === 'legacy-two-pane' && leaf.id !== firstLeaf.id && leaf.tabId !== null)
    ) {
      updates.set(leaf.id, null);
    }
  }
  updates.set(firstLeaf.id, first.id);
  if (second && secondLeaf) updates.set(secondLeaf.id, second.id);
  const root = replaceLeafAssignments(next.root, updates);
  const projected = { ...next, root };
  const physicalLeaves = visiblePaneLeaves(projected).filter(
    (leaf) => leaf.tabId !== null && pairIds.has(leaf.tabId),
  );
  const focusPane =
    requestedPane === 'side' && physicalLeaves[1]
      ? physicalLeaves[1].id
      : (physicalLeaves[0]?.id ?? firstLeaf.id);
  return {
    ...projected,
    focusedPaneId: focusPane,
  };
}

function applyLaunchHash(
  layout: PaneLayoutState,
  activeId: string,
  hash: string,
): {
  readonly layout: PaneLayoutState;
  readonly anchorPaneId: PaneId | null;
  readonly transientLaunchRoute: TransientLaunchRoute | null;
  readonly transientLaunchAssignment: TransientLaunchAssignment | null;
} {
  const exact = layout.tabs.find((tab) => tab.id === activeId);
  const pair = exact ? pairForInstance(layout.tabs, exact) : null;
  const pairIds = pair ? new Set([pair.main.id, pair.side.id]) : new Set(exact ? [exact.id] : []);
  let anchorLeaf = visiblePaneLeaves(layout).find(
    (leaf) => leaf.tabId !== null && pairIds.has(leaf.tabId),
  );
  const target = layout.tabs.find((tab) => tab.id === anchorLeaf?.tabId) ?? pair?.main ?? exact;
  if (!target) {
    const focusedLeaf = visiblePaneLeaves(layout).find((leaf) => leaf.id === layout.focusedPaneId);
    if (!focusedLeaf || focusedLeaf.tabId !== null)
      return {
        layout,
        anchorPaneId: null,
        transientLaunchRoute: null,
        transientLaunchAssignment: null,
      };
    const id = newTabId();
    const created: PaneTabInstance<string> = { id, groupId: id, target: hash, back: [], forward: [] };
    const next = {
      ...layout,
      tabs: [...layout.tabs, created],
      root: replaceLeafAssignments(layout.root, new Map([[focusedLeaf.id, id]])),
    };
    return {
      layout: next,
      anchorPaneId: focusedLeaf.id,
      transientLaunchRoute: null,
      transientLaunchAssignment: {
        paneId: focusedLeaf.id,
        tabId: id,
        created: true,
      },
    };
  }
  let transientLaunchAssignment: TransientLaunchAssignment | null = null;
  if (!anchorLeaf) {
    const focusedLeaf = visiblePaneLeaves(layout).find((leaf) => leaf.id === layout.focusedPaneId);
    if (focusedLeaf?.tabId === null) {
      anchorLeaf = focusedLeaf;
      layout = {
        ...layout,
        root: replaceLeafAssignments(layout.root, new Map([[focusedLeaf.id, target.id]])),
      };
      transientLaunchAssignment = {
        paneId: focusedLeaf.id,
        tabId: target.id,
        created: false,
      };
    } else {
      anchorLeaf = visiblePaneLeaves(layout).find((leaf) => leaf.tabId === target!.id);
    }
  }
  if (target.target === hash)
    return {
      layout,
      anchorPaneId: anchorLeaf?.id ?? null,
      transientLaunchRoute: null,
      transientLaunchAssignment,
    };
  const updated = {
    ...target,
    target: hash,
    back: [...target.back, target.target].slice(-MAX_HISTORY),
  };
  return {
    layout: { ...layout, tabs: layout.tabs.map((tab) => (tab.id === target.id ? updated : tab)) },
    anchorPaneId: anchorLeaf?.id ?? null,
    transientLaunchRoute: { tabId: target.id, original: target },
    transientLaunchAssignment,
  };
}

function initialState(
  hash: string,
  persistenceWritable: boolean,
  observedStorageRaw: string | null,
): TabState {
  urlAnchorPaneId = null;
  const id = newTabId();
  const layout = migrateLegacySplit(
    LAYOUT_ID,
    { tabs: [{ id, hash, back: [], forward: [], side: null }], active: id, pane: 'main' },
    DEFAULT_SPLIT_RATIO,
  );
  return stateFromLayout(layout, [], persistenceWritable, observedStorageRaw, id, null, 'legacy-two-pane');
}

function fromLegacySnapshot(snapshot: LegacyTabsSnapshot, hash: string, raw: string): TabState {
  const layout = migrateLegacySplit(LAYOUT_ID, snapshot, getPreferences().splitShare);
  const baselineState = stateFromLayout(
    layout,
    snapshot.closed,
    true,
    raw,
    snapshot.active,
    null,
    'legacy-two-pane',
  );
  const projectedBaseline = legacyPersistenceView(baselineState);
  const legacyMigrationBaseline: LegacyTabsSnapshot = {
    tabs: projectedBaseline.tabs,
    active: projectedBaseline.active,
    pane: projectedBaseline.pane === 'side' ? 'side' : 'main',
    closed: projectedBaseline.closed,
  };
  let legacyMigrationBaselineV2Raw: string | null = null;
  try {
    legacyMigrationBaselineV2Raw = writePaneTabsSnapshot(layout, snapshot.closed);
  } catch {
    // If the parsed v0 state cannot be emitted as valid v2, leave that source protected.
  }
  const started = applyLaunchHash(layout, snapshot.active, hash);
  urlAnchorPaneId = null;
  return stateFromLayout(
    started.layout,
    snapshot.closed,
    legacyMigrationBaselineV2Raw !== null,
    raw,
    snapshot.active,
    null,
    'legacy-two-pane',
    undefined,
    undefined,
    false,
    legacyMigrationBaseline,
    legacyMigrationBaselineV2Raw,
    started.transientLaunchRoute,
    started.transientLaunchAssignment,
  );
}

function fromCurrentSnapshot(snapshot: CurrentTabsSnapshot, hash: string, raw: string): TabState {
  const focusLeaf = visiblePaneLeaves(snapshot.layout).find(
    (leaf) => leaf.id === snapshot.layout.focusedPaneId,
  );
  const focusInstance = focusLeaf?.tabId
    ? (snapshot.layout.tabs.find((tab) => tab.id === focusLeaf.tabId) ?? null)
    : null;
  const first = focusInstance ?? snapshot.layout.tabs[0];
  if (!first) return initialState(hash, false, raw);
  const identity = projectionIdentity(snapshot.layout, first);
  const physicalOrderByGroup = normalizePhysicalOrderByGroup(snapshot.layout);
  const launched = applyLaunchHash(snapshot.layout, identity.id, hash);
  urlAnchorPaneId = launched.anchorPaneId;
  return stateFromLayout(
    launched.layout,
    snapshot.closed,
    true,
    raw,
    identity.id,
    null,
    'fork-layout',
    undefined,
    physicalOrderByGroup,
    false,
    null,
    null,
    launched.transientLaunchRoute,
    launched.transientLaunchAssignment,
  );
}

function load(): TabState {
  const hash = window.location.hash || '#/';
  let raw: string | null;
  try {
    raw = localStorage.getItem(PANE_TABS_STORAGE_KEY);
  } catch {
    return initialState(hash, false, null);
  }

  const snapshot = readPaneTabsSnapshot(raw);
  if (snapshot.kind === 'empty') return initialState(hash, true, null);
  if (snapshot.kind === 'legacy') return fromLegacySnapshot(snapshot.snapshot, hash, raw!);
  if (snapshot.kind === 'current') return fromCurrentSnapshot(snapshot.snapshot, hash, raw!);

  // Invalid and future snapshots stay byte-exact while this window navigates in memory.
  return initialState(hash, false, raw);
}

let state: TabState | null = null;
const current = (): TabState => (state ??= load());
const suspendedPaneTabs = new Map<string, string[]>();

function applyPresetWithSuspendedTabs(
  layout: PaneLayoutState,
  preset: PanePreset,
): PaneLayoutState {
  const next = applyPanePresetPreservingAssignments(layout, preset);
  if (next === layout) return next;
  const previousLeaves = visiblePaneLeaves(layout);
  const nextLeaves = visiblePaneLeaves(next);
  const registered = new Set(next.tabs.map((tab) => tab.id));
  const suspended = (suspendedPaneTabs.get(layout.id) ?? []).filter((tabId) => registered.has(tabId));
  const assigned = new Set(nextLeaves.flatMap((leaf) => (leaf.tabId ? [leaf.tabId] : [])));
  previousLeaves.forEach((leaf) => {
    if (leaf.tabId && registered.has(leaf.tabId) && !assigned.has(leaf.tabId) && !suspended.includes(leaf.tabId)) {
      suspended.push(leaf.tabId);
    }
  });

  const updates = new Map<string, string | null>();
  for (const leaf of nextLeaves) {
    if (leaf.tabId) continue;
    let tabId: string | undefined;
    while (suspended.length > 0 && !tabId) {
      const candidate = suspended.shift()!;
      if (registered.has(candidate) && !assigned.has(candidate)) tabId = candidate;
    }
    if (!tabId) continue;
    updates.set(leaf.id, tabId);
    assigned.add(tabId);
  }
  if (suspended.length > 0) suspendedPaneTabs.set(layout.id, suspended);
  else suspendedPaneTabs.delete(layout.id);
  return updates.size === 0 ? next : { ...next, root: replaceLeafAssignments(next.root, updates) };
}

function instanceWithTabView(
  instance: PaneTabInstance<string>,
  tab: Tab,
  pinned: boolean,
): PaneTabInstance<string> {
  const sameHistory = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length && left.every((item, index) => item === right[index]);
  const samePin = pinned ? instance.pinned === true : !instance.pinned;
  if (
    instance.target === tab.hash &&
    sameHistory(instance.back, tab.back) &&
    sameHistory(instance.forward, tab.forward) &&
    samePin
  )
    return instance;

  const { pinned: _previousPin, ...rest } = instance;
  return {
    ...rest,
    target: tab.hash,
    back: [...tab.back],
    forward: [...tab.forward],
    ...(pinned ? { pinned: true } : {}),
  };
}

function nextSideId(mainId: string, tabs: readonly PaneTabInstance<string>[]): string {
  return allocateSideInstanceId(mainId, new Set(tabs.map((tab) => tab.id)));
}

function legacyPersistenceView(now: TabState): {
  readonly tabs: readonly Tab[];
  readonly active: string;
  readonly pane: PaneRole;
  readonly closed: readonly string[];
} {
  const tabs = now.tabs.map((tab) => {
    const instance = now.layout.tabs.find((candidate) => candidate.id === tab.id);
    const pair = instance ? pairForInstance(now.layout.tabs, instance) : null;
    if (!pair) return tab;
    const [main, side] = pairInPhysicalOrder(now.layout, pair, now.physicalOrderByGroup);
    return {
      ...tab,
      hash: main.target,
      back: [...main.back],
      forward: [...main.forward],
      side: { hash: side.target, back: [...side.back], forward: [...side.forward] },
    };
  });
  const focusedPair = now.tabs.find((tab) => tab.id === now.active);
  const focusedPairInstance = focusedPair
    ? now.layout.tabs.find((tab) => tab.id === focusedPair.id)
    : undefined;
  const pair = focusedPairInstance ? pairForInstance(now.layout.tabs, focusedPairInstance) : null;
  const pairIds = pair ? new Set([pair.main.id, pair.side.id]) : null;
  const focusedPosition = pairIds
    ? visiblePaneLeaves(now.layout)
        .filter((leaf) => leaf.tabId !== null && pairIds.has(leaf.tabId))
        .findIndex((leaf) => leaf.id === now.layout.focusedPaneId)
    : -1;
  return {
    tabs,
    active: now.active,
    pane: focusedPosition === 1 ? 'side' : 'main',
    closed: now.closed,
  };
}

function sameTransientRoute(
  left: PaneTabInstance<string> | undefined,
  right: PaneTabInstance<string> | undefined,
): boolean {
  return Boolean(
    left &&
      right &&
      left.id === right.id &&
      left.target === right.target &&
      left.back.length === right.back.length &&
      left.back.every((item, index) => item === right.back[index]) &&
      left.forward.length === right.forward.length &&
      left.forward.every((item, index) => item === right.forward[index]),
  );
}

function layoutWithoutTransientLaunchRoute(layout: PaneLayoutState, route: TransientLaunchRoute | null) {
  if (!route) return layout;
  const exists = layout.tabs.some((tab) => tab.id === route.tabId);
  if (!exists) return layout;
  return {
    ...layout,
    tabs: layout.tabs.map((tab) =>
      tab.id === route.tabId
        ? {
            ...tab,
            target: route.original.target,
            back: [...route.original.back],
            forward: [...route.original.forward],
          }
        : tab,
    ),
  };
}

function sameTransientLaunchAssignment(
  previous: PaneLayoutState,
  next: PaneLayoutState,
  assignment: TransientLaunchAssignment,
): boolean {
  const previousLeaf = visiblePaneLeaves(previous).find((leaf) => leaf.id === assignment.paneId);
  const nextLeaf = visiblePaneLeaves(next).find((leaf) => leaf.id === assignment.paneId);
  if (previousLeaf?.tabId !== assignment.tabId || nextLeaf?.tabId !== assignment.tabId) return false;
  const previousInstance = previous.tabs.find((tab) => tab.id === assignment.tabId);
  const nextInstance = next.tabs.find((tab) => tab.id === assignment.tabId);
  return Boolean(
    previousInstance &&
      nextInstance &&
      previousInstance.groupId === nextInstance.groupId &&
      previousInstance.pinned === nextInstance.pinned &&
      sameTransientRoute(previousInstance, nextInstance),
  );
}

function layoutWithoutTransientLaunchAssignment(
  layout: PaneLayoutState,
  assignment: TransientLaunchAssignment | null,
): PaneLayoutState {
  if (!assignment) return layout;
  const leaf = visiblePaneLeaves(layout).find((item) => item.id === assignment.paneId);
  if (leaf?.tabId !== assignment.tabId) return layout;
  return {
    ...layout,
    root: replaceLeafAssignments(layout.root, new Map([[assignment.paneId, null]])),
    tabs: assignment.created
      ? layout.tabs.filter((tab) => tab.id !== assignment.tabId)
      : layout.tabs,
  };
}

function layoutForPersistence(
  layout: PaneLayoutState,
  route: TransientLaunchRoute | null,
  assignment: TransientLaunchAssignment | null,
): PaneLayoutState {
  return layoutWithoutTransientLaunchAssignment(
    layoutWithoutTransientLaunchRoute(layout, route),
    assignment,
  );
}

function preserveVisibleTransientLaunchRoute(
  layout: PaneLayoutState,
  source: PaneLayoutState,
  route: TransientLaunchRoute | null,
  assignment: TransientLaunchAssignment | null,
): PaneLayoutState {
  if (!route || assignment) return layout;
  const current = source.tabs.find((tab) => tab.id === route.tabId);
  if (!current || !visiblePaneLeaves(layout).some((leaf) => leaf.tabId === route.tabId)) return layout;
  return {
    ...layout,
    tabs: layout.tabs.map((tab) =>
      tab.id === route.tabId
        ? { ...tab, target: current.target, back: [...current.back], forward: [...current.forward] }
        : tab,
    ),
  };
}

function hasUnrepresentedPairOrder(state: TabState): boolean {
  const leaves = visiblePaneLeaves(state.layout);
  const checked = new Set<string>();
  for (const instance of state.layout.tabs) {
    const pair = pairForInstance(state.layout.tabs, instance);
    if (!pair || checked.has(pair.main.id)) continue;
    checked.add(pair.main.id);
    const order = state.physicalOrderByGroup.get(pair.main.id);
    if (!order || order[0] === pair.main.id) continue;
    const first = leaves.findIndex((leaf) => leaf.tabId === order[0]);
    const second = leaves.findIndex((leaf) => leaf.tabId === order[1]);
    // The v2 wire has no per-group orientation field, so an inverted pair must stay attached
    // to visible leaves while that order is being persisted.
    if (first < 0 || second < 0 || first > second) return true;
  }
  return false;
}

function projectedOrderChanged(previous: readonly Tab[], next: readonly Tab[]): boolean {
  const nextIds = new Set(next.map((tab) => tab.id));
  const previousCommon = previous.filter((tab) => nextIds.has(tab.id)).map((tab) => tab.id);
  const previousIds = new Set(previous.map((tab) => tab.id));
  const nextCommon = next.filter((tab) => previousIds.has(tab.id)).map((tab) => tab.id);
  return previousCommon.some((id, index) => nextCommon[index] !== id);
}

function orderInstances(layout: PaneLayoutState, projectedTabs: readonly Tab[]): PaneTabInstance<string>[] {
  const result: PaneTabInstance<string>[] = [];
  const used = new Set<string>();
  const add = (tab: PaneTabInstance<string> | undefined) => {
    if (!tab || used.has(tab.id)) return;
    used.add(tab.id);
    result.push(tab);
  };
  for (const projected of projectedTabs) {
    const main = layout.tabs.find((tab) => tab.id === projected.id);
    add(main);
    const pair = main ? pairForInstance(layout.tabs, main) : null;
    if (projected.side && pair) add(pair.side);
  }
  for (const tab of layout.tabs) add(tab);
  return result;
}

function updateLayoutFromProjection(
  base: PaneLayoutState,
  previousTabs: readonly Tab[],
  nextTabs: readonly Tab[],
  preserveExistingOrder: boolean,
  physicalOrderByGroup: ReadonlyMap<string, readonly [string, string]>,
): PaneLayoutState {
  let tabs = [...base.tabs];
  const nextIds = new Set(nextTabs.map((tab) => tab.id));
  for (const previous of previousTabs) {
    if (nextIds.has(previous.id)) continue;
    const instance = tabs.find((tab) => tab.id === previous.id);
    if (!instance) continue;
    const pair = pairForInstance(tabs, instance);
    const removedIds = previous.side && pair ? new Set([pair.main.id, pair.side.id]) : new Set([instance.id]);
    tabs = tabs.filter((tab) => !removedIds.has(tab.id));
  }

  for (const projected of nextTabs) {
    let main = tabs.find((tab) => tab.id === projected.id);
    let groupId = main?.groupId ?? projected.id;
    if (!main) {
      main = {
        id: projected.id,
        groupId,
        target: projected.hash,
        back: [],
        forward: [],
      };
      tabs.push(main);
    }
    if (projected.side && main.id !== groupId) {
      groupId = main.id;
      main = { ...main, groupId };
      tabs = tabs.map((tab) => (tab.id === main!.id ? main! : tab));
    }
    const pinned = projected.pinned === true;
    const previous = previousTabs.find((tab) => tab.id === projected.id);
    const pinChanged = !previous || previous.pinned !== projected.pinned;
    const currentPair = pairForInstance(tabs, main);
    if (currentPair) {
      const pairLayout = { ...base, tabs };
      const [physicalMain, physicalSide] = pairInPhysicalOrder(pairLayout, currentPair, physicalOrderByGroup);
      const updatedMain = instanceWithTabView(
        physicalMain,
        projected,
        pinChanged ? pinned : physicalMain.pinned === true,
      );
      const nextTabsWithMain = tabs.map((tab) => (tab.id === physicalMain.id ? updatedMain : tab));
      if (projected.side && physicalSide) {
        const sideView: Tab = { ...projected.side, id: projected.id, side: null };
        const updatedSide = instanceWithTabView(
          physicalSide,
          sideView,
          pinChanged ? pinned : physicalSide.pinned === true,
        );
        tabs = nextTabsWithMain.map((tab) => (tab.id === physicalSide.id ? updatedSide : tab));
      } else {
        tabs = nextTabsWithMain.filter((tab) => tab.id !== physicalSide?.id);
      }
      continue;
    }
    const nextMain = instanceWithTabView(main, projected, pinChanged ? pinned : main.pinned === true);
    tabs = tabs.map((tab) => (tab.id === main!.id ? nextMain : tab));

    const existingSide = pairForInstance(tabs, main)?.side;
    if (projected.side) {
      const sideId = existingSide?.id ?? nextSideId(main.id, tabs);
      const sideSource =
        existingSide ??
        ({
          id: sideId,
          groupId,
          target: projected.side.hash,
          back: [],
          forward: [],
        } satisfies PaneTabInstance<string>);
      const sideView: Tab = { ...projected.side, id: projected.id, side: null };
      const nextSide = instanceWithTabView(
        sideSource,
        sideView,
        pinChanged ? pinned : sideSource.pinned === true,
      );
      if (existingSide) tabs = tabs.map((tab) => (tab.id === existingSide.id ? nextSide : tab));
      else tabs.push(nextSide);
    } else if (previousTabs.find((tab) => tab.id === projected.id)?.side && existingSide) {
      tabs = tabs.filter((tab) => tab.id !== existingSide.id);
    }
  }

  const ordered = preserveExistingOrder ? tabs : orderInstances({ ...base, tabs }, nextTabs);
  return clearMissingAssignments({ ...base, tabs: ordered });
}

function set(next: TabState, keepLayout = false): void {
  const previous = current();
  let layout = next.layout;
  if (!keepLayout) {
    const preserveExistingOrder =
      previous.projectionIds !== null ||
      (previous.projectionKind === 'fork-layout' && !projectedOrderChanged(previous.tabs, next.tabs));
    layout = updateLayoutFromProjection(
      next.layout,
      previous.tabs,
      next.tabs,
      preserveExistingOrder,
      next.physicalOrderByGroup,
    );
    if (!next.explicitLayout && visiblePaneLeaves(previous.layout).length <= 2) {
      layout = layoutForProjection(
        layout,
        next.active,
        next.pane,
        next.projectionKind,
        next.physicalOrderByGroup,
      );
    } else {
      const active = layout.tabs.find((tab) => tab.id === next.active);
      const pair = active ? pairForInstance(layout.tabs, active) : null;
      const activeIds = pair
        ? new Set(pairInPhysicalOrder(layout, pair, next.physicalOrderByGroup).map((tab) => tab.id))
        : active
          ? new Set([active.id])
          : new Set<string>();
      let visibleLeaves = visiblePaneLeaves(layout);
      const activeIsAssigned = visibleLeaves.some(
        (leaf) => leaf.tabId !== null && activeIds.has(leaf.tabId),
      );
      if (!activeIsAssigned && next.active !== previous.active && active) {
        const destination = visibleLeaves.find((leaf) => leaf.id === layout.focusedPaneId) ?? visibleLeaves[0];
        if (destination) {
          const root = replaceLeafAssignments(layout.root, new Map([[destination.id, active.id]]));
          layout = { ...layout, root, focusedPaneId: destination.id };
          visibleLeaves = visiblePaneLeaves(layout);
        }
      }
      const focusedLeaf = visibleLeaves.find((leaf) => leaf.tabId !== null && activeIds.has(leaf.tabId));
      if (focusedLeaf) layout = { ...layout, focusedPaneId: focusedLeaf.id };
      else if (!visibleLeaves.some((leaf) => leaf.id === layout.focusedPaneId && leaf.tabId !== null)) {
        const fallback = visibleLeaves.find((leaf) => leaf.tabId !== null) ?? visibleLeaves[0];
        if (fallback) layout = { ...layout, focusedPaneId: fallback.id };
      }
    }
  }
  const projectionIds = keepLayout
    ? next.projectionIds
    : previous.projectionIds === null
      ? null
      : next.tabs.map((tab) => tab.id);
  const projectionOrder = keepLayout
    ? next.projectionOrder
    : previous.projectionKind === 'fork-layout' && previous.projectionIds === null
      ? next.tabs.map((tab) => tab.id)
      : null;
  let transientLaunchRoute = next.transientLaunchRoute;
  if (transientLaunchRoute && startupNavigationSuppressionDepth === 0) {
    const previousInstance = previous.layout.tabs.find((tab) => tab.id === transientLaunchRoute!.tabId);
    const nextInstance = layout.tabs.find((tab) => tab.id === transientLaunchRoute!.tabId);
    if (!sameTransientRoute(previousInstance, nextInstance)) transientLaunchRoute = null;
  }
  let transientLaunchAssignment = next.transientLaunchAssignment;
  if (
    transientLaunchAssignment &&
    startupNavigationSuppressionDepth === 0 &&
    !sameTransientLaunchAssignment(previous.layout, layout, transientLaunchAssignment)
  ) {
    transientLaunchAssignment = null;
  }
  let committed = stateFromLayout(
    layout,
    next.closed,
    next.persistenceWritable,
    next.observedStorageRaw,
    next.active,
    projectionIds,
    next.projectionKind,
    projectionOrder,
    next.physicalOrderByGroup,
    next.explicitLayout,
    next.legacyMigrationBaseline,
    next.legacyMigrationBaselineV2Raw,
    transientLaunchRoute,
    transientLaunchAssignment,
  );
  if (committed.persistenceWritable && startupNavigationSuppressionDepth === 0) {
    const persistenceLayout = layoutForPersistence(
      committed.layout,
      committed.transientLaunchRoute,
      committed.transientLaunchAssignment,
    );
    const source = readPaneTabsSnapshot(committed.observedStorageRaw);
    let result:
      | ReturnType<typeof persistPaneTabsSnapshot>
      | ReturnType<typeof persistPaneTabsSnapshotAfterLegacyEquivalence>
      | null = null;
    if (source.kind === 'legacy' && committed.observedStorageRaw !== null) {
      if (
        committed.legacyMigrationBaseline &&
        committed.legacyMigrationBaselineV2Raw !== null
      ) {
        let candidateRaw: string | null = null;
        try {
          candidateRaw = writePaneTabsSnapshot(persistenceLayout, committed.closed);
        } catch {
          // The invalid or over-limit candidate remains in memory; a later representable edit may save.
        }
        if (
          candidateRaw !== null &&
          candidateRaw !== committed.legacyMigrationBaselineV2Raw &&
          !hasUnrepresentedPairOrder(committed)
        ) {
          result = persistPaneTabsSnapshotAfterLegacyEquivalence(
            localStorage,
            persistenceLayout,
            committed.closed,
            committed.observedStorageRaw,
            committed.legacyMigrationBaseline,
          );
        }
      }
    } else if (source.kind === 'current' && hasUnrepresentedPairOrder(committed)) {
      // The v2 wire stores physical order in its tree, not for detached pairs. Keep the last
      // snapshot if writing this runtime state would erase a swapped hidden pair orientation.
    } else {
      result = persistPaneTabsSnapshot(
        localStorage,
        persistenceLayout,
        committed.closed,
        committed.observedStorageRaw,
      );
    }

    if (result?.kind === 'written' || result?.kind === 'unchanged') {
      committed = {
        ...committed,
        observedStorageRaw: result.raw,
        legacyMigrationBaseline: null,
        legacyMigrationBaselineV2Raw: null,
      };
    } else if (result?.kind === 'conflict') {
      committed = { ...committed, persistenceWritable: false };
    } else if (result?.kind === 'storage-error' && result.operation === 'read') {
      committed = { ...committed, persistenceWritable: false };
    } else if (
      result?.kind === 'protected' &&
      result.reason !== 'invalid-candidate'
    ) {
      committed = { ...committed, persistenceWritable: false };
    }
  }
  state = committed;
  for (const listener of listeners) listener();
}

function setLayout(
  layout: PaneLayoutState,
  options: {
    readonly physicalOrderByGroup?: ReadonlyMap<string, readonly [string, string]>;
    readonly projectionIdReplacement?: readonly [string, string];
    readonly explicitLayout?: boolean;
  } = {},
): void {
  const now = current();
  const replaceProjectionIds = (ids: readonly string[] | null) => {
    const replacement = options.projectionIdReplacement;
    return ids && replacement ? ids.map((id) => (id === replacement[0] ? replacement[1] : id)) : ids;
  };
  const next = stateFromLayout(
    layout,
    now.closed,
    now.persistenceWritable,
    now.observedStorageRaw,
    now.active,
    replaceProjectionIds(now.projectionIds),
    now.projectionKind,
    replaceProjectionIds(now.projectionOrder),
    options.physicalOrderByGroup ?? now.physicalOrderByGroup,
    options.explicitLayout ?? now.explicitLayout,
    now.legacyMigrationBaseline,
    now.legacyMigrationBaselineV2Raw,
    now.transientLaunchRoute,
    now.transientLaunchAssignment,
  );
  set(next, true);
}

function commitTransientLaunchForIntent(paneId: PaneId, tabId: string): void {
  if (startupNavigationSuppressionDepth > 0) return;
  const now = current();
  const clearsRoute = now.transientLaunchRoute?.tabId === tabId;
  const clearsAssignment =
    now.transientLaunchAssignment?.paneId === paneId && now.transientLaunchAssignment.tabId === tabId;
  if (!clearsRoute && !clearsAssignment) return;
  set(
    {
      ...now,
      transientLaunchRoute: clearsRoute ? null : now.transientLaunchRoute,
      transientLaunchAssignment: clearsAssignment ? null : now.transientLaunchAssignment,
    },
    true,
  );
}

function updateActive(change: (tab: Tab) => Tab, extra: Partial<TabState> = {}): void {
  const now = current();
  set({ ...now, ...extra, tabs: now.tabs.map((tab) => (tab.id === now.active ? change(tab) : tab)) });
}

// a hash the main side is about to show because of a tab switch or back and forward, not a new visit
let arriving: string | null = null;

function go(hash: string): void {
  if (window.location.hash === hash || (hash === '#/' && !window.location.hash)) return;
  arriving = hash;
  window.location.hash = hash;
}

function replaceBrowserHash(hash: string): void {
  if (window.location.hash === hash || (hash === '#/' && !window.location.hash)) return;
  try {
    history.replaceState(null, '', hash);
  } catch {
    // Keep the in-memory pane state if the host rejects an address replacement.
  }
}

function goToPrimaryPane(): void {
  const primary = primaryPaneId();
  if (primary && assignedTabForPane(primary)) {
    go(routeHashForPane(primary));
    return;
  }

  // An empty URL anchor is neutral state, not a request to open a Home tab. If an internal
  // hash change is already queued, let its handler recognize the replacement as internal.
  arriving = arriving === null ? null : '#/';
  replaceBrowserHash('#/');
}

// a mouse's back button can reach the app both as a button press and as a window app command. whichever
// comes first moves, the other one for the same press is let go
let lastNavigation = 0;
export function claimNavigation(): boolean {
  if (Date.now() - lastNavigation < 400) return false;
  lastNavigation = Date.now();
  return true;
}

/** Runs the preferred start page only while startup has not received user input. */
export function runStartupNavigation(action: () => void): boolean {
  if (startupNavigationCancelled) return false;
  startupNavigationSuppressionDepth += 1;
  try {
    action();
  } finally {
    startupNavigationSuppressionDepth -= 1;
  }
  return true;
}

/** Restores a saved v2 workspace literally; v0 keeps its published 2.2 back-navigation behavior. */
export function restoreLastPosition(): void {
  if (startupNavigationSuppressionDepth === 0) {
    runStartupNavigation(() => restoreLastPosition());
    return;
  }

  const now = current();
  if (now.projectionKind !== 'fork-layout') {
    goBack('main');
    return;
  }

  const layout = layoutWithoutTransientLaunchAssignment(
    layoutWithoutTransientLaunchRoute(now.layout, now.transientLaunchRoute),
    now.transientLaunchAssignment,
  );
  if (
    layout !== now.layout ||
    now.transientLaunchRoute !== null ||
    now.transientLaunchAssignment !== null
  ) {
    set(
      {
        ...now,
        layout,
        transientLaunchRoute: null,
        transientLaunchAssignment: null,
      },
      true,
    );
  }

  const primary = primaryPaneId();
  replaceBrowserHash(primary ? routeHashForPane(primary) : '#/');
}

export function startTabs(): () => void {
  if (activeTabsLifecycles === 0) startupNavigationCancelled = false;
  activeTabsLifecycles += 1;
  current();
  const onStartupInteraction = () => {
    startupNavigationCancelled = true;
  };
  const onHash = () => {
    const hash = window.location.hash || '#/';
    const primary = primaryPaneId();
    const tab = primary ? assignedTabForPane(primary) : null;
    const expected = arriving === hash;
    arriving = null;
    if (!primary) return;
    if (!tab) {
      // `#/` is the neutral URL for an empty anchor, including hash events emitted by
      // hosts such as Happy DOM when replaceState changes only the URL. Opening Home into
      // an empty pane remains an explicit showInPane operation.
      if (hash === '#/') return;
      const now = current();
      if (now.layout.tabs.length >= MAX_TABS) return;
      const id = newTabId();
      setLayout({
        ...now.layout,
        tabs: [...now.layout.tabs, { id, groupId: id, target: hash, back: [], forward: [] }],
        root: replaceLeafAssignments(now.layout.root, new Map([[primary, id]])),
      });
      return;
    }
    if (tab.target === hash) return;
    const history = expected
      ? { ...tab, target: hash }
      : { ...tab, target: hash, back: [...tab.back, tab.target].slice(-MAX_HISTORY), forward: [] };
    const now = current();
    setLayout({
      ...now.layout,
      tabs: now.layout.tabs.map((item) => (item.id === tab.id ? history : item)),
    });
  };
  // ctrl or cmd click, or a middle click, on anything that points at a page opens it in a new tab behind
  // the one you are on, with shift as well it comes to the front. alt click opens it beside the page
  const onClick = (event: MouseEvent) => {
    const newTab =
      event.type === 'auxclick' ? event.button === 1 : event.button === 0 && (event.ctrlKey || event.metaKey);
    const toSide =
      event.type === 'click' && event.button === 0 && event.altKey && !event.ctrlKey && !event.metaKey;
    if (!newTab && !toSide) return;
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-page-id]');
    const id = target?.dataset.pageId;
    if (!id || target.closest('.tab-bar')) return;
    event.preventDefault();
    event.stopPropagation();
    const hash = `#/page/${encodeURIComponent(id)}`;
    if (newTab) openTab(hash, { background: !event.shiftKey });
    else openSide(hash);
  };
  // a mouse's back and forward buttons. chromium only reports their press and release, never a click, and
  // windows may also send them to the window as app commands, which arrive as the go back action
  const onMouseButton = (event: MouseEvent) => {
    if (event.button !== 3 && event.button !== 4) return;
    event.preventDefault();
    if (event.type !== 'mouseup' || !claimNavigation()) return;
    const pane = paneAt(event.target);
    if (event.button === 3) goBack(pane);
    else goForward(pane);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Tab' && event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      stepTab(event.shiftKey ? -1 : 1);
    }
  };
  window.addEventListener('hashchange', onHash);
  window.addEventListener('pointerdown', onStartupInteraction, true);
  window.addEventListener('keydown', onStartupInteraction, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('auxclick', onClick, true);
  window.addEventListener('mousedown', onMouseButton, true);
  window.addEventListener('mouseup', onMouseButton, true);
  window.addEventListener('keydown', onKey, true);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    window.removeEventListener('hashchange', onHash);
    window.removeEventListener('pointerdown', onStartupInteraction, true);
    window.removeEventListener('keydown', onStartupInteraction, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('auxclick', onClick, true);
    window.removeEventListener('mousedown', onMouseButton, true);
    window.removeEventListener('mouseup', onMouseButton, true);
    window.removeEventListener('keydown', onKey, true);
    activeTabsLifecycles = Math.max(0, activeTabsLifecycles - 1);
  };
}

function paneAt(target: EventTarget | null): PaneId {
  const element = target instanceof Element ? target.closest<HTMLElement>('[data-pane]') : null;
  const exact = element?.dataset.paneId;
  return exact ? (resolvePaneId(exact) ?? targetPane()) : targetPane();
}

export interface PaneAssignment {
  readonly role: PaneRole;
  readonly paneId: PaneId;
  readonly tabId: string;
}

export interface PaneSlot {
  readonly role: PaneRole;
  readonly paneId: PaneId;
  readonly tabId: string | null;
}

function paneRoleAt(index: number): PaneRole {
  return index === 0 ? 'main' : index === 1 ? 'side' : index === 2 ? 'third' : 'fourth';
}

/** Assigned panes, in physical order from the left/top. */
export function paneAssignments(layout = current().layout): PaneAssignment[] {
  const leaves = visiblePaneLeaves(layout);
  return leaves.flatMap((leaf, index) =>
    leaf.tabId ? [{ role: paneRoleAt(index), paneId: leaf.id, tabId: leaf.tabId }] : [],
  );
}

/** Visible slots include empty panes so the workspace can offer an explicit open action. */
export function paneSlots(layout = current().layout): PaneSlot[] {
  const now = current();
  const hideLegacyEmptyLeaves =
    layout === now.layout && !now.explicitLayout && now.projectionKind === 'legacy-two-pane';
  return visiblePaneLeaves(layout).flatMap((leaf, index) =>
    hideLegacyEmptyLeaves && leaf.tabId === null
      ? []
      : [{ role: paneRoleAt(index), paneId: leaf.id, tabId: leaf.tabId }],
  );
}

export function targetPane(): PaneId {
  return current().layout.focusedPaneId;
}

export function activeHash(): string {
  const focused = targetPane();
  return focused === primaryPaneId() && window.location.hash
    ? window.location.hash
    : routeHashForPane(focused);
}

export function routeHashForPane(pane: PaneId): string {
  const now = current();
  return assignedTabForPane(pane, now.layout)?.target ?? '#/';
}

export function routeHashForTabId(tabId: string): string {
  return current().layout.tabs.find((tab) => tab.id === tabId)?.target ?? '#/';
}

export function paneIdForTabId(tabId: string): PaneId {
  const layout = current().layout;
  const assigned = visiblePaneLeaves(layout).find((leaf) => leaf.tabId === tabId);
  if (assigned) return assigned.id;
  const cacheKey = Array.from(tabId, (character) => character.codePointAt(0)!.toString(16)).join('-');
  const visibleIds = new Set(visiblePaneLeaves(layout).map((leaf) => leaf.id));
  let cachedId = `morrow-cached-pane:${cacheKey}`;
  while (visibleIds.has(cachedId)) cachedId += ':hidden';
  return cachedId;
}

export function isPrimaryPane(pane: PaneId): boolean {
  return resolvePaneId(pane) === primaryPaneId();
}

export function isSidePane(pane: PaneId): boolean {
  return resolvePaneId(pane) === resolvePaneId('side');
}

export function isPaneTabVisible(tabId: string): boolean {
  return visiblePaneLeaves(current().layout).some((leaf) => leaf.tabId === tabId);
}

export function isSideTabInstance(tabId: string): boolean {
  const layout = current().layout;
  const tab = layout.tabs.find((item) => item.id === tabId);
  return tab !== undefined && pairForInstance(layout.tabs, tab)?.side.id === tabId;
}

export function setActivePane(pane: PaneId): void {
  const now = current();
  const paneId = resolvePaneId(pane, now.layout);
  if (!paneId || paneId === now.layout.focusedPaneId) return;
  setLayout({ ...now.layout, focusedPaneId: paneId });
}

export function setPanePreset(preset: PanePreset): void {
  const now = current();
  const samePreset = applyPanePresetPreservingAssignments(now.layout, preset) === now.layout;
  if (samePreset && now.explicitLayout) return;
  const persistentLayout = layoutForPersistence(
    now.layout,
    now.transientLaunchRoute,
    now.transientLaunchAssignment,
  );
  const layout = preserveVisibleTransientLaunchRoute(
    applyPresetWithSuspendedTabs(persistentLayout, preset),
    now.layout,
    now.transientLaunchRoute,
    now.transientLaunchAssignment,
  );
  if (layout === now.layout && now.explicitLayout) return;
  urlAnchorPaneId = null;
  setLayout(layout, {
    explicitLayout: true,
  });
  goToPrimaryPane();
}

export function assignTabToPane(tabId: string, pane: PaneId): void {
  const now = current();
  if (!now.layout.tabs.some((tab) => tab.id === tabId)) return;
  const paneId = resolvePaneId(pane, now.layout);
  if (!paneId) return;
  const leaf = visiblePaneLeaves(now.layout).find((item) => item.id === paneId);
  if (!leaf) return;
  if (leaf.tabId === tabId) {
    commitTransientLaunchForIntent(paneId, tabId);
    const latest = current();
    if (latest.layout.focusedPaneId !== paneId)
      setLayout({ ...latest.layout, focusedPaneId: paneId });
    return;
  }
  const updates = new Map<string, string | null>();
  for (const item of visiblePaneLeaves(now.layout)) {
    if (item.tabId === tabId && item.id !== paneId) updates.set(item.id, null);
  }
  updates.set(paneId, tabId);
  setLayout({
    ...now.layout,
    root: replaceLeafAssignments(now.layout.root, updates),
    focusedPaneId: paneId,
  });
  if (paneId === primaryPaneId(now.layout)) go(routeHashForPane(paneId));
}

function openNewTabInPane(hash: string, paneId: PaneId): void {
  const now = current();
  if (now.layout.tabs.length >= MAX_TABS) return;
  const id = newTabId();
  const tab: PaneTabInstance<string> = { id, groupId: id, target: hash, back: [], forward: [] };
  const layout = {
    ...now.layout,
    tabs: [...now.layout.tabs, tab],
    root: replaceLeafAssignments(now.layout.root, new Map([[paneId, id]])),
    focusedPaneId: paneId,
  };
  setLayout(layout);
  if (paneId === primaryPaneId(now.layout)) go(hash);
}

function unassignedTabForTarget(
  layout: PaneLayoutState,
  hash: string,
): PaneTabInstance<string> | null {
  const assignedIds = new Set(
    visiblePaneLeaves(layout)
      .map((item) => item.tabId)
      .filter((id): id is string => id !== null),
  );
  return layout.tabs.find((item) => item.target === hash && !assignedIds.has(item.id)) ?? null;
}

/** Whether an empty pane can show a route, reusing the same unassigned tab as showInPane. */
export function canOpenInEmptyPane(pane: PaneId, hash?: string): boolean {
  const now = current();
  const paneId = resolvePaneId(pane, now.layout);
  if (!paneId) return false;
  const leaf = visiblePaneLeaves(now.layout).find((item) => item.id === paneId);
  if (!leaf || leaf.tabId !== null) return false;
  return (
    (hash !== undefined && unassignedTabForTarget(now.layout, hash) !== null) ||
    now.layout.tabs.length < MAX_TABS
  );
}

export function showInPane(hash: string, pane = targetPane(), replace = false): void {
  const now = current();
  const paneId = resolvePaneId(pane, now.layout);
  if (!paneId) return;
  const leaf = visiblePaneLeaves(now.layout).find((item) => item.id === paneId);
  const tab = leaf?.tabId ? now.layout.tabs.find((item) => item.id === leaf.tabId) : null;
  if (!tab) {
    const available = unassignedTabForTarget(now.layout, hash);
    let nextLayout = now.layout;
    let tabId = available?.id;
    if (!tabId) {
      if (now.layout.tabs.length >= MAX_TABS) return;
      tabId = newTabId();
      nextLayout = {
        ...nextLayout,
        tabs: [...nextLayout.tabs, { id: tabId, groupId: tabId, target: hash, back: [], forward: [] }],
      };
    }
    const updates = new Map<string, string | null>();
    for (const item of visiblePaneLeaves(nextLayout)) {
      if (item.tabId === tabId && item.id !== paneId) updates.set(item.id, null);
    }
    updates.set(paneId, tabId);
    setLayout({
      ...nextLayout,
      root: replaceLeafAssignments(nextLayout.root, updates),
      focusedPaneId: paneId,
    });
    if (paneId === primaryPaneId(now.layout)) {
      if (replace) {
        history.replaceState(null, '', hash);
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      } else {
        go(hash);
      }
    }
    return;
  }
  const place = (value: string) => (value || '#/').split('?')[0];
  if (tab.target === hash) {
    commitTransientLaunchForIntent(paneId, tab.id);
    const latest = current();
    if (latest.layout.focusedPaneId !== paneId)
      setLayout({ ...latest.layout, focusedPaneId: paneId });
    return;
  }

  const legacyTwoPane = now.projectionKind === 'legacy-two-pane' && !now.explicitLayout;
  const legacyPair = legacyTwoPane ? pairForInstance(now.layout.tabs, tab) : null;
  const legacyPinned = legacyPair
    ? now.tabs.find((item) => item.id === legacyPair.main.id)?.pinned === true
    : tab.pinned === true;
  if (
    !replace &&
    legacyTwoPane &&
    legacyPinned &&
    paneId === primaryPaneId(now.layout) &&
    place(hash) !== place(tab.target)
  ) {
    // In the legacy two-pane adapter, pinning protects the logical tab group. Navigating its
    // primary pane opens a new solo tab, while the lateral instance remains a mutable history.
    openTab(hash);
    return;
  }
  if (!replace && !legacyTwoPane && tab.pinned && place(hash) !== place(tab.target)) {
    openNewTabInPane(hash, paneId);
    return;
  }
  const primary = primaryPaneId(now.layout);
  const nextHistory = replace
    ? { ...tab, target: hash }
    : { ...tab, target: hash, back: [...tab.back, tab.target].slice(-MAX_HISTORY), forward: [] };
  setLayout({
    ...now.layout,
    focusedPaneId: paneId,
    tabs: now.layout.tabs.map((item) => (item.id === tab.id ? nextHistory : item)),
  });
  if (paneId !== primary) return;
  if (replace) {
    history.replaceState(null, '', hash);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    go(hash);
  }
}

// Shows a place in the primary pane. A pinned tab opens another tab instead of navigating away.
export function showInMain(hash: string, replace = false): void {
  const now = current();
  const primary = primaryPaneId(now.layout);
  if (primary) showInPane(hash, primary, replace);
}

export function showInSide(hash: string, replace = false): void {
  const side = selectedPaneLeaves(current().layout)[1];
  if (side) showInPane(hash, side.id, replace);
}

// splits the tab, the new side shows the given place and becomes where navigation goes
export function openSide(hash = activeHash(), sourceTabId?: string): void {
  let now = current();
  if (now.explicitLayout || visiblePaneLeaves(now.layout).length > 2) {
    if (sourceTabId && !paneForTabGroup(sourceTabId, now.layout)) {
      activateTab(sourceTabId);
      now = current();
    }
    let sourcePane = sourceTabId
      ? paneForTabGroup(sourceTabId, now.layout)
      : now.layout.focusedPaneId;
    if (visiblePaneLeaves(now.layout).length === 1) {
      setPanePreset('two-columns');
      now = current();
      sourcePane = sourceTabId
        ? paneForTabGroup(sourceTabId, now.layout)
        : now.layout.focusedPaneId;
    }
    const destination = sourcePane ? adjacentPaneId(now.layout, sourcePane) : null;
    if (destination) showInPane(hash, destination);
    return;
  }
  if (sourceTabId) {
    activateTab(sourceTabId);
    now = current();
  }
  const side = selectedPaneLeaves(now.layout)[1];
  if (side?.tabId) {
    setLayout({
      ...now.layout,
      focusedPaneId: side.id,
      tabs: now.layout.tabs.map((tab) =>
        tab.id === side.tabId ? { ...tab, target: hash, back: [], forward: [] } : tab,
      ),
    });
    return;
  }
  updateActive((item) => ({ ...item, side: { hash, back: [], forward: [] } }), { pane: 'side' });
}

export function closeSide(): void {
  const now = current();
  const leaves = selectedPaneLeaves(now.layout);
  const main = leaves[0];
  const side = leaves[1];
  if (!main || !side?.tabId) return;
  const sideInstance = now.layout.tabs.find((tab) => tab.id === side.tabId);
  const pair = sideInstance ? pairForInstance(now.layout.tabs, sideInstance) : null;
  const survivorIsPinned =
    pair?.main.pinned === true ||
    pair?.side.pinned === true ||
    now.layout.tabs.find((tab) => tab.id === main.tabId)?.pinned === true;
  const projectionIdReplacement =
    pair && main.tabId === pair.side.id ? ([pair.main.id, pair.side.id] as const) : undefined;
  const layout = clearMissingAssignments({
    ...now.layout,
    focusedPaneId: main.id,
    tabs: now.layout.tabs.flatMap((tab) => {
      if (tab.id === side.tabId) return [];
      if (tab.id === main.tabId && survivorIsPinned) return [{ ...tab, pinned: true }];
      return [tab];
    }),
  });
  setLayout(layout, { projectionIdReplacement });
}

export function swapSides(): void {
  const now = current();
  const leaves = selectedPaneLeaves(now.layout);
  const main = leaves[0];
  const side = leaves[1];
  if (!main?.tabId || !side?.tabId || main.tabId === side.tabId) return;
  const updates = new Map([
    [main.id, side.tabId],
    [side.id, main.tabId],
  ]);
  const root = replaceLeafAssignments(now.layout.root, updates);
  const focusedPaneId =
    now.layout.focusedPaneId === main.id
      ? side.id
      : now.layout.focusedPaneId === side.id
        ? main.id
        : now.layout.focusedPaneId;
  const layout = { ...now.layout, root, focusedPaneId };
  const swappedMain = layout.tabs.find((tab) => tab.id === main.tabId);
  const pair = swappedMain ? pairForInstance(layout.tabs, swappedMain) : null;
  const physicalOrderByGroup = new Map(now.physicalOrderByGroup);
  if (pair) physicalOrderByGroup.set(pair.main.id, [side.tabId, main.tabId]);
  setLayout(layout, { physicalOrderByGroup });
  goToPrimaryPane();
}

export function canGo(_tab: Tab, pane: PaneId, direction: 'back' | 'forward'): boolean {
  const instance = assignedTabForPane(pane);
  return Boolean(instance && instance[direction].length > 0);
}

function step(pane: PaneId, direction: 'back' | 'forward'): void {
  const now = current();
  const paneId = resolvePaneId(pane, now.layout);
  if (!paneId) return;
  const leaf = visiblePaneLeaves(now.layout).find((item) => item.id === paneId);
  const tab = leaf?.tabId ? now.layout.tabs.find((item) => item.id === leaf.tabId) : null;
  if (!tab || tab[direction].length === 0) return;
  const history = [...tab[direction]];
  const hash = history.pop()!;
  const next = {
    ...tab,
    target: hash,
    [direction]: history,
    [direction === 'back' ? 'forward' : 'back']: [
      ...tab[direction === 'back' ? 'forward' : 'back'],
      tab.target,
    ].slice(-MAX_HISTORY),
  };
  setLayout({
    ...now.layout,
    focusedPaneId: paneId,
    tabs: now.layout.tabs.map((item) => (item.id === tab.id ? next : item)),
  });
  if (paneId === primaryPaneId(now.layout)) go(hash);
}

export function goBack(pane: PaneId = targetPane()): void {
  step(pane, 'back');
}

export function goForward(pane: PaneId = targetPane()): void {
  step(pane, 'forward');
}

// a tab opened in the background waits beside the one you are on, which stays in front. tabs opened that
// way one after another line up in the order they were opened
let backgroundRun: { from: string; last: string } | null = null;
export function openTab(hash = '#/', options: { background?: boolean } = {}): void {
  const now = current();
  if (now.tabs.length >= MAX_TABS) {
    if (!options.background) go(hash);
    return;
  }
  const tab: Tab = { id: newTabId(), hash, back: [], forward: [], side: null };
  const after = backgroundRun?.from === now.active ? backgroundRun.last : now.active;
  const index = Math.max(
    now.tabs.findIndex((item) => item.id === after),
    now.tabs.findIndex((item) => item.id === now.active),
  );
  const tabs = [...now.tabs];
  tabs.splice(index + 1, 0, tab);
  if (options.background) {
    backgroundRun = { from: now.active, last: tab.id };
    set({ ...now, tabs });
    return;
  }
  backgroundRun = null;
  if (now.explicitLayout || visiblePaneLeaves(now.layout).length > 2) {
    const focusedPane = now.layout.focusedPaneId;
    set({ ...now, tabs, active: tab.id, pane: 'main' });
    if (focusedPane === primaryPaneId()) go(hash);
    return;
  }
  set({ ...now, tabs, active: tab.id, pane: 'main' });
  go(hash);
}

export function activateTab(id: string): void {
  const now = current();
  const tab = now.tabs.find((item) => item.id === id);
  if (!tab) return;
  if (now.explicitLayout || visiblePaneLeaves(now.layout).length > 2) {
    const exact = now.layout.tabs.find((item) => item.id === id);
    const pair = exact ? pairForInstance(now.layout.tabs, exact) : null;
    const ordered = pair ? pairInPhysicalOrder(now.layout, pair, now.physicalOrderByGroup) : [exact].filter(Boolean);
    const ids = new Set(ordered.map((item) => item!.id));
    const assigned = visiblePaneLeaves(now.layout).find(
      (leaf) => leaf.tabId !== null && ids.has(leaf.tabId),
    );
    if (assigned) {
      const updates = new Map<string, string | null>();
      const occupied = new Set(visiblePaneLeaves(now.layout).flatMap((leaf) => (leaf.tabId ? [leaf.tabId] : [])));
      const emptyLeaves = visiblePaneLeaves(now.layout).filter((leaf) => leaf.tabId === null);
      let emptyIndex = 0;
      for (const member of ordered) {
        if (occupied.has(member!.id)) continue;
        const destination = emptyLeaves[emptyIndex++];
        if (!destination) break;
        updates.set(destination.id, member!.id);
      }
      if (updates.size > 0) {
        setLayout({
          ...now.layout,
          root: replaceLeafAssignments(now.layout.root, updates),
          focusedPaneId: assigned.id,
        });
      } else if (assigned.id !== now.layout.focusedPaneId) {
        setLayout({ ...now.layout, focusedPaneId: assigned.id });
      }
      goToPrimaryPane();
      return;
    }
    const leaves = visiblePaneLeaves(now.layout);
    const firstDestination = leaves.find((leaf) => leaf.id === now.layout.focusedPaneId) ?? leaves[0];
    if (!firstDestination) return;
    const updates = new Map<string, string | null>([[firstDestination.id, ordered[0]!.id]]);
    const otherDestination = leaves.find((leaf) => leaf.id !== firstDestination.id && leaf.tabId === null);
    if (ordered.length > 1 && otherDestination) updates.set(otherDestination.id, ordered[1]!.id);
    setLayout({
      ...now.layout,
      root: replaceLeafAssignments(now.layout.root, updates),
      focusedPaneId: firstDestination.id,
    });
    goToPrimaryPane();
    return;
  }
  if (id === now.active) return;
  set({ ...now, active: id, pane: 'main' });
  goToPrimaryPane();
}

// pinned tabs come first, in the order they were pinned
function pinnedFirst(tabs: Tab[]): Tab[] {
  return [...tabs.filter((tab) => tab.pinned), ...tabs.filter((tab) => !tab.pinned)];
}

export function setTabPinned(id: string, pinned: boolean): void {
  const now = current();
  if (!now.tabs.some((tab) => tab.id === id)) return;
  const tabs = now.tabs.map((tab): Tab => {
    if (tab.id !== id) return tab;
    const { pinned: _was, ...rest } = tab;
    return pinned ? { ...rest, pinned: true } : rest;
  });
  // a newly pinned tab goes after the others, an unpinned one right after the last pinned
  const moved = tabs.find((tab) => tab.id === id)!;
  const others = tabs.filter((tab) => tab.id !== id);
  const at = others.filter((tab) => tab.pinned).length;
  others.splice(at, 0, moved);
  set({ ...now, tabs: pinnedFirst(others) });
}

export function closeTab(id = current().active): void {
  const now = current();
  if (now.tabs.length <= 1) return;
  const index = now.tabs.findIndex((tab) => tab.id === id);
  if (index === -1 || now.tabs[index]!.pinned) return;
  const tabs = now.tabs.filter((tab) => tab.id !== id);
  const closed = [...now.closed, now.tabs[index]!.hash].slice(-MAX_CLOSED);
  if (id !== now.active) {
    set({ ...now, tabs, closed });
    goToPrimaryPane();
    return;
  }
  const next = tabs[Math.min(index, tabs.length - 1)]!;
  set({ ...now, tabs, active: next.id, pane: 'main', closed });
  goToPrimaryPane();
}

export function closeOtherTabs(id = current().active): void {
  const now = current();
  const keep = now.tabs.find((tab) => tab.id === id);
  if (!keep) return;
  // pinned tabs stay open
  const gone = now.tabs.filter((tab) => tab.id !== id && !tab.pinned);
  const tabs = now.tabs.filter((tab) => tab.id === id || tab.pinned);
  const closed = [...now.closed, ...gone.map((tab) => tab.hash)];
  set({ ...now, tabs, active: id, pane: 'main', closed: closed.slice(-MAX_CLOSED) });
  goToPrimaryPane();
}

export function closeTabsToRight(id = current().active): void {
  const now = current();
  const index = now.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return;
  const gone = now.tabs.slice(index + 1).filter((tab) => !tab.pinned);
  if (gone.length === 0) return;
  const tabs = now.tabs.filter((tab) => !gone.includes(tab));
  const closed = [...now.closed, ...gone.map((tab) => tab.hash)].slice(-MAX_CLOSED);
  const stays = tabs.some((tab) => tab.id === now.active);
  set({ ...now, tabs, closed, active: stays ? now.active : id, pane: stays ? now.pane : 'main' });
  goToPrimaryPane();
}

export function reopenClosedTab(): void {
  const now = current();
  const hash = now.closed[now.closed.length - 1];
  if (!hash) return;
  set({ ...now, closed: now.closed.slice(0, -1) });
  openTab(hash);
}

export function stepTab(direction: 1 | -1): void {
  const now = current();
  if (now.tabs.length <= 1) return;
  const index = now.tabs.findIndex((tab) => tab.id === now.active);
  activateTab(now.tabs[(index + direction + now.tabs.length) % now.tabs.length]!.id);
}

// the ninth asks for the last tab, like a browser
export function activateTabAt(position: number): void {
  const tabs = current().tabs;
  const tab = position >= 9 ? tabs[tabs.length - 1] : tabs[position - 1];
  if (tab) activateTab(tab.id);
}

export function moveTab(id: string, to: number): void {
  const now = current();
  const tab = now.tabs.find((item) => item.id === id);
  if (!tab) return;
  const tabs = now.tabs.filter((item) => item.id !== id);
  tabs.splice(Math.max(0, Math.min(tabs.length, to)), 0, tab);
  // a tab can be dragged among its own kind, pinned ones stay ahead of the rest
  set({ ...now, tabs: pinnedFirst(tabs) });
}

export function useTabs(): TabState {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, current);
}

export function subscribeTabs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getTabs(): TabState {
  return current();
}

// which side of the split a view is drawn in
export const PaneContext = createContext<PaneId>('main');
export const PaneTabContext = createContext<string | null>(null);

export function usePane(): PaneId {
  const contextPane = useContext(PaneContext);
  return resolvePaneId(contextPane) ?? contextPane;
}

export function usePaneTabContextId(): string | null {
  return useContext(PaneTabContext);
}

export function usePaneTabId(): string | null {
  const contextTabId = usePaneTabContextId();
  const pane = usePane();
  if (contextTabId !== null) return contextTabId;
  return assignedTabForPane(pane)?.id ?? null;
}
