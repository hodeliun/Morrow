import { CaseSensitive } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { MutableRefObject } from 'react';
import { isEffectivelyTrashed } from '../../core/tree';
import { resolveDefaultNoteStyle } from '../../core/noteStyle';
import type { NoteStyle } from '../../core/noteStyle';
import { Popover } from './Popover';
import { documentoNoteStylePanel, subscribePlugins } from '../plugins/registry';
import type {
  PluginNoteStylePanelEntry,
  PluginNoteStylePanelHost,
  PluginNoteStylePanelLabels,
  PluginNoteStylePanelResult,
} from '../plugins/registry';
import { getPreferences, usePreferences } from '../platform/preferences';
import {
  getWorkspaceSessionGeneration,
  getSession,
  subscribeWorkspaceSession,
  useWorkspace,
} from '../workspace';
import type { WorkspaceSession } from '../../storage/session';
import type { PageId } from '../../core/model';
import { t } from '../i18n';
import { usePane } from '../tabs';
import type { PaneId } from '../tabs';
import { isProviderManagedPage } from './pageEditability';

interface OpenPanel {
  readonly pageId: PageId;
  readonly session: WorkspaceSession;
  readonly sessionGeneration: number;
  readonly contextGeneration: symbol;
  readonly ownerToken: symbol;
  readonly pane: PaneId;
  readonly registration: PluginNoteStylePanelEntry;
  readonly activationGeneration: number;
  readonly revision: string;
  readonly initial: NoteStyle;
  readonly profileDefault: unknown;
  readonly font: 'serif' | 'sans' | 'mono';
  readonly width: 'comfortable' | 'wide' | 'full';
  readonly labels: PluginNoteStylePanelLabels;
  readonly trigger: HTMLButtonElement;
  closed: boolean;
}

interface CurrentPageContext {
  pageId: PageId;
  session: WorkspaceSession;
  sessionGeneration: number;
  contextGeneration: symbol;
  pane: PaneId;
  registration: PluginNoteStylePanelEntry | null;
  eligible: boolean;
}

let activeNoteStylePanelOwner: symbol | null = null;
const noteStylePanelOwnerListeners = new Set<() => void>();

function subscribeNoteStylePanelOwner(listener: () => void): () => void {
  noteStylePanelOwnerListeners.add(listener);
  return () => noteStylePanelOwnerListeners.delete(listener);
}

function getActiveNoteStylePanelOwner(): symbol | null {
  return activeNoteStylePanelOwner;
}

function claimNoteStylePanelOwner(owner: symbol): void {
  if (activeNoteStylePanelOwner === owner) return;
  activeNoteStylePanelOwner = owner;
  for (const listener of [...noteStylePanelOwnerListeners]) listener();
}

function releaseNoteStylePanelOwner(owner: symbol): void {
  if (activeNoteStylePanelOwner !== owner) return;
  activeNoteStylePanelOwner = null;
  for (const listener of [...noteStylePanelOwnerListeners]) listener();
}

function focusBelongsToPanelOrigin(panel: OpenPanel, focused: Element | null): boolean {
  const document = panel.trigger.ownerDocument;
  const sourcePane = panel.trigger.closest<HTMLElement>('.pane[data-pane]');
  if (sourcePane && !sourcePane.classList.contains('is-active')) return false;
  if (focused === panel.trigger) return true;
  if (
    document
      .querySelector<HTMLElement>('.note-style-popover[role="dialog"]')
      ?.contains(focused ?? null)
  )
    return true;
  return Boolean(sourcePane && focused && sourcePane.contains(focused));
}

function originPaneIsActive(panel: OpenPanel): boolean {
  return panel.trigger.closest<HTMLElement>('.pane[data-pane]')?.classList.contains('is-active') ?? false;
}

function copyStyle(style: NoteStyle): NoteStyle {
  return {
    font: style.font,
    fontSize: style.fontSize,
    lineHeight: style.lineHeight,
    blockSpacing: style.blockSpacing,
    width: style.width,
  };
}

function panelLabels(): PluginNoteStylePanelLabels {
  return Object.freeze({
    title: t('pageStyle.title'),
    trigger: t('pageStyle.trigger'),
    font: t('pageStyle.font'),
    fontSize: t('pageStyle.fontSize'),
    lineHeight: t('pageStyle.lineHeight'),
    blockSpacing: t('pageStyle.blockSpacing'),
    width: t('pageStyle.width'),
    previewWidth: t('pageStyle.previewWidth'),
    previewHeading: t('pageStyle.previewHeading'),
    previewBody: t('pageStyle.previewBody'),
    fonts: Object.freeze({
      serif: t('pageStyle.fonts.serif'),
      sans: t('pageStyle.fonts.sans'),
      mono: t('pageStyle.fonts.mono'),
    }),
    widths: Object.freeze({
      comfortable: t('pageStyle.widths.comfortable'),
      wide: t('pageStyle.widths.wide'),
      full: t('pageStyle.widths.full'),
    }),
    save: t('pageStyle.save'),
    restore: t('pageStyle.restore'),
    cancel: t('pageStyle.cancel'),
    saving: t('pageStyle.saving'),
    saveFailed: t('pageStyle.saveFailed'),
    saveConflict: t('pageStyle.saveConflict'),
    saveBusy: t('pageStyle.saveBusy'),
  });
}

/** Host-owned page action that mounts a Documento panel into the existing Popover. */
export function NoteStyleAction({ pageId }: { pageId: PageId }) {
  const pane = usePane();
  const preferences = usePreferences();
  const state = useWorkspace();
  const sessionGeneration = useSyncExternalStore(
    subscribeWorkspaceSession,
    getWorkspaceSessionGeneration,
    getWorkspaceSessionGeneration,
  );
  const session = getSession();
  const mutationFenced = useSyncExternalStore(
    (listener) => session.subscribeMutationFence(listener),
    () => session.isMutationFenced,
    () => session.isMutationFenced,
  );
  const registration = useSyncExternalStore(
    subscribePlugins,
    documentoNoteStylePanel,
    documentoNoteStylePanel,
  );
  const activePanelOwner = useSyncExternalStore(
    subscribeNoteStylePanelOwner,
    getActiveNoteStylePanelOwner,
    getActiveNoteStylePanelOwner,
  );
  const page = state.pages[pageId];
  const eligible = Boolean(
    registration &&
    page?.kind === 'page' &&
    !session.isClosed &&
    !preferences.readingMode &&
    !session.unreadable.has(pageId) &&
    !session.protectedReasons.has(pageId) &&
    !mutationFenced &&
    !isEffectivelyTrashed(state.pages, pageId) &&
    !isProviderManagedPage(state, page) &&
    session.hasWritableNoteStyleSource(pageId),
  );
  const contextGeneration = useMemo(
    () =>
      Symbol(
        `${pageId}:${session.location}:${session.isClosed}:${sessionGeneration}:${pane}:${eligible}:${registration?.generation ?? 0}`,
      ),
    [eligible, pageId, pane, registration, session, sessionGeneration],
  );
  const currentContext: CurrentPageContext = {
    pageId,
    session,
    sessionGeneration,
    contextGeneration,
    pane,
    registration,
    eligible,
  };
  const currentRef = useRef<CurrentPageContext>(currentContext);
  useLayoutEffect(() => {
    currentRef.current = currentContext;
  });
  const panelRef = useRef<OpenPanel | null>(null);
  const focusFrame = useRef<number | null>(null);
  const focusOwnerRef = useRef<symbol | null>(null);
  const [panel, setPanel] = useState<OpenPanel | null>(null);

  const scopeIsCurrent = useCallback((captured: OpenPanel): boolean => {
    const current = currentRef.current;
    try {
      const currentState = captured.session.getState();
      const currentPage = currentState.pages[captured.pageId];
      if (
        getWorkspaceSessionGeneration() !== captured.sessionGeneration ||
        getSession() !== captured.session ||
        getPreferences().readingMode ||
        getActiveNoteStylePanelOwner() !== captured.ownerToken
      )
        return false;
      return (
        !captured.session.isClosed &&
        !captured.session.isMutationFenced &&
        current.pageId === captured.pageId &&
        current.session === captured.session &&
        current.sessionGeneration === captured.sessionGeneration &&
        current.contextGeneration === captured.contextGeneration &&
        current.pane === captured.pane &&
        current.registration === captured.registration &&
        current.registration?.generation === captured.activationGeneration &&
        current.eligible &&
        captured.registration.isActive() &&
        currentPage?.kind === 'page' &&
        !isProviderManagedPage(currentState, currentPage) &&
        !captured.session.unreadable.has(captured.pageId) &&
        !captured.session.protectedReasons.has(captured.pageId) &&
        !isEffectivelyTrashed(captured.session.getState().pages, captured.pageId) &&
        captured.session.hasWritableNoteStyleSource(captured.pageId)
      );
    } catch {
      return false;
    }
  }, []);

  const closePanel = useCallback(
    (captured: OpenPanel, restoreFocus: boolean, mountIsActive: () => boolean = () => true) => {
      if (panelRef.current !== captured) return;
      const document = captured.trigger.ownerDocument;
      const focusAtClose = document.activeElement;
      const focusWasInDialog = Boolean(
        document
          .querySelector<HTMLElement>('.note-style-popover[role="dialog"]')
          ?.contains(focusAtClose),
      );
      const canRestoreFocus = restoreFocus && focusBelongsToPanelOrigin(captured, focusAtClose);
      panelRef.current = null;
      captured.closed = true;
      setPanel(null);
      if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
      focusFrame.current = null;
      focusOwnerRef.current = null;
      if (!canRestoreFocus) {
        releaseNoteStylePanelOwner(captured.ownerToken);
        return;
      }
      focusOwnerRef.current = captured.ownerToken;
      focusFrame.current = requestAnimationFrame(() => {
        focusFrame.current = null;
        focusOwnerRef.current = null;
        const focusNow = document.activeElement;
        const focusStillOwned =
          focusBelongsToPanelOrigin(captured, focusNow) ||
          (focusWasInDialog && focusNow === document.body && originPaneIsActive(captured));
        if (
          mountIsActive() &&
          scopeIsCurrent(captured) &&
          captured.trigger.isConnected &&
          focusStillOwned
        )
          captured.trigger.focus({ preventScroll: true });
        releaseNoteStylePanelOwner(captured.ownerToken);
      });
    },
    [scopeIsCurrent],
  );

  useEffect(() => {
    if (panel && (!scopeIsCurrent(panel) || panel.closed)) closePanel(panel, false);
  }, [
    closePanel,
    eligible,
    mutationFenced,
    contextGeneration,
    activePanelOwner,
    pageId,
    pane,
    panel,
    registration,
    scopeIsCurrent,
    session,
    sessionGeneration,
  ]);

  useEffect(
    () => () => {
      if (panelRef.current) panelRef.current.closed = true;
      if (panelRef.current) releaseNoteStylePanelOwner(panelRef.current.ownerToken);
      panelRef.current = null;
      if (focusFrame.current !== null) {
        cancelAnimationFrame(focusFrame.current);
        if (focusOwnerRef.current) releaseNoteStylePanelOwner(focusOwnerRef.current);
      }
      focusFrame.current = null;
      focusOwnerRef.current = null;
    },
    [],
  );

  const openPanel = useCallback(
    (trigger: HTMLButtonElement) => {
      const current = currentRef.current;
      const activeRegistration = current.registration;
      const existing = panelRef.current;
      if (
        !current.eligible ||
        !activeRegistration?.isActive() ||
        current.session.isClosed ||
        current.session.isMutationFenced ||
        getPreferences().readingMode ||
        getWorkspaceSessionGeneration() !== current.sessionGeneration ||
        getSession() !== current.session
      )
        return;
      if (
        existing &&
        !existing.closed &&
        existing.trigger === trigger &&
        existing.contextGeneration === current.contextGeneration &&
        getActiveNoteStylePanelOwner() === existing.ownerToken
      )
        return;
      if (existing && panelRef.current === existing) closePanel(existing, false);
      const snapshot = current.session.readNoteStyle(current.pageId);
      if (!snapshot.ok) return;
      const currentPreferences = getPreferences();
      const width = currentPreferences.pageWidths[current.pageId] ?? currentPreferences.width;
      const initial = snapshot.value.style
        ? copyStyle(snapshot.value.style)
        : resolveDefaultNoteStyle(currentPreferences.defaultNoteStyle, currentPreferences.font, width);
      if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
      focusFrame.current = null;
      const next: OpenPanel = {
        pageId: current.pageId,
        session: current.session,
        sessionGeneration: current.sessionGeneration,
        contextGeneration: current.contextGeneration,
        ownerToken: Symbol('note-style-owner'),
        pane: current.pane,
        registration: activeRegistration,
        activationGeneration: activeRegistration.generation,
        revision: snapshot.value.revision,
        initial,
        profileDefault: currentPreferences.defaultNoteStyle,
        font: currentPreferences.font,
        width,
        labels: panelLabels(),
        trigger,
        closed: false,
      };
      claimNoteStylePanelOwner(next.ownerToken);
      panelRef.current = next;
      setPanel(next);
    },
    [closePanel],
  );

  const visiblePanel =
    panel &&
    !panel.closed &&
    panel.contextGeneration === contextGeneration &&
    panel.pageId === pageId &&
    panel.session === session &&
    panel.sessionGeneration === sessionGeneration &&
    panel.pane === pane &&
    panel.registration === registration &&
    panel.ownerToken === activePanelOwner &&
    eligible &&
    registration?.isActive() &&
    !session.isClosed &&
    !session.isMutationFenced &&
    getWorkspaceSessionGeneration() === sessionGeneration &&
    getSession() === session &&
    !getPreferences().readingMode
      ? panel
      : null;
  if (!eligible || !registration) return null;

  return (
    <>
      <div className="page-header-actions">
        <button
          type="button"
          className="add-icon"
          aria-label={t('pageStyle.trigger')}
          aria-haspopup="dialog"
          aria-expanded={Boolean(visiblePanel)}
          onClick={(event) => openPanel(event.currentTarget)}
        >
          <CaseSensitive size={14} /> {t('pageStyle.trigger')}
        </button>
      </div>
      {visiblePanel && (
        <Popover
          anchor={visiblePanel.trigger}
          onClose={() => closePanel(visiblePanel, false)}
          onEscape={(event) => {
            const target = event.target instanceof Element ? event.target : null;
            const shouldRestoreFocus =
              target !== null &&
              focusBelongsToPanelOrigin(visiblePanel, target) &&
              focusBelongsToPanelOrigin(
                visiblePanel,
                visiblePanel.trigger.ownerDocument.activeElement,
              );
            closePanel(visiblePanel, shouldRestoreFocus);
          }}
          label={visiblePanel.labels.title}
          className="note-style-popover"
        >
          <MountedNoteStylePanel
            registration={visiblePanel.registration}
            panel={visiblePanel}
            panelRef={panelRef}
            scopeIsCurrent={scopeIsCurrent}
            closePanel={closePanel}
          />
        </Popover>
      )}
    </>
  );
}

function MountedNoteStylePanel({
  registration,
  panel,
  panelRef,
  scopeIsCurrent,
  closePanel,
}: {
  registration: PluginNoteStylePanelEntry;
  panel: OpenPanel;
  panelRef: MutableRefObject<OpenPanel | null>;
  scopeIsCurrent(panel: OpenPanel): boolean;
  closePanel(panel: OpenPanel, restoreFocus: boolean, mountIsActive?: () => boolean): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = root.current;
    if (!container || !registration.isActive()) return;
    const mountState = { active: true, focusPending: false };
    try {
      const operationState = { inFlight: false };
      const resultMessage = (code: string) =>
        code === 'save-conflict' || code === 'stale-revision'
          ? panel.labels.saveConflict
          : panel.labels.saveFailed;
      const run = async (
        operation: () => ReturnType<WorkspaceSession['setNoteStyle']>,
      ): Promise<PluginNoteStylePanelResult> => {
        if (
          !mountState.active ||
          panelRef.current !== panel ||
          panel.closed ||
          !scopeIsCurrent(panel) ||
          getPreferences().readingMode
        )
          return { ok: false, code: 'session-closed', message: panel.labels.saveFailed };
        if (operationState.inFlight)
          return { ok: false, code: 'save-failed', message: panel.labels.saveBusy };
        operationState.inFlight = true;
        try {
          const result = await operation();
          const stillMounted = mountState.active;
          if (!result.ok) return { ok: false, code: result.code, message: resultMessage(result.code) };
          const saved = result.value.style ?? panel.initial;
          if (
            stillMounted &&
            panelRef.current === panel &&
            !panel.closed &&
            scopeIsCurrent(panel) &&
            !getPreferences().readingMode
          ) {
            mountState.focusPending = true;
            closePanel(panel, true, () => {
              const canReturnFocus = mountState.active || mountState.focusPending;
              mountState.focusPending = false;
              return canReturnFocus;
            });
          }
          return { ok: true, style: copyStyle(saved) };
        } catch {
          return { ok: false, code: 'save-failed', message: panel.labels.saveFailed };
        } finally {
          operationState.inFlight = false;
        }
      };
      const host: PluginNoteStylePanelHost = Object.freeze({
        initial: Object.freeze(copyStyle(panel.initial)),
        labels: panel.labels,
        save: (style: NoteStyle) =>
          run(() =>
            panel.session.setNoteStyle({
              pageId: panel.pageId,
              style,
              expectedRevision: panel.revision,
            }),
          ),
        restore: () =>
          run(() =>
            panel.session.restoreNoteStyle({
              pageId: panel.pageId,
              expectedRevision: panel.revision,
              profileDefault: panel.profileDefault,
              font: panel.font,
              width: panel.width,
            }),
          ),
        cancel: () => {
          if (mountState.active && panelRef.current === panel && !panel.closed && scopeIsCurrent(panel)) {
            mountState.focusPending = true;
            closePanel(panel, true, () => {
              const canReturnFocus = mountState.active || mountState.focusPending;
              mountState.focusPending = false;
              return canReturnFocus;
            });
          }
        },
      });
      const unmount = registration.mount(container, host);
      return () => {
        mountState.active = false;
        try {
          if (typeof unmount === 'function') unmount();
        } finally {
          container.replaceChildren();
        }
      };
    } catch {
      mountState.active = false;
      container.setAttribute('role', 'alert');
      container.textContent = panel.labels.saveFailed;
    }
  }, [closePanel, panel, panelRef, registration, scopeIsCurrent]);
  return <div ref={root} className="note-style-panel-mount" />;
}
