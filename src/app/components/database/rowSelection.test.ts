import { describe, expect, it } from 'vitest';
import { selectionMatchesVisibleRows, toggleVisibleRowSelection } from './rowSelection';

const visibleRows = ['row-one', 'row-two', 'row-three'];

describe('row checkbox selection', () => {
  it('adds only the checked row and orders selected IDs by visible rows', () => {
    expect(toggleVisibleRowSelection(['row-three'], 'row-one', true, visibleRows)).toEqual([
      'row-one',
      'row-three',
    ]);
  });

  it('removes only the unchecked row while preserving the rest of the selection', () => {
    expect(
      toggleVisibleRowSelection(['row-one', 'row-two', 'row-three'], 'row-two', false, visibleRows),
    ).toEqual(['row-one', 'row-three']);
  });

  it('does not introduce IDs outside the current visible row set', () => {
    expect(toggleVisibleRowSelection(['row-two', 'removed-row'], 'row-one', true, visibleRows)).toEqual([
      'row-one',
      'row-two',
    ]);
  });

  it('keeps a bulk menu valid only while every selected row remains visible', () => {
    expect(selectionMatchesVisibleRows(['row-one', 'row-two'], ['row-two', 'row-one'], new Set(visibleRows))).toBe(
      true,
    );
    expect(selectionMatchesVisibleRows(['row-one', 'row-two'], ['row-one'], new Set(visibleRows))).toBe(false);
    expect(selectionMatchesVisibleRows(['row-one', 'row-two'], ['row-one', 'row-two'], new Set(['row-one']))).toBe(
      false,
    );
  });
});
