import { describe, expect, it, vi } from 'vitest';
import { handleLayerEscape, handleLayerPointerDown, registerDismissableLayer } from './layers';

function fakeElement(inside: readonly string[] = []) {
  const values = new Map<string, string>();
  return {
    contains: (target: Node | EventTarget | null) => inside.includes(String(target)),
    isConnected: true,
    focus: vi.fn(),
    style: {
      getPropertyValue: (name: string) => values.get(name) ?? '',
      setProperty: (name: string, value: string) => values.set(name, value),
      removeProperty: (name: string) => values.delete(name),
    },
  } as unknown as HTMLElement;
}

describe('dismissable overlay layers', () => {
  it('keeps PropertySettings open and restores RichCanvas focus when Escape closes the top layer', () => {
    const parentElement = fakeElement();
    const parentTrigger = fakeElement();
    const childElement = fakeElement();
    const childTrigger = fakeElement();
    const dismissParent = vi.fn();
    const dismissChild = vi.fn();
    const removeParent = registerDismissableLayer({
      surface: parentElement,
      element: parentElement,
      trigger: parentTrigger,
      onDismiss: dismissParent,
      restoreFocusOnEscape: true,
    });
    const removeChild = registerDismissableLayer({
      surface: childElement,
      element: childElement,
      trigger: childTrigger,
      onDismiss: dismissChild,
      restoreFocusOnEscape: true,
    });

    try {
      expect(parentElement.style.getPropertyValue('--layer-order')).toBe('1');
      expect(childElement.style.getPropertyValue('--layer-order')).toBe('2');
      const event = {
        key: 'Escape',
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        stopImmediatePropagation: vi.fn(),
      } as unknown as KeyboardEvent;

      expect(handleLayerEscape(event)).toBe(true);
      expect(dismissChild).toHaveBeenCalledOnce();
      expect(dismissParent).not.toHaveBeenCalled();
      expect(childTrigger.focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();

      removeChild();
      expect(parentElement.style.getPropertyValue('--layer-order')).toBe('1');
      expect(handleLayerEscape(event)).toBe(true);
      expect(dismissParent).toHaveBeenCalledOnce();
      expect(parentTrigger.focus).toHaveBeenCalledWith({ preventScroll: true });
    } finally {
      removeChild();
      removeParent();
    }
  });

  it('dismisses only the top layer when a pointer lands outside it', () => {
    const parentSurface = fakeElement(['parent-content']);
    const childSurface = fakeElement(['child-content']);
    const childTrigger = fakeElement(['child-trigger']);
    const dismissParent = vi.fn();
    const dismissChild = vi.fn();
    const removeParent = registerDismissableLayer({
      surface: parentSurface,
      element: parentSurface,
      onDismiss: dismissParent,
    });
    const removeChild = registerDismissableLayer({
      surface: childSurface,
      element: childSurface,
      trigger: childTrigger,
      onDismiss: dismissChild,
    });

    try {
      expect(handleLayerPointerDown({ target: 'child-content' as unknown as EventTarget })).toBe(false);
      expect(handleLayerPointerDown({ target: 'child-trigger' as unknown as EventTarget })).toBe(false);
      expect(handleLayerPointerDown({ target: 'parent-content' as unknown as EventTarget })).toBe(true);
      expect(dismissChild).toHaveBeenCalledOnce();
      expect(dismissParent).not.toHaveBeenCalled();

      removeChild();
      expect(handleLayerPointerDown({ target: 'outside' as unknown as EventTarget })).toBe(true);
      expect(dismissParent).toHaveBeenCalledOnce();
    } finally {
      removeChild();
      removeParent();
    }
  });
});
