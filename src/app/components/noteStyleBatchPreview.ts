import { isRecord } from '../../core/doc';
import { displayTitle } from '../../core/model';
import type { PageId, WorkspaceState } from '../../core/model';
import { isEffectivelyTrashed } from '../../core/tree';
import { isValidNoteStyle, resolveDefaultNoteStyle } from '../../core/noteStyle';
import type { NoteStyle } from '../../core/noteStyle';
import type { WorkspaceSession } from '../../storage/session';
import type { NoteStyleRestoreContext } from '../../storage/repository';
import type {
  PluginNoteStyleBatchPreviewHost,
  PluginNoteStyleBatchPreviewLease,
  PluginNoteStyleBatchPreviewMode,
  PluginNoteStyleBatchPreviewSummary,
} from '../plugins/registry';
import { subscribePlugins } from '../plugins/registry';
import {
  getWorkspaceSessionGeneration,
  getSession,
  subscribeWorkspaceSession,
} from '../workspace';
import type { Preferences } from '../platform/preferences';
import { getPreferences, subscribePreferences } from '../platform/preferences';

interface PreviewTarget {
  readonly id: PageId;
  readonly revision: string;
  readonly title: string;
  readonly order: number;
}

interface BuiltPreview {
  readonly targets: readonly PreviewTarget[];
  readonly summary: PluginNoteStyleBatchPreviewSummary;
  readonly eligibilityKey: string;
}

interface PreviewRuntime {
  getSession: typeof getSession;
  getSessionGeneration: typeof getWorkspaceSessionGeneration;
  subscribeSession: typeof subscribeWorkspaceSession;
  getPreferences: typeof getPreferences;
  subscribePreferences: typeof subscribePreferences;
  subscribeRegistration?: (listener: () => void) => () => void;
}

const defaultRuntime: PreviewRuntime = {
  getSession,
  getSessionGeneration: getWorkspaceSessionGeneration,
  subscribeSession: subscribeWorkspaceSession,
  getPreferences,
  subscribePreferences,
  subscribeRegistration: subscribePlugins,
};

export type NoteStyleBatchConfirmationStatus = 'confirmed' | 'refused' | 'unattempted';

export interface NoteStyleBatchConfirmationOutcome {
  readonly title: string;
  readonly order: number;
  readonly status: NoteStyleBatchConfirmationStatus;
}

/** Host-internal result for the next document aggregator; contains no page identity or source data. */
export interface NoteStyleBatchConfirmationResult {
  readonly mode: PluginNoteStyleBatchPreviewMode;
  readonly outcomes: readonly NoteStyleBatchConfirmationOutcome[];
  readonly confirmedCount: number;
  readonly refusedCount: number;
  readonly unattemptedCount: number;
}

/** App-private receipt for the most recent confirmed style batch in one live mount. */
export interface NoteStyleBatchReceiptItem {
  readonly pageId: PageId;
  readonly title: string;
  readonly order: number;
  readonly appliedStyle: Readonly<NoteStyle>;
  readonly restoreContext: NoteStyleRestoreContext | null;
}

export interface NoteStyleBatchReceipt {
  readonly mode: PluginNoteStyleBatchPreviewMode;
  /** Every confirmed op:write; entries with null context do not support undo by themselves. */
  readonly writes: readonly NoteStyleBatchReceiptItem[];
  readonly hasRestorableItems: boolean;
}

interface NoteStyleBatchReceiptScope {
  readonly session: WorkspaceSession;
  readonly generation: number;
  readonly lifecycleGeneration: number;
}

interface NoteStyleBatchReceiptSlot {
  scope: NoteStyleBatchReceiptScope | null;
  receipt: NoteStyleBatchReceipt | null;
  readCurrentScope(): NoteStyleBatchReceiptScope | null;
  nextBatchId: number;
  committedBatchId: number;
  lifecycleGeneration: number;
  disposed: boolean;
  cleanup: Array<() => void>;
}

const noteStyleBatchReceiptSlots = new WeakMap<PluginNoteStyleBatchPreviewHost, NoteStyleBatchReceiptSlot>();

/**
 * Reads the app-private receipt for a host mount. This module is not part of the plugin API; the
 * public host object still exposes summary-only previews and sanitized confirmation results.
 */
export function readLastNoteStyleBatchReceipt(
  host: PluginNoteStyleBatchPreviewHost,
): NoteStyleBatchReceipt | null {
  const slot = noteStyleBatchReceiptSlots.get(host);
  if (!slot || slot.disposed) return null;
  const scope = slot.readCurrentScope();
  if (!scope || !sameReceiptScope(slot.scope, scope)) {
    slot.receipt = null;
    slot.scope = scope;
    return null;
  }
  return slot.receipt;
}

/** Ends one host mount and revokes its private receipt. */
export function disposeNoteStyleBatchPreviewHost(host: PluginNoteStyleBatchPreviewHost): void {
  const slot = noteStyleBatchReceiptSlots.get(host);
  if (!slot || slot.disposed) return;
  try {
    host.invalidate();
  } catch {
    // Revoking the receipt and subscriptions must still happen after lease cleanup errors.
  }
  slot.disposed = true;
  slot.receipt = null;
  slot.scope = null;
  for (const cleanup of slot.cleanup.splice(0)) {
    try {
      cleanup();
    } catch {
      // Teardown must continue if a runtime listener has already been removed.
    }
  }
}

function sameReceiptScope(
  first: NoteStyleBatchReceiptScope | null,
  second: NoteStyleBatchReceiptScope | null,
): boolean {
  return first !== null && second !== null &&
    first.session === second.session &&
    first.generation === second.generation &&
    first.lifecycleGeneration === second.lifecycleGeneration;
}

const previewConfirmations = new WeakMap<
  PluginNoteStyleBatchPreviewLease,
  { consume(): Promise<NoteStyleBatchConfirmationResult | null> }
>();

/** Consumes a host-owned preview once; this function is internal to the app and absent from plugin APIs. */
export function confirmNoteStyleBatchPreview(
  lease: PluginNoteStyleBatchPreviewLease,
): Promise<NoteStyleBatchConfirmationResult | null> {
  return previewConfirmations.get(lease)?.consume() ?? Promise.resolve(null);
}

function stylePreferenceKey(preferences: Preferences): string {
  return JSON.stringify([preferences.font, preferences.width, preferences.defaultNoteStyle]) ?? '';
}

function sameStyle(a: NoteStyle | null, b: NoteStyle): boolean {
  return (
    a !== null &&
    a.font === b.font &&
    a.fontSize === b.fontSize &&
    a.lineHeight === b.lineHeight &&
    a.blockSpacing === b.blockSpacing &&
    a.width === b.width
  );
}

const STORED_STYLE_FIELDS = ['font', 'fontSize', 'lineHeight', 'blockSpacing', 'width'] as const;

function hasExactStoredStyle(value: unknown): value is NoteStyle {
  return (
    isRecord(value) &&
    STORED_STYLE_FIELDS.every((field) => Object.hasOwn(value, field)) &&
    isValidNoteStyle(value)
  );
}

function isDatosRow(
  page: WorkspaceState['pages'][PageId],
  pages: WorkspaceState['pages'],
): boolean {
  const parent = page.parentId ? pages[page.parentId] : undefined;
  return parent?.kind === 'database' && Object.hasOwn(parent.extra, 'polarisDados');
}

function buildPreview(
  session: WorkspaceSession,
  style: NoteStyle,
  mode: PluginNoteStyleBatchPreviewMode,
): BuiltPreview {
  const state = session.getState();
  const targets: PreviewTarget[] = [];
  const eligibility: Array<readonly [PageId, string, string?]> = [];
  const counts = {
    preservedCount: 0,
    noOpCount: 0,
    protectedPageCount: 0,
    protectedFormatCount: 0,
    unsupportedSourceCount: 0,
    unsupportedContainerCount: 0,
  };

  for (const page of Object.values(state.pages)) {
    if (isEffectivelyTrashed(state.pages, page.id)) {
      eligibility.push([page.id, 'trashed']);
      continue;
    }
    if (page.kind === 'journal' || page.kind === 'templates') {
      // These roots can be backed by a folder or a Markdown file. The current typed write API only
      // accepts ordinary Markdown pages, so keep the physical container visible as a diagnostic.
      const physical =
        !page.encrypted &&
        !session.unreadable.has(page.id) &&
        !session.protectedReasons.has(page.id) &&
        session.pathOf(page.id) !== null;
      if (physical) counts.unsupportedContainerCount += 1;
      eligibility.push([page.id, physical ? 'unsupported-container' : 'container']);
      continue;
    }
    if (page.kind !== 'page') continue;
    if (
      page.encrypted ||
      session.unreadable.has(page.id) ||
      session.protectedReasons.has(page.id) ||
      (page.parentId !== null &&
        (session.unreadable.has(page.parentId) || session.protectedReasons.has(page.parentId))) ||
      isDatosRow(page, state.pages)
    ) {
      counts.protectedPageCount += 1;
      eligibility.push([page.id, 'protected-page']);
      continue;
    }

    // The session guard includes liveness, write fencing, host protection, and the opt-in Datos
    // boundary. The physical source check is deliberately not inferred from a display path.
    if (!session.hasWritableNoteStyleSource(page.id)) {
      counts.unsupportedSourceCount += 1;
      eligibility.push([page.id, 'unsupported-source']);
      continue;
    }
    const saved = session.readNoteStyle(page.id);
    if (!saved.ok) {
      counts.protectedPageCount += 1;
      eligibility.push([page.id, 'unreadable-style']);
      continue;
    }

    const hasStyleKey = Object.hasOwn(page.extra, 'morrowNoteStyle');
    if (mode === 'preserve' && hasStyleKey) {
      counts.preservedCount += 1;
      eligibility.push([page.id, 'preserved', saved.value.revision]);
      continue;
    }
    if (mode === 'overwrite' && hasStyleKey) {
      const rawStyle = page.extra.morrowNoteStyle;
      if (!isRecord(rawStyle)) {
        counts.protectedFormatCount += 1;
        eligibility.push([page.id, 'opaque-style', saved.value.revision]);
        continue;
      }
      if (hasExactStoredStyle(rawStyle) && sameStyle(rawStyle, style)) {
        counts.noOpCount += 1;
        eligibility.push([page.id, 'no-op', saved.value.revision]);
        continue;
      }
    }

    if (!session.canUpdateNoteStyleSource(page.id, style)) {
      counts.protectedFormatCount += 1;
      eligibility.push([page.id, 'protected-format', saved.value.revision]);
      continue;
    }

    targets.push({
      id: page.id,
      revision: saved.value.revision,
      title: displayTitle(page),
      order: targets.length + 1,
    });
    eligibility.push([page.id, 'candidate', saved.value.revision]);
  }

  const summary = Object.freeze({
    mode,
    candidateCount: targets.length,
    titles: Object.freeze(targets.slice(0, 4).map(({ title }) => title)),
    ...counts,
  });
  return {
    targets: Object.freeze(targets),
    summary,
    eligibilityKey: JSON.stringify(eligibility),
  };
}

/** Pending/saving always fence; an error fences only while non-quiet changes remain queued. */
function hasUnconfirmedChanges(session: WorkspaceSession): boolean {
  const state = session.saveStatus.state;
  if (state === 'saved') return false;
  if (state === 'error') return session.queue.hasNonQuietPendingChanges();
  return true;
}

/** Creates a host-owned preview lease; plugin code receives only counts and a short title sample. */
export function createNoteStyleBatchPreviewHost(
  isMounted: () => boolean,
  isRegistrationActive: () => boolean,
  runtime: PreviewRuntime = defaultRuntime,
): PluginNoteStyleBatchPreviewHost {
  let activeLease: { invalidate(): void } | null = null;
  let activeExecution: { invalidate(): void } | null = null;
  const receiptSlot: NoteStyleBatchReceiptSlot = {
    scope: null,
    receipt: null,
    readCurrentScope: () => null,
    nextBatchId: 0,
    committedBatchId: 0,
    lifecycleGeneration: 0,
    disposed: false,
    cleanup: [],
  };

  receiptSlot.readCurrentScope = () => {
    try {
      if (receiptSlot.disposed || !isMounted() || !isRegistrationActive()) {
        receiptSlot.receipt = null;
        receiptSlot.lifecycleGeneration++;
        return null;
      }
      const session = runtime.getSession();
      if (session.isClosed) {
        receiptSlot.receipt = null;
        receiptSlot.lifecycleGeneration++;
        return null;
      }
      return {
        session,
        generation: runtime.getSessionGeneration(),
        lifecycleGeneration: receiptSlot.lifecycleGeneration,
      };
    } catch {
      receiptSlot.receipt = null;
      receiptSlot.lifecycleGeneration++;
      return null;
    }
  };

  const clearReceiptWhenScopeChanges = () => {
    if (receiptSlot.disposed) return;
    const scope = receiptSlot.readCurrentScope();
    if (!sameReceiptScope(receiptSlot.scope, scope)) receiptSlot.receipt = null;
    receiptSlot.scope = scope;
  };

  const isReceiptScopeCurrent = (captured: NoteStyleBatchReceiptScope): boolean => {
    const scope = receiptSlot.readCurrentScope();
    if (!scope) {
      receiptSlot.receipt = null;
      receiptSlot.scope = null;
      return false;
    }
    if (!sameReceiptScope(receiptSlot.scope, scope)) {
      receiptSlot.receipt = null;
      receiptSlot.scope = scope;
      return false;
    }
    if (!sameReceiptScope(captured, scope)) return false;
    receiptSlot.scope = scope;
    return true;
  };

  const expireActiveLease = () => {
    const lease = activeLease;
    activeLease = null;
    lease?.invalidate();
  };
  const invalidate = () => {
    expireActiveLease();
    const execution = activeExecution;
    activeExecution = null;
    execution?.invalidate();
  };

  const host: PluginNoteStyleBatchPreviewHost = Object.freeze({
    invalidate,
    create(mode: PluginNoteStyleBatchPreviewMode): PluginNoteStyleBatchPreviewLease | null {
      expireActiveLease();
      clearReceiptWhenScopeChanges();
      if (receiptSlot.disposed) return null;
      if (activeExecution) return null;
      if (!receiptSlot.readCurrentScope()) return null;

      let session: WorkspaceSession;
      let preferences: Preferences;
      try {
        session = runtime.getSession();
        preferences = runtime.getPreferences();
      } catch {
        return null;
      }
      if (
        session.isClosed ||
        session.isMutationFenced ||
        hasUnconfirmedChanges(session)
      )
        return null;

      const generation = runtime.getSessionGeneration();
      const styleKey = stylePreferenceKey(preferences);
      const style = resolveDefaultNoteStyle(
        preferences.defaultNoteStyle,
        preferences.font,
        preferences.width,
      );
      const capturedStyle = Object.freeze({ ...style });
      const built = buildPreview(session, capturedStyle, mode);
      const listeners = new Set<() => void>();
      let valid = true;
      let consumed = false;
      let cleanups: Array<() => void> = [];
      let activeRegistration: { invalidate(): void } | null = null;

      const isCapturedContextCurrent = () => {
        try {
          return (
            isMounted() &&
            isRegistrationActive() &&
            !session.isClosed &&
            !session.isMutationFenced &&
            runtime.getSessionGeneration() === generation &&
            stylePreferenceKey(runtime.getPreferences()) === styleKey &&
            runtime.getSession() === session
          );
        } catch {
          return false;
        }
      };

      const isCurrent = () => {
        if (!valid || consumed || !isCapturedContextCurrent() || hasUnconfirmedChanges(session)) return false;
        try {
          return built.targets.every((target) => {
            const current = session.readNoteStyle(target.id);
            return (
              current.ok &&
              current.value.revision === target.revision &&
              session.canUpdateNoteStyleSource(target.id, capturedStyle)
            );
          });
        } catch {
          return false;
        }
      };

      const expire = () => {
        if (!valid) return;
        valid = false;
        if (activeLease === activeRegistration) activeLease = null;
        for (const cleanup of cleanups.splice(0)) {
          try {
            cleanup();
          } catch {
            // One listener cannot prevent the remaining lease callbacks from being notified.
          }
        }
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch {
            // Plugin callbacks cannot interrupt host-side lease cleanup.
          }
        }
      };

      const onSessionChange = () => {
        if (!isCurrent()) {
          expire();
          return;
        }
        try {
          if (buildPreview(session, style, mode).eligibilityKey !== built.eligibilityKey) expire();
        } catch {
          expire();
        }
      };
      const onPreferenceChange = () => {
        try {
          if (!isCapturedContextCurrent() || stylePreferenceKey(runtime.getPreferences()) !== styleKey) expire();
        } catch {
          expire();
        }
      };
      const onRegistrationChange = () => {
        if (!isMounted() || !isRegistrationActive()) expire();
      };
      const onQueueChange = () => {
        if (hasUnconfirmedChanges(session)) expire();
      };

      cleanups = [
        session.subscribe(onSessionChange),
        session.subscribeMutationFence(onSessionChange),
        session.queue.subscribe(onQueueChange),
        session.onClose(expire),
        runtime.subscribeSession(expire),
        runtime.subscribePreferences(onPreferenceChange),
        (runtime.subscribeRegistration ?? subscribePlugins)(onRegistrationChange),
      ];

      const lease: PluginNoteStyleBatchPreviewLease = Object.freeze({
        summary: built.summary,
        isCurrent,
        subscribe(listener: () => void) {
          if (typeof listener !== 'function') return () => {};
          listeners.add(listener);
          if (!isCurrent()) listener();
          return () => listeners.delete(listener);
        },
      });
      activeRegistration = { invalidate: expire };
      activeLease = activeRegistration;

      const consume = async (): Promise<NoteStyleBatchConfirmationResult | null> => {
        if (consumed) return null;
        if (!isCurrent()) {
          consumed = true;
          expire();
          return null;
        }

        // Reserve the execution before notifying preview subscribers; they can synchronously reenter.
        let executionInvalid = false;
        const executionCleanups: Array<() => void> = [];
        const invalidateExecution = () => {
          if (executionInvalid) return;
          executionInvalid = true;
          for (const cleanup of executionCleanups.splice(0)) {
            try {
              cleanup();
            } catch {
              // A runtime subscriber cannot prevent other host guards from being released.
            }
          }
        };
        const isExecutionContextCurrent = () => {
          if (executionInvalid) return false;
          try {
            if (!isCapturedContextCurrent()) {
              invalidateExecution();
              return false;
            }
            return true;
          } catch {
            invalidateExecution();
            return false;
          }
        };
        const observeExecutionContext = () => {
          isExecutionContextCurrent();
        };
        const execution = { invalidate: invalidateExecution };
        consumed = true;
        activeExecution = execution;
        const trackExecutionSubscription = (subscribe: (listener: () => void) => () => void) => {
          if (executionInvalid) return;
          try {
            const cleanup = subscribe(observeExecutionContext);
            if (executionInvalid) cleanup();
            else executionCleanups.push(cleanup);
          } catch {
            invalidateExecution();
          }
        };

        const outcomes = built.targets.map((target) => ({
          title: target.title,
          order: target.order,
          status: 'unattempted' as NoteStyleBatchConfirmationStatus,
        }));
        const receiptScope = receiptSlot.readCurrentScope();
        if (!sameReceiptScope(receiptSlot.scope, receiptScope)) {
          receiptSlot.receipt = null;
          receiptSlot.scope = receiptScope;
        }
        const batchId = ++receiptSlot.nextBatchId;
        const confirmedWriteItems: NoteStyleBatchReceiptItem[] = [];
        let hadConfirmedWrite = false;

        try {
          trackExecutionSubscription(runtime.subscribeSession);
          trackExecutionSubscription(runtime.subscribePreferences);
          trackExecutionSubscription(runtime.subscribeRegistration ?? subscribePlugins);
          trackExecutionSubscription(session.subscribeMutationFence.bind(session));
          trackExecutionSubscription(session.onClose.bind(session));
          expire();
          for (let index = 0; index < built.targets.length; index++) {
            const target = built.targets[index]!;
            if (!isExecutionContextCurrent() || hasUnconfirmedChanges(session)) {
              invalidateExecution();
              break;
            }

            let writeStarted = false;
            const result = await session.setNoteStyleWithRestoreContext({
              pageId: target.id,
              style: capturedStyle,
              expectedRevision: target.revision,
              hostAuthorization: {
                isCurrent: isExecutionContextCurrent,
                onWriteStarted: () => {
                  writeStarted = true;
                },
              },
            });

            if (result.ok) {
              outcomes[index]!.status = 'confirmed';
              if (result.op === 'write') {
                hadConfirmedWrite = true;
                const restoreContext = result.restoreContext === null
                  ? null
                  : result.restoreContext.kind === 'explicit'
                    ? Object.freeze({
                        kind: 'explicit' as const,
                        context: Object.freeze({
                          ...result.restoreContext.context,
                          fields: Object.freeze({ ...result.restoreContext.context.fields }),
                        }),
                      })
                    : Object.freeze({
                        kind: 'inherited' as const,
                        context: Object.freeze({ ...result.restoreContext.context }),
                      });
                confirmedWriteItems.push(Object.freeze({
                  pageId: target.id,
                  title: target.title,
                  order: target.order,
                  appliedStyle: Object.freeze({ ...capturedStyle }),
                  restoreContext,
                }));
              }
            }
            else if (!writeStarted && !isExecutionContextCurrent()) break;
            else {
              outcomes[index]!.status = 'refused';
              break;
            }

            // The preview itself expires on its first style revision; the consumed execution uses
            // only its own captured context so it can continue to later notes in the same session.
            if (!isExecutionContextCurrent()) break;
          }
        } finally {
          invalidateExecution();
          if (activeExecution === execution) activeExecution = null;
        }

        if (
          hadConfirmedWrite &&
          batchId > receiptSlot.committedBatchId &&
          receiptScope &&
          isReceiptScopeCurrent(receiptScope)
        ) {
          receiptSlot.receipt = Object.freeze({
            mode,
            writes: Object.freeze(confirmedWriteItems),
            hasRestorableItems: confirmedWriteItems.some((item) => item.restoreContext !== null),
          });
          receiptSlot.committedBatchId = batchId;
        }

        const frozenOutcomes = Object.freeze(outcomes.map((outcome) => Object.freeze(outcome)));
        return Object.freeze({
          mode,
          outcomes: frozenOutcomes,
          confirmedCount: outcomes.filter((outcome) => outcome.status === 'confirmed').length,
          refusedCount: outcomes.filter((outcome) => outcome.status === 'refused').length,
          unattemptedCount: outcomes.filter((outcome) => outcome.status === 'unattempted').length,
        });
      };

      previewConfirmations.set(lease, { consume });
      return lease;
    },
  });

  noteStyleBatchReceiptSlots.set(host, receiptSlot);
  for (const subscribe of [
    runtime.subscribeSession,
    runtime.subscribeRegistration ?? subscribePlugins,
  ]) {
    try {
      receiptSlot.cleanup.push(subscribe(clearReceiptWhenScopeChanges));
    } catch {
      // Receipt reads and write completions still check session and registration identity directly.
    }
  }
  return host;
}
