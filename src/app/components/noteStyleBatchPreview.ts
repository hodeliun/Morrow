import { isRecord } from '../../core/doc';
import { displayTitle } from '../../core/model';
import type { PageId, WorkspaceState } from '../../core/model';
import { isEffectivelyTrashed } from '../../core/tree';
import { isValidNoteStyle, resolveDefaultNoteStyle } from '../../core/noteStyle';
import type { NoteStyle } from '../../core/noteStyle';
import type { WorkspaceSession } from '../../storage/session';
import type {
  PluginNoteStyleBatchPreviewHost,
  PluginNoteStyleBatchPreviewLease,
  PluginNoteStyleBatchPreviewMode,
  PluginNoteStyleBatchPreviewSummary,
} from '../plugins/registry';
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
}

const defaultRuntime: PreviewRuntime = {
  getSession,
  getSessionGeneration: getWorkspaceSessionGeneration,
  subscribeSession: subscribeWorkspaceSession,
  getPreferences,
  subscribePreferences,
};

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

    targets.push({ id: page.id, revision: saved.value.revision });
    eligibility.push([page.id, 'candidate', saved.value.revision]);
  }

  const summary = Object.freeze({
    mode,
    candidateCount: targets.length,
    titles: Object.freeze(targets.slice(0, 4).map(({ id }) => displayTitle(state.pages[id]))),
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

  const invalidate = () => {
    activeLease?.invalidate();
    activeLease = null;
  };

  return Object.freeze({
    invalidate,
    create(mode: PluginNoteStyleBatchPreviewMode): PluginNoteStyleBatchPreviewLease | null {
      invalidate();
      if (!isMounted() || !isRegistrationActive()) return null;

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
      const built = buildPreview(session, style, mode);
      const listeners = new Set<() => void>();
      let valid = true;
      let cleanups: Array<() => void> = [];

      const isCurrent = () => {
        if (
          !valid ||
          !isMounted() ||
          !isRegistrationActive() ||
          session.isClosed ||
          session.isMutationFenced ||
          hasUnconfirmedChanges(session) ||
          runtime.getSessionGeneration() !== generation ||
          stylePreferenceKey(runtime.getPreferences()) !== styleKey
        )
          return false;
        try {
          if (runtime.getSession() !== session) return false;
          return built.targets.every((target) => {
            const current = session.readNoteStyle(target.id);
            return (
              current.ok &&
              current.value.revision === target.revision &&
              session.canUpdateNoteStyleSource(target.id, style)
            );
          });
        } catch {
          return false;
        }
      };

      const expire = () => {
        if (!valid) return;
        valid = false;
        for (const cleanup of cleanups.splice(0)) cleanup();
        for (const listener of [...listeners]) listener();
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
          if (stylePreferenceKey(runtime.getPreferences()) !== styleKey) expire();
        } catch {
          expire();
        }
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
      activeLease = { invalidate: expire };
      return lease;
    },
  });
}
