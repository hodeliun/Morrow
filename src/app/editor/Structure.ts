import { mergeAttributes, Node } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';
import { Fragment, type Node as ProsemirrorNode, type Slice } from '@tiptap/pm/model';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import Suggestion from '@tiptap/suggestion';
import { CalendarDays, FileText } from 'lucide-react';
import {
  formatColumnWidths,
  normalizeColumnWidths,
  parseColumnWidths,
  resizeColumnWidths,
} from '../../core/model';
import { dateKey, parseDateKey } from '../../core/daily';
import type { MenuItem } from './SuggestionMenu';
import { renderSuggestion } from './SuggestionMenu';
import { dateLocale, t } from '../i18n';
import { MAX_PAGE_COLUMNS } from '../../core/model';
import { toast } from '../ui';
import { revealAncestorsForPosition } from './CollapsibleHeading';
import {
  closeColumnResizeHistory,
  createColumnWidthsTransaction,
  shouldCommitColumnWidthResize,
} from './columnResize';
import {
  canApplyBlockDrop,
  closestBlockDropSide,
  createColumnRemovalTransaction,
  emptyColumnAtBackspaceBoundary,
  findColumnTarget,
} from './columnActions';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    columns: {
      setColumns: (count: number) => ReturnType;
      addColumn: (side?: 'left' | 'right') => ReturnType;
      splitIntoColumns: (count?: number) => ReturnType;
      resetColumnWidths: () => ReturnType;
    };
  }
}

const COLUMN_GAP = 28;
const COLUMNS_CUSTOM_DROP_CLASS = 'columns-block-drop-active';
const columnsDropCursorOwners = new WeakMap<HTMLElement, number>();

function retainColumnsDropCursorHost(host: HTMLElement): void {
  const owners = columnsDropCursorOwners.get(host) ?? 0;
  columnsDropCursorOwners.set(host, owners + 1);
  host.classList.add(COLUMNS_CUSTOM_DROP_CLASS);
}

function releaseColumnsDropCursorHost(host: HTMLElement): void {
  const owners = columnsDropCursorOwners.get(host) ?? 0;
  if (owners <= 1) {
    columnsDropCursorOwners.delete(host);
    host.classList.remove(COLUMNS_CUSTOM_DROP_CLASS);
  } else {
    columnsDropCursorOwners.set(host, owners - 1);
  }
}

function minColumnWidthFor(count: number): number {
  if (count >= 6) return 50;
  if (count >= 4) return 80;
  return 120;
}

function columnTrackTemplate(widths: number[]): string {
  const minWidth = minColumnWidthFor(widths.length);
  return widths.map((width) => `minmax(${minWidth}px, ${width}fr)`).join(' ');
}

// side by side blocks, each column holds any blocks
interface DraggingView {
  dragging?: { slice?: Slice; move?: boolean } | null;
}

function clearDragging(view: unknown): void {
  (view as DraggingView).dragging = null;
}

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
        rendered: false,
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-columns]',
        getAttrs: (element) => {
          const html = element as HTMLElement;
          const count = Array.from(html.children).filter((child) => child.matches('[data-column]')).length;
          return { widths: parseColumnWidths(html.getAttribute('data-widths'), count) };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const widths = normalizeColumnWidths(node.attrs.widths, node.childCount);
    const encoded = formatColumnWidths(node.attrs.widths, node.childCount);
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-columns': '',
        ...(encoded ? { 'data-widths': encoded } : {}),
        class: 'columns',
        style: `--columns: ${node.childCount}; --column-widths: ${columnTrackTemplate(widths)}`,
      }),
      0,
    ];
  },

  addNodeView() {
    return ({ node, view, getPos }) => {
      let currentNode = node;
      let previewWidths: number[] | null = null;
      const dom = document.createElement('div');
      dom.className = 'columns-editor';
      const contentDOM = document.createElement('div');
      contentDOM.className = 'columns';
      contentDOM.setAttribute('data-columns', '');
      dom.append(contentDOM);
      const handles: HTMLDivElement[] = [];
      const cleanupFns: Array<() => void> = [];
      const cancelActiveDrags: Array<() => void> = [];

      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'columns-reset';
      reset.setAttribute('aria-label', t('editor.resetColumnWidths'));
      reset.title = t('editor.resetColumnWidths');
      const resetIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      resetIcon.setAttribute('viewBox', '0 0 24 24');
      resetIcon.setAttribute('width', '14');
      resetIcon.setAttribute('height', '14');
      resetIcon.setAttribute('fill', 'none');
      resetIcon.setAttribute('stroke', 'currentColor');
      resetIcon.setAttribute('stroke-width', '2');
      resetIcon.setAttribute('stroke-linecap', 'round');
      resetIcon.setAttribute('stroke-linejoin', 'round');
      resetIcon.innerHTML = '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>';
      reset.append(resetIcon);
      reset.addEventListener('click', () => {
        if (!view.editable) return;
        commitWidths(normalizeColumnWidths(null, currentNode.childCount));
      });
      dom.append(reset);

      const commitWidths = (widths: number[]) => {
        if (!view.editable) return;
        const position = getPos();
        if (typeof position !== 'number') return;
        const normalized = normalizeColumnWidths(widths, currentNode.childCount);
        const before = normalizeColumnWidths(currentNode.attrs.widths, currentNode.childCount);
        if (!shouldCommitColumnWidthResize(view.editable, before, normalized)) return;
        previewWidths = null;
        view.dispatch(createColumnWidthsTransaction(view.state.tr, position, currentNode, normalized));
        view.dispatch(closeColumnResizeHistory(view.state.tr));
      };

      const makeHandle = (index: number) => {
        const handle = document.createElement('div');
        handle.className = 'column-resize-handle';
        handle.setAttribute('role', 'separator');
        handle.setAttribute('aria-orientation', 'vertical');
        handle.contentEditable = 'false';
        handle.tabIndex = 0;
        let drag: {
          pointerId: number;
          startX: number;
          startWidths: number[];
          availableWidth: number;
          minimumShare: number;
        } | null = null;

        const minimumShare = (widths: number[], availableWidth: number) =>
          Math.min(
            (widths[index]! + widths[index + 1]!) / 2,
            (minColumnWidthFor(currentNode.childCount) / Math.max(1, availableWidth)) * 100,
          );
        let isDragging = false;
        const removeWindowListeners = () => {
          if (!isDragging) return;
          isDragging = false;
          window.removeEventListener('pointermove', moveDrag, true);
          window.removeEventListener('pointerup', endDrag, true);
          window.removeEventListener('pointercancel', cancelDrag, true);
          window.removeEventListener('mouseup', endDrag as EventListener, true);
        };

        const releasePointerCapture = (pointerId: number) => {
          try {
            if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
          } catch {
            // pointer capture may not be supported by synthetic pointer devices
          }
        };

        const startDrag = (event: PointerEvent) => {
          if (!view.editable || event.button !== 0) return;
          event.preventDefault();
          handle.focus({ preventScroll: true });
          const widths = normalizeColumnWidths(currentNode.attrs.widths, currentNode.childCount);
          const availableWidth = Math.max(
            1,
            contentDOM.getBoundingClientRect().width - COLUMN_GAP * (currentNode.childCount - 1),
          );
          drag = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startWidths: widths,
            availableWidth,
            minimumShare: minimumShare(widths, availableWidth),
          };
          isDragging = true;
          window.addEventListener('pointermove', moveDrag, true);
          window.addEventListener('pointerup', endDrag, true);
          window.addEventListener('pointercancel', cancelDrag, true);
          window.addEventListener('mouseup', endDrag as EventListener, true);
          try {
            handle.setPointerCapture(event.pointerId);
          } catch {
            // some synthetic pointer devices cannot capture; window listeners will handle movement
          }
        };
        const moveDrag = (event: PointerEvent) => {
          if (!drag || drag.pointerId !== event.pointerId) return;
          const delta = ((event.clientX - drag.startX) / drag.availableWidth) * 100;
          previewWidths = resizeColumnWidths(
            drag.startWidths,
            currentNode.childCount,
            index,
            delta,
            drag.minimumShare,
          );
          paint();
        };
        const endDrag = (event: Event) => {
          if (!drag) return;
          if (event instanceof PointerEvent && drag.pointerId !== event.pointerId) return;
          if (!view.editable) {
            cancelDrag(event);
            return;
          }
          const startWidths = drag.startWidths;
          const widths = previewWidths;
          const pointerId = drag.pointerId;
          removeWindowListeners();
          releasePointerCapture(pointerId);
          drag = null;
          previewWidths = null;
          if (shouldCommitColumnWidthResize(view.editable, startWidths, widths)) commitWidths(widths);
          else paint();
        };
        const cancelDrag = (event: Event) => {
          if (!drag) return;
          if (event instanceof PointerEvent && drag.pointerId !== event.pointerId) return;
          const pointerId = drag.pointerId;
          removeWindowListeners();
          releasePointerCapture(pointerId);
          drag = null;
          previewWidths = null;
          paint();
        };
        cancelActiveDrags.push(() => cancelDrag(new Event('cancel')));
        cleanupFns.push(() => {
          if (drag) cancelDrag(new Event('destroy'));
          else removeWindowListeners();
        });
        handle.addEventListener('pointerdown', startDrag);
        handle.addEventListener('pointermove', moveDrag);
        handle.addEventListener('pointerup', endDrag);
        handle.addEventListener('pointercancel', cancelDrag);
        handle.addEventListener('keydown', (event) => {
          if (event.key === 'Escape' && drag) {
            event.preventDefault();
            event.stopPropagation();
            cancelDrag(event);
            return;
          }
          if (!view.editable) return;
          const widths = normalizeColumnWidths(currentNode.attrs.widths, currentNode.childCount);
          const availableWidth = Math.max(
            1,
            contentDOM.getBoundingClientRect().width - COLUMN_GAP * (currentNode.childCount - 1),
          );
          const minShare = minimumShare(widths, availableWidth);
          if (event.key === 'Home') {
            event.preventDefault();
            commitWidths(resizeColumnWidths(widths, currentNode.childCount, index, -100, minShare));
          } else if (event.key === 'End') {
            event.preventDefault();
            commitWidths(resizeColumnWidths(widths, currentNode.childCount, index, 100, minShare));
          } else if (['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp'].includes(event.key)) {
            event.preventDefault();
            const delta = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 2 : -2;
            commitWidths(resizeColumnWidths(widths, currentNode.childCount, index, delta, minShare));
          } else if (event.key.toLowerCase() === 'r' && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            commitWidths(normalizeColumnWidths(null, currentNode.childCount));
          }
        });
        handle.dataset.separator = String(index + 1);
        handle.dataset.columnPair = `${index + 1}-${index + 2}`;
        return handle;
      };

      const initialCount = node.childCount;
      for (let index = 0; index < initialCount - 1; index++) handles.push(makeHandle(index));
      dom.append(...handles);

      const paint = () => {
        const count = currentNode.childCount;
        const widths = previewWidths ?? normalizeColumnWidths(currentNode.attrs.widths, count);
        contentDOM.style.setProperty('--columns', String(count));
        contentDOM.style.setProperty('--column-widths', columnTrackTemplate(widths));
        const editable = view.editable;
        const hasCustomWidths = !!formatColumnWidths(currentNode.attrs.widths, count);
        reset.hidden = !editable || !hasCustomWidths;
        for (let index = 0; index < handles.length; index++) {
          const handle = handles[index]!;
          const leftShare = widths.slice(0, index + 1).reduce((sum, width) => sum + width, 0);
          const pairShare = widths[index]! + widths[index + 1]!;
          const contentWidth = Math.max(1, contentDOM.getBoundingClientRect().width);
          const availableWidth = Math.max(
            1,
            contentWidth - COLUMN_GAP * (count - 1),
          );
          const minShare = Math.min(pairShare / 2, (minColumnWidthFor(count) / availableWidth) * 100);
          const boundary = (leftShare / 100) * availableWidth + COLUMN_GAP * (index + 1);
          handle.style.left = `${(boundary / contentWidth) * 100}%`;
          handle.hidden = !editable;
          handle.setAttribute(
            'aria-label',
            t('editor.resizeColumnPair', { left: index + 1, right: index + 2 }),
          );
          handle.setAttribute('aria-valuemin', String(Number(minShare.toFixed(1))));
          handle.setAttribute('aria-valuemax', String(Number((pairShare - minShare).toFixed(1))));
          handle.setAttribute('aria-valuenow', String(Number(widths[index]!.toFixed(1))));
          handle.setAttribute(
            'aria-valuetext',
            t('editor.columnWidthValue', { value: Math.round(widths[index]!) }),
          );
        }
      };
      paint();
      // Node views are painted before insertion. Measure again after layout or the handle can land far offscreen.
      const frame = requestAnimationFrame(paint);
      const observer = new ResizeObserver(paint);
      observer.observe(contentDOM);
      const editabilityObserver = new MutationObserver(() => {
        if (!view.editable) cancelActiveDrags.forEach((cancel) => cancel());
        paint();
      });
      editabilityObserver.observe(view.dom, {
        attributes: true,
        attributeFilter: ['contenteditable'],
        subtree: true,
      });

      return {
        dom,
        contentDOM,
        update(updated) {
          if (updated.type !== currentNode.type || updated.childCount !== handles.length + 1) return false;
          if (updated !== currentNode) cancelActiveDrags.forEach((cancel) => cancel());
          currentNode = updated;
          previewWidths = null;
          paint();
          return true;
        },
        stopEvent: (event) =>
          dom !== event.target && !(event.target instanceof Element && contentDOM.contains(event.target)),
        ignoreMutation: (mutation) => {
          if (mutation.type === 'selection') return false;
          if (
            mutation.type === 'attributes' &&
            mutation.target === contentDOM &&
            mutation.attributeName === 'style'
          )
            return true;
          return !contentDOM.contains(mutation.target as HTMLElement);
        },
        destroy() {
          cancelAnimationFrame(frame);
          observer.disconnect();
          editabilityObserver.disconnect();
          cleanupFns.forEach((fn) => fn());
          cancelActiveDrags.length = 0;
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
          const target = Math.min(MAX_PAGE_COLUMNS, Math.max(2, count));
          const start = state.selection.from;
          return (
            chain()
              .insertContent({
                type: 'columns',
                content: Array.from({ length: target }, () => ({
                  type: 'column',
                  content: [{ type: 'paragraph' }],
                })),
              })
              // typing carries on in the first column
              .command(({ tr }) => {
                let targetPos: number | null = null;
                tr.doc.nodesBetween(Math.max(0, start - 2), tr.doc.content.size, (node, pos) => {
                  if (targetPos !== null) return false;
                  if (node.type.name === 'column') {
                    targetPos = pos + 2;
                    return false;
                  }
                  return true;
                });
                if (targetPos !== null) tr.setSelection(TextSelection.near(tr.doc.resolve(targetPos)));
                return true;
              })
              .run()
          );
        },

      addColumn:
        (side = 'right') =>
        ({ state, dispatch }) => {
          const { $from } = state.selection;
          let columnsPos = -1;
          let columnsNode: ProsemirrorNode | null = null;
          for (let d = $from.depth; d > 0; d--) {
            if ($from.node(d).type.name === 'columns') {
              columnsPos = $from.before(d);
              columnsNode = $from.node(d);
              break;
            }
          }
          if (!columnsNode && state.selection instanceof NodeSelection && state.selection.node.type.name === 'columns') {
            columnsPos = state.selection.from;
            columnsNode = state.selection.node;
          }
          if (!columnsNode || columnsPos === -1) return false;
          if (columnsNode.childCount >= MAX_PAGE_COLUMNS) {
            toast(t('editor.maxColumnsReached', { max: MAX_PAGE_COLUMNS }), { tone: 'error' });
            return false;
          }
          if (dispatch) {
            const newCol = state.schema.nodes.column!.create(null, [state.schema.nodes.paragraph!.create()]);
            const insertIndex = side === 'left' ? 0 : columnsNode.childCount;
            let offset = 0;
            for (let i = 0; i < insertIndex; i++) {
              offset += columnsNode.child(i).nodeSize;
            }
            const tr = state.tr.insert(columnsPos + 1 + offset, newCol);
            tr.setNodeMarkup(columnsPos, undefined, {
              ...columnsNode.attrs,
              widths: null,
            });
            dispatch(tr);
          }
          return true;
        },

      splitIntoColumns:
        (count = 2) =>
        ({ state, dispatch }) => {
          const target = Math.min(MAX_PAGE_COLUMNS, Math.max(2, count));
          const { $from } = state.selection;
          const block =
            state.selection instanceof NodeSelection
              ? state.selection.node
              : $from.depth >= 1
                ? $from.node(1)
                : $from.nodeAfter;
          const blockPos =
            state.selection instanceof NodeSelection
              ? state.selection.from
              : $from.depth >= 1
                ? $from.before(1)
                : $from.pos;
          if (!block || block.type.name === 'columns') return false;
          if (dispatch) {
            const col1 = state.schema.nodes.column!.create(null, [block]);
            const otherCols = Array.from({ length: target - 1 }, () =>
              state.schema.nodes.column!.create(null, [state.schema.nodes.paragraph!.create()]),
            );
            const columnsNode = state.schema.nodes.columns!.create(null, [col1, ...otherCols]);
            const tr = state.tr.replaceWith(blockPos, blockPos + block.nodeSize, columnsNode);
            dispatch(tr);
          }
          return true;
        },

      resetColumnWidths:
        () =>
        ({ state, dispatch }) => {
          const { $from } = state.selection;
          for (let d = $from.depth; d > 0; d--) {
            if ($from.node(d).type.name === 'columns') {
              const pos = $from.before(d);
              const node = $from.node(d);
              if (dispatch) {
                dispatch(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, widths: null }));
              }
              return true;
            }
          }
          if (state.selection instanceof NodeSelection && state.selection.node.type.name === 'columns') {
            if (dispatch) {
              dispatch(state.tr.setNodeMarkup(state.selection.from, undefined, { ...state.selection.node.attrs, widths: null }));
            }
            return true;
          }
          return false;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      Backspace: ({ editor }) => {
        const { state, view } = editor;
        if (!editor.isEditable) return false;
        const target = emptyColumnAtBackspaceBoundary(state.doc, state.selection);
        if (!target) return false;
        const transaction = createColumnRemovalTransaction(state, target, 'preserve');
        if (!transaction) return false;
        view.dispatch(transaction.scrollIntoView());
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    let indicator: HTMLDivElement | null = null;
    let dropCursorHost: HTMLElement | null = null;
    let dropCursorCleanup: number | null = null;
    const setDropCursorSuppressed = (view: EditorView, active: boolean) => {
      if (dropCursorCleanup !== null) {
        window.clearTimeout(dropCursorCleanup);
        dropCursorCleanup = null;
      }
      if (!active) {
        if (dropCursorHost) releaseColumnsDropCursorHost(dropCursorHost);
        dropCursorHost = null;
        return;
      }
      const offsetParent = view.dom.offsetParent;
      const host = offsetParent instanceof HTMLElement ? offsetParent : view.dom.parentElement;
      if (dropCursorHost && dropCursorHost !== host) {
        releaseColumnsDropCursorHost(dropCursorHost);
        dropCursorHost = null;
      }
      if (host && dropCursorHost !== host) {
        retainColumnsDropCursorHost(host);
        dropCursorHost = host;
      }
    };
    const releaseDropCursorAfterDefaultCleanup = (view: EditorView) => {
      if (dropCursorCleanup !== null) window.clearTimeout(dropCursorCleanup);
      // ProseMirror's default dropcursor schedules its DOM removal 20ms after drop/dragend.
      dropCursorCleanup = window.setTimeout(() => {
        dropCursorCleanup = null;
        setDropCursorSuppressed(view, false);
      }, 25);
    };
    const getIndicator = () => {
      if (!indicator && typeof document !== 'undefined') {
        indicator = document.createElement('div');
        indicator.className = 'column-drop-indicator';
        indicator.style.display = 'none';
        document.body.appendChild(indicator);
      }
      return indicator;
    };
    const hideIndicator = () => {
      if (indicator) indicator.style.display = 'none';
    };

    type ActiveDrop =
      | {
          kind: 'columns';
          pos: number;
          node: ProsemirrorNode;
          columnIndex: number;
          side: 'left' | 'right';
          disabled: boolean;
        }
      | { kind: 'sibling'; pos: number; node: ProsemirrorNode; side: 'top' | 'bottom' }
      | { kind: 'wrap'; pos: number; node: ProsemirrorNode; side: 'left' | 'right' };

    let activeDrop: ActiveDrop | null = null;

    const dropTarget = (view: EditorView, event: DragEvent): ActiveDrop | null => {
      const transferTypes = Array.from(event.dataTransfer?.types ?? []);
      if (
        transferTypes.includes('Files') ||
        transferTypes.some((type) => type.startsWith('application/x-morrow-'))
      )
        return null;
      const target = event.target instanceof Element ? event.target : null;
      if (
        !target ||
        target.closest('.linked-database-view, .inline-database, .database, table, [role="grid"]')
      )
        return null;
      const nestedEditor = target.closest('.ProseMirror');
      if (nestedEditor && nestedEditor !== view.dom) return null;

      const columnElement = target.closest<HTMLElement>('.column');
      const groupElement = target.closest<HTMLElement>('.columns-editor');
      const anchor = columnElement ?? groupElement ?? target.closest<HTMLElement>('.editor-surface .prose > *');
      if (!anchor) return null;
      const point = view.posAtCoords({ left: event.clientX, top: event.clientY });
      if (!point) return null;

      let $pos;
      try {
        $pos = view.state.doc.resolve(point.pos);
      } catch {
        return null;
      }
      const rect = anchor.getBoundingClientRect();
      const side = closestBlockDropSide(rect, event.clientX, event.clientY);
      let columnsDepth = 0;
      let columnDepth = 0;
      for (let depth = $pos.depth; depth > 0; depth--) {
        if (!columnDepth && $pos.node(depth).type.name === 'column') columnDepth = depth;
        if ($pos.node(depth).type.name === 'columns') {
          columnsDepth = depth;
          break;
        }
      }

      if ((side === 'left' || side === 'right') && (columnElement || groupElement)) {
        if (!columnsDepth) return null;
        const columns = $pos.node(columnsDepth);
        const columnIndex = columnElement && columnDepth === columnsDepth + 1
          ? $pos.index(columnsDepth)
          : side === 'left'
            ? 0
            : columns.childCount - 1;
        return {
          kind: 'columns',
          pos: $pos.before(columnsDepth),
          node: columns,
          columnIndex,
          side,
          disabled: columns.childCount >= MAX_PAGE_COLUMNS,
        };
      }

      if (side === 'top' || side === 'bottom') {
        if (columnElement) {
          for (let depth = $pos.depth; depth > 0; depth--) {
            if ($pos.node(depth - 1).type.name !== 'column') continue;
            return {
              kind: 'sibling',
              pos: $pos.before(depth),
              node: $pos.node(depth),
              side,
            };
          }
          return null;
        }
        if (groupElement && columnsDepth) {
          return { kind: 'sibling', pos: $pos.before(columnsDepth), node: $pos.node(columnsDepth), side };
        }
        if ($pos.depth === 0) return null;
        return { kind: 'sibling', pos: $pos.before(1), node: $pos.node(1), side };
      }

      if ($pos.depth === 0) return null;
      if (columnsDepth) {
        const columns = $pos.node(columnsDepth);
        return {
          kind: 'columns',
          pos: $pos.before(columnsDepth),
          node: columns,
          columnIndex: side === 'left' ? 0 : columns.childCount - 1,
          side,
          disabled: columns.childCount >= MAX_PAGE_COLUMNS,
        };
      }
      return { kind: 'wrap', pos: $pos.before(1), node: $pos.node(1), side };
    };

    const showIndicator = (side: 'top' | 'bottom' | 'left' | 'right', rect: DOMRect): void => {
      const ind = getIndicator();
      if (!ind) return;
      ind.style.display = 'block';
      if (side === 'top' || side === 'bottom') {
        ind.style.left = `${rect.left}px`;
        ind.style.top = `${(side === 'top' ? rect.top : rect.bottom) - 2}px`;
        ind.style.width = `${rect.width}px`;
        ind.style.height = '4px';
      } else {
        ind.style.left = `${(side === 'left' ? rect.left : rect.right) - 2}px`;
        ind.style.top = `${rect.top}px`;
        ind.style.width = '4px';
        ind.style.height = `${rect.height}px`;
      }
    };

    return [
      new Plugin({
        key: new PluginKey('columnsDropAndCleanup'),
        view(view) {
          const onDocumentDragEnd = () => {
            hideIndicator();
            activeDrop = null;
            releaseDropCursorAfterDefaultCleanup(view);
          };
          document.addEventListener('dragend', onDocumentDragEnd, true);
          return {
            update(currentView) {
              if (!currentView.editable && (activeDrop || dropCursorHost)) {
                hideIndicator();
                activeDrop = null;
                setDropCursorSuppressed(currentView, false);
              }
            },
            destroy() {
              document.removeEventListener('dragend', onDocumentDragEnd, true);
              indicator?.remove();
              indicator = null;
              activeDrop = null;
              if (dropCursorCleanup !== null) {
                window.clearTimeout(dropCursorCleanup);
                dropCursorCleanup = null;
              }
              setDropCursorSuppressed(view, false);
            },
          };
        },
        appendTransaction(transactions, _oldState, newState) {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          let tr: Transaction | null = null;
          const targets: Array<{ pos: number; node: ProsemirrorNode }> = [];
          newState.doc.descendants((node, pos) => {
            if (node.type.name === 'columns') {
              targets.push({ pos, node });
            }
          });

          for (let i = targets.length - 1; i >= 0; i--) {
            const { pos, node } = targets[i]!;
            const validCols: ProsemirrorNode[] = [];
            node.forEach((col: ProsemirrorNode) => {
              if (col.childCount > 0) validCols.push(col);
            });

            if (validCols.length === 0) {
              if (!tr) tr = newState.tr;
              tr.delete(pos, pos + node.nodeSize);
            } else if (validCols.length === 1) {
              if (!tr) tr = newState.tr;
              const colContent: ProsemirrorNode[] = [];
              validCols[0]!.forEach((child: ProsemirrorNode) => colContent.push(child));
              tr.replaceWith(pos, pos + node.nodeSize, colContent);
            } else if (validCols.length < node.childCount) {
              if (!tr) tr = newState.tr;
              const normalized = normalizeColumnWidths(node.attrs.widths, validCols.length);
              const newColumns = newState.schema.nodes.columns!.create(
                { ...node.attrs, widths: formatColumnWidths(normalized, validCols.length) ? normalized : null },
                validCols,
              );
              tr.replaceWith(pos, pos + node.nodeSize, newColumns);
            }
          }
          return tr;
        },

        props: {
          handleKeyDown(view, event) {
            if (event.key !== 'Escape' || !activeDrop) return false;
            hideIndicator();
            activeDrop = null;
            setDropCursorSuppressed(view, false);
            return false;
          },
          handleDOMEvents: {
            dragover(view, event) {
              const drag = (view as unknown as DraggingView).dragging;
              const transferTypes = Array.from((event as DragEvent).dataTransfer?.types ?? []);
              if (
                !view.editable ||
                !(view.state.selection instanceof NodeSelection) ||
                !drag?.slice?.content?.childCount ||
                transferTypes.includes('Files')
              ) {
                hideIndicator();
                activeDrop = null;
                setDropCursorSuppressed(view, false);
                return false;
              }
              const target = dropTarget(view, event as DragEvent);
              if (!target) {
                hideIndicator();
                activeDrop = null;
                setDropCursorSuppressed(view, false);
                return false;
              }
              activeDrop = target;
              setDropCursorSuppressed(view, true);
              if (target.kind === 'columns' && target.disabled) {
                if ((event as DragEvent).dataTransfer) (event as DragEvent).dataTransfer!.dropEffect = 'none';
                hideIndicator();
              } else {
                let anchor: HTMLElement | null = null;
                if (target.kind === 'columns') {
                  const group = view.nodeDOM(target.pos);
                  if (group instanceof HTMLElement) {
                    const columns = group.querySelector<HTMLElement>(':scope > .columns');
                    const column = columns?.children[target.columnIndex];
                    anchor = column instanceof HTMLElement ? column : group;
                  }
                } else {
                  const targetDOM = view.nodeDOM(target.pos);
                  if (targetDOM instanceof HTMLElement) anchor = targetDOM;
                }
                if (!anchor) {
                  hideIndicator();
                  activeDrop = null;
                  setDropCursorSuppressed(view, false);
                  return false;
                }
                showIndicator(target.side, anchor.getBoundingClientRect());
                if ((event as DragEvent).dataTransfer) (event as DragEvent).dataTransfer!.dropEffect = 'move';
              }
              event.preventDefault();
              return true;
            },
            dragleave(view, event) {
              // keep the marker while the pointer crosses children inside the editor
              const relatedTarget = (event as DragEvent).relatedTarget;
              if (relatedTarget instanceof Element && view.dom.contains(relatedTarget)) return false;
              hideIndicator();
              activeDrop = null;
              setDropCursorSuppressed(view, false);
              return false;
            },
            drop(view, event) {
              hideIndicator();
              if (!activeDrop) {
                setDropCursorSuppressed(view, false);
                return false;
              }
              const dropInfo = activeDrop;
              activeDrop = null;
              releaseDropCursorAfterDefaultCleanup(view);
              const dragging = (view as unknown as DraggingView).dragging;
              const cancelDrop = () => {
                event.preventDefault();
                clearDragging(view);
                return true;
              };
              if (!canApplyBlockDrop(view.editable, view.state.doc, dropInfo.pos, dropInfo.node))
                return cancelDrop();
              if (dropInfo.kind === 'columns' && dropInfo.disabled) {
                toast(t('editor.maxColumnsReached', { max: MAX_PAGE_COLUMNS }), { tone: 'error' });
                return cancelDrop();
              }
              if (
                !view.editable ||
                !(view.state.selection instanceof NodeSelection) ||
                !dragging?.slice?.content?.childCount
              )
                return cancelDrop();
              const draggedNodes: ProsemirrorNode[] = [];
              const sel = view.state.selection;
              dragging.slice.content.forEach((node: ProsemirrorNode) => {
                if (node.type.name === 'column') node.forEach((child) => draggedNodes.push(child));
                else draggedNodes.push(node);
              });
              if (!draggedNodes.length) return cancelDrop();

              const hasSource = dragging.move === true && !sel.empty;
              const sourceFrom = sel.from;
              const sourceTo = sel.to;
              const tr = view.state.tr;
              if (hasSource && dropInfo.pos >= sourceFrom && dropInfo.pos < sourceTo) return cancelDrop();
              if (hasSource) tr.delete(sourceFrom, sourceTo);

              if (dropInfo.kind === 'columns') {
                const mappedColumnsPos = tr.mapping.map(dropInfo.pos);
                const currentColumns = tr.doc.nodeAt(mappedColumnsPos);
                if (!currentColumns || currentColumns.type !== view.state.schema.nodes.columns)
                  return cancelDrop();
                if (currentColumns.childCount >= MAX_PAGE_COLUMNS) {
                  toast(t('editor.maxColumnsReached', { max: MAX_PAGE_COLUMNS }), { tone: 'error' });
                  return cancelDrop();
                }
                let targetIndex = dropInfo.columnIndex;
                if (hasSource) {
                  const sourceNode = view.state.doc.nodeAt(sourceFrom);
                  const sourceColumn = findColumnTarget(view.state.doc, sourceFrom);
                  if (
                    sourceNode?.type.name === 'column' &&
                    sourceColumn?.columnsPosition === dropInfo.pos &&
                    sourceColumn.index < targetIndex
                  )
                    targetIndex -= 1;
                }
                targetIndex = Math.max(0, Math.min(targetIndex, currentColumns.childCount - 1));
                const insertIndex = targetIndex + (dropInfo.side === 'right' ? 1 : 0);
                let insertOffset = 0;
                for (let index = 0; index < insertIndex; index++) insertOffset += currentColumns.child(index).nodeSize;
                const newColumn = view.state.schema.nodes.column!.create(null, draggedNodes);
                const insertPosition = mappedColumnsPos + 1 + insertOffset;
                const insertion = Fragment.from(newColumn);
                const $insert = tr.doc.resolve(insertPosition);
                if (!$insert.parent.canReplace($insert.index(), $insert.index(), insertion)) return cancelDrop();
                tr.insert(insertPosition, insertion);
                tr.setNodeMarkup(mappedColumnsPos, undefined, { ...currentColumns.attrs, widths: null });
              } else {
                const targetPosition = tr.mapping.map(dropInfo.pos);
                const targetNode = tr.doc.nodeAt(targetPosition);
                if (!targetNode || !targetNode.eq(dropInfo.node)) return cancelDrop();
                if (dropInfo.kind === 'wrap') {
                  const newColumn = view.state.schema.nodes.column!.create(null, draggedNodes);
                  const targetColumn = view.state.schema.nodes.column!.create(null, [targetNode]);
                  const columns = view.state.schema.nodes.columns!.create(
                    null,
                    dropInfo.side === 'left' ? [newColumn, targetColumn] : [targetColumn, newColumn],
                  );
                  tr.replaceWith(targetPosition, targetPosition + targetNode.nodeSize, columns);
                } else {
                  const insertPosition = dropInfo.side === 'top' ? targetPosition : targetPosition + targetNode.nodeSize;
                  const $insert = tr.doc.resolve(insertPosition);
                  const insertion = Fragment.fromArray(draggedNodes);
                  if (!$insert.parent.canReplace($insert.index(), $insert.index(), insertion)) return cancelDrop();
                  tr.insert(insertPosition, insertion);
                }
              }

              view.dispatch(tr);
              clearDragging(view);
              event.preventDefault();
              return true;
            },
          },
        },
      }),
    ];
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
    if (node.type.name !== 'heading') return true;
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
            revealAncestorsForPosition(editor.view, target);
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
  findPages: (query: string) => Array<{ id: string; title: string; path: string }>;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function describeDate(key: string, today = new Date()): string {
  const date = parseDateKey(key);
  if (!date) return key;
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
    return { date: { default: null, parseHTML: (element) => element.getAttribute('datetime') } };
  },

  parseHTML() {
    return [{ tag: 'time[datetime]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'time',
      mergeAttributes(HTMLAttributes, { datetime: node.attrs.date, class: 'date-mention' }),
      describeDate(String(node.attrs.date)),
    ];
  },

  renderText({ node }) {
    return describeDate(String(node.attrs.date));
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
        dom.textContent = `@${describeDate(key)}`;
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
        if (date) this.options.openDate(date);
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
    return [
      Suggestion<MenuItem, MenuItem>({
        editor: this.editor,
        pluginKey: new PluginKey('dateMentionSuggestion'),
        char: '@',
        allowSpaces: true,
        allow: ({ state }) => state.selection.$from.parent.type.name !== 'codeBlock',
        items: ({ query }) => {
          if (query.length > 30) return [];
          const dates: MenuItem[] = dateSuggestions(query).map((date) => ({
            id: `date:${dateKey(date)}`,
            title: describeDate(dateKey(date)),
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
        },
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
  const node = item.id.startsWith('date:')
    ? { type: 'dateMention', attrs: { date: item.id.slice(5) } }
    : { type: 'pageLink', attrs: { id: item.id.slice(5), label: item.title } };
  editor
    .chain()
    .focus()
    .insertContentAt(range, [node, { type: 'text', text: ' ' }])
    .run();
}
