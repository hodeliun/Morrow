import { describe, expect, it, vi } from 'vitest';
import type { BrowserTabPresentationBounds } from './browserTabPresentation';
import { observeBrowserPaneGeometry, observeBrowserTabPresentation } from './browserTabPresentation';

type VisibilityTarget = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;

function createVisibilityTarget(initialState: DocumentVisibilityState = 'visible') {
  const listeners = new Set<EventListener>();
  const target = {
    visibilityState: initialState,
    addEventListener: vi.fn((_type: string, listener: EventListener) => listeners.add(listener)),
    removeEventListener: vi.fn((_type: string, listener: EventListener) => listeners.delete(listener)),
  } as unknown as VisibilityTarget;

  return {
    target,
    listenerCount: () => listeners.size,
    setVisibility(state: DocumentVisibilityState) {
      Object.defineProperty(target, 'visibilityState', { configurable: true, value: state });
      for (const listener of [...listeners]) listener(new Event('visibilitychange'));
    },
  };
}

function createFrameScheduler() {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const requestFrame = vi.fn((callback: FrameRequestCallback) => {
    const id = nextId++;
    callbacks.set(id, callback);
    return id;
  });
  const cancelFrame = vi.fn((id: number) => callbacks.delete(id));

  return {
    requestFrame,
    cancelFrame,
    pendingIds: () => [...callbacks.keys()],
    flush(id = callbacks.keys().next().value as number) {
      const callback = callbacks.get(id);
      if (!callback) return false;
      callbacks.delete(id);
      callback(0);
      return true;
    },
  };
}

function createPresentationHarness(paneVisible = true, initialState: DocumentVisibilityState = 'visible') {
  const bounds: BrowserTabPresentationBounds = { x: 24, y: 48, width: 640, height: 420 };
  const present = vi.fn(async (_tabId: string, _bounds: BrowserTabPresentationBounds, _visible: boolean) => true);
  const element = { getBoundingClientRect: vi.fn(() => bounds) };
  const document = createVisibilityTarget(initialState);
  const scheduler = createFrameScheduler();
  const presentation = observeBrowserTabPresentation({
    present,
    tabId: 'synthetic-browser-tab',
    element,
    paneVisible,
    documentTarget: document.target,
    requestFrame: scheduler.requestFrame,
    cancelFrame: scheduler.cancelFrame,
  });

  return { bounds, present, element, document, scheduler, presentation };
}

describe('browser tab presentation visibility', () => {
  it('refreshes the same tab bounds after a position-only pane change', () => {
    const harness = createPresentationHarness();
    harness.scheduler.flush();
    expect(harness.present).toHaveBeenCalledOnce();

    Object.assign(harness.bounds, { x: 312, y: 64 });
    harness.presentation.refresh();
    harness.scheduler.flush();

    expect(harness.present).toHaveBeenCalledTimes(2);
    expect(harness.present).toHaveBeenLastCalledWith('synthetic-browser-tab', {
      x: 312,
      y: 64,
      width: 640,
      height: 420,
    }, true);
  });

  it('observes only current pane geometry attributes and disconnects on cleanup', () => {
    const pane = {} as HTMLElement;
    const refresh = vi.fn();
    const callbacks: MutationCallback[] = [];
    const observer = { observe: vi.fn(), disconnect: vi.fn() };
    const stop = observeBrowserPaneGeometry(pane, refresh, (next) => {
      callbacks.push(next);
      return observer as unknown as MutationObserver;
    });

    expect(observer.observe).toHaveBeenCalledExactlyOnceWith(pane, {
      attributes: true,
      attributeFilter: ['style', 'class', 'data-pane', 'aria-hidden'],
    });
    callbacks[0]?.([], observer as unknown as MutationObserver);
    expect(refresh).toHaveBeenCalledOnce();
    stop();
    expect(observer.disconnect).toHaveBeenCalledOnce();
  });

  it('cancels a queued frame and synchronously hides when the document becomes hidden', () => {
    const harness = createPresentationHarness();
    const [pendingFrame] = harness.scheduler.pendingIds();

    harness.document.setVisibility('hidden');

    expect(harness.scheduler.cancelFrame).toHaveBeenCalledWith(pendingFrame);
    expect(harness.scheduler.pendingIds()).toEqual([]);
    expect(harness.present).toHaveBeenCalledOnce();
    expect(harness.present).toHaveBeenCalledWith('synthetic-browser-tab', harness.bounds, false);
  });

  it('waits to measure on visibility restore and gates presentation on the pane prop', () => {
    const harness = createPresentationHarness(false, 'hidden');
    const [initialFrame] = harness.scheduler.pendingIds();
    harness.scheduler.flush(initialFrame);
    expect(harness.present).toHaveBeenCalledWith('synthetic-browser-tab', harness.bounds, false);

    harness.document.setVisibility('visible');
    expect(harness.present).toHaveBeenCalledTimes(1);
    const [restoreFrame] = harness.scheduler.pendingIds();
    harness.scheduler.flush(restoreFrame);

    expect(harness.present).toHaveBeenCalledTimes(2);
    expect(harness.present).toHaveBeenLastCalledWith('synthetic-browser-tab', harness.bounds, false);
  });

  it('removes the listener and cancels pending measurement on cleanup', () => {
    const harness = createPresentationHarness();
    const [pendingFrame] = harness.scheduler.pendingIds();

    harness.presentation.dispose();
    harness.document.setVisibility('hidden');
    harness.document.setVisibility('visible');

    expect(harness.document.listenerCount()).toBe(0);
    expect(harness.document.target.removeEventListener).toHaveBeenCalledOnce();
    expect(harness.scheduler.cancelFrame).toHaveBeenCalledWith(pendingFrame);
    expect(harness.scheduler.pendingIds()).toEqual([]);
    expect(harness.present).toHaveBeenCalledOnce();
    expect(harness.present).toHaveBeenLastCalledWith(
      'synthetic-browser-tab',
      { x: 0, y: 0, width: 0, height: 0 },
      false,
    );
  });
});
