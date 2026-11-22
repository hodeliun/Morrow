// tabs remember a place each, like a browser: the open tab follows wherever you go.
// a tab can be split in two, each side with its own back and forward history
import { createContext, useContext, useSyncExternalStore } from 'react';
import { visiblePaneLeaves } from './paneLayout';
import type { PaneTabInstance } from './paneLayout';
import { PANE_TABS_STORAGE_KEY, readPaneTabsSnapshot } from './paneLayoutStorage';
import type { CurrentTabsSnapshot, LegacyTabsSnapshot } from './paneLayoutStorage';

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
  // Fork v2, malformed and future snapshots stay byte-exact until a lossless writer is available.
  persistenceWritable: boolean;
  // Raw value observed during load or the last successful write; prevents overwriting another window.
  observedStorageRaw: string | null;
}

const MAX_TABS = 20;
const MAX_HISTORY = 50;
const MAX_CLOSED = 10;
const listeners = new Set<() => void>();
let counter = 0;
const newTabId = () => `t${Date.now().toString(36)}${(counter++).toString(36)}`;

function initialState(
  hash: string,
  persistenceWritable: boolean,
  observedStorageRaw: string | null,
): TabState {
  const id = newTabId();
  return {
    tabs: [{ id, hash, back: [], forward: [], side: null }],
    active: id,
    pane: 'main',
    closed: [],
    persistenceWritable,
    observedStorageRaw,
  };
}

function applyLaunchHash(tabs: Tab[], active: string, hash: string): void {
  const tab = tabs.find((item) => item.id === active);
  if (!tab) return;
  if (tab.hash !== hash) {
    tab.back = [...tab.back, tab.hash].slice(-MAX_HISTORY);
    tab.hash = hash;
  }
}

function fromLegacySnapshot(snapshot: LegacyTabsSnapshot, hash: string, raw: string): TabState {
  const tabs: Tab[] = snapshot.tabs.map((tab) => ({
    id: tab.id,
    hash: tab.hash,
    back: [...tab.back],
    forward: [...tab.forward],
    side: tab.side ? { hash: tab.side.hash, back: [...tab.side.back], forward: [...tab.side.forward] } : null,
    ...(tab.pinned ? { pinned: true } : {}),
  }));
  const active = tabs.find((tab) => tab.id === snapshot.active)?.id ?? tabs[0]!.id;
  const activeTab = tabs.find((tab) => tab.id === active)!;
  const pane = snapshot.pane === 'side' && activeTab.side ? 'side' : 'main';
  // Match 2.2: use the launch route ("#/" when absent), save the previous route in back, and
  // retain forward history. The app's start-page effect must still see an empty window hash.
  applyLaunchHash(tabs, active, hash);
  return {
    tabs,
    active,
    pane,
    closed: [...snapshot.closed],
    persistenceWritable: true,
    observedStorageRaw: raw,
  };
}

interface ProjectedInstance {
  readonly tabId: string;
  readonly pane: PaneId;
}

function fromCurrentSnapshot(snapshot: CurrentTabsSnapshot, hash: string, raw: string): TabState {
  const groups = new Map<string, PaneTabInstance<string>[]>();
  for (const item of snapshot.layout.tabs) {
    const group = groups.get(item.groupId) ?? [];
    group.push(item);
    groups.set(item.groupId, group);
  }

  const tabs: Tab[] = [];
  const instanceMap = new Map<string, ProjectedInstance>();
  for (const [groupId, group] of groups) {
    const main = group.find((item) => item.id === groupId);
    const side =
      group.length === 2
        ? group.find((item) => item.id !== main?.id && item.id.startsWith(`${groupId}:side`))
        : undefined;
    if (main && side) {
      tabs.push({
        id: main.id,
        hash: main.target,
        back: [...main.back],
        forward: [...main.forward],
        side: { hash: side.target, back: [...side.back], forward: [...side.forward] },
        ...(main.pinned || side.pinned ? { pinned: true } : {}),
      });
      instanceMap.set(main.id, { tabId: main.id, pane: 'main' });
      instanceMap.set(side.id, { tabId: main.id, pane: 'side' });
      continue;
    }

    for (const item of group) {
      tabs.push({
        id: item.id,
        hash: item.target,
        back: [...item.back],
        forward: [...item.forward],
        side: null,
        ...(item.pinned ? { pinned: true } : {}),
      });
      instanceMap.set(item.id, { tabId: item.id, pane: 'main' });
    }
  }

  const focusedLeaf = visiblePaneLeaves(snapshot.layout).find(
    (leaf) => leaf.id === snapshot.layout.focusedPaneId,
  );
  const focusedInstance = focusedLeaf?.tabId ? instanceMap.get(focusedLeaf.tabId) : undefined;
  const active = focusedInstance?.tabId ?? tabs[0]?.id;
  if (!active || tabs.length > MAX_TABS) {
    const selected =
      snapshot.layout.tabs.find((item) => item.id === focusedLeaf?.tabId) ?? snapshot.layout.tabs[0];
    if (!selected) return initialState(hash, false, raw);
    const tab: Tab = {
      id: selected.id,
      hash: selected.target,
      back: [...selected.back],
      forward: [...selected.forward],
      side: null,
      ...(selected.pinned ? { pinned: true } : {}),
    };
    const fallbackTabs = [tab];
    applyLaunchHash(fallbackTabs, tab.id, hash);
    return {
      tabs: fallbackTabs,
      active: tab.id,
      pane: 'main',
      closed: [...snapshot.closed],
      persistenceWritable: false,
      observedStorageRaw: raw,
    };
  }

  const pane =
    focusedInstance?.pane === 'side' && tabs.find((tab) => tab.id === active)?.side ? 'side' : 'main';
  applyLaunchHash(tabs, active, hash);
  return {
    tabs,
    active,
    pane,
    closed: [...snapshot.closed],
    persistenceWritable: false,
    observedStorageRaw: raw,
  };
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

function set(next: TabState): void {
  let committed = next;
  if (next.persistenceWritable) {
    const serialized = JSON.stringify({
      tabs: next.tabs,
      active: next.active,
      pane: next.pane,
      closed: next.closed,
    });
    try {
      const currentRaw = localStorage.getItem(PANE_TABS_STORAGE_KEY);
      if (currentRaw !== next.observedStorageRaw) {
        committed = { ...next, persistenceWritable: false };
      } else {
        try {
          localStorage.setItem(PANE_TABS_STORAGE_KEY, serialized);
          committed = { ...next, observedStorageRaw: serialized };
        } catch {
          // not remembering tabs is harmless
        }
      }
    } catch {
      // A failed read cannot prove that the stored value is still the one loaded here.
      committed = { ...next, persistenceWritable: false };
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
  const tab = activeTab();
  return targetPane() === 'side' ? tab.side!.hash : window.location.hash || '#/';
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
