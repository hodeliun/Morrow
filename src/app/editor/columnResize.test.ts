// @vitest-environment happy-dom
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocNode } from '../../core/model';
import { docToMarkdown } from '../../core/markdown/serialize';
import { parseLegacyColumnWidths } from '../../core/columnWidths';
import { BlockHandle } from './BlockHandle';
import { ColumnGrip } from './ColumnGrip';
import { focusedEditor, ownsUndo, setFocusedEditor, undoRedo } from './commits';
import {
  columnPairPercentageBounds,
  hasColumnWidthChange,
  resizeColumnPairByPointer,
  resizeColumnPairByPercentagePoints,
  resizeColumnPairToLimit,
  serializeColumnWidthResize,
  startingColumnWidths,
} from './columnResize';
import { Column, Columns } from './Structure';

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

function pointerEvent(
  type: string,
  { pointerId = 1, clientX = 0, button = 0, isPrimary = true }: Partial<PointerEvent> = {},
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    clientX: { value: clientX },
    button: { value: button },
    isPrimary: { value: isPrimary },
  });
  return event;
}

function mouseMove(clientX: number, clientY: number): MouseEvent {
  const event = new MouseEvent('mousemove', { bubbles: true });
  Object.defineProperties(event, {
    clientX: { value: clientX },
    clientY: { value: clientY },
  });
  return event;
}

function page(count: number, widths: string | null): DocNode {
  return {
    type: 'doc',
    content: [
      {
        type: 'columns',
        ...(widths === null ? {} : { attrs: { widths } }),
        content: Array.from({ length: count }, (_, index) => ({
          type: 'column',
          content: [
            {
              type: 'paragraph',
              attrs: { blockId: `column-${index + 1}` },
              content: [{ type: 'text', text: `Column ${index + 1}` }],
            },
          ],
        })),
      },
    ],
  };
}

function createEditor(
  count: number,
  widths: string | null,
  options: { paneSize?: string; onMenu?: (request: { pos: number }) => void } = {},
): { editor: Editor; pane: HTMLDivElement; host: HTMLDivElement } {
  const pane = document.createElement('div');
  pane.className = 'pane';
  if (options.paneSize) pane.dataset.size = options.paneSize;
  const host = document.createElement('div');
  pane.append(host);
  document.body.append(pane);
  const editor = new Editor({
    element: host,
    extensions: [
      StarterKit,
      Columns,
      Column,
      ColumnGrip,
      BlockHandle.configure({ onMenu: options.onMenu ?? (() => {}) }),
    ],
    content: page(count, widths) as never,
  });
  return { editor, pane, host };
}

function setColumnLayoutRects(editor: Editor, width = 600): HTMLElement {
  const wrapper = editor.view.dom.querySelector<HTMLElement>('.columns-editor');
  const grid = wrapper?.querySelector<HTMLElement>('.columns');
  if (!wrapper || !grid) throw new Error('Columns node view was not mounted.');
  setRect(wrapper, 0, 0, width, 120);
  setRect(grid, 0, 0, width, 120);
  return grid;
}

function resizeHandle(editor: Editor, pair = '1-2'): HTMLDivElement {
  const handle = editor.view.dom.querySelector<HTMLDivElement>(
    `.column-layout-resize-handle[data-column-pair="${pair}"]`,
  );
  if (!handle) throw new Error(`No resize handle for columns ${pair}.`);
  return handle;
}

function textEnd(editor: Editor, text: string): number {
  let result: number | null = null;
  editor.state.doc.descendants((node, position) => {
    if (node.isText && node.text?.includes(text)) {
      result = position + node.text.indexOf(text) + text.length;
      return false;
    }
    return true;
  });
  if (result === null) throw new Error(`No text found: ${text}`);
  return result;
}

const editors: Editor[] = [];

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  setFocusedEditor(null);
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('column pointer resizing', () => {
  it('keeps the selected pair sum, clamps to parser limits, and preserves untouched source tokens', () => {
    expect(startingColumnWidths(null, 3)).toEqual([100, 100, 100]);
    const before = parseLegacyColumnWidths(' 020.00, 080.00, 040.00', 3)!;
    const after = resizeColumnPairByPointer(before, 0, 100, 500, 80)!;
    expect(after).toEqual([48, 52, 40]);
    expect(after[0]! + after[1]!).toBe(before[0]! + before[1]!);
    expect(after[2]).toBe(before[2]);
    expect(
      serializeColumnWidthResize(' 020.00, 080.00, 040.00', 3, before, after, 0),
    ).toBe(' 48, 52, 040.00');
    expect(hasColumnWidthChange(before, before)).toBe(false);

    const atParserLimit = resizeColumnPairByPointer([999.99, 1000], 0, 500, 100, 0)!;
    expect(atParserLimit).toEqual([1000, 999.99]);
    expect(parseLegacyColumnWidths(atParserLimit.map((width) => width.toFixed(2)).join(','), 2)).not.toBeNull();

    const remainsPositive = resizeColumnPairByPointer([1, 1], 0, 10_000, 1000, 0)!;
    expect(remainsPositive).toEqual([1.99, 0.01]);
    expect(parseLegacyColumnWidths(remainsPositive.map(String).join(','), 2)).not.toBeNull();

    const longSource = `1,1,${' '.repeat(83)}1,1,1,1,1`;
    expect(longSource).toHaveLength(96);
    const longBefore = parseLegacyColumnWidths(longSource, 7)!;
    const longAfter = resizeColumnPairByPointer(longBefore, 0, 7.2, 500, 0)!;
    const compacted = serializeColumnWidthResize(longSource, 7, longBefore, longAfter, 0);
    expect(compacted).not.toBeNull();
    expect(compacted!.length).toBeLessThanOrEqual(96);
    expect(parseLegacyColumnWidths(compacted, 7)).toEqual([1.1, 0.9, 1, 1, 1, 1, 1]);
  });

  it('moves two percentage points of the full layout within the selected pair and exposes its limits', () => {
    const before = [100, 100, 100, 100];
    const decreased = resizeColumnPairByPercentagePoints(before, 1, -2, 700, 80)!;
    expect(decreased).toEqual([100, 92, 108, 100]);
    expect(decreased[1]! + decreased[2]!).toBe(before[1]! + before[2]!);
    expect(decreased[0]).toBe(before[0]);
    expect(decreased[3]).toBe(before[3]);

    const increased = resizeColumnPairByPercentagePoints(decreased, 1, 2, 700, 80)!;
    expect(increased).toEqual(before);
    expect(columnPairPercentageBounds(before, 1, 700, 80)).toEqual({
      minimum: 11.43,
      maximum: 38.57,
      current: 25,
    });

    expect(resizeColumnPairToLimit(before, 1, 'minimum', 700, 80)).toEqual([
      100,
      45.72,
      154.28,
      100,
    ]);
    expect(resizeColumnPairToLimit(before, 1, 'maximum', 700, 80)).toEqual([
      100,
      154.28,
      45.72,
      100,
    ]);
  });

  it('previews without document changes, commits one undoable 2–7 column edit, and preserves neighbors', () => {
    for (const { count, source, pair } of [
      { count: 2, source: null, pair: '1-2' },
      { count: 7, source: ' 020.00, 080.00, 050.00, 030.00, 040.00, 050.00, 070.00', pair: '2-3' },
    ] as const) {
      const { editor } = createEditor(count, source);
      editors.push(editor);
      const grid = setColumnLayoutRects(editor);
      window.dispatchEvent(new Event('resize'));
      const handle = resizeHandle(editor, pair);
      const layoutHandles = Array.from(
        editor.view.dom.querySelectorAll<HTMLDivElement>('.column-layout-resize-handle'),
      );
      expect(layoutHandles).toHaveLength(count - 1);
      expect(layoutHandles.every((item) => item.tabIndex === 0)).toBe(true);
      expect(handle.classList.contains('column-layout-resize-handle')).toBe(true);
      expect(handle.classList.contains('column-resize-handle')).toBe(false);
      expect(handle.hidden).toBe(false);

      const before = editor.getJSON() as DocNode;
      const originalColumns = before.content?.[0];
      if (!originalColumns) throw new Error('Columns were not present before resizing.');
      const originalWidths = originalColumns.attrs?.widths ?? null;
      expect(grid.getAttribute('data-widths')).toBe(source);
      const initialGridTemplate = grid.style.getPropertyValue('--column-grid-template');
      let changedTransactions = 0;
      editor.on('transaction', ({ transaction }) => {
        if (transaction.docChanged) changedTransactions++;
      });

      handle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 12, clientX: 200 }));
      window.dispatchEvent(pointerEvent('pointermove', { pointerId: 12, clientX: 240 }));
      expect((editor.getJSON() as DocNode).content?.[0]?.attrs?.widths ?? null).toBe(originalWidths);
      expect(grid.getAttribute('data-widths')).toBe(source);
      expect(grid.style.getPropertyValue('--column-grid-template')).not.toBe(initialGridTemplate);
      window.dispatchEvent(pointerEvent('pointerup', { pointerId: 12, clientX: 240 }));

      const after = editor.getJSON() as DocNode;
      const resizedColumns = after.content?.[0];
      if (!resizedColumns) throw new Error('Columns were removed while resizing.');
      const resizedText = resizedColumns.attrs?.widths;
      expect(typeof resizedText).toBe('string');
      expect(grid.getAttribute('data-widths')).toBe(resizedText);
      const resized = parseLegacyColumnWidths(resizedText, count);
      expect(resized).not.toBeNull();
      expect(resizedColumns.content).toEqual(originalColumns.content);
      expect(changedTransactions).toBe(1);
      if (source !== null) {
        const sourceParts = source.split(',');
        const resultParts = String(resizedText).split(',');
        for (let index = 0; index < count; index++) {
          if (index !== (pair === '2-3' ? 1 : 0) && index !== (pair === '2-3' ? 2 : 1)) {
            expect(resultParts[index]).toBe(sourceParts[index]);
          }
        }
      }
      expect(docToMarkdown(after)).toContain(`data-widths="${resizedText}"`);

      editor.commands.setTextSelection(textEnd(editor, 'Column 1'));
      editor.commands.insertContent(' next');
      expect(editor.commands.undo()).toBe(true);
      expect((editor.getJSON() as DocNode).content?.[0]?.attrs?.widths).toBe(resizedText);
      expect((editor.getJSON() as DocNode).content?.[0]?.content).toEqual(originalColumns.content);
      expect(editor.commands.undo()).toBe(true);
      expect((editor.getJSON() as DocNode).content?.[0]?.attrs?.widths ?? null).toBe(originalWidths);
      expect(grid.getAttribute('data-widths')).toBe(originalWidths);
      expect(editor.commands.redo()).toBe(true);
      expect((editor.getJSON() as DocNode).content?.[0]?.attrs?.widths).toBe(resizedText);
      expect(grid.getAttribute('data-widths')).toBe(resizedText);
    }
  });

  it('returns focus to the editor after a committed resize so the real undo shortcut uses its history', () => {
    const source = '020.00, 080.00';
    const { editor } = createEditor(2, source);
    const { editor: otherEditor } = createEditor(2, '040.00, 060.00');
    editors.push(editor, otherEditor);
    const grid = setColumnLayoutRects(editor);
    setColumnLayoutRects(otherEditor);
    window.dispatchEvent(new Event('resize'));

    editor.commands.setTextSelection(textEnd(editor, 'Column 1'));
    const selection = { from: editor.state.selection.from, to: editor.state.selection.to };
    otherEditor.view.focus();
    expect(document.activeElement).toBe(otherEditor.view.dom);

    const handle = resizeHandle(editor);
    handle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 40, clientX: 200 }));
    expect(ownsUndo(document.activeElement)).toBe(false);
    window.dispatchEvent(pointerEvent('pointermove', { pointerId: 40, clientX: 240 }));
    window.dispatchEvent(pointerEvent('pointerup', { pointerId: 40, clientX: 240 }));

    const resizedText = editor.state.doc.firstChild?.attrs.widths;
    expect(typeof resizedText).toBe('string');
    expect(document.activeElement).toBe(editor.view.dom);
    expect(ownsUndo(document.activeElement)).toBe(true);
    expect({ from: editor.state.selection.from, to: editor.state.selection.to }).toEqual(selection);
    expect(grid.getAttribute('data-widths')).toBe(resizedText);

    const undo = new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    editor.view.dom.dispatchEvent(undo);
    expect(undo.defaultPrevented).toBe(true);
    expect(editor.state.doc.firstChild?.attrs.widths).toBe(source);
    expect(otherEditor.state.doc.firstChild?.attrs.widths).toBe('040.00, 060.00');

    const redo = new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    editor.view.dom.dispatchEvent(redo);
    expect(redo.defaultPrevented).toBe(true);
    expect(editor.state.doc.firstChild?.attrs.widths).toBe(resizedText);
    expect(otherEditor.state.doc.firstChild?.attrs.widths).toBe('040.00, 060.00');
  });

  it('supports keyboard separators and restores explicit equal weights through the focused editor history', () => {
    const source = '100.00, 100.00';
    const { editor } = createEditor(2, source);
    const { editor: otherEditor } = createEditor(2, '040.00, 060.00');
    editors.push(editor, otherEditor);
    const grid = setColumnLayoutRects(editor);
    setColumnLayoutRects(otherEditor);
    window.dispatchEvent(new Event('resize'));
    const originalChildren = editor.state.doc.firstChild?.content.toJSON();

    setFocusedEditor(otherEditor);
    otherEditor.view.focus();
    const handle = resizeHandle(editor);
    expect(handle.hidden).toBe(false);
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('aria-valuenow')).toBe('50');
    expect(handle.getAttribute('aria-valuemin')).toBe('20.98');
    expect(handle.getAttribute('aria-valuemax')).toBe('79.02');
    expect(handle.getAttribute('aria-keyshortcuts')).toContain('ArrowLeft');

    // Simulate browser Tab landing on the separator from a different focused pane.
    handle.focus();
    expect(document.activeElement).toBe(handle);
    expect(focusedEditor()).toBe(editor);
    expect(ownsUndo(handle)).toBe(false);

    const decrease = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
    handle.dispatchEvent(decrease);
    expect(decrease.defaultPrevented).toBe(true);
    expect(parseLegacyColumnWidths(String(editor.state.doc.firstChild?.attrs.widths), 2)).toEqual([96, 104]);
    expect(grid.getAttribute('data-widths')).toBe(editor.state.doc.firstChild?.attrs.widths);
    const afterDecrease = editor.state.doc.firstChild?.attrs.widths;
    undoRedo('undo');
    expect(editor.state.doc.firstChild?.attrs.widths).toBe(source);
    undoRedo('redo');
    expect(editor.state.doc.firstChild?.attrs.widths).toBe(afterDecrease);

    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(parseLegacyColumnWidths(String(editor.state.doc.firstChild?.attrs.widths), 2)).toEqual([92, 108]);
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    expect(parseLegacyColumnWidths(String(editor.state.doc.firstChild?.attrs.widths), 2)).toEqual([96, 104]);
    const increase = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
    handle.dispatchEvent(increase);
    expect(increase.defaultPrevented).toBe(true);
    expect(parseLegacyColumnWidths(String(editor.state.doc.firstChild?.attrs.widths), 2)).toEqual([100, 100]);

    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    expect(parseLegacyColumnWidths(String(editor.state.doc.firstChild?.attrs.widths), 2)).toEqual([41.96, 158.04]);
    expect(handle.getAttribute('aria-valuenow')).toBe('20.98');
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    const endWidths = editor.state.doc.firstChild?.attrs.widths;
    expect(parseLegacyColumnWidths(String(endWidths), 2)).toEqual([158.04, 41.96]);
    expect(handle.getAttribute('aria-valuenow')).toBe('79.02');

    const restore = new KeyboardEvent('keydown', { key: 'r', bubbles: true, cancelable: true });
    handle.dispatchEvent(restore);
    expect(restore.defaultPrevented).toBe(true);
    expect(editor.state.doc.firstChild?.attrs.widths).toBeNull();
    expect(grid.hasAttribute('data-widths')).toBe(false);
    expect(editor.state.doc.firstChild?.content.toJSON()).toEqual(originalChildren);
    expect(document.activeElement).toBe(handle);

    undoRedo('undo');
    expect(editor.state.doc.firstChild?.attrs.widths).toBe(endWidths);
    expect(grid.getAttribute('data-widths')).toBe(endWidths);
    expect(focusedEditor()).toBe(editor);
    expect(otherEditor.state.doc.firstChild?.attrs.widths).toBe('040.00, 060.00');
    undoRedo('redo');
    expect(editor.state.doc.firstChild?.attrs.widths).toBeNull();
    expect(otherEditor.state.doc.firstChild?.attrs.widths).toBe('040.00, 060.00');
  });

  it('keeps the editor as undo owner when the restore button disappears', () => {
    const source = '050.00, 050.00';
    const { editor } = createEditor(2, source);
    const { editor: otherEditor } = createEditor(2, '040.00, 060.00');
    editors.push(editor, otherEditor);
    const grid = setColumnLayoutRects(editor);
    setColumnLayoutRects(otherEditor);
    window.dispatchEvent(new Event('resize'));
    const originalChildren = editor.state.doc.firstChild?.content.toJSON();
    setFocusedEditor(otherEditor);
    otherEditor.view.focus();

    const resetButton = editor.view.dom.querySelector<HTMLButtonElement>('.column-width-reset');
    if (!resetButton) throw new Error('The restore-widths button was not mounted.');
    expect(resetButton.hidden).toBe(false);
    expect(resetButton.tabIndex).toBe(0);
    expect(resetButton.getAttribute('aria-label')).toBe(resetButton.textContent);
    resetButton.focus();
    expect(focusedEditor()).toBe(editor);
    resetButton.click();

    const firstHandle = resizeHandle(editor);
    expect(editor.state.doc.firstChild?.attrs.widths).toBeNull();
    expect(grid.hasAttribute('data-widths')).toBe(false);
    expect(editor.state.doc.firstChild?.content.toJSON()).toEqual(originalChildren);
    expect(resetButton.hidden).toBe(true);
    expect(document.activeElement).toBe(firstHandle);
    expect(focusedEditor()).toBe(editor);
    undoRedo('undo');
    expect(editor.state.doc.firstChild?.attrs.widths).toBe(source);
    expect(grid.getAttribute('data-widths')).toBe(source);
    expect(otherEditor.state.doc.firstChild?.attrs.widths).toBe('040.00, 060.00');
    undoRedo('redo');
    expect(editor.state.doc.firstChild?.attrs.widths).toBeNull();
    expect(grid.hasAttribute('data-widths')).toBe(false);
  });

  it('blocks every group adjustment during a drag and cancels from another divider or reset button', () => {
    const source = '020.00, 040.00, 040.00';
    const { editor } = createEditor(3, source);
    editors.push(editor);
    const grid = setColumnLayoutRects(editor);
    window.dispatchEvent(new Event('resize'));
    const firstHandle = resizeHandle(editor, '1-2');
    const secondHandle = resizeHandle(editor, '2-3');
    const resetButton = editor.view.dom.querySelector<HTMLButtonElement>('.column-width-reset');
    if (!resetButton) throw new Error('The restore-widths button was not mounted.');
    const committedTemplate = grid.style.getPropertyValue('--column-grid-template');
    let committedTransactions = 0;
    editor.on('transaction', ({ transaction }) => {
      if (transaction.docChanged) committedTransactions++;
    });

    firstHandle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 81, clientX: 100 }));
    window.dispatchEvent(pointerEvent('pointermove', { pointerId: 81, clientX: 140 }));
    const previewTemplate = grid.style.getPropertyValue('--column-grid-template');
    expect(previewTemplate).not.toBe(committedTemplate);

    const blockedAdjustment = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    });
    secondHandle.dispatchEvent(blockedAdjustment);
    expect(blockedAdjustment.defaultPrevented).toBe(true);
    expect(editor.state.doc.firstChild?.attrs.widths).toBe(source);
    expect(grid.getAttribute('data-widths')).toBe(source);
    expect(grid.style.getPropertyValue('--column-grid-template')).toBe(previewTemplate);
    expect(committedTransactions).toBe(0);

    secondHandle.focus();
    secondHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(grid.style.getPropertyValue('--column-grid-template')).toBe(committedTemplate);
    expect(editor.view.dom.querySelector('.columns-editor')?.classList.contains('is-resizing')).toBe(false);
    window.dispatchEvent(pointerEvent('pointerup', { pointerId: 81, clientX: 140 }));
    expect(editor.state.doc.firstChild?.attrs.widths).toBe(source);
    expect(committedTransactions).toBe(0);

    secondHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    expect(parseLegacyColumnWidths(String(editor.state.doc.firstChild?.attrs.widths), 3)).toEqual([20, 42, 38]);
    expect(committedTransactions).toBe(1);
    const resizedWidths = editor.state.doc.firstChild?.attrs.widths;
    const resizedTemplate = grid.style.getPropertyValue('--column-grid-template');
    expect(resetButton.hidden).toBe(false);

    firstHandle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 82, clientX: 100 }));
    window.dispatchEvent(pointerEvent('pointermove', { pointerId: 82, clientX: 140 }));
    const secondPreviewTemplate = grid.style.getPropertyValue('--column-grid-template');
    expect(secondPreviewTemplate).not.toBe(resizedTemplate);

    resetButton.focus();
    resetButton.click();
    expect(editor.state.doc.firstChild?.attrs.widths).toBe(resizedWidths);
    expect(grid.getAttribute('data-widths')).toBe(resizedWidths);
    expect(grid.style.getPropertyValue('--column-grid-template')).toBe(secondPreviewTemplate);
    expect(committedTransactions).toBe(1);

    resetButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(grid.style.getPropertyValue('--column-grid-template')).toBe(resizedTemplate);
    window.dispatchEvent(pointerEvent('pointerup', { pointerId: 82, clientX: 140 }));
    expect(editor.state.doc.firstChild?.attrs.widths).toBe(resizedWidths);
    expect(committedTransactions).toBe(1);

    resetButton.click();
    expect(editor.state.doc.firstChild?.attrs.widths).toBeNull();
    expect(grid.hasAttribute('data-widths')).toBe(false);
    expect(committedTransactions).toBe(2);
  });

  it('cancels stale and narrow drags, and keeps block handles targeted inside the wrapper', async () => {
    const onMenu = vi.fn();
    const { editor } = createEditor(2, null, { onMenu });
    editors.push(editor);
    const grid = setColumnLayoutRects(editor);
    const columns = Array.from(grid.children).filter((child) => child.hasAttribute('data-column'));
    if (columns.length !== 2) throw new Error('Column children were not mounted in the grid.');
    setRect(columns[0]!, 0, 0, 286, 100);
    setRect(columns[1]!, 314, 0, 286, 100);
    const firstParagraph = columns[0]!.querySelector<HTMLElement>('p');
    if (!firstParagraph) throw new Error('First column paragraph was not mounted.');
    setRect(firstParagraph, 8, 10, 270, 36);

    const blockHandle = editor.view.dom.parentElement?.querySelector<HTMLButtonElement>('.block-handle');
    if (!blockHandle) throw new Error('The existing block handle was not mounted.');
    editor.view.dom.dispatchEvent(mouseMove(100, 20));
    blockHandle.click();
    expect(onMenu).toHaveBeenCalledTimes(1);
    const request = onMenu.mock.calls[0]![0];
    expect(editor.state.doc.nodeAt(request.pos)?.type.name).toBe('paragraph');
    editor.view.dom.dispatchEvent(mouseMove(300, 20));
    blockHandle.click();
    expect(onMenu).toHaveBeenCalledTimes(2);
    const gapRequest = onMenu.mock.calls[1]![0];
    expect(editor.state.doc.nodeAt(gapRequest.pos)?.type.name).toBe('columns');

    const handle = resizeHandle(editor);
    let committedTransactions = 0;
    editor.on('transaction', ({ transaction }) => {
      if (transaction.docChanged) committedTransactions++;
    });
    handle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 20, clientX: 100 }));
    window.dispatchEvent(pointerEvent('pointerup', { pointerId: 20, clientX: 100 }));
    expect(committedTransactions).toBe(0);
    expect((editor.getJSON() as DocNode).content?.[0]?.attrs?.widths ?? null).toBeNull();

    handle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 21, clientX: 100 }));
    const baseline = grid.style.getPropertyValue('--column-grid-template');
    window.dispatchEvent(pointerEvent('pointermove', { pointerId: 99, clientX: 240 }));
    expect(grid.style.getPropertyValue('--column-grid-template')).toBe(baseline);
    window.dispatchEvent(pointerEvent('pointermove', { pointerId: 21, clientX: 240 }));
    expect(grid.style.getPropertyValue('--column-grid-template')).not.toBe(baseline);
    handle.dispatchEvent(pointerEvent('lostpointercapture', { pointerId: 21 }));
    expect(grid.style.getPropertyValue('--column-grid-template')).toBe(baseline);
    window.dispatchEvent(pointerEvent('pointerup', { pointerId: 21, clientX: 240 }));
    expect((editor.getJSON() as DocNode).content?.[0]?.attrs?.widths ?? null).toBeNull();

    handle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 22, clientX: 100 }));
    window.dispatchEvent(pointerEvent('pointermove', { pointerId: 22, clientX: 240 }));
    const shortcutDuringDrag = new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    handle.dispatchEvent(shortcutDuringDrag);
    expect(shortcutDuringDrag.defaultPrevented).toBe(true);
    expect((editor.getJSON() as DocNode).content?.[0]?.attrs?.widths ?? null).toBeNull();
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    window.dispatchEvent(pointerEvent('pointerup', { pointerId: 22, clientX: 240 }));
    expect((editor.getJSON() as DocNode).content?.[0]?.attrs?.widths ?? null).toBeNull();
    expect(committedTransactions).toBe(0);

    handle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 24, clientX: 100 }));
    window.dispatchEvent(pointerEvent('pointermove', { pointerId: 24, clientX: 240 }));
    window.dispatchEvent(pointerEvent('pointercancel', { pointerId: 24, clientX: 240 }));
    expect(grid.style.getPropertyValue('--column-grid-template')).toBe(baseline);
    expect((editor.getJSON() as DocNode).content?.[0]?.attrs?.widths ?? null).toBeNull();

    handle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 23, clientX: 100 }));
    window.dispatchEvent(pointerEvent('pointermove', { pointerId: 23, clientX: 240 }));
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(0, undefined, { ...editor.state.doc.firstChild!.attrs, widths: '80,120' }),
    );
    window.dispatchEvent(pointerEvent('pointerup', { pointerId: 23, clientX: 240 }));
    expect((editor.getJSON() as DocNode).content?.[0]?.attrs?.widths).toBe('80,120');

    handle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 25, clientX: 100 }));
    window.dispatchEvent(pointerEvent('pointermove', { pointerId: 25, clientX: 240 }));
    editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Other note' }] }] });
    window.dispatchEvent(pointerEvent('pointerup', { pointerId: 25, clientX: 240 }));
    expect((editor.getJSON() as DocNode).content?.[0]?.type).toBe('paragraph');
    expect((editor.getJSON() as DocNode).content?.[0]?.content?.[0]?.text).toBe('Other note');

    const { editor: narrowEditor } = createEditor(2, null, { paneSize: 'narrow' });
    editors.push(narrowEditor);
    const narrowGrid = setColumnLayoutRects(narrowEditor);
    window.dispatchEvent(new Event('resize'));
    const narrowHandle = resizeHandle(narrowEditor);
    const narrowReset = narrowEditor.view.dom.querySelector<HTMLButtonElement>('.column-width-reset');
    expect(narrowHandle.hidden).toBe(true);
    expect(narrowHandle.tabIndex).toBe(-1);
    expect(narrowReset?.hidden).toBe(true);
    expect(narrowReset?.tabIndex).toBe(-1);

    const viewportWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 });
    const { editor: viewportEditor } = createEditor(2, null);
    editors.push(viewportEditor);
    setColumnLayoutRects(viewportEditor);
    window.dispatchEvent(new Event('resize'));
    expect(resizeHandle(viewportEditor).hidden).toBe(true);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: viewportWidth });
    window.dispatchEvent(new Event('resize'));

    const { editor: readonlyEditor } = createEditor(2, null);
    editors.push(readonlyEditor);
    setColumnLayoutRects(readonlyEditor);
    window.dispatchEvent(new Event('resize'));
    const readonlyHandle = resizeHandle(readonlyEditor);
    readonlyHandle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 31, clientX: 100 }));
    window.dispatchEvent(pointerEvent('pointermove', { pointerId: 31, clientX: 240 }));
    readonlyEditor.setEditable(false);
    window.dispatchEvent(pointerEvent('pointerup', { pointerId: 31, clientX: 240 }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(resizeHandle(readonlyEditor).hidden).toBe(true);
    expect(resizeHandle(readonlyEditor).tabIndex).toBe(-1);
    const readonlyReset = readonlyEditor.view.dom.querySelector<HTMLButtonElement>('.column-width-reset');
    expect(readonlyReset?.hidden).toBe(true);
    expect(readonlyReset?.tabIndex).toBe(-1);
    expect(document.activeElement).not.toBe(resizeHandle(readonlyEditor));
    expect((readonlyEditor.getJSON() as DocNode).content?.[0]?.attrs?.widths ?? null).toBeNull();
    expect(narrowGrid.style.getPropertyValue('--column-grid-template')).toContain('1fr');
  });
});
