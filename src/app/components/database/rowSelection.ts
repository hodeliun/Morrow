import type { PageId } from '../../../core/model';

export function toggleVisibleRowSelection(
  selectedIds: readonly PageId[],
  rowId: PageId,
  checked: boolean,
  visibleRowIds: readonly PageId[],
): PageId[] {
  if (!visibleRowIds.includes(rowId)) return visibleRowIds.filter((id) => selectedIds.includes(id));

  const selected = new Set(selectedIds);
  if (checked) selected.add(rowId);
  else selected.delete(rowId);
  return visibleRowIds.filter((id) => selected.has(id));
}

export function selectionMatchesVisibleRows(
  menuRowIds: readonly PageId[],
  selectedVisibleRowIds: readonly PageId[],
  visibleRowIds: ReadonlySet<PageId>,
): boolean {
  return (
    menuRowIds.length === selectedVisibleRowIds.length &&
    menuRowIds.every((id) => visibleRowIds.has(id) && selectedVisibleRowIds.includes(id))
  );
}
