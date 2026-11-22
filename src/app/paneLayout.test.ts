import { describe, expect, it } from 'vitest';
import { applyPanePresetPreservingAssignments, panePresetOf } from './paneLayout';
import type { PaneLayout, PanePreset, PaneTabInstance } from './paneLayout';

function layoutWithTabs(tabIds: readonly string[]): PaneLayout<PaneTabInstance<string>> {
  const tabs = tabIds.map((id) => ({ id, groupId: id, target: `#/page/${id}`, back: [], forward: [] }));
  const [first, ...rest] = tabs;
  let layout: PaneLayout<PaneTabInstance<string>> = {
    id: 'preset-layout',
    root: { kind: 'leaf', id: 'initial-pane', tabId: first?.id ?? null },
    focusedPaneId: 'initial-pane',
    topologyRevision: 0,
    tabs,
  };
  for (const tab of rest) {
    const preset = panePresetOf(layout) === 'single' ? 'two-columns' : 'two-by-two';
    layout = applyPanePresetPreservingAssignments(layout, preset);
    const leaves = getLeaves(layout);
    const empty = leaves.find((leaf) => leaf.tabId === null);
    if (!empty) break;
    layout = {
      ...layout,
      root: replaceLeaf(layout.root, empty.id, tab.id),
    };
  }
  return layout;
}

function getLeaves(layout: PaneLayout<PaneTabInstance<string>>) {
  const leaves: Array<{ id: string; tabId: string | null }> = [];
  const visit = (node: PaneLayout<PaneTabInstance<string>>['root']) => {
    if (node.kind === 'leaf') leaves.push(node);
    else {
      visit(node.first);
      visit(node.second);
    }
  };
  visit(layout.root);
  return leaves;
}

function replaceLeaf(
  node: PaneLayout<PaneTabInstance<string>>['root'],
  paneId: string,
  tabId: string,
): PaneLayout<PaneTabInstance<string>>['root'] {
  if (node.kind === 'leaf') return node.id === paneId ? { ...node, tabId } : node;
  return {
    ...node,
    first: replaceLeaf(node.first, paneId, tabId),
    second: replaceLeaf(node.second, paneId, tabId),
  };
}

describe('pane layout presets', () => {
  it.each([
    ['single', 1],
    ['two-columns', 2],
    ['one-left-two-right', 3],
    ['two-by-two', 4],
  ] as const)('builds the %s preset with %i real leaf slots', (preset, expectedCount) => {
    const start = layoutWithTabs(['note-a']);
    const layout = applyPanePresetPreservingAssignments(start, preset as PanePreset);

    expect(panePresetOf(layout)).toBe(preset);
    expect(getLeaves(layout)).toHaveLength(expectedCount);
    expect(getLeaves(layout).map((leaf) => leaf.tabId)).toEqual([
      'note-a',
      ...Array.from({ length: expectedCount - 1 }, () => null),
    ]);
    expect(layout.tabs).toBe(start.tabs);
  });

  it('keeps the focused instance and all registered histories when reducing a rich layout', () => {
    const four = layoutWithTabs(['note-a', 'note-b', 'note-c', 'note-d']);
    const [first, , focused] = getLeaves(four);
    const focusedLayout = { ...four, focusedPaneId: focused!.id };
    const tabs = focusedLayout.tabs;
    const histories = tabs.map((tab) => ({ ...tab, back: [`#/${tab.id}-before`] }));
    const rich = { ...focusedLayout, tabs: histories };

    const reduced = applyPanePresetPreservingAssignments(rich, 'two-columns');

    expect(getLeaves(reduced).map((leaf) => leaf.tabId)).toEqual(['note-a', 'note-c']);
    expect(getLeaves(reduced).find((leaf) => leaf.id === reduced.focusedPaneId)?.tabId).toBe('note-c');
    expect(reduced.tabs).toEqual(histories);
    expect(reduced.tabs.map((tab) => tab.back)).toEqual([
      ['#/note-a-before'],
      ['#/note-b-before'],
      ['#/note-c-before'],
      ['#/note-d-before'],
    ]);
    expect(first?.tabId).toBe('note-a');
  });
});
