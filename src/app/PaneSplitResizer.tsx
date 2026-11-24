import { useEffect, useRef } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { t } from './i18n';
import {
  beginPaneResize,
  cancelPaneResize,
  findPaneSplit,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  previewPaneResize,
  resetPaneSplit,
} from './paneLayout';
import type { PaneResizeSession, PaneSplit } from './paneLayout';
import { paneLayoutGeometry } from './paneGeometry';
import type { PaneRect } from './paneGeometry';
import { getTabs } from './tabs';
import { getWorkspaceSessionGeneration } from './workspace';

export interface SplitResizeIdentity {
  readonly splitId: string;
  readonly axis: PaneSplit['axis'];
  readonly layoutId: string;
  readonly topologyRevision: number;
  readonly sessionGeneration: number;
}

export interface PaneSplitPreview extends SplitResizeIdentity {
  readonly ratio: number;
}

interface ResizeGesture extends SplitResizeIdentity {
  readonly session: PaneResizeSession;
  readonly pointerId: number;
  readonly surface: HTMLElement;
  lastRatio: number;
  changed: boolean;
  finish: (cancel: boolean) => void;
}

export function paneDividerStyle(split: PaneSplit, rect: PaneRect): CSSProperties {
  if (split.axis === 'columns')
    return {
      left: `${rect.left + rect.width * split.ratio}%`,
      top: `${rect.top}%`,
      height: `${rect.height}%`,
    };
  return {
    left: `${rect.left}%`,
    top: `${rect.top + rect.height * split.ratio}%`,
    width: `${rect.width}%`,
  };
}

function isCurrent(identity: SplitResizeIdentity): boolean {
  if (getWorkspaceSessionGeneration() !== identity.sessionGeneration) return false;
  const layout = getTabs().layout;
  if (layout.id !== identity.layoutId || layout.topologyRevision !== identity.topologyRevision) return false;
  return findPaneSplit(layout.root, identity.splitId)?.axis === identity.axis;
}

export function PaneSplitResizer({
  split,
  rect,
  layoutId,
  topologyRevision,
  sessionGeneration,
  onPreview,
  onCommit,
}: {
  readonly split: PaneSplit;
  readonly rect: PaneRect;
  readonly layoutId: string;
  readonly topologyRevision: number;
  readonly sessionGeneration: number;
  readonly onPreview: (preview: PaneSplitPreview | null, identity: SplitResizeIdentity) => void;
  readonly onCommit: (session: PaneResizeSession, ratio: number) => void;
}) {
  const gestureRef = useRef<ResizeGesture | null>(null);
  const identity: SplitResizeIdentity = {
    splitId: split.id,
    axis: split.axis,
    layoutId,
    topologyRevision,
    sessionGeneration,
  };

  useEffect(
    () => () => gestureRef.current?.finish(true),
    [split.id, split.axis, layoutId, topologyRevision, sessionGeneration],
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || gestureRef.current || !isCurrent(identity)) return;
    const currentLayout = getTabs().layout;
    const session = beginPaneResize(currentLayout, split.id);
    const handle = event.currentTarget;
    const surface = handle.parentElement;
    if (!session || !surface) return;

    event.preventDefault();
    const gesture: ResizeGesture = {
      ...identity,
      session,
      pointerId: event.pointerId,
      surface,
      lastRatio: session.initialRatio,
      changed: false,
      finish: () => {},
    };

    const cleanup = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', cancel);
      handle.removeEventListener('lostpointercapture', cancel);
      window.removeEventListener('keydown', onResizeKey, true);
    };
    const finish = (shouldCancel: boolean) => {
      if (gestureRef.current !== gesture) return;
      cleanup();
      gestureRef.current = null;
      if (shouldCancel || !isCurrent(gesture)) {
        const currentLayout = getTabs().layout;
        const restored = cancelPaneResize(currentLayout, gesture.session);
        const restoredSplit = findPaneSplit(restored.root, gesture.splitId);
        if (restoredSplit) onPreview({ ...identity, ratio: restoredSplit.ratio }, identity);
      } else if (gesture.changed) {
        onCommit(gesture.session, gesture.lastRatio);
      }
      onPreview(null, identity);
      try {
        if (handle.hasPointerCapture?.(gesture.pointerId)) handle.releasePointerCapture(gesture.pointerId);
      } catch {
        // The browser may release capture as part of pointerup or pointercancel.
      }
    };
    gesture.finish = finish;
    const cancel = () => finish(true);
    const up = (released: PointerEvent) => {
      if (released.pointerId === gesture.pointerId) finish(false);
    };
    const move = (moved: PointerEvent) => {
      if (moved.pointerId !== gesture.pointerId) return;
      if (!isCurrent(gesture)) {
        finish(true);
        return;
      }
      const currentLayout = getTabs().layout;
      const currentRect = paneLayoutGeometry(currentLayout.root).splits.find(
        ({ split: currentSplit }) => currentSplit.id === gesture.splitId,
      )?.rect;
      const viewport = gesture.surface.getBoundingClientRect();
      if (!currentRect || !viewport.width || !viewport.height) {
        finish(true);
        return;
      }
      const bounds = {
        left: viewport.left + (viewport.width * currentRect.left) / 100,
        top: viewport.top + (viewport.height * currentRect.top) / 100,
        width: (viewport.width * currentRect.width) / 100,
        height: (viewport.height * currentRect.height) / 100,
      };
      const extent = split.axis === 'columns' ? bounds.width : bounds.height;
      if (!extent) return;
      const position = split.axis === 'columns' ? moved.clientX - bounds.left : moved.clientY - bounds.top;
      const displayed = previewPaneResize(currentLayout, gesture.session, position / extent);
      const displayedSplit = findPaneSplit(displayed.root, gesture.splitId);
      if (!displayedSplit) {
        finish(true);
        return;
      }
      if (displayedSplit.ratio === gesture.lastRatio) return;
      gesture.lastRatio = displayedSplit.ratio;
      gesture.changed = gesture.lastRatio !== gesture.session.initialRatio;
      onPreview({ ...identity, ratio: displayedSplit.ratio }, identity);
    };
    const onResizeKey = (key: KeyboardEvent) => {
      if (key.key !== 'Escape') return;
      key.preventDefault();
      key.stopPropagation();
      finish(true);
    };

    gestureRef.current = gesture;
    handle.setPointerCapture?.(gesture.pointerId);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', cancel);
    handle.addEventListener('lostpointercapture', cancel);
    window.addEventListener('keydown', onResizeKey, true);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isCurrent(identity)) return;
    const currentLayout = getTabs().layout;
    const currentSplit = findPaneSplit(currentLayout.root, split.id);
    if (!currentSplit) return;
    const delta = event.shiftKey ? 0.1 : 0.05;
    const decrement = split.axis === 'columns' ? event.key === 'ArrowLeft' : event.key === 'ArrowUp';
    const increment = split.axis === 'columns' ? event.key === 'ArrowRight' : event.key === 'ArrowDown';
    const ratio = decrement
      ? currentSplit.ratio - delta
      : increment
        ? currentSplit.ratio + delta
        : event.key === 'Home'
          ? MIN_SPLIT_RATIO
          : event.key === 'End'
            ? MAX_SPLIT_RATIO
            : null;
    if (ratio === null) return;
    event.preventDefault();
    const session = beginPaneResize(currentLayout, split.id);
    if (!session) return;
    const displayed = previewPaneResize(currentLayout, session, ratio);
    const displayedSplit = findPaneSplit(displayed.root, split.id);
    if (displayedSplit && displayedSplit.ratio !== currentSplit.ratio)
      onCommit(session, displayedSplit.ratio);
  };

  const onDoubleClick = () => {
    if (!isCurrent(identity)) return;
    const currentLayout = getTabs().layout;
    const session = beginPaneResize(currentLayout, split.id);
    if (!session) return;
    const reset = resetPaneSplit(currentLayout, split.id);
    const resetSplit = findPaneSplit(reset.root, split.id);
    if (resetSplit && resetSplit.ratio !== session.initialRatio) onCommit(session, resetSplit.ratio);
  };

  return (
    <div
      className="split-resizer"
      data-axis={split.axis}
      data-split-id={split.id}
      role="separator"
      tabIndex={0}
      aria-orientation={split.axis === 'columns' ? 'vertical' : 'horizontal'}
      aria-label={t('tabs.resizeSplit')}
      aria-valuemin={20}
      aria-valuemax={80}
      aria-valuenow={Math.round(split.ratio * 100)}
      style={paneDividerStyle(split, rect)}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onDoubleClick}
    />
  );
}
