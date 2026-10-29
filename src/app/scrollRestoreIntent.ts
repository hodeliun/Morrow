export interface ScrollRestorePointerIntent {
  isTrusted: boolean;
  targetIsPageContent: boolean;
  targetIsNavigationControl: boolean;
  targetIsInteractiveControl: boolean;
  inScrollbarGutter: boolean;
}

export function shouldCancelPendingScrollRestoreForPointer(intent: ScrollRestorePointerIntent): boolean {
  return (
    intent.isTrusted &&
    (intent.targetIsPageContent ||
      intent.targetIsNavigationControl ||
      intent.targetIsInteractiveControl ||
      intent.inScrollbarGutter)
  );
}

export interface ScrollRestoreKeyboardIntent {
  eventType: 'keydown' | 'compositionstart';
  isTrusted: boolean;
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  altGraph: boolean;
  isComposing: boolean;
  targetCanEdit: boolean;
  targetIsTextControl: boolean;
  targetPreventsPageScroll: boolean;
}

const PAGE_SCROLL_KEYS = new Set(['ArrowDown', 'ArrowUp', 'End', 'Home', 'PageDown', 'PageUp', ' ']);
const EDIT_START_KEYS = new Set(['F2', 'Enter']);
const TEXT_MODIFICATION_KEYS = new Set(['Backspace', 'Delete']);

export function shouldCancelPendingScrollRestoreForKeyboard(intent: ScrollRestoreKeyboardIntent): boolean {
  if (!intent.isTrusted) return false;

  // Tab only changes focus or switches tabs; neither action claims the current viewport.
  if (intent.eventType === 'keydown' && intent.key === 'Tab') return false;

  if (intent.eventType === 'compositionstart') return intent.targetCanEdit || intent.targetIsTextControl;
  if (intent.isComposing || intent.key === 'Process' || intent.key === 'Dead') {
    return intent.targetCanEdit || intent.targetIsTextControl;
  }

  if (EDIT_START_KEYS.has(intent.key)) return true;
  if (TEXT_MODIFICATION_KEYS.has(intent.key) && (intent.targetCanEdit || intent.targetIsTextControl)) {
    return true;
  }

  const unmodifiedPrintable =
    intent.key.length === 1 && !intent.metaKey && ((!intent.ctrlKey && !intent.altKey) || intent.altGraph);
  if (unmodifiedPrintable && (intent.targetCanEdit || intent.targetIsTextControl)) return true;

  if (!PAGE_SCROLL_KEYS.has(intent.key)) return false;
  return !intent.targetPreventsPageScroll;
}
