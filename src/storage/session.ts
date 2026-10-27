import { applyCommand } from '../core/commands';
import type { Command } from '../core/commands';
import { isDocEmpty } from '../core/doc';
import { snapshotDue } from '../core/history';
import { emptyWorkspace } from '../core/model';
import type {
  DocNode,
  FileId,
  FileMeta,
  FormulaReferenceBinding,
  PageId,
  PageMeta,
  Snapshot,
  WorkspaceState,
} from '../core/model';
import { fail, ok } from '../core/result';
import type { Result } from '../core/result';
import { descendantsOf, isDescendantOf } from '../core/tree';
import { openRepository } from './repository';
import type { ExternalPatch, StoredFile, WorkspaceRepository } from './repository';
import { SaveQueue } from './saveQueue';
import type { SaveQueueOptions, SaveStatus } from './saveQueue';

type DatabasePasteDirection = 'undo' | 'redo';

interface DatabasePasteRecord {
  databaseId: PageId;
  hostPageId: PageId;
  pages: PageMeta[];
  docs: Record<PageId, DocNode>;
  active: boolean;
}

function countPageLinks(doc: DocNode, id: PageId): number {
  let count = 0;
  const visit = (node: DocNode) => {
    if (node.type === 'pageLink' && node.attrs?.id === id) count++;
    for (const child of node.content ?? []) visit(child);
  };
  visit(doc);
  return count;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function samePageExceptOpenedAt(expected: PageMeta, current: PageMeta): boolean {
  return sameJson(expected, { ...current, lastOpenedAt: expected.lastOpenedAt });
}

function valueReferencesAnyPage(value: unknown, pageIds: ReadonlySet<PageId>): boolean {
  if (typeof value === 'string') return pageIds.has(value);
  return Array.isArray(value) && value.some((item) => typeof item === 'string' && pageIds.has(item));
}

function bindingsReferenceAnyPage(
  bindings: FormulaReferenceBinding[] | undefined,
  pageIds: ReadonlySet<PageId>,
): boolean {
  return (
    bindings?.some((binding) => {
      if (binding.kind === 'database' || binding.kind === 'property') return pageIds.has(binding.databaseId);
      return pageIds.has(binding.pageId);
    }) ?? false
  );
}

function docReferencesAnyPage(doc: DocNode, pageIds: ReadonlySet<PageId>): boolean {
  let found = false;
  const visit = (node: DocNode) => {
    if (found) return;
    if (node.type === 'pageLink' && typeof node.attrs?.id === 'string' && pageIds.has(node.attrs.id)) {
      found = true;
      return;
    }
    if (
      node.type === 'linkedDatabaseView' &&
      typeof node.attrs?.sourceDatabaseId === 'string' &&
      pageIds.has(node.attrs.sourceDatabaseId)
    ) {
      found = true;
      return;
    }
    if (
      (node.type === 'namedControl' || node.type === 'calculatedResult') &&
      typeof node.attrs?.pageId === 'string' &&
      pageIds.has(node.attrs.pageId)
    ) {
      found = true;
      return;
    }
    for (const child of node.content ?? []) visit(child);
  };
  visit(doc);
  return found;
}

function databaseReferencesAnyPage(
  database: NonNullable<PageMeta['database']>,
  pageIds: ReadonlySet<PageId>,
): boolean {
  for (const property of database.properties) {
    if (property.relation?.targetDatabaseId && pageIds.has(property.relation.targetDatabaseId)) return true;
    if (bindingsReferenceAnyPage(property.formulaBindings, pageIds)) return true;
    if (bindingsReferenceAnyPage(property.defaultFormulaBindings, pageIds)) return true;
  }
  for (const view of database.views) {
    const rules = [
      ...view.filters,
      ...(view.filterGroups ?? []).flatMap((group) => group.filters),
      ...(view.conditionalFormats ?? []),
    ];
    if (rules.some((rule) => bindingsReferenceAnyPage(rule.formulaBindings, pageIds))) return true;
  }
  return false;
}

function pageReferencesAnyPage(page: PageMeta, state: WorkspaceState, pageIds: ReadonlySet<PageId>): boolean {
  if (page.database && databaseReferencesAnyPage(page.database, pageIds)) return true;
  if (
    page.controls.some(
      (control) =>
        (control.relation?.targetDatabaseId !== null &&
          control.relation?.targetDatabaseId !== undefined &&
          pageIds.has(control.relation.targetDatabaseId)) ||
        valueReferencesAnyPage(control.value, pageIds),
    )
  )
    return true;

  const parentDatabase = page.parentId ? state.pages[page.parentId]?.database : null;
  if (!parentDatabase) return false;
  return parentDatabase.properties.some((property) => {
    if (property.type !== 'relation') return false;
    return (
      (property.relation?.targetDatabaseId !== null &&
        property.relation?.targetDatabaseId !== undefined &&
        pageIds.has(property.relation.targetDatabaseId)) ||
      valueReferencesAnyPage(page.properties[property.id], pageIds)
    );
  });
}

function hasExternalReferences(
  state: WorkspaceState,
  removedPageIds: ReadonlySet<PageId>,
  hostPageId: PageId,
  hostPageAfter: DocNode,
): boolean {
  for (const page of Object.values(state.pages)) {
    if (removedPageIds.has(page.id)) continue;
    const doc = page.id === hostPageId ? hostPageAfter : state.docs[page.id];
    if (doc && docReferencesAnyPage(doc, removedPageIds)) return true;
    if (pageReferencesAnyPage(page, state, removedPageIds)) return true;
  }
  return false;
}

// the single place where commands run, state lives and changes are queued for disk
export class WorkspaceSession {
  private state: WorkspaceState;
  private readonly listeners = new Set<() => void>();
  private readonly lastSnapshot = new Map<PageId, number>();
  private readonly externalListeners = new Set<(patch: ExternalPatch, accepted: PageId[]) => void>();
  private readonly databasePastes = new Map<PageId, DatabasePasteRecord>();
  // runs before edits made elsewhere are applied, the app saves open editors here
  beforeExternal: () => void = () => {};
  readonly queue: SaveQueue;

  private constructor(
    private readonly repository: WorkspaceRepository,
    initial: WorkspaceState,
    readonly unreadable: Set<PageId>,
    readonly problems: readonly string[],
    readonly firstRun: boolean,
    options: SaveQueueOptions,
  ) {
    this.state = initial;
    this.queue = new SaveQueue(repository, () => this.state, {
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
              snapshotDue(this.lastSnapshot.get(id), now)
            );
          })
          .map((id) => this.snapshotOf(id, state, now));
      },
      onSnapshotsWritten: (snapshots) => {
        for (const snapshot of snapshots) this.lastSnapshot.set(snapshot.pageId, snapshot.createdAt);
      },
    });
    repository.onExternalChange?.((patch) => this.applyExternal(patch));
  }

  get location(): string | null {
    return this.repository.location ?? null;
  }

  get supportsEncryption(): boolean {
    return this.repository.unlockPage !== undefined;
  }

  async unlockPage(id: PageId, password: string): Promise<Result<WorkspaceState>> {
    if (!this.repository.unlockPage) return fail('Encrypted pages need a vault folder.');
    const opened = await this.repository.unlockPage(id, password, this.state);
    if (!opened.ok) return opened;
    this.unreadable.delete(id);
    this.state = {
      pages: { ...this.state.pages, [id]: opened.value.page },
      docs: { ...this.state.docs, [id]: opened.value.doc },
    };
    for (const listener of this.listeners) listener();
    return ok(this.state);
  }

  // saves the page, then forgets its key and its content until it is unlocked again
  async lockPage(id: PageId): Promise<void> {
    await this.queue.flush();
    this.repository.lockPage?.(id);
    this.unreadable.add(id);
    const docs = { ...this.state.docs };
    delete docs[id];
    this.state = { pages: this.state.pages, docs };
    for (const listener of this.listeners) listener();
  }

  async protectPage(id: PageId, password: string): Promise<Result<WorkspaceState>> {
    if (!this.repository.protectPage) return fail('Encrypted pages need a vault folder.');
    await this.queue.flush();
    await this.repository.protectPage(id, password);
    const result = this.execute({ type: 'page.setEncrypted', id, encrypted: true, now: Date.now() });
    if (result.ok) await this.queue.flush();
    return result;
  }

  async unprotectPage(id: PageId): Promise<Result<WorkspaceState>> {
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
    this.beforeExternal();
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
    for (const id of patch.readable) if (acceptedSet.has(id)) this.unreadable.delete(id);
    if (accepted.length > 0) {
      this.state = { pages, docs };
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
      loaded.value.problems,
      loaded.value.firstRun,
      options,
    );
    repo.attachState?.(session.getState);
    return ok(session);
  }

  getState = (): WorkspaceState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get saveStatus(): SaveStatus {
    return this.queue.status;
  }

  execute(command: Command): Result<WorkspaceState> {
    const id = 'id' in command ? command.id : 'pageId' in command ? command.pageId : null;
    if (
      typeof id === 'string' &&
      this.unreadable.has(id) &&
      (command.type === 'page.setDoc' || command.type === 'task.setChecked')
    ) {
      return fail('This page could not be read, so it is protected from changes.');
    }
    const result = applyCommand(this.state, command);
    if (!result.ok) return result;
    const { state, changes } = result.value;
    if (state === this.state) return ok(state);
    this.state = state;
    this.queue.enqueue(changes);
    for (const listener of this.listeners) listener();
    return ok(state);
  }

  // runs several commands as one unit, nothing is applied if any of them fails
  executeAll(commands: Command[]): Result<WorkspaceState> {
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
    this.state = draft;
    this.queue.enqueue(all);
    for (const listener of this.listeners) listener();
    return ok(draft);
  }

  // database paste creates ordinary pages, while its visible link lives in an editor history event
  insertDatabasePaste(
    databaseId: PageId,
    hostPageId: PageId,
    pages: PageMeta[],
    docs: Record<PageId, DocNode>,
  ): Result<WorkspaceState> {
    if (this.databasePastes.has(databaseId)) return fail('This database paste is already being tracked.');
    const root = pages.find((page) => page.id === databaseId);
    if (!this.state.pages[hostPageId] || root?.parentId !== hostPageId)
      return fail('The database paste destination is no longer available.');

    const inserted = this.execute({ type: 'pages.insert', pages, docs });
    if (!inserted.ok) return inserted;
    const insertedPages = pages.map((page) => structuredClone(inserted.value.pages[page.id]!));
    const insertedDocs = Object.fromEntries(
      insertedPages.map((page) => [page.id, structuredClone(inserted.value.docs[page.id]!)]),
    );
    this.databasePastes.set(databaseId, {
      databaseId,
      hostPageId,
      pages: insertedPages,
      docs: insertedDocs,
      active: true,
    });
    return inserted;
  }

  databasePastesForHistory(
    hostPageId: PageId,
    before: DocNode,
    after: DocNode,
    direction: DatabasePasteDirection,
  ): PageId[] {
    const changed: PageId[] = [];
    for (const [databaseId, paste] of this.databasePastes) {
      if (paste.hostPageId !== hostPageId) continue;
      const beforeCount = countPageLinks(before, databaseId);
      const afterCount = countPageLinks(after, databaseId);
      if (direction === 'undo' && paste.active && beforeCount > 0 && afterCount === 0)
        changed.push(databaseId);
      if (direction === 'redo' && !paste.active && beforeCount === 0 && afterCount > 0)
        changed.push(databaseId);
    }
    return changed;
  }

  // applies all affected copies together, and refuses to delete pages edited or added since the paste
  transitionDatabasePastes(
    databaseIds: PageId[],
    direction: DatabasePasteDirection,
    hostPageAfter?: DocNode,
  ): Result<WorkspaceState> {
    const uniqueIds = [...new Set(databaseIds)];
    if (uniqueIds.length === 0) return ok(this.state);
    const records = uniqueIds.map((id) => this.databasePastes.get(id));
    if (records.some((record) => !record)) return fail('The database paste can no longer be restored.');
    const pastes = records as DatabasePasteRecord[];
    if (pastes.some((paste) => paste.active !== (direction === 'undo')))
      return fail('The database paste has already changed history state.');

    const commands: Command[] = [];
    if (direction === 'undo') {
      const scheduledPages = new Set(pastes.flatMap((paste) => paste.pages.map((page) => page.id)));
      for (const paste of pastes) {
        if (!this.state.pages[paste.databaseId])
          return fail('A copied database page is no longer available.');
        for (const expected of paste.pages) {
          const current = this.state.pages[expected.id];
          if (!current || !samePageExceptOpenedAt(expected, current))
            return fail('A copied database has changed since it was pasted.');
          const expectedDoc = paste.docs[expected.id];
          const currentDoc = this.state.docs[expected.id];
          if (expectedDoc ? !currentDoc || !sameJson(expectedDoc, currentDoc) : currentDoc !== undefined)
            return fail('A copied database has changed since it was pasted.');
        }
        const descendants = descendantsOf(this.state.pages, paste.databaseId);
        if (descendants.some((page) => !scheduledPages.has(page.id)))
          return fail('A copied database has new pages that must be kept.');
      }

      const hostPageIds = new Set(pastes.map((paste) => paste.hostPageId));
      if (hostPageIds.size !== 1 || !hostPageAfter)
        return fail('The editor state is not available to undo this database paste safely.');
      if (hasExternalReferences(this.state, scheduledPages, [...hostPageIds][0]!, hostPageAfter))
        return fail('A copied database is referenced outside the paste.');

      const roots = pastes.map((paste) => paste.databaseId);
      for (const rootId of roots) commands.push({ type: 'page.trash', id: rootId, now: Date.now() });
      for (const rootId of roots) {
        if (roots.some((other) => other !== rootId && isDescendantOf(this.state.pages, rootId, other)))
          continue;
        commands.push({ type: 'page.deleteForever', id: rootId });
      }
    } else {
      const pending = [...pastes];
      const ordered: DatabasePasteRecord[] = [];
      while (pending.length > 0) {
        const ready = pending.filter((paste) =>
          paste.pages.every(
            (page) =>
              !page.parentId ||
              !pending.some(
                (other) => other !== paste && other.pages.some((parent) => parent.id === page.parentId),
              ),
          ),
        );
        if (ready.length === 0) return fail('The copied database pages cannot be restored safely.');
        for (const paste of ready) {
          ordered.push(paste);
          pending.splice(pending.indexOf(paste), 1);
        }
      }
      for (const paste of ordered) {
        if (paste.pages.some((page) => this.state.pages[page.id]))
          return fail('A copied database page ID is already in use.');
        commands.push({ type: 'pages.insert', pages: paste.pages, docs: paste.docs });
      }
    }

    let draft = this.state;
    for (const command of commands) {
      const result = applyCommand(draft, command);
      if (!result.ok) return result;
      draft = result.value.state;
    }
    const applied = this.executeAll(commands);
    if (!applied.ok) return applied;
    for (const paste of pastes) paste.active = direction === 'redo';
    return applied;
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
    return this.repository.deleteFiles(ids);
  }

  listSnapshots(pageId: PageId): Promise<Snapshot[]> {
    return this.repository.listSnapshots(pageId);
  }

  allSnapshots(): Promise<Snapshot[]> {
    return this.repository.allSnapshots();
  }

  // earlier versions brought over from another storage, written as they are
  async importSnapshots(snapshots: Snapshot[]): Promise<void> {
    if (snapshots.length === 0) return;
    await this.queue.flush();
    await this.repository.write({ pages: [], docs: [], removed: [], snapshots, state: this.state });
  }

  // the current content is kept as a version first, so restoring can always be undone
  async restoreSnapshot(snapshot: Snapshot): Promise<Result<WorkspaceState>> {
    if (!this.state.pages[snapshot.pageId]) return fail('That page no longer exists.');
    await this.queue.flush();
    try {
      const current = this.snapshotOf(snapshot.pageId, this.state, Date.now());
      await this.repository.write({ pages: [], docs: [], removed: [], snapshots: [current] });
      this.lastSnapshot.set(snapshot.pageId, current.createdAt);
    } catch (error) {
      return fail(`The current version could not be kept, so nothing was restored: ${String(error)}`);
    }
    return this.execute({ type: 'page.setDoc', id: snapshot.pageId, doc: snapshot.doc, now: Date.now() });
  }

  // the page as it is now is kept in its history, before the assistant changes it for you
  async keepVersion(pageId: PageId): Promise<void> {
    const doc = this.state.docs[pageId];
    if (!doc || isDocEmpty(doc) || this.state.pages[pageId]?.encrypted) return;
    await this.queue.flush();
    const current = this.snapshotOf(pageId, this.state, Date.now());
    await this.repository.write({ pages: [], docs: [], removed: [], snapshots: [current] });
    this.lastSnapshot.set(pageId, current.createdAt);
  }

  private snapshotOf(pageId: PageId, state: WorkspaceState, now: number): Snapshot {
    return {
      id: crypto.randomUUID(),
      pageId,
      title: state.pages[pageId]?.title ?? '',
      doc: state.docs[pageId] as DocNode,
      createdAt: now,
    };
  }

  async close(): Promise<void> {
    await this.queue.flush();
    this.queue.dispose();
    this.repository.close();
  }
}
