// stores the workspace as a folder of markdown files, one file per page with metadata in frontmatter
import { canvasDoc, canvasFromDoc, readCanvas, writeCanvas } from '../core/canvas';
import { decryptPage, encryptPage, isEncryptedText, newPageKey } from '../core/crypto';
import type { PageKey } from '../core/crypto';
import { isDocEmpty, isRecord, validateDoc, walk } from '../core/doc';
import { snapshotsToPrune } from '../core/history';
import { parseWikiLink } from '../core/markdown/parse';
import { docToMarkdown, retargetMarkdownHref } from '../core/markdown/serialize';
import { markdownToDoc } from '../core/markdown/parse';
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
import { linkTargets, placePages } from '../core/vault/layout';
import type { Placement } from '../core/vault/layout';
import { createFileCatalog } from '../core/vault/fileCatalog';
import type { FileCatalogSnapshot, VaultResource } from '../core/vault/fileCatalog';
import {
  loadVault,
  makeResolver,
  MAX_PAGE_BYTES,
  parseOptions,
  readRegistry,
  resolveFile,
} from '../core/vault/load';
import type { LoadedVault, RegistryEntry, Resolver } from '../core/vault/load';
import {
  composeFrontmatter,
  impliedTitle,
  managedFrontmatter,
  readPageText,
  takeProperties,
  renderPageText,
} from '../core/vault/pageFile';
import type { PageSource } from '../core/vault/pageFile';
import { splitFrontmatter } from '../core/vault/frontmatter';
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
  safeFileName,
  stripExtension,
  TRASH_DIR,
} from '../core/vault/paths';
import { planMoves, replayRename } from '../core/vault/plan';
import type { VaultOp, VaultOpResult } from '../core/vault/plan';
import type { LoadedWorkspace } from '../core/migrations';
import type { ExternalPatch, StoredFile, WorkspaceRepository, WriteBatch } from './repository';
import type { VaultBridge, VaultChange } from './vaultBridge';

export const REGISTRY_PATH = `${MORROW_DIR}/workspace.json`;
export const RECENT_PATH = `${MORROW_DIR}/recent.json`;
const HISTORY_DIR = `${MORROW_DIR}/history`;
const MAX_RECENT = 300;
const MAX_ACTIVITY_DAYS = 400;

function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
const DATE_NAME = /^\d{4}-\d{2}-\d{2}$/;
const WIKI_LINK = /(!?)\[\[([^[\]\n]{0,400}?)\]\]/g;

function persistedMetadata(page: PageMeta): string {
  // Opening a page is tracked in recent.json, not in its Markdown file.
  return JSON.stringify({ ...page, lastOpenedAt: null });
}

export class VaultRepository implements WorkspaceRepository {
  private layout = new Map<PageId, Placement>();
  private folderOnly = new Set<PageId>();
  private sources = new Map<PageId, PageSource>();
  // what each page file holds on disk, as far as morrow knows
  private texts = new Map<PageId, string>();
  private reserved = new Set<string>();
  // pages that could not be read, their files are never rewritten
  private locked = new Set<PageId>();
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
  // metadata confirmed by a loaded source, accepted external change, or successful write
  private readonly persistedMetadataByPage = new Map<PageId, string>();
  private registryDirty = false;
  private readonly history = new Map<PageId, Snapshot[]>();
  private readonly listeners = new Set<(patch: ExternalPatch) => PageId[]>();
  private readonly fileCatalogListeners = new Set<() => void>();
  private resources = new Map<string, VaultResource>();
  private fileCatalog: FileCatalogSnapshot = createFileCatalog([]);
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

  getFileCatalog = (): FileCatalogSnapshot => this.fileCatalog;

  onFileCatalogChange = (listener: () => void): (() => void) => {
    this.fileCatalogListeners.add(listener);
    return () => this.fileCatalogListeners.delete(listener);
  };

  private catalogPathKey(path: string): string {
    return /^(?:[a-z]:\\|\\\\)/i.test(this.bridge.root) ? path.toLowerCase() : path;
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
      const scan = await this.bridge.scan();
      const loaded = loadVault(scan, this.newId);
      this.adopt(loaded);
      this.persistedMetadataByPage.clear();
      for (const page of loaded.pages) this.persistedMetadataByPage.set(page.id, persistedMetadata(page));
      this.others = new Set(scan.others);
      this.replaceFileCatalogResources(
        scan.resources ??
          scan.others
            .filter((path) => !isPageFile(path))
            .map((path) => ({ path, extension: extension(path), size: null, mtime: 0 })),
        false,
      );
      this.registryText = scan.registry === null ? null : JSON.stringify(scan.registry);
      this.recentText = scan.recent === null ? null : JSON.stringify(scan.recent);
      const activity = (scan.recent as { activity?: unknown } | null)?.activity;
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
        scan.registry === null &&
        scan.folders.every((folder) => isHiddenPath(folder.path) || folder.path === TRASH_DIR);
      return ok({
        pages: loaded.pages,
        docs: loaded.docs,
        problems: loaded.problems,
        unreadable: loaded.unreadable,
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
  }

  async markInitialized(): Promise<void> {
    if (!this.registryDirty || !this.lastState) return;
    await this.write({ pages: [], docs: [], removed: [], state: this.lastState });
  }

  async write(batch: WriteBatch): Promise<void> {
    const state = batch.state ?? this.lastState;
    if (!state) throw new Error('Nothing to write yet.');
    this.lastState = state;
    const docChanged = new Set(batch.docs.map((record) => record.id));
    const metaChanged = new Set(batch.pages.map((page) => page.id));
    const fileMetadataChanged = new Set(
      [...metaChanged].filter((id) => {
        const page = state.pages[id];
        return !page || this.persistedMetadataByPage.get(id) !== persistedMetadata(page);
      }),
    );
    const removed = new Set(batch.removed.filter((id) => !state.pages[id]));

    // a folder that gains content or properties gets a note of its own
    for (const id of [...docChanged, ...fileMetadataChanged]) {
      if (this.folderOnly.has(id) && this.wantsFile(state, id)) this.folderOnly.delete(id);
    }

    const previous = new Map([...this.layout].filter(([id]) => !removed.has(id)));
    const next = placePages(state, previous, this.folderOnly, this.reserved);
    const ops: VaultOp[] = [];

    for (const id of removed) {
      const before = this.layout.get(id);
      if (before?.file) ops.push({ op: 'remove', path: before.file });
    }
    ops.push(...planMoves(previous, next));
    // Keep IDs stable if a later page write only partially succeeds. The registry
    // can safely refer to files that have not been created yet; loadVault only
    // uses entries for paths that actually exist.
    const afterPathOps = ops.length;

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

    const candidates = new Set<PageId>([...docChanged, ...fileMetadataChanged]);
    for (const [id, placement] of next)
      if (!previous.has(id) || movedPages.has(id) || (placement.file && !this.texts.has(id)))
        candidates.add(id);
    if (retargeted.size > 0 || movedPages.size > 0) {
      for (const [id, doc] of Object.entries(state.docs)) {
        if (linksTo(doc, retargeted) || linksTo(doc, movedPages)) candidates.add(id);
      }
    }
    for (const id of fileMetadataChanged) {
      if (state.pages[id]?.kind === 'database')
        for (const child of childrenOf(state.pages, id, true)) candidates.add(child.id);
    }

    const resolveOld = retargeted.size > 0 || movedPages.size > 0 ? makeResolver(state, previous, this.sources) : null;
    for (const id of candidates) {
      const placement = next.get(id);
      if (!state.pages[id] || !placement?.file || this.locked.has(id)) continue;
      const text = this.render(
        state,
        next,
        newTargets,
        id,
        docChanged.has(id),
        previous.get(id),
        resolveOld,
        retargeted,
        movedPages,
      );
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
      ops.push({
        op: 'write',
        path: placement.file,
        text: written,
        expect: this.texts.has(id) ? this.texts.get(id)! : null,
        id,
      });
    }
    // turning encryption on removes the plain versions kept in page history
    for (const id of fileMetadataChanged) {
      if (
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

    const edited = batch.docs.length;
    if (edited > 0) {
      const day = localDay(new Date());
      this.days.set(day, (this.days.get(day) ?? 0) + edited);
    }
    const registry = this.registryFor(state, next);
    if (registry.workspace !== this.registryText)
      ops.splice(afterPathOps, 0, { op: 'write', path: REGISTRY_PATH, text: registry.workspace });
    if (registry.recent !== this.recentText)
      ops.push({ op: 'write', path: RECENT_PATH, text: registry.recent });
    // the shell only removes empty folders, a folder page keeps its folder because the folder is the page
    const folderPages = new Set(
      [...next.values()].filter((p) => p.file === null).map((p) => p.folder.toLowerCase()),
    );
    for (const folder of [...emptied].sort((a, b) => b.length - a.length)) {
      if (!folderPages.has(folder.toLowerCase())) ops.push({ op: 'rmdir', path: folder });
    }

    await this.run(ops, next, () => {
      for (const id of metaChanged) {
        const page = state.pages[id];
        if (!page) this.persistedMetadataByPage.delete(id);
        else if (!this.locked.has(id) && (!page.encrypted || this.keys.has(id)))
          this.persistedMetadataByPage.set(id, persistedMetadata(page));
      }
      for (const id of removed) this.persistedMetadataByPage.delete(id);
    });
    this.registryText = registry.workspace;
    this.recentText = registry.recent;
    this.registryDirty = false;
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
      state,
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
    retargeted: Set<PageId>,
    movedPages: Set<PageId>,
  ): string | null {
    const page = state.pages[id]!;
    const placement = layout.get(id)!;
    if (page.kind === 'canvas') {
      const original = this.texts.get(id);
      const doc = state.docs[id] ?? emptyDoc();
      if (original !== undefined && !edited && !linksTo(doc, retargeted) && !linksTo(doc, movedPages))
        return original;
      return writeCanvas(canvasFromDoc(state.docs[id]), (pageId) => layout.get(pageId)?.file ?? null);
    }
    // a folder that just got a note of its own, for its tags, properties or kind, has no text yet
    const doc = state.docs[id] ?? emptyDoc();
    const dir = dirname(placement.file!);
    const sourceDir = before ? dirname(before.folder) : dir;
    let source = this.sources.get(id) ?? null;
    const movedDir = before !== undefined && dirname(before.folder) !== dirname(placement.folder);
    if (source && source.body !== null && (edited || (movedDir && hasFileRefs(doc)))) {
      source = { ...source, body: null };
      this.sources.set(id, source);
    }
    let body: string;
    if (source && source.body !== null) {
      body = resolveOld
        ? retargetLinks(
            source.body,
            (target) => {
              const found = resolveOld.resolve(target, sourceDir);
              return found && retargeted.has(found) ? (targets.get(found) ?? null) : null;
            },
            (href) => {
              if (isExternalMarkdownHref(href)) return null;
              const found = resolveOld.resolve(markdownLinkPath(href), sourceDir);
              if (!found) return null;
              const target = layout.get(found);
              if (!target || isInTrash(target.folder)) return null;
              const targetPath = target.file ?? target.folder;
              return href.startsWith('/') && !href.startsWith('//')
                ? `/${targetPath}`
                : relativePath(dir, targetPath);
            },
          )
        : source.body;
      if (body !== source.body) {
        source = { ...source, body };
        this.sources.set(id, source);
      }
    } else {
      body = docToMarkdown(doc, {
        linkTarget: (pageId) => targets.get(pageId) ?? null,
        markdownLinkTarget: (pageId, originalHref) => {
          if (isExternalMarkdownHref(originalHref)) return null;
          const target = layout.get(pageId);
          if (!target || isInTrash(target.folder)) return null;
          const targetPath = target.file ?? target.folder;
          return originalHref.startsWith('/') && !originalHref.startsWith('//')
            ? `/${targetPath}`
            : relativePath(dir, targetPath);
        },
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
      state,
    );
    const text = renderPageText(composeFrontmatter(managed, page.extra, source), source, body);
    // the next save starts from what this one wrote, so keys added in morrow keep their spelling and order
    if (source) {
      const written = splitFrontmatter(text);
      this.sources.set(id, {
        ...source,
        keyOrder: Object.keys(written.data ?? {}),
        rawData: written.data,
        rawHead: written.head,
        rawYaml: written.yaml,
      });
    }
    return text;
  }

  // carries out the operations and keeps track of what reached the disk, even when something fails halfway
  private async run(ops: VaultOp[], next: Map<PageId, Placement>, onCommitted: () => void): Promise<void> {
    const started = Date.now();
    for (const op of ops) if (op.op === 'write') this.wroteAt.set(op.path.toLowerCase(), started);
    this.saving++;
    try {
      await this.runOps(ops, next);
      // Commit our confirmed baseline before a held watcher event can advance it further.
      onCommitted();
    } finally {
      this.saving--;
      if (this.saving === 0 && this.held.length > 0) {
        const held = this.held;
        this.held = [];
        this.onChanges(held);
      }
    }
  }

  private async runOps(ops: VaultOp[], next: Map<PageId, Placement>): Promise<void> {
    let pending = ops;
    const layout = new Map(this.layout);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (pending.length === 0) break;
      const results: VaultOpResult[] = await this.bridge.apply(pending);
      let failedAt = -1;
      for (let i = 0; i < results.length; i++) {
        if (results[i]!.ok) this.applied(pending[i]!, layout, next);
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
      if (!failed.ok && failed.code === 'conflict' && op.op === 'write' && op.id) {
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

  private applied(op: VaultOp, layout: Map<PageId, Placement>, next: Map<PageId, Placement>): void {
    switch (op.op) {
      case 'write':
        if (op.id) {
          this.texts.set(op.id, op.text);
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
    if (!read.ok) return fail('The page was decrypted but could not be read.');
    const page = { ...read.page, encrypted: true };
    this.keys.set(id, opened.pageKey);
    this.plainTexts.set(id, opened.plain);
    this.persistedMetadataByPage.set(id, persistedMetadata(page));
    if (read.source) this.sources.set(id, read.source);
    this.locked.delete(id);
    return ok({ page, doc: read.doc });
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
    this.history.set(snapshot.pageId, kept);
    const text = JSON.stringify({ version: 1, snapshots: kept.map(({ pageId: _pageId, ...rest }) => rest) });
    return { op: 'write', path: this.historyPath(snapshot.pageId), text };
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
      this.updateFileCatalog([
        {
          path,
          text: '',
          mtime: Date.now(),
          birthtime: Date.now(),
          other: true,
          size: file.data.byteLength,
        },
      ]);
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
    const results = await this.bridge.apply(ids.map((path) => ({ op: 'remove', path })));
    const removed = ids.filter((_, index) => results[index]?.ok);
    for (const id of removed) this.others.delete(id);
    this.updateFileCatalog(
      removed.map((path) => ({ path, text: null, mtime: Date.now(), birthtime: 0, other: true })),
    );
    const failed = results.find((result) => !result.ok);
    if (failed && !failed.ok) throw new Error(failed.message);
  }

  close(): void {
    this.stopWatching?.();
    this.stopWatching = null;
    this.fileCatalogListeners.clear();
  }

  onExternalChange(listener: (patch: ExternalPatch) => PageId[]): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private replaceFileCatalogResources(resources: readonly VaultResource[], notify = true): void {
    this.resources = new Map(
      resources.map((resource) => [this.catalogPathKey(resource.path), { ...resource }]),
    );
    const next = createFileCatalog([...this.resources.values()]);
    const current = this.fileCatalog;
    const sameFiles =
      current.files.length === next.files.length &&
      current.files.every((file, index) => {
        const candidate = next.files[index];
        return (
          candidate?.path === file.path &&
          candidate.extension === file.extension &&
          candidate.size === file.size &&
          candidate.mtime === file.mtime
        );
      });
    const sameFolders =
      current.folders.length === next.folders.length &&
      current.folders.every((folder, index) => folder === next.folders[index]);
    if (sameFiles && sameFolders) return;
    this.fileCatalog = next;
    if (notify) for (const listener of this.fileCatalogListeners) listener();
  }

  private updateOtherFiles(changes: readonly VaultChange[]): void {
    for (const change of changes) {
      if (!change.other) continue;
      const key = this.catalogPathKey(change.path);
      if (change.text === null && change.dir) {
        const prefix = `${key}/`;
        for (const path of this.others)
          if (this.catalogPathKey(path) === key || this.catalogPathKey(path).startsWith(prefix))
            this.others.delete(path);
      } else if (change.text === null) {
        for (const path of this.others) if (this.catalogPathKey(path) === key) this.others.delete(path);
      } else if (!change.dir) {
        for (const path of this.others) if (this.catalogPathKey(path) === key) this.others.delete(path);
        this.others.add(change.path);
      }
    }
  }

  private updateFileCatalog(changes: readonly VaultChange[]): void {
    let changed = false;
    for (const change of changes) {
      if (!change.other) continue;
      const lower = this.catalogPathKey(change.path);
      if (change.text === null && change.dir) {
        for (const key of this.resources.keys())
          if (key === lower || key.startsWith(`${lower}/`)) {
            this.resources.delete(key);
            changed = true;
          }
      } else if (change.text === null) {
        changed = this.resources.delete(lower) || changed;
      } else if (!change.dir && !isPageFile(change.path)) {
        const size = typeof change.size === 'number' && Number.isFinite(change.size) ? change.size : null;
        const current = this.resources.get(lower);
        const next: VaultResource = {
          path: change.path,
          extension: extension(change.path),
          size,
          mtime: change.mtime || 0,
        };
        if (
          !current ||
          current.path !== next.path ||
          current.extension !== next.extension ||
          current.size !== next.size ||
          current.mtime !== next.mtime
        ) {
          this.resources.set(lower, next);
          changed = true;
        }
      }
    }
    if (changed) this.replaceFileCatalogResources([...this.resources.values()]);
  }

  // ---- edits made by other apps, sync tools or git

  private onChanges(changes: VaultChange[]): void {
    if (this.saving > 0) {
      this.held.push(...changes);
      return;
    }
    this.updateOtherFiles(changes);
    this.updateFileCatalog(changes);
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
    // a path that disappeared may have been a folder of pages
    const pageChanges = [...latest.values()].filter(
      (change) =>
        (change.dir && change.text === null) ||
        change.emptyFolder ||
        (!change.other && isPageFile(change.path)),
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

    for (const change of pageChanges.filter((item) => item.emptyFolder && item.text !== null)) {
      const folder = change.path;
      if (ownerOf(folder)) continue;
      const parentFolder = dirname(folder);
      const trashed = parentFolder === TRASH_DIR;
      const id = this.newId();
      const page = newPageMeta({
        id,
        parentId: trashed ? null : ensureFolder(parentFolder),
        title: basename(folder),
        createdAt: change.birthtime || change.mtime || Date.now(),
        order: Number.MAX_SAFE_INTEGER,
      });
      if (trashed) page.trashedAt = change.mtime || Date.now();
      pages.set(id, page);
      docs[id] = emptyDoc();
      layout.set(id, { file: null, folder });
      becameFolders.add(id);
    }

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
      } else {
        pages.set(id, { ...page, encrypted: isEncryptedText(text) || page.encrypted });
        unreadable.add(id);
      }
    }

    if (pages.size === 0 && removed.size === 0) return null;
    const patch: ExternalPatch = {
      pages: [...pages.values()],
      docs,
      removed: [...removed],
      unreadable: [...unreadable],
      readable: [...readable],
    };
    return {
      patch,
      commit: (accepted) => {
        for (const id of accepted) {
          if (removed.has(id)) {
            this.persistedMetadataByPage.delete(id);
            this.layout.delete(id);
            this.texts.delete(id);
            this.sources.delete(id);
            this.folderOnly.delete(id);
            this.locked.delete(id);
            continue;
          }
          const placement = layout.get(id);
          if (placement) this.layout.set(id, placement);
          const page = pages.get(id);
          if (page) this.persistedMetadataByPage.set(id, persistedMetadata(page));
          if (becameFolders.has(id)) this.folderOnly.add(id);
          else this.folderOnly.delete(id);
          if (texts.has(id)) this.texts.set(id, texts.get(id)!);
          else if (becameFolders.has(id)) this.texts.delete(id);
          const source = sources.get(id);
          if (source) this.sources.set(id, source);
          if (unreadable.has(id)) this.locked.add(id);
          if (readable.has(id)) this.locked.delete(id);
        }
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
  ):
    | { ok: true; page: PageMeta; doc: DocNode; source: PageSource | null; database?: PageMeta }
    | { ok: false } {
    if (text.length > MAX_PAGE_BYTES || isEncryptedText(text)) return { ok: false };
    const folder = stripExtension(path);
    const name = basename(folder);
    const parent = base.parentId ? state.pages[base.parentId] : undefined;
    const dailyDate = parent?.kind === 'journal' && DATE_NAME.test(name) ? name : null;
    const merged = { ...state, pages: { ...state.pages, [base.id]: base } };
    const resolver = makeResolver(merged, layout, this.sources);
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
    const read = readPageText(text);
    if (read.error) return { ok: false };
    const page: PageMeta = {
      ...base,
      title: read.title ?? impliedTitle(name, dailyDate),
      icon: read.icon,
      cover: read.cover,
      coverPosition: read.coverPosition,
      noteStyle: read.noteStyle,
      controls: read.controls,
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
      takeProperties(copy, page.extra, page.properties, this.newId);
      const added = copy.properties.some(
        (prop, i) => prop.options.length !== parent.database!.properties[i]!.options.length,
      );
      if (added) database = { ...parent, database: copy };
    }
    const index = new Map([...this.others].map((other) => [other.toLowerCase(), other]));
    const names = new Map<string, string[]>();
    for (const other of this.others)
      names.set(basename(other).toLowerCase(), [...(names.get(basename(other).toLowerCase()) ?? []), other]);
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

// rewrites page links in a file morrow has not otherwise touched, outside code
export function retargetLinks(
  body: string,
  newWikiTarget: (target: string) => string | null,
  newMarkdownTarget?: (href: string) => string | null,
): string {
  const rewrite = (text: string) => {
    const markdown = newMarkdownTarget ? retargetMarkdownPageLinks(text, newMarkdownTarget) : text;
    return mapOutsideCode(markdown, (plain) =>
      plain.replace(WIKI_LINK, (match, bang: string, inner: string) => {
        const link = parseWikiLink(inner, bang === '!');
        const target = newWikiTarget(link.target);
        if (!target || target === link.target) return match;
        const rest = inner.slice(inner.indexOf(link.target) + link.target.length);
        return `${bang}[[${target}${rest}]]`;
      }),
    );
  };

  const fences = markdownFenceRanges(body);
  if (fences.length === 0) return rewrite(body);
  let result = '';
  let sourceIndex = 0;
  for (const fence of fences) {
    if (fence.start > sourceIndex) result += rewrite(body.slice(sourceIndex, fence.start));
    result += body.slice(fence.start, fence.end);
    sourceIndex = fence.end;
  }
  return result + rewrite(body.slice(sourceIndex));
}

function markdownLinkPath(href: string): string {
  const path = href.split(/[?#]/, 1)[0]!;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function isExternalMarkdownHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
}

function retargetMarkdownPageLinks(
  text: string,
  newTarget: (href: string) => string | null,
): string {
  return mapOutsideCode(text, (plain) => retargetMarkdownPageLinksPlain(plain, newTarget));
}

const MAX_MARKDOWN_LABEL_DEPTH = 4096;
const MAX_MARKDOWN_CODE_RUNS = 10_000;

function retargetMarkdownPageLinksPlain(
  text: string,
  newTarget: (href: string) => string | null,
): string {
  let result = '';
  let sourceIndex = 0;
  const labels: Array<{ inImage: boolean }> = [];
  let scanBudget = text.length + 1024;
  let slashRun = 0;
  let previousEscaped = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    const escaped = slashRun % 2 === 1;
    if (char === '\\') {
      slashRun++;
      previousEscaped = escaped;
      continue;
    }
    slashRun = 0;

    if (char === '[' && !escaped) {
      if (labels.length >= MAX_MARKDOWN_LABEL_DEPTH) break;
      const parentImage = labels.at(-1)?.inImage ?? false;
      const image = text[index - 1] === '!' && !previousEscaped;
      labels.push({ inImage: parentImage || image });
    } else if (char === ']' && !escaped) {
      const label = labels.pop();
      if (label && !label.inImage && text[index + 1] === '(') {
        if (scanBudget <= 0) break;
        const scanned = markdownLinkDestination(text, index + 1, scanBudget);
        scanBudget -= scanned.scanned;
        const destination = scanned.destination;
        if (!destination) {
          if (scanBudget <= 0) break;
          previousEscaped = false;
          continue;
        }
        const href = text.slice(destination.start, destination.end);
        const target = newTarget(href);
        if (target) {
          const updated = retargetMarkdownHref(href, target);
          if (updated !== href) {
            result += text.slice(sourceIndex, destination.start) + updated;
            sourceIndex = destination.end;
          }
        }
        index = destination.close;
        previousEscaped = false;
        continue;
      }
    }
    previousEscaped = escaped;
  }
  return result + text.slice(sourceIndex);
}

function markdownLinkDestination(
  text: string,
  open: number,
  scanBudget: number,
): { destination: { start: number; end: number; close: number } | null; scanned: number } {
  let scanned = 0;
  const charge = () => {
    if (scanned >= scanBudget) return false;
    scanned++;
    return true;
  };
  const closeAfter = (start: number): number | null => {
    let index = start;
    while (/\s/.test(text[index] ?? '')) {
      if (!charge()) return null;
      index++;
    }
    if (!charge()) return null;
    if (text[index] === ')') return index;

    const quote = text[index];
    if (quote === '"' || quote === "'") {
      index++;
      while (index < text.length) {
        if (!charge()) return null;
        if (text[index] === quote) break;
        if (text[index] === '\\' && index + 1 < text.length) {
          index++;
          if (!charge()) return null;
        }
        index++;
      }
      if (text[index] !== quote) return null;
      index++;
    } else if (quote === '(') {
      let depth = 1;
      index++;
      while (index < text.length && depth > 0) {
        if (!charge()) return null;
        if (text[index] === '\\' && index + 1 < text.length) {
          index++;
          if (!charge()) return null;
        } else if (text[index] === '(') depth++;
        else if (text[index] === ')') depth--;
        index++;
      }
      if (depth !== 0) return null;
    } else return null;

    while (/\s/.test(text[index] ?? '')) {
      if (!charge()) return null;
      index++;
    }
    if (!charge() || text[index] !== ')') return null;
    return index;
  };

  let index = open + 1;
  while (/\s/.test(text[index] ?? '')) {
    if (!charge()) return { destination: null, scanned };
    index++;
  }
  if (index >= text.length || !charge()) return { destination: null, scanned };

  if (text[index] === '<') {
    const start = ++index;
    while (index < text.length) {
      if (!charge()) return { destination: null, scanned };
      if (text[index] === '\\' && index + 1 < text.length) {
        index++;
        if (!charge()) return { destination: null, scanned };
      } else if (text[index] === '>') break;
      else if (/\s/.test(text[index]!)) return { destination: null, scanned };
      index++;
    }
    if (text[index] !== '>') return { destination: null, scanned };
    const end = index;
    const close = closeAfter(index + 1);
    return {
      destination: close === null ? null : { start, end, close },
      scanned,
    };
  }

  const start = index;
  let depth = 0;
  while (index < text.length) {
    if (!charge()) return { destination: null, scanned };
    const char = text[index]!;
    if (char === '\\' && index + 1 < text.length) {
      index++;
      if (!charge()) return { destination: null, scanned };
    } else if (char === '(') depth++;
    else if (char === ')') {
      if (depth === 0)
        return { destination: { start, end: index, close: index }, scanned };
      depth--;
    } else if (/\s/.test(char) && depth === 0) {
      const close = closeAfter(index);
      return {
        destination: close === null ? null : { start, end: index, close },
        scanned,
      };
    }
    index++;
  }
  return { destination: null, scanned };
}

function mapOutsideCode(text: string, transform: (plain: string) => string): string {
  const closes = markdownCodeSpanCloses(text);
  if (!closes) return text;
  let result = '';
  let plainStart = 0;
  let slashRun = 0;
  for (let index = 0; index < text.length; ) {
    if (text[index] === '`') {
      let end = index + 1;
      while (text[end] === '`') end++;
      const length = end - index;
      const close = closes.get(index);
      if (close !== undefined && slashRun % 2 === 0) {
        const codeEnd = close + length;
        result += transform(text.slice(plainStart, index)) + text.slice(index, codeEnd);
        plainStart = codeEnd;
        index = codeEnd;
        slashRun = 0;
        continue;
      }
      index = end;
      slashRun = 0;
      continue;
    }
    slashRun = text[index] === '\\' ? slashRun + 1 : 0;
    index++;
  }
  return result + transform(text.slice(plainStart));
}

function markdownCodeSpanCloses(text: string): Map<number, number> | null {
  const closes = new Map<number, number>();
  const lastByLength = new Map<number, number>();
  let runCount = 0;
  for (let index = 0; index < text.length; ) {
    if (text[index] !== '`') {
      index++;
      continue;
    }
    const start = index;
    while (text[index] === '`') index++;
    if (++runCount > MAX_MARKDOWN_CODE_RUNS) return null;
    const length = index - start;
    const previous = lastByLength.get(length);
    if (previous !== undefined) closes.set(previous, start);
    lastByLength.set(length, start);
  }
  return closes;
}

function markdownFenceRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let open: { start: number; char: '`' | '~'; length: number } | null = null;
  for (let lineStart = 0; lineStart < text.length; ) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd).replace(/\r$/, '');
    const marker = markdownFenceMarker(line);
    const nextLine = newline === -1 ? text.length : newline + 1;
    if (!open && marker && !(marker.char === '`' && marker.rest.includes('`'))) {
      open = { start: lineStart, char: marker.char, length: marker.length };
    } else if (
      open &&
      marker?.char === open.char &&
      marker.length >= open.length &&
      marker.rest.trim() === ''
    ) {
      ranges.push({ start: open.start, end: nextLine });
      open = null;
    }
    if (newline === -1) break;
    lineStart = nextLine;
  }
  if (open) ranges.push({ start: open.start, end: text.length });
  return ranges;
}

function markdownFenceMarker(line: string): { char: '`' | '~'; length: number; rest: string } | null {
  let index = 0;
  while (line[index] === ' ' && index < 4) index++;
  if (index > 3 || (line[index] !== '`' && line[index] !== '~')) return null;
  const char = line[index] as '`' | '~';
  const start = index;
  while (line[index] === char) index++;
  const length = index - start;
  return length >= 3 ? { char, length, rest: line.slice(index) } : null;
}

function safeCanvas(text: string): DocNode | null {
  try {
    const data = readCanvas(JSON.parse(text), () => null);
    return data ? canvasDoc(data) : null;
  } catch {
    return null;
  }
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
