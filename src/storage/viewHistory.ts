import { MAX_SESSION_HISTORY_BYTES, SessionHistoryBudget } from './historyBudget';
import type { ViewConfigChange, ViewHistoryIdentity } from './viewHistoryCapture';
import { viewHistoryIdentityKey } from './viewHistoryCapture';

export const MAX_VIEW_HISTORY_STEPS = 10;

export type ViewHistoryEntryStatus = 'ready' | 'conflict' | 'unavailable' | 'busy';

export interface ViewHistoryItem {
  id: string;
  label: 'database.historyViewChange';
  ownerName: string;
  status: ViewHistoryEntryStatus | 'blocked';
  message?: string;
  enabled: boolean;
}

export interface OrderedViewHistoryItem extends ViewHistoryItem {
  sequence: number;
}

export interface ViewHistorySnapshot {
  undo: ViewHistoryItem | null;
  redo: ViewHistoryItem | null;
}

export type ViewHistoryStepResult =
  | { status: 'applied' }
  | { status: 'empty' | 'conflict' | 'unavailable' | 'failed' }
  | { status: 'blocked'; reason: 'related' | 'permission' };

export interface ViewHistoryEntry {
  id: string;
  scopes: string[];
  changes: ViewConfigChange[];
  ownerName: string;
  bytes: number;
  status: ViewHistoryEntryStatus;
  direction: 'undo' | 'redo';
  createdSequence: number;
  appliedSequence: number;
  undoneSequence?: number;
  message?: string;
}

const EMPTY_HISTORY: ViewHistorySnapshot = { undo: null, redo: null };

export class SessionViewHistory {
  private readonly entries = new Map<string, ViewHistoryEntry>();
  private readonly order: string[] = [];
  private readonly undoByIdentity = new Map<string, string[]>();
  private readonly redoByIdentity = new Map<string, string[]>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly snapshots = new Map<string, ViewHistorySnapshot>();
  private deferredPublications: Set<string> | null = null;

  constructor(private readonly budget = new SessionHistoryBudget()) {}

  subscribe(identity: ViewHistoryIdentity, listener: () => void): () => void {
    const key = viewHistoryIdentityKey(identity);
    const listeners = this.listeners.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  }

  getSnapshot(identity: ViewHistoryIdentity): ViewHistorySnapshot {
    return this.snapshots.get(viewHistoryIdentityKey(identity)) ?? EMPTY_HISTORY;
  }

  getCandidate(identity: ViewHistoryIdentity, direction: 'undo' | 'redo'): OrderedViewHistoryItem | null {
    const key = viewHistoryIdentityKey(identity);
    const stack = (direction === 'undo' ? this.undoByIdentity : this.redoByIdentity).get(key) ?? [];
    const id = stack.at(-1);
    if (!id) return null;
    const entry = this.entries.get(id);
    const item = this.itemFor(id, direction);
    if (!entry || !item) return null;
    return {
      ...item,
      sequence: direction === 'undo' ? entry.appliedSequence : (entry.undoneSequence ?? entry.createdSequence),
    };
  }

  getCandidateLinkedChanges(
    identity: Extract<ViewHistoryIdentity, { kind: 'linked' }>,
    direction: 'undo' | 'redo',
    expectedEntryId: string,
  ): readonly ViewConfigChange[] | null {
    const candidate = this.getCandidate(identity, direction);
    const entry = this.entries.get(expectedEntryId);
    if (
      !candidate ||
      candidate.id !== expectedEntryId ||
      candidate.status !== 'ready' ||
      !candidate.enabled ||
      !entry ||
      entry.status !== 'ready' ||
      !entry.changes.some((change) => viewHistoryIdentityKey(change.identity) === viewHistoryIdentityKey(identity))
    )
      return null;

    const identities = entry.changes.map(({ identity: changed }) => viewHistoryIdentityKey(changed));
    if (new Set(identities).size !== identities.length) return null;

    const linkedChanges = entry.changes.filter(
      (change): change is ViewConfigChange & { identity: Extract<ViewHistoryIdentity, { kind: 'linked' }> } =>
        change.identity.kind === 'linked',
    );
    if (linkedChanges.length === 0) return null;

    // A single view-history entry may also contain primary-view changes; Session applies and
    // validates the full atomic entry after callers preflight these linked host documents.
    const blockKeys = new Set<string>();
    for (const change of linkedChanges) {
      const { hostPageId, blockId } = change.identity;
      const blockKey = JSON.stringify([hostPageId, blockId]);
      if (
        !hostPageId ||
        !blockId ||
        blockKeys.has(blockKey) ||
        !change.before.view.id ||
        change.before.view.id !== change.after.view.id
      )
        return null;
      blockKeys.add(blockKey);
    }

    return linkedChanges.map((change) => structuredClone(change));
  }

  record(
    changes: ViewConfigChange[],
    beforePublish?: (entry: ViewHistoryEntry, changes: readonly ViewConfigChange[]) => void,
  ): string | null {
    if (changes.length === 0) return null;
    const keys = changes.map(({ identity }) => viewHistoryIdentityKey(identity));
    if (new Set(keys).size !== keys.length) return null;
    const previousDeferred = this.deferredPublications;
    if (!previousDeferred) this.deferredPublications = new Set();
    try {
      const createdSequence = this.budget.nextSequence();
      const entry: ViewHistoryEntry = {
        id: crypto.randomUUID(),
        scopes: keys,
        changes,
        ownerName: changes[0]!.after.view.name,
        bytes: encodedSize(changes),
        status: 'ready',
        direction: 'undo',
        createdSequence,
        appliedSequence: createdSequence,
      };
      if (entry.bytes > MAX_SESSION_HISTORY_BYTES || !this.registerBudgetEntry(entry)) {
        entry.status = 'unavailable';
        entry.message = 'unavailable';
        entry.changes = [];
        entry.bytes = encodedSize({ id: entry.id, ownerName: entry.ownerName, status: entry.status });
        if (!this.budget.register(this.budgetRecord(entry))) {
          entry.bytes = 0;
          this.budget.register(this.budgetRecord(entry, 0));
        }
      }

      const affected = new Set(keys);
      for (const key of keys) {
        for (const relatedId of [
          ...(this.undoByIdentity.get(key) ?? []),
          ...(this.redoByIdentity.get(key) ?? []),
        ]) {
          const related = this.entries.get(relatedId);
          if (related) this.scopeKeys(related).forEach((scope) => affected.add(scope));
        }
        for (const redoId of [...(this.redoByIdentity.get(key) ?? [])]) {
          const candidate = this.entries.get(redoId);
          if (candidate && isProtected(candidate.status)) {
            candidate.status = 'conflict';
            candidate.message = 'conflict';
            this.updateBudget(candidate);
            this.publish(this.scopeKeys(candidate));
          } else this.truncateHistoryThrough(redoId);
        }
      }

      this.entries.set(entry.id, entry);
      this.order.push(entry.id);
      for (const key of keys) this.undoByIdentity.set(key, [...(this.undoByIdentity.get(key) ?? []), entry.id]);
      this.trimScopeDepth();
      beforePublish?.(entry, changes);
      this.publish([...affected]);
      return entry.id;
    } finally {
      if (!previousDeferred) {
        const deferred = this.deferredPublications;
        this.deferredPublications = null;
        if (deferred) this.publishNow([...deferred]);
      }
    }
  }

  step(
    identity: ViewHistoryIdentity,
    direction: 'undo' | 'redo',
    apply: (entry: ViewHistoryEntry, direction: 'undo' | 'redo') => ViewHistoryStepResult,
    canEditNow?: () => boolean,
    expectedEntryId?: string,
  ): ViewHistoryStepResult {
    const key = viewHistoryIdentityKey(identity);
    const stack = (direction === 'undo' ? this.undoByIdentity : this.redoByIdentity).get(key) ?? [];
    const id = stack.at(-1);
    if (!id) return { status: 'empty' };
    if (expectedEntryId && expectedEntryId !== id) return { status: 'blocked', reason: 'related' };
    const entry = this.entries.get(id);
    if (!entry) return { status: 'empty' };
    if (!this.isTopAcrossScopes(entry, direction)) return { status: 'blocked', reason: 'related' };
    if (entry.status === 'unavailable') return { status: 'unavailable' };
    if (entry.status === 'busy') return { status: 'blocked', reason: 'permission' };
    try {
      if (!(canEditNow?.() ?? true)) return { status: 'blocked', reason: 'permission' };
    } catch {
      return { status: 'blocked', reason: 'permission' };
    }

    entry.status = 'busy';
    this.updateBudget(entry);
    this.publish(this.scopeKeys(entry));
    let result: ViewHistoryStepResult;
    try {
      result = apply(entry, direction);
    } catch {
      result = { status: 'failed' };
    }
    if (result.status === 'applied') {
      this.moveEntry(entry, direction);
      entry.status = 'ready';
      entry.direction = direction === 'undo' ? 'redo' : 'undo';
      const transferSequence = this.budget.nextSequence();
      if (direction === 'undo') entry.undoneSequence = transferSequence;
      else entry.appliedSequence = transferSequence;
      delete entry.message;
      this.updateBudget(entry);
      this.trimScopeDepth();
    } else if (result.status === 'conflict') {
      entry.status = 'conflict';
      entry.message = 'conflict';
      this.updateBudget(entry);
    } else {
      entry.status = 'ready';
      this.updateBudget(entry);
    }
    this.publish(this.scopeKeys(entry));
    return result;
  }

  private registerBudgetEntry(entry: ViewHistoryEntry): boolean {
    return this.budget.register(this.budgetRecord(entry));
  }

  private budgetRecord(entry: ViewHistoryEntry, bytes = entry.bytes) {
    return {
      id: this.budgetId(entry.id),
      bytes,
      sequence: entry.createdSequence,
      protected: isProtected(entry.status),
      evict: () => this.truncateHistoryThrough(entry.id),
    };
  }

  private updateBudget(entry: ViewHistoryEntry): void {
    this.budget.update(this.budgetId(entry.id), {
      bytes: entry.bytes,
      protected: isProtected(entry.status),
    });
  }

  private budgetId(id: string): string {
    return `view:${id}`;
  }

  private moveEntry(entry: ViewHistoryEntry, direction: 'undo' | 'redo'): void {
    const from = direction === 'undo' ? this.undoByIdentity : this.redoByIdentity;
    const to = direction === 'undo' ? this.redoByIdentity : this.undoByIdentity;
    for (const key of this.scopeKeys(entry)) {
      from.set(key, (from.get(key) ?? []).filter((id) => id !== entry.id));
      to.set(key, [...(to.get(key) ?? []), entry.id]);
    }
  }

  private isTopAcrossScopes(entry: ViewHistoryEntry, direction: 'undo' | 'redo'): boolean {
    const stacks = direction === 'undo' ? this.undoByIdentity : this.redoByIdentity;
    return this.scopeKeys(entry).every((key) => (stacks.get(key) ?? []).at(-1) === entry.id);
  }

  private trimScopeDepth(): void {
    const keys = new Set([...this.undoByIdentity.keys(), ...this.redoByIdentity.keys()]);
    for (const key of keys) {
      const count = () => this.idsForScope(key).filter((id) => {
        const entry = this.entries.get(id);
        return entry && !isProtected(entry.status);
      }).length;
      while (count() > MAX_VIEW_HISTORY_STEPS) {
        const oldestUndo = (this.undoByIdentity.get(key) ?? []).find((id) => {
          const entry = this.entries.get(id);
          return entry && !isProtected(entry.status);
        });
        const newestRedo = [...(this.redoByIdentity.get(key) ?? [])].reverse().find((id) => {
          const entry = this.entries.get(id);
          return entry && !isProtected(entry.status);
        });
        const boundary = oldestUndo ?? newestRedo;
        if (!boundary) break;
        this.truncateHistoryThrough(boundary);
      }
    }
  }

  private truncateHistoryThrough(id: string): void {
    const positions = new Map(this.order.map((entryId, index) => [entryId, index]));
    const first = this.entries.get(id);
    const firstPosition = positions.get(id);
    if (!first || firstPosition === undefined || isProtected(first.status)) return;

    const direction = first.direction;
    const stacks = direction === 'undo' ? this.undoByIdentity : this.redoByIdentity;
    const cutoffByScope = new Map<string, number>();
    for (const key of this.scopeKeys(first)) cutoffByScope.set(key, firstPosition);
    const remove = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const [key, cutoff] of cutoffByScope) {
        for (const candidateId of stacks.get(key) ?? []) {
          const position = positions.get(candidateId)!;
          if (direction === 'undo' ? position > cutoff : position < cutoff) continue;
          const candidate = this.entries.get(candidateId);
          if (!candidate || isProtected(candidate.status) || remove.has(candidateId)) continue;
          remove.add(candidateId);
          changed = true;
          for (const scope of this.scopeKeys(candidate)) {
            const previous = cutoffByScope.get(scope);
            if (direction === 'undo' && (previous ?? -1) < position) cutoffByScope.set(scope, position);
            if (direction === 'redo' && (previous === undefined || previous > position)) cutoffByScope.set(scope, position);
          }
        }
      }
    }

    const affected = new Set<string>();
    for (const candidateId of remove) {
      const candidate = this.entries.get(candidateId);
      if (!candidate || isProtected(candidate.status)) continue;
      this.scopeKeys(candidate).forEach((key) => affected.add(key));
      this.removeEntry(candidateId);
    }
    this.publish([...affected]);
  }

  private idsForScope(key: string): string[] {
    const ids = new Set([...(this.undoByIdentity.get(key) ?? []), ...(this.redoByIdentity.get(key) ?? [])]);
    return this.order.filter((id) => ids.has(id));
  }

  private removeEntry(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || isProtected(entry.status)) return;
    this.entries.delete(id);
    this.budget.remove(this.budgetId(id));
    for (const key of this.scopeKeys(entry)) {
      this.undoByIdentity.set(key, (this.undoByIdentity.get(key) ?? []).filter((candidate) => candidate !== id));
      this.redoByIdentity.set(key, (this.redoByIdentity.get(key) ?? []).filter((candidate) => candidate !== id));
    }
    const orderIndex = this.order.indexOf(id);
    if (orderIndex >= 0) this.order.splice(orderIndex, 1);
  }

  private scopeKeys(entry: ViewHistoryEntry): string[] {
    return entry.scopes;
  }

  private publish(keys: readonly string[]): void {
    if (this.deferredPublications) {
      keys.forEach((key) => this.deferredPublications!.add(key));
      return;
    }
    this.publishNow(keys);
  }

  private publishNow(keys: readonly string[]): void {
    for (const key of keys) {
      this.snapshots.set(key, this.snapshotFor(key));
      for (const listener of this.listeners.get(key) ?? []) listener();
    }
  }

  private snapshotFor(key: string): ViewHistorySnapshot {
    const undoId = this.undoByIdentity.get(key)?.at(-1);
    const redoId = this.redoByIdentity.get(key)?.at(-1);
    return {
      undo: undoId ? this.itemFor(undoId, 'undo') : null,
      redo: redoId ? this.itemFor(redoId, 'redo') : null,
    };
  }

  private itemFor(id: string, direction: 'undo' | 'redo'): ViewHistoryItem | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const enabled = entry.status !== 'unavailable' && entry.status !== 'busy' && this.isTopAcrossScopes(entry, direction);
    return {
      id,
      label: 'database.historyViewChange',
      ownerName: entry.ownerName,
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

function encodedSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function isProtected(status: ViewHistoryEntryStatus): boolean {
  return status === 'busy' || status === 'conflict';
}
