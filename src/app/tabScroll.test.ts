import { afterEach, describe, expect, it } from 'vitest';
import { forgetTabScrollPositions, rememberTabScrollPosition, tabScrollPosition } from './tabScroll';

const tabIds = ['t16-tab-a', 't16-tab-b'];

afterEach(() => tabIds.forEach(forgetTabScrollPositions));

describe('tab reading positions', () => {
  it('keeps tabs, panes, and pages independent', () => {
    rememberTabScrollPosition({ tabId: tabIds[0]!, pane: 'main', pageId: 'shared-page' }, 240);
    rememberTabScrollPosition({ tabId: tabIds[1]!, pane: 'main', pageId: 'shared-page' }, 860);
    rememberTabScrollPosition({ tabId: tabIds[0]!, pane: 'side', pageId: 'shared-page' }, 510);
    rememberTabScrollPosition({ tabId: tabIds[0]!, pane: 'main', pageId: 'other-page' }, 130);

    expect(tabScrollPosition({ tabId: tabIds[0]!, pane: 'main', pageId: 'shared-page' })).toBe(240);
    expect(tabScrollPosition({ tabId: tabIds[1]!, pane: 'main', pageId: 'shared-page' })).toBe(860);
    expect(tabScrollPosition({ tabId: tabIds[0]!, pane: 'side', pageId: 'shared-page' })).toBe(510);
    expect(tabScrollPosition({ tabId: tabIds[0]!, pane: 'main', pageId: 'other-page' })).toBe(130);
  });

  it('rejects invalid offsets and forgets a closed tab', () => {
    const scope = { tabId: tabIds[0]!, pane: 'main', pageId: 'shared-page' };
    rememberTabScrollPosition(scope, Number.NaN);
    rememberTabScrollPosition(scope, Number.POSITIVE_INFINITY);
    rememberTabScrollPosition(scope, -1);
    expect(tabScrollPosition(scope)).toBeUndefined();

    rememberTabScrollPosition(scope, 240);
    forgetTabScrollPositions(scope.tabId);
    expect(tabScrollPosition(scope)).toBeUndefined();
  });
});
