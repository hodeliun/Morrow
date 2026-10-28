import { computePosition, flip, offset, shift, size } from '@floating-ui/dom';
import type { Placement } from '@floating-ui/dom';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export type MenuEntry =
  | {
      label: string;
      icon?: LucideIcon;
      swatch?: string;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      checked?: boolean;
      onSelect: () => void;
    }
  | { separator: true }
  | { heading: string }
  | { custom: ReactNode };

interface MenuProps {
  anchor: HTMLElement | DOMRect;
  entries: MenuEntry[];
  onClose: () => void;
  placement?: Placement;
  label: string;
}

export function Menu({ anchor, entries, onClose, placement = 'bottom-start', label }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const reference = anchor instanceof HTMLElement ? anchor : { getBoundingClientRect: () => anchor };
    void computePosition(reference, element, {
      placement,
      strategy: 'fixed',
      middleware: [
        offset(4),
        flip({ padding: 8 }),
        shift({ padding: 8 }),
        size({
          padding: 8,
          apply({ availableHeight, availableWidth, elements }) {
            Object.assign(elements.floating.style, {
              maxHeight: `${Math.max(120, Math.floor(availableHeight))}px`,
              maxWidth: `${Math.max(180, Math.floor(availableWidth))}px`,
            });
          },
        }),
      ],
    }).then(({ x, y }) => {
      element.style.left = `${x}px`;
      element.style.top = `${y}px`;
      element.style.visibility = 'visible';
    });
    const firstButton = element.querySelector<HTMLButtonElement>('button:not(:disabled)');
    firstButton?.focus();
    firstButton?.scrollIntoView({ block: 'nearest' });
  }, [anchor, placement]);

  useEffect(() => {
    const trigger = anchor instanceof HTMLElement ? anchor : null;
    const onPointer = (event: PointerEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      if (trigger?.contains(event.target as Node)) return;
      closeRef.current();
    };
    const onBlurWindow = () => closeRef.current();
    document.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('blur', onBlurWindow);
    window.addEventListener('resize', onBlurWindow);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('blur', onBlurWindow);
      window.removeEventListener('resize', onBlurWindow);
      // give focus back to whatever opened the menu
      if (trigger?.isConnected && document.activeElement === document.body)
        trigger.focus({ preventScroll: true });
    };
  }, [anchor]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const buttons = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
    );
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next = buttons[(index + 1) % buttons.length];
      next?.focus();
      next?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const prev = buttons[(index - 1 + buttons.length) % buttons.length];
      prev?.focus();
      prev?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Home') {
      event.preventDefault();
      const first = buttons[0];
      first?.focus();
      first?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'End') {
      event.preventDefault();
      const last = buttons[buttons.length - 1];
      last?.focus();
      last?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  return createPortal(
    <div
      ref={ref}
      className="menu popover floating-layer"
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      style={{ visibility: 'hidden' }}
    >
      {entries.map((entry, index) => {
        if ('separator' in entry) return <div key={index} className="menu-separator" role="separator" />;
        if ('heading' in entry)
          return (
            <div key={index} className="menu-section">
              {entry.heading}
            </div>
          );
        if ('custom' in entry)
          return (
            <div key={index} className="menu-custom-entry">
              {entry.custom}
            </div>
          );
        const Icon = entry.icon;
        return (
          <button
            key={index}
            type="button"
            role={entry.checked === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={entry.checked}
            className={`menu-item${entry.danger ? ' is-danger' : ''}`}
            disabled={entry.disabled}
            onClick={() => {
              onClose();
              entry.onSelect();
            }}
          >
            <span className="menu-icon">
              {entry.swatch ? (
                <span
                  className={`menu-swatch${entry.swatch === 'transparent' ? ' is-transparent' : ''}`}
                  style={entry.swatch !== 'transparent' ? { backgroundColor: entry.swatch } : undefined}
                  aria-hidden="true"
                />
              ) : (
                Icon && <Icon size={15} strokeWidth={1.75} />
              )}
            </span>
            <span className="menu-label">{entry.label}</span>
            {entry.checked && <span className="menu-check">✓</span>}
            {entry.shortcut && <kbd className="menu-shortcut">{entry.shortcut}</kbd>}
          </button>
        );
      })}
    </div>,
    // inside the main landmark so assistive tech finds the menu where the page lives
    document.querySelector('main') ?? document.body,
  );
}
