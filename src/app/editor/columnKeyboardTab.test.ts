// @vitest-environment happy-dom
import { Editor } from '@tiptap/core';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { EditorContent } from '@tiptap/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocNode } from '../../core/model';
import { createExtensions } from './extensions';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock('./bases', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  onPagesChange: () => () => {},
}));

let editor: Editor | null = null;
let root: Root | null = null;

function make(content: DocNode): Editor {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: createExtensions({
      onBlockMenu: () => {},
      resolvePage: () => null,
      resolveTarget: () => null,
      subscribe: () => () => {},
      openTag: () => {},
      createChild: () => null,
      openDate: () => {},
      pages: () => [],
      findPages: () => [],
    } as never),
    content: content as never,
  });
  return editor;
}

function setRect(element: Element, left: number, top: number, width: number, height: number): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: left,
      y: top,
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      toJSON: () => ({}),
    }),
  });
}

function textPosition(target: Editor, value: string): number {
  let result: number | null = null;
  target.state.doc.descendants((node, position) => {
    if (node.isText && node.text?.includes(value)) {
      result = position + node.text.indexOf(value);
      return false;
    }
    return true;
  });
  if (result === null) throw new Error(`No text found: ${value}`);
  return result;
}

function columnsPositionForText(target: Editor, value: string): number {
  const $position = target.state.doc.resolve(textPosition(target, value));
  for (let depth = $position.depth; depth > 0; depth--) {
    if ($position.node(depth).type.name === 'columns') return $position.before(depth);
  }
  throw new Error(`No columns group contains: ${value}`);
}

function pressTab(target: Editor, reverse = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey: reverse,
    bubbles: true,
    cancelable: true,
  });
  target.view.dom.dispatchEvent(event);
  return event;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  editor?.destroy();
  editor = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('Tab access to column resize separators', () => {
  it('uses the real editor keydown path for columns and leaves list, table, code, and note focus alone', async () => {
    const item = (text: string, ...nested: DocNode[]): DocNode => ({
      type: 'listItem',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }, ...nested],
    });
    const columns: DocNode = {
      type: 'columns',
      attrs: { widths: '20.00, 30.00, 50.00' },
      content: [
        {
          type: 'column',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Direct left' }] },
            {
              type: 'columns',
              content: [
                { type: 'column', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Nested left' }] }] },
                { type: 'column', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Nested right' }] }] },
              ],
            },
            {
              type: 'bulletList',
              content: [
                item('Previous'),
                item('Parent', { type: 'bulletList', content: [item('Child')] }),
              ],
            },
            {
              type: 'table',
              content: [
                {
                  type: 'tableRow',
                  content: [
                    {
                      type: 'tableCell',
                      content: [
                        { type: 'paragraph', content: [{ type: 'text', text: 'Cell A' }] },
                        {
                          type: 'columns',
                          content: [
                            { type: 'column', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Cell nested left' }] }] },
                            { type: 'column', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Cell nested right' }] }] },
                          ],
                        },
                      ],
                    },
                    { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Cell B' }] }] },
                  ],
                },
              ],
            },
            { type: 'codeBlock', content: [{ type: 'text', text: 'code' }] },
          ],
        },
        { type: 'column', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Middle' }] }] },
        { type: 'column', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Right' }] }] },
      ],
    };
    const otherColumns: DocNode = {
      type: 'columns',
      content: [
        { type: 'column', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Other left' }] }] },
        { type: 'column', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Other middle' }] }] },
        { type: 'column', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Other right' }] }] },
      ],
    };
    const target = make({
      type: 'doc',
      content: [columns, otherColumns, { type: 'paragraph', content: [{ type: 'text', text: 'Outside note' }] }],
    });
    const pane = document.createElement('div');
    pane.className = 'pane';
    const contentHost = document.createElement('div');
    pane.append(contentHost);
    document.body.append(pane);
    root = createRoot(contentHost);
    await act(async () => root?.render(createElement(EditorContent, { editor: target })));

    const wrapper = target.view.nodeDOM(0);
    if (!(wrapper instanceof HTMLElement)) throw new Error('The columns node view did not mount.');
    const grid = Array.from(wrapper.children).find(
      (child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains('columns'),
    );
    if (!grid) throw new Error('The columns grid did not mount.');
    setRect(wrapper, 0, 0, 800, 240);
    setRect(grid, 0, 0, 800, 240);
    const otherWrapper = target.view.nodeDOM(columnsPositionForText(target, 'Other middle'));
    if (!(otherWrapper instanceof HTMLElement)) throw new Error('The second columns node view did not mount.');
    const otherGrid = Array.from(otherWrapper.children).find(
      (child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains('columns'),
    );
    if (!otherGrid) throw new Error('The second columns grid did not mount.');
    setRect(otherWrapper, 0, 260, 800, 240);
    setRect(otherGrid, 0, 260, 800, 240);
    window.dispatchEvent(new Event('resize'));
    const handles = Array.from(wrapper.children).filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.classList.contains('column-layout-resize-handle'),
    );
    const otherHandles = Array.from(otherWrapper.children).filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.classList.contains('column-layout-resize-handle'),
    );
    const nestedWrapper = target.view.nodeDOM(columnsPositionForText(target, 'Nested right'));
    if (!(nestedWrapper instanceof HTMLElement)) throw new Error('The nested columns node view did not mount.');
    const nestedHandles = Array.from(nestedWrapper.children).filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.classList.contains('column-layout-resize-handle'),
    );
    const nestedGrid = Array.from(nestedWrapper.children).find(
      (child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains('columns'),
    );
    if (!nestedGrid) throw new Error('The nested columns grid did not mount.');
    setRect(nestedWrapper, 20, 30, 800, 160);
    setRect(nestedGrid, 20, 30, 800, 160);
    const cellNestedWrapper = target.view.nodeDOM(columnsPositionForText(target, 'Cell nested right'));
    if (!(cellNestedWrapper instanceof HTMLElement)) throw new Error('The table cell columns node view did not mount.');
    const cellNestedHandles = Array.from(cellNestedWrapper.children).filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.classList.contains('column-layout-resize-handle'),
    );
    const cellNestedGrid = Array.from(cellNestedWrapper.children).find(
      (child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains('columns'),
    );
    if (!cellNestedGrid) throw new Error('The table cell columns grid did not mount.');
    setRect(cellNestedWrapper, 20, 200, 800, 160);
    setRect(cellNestedGrid, 20, 200, 800, 160);
    window.dispatchEvent(new Event('resize'));
    expect(handles).toHaveLength(2);
    expect(otherHandles).toHaveLength(2);
    expect(nestedHandles).toHaveLength(1);
    expect(cellNestedHandles).toHaveLength(1);
    expect(handles.every((handle) => !handle.hidden && handle.tabIndex === 0)).toBe(true);

    target.commands.setTextSelection(textPosition(target, 'Direct left'));
    target.view.focus();
    const selection = target.state.selection;
    const tab = pressTab(target);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(handles[0]);
    expect(target.state.selection).toBe(selection);

    target.commands.setTextSelection(textPosition(target, 'Right'));
    target.view.focus();
    const reverseTab = pressTab(target, true);
    expect(reverseTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(handles[1]);

    target.commands.setTextSelection(textPosition(target, 'Other middle'));
    target.view.focus();
    pressTab(target);
    expect(document.activeElement).toBe(otherHandles[0]);

    target.commands.setTextSelection(textPosition(target, 'Nested right'));
    target.view.focus();
    pressTab(target);
    expect(document.activeElement).toBe(nestedHandles[0]);

    target.commands.setTextSelection(textPosition(target, 'Parent'));
    target.view.focus();
    const listBefore = target.state.doc;
    pressTab(target);
    expect(target.state.doc).not.toBe(listBefore);
    expect(document.activeElement).toBe(target.view.dom);

    target.commands.setTextSelection(textPosition(target, 'Cell A'));
    target.view.focus();
    const cellBefore = target.state.selection.from;
    pressTab(target);
    expect(target.state.selection.from).not.toBe(cellBefore);
    expect(document.activeElement).toBe(target.view.dom);

    target.commands.setTextSelection(textPosition(target, 'Cell nested left'));
    target.view.focus();
    const firstCellBefore = target.state.selection.from;
    pressTab(target, true);
    expect(target.state.selection.from).toBe(firstCellBefore);
    expect(document.activeElement).toBe(target.view.dom);
    expect(document.activeElement).not.toBe(cellNestedHandles[0]);

    target.commands.setTextSelection(textPosition(target, 'code'));
    target.view.focus();
    const codeBefore = target.state.doc;
    pressTab(target);
    expect(target.state.doc).toBe(codeBefore);
    expect(document.activeElement).toBe(target.view.dom);

    target.commands.setTextSelection({
      from: textPosition(target, 'Direct left'),
      to: textPosition(target, 'Direct left') + 'Direct'.length,
    });
    target.view.focus();
    pressTab(target);
    expect(document.activeElement).toBe(target.view.dom);

    target.commands.setTextSelection(textPosition(target, 'Outside note'));
    target.view.focus();
    pressTab(target);
    expect(document.activeElement).toBe(target.view.dom);

    pane.dataset.size = 'narrow';
    window.dispatchEvent(new Event('resize'));
    expect(handles.every((handle) => handle.hidden && handle.tabIndex === -1)).toBe(true);
    target.commands.setTextSelection(textPosition(target, 'Direct left'));
    target.view.focus();
    pressTab(target);
    expect(document.activeElement).toBe(target.view.dom);

    delete pane.dataset.size;
    target.setEditable(false);
    target.commands.setTextSelection(textPosition(target, 'Direct left'));
    target.view.focus();
    pressTab(target);
    expect(document.activeElement).not.toBe(handles[0]);
  });
});
