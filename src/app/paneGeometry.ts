import type { PaneNode, PaneSplit } from './paneLayout';

export interface PaneRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface PaneSplitRect {
  readonly split: PaneSplit;
  readonly rect: PaneRect;
}

export interface PaneLayoutGeometry {
  readonly panes: ReadonlyMap<string, PaneRect>;
  readonly splits: readonly PaneSplitRect[];
}

export function paneLayoutGeometry(root: PaneNode): PaneLayoutGeometry {
  const panes = new Map<string, PaneRect>();
  const splits: PaneSplitRect[] = [];
  const visit = (node: PaneNode, rect: PaneRect): void => {
    if (node.kind === 'leaf') {
      panes.set(node.id, rect);
      return;
    }
    splits.push({ split: node, rect });
    if (node.axis === 'columns') {
      const firstWidth = rect.width * node.ratio;
      visit(node.first, { ...rect, width: firstWidth });
      visit(node.second, {
        ...rect,
        left: rect.left + firstWidth,
        width: rect.width - firstWidth,
      });
      return;
    }
    const firstHeight = rect.height * node.ratio;
    visit(node.first, { ...rect, height: firstHeight });
    visit(node.second, {
      ...rect,
      top: rect.top + firstHeight,
      height: rect.height - firstHeight,
    });
  };

  visit(root, { left: 0, top: 0, width: 100, height: 100 });
  return { panes, splits };
}
