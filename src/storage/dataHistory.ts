import type { Command, Changes } from '../core/commands';
import type { PageId, PageMeta, WorkspaceState } from '../core/model';
import type { ActionRecordChange } from '../core/tableActions';
import {
  isTableActionHistoryEntryJournalable,
  sameTableActionValue,
  stepTableActionHistory,
  tableActionHistoryStateMatches,
} from './tableActions';
import type { TableActionHistoryEntry } from './tableActions';
import type { WorkspaceSession } from './session';
import { MAX_SESSION_HISTORY_BYTES, SessionHistoryBudget } from './historyBudget';

export const MAX_DATA_HISTORY_STEPS_PER_DATABASE = 10;
export const MAX_DATA_HISTORY_BYTES = MAX_SESSION_HISTORY_BYTES;

const ROW_OPERATION_PROPERTY_ID = '__row_operations__';
const GENERIC_HISTORY_PROPERTY_ID = '__session_data_history__';

export interface DataHistoryCaptureContext {
  id?: string;
  databaseId?: PageId;
  rowId?: PageId;
  propertyId?: string;
  label?: string;
  pendingRecovery?: boolean;
  records?: ActionRecordChange[];
}

export type DataHistoryEntryStatus = 'ready' | 'pending' | 'conflict' | 'unavailable' | 'busy';

export interface SessionDataHistoryEntry extends TableActionHistoryEntry {
  databaseIds: PageId[];
  bytes: number;
  status: DataHistoryEntryStatus;
  direction: 'undo' | 'redo';
  createdSequence: number;
  appliedSequence: number;
  undoneSequence?: number;
  message?: string;
}

export interface DataHistoryItem {
  id: string;
  label: string;
  status: DataHistoryEntryStatus | 'blocked';
  message?: string;
  enabled: boolean;
}

export interface DataHistorySnapshot {
  undo: DataHistoryItem | null;
  redo: DataHistoryItem | null;
}

export interface OrderedDataHistoryItem extends DataHistoryItem {
  sequence: number;
}

export type DataHistoryStepResult =
  | { status: 'applied' }
  | { status: 'empty' | 'pending' | 'conflict' | 'unavailable' | 'failed' }
  | { status: 'blocked'; reason: 'related' | 'permission' };

const EMPTY_HISTORY: DataHistorySnapshot = { undo: null, redo: null };

// A session owns one bounded history. Database stacks contain references to shared actions, so a
// relation change touching two databases is stored once and moves through both stacks atomically.
export class SessionDataHistory {
  private readonly entries = new Map<string, SessionDataHistoryEntry>();
  private readonly order: string[] = [];
  private readonly undoByDatabase = new Map<PageId, string[]>();
  private readonly redoByDatabase = new Map<PageId, string[]>();
  private readonly listeners = new Map<PageId, Set<() => void>>();
  private readonly snapshots = new Map<PageId, DataHistorySnapshot>();
  private readonly busyDatabaseIds = new Set<PageId>();

  constructor(private readonly budget = new SessionHistoryBudget()) {}

  subscribe(databaseId: PageId, listener: () => void): () => void {
    const listeners = this.listeners.get(databaseId) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(databaseId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(databaseId);
    };
  }

  getSnapshot(databaseId: PageId): DataHistorySnapshot {
    return this.snapshots.get(databaseId) ?? EMPTY_HISTORY;
  }

  getCandidate(databaseId: PageId, direction: 'undo' | 'redo'): OrderedDataHistoryItem | null {
    const stack = (direction === 'undo' ? this.undoByDatabase : this.redoByDatabase).get(databaseId) ?? [];
    const id = stack.at(-1);
    if (!id) return null;
    const entry = this.entries.get(id);
    const item = this.itemFor(id, direction);
    if (!entry || !item) return null;
    return { ...item, sequence: direction === 'undo' ? entry.appliedSequence : (entry.undoneSequence ?? entry.createdSequence) };
  }

  isBusy(databaseId: PageId): boolean {
    return this.busyDatabaseIds.has(databaseId);
  }

  busyDatabasesForChanges(
    before: WorkspaceState,
    after: WorkspaceState,
    commands: Command[],
    changes: Changes,
    explicitHistoryDatabaseIds: readonly PageId[],
  ): PageId[] {
    const explicitHistoryAction = explicitHistoryDatabaseIds.length > 0;
    if (
      !explicitHistoryAction &&
      !commands.some(
        (command) =>
          command.type === 'database.set' ||
          command.type === 'page.setKind' ||
          command.type === 'page.deleteForever' ||
          isDataHistoryCommand(command),
      )
    )
      return [];
    const affected = new Set<PageId>();
    for (const databaseId of explicitHistoryDatabaseIds) {
      if (this.busyDatabaseIds.has(databaseId)) affected.add(databaseId);
    }
    const changedIds = new Set([...changes.pages, ...changes.removed]);
    for (const id of changedIds) {
      const beforePage = before.pages[id] ?? null;
      const afterPage = after.pages[id] ?? null;
      if (sameTableActionValue(beforePage, afterPage)) continue;
      const beforeOwner = ownerDatabaseId(before, beforePage);
      const afterOwner = ownerDatabaseId(after, afterPage);
      if (beforeOwner && this.busyDatabaseIds.has(beforeOwner)) affected.add(beforeOwner);
      if (afterOwner && this.busyDatabaseIds.has(afterOwner)) affected.add(afterOwner);
      for (const busyDatabaseId of this.busyDatabaseIds) {
        if (id !== busyDatabaseId) continue;
        const schemaChanged = databaseSchemaChanged(beforePage, afterPage);
        const identityOperation = commands.some(
          (command) =>
            'id' in command &&
            command.id === id &&
            ['page.trash', 'page.restore', 'page.deleteForever', 'page.setKind'].includes(command.type),
        );
        if (schemaChanged || identityOperation || explicitHistoryAction) affected.add(busyDatabaseId);
      }
    }
    return [...affected];
  }

  record(
    before: WorkspaceState,
    after: WorkspaceState,
    commands: Command[],
    changes: Changes,
    context?: DataHistoryCaptureContext,
  ): string | null {
    // Schema changes and their adopted row values stay together in the legacy property history.
    if (commands.some((command) => command.type === 'database.set' || command.type === 'page.setKind'))
      return null;
    // An explicit table action is already bounded and owned by its journal, even if its steps
    // only change named controls or target a related page outside the source database.
    if (!context?.pendingRecovery && !commands.some(isDataHistoryCommand)) return null;

    const records: TableActionHistoryEntry['records'] = [];
    const databaseIds = new Set<PageId>();
    const createdWithDocument = new Set(
      commands
        .filter((command): command is Extract<Command, { type: 'page.create' }> => command.type === 'page.create')
        .map((command) => command.id),
    );
    const changedIds = new Set([...changes.pages, ...changes.removed]);
    const sourceRecords =
      context?.pendingRecovery && context.records
        ? context.records.map((record) => ({ id: record.id, record }))
        : [...changedIds].map((id) => ({ id, record: null }));
    for (const { id, record } of sourceRecords) {
      const beforePage = record?.before ?? before.pages[id] ?? null;
      const afterPage = record?.after ?? after.pages[id] ?? null;
      const hasDocumentChange =
        record &&
        ((Object.hasOwn(record, 'docBefore') && Object.hasOwn(record, 'docAfter') &&
          !sameTableActionValue(record.docBefore, record.docAfter)) ||
          (record.docBefore === null && record.docAfter !== null) ||
          (record.docBefore !== null && record.docAfter === null));
      if (sameTableActionValue(beforePage, afterPage) && !hasDocumentChange) continue;
      const owners = [
        ownerDatabaseId(before, beforePage),
        ownerDatabaseId(after, afterPage),
      ].filter((owner): owner is PageId => owner !== null);
      if (owners.length === 0 && !context?.pendingRecovery) continue;
      for (const owner of owners) databaseIds.add(owner);
      if (record) {
        records.push(structuredClone(record));
        continue;
      }
      const beforeDoc = before.docs[id] ?? null;
      const afterDoc = after.docs[id] ?? null;
      records.push({
        id,
        before: beforePage ? structuredClone(beforePage) : null,
        after: afterPage ? structuredClone(afterPage) : null,
        ...(createdWithDocument.has(id)
          ? {
              docBefore: beforeDoc ? structuredClone(beforeDoc) : null,
              docAfter: afterDoc ? structuredClone(afterDoc) : null,
            }
          : {}),
      });
    }
    if (records.length === 0) return null;

    if (context?.databaseId) databaseIds.add(context.databaseId);
    const scopes = [...databaseIds];
    if (scopes.length === 0) return null;
    const databaseId = context?.databaseId ?? scopes[0]!;
    const rowId = context?.rowId ?? records.find((record) => record.before || record.after)?.id;
    if (!rowId) return null;
    const isStructural = commands.some((command) =>
      ['page.create', 'page.deleteForever', 'page.move', 'page.trash', 'page.restore'].includes(command.type),
    );
    const entry: TableActionHistoryEntry = {
      id: context?.id ?? crypto.randomUUID(),
      databaseId,
      rowId,
      propertyId: context?.propertyId ?? (isStructural ? ROW_OPERATION_PROPERTY_ID : GENERIC_HISTORY_PROPERTY_ID),
      label: context?.label ?? 'database.historyDataChange',
      createdAt: Date.now(),
      records,
      commands: structuredClone(commands),
    };
    const bytes = encodedSize({ ...entry, databaseIds: scopes });
    const createdSequence = this.budget.nextSequence();
    let status: DataHistoryEntryStatus = context?.pendingRecovery ? 'pending' : 'ready';
    let message: string | undefined;
    if (!isTableActionHistoryEntryJournalable(entry)) {
      status = context?.pendingRecovery ? 'pending' : 'unavailable';
      message = 'unavailable';
    }
    if (bytes > MAX_DATA_HISTORY_BYTES) {
      status = context?.pendingRecovery ? 'pending' : 'unavailable';
      message = 'unavailable';
    }
    const stored: SessionDataHistoryEntry = {
      ...entry,
      databaseIds: scopes,
      bytes,
      status,
      direction: 'undo',
      createdSequence,
      appliedSequence: createdSequence,
      ...(message ? { message } : {}),
    };
    if (status === 'unavailable') {
      stored.records = [];
      stored.commands = [];
      stored.label = stored.label.slice(0, 100);
      stored.bytes = unavailableEntryBytes(stored);
    }
    this.push(stored);
    return stored.id;
  }

  restore(entry: TableActionHistoryEntry, state: WorkspaceState, direction: 'undo' | 'redo' = 'undo'): void {
    const existing = this.entries.get(entry.id);
    if (existing?.status === 'busy') return;
    const scopes = new Set<PageId>([entry.databaseId, ...(existing?.databaseIds ?? [])]);
    if (!existing) {
      for (const record of entry.records) {
        for (const page of [record.before, record.after]) {
          const owner = ownerDatabaseId(state, page);
          if (owner) scopes.add(owner);
        }
      }
    }
    const entryWithScopes = { ...entry, databaseIds: [...scopes] };
    const bytes = encodedSize({ ...entry, databaseIds: [...scopes] });
    const createdSequence = existing?.createdSequence ?? this.budget.nextSequence();
    const directionChanged = existing !== undefined && existing.direction !== direction;
    const transferSequence = directionChanged ? this.budget.nextSequence() : undefined;
    const appliedSequence =
      direction === 'undo'
        ? transferSequence ?? existing?.appliedSequence ?? createdSequence
        : existing?.appliedSequence ?? createdSequence;
    const undoneSequence =
      direction === 'redo'
        ? transferSequence ?? existing?.undoneSequence ?? this.budget.nextSequence()
        : existing?.undoneSequence;
    const journalable = isTableActionHistoryEntryJournalable(entry);
    const withinMemoryLimit = bytes <= MAX_DATA_HISTORY_BYTES;
    const matches = tableActionHistoryStateMatches(state, entry, direction);
    const stored: SessionDataHistoryEntry = {
      ...entryWithScopes,
      bytes,
      status: !journalable || !withinMemoryLimit ? 'unavailable' : matches ? 'ready' : 'conflict',
      direction,
      createdSequence,
      appliedSequence,
      ...(undoneSequence !== undefined ? { undoneSequence } : {}),
      ...(!journalable || !withinMemoryLimit
        ? { message: 'unavailable', records: [], commands: [], bytes: 0 }
        : !matches
          ? { message: 'conflict' }
          : {}),
    };
    if (stored.status === 'unavailable') {
      stored.label = stored.label.slice(0, 100);
      stored.bytes = unavailableEntryBytes(stored);
    }
    if (!existing) {
      this.push(stored);
      return;
    }

    const restoreDirectionChanged = existing.direction !== direction;
    const cannotMoveAcrossNewerActions = restoreDirectionChanged && !this.isTopAcrossScopes(existing, existing.direction);
    const nextDirection = cannotMoveAcrossNewerActions ? existing.direction : direction;
    existing.databaseIds = [...scopes];
    if (restoreDirectionChanged && !cannotMoveAcrossNewerActions) this.moveEntry(existing, direction, false);
    Object.assign(existing, stored, { direction: nextDirection });
    if (cannotMoveAcrossNewerActions && stored.status !== 'unavailable') {
      existing.status = 'conflict';
      existing.message = 'conflict';
    }
    this.updateBudget(existing);
    this.trimDatabaseDepth();
    this.publish(existing.databaseIds);
  }

  finishEntry(id: string, status: 'ready' | 'pending'): void {
    const entry = this.entries.get(id);
    if (!entry || entry.status === 'unavailable') return;
    entry.status = status;
    this.updateBudget(entry);
    if (status === 'ready') delete entry.message;
    else entry.message = 'pending';
    this.publish(entry.databaseIds);
  }

  async step(
    session: WorkspaceSession,
    databaseId: PageId,
    direction: 'undo' | 'redo',
    canEditNow?: () => boolean,
    expectedEntryId?: string,
  ): Promise<DataHistoryStepResult> {
    const stack = (direction === 'undo' ? this.undoByDatabase : this.redoByDatabase).get(databaseId) ?? [];
    const id = stack.at(-1);
    if (!id) return { status: 'empty' };
    if (expectedEntryId && id !== expectedEntryId) return { status: 'blocked', reason: 'related' };
    const entry = this.entries.get(id);
    if (!entry) return { status: 'empty' };
    if (!this.isTopAcrossScopes(entry, direction)) return { status: 'blocked', reason: 'related' };
    if (entry.status === 'unavailable') return { status: 'unavailable' };
    if (entry.status === 'busy') return { status: 'pending' };
    const replayAllowed = () =>
      session.canEditDataHistoryNow(
        entry.databaseIds,
        entry.records.map((record) => record.id),
      ) &&
      (() => {
        try {
          return canEditNow?.() ?? true;
        } catch {
          return false;
        }
      })();
    if (!replayAllowed()) return { status: 'blocked', reason: 'permission' };

    entry.status = 'busy';
    this.updateBudget(entry);
    for (const scope of entry.databaseIds) this.busyDatabaseIds.add(scope);
    this.publish(entry.databaseIds);
    try {
      const result = await stepTableActionHistory(session, entry, direction, Date.now(), replayAllowed);
      if (result.status === 'applied') {
        this.moveEntry(entry, direction);
        entry.status = 'ready';
        entry.direction = direction === 'undo' ? 'redo' : 'undo';
        const transferSequence = this.budget.nextSequence();
        if (direction === 'undo') entry.undoneSequence = transferSequence;
        else entry.appliedSequence = transferSequence;
        this.updateBudget(entry);
        delete entry.message;
        return this.publishAndResult(entry, { status: 'applied' });
      }
      if (result.status === 'pending') entry.status = 'pending';
      else if (result.status === 'conflict') entry.status = 'conflict';
      else if (result.status === 'unavailable') {
        entry.status = 'unavailable';
        entry.message = 'unavailable';
        entry.records = [];
        entry.commands = [];
        entry.bytes = unavailableEntryBytes(entry);
      } else {
        entry.status = 'ready';
      }
      this.updateBudget(entry);
      entry.message = result.status;
      this.publish(entry.databaseIds);
      if (result.status === 'blocked') return { status: 'blocked', reason: 'permission' };
      return { status: result.status === 'failed' ? 'failed' : result.status };
    } finally {
      for (const scope of entry.databaseIds) this.busyDatabaseIds.delete(scope);
      this.publish(entry.databaseIds);
    }
  }

  private push(entry: SessionDataHistoryEntry): void {
    if (this.entries.has(entry.id)) return;
    const affected = new Set<PageId>(entry.databaseIds);
    for (const databaseId of entry.databaseIds) {
      for (const relatedId of [
        ...(this.undoByDatabase.get(databaseId) ?? []),
        ...(this.redoByDatabase.get(databaseId) ?? []),
      ]) {
        const related = this.entries.get(relatedId);
        if (related) related.databaseIds.forEach((scope) => affected.add(scope));
      }
    }
    if (entry.direction === 'undo') {
      for (const databaseId of entry.databaseIds) {
        const redo = this.redoByDatabase.get(databaseId) ?? [];
        for (const redoId of [...redo]) {
          const candidate = this.entries.get(redoId);
          if (candidate && isProtected(candidate.status)) {
            candidate.status = 'conflict';
            candidate.message = 'conflict';
            this.updateBudget(candidate);
            this.publish(candidate.databaseIds);
          } else this.truncateHistoryThrough(redoId);
        }
      }
    }
    if (!this.registerBudgetEntry(entry)) {
      entry.status = 'unavailable';
      entry.message = 'unavailable';
      entry.records = [];
      entry.commands = [];
      entry.label = entry.label.slice(0, 100);
      entry.bytes = unavailableEntryBytes(entry);
      if (!this.budget.register(this.budgetRecord(entry, entry.bytes))) {
        entry.bytes = 0;
        this.budget.register(this.budgetRecord(entry, 0));
      }
    }
    this.entries.set(entry.id, entry);
    this.order.push(entry.id);
    const target = entry.direction === 'undo' ? this.undoByDatabase : this.redoByDatabase;
    for (const databaseId of entry.databaseIds) {
      target.set(databaseId, [...(target.get(databaseId) ?? []), entry.id]);
    }
    this.trimDatabaseDepth();
    this.publish([...affected]);
  }

  private moveEntry(entry: SessionDataHistoryEntry, direction: 'undo' | 'redo', notify = true): void {
    const from = direction === 'undo' ? this.undoByDatabase : this.redoByDatabase;
    const to = direction === 'undo' ? this.redoByDatabase : this.undoByDatabase;
    for (const databaseId of entry.databaseIds) {
      from.set(databaseId, (from.get(databaseId) ?? []).filter((id) => id !== entry.id));
      to.set(databaseId, [...(to.get(databaseId) ?? []), entry.id]);
    }
    if (notify) this.publish(entry.databaseIds);
  }

  private isTopAcrossScopes(entry: SessionDataHistoryEntry, direction: 'undo' | 'redo'): boolean {
    const stacks = direction === 'undo' ? this.undoByDatabase : this.redoByDatabase;
    return entry.databaseIds.every((databaseId) => (stacks.get(databaseId) ?? []).at(-1) === entry.id);
  }

  private trimDatabaseDepth(): void {
    const databaseIds = new Set([...this.undoByDatabase.keys(), ...this.redoByDatabase.keys()]);
    for (const databaseId of databaseIds) {
      const completedCount = () =>
        this.idsForDatabase(databaseId).filter((id) => {
          const entry = this.entries.get(id);
          return entry && !isProtected(entry.status);
        }).length;
      while (completedCount() > MAX_DATA_HISTORY_STEPS_PER_DATABASE) {
        const positions = new Map(this.order.map((id, index) => [id, index]));
        const oldestUndo = (this.undoByDatabase.get(databaseId) ?? [])
          .filter((id) => {
            const entry = this.entries.get(id);
            return entry && !isProtected(entry.status);
          })
          .sort((a, b) => positions.get(a)! - positions.get(b)!)[0];
        const newestRedo = (this.redoByDatabase.get(databaseId) ?? [])
          .filter((id) => {
            const entry = this.entries.get(id);
            return entry && !isProtected(entry.status);
          })
          .sort((a, b) => positions.get(b)! - positions.get(a)!)[0];
        const boundary = oldestUndo ?? newestRedo;
        if (!boundary) break;
        this.truncateHistoryThrough(boundary);
      }
    }
  }

  // Removing an action is a history boundary, including when the action could not be journaled.
  // For Undo, discard the older prefix; for Redo, discard the newer suffix. Shared actions extend
  // that boundary to every database they touch, so trimming never exposes a step that skips one.
  private truncateHistoryThrough(id: string): void {
    const sequence = [...this.order];
    const positions = new Map(sequence.map((entryId, index) => [entryId, index]));
    const first = this.entries.get(id);
    const firstPosition = positions.get(id);
    if (!first || firstPosition === undefined || isProtected(first.status)) return;

    const direction = first.direction;
    const stacks = direction === 'undo' ? this.undoByDatabase : this.redoByDatabase;
    const cutoffByDatabase = new Map<PageId, number>();
    for (const databaseId of first.databaseIds) cutoffByDatabase.set(databaseId, firstPosition);
    const remove = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const [databaseId, cutoff] of cutoffByDatabase) {
        for (const candidateId of stacks.get(databaseId) ?? []) {
          const position = positions.get(candidateId)!;
          if (direction === 'undo' ? position > cutoff : position < cutoff) continue;
          const candidate = this.entries.get(candidateId);
          if (
            !candidate ||
            !candidate.databaseIds.includes(databaseId) ||
            isProtected(candidate.status) ||
            remove.has(candidateId)
          )
            continue;
          remove.add(candidateId);
          changed = true;
          for (const scope of candidate.databaseIds) {
            const previous = cutoffByDatabase.get(scope);
            if (direction === 'undo' && (previous ?? -1) < position) cutoffByDatabase.set(scope, position);
            if (direction === 'redo' && (previous === undefined || previous > position))
              cutoffByDatabase.set(scope, position);
          }
        }
      }
    }

    const affected = new Set<PageId>();
    for (const candidateId of remove) {
      const candidate = this.entries.get(candidateId);
      if (!candidate || isProtected(candidate.status)) continue;
      for (const scope of candidate.databaseIds) affected.add(scope);
      this.removeEntry(candidateId, false);
    }
    this.publish([...affected]);
  }

  private idsForDatabase(databaseId: PageId): string[] {
    const ids = new Set([
      ...(this.undoByDatabase.get(databaseId) ?? []),
      ...(this.redoByDatabase.get(databaseId) ?? []),
    ]);
    return this.order.filter((id) => ids.has(id));
  }

  private removeEntry(id: string, notify = true): void {
    const entry = this.entries.get(id);
    if (!entry || isProtected(entry.status)) return;
    this.entries.delete(id);
    this.budget.remove(this.budgetId(id));
    const affected = entry.databaseIds;
    for (const databaseId of affected) {
      this.undoByDatabase.set(databaseId, (this.undoByDatabase.get(databaseId) ?? []).filter((item) => item !== id));
      this.redoByDatabase.set(databaseId, (this.redoByDatabase.get(databaseId) ?? []).filter((item) => item !== id));
    }
    const orderIndex = this.order.indexOf(id);
    if (orderIndex >= 0) this.order.splice(orderIndex, 1);
    if (notify) this.publish(affected);
  }

  private publishAndResult(entry: SessionDataHistoryEntry, result: DataHistoryStepResult): DataHistoryStepResult {
    this.publish(entry.databaseIds);
    this.trimDatabaseDepth();
    return result;
  }

  private budgetId(id: string): string {
    return `data:${id}`;
  }

  private budgetRecord(entry: SessionDataHistoryEntry, bytes = entry.bytes) {
    return {
      id: this.budgetId(entry.id),
      bytes,
      sequence: entry.createdSequence,
      protected: isProtected(entry.status),
      evict: () => this.truncateHistoryThrough(entry.id),
    };
  }

  private registerBudgetEntry(entry: SessionDataHistoryEntry): boolean {
    return this.budget.register(this.budgetRecord(entry));
  }

  private updateBudget(entry: SessionDataHistoryEntry): void {
    this.budget.update(this.budgetId(entry.id), {
      bytes: entry.bytes,
      protected: isProtected(entry.status),
    });
  }

  private publish(databaseIds: readonly PageId[]): void {
    for (const databaseId of databaseIds) {
      this.snapshots.set(databaseId, this.snapshotFor(databaseId));
      for (const listener of this.listeners.get(databaseId) ?? []) listener();
    }
  }

  private snapshotFor(databaseId: PageId): DataHistorySnapshot {
    const undoId = this.undoByDatabase.get(databaseId)?.at(-1);
    const redoId = this.redoByDatabase.get(databaseId)?.at(-1);
    return {
      undo: undoId ? this.itemFor(undoId, 'undo') : null,
      redo: redoId ? this.itemFor(redoId, 'redo') : null,
    };
  }

  private itemFor(id: string, direction: 'undo' | 'redo'): DataHistoryItem | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const enabled = entry.status !== 'unavailable' && entry.status !== 'busy' && this.isTopAcrossScopes(entry, direction);
    return {
      id,
      label: entry.label,
      status:
        entry.status === 'busy'
          ? 'busy'
          : enabled
            ? entry.status
            : entry.status === 'unavailable'
              ? 'unavailable'
              : 'blocked',
      ...(entry.message ? { message: entry.message } : {}),
      enabled,
    };
  }
}

function isDataHistoryCommand(command: Command): boolean {
  return [
    'page.create',
    'page.deleteForever',
    'page.rename',
    'page.move',
    'page.trash',
    'page.restore',
    'page.setProperties',
    'relation.set',
    'page.setFields',
  ].includes(command.type);
}

function ownerDatabaseId(state: WorkspaceState, page: PageMeta | null): PageId | null {
  if (!page?.parentId) return null;
  const parent = state.pages[page.parentId];
  return parent?.kind === 'database' && parent.database ? parent.id : null;
}

function databaseSchemaChanged(before: PageMeta | null, after: PageMeta | null): boolean {
  if (before?.kind !== 'database' || after?.kind !== 'database')
    return before?.kind === 'database' || after?.kind === 'database';
  if (!before.database || !after.database) return before.database !== after.database;
  const { views: _beforeViews, ...beforeSchema } = before.database;
  const { views: _afterViews, ...afterSchema } = after.database;
  return !sameTableActionValue(beforeSchema, afterSchema);
}

function encodedSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function unavailableEntryBytes(entry: SessionDataHistoryEntry): number {
  return encodedSize({
    id: entry.id,
    databaseId: entry.databaseId,
    rowId: entry.rowId,
    propertyId: entry.propertyId,
    label: entry.label,
    createdAt: entry.createdAt,
    records: [],
    commands: [],
    databaseIds: entry.databaseIds,
    status: 'unavailable',
    direction: entry.direction,
    message: 'unavailable',
  });
}

function isProtected(status: DataHistoryEntryStatus): boolean {
  return status === 'pending' || status === 'busy' || status === 'conflict';
}
