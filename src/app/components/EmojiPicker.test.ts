import { createElement, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeLucideIcon } from '../../core/icons';
import { EmojiPicker } from './EmojiPicker';
import { LUCIDE_ICON_NAMES } from './Emoji';

const pickerHarness = vi.hoisted(() => {
  let workspace: unknown = { pages: {} };
  let dialogChildren: unknown = null;
  return {
    useWorkspace: () => workspace,
    setWorkspace: (next: unknown) => {
      workspace = next;
    },
    captureDialogChildren: (children: unknown) => {
      dialogChildren = children;
    },
    getDialogChildren: () => dialogChildren,
  };
});

vi.mock('../workspace', () => ({ useWorkspace: pickerHarness.useWorkspace }));
vi.mock('../ui', () => ({ closeDialog: vi.fn(), toast: vi.fn() }));
vi.mock('./primitives', async () => {
  const React = await import('react');
  return {
    Dialog: ({
      title,
      className,
      children,
    }: {
      title: string;
      className?: string;
      children: ReactNode;
    }) => {
      pickerHarness.captureDialogChildren(children);
      return React.createElement('section', { className, 'data-dialog-title': title }, children);
    },
  };
});

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<Record<string, unknown>>;
  if (predicate(element)) return element;
  return findElement(element.props.children as ReactNode, predicate);
}

function renderPicker(props: Parameters<typeof EmojiPicker>[0]) {
  pickerHarness.captureDialogChildren(null);
  const markup = renderToStaticMarkup(createElement(EmojiPicker, props));
  return { markup, children: pickerHarness.getDialogChildren() as ReactNode };
}

function clickElement(element: ReactElement<Record<string, unknown>>) {
  const handler = element.props.onClick;
  if (typeof handler !== 'function') throw new Error('Expected the selected icon control to have an onClick handler.');
  Reflect.apply(handler, undefined, []);
}

describe('property icon picker without a page', () => {
  beforeEach(() => {
    pickerHarness.setWorkspace({ pages: {} });
  });

  it('opens for a property without an icon or pageId', () => {
    const { markup } = renderPicker({ title: 'New property', onPick: vi.fn() });

    expect(markup).toContain('emoji-dialog');
    expect(markup).toContain('New property');
    expect(markup).toContain('icon-upload');
  });

  it('renders for a property icon and passes a selected icon to the persistence callback', () => {
    const originalIcon = encodeLucideIcon('BookOpen')!;
    const property = { icon: originalIcon };
    const onPick = vi.fn((icon: string | null) => {
      property.icon = icon ?? '';
    });
    const { markup, children } = renderPicker({
      currentIcon: originalIcon,
      title: 'Author property',
      onPick,
    });

    expect(markup).toContain('emoji-dialog');
    expect(markup).toContain('Author property');
    const option = findElement(
      children,
      (element) => element.props.role === 'option' && element.props.title !== 'BookOpen',
    );
    expect(option).not.toBeNull();
    clickElement(option!);

    expect(onPick).toHaveBeenCalledWith(property.icon);
    expect(property.icon).not.toBe(originalIcon);
  });

  it('continues to read and mark the page icon when a pageId is supplied', () => {
    const iconName = LUCIDE_ICON_NAMES[0]!;
    const pageIcon = encodeLucideIcon(iconName)!;
    pickerHarness.setWorkspace({ pages: { 'page-1': { icon: pageIcon } } });

    const { markup, children } = renderPicker({ pageId: 'page-1', title: 'Page icon', onPick: vi.fn() });
    const selected = findElement(
      children,
      (element) => element.props.role === 'option' && element.props['aria-selected'] === true,
    );

    expect(markup).toContain('emoji-dialog');
    expect(markup).toContain('icon-color-section');
    expect(selected?.props['aria-selected']).toBe(true);
  });
});
