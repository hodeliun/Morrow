import { mergeAttributes, Node } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';
import type { Node as ProsemirrorNode, Slice } from '@tiptap/pm/model';
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
        previewWidths = null;
        const position = getPos();
        if (typeof position !== 'number') return;
        view.dispatch(
          view.state.tr.setNodeMarkup(position, undefined, { ...currentNode.attrs, widths: null }),
        );
      });
      dom.append(reset);

      const commitWidths = (widths: number[]) => {
        const position = getPos();
        if (typeof position !== 'number') return;
        const encoded = formatColumnWidths(widths, currentNode.childCount);
        const normalized = normalizeColumnWidths(widths, currentNode.childCount);
        previewWidths = null;
        view.dispatch(
          view.state.tr.setNodeMarkup(position, undefined, {
            ...currentNode.attrs,
            widths: encoded ? normalized : null,
          }),
        );
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
        cleanupFns.push(removeWindowListeners);

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
          removeWindowListeners();
          try {
            if (event instanceof PointerEvent) handle.releasePointerCapture(event.pointerId);
          } catch {
            // pointer capture may not be supported by synthetic devices
          }
          const widths = previewWidths ?? drag.startWidths;
          drag = null;
          commitWidths(widths);
        };
        const cancelDrag = (event: Event) => {
          if (!drag) return;
          if (event instanceof PointerEvent && drag.pointerId !== event.pointerId) return;
          removeWindowListeners();
          try {
            if (event instanceof PointerEvent) handle.releasePointerCapture(event.pointerId);
          } catch {
            // pointer capture may not be supported by synthetic devices
          }
          drag = null;
          previewWidths = null;
          paint();
        };
        handle.addEventListener('pointerdown', startDrag);
        handle.addEventListener('pointermove', moveDrag);
        handle.addEventListener('pointerup', endDrag);
        handle.addEventListener('pointercancel', cancelDrag);
        handle.addEventListener('keydown', (event) => {
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
            previewWidths = null;
            const position = getPos();
            if (typeof position === 'number')
              view.dispatch(
                view.state.tr.setNodeMarkup(position, undefined, { ...currentNode.attrs, widths: null }),
              );
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

      return {
        dom,
        contentDOM,
        update(updated) {
          if (updated.type !== currentNode.type || updated.childCount !== handles.length + 1) return false;
          currentNode = updated;
          previewWidths = null;
          paint();
          return true;
        },
        stopEvent: (event) =>
          dom !== event.target && !(event.target instanceof Element && contentDOM.contains(event.target)),
        ignoreMutation: (mutation) =>
          mutation.type === 'selection' ? false : !contentDOM.contains(mutation.target as HTMLElement),
        destroy() {
          cancelAnimationFrame(frame);
          observer.disconnect();
          cleanupFns.forEach((fn) => fn());
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

  addProseMirrorPlugins() {
    let indicator: HTMLDivElement | null = null;
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

    let activeDrop: { pos: number; side: 'left' | 'right'; inColumns: boolean; columnsPos: number; childCount: number } | null = null;

    return [
      new Plugin({
        key: new PluginKey('columnsDropAndCleanup'),
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
          handleDOMEvents: {
            dragover(view, event) {
              const el = (event.target as HTMLElement | null)?.closest?.('.column, .columns, .editor-surface .prose > *') as HTMLElement | null;
              if (!el) {
                hideIndicator();
                activeDrop = null;
                return false;
              }
              const rect = el.getBoundingClientRect();
              const relX = (event.clientX - rect.left) / Math.max(1, rect.width);
              if (relX < 0.2 || relX > 0.8) {
                const side = relX < 0.2 ? 'left' : 'right';
                const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? 0;
                const $pos = view.state.doc.resolve(pos);
                let inColumns = false;
                let columnsPos = -1;
                let childCount = 0;
                for (let d = $pos.depth; d > 0; d--) {
                  if ($pos.node(d).type.name === 'columns') {
                    inColumns = true;
                    columnsPos = $pos.before(d);
                    childCount = $pos.node(d).childCount;
                    break;
                  }
                }

                if (inColumns && childCount >= MAX_PAGE_COLUMNS) {
                  if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
                  hideIndicator();
                  activeDrop = { pos, side, inColumns, columnsPos, childCount };
                  return false;
                }

                const ind = getIndicator();
                if (ind) {
                  ind.style.display = 'block';
                  ind.style.top = `${rect.top}px`;
                  ind.style.height = `${rect.height}px`;
                  ind.style.left = `${side === 'left' ? rect.left : rect.right - 4}px`;
                }
                activeDrop = { pos, side, inColumns, columnsPos, childCount };
                event.preventDefault();
                return true;
              }
              hideIndicator();
              activeDrop = null;
              return false;
            },
            dragleave() {
              hideIndicator();
              activeDrop = null;
              return false;
            },
            drop(view, event) {
              hideIndicator();
              if (!activeDrop) return false;
              const dropInfo = activeDrop;
              activeDrop = null;

              if (dropInfo.inColumns && dropInfo.childCount >= MAX_PAGE_COLUMNS) {
                toast(t('editor.maxColumnsReached', { max: MAX_PAGE_COLUMNS }), { tone: 'error' });
                event.preventDefault();
                clearDragging(view);
                return true;
              }

              const draggedNodes: ProsemirrorNode[] = [];
              const dragging = (view as unknown as DraggingView).dragging;
              if (dragging?.slice?.content?.childCount) {
                dragging.slice.content.forEach((n: ProsemirrorNode) => {
                  if (n.type.name === 'column') {
                    n.forEach((c) => draggedNodes.push(c));
                  } else {
                    draggedNodes.push(n);
                  }
                });
              }
              const sel = view.state.selection;
              if (draggedNodes.length === 0 && sel instanceof NodeSelection) {
                if (sel.node.type.name === 'column') {
                  sel.node.forEach((c) => draggedNodes.push(c));
                } else {
                  draggedNodes.push(sel.node);
                }
              }
              if (draggedNodes.length === 0 && !sel.empty) {
                const slice = sel.content();
                slice.content.forEach((n) => {
                  if (n.type.name === 'column') {
                    n.forEach((c) => draggedNodes.push(c));
                  } else {
                    draggedNodes.push(n);
                  }
                });
              }
              if (draggedNodes.length === 0) {
                draggedNodes.push(view.state.schema.nodes.paragraph!.create());
              }

              const hasSource = !sel.empty;
              const sourceFrom = sel.from;
              const sourceTo = sel.to;

              if (hasSource && dropInfo.pos >= sourceFrom && dropInfo.pos <= sourceTo) {
                event.preventDefault();
                clearDragging(view);
                return true;
              }

              const tr = view.state.tr;
              const newCol = view.state.schema.nodes.column!.create(null, draggedNodes);

              if (dropInfo.inColumns) {
                if (hasSource) {
                  tr.delete(sourceFrom, sourceTo);
                }
                const mappedColumnsPos = tr.mapping.map(dropInfo.columnsPos);
                const currentColumns = tr.doc.nodeAt(mappedColumnsPos);
                if (!currentColumns || currentColumns.type.name !== 'columns') {
                  event.preventDefault();
                  clearDragging(view);
                  return true;
                }
                if (currentColumns.childCount >= MAX_PAGE_COLUMNS) {
                  toast(t('editor.maxColumnsReached', { max: MAX_PAGE_COLUMNS }), { tone: 'error' });
                  event.preventDefault();
                  clearDragging(view);
                  return true;
                }

                const mappedPos = tr.mapping.map(dropInfo.pos);
                const $mappedPos = tr.doc.resolve(Math.min(mappedPos, tr.doc.content.size));
                let insertOffset = 0;
                let foundCol = false;
                for (let d = $mappedPos.depth; d > 0; d--) {
                  if ($mappedPos.node(d).type.name === 'column' && $mappedPos.node(d - 1).type.name === 'columns') {
                    const colIndex = $mappedPos.index(d - 1);
                    const insertColIdx = dropInfo.side === 'left' ? colIndex : colIndex + 1;
                    for (let i = 0; i < insertColIdx && i < currentColumns.childCount; i++) {
                      insertOffset += currentColumns.child(i).nodeSize;
                    }
                    foundCol = true;
                    break;
                  }
                }
                if (!foundCol) {
                  insertOffset = dropInfo.side === 'left' ? 0 : currentColumns.content.size;
                }

                const insertPos = mappedColumnsPos + 1 + insertOffset;
                tr.insert(insertPos, newCol);
                const finalColumnsPos = tr.mapping.map(mappedColumnsPos);
                const finalColNode = tr.doc.nodeAt(finalColumnsPos);
                if (finalColNode && finalColNode.type.name === 'columns') {
                  tr.setNodeMarkup(finalColumnsPos, undefined, { ...finalColNode.attrs, widths: null });
                }
              } else {
                const $pos = view.state.doc.resolve(dropInfo.pos);
                if ($pos.depth < 1) {
                  event.preventDefault();
                  clearDragging(view);
                  return true;
                }
                const targetBlockPos = $pos.before(1);

                if (hasSource) {
                  tr.delete(sourceFrom, sourceTo);
                }
                const mappedTargetBlockPos = tr.mapping.map(targetBlockPos);
                const mappedTargetBlock = tr.doc.nodeAt(mappedTargetBlockPos);
                if (!mappedTargetBlock) {
                  event.preventDefault();
                  clearDragging(view);
                  return true;
                }

                const colTarget = view.state.schema.nodes.column!.create(null, [mappedTargetBlock]);
                const columnsNode = view.state.schema.nodes.columns!.create(
                  null,
                  dropInfo.side === 'left' ? [newCol, colTarget] : [colTarget, newCol],
                );
                tr.replaceWith(mappedTargetBlockPos, mappedTargetBlockPos + mappedTargetBlock.nodeSize, columnsNode);
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
export const TableOfContents = Node.create({
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

  addNodeView() {
    return ({ editor }) => {
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
          const item = document.createElement('button');
          item.type = 'button';
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
