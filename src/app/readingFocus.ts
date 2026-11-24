import type { Route } from './router';

export interface ReadingFocusLease {
  readonly pageId: string;
  readonly paneId: string;
  readonly tabId: string | null;
  readonly routeHash: string | null;
  readonly sessionGeneration: number;
  readonly editor: object;
  readonly activeElement: Element | null;
}

export interface ReadingFocusState extends ReadingFocusLease {
  readonly focusedPaneId: string;
  readonly assignedTabId: string | null;
  readonly startupAllowed: boolean;
  readonly editorDestroyed: boolean;
  readonly editorConnected: boolean;
}

export interface ReadingPageRouteTarget {
  readonly id: string;
  readonly find: string | null;
  readonly anchor: string | null;
}

export interface ReadingRestoreInteractionWatch {
  didInteract(): boolean;
  dispose(): void;
}

const READING_RESTORE_INTERACTION_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

export function watchReadingRestoreInteraction(
  target: Element | null,
  onInteract?: () => void,
): ReadingRestoreInteractionWatch {
  let interacted = false;
  const markInteracted = () => {
    if (interacted) return;
    interacted = true;
    onInteract?.();
  };
  for (const type of READING_RESTORE_INTERACTION_EVENTS) target?.addEventListener(type, markInteracted, true);

  return {
    didInteract: () => interacted,
    dispose() {
      for (const type of READING_RESTORE_INTERACTION_EVENTS)
        target?.removeEventListener(type, markInteracted, true);
    },
  };
}

export function matchesReadingPageRoute(route: Route, target: ReadingPageRouteTarget): boolean {
  return (
    route.name === 'page' &&
    route.id === target.id &&
    route.find === target.find &&
    (route.anchor ?? null) === target.anchor
  );
}

export function isStartupReadingFocusTarget(
  firstPage: boolean,
  paneId: string,
  tabId: string | null,
  focusedPaneId: string,
  assignedTabId: string | null,
): boolean {
  return firstPage && tabId !== null && paneId === focusedPaneId && assignedTabId === tabId;
}

export function isCurrentReadingRestore(lease: ReadingFocusLease, current: ReadingFocusState): boolean {
  return (
    !current.editorDestroyed &&
    current.editorConnected &&
    current.pageId === lease.pageId &&
    current.paneId === lease.paneId &&
    current.tabId === lease.tabId &&
    current.routeHash === lease.routeHash &&
    current.sessionGeneration === lease.sessionGeneration &&
    current.editor === lease.editor &&
    (lease.tabId === null || current.assignedTabId === lease.tabId)
  );
}

export function canFocusRestoredReadingPlace(lease: ReadingFocusLease, current: ReadingFocusState): boolean {
  return (
    isCurrentReadingRestore(lease, current) &&
    current.startupAllowed &&
    current.focusedPaneId === lease.paneId &&
    current.activeElement === lease.activeElement
  );
}
