// stores the workspace as a folder of markdown files, one file per page with metadata in frontmatter
import { canvasDoc, canvasFromDoc, readCanvas, writeCanvas } from '../core/canvas';
import { decryptPage, encryptPage, isEncryptedText, newPageKey } from '../core/crypto';
import type { PageKey } from '../core/crypto';
import { isDocEmpty, isRecord, validateDoc, walk } from '../core/doc';
import { snapshotsToPrune } from '../core/history';
import {
  markdownHrefPath,
  markdownRetargetSpans,
  markdownToDoc,
  parseWikiLink,
} from '../core/markdown/parse';
import { docToMarkdown, retargetMarkdownHref } from '../core/markdown/serialize';
import { displayTitle, emptyDoc, newPageMeta } from '../core/model';
import type {
  DocNode,
  FileId,
  FileMeta,
  PageId,
  PageMeta,
  PropValue,
  Snapshot,
  WorkspaceState,
} from '../core/model';
import { errorMessage, fail, ok } from '../core/result';
import type { Result } from '../core/result';
import { childrenOf } from '../core/tree';
import {
  findUnrepresentablePageContent,
  findUnrepresentableVaultMetadata,
  hasUnrepresentableDatabaseSchema,
} from '../core/vault/compatibility';
import { linkTargets, placePages } from '../core/vault/layout';
import type { Placement } from '../core/vault/layout';
import {
  loadVault,
  makeResolver,
  MAX_PAGE_BYTES,
  parseOptions,
  readRegistry,
  resolveFile,
  resolveMarkdownPageLink,
} from '../core/vault/load';
import type { LoadedVault, RegistryEntry, Resolver } from '../core/vault/load';
import {
  composeFrontmatter,
  impliedTitle,
  managedFrontmatter,
  readProperty,
  readPageText,
  takeProperties,
  renderPageText,
  sameValue,
  UnsafeFrontmatterUpdateError,
} from '../core/vault/pageFile';
import type { PageSource } from '../core/vault/pageFile';
import {
  findKey,
  isUnambiguousFrontmatter,
  splitFrontmatter,
  updateFrontmatter,
} from '../core/vault/frontmatter';
import {
  ATTACHMENTS_DIR,
  basename,
  dirname,
  extension,
  isHiddenPath,
  isImagePath,
  isInTrash,
  isPageFile,
  joinPath,
  MORROW_DIR,
  relativePath,
  resolveRelative,
  safeFileName,
  stripExtension,
  TRASH_DIR,
} from '../core/vault/paths';
import { planMoves, replayRename } from '../core/vault/plan';
import type { VaultOp, VaultOpResult } from '../core/vault/plan';
import type { LoadedWorkspace } from '../core/migrations';
import { WorkspaceWriteError } from './repository';
import type { ExternalPatch, StoredFile, WorkspaceRepository, WriteBatch } from './repository';
import type { VaultBridge, VaultChange } from './vaultBridge';

export const REGISTRY_PATH = `${MORROW_DIR}/workspace.json`;
export const RECENT_PATH = `${MORROW_DIR}/recent.json`;
const HISTORY_DIR = `${MORROW_DIR}/history`;
const MAX_RECENT = 300;
const MAX_ACTIVITY_DAYS = 400;

type FolderOwnerIndex = ReadonlyMap<
  string,
  { readonly count: number; readonly first: PageId; readonly second?: PageId }
>;

function indexFolderOwners(layout: Map<PageId, Placement>): FolderOwnerIndex {
  const owners = new Map<string, { count: number; first: PageId; second?: PageId }>();
  for (const [id, placement] of layout) {
    const folder = placement.folder.toLowerCase();
    const current = owners.get(folder);
    if (!current) {
      owners.set(folder, { count: 1, first: id });
    } else if (current.count === 1) {
      owners.set(folder, { count: 2, first: current.first, second: id });
    } else {
      owners.set(folder, { ...current, count: current.count + 1 });
    }
  }
  return owners;
}

function sourceParentId(
  id: PageId,
  placement: Placement,
  owners: FolderOwnerIndex,
): PageId | null | undefined {
  const parentFolder = dirname(placement.folder);
  if (!parentFolder) return null;
  const folderOwners = owners.get(parentFolder.toLowerCase());
  if (!folderOwners) return undefined;
  if (folderOwners.first !== id) return folderOwners.count === 1 ? folderOwners.first : undefined;
  return folderOwners.count === 2 ? folderOwners.second : undefined;
}

interface NavigationReadContext {
  readonly state: WorkspaceState;
  readonly layout: Map<PageId, Placement>;
  readonly sources: Map<PageId, PageSource>;
  readonly others: Set<string>;
  readonly resolver: Resolver;
  readonly otherIndex: Map<string, string>;
  readonly otherNames: Map<string, string[]>;
}

interface RenderedPage {
  text: string | null;
  source: PageSource | null;
}

function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
const DATE_NAME = /^\d{4}-\d{2}-\d{2}$/;

export class VaultRepository implements WorkspaceRepository {
  private layout = new Map<PageId, Placement>();
  private folderOnly = new Set<PageId>();
  private sources = new Map<PageId, PageSource>();
  // what each page file holds on disk, as far as morrow knows
  private texts = new Map<PageId, string>();
  private reserved = new Set<string>();
  // pages that could not be read, their files are never rewritten
  private locked = new Set<PageId>();
  private protectedReasons = new Map<PageId, string>();
  private others = new Set<string>();
  private registryText: string | null = null;
  private recentText: string | null = null;
  // keys of unlocked encrypted pages, kept in memory only
  private readonly keys = new Map<PageId, PageKey>();
  // the plain text last encrypted for each page, to tell whether anything changed
  private readonly plainTexts = new Map<PageId, string>();
  private readonly pendingPlain = new Map<PageId, string>();
  // when morrow last wrote each path, lower case. a page moved and rewritten is renamed first and written
  // after, and the file watcher can catch it in between, still holding the text from before the move. such
  // a file is older than morrow's write, so it is not taken for an edit made elsewhere
  private readonly wroteAt = new Map<string, number>();
  // changes the watcher reports while a save is still writing files wait for it to finish. until then the
  // files written so far are not known as morrow's own, and would come back in as new pages
  private saving = 0;
  private held: VaultChange[] = [];
  private readonly historyCleared = new Set<PageId>();
  // saves per day, for the activity chart on the home page
  private readonly days = new Map<string, number>();
  private registryDirty = false;
  private readonly history = new Map<PageId, Snapshot[]>();
  private readonly listeners = new Set<(patch: ExternalPatch) => PageId[]>();
  private stopWatching: (() => void) | null = null;
  private currentState: () => WorkspaceState | null = () => null;
  private lastState: WorkspaceState | null = null;

  constructor(
    private readonly bridge: VaultBridge,
    private readonly newId: () => string,
  ) {}

  get location(): string {
    return this.bridge.root;
  }

  pathOf(id: PageId): string | null {
    const placement = this.layout.get(id);
    return placement ? (placement.file ?? placement.folder) : null;
  }

  // lets edits made elsewhere be read against the live workspace, not the last saved one
  attachState(getState: () => WorkspaceState): void {
    this.currentState = getState;
  }

  async load(): Promise<Result<LoadedWorkspace & { firstRun: boolean }>> {
    try {
      const [scan, registryText, recentText] = await Promise.all([
        this.bridge.scan(),
        this.bridge.readText(REGISTRY_PATH),
        this.bridge.readText(RECENT_PATH),
      ]);
      const parseMetadata = (
        text: string | null,
        scanned: unknown,
        kind: 'workspace' | 'recent',
      ): { value: unknown; problem: string | null } => {
        if (text === null)
          return { value: scanned, problem: findUnrepresentableVaultMetadata(scanned, kind) };
        let value: unknown;
        try {
          value = JSON.parse(text) as unknown;
        } catch {
          return {
            value: null,
            problem: `The Morrow ${kind} metadata could not be read and was left untouched.`,
          };
        }
        if (value === null) {
          return { value, problem: `The Morrow ${kind} metadata is not a supported object.` };
        }
        return { value, problem: findUnrepresentableVaultMetadata(value, kind) };
      };
      const registry = parseMetadata(registryText, scan.registry, 'workspace');
      const recent = parseMetadata(recentText, scan.recent, 'recent');
      if (registry.problem || recent.problem) {
        return fail(
          `${registry.problem ?? recent.problem} Opening this vault was stopped before any file could be changed.`,
        );
      }
      const guardedScan = { ...scan, registry: registry.value, recent: recent.value };
      const loaded = loadVault(guardedScan, this.newId);
      this.adopt(loaded);
      this.others = new Set(scan.others);
      this.registryText = registryText ?? (registry.value === null ? null : JSON.stringify(registry.value));
      this.recentText = recentText ?? (recent.value === null ? null : JSON.stringify(recent.value));
      const activity = (recent.value as { activity?: unknown } | null)?.activity;
      if (activity && typeof activity === 'object') {
        for (const [day, count] of Object.entries(activity as Record<string, unknown>)) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(day) && typeof count === 'number' && count > 0)
            this.days.set(day, count);
        }
      }
      this.registryDirty = loaded.registryChanged;
      this.lastState = {
        pages: Object.fromEntries(loaded.pages.map((page) => [page.id, page])),
        docs: loaded.docs,
      };
      this.stopWatching = this.bridge.onChange((changes) => this.onChanges(changes));
      const firstRun =
        scan.files.length === 0 &&
        registry.value === null &&
        scan.folders.every((folder) => isHiddenPath(folder.path) || folder.path === TRASH_DIR);
      return ok({
        pages: loaded.pages,
        docs: loaded.docs,
        problems: loaded.problems,
        unreadable: loaded.unreadable,
        protectedPages: Object.fromEntries(loaded.protectedPages),
        firstRun,
      });
    } catch (error) {
      return fail(`Could not open the folder ${this.bridge.root}: ${errorMessage(error)}`);
    }
  }

  private adopt(loaded: LoadedVault): void {
    this.layout = loaded.layout;
    this.folderOnly = loaded.folderOnly;
    this.sources = loaded.sources;
    this.texts = loaded.texts;
    this.reserved = loaded.reserved;
    this.locked = new Set(loaded.unreadable);
    this.protectedReasons = new Map(loaded.protectedPages);
  }

  validateWrite(batch: WriteBatch): string | null {
    const state = batch.state ?? this.lastState;
    if (!state) return 'Nothing to write yet.';
    const touched = new Set<PageId>([
      ...batch.pages.map((page) => page.id),
      ...batch.docs.map((record) => record.id),
      ...batch.removed,
      ...(batch.snapshots ?? []).map((snapshot) => snapshot.pageId),
    ]);
    for (const id of touched) if (this.locked.has(id)) return this.protectionMessage(id);

    // Adding or moving a child under a read-only page changes its directory contents and, for
    // databases, the set of rows. Keep the whole parent boundary read only as well.
    for (const id of touched) {
      const page = state.pages[id];
      if (page?.parentId && this.locked.has(page.parentId)) {
        return this.protectionMessage(page.parentId);
      }
    }

    for (const id of this.locked) {
      const beforePage = this.lastState?.pages[id];
      const afterPage = state.pages[id];
      const beforeDoc = this.lastState?.docs[id];
      const afterDoc = state.docs[id];
      if (!sameValue(beforePage, afterPage) || !sameValue(beforeDoc, afterDoc)) {
        return this.protectionMessage(id);
      }
    }

    const removed = new Set(batch.removed.filter((id) => !state.pages[id]));
    const previous = new Map([...this.layout].filter(([id]) => !removed.has(id)));
    const next = placePages(state, previous, this.folderOnly, this.reserved);
    for (const id of this.locked) {
      const before = this.layout.get(id);
      const after = next.get(id);
      if (before && (!after || before.file !== after.file || before.folder !== after.folder)) {
        return this.protectionMessage(id);
      }
    }
    return null;
  }

  private protectionMessage(id: PageId): string {
    const reason = this.protectedReasons.get(id);
    return reason
      ? `This page is protected because Morrow cannot safely represent its content: ${reason}`
      : 'This page could not be read and is protected from changes.';
  }

  async markInitialized(): Promise<void> {
    if (!this.registryDirty || !this.lastState) return;
    await this.write({ pages: [], docs: [], removed: [], state: this.lastState });
  }

  async write(batch: WriteBatch): Promise<void> {
    const state = batch.state ?? this.lastState;
    if (!state) throw new Error('Nothing to write yet.');
    const refusal = this.validateWrite(batch);
    if (refusal) throw new Error(refusal);
    const metadataRefusal = await this.validateMetadataBeforeWrite();
    if (metadataRefusal) throw new Error(metadataRefusal);
    const docChanged = new Set(batch.docs.map((record) => record.id));
    const metaChanged = new Set(batch.pages.map((page) => page.id));
    const quietPageIds = new Set(batch.quietPageIds ?? []);
    const nonQuietMetaChanged = new Set([...metaChanged].filter((id) => !quietPageIds.has(id)));
    const removed = new Set(batch.removed.filter((id) => !state.pages[id]));

    // a folder that gains content or properties gets a note of its own
    for (const id of [...docChanged, ...nonQuietMetaChanged]) {
      if (this.folderOnly.has(id) && this.wantsFile(state, id)) this.folderOnly.delete(id);
    }

    const previous = new Map([...this.layout].filter(([id]) => !removed.has(id)));
    const next = placePages(state, previous, this.folderOnly, this.reserved);
    const previousFolderOwners = indexFolderOwners(previous);
    const nextFolderOwners = indexFolderOwners(next);
    const persistibleSourceMatches = new Map<PageId, boolean>();
    // Put a non-mutating compare ahead of moves/removals, then compare again at each metadata write.
    const ops: VaultOp[] = [
      { op: 'check', path: REGISTRY_PATH, expect: this.registryText },
      { op: 'check', path: RECENT_PATH, expect: this.recentText },
    ];

    const oldTargets = linkTargets(previous);
    const newTargets = linkTargets(next);
    const retargeted = new Set<PageId>();
    for (const [id, target] of newTargets)
      if (oldTargets.has(id) && oldTargets.get(id) !== target) retargeted.add(id);
    const movedPages = new Set<PageId>();
    for (const [id, placement] of next) {
      const before = previous.get(id);
      if (before && (before.file !== placement.file || before.folder !== placement.folder))
        movedPages.add(id);
    }

    const candidates = new Set<PageId>([...docChanged, ...metaChanged]);
    const structuralCandidates = new Set<PageId>(docChanged);
    const markdownReferrers = new Set<PageId>();
    for (const [id, placement] of next)
      if (!previous.has(id) || movedPages.has(id) || (placement.file && !this.texts.has(id))) {
        candidates.add(id);
        structuralCandidates.add(id);
      }
    if (retargeted.size > 0 || movedPages.size > 0) {
      for (const [id, doc] of Object.entries(state.docs)) {
        const linksToMovedMarkdownPage = linksToMarkdownPage(doc, movedPages);
        const movedMarkdownSource = movedPages.has(id) && hasMarkdownPageLink(doc);
        if (
          linksTo(doc, retargeted) ||
          linksToMovedMarkdownPage ||
          movedMarkdownSource ||
          (state.pages[id]?.kind === 'canvas' && linksTo(doc, movedPages))
        ) {
          candidates.add(id);
          structuralCandidates.add(id);
          if (linksToMovedMarkdownPage || movedMarkdownSource) markdownReferrers.add(id);
        }
      }
    }
    const quietSchemaDependents = new Set<PageId>();
    const nonQuietSchemaDependents = new Set<PageId>();
    for (const id of metaChanged) {
      if (state.pages[id]?.kind === 'database') {
        for (const child of childrenOf(state.pages, id, true)) {
          candidates.add(child.id);
          if (
            quietPageIds.has(id) &&
            !nonQuietMetaChanged.has(id) &&
            !docChanged.has(id) &&
            !movedPages.has(id) &&
            !retargeted.has(id)
          ) {
            quietSchemaDependents.add(child.id);
          } else {
            nonQuietSchemaDependents.add(child.id);
          }
        }
      }
    }

    const preservedSources = new Set<PageId>();
    const sourcesToCheck = new Set<PageId>();
    let navigationReadContext: NavigationReadContext | null = null;
    const getNavigationReadContext = (): NavigationReadContext => {
      navigationReadContext ??= this.createNavigationReadContext(state, next);
      return navigationReadContext;
    };
    for (const id of candidates) {
      const dependencies = this.navigationSourceDependencies(
        id,
        state,
        previous,
        next,
        previousFolderOwners,
        nextFolderOwners,
        movedPages,
        retargeted,
        docChanged,
        persistibleSourceMatches,
        getNavigationReadContext,
      );
      if (!dependencies) continue;
      preservedSources.add(id);
      for (const dependency of dependencies) sourcesToCheck.add(dependency);
    }
    // Check every Markdown referrer before moves begin so a known external edit cannot leave a
    // partially moved target followed by a failed referrer write.
    for (const id of markdownReferrers) sourcesToCheck.add(id);

    const checkedSources = new Set<string>();
    for (const id of batch.checkPages ?? []) {
      const source = this.layout.get(id);
      const baseline = this.texts.get(id);
      if (!source?.file || baseline === undefined) {
        throw new WorkspaceWriteError(
          'save-conflict',
          'The source database for a staged Polaris Dados edit is no longer available.',
          false,
        );
      }
      ops.push({ op: 'check', path: source.file, expect: baseline, id });
      checkedSources.add(source.file.toLowerCase());
    }
    for (const id of sourcesToCheck) {
      const source = this.layout.get(id);
      const baseline = this.texts.get(id);
      if (!source?.file || baseline === undefined) continue;
      if (checkedSources.has(source.file.toLowerCase())) continue;
      ops.push({ op: 'check', path: source.file, expect: baseline, id });
      checkedSources.add(source.file.toLowerCase());
    }

    for (const id of removed) {
      const before = this.layout.get(id);
      if (before?.file) ops.push({ op: 'remove', path: before.file });
      // a page deleted for good takes its history with it, which would otherwise keep its pictures and
      // files in the attachments folder for ever
      if (before) {
        ops.push({ op: 'delete', path: this.historyPath(id) });
        this.history.delete(id);
      }
    }
    ops.push(...planMoves(previous, next));

    const resolveOld =
      retargeted.size > 0 || movedPages.size > 0 ? makeResolver(state, previous, this.sources) : null;
    const resolveCurrent = makeResolver(state, next, this.sources);
    const skippedQuietSerialization = new Set<PageId>();
    const plannedSources = new Map<PageId, PageSource>();
    for (const id of candidates) {
      if (preservedSources.has(id)) continue;
      const placement = next.get(id);
      if (!state.pages[id] || !placement?.file || this.locked.has(id)) continue;
      const doc = state.docs[id];
      const structurallyAffectedCanvas =
        state.pages[id]?.kind === 'canvas' && doc !== undefined && linksTo(doc, movedPages);
      const retargetedLink = retargeted.size > 0 && doc !== undefined && linksTo(doc, retargeted);
      const retargetedMarkdownLink = markdownReferrers.has(id);
      const enteredThroughQuiet =
        (quietPageIds.has(id) && metaChanged.has(id)) || quietSchemaDependents.has(id);
      const quietOnlyCandidate =
        enteredThroughQuiet &&
        !nonQuietMetaChanged.has(id) &&
        !nonQuietSchemaDependents.has(id) &&
        !structuralCandidates.has(id) &&
        !movedPages.has(id) &&
        !retargeted.has(id) &&
        !retargetedLink &&
        !retargetedMarkdownLink &&
        !structurallyAffectedCanvas;
      if (quietOnlyCandidate) {
        skippedQuietSerialization.add(id);
        continue;
      }
      const rendered = this.render(
        state,
        next,
        newTargets,
        id,
        docChanged.has(id),
        previous.get(id),
        resolveOld,
        resolveCurrent,
        retargeted,
        movedPages,
      );
      const text = rendered.text;
      if (text === null) continue;
      let written = text;
      if (state.pages[id]!.encrypted) {
        // encrypted pages are compared before encryption, a fresh nonce makes every encrypted copy differ
        const pageKey = this.keys.get(id);
        if (!pageKey) continue;
        if (text === this.plainTexts.get(id) && this.texts.has(id) && isEncryptedText(this.texts.get(id)!))
          continue;
        written = await encryptPage(text, pageKey);
        this.pendingPlain.set(id, text);
      } else if (text === this.texts.get(id)) continue;
      if (rendered.source) plannedSources.set(id, rendered.source);
      ops.push({
        op: 'write',
        path: placement.file,
        text: written,
        expect: this.texts.has(id) ? this.texts.get(id)! : null,
        id,
      });
    }
    // turning encryption on removes the plain versions kept in page history
    for (const id of metaChanged) {
      if (
        !quietPageIds.has(id) &&
        state.pages[id]?.encrypted &&
        this.layout.has(id) &&
        !this.history.get(id)?.length &&
        !this.historyCleared.has(id)
      ) {
        ops.push({ op: 'delete', path: this.historyPath(id) });
        this.historyCleared.add(id);
      }
    }

    // folders emptied by removals and moves are tidied away, folders with other files stay
    const emptied = new Set<string>();
    for (const id of removed) {
      const before = this.layout.get(id);
      if (before) emptied.add(before.folder);
    }
    for (const id of movedPages) {
      const before = previous.get(id)!;
      const parentFolder = dirname(before.folder);
      if (parentFolder && parentFolder !== TRASH_DIR) emptied.add(parentFolder);
    }

    for (const snapshot of batch.snapshots ?? []) {
      const op = await this.historyOp(snapshot);
      if (op) ops.push(op);
    }

    const guardedLinkedViewPages = new Set<PageId>();
    for (const id of candidates) {
      if (skippedQuietSerialization.has(id)) continue;
      const placement = next.get(id);
      if (!placement?.file || extension(placement.file) !== 'md') continue;
      const stagedHasLinkedView = hasLinkedViewNode(state.docs[id]);
      if (stagedHasLinkedView) guardedLinkedViewPages.add(id);
    }

    const edited = batch.docs.length;
    if (edited > 0) {
      const day = localDay(new Date());
      this.days.set(day, (this.days.get(day) ?? 0) + edited);
    }
    const registry = this.registryFor(state, next);
    if (registry.workspace !== this.registryText)
      ops.push({ op: 'write', path: REGISTRY_PATH, text: registry.workspace, expect: this.registryText });
    if (registry.recent !== this.recentText)
      ops.push({ op: 'write', path: RECENT_PATH, text: registry.recent, expect: this.recentText });
    // the shell only removes empty folders, a folder page keeps its folder because the folder is the page
    const folderPages = new Set(
      [...next.values()].filter((p) => p.file === null).map((p) => p.folder.toLowerCase()),
    );
    for (const folder of [...emptied].sort((a, b) => b.length - a.length)) {
      if (!folderPages.has(folder.toLowerCase())) ops.push({ op: 'rmdir', path: folder });
    }

    await this.run(ops, next, guardedLinkedViewPages, markdownReferrers, plannedSources);
    this.lastState = state;
    this.registryText = registry.workspace;
    this.recentText = registry.recent;
    this.registryDirty = false;
  }

  private navigationSourceDependencies(
    id: PageId,
    state: WorkspaceState,
    previous: Map<PageId, Placement>,
    next: Map<PageId, Placement>,
    previousFolderOwners: FolderOwnerIndex,
    nextFolderOwners: FolderOwnerIndex,
    movedPages: Set<PageId>,
    retargeted: Set<PageId>,
    docChanged: Set<PageId>,
    persistibleSourceMatches: Map<PageId, boolean>,
    getNavigationReadContext: () => NavigationReadContext,
  ): PageId[] | null {
    const page = state.pages[id];
    const before = previous.get(id);
    const after = next.get(id);
    const parent = page?.parentId ? state.pages[page.parentId] : undefined;
    if (
      !page ||
      !before?.file ||
      !after?.file ||
      extension(before.file) !== 'md' ||
      before.file !== after.file ||
      before.folder !== after.folder ||
      movedPages.has(id) ||
      retargeted.size > 0 ||
      docChanged.has(id) ||
      linksToMarkdownPage(state.docs[id], movedPages) ||
      this.locked.has(id) ||
      page.encrypted ||
      (!isOptedInDatabase(page) && !isOptedInDatabase(parent))
    ) {
      return null;
    }

    const previousOwner = sourceParentId(id, before, previousFolderOwners);
    const nextOwner = sourceParentId(id, after, nextFolderOwners);
    if (
      previousOwner === undefined ||
      nextOwner === undefined ||
      previousOwner !== nextOwner ||
      page.parentId !== nextOwner
    ) {
      return null;
    }

    const dependencies = [id];
    if (page.parentId) {
      const parentId = page.parentId;
      if (docChanged.has(parentId) || movedPages.has(parentId) || retargeted.has(parentId)) return null;
      if (parent?.kind === 'database') {
        const parentBefore = previous.get(parentId);
        const parentAfter = next.get(parentId);
        const grandparent = parent.parentId ? state.pages[parent.parentId] : undefined;
        if (
          !parent.database ||
          !parentBefore?.file ||
          !parentAfter?.file ||
          parentBefore.file !== parentAfter.file ||
          parentBefore.folder !== parentAfter.folder ||
          movedPages.has(parentId) ||
          grandparent?.kind === 'database' ||
          !this.sourceMatchesPersistiblePage(
            parentId,
            state,
            next,
            nextFolderOwners,
            persistibleSourceMatches,
            getNavigationReadContext,
          )
        ) {
          return null;
        }
        dependencies.push(parentId);
      }
    }

    if (
      !this.sourceMatchesPersistiblePage(
        id,
        state,
        next,
        nextFolderOwners,
        persistibleSourceMatches,
        getNavigationReadContext,
      )
    )
      return null;
    return dependencies;
  }

  private sourceMatchesPersistiblePage(
    id: PageId,
    state: WorkspaceState,
    layout: Map<PageId, Placement>,
    folderOwners: FolderOwnerIndex,
    matches: Map<PageId, boolean>,
    getNavigationReadContext: () => NavigationReadContext,
  ): boolean {
    const remembered = matches.get(id);
    if (remembered !== undefined || matches.has(id)) return remembered ?? false;
    const page = state.pages[id];
    const placement = layout.get(id);
    const baseline = this.texts.get(id);
    if (
      !page ||
      !placement?.file ||
      extension(placement.file) !== 'md' ||
      baseline === undefined ||
      this.locked.has(id) ||
      page.encrypted
    ) {
      return false;
    }

    const sourceParent = sourceParentId(id, placement, folderOwners);
    if (sourceParent === undefined || page.parentId !== sourceParent) {
      matches.set(id, false);
      return false;
    }

    let matchesSource: boolean;
    try {
      const parsed = this.readFile(
        placement.file,
        baseline,
        page,
        state,
        layout,
        () => {
          throw new Error('A new select option would be required to compare this source safely.');
        },
        getNavigationReadContext(),
      );
      matchesSource =
        parsed.ok &&
        parsed.database === undefined &&
        samePersistiblePageContent(page, parsed.page) &&
        sameValue(state.docs[id], parsed.doc);
    } catch {
      matchesSource = false;
    }
    matches.set(id, matchesSource);
    return matchesSource;
  }

  private async validateMetadataBeforeWrite(): Promise<string | null> {
    for (const [path, kind, baseline] of [
      [REGISTRY_PATH, 'workspace', this.registryText],
      [RECENT_PATH, 'recent', this.recentText],
    ] as const) {
      let current: string | null;
      try {
        current = await this.bridge.readText(path);
      } catch {
        return `The Morrow ${kind} metadata could not be checked; no files were changed.`;
      }
      if (current === null) {
        if (baseline !== null) {
          return `The Morrow ${kind} metadata changed after opening; reopen this vault before saving.`;
        }
        continue;
      }

      let raw: unknown;
      try {
        raw = JSON.parse(current) as unknown;
      } catch {
        return `The Morrow ${kind} metadata could not be read and was left untouched.`;
      }
      const issue = findUnrepresentableVaultMetadata(raw, kind);
      if (issue) return `${issue} No files were changed.`;
      if (current !== baseline) {
        return `The Morrow ${kind} metadata changed after opening; reopen this vault before saving.`;
      }
    }
    return null;
  }

  private createNavigationReadContext(
    state: WorkspaceState,
    layout: Map<PageId, Placement>,
  ): NavigationReadContext {
    const otherIndex = new Map<string, string>();
    const otherNames = new Map<string, string[]>();
    for (const path of this.others) {
      otherIndex.set(path.toLowerCase(), path);
      const name = basename(path).toLowerCase();
      otherNames.set(name, [...(otherNames.get(name) ?? []), path]);
    }
    return {
      state,
      layout,
      sources: this.sources,
      others: this.others,
      resolver: makeResolver(state, layout, this.sources),
      otherIndex,
      otherNames,
    };
  }

  private wantsFile(state: WorkspaceState, id: PageId): boolean {
    const page = state.pages[id];
    const doc = state.docs[id];
    if (!page) return false;
    if (doc && !isDocEmpty(doc)) return true;
    const parent = page.parentId ? state.pages[page.parentId] : undefined;
    const placement = this.layout.get(id);
    const managed = managedFrontmatter(
      page,
      placement ? basename(placement.folder) : '',
      parent?.kind === 'database' ? parent.database : null,
      parent?.kind === 'database' && Object.hasOwn(parent.extra, 'polarisDados'),
    );
    return managed.size > 0 || Object.keys(page.extra).length > 0;
  }

  private render(
    state: WorkspaceState,
    layout: Map<PageId, Placement>,
    targets: Map<PageId, string>,
    id: PageId,
    edited: boolean,
    before: Placement | undefined,
    resolveOld: Resolver | null,
    resolveCurrent: Resolver,
    retargeted: Set<PageId>,
    movedPages: Set<PageId>,
  ): RenderedPage {
    const page = state.pages[id]!;
    const placement = layout.get(id)!;
    if (page.kind === 'canvas')
      return {
        text: writeCanvas(canvasFromDoc(state.docs[id]), (pageId) => layout.get(pageId)?.file ?? null),
        source: null,
      };
    // a folder that just got a note of its own, for its tags, properties or kind, has no text yet
    const doc = state.docs[id] ?? emptyDoc();
    const dir = dirname(placement.file!);
    const beforeDir = before?.file ? dirname(before.file) : before ? dirname(before.folder) : dir;
    const markdownTarget = (href: string): string | null => {
      if (!resolveOld) return null;
      const targetId = resolveMarkdownPageLink(href, beforeDir, resolveOld);
      if (!targetId || (!movedPages.has(id) && !movedPages.has(targetId))) return null;
      return markdownPageTargetPath(targetId, href, dir, layout, resolveCurrent);
    };
    let source = this.sources.get(id) ?? null;
    const movedDir = before !== undefined && dirname(before.folder) !== dirname(placement.folder);
    if (source && source.body !== null && (edited || (movedDir && hasFileRefs(doc)))) {
      source = { ...source, body: null };
    }
    let body: string;
    if (source && source.body !== null) {
      body = resolveOld
        ? retargetLinks(
            source.body,
            (target) => {
              const found = resolveOld.resolve(target, beforeDir);
              return found && retargeted.has(found) ? (targets.get(found) ?? null) : null;
            },
            markdownTarget,
          )
        : source.body;
      if (body !== source.body) {
        source = { ...source, body };
      }
    } else {
      body = docToMarkdown(doc, {
        linkTarget: (pageId) => targets.get(pageId) ?? null,
        markdownLinkTarget: (pageId, href) =>
          markdownPageTargetPath(pageId, href, dir, layout, resolveCurrent),
        titleOf: (pageId) => (state.pages[pageId] ? displayTitle(state.pages[pageId]) : null),
        filePath: (fileId) =>
          fileId.includes('/') || fileId.includes('.') ? relativePath(dir, fileId) : null,
      });
    }
    const parent = page.parentId ? state.pages[page.parentId] : undefined;
    const managed = managedFrontmatter(
      page,
      basename(placement.folder),
      parent?.kind === 'database' ? parent.database : null,
      parent?.kind === 'database' && Object.hasOwn(parent.extra, 'polarisDados'),
    );
    let frontmatter = composeFrontmatter(managed, page.extra, source, page);
    const changedCheckboxKeys = new Set<string>();
    const unchangedSchemaKeys = new Set<string>();
    let schemaValuesChanged = false;
    const optedInDatabase =
      parent?.kind === 'database' &&
      parent.database !== null &&
      Object.hasOwn(parent.extra, 'polarisDados');
    const unchangedSourceValues = new Map<string, unknown>();
    if (source?.rawData && parent?.kind === 'database' && parent.database) {
      for (const property of parent.database.properties) {
        if (property.type === 'formula') continue;
        const sourceKey = findKey(source.rawData, property.name);
        const hasPageValue = Object.hasOwn(page.properties, property.id);
        if (sourceKey === undefined) {
          if (hasPageValue) {
            schemaValuesChanged = true;
            if (property.type === 'checkbox' && optedInDatabase) {
              changedCheckboxKeys.add(findKey(frontmatter, property.name) ?? property.name);
            }
          }
          continue;
        }
        const raw = source.rawData[sourceKey];
        const parsed = readProperty(
          property,
          raw,
          () => '',
          optedInDatabase && (property.type === 'text' || property.type === 'checkbox'),
        ).value;
        // takeProperties leaves unrepresentable non-empty values in page.extra so they remain
        // editable. Only restore source values that its parser actually consumes (or omits as null/empty).
        if (parsed === null && raw !== null && raw !== '') continue;
        // Match the page's effective property state, including whether it is present. A null raw
        // value maps to an explicit null only in the opted-in lane; legacy schemas omit it.
        const sourceHasPageValue = parsed !== null || (optedInDatabase && raw === null);
        const sameAsSource =
          hasPageValue === sourceHasPageValue &&
          (!sourceHasPageValue || sameValue(parsed, page.properties[property.id]));

        if (!sameAsSource) schemaValuesChanged = true;
        if (property.type === 'checkbox' && optedInDatabase && !sameAsSource) {
          changedCheckboxKeys.add(
            findKey(frontmatter, property.name) ?? sourceKey ?? property.name,
          );
        }
        if (!sameAsSource) continue;
        unchangedSourceValues.set(sourceKey, raw);
        unchangedSchemaKeys.add(sourceKey);
      }
    }
    // Preserve unchanged raw schema values on unrelated edits. For actual opted-in schema edits,
    // keep the established typed serialization, except for the checkbox patch lane which must
    // preserve untouched source lines.
    if (
      unchangedSourceValues.size > 0 &&
      (!optedInDatabase || !schemaValuesChanged || changedCheckboxKeys.size > 0)
    ) {
      const preserved = new Map(Object.entries(frontmatter));
      for (const [sourceKey, raw] of unchangedSourceValues) {
        const candidateKey = findKey(frontmatter, sourceKey);
        if (candidateKey !== undefined && candidateKey !== sourceKey) preserved.delete(candidateKey);
        preserved.set(sourceKey, raw);
      }
      frontmatter = composeFrontmatter(preserved, {}, source);
    }
    let text: string;
    if (changedCheckboxKeys.size > 0 && source?.rawData && source.rawHead) {
      const updated = updateFrontmatter(
        source.rawYaml,
        source.rawData,
        frontmatter,
        body,
        changedCheckboxKeys,
        unchangedSchemaKeys,
      );
      if (updated === null) {
        throw new WorkspaceWriteError(
          'unsafe-checkbox-frontmatter',
          'The checkbox change was kept in memory but not written because its frontmatter cannot be changed without risking another value. No files were changed.',
          false,
        );
      }
      text = updated;
    } else {
      try {
        text = renderPageText(frontmatter, source, body);
      } catch (error) {
        if (error instanceof UnsafeFrontmatterUpdateError) {
          throw new WorkspaceWriteError('unsafe-frontmatter', error.message, false);
        }
        throw error;
      }
    }
    let writtenSource: PageSource | null = null;
    if (source) {
      const written = splitFrontmatter(text);
      // Keep this candidate local until its corresponding file write succeeds.
      writtenSource = {
        ...source,
        keyOrder: Object.keys(written.data ?? {}),
        rawData: written.data,
        rawHead: written.head,
        rawYaml: written.yaml,
      };
    }
    return { text, source: writtenSource };
  }

  // carries out the operations and keeps track of what reached the disk, even when something fails halfway
  private async run(
    ops: VaultOp[],
    next: Map<PageId, Placement>,
    guardedLinkedViewPages: ReadonlySet<PageId>,
    guardedMarkdownReferrers: ReadonlySet<PageId>,
    plannedSources: ReadonlyMap<PageId, PageSource>,
  ): Promise<void> {
    const started = Date.now();
    for (const op of ops) if (op.op === 'write') this.wroteAt.set(op.path.toLowerCase(), started);
    this.saving++;
    try {
      await this.runOps(ops, next, guardedLinkedViewPages, guardedMarkdownReferrers, plannedSources);
    } finally {
      this.saving--;
      if (this.saving === 0 && this.held.length > 0) {
        const held = this.held;
        this.held = [];
        this.onChanges(held);
      }
    }
  }

  private async runOps(
    ops: VaultOp[],
    next: Map<PageId, Placement>,
    guardedLinkedViewPages: ReadonlySet<PageId>,
    guardedMarkdownReferrers: ReadonlySet<PageId>,
    plannedSources: ReadonlyMap<PageId, PageSource>,
  ): Promise<void> {
    let pending = ops;
    const layout = new Map(this.layout);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (pending.length === 0) break;
      const results: VaultOpResult[] = await this.bridge.apply(pending);
      let failedAt = -1;
      for (let i = 0; i < results.length; i++) {
        if (results[i]!.ok) this.applied(pending[i]!, layout, next, plannedSources);
        else {
          failedAt = i;
          break;
        }
      }
      if (failedAt === -1 && results.length === pending.length) {
        pending = [];
        break;
      }
      if (failedAt === -1) throw new Error('The desktop shell stopped before finishing the save.');
      const failed = results[failedAt]!;
      const op = pending[failedAt]!;
      if (
        !failed.ok &&
        failed.code === 'conflict' &&
        op.op === 'check' &&
        op.id &&
        (this.isPilotDataRecord(op.id) ||
          guardedLinkedViewPages.has(op.id) ||
          guardedMarkdownReferrers.has(op.id) ||
          this.hasLinkedViewBaseline(op.id))
      ) {
        this.layout = layout;
        throw new WorkspaceWriteError(
          'save-conflict',
          guardedMarkdownReferrers.has(op.id)
            ? 'A Markdown link referrer changed on disk; its bytes were preserved and the retarget was refused. Reopen the vault to review the external version.'
            : 'A Polaris Dados source or linked-view note changed on disk. The staged change was kept in memory and not written; reopen the vault to review the external version.',
          false,
        );
      }
      if (!failed.ok && failed.code === 'conflict' && op.op === 'write' && op.id) {
        if (
          this.isPilotDataRecord(op.id) ||
          guardedLinkedViewPages.has(op.id) ||
          guardedMarkdownReferrers.has(op.id) ||
          this.hasLinkedViewBaseline(op.id)
        ) {
          this.layout = layout;
          throw new WorkspaceWriteError(
            'save-conflict',
            guardedMarkdownReferrers.has(op.id)
              ? 'A Markdown link referrer changed during retargeting; its bytes were preserved and automatic retry was refused. Reopen the vault to review the external version.'
              : 'A Polaris Dados source or linked-view note changed on disk. Automatic retry was refused; reopen the vault to review the external version.',
            false,
          );
        }
        const currentSplit = failed.current === null ? null : splitFrontmatter(failed.current);
        const ambiguousFrontmatter =
          currentSplit !== null &&
          currentSplit.head !== '' &&
          currentSplit.error === null &&
          currentSplit.data !== null &&
          !isUnambiguousFrontmatter(currentSplit.yaml, currentSplit.data);
        const reason =
          failed.current === null
            ? null
            : (findUnrepresentablePageContent(failed.current) ??
              currentSplit?.error ??
              (ambiguousFrontmatter ? 'The current file contains ambiguous YAML frontmatter.' : null) ??
              (isEncryptedText(failed.current) ? 'The current file is encrypted.' : null));
        if (reason) {
          // Earlier renames in this same batch may already have moved the page; keep that layout fact.
          this.layout = layout;
          if (ambiguousFrontmatter) {
            throw new WorkspaceWriteError(
              'unsafe-frontmatter',
              'The external page now contains ambiguous YAML frontmatter. Its bytes and the staged edit were kept; history capture and automatic retry were skipped.',
              false,
            );
          }
          throw new Error(
            `The page changed on disk and contains content this version cannot safely represent. It was left untouched: ${reason}`,
          );
        }
        // the file changed on disk in the meantime, that version is kept in page history before it is replaced
        if (failed.current !== null) await this.keepDiskVersion(op.id, failed.current);
        pending = [{ ...op, expect: failed.current }, ...pending.slice(failedAt + 1)];
        continue;
      }
      this.layout = layout;
      throw new Error(failed.ok ? 'Unknown error' : failed.message);
    }
    if (pending.length > 0) {
      this.layout = layout;
      throw new Error('The file kept changing on disk while Morrow tried to save it.');
    }
    this.layout = new Map(next);
  }

  private applied(
    op: VaultOp,
    layout: Map<PageId, Placement>,
    next: Map<PageId, Placement>,
    plannedSources: ReadonlyMap<PageId, PageSource>,
  ): void {
    switch (op.op) {
      case 'write':
        if (op.id) {
          this.texts.set(op.id, op.text);
          const source = plannedSources.get(op.id);
          if (source) this.sources.set(op.id, source);
          const plain = this.pendingPlain.get(op.id);
          if (plain !== undefined) {
            this.plainTexts.set(op.id, plain);
            this.pendingPlain.delete(op.id);
          }
          const target = next.get(op.id);
          if (target) layout.set(op.id, { ...target });
        }
        break;
      case 'rename':
        replayRename(layout, op.from, op.to);
        break;
      case 'remove':
        for (const [id, placement] of layout) {
          if (placement.file !== op.path) continue;
          layout.delete(id);
          this.texts.delete(id);
          this.sources.delete(id);
          this.folderOnly.delete(id);
          this.locked.delete(id);
        }
        break;
      default:
        break;
    }
  }

  private isPilotDataRecord(id: PageId): boolean {
    const state = this.currentState() ?? this.lastState;
    const page = state?.pages[id];
    if (!page) return false;
    if (page.kind === 'database' && Object.hasOwn(page.extra, 'polarisDados')) return true;
    const parent = page.parentId ? state?.pages[page.parentId] : undefined;
    return parent?.kind === 'database' && Object.hasOwn(parent.extra, 'polarisDados');
  }

  private hasLinkedViewText(text: string): boolean {
    if (isEncryptedText(text) || findUnrepresentablePageContent(text)) return false;
    try {
      const page = readPageText(text);
      if (page.error) return false;
      return hasLinkedViewNode(markdownToDoc(page.body));
    } catch {
      return false;
    }
  }

  private hasLinkedViewBaseline(id: PageId): boolean {
    const text = this.plainTexts.get(id) ?? this.texts.get(id);
    return text ? this.hasLinkedViewText(text) : false;
  }

  private registryFor(
    state: WorkspaceState,
    layout: Map<PageId, Placement>,
  ): { workspace: string; recent: string } {
    const pages: Record<string, RegistryEntry> = {};
    const opened: Array<[PageId, number]> = [];
    for (const [id, placement] of [...layout].sort(([, a], [, b]) =>
      (a.file ?? a.folder).localeCompare(b.file ?? b.folder),
    )) {
      const page = state.pages[id];
      if (!page) continue;
      const entry: RegistryEntry = { id, created: page.createdAt, order: page.order };
      if (page.favorite) entry.favorite = true;
      if (page.archivedAt !== null) entry.archived = page.archivedAt;
      if (page.hideTasks) entry.hideTasks = true;
      if (page.trashedAt !== null && isInTrash(placement.folder) && dirname(placement.folder) === TRASH_DIR) {
        entry.trashed = page.trashedAt;
        if (page.parentId) entry.parent = page.parentId;
      }
      if (page.icon && (page.kind === 'canvas' || placement.file === null)) entry.icon = page.icon;
      pages[placement.file ?? placement.folder] = entry;
      if (page.lastOpenedAt !== null) opened.push([id, page.lastOpenedAt]);
    }
    opened.sort((a, b) => b[1] - a[1]);
    const activity = Object.fromEntries(
      [...this.days].sort(([a], [b]) => b.localeCompare(a)).slice(0, MAX_ACTIVITY_DAYS),
    );
    return {
      workspace: `${JSON.stringify({ version: 1, pages }, null, 1)}\n`,
      recent: `${JSON.stringify({ version: 1, opened: Object.fromEntries(opened.slice(0, MAX_RECENT)), activity })}\n`,
    };
  }

  async readMeta(name: string): Promise<string | null> {
    if (!/^[\w-]+\.(json|css)$/.test(name)) return null;
    return this.bridge.readText(`${MORROW_DIR}/${name}`);
  }

  async writeMeta(name: string, text: string): Promise<void> {
    if (!/^[\w-]+\.(json|css)$/.test(name)) return;
    const [result] = await this.bridge.apply([{ op: 'write', path: `${MORROW_DIR}/${name}`, text }]);
    if (result && !result.ok) throw new Error(result.message);
  }

  activity(): Record<string, number> {
    return Object.fromEntries(this.days);
  }

  // ---- page history, one json file per page in .morrow/history

  private historyPath(pageId: PageId): string {
    return `${HISTORY_DIR}/${pageId}.json`;
  }

  private async historyOf(pageId: PageId): Promise<Snapshot[]> {
    const cached = this.history.get(pageId);
    if (cached) return cached;
    let list: Snapshot[];
    try {
      const text = await this.bridge.readText(this.historyPath(pageId));
      const raw: unknown = text ? JSON.parse(text) : null;
      const items =
        raw && typeof raw === 'object' && Array.isArray((raw as { snapshots?: unknown }).snapshots)
          ? (raw as { snapshots: unknown[] }).snapshots
          : [];
      list = items.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const snapshot = item as Partial<Snapshot>;
        const doc = validateDoc(snapshot.doc);
        if (typeof snapshot.id !== 'string' || typeof snapshot.createdAt !== 'number' || !doc.ok) return [];
        return [
          {
            id: snapshot.id,
            pageId,
            title: String(snapshot.title ?? ''),
            doc: doc.value,
            createdAt: snapshot.createdAt,
            ...(typeof snapshot.name === 'string' && snapshot.name
              ? { name: snapshot.name.slice(0, 200) }
              : {}),
            ...(isRecord(snapshot.properties)
              ? { properties: snapshot.properties as Record<string, PropValue> }
              : {}),
            ...(isRecord(snapshot.extra) ? { extra: snapshot.extra } : {}),
          },
        ];
      });
    } catch {
      list = [];
    }
    this.history.set(pageId, list);
    return list;
  }

  // the page is locked again, its key and plain text leave memory
  lockPage(id: PageId): void {
    this.keys.delete(id);
    this.plainTexts.delete(id);
    this.locked.add(id);
  }

  // a new password for a page, its next save is encrypted
  async protectPage(id: PageId, password: string): Promise<void> {
    this.keys.set(id, await newPageKey(password));
    this.history.set(id, []);
    this.historyCleared.delete(id);
  }

  unprotectPage(id: PageId): void {
    this.keys.delete(id);
    this.plainTexts.delete(id);
  }

  // decrypts a locked page and reads it as if it had just been loaded
  async unlockPage(
    id: PageId,
    password: string,
    state: WorkspaceState,
  ): Promise<Result<{ page: PageMeta; doc: DocNode }>> {
    const text = this.texts.get(id);
    const placement = this.layout.get(id);
    const base = state.pages[id];
    if (!text || !placement?.file || !base) return fail('This page is not on disk.');
    const opened = await decryptPage(text, password);
    if (!opened) return fail('That password is not right.');
    const read = this.readFile(placement.file, opened.plain, base, state, this.layout);
    if (!read.ok) {
      return fail(
        read.reason
          ? `This encrypted page is protected because Morrow cannot safely represent its content: ${read.reason}`
          : 'The page was decrypted but could not be read.',
      );
    }
    this.keys.set(id, opened.pageKey);
    this.plainTexts.set(id, opened.plain);
    if (read.source) this.sources.set(id, read.source);
    this.locked.delete(id);
    return ok({ page: { ...read.page, encrypted: true }, doc: read.doc });
  }

  // null when the page's newest version already holds exactly this
  private async historyOp(snapshot: Snapshot): Promise<VaultOp | null> {
    const existing = await this.historyOf(snapshot.pageId);
    const content = (item: Snapshot) =>
      JSON.stringify([item.title, item.doc, item.properties ?? {}, item.extra ?? {}]);
    const newest = existing.reduce<Snapshot | null>(
      (latest, item) => (!latest || item.createdAt > latest.createdAt ? item : latest),
      null,
    );
    if (newest && content(newest) === content(snapshot)) return null;
    const list = [...existing, snapshot];
    const prune = new Set(snapshotsToPrune(list));
    const kept = list.filter((item) => !prune.has(item.id)).sort((a, b) => a.createdAt - b.createdAt);
    return this.writeHistory(snapshot.pageId, kept);
  }

  private writeHistory(pageId: PageId, kept: Snapshot[]): VaultOp {
    this.history.set(pageId, kept);
    const text = JSON.stringify({ version: 1, snapshots: kept.map(({ pageId: _pageId, ...rest }) => rest) });
    return { op: 'write', path: this.historyPath(pageId), text };
  }

  async changeSnapshot(pageId: PageId, id: string, change: { name: string } | null): Promise<void> {
    const existing = await this.historyOf(pageId);
    if (!existing.some((item) => item.id === id)) return;
    const kept = existing.flatMap((item) => {
      if (item.id !== id) return [item];
      if (!change) return [];
      const { name: _old, ...rest } = item;
      return [change.name.trim() ? { ...rest, name: change.name.trim().slice(0, 200) } : rest];
    });
    const [result] = await this.bridge.apply([this.writeHistory(pageId, kept)]);
    if (result && !result.ok) throw new Error(result.message);
  }

  private async keepDiskVersion(pageId: PageId, text: string): Promise<void> {
    // a version of an encrypted page is never kept as plain text
    if (isEncryptedText(text) || this.lastState?.pages[pageId]?.encrypted) return;
    const page = this.lastState?.pages[pageId];
    const doc = page?.kind === 'canvas' ? safeCanvas(text) : markdownToDoc(readPageText(text).body);
    if (!doc) return;
    const snapshot: Snapshot = {
      id: this.newId(),
      pageId,
      title: page?.title ?? '',
      doc,
      createdAt: Date.now(),
    };
    const op = await this.historyOp(snapshot);
    if (op) await this.bridge.apply([op]);
  }

  async listSnapshots(pageId: PageId): Promise<Snapshot[]> {
    return [...(await this.historyOf(pageId))].sort((a, b) => b.createdAt - a.createdAt);
  }

  async allSnapshots(): Promise<Snapshot[]> {
    const files = await this.bridge.listFiles(HISTORY_DIR).catch(() => []);
    const all: Snapshot[] = [];
    for (const file of files) {
      const id = basename(stripExtension(file.path));
      all.push(...(await this.historyOf(id)));
    }
    return all;
  }

  // ---- images and files, stored in the attachments folder and referenced by their path

  async putFiles(files: StoredFile[]): Promise<FileMeta[]> {
    const metas: FileMeta[] = [];
    for (const file of files) {
      const dot = file.meta.name.lastIndexOf('.');
      const ext =
        dot > 0
          ? file.meta.name
              .slice(dot)
              .replace(/[^.A-Za-z0-9]/g, '')
              .slice(0, 10)
              .toLowerCase()
          : '';
      const base = safeFileName(dot > 0 ? file.meta.name.slice(0, dot) : file.meta.name, 80);
      let path = joinPath(ATTACHMENTS_DIR, `${base}${ext}`);
      for (let n = 2; this.others.has(path) || (await this.bridge.exists(path)); n++) {
        path = joinPath(ATTACHMENTS_DIR, `${base} ${n}${ext}`);
      }
      await this.bridge.createFile(path, file.data);
      this.others.add(path);
      metas.push({ ...file.meta, id: path, name: basename(path) });
    }
    return metas;
  }

  async getFile(id: FileId): Promise<StoredFile | null> {
    const data = await this.bridge.readBytes(id);
    if (!data) return null;
    return { meta: { id, name: basename(id), type: mimeOf(id), size: data.byteLength, createdAt: 0 }, data };
  }

  fileUrl(id: FileId): string | null {
    return this.bridge.fileUrl(id);
  }

  async listFiles(): Promise<FileMeta[]> {
    const files = await this.bridge.listFiles(ATTACHMENTS_DIR).catch(() => []);
    return files.map((file) => ({
      id: file.path,
      name: basename(file.path),
      type: mimeOf(file.path),
      size: file.size,
      createdAt: file.mtime,
    }));
  }

  async deleteFiles(ids: FileId[]): Promise<void> {
    if (ids.length > 0 && this.locked.size > 0) {
      const id = this.locked.values().next().value as PageId;
      throw new Error(
        `Files could not be deleted because a protected page may reference them: ${this.protectionMessage(id)}`,
      );
    }
    const results = await this.bridge.apply(ids.map((path) => ({ op: 'remove', path })));
    for (const id of ids) this.others.delete(id);
    const failed = results.find((result) => !result.ok);
    if (failed && !failed.ok) throw new Error(failed.message);
  }

  close(): void {
    this.stopWatching?.();
    this.stopWatching = null;
  }

  onExternalChange(listener: (patch: ExternalPatch) => PageId[]): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- edits made by other apps, sync tools or git

  private onChanges(changes: VaultChange[]): void {
    if (this.saving > 0) {
      this.held.push(...changes);
      return;
    }
    const state = this.currentState() ?? this.lastState;
    if (!state || this.listeners.size === 0) return;
    const result = this.readChanges(changes, state);
    if (!result) return;
    let accepted: PageId[] = [];
    for (const listener of this.listeners) accepted = listener(result.patch);
    result.commit(new Set(accepted));
  }

  readChanges(
    changes: VaultChange[],
    state: WorkspaceState,
  ): { patch: ExternalPatch; commit: (accepted: Set<PageId>) => void } | null {
    const latest = new Map<string, VaultChange>();
    for (const change of changes) {
      if (isHiddenPath(change.path)) continue;
      latest.set(change.path, change);
    }
    for (const change of latest.values()) {
      if (!change.other) continue;
      if (change.text === null) this.others.delete(change.path);
      else this.others.add(change.path);
    }
    // a path that disappeared may have been a folder of pages
    const pageChanges = [...latest.values()].filter(
      (change) => (change.dir && change.text === null) || (!change.other && isPageFile(change.path)),
    );
    if (pageChanges.length === 0) return null;

    const byFile = new Map<string, PageId>();
    for (const [id, placement] of this.layout)
      if (placement.file) byFile.set(placement.file.toLowerCase(), id);
    const layout = new Map(this.layout);
    const pages = new Map<PageId, PageMeta>();
    const docs: Record<PageId, DocNode> = {};
    const removed = new Set<PageId>();
    const unreadable = new Set<PageId>();
    const readable = new Set<PageId>();
    const protectedPages = new Map<PageId, string>();
    const clearProtected = new Set<PageId>();
    const protectedDatabases = new Set<PageId>();
    const recoveredDatabases = new Set<PageId>();
    const requiresAccepted = new Map<PageId, PageId[]>();
    const texts = new Map<PageId, string>();
    const sources = new Map<PageId, PageSource | null>();
    const becameFolders = new Set<PageId>();
    const pageOf = (id: PageId) => pages.get(id) ?? state.pages[id];

    // gone: a removed file whose text shows up at a new path is a rename and keeps its page
    const deleted = pageChanges.filter((change) => change.text === null);
    const written = pageChanges.filter((change) => change.text !== null && !change.dir);
    const moves = new Map<string, PageId>();
    for (const change of deleted) {
      const lower = change.path.toLowerCase();
      const inside = (path: string) => {
        const candidate = path.toLowerCase();
        return candidate === lower || candidate.startsWith(`${lower}/`);
      };
      // a page's note sits beside its subpage folder, so the folder going away only removes what was in it
      const ids = change.dir
        ? [...this.layout].filter(([, p]) => (p.file ? inside(p.file) : inside(p.folder))).map(([id]) => id)
        : [byFile.get(lower)].filter((id): id is PageId => id !== undefined);
      for (const id of ids) {
        const text = this.texts.get(id);
        const target =
          text !== undefined
            ? written.find(
                (candidate) =>
                  candidate.text === text &&
                  !byFile.has(candidate.path.toLowerCase()) &&
                  !moves.has(candidate.path),
              )
            : undefined;
        if (target) {
          moves.set(target.path, id);
          continue;
        }
        const hasChildren = childrenOf(state.pages, id, true).some((child) => !ids.includes(child.id));
        if (hasChildren && !change.dir) {
          becameFolders.add(id);
          layout.set(id, { file: null, folder: this.layout.get(id)!.folder });
          docs[id] = emptyDoc();
          pages.set(id, { ...state.pages[id]!, updatedAt: change.mtime || Date.now() });
          texts.delete(id);
        } else removed.add(id);
      }
    }

    const ownerOf = (folder: string): PageId | null => {
      const lower = folder.toLowerCase();
      for (const [id, placement] of layout)
        if (placement.folder.toLowerCase() === lower && !removed.has(id)) return id;
      return null;
    };
    const ensureFolder = (folder: string): PageId | null => {
      if (!folder || folder === TRASH_DIR) return null;
      const known = ownerOf(folder);
      if (known) return known;
      const parentId = ensureFolder(dirname(folder));
      const id = this.newId();
      const now = Date.now();
      pages.set(
        id,
        newPageMeta({
          id,
          parentId,
          title: basename(folder),
          createdAt: now,
          order: Number.MAX_SAFE_INTEGER,
        }),
      );
      docs[id] = emptyDoc();
      layout.set(id, { file: null, folder });
      becameFolders.add(id);
      return id;
    };

    for (const change of written) {
      const text = change.text!;
      const ours = this.wroteAt.get(change.path.toLowerCase());
      if (ours !== undefined && change.mtime > 0 && change.mtime < ours) continue;
      const known = byFile.get(change.path.toLowerCase()) ?? moves.get(change.path);
      if (known !== undefined && text === this.texts.get(known) && !moves.has(change.path)) continue;
      const folder = stripExtension(change.path);
      const parentFolder = dirname(folder);
      let id = known;
      if (id === undefined) {
        // a note appearing next to a folder page becomes that folder's note
        const folderPage = ownerOf(folder);
        id = folderPage && layout.get(folderPage)?.file === null ? folderPage : this.newId();
      }
      const current = pageOf(id);
      const wasStructurallyProtectedDatabase =
        this.locked.has(id) && hasUnrepresentableDatabaseSchema(this.texts.get(id) ?? '');
      const parentId = parentFolder === TRASH_DIR ? (current?.parentId ?? null) : ensureFolder(parentFolder);
      const base =
        current ??
        newPageMeta({
          id,
          parentId,
          createdAt: change.birthtime || Date.now(),
          order: Number.MAX_SAFE_INTEGER,
        });
      const page: PageMeta = { ...base, parentId, updatedAt: change.mtime || Date.now() };
      if (parentFolder === TRASH_DIR) page.trashedAt = page.trashedAt ?? Date.now();
      else if (dirname(this.layout.get(id)?.folder ?? '') === TRASH_DIR) page.trashedAt = null;
      layout.set(id, { file: change.path, folder });
      texts.set(id, text);
      const read = this.readFile(change.path, text, page, state, layout);
      if (read.ok) {
        pages.set(id, read.page);
        if (read.database && !pages.has(read.database.id)) pages.set(read.database.id, read.database);
        docs[id] = read.doc;
        sources.set(id, read.source);
        if (this.locked.has(id)) readable.add(id);
        if (wasStructurallyProtectedDatabase && read.page.kind === 'database' && read.page.database) {
          recoveredDatabases.add(id);
        }
      } else {
        pages.set(id, { ...page, encrypted: isEncryptedText(text) || page.encrypted });
        unreadable.add(id);
        if (read.reason) {
          protectedPages.set(id, read.reason);
          docs[id] = { type: 'doc', content: [{ type: 'rawBlock', attrs: { text } }] };
          if (hasUnrepresentableDatabaseSchema(text)) protectedDatabases.add(id);
        } else if (this.protectedReasons.has(id)) {
          clearProtected.add(id);
        }
      }
    }

    if (protectedDatabases.size > 0) {
      const allPages = new Map(
        [...Object.values(state.pages), ...pages.values()].map((page) => [page.id, page]),
      );
      for (const databaseId of protectedDatabases) {
        const reason = `The parent database is protected: ${protectedPages.get(databaseId)}`;
        for (const row of allPages.values()) {
          if (row.parentId !== databaseId || removed.has(row.id)) continue;
          requiresAccepted.set(row.id, [databaseId]);
          protectedPages.set(row.id, reason);
          unreadable.add(row.id);
          readable.delete(row.id);
          pages.set(row.id, row);
          const raw = texts.get(row.id) ?? this.texts.get(row.id);
          if (raw !== undefined)
            docs[row.id] = { type: 'doc', content: [{ type: 'rawBlock', attrs: { text: raw } }] };
        }
      }
    }

    if (recoveredDatabases.size > 0) {
      for (const databaseId of recoveredDatabases) {
        const mergedPages = { ...state.pages, ...Object.fromEntries(pages) };
        const readState: WorkspaceState = { ...state, pages: mergedPages };
        const rows = Object.values(mergedPages).filter(
          (page) => page.parentId === databaseId && !removed.has(page.id),
        );
        for (const row of rows) {
          if (row.parentId !== databaseId || removed.has(row.id)) continue;
          requiresAccepted.set(row.id, [databaseId]);
          const base = pages.get(row.id) ?? row;
          const placement = layout.get(row.id);
          const text = texts.get(row.id) ?? this.texts.get(row.id);
          if (!placement?.file || text === undefined) {
            pages.set(row.id, base);
            if (this.locked.has(row.id)) {
              unreadable.delete(row.id);
              readable.add(row.id);
              clearProtected.add(row.id);
            }
            continue;
          }

          const wasUnreadable = this.locked.has(row.id) || unreadable.has(row.id);
          const read = this.readFile(placement.file, text, base, readState, layout);
          if (read.ok) {
            pages.set(row.id, read.page);
            mergedPages[row.id] = read.page;
            if (read.database) {
              pages.set(read.database.id, read.database);
              mergedPages[read.database.id] = read.database;
            }
            docs[row.id] = read.doc;
            sources.set(row.id, read.source);
            unreadable.delete(row.id);
            protectedPages.delete(row.id);
            clearProtected.delete(row.id);
            if (wasUnreadable) readable.add(row.id);
          } else {
            const unreadablePage = { ...base, encrypted: isEncryptedText(text) || base.encrypted };
            pages.set(row.id, unreadablePage);
            mergedPages[row.id] = unreadablePage;
            unreadable.add(row.id);
            readable.delete(row.id);
            if (read.reason) {
              protectedPages.set(row.id, read.reason);
              clearProtected.delete(row.id);
              docs[row.id] = { type: 'doc', content: [{ type: 'rawBlock', attrs: { text } }] };
            } else {
              protectedPages.delete(row.id);
              if (this.protectedReasons.has(row.id) || clearProtected.has(row.id)) clearProtected.add(row.id);
            }
          }
        }
      }
    }

    if (pages.size === 0 && removed.size === 0) return null;
    const patch: ExternalPatch = {
      pages: [...pages.values()],
      docs,
      removed: [...removed],
      unreadable: [...unreadable],
      readable: [...readable],
      ...(protectedPages.size > 0 ? { protectedPages: Object.fromEntries(protectedPages) } : {}),
      ...(clearProtected.size > 0 ? { clearProtected: [...clearProtected] } : {}),
      ...(requiresAccepted.size > 0 ? { requiresAccepted: Object.fromEntries(requiresAccepted) } : {}),
    };
    return {
      patch,
      commit: (accepted) => {
        for (const id of accepted) {
          if (removed.has(id)) {
            this.layout.delete(id);
            this.texts.delete(id);
            this.sources.delete(id);
            this.folderOnly.delete(id);
            this.locked.delete(id);
            continue;
          }
          const placement = layout.get(id);
          if (placement) this.layout.set(id, placement);
          if (becameFolders.has(id)) this.folderOnly.add(id);
          else this.folderOnly.delete(id);
          if (texts.has(id)) this.texts.set(id, texts.get(id)!);
          else if (becameFolders.has(id)) this.texts.delete(id);
          const source = sources.get(id);
          if (sources.has(id)) {
            if (source) this.sources.set(id, source);
            else this.sources.delete(id);
          }
          if (clearProtected.has(id)) this.protectedReasons.delete(id);
          if (unreadable.has(id)) this.locked.add(id);
          if (protectedPages.has(id)) this.protectedReasons.set(id, protectedPages.get(id)!);
          if (readable.has(id)) {
            this.locked.delete(id);
            this.protectedReasons.delete(id);
          }
        }
        this.lastState = this.currentState() ?? this.lastState;
        // registry ids for new pages are written with the next save
        if (patch.pages.some((page) => !this.registryHas(page.id))) this.registryDirty = true;
      },
    };
  }

  private registryHas(id: PageId): boolean {
    if (!this.registryText) return false;
    try {
      return [...readRegistry(JSON.parse(this.registryText)).values()].some((entry) => entry.id === id);
    } catch {
      return false;
    }
  }

  private readFile(
    path: string,
    text: string,
    base: PageMeta,
    state: WorkspaceState,
    layout: Map<PageId, Placement>,
    newOptionId?: () => string,
    navigationContext?: NavigationReadContext,
  ):
    | { ok: true; page: PageMeta; doc: DocNode; source: PageSource | null; database?: PageMeta }
    | { ok: false; reason?: string } {
    if (text.length > MAX_PAGE_BYTES || isEncryptedText(text)) return { ok: false };
    const folder = stripExtension(path);
    const name = basename(folder);
    const parent = base.parentId ? state.pages[base.parentId] : undefined;
    const dailyDate = parent?.kind === 'journal' && DATE_NAME.test(name) ? name : null;
    const context =
      navigationContext?.state === state &&
      navigationContext.layout === layout &&
      navigationContext.sources === this.sources &&
      navigationContext.others === this.others &&
      state.pages[base.id] === base
        ? navigationContext
        : undefined;
    const merged = context ? state : { ...state, pages: { ...state.pages, [base.id]: base } };
    const resolver = context?.resolver ?? makeResolver(merged, layout, this.sources);
    if (extension(path) === 'canvas') {
      try {
        const data = readCanvas(JSON.parse(text || '{}'), (target) =>
          resolver.byPath(stripExtension(target)),
        );
        if (!data) return { ok: false };
        return {
          ok: true,
          page: { ...base, kind: 'canvas', title: name },
          doc: canvasDoc(data),
          source: null,
        };
      } catch {
        return { ok: false };
      }
    }
    const protectionReason = findUnrepresentablePageContent(text);
    if (protectionReason) return { ok: false, reason: protectionReason };
    const read = readPageText(text);
    if (read.error) return { ok: false };
    const page: PageMeta = {
      ...base,
      title: read.title ?? impliedTitle(name, dailyDate),
      icon: read.icon,
      cover: read.cover,
      kind: read.kind ?? 'page',
      tags: read.tags,
      database: read.database,
      dailyDate,
      properties: {},
      extra: read.extra,
    };
    // select values the database has not seen become options of a copy, the state itself is never changed here
    let database: PageMeta | undefined;
    if (parent?.kind === 'database' && parent.database) {
      const copy = structuredClone(parent.database);
      takeProperties(
        copy,
        page.extra,
        page.properties,
        newOptionId ?? this.newId,
        Object.hasOwn(parent.extra, 'polarisDados'),
      );
      const added = copy.properties.some(
        (prop, i) => prop.options.length !== parent.database!.properties[i]!.options.length,
      );
      if (added) database = { ...parent, database: copy };
    }
    const index =
      context?.otherIndex ?? new Map([...this.others].map((other) => [other.toLowerCase(), other]));
    const names = context?.otherNames ?? new Map<string, string[]>();
    if (!context) {
      for (const other of this.others)
        names.set(basename(other).toLowerCase(), [
          ...(names.get(basename(other).toLowerCase()) ?? []),
          other,
        ]);
    }
    const dir = dirname(path);
    const doc = markdownToDoc(
      read.body,
      parseOptions(dir, resolver, (href) => resolveFile(dir, href, index, names)),
    );
    const valid = validateDoc(doc);
    if (!valid.ok) return { ok: false };
    return { ok: true, page, doc: valid.value, source: read.source, ...(database ? { database } : {}) };
  }
}

function hasLinkedViewNode(doc: DocNode | undefined): boolean {
  if (!doc) return false;
  let found = false;
  walk(doc, (node) => {
    if (node.type === 'polarisDadosView') found = true;
    return !found;
  });
  return found;
}

function linksTo(doc: DocNode, ids: Set<PageId>): boolean {
  if (ids.size === 0) return false;
  let found = false;
  walk(doc, (node) => {
    if (found) return false;
    if (node.type === 'pageLink' && typeof node.attrs?.id === 'string' && ids.has(node.attrs.id))
      found = true;
    if (node.type === 'canvas' && Array.isArray(node.attrs?.nodes)) {
      for (const item of node.attrs.nodes as Array<{ type?: string; pageId?: string }>) {
        if (item.type === 'page' && item.pageId && ids.has(item.pageId)) found = true;
      }
    }
    return !found;
  });
  return found;
}

function hasFileRefs(doc: DocNode): boolean {
  let found = false;
  walk(doc, (node) => {
    if ((node.type === 'image' && typeof node.attrs?.fileId === 'string') || node.type === 'fileAttachment')
      found = true;
    return !found;
  });
  return found;
}

function linksToMarkdownPage(doc: DocNode | undefined, ids: Set<PageId>): boolean {
  if (!doc || ids.size === 0) return false;
  let found = false;
  walk(doc, (node) => {
    if (
      node.type === 'pageLink' &&
      typeof node.attrs?.id === 'string' &&
      typeof node.attrs?.markdownHref === 'string' &&
      ids.has(node.attrs.id)
    ) {
      found = true;
    }
    return !found;
  });
  return found;
}

function hasMarkdownPageLink(doc: DocNode | undefined): boolean {
  if (!doc) return false;
  let found = false;
  walk(doc, (node) => {
    if (node.type === 'pageLink' && typeof node.attrs?.markdownHref === 'string') found = true;
    return !found;
  });
  return found;
}

function markdownPageTargetPath(
  id: PageId,
  href: string,
  sourceDir: string,
  layout: Map<PageId, Placement>,
  resolver: Resolver,
): string | null {
  const destination = markdownHrefPath(href);
  if (!destination || !/\.(md|canvas)$/i.test(destination.path)) return null;
  const target = layout.get(id);
  if (!target?.file || isInTrash(target.folder)) return null;
  if (resolveMarkdownPageLink(href, sourceDir, resolver) === id) return null;

  const currentPath = destination.path.startsWith('/')
    ? destination.path.slice(1)
    : resolveRelative(sourceDir, destination.path);
  if (currentPath === target.file) return null;
  return destination.path.startsWith('/') ? `/${target.file}` : relativePath(sourceDir, target.file);
}

// rewrites only source ranges emitted by Morrow's configured Markdown parser
export function retargetLinks(
  body: string,
  newWikiTarget: (target: string) => string | null,
  newMarkdownTarget?: (href: string) => string | null,
): string {
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const span of markdownRetargetSpans(body)) {
    if (span.kind === 'wiki') {
      const bang = span.raw.startsWith('!') ? '!' : '';
      const inner = span.raw.slice(bang.length + 2, -2);
      const originalTarget = span.target ?? parseWikiLink(inner, bang === '!').target;
      const target = newWikiTarget(originalTarget);
      if (!target || target === originalTarget) continue;
      if (span.targetStart !== undefined && span.targetEnd !== undefined) {
        edits.push({ start: span.targetStart, end: span.targetEnd, text: target });
        continue;
      }
      const rest = inner.slice(inner.indexOf(originalTarget) + originalTarget.length);
      edits.push({ start: span.start, end: span.end, text: bang + '[[' + target + rest + ']]' });
      continue;
    }

    const targetPath = newMarkdownTarget?.(span.raw);
    if (!targetPath) continue;
    const href = retargetMarkdownHref(span.raw, targetPath);
    if (href !== span.raw) edits.push({ start: span.start, end: span.end, text: href });
  }

  edits.sort((left, right) => right.start - left.start);
  let result = body;
  let nextStart = body.length + 1;
  for (const edit of edits) {
    if (edit.end > nextStart) continue;
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    nextStart = edit.start;
  }
  return result;
}

function safeCanvas(text: string): DocNode | null {
  try {
    const data = readCanvas(JSON.parse(text), () => null);
    return data ? canvasDoc(data) : null;
  } catch {
    return null;
  }
}

function isOptedInDatabase(page: PageMeta | undefined): page is PageMeta {
  return page?.kind === 'database' && Object.hasOwn(page.extra, 'polarisDados');
}

function samePersistiblePageContent(current: PageMeta, parsed: PageMeta): boolean {
  const projection = (page: PageMeta) => ({
    title: page.title,
    icon: page.icon,
    cover: page.cover,
    kind: page.kind,
    tags: page.tags,
    extra: page.extra,
    database: page.database,
    properties: page.properties,
  });
  return sameValue(projection(current), projection(parsed));
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};

export function mimeOf(path: string): string {
  return MIME[extension(path)] ?? (isImagePath(path) ? 'image/*' : 'application/octet-stream');
}
