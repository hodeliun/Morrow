export const MAX_SESSION_HISTORY_BYTES = 32 * 1024 * 1024;

export interface HistoryBudgetRegistration {
  id: string;
  bytes: number;
  sequence: number;
  protected: boolean;
  evict: () => void;
}

type RegisteredEntry = HistoryBudgetRegistration;

/** One session-wide byte budget shared by data and view history stores. */
export class SessionHistoryBudget {
  private readonly entries = new Map<string, RegisteredEntry>();
  private total = 0;
  private sequence = 0;

  get usedBytes(): number {
    return this.total;
  }

  get overLimit(): boolean {
    return this.total > MAX_SESSION_HISTORY_BYTES;
  }

  nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  register(entry: HistoryBudgetRegistration): boolean {
    if (this.entries.has(entry.id)) return true;
    const canFit = entry.bytes === 0 || this.makeRoom(entry.bytes);
    if (!canFit && !entry.protected) return false;
    this.entries.set(entry.id, { ...entry });
    this.total += entry.bytes;
    return true;
  }

  update(id: string, change: { bytes?: number; protected?: boolean }): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (change.bytes !== undefined && change.bytes !== entry.bytes) {
      this.total += change.bytes - entry.bytes;
      entry.bytes = change.bytes;
    }
    if (change.protected !== undefined) entry.protected = change.protected;
    if (!entry.protected) this.makeRoom(0);
  }

  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.total -= entry.bytes;
  }

  private makeRoom(requiredBytes: number): boolean {
    while (this.total + requiredBytes > MAX_SESSION_HISTORY_BYTES) {
      const candidate = [...this.entries.values()]
        .filter((entry) => !entry.protected && entry.bytes > 0)
        .sort((left, right) => left.sequence - right.sequence)[0];
      if (!candidate) return false;
      const before = this.total;
      candidate.evict();
      // Stores may evict a causal chain, so always recalculate from the registry after the callback.
      if (this.total >= before) return false;
    }
    return true;
  }
}
