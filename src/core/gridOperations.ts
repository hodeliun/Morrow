import { applyCommand } from './commands';
import type { Command } from './commands';
import type { DatabaseDef, PageId, PropDef, PropType, PropValue, WorkspaceState } from './model';
import { MAX_TITLE_LENGTH, PROP_TYPES } from './model';
import { childrenOf } from './tree';
import { TITLE_PROP, valueOf } from './database';
import {
  isNumericPropertyType,
  isValidDateKey,
  isValidDateTime,
  isValidTime,
  propertyValueError,
} from './typedValues';

export const MAX_GRID_BATCH_CELLS = 1000;
export const MAX_GRID_CLIPBOARD_CHARS = 1_000_000;
export const TITLE_PROP_ID = TITLE_PROP; // 'title'

export interface GridCoord {
  rowId: PageId;
  colId: string;
}

export interface GridRange {
  anchor: GridCoord;
  focus: GridCoord;
}

export interface ResolvedGridRange {
  rowIds: PageId[];
  colIds: string[];
  cellCount: number;
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
}

export interface GridTypedCell {
  type: PropType | 'title';
  value: PropValue;
}

export interface GridClipboardPayload {
  version: 1;
  kind: 'morrow-grid-range';
  rowCount: number;
  colCount: number;
  colTypes: Array<PropType | 'title'>;
  rows: GridTypedCell[][];
}

export interface GridClipboardEnvelope {
  version: 1;
  kind: 'morrow-grid-clipboard';
  text: string;
  payload: GridClipboardPayload;
}

export type FillModeChoice = 'copy' | 'sequence';

export interface GridOperationPlan {
  commands: Command[];
  undoCommands: Command[];
  redoCommands: Command[];
  affectedCells: number;
}

export interface GridPastePlan extends GridOperationPlan {
  createdRowIds?: PageId[];
}

export interface GridFillPlan extends GridOperationPlan {
  previewCells: Array<{ rowId: PageId; colId: string; value: PropValue }>;
  canSequence: boolean;
  detectedStep?: number;
}

export type GridResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; extraRowsNeeded?: number };

/**
 * Checks whether a column is read-only (formula, system, button, calculated fillMode).
 */
export function isColumnReadOnly(propId: string, database?: DatabaseDef | null): boolean {
  if (propId === TITLE_PROP_ID) return false;
  if (!database) return true;
  const prop = database.properties.find((p) => p.id === propId);
  if (!prop) return true;
  if (prop.type === 'formula') return true;
  if (prop.type === 'createdTime') return true;
  if (prop.type === 'lastEditedTime') return true;
  if (prop.type === 'button') return true;
  if (prop.fillMode === 'calculated') return true;
  if (prop.type === 'relation' && !prop.relation?.targetDatabaseId) return true;
  return false;
}

function gridColumnError(colId: string, database?: DatabaseDef | null): string | null {
  if (colId === TITLE_PROP_ID) return null;
  if (!database?.properties.some((property) => property.id === colId)) {
    return `Column "${colId}" is not part of this database.`;
  }
  if (isColumnReadOnly(colId, database)) {
    const propName = database.properties.find((property) => property.id === colId)?.name ?? colId;
    return `Column "${propName}" is read-only and cannot be changed in a grid batch.`;
  }
  return null;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameProperties(a: Record<string, PropValue>, b: Record<string, PropValue>): boolean {
  const propertyIds = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...propertyIds].every((propertyId) => sameValue(a[propertyId] ?? null, b[propertyId] ?? null));
}

/** Simulates the complete batch and derives an undo from the actual state diff. */
function planGridUndoCommands(
  state: WorkspaceState,
  commands: Command[],
  createdRowIds: PageId[],
  now: number,
): GridResult<Command[]> {
  let after = state;
  for (const command of commands) {
    const result = applyCommand(after, command);
    if (!result.ok) return { ok: false, error: result.error };
    after = result.value.state;
  }

  const created = new Set(createdRowIds);
  const ordinaryUndoCommands: Command[] = [];
  const ownerRelationReleases: Command[] = [];
  const ownerRelationRestores: Command[] = [];
  for (const beforePage of Object.values(state.pages)) {
    const afterPage = after.pages[beforePage.id];
    if (!afterPage || created.has(beforePage.id)) continue;

    if (beforePage.title !== afterPage.title) {
      ordinaryUndoCommands.push({ type: 'page.rename', id: beforePage.id, title: beforePage.title, now });
    }

    const parentDatabase = beforePage.parentId ? state.pages[beforePage.parentId]?.database : undefined;
    const changedValues: Record<string, PropValue> = {};
    const propertyIds = new Set([...Object.keys(beforePage.properties), ...Object.keys(afterPage.properties)]);
    for (const propertyId of propertyIds) {
      const previous = beforePage.properties[propertyId] ?? null;
      const next = afterPage.properties[propertyId] ?? null;
      if (sameValue(previous, next)) continue;

      const property = parentDatabase?.properties.find((candidate) => candidate.id === propertyId);
      if (property?.type === 'relation' && property.relation && !property.relation.isInverse) {
        ownerRelationReleases.push({
          type: 'relation.set',
          id: beforePage.id,
          propertyId,
          value: null,
          now,
        });
        ownerRelationRestores.push({
          type: 'relation.set',
          id: beforePage.id,
          propertyId,
          value: previous,
          now,
        });
      } else if (property?.type !== 'relation' || !property.relation?.isInverse) {
        changedValues[propertyId] = previous;
      }
    }
    if (Object.keys(changedValues).length > 0) {
      ordinaryUndoCommands.push({ type: 'page.setProperties', id: beforePage.id, values: changedValues, now });
    }
  }

  // Newly created rows may also hold singular relations. Release those links before
  // restoring prior owners or the undo can temporarily violate the one-row inverse.
  for (const id of createdRowIds) {
    const page = after.pages[id];
    const parentDatabase = page?.parentId ? after.pages[page.parentId]?.database : undefined;
    if (!page || !parentDatabase) continue;
    for (const property of parentDatabase.properties) {
      if (property.type !== 'relation' || property.relation?.isInverse || !property.relation?.targetDatabaseId) continue;
      const current = page.properties[property.id] ?? null;
      if (current !== null && !(Array.isArray(current) && current.length === 0)) {
        ownerRelationReleases.push({ type: 'relation.set', id, propertyId: property.id, value: null, now });
      }
    }
  }

  const undoCommands: Command[] = [...ownerRelationReleases, ...ordinaryUndoCommands, ...ownerRelationRestores];
  for (const id of [...createdRowIds].reverse()) {
    if (after.pages[id] && !state.pages[id]) undoCommands.push({ type: 'page.trash', id, now });
  }

  let restored = after;
  for (const command of undoCommands) {
    const result = applyCommand(restored, command);
    if (!result.ok) return { ok: false, error: `A safe undo could not be prepared: ${result.error}` };
    restored = result.value.state;
  }
  for (const beforePage of Object.values(state.pages)) {
    const restoredPage = restored.pages[beforePage.id];
    if (!restoredPage || restoredPage.title !== beforePage.title || !sameProperties(restoredPage.properties, beforePage.properties)) {
      return { ok: false, error: `A safe undo could not restore the original grid values on ${beforePage.id}.` };
    }
  }
  for (const id of createdRowIds) {
    if (restored.pages[id]?.trashedAt === null || !restored.pages[id]) {
      return { ok: false, error: 'A safe undo could not preserve a newly created row.' };
    }
  }

  return { ok: true, value: undoCommands };
}

/**
 * Resolves the 2D bounding rectangle between anchor and focus within visible row and column arrays.
 */
export function resolveVisibleRange(
  range: GridRange,
  visibleRowIds: PageId[],
  visibleColIds: string[],
): ResolvedGridRange | null {
  if (visibleRowIds.length === 0 || visibleColIds.length === 0) return null;

  const anchorRowIdx = visibleRowIds.indexOf(range.anchor.rowId);
  const focusRowIdx = visibleRowIds.indexOf(range.focus.rowId);
  const anchorColIdx = visibleColIds.indexOf(range.anchor.colId);
  const focusColIdx = visibleColIds.indexOf(range.focus.colId);

  if (anchorRowIdx === -1 || focusRowIdx === -1 || anchorColIdx === -1 || focusColIdx === -1) {
    return null;
  }

  const minRow = Math.min(anchorRowIdx, focusRowIdx);
  const maxRow = Math.max(anchorRowIdx, focusRowIdx);
  const minCol = Math.min(anchorColIdx, focusColIdx);
  const maxCol = Math.max(anchorColIdx, focusColIdx);

  const rowIds = visibleRowIds.slice(minRow, maxRow + 1);
  const colIds = visibleColIds.slice(minCol, maxCol + 1);
  const cellCount = rowIds.length * colIds.length;

  return { rowIds, colIds, cellCount, minRow, maxRow, minCol, maxCol };
}

/**
 * Revalidates the active cell when filters, sorting or column visibility change.
 * If the current active cell is still visible, it stays unchanged.
 * If not, repositions to the nearest visible cell.
 */
export function revalidateActiveCell(
  active: GridCoord | null,
  prevRowIds: PageId[],
  prevColIds: string[],
  nextRowIds: PageId[],
  nextColIds: string[],
): { active: GridCoord | null; moved: boolean; reason?: string } {
  if (nextRowIds.length === 0 || nextColIds.length === 0) {
    return { active: null, moved: active !== null, reason: 'Table has no visible rows or columns' };
  }
  const defaultRow = nextRowIds[0];
  const defaultCol = nextColIds[0];
  if (!defaultRow || !defaultCol) {
    return { active: null, moved: active !== null, reason: 'Table has no visible rows or columns' };
  }
  if (!active) {
    return { active: { rowId: defaultRow, colId: defaultCol }, moved: false };
  }

  const hasRow = nextRowIds.includes(active.rowId);
  const hasCol = nextColIds.includes(active.colId);

  if (hasRow && hasCol) {
    return { active, moved: false };
  }

  let targetRowIndex = prevRowIds.indexOf(active.rowId);
  if (targetRowIndex === -1) targetRowIndex = 0;
  targetRowIndex = Math.min(targetRowIndex, nextRowIds.length - 1);
  if (targetRowIndex < 0) targetRowIndex = 0;

  let targetColIndex = prevColIds.indexOf(active.colId);
  if (targetColIndex === -1) targetColIndex = 0;
  targetColIndex = Math.min(targetColIndex, nextColIds.length - 1);
  if (targetColIndex < 0) targetColIndex = 0;

  const validRow = nextRowIds[targetRowIndex] ?? defaultRow;
  const validCol = nextColIds[targetColIndex] ?? defaultCol;

  const nextActive: GridCoord = {
    rowId: validRow,
    colId: validCol,
  };

  const reason = !hasRow && !hasCol
    ? 'Active row and column are no longer visible'
    : !hasRow
      ? 'Active row is no longer visible'
      : 'Active column is no longer visible';

  return { active: nextActive, moved: true, reason };
}

/**
 * Plans a batch clear for all cells in range.
 */
export function planGridClear(
  state: WorkspaceState,
  dbId: PageId,
  range: GridRange,
  visibleRowIds: PageId[],
  visibleColIds: string[],
  now: number,
): GridResult<GridOperationPlan> {
  const resolved = resolveVisibleRange(range, visibleRowIds, visibleColIds);
  if (!resolved) {
    return { ok: false, error: 'Selection range is not visible.' };
  }

  if (resolved.cellCount > MAX_GRID_BATCH_CELLS) {
    return {
      ok: false,
      error: `Batch operation exceeds the limit of 1,000 cells (attempted: ${resolved.cellCount} cells).`,
    };
  }

  const database = state.pages[dbId]?.database;
  if (!database) return { ok: false, error: 'The target is no longer a database.' };
  for (const rowId of resolved.rowIds) {
    if (state.pages[rowId]?.parentId !== dbId) {
      return { ok: false, error: 'A selected row is no longer part of this database.' };
    }
  }

  for (const colId of resolved.colIds) {
    const error = gridColumnError(colId, database);
    if (error) return { ok: false, error };
  }

  const commands: Command[] = [];

  for (const rowId of resolved.rowIds) {
    const page = state.pages[rowId];
    if (!page) continue;

    const normalPropValues: Record<string, PropValue> = {};
    for (const colId of resolved.colIds) {
      if (colId === TITLE_PROP_ID) {
        if (page.title !== '') {
          commands.push({ type: 'page.rename', id: rowId, title: '', now });
        }
      } else {
        const prop = database?.properties.find((p) => p.id === colId);

        let emptyValue: PropValue = null;
        if (prop?.type === 'checkbox') {
          emptyValue = false;
        } else if (prop?.type === 'multiSelect') {
          emptyValue = [];
        } else if (prop?.type === 'relation') {
          emptyValue = prop.relation?.multiple ? [] : null;
        }

        if (prop?.type === 'relation') {
          commands.push({ type: 'relation.set', id: rowId, propertyId: colId, value: emptyValue, now });
        } else {
          normalPropValues[colId] = emptyValue;
        }
      }
    }

    if (Object.keys(normalPropValues).length > 0) {
      commands.push({ type: 'page.setProperties', id: rowId, values: normalPropValues, now });
    }
  }

  const undo = planGridUndoCommands(state, commands, [], now);
  if (!undo.ok) return undo;

  return {
    ok: true,
    value: {
      commands,
      undoCommands: undo.value,
      redoCommands: [...commands],
      affectedCells: resolved.cellCount,
    },
  };
}

/**
 * Serializes cell range to TSV and typed JSON payload.
 */
export function serializeGridClipboard(
  state: WorkspaceState,
  dbId: PageId,
  range: GridRange,
  visibleRowIds: PageId[],
  visibleColIds: string[],
): GridResult<{ tsv: string; payload: GridClipboardPayload; cellCount: number }> {
  const resolved = resolveVisibleRange(range, visibleRowIds, visibleColIds);
  if (!resolved) {
    return { ok: false, error: 'Selection range is not visible.' };
  }

  if (resolved.cellCount > MAX_GRID_BATCH_CELLS) {
    return {
      ok: false,
      error: `Batch operation exceeds the limit of 1,000 cells (attempted: ${resolved.cellCount} cells).`,
    };
  }

  const database = state.pages[dbId]?.database;
  const colTypes: Array<PropType | 'title'> = resolved.colIds.map((colId) => {
    if (colId === TITLE_PROP_ID) return 'title';
    return database?.properties.find((p) => p.id === colId)?.type ?? 'text';
  });

  const rowsData: GridTypedCell[][] = [];
  const tsvLines: string[] = [];

  for (const rowId of resolved.rowIds) {
    const page = state.pages[rowId];
    if (!page) continue;

    const rowCells: GridTypedCell[] = [];
    const tsvRowValues: string[] = [];

    for (let c = 0; c < resolved.colIds.length; c++) {
      const colId = resolved.colIds[c]!;
      const type = colTypes[c] ?? 'text';
      let val: PropValue;

      if (colId === TITLE_PROP_ID) {
        val = page.title;
      } else {
        val = valueOf(page, colId, database ?? undefined, state);
      }

      rowCells.push({ type, value: val });

      let cellStr: string;
      if (val === null || val === undefined) {
        cellStr = '';
      } else if (typeof val === 'boolean') {
        cellStr = val ? 'true' : 'false';
      } else if (typeof val === 'number') {
        cellStr = String(val);
      } else if (Array.isArray(val)) {
        cellStr = val.join(', ');
      } else {
        cellStr = String(val);
      }

      if (cellStr.includes('\t') || cellStr.includes('\n') || cellStr.includes('\r') || cellStr.includes('"')) {
        cellStr = `"${cellStr.replace(/"/g, '""')}"`;
      }
      tsvRowValues.push(cellStr);
    }

    rowsData.push(rowCells);
    tsvLines.push(tsvRowValues.join('\t'));
  }

  const payload: GridClipboardPayload = {
    version: 1,
    kind: 'morrow-grid-range',
    rowCount: rowsData.length,
    colCount: resolved.colIds.length,
    colTypes,
    rows: rowsData,
  };

  return {
    ok: true,
    value: {
      tsv: tsvLines.join('\n'),
      payload,
      cellCount: resolved.cellCount,
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isPropValue(value: unknown): value is PropValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (Array.isArray(value) && value.length <= 200 && value.every((item) => typeof item === 'string'))
  );
}

function clipboardValueMatchesType(type: PropType | 'title', value: PropValue): boolean {
  if (value === null || type === 'formula') return true;
  if (type === 'title' || ['text', 'email', 'url', 'phone', 'select', 'date', 'time', 'datetime', 'richCanvas'].includes(type))
    return typeof value === 'string';
  if (isNumericPropertyType(type) || type === 'createdTime' || type === 'lastEditedTime')
    return typeof value === 'number' && Number.isFinite(value);
  if (type === 'checkbox') return typeof value === 'boolean';
  if (type === 'multiSelect' || type === 'relation' || type === 'image' || type === 'file')
    return typeof value === 'string' || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
  if (type === 'button') return value === null;
  return false;
}

/** Checks every field before a typed payload can reach a grid operation. */
export function validateGridClipboardPayload(value: unknown): GridResult<GridClipboardPayload> {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ['version', 'kind', 'rowCount', 'colCount', 'colTypes', 'rows']) ||
    value.version !== 1 ||
    value.kind !== 'morrow-grid-range'
  ) {
    return { ok: false, error: 'Clipboard data is not a supported Morrow grid payload.' };
  }
  const rowCount = value.rowCount;
  const colCount = value.colCount;
  const colTypes = value.colTypes;
  const rows = value.rows;
  if (
    !Number.isInteger(rowCount) ||
    (rowCount as number) < 1 ||
    !Number.isInteger(colCount) ||
    (colCount as number) < 1 ||
    !Array.isArray(colTypes) ||
    !Array.isArray(rows) ||
    rows.length !== rowCount ||
    colTypes.length !== colCount ||
    (rowCount as number) * (colCount as number) > MAX_GRID_BATCH_CELLS
  ) {
    return { ok: false, error: 'Clipboard action exceeds the 1,000-cell limit or has invalid dimensions.' };
  }

  const acceptedTypes = new Set<PropType | 'title'>(['title', ...PROP_TYPES]);
  const normalizedTypes: Array<PropType | 'title'> = [];
  for (const type of colTypes) {
    if (typeof type !== 'string' || !acceptedTypes.has(type as PropType | 'title')) {
      return { ok: false, error: 'Clipboard contains an unsupported column type.' };
    }
    normalizedTypes.push(type as PropType | 'title');
  }

  const normalizedRows: GridTypedCell[][] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (!Array.isArray(row) || row.length !== colCount) {
      return { ok: false, error: `Clipboard row ${rowIndex + 1} does not match its declared width.` };
    }
    const normalizedRow: GridTypedCell[] = [];
    for (let colIndex = 0; colIndex < row.length; colIndex++) {
      const cell = row[colIndex];
      if (
        !isPlainObject(cell) ||
        !hasOnlyKeys(cell, ['type', 'value']) ||
        typeof cell.type !== 'string' ||
        !acceptedTypes.has(cell.type as PropType | 'title')
      ) {
        return { ok: false, error: `Clipboard cell ${rowIndex + 1}, ${colIndex + 1} has an invalid type.` };
      }
      if (!isPropValue(cell.value)) {
        return { ok: false, error: `Clipboard cell ${rowIndex + 1}, ${colIndex + 1} has an unsupported value.` };
      }
      const columnType = normalizedTypes[colIndex];
      if (cell.type !== columnType || !clipboardValueMatchesType(cell.type as PropType | 'title', cell.value)) {
        return { ok: false, error: `Clipboard cell ${rowIndex + 1}, ${colIndex + 1} does not match its column type.` };
      }
      normalizedRow.push({ type: cell.type as PropType | 'title', value: cell.value });
    }
    normalizedRows.push(normalizedRow);
  }

  return {
    ok: true,
    value: {
      version: 1,
      kind: 'morrow-grid-range',
      rowCount: rowCount as number,
      colCount: colCount as number,
      colTypes: normalizedTypes,
      rows: normalizedRows,
    },
  };
}

/** Keeps typed clipboard data tied to the TSV copied in the same system clipboard item. */
export function validateGridClipboardEnvelope(
  value: unknown,
  text: string,
): GridResult<GridClipboardPayload> {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ['version', 'kind', 'text', 'payload']) ||
    value.version !== 1 ||
    value.kind !== 'morrow-grid-clipboard' ||
    typeof value.text !== 'string' ||
    value.text.length > MAX_GRID_CLIPBOARD_CHARS ||
    value.text.replace(/\r\n?/g, '\n') !== text.replace(/\r\n?/g, '\n')
  ) {
    return { ok: false, error: 'Morrow clipboard data no longer matches the system clipboard text.' };
  }
  return validateGridClipboardPayload(value.payload);
}

/**
 * Parses typed Morrow JSON or a TSV matrix. Plain TSV cells stay strings so text
 * such as "00123" and "=name" is preserved until the destination type is known.
 */
export function parseGridClipboard(text: string): GridResult<GridClipboardPayload> {
  if (text.length > MAX_GRID_CLIPBOARD_CHARS) {
    return { ok: false, error: 'Clipboard content exceeds the 1 MB safety limit.' };
  }

  const trimmedStart = text.trimStart();
  if (trimmedStart.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isPlainObject(parsed) && parsed.kind === 'morrow-grid-range') {
        return validateGridClipboardPayload(parsed);
      }
    } catch {
      // A normal text cell can begin with a brace; keep treating non-payload text as TSV.
      if (trimmedStart.includes('morrow-grid-range')) {
        return { ok: false, error: 'Morrow grid clipboard data is not valid JSON.' };
      }
    }
  }

  const matrix: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let closedQuote = false;
  let endedWithRecordSeparator = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          inQuotes = false;
          closedQuote = true;
        }
      } else {
        field += char;
      }
      endedWithRecordSeparator = false;
      continue;
    }

    if (closedQuote && char !== '\t' && char !== '\r' && char !== '\n') {
      return { ok: false, error: 'Clipboard TSV has characters after a quoted cell.' };
    }
    if (char === '"' && field.length === 0 && !closedQuote) {
      inQuotes = true;
      endedWithRecordSeparator = false;
    } else if (char === '\t') {
      row.push(field);
      if (row.length > MAX_GRID_BATCH_CELLS) {
        return { ok: false, error: 'Clipboard action exceeds the 1,000-cell limit.' };
      }
      field = '';
      closedQuote = false;
      endedWithRecordSeparator = false;
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[index + 1] === '\n') index++;
      row.push(field);
      if (row.length > MAX_GRID_BATCH_CELLS || matrix.length >= MAX_GRID_BATCH_CELLS) {
        return { ok: false, error: 'Clipboard action exceeds the 1,000-cell limit.' };
      }
      matrix.push(row);
      row = [];
      field = '';
      closedQuote = false;
      endedWithRecordSeparator = true;
    } else {
      field += char;
      endedWithRecordSeparator = false;
    }
  }

  if (inQuotes) return { ok: false, error: 'Clipboard TSV has an unclosed quoted cell.' };
  if (!endedWithRecordSeparator || row.length > 0 || field.length > 0 || text.length === 0) {
    row.push(field);
    if (row.length > MAX_GRID_BATCH_CELLS || matrix.length >= MAX_GRID_BATCH_CELLS) {
      return { ok: false, error: 'Clipboard action exceeds the 1,000-cell limit.' };
    }
    matrix.push(row);
  }
  let colCount = 1;
  for (const cells of matrix) colCount = Math.max(colCount, cells.length);
  if (matrix.length * colCount > MAX_GRID_BATCH_CELLS) {
    return { ok: false, error: 'Clipboard action exceeds the 1,000-cell limit.' };
  }
  const payload: GridClipboardPayload = {
    version: 1,
    kind: 'morrow-grid-range',
    rowCount: matrix.length,
    colCount,
    colTypes: Array(colCount).fill('text'),
    rows: matrix.map((cells) =>
      Array.from({ length: colCount }, (_, colIndex) => ({ type: 'text' as const, value: cells[colIndex] ?? '' })),
    ),
  };
  return { ok: true, value: payload };
}

function matchingOption(value: string, prop: PropDef): { id: string; ambiguous: boolean } | null {
  const byId = prop.options.filter((option) => option.id === value);
  if (byId.length === 1) return { id: byId[0]!.id, ambiguous: false };
  const normalized = value.trim().toLocaleLowerCase();
  const byName = prop.options.filter((option) => option.name.trim().toLocaleLowerCase() === normalized);
  if (byName.length === 1) return { id: byName[0]!.id, ambiguous: false };
  return byName.length > 1 ? { id: '', ambiguous: true } : null;
}

/** Converts one source value for a destination without silently replacing invalid input. */
export function coerceValueForProperty(
  sourceVal: PropValue,
  destType: PropType | 'title',
  destProp?: PropDef,
  sourceType?: PropType | 'title',
): GridResult<PropValue> {
  if (sourceVal === null || sourceVal === '') {
    if (destType === 'checkbox') return { ok: true, value: false };
    if (destType === 'title') return { ok: true, value: '' };
    if (destType === 'multiSelect' || (destType === 'relation' && destProp?.relation?.multiple))
      return { ok: true, value: [] };
    return { ok: true, value: null };
  }

  let converted: PropValue;
  if (destType === 'title' || ['text', 'email', 'url', 'phone'].includes(destType)) {
    if (Array.isArray(sourceVal)) {
      return { ok: false, error: `A list cannot be pasted into ${destType === 'title' ? 'the title' : 'text'}.` };
    }
    converted = String(sourceVal);
    if (destType === 'title' && /[\r\n\t]/.test(converted)) {
      return { ok: false, error: 'A title cannot contain line breaks or tabs.' };
    }
    if (destType === 'title' && [...converted].length > MAX_TITLE_LENGTH) {
      return { ok: false, error: `A title cannot exceed ${MAX_TITLE_LENGTH} characters.` };
    }
  } else if (destType === 'checkbox') {
    if (typeof sourceVal === 'boolean') converted = sourceVal;
    else if (sourceVal === 1 || sourceVal === '1' || (typeof sourceVal === 'string' && sourceVal.toLocaleLowerCase() === 'true')) converted = true;
    else if (sourceVal === 0 || sourceVal === '0' || (typeof sourceVal === 'string' && sourceVal.toLocaleLowerCase() === 'false')) converted = false;
    else return { ok: false, error: 'Use true or false for a checkbox.' };
  } else if (isNumericPropertyType(destType)) {
    if (typeof sourceVal === 'number' && Number.isFinite(sourceVal)) converted = sourceVal;
    else if (typeof sourceVal === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(sourceVal.trim())) {
      const number = Number(sourceVal.trim());
      if (!Number.isFinite(number)) return { ok: false, error: 'The value must be a finite number.' };
      converted = number;
    } else return { ok: false, error: 'The value is not a valid number.' };
  } else if (destType === 'date' || destType === 'time' || destType === 'datetime') {
    if (typeof sourceVal !== 'string') return { ok: false, error: 'The value does not match the date or time format.' };
    converted = sourceVal;
  } else if (destType === 'select') {
    if (typeof sourceVal !== 'string' || !destProp) return { ok: false, error: 'The value does not match a configured option.' };
    const option = matchingOption(sourceVal, destProp);
    if (!option || option.ambiguous) return { ok: false, error: 'Choose one unambiguous configured option.' };
    converted = option.id;
  } else if (destType === 'multiSelect') {
    if (!destProp || (!Array.isArray(sourceVal) && typeof sourceVal !== 'string'))
      return { ok: false, error: 'The value does not match configured options.' };
    const rawItems = Array.isArray(sourceVal)
      ? sourceVal
      : matchingOption(sourceVal, destProp)
        ? [sourceVal]
        : sourceType === 'text'
          ? sourceVal.split(',').map((item) => item.trim())
          : [sourceVal];
    const resolvedIds: string[] = [];
    for (const item of rawItems) {
      if (typeof item !== 'string') return { ok: false, error: 'A multi-select option must be text.' };
      const option = matchingOption(item, destProp);
      if (!option || option.ambiguous) return { ok: false, error: `Option "${item}" is not uniquely configured.` };
      if (!resolvedIds.includes(option.id)) resolvedIds.push(option.id);
    }
    converted = resolvedIds;
  } else if (destType === 'relation') {
    if (!destProp?.relation?.targetDatabaseId || (!Array.isArray(sourceVal) && typeof sourceVal !== 'string'))
      return { ok: false, error: 'The relation is not configured for a compatible row reference.' };
    const relationIds = Array.isArray(sourceVal)
      ? sourceVal
      : sourceType === 'text' && destProp.relation.multiple && sourceVal.includes(',')
        ? sourceVal.split(',').map((id) => id.trim())
        : [sourceVal];
    if (relationIds.some((id) => !id.trim())) return { ok: false, error: 'The relation contains an empty row id.' };
    if (!destProp.relation.multiple && relationIds.length > 1)
      return { ok: false, error: 'This relation accepts only one row.' };
    converted = relationIds.length === 0
      ? destProp.relation.multiple ? [] : null
      : destProp.relation.multiple
        ? [...new Set(relationIds)]
        : relationIds[0]!;
  } else {
    converted = sourceVal;
  }

  if (destType === 'date' && (typeof converted !== 'string' || !isValidDateKey(converted)))
    return { ok: false, error: 'The value is not a real calendar date.' };
  if (destType === 'time' && (typeof converted !== 'string' || !isValidTime(converted)))
    return { ok: false, error: 'The value is not a valid time.' };
  if (destType === 'datetime' && (typeof converted !== 'string' || !isValidDateTime(converted)))
    return { ok: false, error: 'The value is not a valid date and time with a timezone.' };
  if (destProp) {
    const invalid = propertyValueError(destProp, converted);
    if (invalid) return { ok: false, error: invalid };
  }
  return { ok: true, value: converted };
}

/**
 * Plans pasting a clipboard payload into the target grid.
 */
export function planGridPaste(
  state: WorkspaceState,
  dbId: PageId,
  targetRange: GridRange,
  payload: GridClipboardPayload,
  visibleRowIds: PageId[],
  visibleColIds: string[],
  now: number,
  options?: {
    allowCreateRows?: boolean;
    newRowIdFactory?: () => PageId;
  },
): GridResult<GridPastePlan> {
  if (visibleRowIds.length === 0 || visibleColIds.length === 0) {
    return { ok: false, error: 'Table has no visible rows or columns.' };
  }
  const validatedPayload = validateGridClipboardPayload(payload);
  if (!validatedPayload.ok) return validatedPayload;
  payload = validatedPayload.value;
  const database = state.pages[dbId]?.database;
  if (!database) return { ok: false, error: 'The target is no longer a database.' };
  const startRowIdx = visibleRowIds.indexOf(targetRange.anchor.rowId);
  const startColIdx = visibleColIds.indexOf(targetRange.anchor.colId);

  if (startRowIdx === -1 || startColIdx === -1) {
    return { ok: false, error: 'Active cell is not visible.' };
  }

  const isOneByOne = payload.rowCount === 1 && payload.colCount === 1;
  const resolvedTarget = resolveVisibleRange(targetRange, visibleRowIds, visibleColIds);

  let destRowIds: PageId[];
  let destColIds: string[];
  let extraRowsNeeded = 0;
  const createdRowIds: PageId[] = [];

  if (isOneByOne && resolvedTarget && resolvedTarget.cellCount > 1) {
    destRowIds = resolvedTarget.rowIds;
    destColIds = resolvedTarget.colIds;
  } else {
    const matrixRows = payload.rowCount;
    const matrixCols = payload.colCount;

    if (startColIdx + matrixCols > visibleColIds.length) {
      return {
        ok: false,
        error: `Paste extends beyond visible columns (${startColIdx + matrixCols} needed, ${visibleColIds.length} visible).`,
      };
    }

    destColIds = visibleColIds.slice(startColIdx, startColIdx + matrixCols);

    const neededRows = startRowIdx + matrixRows;
    if (neededRows > visibleRowIds.length) {
      extraRowsNeeded = neededRows - visibleRowIds.length;
      if (!options?.allowCreateRows) {
        return {
          ok: false,
          error: `Paste requires creating ${extraRowsNeeded} new row${extraRowsNeeded > 1 ? 's' : ''}. Confirmation required.`,
          extraRowsNeeded,
        };
      }
    }

    destRowIds = visibleRowIds.slice(startRowIdx, startRowIdx + matrixRows);
  }

  const totalCells = (destRowIds.length + extraRowsNeeded) * destColIds.length;
  if (totalCells > MAX_GRID_BATCH_CELLS) {
    return {
      ok: false,
      error: `Batch operation exceeds the limit of 1,000 cells (attempted: ${totalCells} cells).`,
    };
  }

  for (const colId of destColIds) {
    const error = gridColumnError(colId, database);
    if (error) return { ok: false, error };
  }
  for (const rowId of destRowIds) {
    if (state.pages[rowId] && state.pages[rowId]?.parentId !== dbId) {
      return { ok: false, error: 'A destination row is no longer part of this database.' };
    }
  }

  const singleCell = isOneByOne ? payload.rows[0]?.[0] : null;
  const convertedRows: PropValue[][] = [];
  for (let r = 0; r < destRowIds.length + (options?.allowCreateRows ? extraRowsNeeded : 0); r++) {
    const convertedRow: PropValue[] = [];
    for (let c = 0; c < destColIds.length; c++) {
      const colId = destColIds[c]!;
      const sourceRow = payload.rows[r % payload.rowCount];
      const sourceCell = singleCell ?? sourceRow?.[c % payload.colCount];
      if (!sourceCell) return { ok: false, error: `Clipboard cell ${r + 1}, ${c + 1} is missing.` };
      const destProp = database.properties.find((property) => property.id === colId);
      const destType = colId === TITLE_PROP_ID ? 'title' : destProp!.type;
      const converted = coerceValueForProperty(sourceCell.value, destType, destProp, sourceCell.type);
      const rowId = destRowIds[r];
      const rowTitle = rowId ? state.pages[rowId]?.title : undefined;
      const columnName = colId === TITLE_PROP_ID ? 'Name' : destProp?.name ?? colId;
      if (!converted.ok) {
        return {
          ok: false,
          error: `Cell ${r + 1}${rowTitle ? ` ("${rowTitle}")` : ''}, column "${columnName}": ${converted.error}`,
        };
      }

      if (destType === 'relation' && converted.value !== null) {
        const targetDatabaseId = destProp?.relation?.targetDatabaseId;
        const targetRows = targetDatabaseId ? childrenOf(state.pages, targetDatabaseId) : [];
        const validIds = new Set(targetRows.map((row) => row.id));
        const ids = Array.isArray(converted.value) ? converted.value : [converted.value];
        if (ids.some((id) => typeof id !== 'string' || !validIds.has(id))) {
          return {
            ok: false,
            error: `Cell ${r + 1}${rowTitle ? ` ("${rowTitle}")` : ''}, column "${columnName}": relation rows must belong to the configured target database.`,
          };
        }
      }
      convertedRow.push(converted.value);
    }
    convertedRows.push(convertedRow);
  }

  const commands: Command[] = [];

  if (extraRowsNeeded > 0 && options?.allowCreateRows) {
    const idFactory = options.newRowIdFactory ?? (() => `row-${Math.random().toString(36).slice(2, 10)}`);
    for (let r = 0; r < extraRowsNeeded; r++) {
      let newId: PageId;
      try {
        newId = idFactory();
      } catch {
        return { ok: false, error: 'Could not create a unique id for a new row.' };
      }
      if (
        typeof newId !== 'string' ||
        newId.length === 0 ||
        newId.length > 64 ||
        state.pages[newId] ||
        createdRowIds.includes(newId)
      ) {
        return { ok: false, error: 'Could not create a unique id for a new row.' };
      }
      createdRowIds.push(newId);
      destRowIds.push(newId);
      commands.push({
        type: 'page.create',
        id: newId,
        parentId: dbId,
        now,
        title: '',
        properties: {},
      });
    }
  }

  for (let r = 0; r < destRowIds.length; r++) {
    const rowId = destRowIds[r];
    if (!rowId) continue;

    const normalPropValues: Record<string, PropValue> = {};

    for (let c = 0; c < destColIds.length; c++) {
      const colId = destColIds[c];
      if (!colId) continue;
      const destProp = database?.properties.find((p) => p.id === colId);
      const destType = colId === TITLE_PROP_ID ? 'title' : destProp!.type;
      const convertedVal = convertedRows[r]?.[c] ?? null;

      if (colId === TITLE_PROP_ID) {
        commands.push({ type: 'page.rename', id: rowId, title: String(convertedVal), now });
      } else if (destType === 'relation') {
        commands.push({ type: 'relation.set', id: rowId, propertyId: colId, value: convertedVal, now });
      } else {
        normalPropValues[colId] = convertedVal;
      }
    }

    if (Object.keys(normalPropValues).length > 0) {
      commands.push({ type: 'page.setProperties', id: rowId, values: normalPropValues, now });
    }
  }

  const undo = planGridUndoCommands(state, commands, createdRowIds, now);
  if (!undo.ok) return undo;

  return {
    ok: true,
    value: {
      commands,
      undoCommands: undo.value,
      affectedCells: totalCells,
      createdRowIds: createdRowIds.length > 0 ? createdRowIds : undefined,
      redoCommands: commands.map((command) =>
        command.type === 'page.create' ? { type: 'page.restore', id: command.id } : command,
      ),
    },
  };
}

function dateDifferenceInDays(d1: string, d2: string): number | null {
  if (!isValidDateKey(d1) || !isValidDateKey(d2)) return null;
  const [y1, m1, day1] = d1.split('-').map(Number);
  const [y2, m2, day2] = d2.split('-').map(Number);
  const first = new Date(0);
  first.setUTCHours(0, 0, 0, 0);
  first.setUTCFullYear(y1!, m1! - 1, day1!);
  const second = new Date(0);
  second.setUTCHours(0, 0, 0, 0);
  second.setUTCFullYear(y2!, m2! - 1, day2!);
  const t1 = first.getTime();
  const t2 = second.getTime();
  return (t2 - t1) / 86_400_000;
}

function addDaysToDateKey(d: string, days: number): string {
  const [year, month, day] = d.split('-').map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year!, month! - 1, day! + days);
  return date.toISOString().slice(0, 10);
}

function propTypeForColumn(colId: string, database: DatabaseDef): PropType | 'title' | null {
  if (colId === TITLE_PROP_ID) return 'title';
  return database.properties.find((property) => property.id === colId)?.type ?? null;
}

function canSequenceType(type: PropType | 'title' | null): boolean {
  return type === 'date' || (type !== null && type !== 'title' && isNumericPropertyType(type));
}

function sequenceForColumn(values: PropValue[], type: PropType | 'title' | null) {
  return canSequenceType(type) ? detectArithmeticSequence(values) : { canSequence: false as const };
}

function validateRelationFillValue(
  state: WorkspaceState,
  prop: PropDef,
  value: PropValue,
): string | null {
  if (value === null) return null;
  const targetId = prop.relation?.targetDatabaseId;
  const targets = targetId ? new Set(childrenOf(state.pages, targetId).map((page) => page.id)) : new Set<string>();
  const ids = Array.isArray(value) ? value : [value];
  return ids.every((id) => typeof id === 'string' && targets.has(id))
    ? null
    : `Relation values for "${prop.name}" must belong to its target database.`;
}

/**
 * Detects if a sequence of values forms a constant arithmetic progression.
 */
export function detectArithmeticSequence(values: PropValue[]): { canSequence: boolean; step?: number } {
  if (values.length < 2) return { canSequence: false };

  const allNumbers = values.every((v) => typeof v === 'number' && Number.isFinite(v));
  if (allNumbers) {
    const nums = values as number[];
    const first = nums[0];
    const second = nums[1];
    if (first === undefined || second === undefined) return { canSequence: false };
    const step = second - first;
    for (let i = 2; i < nums.length; i++) {
      const prev = nums[i - 1];
      const cur = nums[i];
      if (prev === undefined || cur === undefined) return { canSequence: false };
      const difference = cur - prev;
      const tolerance = Number.EPSILON * 8 * Math.max(1, Math.abs(cur), Math.abs(prev), Math.abs(step));
      if (Math.abs(difference - step) > tolerance) return { canSequence: false };
    }
    return { canSequence: true, step };
  }

  const allDates = values.every((v) => typeof v === 'string' && isValidDateKey(v));
  if (allDates) {
    const dates = values as string[];
    const first = dates[0];
    const second = dates[1];
    if (!first || !second) return { canSequence: false };
    const stepDays = dateDifferenceInDays(first, second);
    if (stepDays === null) return { canSequence: false };
    for (let i = 2; i < dates.length; i++) {
      const prev = dates[i - 1];
      const cur = dates[i];
      if (!prev || !cur || dateDifferenceInDays(prev, cur) !== stepDays) return { canSequence: false };
    }
    return { canSequence: true, step: stepDays };
  }

  return { canSequence: false };
}

/**
 * Plans fill handle drag operation across rows or columns.
 */
export function planGridFill(
  state: WorkspaceState,
  dbId: PageId,
  sourceRange: GridRange,
  targetRange: GridRange,
  mode: FillModeChoice,
  visibleRowIds: PageId[],
  visibleColIds: string[],
  now: number,
  options?: { prepareUndo?: boolean },
): GridResult<GridFillPlan> {
  const database = state.pages[dbId]?.database;
  if (!database) return { ok: false, error: 'The target is no longer a database.' };
  const resolvedSource = resolveVisibleRange(sourceRange, visibleRowIds, visibleColIds);
  const resolvedTarget = resolveVisibleRange(targetRange, visibleRowIds, visibleColIds);

  if (!resolvedSource || !resolvedTarget) {
    return { ok: false, error: 'Source or target range is not visible.' };
  }

  const extendsUp = resolvedTarget.minRow < resolvedSource.minRow;
  const extendsDown = resolvedTarget.maxRow > resolvedSource.maxRow;
  const extendsLeft = resolvedTarget.minCol < resolvedSource.minCol;
  const extendsRight = resolvedTarget.maxCol > resolvedSource.maxCol;
  const isVertical = extendsUp || extendsDown;
  const isHorizontal = extendsLeft || extendsRight;

  if (!isVertical && !isHorizontal) {
    return { ok: false, error: 'Fill target must extend beyond source range.' };
  }
  if ((extendsUp && extendsDown) || (extendsLeft && extendsRight) || (isVertical && isHorizontal)) {
    return { ok: false, error: 'Fill one direction at a time.' };
  }
  if (
    (isVertical && (resolvedTarget.minCol !== resolvedSource.minCol || resolvedTarget.maxCol !== resolvedSource.maxCol)) ||
    (isHorizontal && (resolvedTarget.minRow !== resolvedSource.minRow || resolvedTarget.maxRow !== resolvedSource.maxRow))
  ) {
    return { ok: false, error: 'Fill target must align with the source range.' };
  }

  const targetRowIds = resolvedTarget.rowIds.filter((id) => !resolvedSource.rowIds.includes(id));
  const targetColIds = resolvedTarget.colIds.filter((id) => !resolvedSource.colIds.includes(id));

  const affectedRows = isVertical ? targetRowIds : resolvedSource.rowIds;
  const affectedCols = isVertical ? resolvedSource.colIds : targetColIds;
  const totalAffected = affectedRows.length * affectedCols.length;

  if (totalAffected > MAX_GRID_BATCH_CELLS) {
    return {
      ok: false,
      error: `Batch operation exceeds the limit of 1,000 cells (attempted: ${totalAffected} cells).`,
    };
  }

  for (const rowId of [...resolvedSource.rowIds, ...affectedRows]) {
    if (state.pages[rowId]?.parentId !== dbId) {
      return { ok: false, error: 'A fill row is no longer part of this database.' };
    }
  }
  for (const colId of affectedCols) {
    const error = gridColumnError(colId, database);
    if (error) return { ok: false, error };
  }

  let overallCanSequence = false;
  let overallStep: number | undefined;

  const previewCells: Array<{ rowId: PageId; colId: string; value: PropValue }> = [];
  const commands: Command[] = [];

  if (isVertical) {
    for (const colId of affectedCols) {
      const sourceValues: PropValue[] = resolvedSource.rowIds.map((rId) => {
        const page = state.pages[rId];
        if (!page) return null;
        if (colId === TITLE_PROP_ID) return page.title;
        return valueOf(page, colId, database ?? undefined, state);
      });

      const sourceType = propTypeForColumn(colId, database);
      const seq = sequenceForColumn(sourceValues, sourceType);
      if (seq.canSequence) {
        overallCanSequence = true;
        overallStep ??= seq.step;
      }

      const isDownward = extendsDown;
      const destProp = database.properties.find((property) => property.id === colId);

      for (let i = 0; i < targetRowIds.length; i++) {
        const targetRowId = targetRowIds[i];
        if (!targetRowId) continue;
        const page = state.pages[targetRowId];
        if (!page) return { ok: false, error: 'A fill target row no longer exists.' };

        let nextVal: PropValue = null;

        if (seq.canSequence && mode === 'sequence') {
          const step = seq.step!;
          const lastVal = isDownward ? sourceValues[sourceValues.length - 1] : sourceValues[0];
          const dist = isDownward ? i + 1 : -(targetRowIds.length - i);

          if (typeof lastVal === 'number') {
            nextVal = lastVal + step * dist;
          } else if (typeof lastVal === 'string' && isValidDateKey(lastVal)) {
            nextVal = addDaysToDateKey(lastVal, step * dist);
          }
        } else {
          const idx = i % sourceValues.length;
          nextVal = sourceValues[idx] ?? null;
        }

        const converted = coerceValueForProperty(nextVal, sourceType ?? 'text', destProp, sourceType ?? 'text');
        if (!converted.ok) {
          const propName = colId === TITLE_PROP_ID ? 'Name' : destProp?.name ?? colId;
          return { ok: false, error: `Fill into row ${i + 1}, column "${propName}": ${converted.error}` };
        }
        nextVal = converted.value;
        if (destProp?.type === 'relation') {
          const relationError = validateRelationFillValue(state, destProp, nextVal);
          if (relationError) return { ok: false, error: relationError };
        }

        previewCells.push({ rowId: targetRowId, colId, value: nextVal });

        if (colId === TITLE_PROP_ID) {
          commands.push({ type: 'page.rename', id: targetRowId, title: String(nextVal ?? ''), now });
        } else {
          const prop = database?.properties.find((p) => p.id === colId);
          if (prop?.type === 'relation') {
            commands.push({ type: 'relation.set', id: targetRowId, propertyId: colId, value: nextVal, now });
          } else {
            commands.push({ type: 'page.setProperties', id: targetRowId, values: { [colId]: nextVal }, now });
          }
        }
      }
    }
  } else {
    for (const rowId of affectedRows) {
      const page = state.pages[rowId];
      if (!page) continue;

      const sourceValues: PropValue[] = resolvedSource.colIds.map((cId) => {
        if (cId === TITLE_PROP_ID) return page.title;
        return valueOf(page, cId, database ?? undefined, state);
      });

      const sourceTypes = resolvedSource.colIds.map((colId) => propTypeForColumn(colId, database));
      const targetTypes = affectedCols.map((colId) => propTypeForColumn(colId, database));
      const numericSequence =
        sourceTypes.every((type) => type !== null && type !== 'title' && isNumericPropertyType(type)) &&
        targetTypes.every((type) => type !== null && type !== 'title' && isNumericPropertyType(type));
      const dateSequence = sourceTypes.every((type) => type === 'date') && targetTypes.every((type) => type === 'date');
      const seq = numericSequence || dateSequence ? detectArithmeticSequence(sourceValues) : { canSequence: false as const };
      if (seq.canSequence) {
        overallCanSequence = true;
        overallStep ??= seq.step;
      }

      const isRightward = extendsRight;

      for (let j = 0; j < targetColIds.length; j++) {
        const targetColId = targetColIds[j];
        if (!targetColId) continue;
        const destProp = database.properties.find((property) => property.id === targetColId);
        let nextVal: PropValue = null;

        if (seq.canSequence && mode === 'sequence') {
          const step = seq.step!;
          const lastVal = isRightward ? sourceValues[sourceValues.length - 1] : sourceValues[0];
          const dist = isRightward ? j + 1 : -(targetColIds.length - j);
          if (typeof lastVal === 'number') {
            nextVal = lastVal + step * dist;
          } else if (typeof lastVal === 'string' && isValidDateKey(lastVal)) {
            nextVal = addDaysToDateKey(lastVal, step * dist);
          }
        } else {
          const idx = j % sourceValues.length;
          nextVal = sourceValues[idx] ?? null;
        }

        const sourceType = sourceTypes[j % sourceTypes.length] ?? 'text';
        const destType = propTypeForColumn(targetColId, database);
        if (!destType) return { ok: false, error: `Column "${targetColId}" is not part of this database.` };
        const converted = coerceValueForProperty(nextVal, destType, destProp, sourceType);
        if (!converted.ok) {
          const propName = destProp?.name ?? targetColId;
          return { ok: false, error: `Fill into column "${propName}": ${converted.error}` };
        }
        nextVal = converted.value;
        if (destProp?.type === 'relation') {
          const relationError = validateRelationFillValue(state, destProp, nextVal);
          if (relationError) return { ok: false, error: relationError };
        }

        previewCells.push({ rowId, colId: targetColId, value: nextVal });

        if (targetColId === TITLE_PROP_ID) {
          commands.push({ type: 'page.rename', id: rowId, title: String(nextVal ?? ''), now });
        } else {
          const prop = database?.properties.find((p) => p.id === targetColId);
          if (prop?.type === 'relation') {
            commands.push({ type: 'relation.set', id: rowId, propertyId: targetColId, value: nextVal, now });
          } else {
            commands.push({ type: 'page.setProperties', id: rowId, values: { [targetColId]: nextVal }, now });
          }
        }
      }
    }
  }

  let undoCommands: Command[] = [];
  if (options?.prepareUndo !== false) {
    const undo = planGridUndoCommands(state, commands, [], now);
    if (!undo.ok) return undo;
    undoCommands = undo.value;
  }

  return {
    ok: true,
    value: {
      commands,
      undoCommands,
      redoCommands: [...commands],
      previewCells,
      affectedCells: totalAffected,
      canSequence: overallCanSequence,
      detectedStep: overallStep,
    },
  };
}
