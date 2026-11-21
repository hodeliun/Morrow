import type { DatabaseDef, PageId, PropValue } from '../../core/model';
import type { WorkspaceSession } from '../../storage/session';
import { createPilotDataBackend } from '../../storage/pilotData';

/**
 * Public, versioned types for the host-loaded plugin data contract. Plugins should import these as
 * types only; the factory below is host implementation detail and is not injected into plugin code.
 */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export interface DataApiDiagnostic {
  readonly code:
    | 'unsupported-database'
    | 'database-trashed'
    | 'database-unreadable'
    | 'row-unreadable'
    | 'ambiguous-schema'
    | 'unrepresentable-cell'
    | 'provider-inactive'
    | 'host-readonly'
    | 'save-conflict';
  readonly message: string;
}

export interface DataApiRow {
  readonly id: PageId;
  readonly title: string;
  /** Missing keys and keys whose value is null remain distinct. */
  readonly properties: DeepReadonly<Record<string, PropValue>>;
}

export type DataApiSnapshot =
  | {
      readonly version: 1;
      readonly status: 'ready';
      readonly databaseId: PageId;
      readonly revision: string;
      readonly schema: DeepReadonly<DatabaseDef>;
      readonly rows: readonly DeepReadonly<DataApiRow>[];
      readonly history: {
        readonly canUndo: boolean;
        readonly canRedo: boolean;
      };
      readonly readonly: boolean;
      readonly diagnostic: DataApiDiagnostic | null;
    }
  | {
      readonly version: 1;
      readonly status: 'missing';
      readonly databaseId: PageId;
      readonly revision: string;
    }
  | {
      readonly version: 1;
      readonly status: 'unsupported';
      readonly databaseId: PageId;
      readonly revision: string;
      readonly diagnostic: DataApiDiagnostic;
    };

export type DataApiErrorCode =
  | 'owner-inactive'
  | 'session-closed'
  | 'provider-inactive'
  | 'host-readonly'
  | 'unsupported'
  | 'not-opted-in'
  | 'out-of-scope'
  | 'stale-revision'
  | 'row-not-found'
  | 'property-not-found'
  | 'read-only'
  | 'invalid-value'
  | 'save-conflict'
  | 'save-failed';

export type DataApiPatchResult =
  | {
      readonly status: 'staged';
      readonly databaseId: PageId;
      readonly rowId: PageId;
      readonly propertyId: string;
      readonly revision: string;
    }
  | { readonly status: 'error'; readonly code: DataApiErrorCode; readonly message: string };

export type DataApiHistoryResult =
  | {
      readonly status: 'staged' | 'no-op';
      readonly databaseId: PageId;
      readonly revision: string;
      readonly direction: 'undo' | 'redo';
    }
  | { readonly status: 'error'; readonly code: DataApiErrorCode; readonly message: string };

export type DataApiFlushResult =
  | { readonly status: 'persisted'; readonly databaseId: PageId; readonly revision: string }
  | { readonly status: 'error'; readonly code: DataApiErrorCode; readonly message: string };

export interface DataApi {
  readonly version: 1;
  /** Returns a deeply immutable, revisioned snapshot. Throws if this plugin handle is inactive. */
  snapshot(databaseId: PageId): DataApiSnapshot;
  /** Stages one finite number edit; the caller must flush to learn whether it reached storage. */
  patchCell(input: {
    databaseId: PageId;
    rowId: PageId;
    propertyId: string;
    value: number;
    expectedRevision: string;
  }): DataApiPatchResult;
  /** Stages one exact text or null edit for an opted-in text property. */
  patchTextCell?(input: {
    databaseId: PageId;
    rowId: PageId;
    propertyId: string;
    value: string | null;
    expectedRevision: string;
  }): DataApiPatchResult;
  /** Restores one contextual data-cell edit in memory; the caller must flush to persist it. */
  history(input: {
    databaseId: PageId;
    direction: 'undo' | 'redo';
    expectedRevision: string;
  }): DataApiHistoryResult;
  /** Delivers the current snapshot immediately, then each later revision/status change. */
  subscribe(databaseId: PageId, listener: (snapshot: DataApiSnapshot) => void): () => void;
  /** Flushes the existing workspace queue; this does not stage another mutation. */
  flush(databaseId: PageId): Promise<DataApiFlushResult>;
}

/** Host-only factory; this is not injected into plugin modules or the public plugin API. */
export function createDataApi(options: {
  session: WorkspaceSession;
  ownerIsActive: () => boolean;
  isProviderActive: (databaseId: PageId) => boolean;
  isHostReadonly: () => boolean;
  registerCleanup: (cleanup: () => void) => void;
}): DataApi {
  const backend = createPilotDataBackend(options.session);
  const subscriptions = new Set<() => void>();
  let disposed = false;
  const isActive = () => !disposed && !options.session.isClosed && options.ownerIsActive();
  const assertActive = () => {
    if (!isActive()) throw new Error('This plugin data API handle is no longer active.');
  };
  const read = (databaseId: PageId): DataApiSnapshot => {
    assertActive();
    const snapshot = backend.snapshot(databaseId);
    if (snapshot.status !== 'ready') return snapshot;
    const saveStatus = options.session.saveStatus;
    const diagnostic = options.isHostReadonly()
      ? { code: 'host-readonly' as const, message: 'Morrow is in read-only mode.' }
      : !options.isProviderActive(databaseId)
        ? { code: 'provider-inactive' as const, message: 'No active provider owns this database.' }
        : saveStatus.errorCode === 'save-conflict'
          ? {
              code: 'save-conflict' as const,
              message: saveStatus.error ?? 'A previous save conflicted with external changes.',
            }
          : null;
    const history = diagnostic ? { canUndo: false, canRedo: false } : snapshot.history;
    return freeze({ ...snapshot, readonly: diagnostic !== null, diagnostic, history });
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const unsubscribe of [...subscriptions]) unsubscribe();
    subscriptions.clear();
  };
  const unsubscribeClose = options.session.onClose(dispose);
  options.registerCleanup(() => {
    unsubscribeClose();
    dispose();
  });

  const patch = (input: unknown, expectedValueType: 'number' | 'text'): DataApiPatchResult => {
    if (!isActive()) return apiError('owner-inactive', 'This plugin data API handle is no longer active.');
    if (options.isHostReadonly()) return apiError('host-readonly', 'Morrow is in read-only mode.');
    const captured = captureCellPatchInput(input, expectedValueType);
    if (captured.databaseId !== null && !options.isProviderActive(captured.databaseId)) {
      return apiError('provider-inactive', 'No active provider owns this database.');
    }
    const parsed = captured.patch;
    if (!parsed)
      return apiError(
        'invalid-value',
        'The cell patch contains an invalid identifier, revision, or scalar value.',
      );
    const snapshot = backend.snapshot(parsed.databaseId);
    if (snapshot.status === 'missing') return apiError('not-opted-in', 'That database is not opted in.');
    if (snapshot.status === 'unsupported') return apiError('unsupported', snapshot.diagnostic.message);
    if (
      expectedValueType === 'number' &&
      snapshot.schema.properties.some(
        (property) => property.id === parsed.propertyId && property.type !== 'number',
      )
    ) {
      return apiError('read-only', 'Only manual number properties can be edited by this API method.');
    }
    const result = backend.patchCell(parsed);
    if (!result.ok) return apiError(result.code as DataApiErrorCode, result.message);
    return freeze({
      status: 'staged' as const,
      databaseId: parsed.databaseId,
      rowId: parsed.rowId,
      propertyId: parsed.propertyId,
      revision: result.revision,
    });
  };

  return Object.freeze({
    version: 1 as const,
    snapshot: read,
    patchCell(input: {
      databaseId: PageId;
      rowId: PageId;
      propertyId: string;
      value: number;
      expectedRevision: string;
    }): DataApiPatchResult {
      return patch(input, 'number');
    },
    patchTextCell(input: {
      databaseId: PageId;
      rowId: PageId;
      propertyId: string;
      value: string | null;
      expectedRevision: string;
    }): DataApiPatchResult {
      return patch(input, 'text');
    },
    history(input: {
      databaseId: PageId;
      direction: 'undo' | 'redo';
      expectedRevision: string;
    }): DataApiHistoryResult {
      if (!isActive()) return apiError('owner-inactive', 'This plugin data API handle is no longer active.');
      if (options.isHostReadonly()) return apiError('host-readonly', 'Morrow is in read-only mode.');
      const captured = captureDataApiHistoryInput(input);
      if (captured.databaseId !== null && !options.isProviderActive(captured.databaseId)) {
        return apiError('provider-inactive', 'No active provider owns this database.');
      }
      if (!captured.input) return apiError('invalid-value', 'History requires a valid database, direction, and revision.');
      const { databaseId, direction } = captured.input;
      const snapshot = backend.snapshot(databaseId);
      if (snapshot.status === 'missing') return apiError('not-opted-in', 'That database is not opted in.');
      if (snapshot.status === 'unsupported') return apiError('unsupported', snapshot.diagnostic.message);
      const result = backend.history({
        databaseId,
        direction,
        expectedRevision: captured.input.expectedRevision,
      });
      if (!result.ok) return apiError(result.code as DataApiErrorCode, result.message);
      return freeze({
        status: result.status,
        databaseId,
        revision: result.revision,
        direction,
      });
    },
    subscribe(databaseId: PageId, listener: (snapshot: DataApiSnapshot) => void) {
      assertActive();
      let previous = read(databaseId);
      let stopped = false;
      let removeSessionListener = () => {};
      let removeQueueListener = () => {};
      const unsubscribe = () => {
        if (stopped) return;
        stopped = true;
        removeSessionListener();
        removeQueueListener();
        subscriptions.delete(unsubscribe);
      };
      const notifyIfChanged = () => {
        if (stopped) return;
        if (!isActive()) {
          unsubscribe();
          return;
        }
        const next = read(databaseId);
        if (JSON.stringify(next) === JSON.stringify(previous)) return;
        previous = next;
        safelyNotify(listener, next);
      };
      subscriptions.add(unsubscribe);
      removeSessionListener = options.session.subscribe(notifyIfChanged);
      removeQueueListener = options.session.queue.subscribe(notifyIfChanged);
      safelyNotify(listener, previous);
      return unsubscribe;
    },
    async flush(databaseId: PageId): Promise<DataApiFlushResult> {
      if (!isActive()) return apiError('owner-inactive', 'This plugin data API handle is no longer active.');
      const before = backend.snapshot(databaseId);
      if (before.status === 'missing') return apiError('not-opted-in', 'That database is not opted in.');
      if (before.status === 'unsupported') return apiError('unsupported', before.diagnostic.message);
      let persisted: boolean;
      try {
        persisted = await backend.flush();
      } catch (error) {
        return apiError('save-failed', error instanceof Error ? error.message : String(error));
      }
      if (!isActive()) return apiError('owner-inactive', 'This plugin data API handle is no longer active.');
      const after = backend.snapshot(databaseId);
      if (after.status === 'missing') return apiError('not-opted-in', 'That database is no longer opted in.');
      if (after.status === 'unsupported') return apiError('unsupported', after.diagnostic.message);
      if (!persisted) {
        const status = options.session.saveStatus;
        const code = status.errorCode === 'save-conflict' ? 'save-conflict' : 'save-failed';
        return apiError(code, status.error ?? 'The workspace changes could not be saved.');
      }
      return freeze({
        status: 'persisted' as const,
        databaseId,
        revision: options.session.pilotDataRevision(databaseId),
      });
    },
  });
}

function apiError(code: DataApiErrorCode, message: string): DataApiPatchResult & DataApiFlushResult {
  return { status: 'error', code, message };
}

export interface DataApiCellPatch<Value extends number | string | null> {
  databaseId: PageId;
  rowId: PageId;
  propertyId: string;
  value: Value;
  expectedRevision: string;
}

export interface CapturedDataApiCellPatch<Value extends number | string | null> {
  /** A valid, own data property captured once, even when another field is invalid. */
  databaseId: PageId | null;
  /** A plain canonical DTO with every field validated for the selected method. */
  patch: DataApiCellPatch<Value> | null;
}

export interface DataApiHistoryInput {
  databaseId: PageId;
  direction: 'undo' | 'redo';
  expectedRevision: string;
}

export interface CapturedDataApiHistoryInput {
  databaseId: PageId | null;
  input: DataApiHistoryInput | null;
}

type RevisionValidation = 'native' | 'opaque';

/** Captures own data fields once and rejects getters/setters before authorization or mutation. */
export function captureCellPatchInput(
  input: unknown,
  expectedValueType: 'number',
  revisionValidation?: RevisionValidation,
): CapturedDataApiCellPatch<number>;
export function captureCellPatchInput(
  input: unknown,
  expectedValueType: 'text',
  revisionValidation?: RevisionValidation,
): CapturedDataApiCellPatch<string | null>;
export function captureCellPatchInput(
  input: unknown,
  expectedValueType: 'number' | 'text',
  revisionValidation?: RevisionValidation,
): CapturedDataApiCellPatch<number | string | null>;
export function captureCellPatchInput(
  input: unknown,
  expectedValueType: 'number' | 'text',
  revisionValidation: RevisionValidation = 'native',
): CapturedDataApiCellPatch<number | string | null> {
  const captured = ownDataFields(input, ['databaseId', 'rowId', 'propertyId', 'value', 'expectedRevision']);
  const values = captured?.values;
  const databaseId = values && isValidId(values.databaseId) ? values.databaseId : null;
  if (!captured?.valid || !values) return { databaseId, patch: null };

  const { rowId, propertyId, value, expectedRevision } = values;
  if (
    !databaseId ||
    !isValidId(rowId) ||
    !isValidId(propertyId) ||
    !isRevision(expectedRevision, revisionValidation)
  ) {
    return { databaseId, patch: null };
  }
  if (
    (expectedValueType === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) ||
    (expectedValueType === 'text' && !(value === null || (typeof value === 'string' && value.length <= 10_000)))
  ) {
    return { databaseId, patch: null };
  }
  return {
    databaseId,
    patch: { databaseId, rowId, propertyId, value, expectedRevision } as DataApiCellPatch<number | string | null>,
  };
}

/** Captures history fields once so provider authorization and mutation use the same values. */
export function captureDataApiHistoryInput(
  input: unknown,
  revisionValidation: RevisionValidation = 'native',
): CapturedDataApiHistoryInput {
  const captured = ownDataFields(input, ['databaseId', 'direction', 'expectedRevision']);
  const values = captured?.values;
  const databaseId = values && isValidId(values.databaseId) ? values.databaseId : null;
  if (
    !captured?.valid ||
    !values ||
    databaseId === null ||
    (values.direction !== 'undo' && values.direction !== 'redo') ||
    !isRevision(values.expectedRevision, revisionValidation)
  ) {
    return { databaseId, input: null };
  }
  return {
    databaseId,
    input: {
      databaseId,
      direction: values.direction,
      expectedRevision: values.expectedRevision,
    },
  };
}

function isRevision(value: unknown, validation: RevisionValidation): value is string {
  return validation === 'opaque'
    ? typeof value === 'string' && value.length > 0
    : isValidRevision(value);
}

function ownDataFields(
  input: unknown,
  fields: readonly string[],
): { values: Record<string, unknown>; valid: boolean } | null {
  if (input === null || typeof input !== 'object') return null;
  try {
    if (Array.isArray(input)) return null;
    const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    let valid = true;
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(input, field);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        valid = false;
        continue;
      }
      values[field] = descriptor.value;
    }
    return { values, valid };
  } catch {
    return null;
  }
}

function isValidId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function isValidRevision(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:r\d+$/i.test(value);
}

function safelyNotify(listener: (snapshot: DataApiSnapshot) => void, snapshot: DataApiSnapshot): void {
  try {
    listener(snapshot);
  } catch {
    // A subscriber cannot interrupt host session updates or other subscribers.
  }
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}
