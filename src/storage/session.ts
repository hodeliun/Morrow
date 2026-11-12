import { applyCommand } from '../core/commands';
import type { Changes, Command } from '../core/commands';
import { isDocEmpty } from '../core/doc';
import { snapshotDue } from '../core/history';
import { emptyWorkspace } from '../core/model';
import type { DocNode, FileId, FileMeta, PageId, PageMeta, Snapshot, WorkspaceState } from '../core/model';
import { fail, ok } from '../core/result';
import type { Result } from '../core/result';
import { isEffectivelyTrashed } from '../core/tree';
import { WorkspaceWriteError } from './repository';
import { openRepository } from './repository';
import type { ExternalPatch, StoredFile, WorkspaceRepository, WriteBatch } from './repository';
import { SaveQueue } from './saveQueue';
import type { SaveQueueOptions, SaveStatus } from './saveQueue';
import { PilotDataHistory } from './pilotDataHistory';
import type {
  PilotDataHistoryCellValue,
  PilotDataHistoryDirection,
  PilotDataHistorySnapshot,
} from './pilotDataHistory';

// the single place where commands run, state lives and changes are queued for disk
export class WorkspaceSession {
  private state: WorkspaceState;
  private closed = false;
  private readonly pilotDataSessionId = crypto.randomUUID();
  private readonly pilotDataRevisions = new Map<PageId, { fingerprint: string | null; revision: number }>();
  private readonly pilotDataHistory = new PilotDataHistory();
  private pilotDataRevisionClock = 0;
  private readonly listeners = new Set<() => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly lastSnapshot = new Map<PageId, number>();
  // what each page held when it was last kept as a version, or when it was opened. a page saved with
  // nothing really different, such as only its edit time, gets no new version
  private readonly lastKept = new Map<PageId, string>();
  private readonly externalListeners = new Set<(patch: ExternalPatch, accepted: PageId[]) => void>();
  // runs before edits made elsewhere are applied, the app saves open editors here
  beforeExternal: () => void = () => {};
  readonly queue: SaveQueue;
  // one write to the vault at a time. a version kept for the assistant while the queue was still saving
  // could otherwise read a page's history before the other write added to it
  private writing: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly repository: WorkspaceRepository,
    initial: WorkspaceState,
    readonly unreadable: Set<PageId>,
    readonly protectedReasons: Map<PageId, string>,
    readonly problems: readonly string[],
    readonly firstRun: boolean,
    options: SaveQueueOptions,
  ) {
    this.state = initial;
    this.refreshPilotDataRevisions(initial);
    this.queue = new SaveQueue(
      {
        write: (batch) =>
          this.exclusive(async () => {
            if (batch.checkPages?.some((id) => !batch.state?.pages[id])) {
              throw new WorkspaceWriteError(
                'save-conflict',
                'A source database for a staged Polaris Dados edit no longer exists.',
                false,
              );
            }
            await repository.write(batch);
          }),
      },
      () => this.state,
      {
        ...options,
        snapshotsFor: (ids, state) => {
          const now = Date.now();
          return ids
            .filter((id) => {
              const doc = state.docs[id];
              // an empty page has nothing worth going back to, an encrypted one never keeps a plain copy
              return (
                doc &&
                !isDocEmpty(doc) &&
                !state.pages[id]?.encrypted &&
                snapshotDue(this.lastSnapshot.get(id), now) &&
                this.keptKey(id, state) !== (this.lastKept.get(id) ?? this.keptKey(id, initial))
              );
            })
            .map((id) => this.snapshotOf(id, state, now));
        },
        onSnapshotsWritten: (snapshots) => {
          for (const snapshot of snapshots) this.noteKept(snapshot);
        },
      },
    );
    repository.onExternalChange?.((patch) => this.applyExternal(patch));
  }

  get location(): string | null {
    return this.repository.location ?? null;
  }

  get supportsEncryption(): boolean {
    return this.repository.unlockPage !== undefined;
  }

  async unlockPage(id: PageId, password: string): Promise<Result<WorkspaceState>> {
    if (this.closed) return fail('The workspace session is closed.');
    if (this.protectedReasons.has(id)) return fail(this.protectionMessage(id));
    if (!this.repository.unlockPage) return fail('Encrypted pages need a vault folder.');
    const opened = await this.repository.unlockPage(id, password, this.state);
    if (!opened.ok) return opened;
    this.unreadable.delete(id);
    this.state = {
      pages: { ...this.state.pages, [id]: opened.value.page },
      docs: { ...this.state.docs, [id]: opened.value.doc },
    };
    this.refreshPilotDataRevisions(this.state);
    for (const listener of this.listeners) listener();
    return ok(this.state);
  }

  // saves the page, then forgets its key and its content until it is unlocked again
  async lockPage(id: PageId): Promise<void> {
    if (this.closed) return;
    if (this.protectedReasons.has(id)) return;
    await this.queue.flush();
    this.repository.lockPage?.(id);
    this.unreadable.add(id);
    const docs = { ...this.state.docs };
    delete docs[id];
    this.state = { pages: this.state.pages, docs };
    this.refreshPilotDataRevisions(this.state);
    for (const listener of this.listeners) listener();
  }

  async protectPage(id: PageId, password: string): Promise<Result<WorkspaceState>> {
    if (this.closed) return fail('The workspace session is closed.');
    if (!this.repository.protectPage) return fail('Encrypted pages need a vault folder.');
    if (this.unreadable.has(id)) return fail(this.protectionMessage(id));
    if (this.isPilotDataPage(id)) {
      return fail('Opted-in Polaris Dados databases and rows cannot be encrypted through generic page commands.');
    }
    await this.queue.flush();
    await this.repository.protectPage(id, password);
    const result = this.execute({ type: 'page.setEncrypted', id, encrypted: true, now: Date.now() });
    if (result.ok) await this.queue.flush();
    return result;
  }

  async unprotectPage(id: PageId): Promise<Result<WorkspaceState>> {
    if (this.closed) return fail('The workspace session is closed.');
    const result = this.execute({ type: 'page.setEncrypted', id, encrypted: false, now: Date.now() });
    if (!result.ok) return result;
    await this.queue.flush();
    this.repository.unprotectPage?.(id);
    return result;
  }

  readMeta(name: string): Promise<string | null> {
    return this.repository.readMeta?.(name) ?? Promise.resolve(null);
  }

  async writeMeta(name: string, text: string): Promise<void> {
    if (this.closed) throw new Error('The workspace session is closed.');
    await this.repository.writeMeta?.(name, text);
  }

  activity(): Record<string, number> {
    return this.repository.activity?.() ?? {};
  }

  pathOf(id: PageId): string | null {
    return this.repository.pathOf?.(id) ?? null;
  }

  fileUrl(id: FileId): string | null {
    return this.repository.fileUrl?.(id) ?? null;
  }

  onExternal(listener: (patch: ExternalPatch, accepted: PageId[]) => void): () => void {
    this.externalListeners.add(listener);
    return () => this.externalListeners.delete(listener);
  }

  // takes in pages changed by another app, a page with unsaved changes here keeps them
  // and the other version is kept in its history when this one is saved
  applyExternal(patch: ExternalPatch): PageId[] {
    if (this.closed) return [];
    this.beforeExternal();
    const previousState = this.state;
    const previousUnreadable = new Set(this.unreadable);
    const previousProtectedReasons = new Map(this.protectedReasons);
    const pages = { ...this.state.pages };
    const docs = { ...this.state.docs };
    const accepted: PageId[] = [];
    for (const page of patch.pages) {
      if (this.queue.isDirty(page.id)) continue;
      pages[page.id] = page;
      if (patch.docs[page.id]) docs[page.id] = patch.docs[page.id]!;
      accepted.push(page.id);
    }
    for (const id of patch.removed) {
      if (this.queue.isDirty(id)) continue;
      delete pages[id];
      delete docs[id];
      accepted.push(id);
    }
    const acceptedSet = new Set(accepted);
    for (const id of patch.unreadable) if (acceptedSet.has(id)) this.unreadable.add(id);
    for (const id of patch.readable) {
      if (!acceptedSet.has(id)) continue;
      this.unreadable.delete(id);
      this.protectedReasons.delete(id);
    }
    for (const [id, reason] of Object.entries(patch.protectedPages ?? {})) {
      if (acceptedSet.has(id)) this.protectedReasons.set(id, reason);
    }
    for (const id of patch.removed) if (acceptedSet.has(id)) this.protectedReasons.delete(id);
    if (accepted.length > 0) {
      this.state = { pages, docs };
      this.refreshPilotDataRevisions(this.state);
      const affectedDatabases = new Set([
        ...pilotDataDatabasesForPages(previousState, accepted),
        ...pilotDataDatabasesForPages(this.state, accepted),
      ]);
      for (const databaseId of affectedDatabases) {
        const previousFingerprint = pilotDataHistoryFingerprint(
          previousState,
          databaseId,
          previousUnreadable,
          previousProtectedReasons,
        );
        const nextFingerprint = pilotDataHistoryFingerprint(
          this.state,
          databaseId,
          this.unreadable,
          this.protectedReasons,
        );
        if (previousFingerprint !== nextFingerprint) this.pilotDataHistory.invalidate(databaseId);
      }
      for (const listener of this.listeners) listener();
    }
    for (const listener of this.externalListeners) listener(patch, accepted);
    return accepted;
  }

  static async open(
    repository?: WorkspaceRepository,
    options: SaveQueueOptions = {},
  ): Promise<Result<WorkspaceSession>> {
    const repo = repository ?? (await openRepository());
    const loaded = await repo.load();
    if (!loaded.ok) return loaded;
    const state = emptyWorkspace();
    const pages = Object.fromEntries(loaded.value.pages.map((page) => [page.id, page]));
    const session = new WorkspaceSession(
      repo,
      { ...state, pages, docs: loaded.value.docs },
      new Set(loaded.value.unreadable),
      new Map(Object.entries(loaded.value.protectedPages ?? {})),
      loaded.value.problems,
      loaded.value.firstRun,
      options,
    );
    repo.attachState?.(session.getState);
    return ok(session);
  }

  getState = (): WorkspaceState => this.state;

  get isClosed(): boolean {
    return this.closed;
  }

  /** Opaque, monotonic revision for the structured content of an opted-in database. */
  pilotDataRevision(databaseId: PageId): string {
    this.refreshPilotDataRevisions(this.state);
    return `${this.pilotDataSessionId}:r${this.pilotDataRevisions.get(databaseId)?.revision ?? 0}`;
  }

  /** Host-only cell write seam. Plugins receive the typed facade, never this session object. */
  patchPilotDataCell(input: {
    databaseId: PageId;
    rowId: PageId;
    propertyId: string;
    value: unknown;
    expectedRevision: string;
  }):
    | { ok: true; revision: string }
    | {
        ok: false;
        code:
          | 'session-closed'
          | 'unsupported'
          | 'not-opted-in'
          | 'stale-revision'
          | 'row-not-found'
          | 'property-not-found'
          | 'read-only'
          | 'invalid-value'
          | 'save-conflict';
        message: string;
      } {
    if (this.closed) return { ok: false, code: 'session-closed', message: 'The workspace session is closed.' };
    const state = this.state;
    const database = state.pages[input.databaseId];
    if (!database || !hasPilotDataMarker(database.extra)) {
      return { ok: false, code: 'not-opted-in', message: 'That database is not opted in to Polaris Dados.' };
    }
    if (
      database.kind !== 'database' ||
      !database.database ||
      this.unreadable.has(database.id) ||
      this.protectedReasons.has(database.id) ||
      database.encrypted ||
      isEffectivelyTrashed(state.pages, database.id)
    ) {
      return { ok: false, code: 'unsupported', message: 'That Polaris Dados database is unavailable or unsupported.' };
    }
    if (hasLiveCanvasRow(state.pages, database.id)) {
      return {
        ok: false,
        code: 'unsupported',
        message: 'Canvas rows are not supported by the Polaris Dados cell API.',
      };
    }
    const revision = this.pilotDataRevision(database.id);
    if (input.expectedRevision !== revision) {
      return { ok: false, code: 'stale-revision', message: 'The database changed after this snapshot was read.' };
    }
    if (this.queue.status.errorCode === 'save-conflict') {
      return {
        ok: false,
        code: 'save-conflict',
        message: this.queue.status.error ?? 'A prior Polaris Dados save conflicted; reopen the vault before editing again.',
      };
    }
    const value = input.value;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, code: 'invalid-value', message: 'A cell value must be a finite number.' };
    }
    const row = state.pages[input.rowId];
    if (!row || row.parentId !== database.id || isEffectivelyTrashed(state.pages, row.id)) {
      return { ok: false, code: 'row-not-found', message: 'That row is not a live member of this database.' };
    }
    if (row.encrypted || this.unreadable.has(row.id) || this.protectedReasons.has(row.id)) {
      return { ok: false, code: 'read-only', message: 'That row is read only.' };
    }
    const property = database.database.properties.find((candidate) => candidate.id === input.propertyId);
    if (!property) {
      return { ok: false, code: 'property-not-found', message: 'That database property no longer exists.' };
    }
    if (property.type !== 'number') {
      return { ok: false, code: 'read-only', message: 'Only manual number properties can be edited by this API.' };
    }
    const before = pilotDataCellValue(row.properties, property.id);
    if (!before) {
      return { ok: false, code: 'unsupported', message: 'That cell is not a representable numeric value.' };
    }
    if (before.present && before.value === value) return { ok: true, revision };
    let stagedRevision = revision;
    const result = this.executePilotDataCommand(
      {
        type: 'page.setProperties',
        id: row.id,
        values: { [property.id]: value },
        now: Date.now(),
      },
      database.id,
      () => {
        stagedRevision = this.pilotDataRevision(database.id);
        this.pilotDataHistory.record(database.id, {
          rowId: row.id,
          propertyId: property.id,
          before,
          after: { present: true, value },
        });
      },
    );
    if (!result.ok) return { ok: false, code: 'read-only', message: result.error };
    return { ok: true, revision: stagedRevision };
  }

  pilotDataHistorySnapshot(databaseId: PageId): PilotDataHistorySnapshot {
    return this.pilotDataHistory.snapshot(databaseId);
  }

  /** Host-only contextual data undo/redo; this does not run the native workspace history command. */
  pilotDataHistoryChange(input: { databaseId: PageId; direction: unknown; expectedRevision: unknown }):
    | { ok: true; status: 'staged' | 'no-op'; revision: string }
    | {
        ok: false;
        code:
          | 'session-closed'
          | 'invalid-value'
          | 'unsupported'
          | 'not-opted-in'
          | 'stale-revision'
          | 'row-not-found'
          | 'property-not-found'
          | 'read-only'
          | 'save-conflict';
        message: string;
      } {
    if (this.closed)
      return { ok: false, code: 'session-closed', message: 'The workspace session is closed.' };
    if (input.direction !== 'undo' && input.direction !== 'redo') {
      return { ok: false, code: 'invalid-value', message: 'History direction must be undo or redo.' };
    }
    const direction = input.direction as PilotDataHistoryDirection;
    if (typeof input.expectedRevision !== 'string') {
      return { ok: false, code: 'invalid-value', message: 'History requires a snapshot revision.' };
    }
    const database = this.state.pages[input.databaseId];
    if (!database || !hasPilotDataMarker(database.extra)) {
      return { ok: false, code: 'not-opted-in', message: 'That database is not opted in to Polaris Dados.' };
    }
    if (
      database.kind !== 'database' ||
      !database.database ||
      database.encrypted ||
      this.unreadable.has(database.id) ||
      this.protectedReasons.has(database.id) ||
      isEffectivelyTrashed(this.state.pages, database.id)
    ) {
      return {
        ok: false,
        code: 'unsupported',
        message: 'That Polaris Dados database is unavailable or unsupported.',
      };
    }
    if (hasLiveCanvasRow(this.state.pages, database.id)) {
      return {
        ok: false,
        code: 'unsupported',
        message: 'Canvas rows are not supported by Polaris Dados history.',
      };
    }
    const revision = this.pilotDataRevision(database.id);
    if (input.expectedRevision !== revision) {
      return {
        ok: false,
        code: 'stale-revision',
        message: 'The database changed after this snapshot was read.',
      };
    }
    if (this.queue.status.errorCode === 'save-conflict') {
      return {
        ok: false,
        code: 'save-conflict',
        message:
          this.queue.status.error ??
          'A prior Polaris Dados save conflicted; reopen the vault before editing again.',
      };
    }
    const entry = this.pilotDataHistory.peek(database.id, direction);
    if (!entry) return { ok: true, status: 'no-op', revision };
    if (!this.pilotDataHistory.canCommitMove(database.id, direction, entry)) {
      return {
        ok: false,
        code: 'stale-revision',
        message: 'That history step changed before it could be applied.',
      };
    }

    const row = this.state.pages[entry.rowId];
    if (!row || row.parentId !== database.id || isEffectivelyTrashed(this.state.pages, row.id)) {
      return {
        ok: false,
        code: 'row-not-found',
        message: 'That history row is no longer a live database member.',
      };
    }
    if (row.encrypted || this.unreadable.has(row.id) || this.protectedReasons.has(row.id)) {
      return { ok: false, code: 'read-only', message: 'That history row is read only.' };
    }
    const properties = database.database.properties.filter((candidate) => candidate.id === entry.propertyId);
    if (properties.length === 0) {
      return { ok: false, code: 'property-not-found', message: 'That history property no longer exists.' };
    }
    if (properties.length !== 1 || properties[0]!.type !== 'number') {
      return {
        ok: false,
        code: 'unsupported',
        message: 'That history property is no longer a unique number property.',
      };
    }

    const expectedCell = direction === 'undo' ? entry.after : entry.before;
    const targetCell = direction === 'undo' ? entry.before : entry.after;
    if (!isValidPilotDataCellValue(expectedCell) || !isValidPilotDataCellValue(targetCell)) {
      return {
        ok: false,
        code: 'unsupported',
        message: 'That history entry is not a valid numeric cell value.',
      };
    }
    const currentCell = pilotDataCellValue(row.properties, entry.propertyId);
    if (!currentCell || !samePilotDataCellValue(currentCell, expectedCell)) {
      return { ok: false, code: 'stale-revision', message: 'The cell no longer matches this history step.' };
    }

    const restoredProperties = { ...row.properties };
    if (targetCell.present) restoredProperties[entry.propertyId] = targetCell.value;
    else delete restoredProperties[entry.propertyId];
    const nextState: WorkspaceState = {
      ...this.state,
      pages: {
        ...this.state.pages,
        [row.id]: { ...row, properties: restoredProperties, updatedAt: Date.now() },
      },
    };
    const changes: Changes = { pages: new Set([row.id]), docs: new Set(), removed: new Set() };
    const refusal = this.validateChanges(changes, nextState, database.id);
    if (refusal) return { ok: false, code: 'read-only', message: refusal };

    const previousState = this.state;
    const previousDatabaseRevision = this.pilotDataRevisions.get(database.id);
    const previousRevisionClock = this.pilotDataRevisionClock;
    this.state = nextState;
    this.refreshPilotDataRevisions(this.state);
    const stagedRevision = this.pilotDataRevision(database.id);
    if (!this.pilotDataHistory.commitMove(database.id, direction, entry)) {
      this.state = previousState;
      if (previousDatabaseRevision) this.pilotDataRevisions.set(database.id, previousDatabaseRevision);
      else this.pilotDataRevisions.delete(database.id);
      this.pilotDataRevisionClock = previousRevisionClock;
      return {
        ok: false,
        code: 'stale-revision',
        message: 'That history step changed before it could be applied.',
      };
    }
    this.queue.enqueue(changes, [database.id]);
    for (const listener of this.listeners) listener();
    return { ok: true, status: 'staged', revision: stagedRevision };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  onClose(listener: () => void): () => void {
    if (this.closed) {
      listener();
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  get saveStatus(): SaveStatus {
    return this.queue.status;
  }

  execute(command: Command): Result<WorkspaceState> {
    return this.executeCommand(command);
  }

  private executePilotDataCommand(
    command: Command,
    databaseId: PageId,
    beforeQueue?: () => void,
  ): Result<WorkspaceState> {
    return this.executeCommand(command, databaseId, beforeQueue);
  }

  private executeCommand(
    command: Command,
    allowedPilotDataDatabaseId?: PageId,
    beforeQueue?: () => void,
  ): Result<WorkspaceState> {
    if (this.closed) return fail('The workspace session is closed.');
    const result = applyCommand(this.state, command);
    if (!result.ok) return result;
    const { state, changes } = result.value;
    if (state === this.state) return ok(state);
    const refusal = this.validateChanges(changes, state, allowedPilotDataDatabaseId);
    if (refusal) return fail(refusal);
    this.state = state;
    this.refreshPilotDataRevisions(this.state);
    beforeQueue?.();
    this.queue.enqueue(changes, allowedPilotDataDatabaseId ? [allowedPilotDataDatabaseId] : []);
    for (const listener of this.listeners) listener();
    return ok(state);
  }

  // runs several commands as one unit, nothing is applied if any of them fails
  executeAll(commands: Command[]): Result<WorkspaceState> {
    if (this.closed) return fail('The workspace session is closed.');
    let draft = this.state;
    const all = { pages: new Set<PageId>(), docs: new Set<PageId>(), removed: new Set<PageId>() };
    for (const command of commands) {
      const result = applyCommand(draft, command);
      if (!result.ok) return result;
      draft = result.value.state;
      for (const id of result.value.changes.pages) all.pages.add(id);
      for (const id of result.value.changes.docs) all.docs.add(id);
      for (const id of result.value.changes.removed) all.removed.add(id);
    }
    const refusal = this.validateChanges(all, draft);
    if (refusal) return fail(refusal);
    this.state = draft;
    this.refreshPilotDataRevisions(this.state);
    this.queue.enqueue(all);
    for (const listener of this.listeners) listener();
    return ok(draft);
  }

  flush(): Promise<boolean> {
    return this.queue.flush();
  }

  markInitialized(): Promise<void> {
    return this.repository.markInitialized();
  }

  // files are written straight away, a page only references them once they are safely stored
  async addFiles(files: StoredFile[]): Promise<Result<FileMeta[]>> {
    try {
      return ok(await this.repository.putFiles(files));
    } catch (error) {
      return fail(`The file could not be saved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  getFile(id: FileId): Promise<StoredFile | null> {
    return this.repository.getFile(id);
  }

  listFiles(): Promise<FileMeta[]> {
    return this.repository.listFiles();
  }

  deleteFiles(ids: FileId[]): Promise<void> {
    if (ids.length > 0 && this.unreadable.size > 0) {
      const id = this.unreadable.values().next().value as PageId;
      return Promise.reject(
        new Error(`Files could not be deleted because a protected page may reference them: ${this.protectionMessage(id)}`),
      );
    }
    return this.repository.deleteFiles(ids);
  }

  listSnapshots(pageId: PageId): Promise<Snapshot[]> {
    return this.repository.listSnapshots(pageId);
  }

  allSnapshots(): Promise<Snapshot[]> {
    return this.repository.allSnapshots();
  }

  changeSnapshot(pageId: PageId, id: string, change: { name: string } | null): Promise<void> {
    if (this.unreadable.has(pageId)) return Promise.reject(new Error(this.protectionMessage(pageId)));
    return this.repository.changeSnapshot(pageId, id, change);
  }

  // earlier versions brought over from another storage, written as they are
  async importSnapshots(snapshots: Snapshot[]): Promise<void> {
    if (snapshots.length === 0) return;
    if (snapshots.some((snapshot) => this.isPilotDataPage(snapshot.pageId))) {
      throw new Error('History for opted-in Polaris Dados databases and rows is not writable through generic APIs.');
    }
    const protectedSnapshot = snapshots.find((snapshot) => this.unreadable.has(snapshot.pageId));
    if (protectedSnapshot) throw new Error(this.protectionMessage(protectedSnapshot.pageId));
    await this.queue.flush();
    await this.exclusive(() =>
      this.repository.write({ pages: [], docs: [], removed: [], snapshots, state: this.state }),
    );
  }

  // the current content is kept as a version first, so restoring can always be undone
  async restoreSnapshot(snapshot: Snapshot): Promise<Result<WorkspaceState>> {
    if (this.closed) return fail('The workspace session is closed.');
    if (!this.state.pages[snapshot.pageId]) return fail('That page no longer exists.');
    if (this.isPilotDataPage(snapshot.pageId)) {
      return fail('History for opted-in Polaris Dados databases and rows cannot be restored through generic APIs.');
    }
    if (this.unreadable.has(snapshot.pageId)) return fail(this.protectionMessage(snapshot.pageId));
    await this.queue.flush();
    try {
      const current = this.snapshotOf(snapshot.pageId, this.state, Date.now());
      await this.exclusive(() =>
        this.repository.write({ pages: [], docs: [], removed: [], snapshots: [current] }),
      );
      this.noteKept(current);
    } catch (error) {
      return fail(`The current version could not be kept, so nothing was restored: ${String(error)}`);
    }
    const restored = this.execute({
      type: 'page.setDoc',
      id: snapshot.pageId,
      doc: snapshot.doc,
      now: Date.now(),
    });
    // a version kept before properties were part of history leaves them as they are
    if (!restored.ok || (!snapshot.properties && !snapshot.extra)) return restored;
    return this.execute({
      type: 'page.setFields',
      id: snapshot.pageId,
      ...(snapshot.properties ? { properties: snapshot.properties } : {}),
      ...(snapshot.extra ? { extra: snapshot.extra } : {}),
      now: Date.now(),
    });
  }

  // the page as it is now is kept in its history, before the assistant changes it for you
  async keepVersion(pageId: PageId): Promise<void> {
    if (this.unreadable.has(pageId)) return;
    const doc = this.state.docs[pageId];
    if (!doc || isDocEmpty(doc) || this.state.pages[pageId]?.encrypted) return;
    await this.queue.flush();
    // the page as it is was already kept, a second copy of it would only push older versions out
    if (this.lastKept.get(pageId) === this.keptKey(pageId, this.state)) return;
    const current = this.snapshotOf(pageId, this.state, Date.now());
    await this.exclusive(() =>
      this.repository.write({ pages: [], docs: [], removed: [], snapshots: [current] }),
    );
    this.noteKept(current);
  }

  private validateChanges(
    changes: { pages: Set<PageId>; docs: Set<PageId>; removed: Set<PageId> },
    state: WorkspaceState,
    allowedPilotDataDatabaseId?: PageId,
  ): string | null {
    const pilotDataRefusal = this.validatePilotDataChanges(state, allowedPilotDataDatabaseId);
    if (pilotDataRefusal) return pilotDataRefusal;
    const touched = new Set<PageId>([...changes.pages, ...changes.docs, ...changes.removed]);
    for (const id of touched) if (this.unreadable.has(id)) return this.protectionMessage(id);
    const batch: WriteBatch = {
      pages: [...changes.pages].flatMap((id) => (state.pages[id] ? [state.pages[id]!] : [])),
      docs: [...changes.docs].flatMap((id) => (state.docs[id] ? [{ id, doc: state.docs[id]! }] : [])),
      removed: [...changes.removed].filter((id) => !state.pages[id]),
      state,
    };
    return this.repository.validateWrite?.(batch) ?? null;
  }

  private validatePilotDataChanges(state: WorkspaceState, allowedDatabaseId?: PageId): string | null {
    const databaseIds = new Set<PageId>();
    for (const page of Object.values(this.state.pages))
      if (page.kind === 'database' && hasPilotDataMarker(page.extra)) databaseIds.add(page.id);
    for (const page of Object.values(state.pages))
      if (page.kind === 'database' && hasPilotDataMarker(page.extra)) databaseIds.add(page.id);

    for (const databaseId of databaseIds) {
      if (databaseId === allowedDatabaseId) continue;
      const next = pilotDataFingerprint(state, databaseId, this.unreadable, this.protectedReasons);
      const current = pilotDataFingerprint(this.state, databaseId, this.unreadable, this.protectedReasons);
      if (next !== current) {
        return 'Opted-in Polaris Dados databases and rows can only be changed through the host data API.';
      }
    }
    return null;
  }

  private isPilotDataPage(id: PageId): boolean {
    const page = this.state.pages[id];
    if (!page) return false;
    if (page.kind === 'database' && hasPilotDataMarker(page.extra)) return true;
    const parent = page.parentId ? this.state.pages[page.parentId] : undefined;
    return parent?.kind === 'database' && hasPilotDataMarker(parent.extra);
  }

  private refreshPilotDataRevisions(state: WorkspaceState): void {
    const databaseIds = new Set<PageId>(this.pilotDataRevisions.keys());
    for (const page of Object.values(state.pages))
      if (page.kind === 'database' && hasPilotDataMarker(page.extra)) databaseIds.add(page.id);
    for (const databaseId of databaseIds) {
      const fingerprint = pilotDataFingerprint(state, databaseId, this.unreadable, this.protectedReasons);
      const previous = this.pilotDataRevisions.get(databaseId);
      if (!previous || previous.fingerprint !== fingerprint) {
        this.pilotDataRevisionClock += 1;
        this.pilotDataRevisions.set(databaseId, { fingerprint, revision: this.pilotDataRevisionClock });
      }
    }
  }

  private protectionMessage(id: PageId): string {
    const reason = this.protectedReasons.get(id);
    return reason
      ? `This page is protected because Morrow cannot safely represent its content: ${reason}`
      : 'This page could not be read and is protected from changes.';
  }

  private exclusive<T>(write: () => Promise<T>): Promise<T> {
    const next = this.writing.then(write, write);
    this.writing = next.catch(() => {});
    return next;
  }

  // a version is a copy, nothing done to the page afterwards can reach into it
  private snapshotOf(pageId: PageId, state: WorkspaceState, now: number): Snapshot {
    const page = state.pages[pageId];
    return structuredClone({
      id: crypto.randomUUID(),
      pageId,
      title: page?.title ?? '',
      doc: state.docs[pageId] as DocNode,
      createdAt: now,
      properties: page?.properties ?? {},
      extra: page?.extra ?? {},
    });
  }

  // everything a version holds, as one string to compare
  private keptKey(pageId: PageId, state: WorkspaceState): string {
    const page = state.pages[pageId];
    return JSON.stringify([
      page?.title ?? '',
      state.docs[pageId] ?? null,
      page?.properties ?? {},
      page?.extra ?? {},
    ]);
  }

  private noteKept(snapshot: Snapshot): void {
    this.lastSnapshot.set(snapshot.pageId, snapshot.createdAt);
    this.lastKept.set(
      snapshot.pageId,
      JSON.stringify([snapshot.title, snapshot.doc, snapshot.properties ?? {}, snapshot.extra ?? {}]),
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener();
    this.closeListeners.clear();
    await this.queue.flush();
    this.queue.dispose();
    this.repository.close();
  }
}

function hasPilotDataMarker(extra: Record<string, unknown>): boolean {
  return Object.hasOwn(extra, 'polarisDados');
}

function hasLiveCanvasRow(pages: Record<PageId, PageMeta>, databaseId: PageId): boolean {
  return Object.values(pages).some(
    (page) => page.parentId === databaseId && page.kind === 'canvas' && !isEffectivelyTrashed(pages, page.id),
  );
}

function pilotDataCellValue(
  properties: Record<string, unknown>,
  propertyId: string,
): PilotDataHistoryCellValue | null {
  if (!Object.hasOwn(properties, propertyId)) return { present: false, value: null };
  const value = properties[propertyId];
  if (value === null) return { present: true, value: null };
  if (typeof value === 'number' && Number.isFinite(value)) return { present: true, value };
  return null;
}

function isValidPilotDataCellValue(value: PilotDataHistoryCellValue): boolean {
  return value.present === false
    ? value.value === null
    : value.value === null || (typeof value.value === 'number' && Number.isFinite(value.value));
}

function samePilotDataCellValue(a: PilotDataHistoryCellValue, b: PilotDataHistoryCellValue): boolean {
  return a.present === b.present && a.value === b.value;
}

function pilotDataDatabasesForPages(state: WorkspaceState, pageIds: PageId[]): Set<PageId> {
  const databases = new Set<PageId>();
  for (const id of pageIds) {
    const page = state.pages[id];
    if (!page) continue;
    if (page.kind === 'database' && hasPilotDataMarker(page.extra)) databases.add(page.id);
    const parent = page.parentId ? state.pages[page.parentId] : undefined;
    if (parent?.kind === 'database' && hasPilotDataMarker(parent.extra)) databases.add(parent.id);
  }
  return databases;
}

/** Fingerprint only the structured snapshot and its representability, not row body/vendor metadata. */
function pilotDataHistoryFingerprint(
  state: WorkspaceState,
  databaseId: PageId,
  unreadable: Set<PageId>,
  protectedReasons: Map<PageId, string>,
): string | null {
  const database = state.pages[databaseId];
  if (!database || database.kind !== 'database' || !hasPilotDataMarker(database.extra)) return null;
  const propertyNames = new Set(
    database.database?.properties.map((property) => property.name.trim().toLowerCase()) ?? [],
  );
  const rows = Object.values(state.pages)
    .filter((page) => page.parentId === databaseId)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((page) => [
      page.id,
      page.parentId,
      page.kind,
      page.title,
      page.trashedAt,
      page.encrypted,
      page.properties,
      Object.keys(page.extra)
        .filter((key) => propertyNames.has(key.trim().toLowerCase()))
        .sort(),
      unreadable.has(page.id),
      protectedReasons.get(page.id) ?? null,
    ]);
  return JSON.stringify([
    database.id,
    database.parentId,
    database.kind,
    database.title,
    database.trashedAt,
    database.encrypted,
    database.properties,
    database.database,
    database.extra.polarisDados,
    unreadable.has(database.id),
    protectedReasons.get(database.id) ?? null,
    rows,
  ]);
}

function pilotDataFingerprint(
  state: WorkspaceState,
  databaseId: PageId,
  unreadable: Set<PageId>,
  protectedReasons: Map<PageId, string>,
): string | null {
  const database = state.pages[databaseId];
  if (!database || database.kind !== 'database' || !hasPilotDataMarker(database.extra)) return null;
  const rows = Object.values(state.pages)
    .filter((page) => page.parentId === databaseId)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((page) => [
      page.id,
      page.parentId,
      page.kind,
      page.title,
      page.trashedAt,
      page.encrypted,
      page.properties,
      page.extra,
      state.docs[page.id] ?? null,
      unreadable.has(page.id),
      protectedReasons.get(page.id) ?? null,
    ]);
  return JSON.stringify([
    database.id,
    database.parentId,
    database.kind,
    database.title,
    database.trashedAt,
    database.encrypted,
    database.properties,
    database.database,
    database.extra,
    state.docs[database.id] ?? null,
    unreadable.has(database.id),
    protectedReasons.get(database.id) ?? null,
    rows,
  ]);
}
