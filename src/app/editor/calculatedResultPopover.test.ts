import { describe, expect, it } from 'vitest';
import { calculateResultPopoverPlacement } from './calculatedResultPopover';
import type { ResultPopoverRect } from './calculatedResultPopover';

const rect = (left: number, top: number, width: number, height: number): ResultPopoverRect => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
});

describe('calculated result editor placement', () => {
  it('anchors simultaneous result editors inside their own panes', () => {
    const viewport = { width: 1440, height: 900 };
    const leftPane = rect(0, 0, 700, 900);
    const rightPane = rect(720, 0, 720, 900);
    const leftPlacement = calculateResultPopoverPlacement(
      { left: 170, top: 210, bottom: 234 }, leftPane, viewport, { height: 480 },
    );
    const rightPlacement = calculateResultPopoverPlacement(
      { left: 920, top: 310, bottom: 334 }, rightPane, viewport, { height: 480 },
    );

    expect(leftPlacement).toEqual({ left: 128, top: 240, width: 560, maxHeight: 876 });
    expect(rightPlacement).toEqual({ left: 868, top: 340, width: 560, maxHeight: 876 });
    expect(leftPlacement!.left + leftPlacement!.width).toBeLessThanOrEqual(leftPane.right - 12);
    expect(rightPlacement!.left).toBeGreaterThanOrEqual(rightPane.left + 12);
  });

  it('clamps a scrolled result editor to the visible pane and shrinks in a narrow pane', () => {
    const pane = rect(380, 500, 260, 300);
    const placement = calculateResultPopoverPlacement(
      { left: 600, top: 690, bottom: 710 },
      pane,
      { width: 1000, height: 900 },
      { height: 600 },
    );

    expect(placement).toEqual({ left: 392, top: 512, width: 236, maxHeight: 276 });
    expect(placement!.left).toBeGreaterThanOrEqual(pane.left + 12);
    expect(placement!.left + placement!.width).toBeLessThanOrEqual(pane.right - 12);
    expect(placement!.top).toBeGreaterThanOrEqual(pane.top + 12);
    expect(placement!.top + placement!.maxHeight).toBeLessThanOrEqual(pane.bottom - 12);
  });

  it('uses only the pane portion intersecting the viewport', () => {
    const pane = rect(1000, 50, 600, 1050);
    const placement = calculateResultPopoverPlacement(
      { left: 1500, top: 740, bottom: 770 },
      pane,
      { width: 1440, height: 800 },
      { height: 900 },
    );

    expect(placement).toEqual({ left: 1012, top: 62, width: 416, maxHeight: 726 });
    expect(placement!.left + placement!.width).toBeLessThanOrEqual(1440 - 12);
    expect(placement!.top + placement!.maxHeight).toBeLessThanOrEqual(800 - 12);
  });
});
