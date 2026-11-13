import type { PageId } from '../../core/model';
import {
  canSynchronizePageEditorDoc,
  commitPageEditorDraft,
  isPageEditorDocumentSynchronized,
} from '../editor/pageEditorCoordination';
import { createPilotLinkedViewBackend } from '../../storage/pilotLinkedViews';
import type { WorkspaceSession } from '../../storage/session';

export type LinkedViewDeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly LinkedViewDeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: LinkedViewDeepReadonly<T[Key]> }
      : T;

export interface LinkedViewConfig {
  readonly title: string;
  readonly columnOrder: readonly string[];
  readonly filter: {
    readonly propertyId: string;
    readonly op: 'gte';
    readonly value: number;
  } | null;
}

export interface LinkedViewDiagnostic {
  readonly code:
    | 'page-unreadable'
    | 'unsupported-view-node'
    | 'duplicate-view'
    | 'source-mismatch'
    | 'source-missing'
    | 'source-trashed'
    | 'source-unsupported'
    | 'column-order-property-missing'
    | 'filter-property-missing'
    | 'filter-property-not-numeric'
    | 'host-readonly'
    | 'save-conflict';
  readonly message: string;
}

export interface LinkedViewSourceStatus {
  readonly status: 'available' | 'missing' | 'trashed' | 'unsupported';
  readonly diagnostic: LinkedViewDiagnostic | null;
}

export type LinkedViewSnapshot =
  | {
      readonly version: 1;
      readonly status: 'ready';
      readonly pageId: PageId;
      readonly viewId: string;
      readonly sourceDatabaseId: PageId;
      readonly revision: string;
      readonly config: LinkedViewDeepReadonly<LinkedViewConfig>;
      readonly sourceStatus: LinkedViewSourceStatus;
      readonly readonly: boolean;
      readonly diagnostic: LinkedViewDiagnostic | null;
      readonly history: {
        readonly canUndo: boolean;
        readonly canRedo: boolean;
      };
    }
  | {
      readonly version: 1;
      readonly status: 'missing';
      readonly pageId: PageId;
      readonly viewId: string;
      readonly sourceDatabaseId: PageId;
      readonly revision: string;
    }
  | {
      readonly version: 1;
      readonly status: 'unsupported';
      readonly pageId: PageId;
      readonly viewId: string;
      readonly sourceDatabaseId: PageId;
      readonly revision: string;
      readonly diagnostic: LinkedViewDiagnostic;
    };

export type LinkedViewErrorCode =
  | 'owner-inactive'
  | 'session-closed'
  | 'missing'
  | 'unsupported'
  | 'stale-revision'
  | 'read-only'
  | 'invalid-config'
  | 'page-editor-conflict'
  | 'save-conflict'
  | 'save-failed';

export type LinkedViewMutationResult =
  | {
      readonly status: 'staged' | 'no-op';
      readonly pageId: PageId;
      readonly viewId: string;
      readonly revision: string;
    }
  | { readonly status: 'error'; readonly code: LinkedViewErrorCode; readonly message: string }
  | {
      readonly status: 'error';
      readonly code: Exclude<LinkedViewErrorCode, 'page-editor-conflict'>;
      readonly message: string;
      readonly staged: true;
      readonly pageId: PageId;
      readonly viewId: string;
      readonly revision: string;
    }
  | {
      readonly status: 'error';
      readonly code: 'page-editor-conflict';
      readonly message: string;
      readonly staged: true;
      readonly pageId: PageId;
      readonly viewId: string;
      readonly revision: string;
    };

export type LinkedViewHistoryResult =
  | {
      readonly status: 'staged' | 'no-op';
      readonly pageId: PageId;
      readonly viewId: string;
      readonly revision: string;
      readonly direction: 'undo' | 'redo';
    }
  | { readonly status: 'error'; readonly code: LinkedViewErrorCode; readonly message: string }
  | {
      readonly status: 'error';
      readonly code: Exclude<LinkedViewErrorCode, 'page-editor-conflict'>;
      readonly message: string;
      readonly staged: true;
      readonly pageId: PageId;
      readonly viewId: string;
      readonly revision: string;
    }
  | {
      readonly status: 'error';
      readonly code: 'page-editor-conflict';
      readonly message: string;
      readonly staged: true;
      readonly pageId: PageId;
      readonly viewId: string;
      readonly revision: string;
      readonly direction: 'undo' | 'redo';
    };

export type LinkedViewFlushResult =
  | { readonly status: 'persisted'; readonly pageId: PageId; readonly viewId: string; readonly revision: string }
  | {
      readonly status: 'error';
      readonly code: LinkedViewErrorCode;
      readonly message: string;
      readonly staged?: true;
      readonly pageId?: PageId;
      readonly viewId?: string;
      readonly revision?: string;
    }
  | {
      readonly status: 'error';
      readonly code: 'page-editor-conflict';
      readonly message: string;
      readonly staged: true;
      readonly pageId: PageId;
      readonly viewId: string;
      readonly revision: string;
    };

/** Type-only public API. Plugins should import this interface with `import type`. */
export interface LinkedViewApi {
  readonly version: 1;
  snapshot(): LinkedViewSnapshot;
  patchConfig(input: { patch: Partial<LinkedViewConfig>; expectedRevision: string }): LinkedViewMutationResult;
  history(input: { direction: 'undo' | 'redo'; expectedRevision: string }): LinkedViewHistoryResult;
  subscribe(listener: (snapshot: LinkedViewSnapshot) => void): () => void;
  flush(): Promise<LinkedViewFlushResult>;
}

export interface CreateLinkedViewApiOptions {
  session: WorkspaceSession;
  pageId: PageId;
  viewId: string;
  sourceDatabaseId: PageId;
  /** Unique for one provider mount; obsolete generations cannot revive a handle. */
  mountGeneration: string | number | symbol | object;
  ownerIsActive: () => boolean;
  isMountGenerationActive: (generation: CreateLinkedViewApiOptions['mountGeneration']) => boolean;
  isHostReadonly: () => boolean;
  registerCleanup: (cleanup: () => void) => void;
}

interface LinkedViewLifecycle {
  incarnation: number;
  removals: number;
  identityChanges: number;
  sourceLosses: number;
}

type LinkedViewApiGuardError =
  | { readonly status: 'error'; readonly code: LinkedViewErrorCode; readonly message: string }
  | {
      readonly status: 'error';
      readonly code: Exclude<LinkedViewErrorCode, 'page-editor-conflict'>;
      readonly message: string;
      readonly staged: true;
      readonly pageId: PageId;
      readonly viewId: string;
      readonly revision: string;
    };

/** Host-only factory. Plugin bundles receive a bound LinkedViewApi, never the session object. */
export function createLinkedViewApi(options: CreateLinkedViewApiOptions): LinkedViewApi {
  let disposed = false;
  let stageGuardError: { code: Exclude<LinkedViewErrorCode, 'page-editor-conflict'>; message: string } | null = null;
  const backend = createPilotLinkedViewBackend(options.session, {
    pageId: options.pageId,
    viewId: options.viewId,
    sourceDatabaseId: options.sourceDatabaseId,
  }, {
    beforeStage: (currentDoc, nextDoc) => {
      if (!canSynchronizePageEditorDoc(options.session, options.pageId, currentDoc, nextDoc)) return false;
      if (options.session.isClosed) {
        stageGuardError = { code: 'session-closed', message: 'The workspace session closed during editor preflight.' };
        return false;
      }
      if (disposed || !options.ownerIsActive() || !options.isMountGenerationActive(options.mountGeneration)) {
        stageGuardError = { code: 'owner-inactive', message: 'The linked-view owner changed during editor preflight.' };
        return false;
      }
      if (options.session.saveStatus.errorCode === 'save-conflict') {
        stageGuardError = { code: 'save-conflict', message: options.session.saveStatus.error ?? 'A previous save conflicted.' };
        return false;
      }
      try {
        if (options.isHostReadonly()) {
          stageGuardError = { code: 'read-only', message: 'Morrow is in read-only mode.' };
          return false;
        }
      } catch {
        stageGuardError = { code: 'read-only', message: 'The host read-only state could not be verified.' };
        return false;
      }
      return true;
    },
    afterStage: () => isPageEditorDocumentSynchronized(options.session, options.pageId),
  });
  const initialSnapshot = backend.snapshot();
  const boundLifecycle = backend.lifecycle();
  const subscriptions = new Set<() => void>();
  let confirmationPending = false;
  let stagedRevision: string | null = null;
  let terminalSnapshot: LinkedViewSnapshot | null = initialSnapshot.status === 'missing' ||
    (initialSnapshot.status === 'unsupported' && initialSnapshot.diagnostic.code === 'source-mismatch')
    ? freeze(initialSnapshot)
    : null;

  const missingSnapshot = (revision: string): LinkedViewSnapshot => Object.freeze({
    version: 1 as const,
    status: 'missing' as const,
    pageId: options.pageId,
    viewId: options.viewId,
    sourceDatabaseId: options.sourceDatabaseId,
    revision,
  });
  const unsupportedSnapshot = (revision: string, message: string): LinkedViewSnapshot => freeze({
    version: 1 as const,
    status: 'unsupported' as const,
    pageId: options.pageId,
    viewId: options.viewId,
    sourceDatabaseId: options.sourceDatabaseId,
    revision,
    diagnostic: { code: 'source-unsupported' as const, message },
  });

  const ownerIsActive = () => !disposed && options.ownerIsActive() && options.isMountGenerationActive(options.mountGeneration);
  const isActive = () => !options.session.isClosed && ownerIsActive();
  const assertActive = () => {
    if (options.session.isClosed) throw new Error('This linked-view API session is closed.');
    if (!ownerIsActive()) throw new Error('This linked-view API handle is no longer active.');
  };
  const inactiveError = (): Exclude<LinkedViewErrorCode, 'page-editor-conflict'> =>
    options.session.isClosed ? 'session-closed' : 'owner-inactive';
  const makeError = (code: LinkedViewErrorCode, message: string) => Object.freeze({ status: 'error' as const, code, message });
  const stagedApiError = (code: Exclude<LinkedViewErrorCode, 'page-editor-conflict'>, message: string, revision: string): Extract<LinkedViewApiGuardError, { staged: true }> => freeze({
    status: 'error' as const,
    code,
    message,
    staged: true as const,
    pageId: options.pageId,
    viewId: options.viewId,
    revision,
  });
  const flushSnapshotError = (snapshot: LinkedViewSnapshot, revision: string | null): LinkedViewFlushResult | null => {
    let code: Exclude<LinkedViewErrorCode, 'page-editor-conflict'> | null = null;
    let message = '';
    if (snapshot.status === 'missing') {
      code = 'missing';
      message = 'The linked view is no longer present.';
    } else if (snapshot.status === 'unsupported') {
      code = 'unsupported';
      message = snapshot.diagnostic.message;
    } else if (
      snapshot.pageId !== options.pageId ||
      snapshot.viewId !== options.viewId ||
      snapshot.sourceDatabaseId !== options.sourceDatabaseId
    ) {
      code = 'unsupported';
      message = 'The linked-view handle no longer matches its bound identity.';
    } else if (snapshot.sourceStatus.status !== 'available') {
      code = snapshot.sourceStatus.status === 'unsupported' ? 'unsupported' : 'read-only';
      message = snapshot.sourceStatus.diagnostic?.message ?? 'The linked-view source is no longer available.';
    } else if (snapshot.readonly) {
      code = snapshot.diagnostic?.code === 'save-conflict' ? 'save-conflict' : 'read-only';
      message = snapshot.diagnostic?.message ?? 'The linked view is read only.';
    }
    if (!code) return null;
    return revision === null ? makeError(code, message) : stagedApiError(code, message, revision);
  };
  const isStagedResult = (result: LinkedViewMutationResult | LinkedViewHistoryResult): boolean =>
    result.status === 'staged' || (result.status === 'error' && 'staged' in result && result.staged === true);
  const validateMutationResult = <T extends LinkedViewMutationResult | LinkedViewHistoryResult>(result: T): T | LinkedViewApiGuardError => {
    if (!isActive()) {
      if (isStagedResult(result)) {
        const revision = 'revision' in result ? result.revision : '';
        return stagedApiError(inactiveError(), 'The linked-view owner or session ended after the change was staged.', revision);
      }
      return makeError(inactiveError(), 'The linked-view owner or session is no longer active.');
    }
    if (stageGuardError && result.status === 'error' && !('staged' in result)) {
      return makeError(stageGuardError.code, stageGuardError.message);
    }
    if (result.status !== 'staged') return result;
    let latest: LinkedViewSnapshot;
    try {
      latest = read();
    } catch {
      return stagedApiError('read-only', 'The host state could not be checked after staging.', result.revision);
    }
    if (latest.status === 'missing') return stagedApiError('missing', 'The linked view was removed after the change was staged.', result.revision);
    if (latest.status === 'unsupported') return stagedApiError('unsupported', latest.diagnostic.message, result.revision);
    if (latest.readonly) {
      const code = latest.diagnostic?.code === 'save-conflict' ? 'save-conflict' : 'read-only';
      return stagedApiError(code, latest.diagnostic?.message ?? 'The linked view became read only after staging.', result.revision);
    }
    if (latest.revision !== result.revision) {
      return stagedApiError('stale-revision', 'The linked-view revision changed before the staged result could be returned.', result.revision);
    }
    return result;
  };

  const rawSnapshot = (): LinkedViewSnapshot => {
    if (terminalSnapshot) return terminalSnapshot;
    const snapshot = backend.snapshot();
    const lifecycle: LinkedViewLifecycle = backend.lifecycle();
    if (snapshot.status === 'missing' || lifecycle.removals > boundLifecycle.removals) {
      terminalSnapshot = snapshot.status === 'missing' ? snapshot : missingSnapshot(snapshot.revision);
      return terminalSnapshot;
    }
    if (lifecycle.identityChanges > boundLifecycle.identityChanges ||
      (snapshot.status === 'unsupported' && snapshot.diagnostic.code === 'source-mismatch')) {
      terminalSnapshot = snapshot.status === 'unsupported'
        ? snapshot
        : unsupportedSnapshot(snapshot.revision, 'The linked-view source identity changed after this handle was bound.');
      return terminalSnapshot;
    }
    if (
      lifecycle.sourceLosses > boundLifecycle.sourceLosses &&
      snapshot.status === 'ready' &&
      snapshot.sourceStatus.status === 'available'
    ) {
      terminalSnapshot = unsupportedSnapshot(
        snapshot.revision,
        'The source database was removed or became unsupported after this handle was bound; create a new handle to reconnect.',
      );
      return terminalSnapshot;
    }
    return snapshot;
  };
  const read = (): LinkedViewSnapshot => {
    assertActive();
    const snapshot = rawSnapshot();
    if (snapshot.status !== 'ready') return snapshot;
    const queueConflict = options.session.saveStatus.errorCode === 'save-conflict';
    const hostReadonly = options.isHostReadonly();
    const blocker = queueConflict
      ? { code: 'save-conflict' as const, message: options.session.saveStatus.error ?? 'A previous save conflicted.' }
      : hostReadonly
        ? { code: 'host-readonly' as const, message: 'Morrow is in read-only mode.' }
        : null;
    const diagnostic = blocker ?? snapshot.diagnostic;
    const readonly = snapshot.readonly || blocker !== null;
    return freeze({
      ...snapshot,
      readonly,
      diagnostic,
      history: readonly ? { canUndo: false, canRedo: false } : snapshot.history,
    });
  };
  const stopSubscriptions = () => {
    for (const stop of [...subscriptions]) stop();
    subscriptions.clear();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stopSubscriptions();
  };
  const unsubscribeClose = options.session.onClose(dispose);
  options.registerCleanup(() => {
    unsubscribeClose();
    dispose();
  });

  const preflight = (expectedRevision: string):
    | { snapshot: Extract<LinkedViewSnapshot, { status: 'ready' }> }
    | { error: LinkedViewErrorCode; message: string } => {
    if (!isActive()) return { error: inactiveError(), message: 'This linked-view API handle is no longer active.' };
    const snapshot = read();
    if (snapshot.status === 'missing') return { error: 'missing', message: 'The linked view is no longer present.' };
    if (snapshot.status === 'unsupported') return { error: 'unsupported', message: snapshot.diagnostic.message };
    if (snapshot.readonly) {
      const code = snapshot.diagnostic?.code === 'save-conflict' ? 'save-conflict' : 'read-only';
      return { error: code, message: snapshot.diagnostic?.message ?? 'This linked view is read only.' };
    }
    if (snapshot.revision !== expectedRevision) {
      return { error: 'stale-revision', message: 'The linked view changed after this snapshot was read.' };
    }
    return { snapshot };
  };
  const drainEditorDraft = (): boolean => {
    try {
      return commitPageEditorDraft(options.session, options.pageId);
    } catch {
      return false;
    }
  };

  return Object.freeze({
    version: 1 as const,
    snapshot: read,
    patchConfig(input: { patch: Partial<LinkedViewConfig>; expectedRevision: string }): LinkedViewMutationResult {
      if (!input || typeof input !== 'object' || typeof input.expectedRevision !== 'string') {
        return makeError('invalid-config', 'A linked-view patch requires an expected revision.');
      }
      const checked = preflight(input.expectedRevision);
      if ('error' in checked) return makeError(checked.error, checked.message);
      if (!drainEditorDraft()) return makeError('page-editor-conflict', 'The open page editor could not commit its current draft.');
      const afterDrain = preflight(input.expectedRevision);
      if ('error' in afterDrain) return makeError(afterDrain.error, afterDrain.message);
      stageGuardError = null;
      const result = validateMutationResult(backend.patchConfig({ patch: input.patch, expectedRevision: afterDrain.snapshot.revision }));
      if (result.status === 'staged') stagedRevision = result.revision;
      if (result.status === 'error' && 'staged' in result && result.staged) {
        confirmationPending = true;
        stagedRevision = result.revision;
      }
      return freeze(result);
    },
    history(input: { direction: 'undo' | 'redo'; expectedRevision: string }): LinkedViewHistoryResult {
      if (
        !input ||
        typeof input !== 'object' ||
        typeof input.expectedRevision !== 'string' ||
        (input.direction !== 'undo' && input.direction !== 'redo')
      ) {
        return makeError('invalid-config', 'History requires a direction and expected revision.');
      }
      const checked = preflight(input.expectedRevision);
      if ('error' in checked) return makeError(checked.error, checked.message);
      if (!drainEditorDraft()) return makeError('page-editor-conflict', 'The open page editor could not commit its current draft.');
      const afterDrain = preflight(input.expectedRevision);
      if ('error' in afterDrain) return makeError(afterDrain.error, afterDrain.message);
      stageGuardError = null;
      const result = validateMutationResult(backend.history({ direction: input.direction, expectedRevision: afterDrain.snapshot.revision }));
      if (result.status === 'staged') stagedRevision = result.revision;
      if (result.status === 'error' && 'staged' in result && result.staged) {
        confirmationPending = true;
        stagedRevision = result.revision;
      }
      return freeze(result);
    },
    subscribe(listener: (snapshot: LinkedViewSnapshot) => void): () => void {
      assertActive();
      let stopped = false;
      let removeBackend = () => {};
      let previous: LinkedViewSnapshot | null = null;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        removeBackend();
        subscriptions.delete(stop);
      };
      const notify = () => {
        if (stopped) return;
        if (!isActive()) {
          stop();
          return;
        }
        try {
          const snapshot = read();
          if (previous && JSON.stringify(snapshot) === JSON.stringify(previous)) return;
          previous = snapshot;
          listener(snapshot);
          if (snapshot.status === 'missing') stop();
        } catch {
          stop();
        }
      };
      subscriptions.add(stop);
      removeBackend = backend.subscribe(notify);
      notify();
      return stop;
    },
    async flush(): Promise<LinkedViewFlushResult> {
      if (!isActive()) return makeError(inactiveError(), 'This linked-view API handle is no longer active.');
      const before = rawSnapshot();
      const beforeError = flushSnapshotError(before, stagedRevision);
      if (beforeError) return beforeError;
      const editorsSynchronized = (): boolean => isPageEditorDocumentSynchronized(options.session, options.pageId);
      if (!editorsSynchronized()) {
        const drained = drainEditorDraft();
        if (!drained || !editorsSynchronized()) {
          if (confirmationPending || stagedRevision) {
            return freeze({
              status: 'error' as const,
              code: 'page-editor-conflict' as const,
              message: 'The linked-view change is still staged, but an open editor has not synchronized. Retry after synchronization.',
              staged: true as const,
              pageId: options.pageId,
              viewId: options.viewId,
              revision: stagedRevision ?? before.revision,
            });
          }
          return makeError('page-editor-conflict', 'The open page editor could not be synchronized before saving.');
        }
        if (!isActive()) {
          return stagedRevision
            ? stagedApiError(inactiveError(), 'The linked-view owner or session ended before saving.', stagedRevision)
            : makeError(inactiveError(), 'This linked-view API handle is no longer active.');
        }
        const afterDrainError = flushSnapshotError(rawSnapshot(), stagedRevision);
        if (afterDrainError) return afterDrainError;
        confirmationPending = false;
      }
      let persisted: boolean;
      try {
        persisted = await options.session.flush();
      } catch (error) {
        if (!isActive()) {
          return stagedRevision
            ? stagedApiError(inactiveError(), 'The linked-view owner or session ended while saving.', stagedRevision)
            : makeError(inactiveError(), 'This linked-view API handle is no longer active.');
        }
        if (stagedRevision) {
          return freeze({
            status: 'error' as const,
            code: 'save-failed' as const,
            message: error instanceof Error ? error.message : String(error),
            staged: true as const,
            pageId: options.pageId,
            viewId: options.viewId,
            revision: stagedRevision,
          });
        }
        return makeError('save-failed', error instanceof Error ? error.message : String(error));
      }
      if (!isActive()) {
        return stagedRevision
          ? stagedApiError(inactiveError(), 'The linked-view owner or session ended while saving.', stagedRevision)
          : makeError(inactiveError(), 'This linked-view API handle is no longer active.');
      }
      if (!persisted) {
        const status = options.session.saveStatus;
        const code = status.errorCode === 'save-conflict' ? 'save-conflict' : 'save-failed';
        const message = status.error ?? 'The workspace changes could not be saved.';
        if (stagedRevision) {
          return freeze({
            status: 'error' as const,
            code,
            message,
            staged: true as const,
            pageId: options.pageId,
            viewId: options.viewId,
            revision: stagedRevision,
          });
        }
        return makeError(code, message);
      }
      let after: LinkedViewSnapshot;
      try {
        after = read();
      } catch {
        return stagedRevision
          ? stagedApiError('read-only', 'The linked-view state could not be checked after saving.', stagedRevision)
          : makeError('read-only', 'The linked-view state could not be checked after saving.');
      }
      const afterError = flushSnapshotError(after, stagedRevision);
      if (afterError) return afterError;
      if (!editorsSynchronized()) {
        confirmationPending = true;
        return freeze({
          status: 'error' as const,
          code: 'page-editor-conflict' as const,
          message: 'The save completed, but an open editor is not synchronized. Retry after synchronization.',
          ...(stagedRevision ? { staged: true as const, pageId: options.pageId, viewId: options.viewId, revision: stagedRevision } : {}),
        });
      }
      confirmationPending = false;
      stagedRevision = null;
      return freeze({ status: 'persisted' as const, pageId: options.pageId, viewId: options.viewId, revision: after.revision });
    },
  });
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}
