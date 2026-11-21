import type { Changes } from '../core/commands';
import type { PageId, Snapshot, WorkspaceState } from '../core/model';
import { errorMessage } from '../core/result';
import { WorkspaceWriteError } from './repository';
import type { WriteBatch } from './repository';

export type SaveState = 'saved' | 'pending' | 'saving' | 'error';

export interface SaveStatus {
  state: SaveState;
  lastSavedAt: number | null;
  error: string | null;
  errorCode: string | null;
  failures: number;
}

export interface SaveQueueOptions {
  // versions to store alongside the documents being written
  snapshotsFor?: (docIds: PageId[], state: WorkspaceState) => Snapshot[];
  onSnapshotsWritten?: (snapshots: Snapshot[]) => void;
  delayMs?: number;
  // how long a quiet change, such as when a page was last opened, waits before it is written
  quietDelayMs?: number;
  maxRetryMs?: number;
  now?: () => number;
}

// batches changed records into serialised writes and keeps failed ones until they land
export class SaveQueue {
  private readonly dirtyPages = new Set<PageId>();
  private readonly dirtyDocs = new Set<PageId>();
  private readonly removed = new Set<PageId>();
  private readonly checkPages = new Set<PageId>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private current: SaveStatus = {
    state: 'saved',
    lastSavedAt: null,
    error: null,
    errorCode: null,
    failures: 0,
  };
  private readonly delayMs: number;
  private readonly maxRetryMs: number;
  private readonly now: () => number;
  private readonly options: SaveQueueOptions;
  private writing = new Set<PageId>();
  // A quiet page has only a navigation update pending; it does not make the page dirty to the watcher.
  private readonly quiet = new Set<PageId>();
  private readonly quietDelayMs: number;
  private retryBlocked = false;
  private disposed = false;

  constructor(
    private readonly writer: { write(batch: WriteBatch): Promise<void> },
    private readonly getState: () => WorkspaceState,
    options: SaveQueueOptions = {},
  ) {
    // a moment after the last edit rather than at every pause between words
    this.delayMs = options.delayMs ?? 1500;
    this.quietDelayMs = options.quietDelayMs ?? Math.max(this.delayMs, 20_000);
    this.maxRetryMs = options.maxRetryMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.options = options;
  }

  get status(): SaveStatus {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // true while the page has changes that are not on disk yet, edits made elsewhere must not replace them
  isDirty(id: PageId): boolean {
    const hasPendingWrite =
      this.dirtyPages.has(id) ||
      this.dirtyDocs.has(id) ||
      this.removed.has(id) ||
      this.checkPages.has(id) ||
      this.writing.has(id);
    if (!hasPendingWrite) return false;

    // Quiet is only an exception for the page entry itself. It must never hide a document write,
    // removal, dependency check, active write, or a failed write that still needs attention.
    const quietOnly =
      this.quiet.has(id) &&
      this.dirtyPages.has(id) &&
      !this.dirtyDocs.has(id) &&
      !this.removed.has(id) &&
      !this.checkPages.has(id) &&
      !this.writing.has(id) &&
      this.current.state !== 'error';
    return !quietOnly;
  }

  isQuietPending(id: PageId): boolean {
    return this.quiet.has(id) && this.dirtyPages.has(id) && !this.isDirty(id);
  }

  hasPending(): boolean {
    return (
      this.dirtyPages.size + this.dirtyDocs.size + this.removed.size + this.checkPages.size > 0 ||
      this.inFlight !== null
    );
  }

  // The second argument accepts both the fork's dependency list and upstream's quiet flag.
  // A third flag lets a future caller combine them without losing either contract.
  enqueue(changes: Changes, checkPages?: PageId[]): void;
  enqueue(changes: Changes, quiet?: boolean): void;
  enqueue(changes: Changes, checkPages: PageId[], quiet: boolean): void;
  enqueue(changes: Changes, checkPagesOrQuiet: PageId[] | boolean = [], quiet = false): void {
    if (this.disposed) return;
    const checkPages = Array.isArray(checkPagesOrQuiet) ? checkPagesOrQuiet : [];
    if (typeof checkPagesOrQuiet === 'boolean') quiet = checkPagesOrQuiet;

    let addedQuiet = false;
    if (quiet) {
      for (const id of changes.pages) {
        const hasNonQuietPage = this.dirtyPages.has(id) && !this.quiet.has(id);
        const hasNonQuietWork =
          hasNonQuietPage || this.dirtyDocs.has(id) || this.removed.has(id) || this.checkPages.has(id);
        this.dirtyPages.add(id);
        if (hasNonQuietWork) this.quiet.delete(id);
        else this.quiet.add(id);
        addedQuiet = true;
      }
    } else {
      for (const id of changes.pages) {
        this.quiet.delete(id);
        this.dirtyPages.add(id);
      }
    }

    // Documents and removals are always real work, even if a caller batches them with a quiet page update.
    for (const id of changes.docs) this.dirtyDocs.add(id);
    for (const id of changes.removed) {
      this.quiet.delete(id);
      this.removed.add(id);
      this.dirtyPages.delete(id);
      this.dirtyDocs.delete(id);
    }
    for (const id of changes.docs) this.quiet.delete(id);
    for (const id of checkPages) {
      this.quiet.delete(id);
      this.checkPages.add(id);
    }
    if (!this.hasPending()) return;

    const hasNonQuietInput =
      !quiet || changes.docs.size > 0 || changes.removed.size > 0 || checkPages.length > 0;
    if (this.hasNonQuietPendingChanges()) {
      if (this.current.state !== 'error') this.setStatus({ ...this.current, state: 'pending' });
      const maySchedule = hasNonQuietInput || (this.timer === null && this.inFlight === null);
      if (!this.retryBlocked && maySchedule)
        this.schedule(this.current.state === 'error' ? this.retryDelay() : this.delayMs);
    } else if (addedQuiet && this.timer === null && this.inFlight === null && !this.retryBlocked) {
      this.schedule(this.current.state === 'error' ? this.retryDelay() : this.quietDelayMs);
    }
  }

  // writes everything outstanding now, resolves true when nothing is left unsaved
  async flush(): Promise<boolean> {
    if (this.disposed) return !this.hasPending();
    this.clearTimer();
    while (this.inFlight) await this.inFlight;
    if (this.dirtyPages.size + this.dirtyDocs.size + this.removed.size + this.checkPages.size > 0) {
      this.inFlight = this.writeOnce();
      await this.inFlight;
    }
    return !this.hasPending();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.listeners.clear();
  }

  private async writeOnce(): Promise<void> {
    const pages = [...this.dirtyPages];
    const docs = [...this.dirtyDocs];
    const removed = [...this.removed];
    const checkPages = [...this.checkPages];
    this.dirtyPages.clear();
    this.dirtyDocs.clear();
    this.removed.clear();
    this.checkPages.clear();
    const quietPages = new Set(pages.filter((id) => this.quiet.has(id)));
    const quietOnly =
      pages.length > 0 &&
      docs.length === 0 &&
      removed.length === 0 &&
      checkPages.length === 0 &&
      quietPages.size === pages.length;
    this.quiet.clear();
    this.writing = new Set([...pages, ...docs, ...removed, ...checkPages]);
    if (!quietOnly) this.setStatus({ ...this.current, state: 'saving' });

    const state = this.getState();
    const batch: WriteBatch = {
      pages: [],
      docs: [],
      removed: [],
      quietPageIds: [...quietPages].filter((id) => state.pages[id]),
      checkPages,
      state,
    };
    for (const id of pages) {
      const page = state.pages[id];
      if (page) batch.pages.push(page);
    }
    for (const id of docs) {
      const doc = state.docs[id];
      if (doc) batch.docs.push({ id, doc });
    }
    for (const id of removed) if (!state.pages[id]) batch.removed.push(id);

    try {
      batch.snapshots = this.options.snapshotsFor?.(
        batch.docs.map((record) => record.id),
        state,
      );
      await this.writer.write(batch);
      if (batch.snapshots?.length) this.options.onSnapshotsWritten?.(batch.snapshots);
      this.writing.clear();
      this.inFlight = null;
      const more = this.hasPendingChanges();
      const moreReal = this.hasNonQuietPendingChanges();
      if (!quietOnly || this.current.state === 'error') {
        this.setStatus({
          state: moreReal ? 'pending' : 'saved',
          lastSavedAt: quietOnly ? this.current.lastSavedAt : this.now(),
          error: null,
          errorCode: null,
          failures: 0,
        });
      }
      this.retryBlocked = false;
      if (more && this.timer === null) this.schedule(this.pendingDelay());
    } catch (error) {
      // put the ids back so the next attempt writes the latest version of each record
      for (const id of docs) if (!this.removed.has(id)) this.dirtyDocs.add(id);
      for (const id of removed) this.removed.add(id);
      for (const id of checkPages) this.checkPages.add(id);
      // Restore quiet status per captured page; unrelated real work in the batch does not affect it.
      for (const id of pages) {
        if (this.removed.has(id)) {
          this.dirtyPages.delete(id);
          this.quiet.delete(id);
          continue;
        }

        const newerNonQuietWork = this.hasNonQuietPendingFor(id);
        this.dirtyPages.add(id);
        if (quietPages.has(id) && !newerNonQuietWork) this.quiet.add(id);
        else this.quiet.delete(id);
      }
      this.writing.clear();
      this.inFlight = null;
      const nonRetryable = error instanceof WorkspaceWriteError && !error.retryable;
      this.retryBlocked = nonRetryable;
      this.setStatus({
        ...this.current,
        state: 'error',
        error: errorMessage(error),
        errorCode: error instanceof WorkspaceWriteError ? error.code : 'save-failed',
        failures: this.current.failures + 1,
      });
      if (!nonRetryable) this.schedule(this.retryDelay());
    }
  }

  private retryDelay(): number {
    return Math.min(this.maxRetryMs, 1000 * 2 ** Math.max(0, this.current.failures - 1));
  }

  private hasPendingChanges(): boolean {
    return this.dirtyPages.size + this.dirtyDocs.size + this.removed.size + this.checkPages.size > 0;
  }

  private hasNonQuietPendingChanges(): boolean {
    return (
      this.dirtyDocs.size + this.removed.size + this.checkPages.size > 0 ||
      [...this.dirtyPages].some((id) => !this.quiet.has(id))
    );
  }

  private hasNonQuietPendingFor(id: PageId): boolean {
    return (
      (this.dirtyPages.has(id) && !this.quiet.has(id)) ||
      this.dirtyDocs.has(id) ||
      this.removed.has(id) ||
      this.checkPages.has(id)
    );
  }

  private pendingDelay(): number {
    if (this.current.state === 'error') return this.retryDelay();
    return this.hasNonQuietPendingChanges() ? this.delayMs : this.quietDelayMs;
  }

  private schedule(delay: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private setStatus(status: SaveStatus): void {
    this.current = status;
    for (const listener of this.listeners) listener();
  }
}
