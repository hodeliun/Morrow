// @vitest-environment happy-dom
import { act, createElement, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaneSplitResizer } from './PaneSplitResizer';
import { paneLayoutGeometry } from './paneGeometry';
import type { PaneSplitPreview } from './PaneSplitResizer';
import { beginPaneResize, findPaneSplit, updatePaneSplitRatio, visiblePaneLeaves } from './paneLayout';
import { PANE_TABS_STORAGE_KEY, readPaneTabsSnapshot } from './paneLayoutStorage';
import { commitPaneResizeSession, getTabs, openTab, setPanePreset, setPaneSplitRatio, useTabs } from './tabs';
import { getWorkspaceSessionGeneration } from './workspace';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

function fixture(): string {
  return JSON.stringify({
    schemaVersion: 2,
    paneLayout: {
      version: 1,
      id: 'storage-preview-layout',
      root: {
        kind: 'split',
        id: 'split-root',
        axis: 'columns',
        ratio: 0.6,
        first: { kind: 'leaf', id: 'pane-first', tabId: 'tab-first' },
        second: { kind: 'leaf', id: 'pane-second', tabId: 'tab-second' },
      },
      focusedPaneId: 'pane-first',
    },
    tabs: [
      {
        id: 'tab-first',
        groupId: 'tab-first',
        target: '#/page/first',
        back: ['#/page/first-before'],
        forward: [],
      },
      { id: 'tab-second', groupId: 'tab-second', target: '#/page/second', back: [], forward: [] },
    ],
    closed: [],
  });
}

function PreviewWorkspace({
  controlPaneId,
  onEscapeAction,
}: {
  readonly controlPaneId?: string;
  readonly onEscapeAction?: () => void;
}) {
  const [preview, setPreview] = useState<PaneSplitPreview | null>(null);
  const committed = useTabs().layout;
  const displayLayout =
    preview &&
    preview.layoutId === committed.id &&
    preview.topologyRevision === committed.topologyRevision &&
    preview.sessionGeneration === getWorkspaceSessionGeneration()
      ? (updatePaneSplitRatio(committed, preview.splitId, preview.ratio) ?? committed)
      : committed;
  const geometry = paneLayoutGeometry(displayLayout.root);
  return createElement(
    'div',
    { className: 'panes' },
    ...visiblePaneLeaves(displayLayout).map((leaf) => {
      const rect = geometry.panes.get(leaf.id)!;
      return createElement(
        'section',
        {
          key: leaf.id,
          'data-pane-id': leaf.id,
          style: {
            left: `${rect.left}%`,
            top: `${rect.top}%`,
            width: `${rect.width}%`,
            height: `${rect.height}%`,
          },
        },
        leaf.id === controlPaneId
          ? createElement(
              'button',
              {
                type: 'button',
                'data-control-in-other-pane': true,
                onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
                  if (event.key === 'Escape') onEscapeAction?.();
                },
              },
              'Other pane control',
            )
          : null,
      );
    }),
    ...geometry.splits.map(({ split, rect }) =>
      createElement(PaneSplitResizer, {
        key: split.id,
        split,
        rect,
        layoutId: committed.id,
        topologyRevision: committed.topologyRevision,
        sessionGeneration: getWorkspaceSessionGeneration(),
        onPreview: (next) => setPreview(next),
        onCommit: commitPaneResizeSession,
      }),
    ),
  );
}

function pointer(
  target: HTMLElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  values: Record<string, number>,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, values);
  target.dispatchEvent(event);
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

describe('pane resize preview persistence', () => {
  it('keeps preview and Escape out of storage, then writes once on pointerup', async () => {
    window.localStorage.clear();
    window.localStorage.setItem(PANE_TABS_STORAGE_KEY, fixture());
    const writes: string[] = [];
    const originalSetItem = window.localStorage.setItem.bind(window.localStorage);
    vi.spyOn(window.localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === PANE_TABS_STORAGE_KEY) writes.push(value);
      originalSetItem(key, value);
    });

    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(createElement(PreviewWorkspace)));
    const surface = container.querySelector<HTMLElement>('.panes')!;
    surface.getBoundingClientRect = () => ({
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
    let handle = container.querySelector<HTMLElement>('[role="separator"]')!;
    expect(handle.getAttribute('aria-valuenow')).toBe('60');

    await act(async () => {
      pointer(handle, 'pointerdown', { button: 0, pointerId: 4 });
      pointer(handle, 'pointermove', { pointerId: 4, clientX: 660, clientY: 300 });
    });
    handle = container.querySelector<HTMLElement>('[role="separator"]')!;
    expect(handle.getAttribute('aria-valuenow')).toBe('70');
    expect(container.querySelector<HTMLElement>('[data-pane-id="pane-first"]')?.style.width).toBe('70%');
    expect(getTabs().layout.root).toMatchObject({ kind: 'split', ratio: 0.6 });
    expect(writes).toEqual([]);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    handle = container.querySelector<HTMLElement>('[role="separator"]')!;
    expect(handle.getAttribute('aria-valuenow')).toBe('60');
    expect(container.querySelector<HTMLElement>('[data-pane-id="pane-first"]')?.style.width).toBe('60%');
    expect(getTabs().layout.root).toMatchObject({ kind: 'split', ratio: 0.6 });
    expect(writes).toEqual([]);

    await act(async () => {
      pointer(handle, 'pointerdown', { button: 0, pointerId: 5 });
      pointer(handle, 'pointermove', { pointerId: 5, clientX: 660, clientY: 300 });
      pointer(handle, 'pointerup', { pointerId: 5 });
    });

    expect(writes).toHaveLength(1);
    const saved = readPaneTabsSnapshot(window.localStorage.getItem(PANE_TABS_STORAGE_KEY));
    expect(saved.kind).toBe('current');
    if (saved.kind === 'current') {
      expect(saved.snapshot.layout.root).toMatchObject({ kind: 'split', ratio: 0.7 });
    }
    expect(getTabs().layout.root).toMatchObject({ kind: 'split', ratio: 0.7 });

    handle = container.querySelector<HTMLElement>('[role="separator"]')!;
    await act(async () => {
      pointer(handle, 'pointerdown', { button: 0, pointerId: 6 });
      pointer(handle, 'pointermove', { pointerId: 6, clientX: 620, clientY: 300 });
    });
    expect(handle.getAttribute('aria-valuenow')).toBe('65');
    expect(getTabs().layout.root).toMatchObject({ kind: 'split', ratio: 0.7 });
    expect(writes).toHaveLength(1);

    await act(async () => openTab('#/page/concurrent-action'));
    expect(writes).toHaveLength(2);
    const duringConcurrentAction = readPaneTabsSnapshot(writes[1]!);
    expect(duringConcurrentAction.kind).toBe('current');
    if (duringConcurrentAction.kind === 'current')
      expect(duringConcurrentAction.snapshot.layout.root).toMatchObject({ kind: 'split', ratio: 0.7 });

    await act(async () => pointer(handle, 'pointercancel', { pointerId: 6 }));
    expect(writes).toHaveLength(2);
    expect(getTabs().layout.root).toMatchObject({ kind: 'split', ratio: 0.7 });
  });

  it('keeps split A preview over committed split B changes and captures Escape from another pane', async () => {
    const writes: string[] = [];
    const originalSetItem = window.localStorage.setItem.bind(window.localStorage);
    vi.spyOn(window.localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === PANE_TABS_STORAGE_KEY) writes.push(value);
      originalSetItem(key, value);
    });

    setPanePreset('two-columns');
    setPanePreset('two-by-two');
    let before = getTabs().layout;
    expect(before.root.kind).toBe('split');
    if (
      before.root.kind !== 'split' ||
      before.root.first.kind !== 'split' ||
      before.root.second.kind !== 'split'
    )
      throw new Error('Expected a four-pane preset with independent left and right splits.');
    const leftSplitId = before.root.first.id;
    const rightSplitId = before.root.second.id;
    const controlPaneId = before.root.second.first.id;
    expect(setPaneSplitRatio(leftSplitId, 0.4)).toBe(true);
    expect(setPaneSplitRatio(rightSplitId, 0.7)).toBe(true);
    writes.length = 0;
    before = getTabs().layout;

    let escapeActions = 0;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        createElement(PreviewWorkspace, {
          controlPaneId,
          onEscapeAction: () => {
            escapeActions += 1;
            const layout = getTabs().layout;
            const session = beginPaneResize(layout, rightSplitId);
            if (session) commitPaneResizeSession(session, 0.8);
          },
        }),
      ),
    );
    const surface = container.querySelector<HTMLElement>('.panes')!;
    surface.getBoundingClientRect = () => ({
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

    const left = container.querySelector<HTMLElement>(`[data-split-id="${leftSplitId}"]`)!;
    const right = container.querySelector<HTMLElement>(`[data-split-id="${rightSplitId}"]`)!;
    expect(left.getAttribute('aria-valuenow')).toBe('40');
    expect(right.getAttribute('aria-valuenow')).toBe('70');

    await act(async () => {
      pointer(left, 'pointerdown', { button: 0, pointerId: 9 });
      pointer(left, 'pointermove', { pointerId: 9, clientX: 300, clientY: 460 });
    });
    expect(
      container.querySelector<HTMLElement>(`[data-split-id="${leftSplitId}"]`)?.getAttribute('aria-valuenow'),
    ).toBe('65');
    expect(
      container
        .querySelector<HTMLElement>(`[data-split-id="${rightSplitId}"]`)
        ?.getAttribute('aria-valuenow'),
    ).toBe('70');
    expect(findPaneSplit(getTabs().layout.root, leftSplitId)?.ratio).toBe(0.4);
    expect(writes).toEqual([]);

    await act(async () =>
      right.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      ),
    );
    expect(
      container.querySelector<HTMLElement>(`[data-split-id="${leftSplitId}"]`)?.getAttribute('aria-valuenow'),
    ).toBe('65');
    expect(
      container
        .querySelector<HTMLElement>(`[data-split-id="${rightSplitId}"]`)
        ?.getAttribute('aria-valuenow'),
    ).toBe('75');
    expect(getTabs().layout.focusedPaneId).toBe(before.focusedPaneId);
    expect(findPaneSplit(getTabs().layout.root, leftSplitId)?.ratio).toBe(0.4);
    expect(findPaneSplit(getTabs().layout.root, rightSplitId)?.ratio).toBe(0.75);
    expect(writes).toHaveLength(1);
    const committed = readPaneTabsSnapshot(writes[0]!);
    expect(committed.kind).toBe('current');
    if (committed.kind === 'current') {
      expect(findPaneSplit(committed.snapshot.layout.root, leftSplitId)?.ratio).toBe(0.4);
      expect(findPaneSplit(committed.snapshot.layout.root, rightSplitId)?.ratio).toBe(0.75);
    }

    const otherControl = container.querySelector<HTMLElement>('[data-control-in-other-pane]')!;
    await act(async () => {
      otherControl.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(escapeActions).toBe(0);
    expect(
      container.querySelector<HTMLElement>(`[data-split-id="${leftSplitId}"]`)?.getAttribute('aria-valuenow'),
    ).toBe('40');
    expect(
      container
        .querySelector<HTMLElement>(`[data-split-id="${rightSplitId}"]`)
        ?.getAttribute('aria-valuenow'),
    ).toBe('75');
    expect(getTabs().layout.focusedPaneId).toBe(before.focusedPaneId);
    expect(findPaneSplit(getTabs().layout.root, rightSplitId)?.ratio).toBe(0.75);
    expect(writes).toHaveLength(1);
  });
});
