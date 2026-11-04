export type BrowserTabPresentationBounds = Pick<DOMRect, 'x' | 'y' | 'width' | 'height'>;
export type BrowserTabPresenter = (
  tabId: string,
  bounds: BrowserTabPresentationBounds,
  visible: boolean,
) => void;

type BrowserTabPresentationDocument = Pick<
  Document,
  'visibilityState' | 'addEventListener' | 'removeEventListener'
>;

type BrowserTabPresentationElement = {
  getBoundingClientRect(): Pick<DOMRect, 'x' | 'y' | 'width' | 'height'>;
};

export function observeBrowserPaneGeometry(
  pane: Element,
  refresh: () => void,
  createObserver: (callback: MutationCallback) => Pick<MutationObserver, 'observe' | 'disconnect'> = (callback) =>
    new MutationObserver(callback),
): () => void {
  const observer = createObserver(refresh);
  observer.observe(pane, {
    attributes: true,
    attributeFilter: ['style', 'class', 'data-pane', 'aria-hidden'],
  });
  return () => observer.disconnect();
}

export function observeBrowserTabPresentation({
  present,
  tabId,
  element,
  paneVisible,
  documentTarget = document,
  requestFrame = requestAnimationFrame,
  cancelFrame = cancelAnimationFrame,
}: {
  present: BrowserTabPresenter;
  tabId: string;
  element: BrowserTabPresentationElement;
  paneVisible: boolean;
  documentTarget?: BrowserTabPresentationDocument;
  requestFrame?: typeof requestAnimationFrame;
  cancelFrame?: typeof cancelAnimationFrame;
}): { refresh(): void; dispose(): void } {
  let frame: number | null = null;
  let active = true;

  const getBounds = (): BrowserTabPresentationBounds => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  };

  const sendPresentation = (requestedVisible: boolean) => {
    const bounds = getBounds();
    present(tabId, bounds, requestedVisible && bounds.width > 0 && bounds.height > 0);
  };

  const refresh = () => {
    if (!active) return;
    if (frame !== null) cancelFrame(frame);
    frame = requestFrame(() => {
      frame = null;
      if (!active) return;
      sendPresentation(paneVisible && documentTarget.visibilityState !== 'hidden');
    });
  };

  const onVisibilityChange = () => {
    if (documentTarget.visibilityState === 'hidden') {
      if (frame !== null) cancelFrame(frame);
      frame = null;
      if (active) sendPresentation(false);
      return;
    }
    refresh();
  };

  documentTarget.addEventListener('visibilitychange', onVisibilityChange);
  refresh();

  return {
    refresh,
    dispose() {
      if (!active) return;
      active = false;
      documentTarget.removeEventListener('visibilitychange', onVisibilityChange);
      if (frame !== null) cancelFrame(frame);
      frame = null;
      present(tabId, { x: 0, y: 0, width: 0, height: 0 }, false);
    },
  };
}
