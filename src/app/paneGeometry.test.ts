import { describe, expect, it } from 'vitest';
import { paneLayoutGeometry } from './paneGeometry';
import type { PaneNode } from './paneLayout';

describe('visible pane geometry', () => {
  it('derives one divider for each visible split across both axes', () => {
    const root: PaneNode = {
      kind: 'split',
      id: 'root',
      axis: 'columns',
      ratio: 0.6,
      first: {
        kind: 'split',
        id: 'left',
        axis: 'rows',
        ratio: 0.4,
        first: { kind: 'leaf', id: 'a', tabId: 'tab-a' },
        second: { kind: 'leaf', id: 'b', tabId: 'tab-b' },
      },
      second: {
        kind: 'split',
        id: 'right',
        axis: 'rows',
        ratio: 0.7,
        first: { kind: 'leaf', id: 'c', tabId: 'tab-c' },
        second: { kind: 'leaf', id: 'd', tabId: 'tab-d' },
      },
    };

    const geometry = paneLayoutGeometry(root);

    expect(geometry.splits.map(({ split }) => [split.id, split.axis, split.ratio])).toEqual([
      ['root', 'columns', 0.6],
      ['left', 'rows', 0.4],
      ['right', 'rows', 0.7],
    ]);
    expect(geometry.panes.get('a')).toEqual({ left: 0, top: 0, width: 60, height: 40 });
    expect(geometry.panes.get('b')).toEqual({ left: 0, top: 40, width: 60, height: 60 });
    expect(geometry.panes.get('c')).toEqual({ left: 60, top: 0, width: 40, height: 70 });
    expect(geometry.panes.get('d')).toEqual({ left: 60, top: 70, width: 40, height: 30 });
  });
});
