import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { TextSelection, type EditorState, type Selection, type Transaction } from '@tiptap/pm/state';
import { formatColumnWidths, normalizeColumnWidths } from '../../core/model';

export interface ColumnTarget {
  readonly columnsPosition: number;
  readonly index: number;
  readonly columns: ProseMirrorNode;
  readonly column: ProseMirrorNode;
}

export type ColumnRemovalMode = 'preserve' | 'discard';
export type BlockDropSide = 'top' | 'bottom' | 'left' | 'right';

function columnTargetAtGroup(
  doc: ProseMirrorNode,
  columnsPosition: number,
  index: number,
): ColumnTarget | null {
  const columns = doc.nodeAt(columnsPosition);
  if (
    !columns ||
    columns.type.name !== 'columns' ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= columns.childCount
  )
    return null;
  return { columnsPosition, index, columns, column: columns.child(index) };
}

export function findColumnTarget(doc: ProseMirrorNode, position: number, indexInGroup?: number): ColumnTarget | null {
  if (!Number.isInteger(position) || position < 0 || position > doc.content.size) return null;
  if (indexInGroup !== undefined) return columnTargetAtGroup(doc, position, indexInGroup);

  const selectedNode = doc.nodeAt(position);
  if (selectedNode?.type.name === 'column') {
    try {
      const $position = doc.resolve(position);
      const groupDepth = $position.depth;
      const group = $position.node(groupDepth);
      if (group.type.name === 'columns' && $position.nodeAfter === selectedNode)
        return columnTargetAtGroup(doc, $position.before(groupDepth), $position.index(groupDepth));
    } catch {
      return null;
    }
  }

  try {
    const $position = doc.resolve(position);
    for (let depth = $position.depth; depth > 0; depth--) {
      if ($position.node(depth).type.name !== 'column' || depth < 2) continue;
      const groupDepth = depth - 1;
      if ($position.node(groupDepth).type.name !== 'columns') continue;
      return columnTargetAtGroup(
        doc,
        $position.before(groupDepth),
        $position.index(groupDepth),
      );
    }
  } catch {
    return null;
  }
  return null;
}

export function isEmptyColumn(column: ProseMirrorNode): boolean {
  if (column.type.name !== 'column' || column.childCount !== 1) return false;
  const paragraph = column.firstChild;
  return Boolean(
    paragraph &&
      paragraph.type.name === 'paragraph' &&
      paragraph.content.size === 0 &&
      Object.values(column.attrs).every((value) => value === null || value === undefined) &&
      Object.values(paragraph.attrs).every((value) => value === null || value === undefined),
  );
}

export function emptyColumnAtBackspaceBoundary(
  doc: ProseMirrorNode,
  selection: Selection,
): ColumnTarget | null {
  if (
    !selection.empty ||
    selection.$from.parent.type.name !== 'paragraph' ||
    selection.$from.parentOffset !== 0
  )
    return null;
  const target = findColumnTarget(doc, selection.from);
  if (!target || !isEmptyColumn(target.column)) return null;
  return target.column.firstChild?.eq(selection.$from.parent) ? target : null;
}

function updatedColumns(target: ColumnTarget, remaining: ProseMirrorNode[]): ProseMirrorNode {
  const widths = normalizeColumnWidths(target.columns.attrs.widths, target.columns.childCount).filter(
    (_width, index) => index !== target.index,
  );
  const normalized = normalizeColumnWidths(widths, remaining.length);
  const encoded = formatColumnWidths(normalized, remaining.length);
  return target.columns.type.create(
    { ...target.columns.attrs, widths: encoded ? normalized : null },
    remaining,
  );
}

function paragraphSelection(transaction: Transaction, position: number): Transaction {
  const clamped = Math.max(0, Math.min(position, transaction.doc.content.size));
  return transaction.setSelection(TextSelection.near(transaction.doc.resolve(clamped), 1));
}

export function createColumnRemovalTransaction(
  state: EditorState,
  target: ColumnTarget,
  mode: ColumnRemovalMode,
): Transaction | null {
  const current = columnTargetAtGroup(state.doc, target.columnsPosition, target.index);
  if (!current || !current.columns.eq(target.columns) || !current.column.eq(target.column)) return null;

  const remaining = Array.from({ length: current.columns.childCount }, (_unused, index) => index)
    .filter((index) => index !== current.index)
    .map((index) => current.columns.child(index));
  if (remaining.length === 0) return null;

  const preserved: ProseMirrorNode[] = [];
  if (mode === 'preserve' && !isEmptyColumn(current.column))
    current.column.forEach((child) => preserved.push(child));

  let transaction: Transaction;
  if (remaining.length >= 2) {
    const nextColumns = updatedColumns(current, remaining);
    transaction = state.tr.replaceWith(
      current.columnsPosition,
      current.columnsPosition + current.columns.nodeSize,
      nextColumns,
    );
    if (preserved.length) transaction.insert(current.columnsPosition + nextColumns.nodeSize, Fragment.fromArray(preserved));
  } else {
    const flattened: ProseMirrorNode[] = [];
    remaining[0]!.forEach((child) => flattened.push(child));
    flattened.push(...preserved);
    transaction = state.tr.replaceWith(
      current.columnsPosition,
      current.columnsPosition + current.columns.nodeSize,
      Fragment.fromArray(flattened),
    );
  }

  return paragraphSelection(transaction, current.columnsPosition);
}

export function createParagraphBesideBlockTransaction(
  state: EditorState,
  position: number,
  side: 'before' | 'after',
): Transaction | null {
  const target = state.doc.nodeAt(position);
  const paragraph = state.schema.nodes.paragraph?.createAndFill();
  if (!target || !paragraph) return null;

  const $position = state.doc.resolve(position);
  const index = $position.index();
  const insertIndex = side === 'before' ? index : index + 1;
  if (!$position.parent.canReplace(insertIndex, insertIndex, Fragment.from(paragraph))) return null;

  const insertPosition = side === 'before' ? position : position + target.nodeSize;
  const selectionPosition = insertPosition + 1;
  const transaction = state.tr.insert(insertPosition, paragraph);
  return transaction.setSelection(TextSelection.create(transaction.doc, selectionPosition)).scrollIntoView();
}

export function closestBlockDropSide(
  rect: { left: number; right: number; top: number; bottom: number },
  x: number,
  y: number,
): BlockDropSide {
  const width = Math.max(1, rect.right - rect.left);
  const height = Math.max(1, rect.bottom - rect.top);
  const horizontal = Math.max(0, Math.min(1, (x - rect.left) / width));
  const vertical = Math.max(0, Math.min(1, (y - rect.top) / height));
  const horizontalDistance = Math.min(horizontal, 1 - horizontal);
  const verticalDistance = Math.min(vertical, 1 - vertical);
  if (verticalDistance <= horizontalDistance) return vertical <= 0.5 ? 'top' : 'bottom';
  return horizontal <= 0.5 ? 'left' : 'right';
}

export function canApplyBlockDrop(
  editable: boolean,
  doc: ProseMirrorNode,
  position: number,
  expectedTarget: ProseMirrorNode,
): boolean {
  return editable && doc.nodeAt(position)?.eq(expectedTarget) === true;
}

