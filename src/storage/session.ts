import { applyCommand } from '../core/commands';
import type { Changes, Command } from '../core/commands';
import { isDocEmpty, isRecord } from '../core/doc';
import { snapshotDue } from '../core/history';
import { emptyWorkspace } from '../core/model';
import type {
  DocNode,
  FileId,
  FileMeta,
  PageId,
  PageMeta,
  PropType,
  Snapshot,
  WorkspaceState,
} from '../core/model';
import { fail, ok } from '../core/result';
import type { Result } from '../core/result';
import { isEffectivelyTrashed } from '../core/tree';
import {
  isValidNoteStyleInput,
  mergeNoteStyleExtra,
  projectNoteStyle,
  resolveDefaultNoteStyle,
} from '../core/noteStyle';
import type { BasePageWidth, NoteStyle, NoteStyleFont } from '../core/noteStyle';
import {
  decodeExplicitMorrowNoteStyleSnapshot,
  matchesAppliedNoteStyleValues,
  sameNoteStyle,
} from '../core/vault/frontmatter';
import type {
  ExplicitMorrowNoteStylePatch,
  ExplicitMorrowNoteStyleSnapshot,
  MorrowNoteStyleRestoreContext,
} from '../core/vault/frontmatter';
import { WorkspaceWriteError } from './repository';
import { openRepository } from './repository';
import type {
  ExternalPatch,
  ExplicitNoteStyleRestore,
  InheritedNoteStyleRestore,
  NoteStyleRestore,
  NoteStyleRestoreContext,
  NoteStyleWriteReceipt,
  StoredFile,
  WorkspaceRepository,
  WriteBatch,
} from './repository';
import { SaveQueue } from './saveQueue';
import type { SaveQueueOptions, SaveStatus } from './saveQueue';
import { PilotDataHistory } from './pilotDataHistory';
import type {
  PilotDataHistoryCellValue,
  PilotDataHistoryDirection,
  PilotDataHistorySnapshot,
} from './pilotDataHistory';

const MUTATION_FENCE_MESSAGE = 'The workspace session is preparing to close.';
const PILOT_DATA_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const PILOT_DATA_REVISION_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:r\d+$/i;

type NoteStyleHostAuthorization = { isCurrent(): boolean; onWriteStarted(): void };

function isNoteStyleHostAuthorized(authorization?: NoteStyleHostAuthorization): boolean {
  try {
    return authorization?.isCurrent() !== false;
  } catch {
    return false;
  }
}

function noteStyleHostAuthorizationFailure(): NoteStyleFailureResult {
  return noteStyleFailure('read-only', 'The style operation is no longer authorized.');
}

export interface NoteStyleSnapshot {
  pageId: PageId;
  revision: string;
  style: NoteStyle | null;
}

export type NoteStyleFailureCode =
  | 'session-closed'
  | 'page-not-found'
  | 'unsupported'
  | 'read-only'
  | 'inaccessible'
  | 'trashed'
  | 'stale-revision'
  | 'invalid-style'
  | 'save-conflict'
  | 'save-failed';

export type NoteStyleResult =
  { ok: true; value: NoteStyleSnapshot } | { ok: false; code: NoteStyleFailureCode; message: string };
type NoteStyleFailureResult = Extract<NoteStyleResult, { ok: false }>;

/** Host-internal result for a style-batch caller that explicitly requests a private undo context. */
type NoteStyleCaptureResult =
  | {
      ok: true;
      value: NoteStyleSnapshot;
      op: NoteStyleWriteReceipt['op'] | null;
      restoreContext: NoteStyleRestoreContext | null;
    }
  | NoteStyleFailureResult;

// the single place where commands run, state lives and changes are queued for disk
export class WorkspaceSession {
  private state: WorkspaceState;
  private closed = false;
  private readonly mutationFenceLeases = new Set<symbol>();
  private readonly mutationFenceListeners = new Set<() => void>();
  private readonly pilotDataSessionId = crypto.randomUUID();
  private readonly noteStyleSessionId = crypto.randomUUID();
  private readonly noteStyleRevisions = new Map<PageId, number>();
  private noteStyleRevisionClock = 0;
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
    this.bumpNoteStyleRevisions([id]);
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
    this.bumpNoteStyleRevisions([id]);
    this.refreshPilotDataRevisions(this.state);
    for (const listener of this.listeners) listener();
  }

  async protectPage(id: PageId, password: string): Promise<Result<WorkspaceState>> {
    if (this.closed) return fail('The workspace session is closed.');
    if (!this.repository.protectPage) return fail('Encrypted pages need a vault folder.');
    if (this.unreadable.has(id)) return fail(this.protectionMessage(id));
    if (this.isPilotDataPage(id)) {
      return fail(
        'Opted-in Polaris Dados databases and rows cannot be encrypted through generic page commands.',
      );
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

  /** Host-only preflight that distinguishes a note file from a folder with the same path suffix. */
  hasWritableNoteStyleSource(id: PageId): boolean {
    const page = ownPage(this.state.pages, id);
    const parentId = page?.parentId;
    return (
      !this.closed &&
      page?.kind === 'page' &&
      !this.isMutationFenced &&
      !isEffectivelyTrashed(this.state.pages, id) &&
      !this.unreadable.has(id) &&
      !this.protectedReasons.has(id) &&
      !(parentId && (this.unreadable.has(parentId) || this.protectedReasons.has(parentId))) &&
      !this.isPilotDataPage(id) &&
      this.repository.hasWritableNoteStyleSource?.(id) === true
    );
  }

  /** Read-only preflight using the same typed YAML serializer as the style write. */
  canUpdateNoteStyleSource(id: PageId, style: NoteStyle): boolean {
    return (
      isValidNoteStyleInput(style) &&
      this.hasWritableNoteStyleSource(id) &&
      this.repository.canUpdateNoteStyleSource?.(id, style) === true
    );
  }

  /** Reads the saved style and returns an opaque revision scoped to this page and session. */
  readNoteStyle(pageId: PageId): NoteStyleResult {
    if (this.closed) return noteStyleFailure('session-closed', 'The workspace session is closed.');
    const page = ownPage(this.state.pages, pageId);
    if (!page) return noteStyleFailure('page-not-found', 'That page no longer exists.');
    if (page.kind !== 'page')
      return noteStyleFailure('unsupported', 'Note styles can only be read on ordinary pages.');
    return {
      ok: true,
      value: {
        pageId,
        revision: this.noteStyleRevision(pageId),
        style: projectNoteStyle(page.extra.morrowNoteStyle),
      },
    };
  }

  /** Writes one page-style value with a source CAS before publishing it in session state. */
  async setNoteStyle(input: {
    pageId: PageId;
    style: NoteStyle;
    expectedRevision: string;
    /** Internal host guard used by consumed previews; ordinary typed callers need not supply it. */
    hostAuthorization?: NoteStyleHostAuthorization;
  }): Promise<NoteStyleResult> {
    const result = await this.setNoteStyleInternal(input, false);
    if (!result.ok) return result;
    return { ok: true, value: result.value };
  }

  /** @internal Host-only path; context and operation follow a confirmed source CAS. */
  async setNoteStyleWithRestoreContext(input: {
    pageId: PageId;
    style: NoteStyle;
    expectedRevision: string;
    hostAuthorization?: NoteStyleHostAuthorization;
  }): Promise<NoteStyleCaptureResult> {
    return this.setNoteStyleInternal(input, true);
  }

  private async setNoteStyleInternal(
    input: {
      pageId: PageId;
      style: NoteStyle;
      expectedRevision: string;
      hostAuthorization?: NoteStyleHostAuthorization;
    },
    captureRestoreContext: boolean,
  ): Promise<NoteStyleCaptureResult> {
    const pageId = input.pageId;
    const expectedRevision = input.expectedRevision;
    const initialTargetError = this.noteStyleTargetError(pageId);
    if (initialTargetError) return initialTargetError;
    if (this.isMutationFenced) return noteStyleFailure('read-only', MUTATION_FENCE_MESSAGE);
    if (!isValidNoteStyleInput(input.style)) return noteStyleFailure('invalid-style', 'Invalid note style.');
    const hasHostAuthorization = () => isNoteStyleHostAuthorized(input.hostAuthorization);
    const hostAuthorizationFailure = () =>
      noteStyleFailure('read-only', 'The style preview is no longer authorized.');
    if (!hasHostAuthorization()) return hostAuthorizationFailure();
    const style: NoteStyle = {
      font: input.style.font,
      fontSize: input.style.fontSize,
      lineHeight: input.style.lineHeight,
      blockSpacing: input.style.blockSpacing,
      width: input.style.width,
    };

    try {
      const isolated = await this.queue.runIsolated([pageId], async () => {
        if (!hasHostAuthorization()) return hostAuthorizationFailure();
        const targetError = this.noteStyleTargetError(pageId);
        if (targetError) return targetError;
        if (this.isMutationFenced) return noteStyleFailure('read-only', MUTATION_FENCE_MESSAGE);
        if (expectedRevision !== this.noteStyleRevision(pageId))
          return noteStyleFailure(
            'stale-revision',
            'This note changed while its style editor was open. Reopen it to review the latest version.',
          );

        const result = applyCommand(this.state, {
          type: 'page.setNoteStyle',
          id: pageId,
          style,
          now: Date.now(),
        });
        if (!result.ok) return this.noteStyleCommandFailure(result.error);
        const { state: candidate, changes } = result.value;
        const refusal = this.validateChanges(changes, candidate, undefined, [pageId]);
        if (refusal) return this.noteStyleCommandFailure(refusal);
        const page = ownPage(candidate.pages, pageId);
        if (!page) return noteStyleFailure('page-not-found', 'That page no longer exists.');

        const batch: WriteBatch = {
          pages: [page],
          docs: [],
          removed: [],
          noteStylePages: [pageId],
          state: candidate,
        };
        let confirmedOperation: NoteStyleWriteReceipt['op'] | null = null;
        let confirmedRestoreContext: NoteStyleRestoreContext | null = null;
        const dispatched = await this.exclusive(async (): Promise<true | false | NoteStyleFailureResult> => {
          if (!hasHostAuthorization()) return false;
          // Establish the page-id registry first; the style write itself then has no sidecar tail
          // that could fail after the Markdown source has been confirmed.
          await this.repository.markInitialized();

          // The session can still accept edits while metadata initialization is in flight. Recheck
          // the captured target and its revision immediately before dispatching the Markdown write.
          const latestTargetError = this.noteStyleTargetError(pageId);
          if (latestTargetError) return latestTargetError;
          if (this.isMutationFenced) return noteStyleFailure('read-only', MUTATION_FENCE_MESSAGE);
          if (expectedRevision !== this.noteStyleRevision(pageId))
            return noteStyleFailure(
              'stale-revision',
              'This note changed while its style editor was open. Reopen it to review the latest version.',
            );

          if (!hasHostAuthorization()) return false;
          input.hostAuthorization?.onWriteStarted();
          if (captureRestoreContext && this.repository.writeNoteStyle) {
            const receipt: NoteStyleWriteReceipt = await this.repository.writeNoteStyle(batch, {
              captureRestoreContext: true,
            });
            confirmedOperation = receipt.op;
            if (receipt.op === 'write') confirmedRestoreContext = receipt.restoreContext;
          } else {
            await this.repository.write(batch);
          }
          return true;
        });
        if (dispatched !== true) return dispatched === false ? hostAuthorizationFailure() : dispatched;

        // Merge the confirmed key into the latest state so concurrent body/metadata edits survive.
        if (changes.pages.has(pageId)) {
          const current = ownPage(this.state.pages, pageId);
          if (current?.kind === 'page') {
            const updated = candidate.pages[pageId]!;
            const extra = mergeNoteStyleExtra(current.extra, style) ?? {
              ...current.extra,
              morrowNoteStyle: updated.extra.morrowNoteStyle,
            };
            this.state = {
              ...this.state,
              pages: {
                ...this.state.pages,
                [pageId]: {
                  ...current,
                  updatedAt: Math.max(current.updatedAt, updated.updatedAt),
                  extra,
                },
              },
            };
            this.bumpNoteStyleRevisions([pageId]);
            this.refreshPilotDataRevisions(this.state);
            for (const listener of this.listeners) listener();
          }
        }
        const confirmedPage = ownPage(this.state.pages, pageId);
        if (!confirmedPage || confirmedPage.kind !== 'page')
          return noteStyleFailure('page-not-found', 'That page no longer exists.');
        return {
          ok: true as const,
          value: {
            pageId,
            revision: this.noteStyleRevision(pageId),
            style: projectNoteStyle(confirmedPage.extra.morrowNoteStyle),
          },
          op: confirmedOperation,
          restoreContext: confirmedRestoreContext,
        };
      });
      return isolated.ok ? isolated.value : this.noteStyleSaveFailure();
    } catch {
      return this.noteStyleSaveFailure();
    }
  }

  /** @internal Host-only path for restoring the inherited override from one confirmed write. */
  async restoreInheritedNoteStyle(input: {
    pageId: PageId;
    expectedRevision: string;
    appliedStyle: NoteStyle;
    context: MorrowNoteStyleRestoreContext;
    hostAuthorization?: NoteStyleHostAuthorization;
  }): Promise<NoteStyleResult> {
    if (!isNoteStyleHostAuthorized(input.hostAuthorization)) return noteStyleHostAuthorizationFailure();
    if (this.closed) return noteStyleFailure('session-closed', 'The workspace session is closed.');
    if (this.isMutationFenced) return noteStyleFailure('read-only', MUTATION_FENCE_MESSAGE);
    if (!isValidNoteStyleInput(input.appliedStyle))
      return noteStyleFailure('invalid-style', 'Invalid note style.');
    const restore: InheritedNoteStyleRestore = {
      kind: 'restore-inherited',
      pageId: input.pageId,
      appliedStyle: copyNoteStyle(input.appliedStyle),
      context: {
        hadFrontmatter: input.context.hadFrontmatter,
        separatorAdded: input.context.separatorAdded,
        emptyFrontmatterHadBlankLine: input.context.emptyFrontmatterHadBlankLine,
      },
    };
    return this.restoreNoteStyleFromContext({
      pageId: input.pageId,
      expectedRevision: input.expectedRevision,
      restore,
      hostAuthorization: input.hostAuthorization,
    });
  }

  /** @internal Host-only path for restoring an explicit override from its codec snapshot. */
  async restoreExplicitNoteStyle(input: {
    pageId: PageId;
    expectedRevision: string;
    appliedStyle: NoteStyle;
    context: ExplicitMorrowNoteStyleSnapshot;
    hostAuthorization?: NoteStyleHostAuthorization;
  }): Promise<NoteStyleResult> {
    if (!isNoteStyleHostAuthorized(input.hostAuthorization)) return noteStyleHostAuthorizationFailure();
    if (this.closed) return noteStyleFailure('session-closed', 'The workspace session is closed.');
    if (this.isMutationFenced) return noteStyleFailure('read-only', MUTATION_FENCE_MESSAGE);
    if (!isValidNoteStyleInput(input.appliedStyle))
      return noteStyleFailure('invalid-style', 'Invalid note style.');
    const patch = decodeExplicitMorrowNoteStyleSnapshot(input.context);
    if (!patch)
      return noteStyleFailure('unsupported', 'The original explicit note-style context is invalid.');
    const restore: ExplicitNoteStyleRestore = {
      kind: 'restore-explicit',
      pageId: input.pageId,
      appliedStyle: copyNoteStyle(input.appliedStyle),
      context: {
        kind: 'explicit',
        fields: { ...input.context.fields },
        separatorAdded: input.context.separatorAdded,
        separatorAnchorKey: input.context.separatorAnchorKey,
      },
    };
    return this.restoreNoteStyleFromContext({
      pageId: input.pageId,
      expectedRevision: input.expectedRevision,
      restore,
      explicitPatch: patch,
      hostAuthorization: input.hostAuthorization,
    });
  }

  private async restoreNoteStyleFromContext(input: {
    pageId: PageId;
    expectedRevision: string;
    restore: NoteStyleRestore;
    explicitPatch?: ExplicitMorrowNoteStylePatch;
    hostAuthorization?: NoteStyleHostAuthorization;
  }): Promise<NoteStyleResult> {
    const { pageId, expectedRevision, restore } = input;
    const appliedStyle = restore.appliedStyle;
    if (!isNoteStyleHostAuthorized(input.hostAuthorization)) return noteStyleHostAuthorizationFailure();
    if (this.closed) return noteStyleFailure('session-closed', 'The workspace session is closed.');
    if (this.isMutationFenced) return noteStyleFailure('read-only', MUTATION_FENCE_MESSAGE);

    const checkCurrent = (): NoteStyleResult | null => {
      if (!isNoteStyleHostAuthorized(input.hostAuthorization)) return noteStyleHostAuthorizationFailure();
      if (this.isMutationFenced) return noteStyleFailure('read-only', MUTATION_FENCE_MESSAGE);
      const targetError =
        restore.kind === 'restore-inherited'
          ? this.inheritedNoteStyleTargetError(pageId, appliedStyle)
          : this.explicitNoteStyleTargetError(pageId, appliedStyle);
      if (targetError) return targetError;
      return expectedRevision === this.noteStyleRevision(pageId)
        ? null
        : noteStyleFailure(
            'stale-revision',
            'This note changed while its style editor was open. Reopen it to review the latest version.',
          );
    };
    const initialError = checkCurrent();
    if (initialError) return initialError;

    try {
      const isolated = await this.queue.runIsolated([pageId], async () => {
        const currentError = checkCurrent();
        if (currentError) return currentError;

        const initialBatch = this.noteStyleRestoreBatch(restore, input.explicitPatch);
        if (!initialBatch) return noteStyleFailure('stale-revision', 'The applied note style has changed.');
        let refusal = this.validateNoteStyleRestore(initialBatch);
        if (refusal) return noteStyleFailure('save-failed', refusal);

        const dispatched = await this.exclusive(async (): Promise<true | NoteStyleResult> => {
          if (!isNoteStyleHostAuthorized(input.hostAuthorization))
            return noteStyleHostAuthorizationFailure();
          // Initialize the registry before the one-file CAS so no sidecar write follows its ACK.
          await this.repository.markInitialized();

          const latestError = checkCurrent();
          if (latestError) return latestError;

          const latestBatch = this.noteStyleRestoreBatch(restore, input.explicitPatch);
          if (!latestBatch) return noteStyleFailure('stale-revision', 'The applied note style has changed.');
          refusal = this.validateNoteStyleRestore(latestBatch);
          if (refusal) return noteStyleFailure('save-failed', refusal);

          if (!isNoteStyleHostAuthorized(input.hostAuthorization))
            return noteStyleHostAuthorizationFailure();
          input.hostAuthorization?.onWriteStarted();
          await this.repository.write(latestBatch);
          return true;
        });
        if (dispatched !== true) return dispatched;

        // Apply the confirmed inverse to the newest state, keeping other accepted edits.
        const current = ownPage(this.state.pages, pageId);
        if (current?.kind === 'page' && restore.kind === 'restore-inherited') {
          if (sameNoteStyle(current.extra.morrowNoteStyle, appliedStyle)) {
            const extra = { ...current.extra };
            delete extra.morrowNoteStyle;
            this.state = {
              ...this.state,
              pages: {
                ...this.state.pages,
                [pageId]: { ...current, extra },
              },
            };
          }
        } else if (
          current?.kind === 'page' &&
          input.explicitPatch &&
          matchesAppliedNoteStyleValues(current.extra.morrowNoteStyle, appliedStyle) &&
          isRecord(current.extra.morrowNoteStyle)
        ) {
          const extra = {
            ...current.extra,
            morrowNoteStyle: applyExplicitNoteStylePatch(current.extra.morrowNoteStyle, input.explicitPatch),
          };
          this.state = {
            ...this.state,
            pages: {
              ...this.state.pages,
              [pageId]: { ...current, extra },
            },
          };
        }
        this.bumpNoteStyleRevisions([pageId]);
        this.refreshPilotDataRevisions(this.state);
        for (const listener of this.listeners) listener();
        const confirmedPage = ownPage(this.state.pages, pageId);
        return {
          ok: true as const,
          value: {
            pageId,
            revision: this.noteStyleRevision(pageId),
            style:
              confirmedPage?.kind === 'page' ? projectNoteStyle(confirmedPage.extra.morrowNoteStyle) : null,
          },
        };
      });
      return isolated.ok ? isolated.value : this.noteStyleSaveFailure();
    } catch {
      return this.noteStyleSaveFailure();
    }
  }

  /** Resolves a legacy profile default or the 2.2 font/width defaults, then uses the same guarded write. */
  async restoreNoteStyle(input: {
    pageId: PageId;
    expectedRevision: string;
    profileDefault: unknown;
    font: NoteStyleFont;
    width: BasePageWidth;
  }): Promise<NoteStyleResult> {
    return this.setNoteStyle({
      pageId: input.pageId,
      expectedRevision: input.expectedRevision,
      style: resolveDefaultNoteStyle(input.profileDefault, input.font, input.width),
    });
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
    const acceptedSet = new Set<PageId>();
    const patchPageIds = new Set(patch.pages.map((page) => page.id));
    const pendingPages = patch.pages.filter((page) => !this.queue.isDirty(page.id));
    while (pendingPages.length > 0) {
      let acceptedInPass = false;
      for (let index = 0; index < pendingPages.length;) {
        const page = pendingPages[index]!;
        const dependencies = patch.requiresAccepted?.[page.id] ?? [];
        if (
          dependencies.some((dependency) => !patchPageIds.has(dependency) || !acceptedSet.has(dependency))
        ) {
          index += 1;
          continue;
        }
        const currentPage = this.state.pages[page.id];
        // The watcher may read the old recent.json value while a quiet page-open is queued.
        // Accept its content update, but keep that navigation timestamp for the pending sidecar write.
        pages[page.id] =
          currentPage && this.queue.isQuietPending(page.id)
            ? { ...page, lastOpenedAt: currentPage.lastOpenedAt }
            : page;
        if (patch.docs[page.id]) docs[page.id] = patch.docs[page.id]!;
        accepted.push(page.id);
        acceptedSet.add(page.id);
        pendingPages.splice(index, 1);
        acceptedInPass = true;
      }
      // Missing, rejected, or cyclic dependencies remain unapplied.
      if (!acceptedInPass) break;
    }
    for (const id of patch.removed) {
      if (this.queue.isDirty(id)) continue;
      delete pages[id];
      delete docs[id];
      accepted.push(id);
      acceptedSet.add(id);
    }
    for (const id of patch.unreadable) if (acceptedSet.has(id)) this.unreadable.add(id);
    for (const id of patch.readable) {
      if (!acceptedSet.has(id)) continue;
      this.unreadable.delete(id);
      this.protectedReasons.delete(id);
    }
    for (const id of patch.clearProtected ?? []) {
      if (acceptedSet.has(id)) this.protectedReasons.delete(id);
    }
    for (const [id, reason] of Object.entries(patch.protectedPages ?? {})) {
      if (acceptedSet.has(id)) this.protectedReasons.set(id, reason);
    }
    for (const id of patch.removed) if (acceptedSet.has(id)) this.protectedReasons.delete(id);
    if (accepted.length > 0) {
      this.state = { pages, docs };
      this.bumpNoteStyleRevisions(accepted);
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

  /** Host-only transient fence; it is deliberately independent of the closed session state. */
  get isMutationFenced(): boolean {
    return this.mutationFenceLeases.size > 0;
  }

  /** Host-only lease for briefly refusing new state mutations while an exit is prepared. */
  beginMutationFence(): () => void {
    const wasFenced = this.isMutationFenced;
    const lease = Symbol('workspace-mutation-fence');
    this.mutationFenceLeases.add(lease);
    let active = true;
    if (!wasFenced) this.notifyMutationFenceListeners();

    return () => {
      if (!active) return;
      active = false;
      const wasFenced = this.isMutationFenced;
      if (!this.mutationFenceLeases.delete(lease)) return;
      if (wasFenced && !this.isMutationFenced) this.notifyMutationFenceListeners();
    };
  }

  /**
   * Observes only fence transitions. Each registration has its own cleanup, and listener failures
   * cannot interrupt another listener or prevent the lease cleanup from being returned.
   */
  subscribeMutationFence(listener: () => void): () => void {
    const registration = () => listener();
    this.mutationFenceListeners.add(registration);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.mutationFenceListeners.delete(registration);
    };
  }

  private notifyMutationFenceListeners(): void {
    for (const listener of [...this.mutationFenceListeners]) {
      if (!this.mutationFenceListeners.has(listener)) continue;
      try {
        listener();
      } catch {
        // A transient fence cannot depend on arbitrary observer callbacks behaving correctly.
      }
    }
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
    if (this.closed)
      return { ok: false, code: 'session-closed', message: 'The workspace session is closed.' };
    if (this.isMutationFenced) {
      return { ok: false, code: 'read-only', message: MUTATION_FENCE_MESSAGE };
    }
    const capturedInput = ownDataFields(input, [
      'databaseId',
      'rowId',
      'propertyId',
      'value',
      'expectedRevision',
    ]);
    const rawInput = capturedInput?.values;
    const databaseId = rawInput?.databaseId;
    const rowId = rawInput?.rowId;
    const propertyId = rawInput?.propertyId;
    const candidateValue = rawInput?.value;
    const expectedRevision = rawInput?.expectedRevision;
    if (
      !capturedInput?.valid ||
      !isPilotDataId(databaseId) ||
      !isPilotDataId(rowId) ||
      !isPilotDataId(propertyId) ||
      !isPilotDataRevision(expectedRevision)
    ) {
      return {
        ok: false,
        code: 'invalid-value',
        message: 'The cell patch contains an invalid identifier or snapshot revision.',
      };
    }
    const state = this.state;
    const database = ownPage(state.pages, databaseId);
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
      return {
        ok: false,
        code: 'unsupported',
        message: 'That Polaris Dados database is unavailable or unsupported.',
      };
    }
    if (hasLiveCanvasRow(state.pages, database.id)) {
      return {
        ok: false,
        code: 'unsupported',
        message: 'Canvas rows are not supported by the Polaris Dados cell API.',
      };
    }
    const revision = this.pilotDataRevision(database.id);
    if (expectedRevision !== revision) {
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
    const row = ownPage(state.pages, rowId);
    if (!row || row.parentId !== database.id || isEffectivelyTrashed(state.pages, row.id)) {
      return { ok: false, code: 'row-not-found', message: 'That row is not a live member of this database.' };
    }
    if (row.encrypted || this.unreadable.has(row.id) || this.protectedReasons.has(row.id)) {
      return { ok: false, code: 'read-only', message: 'That row is read only.' };
    }
    const matchingProperties = database.database.properties.filter(
      (candidate) => candidate.id === propertyId,
    );
    const property = matchingProperties[0];
    if (!property) {
      return { ok: false, code: 'property-not-found', message: 'That database property no longer exists.' };
    }
    if (matchingProperties.length !== 1) {
      return { ok: false, code: 'unsupported', message: 'That database property identifier is ambiguous.' };
    }
    if (property.type !== 'number' && property.type !== 'text' && property.type !== 'checkbox') {
      return {
        ok: false,
        code: 'read-only',
        message: 'Only manual number and text properties can be edited by this API.',
      };
    }
    if (
      (property.type === 'number' &&
        (typeof candidateValue !== 'number' || !Number.isFinite(candidateValue))) ||
      (property.type === 'text' &&
        !(
          candidateValue === null ||
          (typeof candidateValue === 'string' && candidateValue.length <= 10_000)
        )) ||
      (property.type === 'checkbox' && typeof candidateValue !== 'boolean')
    ) {
      return {
        ok: false,
        code: 'invalid-value',
        message:
          property.type === 'number'
            ? 'Number cells require a finite number.'
            : property.type === 'text'
              ? 'Text cells require an exact string of at most 10,000 units or null.'
              : 'Checkbox cells require a boolean.',
      };
    }
    const value = candidateValue as number | string | boolean | null;
    const before = pilotDataCellValue(row.properties, property.id);
    if (!before) {
      return { ok: false, code: 'unsupported', message: 'That cell is not a representable scalar value.' };
    }
    if (!isPilotDataHistoryCellValueForType(before, property.type)) {
      return { ok: false, code: 'unsupported', message: 'That cell value does not match its property type.' };
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
    if (this.isMutationFenced) {
      return { ok: false, code: 'read-only', message: MUTATION_FENCE_MESSAGE };
    }
    const capturedInput = ownDataFields(input, ['databaseId', 'direction', 'expectedRevision']);
    const rawInput = capturedInput?.values;
    const databaseId = rawInput?.databaseId;
    const directionValue = rawInput?.direction;
    const expectedRevision = rawInput?.expectedRevision;
    if (!capturedInput?.valid || !isPilotDataId(databaseId)) {
      return { ok: false, code: 'invalid-value', message: 'History requires a valid database identifier.' };
    }
    if (directionValue !== 'undo' && directionValue !== 'redo') {
      return { ok: false, code: 'invalid-value', message: 'History direction must be undo or redo.' };
    }
    const direction = directionValue as PilotDataHistoryDirection;
    if (!isPilotDataRevision(expectedRevision)) {
      return { ok: false, code: 'invalid-value', message: 'History requires a snapshot revision.' };
    }
    const database = ownPage(this.state.pages, databaseId);
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
    if (expectedRevision !== revision) {
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

    const row = ownPage(this.state.pages, entry.rowId);
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
    const property = properties[0]!;
    if (
      properties.length !== 1 ||
      (property.type !== 'number' && property.type !== 'text' && property.type !== 'checkbox')
    ) {
      return {
        ok: false,
        code: 'unsupported',
        message: 'That history property is no longer a unique number, text, or checkbox property.',
      };
    }

    const expectedCell = direction === 'undo' ? entry.after : entry.before;
    const targetCell = direction === 'undo' ? entry.before : entry.after;
    if (
      !isValidPilotDataCellValue(expectedCell) ||
      !isValidPilotDataCellValue(targetCell) ||
      !isPilotDataHistoryCellValueForType(expectedCell, property.type) ||
      !isPilotDataHistoryCellValueForType(targetCell, property.type)
    ) {
      return {
        ok: false,
        code: 'unsupported',
        message: 'That history entry is not valid for this property type.',
      };
    }
    const currentCell = pilotDataCellValue(row.properties, entry.propertyId);
    if (!currentCell || !samePilotDataCellValue(currentCell, expectedCell)) {
      return { ok: false, code: 'stale-revision', message: 'The cell no longer matches this history step.' };
    }

    const restoredProperties = { ...row.properties };
    if (targetCell.present) setOwnPropertyValue(restoredProperties, entry.propertyId, targetCell.value);
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
    this.bumpNoteStyleRevisions([row.id]);
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
    if (this.isMutationFenced) return fail(MUTATION_FENCE_MESSAGE);
    if (command.type === 'page.setNoteStyle')
      return fail('Note styles must be changed through the typed note-style operation.');
    const result = applyCommand(this.state, command);
    if (!result.ok) return result;
    const { state, changes } = result.value;
    if (state === this.state) {
      return ok(state);
    }
    const refusal = this.validateChanges(changes, state, allowedPilotDataDatabaseId);
    if (refusal) return fail(refusal);
    this.state = state;
    this.bumpNoteStyleRevisions([
      ...(command.type === 'page.markOpened' ? [] : changes.pages),
      ...changes.docs,
      ...changes.removed,
    ]);
    this.refreshPilotDataRevisions(this.state);
    beforeQueue?.();
    this.queue.enqueue(
      changes,
      allowedPilotDataDatabaseId ? [allowedPilotDataDatabaseId] : [],
      command.type === 'page.markOpened',
    );
    for (const listener of this.listeners) listener();
    return ok(state);
  }

  // runs several commands as one unit, nothing is applied if any of them fails
  executeAll(commands: Command[]): Result<WorkspaceState> {
    if (this.closed) return fail('The workspace session is closed.');
    if (this.isMutationFenced) return fail(MUTATION_FENCE_MESSAGE);
    if (commands.some((command) => command.type === 'page.setNoteStyle'))
      return fail('Note styles must be changed through the typed note-style operation.');
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
    this.bumpNoteStyleRevisions([...all.pages, ...all.docs, ...all.removed]);
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
        new Error(
          `Files could not be deleted because a protected page may reference them: ${this.protectionMessage(id)}`,
        ),
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
      throw new Error(
        'History for opted-in Polaris Dados databases and rows is not writable through generic APIs.',
      );
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
      return fail(
        'History for opted-in Polaris Dados databases and rows cannot be restored through generic APIs.',
      );
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
    noteStylePages: PageId[] = [],
    noteStyleRestore?: NoteStyleRestore,
  ): string | null {
    const pilotDataRefusal = this.validatePilotDataChanges(state, allowedPilotDataDatabaseId);
    if (pilotDataRefusal) return pilotDataRefusal;
    const touched = new Set<PageId>([...changes.pages, ...changes.docs, ...changes.removed]);
    for (const id of touched) if (this.unreadable.has(id)) return this.protectionMessage(id);
    const batch: WriteBatch = {
      pages: [...changes.pages].flatMap((id) => (state.pages[id] ? [state.pages[id]!] : [])),
      docs: [...changes.docs].flatMap((id) => (state.docs[id] ? [{ id, doc: state.docs[id]! }] : [])),
      removed: [...changes.removed].filter((id) => !state.pages[id]),
      noteStylePages,
      ...(noteStyleRestore ? { noteStyleRestore } : {}),
      state,
    };
    return this.repository.validateWrite?.(batch) ?? null;
  }

  private inheritedNoteStyleRestoreBatch(
    pageId: PageId,
    appliedStyle: NoteStyle,
    restore: InheritedNoteStyleRestore,
  ): WriteBatch | null {
    const current = ownPage(this.state.pages, pageId);
    if (current?.kind !== 'page' || !sameNoteStyle(current.extra.morrowNoteStyle, appliedStyle)) return null;
    const extra = { ...current.extra };
    delete extra.morrowNoteStyle;
    const page = { ...current, extra };
    const state: WorkspaceState = {
      ...this.state,
      pages: { ...this.state.pages, [pageId]: page },
    };
    return {
      pages: [page],
      docs: [],
      removed: [],
      noteStylePages: [pageId],
      noteStyleRestore: restore,
      state,
    };
  }

  private explicitNoteStyleRestoreBatch(
    pageId: PageId,
    appliedStyle: NoteStyle,
    restore: ExplicitNoteStyleRestore,
    patch: ExplicitMorrowNoteStylePatch,
  ): WriteBatch | null {
    const current = ownPage(this.state.pages, pageId);
    if (
      current?.kind !== 'page' ||
      !matchesAppliedNoteStyleValues(current.extra.morrowNoteStyle, appliedStyle) ||
      !isRecord(current.extra.morrowNoteStyle)
    )
      return null;
    const extra = {
      ...current.extra,
      morrowNoteStyle: applyExplicitNoteStylePatch(current.extra.morrowNoteStyle, patch),
    };
    const page = { ...current, extra };
    const state: WorkspaceState = {
      ...this.state,
      pages: { ...this.state.pages, [pageId]: page },
    };
    return {
      pages: [page],
      docs: [],
      removed: [],
      noteStylePages: [pageId],
      noteStyleRestore: restore,
      state,
    };
  }

  private noteStyleRestoreBatch(
    restore: NoteStyleRestore,
    patch?: ExplicitMorrowNoteStylePatch,
  ): WriteBatch | null {
    return restore.kind === 'restore-inherited'
      ? this.inheritedNoteStyleRestoreBatch(restore.pageId, restore.appliedStyle, restore)
      : patch
        ? this.explicitNoteStyleRestoreBatch(restore.pageId, restore.appliedStyle, restore, patch)
        : null;
  }

  private validateNoteStyleRestore(batch: WriteBatch): string | null {
    const restore = batch.noteStyleRestore;
    if (!restore || !batch.state) return 'The note-style restoration is not isolated.';
    const refusal = this.validateChanges(
      {
        pages: new Set([restore.pageId]),
        docs: new Set(),
        removed: new Set(),
      },
      batch.state,
      undefined,
      [restore.pageId],
      restore,
    );
    return refusal;
  }

  private inheritedNoteStyleTargetError(
    pageId: PageId,
    appliedStyle: NoteStyle,
  ): NoteStyleFailureResult | null {
    const targetError = this.noteStyleTargetError(pageId);
    if (targetError) return targetError;
    const page = ownPage(this.state.pages, pageId);
    if (page?.encrypted)
      return noteStyleFailure('unsupported', 'Encrypted notes cannot restore an inherited note style.');
    if (!this.hasWritableNoteStyleSource(pageId))
      return noteStyleFailure('inaccessible', 'The note has no writable Markdown source.');
    if (!page || page.kind !== 'page' || !sameNoteStyle(page.extra.morrowNoteStyle, appliedStyle))
      return noteStyleFailure('stale-revision', 'The applied note style has changed.');
    return null;
  }

  private explicitNoteStyleTargetError(
    pageId: PageId,
    appliedStyle: NoteStyle,
  ): NoteStyleFailureResult | null {
    const targetError = this.noteStyleTargetError(pageId);
    if (targetError) return targetError;
    const page = ownPage(this.state.pages, pageId);
    if (page?.encrypted)
      return noteStyleFailure('unsupported', 'Encrypted notes cannot restore an explicit note style.');
    if (!this.hasWritableNoteStyleSource(pageId))
      return noteStyleFailure('inaccessible', 'The note has no writable Markdown source.');
    if (
      !page ||
      page.kind !== 'page' ||
      !matchesAppliedNoteStyleValues(page.extra.morrowNoteStyle, appliedStyle)
    )
      return noteStyleFailure('stale-revision', 'The applied note style has changed.');
    return null;
  }

  private noteStyleTargetError(pageId: PageId): NoteStyleFailureResult | null {
    if (this.closed) return noteStyleFailure('session-closed', 'The workspace session is closed.');
    const page = ownPage(this.state.pages, pageId);
    if (!page) return noteStyleFailure('page-not-found', 'That page no longer exists.');
    if (page.kind !== 'page')
      return noteStyleFailure('unsupported', 'Note styles can only be saved on ordinary pages.');
    if (isEffectivelyTrashed(this.state.pages, pageId))
      return noteStyleFailure('trashed', 'A page in the trash cannot be styled.');
    if (this.unreadable.has(pageId) || this.protectedReasons.has(pageId) || this.isPilotDataPage(pageId))
      return noteStyleFailure('read-only', 'This note is read only.');
    return null;
  }

  private noteStyleSaveFailure(): NoteStyleFailureResult {
    const status = this.queue.status;
    if (status.errorCode === 'save-conflict') {
      return noteStyleFailure(
        'save-conflict',
        status.error ??
          'The note changed on disk; its bytes were preserved and the style change was refused. Reopen the vault to review it.',
      );
    }
    return noteStyleFailure('save-failed', status.error ?? 'The note style could not be confirmed on disk.');
  }

  private noteStyleCommandFailure(message: string): NoteStyleFailureResult {
    const code = message.startsWith('Invalid note style')
      ? 'invalid-style'
      : message.startsWith('This note style') || message.startsWith('Note styles can only')
        ? 'unsupported'
        : message.includes('no writable Markdown source')
          ? 'inaccessible'
          : 'read-only';
    return noteStyleFailure(code, message);
  }

  private noteStyleRevision(pageId: PageId): string {
    // This is a monotonic session-local clock, not a content hash: A→B→A must not revive a
    // revision token previously handed to a style editor.
    let revision = this.noteStyleRevisions.get(pageId);
    if (revision === undefined) {
      revision = ++this.noteStyleRevisionClock;
      this.noteStyleRevisions.set(pageId, revision);
    }
    return `${this.noteStyleSessionId}:${pageId}:r${revision}`;
  }

  private bumpNoteStyleRevisions(ids: Iterable<PageId>): void {
    for (const id of new Set(ids)) {
      this.noteStyleRevisions.set(id, ++this.noteStyleRevisionClock);
    }
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
    const page = ownPage(this.state.pages, id);
    if (!page) return false;
    if (page.kind === 'database' && hasPilotDataMarker(page.extra)) return true;
    const parent = page.parentId ? ownPage(this.state.pages, page.parentId) : undefined;
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

function noteStyleFailure(code: NoteStyleFailureCode, message: string): NoteStyleFailureResult {
  return { ok: false, code, message };
}

function applyExplicitNoteStylePatch(
  current: Record<string, unknown>,
  patch: ExplicitMorrowNoteStylePatch,
): Record<string, unknown> {
  const restored = { ...current };
  for (const field of patch.remove) delete restored[field];
  for (const [field, value] of Object.entries(patch.set)) restored[field] = value;
  return restored;
}

function copyNoteStyle(style: NoteStyle): NoteStyle {
  return {
    font: style.font,
    fontSize: style.fontSize,
    lineHeight: style.lineHeight,
    blockSpacing: style.blockSpacing,
    width: style.width,
  };
}

function ownPage(pages: Record<PageId, PageMeta>, id: PageId): PageMeta | undefined {
  return Object.hasOwn(pages, id) ? pages[id] : undefined;
}

function setOwnPropertyValue<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    configurable: true,
    enumerable: true,
    writable: true,
  });
}

function ownDataFields(
  input: unknown,
  fields: readonly string[],
): { values: Record<string, unknown>; valid: boolean } | null {
  if (input === null || typeof input !== 'object') return null;
  try {
    if (Array.isArray(input)) return null;
    const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    let valid = true;
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(input, field);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        valid = false;
        continue;
      }
      values[field] = descriptor.value;
    }
    return { values, valid };
  } catch {
    return null;
  }
}

function isPilotDataId(value: unknown): value is string {
  return typeof value === 'string' && PILOT_DATA_ID_PATTERN.test(value);
}

function isPilotDataRevision(value: unknown): value is string {
  return typeof value === 'string' && PILOT_DATA_REVISION_PATTERN.test(value);
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
  if (typeof value === 'string' && value.length <= 10_000) return { present: true, value };
  if (typeof value === 'boolean') return { present: true, value };
  return null;
}

function isValidPilotDataCellValue(value: PilotDataHistoryCellValue): boolean {
  return value.present === false
    ? value.value === null
    : value.value === null ||
        (typeof value.value === 'number' && Number.isFinite(value.value)) ||
        (typeof value.value === 'string' && value.value.length <= 10_000) ||
        typeof value.value === 'boolean';
}

function isPilotDataHistoryCellValueForType(value: PilotDataHistoryCellValue, type: PropType): boolean {
  if (value.present === false) return value.value === null;
  if (value.value === null) return type === 'number' || type === 'text' || type === 'checkbox';
  if (type === 'number') return typeof value.value === 'number' && Number.isFinite(value.value);
  if (type === 'text') return typeof value.value === 'string' && value.value.length <= 10_000;
  if (type === 'checkbox') return typeof value.value === 'boolean';
  return false;
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
