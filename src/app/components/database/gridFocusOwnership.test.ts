import { describe, expect, it } from 'vitest';
import {
  blurGridTarget,
  focusGridTarget,
  takeGridFocusOwnership,
} from './gridFocusOwnership';

describe('database grid focus ownership', () => {
  it('does not claim focus for a grid that has never received cell focus', () => {
    const taken = takeGridFocusOwnership(null);

    expect(taken).toEqual({ wasOwned: false, next: null });
  });

  it('transfers ownership when focus moves directly between grid cells', () => {
    const table = {};
    const first = focusGridTarget('row-a:column-a', table);
    const moved = blurGridTarget(first, {
      sourceCellKey: 'row-a:column-a',
      sourceOwner: table,
      relatedCellKey: 'row-b:column-a',
      relatedOwner: table,
      relatedTargetIsBodyOrNull: false,
      sourceCellRemoved: false,
    });

    expect(moved).toEqual({ cellKey: 'row-b:column-a', owner: table });
    expect(focusGridTarget('row-b:column-a', table)).toEqual(moved);
  });

  it('clears ownership when focus enters a cell editor or an external control', () => {
    const table = {};
    const cell = focusGridTarget('row-a:column-a', table);

    const editorBlur = blurGridTarget(cell, {
      sourceCellKey: 'row-a:column-a',
      sourceOwner: table,
      relatedCellKey: null,
      relatedOwner: null,
      relatedTargetIsBodyOrNull: false,
      sourceCellRemoved: false,
    });
    expect(editorBlur).toBeNull();
    expect(focusGridTarget(null, table)).toBeNull();

    const externalBlur = blurGridTarget(cell, {
      sourceCellKey: 'row-a:column-a',
      sourceOwner: table,
      relatedCellKey: null,
      relatedOwner: null,
      relatedTargetIsBodyOrNull: false,
      sourceCellRemoved: false,
    });
    expect(externalBlur).toBeNull();
  });

  it('retains ownership when the focused cell is removed and blur lands on body', () => {
    const table = {};
    const cell = focusGridTarget('row-a:column-a', table);
    const afterRemoval = blurGridTarget(cell, {
      sourceCellKey: 'row-a:column-a',
      sourceOwner: table,
      relatedCellKey: null,
      relatedOwner: null,
      relatedTargetIsBodyOrNull: true,
      sourceCellRemoved: true,
    });

    expect(afterRemoval).toEqual(cell);
    expect(takeGridFocusOwnership(afterRemoval)).toEqual({ wasOwned: true, next: null });
  });

  it('clears ownership when an explicit blur reaches body while the cell remains connected', () => {
    const table = {};
    const cell = focusGridTarget('row-a:column-a', table);
    const afterExplicitBlur = blurGridTarget(cell, {
      sourceCellKey: 'row-a:column-a',
      sourceOwner: table,
      relatedCellKey: null,
      relatedOwner: null,
      relatedTargetIsBodyOrNull: true,
      sourceCellRemoved: false,
    });

    expect(afterExplicitBlur).toBeNull();
    expect(takeGridFocusOwnership(afterExplicitBlur)).toEqual({ wasOwned: false, next: null });
  });

  it('clears ownership if a removed cell blurs directly to an external control', () => {
    const table = {};
    const cell = focusGridTarget('row-a:column-a', table);
    const afterRemovalToExternalControl = blurGridTarget(cell, {
      sourceCellKey: 'row-a:column-a',
      sourceOwner: table,
      relatedCellKey: null,
      relatedOwner: null,
      relatedTargetIsBodyOrNull: false,
      sourceCellRemoved: true,
    });

    expect(afterRemovalToExternalControl).toBeNull();
  });

  it('clears ownership when a same-coordinate cell belongs to another table', () => {
    const sourceTable = {};
    const otherTable = {};
    const source = focusGridTarget('row-a:column-a', sourceTable);
    const afterMovingToOtherTable = blurGridTarget(source, {
      sourceCellKey: 'row-a:column-a',
      sourceOwner: sourceTable,
      relatedCellKey: 'row-a:column-a',
      relatedOwner: otherTable,
      relatedTargetIsBodyOrNull: false,
      sourceCellRemoved: false,
    });

    expect(afterMovingToOtherTable).toBeNull();
  });

  it('consumes old ownership before a fallback focus is attempted', () => {
    const table = {};
    const taken = takeGridFocusOwnership(focusGridTarget('row-a:column-a', table));

    expect(taken.wasOwned).toBe(true);
    expect(taken.next).toBeNull();
    expect(takeGridFocusOwnership(taken.next).wasOwned).toBe(false);
  });
});
