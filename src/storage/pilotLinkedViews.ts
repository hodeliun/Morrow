import type { DocNode, PageId, WorkspaceState } from '../core/model';
import { isEffectivelyTrashed } from '../core/tree';
import {
  decodePolarisDadosViewMarker,
  encodePolarisDadosViewMarker,
  isPolarisDadosViewData,
  polarisDadosViewDocIssue,
} from '../core/polarisDadosView';
import type { PolarisDadosViewData } from '../core/polarisDadosView';
import type {
  LinkedViewConfig,
  LinkedViewDiagnostic,
  LinkedViewErrorCode,
  LinkedViewHistoryResult,
  LinkedViewMutationResult,
  LinkedViewSnapshot,
  LinkedViewSourceStatus,
} from '../app/plugins/linkedViewApi';
import { createPilotDataBackend } from './pilotData';
import type { WorkspaceSession } from './session';

export interface PilotLinkedViewBinding {
  pageId: PageId;
  viewId: string;
  sourceDatabaseId: PageId;
}

export interface PilotLinkedViewBackend {
  snapshot(): LinkedViewSnapshot;
  incarnation(): number;
  lifecycle(): { incarnation: number; removals: number; identityChanges: number; sourceLosses: number };
  patchConfig(input: {
    patch: unknown;
    expectedRevision: string;
  }): LinkedViewMutationResult;
  history(input: { direction: 'undo' | 'redo'; expectedRevision: string }): LinkedViewHistoryResult;
  subscribe(listener: () => void): () => void;
}

export interface PilotLinkedViewStageHooks {
  beforeStage?: (currentDoc: DocNode, nextDoc: DocNode) => boolean;
  afterStage?: () => boolean;
}

interface ConfigHistoryEntry {
  before: LinkedViewConfig;
  after: LinkedViewConfig;
}

interface ViewHistory {
  undo: ConfigHistoryEntry[];
  redo: ConfigHistoryEntry[];
}

interface ViewState {
  binding: PilotLinkedViewBinding;
  nonce: string;
  fingerprint: string;
  identityKey: string | null;
  revisionNumber: number;
  revision: string;
  incarnation: number;
  removals: number;
  identityChanges: number;
  sourceLosses: number;
  sourceStatus: string | null;
  sourceWasAvailable: boolean;
  wasPresent: boolean;
}

interface PendingMutation {
  entry: ViewState;
  analysis: Analysis;
  targetConfig: LinkedViewConfig;
  nonConfigFingerprint: string;
}

interface SessionState {
  id: string;
  views: Map<string, ViewState>;
  histories: Map<string, ViewHistory>;
  listeners: Set<() => void>;
  activeMutations: Map<string, PendingMutation>;
  unsubscribeSession: () => void;
  unsubscribeQueue: () => void;
  unsubscribeClose: () => void;
}

interface LocatedView {
  node: DocNode | null;
  matchingNodes: DocNode[];
  allViewNodes: DocNode[];
}

interface Analysis {
  snapshot: LinkedViewSnapshot;
  fingerprint: string;
  nonConfigFingerprint: string;
  present: boolean;
  identityKey?: string | null;
  sourceStatus?: string | null;
  config: LinkedViewConfig | null;
}

const MAX_HISTORY_STEPS = 10;
const sessionStates = new WeakMap<WorkspaceSession, SessionState>();

function bindingKey(binding: PilotLinkedViewBinding): string {
  return JSON.stringify([binding.pageId, binding.viewId, binding.sourceDatabaseId]);
}

function historyKey(binding: PilotLinkedViewBinding): string {
  return JSON.stringify([binding.pageId, binding.viewId]);
}

function randomSessionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function getSessionState(session: WorkspaceSession): SessionState {
  const existing = sessionStates.get(session);
  if (existing) return existing;
  const state: SessionState = {
    id: randomSessionId(),
    views: new Map(),
    histories: new Map(),
    listeners: new Set(),
    activeMutations: new Map(),
    unsubscribeSession: () => {},
    unsubscribeQueue: () => {},
    unsubscribeClose: () => {},
  };
  sessionStates.set(session, state);
  state.unsubscribeSession = session.subscribe(() => refreshSessionViews(session, state, true));
  state.unsubscribeQueue = session.queue.subscribe(() => publish(state));
  state.unsubscribeClose = session.onClose(() => {
    state.unsubscribeSession();
    state.unsubscribeQueue();
    state.listeners.clear();
    state.views.clear();
    state.histories.clear();
  });
  return state;
}

function createHistory(): ViewHistory {
  return { undo: [], redo: [] };
}

function getHistory(state: SessionState, binding: PilotLinkedViewBinding): ViewHistory {
  const key = historyKey(binding);
  let history = state.histories.get(key);
  if (!history) {
    history = createHistory();
    state.histories.set(key, history);
  }
  return history;
}

function locateViews(doc: DocNode | undefined, viewId: string): LocatedView {
  const allViewNodes: DocNode[] = [];
  const matchingNodes: DocNode[] = [];
  if (!doc) return { node: null, matchingNodes, allViewNodes };
  const stack: DocNode[] = [doc];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'polarisDadosView') {
      allViewNodes.push(node);
      const attrs = node.attrs;
      if (attrs && typeof attrs.viewId === 'string' && attrs.viewId === viewId) matchingNodes.push(node);
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) stack.push(child);
    }
  }
  return { node: matchingNodes.length === 1 ? matchingNodes[0]! : null, matchingNodes, allViewNodes };
}

function diagnostic(code: LinkedViewDiagnostic['code'], message: string): LinkedViewDiagnostic {
  return Object.freeze({ code, message });
}

function unsupported(
  binding: PilotLinkedViewBinding,
  revision: string,
  issue: LinkedViewDiagnostic,
  fingerprintData: unknown,
  identityKey?: string | null,
): Analysis {
  const fingerprint = JSON.stringify(['unsupported', binding.pageId, binding.viewId, binding.sourceDatabaseId, issue.code, fingerprintData]);
  return {
    snapshot: Object.freeze({
      version: 1,
      status: 'unsupported',
      pageId: binding.pageId,
      viewId: binding.viewId,
      sourceDatabaseId: binding.sourceDatabaseId,
      revision,
      diagnostic: issue,
    }),
    fingerprint,
    nonConfigFingerprint: fingerprint,
    present: true,
    identityKey,
    config: null,
  };
}

function missing(binding: PilotLinkedViewBinding, revision: string, reason: string): Analysis {
  return {
    snapshot: Object.freeze({
      version: 1,
      status: 'missing',
      pageId: binding.pageId,
      viewId: binding.viewId,
      sourceDatabaseId: binding.sourceDatabaseId,
      revision,
    }),
    fingerprint: JSON.stringify(['missing', binding.pageId, binding.viewId, binding.sourceDatabaseId, reason]),
    nonConfigFingerprint: JSON.stringify(['missing', binding.pageId, binding.viewId, binding.sourceDatabaseId, reason]),
    present: false,
    identityKey: null,
    sourceStatus: null,
    config: null,
  };
}

function configFrom(data: PolarisDadosViewData): LinkedViewConfig {
  return {
    title: data.title,
    columnOrder: [...data.columnOrder],
    filter: data.filter ? { propertyId: data.filter.propertyId, op: 'gte', value: data.filter.value } : null,
  };
}

function schemaFingerprint(schema: readonly { id: string; type: string }[]): readonly (readonly [string, string])[] {
  return schema.map((property) => [property.id, property.type] as const);
}

function analyze(
  session: WorkspaceSession,
  binding: PilotLinkedViewBinding,
  revision: string,
  state: WorkspaceState,
): Analysis {
  const hostPage = state.pages[binding.pageId];
  if (!hostPage || isEffectivelyTrashed(state.pages, binding.pageId)) {
    return missing(binding, revision, 'host-page-unavailable');
  }
  const doc = state.docs[binding.pageId];
  if (
    session.unreadable.has(binding.pageId) ||
    session.protectedReasons.has(binding.pageId) ||
    hostPage.encrypted ||
    !doc
  ) {
    return unsupported(
      binding,
      revision,
      diagnostic('page-unreadable', session.protectedReasons.get(binding.pageId) ?? 'The linked-view note is read only or unavailable.'),
      ['host-page-unreadable'],
    );
  }

  const located = locateViews(doc, binding.viewId);
  if (located.matchingNodes.length === 0 && located.allViewNodes.length === 0) {
    return missing(binding, revision, 'view-node-removed');
  }
  const docIssue = polarisDadosViewDocIssue(doc);
  if (docIssue) {
    return unsupported(
      binding,
      revision,
      diagnostic('unsupported-view-node', docIssue),
      located.matchingNodes.map((node) => node.attrs ?? null),
    );
  }
  if (located.matchingNodes.length === 0) return missing(binding, revision, 'view-node-removed');
  if (located.matchingNodes.length !== 1 || !located.node) {
    return unsupported(
      binding,
      revision,
      diagnostic('duplicate-view', 'The note contains more than one node with this linked-view ID.'),
      located.matchingNodes.length,
    );
  }

  const data = located.node.attrs;
  if (!isPolarisDadosViewData(data)) {
    return unsupported(
      binding,
      revision,
      diagnostic('unsupported-view-node', 'The linked-view payload is unknown or malformed.'),
      data ?? null,
    );
  }
  if (data.sourceDatabaseId !== binding.sourceDatabaseId) {
    return unsupported(
      binding,
      revision,
      diagnostic('source-mismatch', 'This handle is bound to a different source database.'),
      [data.viewId, data.sourceDatabaseId],
      JSON.stringify([data.viewId, data.sourceDatabaseId]),
    );
  }

  const normalizedMarker = encodePolarisDadosViewMarker(data);
  const normalized = decodePolarisDadosViewMarker(normalizedMarker);
  if (!normalized) {
    return unsupported(
      binding,
      revision,
      diagnostic('unsupported-view-node', 'The linked-view payload could not be represented safely.'),
      data,
    );
  }
  const config = configFrom(normalized);
  const source = sourceStatus(session, binding.sourceDatabaseId, state);
  let configIssue: LinkedViewDiagnostic | null = null;
  if (source.schema) {
    const propertyIds = source.schema.map((property) => property.id);
    const available = new Set(propertyIds);
    if (config.columnOrder.length > 0) {
      const missingColumn = config.columnOrder.find((propertyId) => !available.has(propertyId));
      if (missingColumn) {
        configIssue = diagnostic('column-order-property-missing', `Column “${missingColumn}” is no longer in the source schema.`);
      }
    }
    if (!configIssue && config.filter) {
      const property = source.schema.find((item) => item.id === config.filter!.propertyId);
      if (!property) {
        configIssue = diagnostic('filter-property-missing', `Filter property “${config.filter.propertyId}” is no longer in the source schema.`);
      } else if (property.type !== 'number') {
        configIssue = diagnostic('filter-property-not-numeric', 'The saved gte filter refers to a property that is not numeric.');
      }
    }
  }

  const sourceDiagnostic = source.status.diagnostic;
  const readonly = source.schema === null;
  const viewDiagnostic = sourceDiagnostic ?? configIssue;
  const nonConfigFingerprint = JSON.stringify([
    binding.pageId,
    binding.viewId,
    binding.sourceDatabaseId,
    source.status.status,
    sourceDiagnostic?.code ?? null,
    source.schema ? schemaFingerprint(source.schema) : null,
  ]);
  const fingerprint = JSON.stringify(['ready', nonConfigFingerprint, normalized]);
  const snapshot: LinkedViewSnapshot = {
    version: 1,
    status: 'ready',
    pageId: binding.pageId,
    viewId: binding.viewId,
    sourceDatabaseId: binding.sourceDatabaseId,
    revision,
    config,
    sourceStatus: source.status,
    readonly,
    diagnostic: viewDiagnostic,
    history: { canUndo: false, canRedo: false },
  };
  return {
    snapshot,
    fingerprint,
    nonConfigFingerprint,
    present: true,
    identityKey: JSON.stringify([normalized.viewId, normalized.sourceDatabaseId]),
    sourceStatus: source.status.status,
    config,
  };
}

function sourceStatus(
  session: WorkspaceSession,
  sourceDatabaseId: PageId,
  state: WorkspaceState,
): {
  status: LinkedViewSourceStatus;
  schema: Array<{ id: string; type: string }> | null;
} {
  const page = state.pages[sourceDatabaseId];
  if (!page) {
    return {
      status: { status: 'missing', diagnostic: diagnostic('source-missing', 'The source database no longer exists.') },
      schema: null,
    };
  }
  if (isEffectivelyTrashed(state.pages, sourceDatabaseId)) {
    return {
      status: { status: 'trashed', diagnostic: diagnostic('source-trashed', 'The source database is in the trash.') },
      schema: null,
    };
  }
  const snapshot = createPilotDataBackend(session).snapshot(sourceDatabaseId);
  if (snapshot.status !== 'ready') {
    const cause = snapshot.status === 'unsupported' ? snapshot.diagnostic : null;
    return {
      status: {
        status: 'unsupported',
        diagnostic: diagnostic('source-unsupported', cause?.message ?? 'The source database is not enabled for Polaris Dados.'),
      },
      schema: null,
    };
  }
  if (snapshot.readonly) {
    return {
      status: {
        status: 'unsupported',
        diagnostic: diagnostic('source-unsupported', snapshot.diagnostic?.message ?? 'The source database is read only.'),
      },
      schema: null,
    };
  }
  const schema = snapshot.schema.properties.map((property) => ({ id: property.id, type: property.type }));
  return { status: { status: 'available', diagnostic: null }, schema };
}

function updateStateEntry(
  state: SessionState,
  entry: ViewState,
  analysis: Analysis,
  invalidateHistory: boolean,
): boolean {
  const changed = analysis.fingerprint !== entry.fingerprint;
  if (!changed) return false;
  if (entry.wasPresent !== analysis.present) entry.incarnation += 1;
  if (analysis.identityKey !== undefined && analysis.identityKey !== entry.identityKey) {
    entry.incarnation += 1;
    if (entry.identityKey !== null && analysis.identityKey !== null) entry.identityChanges += 1;
    entry.identityKey = analysis.identityKey;
  }
  if (entry.wasPresent && !analysis.present) entry.removals += 1;
  if (analysis.sourceStatus !== undefined) {
    if (entry.sourceStatus === 'available' && analysis.sourceStatus !== 'available') entry.sourceLosses += 1;
    entry.sourceStatus = analysis.sourceStatus;
    if (analysis.sourceStatus === 'available') entry.sourceWasAvailable = true;
  }
  entry.wasPresent = analysis.present;
  entry.fingerprint = analysis.fingerprint;
  entry.revisionNumber += 1;
  entry.revision = `${state.id}:${entry.nonce}:v${entry.revisionNumber}`;
  if (invalidateHistory) {
    const history = getHistory(state, entry.binding);
    history.undo = [];
    history.redo = [];
  }
  return true;
}

function refreshSessionViews(
  session: WorkspaceSession,
  state: SessionState,
  invalidateHistory: boolean,
  notify = true,
): void {
  if (session.isClosed) return;
  let changed = false;
  for (const entry of state.views.values()) {
    if (state.activeMutations.has(bindingKey(entry.binding))) continue;
    const analysis = analyze(session, entry.binding, entry.revision, session.getState());
    changed = updateStateEntry(state, entry, analysis, invalidateHistory) || changed;
  }
  if (changed && notify) publish(state);
}

function refreshAfterOwnMutation(
  session: WorkspaceSession,
  state: SessionState,
  binding: PilotLinkedViewBinding,
): boolean {
  const targetKey = bindingKey(binding);
  let targetMatches = false;
  for (const entry of state.views.values()) {
    const analysis = analyze(session, entry.binding, entry.revision, session.getState());
    const key = bindingKey(entry.binding);
    const pending = state.activeMutations.get(key);
    const expectedTarget =
      pending !== undefined &&
      analysis.snapshot.status === 'ready' &&
      analysis.config !== null &&
      configFingerprint(analysis.config) === configFingerprint(pending.targetConfig) &&
      analysis.nonConfigFingerprint === pending.nonConfigFingerprint;
    if (key === targetKey && expectedTarget) targetMatches = true;
    updateStateEntry(state, entry, analysis, !expectedTarget);
  }
  return targetMatches;
}

function publish(state: SessionState): void {
  for (const listener of [...state.listeners]) {
    try {
      listener();
    } catch {
      // A linked-view subscriber cannot interrupt a workspace update or another listener.
    }
  }
}

function readEntry(session: WorkspaceSession, state: SessionState, binding: PilotLinkedViewBinding): {
  entry: ViewState;
  analysis: Analysis;
} {
  const key = bindingKey(binding);
  let entry = state.views.get(key);
  if (!entry) {
    const nonce = randomSessionId();
    const seedRevision = `${state.id}:${nonce}:v0`;
    const analysis = analyze(session, binding, seedRevision, session.getState());
    entry = {
      binding,
      nonce,
      fingerprint: analysis.fingerprint,
      identityKey: analysis.identityKey ?? null,
      revisionNumber: 0,
      revision: seedRevision,
      incarnation: analysis.present ? 1 : 0,
      removals: 0,
      identityChanges: 0,
      sourceLosses: 0,
      sourceStatus: analysis.sourceStatus ?? null,
      sourceWasAvailable: analysis.sourceStatus === 'available',
      wasPresent: analysis.present,
    };
    state.views.set(key, entry);
    return { entry, analysis };
  }
  let analysis = analyze(session, binding, entry.revision, session.getState());
  if (updateStateEntry(state, entry, analysis, true)) {
    analysis = analyze(session, binding, entry.revision, session.getState());
  }
  return { entry, analysis };
}

function snapshotWithHistory(analysis: Analysis, entry: ViewState, history: ViewHistory): LinkedViewSnapshot {
  const current = analyzeSnapshotRevision(analysis.snapshot, entry.revision);
  if (current.status !== 'ready') return current;
  return deepFreeze({
    ...current,
    history: { canUndo: history.undo.length > 0, canRedo: history.redo.length > 0 },
  });
}

function analyzeSnapshotRevision(snapshot: LinkedViewSnapshot, revision: string): LinkedViewSnapshot {
  if (snapshot.revision === revision) return snapshot;
  return { ...snapshot, revision };
}

function copyConfig(config: LinkedViewConfig): LinkedViewConfig {
  return {
    title: config.title,
    columnOrder: [...config.columnOrder],
    filter: config.filter ? { ...config.filter } : null,
  };
}

function configFingerprint(config: LinkedViewConfig): string {
  return JSON.stringify([config.title, config.columnOrder, config.filter]);
}

function validPatch(patch: unknown, current: LinkedViewConfig, viewId: string, sourceDatabaseId: PageId):
  | { ok: true; config: LinkedViewConfig }
  | { ok: false; message: string } {
  try {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      return { ok: false, message: 'A linked-view patch must be an object.' };
    }
    const allowedKeys = new Set(['title', 'columnOrder', 'filter']);
    const patchRecord = patch as Record<string, unknown>;
    if (Object.keys(patchRecord).some((key) => !allowedKeys.has(key))) {
      return { ok: false, message: 'A linked-view patch can change only title, columnOrder, and filter.' };
    }
    const hasTitle = Object.hasOwn(patchRecord, 'title');
    const hasColumnOrder = Object.hasOwn(patchRecord, 'columnOrder');
    const hasFilter = Object.hasOwn(patchRecord, 'filter');
    if (hasTitle && typeof patchRecord.title !== 'string') {
      return { ok: false, message: 'A linked-view title must be a string.' };
    }
    if (hasColumnOrder && (!Array.isArray(patchRecord.columnOrder) || !patchRecord.columnOrder.every((value) => typeof value === 'string'))) {
      return { ok: false, message: 'A linked-view column order must be an array of property IDs.' };
    }
    let filter: LinkedViewConfig['filter'] = current.filter;
    if (hasFilter) {
      const candidate = patchRecord.filter;
      if (candidate === null) {
        filter = null;
      } else {
        if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
          return { ok: false, message: 'A linked-view filter must be null or a gte filter object.' };
        }
        const filterRecord = candidate as Record<string, unknown>;
        if (
          Object.keys(filterRecord).some((key) => !['propertyId', 'op', 'value'].includes(key)) ||
          typeof filterRecord.propertyId !== 'string' ||
          filterRecord.op !== 'gte' ||
          typeof filterRecord.value !== 'number' ||
          !Number.isFinite(filterRecord.value)
        ) {
          return { ok: false, message: 'A linked-view filter requires a property ID, gte operator, and finite number.' };
        }
        filter = { propertyId: filterRecord.propertyId, op: 'gte', value: filterRecord.value };
      }
    }
    const next: LinkedViewConfig = {
      title: hasTitle ? patchRecord.title as string : current.title,
      columnOrder: hasColumnOrder ? [...patchRecord.columnOrder as string[]] : [...current.columnOrder],
      filter,
    };
    const candidate: PolarisDadosViewData = {
      version: 1,
      viewId,
      sourceDatabaseId,
      title: next.title,
      columnOrder: [...next.columnOrder],
      filter: next.filter,
    };
    const canonical = decodePolarisDadosViewMarker(encodePolarisDadosViewMarker(candidate));
    if (!canonical) return { ok: false, message: 'The linked-view config is not representable by the version 1 codec.' };
    return { ok: true, config: configFrom(canonical) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function stagedError(
  binding: PilotLinkedViewBinding,
  revision: string,
  code: Exclude<LinkedViewErrorCode, 'page-editor-conflict'>,
  message: string,
): LinkedViewMutationResult & LinkedViewHistoryResult {
  return { status: 'error', code, message, staged: true, pageId: binding.pageId, viewId: binding.viewId, revision };
}

function replaceNodeAttrs(doc: DocNode, viewId: string, attrs: PolarisDadosViewData): DocNode | null {
  let changed = false;
  const visit = (node: DocNode): DocNode => {
    if (node.type === 'polarisDadosView' && node.attrs?.viewId === viewId) {
      changed = true;
      return { type: node.type, attrs: { ...attrs } };
    }
    if (!node.content) return node;
    let childChanged = false;
    const content = node.content.map((child) => {
      const next = visit(child);
      if (next !== child) childChanged = true;
      return next;
    });
    if (!childChanged) return node;
    changed = true;
    return { ...node, content };
  };
  const next = visit(doc);
  return changed ? next : null;
}

function dataWithConfig(
  viewId: string,
  sourceDatabaseId: PageId,
  config: LinkedViewConfig,
): PolarisDadosViewData {
  return {
    version: 1,
    viewId,
    sourceDatabaseId,
    title: config.title,
    columnOrder: [...config.columnOrder],
    filter: config.filter ? { ...config.filter } : null,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function errorResult(code: LinkedViewErrorCode, message: string): LinkedViewMutationResult & LinkedViewHistoryResult {
  return { status: 'error', code, message };
}

function stagedMutationConflict(binding: PilotLinkedViewBinding, revision: string): LinkedViewMutationResult {
  return {
    status: 'error',
    code: 'page-editor-conflict',
    message: 'The config was staged, but one open page editor has not synchronized yet. Retry after synchronization.',
    staged: true,
    pageId: binding.pageId,
    viewId: binding.viewId,
    revision,
  };
}

function stagedHistoryConflict(
  binding: PilotLinkedViewBinding,
  revision: string,
  direction: 'undo' | 'redo',
): LinkedViewHistoryResult {
  return {
    status: 'error',
    code: 'page-editor-conflict',
    message: 'The history step was staged, but one open page editor has not synchronized yet. Retry after synchronization.',
    staged: true,
    pageId: binding.pageId,
    viewId: binding.viewId,
    revision,
    direction,
  };
}

function mutatePageDoc(
  session: WorkspaceSession,
  binding: PilotLinkedViewBinding,
  doc: DocNode,
): boolean {
  const result = session.execute({ type: 'page.setDoc', id: binding.pageId, doc, now: Date.now() });
  if (!result.ok) return false;
  return true;
}

export function createPilotLinkedViewBackend(
  session: WorkspaceSession,
  binding: PilotLinkedViewBinding,
  hooks: PilotLinkedViewStageHooks = {},
): PilotLinkedViewBackend {
  const sessionState = getSessionState(session);
  const bound = Object.freeze({ ...binding });
  const history = getHistory(sessionState, bound);
  readEntry(session, sessionState, bound);

  const current = () => {
    const pending = sessionState.activeMutations.get(bindingKey(bound));
    if (pending) return { entry: pending.entry, analysis: pending.analysis, history };
    const resolved = readEntry(session, sessionState, bound);
    return { ...resolved, history };
  };
  const buildSnapshot = (analysis: Analysis, entry: ViewState) => snapshotWithHistory(analysis, entry, history);
  const revalidateAcceptedStage = (
    targetConfig: LinkedViewConfig,
    nonConfigFingerprint: string,
    acceptedRevision: string,
  ): (LinkedViewMutationResult & LinkedViewHistoryResult) | null => {
    if (session.isClosed) {
      return stagedError(bound, acceptedRevision, 'session-closed', 'The session closed after the linked-view change was staged.');
    }
    const { entry, analysis } = current();
    const snapshot = buildSnapshot(analysis, entry);
    if (snapshot.status === 'missing') {
      return stagedError(bound, acceptedRevision, 'missing', 'The linked view was removed after the change was staged.');
    }
    if (snapshot.status === 'unsupported') {
      return stagedError(bound, acceptedRevision, 'unsupported', snapshot.diagnostic.message);
    }
    if (snapshot.readonly) {
      return stagedError(bound, acceptedRevision, 'read-only', snapshot.diagnostic?.message ?? 'The linked view became read only after staging.');
    }
    if (
      entry.revision !== acceptedRevision ||
      configFingerprint(analysis.config!) !== configFingerprint(targetConfig) ||
      analysis.nonConfigFingerprint !== nonConfigFingerprint
    ) {
      return stagedError(bound, acceptedRevision, 'stale-revision', 'The linked-view state changed after this update was staged.');
    }
    return null;
  };

  return {
    snapshot() {
      const { entry, analysis } = current();
      return buildSnapshot(analysis, entry);
    },
    incarnation() {
      return current().entry.incarnation;
    },
    lifecycle() {
      const entry = current().entry;
      return {
        incarnation: entry.incarnation,
        removals: entry.removals,
        identityChanges: entry.identityChanges,
        sourceLosses: entry.sourceLosses,
      };
    },
    patchConfig({ patch, expectedRevision }) {
      if (session.isClosed) return errorResult('session-closed', 'The workspace session is closed.');
      if (sessionState.activeMutations.has(bindingKey(bound))) {
        return errorResult('stale-revision', 'Another linked-view mutation is still being synchronized.');
      }
      const { entry, analysis } = current();
      const before = buildSnapshot(analysis, entry);
      if (before.status === 'missing') return errorResult('missing', 'The linked view is no longer present.');
      if (before.status === 'unsupported') return errorResult('unsupported', before.diagnostic.message);
      if (before.readonly) return errorResult('read-only', before.diagnostic?.message ?? 'This linked view is read only.');
      if (expectedRevision !== before.revision) return errorResult('stale-revision', 'The linked view changed after this snapshot was read.');
      const validated = validPatch(patch, before.config, bound.viewId, bound.sourceDatabaseId);
      if (!validated.ok) return errorResult('invalid-config', validated.message);
      if (configFingerprint(validated.config) === configFingerprint(before.config)) {
        return deepFreeze({ status: 'no-op' as const, pageId: bound.pageId, viewId: bound.viewId, revision: before.revision });
      }

      const latest = session.getState();
      const latestDoc = latest.docs[bound.pageId];
      if (!latestDoc) return errorResult('missing', 'The linked-view note is no longer available.');
      const located = locateViews(latestDoc, bound.viewId);
      if (located.matchingNodes.length !== 1 || !located.node || polarisDadosViewDocIssue(latestDoc)) {
        return errorResult('unsupported', 'The linked-view node could not be located uniquely.');
      }
      const latestData = located.node.attrs;
      if (!isPolarisDadosViewData(latestData) || latestData.sourceDatabaseId !== bound.sourceDatabaseId) {
        return errorResult('unsupported', 'The linked-view node is no longer supported for this binding.');
      }
      const newData = dataWithConfig(latestData.viewId, latestData.sourceDatabaseId, validated.config);
      try {
        encodePolarisDadosViewMarker(newData);
      } catch (error) {
        return errorResult('invalid-config', error instanceof Error ? error.message : String(error));
      }
      const nextDoc = replaceNodeAttrs(latestDoc, bound.viewId, newData);
      if (!nextDoc) return errorResult('missing', 'The linked-view node is no longer present.');

      if (hooks.beforeStage && !hooks.beforeStage(latestDoc, nextDoc)) {
        return errorResult('page-editor-conflict', 'The open page editors cannot accept this linked-view update safely.');
      }
      if (session.getState().docs[bound.pageId] !== latestDoc) {
        return errorResult('stale-revision', 'The page changed while the linked-view update was being prepared.');
      }
      const postPreflight = current();
      const postPreflightSnapshot = buildSnapshot(postPreflight.analysis, postPreflight.entry);
      if (
        postPreflightSnapshot.status !== 'ready' ||
        postPreflightSnapshot.readonly ||
        postPreflightSnapshot.revision !== expectedRevision
      ) {
        return errorResult('stale-revision', 'The linked-view state changed while the update was being prepared.');
      }

      sessionState.activeMutations.set(bindingKey(bound), {
        entry,
        analysis,
        targetConfig: validated.config,
        nonConfigFingerprint: analysis.nonConfigFingerprint,
      });
      const committed = (() => {
        try {
          return mutatePageDoc(session, bound, nextDoc);
        } catch {
          return session.getState().docs[bound.pageId] !== latestDoc;
        }
      })();
      if (!committed) {
        sessionState.activeMutations.delete(bindingKey(bound));
        publish(sessionState);
        return errorResult('read-only', 'The linked-view config could not be staged.');
      }

      const accepted = refreshAfterOwnMutation(session, sessionState, bound);
      const peersAccepted = (() => {
        try {
          return hooks.afterStage?.() ?? true;
        } catch {
          return false;
        }
      })();
      sessionState.activeMutations.delete(bindingKey(bound));
      if (!accepted) {
        publish(sessionState);
        return errorResult('stale-revision', 'The linked-view update was not accepted by every open page editor.');
      }
      history.undo.push({ before: copyConfig(before.config), after: copyConfig(validated.config) });
      if (history.undo.length > MAX_HISTORY_STEPS) history.undo.shift();
      history.redo = [];
      const updated = current();
      const acceptedRevision = updated.entry.revision;
      publish(sessionState);
      const revalidationError = revalidateAcceptedStage(validated.config, analysis.nonConfigFingerprint, acceptedRevision);
      if (revalidationError) return revalidationError;
      if (!peersAccepted) return stagedMutationConflict(bound, acceptedRevision);
      return deepFreeze({
        status: 'staged' as const,
        pageId: bound.pageId,
        viewId: bound.viewId,
        revision: acceptedRevision,
      });
    },
    history({ direction, expectedRevision }) {
      if (session.isClosed) return errorResult('session-closed', 'The workspace session is closed.');
      if (sessionState.activeMutations.has(bindingKey(bound))) {
        return errorResult('stale-revision', 'Another linked-view mutation is still being synchronized.');
      }
      const { entry, analysis } = current();
      const before = buildSnapshot(analysis, entry);
      if (before.status === 'missing') return errorResult('missing', 'The linked view is no longer present.');
      if (before.status === 'unsupported') return errorResult('unsupported', before.diagnostic.message);
      if (before.readonly) return errorResult('read-only', before.diagnostic?.message ?? 'This linked view is read only.');
      if (expectedRevision !== before.revision) return errorResult('stale-revision', 'The linked view changed after this snapshot was read.');
      const step = direction === 'undo' ? history.undo.at(-1) : history.redo.at(-1);
      if (!step) return deepFreeze({ status: 'no-op' as const, pageId: bound.pageId, viewId: bound.viewId, revision: before.revision, direction });
      const expectedConfig = direction === 'undo' ? step.after : step.before;
      const targetConfig = direction === 'undo' ? step.before : step.after;
      if (configFingerprint(before.config) !== configFingerprint(expectedConfig)) {
        history.undo = [];
        history.redo = [];
        publish(sessionState);
        return errorResult('stale-revision', 'The current config no longer matches this history step.');
      }
      const validated = validPatch(targetConfig, before.config, bound.viewId, bound.sourceDatabaseId);
      if (!validated.ok) return errorResult('invalid-config', validated.message);
      const latestDoc = session.getState().docs[bound.pageId];
      const located = locateViews(latestDoc, bound.viewId);
      const latestData = located.node?.attrs;
      if (
        !latestDoc ||
        located.matchingNodes.length !== 1 ||
        !located.node ||
        polarisDadosViewDocIssue(latestDoc) ||
        !isPolarisDadosViewData(latestData) ||
        latestData.sourceDatabaseId !== bound.sourceDatabaseId
      ) {
        return errorResult('unsupported', 'The linked-view node could not be located uniquely for history.');
      }
      const nextData = dataWithConfig(latestData.viewId, latestData.sourceDatabaseId, validated.config);
      const nextDoc = replaceNodeAttrs(latestDoc, bound.viewId, nextData);
      if (!nextDoc) return errorResult('missing', 'The linked-view node is no longer present.');
      if (hooks.beforeStage && !hooks.beforeStage(latestDoc, nextDoc)) {
        return errorResult('page-editor-conflict', 'The open page editors cannot accept this linked-view history step safely.');
      }
      if (session.getState().docs[bound.pageId] !== latestDoc) {
        return errorResult('stale-revision', 'The page changed while linked-view history was being prepared.');
      }
      const postPreflight = current();
      const postPreflightSnapshot = buildSnapshot(postPreflight.analysis, postPreflight.entry);
      if (
        postPreflightSnapshot.status !== 'ready' ||
        postPreflightSnapshot.readonly ||
        postPreflightSnapshot.revision !== expectedRevision
      ) {
        return errorResult('stale-revision', 'The linked-view state changed while history was being prepared.');
      }
      sessionState.activeMutations.set(bindingKey(bound), {
        entry,
        analysis,
        targetConfig: validated.config,
        nonConfigFingerprint: analysis.nonConfigFingerprint,
      });
      const committed = (() => {
        try {
          return mutatePageDoc(session, bound, nextDoc);
        } catch {
          return session.getState().docs[bound.pageId] !== latestDoc;
        }
      })();
      if (!committed) {
        sessionState.activeMutations.delete(bindingKey(bound));
        publish(sessionState);
        return errorResult('read-only', 'The linked-view history step could not be staged.');
      }
      const accepted = refreshAfterOwnMutation(session, sessionState, bound);
      const peersAccepted = (() => {
        try {
          return hooks.afterStage?.() ?? true;
        } catch {
          return false;
        }
      })();
      sessionState.activeMutations.delete(bindingKey(bound));
      if (!accepted) {
        publish(sessionState);
        return errorResult('stale-revision', 'The linked-view history step was not accepted by every open page editor.');
      }
      if (direction === 'undo') {
        history.undo.pop();
        history.redo.push(step);
      } else {
        history.redo.pop();
        history.undo.push(step);
        if (history.undo.length > MAX_HISTORY_STEPS) history.undo.shift();
      }
      const updated = current();
      const acceptedRevision = updated.entry.revision;
      publish(sessionState);
      const revalidationError = revalidateAcceptedStage(validated.config, analysis.nonConfigFingerprint, acceptedRevision);
      if (revalidationError) return revalidationError;
      if (!peersAccepted) return stagedHistoryConflict(bound, acceptedRevision, direction);
      return deepFreeze({
        status: 'staged' as const,
        pageId: bound.pageId,
        viewId: bound.viewId,
        revision: acceptedRevision,
        direction,
      });
    },
    subscribe(listener) {
      sessionState.listeners.add(listener);
      return () => sessionState.listeners.delete(listener);
    },
  };
}
