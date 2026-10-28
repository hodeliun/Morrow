import { useLayoutEffect, useRef } from 'react';

interface DismissableLayer {
  surface: HTMLElement;
  element: HTMLElement;
  trigger: HTMLElement | null;
  onDismiss: () => void;
  restoreFocusOnEscape: boolean;
  restoreFocusOnUnmount: boolean;
  previousOrder: string;
}

interface RegisterDismissableLayerOptions {
  surface: HTMLElement;
  element: HTMLElement;
  trigger?: HTMLElement | null;
  onDismiss: () => void;
  restoreFocusOnEscape?: boolean;
  restoreFocusOnUnmount?: boolean;
}

interface LayerRef {
  current: HTMLElement | null;
}

const activeLayers: DismissableLayer[] = [];
const portalRootId = 'morrow-overlay-root';
let listenersAttached = false;

function updateLayerOrder() {
  activeLayers.forEach((layer, index) => {
    layer.element.style.setProperty('--layer-order', String(index + 1));
  });
}

function onDocumentPointerDown(event: PointerEvent) {
  handleLayerPointerDown(event);
}

function onDocumentKeyDown(event: KeyboardEvent) {
  handleLayerEscape(event);
}

function attachDocumentListeners() {
  if (listenersAttached || typeof document === 'undefined') return;
  listenersAttached = true;
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  document.addEventListener('keydown', onDocumentKeyDown, true);
}

function detachDocumentListeners() {
  if (!listenersAttached || typeof document === 'undefined') return;
  listenersAttached = false;
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  document.removeEventListener('keydown', onDocumentKeyDown, true);
}

export function handleLayerEscape(event: KeyboardEvent): boolean {
  if (event.key !== 'Escape') return false;
  const top = activeLayers.at(-1);
  if (!top) return false;

  event.preventDefault();
  event.stopImmediatePropagation();
  top.onDismiss();
  if (top.restoreFocusOnEscape && top.trigger?.isConnected) top.trigger.focus({ preventScroll: true });
  return true;
}

export function handleLayerPointerDown(event: Pick<PointerEvent, 'target'>): boolean {
  const top = activeLayers.at(-1);
  if (!top || !event.target) return false;
  const target = event.target as Node;
  if (top.surface.contains(target) || top.trigger?.contains(target)) return false;
  top.onDismiss();
  return true;
}

export function registerDismissableLayer(options: RegisterDismissableLayerOptions): () => void {
  const layer: DismissableLayer = {
    ...options,
    trigger: options.trigger ?? null,
    restoreFocusOnEscape: options.restoreFocusOnEscape ?? false,
    restoreFocusOnUnmount: options.restoreFocusOnUnmount ?? false,
    previousOrder: options.element.style.getPropertyValue('--layer-order'),
  };
  activeLayers.push(layer);
  updateLayerOrder();
  attachDocumentListeners();

  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    const index = activeLayers.indexOf(layer);
    if (index < 0) return;
    activeLayers.splice(index, 1);
    updateLayerOrder();
    if (layer.previousOrder) layer.element.style.setProperty('--layer-order', layer.previousOrder);
    else layer.element.style.removeProperty('--layer-order');
    if (activeLayers.length === 0) detachDocumentListeners();
    if (layer.restoreFocusOnUnmount && layer.trigger?.isConnected) layer.trigger.focus({ preventScroll: true });
  };
}

export function useDismissableLayer({
  surfaceRef,
  elementRef = surfaceRef,
  trigger,
  triggerRef,
  onDismiss,
  captureFocusOnMount = false,
  restoreFocusOnEscape = false,
  restoreFocusOnUnmount = false,
}: {
  surfaceRef: LayerRef;
  elementRef?: LayerRef;
  trigger?: HTMLElement | null;
  triggerRef?: LayerRef;
  onDismiss: () => void;
  captureFocusOnMount?: boolean;
  restoreFocusOnEscape?: boolean;
  restoreFocusOnUnmount?: boolean;
}) {
  const dismissRef = useRef(onDismiss);
  const capturedTrigger = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  useLayoutEffect(() => {
    if (captureFocusOnMount) {
      capturedTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    const surface = surfaceRef.current;
    const element = elementRef.current;
    if (!surface || !element) return;
    return registerDismissableLayer({
      surface,
      element,
      trigger: trigger !== undefined ? trigger : (triggerRef?.current ?? capturedTrigger.current),
      onDismiss: () => dismissRef.current(),
      restoreFocusOnEscape,
      restoreFocusOnUnmount,
    });
  }, [
    captureFocusOnMount,
    elementRef,
    restoreFocusOnEscape,
    restoreFocusOnUnmount,
    surfaceRef,
    trigger,
    triggerRef,
  ]);
}

export function layerPortalTarget(): HTMLElement {
  const existing = document.getElementById(portalRootId);
  if (existing) return existing;
  const root = document.createElement('div');
  root.id = portalRootId;
  root.className = 'overlay-layer-root';
  document.body.append(root);
  return root;
}
