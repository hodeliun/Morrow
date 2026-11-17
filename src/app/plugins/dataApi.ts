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
      if (!isActive()) return apiError('owner-inactive', 'This plugin data API handle is no longer active.');
      if (options.isHostReadonly()) return apiError('host-readonly', 'Morrow is in read-only mode.');
      if (!options.isProviderActive(input.databaseId)) {
        return apiError('provider-inactive', 'No active provider owns this database.');
      }
      const snapshot = backend.snapshot(input.databaseId);
      if (snapshot.status === 'missing') return apiError('not-opted-in', 'That database is not opted in.');
      if (snapshot.status === 'unsupported') return apiError('unsupported', snapshot.diagnostic.message);
      const result = backend.patchCell(input);
      if (!result.ok) return apiError(result.code as DataApiErrorCode, result.message);
      return freeze({
        status: 'staged' as const,
        databaseId: input.databaseId,
        rowId: input.rowId,
        propertyId: input.propertyId,
        revision: result.revision,
      });
    },
    history(input: {
      databaseId: PageId;
      direction: 'undo' | 'redo';
      expectedRevision: string;
    }): DataApiHistoryResult {
      if (!isActive()) return apiError('owner-inactive', 'This plugin data API handle is no longer active.');
      const runtimeInput = input as unknown as {
        databaseId?: unknown;
        direction?: unknown;
        expectedRevision?: unknown;
      } | null;
      if (
        !runtimeInput ||
        typeof runtimeInput.databaseId !== 'string' ||
        runtimeInput.databaseId.length === 0
      ) {
        return apiError('invalid-value', 'History requires a database identifier.');
      }
      if (runtimeInput.direction !== 'undo' && runtimeInput.direction !== 'redo') {
        return apiError('invalid-value', 'History direction must be undo or redo.');
      }
      if (typeof runtimeInput.expectedRevision !== 'string') {
        return apiError('invalid-value', 'History requires a snapshot revision.');
      }
      const databaseId = runtimeInput.databaseId as PageId;
      const direction = runtimeInput.direction;
      if (options.isHostReadonly()) return apiError('host-readonly', 'Morrow is in read-only mode.');
      if (!options.isProviderActive(databaseId)) {
        return apiError('provider-inactive', 'No active provider owns this database.');
      }
      const snapshot = backend.snapshot(databaseId);
      if (snapshot.status === 'missing') return apiError('not-opted-in', 'That database is not opted in.');
      if (snapshot.status === 'unsupported') return apiError('unsupported', snapshot.diagnostic.message);
      const result = backend.history({
        databaseId,
        direction,
        expectedRevision: runtimeInput.expectedRevision,
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
