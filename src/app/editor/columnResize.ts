import { closeHistory } from '@tiptap/pm/history';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { formatColumnWidths, normalizeColumnWidths } from '../../core/model';

export function shouldCommitColumnWidthResize(
  editable: boolean,
  before: readonly number[],
  after: readonly number[] | null,
): after is readonly number[] {
  return (
    editable &&
    after !== null &&
    before.length === after.length &&
    before.length > 0 &&
    before.every((width, index) => Number.isFinite(width) && Number.isFinite(after[index])) &&
    before.some((width, index) => width !== after[index])
  );
}

export function createColumnWidthsTransaction(
  transaction: Transaction,
  position: number,
  node: ProseMirrorNode,
  widths: readonly number[],
): Transaction {
  const normalized = normalizeColumnWidths([...widths], node.childCount);
  const encoded = formatColumnWidths(normalized, node.childCount);
  return closeHistory(transaction).setNodeMarkup(position, undefined, {
    ...node.attrs,
    widths: encoded ? normalized : null,
  });
}

export function closeColumnResizeHistory(transaction: Transaction): Transaction {
  return closeHistory(transaction).setMeta('addToHistory', false);
}
