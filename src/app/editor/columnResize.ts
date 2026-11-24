import { closeHistory } from '@tiptap/pm/history';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { parseLegacyColumnWidths } from '../../core/columnWidths';

const WIDTH_PRECISION = 100;
const MAX_WIDTH_CENTS = 1000 * WIDTH_PRECISION;

type PairResizeState = {
  pairCents: number;
  totalCents: number;
  startLeftCents: number;
  minimumLeftCents: number;
  maximumLeftCents: number;
};

export function startingColumnWidths(value: unknown, count: number): number[] | null {
  if (!Number.isInteger(count) || count < 2 || count > 7) return null;
  if (value === null || value === undefined) return Array.from({ length: count }, () => 100);
  return parseLegacyColumnWidths(value, count);
}

export function resizeColumnPairByPointer(
  widths: readonly number[],
  pairIndex: number,
  deltaPixels: number,
  availableWidth: number,
  minimumColumnPixels: number,
): number[] | null {
  const state = pairResizeState(widths, pairIndex, availableWidth, minimumColumnPixels);
  if (
    state === null ||
    !Number.isFinite(deltaPixels) ||
    !Number.isFinite(availableWidth) ||
    availableWidth <= 0
  ) {
    return null;
  }

  const deltaCents = (deltaPixels / availableWidth) * state.totalCents;
  const leftCents = clampLeftCents(state, state.startLeftCents + deltaCents);
  return replacePairWidths(widths, pairIndex, state.pairCents, leftCents);
}

export function resizeColumnPairByPercentagePoints(
  widths: readonly number[],
  pairIndex: number,
  deltaPercentagePoints: number,
  availableWidth: number,
  minimumColumnPixels: number,
): number[] | null {
  const state = pairResizeState(widths, pairIndex, availableWidth, minimumColumnPixels);
  if (state === null || !Number.isFinite(deltaPercentagePoints)) return null;

  const deltaCents = (deltaPercentagePoints / 100) * state.totalCents;
  const leftCents = clampLeftCents(state, state.startLeftCents + deltaCents);
  return replacePairWidths(widths, pairIndex, state.pairCents, leftCents);
}

export function resizeColumnPairToLimit(
  widths: readonly number[],
  pairIndex: number,
  limit: 'minimum' | 'maximum',
  availableWidth: number,
  minimumColumnPixels: number,
): number[] | null {
  const state = pairResizeState(widths, pairIndex, availableWidth, minimumColumnPixels);
  if (state === null) return null;
  const leftCents = limit === 'minimum' ? state.minimumLeftCents : state.maximumLeftCents;
  return replacePairWidths(widths, pairIndex, state.pairCents, leftCents);
}

export function columnPairPercentageBounds(
  widths: readonly number[],
  pairIndex: number,
  availableWidth: number,
  minimumColumnPixels: number,
): { minimum: number; maximum: number; current: number } | null {
  const state = pairResizeState(widths, pairIndex, availableWidth, minimumColumnPixels);
  if (state === null) return null;
  return {
    minimum: (state.minimumLeftCents / state.totalCents) * 100,
    maximum: (state.maximumLeftCents / state.totalCents) * 100,
    current: (state.startLeftCents / state.totalCents) * 100,
  };
}

function pairResizeState(
  widths: readonly number[],
  pairIndex: number,
  availableWidth: number,
  minimumColumnPixels: number,
): PairResizeState | null {
  if (
    widths.length < 2 ||
    widths.length > 7 ||
    !Number.isInteger(pairIndex) ||
    pairIndex < 0 ||
    pairIndex >= widths.length - 1 ||
    !Number.isFinite(availableWidth) ||
    availableWidth <= 0 ||
    !Number.isFinite(minimumColumnPixels) ||
    minimumColumnPixels < 0 ||
    !widths.every((width) => Number.isFinite(width) && width > 0 && width <= 1000)
  ) {
    return null;
  }

  const cents = widths.map((width) => Math.round(width * WIDTH_PRECISION));
  const totalCents = cents.reduce((sum, width) => sum + width, 0);
  const pairCents = cents[pairIndex]! + cents[pairIndex + 1]!;
  const startLeftCents = cents[pairIndex]!;
  const pixelMinimumCents = Math.ceil((minimumColumnPixels / availableWidth) * totalCents);
  const operationalMinimumCents = Math.min(Math.floor(pairCents / 2), pixelMinimumCents);
  const minimumCents = Math.max(1, operationalMinimumCents, pairCents - MAX_WIDTH_CENTS);
  const maximumCents = Math.min(MAX_WIDTH_CENTS, pairCents - minimumCents);

  // Keep an existing narrow track reachable and let keyboard and pointer input share limits.
  return {
    pairCents,
    totalCents,
    startLeftCents,
    minimumLeftCents: Math.min(startLeftCents, minimumCents),
    maximumLeftCents: Math.max(startLeftCents, maximumCents),
  };
}

function clampLeftCents(state: PairResizeState, targetLeftCents: number): number {
  return Math.round(Math.min(state.maximumLeftCents, Math.max(state.minimumLeftCents, targetLeftCents)));
}

function replacePairWidths(
  widths: readonly number[],
  pairIndex: number,
  pairCents: number,
  leftCents: number,
): number[] | null {
  const rightCents = pairCents - leftCents;
  if (
    leftCents < 1 ||
    rightCents < 1 ||
    leftCents > MAX_WIDTH_CENTS ||
    rightCents > MAX_WIDTH_CENTS
  ) {
    return null;
  }
  const resized = [...widths];
  resized[pairIndex] = leftCents / WIDTH_PRECISION;
  resized[pairIndex + 1] = rightCents / WIDTH_PRECISION;
  return resized;
}

export function hasColumnWidthChange(before: readonly number[], after: readonly number[]): boolean {
  return before.length === after.length && before.some((width, index) => width !== after[index]);
}

function formattedWidth(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0 || value > 1000) return null;
  const cents = Math.round(value * WIDTH_PRECISION);
  return (cents / WIDTH_PRECISION).toFixed(2).replace(/\.?0+$/, '');
}

function replaceWeight(raw: string, value: number): string | null {
  const formatted = formattedWidth(value);
  if (!formatted) return null;
  const leading = /^\s*/.exec(raw)?.[0] ?? '';
  const trailing = /\s*$/.exec(raw)?.[0] ?? '';
  return `${leading}${formatted}${trailing}`;
}

export function serializeColumnWidthResize(
  source: string | null,
  count: number,
  before: readonly number[],
  after: readonly number[],
  pairIndex: number,
): string | null {
  if (
    before.length !== count ||
    after.length !== count ||
    !Number.isInteger(pairIndex) ||
    pairIndex < 0 ||
    pairIndex >= count - 1 ||
    !hasColumnWidthChange(before, after)
  ) {
    return null;
  }

  const beforeCents = before.map((width) => Math.round(width * WIDTH_PRECISION));
  const afterCents = after.map((width) => Math.round(width * WIDTH_PRECISION));
  if (
    after.some((width, index) => index !== pairIndex && index !== pairIndex + 1 && width !== before[index]) ||
    beforeCents[pairIndex]! + beforeCents[pairIndex + 1]! !==
      afterCents[pairIndex]! + afterCents[pairIndex + 1]!
  ) {
    return null;
  }

  const parts: string[] | null =
    source === null
      ? before.map((width) => formattedWidth(width) ?? '')
      : parseLegacyColumnWidths(source, count)
        ? source.split(',')
        : null;
  if (parts === null) return null;
  if (parts.length !== count) return null;
  const left = replaceWeight(parts[pairIndex]!, after[pairIndex]!);
  const right = replaceWeight(parts[pairIndex + 1]!, after[pairIndex + 1]!);
  if (left === null || right === null) return null;
  parts[pairIndex] = left;
  parts[pairIndex + 1] = right;

  const result = parts.join(',');
  if (parseLegacyColumnWidths(result, count)) return result;

  // A valid source may already be at the legacy 96-character limit. First trim only the
  // adjusted pair's padding; if that is not enough, shorten the untouched tokens while
  // keeping their parsed numeric values unchanged.
  const compactPair = [...parts];
  compactPair[pairIndex] = formattedWidth(after[pairIndex]!) ?? '';
  compactPair[pairIndex + 1] = formattedWidth(after[pairIndex + 1]!) ?? '';
  const compactPairResult = compactPair.join(',');
  if (parseLegacyColumnWidths(compactPairResult, count)) return compactPairResult;

  const compactAll = after.map((width) => formattedWidth(width));
  if (compactAll.some((part) => part === null)) return null;
  const compactResult = compactAll.join(',');
  return parseLegacyColumnWidths(compactResult, count) ? compactResult : null;
}

export function createColumnWidthsTransaction(
  transaction: Transaction,
  position: number,
  sourceNode: ProseMirrorNode,
  widths: string | null,
): Transaction | null {
  const currentNode = transaction.doc.nodeAt(position);
  if (
    sourceNode.type.name !== 'columns' ||
    currentNode !== sourceNode ||
    currentNode.childCount < 2 ||
    currentNode.childCount > 7 ||
    currentNode.attrs.widths === widths ||
    (widths !== null && !parseLegacyColumnWidths(widths, currentNode.childCount))
  ) {
    return null;
  }
  return closeHistory(transaction).setNodeMarkup(position, undefined, {
    ...currentNode.attrs,
    widths,
  });
}

export function closeColumnWidthResizeHistory(transaction: Transaction): Transaction {
  return closeHistory(transaction).setMeta('addToHistory', false);
}
