import type { PageId } from '../core/model';

export type PilotDataHistoryDirection = 'undo' | 'redo';

export type PilotDataHistoryCellValue =
  | { readonly present: false; readonly value: null }
  | { readonly present: true; readonly value: number | null };

export interface PilotDataHistoryEntry {
  readonly rowId: PageId;
  readonly propertyId: string;
  readonly before: PilotDataHistoryCellValue;
  readonly after: PilotDataHistoryCellValue;
}

export interface PilotDataHistorySnapshot {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

interface DatabaseHistory {
  undo: PilotDataHistoryEntry[];
  redo: PilotDataHistoryEntry[];
}

const HISTORY_LIMIT = 10;

/** Short-lived, session-scoped data-cell history. Nothing in this type is persisted to the vault. */
export class PilotDataHistory {
  private readonly databases = new Map<PageId, DatabaseHistory>();

  snapshot(databaseId: PageId): PilotDataHistorySnapshot {
    const history = this.databases.get(databaseId);
    return { canUndo: (history?.undo.length ?? 0) > 0, canRedo: (history?.redo.length ?? 0) > 0 };
  }

  peek(databaseId: PageId, direction: PilotDataHistoryDirection): PilotDataHistoryEntry | null {
    const history = this.databases.get(databaseId);
    const stack = direction === 'undo' ? history?.undo : history?.redo;
    return stack?.at(-1) ?? null;
  }

  record(databaseId: PageId, entry: PilotDataHistoryEntry): void {
    let history = this.databases.get(databaseId);
    if (!history) {
      history = { undo: [], redo: [] };
      this.databases.set(databaseId, history);
    }
    history.undo.push(freezeEntry(entry));
    if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
    history.redo = [];
  }

  canCommitMove(
    databaseId: PageId,
    direction: PilotDataHistoryDirection,
    entry: PilotDataHistoryEntry,
  ): boolean {
    const history = this.databases.get(databaseId);
    const stack = direction === 'undo' ? history?.undo : history?.redo;
    return stack?.at(-1) === entry;
  }

  /** Moves only the exact entry previously peeked after its validated state restoration succeeds. */
  commitMove(
    databaseId: PageId,
    direction: PilotDataHistoryDirection,
    entry: PilotDataHistoryEntry,
  ): boolean {
    const history = this.databases.get(databaseId);
    if (!history) return false;
    const from = direction === 'undo' ? history.undo : history.redo;
    if (from.at(-1) !== entry) return false;
    from.pop();
    const to = direction === 'undo' ? history.redo : history.undo;
    to.push(entry);
    if (direction === 'redo' && to.length > HISTORY_LIMIT) to.shift();
    return true;
  }

  invalidate(databaseId: PageId): void {
    this.databases.delete(databaseId);
  }
}

function freezeEntry(entry: PilotDataHistoryEntry): PilotDataHistoryEntry {
  return Object.freeze({
    rowId: entry.rowId,
    propertyId: entry.propertyId,
    before: Object.freeze({ ...entry.before }),
    after: Object.freeze({ ...entry.after }),
  });
}
