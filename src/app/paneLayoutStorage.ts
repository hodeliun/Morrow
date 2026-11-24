import { validatePaneLayout } from './paneLayout';
import type { LegacySplitState, PaneLayout, PaneNode, PaneTabInstance } from './paneLayout';

// This reader preserves target strings verbatim. The 2.2 runtime has no v2 writer;
// route-specific normalization belongs to the runtime that owns those routes.
// The v2 reader is adapted from hodeliun/Morrow v1.3.0-fork.1.2.0
// (778c6b6ef7d30aad8678dbbbcb50fdcab6bc1106).

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

export interface PaneTabsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type PaneTabsWriteResult =
  | { readonly kind: 'written'; readonly raw: string }
  | { readonly kind: 'unchanged'; readonly raw: string }
  | { readonly kind: 'conflict' }
  | {
      readonly kind: 'protected';
      readonly reason:
        | 'unsupported-source'
        | 'legacy-source'
        | 'source-not-lossless'
        | 'invalid-candidate';
    }
  | { readonly kind: 'storage-error'; readonly operation: 'read' | 'write' };

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

/** Detects duplicate decoded object keys before JSON.parse can silently keep only the last one. */
function hasDuplicateJsonObjectKeys(raw: string): boolean {
  type Frame =
    | { readonly kind: 'array' }
    | { readonly kind: 'object'; readonly keys: Set<string>; expectingKey: boolean };
  const stack: Frame[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '"') {
      const start = index;
      index += 1;
      while (index < raw.length) {
        if (raw[index] === '\\') {
          index += 2;
          continue;
        }
        if (raw[index] === '"') break;
        index += 1;
      }
      if (index >= raw.length) return false;

      const parent = stack.at(-1);
      if (parent?.kind === 'object' && parent.expectingKey) {
        let key: unknown;
        try {
          key = JSON.parse(raw.slice(start, index + 1)) as unknown;
        } catch {
          return false;
        }
        if (typeof key !== 'string') return false;
        if (parent.keys.has(key)) return true;
        parent.keys.add(key);
        parent.expectingKey = false;
      }
      continue;
    }

    if (char === '{') {
      stack.push({ kind: 'object', keys: new Set(), expectingKey: true });
    } else if (char === '[') {
      stack.push({ kind: 'array' });
    } else if (char === '}' || char === ']') {
      const parent = stack.at(-1);
      if (
        parent &&
        ((char === '}' && parent.kind === 'object') || (char === ']' && parent.kind === 'array'))
      )
        stack.pop();
    } else if (char === ',') {
      const parent = stack.at(-1);
      if (parent?.kind === 'object') parent.expectingKey = true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function readStringArray(value: unknown, limit: number, maxLength: number): readonly string[] | null {
  if (!Array.isArray(value) || value.length > limit) return null;
  if (!value.every((item) => boundedString(item, maxLength))) return null;
  return value as string[];
}

function readLegacyStringArray(value: unknown, limit: number): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').slice(-limit)
    : [];
}

function readTargetArray(value: unknown, limit: number, maxLength: number): readonly string[] | null {
  const raw = readStringArray(value, limit, maxLength);
  if (!raw) return null;
  return raw;
}

function readHistory(
  value: unknown,
  targetKey: 'hash' | 'target',
  allowMissingHistory = false,
): {
  readonly target: string;
  readonly back: readonly string[];
  readonly forward: readonly string[];
} | null {
  if (!isRecord(value) || !boundedString(value[targetKey], MAX_PERSISTED_TARGET_LENGTH)) return null;
  const target = value[targetKey];
  const back =
    allowMissingHistory && value.back === undefined
      ? []
      : readTargetArray(value.back, MAX_PERSISTED_HISTORY, MAX_PERSISTED_TARGET_LENGTH);
  const forward =
    allowMissingHistory && value.forward === undefined
      ? []
      : readTargetArray(value.forward, MAX_PERSISTED_HISTORY, MAX_PERSISTED_TARGET_LENGTH);
  if (!back || !forward) return null;
  return { target, back, forward };
}

function readLegacyHistory(
  value: unknown,
  allowMissingHistory = false,
): {
  readonly target: string;
  readonly back: readonly string[];
  readonly forward: readonly string[];
} | null {
  if (!isRecord(value) || typeof value.hash !== 'string') return null;
  const back =
    allowMissingHistory && value.back === undefined
      ? []
      : readLegacyStringArray(value.back, MAX_PERSISTED_HISTORY);
  const forward =
    allowMissingHistory && value.forward === undefined
      ? []
      : readLegacyStringArray(value.forward, MAX_PERSISTED_HISTORY);
  return { target: value.hash, back, forward };
}

function readLegacySnapshot(root: UnknownRecord): LegacyTabsSnapshot | null {
  if (!hasOnlyKeys(root, ['tabs', 'active', 'pane', 'closed'])) return null;
  if (!Array.isArray(root.tabs) || root.tabs.length === 0 || root.tabs.length > MAX_LEGACY_GROUPS)
    return null;
  const ids = new Set<string>();
  const tabs: LegacySplitState['tabs'][number][] = [];

  for (const item of root.tabs) {
    if (
      !isRecord(item) ||
      !hasOnlyKeys(item, ['id', 'hash', 'back', 'forward', 'side', 'pinned']) ||
      !boundedString(item.id, MAX_PERSISTED_ID_LENGTH) ||
      ids.has(item.id) ||
      (item.pinned !== undefined && typeof item.pinned !== 'boolean')
    )
      return null;
    const main = readLegacyHistory(item, true);
    if (!main) return null;
    let side: LegacySplitState['tabs'][number]['side'] = null;
    if (item.side !== undefined && item.side !== null) {
      if (!isRecord(item.side) || !hasOnlyKeys(item.side, ['hash', 'back', 'forward'])) return null;
      const parsedSide = readLegacyHistory(item.side, true);
      if (!parsedSide) return null;
      side = { hash: parsedSide.target, back: parsedSide.back, forward: parsedSide.forward };
    }
    ids.add(item.id);
    tabs.push({
      id: item.id,
      hash: main.target,
      back: main.back,
      forward: main.forward,
      side,
      ...(item.pinned === true ? { pinned: true } : {}),
    });
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
  const closed = root.closed === undefined ? [] : readLegacyStringArray(root.closed, MAX_CLOSED_TABS);

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
    if (item.pinned !== undefined && typeof item.pinned !== 'boolean') return null;
    tabs.push({
      id: item.id,
      groupId: item.groupId,
      target: history.target,
      back: history.back,
      forward: history.forward,
      ...(item.pinned === true ? { pinned: true } : {}),
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

  const closed = readTargetArray(root.closed, MAX_CLOSED_TABS, MAX_PERSISTED_TARGET_LENGTH);
  if (!closed) return null;
  return { layout, closed };
}

export function readPaneTabsSnapshot(raw: string | null): PaneTabsReadResult {
  if (raw === null) return { kind: 'empty' };

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { kind: 'invalid', reason: 'malformed-json' };
  }
  if (!isRecord(value)) return { kind: 'invalid', reason: 'root-not-object' };

  if (Object.hasOwn(value, 'schemaVersion')) {
    if (value.schemaVersion !== TABS_SCHEMA_VERSION) return { kind: 'future', version: value.schemaVersion };
    if (
      raw.length > MAX_PERSISTED_TABS_CHARS ||
      new TextEncoder().encode(raw).byteLength > MAX_PERSISTED_TABS_CHARS
    )
      return { kind: 'invalid', reason: 'payload-too-large' };
    const snapshot = readCurrentSnapshot(value);
    return snapshot ? { kind: 'current', snapshot } : { kind: 'invalid', reason: 'invalid-v2-payload' };
  }

  if (Object.hasOwn(value, 'paneLayout')) return { kind: 'invalid', reason: 'unversioned-pane-layout' };
  const snapshot = readLegacySnapshot(value);
  return snapshot ? { kind: 'legacy', snapshot } : { kind: 'invalid', reason: 'invalid-legacy-payload' };
}

function nodeHasOnlyKnownFields(value: unknown): boolean {
  const visited = new Set<UnknownRecord>();
  let visitedCount = 0;
  const visit = (node: unknown, depth: number): boolean => {
    if (
      !isRecord(node) ||
      depth > MAX_PANE_DEPTH ||
      visitedCount >= MAX_PANE_NODES ||
      visited.has(node)
    )
      return false;

    visited.add(node);
    visitedCount += 1;
    if (node.kind === 'leaf') return hasOnlyKeys(node, ['kind', 'id', 'tabId']);
    return (
      node.kind === 'split' &&
      hasOnlyKeys(node, ['kind', 'id', 'axis', 'ratio', 'first', 'second']) &&
      visit(node.first, depth + 1) &&
      visit(node.second, depth + 1)
    );
  };

  return visit(value, 0);
}

function candidateHasOnlyKnownFields(
  layout: PaneLayout<PaneTabInstance<string>>,
  closed: readonly string[],
): boolean {
  const candidate = layout as unknown as UnknownRecord;
  return (
    hasOnlyKeys(candidate, ['id', 'root', 'focusedPaneId', 'topologyRevision', 'tabs']) &&
    nodeHasOnlyKnownFields(candidate.root) &&
    Array.isArray(candidate.tabs) &&
    candidate.tabs.every(
      (tab) =>
        isRecord(tab) &&
        hasOnlyKeys(tab, ['id', 'groupId', 'target', 'back', 'forward', 'pinned']),
    ) &&
    Array.isArray(closed)
  );
}

function sourceHasNoDiscardedFields(raw: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return false;
  }
  if (!isRecord(value)) return false;

  if (
    !hasOnlyKeys(value, ['schemaVersion', 'paneLayout', 'tabs', 'closed']) ||
    !isRecord(value.paneLayout) ||
    !hasOnlyKeys(value.paneLayout, ['version', 'id', 'root', 'focusedPaneId']) ||
    !nodeHasOnlyKnownFields(value.paneLayout.root) ||
    !Array.isArray(value.tabs)
  )
    return false;
  return (
    value.tabs.length <= MAX_PANE_TAB_INSTANCES &&
    value.tabs.every((tab) =>
      isRecord(tab) &&
      hasOnlyKeys(tab, ['id', 'groupId', 'target', 'back', 'forward', 'pinned']) &&
      !(Object.hasOwn(tab, 'pinned') && tab.pinned === false),
    ) &&
    new Set(value.tabs.map((tab) => (isRecord(tab) ? tab.groupId : undefined))).size <=
      MAX_LEGACY_GROUPS
  );
}

function legacyHistoryHasNoDiscardedFields(value: UnknownRecord): boolean {
  if (!boundedString(value.hash, MAX_PERSISTED_TARGET_LENGTH)) return false;
  return (['back', 'forward'] as const).every((key) => {
    const history = value[key];
    return (
      history === undefined ||
      (Array.isArray(history) &&
        history.length <= MAX_PERSISTED_HISTORY &&
        history.every((target) => boundedString(target, MAX_PERSISTED_TARGET_LENGTH)))
    );
  });
}

function legacySourceHasNoDiscardedFields(raw: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return false;
  }
  if (!isRecord(value) || !hasOnlyKeys(value, ['tabs', 'active', 'pane', 'closed'])) return false;
  if (
    value.closed !== undefined &&
    (!Array.isArray(value.closed) ||
      value.closed.length > MAX_CLOSED_TABS ||
      !value.closed.every((target) => boundedString(target, MAX_PERSISTED_TARGET_LENGTH)))
  )
    return false;

  return (
    Array.isArray(value.tabs) &&
    value.tabs.length > 0 &&
    value.tabs.length <= MAX_LEGACY_GROUPS &&
    value.tabs.every((entry) => {
      if (
        !isRecord(entry) ||
        !hasOnlyKeys(entry, ['id', 'hash', 'back', 'forward', 'side', 'pinned']) ||
        !boundedString(entry.id, MAX_PERSISTED_ID_LENGTH) ||
        entry.pinned === false ||
        !legacyHistoryHasNoDiscardedFields(entry)
      )
        return false;
      if (entry.side === undefined || entry.side === null) return true;
      return (
        isRecord(entry.side) &&
        hasOnlyKeys(entry.side, ['hash', 'back', 'forward']) &&
        legacyHistoryHasNoDiscardedFields(entry.side)
      );
    })
  );
}

function canonicalLegacySnapshot(snapshot: LegacyTabsSnapshot): string {
  return JSON.stringify({
    tabs: snapshot.tabs.map((tab) => ({
      id: tab.id,
      hash: tab.hash,
      back: [...tab.back],
      forward: [...tab.forward],
      side: tab.side
        ? { hash: tab.side.hash, back: [...tab.side.back], forward: [...tab.side.forward] }
        : null,
      ...(tab.pinned === true ? { pinned: true } : {}),
    })),
    active: snapshot.active,
    pane: snapshot.pane,
    closed: [...snapshot.closed],
  });
}

function persistableNode(node: PaneNode): PaneNode {
  if (node.kind === 'leaf') return { kind: 'leaf', id: node.id, tabId: node.tabId };
  return {
    kind: 'split',
    id: node.id,
    axis: node.axis,
    ratio: node.ratio,
    first: persistableNode(node.first),
    second: persistableNode(node.second),
  };
}

function serializePaneTabsSnapshot(
  layout: PaneLayout<PaneTabInstance<string>>,
  closed: readonly string[],
): string {
  return JSON.stringify({
    schemaVersion: TABS_SCHEMA_VERSION,
    paneLayout: {
      version: PANE_LAYOUT_SCHEMA_VERSION,
      id: layout.id,
      root: persistableNode(layout.root),
      focusedPaneId: layout.focusedPaneId,
    },
    tabs: layout.tabs.map((tab) => ({
      id: tab.id,
      groupId: tab.groupId,
      target: tab.target,
      back: tab.back,
      forward: tab.forward,
      ...(tab.pinned === undefined ? {} : { pinned: tab.pinned }),
    })),
    closed,
  });
}

/** Writes the complete published v2 wire shape, excluding runtime topologyRevision. */
export function writePaneTabsSnapshot(
  layout: PaneLayout<PaneTabInstance<string>>,
  closed: readonly string[],
): string {
  if (!candidateHasOnlyKnownFields(layout, closed) || validatePaneLayout(layout).length > 0)
    throw new Error('Invalid pane tabs snapshot candidate.');
  if (
    layout.tabs.length === 0 ||
    layout.tabs.length > MAX_PANE_TAB_INSTANCES ||
    new Set(layout.tabs.map((tab) => tab.groupId)).size > MAX_LEGACY_GROUPS
  )
    throw new Error('Pane tabs snapshot candidate exceeds the published limits.');

  const raw = serializePaneTabsSnapshot(layout, closed);
  if (
    raw.length > MAX_PERSISTED_TABS_CHARS ||
    new TextEncoder().encode(raw).byteLength > MAX_PERSISTED_TABS_CHARS
  )
    throw new Error('Pane tabs snapshot candidate exceeds the published payload limit.');

  const roundTrip = readPaneTabsSnapshot(raw);
  if (
    roundTrip.kind !== 'current' ||
    serializePaneTabsSnapshot(roundTrip.snapshot.layout, roundTrip.snapshot.closed) !== raw
  )
    throw new Error('Pane tabs snapshot candidate is not losslessly readable.');
  return raw;
}

/**
 * Validates before reading storage, then compares the exact observed bytes immediately before
 * setItem. This narrows stale-write risk within one window; Web Storage has no cross-window lock,
 * so another window may still write between this comparison and setItem.
 */
export function persistPaneTabsSnapshot(
  storage: PaneTabsStorage,
  layout: PaneLayout<PaneTabInstance<string>>,
  closed: readonly string[],
  observedRaw: string | null,
): PaneTabsWriteResult {
  let candidateRaw: string;
  try {
    candidateRaw = writePaneTabsSnapshot(layout, closed);
  } catch {
    return { kind: 'protected', reason: 'invalid-candidate' };
  }

  let semanticallyUnchanged = false;
  if (observedRaw !== null) {
    if (
      observedRaw.length > MAX_PERSISTED_TABS_CHARS ||
      new TextEncoder().encode(observedRaw).byteLength > MAX_PERSISTED_TABS_CHARS
    )
      return { kind: 'protected', reason: 'unsupported-source' };
    if (hasDuplicateJsonObjectKeys(observedRaw))
      return { kind: 'protected', reason: 'source-not-lossless' };
    const observed = readPaneTabsSnapshot(observedRaw);
    if (observed.kind === 'legacy') {
      return { kind: 'protected', reason: 'legacy-source' };
    } else if (observed.kind === 'current') {
      if (!sourceHasNoDiscardedFields(observedRaw))
        return { kind: 'protected', reason: 'source-not-lossless' };
      semanticallyUnchanged =
        serializePaneTabsSnapshot(observed.snapshot.layout, observed.snapshot.closed) ===
        candidateRaw;
    } else {
      return { kind: 'protected', reason: 'unsupported-source' };
    }
  }

  let currentRaw: string | null;
  try {
    currentRaw = storage.getItem(PANE_TABS_STORAGE_KEY);
  } catch {
    return { kind: 'storage-error', operation: 'read' };
  }
  if (currentRaw !== observedRaw) return { kind: 'conflict' };
  if (semanticallyUnchanged && currentRaw !== null)
    return { kind: 'unchanged', raw: currentRaw };

  try {
    storage.setItem(PANE_TABS_STORAGE_KEY, candidateRaw);
  } catch {
    // Storage.setItem is atomic; do not attempt a compensating write that could clobber another window.
    return { kind: 'storage-error', operation: 'write' };
  }
  return { kind: 'written', raw: candidateRaw };
}

/**
 * Migrates v0 only after the caller supplies a v2-to-v0 baseline that exactly matches the
 * losslessly parsed source. The exact raw bytes are still checked immediately before writing.
 */
export function persistPaneTabsSnapshotAfterLegacyEquivalence(
  storage: PaneTabsStorage,
  layout: PaneLayout<PaneTabInstance<string>>,
  closed: readonly string[],
  observedRaw: string,
  equivalentLegacyBaseline: LegacyTabsSnapshot,
): PaneTabsWriteResult {
  let candidateRaw: string;
  try {
    candidateRaw = writePaneTabsSnapshot(layout, closed);
  } catch {
    return { kind: 'protected', reason: 'invalid-candidate' };
  }

  if (
    observedRaw.length > MAX_PERSISTED_TABS_CHARS ||
    new TextEncoder().encode(observedRaw).byteLength > MAX_PERSISTED_TABS_CHARS
  )
    return { kind: 'protected', reason: 'unsupported-source' };
  if (hasDuplicateJsonObjectKeys(observedRaw))
    return { kind: 'protected', reason: 'source-not-lossless' };

  const observed = readPaneTabsSnapshot(observedRaw);
  if (observed.kind !== 'legacy') return { kind: 'protected', reason: 'unsupported-source' };
  if (
    !legacySourceHasNoDiscardedFields(observedRaw) ||
    canonicalLegacySnapshot(observed.snapshot) !== canonicalLegacySnapshot(equivalentLegacyBaseline)
  )
    return { kind: 'protected', reason: 'source-not-lossless' };

  let currentRaw: string | null;
  try {
    currentRaw = storage.getItem(PANE_TABS_STORAGE_KEY);
  } catch {
    return { kind: 'storage-error', operation: 'read' };
  }
  if (currentRaw !== observedRaw) return { kind: 'conflict' };

  try {
    storage.setItem(PANE_TABS_STORAGE_KEY, candidateRaw);
  } catch {
    return { kind: 'storage-error', operation: 'write' };
  }
  return { kind: 'written', raw: candidateRaw };
}
