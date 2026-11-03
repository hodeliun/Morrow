export interface ViewportPosition {
  left: number;
  top: number;
}

export interface PositioningContainingBlock {
  left: number;
  top: number;
  clientLeft: number;
  clientTop: number;
  scrollLeft: number;
  scrollTop: number;
}

export interface VisibleClipBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PositioningRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface OverflowClipAncestor {
  left: number;
  top: number;
  clientLeft: number;
  clientTop: number;
  clientWidth: number;
  clientHeight: number;
  clipX: boolean;
  clipY: boolean;
}

/** Intersect the viewport with only the axes clipped by each ancestor's client box. */
export function intersectVisibleClipBounds(
  viewport: VisibleClipBounds,
  ancestors: readonly OverflowClipAncestor[],
): VisibleClipBounds {
  const visible = { ...viewport };
  for (const ancestor of ancestors) {
    const clientLeft = ancestor.left + ancestor.clientLeft;
    const clientTop = ancestor.top + ancestor.clientTop;
    if (ancestor.clipX) {
      visible.left = Math.max(visible.left, clientLeft);
      visible.right = Math.min(visible.right, clientLeft + ancestor.clientWidth);
    }
    if (ancestor.clipY) {
      visible.top = Math.max(visible.top, clientTop);
      visible.bottom = Math.min(visible.bottom, clientTop + ancestor.clientHeight);
    }
  }
  return visible;
}

/** Find a direct, unobstructed hit corridor between an image edge and its toolbar. */
export function findDirectHoverCorridor(
  image: PositioningRect,
  toolbar: PositioningRect,
  visibleBounds: VisibleClipBounds,
  obstacles: readonly PositioningRect[],
): PositioningRect | null {
  const verticalOverlap = {
    top: Math.max(image.top, toolbar.top),
    bottom: Math.min(image.bottom, toolbar.bottom),
  };
  const horizontalOverlap = {
    left: Math.max(image.left, toolbar.left),
    right: Math.min(image.right, toolbar.right),
  };
  const candidates: PositioningRect[] = [];

  // A subpixel cross-section can touch both edges without receiving a pointer hit.
  if (verticalOverlap.bottom - verticalOverlap.top >= 1) {
    if (image.right < toolbar.left) {
      candidates.push({ left: image.right, top: verticalOverlap.top, right: toolbar.left, bottom: verticalOverlap.bottom });
    } else if (toolbar.right < image.left) {
      candidates.push({ left: toolbar.right, top: verticalOverlap.top, right: image.left, bottom: verticalOverlap.bottom });
    }
  }
  if (horizontalOverlap.right - horizontalOverlap.left >= 1) {
    if (image.bottom < toolbar.top) {
      candidates.push({ left: horizontalOverlap.left, top: image.bottom, right: horizontalOverlap.right, bottom: toolbar.top });
    } else if (toolbar.bottom < image.top) {
      candidates.push({ left: horizontalOverlap.left, top: toolbar.bottom, right: horizontalOverlap.right, bottom: image.top });
    }
  }

  const withinBounds = (rect: PositioningRect) =>
    rect.left >= visibleBounds.left && rect.top >= visibleBounds.top &&
    rect.right <= visibleBounds.right && rect.bottom <= visibleBounds.bottom;
  const overlaps = (left: PositioningRect, right: PositioningRect) =>
    left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;

  return candidates
    .filter((candidate) =>
      candidate.right > candidate.left && candidate.bottom > candidate.top &&
      withinBounds(candidate) && !obstacles.some((obstacle) => overlaps(candidate, obstacle)),
    )
    .sort((left, right) => {
      const leftThickness = Math.min(left.right - left.left, left.bottom - left.top);
      const rightThickness = Math.min(right.right - right.left, right.bottom - right.top);
      const leftDistance = (left.right - left.left) + (left.bottom - left.top);
      const rightDistance = (right.right - right.left) + (right.bottom - right.top);
      return rightThickness - leftThickness || leftDistance - rightDistance;
    })[0] ?? null;
}

/** Convert viewport coordinates to CSS left/top for an absolute child's real containing block. */
export function viewportPositionToContainingBlock(
  position: ViewportPosition,
  containingBlock: PositioningContainingBlock | null,
): ViewportPosition {
  if (!containingBlock) return position;
  return {
    left: position.left - containingBlock.left - containingBlock.clientLeft + containingBlock.scrollLeft,
    top: position.top - containingBlock.top - containingBlock.clientTop + containingBlock.scrollTop,
  };
}
