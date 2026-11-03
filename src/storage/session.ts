import { applyCommand } from '../core/commands';
import type { Command } from '../core/commands';
import { isDocEmpty } from '../core/doc';
import { snapshotDue } from '../core/history';
import { emptyWorkspace } from '../core/model';
import type {
  DatabaseDef,
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
import { descendantsOf, isDescendantOf, isEffectivelyTrashed } from '../core/tree';
import type { FileCatalogSnapshot } from '../core/vault/fileCatalog';
import { openRepository } from './repository';
import type { ExternalPatch, StoredFile, WorkspaceRepository } from './repository';
import { SaveQueue } from './saveQueue';
import type { SaveQueueOptions, SaveStatus } from './saveQueue';
import { SessionDataHistory } from './dataHistory';
import type {
  DataHistoryCaptureContext,
  DataHistoryEntryStatus,
  DataHistorySnapshot,
  DataHistoryStepResult,
  OrderedDataHistoryItem,
} from './dataHistory';
import type { TableActionHistoryEntry } from './tableActions';
import { restoreTableActionHistory } from './tableActions';
import { SessionHistoryBudget } from './historyBudget';
import { SessionViewHistory } from './viewHistory';
import type {
  OrderedViewHistoryItem,
  ViewHistoryEntry,
  ViewHistoryEntryStatus,
  ViewHistorySnapshot,
  ViewHistoryStepResult,
} from './viewHistory';
import {
  linkedViewHostMatches,
  linkedViewConfigChanges,
  linkedViewConfigSnapshot,
  primaryViewConfigChanges,
  replaceLinkedViewConfig,
  replacePrimaryViewConfig,
  viewConfigMatches,
  viewHistoryIdentityKey,
} from './viewHistoryCapture';
import type { ViewConfigChange, ViewHistoryIdentity } from './viewHistoryCapture';

export interface ContextualHistoryItem {
  id: string;
  label: string;
  owner: { kind: 'data' } | { kind: 'view'; name: string };
  status: DataHistoryEntryStatus | ViewHistoryEntryStatus | 'blocked';
  enabled: boolean;
  sequence: number;
}

export interface ContextualHistorySnapshot {
  undo: ContextualHistoryItem | null;
  redo: ContextualHistoryItem | null;
}

export type LinkedViewHistoryReplayTargets =
  | { status: 'candidate-changed' | 'conflict' }
  | {
      status: 'ready';
      entryId: string;
      hosts: readonly { hostPageId: PageId; doc: DocNode }[];
    };

const EMPTY_CONTEXTUAL_HISTORY: ContextualHistorySnapshot = { undo: null, redo: null };

function sameContextualHistoryItem(
  left: ContextualHistoryItem | null,
  right: ContextualHistoryItem | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const sameOwner = left.owner.kind === right.owner.kind &&
    (left.owner.kind === 'data' || (right.owner.kind === 'view' && left.owner.name === right.owner.name));
  return left.id === right.id &&
    left.label === right.label &&
    sameOwner &&
    left.status === right.status &&
    left.enabled === right.enabled &&
    left.sequence === right.sequence;
}

export interface LinkedViewConfigCommitReceipt {
  id: string;
  identity: Extract<ViewHistoryIdentity, { kind: 'linked' }>;
  change: ViewConfigChange;
  status: ViewHistoryEntryStatus;
  mirrored: boolean;
}

interface LinkedViewConfigCommitHook {
  identity: Extract<ViewHistoryIdentity, { kind: 'linked' }>;
  expectedDoc: DocNode;
  canEditNow: () => boolean;
  mirror: (receipt: LinkedViewConfigCommitReceipt) => boolean;
}

type DatabasePasteDirection = 'undo' | 'redo';
const EMPTY_FILE_CATALOG: FileCatalogSnapshot = { files: [], folders: [] };

interface DatabasePasteRecord {
  databaseId: PageId;
  hostPageId: PageId;
  pages: PageMeta[];
  docs: Record<PageId, DocNode>;
  active: boolean;
}

function captureViewConfigChanges(
  before: WorkspaceState,
  after: WorkspaceState,
  commands: Command[],
): ViewConfigChange[] {
  if (commands.length !== 1) return [];
  const command = commands[0]!;
  if (command.type === 'database.set') {
    const beforeDatabase = before.pages[command.id]?.database;
    const afterDatabase = after.pages[command.id]?.database;
    return beforeDatabase && afterDatabase
      ? primaryViewConfigChanges(command.id, beforeDatabase, afterDatabase)
      : [];
  }
  if (command.type === 'page.setDoc') {
    const beforeDoc = before.docs[command.id];
    const afterDoc = after.docs[command.id];
    return beforeDoc && afterDoc ? linkedViewConfigChanges(command.id, beforeDoc, afterDoc) : [];
  }
  return [];
}

function linkedSourceDatabaseId(state: WorkspaceState, hostPageId: PageId, blockId: string): PageId | null {
  const doc = state.docs[hostPageId];
  if (!doc) return null;
  const ids = new Set<PageId>();
  const visit = (node: DocNode) => {
    if (
      node.type === 'linkedDatabaseView' &&
      linkedViewHostMatches(node.attrs, hostPageId) &&
      node.attrs.blockId === blockId &&
      typeof node.attrs.sourceDatabaseId === 'string'
    )
      ids.add(node.attrs.sourceDatabaseId);
    node.content?.forEach(visit);
  };
  visit(doc);
  return ids.size === 1 ? [...ids][0]! : null;
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
  private readonly fileCatalogListeners = new Set<() => void>();
  private stopRepositoryFileCatalog: (() => void) | null = null;
  private stopRepositoryChangeError: (() => void) | null = null;
  private readonly lastSnapshot = new Map<PageId, number>();
  // what each page held when it was last kept as a version, or when it was opened. a page saved with
  // nothing really different, such as only its edit time, gets no new version
  private readonly lastKept = new Map<PageId, string>();
  private readonly externalListeners = new Set<(patch: ExternalPatch, accepted: PageId[]) => void>();
  private readonly databasePastes = new Map<PageId, DatabasePasteRecord>();
  private readonly historyBudget = new SessionHistoryBudget();
  private readonly dataHistory = new SessionDataHistory(this.historyBudget);
  private readonly viewHistory = new SessionViewHistory(this.historyBudget);
  private readonly contextualHistorySnapshots = new Map<string, ContextualHistorySnapshot>();
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
    readonly problems: readonly string[],
    readonly firstRun: boolean,
    options: SaveQueueOptions,
  ) {
    this.state = initial;
    this.queue = new SaveQueue(
      { write: (batch) => this.exclusive(() => repository.write(batch)) },
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
    this.stopRepositoryChangeError =
      repository.onExternalChangeError?.((error) => this.queue.setExternalError(error)) ?? null;
    this.stopRepositoryFileCatalog = repository.onFileCatalogChange?.(() => {
      for (const listener of this.fileCatalogListeners) listener();
    }) ?? null;
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
    await restoreTableActionHistory(session);
    return ok(session);
  }

  getState = (): WorkspaceState => this.state;

  getFileCatalog = (): FileCatalogSnapshot => this.repository.getFileCatalog?.() ?? EMPTY_FILE_CATALOG;

  subscribeFileCatalog = (listener: () => void): (() => void) => {
    this.fileCatalogListeners.add(listener);
    return () => this.fileCatalogListeners.delete(listener);
  };

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
    return this.executeAll([command]);
  }

  // runs several commands as one unit, nothing is applied if any of them fails
  executeAll(commands: Command[]): Result<WorkspaceState> {
    return this.executeCommands(commands, undefined, false).result;
  }

  /**
   * Applies and captures one linked-view-only document update before synchronously mirroring it
   * into ProseMirror. Session and history listeners are published only after that mirror callback.
   */
  executeLinkedViewConfigChange(
    identity: Extract<ViewHistoryIdentity, { kind: 'linked' }>,
    expectedDoc: DocNode,
    nextDoc: DocNode,
    canEditNow: () => boolean,
    mirror: (receipt: LinkedViewConfigCommitReceipt) => boolean,
  ): Result<LinkedViewConfigCommitReceipt> {
    const execution = this.executeCommands(
      [{ type: 'page.setDoc', id: identity.hostPageId, doc: nextDoc, now: Date.now() }],
      undefined,
      false,
      false,
      { identity, expectedDoc, canEditNow, mirror },
    );
    if (!execution.result.ok) return execution.result;
    return execution.viewCommitReceipt
      ? ok(execution.viewCommitReceipt)
      : fail('The linked view change was not captured.');
  }

  // Table actions supply their journal identity so an unfinished save stays protected from eviction.
  executeAllWithDataHistory(
    commands: Command[],
    context: DataHistoryCaptureContext,
  ): { result: Result<WorkspaceState>; historyEntryId: string | null } {
    return this.executeCommands(commands, context, false);
  }

  // Undo, redo, legacy property replay and journal recovery do not become new user actions.
  // Suppression is limited to this synchronous command batch rather than a flag held across awaits.
  executeHistoryReplay(commands: Command[]): Result<WorkspaceState> {
    return this.executeCommands(commands, undefined, true).result;
  }

  executeDataHistoryReplay(commands: Command[]): Result<WorkspaceState> {
    return this.executeCommands(commands, undefined, true, true).result;
  }

  private executeCommands(
    commands: Command[],
    historyContext: DataHistoryCaptureContext | undefined,
    replay: boolean,
    dataHistoryReplay = false,
    linkedViewCommit?: LinkedViewConfigCommitHook,
  ): {
    result: Result<WorkspaceState>;
    historyEntryId: string | null;
    viewCommitReceipt?: LinkedViewConfigCommitReceipt;
  } {
    const before = this.state;
    let draft = this.state;
    const all = { pages: new Set<PageId>(), docs: new Set<PageId>(), removed: new Set<PageId>() };
    for (const command of commands) {
      const result = applyCommand(draft, command);
      if (!result.ok) return { result, historyEntryId: null };
      draft = result.value.state;
      for (const id of result.value.changes.pages) all.pages.add(id);
      for (const id of result.value.changes.docs) all.docs.add(id);
      for (const id of result.value.changes.removed) all.removed.add(id);
    }
    const viewChanges = replay ? [] : captureViewConfigChanges(before, draft, commands);
    let viewCommitReceipt: LinkedViewConfigCommitReceipt | undefined;
    let linkedViewChange: ViewConfigChange | undefined;
    if (linkedViewCommit) {
      const command = commands.length === 1 ? commands[0] : undefined;
      const host = before.pages[linkedViewCommit.identity.hostPageId];
      const currentDoc = before.docs[linkedViewCommit.identity.hostPageId];
      const change = viewChanges.length === 1 ? viewChanges[0] : undefined;
      const canEdit = (() => {
        try {
          return linkedViewCommit.canEditNow();
        } catch {
          return false;
        }
      })();
      if (
        command?.type !== 'page.setDoc' ||
        command.id !== linkedViewCommit.identity.hostPageId ||
        !currentDoc ||
        !sameJson(currentDoc, linkedViewCommit.expectedDoc) ||
        !host ||
        this.unreadable.has(host.id) ||
        isEffectivelyTrashed(before.pages, host.id) ||
        !canEdit ||
        !change ||
        change.identity.kind !== 'linked' ||
        change.identity.hostPageId !== linkedViewCommit.identity.hostPageId ||
        change.identity.blockId !== linkedViewCommit.identity.blockId
      )
        return { result: fail('The linked view change could not be captured safely.'), historyEntryId: null };
      linkedViewChange = change;
    }
    const viewHistoryDatabaseIds = new Set<PageId>();
    for (const change of viewChanges) {
      if (change.identity.kind === 'database') viewHistoryDatabaseIds.add(change.identity.databaseId);
      else {
        const databaseId = linkedSourceDatabaseId(before, change.identity.hostPageId, change.identity.blockId);
        if (databaseId) viewHistoryDatabaseIds.add(databaseId);
      }
    }
    const busyDatabaseIds = dataHistoryReplay
      ? []
      : this.dataHistory.busyDatabasesForChanges(
          before,
          draft,
          commands,
          all,
          [...new Set([...(historyContext?.databaseId ? [historyContext.databaseId] : []), ...viewHistoryDatabaseIds])],
        );
    if (busyDatabaseIds.length > 0)
      return {
        result: fail<WorkspaceState>('A row data history change is still in progress.', {
          kind: 'dataHistoryBusy',
          databaseIds: busyDatabaseIds,
        }),
        historyEntryId: null,
      };
    this.state = draft;
    this.queue.enqueue(all);
    const historyEntryId = replay
      ? null
      : this.dataHistory.record(before, draft, commands, all, historyContext);
    if (!replay && viewChanges.length > 0) {
      this.viewHistory.record(
        viewChanges,
        linkedViewCommit && linkedViewChange
          ? (entry, changes) => {
              const change = changes.length === 1 ? changes[0] : undefined;
              if (!change || change.identity.kind !== 'linked') return;
              const receipt: LinkedViewConfigCommitReceipt = {
                id: entry.id,
                identity: linkedViewCommit.identity,
                change,
                status: entry.status,
                mirrored: false,
              };
              const candidate = this.viewHistory.getCandidate(linkedViewCommit.identity, 'undo');
              if (candidate?.id !== entry.id || candidate.status !== entry.status) {
                // Keep the accepted entry and let later source synchronization repair the editor.
                viewCommitReceipt = receipt;
                return;
              }
              let mirrored = false;
              try {
                mirrored = linkedViewCommit.mirror(receipt);
              } catch {
                // The source state is already committed. Publish the real entry so the editor can
                // resynchronize without losing the accepted history action.
              }
              viewCommitReceipt = { ...receipt, mirrored };
            }
          : undefined,
      );
    }
    for (const listener of this.listeners) listener();
    return {
      result: ok(draft),
      historyEntryId,
      ...(viewCommitReceipt ? { viewCommitReceipt } : {}),
    };
  }

  getDataHistory = (databaseId: PageId): DataHistorySnapshot => this.dataHistory.getSnapshot(databaseId);

  subscribeDataHistory = (databaseId: PageId, listener: () => void): (() => void) =>
    this.dataHistory.subscribe(databaseId, listener);

  stepDataHistory(
    databaseId: PageId,
    direction: 'undo' | 'redo',
    canEditNow?: () => boolean,
    expectedEntryId?: string,
  ): Promise<DataHistoryStepResult> {
    return this.dataHistory.step(this, databaseId, direction, canEditNow, expectedEntryId);
  }

  getViewHistory(identity: ViewHistoryIdentity): ViewHistorySnapshot {
    return this.viewHistory.getSnapshot(identity);
  }

  linkedViewHistoryReplayTargets(
    identity: Extract<ViewHistoryIdentity, { kind: 'linked' }>,
    direction: 'undo' | 'redo',
    expectedEntryId: string,
  ): LinkedViewHistoryReplayTargets {
    const candidate = this.viewHistory.getCandidate(identity, direction);
    if (!candidate || candidate.id !== expectedEntryId) return { status: 'candidate-changed' };
    const changes = this.viewHistory.getCandidateLinkedChanges(identity, direction, expectedEntryId);
    if (!changes || changes.length === 0) return { status: 'conflict' };

    const hosts = new Map<PageId, DocNode>();
    const identities = new Set<string>();
    for (const change of changes) {
      if (change.identity.kind !== 'linked') return { status: 'conflict' };
      const { hostPageId, blockId } = change.identity;
      const identityKey = viewHistoryIdentityKey(change.identity);
      const currentDoc = this.state.docs[hostPageId];
      const expected = direction === 'undo' ? change.after : change.before;
      const current = currentDoc ? linkedViewConfigSnapshot(currentDoc, hostPageId, blockId) : null;
      const sourceDatabaseId = currentDoc ? linkedSourceDatabaseId(this.state, hostPageId, blockId) : null;
      const sourcePage = sourceDatabaseId ? this.state.pages[sourceDatabaseId] : undefined;
      if (
        identities.has(identityKey) ||
        !currentDoc ||
        !current ||
        !viewConfigMatches(current, expected) ||
        !sourceDatabaseId ||
        sourcePage?.kind !== 'database' ||
        !sourcePage.database
      )
        return { status: 'conflict' };
      identities.add(identityKey);
      hosts.set(hostPageId, currentDoc);
    }

    if (hosts.size === 0) return { status: 'conflict' };
    return {
      status: 'ready',
      entryId: expectedEntryId,
      hosts: [...hosts].map(([hostPageId, doc]) => ({ hostPageId, doc })),
    };
  }

  subscribeViewHistory(identity: ViewHistoryIdentity, listener: () => void): () => void {
    return this.viewHistory.subscribe(identity, listener);
  }

  getContextualHistory(databaseId: PageId, identity: ViewHistoryIdentity): ContextualHistorySnapshot {
    const key = JSON.stringify([databaseId, viewHistoryIdentityKey(identity)]);
    const undo = this.contextualItem(
      this.dataHistory.getCandidate(databaseId, 'undo'),
      this.viewHistory.getCandidate(identity, 'undo'),
    );
    const redo = this.contextualItem(
      this.dataHistory.getCandidate(databaseId, 'redo'),
      this.viewHistory.getCandidate(identity, 'redo'),
    );
    const previous = this.contextualHistorySnapshots.get(key);
    if (previous && sameContextualHistoryItem(previous.undo, undo) && sameContextualHistoryItem(previous.redo, redo))
      return previous;
    const next = !undo && !redo ? EMPTY_CONTEXTUAL_HISTORY : { undo, redo };
    this.contextualHistorySnapshots.set(key, next);
    return next;
  }

  subscribeContextualHistory(
    databaseId: PageId,
    identity: ViewHistoryIdentity,
    listener: () => void,
  ): () => void {
    const stopData = this.dataHistory.subscribe(databaseId, listener);
    const stopView = this.viewHistory.subscribe(identity, listener);
    return () => {
      stopData();
      stopView();
    };
  }

  stepContextualHistory(
    databaseId: PageId,
    identity: ViewHistoryIdentity,
    direction: 'undo' | 'redo',
    canEditNow?: () => boolean,
    expectedEntryId?: string,
  ): Promise<DataHistoryStepResult | ViewHistoryStepResult> {
    const candidate = this.getContextualHistory(databaseId, identity)[direction];
    if (!candidate) return Promise.resolve({ status: 'empty' });
    if (expectedEntryId && candidate.id !== expectedEntryId)
      return Promise.resolve({ status: 'blocked', reason: 'related' });
    if (candidate.owner.kind === 'data')
      return this.dataHistory.step(this, databaseId, direction, canEditNow, candidate.id);
    return Promise.resolve(
      this.viewHistory.step(
        identity,
        direction,
        (entry, stepDirection) => this.applyViewHistoryEntry(entry, stepDirection),
        canEditNow,
        candidate.id,
      ),
    );
  }

  private contextualItem(
    data: OrderedDataHistoryItem | null,
    view: OrderedViewHistoryItem | null,
  ): ContextualHistoryItem | null {
    if (!data && !view) return null;
    if (!view || (data && data.sequence > view.sequence))
      return {
        id: data!.id,
        label: data!.label,
        owner: { kind: 'data' },
        status: data!.status,
        enabled: data!.enabled,
        sequence: data!.sequence,
      };
    return {
      id: view.id,
      label: view.label,
      owner: { kind: 'view', name: view.ownerName },
      status: view.status,
      enabled: view.enabled,
      sequence: view.sequence,
    };
  }

  private applyViewHistoryEntry(
    entry: ViewHistoryEntry,
    direction: 'undo' | 'redo',
  ): ViewHistoryStepResult {
    if (entry.changes.length === 0) return { status: 'unavailable' };
    const databaseDefs = new Map<PageId, DatabaseDef>();
    const hostDocs = new Map<PageId, DocNode>();
    const databaseIds = new Set<PageId>();
    const hostPageIds = new Set<PageId>();
    for (const change of entry.changes) {
      const expected = direction === 'undo' ? change.after : change.before;
      const replacement = direction === 'undo' ? change.before : change.after;
      if (change.identity.kind === 'database') {
        const databaseId = change.identity.databaseId;
        const current = databaseDefs.get(databaseId) ?? this.state.pages[databaseId]?.database;
        if (!current) return { status: 'conflict' };
        const next = replacePrimaryViewConfig(current, change.identity.viewId, expected, replacement);
        if (!next) return { status: 'conflict' };
        databaseDefs.set(databaseId, next);
        databaseIds.add(databaseId);
      } else {
        const hostPageId = change.identity.hostPageId;
        const current = hostDocs.get(hostPageId) ?? this.state.docs[hostPageId];
        if (!current) return { status: 'conflict' };
        const next = replaceLinkedViewConfig(
          current,
          hostPageId,
          change.identity.blockId,
          expected,
          replacement,
        );
        if (!next) return { status: 'conflict' };
        hostDocs.set(hostPageId, next);
        hostPageIds.add(hostPageId);
        const sourceDatabaseId = linkedSourceDatabaseId(this.state, hostPageId, change.identity.blockId);
        if (!sourceDatabaseId) return { status: 'conflict' };
        databaseIds.add(sourceDatabaseId);
      }
    }

    const now = Date.now();
    const commands: Command[] = [
      ...[...databaseDefs].map(([id, database]) => ({ type: 'database.set' as const, id, database, now })),
      ...[...hostDocs].map(([id, doc]) => ({ type: 'page.setDoc' as const, id, doc, now })),
    ];
    if (
      !this.canEditDataHistoryNow([...databaseIds], [...hostPageIds]) ||
      [...databaseIds].some((id) => this.dataHistory.isBusy(id)) ||
      [...hostPageIds].some((id) => isEffectivelyTrashed(this.state.pages, id))
    )
      return { status: 'blocked', reason: 'permission' };
    const result = this.executeHistoryReplay(commands);
    return result.ok ? { status: 'applied' } : { status: 'failed' };
  }

  canEditDataHistoryNow(databaseIds: readonly PageId[], recordIds: readonly PageId[] = []): boolean {
    for (const databaseId of databaseIds) {
      const databasePage = this.state.pages[databaseId];
      if (
        !databasePage ||
        databasePage.kind !== 'database' ||
        !databasePage.database ||
        databasePage.database.unsupportedProperties?.length ||
        this.unreadable.has(databaseId) ||
        isEffectivelyTrashed(this.state.pages, databaseId)
      )
        return false;
    }
    for (const recordId of recordIds) {
      if (this.unreadable.has(recordId)) return false;
      const record = this.state.pages[recordId];
      const parent = record?.parentId ? this.state.pages[record.parentId] : undefined;
      if (
        parent?.kind === 'database' &&
        (parent.database?.unsupportedProperties?.length ||
          this.unreadable.has(parent.id) ||
          isEffectivelyTrashed(this.state.pages, parent.id))
      )
        return false;
    }
    return true;
  }

  finishDataHistoryEntry(id: string, status: 'ready' | 'pending'): void {
    this.dataHistory.finishEntry(id, status);
  }

  restoreDataHistoryEntry(entry: TableActionHistoryEntry, direction: 'undo' | 'redo' = 'undo'): void {
    this.dataHistory.restore(entry, this.state, direction);
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

  async flush(): Promise<boolean> {
    if (this.repository.retryExternalChanges && !(await this.repository.retryExternalChanges())) return false;
    return await this.queue.flush();
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
    await this.exclusive(() =>
      this.repository.write({ pages: [], docs: [], removed: [], snapshots, state: this.state }),
    );
  }

  // the current content is kept as a version first, so restoring can always be undone
  async restoreSnapshot(snapshot: Snapshot): Promise<Result<WorkspaceState>> {
    if (!this.state.pages[snapshot.pageId]) return fail('That page no longer exists.');
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
    await this.queue.flush();
    this.stopRepositoryChangeError?.();
    this.stopRepositoryChangeError = null;
    this.queue.dispose();
    this.contextualHistorySnapshots.clear();
    this.stopRepositoryFileCatalog?.();
    this.stopRepositoryFileCatalog = null;
    this.fileCatalogListeners.clear();
    this.repository.close();
  }
}
