import { forgetReadingTab, rememberScopedPlace, sessionReadingPlace } from './readingPlace';

// Compatibility facade: readingPlace owns both live tab/pane scopes and the versioned durable fallback.
export type TabScrollPane = 'main' | 'side' | (string & {});
export interface TabScrollScope {
  tabId: string;
  pane: TabScrollPane;
  pageId: string;
  vaultKey?: string;
}
export function tabScrollPosition(scope: TabScrollScope): number | undefined {
  return sessionReadingPlace(scope)?.scroll;
}
export function rememberTabScrollPosition(scope: TabScrollScope, position: number): void {
  rememberScopedPlace(scope, { scroll: position });
}
export function forgetTabScrollPositions(tabId: string): void {
  forgetReadingTab(tabId);
}
