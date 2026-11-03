export type GridFocusOwnership = Readonly<{ cellKey: string; owner: object }> | null;

export type GridFocusBlur = Readonly<{
  sourceCellKey: string | null;
  sourceOwner: object | null;
  relatedCellKey: string | null;
  relatedOwner: object | null;
  relatedTargetIsBodyOrNull: boolean;
  sourceCellRemoved: boolean;
}>;

export function focusGridTarget(cellKey: string | null, owner: object | null): GridFocusOwnership {
  return cellKey === null || owner === null ? null : { cellKey, owner };
}

export function blurGridTarget(
  current: GridFocusOwnership,
  blur: GridFocusBlur,
): GridFocusOwnership {
  if (blur.relatedCellKey !== null) {
    if (blur.relatedOwner === null || blur.relatedOwner !== current?.owner) return null;
    return { cellKey: blur.relatedCellKey, owner: blur.relatedOwner };
  }
  if (
    blur.sourceCellRemoved &&
    blur.sourceCellKey !== null &&
    blur.relatedTargetIsBodyOrNull &&
    current?.cellKey === blur.sourceCellKey &&
    current.owner === blur.sourceOwner
  ) {
    return current;
  }
  return null;
}

export function takeGridFocusOwnership(current: GridFocusOwnership): {
  wasOwned: boolean;
  next: GridFocusOwnership;
} {
  return { wasOwned: current !== null, next: null };
}
