import { describe, expect, it } from 'vitest';
import { applyPanePreset, createPaneLayout, movePaneTab, visiblePaneLeaves } from './paneLayout';
import { paneIdForTabId, routeHashForPane, routeHashForTabId } from './tabs';
import type { TabState } from './tabs';

describe('pane tab route context', () => {
  it('keeps a cached tab bound to its own route after another tab takes its former pane', () => {
    const initial = createPaneLayout(
      'cached-route-test',
      [
        { id: 'tab-a', groupId: 'a', target: '#/search?q=alpha', back: [], forward: [] },
        { id: 'tab-b', groupId: 'b', target: '#/tags/work', back: [], forward: [] },
      ],
      'tab-a',
    );
    const twoColumns = applyPanePreset(initial, 'two-columns');
    const formerPane = visiblePaneLeaves(twoColumns)[0]!.id;
    const layout = movePaneTab(twoColumns, 'tab-b', formerPane);
    const tabs: TabState = {
      tabs: layout.tabs.map((tab) => ({ ...tab, hash: tab.target, side: null })),
      active: 'tab-b',
      pane: formerPane,
      layout,
      closed: [],
      persistenceWritable: false,
    };

    const cachedPane = paneIdForTabId('tab-a', tabs);
    expect(routeHashForPane(formerPane, tabs)).toBe('#/tags/work');
    expect(routeHashForTabId('tab-a', layout.tabs)).toBe('#/search?q=alpha');
    expect(paneIdForTabId('tab-b', tabs)).toBe(formerPane);
    expect(cachedPane).not.toBe(formerPane);
    expect(routeHashForPane(cachedPane, tabs)).toBe('#/');
  });
});
