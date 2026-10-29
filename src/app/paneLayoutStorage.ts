import { validatePaneLayout } from './paneLayout';
import type { LegacySplitState, PaneLayout, PaneNode, PaneTabInstance } from './paneLayout';

export const TABS_SCHEMA_VERSION = 2;
export const PANE_LAYOUT_SCHEMA_VERSION = 1;
export const MAX_PERSISTED_TABS_CHARS = 1_048_576;
export const MAX_LEGACY_GROUPS = 20;
export const MAX_PANE_TAB_INSTANCES = MAX_LEGACY_GROUPS * 2;
export const MAX_PERSISTED_HISTORY = 50;
export const MAX_CLOSED_TABS = 10;
export const MAX_PERSISTED_ID_LENGTH = 128;
export const MAX_PERSISTED_TARGET_LENGTH = 8192;
export const MAX_PANE_NODES = 7;
export const MAX_PANE_DEPTH = 3;
export const PANE_TABS_STORAGE_KEY = 'morrow.tabs';

export interface PaneTabsStorageWriter {
  setItem(key: string, value: string): void;
}

export interface LegacyTabsSnapshot extends LegacySplitState {
  readonly closed: readonly string[];
}

export interface CurrentTabsSnapshot {
  readonly layout: PaneLayout<PaneTabInstance<string>>;
  readonly closed: readonly string[];
}

export type PaneTabsReadResult =
  | { readonly kind: 'empty' }
  | { readonly kind: 'legacy'; readonly snapshot: LegacyTabsSnapshot }
  | { readonly kind: 'current'; readonly snapshot: CurrentTabsSnapshot }
  | { readonly kind: 'future'; readonly version: unknown }
  | { readonly kind: 'invalid'; readonly reason: string };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function readStringArray(value: unknown, limit: number, maxLength: number): readonly string[] | null {
  if (!Array.isArray(value) || value.length > limit) return null;
  if (!value.every((item) => boundedString(item, maxLength))) return null;
  return value as string[];
}

function readHistory(
  value: unknown,
  targetKey: 'hash' | 'target',
  allowMissingHistory = false,
): { readonly target: string; readonly back: readonly string[]; readonly forward: readonly string[] } | null {
  if (!isRecord(value) || !boundedString(value[targetKey], MAX_PERSISTED_TARGET_LENGTH)) return null;
  const back =
    allowMissingHistory && value.back === undefined
      ? []
      : readStringArray(value.back, MAX_PERSISTED_HISTORY, MAX_PERSISTED_TARGET_LENGTH);
  const forward =
    allowMissingHistory && value.forward === undefined
      ? []
      : readStringArray(value.forward, MAX_PERSISTED_HISTORY, MAX_PERSISTED_TARGET_LENGTH);
  if (!back || !forward) return null;
  return { target: value[targetKey], back, forward };
}

function readLegacySnapshot(root: UnknownRecord): LegacyTabsSnapshot | null {
  if (!Array.isArray(root.tabs) || root.tabs.length === 0 || root.tabs.length > MAX_LEGACY_GROUPS)
    return null;
  const ids = new Set<string>();
  const tabs: LegacySplitState['tabs'][number][] = [];

  for (const item of root.tabs) {
    if (!isRecord(item) || !boundedString(item.id, MAX_PERSISTED_ID_LENGTH) || ids.has(item.id)) return null;
    const main = readHistory(item, 'hash', true);
    if (!main) return null;
    let side: LegacySplitState['tabs'][number]['side'] = null;
    if (item.side !== undefined && item.side !== null) {
      const parsedSide = readHistory(item.side, 'hash', true);
      if (!parsedSide) return null;
      side = { hash: parsedSide.target, back: parsedSide.back, forward: parsedSide.forward };
    }
    ids.add(item.id);
    tabs.push({ id: item.id, hash: main.target, back: main.back, forward: main.forward, side });
  }

  if (typeof root.active !== 'string' || !ids.has(root.active)) return null;
  const active = tabs.find((tab) => tab.id === root.active)!;
  const pane =
    root.pane === 'side' && active.side
      ? 'side'
      : root.pane === undefined || root.pane === 'main'
        ? 'main'
        : null;
  if (!pane) return null;
  const closed =
    root.closed === undefined
      ? []
      : readStringArray(root.closed, MAX_CLOSED_TABS, MAX_PERSISTED_TARGET_LENGTH);
  if (!closed) return null;

  return { tabs, active: root.active, pane, closed };
}

interface NodeBudget {
  count: number;
  readonly ids: Set<string>;
}

function readNode(value: unknown, depth: number, budget: NodeBudget): PaneNode | null {
  if (!isRecord(value) || depth > MAX_PANE_DEPTH || budget.count >= MAX_PANE_NODES) return null;
  if (!boundedString(value.id, MAX_PERSISTED_ID_LENGTH) || budget.ids.has(value.id)) return null;
  budget.ids.add(value.id);
  budget.count += 1;

  if (value.kind === 'leaf') {
    if (value.tabId !== null && !boundedString(value.tabId, MAX_PERSISTED_ID_LENGTH)) return null;
    return { kind: 'leaf', id: value.id, tabId: value.tabId as string | null };
  }

  if (value.kind !== 'split' || (value.axis !== 'columns' && value.axis !== 'rows')) return null;
  if (
    typeof value.ratio !== 'number' ||
    !Number.isFinite(value.ratio) ||
    value.ratio < 0.2 ||
    value.ratio > 0.8
  )
    return null;
  const first = readNode(value.first, depth + 1, budget);
  const second = readNode(value.second, depth + 1, budget);
  if (!first || !second) return null;
  return { kind: 'split', id: value.id, axis: value.axis, ratio: value.ratio, first, second };
}

function readCurrentSnapshot(root: UnknownRecord): CurrentTabsSnapshot | null {
  if (!Array.isArray(root.tabs) || root.tabs.length === 0 || root.tabs.length > MAX_PANE_TAB_INSTANCES)
    return null;
  const tabs: PaneTabInstance<string>[] = [];
  for (const item of root.tabs) {
    if (
      !isRecord(item) ||
      !boundedString(item.id, MAX_PERSISTED_ID_LENGTH) ||
      !boundedString(item.groupId, MAX_PERSISTED_ID_LENGTH)
    )
      return null;
    const history = readHistory(item, 'target');
    if (!history) return null;
    tabs.push({
      id: item.id,
      groupId: item.groupId,
      target: history.target,
      back: history.back,
      forward: history.forward,
    });
  }

  if (!isRecord(root.paneLayout) || root.paneLayout.version !== PANE_LAYOUT_SCHEMA_VERSION) return null;
  const rawLayout = root.paneLayout;
  if (
    !boundedString(rawLayout.id, MAX_PERSISTED_ID_LENGTH) ||
    !boundedString(rawLayout.focusedPaneId, MAX_PERSISTED_ID_LENGTH)
  )
    return null;
  const budget: NodeBudget = { count: 0, ids: new Set() };
  const rootNode = readNode(rawLayout.root, 0, budget);
  if (!rootNode) return null;
  const layout: PaneLayout<PaneTabInstance<string>> = {
    id: rawLayout.id,
    root: rootNode,
    focusedPaneId: rawLayout.focusedPaneId,
    topologyRevision: 0,
    tabs,
  };
  if (validatePaneLayout(layout).length > 0) return null;

  const closed = readStringArray(root.closed, MAX_CLOSED_TABS, MAX_PERSISTED_TARGET_LENGTH);
  if (!closed) return null;
  return { layout, closed };
}

export function readPaneTabsSnapshot(raw: string | null): PaneTabsReadResult {
  if (raw === null) return { kind: 'empty' };
  if (
    raw.length > MAX_PERSISTED_TABS_CHARS ||
    new TextEncoder().encode(raw).byteLength > MAX_PERSISTED_TABS_CHARS
  )
    return { kind: 'invalid', reason: 'payload-too-large' };

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { kind: 'invalid', reason: 'malformed-json' };
  }
  if (!isRecord(value)) return { kind: 'invalid', reason: 'root-not-object' };

  if (Object.hasOwn(value, 'schemaVersion')) {
    if (value.schemaVersion !== TABS_SCHEMA_VERSION) return { kind: 'future', version: value.schemaVersion };
    const snapshot = readCurrentSnapshot(value);
    return snapshot ? { kind: 'current', snapshot } : { kind: 'invalid', reason: 'invalid-v2-payload' };
  }

  if (Object.hasOwn(value, 'paneLayout')) return { kind: 'invalid', reason: 'unversioned-pane-layout' };
  const snapshot = readLegacySnapshot(value);
  return snapshot ? { kind: 'legacy', snapshot } : { kind: 'invalid', reason: 'invalid-legacy-payload' };
}

export function writePaneTabsSnapshot(
  layout: PaneLayout<PaneTabInstance<string>>,
  closed: readonly string[],
): string {
  return JSON.stringify({
    schemaVersion: TABS_SCHEMA_VERSION,
    paneLayout: {
      version: PANE_LAYOUT_SCHEMA_VERSION,
      id: layout.id,
      root: layout.root,
      focusedPaneId: layout.focusedPaneId,
    },
    tabs: layout.tabs,
    closed,
  });
}

export function persistPaneTabsSnapshot(
  storage: PaneTabsStorageWriter,
  layout: PaneLayout<PaneTabInstance<string>>,
  closed: readonly string[],
  writable: boolean,
): boolean {
  if (!writable) return false;
  const raw = writePaneTabsSnapshot(layout, closed);
  if (
    raw.length > MAX_PERSISTED_TABS_CHARS ||
    new TextEncoder().encode(raw).byteLength > MAX_PERSISTED_TABS_CHARS
  )
    return false;
  try {
    storage.setItem(PANE_TABS_STORAGE_KEY, raw);
    return true;
  } catch {
    return false;
  }
}
