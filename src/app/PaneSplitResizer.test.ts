// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findPaneSplit, updatePaneSplitRatio } from './paneLayout';
import type { PaneLayout, PaneNode, PaneSplit } from './paneLayout';
import { paneLayoutGeometry } from './paneGeometry';

const h = vi.hoisted(() => ({
  getTabs: vi.fn(),
  setPaneSplitRatio: vi.fn(),
  onPreview: vi.fn(),
  getWorkspaceSessionGeneration: vi.fn(),
}));

vi.mock('./tabs', () => ({ getTabs: h.getTabs, setPaneSplitRatio: h.setPaneSplitRatio }));
vi.mock('./workspace', () => ({ getWorkspaceSessionGeneration: h.getWorkspaceSessionGeneration }));
vi.mock('./i18n', () => ({ t: () => 'Resize split' }));

import { PaneSplitResizer } from './PaneSplitResizer';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

function split(axis: PaneSplit['axis'], ratio = 0.5): PaneSplit {
  return {
    kind: 'split',
    id: 'split-root',
    axis,
    ratio,
    first: { kind: 'leaf', id: 'first', tabId: 'tab-first' },
    second: { kind: 'leaf', id: 'second', tabId: 'tab-second' },
  };
}

function renderDivider(axis: PaneSplit['axis'], ratio = 0.5, topologyRevision = 4) {
  const activeSplit = split(axis, ratio);
  const layout = {
    id: 'layout-one',
    topologyRevision,
    root: activeSplit as PaneNode,
  };
  h.getTabs.mockReturnValue({ layout });
  h.getWorkspaceSessionGeneration.mockReturnValue(9);
  container = document.createElement('div');
  container.getBoundingClientRect = () => ({
    x: 100,
    y: 200,
    left: 100,
    top: 200,
    right: 900,
    bottom: 600,
    width: 800,
    height: 400,
    toJSON: () => ({}),
  });
  document.body.append(container);
  root = createRoot(container);
  const render = (revision = topologyRevision, nextSplit = activeSplit) =>
    root!.render(
      createElement(PaneSplitResizer, {
        split: nextSplit,
        rect: { left: 0, top: 0, width: 100, height: 100 },
        layoutId: layout.id,
        topologyRevision: revision,
        sessionGeneration: 9,
        onPreview: h.onPreview,
        onCommit: h.setPaneSplitRatio,
      }),
    );
  return { activeSplit, layout, render };
}

function pointer(
  target: HTMLElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  values: Record<string, number>,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, values);
  target.dispatchEvent(event);
  return event;
}

function mockPointerCapture(handle: HTMLElement) {
  Object.defineProperty(handle, 'setPointerCapture', { configurable: true, value: vi.fn() });
  Object.defineProperty(handle, 'hasPointerCapture', {
    configurable: true,
    value: vi.fn(() => true),
  });
  Object.defineProperty(handle, 'releasePointerCapture', { configurable: true, value: vi.fn() });
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

describe('pane split divider', () => {
  it('previews without committing and restores the gesture start on Escape', async () => {
    const { render } = renderDivider('columns');
    await act(async () => render());
    const handle = container!.querySelector<HTMLElement>('[role="separator"]')!;
    mockPointerCapture(handle);

    await act(async () => {
      pointer(handle, 'pointerdown', { button: 0, pointerId: 3 });
      pointer(handle, 'pointermove', { pointerId: 3, clientX: 660, clientY: 300 });
    });
    expect(handle.setPointerCapture).toHaveBeenCalledWith(3);
    const preview = h.onPreview.mock.calls[0]?.[0] as { ratio: number } | undefined;
    expect(preview?.ratio).toBe(0.7);
    expect(h.setPaneSplitRatio).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    const restored = h.onPreview.mock.calls.at(-2)?.[0] as { ratio: number } | undefined;
    expect(restored?.ratio).toBe(0.5);
    expect(h.onPreview).toHaveBeenLastCalledWith(null, {
      splitId: 'split-root',
      axis: 'columns',
      layoutId: 'layout-one',
      topologyRevision: 4,
      sessionGeneration: 9,
    });
    expect(h.setPaneSplitRatio).not.toHaveBeenCalled();
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(3);
  });

  it('commits only the final preview once on pointerup', async () => {
    const { render } = renderDivider('rows');
    await act(async () => render());
    const handle = container!.querySelector<HTMLElement>('[role="separator"]')!;
    mockPointerCapture(handle);
    await act(async () => {
      pointer(handle, 'pointerdown', { button: 0, pointerId: 7 });
      pointer(handle, 'pointermove', { pointerId: 7, clientY: 360 });
      pointer(handle, 'pointermove', { pointerId: 7, clientY: 440 });
      pointer(handle, 'pointerup', { pointerId: 7 });
    });

    expect(h.setPaneSplitRatio).toHaveBeenCalledTimes(1);
    expect(h.setPaneSplitRatio).toHaveBeenCalledWith(
      {
        layoutId: 'layout-one',
        splitId: 'split-root',
        topologyRevision: 4,
        initialRatio: 0.5,
      },
      0.6,
    );
    expect(h.onPreview).toHaveBeenLastCalledWith(null, {
      splitId: 'split-root',
      axis: 'rows',
      layoutId: 'layout-one',
      topologyRevision: 4,
      sessionGeneration: 9,
    });
  });

  it('uses axis-specific keyboard controls and keeps the handle focusable', async () => {
    const { render } = renderDivider('rows');
    await act(async () => render());
    const handle = container!.querySelector<HTMLElement>('[role="separator"]')!;
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute('aria-orientation')).toBe('horizontal');
    expect(handle.getAttribute('aria-valuenow')).toBe('50');

    await act(async () =>
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
    );
    expect(h.setPaneSplitRatio).not.toHaveBeenCalled();

    await act(async () =>
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
    );
    expect(h.setPaneSplitRatio).toHaveBeenCalledWith(
      {
        layoutId: 'layout-one',
        splitId: 'split-root',
        topologyRevision: 4,
        initialRatio: 0.5,
      },
      0.55,
    );

    const changedSplit = split('rows', 0.55);
    h.getTabs.mockReturnValue({
      layout: { id: 'layout-one', topologyRevision: 4, root: changedSplit },
    });
    await act(async () => render(4, changedSplit));
    const changedHandle = container!.querySelector<HTMLElement>('[role="separator"]')!;
    await act(async () => changedHandle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(h.setPaneSplitRatio).toHaveBeenLastCalledWith(
      {
        layoutId: 'layout-one',
        splitId: 'split-root',
        topologyRevision: 4,
        initialRatio: 0.55,
      },
      0.5,
    );
  });

  it('drops an active gesture without restoring it after the split topology changes', async () => {
    const { render } = renderDivider('columns');
    await act(async () => render());
    const handle = container!.querySelector<HTMLElement>('[role="separator"]')!;
    mockPointerCapture(handle);
    await act(async () => {
      pointer(handle, 'pointerdown', { button: 0, pointerId: 2 });
      pointer(handle, 'pointermove', { pointerId: 2, clientX: 700, clientY: 300 });
    });
    expect(h.onPreview).toHaveBeenCalledTimes(1);

    h.getTabs.mockReturnValue({
      layout: { id: 'layout-one', topologyRevision: 5, root: split('columns') },
    });
    await act(async () => render(5));

    expect(h.onPreview).toHaveBeenLastCalledWith(null, {
      splitId: 'split-root',
      axis: 'columns',
      layoutId: 'layout-one',
      topologyRevision: 4,
      sessionGeneration: 9,
    });
    await act(async () => {
      pointer(handle, 'pointermove', { pointerId: 2, clientX: 620, clientY: 300 });
    });
    expect(h.setPaneSplitRatio).not.toHaveBeenCalled();
  });

  it('recalculates the active split bounds after an ancestor divider changes', async () => {
    let layout: PaneLayout = {
      id: 'nested-layout',
      topologyRevision: 8,
      focusedPaneId: 'pane-b',
      tabs: [],
      root: {
        kind: 'split',
        id: 'ancestor',
        axis: 'columns',
        ratio: 0.5,
        first: {
          kind: 'split',
          id: 'active-a',
          axis: 'columns',
          ratio: 0.5,
          first: { kind: 'leaf', id: 'pane-a1', tabId: 'tab-a1' },
          second: { kind: 'leaf', id: 'pane-a2', tabId: 'tab-a2' },
        },
        second: { kind: 'leaf', id: 'pane-b', tabId: 'tab-b' },
      },
    };
    h.getTabs.mockImplementation(() => ({ layout }));
    h.getWorkspaceSessionGeneration.mockReturnValue(9);
    h.setPaneSplitRatio.mockImplementation((session, ratio: number) => {
      const updated = updatePaneSplitRatio(layout, session.splitId, ratio);
      if (updated) layout = updated;
    });

    container = document.createElement('div');
    container.getBoundingClientRect = () => ({
      x: 100,
      y: 200,
      left: 100,
      top: 200,
      right: 900,
      bottom: 600,
      width: 800,
      height: 400,
      toJSON: () => ({}),
    });
    document.body.append(container);
    root = createRoot(container);
    const render = () => {
      const geometry = paneLayoutGeometry(layout.root);
      root!.render(
        createElement(
          'div',
          { className: 'panes' },
          ...geometry.splits.map(({ split: activeSplit, rect }) =>
            createElement(PaneSplitResizer, {
              key: activeSplit.id,
              split: activeSplit,
              rect,
              layoutId: layout.id,
              topologyRevision: layout.topologyRevision,
              sessionGeneration: 9,
              onPreview: h.onPreview,
              onCommit: h.setPaneSplitRatio,
            }),
          ),
        ),
      );
    };
    await act(async () => render());
    const surface = container.querySelector<HTMLElement>('.panes')!;
    surface.getBoundingClientRect = container.getBoundingClientRect;
    const active = container.querySelector<HTMLElement>('[data-split-id="active-a"]')!;
    const ancestor = container.querySelector<HTMLElement>('[data-split-id="ancestor"]')!;
    mockPointerCapture(active);
    await act(async () => {
      pointer(active, 'pointerdown', { button: 0, pointerId: 12 });
      pointer(active, 'pointermove', { pointerId: 12, clientX: 340, clientY: 300 });
    });
    expect((h.onPreview.mock.calls.at(-1)?.[0] as { ratio: number }).ratio).toBe(0.6);

    await act(async () =>
      ancestor.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })),
    );
    expect(findPaneSplit(layout.root, 'ancestor')?.ratio).toBe(0.45);
    await act(async () => render());

    await act(async () => {
      pointer(active, 'pointermove', { pointerId: 12, clientX: 316, clientY: 300 });
    });
    expect((h.onPreview.mock.calls.at(-1)?.[0] as { ratio: number }).ratio).toBe(0.6);

    await act(async () => pointer(active, 'pointercancel', { pointerId: 12 }));
    expect(findPaneSplit(layout.root, 'active-a')?.ratio).toBe(0.5);
  });

  it('captures Escape before a control in another pane can handle it', async () => {
    const { render } = renderDivider('columns');
    await act(async () => render());
    const handle = container!.querySelector<HTMLElement>('[role="separator"]')!;
    mockPointerCapture(handle);
    const otherPane = document.createElement('section');
    const control = document.createElement('button');
    const onEscape = vi.fn();
    control.addEventListener('keydown', onEscape);
    otherPane.append(control);
    container!.append(otherPane);

    await act(async () => {
      pointer(handle, 'pointerdown', { button: 0, pointerId: 13 });
      pointer(handle, 'pointermove', { pointerId: 13, clientX: 660, clientY: 300 });
      control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });

    expect(onEscape).not.toHaveBeenCalled();
    expect(h.setPaneSplitRatio).not.toHaveBeenCalled();
    expect(h.onPreview).toHaveBeenLastCalledWith(null, {
      splitId: 'split-root',
      axis: 'columns',
      layoutId: 'layout-one',
      topologyRevision: 4,
      sessionGeneration: 9,
    });
  });
});
