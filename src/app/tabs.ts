import { createContext, useContext, useSyncExternalStore } from 'react';
import {
  applyPanePreset,
  availablePaneTabs,
  beginPaneResize as beginPaneResizeModel,
  cancelPaneResize as cancelPaneResizeModel,
  closePane,
  createPaneLayout,
  focusPane,
  migrateLegacySplit,
  movePaneTab,
  previewPaneResize as previewPaneResizeModel,
  removePaneTabs,
  resetPaneSplit,
  swapPaneTabs,
  visiblePaneLeaves,
} from './paneLayout';
import type { PaneLayout, PanePreset, PaneResizeSession, PaneTabInstance } from './paneLayout';
import { forgetTabScrollPositions } from './tabScroll';
import {
  MAX_PANE_TAB_INSTANCES,
  PANE_TABS_STORAGE_KEY,
  persistPaneTabsSnapshot,
  readPaneTabsSnapshot,
} from './paneLayoutStorage';
import { getPreferences, setPreferences } from './platform/preferences';

export type PaneId = string;
type PaneTab = PaneTabInstance<string>;
type PaneLayoutState = PaneLayout<PaneTab>;

export interface PaneHistory {
  readonly hash: string;
  readonly back: readonly string[];
  readonly forward: readonly string[];
}

// Compatibility projection for existing tab controls while routes migrate to pane instances.
export interface Tab extends PaneTab {
  readonly hash: string;
  readonly side: PaneHistory | null;
}

export interface TabState {
  readonly tabs: readonly Tab[];
  // Most recently selected item; when the focused leaf is occupied this equals its tabId.
  readonly active: string;
  // Stable ID of the leaf receiving implicit navigation.
  readonly pane: PaneId;
  readonly layout: PaneLayoutState;
  // Recently closed routes, newest last, for the existing reopen command.
  readonly closed: readonly string[];
  // Invalid or future persisted state is left untouched; this window remains memory-only.
  readonly persistenceWritable: boolean;
}

const KEY = PANE_TABS_STORAGE_KEY;
const LAYOUT_ID = 'morrow-pane-layout';
const MAX_TAB_GROUPS = 20;
const MAX_HISTORY = 50;
const MAX_CLOSED = 10;
const EMPTY_HASH = '#/';
const listeners = new Set<() => void>();
let counter = 0;
let state: TabState | null = null;
let arriving: string | null = null;
let lastNavigation = 0;

const newTabId = (used: ReadonlySet<string> = new Set()): string => {
  let id: string;
  do id = `t${Date.now().toString(36)}${(counter++).toString(36)}`;
  while (used.has(id));
  return id;
};

function emptyTab(id: string, target: string, groupId = id): PaneTab {
  return { id, groupId, target, back: [], forward: [] };
}

function paneLeaf(layout: PaneLayoutState, paneId: PaneId) {
  return visiblePaneLeaves(layout).find((leaf) => leaf.id === paneId) ?? null;
}

function tabForLeaf(layout: PaneLayoutState, paneId: PaneId): PaneTab | null {
  const tabId = paneLeaf(layout, paneId)?.tabId;
  return tabId ? (layout.tabs.find((tab) => tab.id === tabId) ?? null) : null;
}

function projectTabViews(layout: PaneLayoutState): Tab[] {
  const legacyPairs = new Map<string, { main: PaneTab; side: PaneTab }>();
  for (const tab of layout.tabs) {
    const group = layout.tabs.filter((item) => item.groupId === tab.groupId);
    const main = group.find((item) => item.id === item.groupId);
    const side = group.find((item) => item.id !== item.groupId && item.id.startsWith(`${item.groupId}:side`));
    if (group.length === 2 && main && side) legacyPairs.set(tab.groupId, { main, side });
  }
  return layout.tabs.map((tab) => {
    const pair = legacyPairs.get(tab.groupId);
    const sibling = pair ? (tab.id === pair.main.id ? pair.side : pair.main) : null;
    return {
      ...tab,
      hash: tab.target,
      side: sibling ? { hash: sibling.target, back: sibling.back, forward: sibling.forward } : null,
    };
  });
}

function stateFromLayout(
  layout: PaneLayoutState,
  closed: readonly string[],
  persistenceWritable: boolean,
  previousActive = '',
): TabState {
  const tabs = projectTabViews(layout);
  const active =
    tabForLeaf(layout, layout.focusedPaneId)?.id ??
    (tabs.some((tab) => tab.id === previousActive) ? previousActive : (tabs[0]?.id ?? ''));
  return {
    tabs,
    active,
    pane: layout.focusedPaneId,
    layout,
    closed: closed.slice(-MAX_CLOSED),
    persistenceWritable,
  };
}

function writeState(next: TabState, persist = true): void {
  state = next;
  if (persist && next.persistenceWritable) {
    try {
      persistPaneTabsSnapshot(localStorage, next.layout, next.closed, true);
    } catch {
      // A private or unavailable storage area leaves this window usable in memory.
    }
  }
  for (const listener of listeners) listener();
}

function visit(tab: PaneTab, target: string, replace: boolean): PaneTab {
  if (tab.target === target) return tab;
  if (replace) return { ...tab, target };
  return {
    ...tab,
    target,
    back: [...tab.back, tab.target].slice(-MAX_HISTORY),
    forward: [],
  };
}

function replaceTab(layout: PaneLayoutState, tabId: string, nextTab: PaneTab): PaneLayoutState {
  if (!layout.tabs.some((tab) => tab.id === tabId)) return layout;
  const tabs = layout.tabs.map((tab) => (tab.id === tabId ? nextTab : tab));
  return { ...layout, tabs };
}

function tabIdSet(layout: PaneLayoutState): Set<string> {
  return new Set(layout.tabs.map((tab) => tab.id));
}

function readCurrentHash(): string {
  return window.location.hash || EMPTY_HASH;
}

function replaceBrowserHash(hash: string): void {
  if (!hash || window.location.hash === hash || (hash === EMPTY_HASH && !window.location.hash)) return;
  try {
    window.history.replaceState(null, '', hash);
  } catch {
    // The in-memory pane state remains authoritative if the host rejects a URL replacement.
  }
}

function go(hash: string): void {
  if (window.location.hash === hash || (hash === EMPTY_HASH && !window.location.hash)) return;
  arriving = hash;
  window.location.hash = hash;
}

function initialState(hash: string, persistenceWritable: boolean): TabState {
  const id = newTabId();
  const layout = createPaneLayout(LAYOUT_ID, [emptyTab(id, hash)], id) as PaneLayoutState;
  return stateFromLayout(layout, [], persistenceWritable);
}

function load(): TabState {
  const here = readCurrentHash();
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return initialState(here, false);
  }

  const snapshot = readPaneTabsSnapshot(raw);
  if (snapshot.kind === 'empty') return initialState(here, true);
  if (snapshot.kind === 'current') {
    const restored = stateFromLayout(snapshot.snapshot.layout, snapshot.snapshot.closed, true);
    const focused = tabForLeaf(restored.layout, restored.pane);
    if (focused) replaceBrowserHash(focused.target);
    return restored;
  }
  if (snapshot.kind === 'legacy') {
    const layout = migrateLegacySplit(LAYOUT_ID, snapshot.snapshot, getPreferences().splitShare);
    const activeMainId = snapshot.snapshot.active;
    const main = layout.tabs.find((tab) => tab.id === activeMainId);
    const reconciled =
      main && main.target !== here ? replaceTab(layout, main.id, visit(main, here, false)) : layout;
    const migrated = stateFromLayout(reconciled, snapshot.snapshot.closed, true);
    try {
      persistPaneTabsSnapshot(localStorage, migrated.layout, migrated.closed, true);
    } catch {
      // Keep the validated in-memory migration; the legacy payload remains available if storage fails.
    }
    const focused = tabForLeaf(migrated.layout, migrated.pane);
    if (focused) replaceBrowserHash(focused.target);
    return migrated;
  }

  // A corrupt or future payload must never be silently replaced by a fresh default.
  return initialState(here, false);
}

const current = (): TabState => (state ??= load());

function makeStateWithLayout(
  now: TabState,
  layout: PaneLayoutState,
  closed = now.closed,
  active = now.active,
): TabState {
  return stateFromLayout(layout, closed, now.persistenceWritable, active);
}

export function getTabForPane(paneId: PaneId, tabs = current()): PaneTab | null {
  return tabForLeaf(tabs.layout, paneId);
}

export function getVisiblePanes(tabs = current()) {
  return visiblePaneLeaves(tabs.layout);
}

export function getAvailableTabs(tabs = current()): readonly PaneTab[] {
  return availablePaneTabs(tabs.layout);
}

export function routeHashForPane(paneId: PaneId, tabs = current()): string {
  return getTabForPane(paneId, tabs)?.target ?? EMPTY_HASH;
}

export function routeHashForTabId(
  tabId: string,
  tabs: readonly { readonly id: string; readonly target: string }[] = current().layout.tabs,
): string {
  return tabs.find((tab) => tab.id === tabId)?.target ?? EMPTY_HASH;
}

export function paneIdForTabId(tabId: string, tabs = current()): PaneId {
  const leaves = visiblePaneLeaves(tabs.layout);
  const assigned = leaves.find((leaf) => leaf.tabId === tabId);
  if (assigned) return assigned.id;

  // A cached host has no visible destination; don't let its callbacks address a pane another tab took over.
  const visibleIds = new Set(leaves.map((leaf) => leaf.id));
  const cacheKey = Array.from(tabId, (character) => character.codePointAt(0)!.toString(16)).join('-');
  let cachedId = `morrow-cached-pane:${cacheKey}`;
  while (visibleIds.has(cachedId)) cachedId += ':hidden';
  return cachedId;
}

function activeTab(now = current()): PaneTab | null {
  return getTabForPane(now.pane, now) ?? now.tabs.find((tab) => tab.id === now.active) ?? now.tabs[0] ?? null;
}

function makeAvailableTab(layout: PaneLayoutState, target: string): PaneTab | null {
  if (layout.tabs.length >= MAX_PANE_TAB_INSTANCES) return null;
  const id = newTabId(tabIdSet(layout));
  const groupIds = new Set(layout.tabs.map((tab) => tab.groupId));
  const active = layout.tabs.find((tab) => tab.id === activeTab(current())?.id);
  const groupId = groupIds.size < MAX_TAB_GROUPS ? id : (active?.groupId ?? layout.tabs[0]?.groupId ?? id);
  return emptyTab(id, target, groupId);
}

function insertAfterActive(tabs: readonly PaneTab[], activeId: string, tab: PaneTab): PaneTab[] {
  const next = [...tabs];
  const index = next.findIndex((item) => item.id === activeId);
  next.splice(index < 0 ? next.length : index + 1, 0, tab);
  return next;
}

function mirrorFocusedTarget(next: TabState, replace = false): void {
  const tab = getTabForPane(next.pane, next);
  if (tab) {
    if (replace) replaceBrowserHash(tab.target);
    else go(tab.target);
  }
}

export function claimNavigation(): boolean {
  if (Date.now() - lastNavigation < 400) return false;
  lastNavigation = Date.now();
  return true;
}

export function startTabs(): () => void {
  current();
  const onHash = () => {
    const hash = readCurrentHash();
    const expected = arriving === hash;
    arriving = null;
    if (expected) return;

    const now = current();
    const tab = getTabForPane(now.pane, now);
    if (tab) {
      if (tab.target === hash) return;
      const layout = replaceTab(now.layout, tab.id, visit(tab, hash, false));
      writeState(makeStateWithLayout(now, layout));
      return;
    }
    showInPane(hash, now.pane);
  };

  // Ctrl/Cmd click opens a new tab; Alt click explicitly fills another pane.
  const onClick = (event: MouseEvent) => {
    const newTab =
      event.type === 'auxclick' ? event.button === 1 : event.button === 0 && (event.ctrlKey || event.metaKey);
    const toPane =
      event.type === 'click' && event.button === 0 && event.altKey && !event.ctrlKey && !event.metaKey;
    if (!newTab && !toPane) return;
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-page-id]');
    const id = target?.dataset.pageId;
    if (!id || target.closest('.tab-bar')) return;
    event.preventDefault();
    event.stopPropagation();
    const hash = `#/page/${encodeURIComponent(id)}`;
    if (newTab) openTab(hash);
    else openSide(hash);
  };
  const onMouseButton = (event: MouseEvent) => {
    if (event.button !== 3 && event.button !== 4) return;
    event.preventDefault();
    if (event.type !== 'mouseup' || !claimNavigation()) return;
    const pane = paneAt(event.target);
    setActivePane(pane);
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
  return element?.dataset.pane ?? current().pane;
}

export function targetPane(): PaneId {
  return current().layout.focusedPaneId;
}

export function activeHash(): string {
  return routeHashForPane(targetPane());
}

export function setActivePane(pane: PaneId): void {
  const now = current();
  const layout = focusPane(now.layout, pane);
  if (layout === now.layout) return;
  const next = makeStateWithLayout(now, layout);
  writeState(next);
  mirrorFocusedTarget(next, true);
}

export function showInPane(hash: string, pane = targetPane(), replace = false): void {
  const now = current();
  if (!paneLeaf(now.layout, pane)) return;

  let layout = now.layout;
  let tab = getTabForPane(pane, now);
  if (!tab) {
    tab = makeAvailableTab(layout, hash);
    if (tab) {
      layout = { ...layout, tabs: insertAfterActive(layout.tabs, now.active, tab) };
    } else {
      tab = availablePaneTabs(layout)[0] ?? null;
      if (!tab) return;
      layout = replaceTab(layout, tab.id, visit(tab, hash, replace));
    }
    if (!layout.tabs.some((item) => item.id === tab!.id)) layout = { ...layout, tabs: [...layout.tabs, tab] };
    layout = movePaneTab(layout, tab.id, pane);
  } else {
    layout = replaceTab(layout, tab.id, visit(tab, hash, replace));
  }
  layout = focusPane(layout, pane);
  const next = makeStateWithLayout(now, layout, now.closed, tab.id);
  writeState(next);
  if (next.pane === pane) {
    if (replace) replaceBrowserHash(hash);
    else go(hash);
  }
}

export function setPanePreset(preset: PanePreset): void {
  const now = current();
  const layout = applyPanePreset(now.layout, preset);
  if (layout === now.layout) return;
  const next = makeStateWithLayout(now, layout);
  writeState(next);
  mirrorFocusedTarget(next, true);
}

export function openSide(hash?: string): void {
  let now = current();
  let layout = now.layout;
  if (visiblePaneLeaves(layout).length === 1) layout = applyPanePreset(layout, 'two-columns');
  const target = visiblePaneLeaves(layout).find((leaf) => leaf.id !== now.pane && leaf.tabId === null);
  if (!target) return;
  layout = focusPane(layout, target.id);
  if (layout !== now.layout) {
    now = makeStateWithLayout(now, layout);
    writeState(now);
  }
  if (hash !== undefined) showInPane(hash, target.id);
  else mirrorFocusedTarget(now, true);
}

export function closeSide(): void {
  const now = current();
  if (visiblePaneLeaves(now.layout).length <= 1) return;
  const layout = closePane(now.layout, now.pane);
  if (layout === now.layout) return;
  const next = makeStateWithLayout(now, layout);
  writeState(next);
  mirrorFocusedTarget(next, true);
}

export function swapSides(): void {
  const now = current();
  const leaves = visiblePaneLeaves(now.layout);
  if (leaves.length < 2) return;
  const layout = swapPaneTabs(now.layout, leaves[0]!.id, leaves[1]!.id);
  if (layout === now.layout) return;
  const next = makeStateWithLayout(now, layout);
  writeState(next);
  mirrorFocusedTarget(next, true);
}

export function canGo(
  tab: Pick<PaneTab, 'id' | 'back' | 'forward'>,
  pane: PaneId,
  direction: 'back' | 'forward',
): boolean {
  const assigned = getTabForPane(pane);
  return assigned?.id === tab.id && tab[direction].length > 0;
}

function step(pane: PaneId, direction: 'back' | 'forward'): void {
  const now = current();
  const tab = getTabForPane(pane, now);
  if (!tab || tab[direction].length === 0) return;
  const list = [...tab[direction]];
  const target = list.pop()!;
  const opposite = direction === 'back' ? tab.forward : tab.back;
  const updated: PaneTab =
    direction === 'back'
      ? { ...tab, target, back: list, forward: [...opposite, tab.target].slice(-MAX_HISTORY) }
      : { ...tab, target, back: [...opposite, tab.target].slice(-MAX_HISTORY), forward: list };
  const layout = replaceTab(now.layout, tab.id, updated);
  const next = makeStateWithLayout(now, layout, now.closed, tab.id);
  writeState(next);
  if (pane === next.pane) go(target);
}

export function goBack(pane: PaneId = targetPane()): void {
  step(pane, 'back');
}

export function goForward(pane: PaneId = targetPane()): void {
  step(pane, 'forward');
}

export function openTab(hash = EMPTY_HASH): void {
  const now = current();
  const groups = new Set(now.tabs.map((tab) => tab.groupId));
  const tab = groups.size < MAX_TAB_GROUPS ? makeAvailableTab(now.layout, hash) : null;
  if (!tab) {
    showInPane(hash, now.pane);
    return;
  }
  let layout: PaneLayoutState = { ...now.layout, tabs: insertAfterActive(now.layout.tabs, now.active, tab) };
  layout = movePaneTab(layout, tab.id, now.pane);
  const next = makeStateWithLayout(now, layout, now.closed, tab.id);
  writeState(next);
  go(hash);
}

export function activateTab(id: string): void {
  const now = current();
  const tab = now.tabs.find((item) => item.id === id);
  if (!tab) return;
  const alreadyVisible = visiblePaneLeaves(now.layout).find((leaf) => leaf.tabId === id);
  const layout = alreadyVisible
    ? focusPane(now.layout, alreadyVisible.id)
    : movePaneTab(now.layout, id, now.pane);
  if (layout === now.layout) return;
  const next = makeStateWithLayout(now, layout, now.closed, id);
  writeState(next);
  mirrorFocusedTarget(next, true);
}

function nextAfterRemoval(now: TabState, layout: PaneLayoutState, index: number): PaneLayoutState {
  const nextTab = layout.tabs[Math.min(index, layout.tabs.length - 1)];
  if (!nextTab) return layout;
  const existingPane = visiblePaneLeaves(layout).find((leaf) => leaf.tabId === nextTab.id);
  if (existingPane) return focusPane(layout, existingPane.id);
  return movePaneTab(layout, nextTab.id, now.pane);
}

function closedWith(now: TabState, tabs: readonly Pick<PaneTab, 'target'>[]): string[] {
  return [...now.closed, ...tabs.map((tab) => tab.target)].slice(-MAX_CLOSED);
}

export function closeTab(id = current().active): void {
  const now = current();
  if (now.tabs.length <= 1) return;
  const index = now.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return;
  const removed = now.tabs[index]!;
  const layout = removePaneTabs(now.layout, new Set([id]));
  const isFocused = getTabForPane(now.pane, now)?.id === id || now.active === id;
  const nextLayout = isFocused ? nextAfterRemoval(now, layout, index) : layout;
  const next = makeStateWithLayout(now, nextLayout, closedWith(now, [removed]));
  forgetTabScrollPositions(id);
  writeState(next);
  if (isFocused) mirrorFocusedTarget(next);
}

export function closeOtherTabs(id = current().active): void {
  const now = current();
  const keep = now.tabs.find((tab) => tab.id === id);
  if (!keep) return;
  const removed = now.tabs.filter((tab) => tab.id !== id);
  if (removed.length === 0) return;
  removed.forEach((tab) => forgetTabScrollPositions(tab.id));
  let layout = removePaneTabs(now.layout, new Set(removed.map((tab) => tab.id)));
  const existingPane = visiblePaneLeaves(layout).find((leaf) => leaf.tabId === id);
  layout = existingPane ? focusPane(layout, existingPane.id) : movePaneTab(layout, id, now.pane);
  const next = makeStateWithLayout(now, layout, closedWith(now, removed), id);
  writeState(next);
  mirrorFocusedTarget(next);
}

export function closeTabsToRight(id = current().active): void {
  const now = current();
  const index = now.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return;
  const removed = now.tabs.slice(index + 1);
  if (removed.length === 0) return;
  removed.forEach((tab) => forgetTabScrollPositions(tab.id));
  let layout = removePaneTabs(now.layout, new Set(removed.map((tab) => tab.id)));
  const focused = getTabForPane(now.pane, now);
  const focusedStillExists = focused && layout.tabs.some((tab) => tab.id === focused.id);
  if (!focusedStillExists) {
    const existingPane = visiblePaneLeaves(layout).find((leaf) => leaf.tabId === id);
    layout = existingPane ? focusPane(layout, existingPane.id) : movePaneTab(layout, id, now.pane);
  }
  const next = makeStateWithLayout(
    now,
    layout,
    closedWith(now, removed),
    focusedStillExists ? now.active : id,
  );
  writeState(next);
  if (!focusedStillExists) mirrorFocusedTarget(next);
}

export function reopenClosedTab(): void {
  const now = current();
  const hash = now.closed[now.closed.length - 1];
  if (!hash) return;
  writeState({ ...now, closed: now.closed.slice(0, -1) });
  openTab(hash);
}

export function stepTab(direction: 1 | -1): void {
  const now = current();
  if (now.tabs.length <= 1) return;
  const index = now.tabs.findIndex((tab) => tab.id === now.active);
  activateTab(now.tabs[(index + direction + now.tabs.length) % now.tabs.length]!.id);
}

export function activateTabAt(position: number): void {
  const tabs = current().tabs;
  const tab = position >= 9 ? tabs[tabs.length - 1] : tabs[position - 1];
  if (tab) activateTab(tab.id);
}

export function moveTab(id: string, to: number): void {
  const now = current();
  const tab = now.layout.tabs.find((item) => item.id === id);
  if (!tab) return;
  const tabs = now.layout.tabs.filter((item) => item.id !== id);
  tabs.splice(Math.max(0, Math.min(tabs.length, to)), 0, tab);
  writeState(makeStateWithLayout(now, { ...now.layout, tabs }));
}

export function beginPaneResize(splitId: string): PaneResizeSession | null {
  return beginPaneResizeModel(nowLayout(), splitId);
}

function nowLayout(): PaneLayoutState {
  return current().layout;
}

export function previewPaneResizeSession(session: PaneResizeSession, ratio: number): void {
  const now = current();
  const layout = previewPaneResizeModel(now.layout, session, ratio);
  if (layout !== now.layout) writeState(makeStateWithLayout(now, layout), false);
}

function findSplitRatio(node: PaneLayoutState['root'], splitId: string): number | null {
  if (node.kind === 'leaf') return null;
  if (node.id === splitId) return node.ratio;
  return findSplitRatio(node.first, splitId) ?? findSplitRatio(node.second, splitId);
}

export function commitPaneResizeSession(session: PaneResizeSession): void {
  const now = current();
  if (session.layoutId !== now.layout.id || session.topologyRevision !== now.layout.topologyRevision) return;
  writeState(now);
  if (now.layout.root.kind === 'split' && now.layout.root.id === session.splitId) {
    const ratio = findSplitRatio(now.layout.root, session.splitId);
    if (ratio !== null) setPreferences({ splitShare: ratio });
  }
}

export function cancelPaneResizeSession(session: PaneResizeSession): void {
  const now = current();
  const layout = cancelPaneResizeModel(now.layout, session);
  if (layout !== now.layout) writeState(makeStateWithLayout(now, layout), false);
}

export function resetPaneSplitRatio(splitId: string): void {
  const now = current();
  const layout = resetPaneSplit(now.layout, splitId);
  if (layout === now.layout) return;
  writeState(makeStateWithLayout(now, layout));
  if (layout.root.kind === 'split' && layout.root.id === splitId) setPreferences({ splitShare: 0.5 });
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

export const PaneContext = createContext<PaneId | null>(null);
export const PaneTabContext = createContext<string | null>(null);

export function usePane(): PaneId {
  const pane = useContext(PaneContext);
  const tabId = useContext(PaneTabContext);
  return tabId === null ? (pane ?? targetPane()) : paneIdForTabId(tabId);
}

export function usePaneTabId(): string | null {
  const paneTabId = useContext(PaneTabContext);
  const pane = usePane();
  return paneTabId ?? getTabForPane(pane)?.id ?? null;
}
