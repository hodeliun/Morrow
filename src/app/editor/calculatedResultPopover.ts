export interface ResultPopoverRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface ResultPopoverViewport {
  width: number;
  height: number;
}

export interface ResultPopoverPlacement {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

export function calculateResultPopoverPlacement(
  anchor: Pick<ResultPopoverRect, 'left' | 'top' | 'bottom'>,
  pane: Pick<ResultPopoverRect, 'left' | 'top' | 'right' | 'bottom'>,
  viewport: ResultPopoverViewport,
  popover: Pick<ResultPopoverRect, 'height'>,
  preferredWidth = 560,
  inset = 12,
  gap = 6,
): ResultPopoverPlacement | null {
  const bounds = {
    left: Math.max(0, pane.left),
    top: Math.max(0, pane.top),
    right: Math.min(viewport.width, pane.right),
    bottom: Math.min(viewport.height, pane.bottom),
  };
  const visibleWidth = bounds.right - bounds.left;
  const visibleHeight = bounds.bottom - bounds.top;
  if (!Number.isFinite(visibleWidth) || !Number.isFinite(visibleHeight) || visibleWidth <= 0 || visibleHeight <= 0) return null;

  const horizontalInset = Math.min(inset, visibleWidth / 2);
  const verticalInset = Math.min(inset, visibleHeight / 2);
  const innerLeft = bounds.left + horizontalInset;
  const innerRight = bounds.right - horizontalInset;
  const innerTop = bounds.top + verticalInset;
  const innerBottom = bounds.bottom - verticalInset;
  const width = Math.max(0, Math.min(preferredWidth, innerRight - innerLeft));
  const maxHeight = Math.max(0, innerBottom - innerTop);
  if (width <= 0 || maxHeight <= 0) return null;

  const height = Math.max(0, Math.min(popover.height, maxHeight));
  const maxLeft = Math.max(innerLeft, innerRight - width);
  const left = Math.min(Math.max(anchor.left, innerLeft), maxLeft);
  const minTop = innerTop;
  const maxTop = Math.max(minTop, innerBottom - height);
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - height;
  const top = below <= maxTop
    ? Math.max(minTop, below)
    : above >= minTop
      ? Math.min(maxTop, above)
      : Math.min(Math.max(below, minTop), maxTop);

  return { left, top, width, maxHeight };
}
