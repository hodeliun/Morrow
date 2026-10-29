// Scroll positions live only in this renderer session. They are keyed by tab, pane, and page so
// separate tabs showing the same page never share a reading position.
export type TabScrollPane = 'main' | 'side' | (string & {});

export interface TabScrollScope {
  tabId: string;
  pane: TabScrollPane;
  pageId: string;
}

const positions = new Map<string, Map<string, number>>();

function pageKey(scope: TabScrollScope): string {
  return JSON.stringify([scope.pane, scope.pageId]);
}

export function tabScrollPosition(scope: TabScrollScope): number | undefined {
  return positions.get(scope.tabId)?.get(pageKey(scope));
}

export function rememberTabScrollPosition(scope: TabScrollScope, position: number): void {
  if (!Number.isFinite(position) || position < 0) return;
  const pages = positions.get(scope.tabId) ?? new Map<string, number>();
  pages.set(pageKey(scope), position);
  positions.set(scope.tabId, pages);
}

export function forgetTabScrollPositions(tabId: string): void {
  positions.delete(tabId);
}
