import { mergeAttributes, Node } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import Suggestion from '@tiptap/suggestion';
import { CalendarDays, FileText } from 'lucide-react';
import { dateKey, parseDateKey } from '../../core/daily';
import type { MenuItem } from './SuggestionMenu';
import { renderSuggestion } from './SuggestionMenu';
import { dateLocale, t } from '../i18n';
import { getPreferences } from '../platform/preferences';
import type { DateFormat } from '../platform/preferences';
import { legacyColumnGridTemplate, parseLegacyColumnWidths } from '../../core/columnWidths';
import {
  columnPairPercentageBounds,
  closeColumnWidthResizeHistory,
  createColumnWidthsTransaction,
  hasColumnWidthChange,
  resizeColumnPairByPointer,
  resizeColumnPairByPercentagePoints,
  resizeColumnPairToLimit,
  serializeColumnWidthResize,
  startingColumnWidths,
} from './columnResize';
import { setFocusedEditor } from './commits';

const COLUMN_GAP = 28;
const KEYBOARD_COLUMN_STEP_PERCENTAGE_POINTS = 2;

function minColumnWidthFor(count: number): number {
  if (count >= 6) return 50;
  if (count >= 4) return 80;
  return 120;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    columns: {
      setColumns: (count: number) => ReturnType;
    };
  }
}

// side by side blocks, each column holds any blocks
export const Columns = Node.create({
  name: 'columns',
  group: 'block',
  content: 'column{2,7}',
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      widths: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const value = element.getAttribute('data-widths');
          if (value === null) return null;
          const count = Array.from(element.children).filter((child) => child.matches('div[data-column]')).length;
          return parseLegacyColumnWidths(value, count) ? value : null;
        },
        renderHTML: (attributes: { widths?: unknown }) => {
          const value = attributes.widths;
          return parseLegacyColumnWidths(value) ? { 'data-widths': value as string } : {};
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-columns]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const gridTemplate =
      legacyColumnGridTemplate(node.attrs.widths, node.childCount) ??
      `repeat(${node.childCount}, minmax(0, 1fr))`;
    const style = [
      `--columns: ${node.childCount}`,
      `--column-grid-template: ${gridTemplate}`,
    ].join('; ');
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-columns': '',
        class: 'columns',
        style,
      }),
      0,
    ];
  },

  addNodeView() {
    return ({ node, view, getPos, editor }) => {
      let currentNode = node;
      let previewWidths: number[] | null = null;
      let drag: {
        pointerId: number;
        pairIndex: number;
        startX: number;
        startWidths: number[];
        sourceWidths: string | null;
        availableWidth: number;
        position: number;
        sourceNode: typeof node;
        sourceDoc: typeof view.state.doc;
        handle: HTMLDivElement;
      } | null = null;
      const dom = document.createElement('div');
      dom.className = 'columns-editor';
      const contentDOM = document.createElement('div');
      contentDOM.className = 'columns';
      contentDOM.setAttribute('data-columns', '');
      dom.append(contentDOM);

      const handles: HTMLDivElement[] = [];
      const restoreButton = document.createElement('button');
      restoreButton.type = 'button';
      restoreButton.className = 'column-width-reset';
      restoreButton.contentEditable = 'false';
      restoreButton.hidden = true;
      restoreButton.addEventListener('focus', () => setFocusedEditor(editor));
      restoreButton.addEventListener('click', () => restoreEqualWidths(handles[0] ?? null));
      let observedPane: HTMLElement | null = null;
      let paneObserver: MutationObserver | null = null;

      const positionOfCurrentNode = (): number | null => {
        try {
          const position = getPos();
          return typeof position === 'number' ? position : null;
        } catch {
          return null;
        }
      };

      const committedWidthsAttribute = (): string | null => {
        const value = currentNode.attrs.widths;
        return typeof value === 'string' && parseLegacyColumnWidths(value, currentNode.childCount) ? value : null;
      };

      const availableWidth = (): number | null => {
        const width = contentDOM.getBoundingClientRect().width;
        const available = width - COLUMN_GAP * (currentNode.childCount - 1);
        return Number.isFinite(available) && available > 0 ? available : null;
      };

      const viewportIsNarrow = (): boolean => {
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
        const mediaNarrow =
          typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 720px)').matches;
        return mediaNarrow || (viewportWidth > 0 && viewportWidth <= 720);
      };

      const canResize = (): boolean => {
        if (!view.editable || viewportIsNarrow() || dom.closest<HTMLElement>('.pane')?.dataset.size === 'narrow')
          return false;
        const widths = startingColumnWidths(currentNode.attrs.widths, currentNode.childCount);
        const position = positionOfCurrentNode();
        return (
          widths !== null &&
          currentNode.childCount >= 2 &&
          currentNode.childCount <= 7 &&
          position !== null &&
          view.state.doc.nodeAt(position) === currentNode &&
          availableWidth() !== null
        );
      };

      const trackTemplate = (widths: readonly number[]): string =>
        widths.map((width) => `minmax(0, ${width}fr)`).join(' ');

      const focusControl = (control: HTMLElement) => {
        try {
          control.focus({ preventScroll: true });
        } catch {
          control.focus();
        }
      };

      const paint = () => {
        observeCurrentPane();
        const count = currentNode.childCount;
        const committedWidths = committedWidthsAttribute();
        if (committedWidths === null) {
          contentDOM.removeAttribute('data-widths');
        } else if (contentDOM.getAttribute('data-widths') !== committedWidths) {
          contentDOM.setAttribute('data-widths', committedWidths);
        }
        const widths = previewWidths ?? startingColumnWidths(currentNode.attrs.widths, count);
        const visualWidths = widths ?? Array.from({ length: count }, () => 100);
        const template =
          previewWidths !== null
            ? trackTemplate(previewWidths)
            : legacyColumnGridTemplate(currentNode.attrs.widths, count) ??
              `repeat(${count}, minmax(0, 1fr))`;
        contentDOM.style.setProperty('--columns', String(count));
        contentDOM.style.setProperty('--column-grid-template', template);

        const active = canResize();
        const contentRect = contentDOM.getBoundingClientRect();
        const rootRect = dom.getBoundingClientRect();
        const available = availableWidth();
        restoreButton.hidden = !active || committedWidths === null;
        restoreButton.tabIndex = restoreButton.hidden ? -1 : 0;
        restoreButton.textContent = t('editor.restoreEqualColumnWidths');
        restoreButton.setAttribute('aria-label', t('editor.restoreEqualColumnWidths'));
        if (!active && document.activeElement === restoreButton) restoreButton.blur();
        const total = visualWidths.reduce((sum, width) => sum + width, 0);
        const usableWidth = Math.max(0, contentRect.width - COLUMN_GAP * (count - 1));
        let leftShare = 0;
        for (let index = 0; index < handles.length; index++) {
          leftShare += visualWidths[index]!;
          const handle = handles[index]!;
          const boundary =
            total > 0
              ? (leftShare / total) * usableWidth + COLUMN_GAP * index + COLUMN_GAP / 2
              : 0;
          const offset = contentRect.width > 0 ? contentRect.left - rootRect.left + boundary : 0;
          handle.style.left = contentRect.width > 0 ? `${offset}px` : `${(leftShare / total) * 100}%`;
          handle.hidden = !active;
          handle.tabIndex = active ? 0 : -1;
          handle.setAttribute('aria-label', t('editor.resizeColumnPair', { left: index + 1, right: index + 2 }));
          const bounds =
            available === null
              ? null
              : columnPairPercentageBounds(
                  visualWidths,
                  index,
                  available,
                  minColumnWidthFor(count),
                );
          const formatPercentage = (value: number | undefined): string =>
            value === undefined ? '0' : String(Number(value.toFixed(2)));
          handle.setAttribute('aria-valuemin', formatPercentage(bounds?.minimum));
          handle.setAttribute('aria-valuemax', formatPercentage(bounds?.maximum ?? 100));
          handle.setAttribute('aria-valuenow', formatPercentage(bounds?.current));
          handle.setAttribute(
            'aria-valuetext',
            t('editor.columnPairValueText', {
              left: index + 1,
              right: index + 2,
              value: formatPercentage(bounds?.current),
            }),
          );
          handle.setAttribute(
            'aria-keyshortcuts',
            'ArrowLeft ArrowDown ArrowRight ArrowUp Home End R',
          );
        }
        if (
          !active &&
          document.activeElement instanceof HTMLElement &&
          handles.includes(document.activeElement as HTMLDivElement)
        ) {
          document.activeElement.blur();
        }
        dom.classList.toggle('is-resizing', drag !== null);
      };

      const removeWindowListeners = () => {
        window.removeEventListener('pointermove', moveDrag, true);
        window.removeEventListener('pointerup', endDrag, true);
        window.removeEventListener('pointercancel', onPointerCancel, true);
      };

      const releasePointerCapture = (state: NonNullable<typeof drag>) => {
        try {
          if (
            typeof state.handle.hasPointerCapture === 'function' &&
            state.handle.hasPointerCapture(state.pointerId)
          ) {
            state.handle.releasePointerCapture(state.pointerId);
          }
        } catch {
          // Pointer capture may be unavailable in synthetic or embedded browsers.
        }
      };

      const cancelDrag = (pointerId?: number, repaint = true) => {
        if (!drag || (pointerId !== undefined && drag.pointerId !== pointerId)) return;
        const state = drag;
        drag = null;
        previewWidths = null;
        removeWindowListeners();
        releasePointerCapture(state);
        dom.classList.remove('is-resizing');
        if (repaint) paint();
      };

      function commitWidths(widths: string | null, focusTarget: HTMLElement | null): boolean {
        if (drag !== null || !canResize()) return false;
        const position = positionOfCurrentNode();
        if (position === null || view.state.doc.nodeAt(position) !== currentNode) return false;
        const transaction = createColumnWidthsTransaction(view.state.tr, position, currentNode, widths);
        if (!transaction) return false;
        view.dispatch(transaction);
        view.dispatch(closeColumnWidthResizeHistory(view.state.tr));
        if (!view.isDestroyed) {
          if (focusTarget) focusControl(focusTarget);
          else view.focus();
        }
        return true;
      }

      function restoreEqualWidths(focusTarget: HTMLElement | null): boolean {
        if (drag !== null) return false;
        return commitWidths(null, focusTarget);
      }

      const changePairFromKeyboard = (
        pairIndex: number,
        action: 'decrease' | 'increase' | 'minimum' | 'maximum',
        handle: HTMLDivElement,
      ) => {
        if (drag !== null || !canResize()) return;
        const widths = startingColumnWidths(currentNode.attrs.widths, currentNode.childCount);
        const available = availableWidth();
        if (widths === null || available === null) return;
        const after =
          action === 'minimum' || action === 'maximum'
            ? resizeColumnPairToLimit(
                widths,
                pairIndex,
                action === 'minimum' ? 'minimum' : 'maximum',
                available,
                minColumnWidthFor(currentNode.childCount),
              )
            : resizeColumnPairByPercentagePoints(
                widths,
                pairIndex,
                action === 'decrease'
                  ? -KEYBOARD_COLUMN_STEP_PERCENTAGE_POINTS
                  : KEYBOARD_COLUMN_STEP_PERCENTAGE_POINTS,
                available,
                minColumnWidthFor(currentNode.childCount),
              );
        if (after === null || !hasColumnWidthChange(widths, after)) return;
        const encoded = serializeColumnWidthResize(
          typeof currentNode.attrs.widths === 'string' ? currentNode.attrs.widths : null,
          currentNode.childCount,
          widths,
          after,
          pairIndex,
        );
        if (encoded !== null) commitWidths(encoded, handle);
      };

      const dragIsCurrent = (state: NonNullable<typeof drag>): boolean => {
        const position = positionOfCurrentNode();
        const width = availableWidth();
        return (
          drag === state &&
          view.editable &&
          !viewportIsNarrow() &&
          dom.closest<HTMLElement>('.pane')?.dataset.size !== 'narrow' &&
          view.state.doc === state.sourceDoc &&
          currentNode === state.sourceNode &&
          position === state.position &&
          position !== null &&
          view.state.doc.nodeAt(position) === state.sourceNode &&
          width !== null &&
          Math.abs(width - state.availableWidth) < 0.5
        );
      };

      const updatePreview = (event: PointerEvent) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const state = drag;
        if (!dragIsCurrent(state)) {
          cancelDrag();
          return;
        }
        const next = resizeColumnPairByPointer(
          state.startWidths,
          state.pairIndex,
          event.clientX - state.startX,
          state.availableWidth,
          minColumnWidthFor(currentNode.childCount),
        );
        if (next === null) {
          cancelDrag();
          return;
        }
        previewWidths = next;
        paint();
      };

      function moveDrag(event: PointerEvent): void {
        updatePreview(event);
      }

      function endDrag(event: PointerEvent): void {
        if (!drag || event.pointerId !== drag.pointerId) return;
        updatePreview(event);
        if (!drag) return;
        const state = drag;
        const after = previewWidths;
        const changed = after !== null && hasColumnWidthChange(state.startWidths, after);
        cancelDrag(undefined, false);
        if (!changed || after === null) {
          paint();
          return;
        }
        const encoded = serializeColumnWidthResize(
          state.sourceWidths,
          state.sourceNode.childCount,
          state.startWidths,
          after,
          state.pairIndex,
        );
        if (encoded === null) {
          paint();
          return;
        }
        const transaction = createColumnWidthsTransaction(
          view.state.tr,
          state.position,
          state.sourceNode,
          encoded,
        );
        if (transaction) commitWidths(encoded, null);
        else paint();
      }

      function onPointerCancel(event: PointerEvent): void {
        cancelDrag(event.pointerId);
      }

      const startDrag = (pairIndex: number, handle: HTMLDivElement, event: PointerEvent) => {
        if (
          drag ||
          event.button !== 0 ||
          event.isPrimary === false ||
          !canResize()
        ) {
          return;
        }
        const position = positionOfCurrentNode();
        const startWidths = startingColumnWidths(currentNode.attrs.widths, currentNode.childCount);
        const width = availableWidth();
        if (
          position === null ||
          startWidths === null ||
          width === null ||
          view.state.doc.nodeAt(position) !== currentNode
        ) {
          return;
        }
        event.preventDefault();
        try {
          handle.focus({ preventScroll: true });
        } catch {
          handle.focus();
        }
        drag = {
          pointerId: event.pointerId,
          pairIndex,
          startX: event.clientX,
          startWidths,
          sourceWidths: typeof currentNode.attrs.widths === 'string' ? currentNode.attrs.widths : null,
          availableWidth: width,
          position,
          sourceNode: currentNode,
          sourceDoc: view.state.doc,
          handle,
        };
        try {
          handle.setPointerCapture(event.pointerId);
        } catch {
          // Window listeners still follow the pointer if capture is unsupported.
        }
        window.addEventListener('pointermove', moveDrag, true);
        window.addEventListener('pointerup', endDrag, true);
        window.addEventListener('pointercancel', onPointerCancel, true);
        paint();
      };

      const onLayoutChange = () => {
        if (drag && !dragIsCurrent(drag)) cancelDrag();
        paint();
      };

      function observeCurrentPane(): void {
        const pane = dom.closest<HTMLElement>('.pane');
        if (pane === observedPane) return;
        paneObserver?.disconnect();
        paneObserver = null;
        observedPane = pane;
        if (pane && typeof MutationObserver !== 'undefined') {
          paneObserver = new MutationObserver(onLayoutChange);
          paneObserver.observe(pane, { attributes: true, attributeFilter: ['data-size'] });
        }
      }

      for (let index = 0; index < node.childCount - 1; index++) {
        const handle = document.createElement('div');
        handle.className = 'column-layout-resize-handle';
        handle.dataset.columnPair = `${index + 1}-${index + 2}`;
        handle.setAttribute('role', 'separator');
        handle.setAttribute('aria-orientation', 'vertical');
        handle.tabIndex = -1;
        handle.contentEditable = 'false';
        handle.hidden = true;
        handle.addEventListener('focus', () => setFocusedEditor(editor));
        handle.addEventListener('pointerdown', (event) => startDrag(index, handle, event));
        handle.addEventListener('keydown', (event) => {
          if (drag !== null) {
            event.preventDefault();
            event.stopPropagation();
            if (event.key === 'Escape') cancelDrag(drag.pointerId);
            return;
          }
          if (!canResize() || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          const action =
            event.key === 'ArrowLeft' || event.key === 'ArrowDown'
              ? 'decrease'
              : event.key === 'ArrowRight' || event.key === 'ArrowUp'
                ? 'increase'
                : event.key === 'Home'
                  ? 'minimum'
                  : event.key === 'End'
                    ? 'maximum'
                    : event.key.toLowerCase() === 'r'
                      ? 'restore'
                      : null;
          if (action === null) return;
          event.preventDefault();
          event.stopPropagation();
          if (action === 'restore') restoreEqualWidths(handle);
          else changePairFromKeyboard(index, action, handle);
        });
        handle.addEventListener('lostpointercapture', (event) => {
          cancelDrag((event as PointerEvent).pointerId);
        });
        handles.push(handle);
      }
      restoreButton.addEventListener('keydown', (event) => {
        if (drag === null) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Escape') cancelDrag(drag.pointerId);
      });
      dom.append(...handles, restoreButton);

      paint();
      const resizeObserver =
        typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onLayoutChange);
      resizeObserver?.observe(contentDOM);
      const editabilityObserver =
        typeof MutationObserver === 'undefined' ? null : new MutationObserver(onLayoutChange);
      editabilityObserver?.observe(view.dom, {
        attributes: true,
        attributeFilter: ['contenteditable'],
        subtree: true,
      });
      window.addEventListener('resize', onLayoutChange);

      return {
        dom,
        contentDOM,
        update(updated) {
          if (updated.type !== currentNode.type || updated.childCount !== handles.length + 1) return false;
          if (updated !== currentNode) cancelDrag();
          currentNode = updated;
          previewWidths = null;
          paint();
          return true;
        },
        stopEvent: (event) => !(event.target instanceof HTMLElement && contentDOM.contains(event.target)),
        ignoreMutation: (mutation) => {
          if (mutation.type === 'selection') return false;
          if (
            mutation.type === 'attributes' &&
            mutation.target === contentDOM &&
            (mutation.attributeName === 'style' ||
              (mutation.attributeName === 'data-widths' &&
                contentDOM.getAttribute('data-widths') === committedWidthsAttribute()))
          ) {
            return true;
          }
          return !(mutation.target instanceof HTMLElement && contentDOM.contains(mutation.target));
        },
        destroy() {
          cancelDrag(undefined, false);
          resizeObserver?.disconnect();
          editabilityObserver?.disconnect();
          paneObserver?.disconnect();
          window.removeEventListener('resize', onLayoutChange);
          previewWidths = null;
        },
      };
    };
  },

  addCommands() {
    return {
      setColumns:
        (count) =>
        ({ chain, state }) => {
          const start = state.selection.from;
          const columnCount = Math.min(7, Math.max(2, count));
          return (
            chain()
              .insertContent({
                type: 'columns',
                content: Array.from({ length: columnCount }, () => ({
                  type: 'column',
                  content: [{ type: 'paragraph' }],
                })),
              })
              // typing carries on in the first column
              .command(({ tr }) => {
                let target: number | null = null;
                if (columnCount >= 6) {
                  const insertedAt = tr.mapping.map(start, -1);
                  if (tr.doc.nodeAt(insertedAt)?.type.name === 'columns') target = insertedAt + 2;
                } else {
                  // Keep the existing 2–5 cursor behavior unchanged.
                  tr.doc.nodesBetween(Math.max(0, start - 2), tr.doc.content.size, (node, pos) => {
                    if (target !== null) return false;
                    if (node.type.name === 'column') {
                      target = pos + 2;
                      return false;
                    }
                    return true;
                  });
                }
                if (target !== null) tr.setSelection(TextSelection.near(tr.doc.resolve(target)));
                return true;
              })
              .run()
          );
        },
    };
  },
});

export const Column = Node.create({
  name: 'column',
  content: 'block+',
  isolating: true,

  parseHTML() {
    return [{ tag: 'div[data-column]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-column': '', class: 'column' }), 0];
  },
});

// a live list of the page's headings, each one jumps to its section
// every heading gets an id, unique to its editor, so a table of contents can link to it. links inside the
// page are kept when it is saved as a pdf, there they jump to the heading
function headingIds(doc: PMNode, prefix: string): DecorationSet {
  const decorations: Decoration[] = [];
  let index = 0;
  doc.descendants((node, pos) => {
    // the words of a paragraph are never headings, so only blocks are looked through
    if (node.type.name !== 'heading') return !node.isTextblock;
    decorations.push(Decoration.node(pos, pos + node.nodeSize, { id: `${prefix}-${index++}` }));
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

let editors = 0;

export const TableOfContents = Node.create<object, { prefix: string }>({
  name: 'tableOfContents',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  parseHTML() {
    return [{ tag: 'nav[data-toc]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['nav', mergeAttributes(HTMLAttributes, { 'data-toc': '', class: 'toc' })];
  },

  addStorage() {
    return { prefix: `heading-${(editors++).toString(36)}` };
  },

  addProseMirrorPlugins() {
    const prefix = this.storage.prefix;
    return [
      new Plugin<DecorationSet>({
        key: new PluginKey('headingIds'),
        state: {
          init: (_config, state) => headingIds(state.doc, prefix),
          apply: (tr, value) => (tr.docChanged ? headingIds(tr.doc, prefix) : value),
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },

  addNodeView() {
    return ({ editor }) => {
      const prefix = (editor.storage as unknown as Record<string, { prefix: string }>).tableOfContents!
        .prefix;
      const dom = document.createElement('nav');
      dom.className = 'toc';
      dom.contentEditable = 'false';
      dom.setAttribute('aria-label', t('slash.items.toc.title'));
      let last = '';
      const render = () => {
        const headings: Array<{ level: number; text: string; pos: number }> = [];
        editor.state.doc.descendants((node, pos) => {
          if (node.type.name === 'heading')
            headings.push({ level: Number(node.attrs.level), text: node.textContent, pos });
          return node.type.name !== 'heading';
        });
        const key = JSON.stringify(headings.map((heading) => [heading.level, heading.text]));
        if (key === last) return;
        last = key;
        dom.replaceChildren();
        if (!headings.length) {
          const empty = document.createElement('p');
          empty.className = 'toc-empty';
          empty.textContent = t('editor.tocEmpty');
          dom.append(empty);
          return;
        }
        headings.forEach((heading, index) => {
          const item = document.createElement('a');
          item.href = `#${prefix}-${index}`;
          item.className = `toc-item toc-${Math.min(3, heading.level)}`;
          item.textContent = heading.text || 'Untitled heading';
          item.addEventListener('click', (event) => {
            event.preventDefault();
            // positions move as the page changes, so the heading is found again by its place in the list
            let seen = 0;
            let target: number | null = null;
            editor.state.doc.descendants((node, pos) => {
              if (target !== null) return false;
              if (node.type.name === 'heading') {
                if (seen === index) target = pos;
                seen++;
                return false;
              }
              return true;
            });
            if (target === null) return;
            const element = editor.view.nodeDOM(target) as HTMLElement | null;
            element?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          });
          dom.append(item);
        });
      };
      render();
      editor.on('update', render);
      return {
        dom,
        stopEvent: (event) => event.type === 'click' || event.type === 'mousedown',
        ignoreMutation: () => true,
        destroy: () => {
          editor.off('update', render);
        },
      };
    };
  },
});

export interface DateMentionOptions {
  openDate: (date: Date) => void;
  // a click on a date shows what can be done with it, its day's note or a reminder
  dateMenu?: (date: Date, anchor: HTMLElement, time: string | null) => void;
  findPages: (query: string) => Array<{ id: string; title: string; path: string }>;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// a date in the format picked in settings. relative reads today, tomorrow or a weekday when it's close
export function describeDate(
  key: string,
  today = new Date(),
  format: DateFormat = getPreferences().dateFormat,
): string {
  const date = parseDateKey(key);
  if (!date) return key;
  const pad = (value: number) => String(value).padStart(2, '0');
  const [year, month, day] = [String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate())];
  switch (format) {
    case 'full':
      return date.toLocaleDateString(dateLocale(), { dateStyle: 'full' });
    case 'short':
      return date.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' });
    case 'mdy':
      return `${month}/${day}/${year}`;
    case 'dmy':
      return `${day}/${month}/${year}`;
    case 'ymd':
      return `${year}/${month}/${day}`;
    default:
      break;
  }
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((date.getTime() - start.getTime()) / 86_400_000);
  if (days === 0) return t('daily.today');
  if (days === 1) return t('daily.tomorrow');
  if (days === -1) return t('daily.yesterday');
  const sameYear = date.getFullYear() === today.getFullYear();
  return date.toLocaleDateString(dateLocale(), {
    ...(days > 1 && days < 7 ? { weekday: 'long' } : {}),
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

// dates the @ menu offers for what was typed, like "fri", "next week" or "2026-12-01"
export function dateSuggestions(query: string, today = new Date()): Date[] {
  const at = (days: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
  const text = query.trim().toLowerCase();
  const all: Array<[string, Date]> = [
    ['today', at(0)],
    ['tomorrow', at(1)],
    ['yesterday', at(-1)],
    ['next week', at(7)],
  ];
  for (let offset = 1; offset <= 7; offset++) {
    const date = at(offset);
    all.push([WEEKDAYS[date.getDay()]!, date]);
  }
  const exact = parseDateKey(text);
  if (exact) return [exact];
  const typed = text ? new Date(`${text} ${today.getFullYear()}`) : null;
  const matches = all.filter(
    ([name]) => !text || name.startsWith(text) || name.split(' ').some((word) => word.startsWith(text)),
  );
  const dates = matches.map(([, date]) => date);
  if (typed && !Number.isNaN(typed.getTime()) && /\d/.test(text)) dates.unshift(typed);
  const seen = new Set<string>();
  return dates
    .filter((date) => {
      const key = dateKey(date);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, text ? 6 : 4);
}

// a time typed after a date, 17:05, 5:05pm or 5pm, as hh:mm. null when the words end in no time
export function typedTime(query: string): { rest: string; time: string } | null {
  const match = /\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(query);
  if (!match || (!match[2] && !match[3])) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const half = match[3]?.toLowerCase();
  if (half && (hour < 1 || hour > 12)) return null;
  if (half === 'pm' && hour < 12) hour += 12;
  if (half === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const pad = (value: number) => String(value).padStart(2, '0');
  return { rest: query.slice(0, match.index), time: `${pad(hour)}:${pad(minute)}` };
}

// a time as this computer writes it, 05:05 PM or 17:05
export function describeTime(time: string): string {
  const [hour, minute] = time.split(':').map(Number);
  return new Date(2000, 0, 1, hour ?? 0, minute ?? 0).toLocaleTimeString(dateLocale(), {
    hour: '2-digit',
    minute: '2-digit',
  });
}

const VALID_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const describeMention = (date: string, time: unknown) =>
  typeof time === 'string' && VALID_TIME.test(time)
    ? `${describeDate(date)} ${describeTime(time)}`
    : describeDate(date);

// @today and friends, a date that opens that day's note
export const DateMention = Node.create<DateMentionOptions>({
  name: 'dateMention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return { openDate: () => {}, findPages: () => [] };
  },

  addAttributes() {
    return {
      date: {
        default: null,
        parseHTML: (element) => element.getAttribute('datetime')?.slice(0, 10) ?? null,
      },
      // a time of day written with the date, @today 17:05
      time: {
        default: null,
        parseHTML: (element) => {
          const time = element.getAttribute('datetime')?.slice(11, 16) ?? '';
          return VALID_TIME.test(time) ? time : null;
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'time[datetime]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'time',
      mergeAttributes(HTMLAttributes, {
        class: 'date-mention',
        datetime: node.attrs.time ? `${node.attrs.date}T${node.attrs.time}` : node.attrs.date,
      }),
      describeMention(String(node.attrs.date), node.attrs.time),
    ];
  },

  renderText({ node }) {
    return describeMention(String(node.attrs.date), node.attrs.time);
  },

  addNodeView() {
    return ({ node }) => {
      let current = node;
      const dom = document.createElement('button');
      dom.type = 'button';
      dom.className = 'date-mention';
      dom.contentEditable = 'false';
      const paint = () => {
        const key = String(current.attrs.date ?? '');
        dom.textContent = `@${describeMention(key, current.attrs.time)}`;
        dom.title = t('editor.openNoteFor', {
          date: parseDateKey(key)?.toLocaleDateString(dateLocale(), { dateStyle: 'full' }) ?? key,
        });
        const date = parseDateKey(key);
        const today = dateKey(new Date());
        dom.classList.toggle('is-past', !!date && key < today);
        dom.classList.toggle('is-today', key === today);
      };
      paint();
      dom.addEventListener('click', (event) => {
        event.preventDefault();
        const date = parseDateKey(String(current.attrs.date ?? ''));
        if (!date) return;
        const time = typeof current.attrs.time === 'string' ? current.attrs.time : null;
        if (this.options.dateMenu) this.options.dateMenu(date, dom, time);
        else this.options.openDate(date);
      });
      return {
        dom,
        update(updated) {
          if (updated.type !== current.type) return false;
          current = updated;
          paint();
          return true;
        },
      };
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    const mentionItems = (query: string): MenuItem[] => {
      if (query.length > 30 || /^\s/.test(query)) return [];
      // @today 17:05 keeps the time with the date
      const timed = typedTime(query);
      const days = timed ? dateSuggestions(timed.rest) : dateSuggestions(query);
      const dates: MenuItem[] = days.map((date) => ({
        id: `date:${dateKey(date)}${timed ? `T${timed.time}` : ''}`,
        title: describeMention(dateKey(date), timed?.time),
        description: date.toLocaleDateString(dateLocale(), {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        }),
        icon: CalendarDays,
      }));
      const pages: MenuItem[] = options
        .findPages(query.trim())
        .slice(0, 5)
        .map((page) => ({
          id: `page:${page.id}`,
          title: page.title,
          ...(page.path ? { description: page.path } : {}),
          icon: FileText,
        }));
      return [...dates, ...pages];
    };
    return [
      Suggestion<MenuItem, MenuItem>({
        editor: this.editor,
        pluginKey: new PluginKey('dateMentionSuggestion'),
        char: '@',
        allowSpaces: true,
        // an @ followed by a space or by words that match no date or page is just an @ in a sentence, so
        // the menu goes away and doesn't come back when the cursor returns there
        allow: ({ state, range }) =>
          state.selection.$from.parent.type.name !== 'codeBlock' &&
          mentionItems(state.doc.textBetween(range.from + 1, range.to, ' ')).length > 0,
        items: ({ query }) => mentionItems(query),
        command: ({ editor, range, props }) => insertMention(editor, range, props),
        render: renderSuggestion(
          () => t('editor.mentionDateOrPage'),
          () => t('editor.nothingMatches'),
        ),
      }),
    ];
  },
});

function insertMention(editor: Editor, range: { from: number; to: number }, item: MenuItem): void {
  const [date, time] = item.id.slice(5).split('T');
  const node = item.id.startsWith('date:')
    ? { type: 'dateMention', attrs: { date, time: time ?? null } }
    : { type: 'pageLink', attrs: { id: item.id.slice(5), label: item.title } };
  editor
    .chain()
    .focus()
    .insertContentAt(range, [node, { type: 'text', text: ' ' }])
    .run();
}
