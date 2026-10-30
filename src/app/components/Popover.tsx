import { computePosition, flip, offset, shift, size } from '@floating-ui/dom';
import type { Placement } from '@floating-ui/dom';
import type { ReactNode } from 'react';
import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { layerPortalTarget, useDismissableLayer } from './layers';

// a floating panel anchored to an element, closed by escape or a click outside
export function Popover({
  anchor,
  onClose,
  children,
  placement = 'bottom-start',
  label,
  className,
}: {
  anchor: HTMLElement | DOMRect;
  onClose: () => void;
  children: ReactNode;
  placement?: Placement;
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useDismissableLayer({
    surfaceRef: ref,
    trigger: anchor instanceof HTMLElement ? anchor : null,
    onDismiss: onClose,
    restoreFocusOnEscape: true,
  });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const reference = anchor instanceof HTMLElement ? anchor : { getBoundingClientRect: () => anchor };
    // focus waits until the panel is placed and shown, a hidden element can not take it
    let focused = false;
    const place = () =>
      void computePosition(reference, element, {
        placement,
        strategy: 'fixed',
        middleware: [
          offset(6),
          flip({ padding: 8 }),
          shift({ padding: 8, crossAxis: true }),
          size({
            padding: 8,
            apply({ availableHeight, availableWidth, elements }) {
              Object.assign(elements.floating.style, {
                maxHeight: `${Math.max(160, Math.floor(availableHeight))}px`,
                maxWidth: `${Math.max(220, Math.floor(availableWidth))}px`,
              });
            },
          }),
        ],
      }).then(({ x, y }) => {
        element.style.left = `${x}px`;
        element.style.top = `${y}px`;
        element.style.visibility = 'visible';
        if (focused) return;
        focused = true;
        (element.querySelector<HTMLElement>('[data-autofocus]') ??
          element.querySelector<HTMLElement>('input, select, button'))?.focus();
      });
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    return () => observer.disconnect();
  }, [anchor, placement]);

  return createPortal(
    <div
      ref={ref}
      className={`popover floating-layer panel-popover${className ? ` ${className}` : ''}`}
      role="dialog"
      aria-label={label}
      style={{ visibility: 'hidden' }}
    >
      {children}
    </div>,
    layerPortalTarget(),
  );
}
