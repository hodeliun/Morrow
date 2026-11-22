// tabs remember a place each, like a browser: the open tab follows wherever you go.
// a tab can be split in two, each side with its own back and forward history
import { createContext, useContext, useSyncExternalStore } from 'react';
import {
  allocateSideInstanceId,
  DEFAULT_SPLIT_RATIO,
  isSideInstanceIdFor,
  migrateLegacySplit,
  visiblePaneLeaves,
} from './paneLayout';
import type { PaneLayout, PaneLeaf, PaneNode, PaneTabInstance } from './paneLayout';
import { PANE_TABS_STORAGE_KEY, readPaneTabsSnapshot } from './paneLayoutStorage';
import type { CurrentTabsSnapshot, LegacyTabsSnapshot } from './paneLayoutStorage';
import { getPreferences } from './platform/preferences';

export type PaneId = 'main' | 'side';

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
  pane: PaneId;
  // recently closed tabs, newest last, so they can be opened again
  closed: string[];
  // The pane layout is the sole runtime source for tab instances, visible leaves, and focus.
  layout: PaneLayout<PaneTabInstance<string>>;
  // A >20-instance fork snapshot keeps an ordinary, bounded temporary tab strip in memory.
  projectionIds: readonly string[] | null;
  // Fork layouts keep their canonical instance order while the in-memory tab strip can evolve.
  projectionOrder: readonly string[] | null;
  // Legacy tabs use one dynamic two-pane tree; fork snapshots retain their own full tree.
  projectionKind: 'legacy-two-pane' | 'fork-layout';
  // Fork v2, malformed and future snapshots stay byte-exact until a lossless writer is available.
  persistenceWritable: boolean;
  // Raw value observed during load or the last successful write; prevents overwriting another window.
  observedStorageRaw: string | null;
}

const MAX_TABS = 20;
const MAX_HISTORY = 50;
const MAX_CLOSED = 10;
const LAYOUT_ID = 'morrow-pane-layout';
const listeners = new Set<() => void>();
let counter = 0;
const newTabId = () => `t${Date.now().toString(36)}${(counter++).toString(36)}`;

type PaneLayoutState = PaneLayout<PaneTabInstance<string>>;

interface PanePair {
  readonly main: PaneTabInstance<string>;
  readonly side: PaneTabInstance<string>;
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

function compatibilityTab(pair: PanePair): Tab {
  return {
    id: pair.main.id,
    hash: pair.main.target,
    back: [...pair.main.back],
    forward: [...pair.main.forward],
    side: { hash: pair.side.target, back: [...pair.side.back], forward: [...pair.side.forward] },
    ...(pair.main.pinned || pair.side.pinned ? { pinned: true } : {}),
  };
}

function projectTabs(layout: PaneLayoutState, projectionIds: readonly string[] | null = null): Tab[] {
  const projected: Tab[] = [];
  const consumed = new Set<string>();
  for (const instance of layout.tabs) {
    if (consumed.has(instance.id)) continue;
    const pair = pairForInstance(layout.tabs, instance);
    if (pair) {
      projected.push(compatibilityTab(pair));
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

function stateFromLayout(
  layout: PaneLayoutState,
  closed: readonly string[],
  persistenceWritable: boolean,
  observedStorageRaw: string | null,
  previousActive = '',
  projectionIds: readonly string[] | null = null,
  projectionKind: TabState['projectionKind'] = 'legacy-two-pane',
  projectionOrder?: readonly string[] | null,
): TabState {
  const focused = focusedInstance(layout);
  const focusedProjection = focused ? projectionIdentity(layout, focused) : null;
  const defaultOrder = projectionKind === 'fork-layout' ? projectTabs(layout).map((tab) => tab.id) : null;
  const effectiveProjectionOrder = projectionOrder === undefined ? defaultOrder : projectionOrder;
  const allTabs = effectiveProjectionOrder
    ? projectTabs(layout, effectiveProjectionOrder)
    : projectTabs(layout);
  const fallbackActive =
    focusedProjection?.id ??
    (allTabs.some((tab) => tab.id === previousActive) ? previousActive : (allTabs[0]?.id ?? ''));
  const visibleProjectionIds = projectionIds ?? (allTabs.length > MAX_TABS ? [fallbackActive] : null);
  const tabs = visibleProjectionIds === null ? allTabs : projectTabs(layout, visibleProjectionIds);
  const active =
    focusedProjection && tabs.some((tab) => tab.id === focusedProjection.id)
      ? focusedProjection.id
      : tabs.some((tab) => tab.id === previousActive)
        ? previousActive
        : (tabs[0]?.id ?? '');
  const activeTab = tabs.find((tab) => tab.id === active);
  const pane = focusedProjection?.pane === 'side' && activeTab?.side ? 'side' : 'main';
  return {
    tabs,
    active,
    pane,
    layout,
    projectionIds: visibleProjectionIds,
    projectionOrder: effectiveProjectionOrder,
    projectionKind,
    closed: [...closed].slice(-MAX_CLOSED),
    persistenceWritable,
    observedStorageRaw,
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
): PaneLayoutState {
  const exact = layout.tabs.find((tab) => tab.id === activeId);
  if (!exact) return layout;
  const pair = pairForInstance(layout.tabs, exact);
  const main = pair?.main ?? exact;
  const side = pair?.side ?? null;
  let next = clearMissingAssignments(layout);
  let leaves = visiblePaneLeaves(next);
  let mainLeaf = leaves.find((leaf) => leaf.tabId === main.id) ?? leaves[0];
  if (!mainLeaf) return next;
  let sideLeaf = side ? leaves.find((leaf) => leaf.tabId === side.id && leaf.id !== mainLeaf!.id) : undefined;

  if (side && !sideLeaf && leaves.length === 1) {
    next = splitSinglePane(next, mainLeaf, main.id, side.id);
    leaves = visiblePaneLeaves(next);
    const splitMainLeaf = leaves.find((leaf) => leaf.tabId === main.id) ?? leaves[0];
    if (!splitMainLeaf) return next;
    mainLeaf = splitMainLeaf;
    sideLeaf = leaves.find((leaf) => leaf.id !== splitMainLeaf.id && leaf.tabId === side.id);
  }
  if (side && !sideLeaf) {
    sideLeaf =
      leaves.find((leaf) => leaf.id !== mainLeaf!.id && leaf.tabId === null) ??
      leaves.find((leaf) => leaf.id !== mainLeaf!.id);
  }

  const updates = new Map<string, string | null>();
  for (const leaf of leaves) {
    if (
      (leaf.tabId === main.id && leaf.id !== mainLeaf.id) ||
      (side && leaf.tabId === side.id && leaf.id !== sideLeaf?.id) ||
      // In the legacy runtime, a lone tab has no visible side; keep its former side instance
      // in layout.tabs but detach it from the two-pane projection so it can return later.
      (!side && projectionKind === 'legacy-two-pane' && leaf.id !== mainLeaf.id && leaf.tabId !== null)
    ) {
      updates.set(leaf.id, null);
    }
  }
  updates.set(mainLeaf.id, main.id);
  if (side && sideLeaf) updates.set(sideLeaf.id, side.id);
  const root = replaceLeafAssignments(next.root, updates);
  const focusPane = requestedPane === 'side' && side && sideLeaf ? sideLeaf.id : mainLeaf.id;
  return {
    ...next,
    root,
    focusedPaneId: focusPane,
  };
}

function applyLaunchHash(layout: PaneLayoutState, activeId: string, hash: string): PaneLayoutState {
  const exact = layout.tabs.find((tab) => tab.id === activeId);
  if (!exact) return layout;
  const pair = pairForInstance(layout.tabs, exact);
  const target = pair?.main ?? exact;
  if (target.target === hash) return layout;
  const updated = {
    ...target,
    target: hash,
    back: [...target.back, target.target].slice(-MAX_HISTORY),
  };
  return { ...layout, tabs: layout.tabs.map((tab) => (tab.id === target.id ? updated : tab)) };
}

function initialState(
  hash: string,
  persistenceWritable: boolean,
  observedStorageRaw: string | null,
): TabState {
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
  const started = applyLaunchHash(layout, snapshot.active, hash);
  return stateFromLayout(started, snapshot.closed, true, raw, snapshot.active, null, 'legacy-two-pane');
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
  const projected = layoutForProjection(snapshot.layout, identity.id, identity.pane, 'fork-layout');
  const launched = applyLaunchHash(projected, identity.id, hash);
  return stateFromLayout(launched, snapshot.closed, false, raw, identity.id, null, 'fork-layout');
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

function set(next: TabState): void {
  const previous = current();
  const preserveExistingOrder =
    previous.projectionIds !== null ||
    (previous.projectionKind === 'fork-layout' && !projectedOrderChanged(previous.tabs, next.tabs));
  let layout = updateLayoutFromProjection(next.layout, previous.tabs, next.tabs, preserveExistingOrder);
  layout = layoutForProjection(layout, next.active, next.pane, next.projectionKind);
  let committed = stateFromLayout(
    layout,
    next.closed,
    next.persistenceWritable,
    next.observedStorageRaw,
    next.active,
    previous.projectionIds === null ? null : next.tabs.map((tab) => tab.id),
    next.projectionKind,
    previous.projectionKind === 'fork-layout' && previous.projectionIds === null
      ? next.tabs.map((tab) => tab.id)
      : null,
  );
  if (committed.persistenceWritable) {
    const serialized = JSON.stringify({
      tabs: committed.tabs,
      active: committed.active,
      pane: committed.pane,
      closed: committed.closed,
    });
    try {
      const currentRaw = localStorage.getItem(PANE_TABS_STORAGE_KEY);
      if (currentRaw !== committed.observedStorageRaw) {
        committed = { ...committed, persistenceWritable: false };
      } else {
        try {
          localStorage.setItem(PANE_TABS_STORAGE_KEY, serialized);
          committed = { ...committed, observedStorageRaw: serialized };
        } catch {
          // not remembering tabs is harmless
        }
      }
    } catch {
      // A failed read cannot prove that the stored value is still the one loaded here.
      committed = { ...committed, persistenceWritable: false };
    }
  }
  state = committed;
  for (const listener of listeners) listener();
}

const activeTab = (now = current()): Tab => now.tabs.find((tab) => tab.id === now.active) ?? now.tabs[0]!;

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

function visit(pane: PaneHistory, hash: string, replace: boolean): PaneHistory {
  if (pane.hash === hash) return pane;
  if (replace) return { ...pane, hash };
  return { hash, back: [...pane.back, pane.hash].slice(-MAX_HISTORY), forward: [] };
}

// a mouse's back button can reach the app both as a button press and as a window app command. whichever
// comes first moves, the other one for the same press is let go
let lastNavigation = 0;
export function claimNavigation(): boolean {
  if (Date.now() - lastNavigation < 400) return false;
  lastNavigation = Date.now();
  return true;
}

export function startTabs(): () => void {
  current();
  const onHash = () => {
    const hash = window.location.hash || '#/';
    const tab = activeTab();
    const expected = arriving === hash;
    arriving = null;
    if (tab.hash === hash) return;
    updateActive((item) => (expected ? { ...item, hash } : { ...item, ...visit(item, hash, false) }));
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
  window.addEventListener('click', onClick, true);
  window.addEventListener('auxclick', onClick, true);
  window.addEventListener('mousedown', onMouseButton, true);
  window.addEventListener('mouseup', onMouseButton, true);
  window.addEventListener('keydown', onKey, true);
  return () => {
    window.removeEventListener('hashchange', onHash);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('auxclick', onClick, true);
    window.removeEventListener('mousedown', onMouseButton, true);
    window.removeEventListener('mouseup', onMouseButton, true);
    window.removeEventListener('keydown', onKey, true);
  };
}

function paneAt(target: EventTarget | null): PaneId {
  const element = target instanceof Element ? target.closest<HTMLElement>('[data-pane]') : null;
  return element?.dataset.pane === 'side' ? 'side' : element ? 'main' : current().pane;
}

// where navigation goes: the side of a split tab when that side was used last
export function targetPane(): PaneId {
  const now = current();
  return now.pane === 'side' && activeTab(now).side ? 'side' : 'main';
}

// the hash shown in the pane navigation goes to
export function activeHash(): string {
  const pane = targetPane();
  return pane === 'main' ? window.location.hash || routeHashForPane('main') : routeHashForPane('side');
}

export function routeHashForPane(pane: PaneId): string {
  const now = current();
  const projected = now.tabs.find((tab) => tab.id === now.active) ?? now.tabs[0];
  if (!projected) return '#/';
  const instance = now.layout.tabs.find((tab) => tab.id === projected.id);
  if (!instance) return '#/';
  const pair = pairForInstance(now.layout.tabs, instance);
  if (pair) return pane === 'side' ? pair.side.target : pair.main.target;
  return pane === 'main' ? instance.target : '#/';
}

export function setActivePane(pane: PaneId): void {
  const now = current();
  const next = pane === 'side' && activeTab(now).side ? 'side' : 'main';
  if (now.pane !== next) set({ ...now, pane: next });
}

// shows a place in the main side, replacing keeps back and forward as they are. a pinned tab keeps its
// place, anywhere else it goes opens in a new tab beside it
export function showInMain(hash: string, replace = false): void {
  if (window.location.hash === hash) return;
  const place = (value: string) => (value || '#/').split('?')[0];
  if (!replace && activeTab().pinned && place(hash) !== place(activeTab().hash)) {
    openTab(hash);
    return;
  }
  if (!replace) {
    window.location.hash = hash;
    return;
  }
  updateActive((item) => ({ ...item, hash }));
  history.replaceState(null, '', hash);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

// shows a place in the side of the split, used by navigation while that side is active
export function showInSide(hash: string, replace = false): void {
  const tab = activeTab();
  if (!tab.side) return;
  updateActive((item) => ({ ...item, side: visit(item.side!, hash, replace) }));
}

// splits the tab, the new side shows the given place and becomes where navigation goes
export function openSide(hash = activeHash()): void {
  updateActive((item) => ({ ...item, side: { hash, back: [], forward: [] } }), { pane: 'side' });
}

export function closeSide(): void {
  if (!activeTab().side) return;
  updateActive((item) => ({ ...item, side: null }), { pane: 'main' });
}

export function swapSides(): void {
  const tab = activeTab();
  if (!tab.side) return;
  const main: PaneHistory = { hash: tab.hash, back: tab.back, forward: tab.forward };
  const side = tab.side;
  updateActive((item) => ({ ...item, ...side, side: main }));
  go(side.hash);
}

function paneOf(tab: Tab, pane: PaneId): PaneHistory | null {
  return pane === 'side' ? tab.side : tab;
}

export function canGo(tab: Tab, pane: PaneId, direction: 'back' | 'forward'): boolean {
  return (paneOf(tab, pane)?.[direction].length ?? 0) > 0;
}

function step(pane: PaneId, direction: 'back' | 'forward'): void {
  const tab = activeTab();
  const history = paneOf(tab, pane);
  if (!history || history[direction].length === 0) return;
  const list = [...history[direction]];
  const hash = list.pop()!;
  const left = [...(direction === 'back' ? history.forward : history.back), history.hash].slice(-MAX_HISTORY);
  const moved: PaneHistory =
    direction === 'back' ? { hash, back: list, forward: left } : { hash, back: left, forward: list };
  if (pane === 'side') {
    updateActive((item) => ({ ...item, side: moved }), { pane: 'side' });
    return;
  }
  updateActive((item) => ({ ...item, ...moved }), { pane: 'main' });
  go(hash);
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
  set({ ...now, tabs, active: tab.id, pane: 'main' });
  go(hash);
}

export function activateTab(id: string): void {
  const now = current();
  const tab = now.tabs.find((item) => item.id === id);
  if (!tab || id === now.active) return;
  set({ ...now, active: id, pane: 'main' });
  go(tab.hash);
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
    return;
  }
  const next = tabs[Math.min(index, tabs.length - 1)]!;
  set({ ...now, tabs, active: next.id, pane: 'main', closed });
  go(next.hash);
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
  go(keep.hash);
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
  if (!stays) go(tabs.find((tab) => tab.id === id)!.hash);
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

export function usePane(): PaneId {
  return useContext(PaneContext);
}
