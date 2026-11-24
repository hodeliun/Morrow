import { describe, expect, it } from 'vitest';
import {
  canFocusRestoredReadingPlace,
  isCurrentReadingRestore,
  isStartupReadingFocusTarget,
  matchesReadingPageRoute,
} from './readingFocus';
import type { ReadingFocusLease, ReadingFocusState } from './readingFocus';
import type { Route } from './router';

function focusCase(paneId: string, tabId: string) {
  const editor = {};
  const activeElement = {} as Element;
  const lease: ReadingFocusLease = {
    pageId: 'same-note',
    paneId,
    tabId,
    routeHash: '#/page/same-note',
    sessionGeneration: 12,
    editor,
    activeElement,
  };
  const current: ReadingFocusState = {
    ...lease,
    focusedPaneId: paneId,
    assignedTabId: tabId,
    startupAllowed: true,
    editorDestroyed: false,
    editorConnected: true,
  };
  return { lease, current, editor, activeElement };
}

describe('reading-place focus restoration', () => {
  it('targets the active duplicate instance while restoring both panel positions', () => {
    const first = focusCase('pane-a', 'duplicate-a');
    const second = focusCase('pane-b', 'duplicate-b');

    expect(
      isStartupReadingFocusTarget(true, first.lease.paneId, first.lease.tabId, 'pane-b', 'duplicate-a'),
    ).toBe(false);
    expect(
      isStartupReadingFocusTarget(true, second.lease.paneId, second.lease.tabId, 'pane-b', 'duplicate-b'),
    ).toBe(true);
    expect(isCurrentReadingRestore(first.lease, { ...first.current, focusedPaneId: 'pane-b' })).toBe(true);
    expect(canFocusRestoredReadingPlace(first.lease, { ...first.current, focusedPaneId: 'pane-b' })).toBe(
      false,
    );
    expect(canFocusRestoredReadingPlace(second.lease, second.current)).toBe(true);
  });

  it('keeps a single visible panel eligible for startup focus', () => {
    const single = focusCase('only-pane', 'only-instance');

    expect(
      isStartupReadingFocusTarget(true, 'only-pane', 'only-instance', 'only-pane', 'only-instance'),
    ).toBe(true);
    expect(canFocusRestoredReadingPlace(single.lease, single.current)).toBe(true);
  });

  it('matches a valid page route by parsed identity, not its raw URL spelling', () => {
    const route: Route = { name: 'page', id: 'a', find: null, anchor: null };

    expect(matchesReadingPageRoute(route, { id: 'a', find: null, anchor: null })).toBe(true);
    expect(matchesReadingPageRoute(route, { id: 'a', find: 'query', anchor: null })).toBe(false);
  });

  it('drops stale focus after user interaction or a pane, tab, editor, route, or session change', () => {
    const { lease, current, activeElement } = focusCase('pane-b', 'duplicate-b');
    const changedEditor = {};
    const changedActiveElement = {} as Element;
    const staleStates: ReadingFocusState[] = [
      { ...current, startupAllowed: false },
      { ...current, activeElement: changedActiveElement },
      { ...current, focusedPaneId: 'pane-a' },
      { ...current, paneId: 'pane-a', focusedPaneId: 'pane-a' },
      { ...current, tabId: 'replacement-tab', assignedTabId: 'replacement-tab' },
      { ...current, assignedTabId: 'replacement-tab' },
      { ...current, pageId: 'other-note' },
      { ...current, routeHash: '#/page/other-note' },
      { ...current, sessionGeneration: current.sessionGeneration + 1 },
      { ...current, editor: changedEditor },
      { ...current, editorDestroyed: true },
      { ...current, editorConnected: false },
    ];

    for (const stale of staleStates) expect(canFocusRestoredReadingPlace(lease, stale)).toBe(false);
    expect(lease.activeElement).toBe(activeElement);
  });
});
