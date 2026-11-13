type InputSelection = {
  readonly start: number;
  readonly end: number;
  readonly direction: 'forward' | 'backward' | 'none' | null;
};

type DomSelection = {
  readonly anchorNode: Node;
  readonly anchorOffset: number;
  readonly focusNode: Node;
  readonly focusOffset: number;
};

type FocusSnapshot = {
  readonly element: HTMLElement;
  readonly inputSelection: InputSelection | null;
  readonly domSelection: DomSelection | null;
};

const leases = new Set<symbol>();
const priorInert = new Map<HTMLElement, boolean>();
const closePointerEvents = new Set([
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'touchstart',
  'touchend',
  'click',
]);
const gatedEvents = [
  'auxclick',
  'beforeinput',
  'blur',
  'change',
  'click',
  'compositionend',
  'compositionstart',
  'compositionupdate',
  'contextmenu',
  'copy',
  'cut',
  'dblclick',
  'drop',
  'dragstart',
  'focusout',
  'input',
  'keydown',
  'keypress',
  'keyup',
  'mousedown',
  'mousemove',
  'mouseup',
  'paste',
  'pointercancel',
  'pointerdown',
  'pointermove',
  'pointerup',
  'reset',
  'select',
  'submit',
  'touchcancel',
  'touchmove',
  'touchstart',
  'touchend',
  'wheel',
] as const;

let observer: MutationObserver | null = null;
let observedBody: HTMLElement | null = null;
let focusBeforeGate: FocusSnapshot | null = null;

function elementTarget(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

function hostCloseButton(target: EventTarget | null): HTMLButtonElement | null {
  const element = elementTarget(target);
  const button = element?.closest<HTMLButtonElement>('button.window-control.is-close');
  const controls = button?.closest<HTMLElement>('.window-controls');
  if (!button || !controls || controls.parentElement !== document.body) return null;
  return button;
}

function isCloseIntent(event: Event): boolean {
  if (!hostCloseButton(event.target)) return false;
  if (event instanceof KeyboardEvent) {
    const closeKey = event.key === 'Enter' || event.key === ' ' || event.code === 'Space';
    return closeKey && !event.ctrlKey && !event.metaKey && !event.altKey;
  }
  return closePointerEvents.has(event.type);
}

function isTabNavigation(event: Event): boolean {
  // Native focus traversal reaches the exempt host Close button; Ctrl+Tab remains blocked.
  return (
    event instanceof KeyboardEvent && event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey
  );
}

function gateEvent(event: Event): void {
  if (!isExitInteractionBlocked() || isCloseIntent(event) || isTabNavigation(event)) return;
  if (event.cancelable) event.preventDefault();
  event.stopImmediatePropagation();
}

// This leaf is imported first by the application entrypoint, before desktop and tab listeners register.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  for (const type of gatedEvents) window.addEventListener(type, gateEvent, true);
}

function setInert(element: HTMLElement): void {
  if (element.matches('.window-controls')) return;
  if (!priorInert.has(element)) priorInert.set(element, element.inert);
  element.inert = true;
}

function inertBodyChildren(body: HTMLElement): void {
  for (const child of Array.from(body.children)) {
    if (child instanceof HTMLElement) setInert(child);
  }
}

function isWithinInertElement(element: HTMLElement, body: HTMLElement): boolean {
  for (
    let current: HTMLElement | null = element;
    current && current !== body;
    current = current.parentElement
  ) {
    if (current.inert) return true;
  }
  return false;
}

function captureFocus(): FocusSnapshot | null {
  if (typeof document === 'undefined') return null;
  const element = document.activeElement;
  if (!(element instanceof HTMLElement) || element === document.body) return null;

  let inputSelection: InputSelection | null = null;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    try {
      const start = element.selectionStart;
      const end = element.selectionEnd;
      if (start !== null && end !== null) {
        inputSelection = { start, end, direction: element.selectionDirection };
      }
    } catch {
      // Some input types do not expose a text selection.
    }
  }

  let domSelection: DomSelection | null = null;
  const selection = document.getSelection();
  if (
    selection?.anchorNode &&
    selection.focusNode &&
    element.contains(selection.anchorNode) &&
    element.contains(selection.focusNode)
  ) {
    domSelection = {
      anchorNode: selection.anchorNode,
      anchorOffset: selection.anchorOffset,
      focusNode: selection.focusNode,
      focusOffset: selection.focusOffset,
    };
  }

  return { element, inputSelection, domSelection };
}

function restoreFocus(snapshot: FocusSnapshot | null, body: HTMLElement | null): void {
  if (!snapshot || !body || !snapshot.element.isConnected || isWithinInertElement(snapshot.element, body))
    return;

  const current = document.activeElement;
  if (current !== snapshot.element && current !== body && current !== document.documentElement) return;

  if (current !== snapshot.element) {
    try {
      snapshot.element.focus({ preventScroll: true });
    } catch {
      return;
    }
  }
  if (document.activeElement !== snapshot.element) return;

  if (
    snapshot.inputSelection &&
    (snapshot.element instanceof HTMLInputElement || snapshot.element instanceof HTMLTextAreaElement)
  ) {
    try {
      snapshot.element.setSelectionRange(
        snapshot.inputSelection.start,
        snapshot.inputSelection.end,
        snapshot.inputSelection.direction ?? 'none',
      );
    } catch {
      // The input may have changed to a type without a text selection while the gate was held.
    }
  }

  const domSelection = snapshot.domSelection;
  const selection = document.getSelection();
  if (
    domSelection &&
    selection &&
    domSelection.anchorNode.isConnected &&
    domSelection.focusNode.isConnected
  ) {
    try {
      selection.setBaseAndExtent(
        domSelection.anchorNode,
        domSelection.anchorOffset,
        domSelection.focusNode,
        domSelection.focusOffset,
      );
    } catch {
      // A contenteditable may have replaced the selected text while the gate was held.
    }
  }
}

function beginGate(): void {
  focusBeforeGate = captureFocus();
  if (typeof document === 'undefined') return;
  const body = document.body;
  if (!body) return;

  observedBody = body;
  inertBodyChildren(body);
  observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (node instanceof HTMLElement) setInert(node);
      }
    }
  });
  observer.observe(body, { childList: true });
}

function endGate(): void {
  observer?.disconnect();
  observer = null;
  const snapshot = focusBeforeGate;
  const body = observedBody;
  observedBody = null;

  for (const [element, inert] of priorInert) element.inert = inert;
  priorInert.clear();
  focusBeforeGate = null;
  restoreFocus(snapshot, body);
}

export function isExitInteractionBlocked(): boolean {
  return leases.size > 0;
}

export function acquireExitInteractionGate(): () => void {
  const lease = Symbol('exit-interaction');
  leases.add(lease);
  if (leases.size === 1) beginGate();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    leases.delete(lease);
    if (leases.size === 0) endGate();
  };
}
