import { cloneDoc, fileIdsInDoc, isRecord } from './doc';
import { fileIdsInPageProperties, remapPagePropertyFiles, validPropertyFileId } from './propertyMedia';
import { encodeFileIcon, parsePageIcon } from './icons';
import {
  documentFormulaResult,
  formulaResult,
  formulaValueText,
  formatValue,
  rowsOf,
  valueOf,
  visibleRows,
} from './database';
import type { ViewDef } from './model';
import { normalizeDatabase } from './migrations';
import { parseRichCanvas, propertyMediaLabel, readAttachmentValue } from './propertyMedia';
import { docToMarkdown } from './markdown/serialize';
import { findDailyNote, findJournal } from './daily';
import { readImportedFile } from './importer';
import { refreshLinkLabels } from './links';
import { pageToMarkdown } from './markdown/serialize';
import type { SerializeOptions } from './markdown/serialize';
import { markdownTargetFromPaths } from './vault/markdownLinks';
import { displayTitle, newPageMeta, PROP_TYPES, SCHEMA_VERSION } from './model';
import type {
  DocNode,
  FileId,
  FileMeta,
  FormulaReferenceBinding,
  PageId,
  PageMeta,
  WorkspaceState,
} from './model';
import type { PropDef, PropType, PropertyFormat } from './model';
import { readWorkspace } from './migrations';
import { errorMessage, fail, ok } from './result';
import type { Result } from './result';
import { pageIdByTitle } from './search';
import { childrenOf, livePages } from './tree';
import { composeFrontmatter, managedFrontmatter, readPageText } from './vault/pageFile';
import { joinFrontmatter } from './vault/frontmatter';

export const BACKUP_FORMAT = 'morrow-backup';

export interface BackupFile extends FileMeta {
  // base64 encoded bytes
  data: string;
}

export interface Backup {
  format: typeof BACKUP_FORMAT;
  schemaVersion: number;
  exportedAt: string;
  pages: PageMeta[];
  docs: Record<PageId, DocNode>;
  files: BackupFile[];
}

export interface ParsedBackup {
  pages: PageMeta[];
  docs: Record<PageId, DocNode>;
  files: BackupFile[];
  problems: string[];
}

export interface InsertPlan {
  pages: PageMeta[];
  docs: Record<PageId, DocNode>;
  skipped: number;
  problems: string[];
}

export function createBackup(state: WorkspaceState, now: Date, files: BackupFile[] = []): Backup {
  return {
    format: BACKUP_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    // encrypted pages are left out, their encrypted files in the vault are their backup
    pages: Object.values(state.pages).filter((page) => !page.encrypted),
    docs: Object.fromEntries(Object.entries(state.docs).filter(([id]) => !state.pages[id]?.encrypted)),
    files,
  };
}

// every file referenced by any page, including pages in the trash
export function referencedFileIds(state: WorkspaceState): Set<FileId> {
  const ids = new Set<FileId>();
  for (const doc of Object.values(state.docs)) for (const id of fileIdsInDoc(doc)) ids.add(id);
  for (const page of Object.values(state.pages)) {
    if (page.cover && !page.cover.startsWith('gradient-')) ids.add(page.cover);
    const icon = parsePageIcon(page.icon);
    if (icon?.kind === 'file') ids.add(icon.id);
    for (const id of fileIdsInPageProperties(page, state.pages)) ids.add(id);
  }
  return ids;
}

// Restored files may be assigned new vault paths when their original paths are occupied.
export function remapPageMediaFiles(
  pages: PageMeta[],
  existing: Readonly<Record<PageId, PageMeta>>,
  ids: ReadonlyMap<string, string>,
): PageMeta[] {
  if (ids.size === 0) return pages;
  const known = { ...existing, ...Object.fromEntries(pages.map((page) => [page.id, page])) };
  return pages.map((page) => {
    let remapped = page;
    if (page.cover && !page.cover.startsWith('gradient-')) {
      const cover = ids.get(page.cover);
      if (cover) remapped = { ...remapped, cover };
    }
    const icon = parsePageIcon(page.icon);
    if (icon?.kind === 'file') {
      const id = ids.get(icon.id);
      if (id) {
        const value = encodeFileIcon(id, icon.color);
        if (value) remapped = { ...remapped, icon: value };
      }
    }
    const database = page.parentId ? known[page.parentId]?.database : page.database;
    return remapPagePropertyFiles(remapped, database, ids);
  });
}

export function parseBackup(text: string): Result<ParsedBackup> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return fail(`This file is not valid JSON (${errorMessage(error)}).`);
  }
  if (!isRecord(data) || data.format !== BACKUP_FORMAT) return fail('This file is not a Morrow backup.');
  if (!Array.isArray(data.pages) || !isRecord(data.docs)) return fail('The backup is incomplete.');
  const loaded = readWorkspace(Number(data.schemaVersion), { pages: data.pages, docs: data.docs });
  if (!loaded.ok) return loaded;
  const files: BackupFile[] = [];
  const problems = [...loaded.value.problems];
  for (const raw of Array.isArray(data.files) ? data.files : []) {
    const file = readBackupFile(raw);
    if (file) files.push(file);
    else problems.push('An attachment in the backup could not be read and was skipped.');
  }
  return ok({ pages: loaded.value.pages, docs: loaded.value.docs, files, problems });
}

function readBackupFile(raw: unknown): BackupFile | null {
  if (!isRecord(raw) || !validPropertyFileId(raw.id)) return null;
  if (typeof raw.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw.data)) return null;
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name ? raw.name.slice(0, 255) : 'file',
    type: typeof raw.type === 'string' ? raw.type.slice(0, 120) : 'application/octet-stream',
    size: typeof raw.size === 'number' && Number.isFinite(raw.size) ? raw.size : 0,
    createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
    data: raw.data,
  };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// restoring only ever adds pages, conflicting ids get fresh ids and identical pages are skipped
export function planRestore(state: WorkspaceState, backup: ParsedBackup, newId: () => PageId): InsertPlan {
  const remap = new Map<PageId, PageId>();
  const skip = new Set<PageId>();
  for (const page of backup.pages) {
    const existing = state.pages[page.id];
    if (!existing) continue;
    if (existing.updatedAt === page.updatedAt && existing.title === page.title) skip.add(page.id);
    else remap.set(page.id, newId());
  }
  const hasJournal = findJournal(state) !== null;
  const mapId = (id: PageId) => remap.get(id) ?? id;
  const incomingIds = new Set(backup.pages.map((page) => page.id));
  const pages: PageMeta[] = [];
  const docs: Record<PageId, DocNode> = {};
  for (const page of backup.pages) {
    if (skip.has(page.id)) continue;
    const id = mapId(page.id);
    const parentKnown =
      page.parentId !== null && (incomingIds.has(page.parentId) || state.pages[page.parentId]);
    pages.push({
      ...page,
      id,
      parentId: parentKnown ? mapId(page.parentId!) : null,
      title: remap.has(page.id) ? `${page.title || 'Untitled'} (restored)` : page.title,
      kind: page.kind === 'journal' && hasJournal ? 'page' : page.kind,
      dailyDate: page.dailyDate && findDailyNote(state, page.dailyDate) ? null : page.dailyDate,
    });
    const doc = backup.docs[page.id];
    if (doc) docs[id] = remapLinks(doc, mapId);
  }
  return { pages, docs, skipped: skip.size, problems: backup.problems };
}

function remapLinks(doc: DocNode, mapId: (id: PageId) => PageId): DocNode {
  const visit = (node: DocNode): DocNode => {
    const next = node.content ? { ...node, content: node.content.map(visit) } : node;
    if (node.type === 'pageLink' && typeof node.attrs?.id === 'string') {
      return { ...next, attrs: { ...node.attrs, id: mapId(node.attrs.id) } };
    }
    return next;
  };
  return visit(cloneDoc(doc));
}

export interface MarkdownFile {
  name: string;
  text: string;
}

// each file becomes a page, [[links]] resolve against existing and imported pages
export function planMarkdownImport(
  state: WorkspaceState,
  files: MarkdownFile[],
  parentId: PageId | null,
  newId: () => PageId,
  now: number,
): InsertPlan {
  const base = childrenOf(state.pages, parentId).length;
  const drafts = files.map((file) => {
    const fallback = file.name.replace(/\.(md|markdown|mdown|txt)$/i, '').trim() || 'Untitled';
    const read = readPageText(file.text);
    const body = read.error ? file.text : read.body;
    const firstLine = /^#\s+(.+)$/m.exec(body.split('\n').find((line) => line.trim()) ?? '');
    const title = (read.error ? null : read.title) ?? firstLine?.[1]?.trim() ?? fallback;
    return { id: newId(), file, fallback, title };
  });
  const resolvePage = (title: string): PageId | null => {
    const imported = drafts.find((draft) => draft.title.toLowerCase() === title.toLowerCase());
    return imported?.id ?? pageIdByTitle(state, title);
  };
  const pages: PageMeta[] = [];
  const docs: Record<PageId, DocNode> = {};
  drafts.forEach((draft, index) => {
    const parsed = readImportedFile(draft.file.text, draft.fallback, { resolvePage });
    pages.push(
      newPageMeta({
        id: draft.id,
        parentId,
        title: parsed.title,
        order: base + index,
        createdAt: now,
        ...parsed.fields,
      }),
    );
    docs[draft.id] = parsed.doc;
  });
  return { pages, docs, skipped: 0, problems: [] };
}

export function pageMarkdown(
  state: WorkspaceState,
  id: PageId,
  filePath?: (fileId: FileId) => string | null,
  attachmentPath?: (fileId: FileId) => string | null,
  markdownPagePath?: (pageId: PageId) => string | null,
): string {
  const page = state.pages[id];
  const doc = state.docs[id];
  if (!page || !doc) return '';
  const titleOf = (target: PageId) => (state.pages[target] ? displayTitle(state.pages[target]) : null);
  const markdownLinkTarget: MarkdownPageLinkTarget = (targetId, originalHref) =>
    markdownTargetFromPaths(
      markdownPagePath?.(id) ?? null,
      markdownPagePath?.(targetId) ?? null,
      originalHref,
    );
  const markdown = pageToMarkdown(displayTitle(page), refreshLinkLabels(doc, titleOf), {
    titleOf,
    ...(filePath ? { filePath } : {}),
    markdownLinkTarget,
  });
  const frontmatterFiles = new Map<string, string>();
  for (const fileId of pageFileReferences(page, doc, state)) {
    const path = attachmentPath?.(fileId) ?? filePath?.(fileId);
    if (path) frontmatterFiles.set(fileId, path);
  }
  const exportedPage = remapPageMediaFiles([page], state.pages, frontmatterFiles)[0]!;
  const parentDatabase = page.parentId ? (state.pages[page.parentId]?.database ?? null) : null;
  const managed = managedFrontmatter(exportedPage, safeFileName(displayTitle(page)), parentDatabase, state);
  managed.set('title', displayTitle(page));
  const frontmatter = composeFrontmatter(managed, page.extra, null);
  const body = `${markdown}${dynamicSnapshot(state, page, filePath, markdownLinkTarget)}${databaseSnapshot(
    state,
    page,
    filePath,
    markdownLinkTarget,
  )}`;
  return joinFrontmatter(frontmatter, body);
}

// attachments share one folder, each file gets a stable unique name
export function attachmentNames(ids: FileId[], files: Record<FileId, FileMeta>): Map<FileId, string> {
  const names = new Map<FileId, string>();
  const used = new Set<string>();
  for (const id of ids) {
    const meta = files[id];
    if (!meta || names.has(id)) continue;
    const dot = meta.name.lastIndexOf('.');
    const extension =
      dot > 0
        ? meta.name
            .slice(dot)
            .replace(/[^.A-Za-z0-9]/g, '')
            .slice(0, 10)
        : '';
    const base = safeFileName(dot > 0 ? meta.name.slice(0, dot) : meta.name);
    names.set(id, uniqueName(`${base}${extension}`, used));
  }
  return names;
}

export interface ExportFile {
  path: string;
  content: string;
}

type MarkdownPageLinkTarget = NonNullable<SerializeOptions['markdownLinkTarget']>;

// a page with subpages exports as title.md next to a folder named after it, files go in attachments
export function workspaceMarkdownFiles(
  state: WorkspaceState,
  fileMetas: Record<FileId, FileMeta> = {},
): { files: ExportFile[]; attachments: Map<FileId, string> } {
  const live = livePages(state.pages).filter((page) => !page.encrypted);
  const referenced = live.flatMap((page) => [
    ...(state.docs[page.id] ? fileIdsInDoc(state.docs[page.id]!) : []),
    ...(state.docs[page.id] ? pageFileReferences(page, state.docs[page.id]!, state) : []),
    ...fileIdsInPageProperties(page, state.pages),
  ]);
  const attachments = new Map(
    [...attachmentNames(referenced, fileMetas)].map(([id, name]) => [id, `attachments/${name}`]),
  );
  const markdownPagePaths = exportMarkdownPagePaths(state);
  const files: ExportFile[] = [];
  const visit = (parentId: PageId | null, folder: string, depth: number) => {
    if (depth > 32) return;
    const used = new Set<string>(['attachments']);
    const up = '../'.repeat(depth);
    for (const page of childrenOf(state.pages, parentId)) {
      if (page.encrypted) continue;
      const name = uniqueName(safeFileName(displayTitle(page)), used);
      const filePath = (id: FileId) => {
        const target = attachments.get(id);
        return target ? `${up}${target}` : null;
      };
      files.push({
        path: markdownPagePaths.get(page.id) ?? `${folder}${name}.md`,
        content: pageMarkdown(
          state,
          page.id,
          filePath,
          (id) => attachments.get(id) ?? null,
          (id) => markdownPagePaths.get(id) ?? null,
        ),
      });
      visit(page.id, `${folder}${name}/`, depth + 1);
    }
  };
  visit(null, '', 0);
  return { files, attachments };
}

function exportMarkdownPagePaths(state: WorkspaceState): Map<PageId, string> {
  const paths = new Map<PageId, string>();
  const visit = (parentId: PageId | null, folder: string, depth: number) => {
    if (depth > 32) return;
    const used = new Set<string>(['attachments']);
    for (const page of childrenOf(state.pages, parentId)) {
      if (page.encrypted) continue;
      const name = uniqueName(safeFileName(displayTitle(page)), used);
      paths.set(page.id, `${folder}${name}.md`);
      visit(page.id, `${folder}${name}/`, depth + 1);
    }
  };
  visit(null, '', 0);
  return paths;
}

function pageFileReferences(page: PageMeta, doc: DocNode, state: WorkspaceState): FileId[] {
  const ids = new Set<FileId>([...fileIdsInDoc(doc), ...fileIdsInPageProperties(page, state.pages)]);
  if (page.cover && !page.cover.startsWith('gradient-')) ids.add(page.cover);
  const icon = parsePageIcon(page.icon);
  if (icon?.kind === 'file') ids.add(icon.id);
  return [...ids];
}

function dynamicSnapshot(
  state: WorkspaceState,
  page: PageMeta,
  filePath?: (fileId: FileId) => string | null,
  markdownLinkTarget?: MarkdownPageLinkTarget,
): string {
  const doc = state.docs[page.id];
  if (!doc) return '';
  const controls = page.controls.length
    ? [
        '## Controls snapshot',
        '',
        '| Control | Type | Current value | Default |',
        '| --- | --- | --- | --- |',
        ...page.controls.map(
          (control) =>
            `| ${cell(control.name)} | ${cell(control.type)} | ${cell(controlValue(control.value, control.options, state))} | ${cell(controlValue(control.defaultValue, control.options, state))} |`,
        ),
        '',
      ].join('\n')
    : '';
  const nodes: DocNode[] = [];
  const stack = [...(doc.content ?? [])].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === 'calculatedResult' || node.type === 'linkedDatabaseView') nodes.push(node);
    if (node.content) stack.push(...[...node.content].reverse());
  }
  const results = nodes.filter((node) => node.type === 'calculatedResult');
  const resultSnapshot = results.length
    ? [
        '## Calculated results snapshot',
        '',
        '| Result | Formula | Current value |',
        '| --- | --- | --- |',
        ...results.map((node) => {
          const attrs = node.attrs ?? {};
          const source = typeof attrs.formula === 'string' ? attrs.formula : '';
          const resultId = typeof attrs.resultId === 'string' ? attrs.resultId : '';
          const bindings = Array.isArray(attrs.bindings) ? (attrs.bindings as FormulaReferenceBinding[]) : [];
          const evaluated = resultId
            ? documentFormulaResult(page.id, resultId, source, bindings, state)
            : { value: null, error: 'Missing result identifier.' };
          const outputType = typeof attrs.outputType === 'string' ? attrs.outputType : 'formula';
          const displayProp: PropDef = {
            id: resultId,
            name: String(attrs.name ?? 'Result'),
            type: PROP_TYPES.includes(outputType as PropType) ? (outputType as PropType) : 'formula',
            options: [],
            ...(isRecord(attrs.format) ? { format: attrs.format as PropertyFormat } : {}),
          };
          const value =
            evaluated.error ??
            formulaValueText(displayProp, evaluated.value, state);
          return `| ${cell(String(attrs.name ?? 'Calculated result'))} | ${cell(source)} | ${cell(value)} |`;
        }),
        '',
      ].join('\n')
    : '';
  const linkedViews = nodes.filter((node) => node.type === 'linkedDatabaseView');
  const linkedViewSnapshots = linkedViews.map((node, index) => {
    const attrs = node.attrs ?? {};
    const sourceId = typeof attrs.sourceDatabaseId === 'string' ? attrs.sourceDatabaseId : '';
    const source = state.pages[sourceId];
    const title = source ? displayTitle(source) : sourceId || 'Unavailable source';
    const viewInfo = isRecord(attrs.view) ? attrs.view : {};
    const name = typeof viewInfo.name === 'string' ? viewInfo.name : `Linked view ${index + 1}`;
    const type = typeof viewInfo.type === 'string' ? viewInfo.type : 'table';
    const header = `## Linked view snapshot: ${name}\n\nSource database: **${title}** · View type: ${type}. This is a static snapshot; open the linked view in Morrow to edit shared rows.\n`;
    if (!source?.database || source.kind !== 'database') return `${header}\n`;
    const normalized = normalizeDatabase({ properties: source.database.properties, views: [viewInfo] });
    const view = normalized?.views[0];
    if (!view) return `${header}\n`;
    return `${header}\n${databaseTable(state, source, view, filePath, markdownLinkTarget)}\n`;
  });
  return [controls, resultSnapshot, ...linkedViewSnapshots].filter(Boolean).join('\n');
}

function databaseSnapshot(
  state: WorkspaceState,
  page: PageMeta,
  filePath?: (fileId: FileId) => string | null,
  markdownLinkTarget?: MarkdownPageLinkTarget,
): string {
  if (page.kind !== 'database' || !page.database) return '';
  const views = page.database.views.length
    ? ['## Saved views', '', ...page.database.views.map((view) => `- ${viewSummary(view)}`), ''].join('\n')
    : '';
  const table = databaseTable(state, page, undefined, filePath, markdownLinkTarget);
  return `\n## Database snapshot\n\n${table}\n${views}`;
}

function databaseTable(
  state: WorkspaceState,
  databasePage: PageMeta,
  view?: ViewDef,
  filePath?: (fileId: FileId) => string | null,
  markdownLinkTarget?: MarkdownPageLinkTarget,
): string {
  const database = databasePage.database;
  if (!database) return '';
  const props = database.properties;
  const rows = view
    ? visibleRows(rowsOf(state, databasePage.id), view, database, state)
    : rowsOf(state, databasePage.id);
  const headers = ['Title', ...props.map((prop) => prop.name)];
  const table = [
    `| ${headers.map(cell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map(
      (row) =>
        `| ${[
          displayTitle(row),
          ...props.map((prop) => {
            if (prop.type === 'button') return `Action: ${prop.action?.label ?? prop.name}`;
            if (prop.type === 'formula' || prop.fillMode === 'calculated') {
              const result = formulaResult(row, prop, database, 0, state);
              if (result.error) return `Error: ${result.error}`;
            }
            const value = valueOf(row, prop.id, database, state);
            if (prop.type === 'relation') {
              const refs = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
              return refs.map((id) => (state.pages[id] ? displayTitle(state.pages[id]!) : id)).join(', ');
            }
            if ((prop.type === 'image' || prop.type === 'file') && typeof value === 'string') {
              const files = readAttachmentValue(value) ?? [];
              return files
                .map((file) => {
                  const path = filePath?.(file.id);
                  return path ? `[${file.name}](${path})` : file.name;
                })
                .join(', ');
            }
            if (prop.type === 'richCanvas') {
              const rich = parseRichCanvas(value);
              return rich
                ? docToMarkdown(rich, {
                    ...(filePath ? { filePath } : {}),
                    ...(markdownLinkTarget ? { markdownLinkTarget } : {}),
                  }).trim()
                : propertyMediaLabel(prop, value);
            }
            return formatValue(prop, value);
          }),
        ]
          .map(cell)
          .join(' | ')} |`,
    ),
  ];
  return table.join('\n');
}

function viewSummary(view: ViewDef): string {
  const details = [
    view.filters.length
      ? `filters: ${view.filters.map((rule) => `${rule.prop} ${rule.op} ${JSON.stringify(rule.value)}`).join('; ')}`
      : '',
    view.sorts.length ? `sorts: ${view.sorts.map((rule) => `${rule.prop} ${rule.dir}`).join(', ')}` : '',
    view.groupBy ? `grouped by ${view.groupBy}` : '',
    view.dateProp ? `date field ${view.dateProp}` : '',
    view.search ? `search: ${view.search}` : '',
  ].filter(Boolean);
  return `**${view.name}** (${view.type})${details.length ? ` — ${details.join('; ')}` : ''}`;
}

function controlValue(
  value: unknown,
  options: PageMeta['controls'][number]['options'],
  state: WorkspaceState,
): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map((part) => controlValue(part, options, state)).join(', ');
  if (typeof value !== 'string') return value === null || value === undefined ? '' : String(value);
  const option = options.find((candidate) => candidate.id === value);
  if (option) return option.name;
  return state.pages[value] ? displayTitle(state.pages[value]!) : value;
}

function cell(value: unknown): string {
  return String(value ?? '')
    .replaceAll('|', '\\|')
    .replace(/\r?\n/g, '<br>')
    .trim();
}

export function safeFileName(title: string): string {
  const printable = [...title].map((char) => (char.charCodeAt(0) < 32 ? ' ' : char)).join('');
  const cleaned = printable
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 60)
    .trim();
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
  return !cleaned || reserved.test(cleaned) ? 'Untitled' : cleaned;
}

function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${name} (${n})`;
  used.add(candidate.toLowerCase());
  return candidate;
}
