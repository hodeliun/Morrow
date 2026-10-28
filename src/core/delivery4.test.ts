import { describe, expect, it } from 'vitest';
import {
  detectArithmeticSequence,
  isColumnReadOnly,
  parseGridClipboard,
  planGridClear,
  planGridFill,
  planGridPaste,
  resolveVisibleRange,
  revalidateActiveCell,
  serializeGridClipboard,
  TITLE_PROP_ID,
  validateGridClipboardPayload,
} from './gridOperations';
import type { DatabaseDef, PageMeta, PropDef, WorkspaceState } from './model';

function parseClipboard(text: string) {
  const result = parseGridClipboard(text);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function makeSyntheticState(): {
  state: WorkspaceState;
  dbId: string;
  rowIds: [string, string, string, string, string];
  propIds: string[];
} {
  const dbId = 'test-db';
  const relationDbId = 'target-db';
  const rowIds: [string, string, string, string, string] = ['row-1', 'row-2', 'row-3', 'row-4', 'row-5'];
  const properties: PropDef[] = [
    { id: 'num-prop', name: 'Quantity', type: 'number', options: [] },
    { id: 'text-prop', name: 'Notes', type: 'text', options: [] },
    { id: 'check-prop', name: 'Active', type: 'checkbox', options: [] },
    { id: 'date-prop', name: 'Due Date', type: 'date', options: [] },
    {
      id: 'select-prop',
      name: 'Status',
      type: 'select',
      options: [
        { id: 'opt-done', name: 'Done', color: 'green' },
        { id: 'opt-todo', name: 'Todo', color: 'gray' },
      ],
    },
    {
      id: 'relation-prop',
      name: 'Related rows',
      type: 'relation',
      options: [],
      relation: {
        targetDatabaseId: relationDbId,
        multiple: true,
        isInverse: false,
        displayPropertyId: null,
        inversePropertyId: null,
        filters: [],
      },
    },
    { id: 'formula-prop', name: 'Calculated', type: 'formula', formula: 'Quantity * 2', options: [] },
  ];

  const database: DatabaseDef = {
    properties,
    views: [
      {
        id: 'view-default',
        name: 'Default',
        type: 'table',
        filters: [],
        sorts: [],
        hidden: [],
        groupBy: null,
        dateProp: null,
      },
    ],
  };

  const pages: Record<string, PageMeta> = {
    [dbId]: {
      id: dbId,
      title: 'Test Database',
      createdAt: 1000,
      updatedAt: 1000,
      parentId: null,
      trashedAt: null,
      kind: 'database',
      database,
      tags: [],
      properties: {},
      extra: {},
      favorite: false,
      icon: null,
      order: 0,
    } as unknown as PageMeta,
    [relationDbId]: {
      id: relationDbId,
      title: 'Target Database',
      createdAt: 1000,
      updatedAt: 1000,
      parentId: null,
      trashedAt: null,
      kind: 'database',
      database: { properties: [], views: [] },
      tags: [],
      properties: {},
      extra: {},
      favorite: false,
      icon: null,
      order: 1,
    } as unknown as PageMeta,
    'target-1': {
      id: 'target-1',
      title: 'Target 1',
      createdAt: 1000,
      updatedAt: 1000,
      parentId: relationDbId,
      kind: 'note',
      trashedAt: null,
      tags: [],
      properties: {},
      extra: {},
      favorite: false,
      icon: null,
      order: 0,
    } as unknown as PageMeta,
    'target-2': {
      id: 'target-2',
      title: 'Target 2',
      createdAt: 1000,
      updatedAt: 1000,
      parentId: relationDbId,
      kind: 'note',
      trashedAt: null,
      tags: [],
      properties: {},
      extra: {},
      favorite: false,
      icon: null,
      order: 1,
    } as unknown as PageMeta,
  };

  for (let i = 0; i < rowIds.length; i++) {
    const id = rowIds[i]!;
    pages[id] = {
      id,
      title: `Item ${i + 1}`,
      createdAt: 1000 + i * 10,
      updatedAt: 1000 + i * 10,
      parentId: dbId,
      trashedAt: null,
      kind: 'note',
      tags: [],
      properties: {
        'num-prop': (i + 1) * 10,
        'text-prop': `Note ${i + 1}`,
        'check-prop': i % 2 === 0,
        'date-prop': `2026-10-2${i + 1}`,
        'select-prop': i % 2 === 0 ? 'opt-done' : 'opt-todo',
        'relation-prop': [i % 2 === 0 ? 'target-1' : 'target-2'],
      },
      extra: {},
      favorite: false,
      icon: null,
      order: i,
    } as unknown as PageMeta;
  }

  const state: WorkspaceState = {
    pages,
    docs: {},
  };

  return { state, dbId, rowIds, propIds: ['title', ...properties.map((p) => p.id)] };
}

describe('gridOperations — delivery 4 unit tests (#32, #33, #34)', () => {
  describe('Ticket #32: Roving focus and cell range resolution', () => {
    it('resolves 1x1 cell range', () => {
      const rows = ['r1', 'r2', 'r3'];
      const cols = ['title', 'p1', 'p2'];
      const range = { anchor: { rowId: 'r2', colId: 'p1' }, focus: { rowId: 'r2', colId: 'p1' } };

      const resolved = resolveVisibleRange(range, rows, cols);
      expect(resolved).not.toBeNull();
      expect(resolved?.rowIds).toEqual(['r2']);
      expect(resolved?.colIds).toEqual(['p1']);
      expect(resolved?.cellCount).toBe(1);
    });

    it('resolves multi-cell range bidirectionally', () => {
      const rows = ['r1', 'r2', 'r3', 'r4'];
      const cols = ['title', 'p1', 'p2', 'p3'];

      const range = { anchor: { rowId: 'r3', colId: 'p2' }, focus: { rowId: 'r1', colId: 'title' } };
      const resolved = resolveVisibleRange(range, rows, cols);

      expect(resolved).not.toBeNull();
      expect(resolved?.rowIds).toEqual(['r1', 'r2', 'r3']);
      expect(resolved?.colIds).toEqual(['title', 'p1', 'p2']);
      expect(resolved?.cellCount).toBe(9);
    });

    it('revalidates active cell when visible rows or columns change', () => {
      const prevRows = ['r1', 'r2', 'r3', 'r4'];
      const prevCols = ['title', 'p1', 'p2'];

      const r1 = revalidateActiveCell({ rowId: 'r2', colId: 'p1' }, prevRows, prevCols, ['r2', 'r3'], ['title', 'p1']);
      expect(r1.moved).toBe(false);
      expect(r1.active).toEqual({ rowId: 'r2', colId: 'p1' });

      const r2 = revalidateActiveCell({ rowId: 'r4', colId: 'p1' }, prevRows, prevCols, ['r1', 'r2'], prevCols);
      expect(r2.moved).toBe(true);
      expect(r2.active?.rowId).toBe('r2');
      expect(r2.active?.colId).toBe('p1');

      const r3 = revalidateActiveCell({ rowId: 'r2', colId: 'p2' }, prevRows, prevCols, prevRows, ['title', 'p1']);
      expect(r3.moved).toBe(true);
      expect(r3.active?.rowId).toBe('r2');
      expect(r3.active?.colId).toBe('p1');
    });

    it('identifies read-only columns accurately', () => {
      const { state, dbId } = makeSyntheticState();
      const db = state.pages[dbId]!.database!;

      expect(isColumnReadOnly(TITLE_PROP_ID, db)).toBe(false);
      expect(isColumnReadOnly('num-prop', db)).toBe(false);
      expect(isColumnReadOnly('formula-prop', db)).toBe(true);
    });
  });

  describe('Ticket #33: Cell ranges, clear, copy and paste', () => {
    it('refuses batch clear if it exceeds MAX_GRID_BATCH_CELLS', () => {
      const { state, dbId } = makeSyntheticState();
      const rows = Array.from({ length: 50 }, (_, i) => `row-${i}`);
      const cols = Array.from({ length: 30 }, (_, i) => `col-${i}`);
      const range = { anchor: { rowId: rows[0]!, colId: cols[0]! }, focus: { rowId: rows[49]!, colId: cols[29]! } };

      const result = planGridClear(state, dbId, range, rows, cols, 1000);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('1,000 cells');
      }
    });

    it('allows exactly 1,000 selected cells and rejects 1,001 before planning commands', () => {
      const { state, dbId, rowIds } = makeSyntheticState();
      const visibleRows = Array.from({ length: 1001 }, (_, index) => `limit-row-${index}`);
      const template = state.pages[rowIds[0]]!;
      const pages: Record<string, PageMeta> = { ...state.pages };
      for (const [index, rowId] of visibleRows.entries()) {
        pages[rowId] = { ...structuredClone(template), id: rowId, title: `Limit ${index}`, order: index };
      }
      const largeState: WorkspaceState = { ...state, pages };

      const exactRange = {
        anchor: { rowId: visibleRows[0]!, colId: 'text-prop' },
        focus: { rowId: visibleRows[999]!, colId: 'text-prop' },
      };
      expect(planGridClear(largeState, dbId, exactRange, visibleRows, ['text-prop'], 1000).ok).toBe(true);

      const overRange = { ...exactRange, focus: { rowId: visibleRows[1000]!, colId: 'text-prop' } };
      const tooLarge = planGridClear(largeState, dbId, overRange, visibleRows, ['text-prop'], 1000);
      expect(tooLarge.ok).toBe(false);
      if (!tooLarge.ok) expect(tooLarge.error).toContain('1,000 cells');
    });

    it('refuses batch clear if any cell is in a calculated/read-only column', () => {
      const { state, dbId, rowIds, propIds } = makeSyntheticState();
      const range = { anchor: { rowId: rowIds[0], colId: 'formula-prop' }, focus: { rowId: rowIds[1], colId: 'formula-prop' } };

      const result = planGridClear(state, dbId, range, rowIds, propIds, 1000);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Calculated');
        expect(result.error).toContain('read-only');
      }
    });

    it('clears cell values and provides reversible undo commands without deleting pages', () => {
      const { state, dbId, rowIds, propIds } = makeSyntheticState();
      const range = {
        anchor: { rowId: rowIds[0], colId: 'title' },
        focus: { rowId: rowIds[1], colId: 'check-prop' },
      };

      const result = planGridClear(state, dbId, range, rowIds, propIds, 2000);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.affectedCells).toBe(8);
        expect(result.value.commands.length).toBeGreaterThan(0);
        expect(result.value.undoCommands.length).toBeGreaterThan(0);

        const titleClearCmd = result.value.commands.find((c) => c.type === 'page.rename' && c.id === 'row-1');
        expect(titleClearCmd).toBeDefined();
        if (titleClearCmd && titleClearCmd.type === 'page.rename') {
          expect(titleClearCmd.title).toBe('');
        }

        const titleUndoCmd = result.value.undoCommands.find((c) => c.type === 'page.rename' && c.id === 'row-1');
        expect(titleUndoCmd).toBeDefined();
        if (titleUndoCmd && titleUndoCmd.type === 'page.rename') {
          expect(titleUndoCmd.title).toBe('Item 1');
        }
      }
    });

    it('serializes and parses clipboard payload preserving false, 0, null, dates and strings starting with =', () => {
      const { state, dbId, rowIds, propIds } = makeSyntheticState();
      const range = {
        anchor: { rowId: rowIds[0], colId: 'title' },
        focus: { rowId: rowIds[1], colId: 'select-prop' },
      };

      const serialized = serializeGridClipboard(state, dbId, range, rowIds, propIds);
      expect(serialized.ok).toBe(true);
      if (serialized.ok) {
        expect(serialized.value.tsv).toContain('Item 1');
        expect(serialized.value.payload.version).toBe(1);
        expect(serialized.value.payload.kind).toBe('morrow-grid-range');

        const parsedJson = parseClipboard(JSON.stringify(serialized.value.payload));
        expect(parsedJson.version).toBe(1);
        expect(parsedJson.rowCount).toBe(2);

        const tsv = 'Title\tValue\n=SUM(1,2)\t00123\nFormula\tfalse';
        const parsedTsv = parseClipboard(tsv);
        expect(parsedTsv.rows[1]?.[0]?.value).toBe('=SUM(1,2)');
        expect(parsedTsv.rows[1]?.[1]?.value).toBe('00123');
        expect(parsedTsv.rows[2]?.[1]?.value).toBe('false');
      }
    });

    it('parses quoted TSV cells across newlines without changing text values', () => {
      const parsed = parseClipboard('"first line\r\nsecond line\twith a tab"\t00123\r\n=1+2\tfalse\r\n');
      expect(parsed.rowCount).toBe(2);
      expect(parsed.colCount).toBe(2);
      expect(parsed.rows[0]?.[0]?.value).toBe('first line\r\nsecond line\twith a tab');
      expect(parsed.rows[0]?.[1]?.value).toBe('00123');
      expect(parsed.rows[1]?.[0]?.value).toBe('=1+2');
      expect(parsed.rows[1]?.[1]?.value).toBe('false');
    });

    it('enforces the clipboard cell limit without spreading an unbounded row array', () => {
      expect(parseGridClipboard(Array.from({ length: 1000 }, () => 'x').join('\t')).ok).toBe(true);
      const tooWide = parseGridClipboard(Array.from({ length: 1001 }, () => 'x').join('\t'));
      expect(tooWide.ok).toBe(false);
      if (!tooWide.ok) expect(tooWide.error).toContain('1,000-cell limit');

      const tooTall = parseGridClipboard('\n'.repeat(200_000));
      expect(tooTall.ok).toBe(false);
      if (!tooTall.ok) expect(tooTall.error).toContain('1,000-cell limit');
    });

    it('validates typed clipboard dimensions, types, row widths, and primitive values', () => {
      const valid = {
        version: 1,
        kind: 'morrow-grid-range',
        rowCount: 1,
        colCount: 2,
        colTypes: ['checkbox', 'text'],
        rows: [[
          { type: 'checkbox', value: false },
          { type: 'text', value: '=still text' },
        ]],
      };
      expect(validateGridClipboardPayload(valid).ok).toBe(true);
      expect(validateGridClipboardPayload({ ...valid, rowCount: 2 }).ok).toBe(false);
      expect(validateGridClipboardPayload({ ...valid, colTypes: ['checkbox', 'unknown'] }).ok).toBe(false);
      expect(validateGridClipboardPayload({ ...valid, extra: true }).ok).toBe(false);
      expect(validateGridClipboardPayload({ ...valid, rows: [[{ type: 'checkbox', value: false }]] }).ok).toBe(false);
      expect(validateGridClipboardPayload({ ...valid, rows: [[{ type: 'checkbox', value: { code: 'x' } }, valid.rows[0]![1]]] }).ok).toBe(false);
      expect(validateGridClipboardPayload({ ...valid, rows: [[{ type: 'checkbox', value: false, extra: 'ignored' }, valid.rows[0]![1]]] }).ok).toBe(false);
    });

    it('fills 1x1 source value across NxM target selection', () => {
      const { state, dbId, rowIds, propIds } = makeSyntheticState();
      const payload = parseClipboard('99');
      const targetRange = {
        anchor: { rowId: rowIds[0], colId: 'num-prop' },
        focus: { rowId: rowIds[2], colId: 'num-prop' },
      };

      const result = planGridPaste(state, dbId, targetRange, payload, rowIds, propIds, 3000);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.affectedCells).toBe(3);
        const setProps = result.value.commands.filter((c) => c.type === 'page.setProperties');
        expect(setProps.length).toBe(3);
        setProps.forEach((c) => {
          if (c.type === 'page.setProperties') {
            expect(c.values['num-prop']).toBe(99);
          }
        });
      }
    });

    it('refuses paste if it extends beyond visible columns', () => {
      const { state, dbId, rowIds, propIds } = makeSyntheticState();
      const payload = parseClipboard('A\tB\tC');
      const lastCol = propIds[propIds.length - 1]!;
      const targetRange = {
        anchor: { rowId: rowIds[0], colId: lastCol },
        focus: { rowId: rowIds[0], colId: lastCol },
      };

      const result = planGridPaste(state, dbId, targetRange, payload, rowIds, propIds, 3000);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Paste extends beyond visible columns');
      }
    });

    it('rejects invalid values in a whole paste plan without returning partial commands', () => {
      const { state, dbId, rowIds } = makeSyntheticState();
      const before = structuredClone(state.pages[rowIds[0]]!.properties);
      const range = {
        anchor: { rowId: rowIds[0], colId: 'num-prop' },
        focus: { rowId: rowIds[0], colId: 'num-prop' },
      };

      const invalidNumber = planGridPaste(
        state,
        dbId,
        range,
        parseClipboard('not-a-number'),
        rowIds,
        ['num-prop'],
        3000,
      );
      expect(invalidNumber.ok).toBe(false);
      if (!invalidNumber.ok) expect(invalidNumber.error).toContain('valid number');
      expect(state.pages[rowIds[0]]!.properties).toEqual(before);

      const invalidBatch = planGridPaste(
        state,
        dbId,
        range,
        parseClipboard('99\t2026-02-30'),
        rowIds,
        ['num-prop', 'date-prop'],
        3000,
      );
      expect(invalidBatch.ok).toBe(false);
      if (!invalidBatch.ok) {
        expect(invalidBatch.error).toContain('Cell 1');
        expect(invalidBatch.error).toContain('Due Date');
      }
      expect(state.pages[rowIds[0]]!.properties).toEqual(before);
    });

    it('keeps formula-looking text as data and rejects invalid checkbox/select values', () => {
      const { state, dbId, rowIds } = makeSyntheticState();
      const textRange = {
        anchor: { rowId: rowIds[0], colId: 'text-prop' },
        focus: { rowId: rowIds[0], colId: 'text-prop' },
      };
      const textPaste = planGridPaste(state, dbId, textRange, parseClipboard('=not executable'), rowIds, ['text-prop'], 3000);
      expect(textPaste.ok).toBe(true);
      if (textPaste.ok) {
        const command = textPaste.value.commands.find((item) => item.type === 'page.setProperties');
        expect(command?.type === 'page.setProperties' ? command.values['text-prop'] : undefined).toBe('=not executable');
      }

      for (const [colId, raw] of [['check-prop', 'maybe'], ['select-prop', 'missing option']] as const) {
        const result = planGridPaste(
          state,
          dbId,
          { anchor: { rowId: rowIds[0], colId }, focus: { rowId: rowIds[0], colId } },
          parseClipboard(raw),
          rowIds,
          [colId],
          3000,
        );
        expect(result.ok).toBe(false);
      }
    });

    it('demands row confirmation when paste extends beyond visible rows, then creates rows when authorized', () => {
      const { state, dbId, rowIds, propIds } = makeSyntheticState();
      const payload = parseClipboard('A\nB\nC');
      const targetRange = {
        anchor: { rowId: rowIds[4], colId: 'title' },
        focus: { rowId: rowIds[4], colId: 'title' },
      };

      const blocked = planGridPaste(state, dbId, targetRange, payload, rowIds, propIds, 3000, {
        allowCreateRows: false,
      });
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) {
        expect(blocked.extraRowsNeeded).toBe(2);
      }

      let rowCounter = 1;
      const authorized = planGridPaste(state, dbId, targetRange, payload, rowIds, propIds, 3000, {
        allowCreateRows: true,
        newRowIdFactory: () => `new-row-${rowCounter++}`,
      });
      if (!authorized.ok) throw new Error(authorized.error);
      if (authorized.ok) {
        expect(authorized.value.createdRowIds).toEqual(['new-row-1', 'new-row-2']);
        const createCmds = authorized.value.commands.filter((c) => c.type === 'page.create');
        expect(createCmds.length).toBe(2);

        const trashCmds = authorized.value.undoCommands.filter((c) => c.type === 'page.trash');
        expect(trashCmds.length).toBe(2);
        expect(authorized.value.undoCommands.every((c) => c.type !== 'page.deleteForever')).toBe(true);
        expect(authorized.value.redoCommands.filter((c) => c.type === 'page.restore')).toHaveLength(2);
      }
    });
  });

  describe('Ticket #34: Fill handle with seed pattern detection and preview', () => {
    it('detects arithmetic progression on numbers (+step and -step)', () => {
      expect(detectArithmeticSequence([1, 2, 3])).toEqual({ canSequence: true, step: 1 });
      expect(detectArithmeticSequence([10, 20])).toEqual({ canSequence: true, step: 10 });
      expect(detectArithmeticSequence([5, 4, 3])).toEqual({ canSequence: true, step: -1 });
      expect(detectArithmeticSequence([1, 5, 2])).toEqual({ canSequence: false });
      expect(detectArithmeticSequence([42])).toEqual({ canSequence: false });
    });

    it('detects date progressions (+1 day, +7 days)', () => {
      expect(detectArithmeticSequence(['2026-10-01', '2026-10-02', '2026-10-03'])).toEqual({
        canSequence: true,
        step: 1,
      });
      expect(detectArithmeticSequence(['2026-10-01', '2026-10-08'])).toEqual({
        canSequence: true,
        step: 7,
      });
    });

    it('plans vertical fill with arithmetic sequence progression', () => {
      const { state, dbId, rowIds, propIds } = makeSyntheticState();
      const sourceRange = {
        anchor: { rowId: rowIds[0], colId: 'num-prop' },
        focus: { rowId: rowIds[1], colId: 'num-prop' },
      };
      const targetRange = {
        anchor: { rowId: rowIds[0], colId: 'num-prop' },
        focus: { rowId: rowIds[3], colId: 'num-prop' },
      };

      const result = planGridFill(state, dbId, sourceRange, targetRange, 'sequence', rowIds, propIds, 4000);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.canSequence).toBe(true);
        expect(result.value.previewCells).toEqual([
          { rowId: rowIds[2], colId: 'num-prop', value: 30 },
          { rowId: rowIds[3], colId: 'num-prop', value: 40 },
        ]);
      }
    });

    it('copies a single seed and does not infer date sequences from text columns', () => {
      const { state, dbId, rowIds, propIds } = makeSyntheticState();
      const sourceRange = {
        anchor: { rowId: rowIds[0], colId: 'num-prop' },
        focus: { rowId: rowIds[0], colId: 'num-prop' },
      };
      const targetRange = {
        anchor: { rowId: rowIds[0], colId: 'num-prop' },
        focus: { rowId: rowIds[3], colId: 'num-prop' },
      };
      const oneSeed = planGridFill(state, dbId, sourceRange, targetRange, 'copy', rowIds, propIds, 4000);
      expect(oneSeed.ok).toBe(true);
      if (oneSeed.ok) {
        expect(oneSeed.value.canSequence).toBe(false);
        expect(oneSeed.value.previewCells.map((cell) => cell.value)).toEqual([10, 10, 10]);
      }

      const textSource = {
        anchor: { rowId: rowIds[0], colId: 'text-prop' },
        focus: { rowId: rowIds[1], colId: 'text-prop' },
      };
      state.pages[rowIds[0]]!.properties['text-prop'] = '2026-10-21';
      state.pages[rowIds[1]]!.properties['text-prop'] = '2026-10-22';
      const textFill = planGridFill(
        state,
        dbId,
        textSource,
        { anchor: textSource.anchor, focus: { rowId: rowIds[3], colId: 'text-prop' } },
        'sequence',
        rowIds,
        propIds,
        4000,
      );
      expect(textFill.ok).toBe(true);
      if (textFill.ok) {
        expect(textFill.value.canSequence).toBe(false);
        expect(textFill.value.previewCells.map((cell) => cell.value)).toEqual(['2026-10-21', '2026-10-22']);
      }
    });

    it('fills horizontally to the left with the correct numeric value', () => {
      const { state, dbId, rowIds } = makeSyntheticState();
      const database = state.pages[dbId]!.database!;
      database.properties.push(
        { id: 'num-before', name: 'Before', type: 'number', options: [] },
        { id: 'num-after', name: 'After', type: 'number', options: [] },
      );
      state.pages[rowIds[0]]!.properties['num-prop'] = 20;
      state.pages[rowIds[0]]!.properties['num-after'] = 30;
      state.pages[rowIds[0]]!.properties['num-before'] = 0;
      const visibleCols = ['num-before', 'num-prop', 'num-after'];
      const sourceRange = {
        anchor: { rowId: rowIds[0], colId: 'num-prop' },
        focus: { rowId: rowIds[0], colId: 'num-after' },
      };
      const targetRange = {
        anchor: sourceRange.anchor,
        focus: { rowId: rowIds[0], colId: 'num-before' },
      };
      const result = planGridFill(state, dbId, sourceRange, targetRange, 'sequence', rowIds, visibleCols, 4000);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.previewCells).toEqual([{ rowId: rowIds[0], colId: 'num-before', value: 10 }]);
      }
    });

    it('increments date sequences in UTC regardless of the local time zone', () => {
      const previousTimeZone = process.env.TZ;
      process.env.TZ = 'America/Sao_Paulo';
      try {
        const { state, dbId, rowIds, propIds } = makeSyntheticState();
        state.pages[rowIds[0]]!.properties['date-prop'] = '2026-10-21';
        state.pages[rowIds[1]]!.properties['date-prop'] = '2026-10-22';
        const sourceRange = {
          anchor: { rowId: rowIds[0], colId: 'date-prop' },
          focus: { rowId: rowIds[1], colId: 'date-prop' },
        };
        const result = planGridFill(
          state,
          dbId,
          sourceRange,
          { anchor: sourceRange.anchor, focus: { rowId: rowIds[3], colId: 'date-prop' } },
          'sequence',
          rowIds,
          propIds,
          4000,
        );
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.previewCells.map((cell) => cell.value)).toEqual(['2026-10-23', '2026-10-24']);
      } finally {
        if (previousTimeZone === undefined) delete process.env.TZ;
        else process.env.TZ = previousTimeZone;
      }
    });

    it('repeats select and relation references without inventing options or targets', () => {
      const { state, dbId, rowIds, propIds } = makeSyntheticState();
      const sourceRange = {
        anchor: { rowId: rowIds[0], colId: 'select-prop' },
        focus: { rowId: rowIds[1], colId: 'select-prop' },
      };
      const targetRange = {
        anchor: { rowId: rowIds[0], colId: 'select-prop' },
        focus: { rowId: rowIds[3], colId: 'select-prop' },
      };

      const result = planGridFill(state, dbId, sourceRange, targetRange, 'sequence', rowIds, propIds, 4000);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.canSequence).toBe(false);
        expect(result.value.previewCells).toEqual([
          { rowId: rowIds[2], colId: 'select-prop', value: 'opt-done' },
          { rowId: rowIds[3], colId: 'select-prop', value: 'opt-todo' },
        ]);
      }

      const relationSource = {
        anchor: { rowId: rowIds[0], colId: 'relation-prop' },
        focus: { rowId: rowIds[1], colId: 'relation-prop' },
      };
      const relationFill = planGridFill(
        state,
        dbId,
        relationSource,
        { anchor: relationSource.anchor, focus: { rowId: rowIds[3], colId: 'relation-prop' } },
        'sequence',
        rowIds,
        propIds,
        4000,
      );
      if (!relationFill.ok) throw new Error(relationFill.error);
      if (relationFill.ok) {
        expect(relationFill.value.canSequence).toBe(false);
        expect(relationFill.value.previewCells.map((cell) => cell.value)).toEqual([['target-1'], ['target-2']]);
      }
    });

    it('refuses fill handle into read-only columns', () => {
      const { state, dbId, rowIds, propIds } = makeSyntheticState();
      const sourceRange = {
        anchor: { rowId: rowIds[0], colId: 'formula-prop' },
        focus: { rowId: rowIds[1], colId: 'formula-prop' },
      };
      const targetRange = {
        anchor: { rowId: rowIds[0], colId: 'formula-prop' },
        focus: { rowId: rowIds[2], colId: 'formula-prop' },
      };

      const result = planGridFill(state, dbId, sourceRange, targetRange, 'copy', rowIds, propIds, 4000);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Calculated');
        expect(result.error).toContain('read-only');
      }
    });
  });
});
