import { describe, expect, it } from 'vitest';
import type { DocNode } from '../core/model';
import { docToMarkdown } from '../core/markdown/serialize';
import { inspectBlockBackgroundMarkers, markdownToDoc } from '../core/markdown/parse';
import { encodePolarisDadosViewMarker } from '../core/polarisDadosView';
import { findUnrepresentablePageContent } from '../core/vault/compatibility';
import { splitFrontmatter } from '../core/vault/frontmatter';
import {
  E003_CURRENT_SCHEMA3_DATABASE,
  E003_CURRENT_SCHEMA3_DATABASE_PATH,
  E003_FORMAT12_DATABASE,
  E003_FORMAT12_DATABASE_PATH,
  E003_FORMAT12_ROW,
  E003_FORMAT12_ROW_PATH,
  E003_FORMAT13_DATABASE,
  E003_FORMAT13_DATABASE_PATH,
  E003_FORMAT13_ROW,
  E003_FORMAT13_ROW_PATH,
  E003_FUTURE_DATABASE,
  E003_FUTURE_DATABASE_PATH,
  E003_FUTURE_ROW,
  E003_FUTURE_ROW_PATH,
  E003_PUBLISHED_NAMED_CONTROL,
  E003_PUBLISHED_NAMED_CONTROL_PATH,
} from './fixtures/e003-fork-compatibility';
import { MemoryVault } from './memoryVault';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';

let generatedId = 0;
const newId = () => `compatibility-${++generatedId}`;

function databaseFile(columns: unknown, extraViewFields = ''): string {
  const yamlColumns = JSON.stringify(columns);
  if (yamlColumns === undefined) throw new Error('The fixture columns must be JSON serializable.');
  return `---
kind: database
database:
  properties:
    - id: name
      name: Name
      type: text
    - id: quantity
      name: Quantity
      type: number
    - id: price
      name: Price
      type: number
  views:
    - id: table
      name: Table
      type: table
      columns: ${yamlColumns}
${extraViewFields}---
# Inventory
`;
}

function registryFor(paths: Record<string, string>): string {
  return JSON.stringify({
    version: 1,
    pages: Object.fromEntries(Object.entries(paths).map(([path, id]) => [path, { id }])),
  });
}

async function open(vault: MemoryVault): Promise<WorkspaceSession> {
  const result = await WorkspaceSession.open(new VaultRepository(vault, newId), { delayMs: 0 });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function pageIdAt(session: WorkspaceSession, path: string): string {
  const id = Object.keys(session.getState().pages).find((candidate) => session.pathOf(candidate) === path);
  if (!id) throw new Error(`No page at ${path}`);
  return id;
}

function viewMarker(viewId = 'linked-view'): string {
  return encodePolarisDadosViewMarker({
    version: 1,
    viewId,
    sourceDatabaseId: 'missing-source-database',
    title: 'Synthetic view',
    columnOrder: ['title', 'quantity', 'retired-property'],
    filter: null,
  });
}

type VaultOperations = Parameters<MemoryVault['apply']>[0];

class ObservedMemoryVault extends MemoryVault {
  readonly applyCalls: VaultOperations[] = [];

  override async apply(operations: VaultOperations) {
    this.applyCalls.push(operations);
    return super.apply(operations);
  }
}

function snapshotAllFiles(vault: MemoryVault) {
  return Object.fromEntries(
    [...vault.files.keys()]
      .sort()
      .map((path) => [path, { text: vault.text(path) ?? null, mtime: vault.modifiedTime(path) }]),
  );
}

async function openObservedVault(files: Record<string, string>) {
  const pageIds = Object.fromEntries(
    Object.keys(files).map((path, index) => [path, `compatibility-fixture-${index + 1}`]),
  );
  const vault = new ObservedMemoryVault({
    ...files,
    '.morrow/workspace.json': registryFor(pageIds),
    '.morrow/recent.json': JSON.stringify({ version: 1, opened: {}, activity: {} }, null, 1),
  });
  const repository = new VaultRepository(vault, newId);
  const opened = await WorkspaceSession.open(repository, { delayMs: 0 });
  if (!opened.ok) throw new Error(opened.error);
  return { vault, repository, session: opened.value };
}

function expectRawSource(session: WorkspaceSession, id: string, source: string): void {
  expect(session.getState().docs[id]).toEqual({
    type: 'doc',
    content: [{ type: 'rawBlock', attrs: { text: source } }],
  });
}

async function expectProtectedStorageSample(options: {
  files: Record<string, string>;
  protectedPath: string;
  reason: RegExp;
  rowPath?: string;
  validYaml?: boolean;
}): Promise<void> {
  const { files, protectedPath, reason, rowPath, validYaml = false } = options;
  const { vault, repository, session } = await openObservedVault(files);
  const before = snapshotAllFiles(vault);
  try {
    expect(session.firstRun).toBe(false);
    expect(vault.applyCalls).toHaveLength(0);

    const source = files[protectedPath]!;
    if (validYaml) {
      const parsed = splitFrontmatter(source);
      expect(parsed.error).toBeNull();
      expect(parsed.data).not.toBeNull();
    }

    const id = pageIdAt(session, protectedPath);
    expect(session.protectedReasons.get(id)).toMatch(reason);
    expect(session.unreadable.has(id)).toBe(true);
    expect(session.problems.join('\n')).toMatch(reason);
    expectRawSource(session, id, source);
    expect(Object.hasOwn(session.getState().pages[id]!.extra, 'polarisDados')).toBe(false);

    const refusedEdit = session.execute({
      type: 'page.rename',
      id,
      title: 'Unsafe compatibility edit',
      now: 40,
    });
    expect(refusedEdit.ok).toBe(false);
    if (!refusedEdit.ok) expect(refusedEdit.error).toMatch(/cannot safely represent/i);

    if (rowPath) {
      const rowId = pageIdAt(session, rowPath);
      expect(session.protectedReasons.get(rowId)).toMatch(/parent database is protected/i);
      expect(session.unreadable.has(rowId)).toBe(true);
      expectRawSource(session, rowId, files[rowPath]!);
      expect(session.execute({ type: 'page.rename', id: rowId, title: 'Unsafe row edit', now: 41 }).ok).toBe(
        false,
      );

      const row = session.getState().pages[rowId]!;
      const changedRow = { ...row, title: 'Unsafe direct row edit' };
      const rowBatch = {
        pages: [changedRow],
        docs: [],
        removed: [],
        state: {
          pages: { ...session.getState().pages, [rowId]: changedRow },
          docs: session.getState().docs,
        },
      };
      expect(repository.validateWrite(rowBatch)).toMatch(/parent database is protected/i);
      await expect(repository.write(rowBatch)).rejects.toThrow(/parent database is protected/i);
    }

    const state = session.getState();
    const changed = { ...state.pages[id]!, title: 'Unsafe direct repository edit' };
    const batch = {
      pages: [changed],
      docs: [],
      removed: [],
      state: { pages: { ...state.pages, [id]: changed }, docs: state.docs },
    };
    expect(repository.validateWrite(batch)).toMatch(/cannot safely represent/i);
    await expect(repository.write(batch)).rejects.toThrow(/cannot safely represent/i);
    expect(vault.applyCalls).toHaveLength(0);
    expect(snapshotAllFiles(vault)).toEqual(before);

    expect(await session.flush()).toBe(true);
    expect(snapshotAllFiles(vault)).toEqual(before);
    await session.markInitialized();
    expect(vault.applyCalls).toHaveLength(0);
    expect(snapshotAllFiles(vault)).toEqual(before);

    await session.close();
    expect(vault.applyCalls).toHaveLength(0);
    expect(snapshotAllFiles(vault)).toEqual(before);
  } finally {
    if (!session.isClosed) await session.close();
  }
}

describe('E003 #164 Morrow 2.1 representability', () => {
  it('accepts explicit column orders at the supported limits and keeps stale IDs opaque', () => {
    const maxCount = Array.from({ length: 200 }, (_, index) => `column-${index}`);
    maxCount[199] = 'z'.repeat(64);
    for (const columns of [
      ['x'],
      ['title', 'quantity', 'retired property / opaque ID'],
      ['z'.repeat(64)],
      maxCount,
    ]) {
      expect(findUnrepresentablePageContent(databaseFile(columns))).toBeNull();
    }
  });

  it.each([
    ['empty order', []],
    ['65-character ID', ['x'.repeat(65)]],
    ['201 entries', Array.from({ length: 201 }, (_, index) => `column-${index}`)],
    ['null', null],
    ['scalar', 'title'],
    ['non-string entry', ['title', 42]],
    ['duplicate IDs', ['title', 'title']],
  ])('protects a %s column order before normalization', (_name, columns) => {
    expect(findUnrepresentablePageContent(databaseFile(columns))).toMatch(/database view column order/i);
  });

  it('persists a reordered view with a stale ID and row edit through MemoryVault and WorkspaceSession', async () => {
    const initialColumns = ['title', 'quantity', 'retired property / opaque ID'];
    const initialDatabase = databaseFile(initialColumns);
    const vault = new MemoryVault({
      'Inventory.md': initialDatabase,
      'Inventory/Widget.md': `---
Name: Widget
Quantity: 2
Price: 10
vendorRecord:
  id: opaque-widget-7f21
---
Synthetic row.
`,
      '.morrow/workspace.json': registryFor({
        'Inventory.md': 'inventory-page',
        'Inventory/Widget.md': 'widget-row',
      }),
    });

    let first: WorkspaceSession | undefined;
    let reopened: WorkspaceSession | undefined;
    try {
      first = await open(vault);
      const databaseId = pageIdAt(first, 'Inventory.md');
      const rowId = pageIdAt(first, 'Inventory/Widget.md');
      const database = first.getState().pages[databaseId]!.database!;
      expect(database.views[0]!.columns).toEqual(initialColumns);

      const reorderedColumns = ['title', 'retired property / opaque ID', 'price', 'quantity'];
      const schemaEdit = first.execute({
        type: 'database.set',
        id: databaseId,
        database: {
          ...database,
          views: database.views.map((view) => ({ ...view, columns: reorderedColumns })),
        },
        now: 10,
      });
      expect(schemaEdit.ok).toBe(true);
      const rowEdit = first.execute({
        type: 'page.setProperties',
        id: rowId,
        values: { quantity: 3 },
        now: 11,
      });
      expect(rowEdit.ok).toBe(true);
      expect(await first.flush()).toBe(true);
      await first.close();
      first = undefined;

      expect(vault.text('Inventory.md')).toContain('columns:');
      expect(vault.text('Inventory/Widget.md')).toContain('vendorRecord:');

      reopened = await open(vault);
      const reopenedDatabaseId = pageIdAt(reopened, 'Inventory.md');
      const reopenedRowId = pageIdAt(reopened, 'Inventory/Widget.md');
      expect(reopenedDatabaseId).toBe(databaseId);
      expect(reopenedRowId).toBe(rowId);
      expect(reopened.getState().pages[reopenedDatabaseId]!.database!.views[0]!.columns).toEqual(
        reorderedColumns,
      );
      expect(reopened.getState().pages[reopenedRowId]!.properties.quantity).toBe(3);
      expect(reopened.getState().pages[reopenedRowId]!.properties.price).toBe(10);
    } finally {
      if (first && !first.isClosed) await first.close();
      if (reopened && !reopened.isClosed) await reopened.close();
    }
  });

  it('keeps an empty raw column order protected and leaves the original database and rows unchanged', async () => {
    const rawDatabase = databaseFile([]);
    const vault = new MemoryVault({
      'Inventory.md': rawDatabase,
      'Inventory/Widget.md': '---\nName: Widget\nQuantity: 2\n---\nSynthetic row.\n',
      '.morrow/workspace.json': registryFor({
        'Inventory.md': 'inventory-page',
        'Inventory/Widget.md': 'widget-row',
      }),
    });
    let session: WorkspaceSession | undefined;
    try {
      session = await open(vault);
      const databaseId = pageIdAt(session, 'Inventory.md');
      const rowId = pageIdAt(session, 'Inventory/Widget.md');
      expect(session.protectedReasons.get(databaseId)).toMatch(/column order/i);
      expect(session.unreadable.has(databaseId)).toBe(true);
      expect(session.protectedReasons.get(rowId)).toMatch(/parent database is protected/i);
      expect(session.unreadable.has(rowId)).toBe(true);
      expect(session.getState().pages[databaseId]!.database!.views[0]!.columns).toEqual([]);
      expect(session.execute({ type: 'page.rename', id: databaseId, title: 'Unsafe edit', now: 20 }).ok).toBe(
        false,
      );
      expect(await session.flush()).toBe(true);
      expect(vault.text('Inventory.md')).toBe(rawDatabase);
      expect(vault.text('Inventory/Widget.md')).toBe('---\nName: Widget\nQuantity: 2\n---\nSynthetic row.\n');
    } finally {
      if (session && !session.isClosed) await session.close();
    }
  });

  it('round-trips supported 2.1 background, lettered-list, and table-width markers next to a linked view', async () => {
    const source = [
      '<!-- background: blue -->',
      'Highlighted paragraph.',
      '',
      '<!-- letters -->',
      '1. First item',
      '2. Second item',
      '',
      '<!-- column-widths: 240 0 -->',
      '| Name | Note |',
      '| --- | --- |',
      '| Ada | Keeps the width marker. |',
      '',
      viewMarker(),
      '',
    ].join('\n');
    const originalDoc = markdownToDoc(source);
    const serialized = docToMarkdown(originalDoc);

    expect(findUnrepresentablePageContent(source)).toBeNull();
    expect(findUnrepresentablePageContent(serialized)).toBeNull();
    expect(serialized).toContain('<!-- background: blue -->');
    expect(serialized).toContain('<!-- letters -->');
    expect(serialized).toContain('<!-- column-widths: 240 0 -->');
    expect(serialized).toContain(viewMarker());
    expect(markdownToDoc(serialized)).toEqual(originalDoc);

    const noteFile = `Notes.md`;
    const vault = new MemoryVault({
      [noteFile]: source,
      '.morrow/workspace.json': registryFor({ [noteFile]: 'note-page' }),
    });
    let first: WorkspaceSession | undefined;
    let reopened: WorkspaceSession | undefined;
    try {
      first = await open(vault);
      expect(first.protectedReasons.has('note-page')).toBe(false);
      const current = first.getState().docs['note-page']!;
      const edited: DocNode = {
        ...current,
        content: [
          ...(current.content ?? []),
          { type: 'paragraph', content: [{ type: 'text', text: 'Edited after reopening.' }] },
        ],
      };
      expect(first.execute({ type: 'page.setDoc', id: 'note-page', doc: edited, now: 30 }).ok).toBe(true);
      expect(await first.flush()).toBe(true);
      await first.close();
      first = undefined;

      const savedText = vault.text(noteFile)!;
      expect(findUnrepresentablePageContent(savedText)).toBeNull();
      reopened = await open(vault);
      expect(reopened.protectedReasons.has('note-page')).toBe(false);
      const reopenedDoc = reopened.getState().docs['note-page']!;
      const reopenedMarkdown = docToMarkdown(reopenedDoc);
      expect(reopenedMarkdown).toContain('<!-- background: blue -->');
      expect(reopenedMarkdown).toContain('<!-- letters -->');
      expect(reopenedMarkdown).toContain('<!-- column-widths: 240 0 -->');
      expect(reopenedMarkdown).toContain(viewMarker());
      expect(reopenedMarkdown).toContain('Edited after reopening.');
      expect(markdownToDoc(reopenedMarkdown)).toEqual(reopenedDoc);
    } finally {
      if (first && !first.isClosed) await first.close();
      if (reopened && !reopened.isClosed) await reopened.close();
    }
  });

  it('opens and saves an explicit-title H1 background while keeping a literal code marker inert', async () => {
    const marker = '<!-- morrow:block-background:#2F80ED -->';
    const noteFile = 'Notes.md';
    const source = [
      '---',
      'title: Explicit title',
      '---',
      marker,
      '',
      '# Body heading',
      '',
      'Adjacent paragraph.',
      '',
      '```markdown',
      marker,
      '```',
      '',
      '<div data-columns>',
      '<div data-column>',
      '',
      '<!-- morrow:block-background:#12AB34 -->',
      'Column HEX background.',
      '',
      '<!-- morrow:block-background:yellow -->',
      'Legacy palette background.',
      '',
      '<!-- background: red -->',
      'Named column background.',
      '',
      '</div>',
      '<div data-column>',
      '',
      'Second column.',
      '',
      '</div>',
      '</div>',
      '',
    ].join('\n');
    expect(findUnrepresentablePageContent(source)).toBeNull();
    const vault = new ObservedMemoryVault({
      [noteFile]: source,
      '.morrow/workspace.json': registryFor({ [noteFile]: 'note-page' }),
    });
    let first: WorkspaceSession | undefined;
    let reopened: WorkspaceSession | undefined;
    try {
      first = await open(vault);
      expect(first.protectedReasons.has('note-page')).toBe(false);
      expect(vault.applyCalls).toHaveLength(0);
      expect(vault.text(noteFile)).toBe(source);
      const current = first.getState().docs['note-page']!;
      expect(current.content?.[0]).toMatchObject({
        type: 'heading',
        attrs: { level: 1, backgroundColor: '#2f80ed' },
      });
      expect(current.content?.[2]?.type).toBe('codeBlock');
      expect(current.content?.[2]?.content?.[0]?.text).toBe(marker);
      expect(current.content?.[3]?.type).toBe('columns');
      expect(current.content?.[3]?.content?.[0]?.content?.[0]?.attrs?.backgroundColor).toBe('#12ab34');
      expect(current.content?.[3]?.content?.[0]?.content?.[1]?.attrs?.backgroundColor).toBe('yellow');
      expect(current.content?.[3]?.content?.[0]?.content?.[2]?.attrs?.backgroundColor).toBe('red');

      const edited: DocNode = {
        ...current,
        content: [
          ...(current.content ?? []),
          { type: 'paragraph', content: [{ type: 'text', text: 'Edited safely.' }] },
        ],
      };
      expect(first.execute({ type: 'page.setDoc', id: 'note-page', doc: edited, now: 31 }).ok).toBe(true);
      expect(await first.flush()).toBe(true);
      await first.close();
      first = undefined;

      const savedFile = 'Explicit title.md';
      expect(vault.text(savedFile)).toBeDefined();
      const saved = vault.text(savedFile)!;
      expect(saved).toContain('title: Explicit title');
      expect(saved).toContain('<!-- morrow:block-background:#2f80ed -->');
      expect(saved).toContain(`\`\`\`markdown\n${marker}\n\`\`\``);
      expect(saved).toContain('Adjacent paragraph.');
      expect(saved).toContain('<!-- morrow:block-background:#12ab34 -->');
      expect(saved).toContain('<!-- background: yellow -->');
      expect(saved).toContain('<!-- background: red -->');
      expect(findUnrepresentablePageContent(saved)).toBeNull();

      reopened = await open(vault);
      expect(reopened.protectedReasons.has('note-page')).toBe(false);
      expect(reopened.getState().pages['note-page']!.title).toBe('Explicit title');
      expect(reopened.getState().docs['note-page']!.content?.[0]?.attrs?.backgroundColor).toBe('#2f80ed');
      expect(reopened.getState().docs['note-page']!.content?.[2]?.content?.[0]?.text).toBe(marker);
      expect(
        reopened.getState().docs['note-page']!.content?.[3]?.content?.[0]?.content?.[0]?.attrs
          ?.backgroundColor,
      ).toBe('#12ab34');
      expect(
        reopened.getState().docs['note-page']!.content?.[3]?.content?.[0]?.content?.[1]?.attrs
          ?.backgroundColor,
      ).toBe('yellow');
      expect(
        reopened.getState().docs['note-page']!.content?.[3]?.content?.[0]?.content?.[2]?.attrs
          ?.backgroundColor,
      ).toBe('red');
    } finally {
      if (first && !first.isClosed) await first.close();
      if (reopened && !reopened.isClosed) await reopened.close();
    }
  });

  it('opens and saves identical marker text on a root paragraph and direct list paragraphs', async () => {
    const marker = '<!-- morrow:block-background:#2f80ed -->';
    const presetMarker = '<!-- morrow:block-background:green -->';
    const source = [
      marker,
      'Supported paragraph.',
      '',
      '- ',
      `  ${marker}`,
      '  First list paragraph.',
      '',
      `  ${marker}`,
      '',
      '  Second list paragraph.',
      '',
      `  ${presetMarker}`,
      '',
      '  Named preset paragraph.',
      '',
    ].join('\n');
    expect(findUnrepresentablePageContent(source)).toBeNull();
    const vault = new ObservedMemoryVault({
      'Notes.md': source,
      '.morrow/workspace.json': registryFor({ 'Notes.md': 'note-page' }),
    });
    let session: WorkspaceSession | undefined;
    let reopened: WorkspaceSession | undefined;
    try {
      session = await open(vault);
      expect(session.protectedReasons.has('note-page')).toBe(false);
      const original = session.getState().docs['note-page']!;
      expect(docToMarkdown(original).match(/<!-- morrow:block-background:/g)).toHaveLength(4);
      expect(original.content?.[1]?.content?.[0]?.content?.[2]?.attrs?.backgroundColor).toBe('green');
      const edited: DocNode = {
        ...original,
        content: [
          ...(original.content ?? []),
          { type: 'paragraph', content: [{ type: 'text', text: 'Neighbor edit.' }] },
        ],
      };
      expect(session.execute({ type: 'page.setDoc', id: 'note-page', doc: edited, now: 41 }).ok).toBe(true);
      expect(await session.flush()).toBe(true);
      const saved = vault.text('Notes.md')!;
      expect(findUnrepresentablePageContent(saved)).toBeNull();
      expect(saved.match(/<!-- morrow:block-background:/g)).toHaveLength(4);
      expect(saved).toContain('Neighbor edit.');
      await session.close();
      session = undefined;

      reopened = await open(vault);
      expect(reopened.protectedReasons.has('note-page')).toBe(false);
      const reopenedMarkdown = docToMarkdown(reopened.getState().docs['note-page']!);
      expect(reopenedMarkdown.match(/<!-- morrow:block-background:/g)).toHaveLength(4);
      expect(reopenedMarkdown).toContain('Neighbor edit.');
    } finally {
      if (session && !session.isClosed) await session.close();
      if (reopened && !reopened.isClosed) await reopened.close();
    }
  });

  it('preserves a block marker in an indented nested-list paragraph across save and reopen', async () => {
    const marker = '<!-- morrow:block-background:#2f80ed -->';
    const source = `- Pai\n  - Filho\n\n    ${marker}\n\n    Parágrafo do filho\n`;
    expect(findUnrepresentablePageContent(source)).toBeNull();
    const vault = new ObservedMemoryVault({
      'Notes.md': source,
      '.morrow/workspace.json': registryFor({ 'Notes.md': 'note-page' }),
    });
    let session: WorkspaceSession | undefined;
    let reopened: WorkspaceSession | undefined;
    try {
      session = await open(vault);
      expect(session.protectedReasons.has('note-page')).toBe(false);
      const original = session.getState().docs['note-page']!;
      expect(docToMarkdown(original)).toContain(marker);
      const edited: DocNode = {
        ...original,
        content: [
          ...(original.content ?? []),
          { type: 'paragraph', content: [{ type: 'text', text: 'Neighbor edit.' }] },
        ],
      };
      expect(session.execute({ type: 'page.setDoc', id: 'note-page', doc: edited, now: 42 }).ok).toBe(true);
      expect(await session.flush()).toBe(true);
      const saved = vault.text('Notes.md')!;
      expect(saved).toContain(marker);
      expect(saved).toContain('Neighbor edit.');
      expect(findUnrepresentablePageContent(saved)).toBeNull();
      await session.close();
      session = undefined;

      reopened = await open(vault);
      expect(reopened.protectedReasons.has('note-page')).toBe(false);
      expect(docToMarkdown(reopened.getState().docs['note-page']!)).toContain(marker);
    } finally {
      if (session && !session.isClosed) await session.close();
      if (reopened && !reopened.isClosed) await reopened.close();
    }
  });

  it('round-trips a published same-line nested-list background with mixed scanner controls', async () => {
    const nestedMarker = '<!-- morrow:block-background:#2f80ed -->';
    const rootMarker = '<!-- morrow:block-background:#7c40ab -->';
    const codeMarker = '<!-- morrow:block-background:#cafe00 -->';
    const fencedMarker = '<!-- morrow:block-background:#beef00 -->';
    const inlineMarker = '<!-- morrow:block-background:#deaf00 -->';
    const source = [
      '- One',
      '  - Two',
      `    - ${nestedMarker}`,
      '      Nested',
      '',
      rootMarker,
      'Root',
      '',
      `    ${codeMarker}`,
      '    Literal code marker.',
      '',
      '~~~markdown',
      fencedMarker,
      '~~~',
      '',
      `Inline code: \`${inlineMarker}\`.`,
      '',
    ].join('\n');
    expect(
      inspectBlockBackgroundMarkers(source).map((marker) => [marker.comment, marker.approved, marker.sourceLine]),
    ).toEqual([
      [nestedMarker, true, 2],
      [rootMarker, true, 5],
    ]);
    expect(findUnrepresentablePageContent(source)).toBeNull();

    const vault = new ObservedMemoryVault({
      'Published nested list.md': source,
      '.morrow/workspace.json': registryFor({ 'Published nested list.md': 'published-nested-list' }),
    });
    let session: WorkspaceSession | undefined;
    let reopened: WorkspaceSession | undefined;
    try {
      session = await open(vault);
      expect(session.protectedReasons.has('published-nested-list')).toBe(false);
      expect(vault.applyCalls).toHaveLength(0);
      expect(vault.text('Published nested list.md')).toBe(source);
      const original = session.getState().docs['published-nested-list']!;
      const edited: DocNode = {
        ...original,
        content: [
          ...(original.content ?? []),
          { type: 'paragraph', content: [{ type: 'text', text: 'Neighbor edit.' }] },
        ],
      };
      expect(
        session.execute({ type: 'page.setDoc', id: 'published-nested-list', doc: edited, now: 44 }).ok,
      ).toBe(true);
      expect(await session.flush()).toBe(true);
      const saved = vault.text('Published nested list.md')!;
      expect(saved).toContain(nestedMarker);
      expect(saved).toContain(rootMarker);
      expect(saved).toContain(`\`\`\`markdown\n${fencedMarker}\n\`\`\``);
      expect(saved).toContain(`\`${inlineMarker}\``);
      expect(saved).toContain(codeMarker);
      expect(saved).toContain('Neighbor edit.');
      expect(findUnrepresentablePageContent(saved)).toBeNull();
      await session.close();
      session = undefined;

      reopened = await open(vault);
      expect(reopened.protectedReasons.has('published-nested-list')).toBe(false);
      const reopenedDoc = reopened.getState().docs['published-nested-list']!;
      expect(docToMarkdown(reopenedDoc)).toContain(nestedMarker);
      expect(docToMarkdown(reopenedDoc)).toContain(rootMarker);
      expect(docToMarkdown(reopenedDoc)).toContain('Neighbor edit.');
    } finally {
      if (session && !session.isClosed) await session.close();
      if (reopened && !reopened.isClosed) await reopened.close();
    }
  });

  it('does not whitelist trailing content or other markers after a nested-list prefix', () => {
    const marker = '<!-- morrow:block-background:#2f80ed -->';
    const trailingContent = `- One\n  - Two\n    - ${marker} extra\n      Nested\n`;
    const unknownMarker = '- One\n  - Two\n    - <!-- morrow:future-marker -->\n      Nested\n';
    expect(findUnrepresentablePageContent(trailingContent)).toMatch(/morrow block marker/i);
    expect(findUnrepresentablePageContent(unknownMarker)).toMatch(/morrow block marker/i);
  });

  it('keeps mixed root, nested-task, and ordered-list backgrounds editable across save and reopen', async () => {
    const rootMarker = '<!-- morrow:block-background:#a1b2c3 -->';
    const nestedMarker = '<!-- morrow:block-background:#2f80ed -->';
    const orderedMarker = '<!-- morrow:block-background:#7c40ab -->';
    const codeMarker = '<!-- morrow:block-background:#cafe00 -->';
    const fencedMarker = '<!-- morrow:block-background:#beef00 -->';
    const inlineMarker = '<!-- morrow:block-background:#deaf00 -->';
    const source = [
      rootMarker,
      'Root colored paragraph.',
      '',
      `    ${codeMarker}`,
      '    Literal code marker.',
      '',
      '```markdown',
      fencedMarker,
      '```',
      '',
      `Inline code: \`${inlineMarker}\`.`,
      '',
      '- Parent item',
      '  - [x] Nested task',
      '',
      `    ${nestedMarker}`,
      '',
      '    Nested shaded paragraph.',
      '',
      '1. ',
      `   ${orderedMarker}`,
      '',
      '   Ordered shaded paragraph.',
      '',
    ].join('\n');
    expect(
      inspectBlockBackgroundMarkers(source).map((marker) => [marker.comment, marker.approved, marker.sourceLine]),
    ).toEqual([
      [rootMarker, true, 0],
      [nestedMarker, true, 15],
      [orderedMarker, true, 20],
    ]);
    expect(findUnrepresentablePageContent(source)).toBeNull();

    const vault = new ObservedMemoryVault({
      'Mixed backgrounds.md': source,
      '.morrow/workspace.json': registryFor({ 'Mixed backgrounds.md': 'mixed-backgrounds' }),
    });
    let session: WorkspaceSession | undefined;
    let reopened: WorkspaceSession | undefined;
    try {
      session = await open(vault);
      expect(session.protectedReasons.has('mixed-backgrounds')).toBe(false);
      expect(vault.applyCalls).toHaveLength(0);
      expect(vault.text('Mixed backgrounds.md')).toBe(source);
      const original = session.getState().docs['mixed-backgrounds']!;
      expect(docToMarkdown(original)).toContain(nestedMarker);
      expect(docToMarkdown(original)).toContain(orderedMarker);
      expect(docToMarkdown(original)).toContain(`${codeMarker}\n`);

      const edited: DocNode = {
        ...original,
        content: [
          ...(original.content ?? []),
          { type: 'paragraph', content: [{ type: 'text', text: 'Neighbor edit.' }] },
        ],
      };
      expect(
        session.execute({ type: 'page.setDoc', id: 'mixed-backgrounds', doc: edited, now: 43 }).ok,
      ).toBe(true);
      expect(await session.flush()).toBe(true);
      const saved = vault.text('Mixed backgrounds.md')!;
      expect(saved).toContain('Neighbor edit.');
      expect(saved).toContain(nestedMarker);
      expect(saved).toContain(orderedMarker);
      expect(findUnrepresentablePageContent(saved)).toBeNull();
      expect(vault.applyCalls.length).toBeGreaterThan(0);
      await session.close();
      session = undefined;

      reopened = await open(vault);
      expect(reopened.protectedReasons.has('mixed-backgrounds')).toBe(false);
      expect(docToMarkdown(reopened.getState().docs['mixed-backgrounds']!)).toContain('Neighbor edit.');
      expect(docToMarkdown(reopened.getState().docs['mixed-backgrounds']!)).toContain(nestedMarker);
      expect(docToMarkdown(reopened.getState().docs['mixed-backgrounds']!)).toContain(orderedMarker);
    } finally {
      if (session && !session.isClosed) await session.close();
      if (reopened && !reopened.isClosed) await reopened.close();
    }
  });

  it('does not whitelist an indented code marker as a background owner', () => {
    const marker = '<!-- morrow:block-background:#2f80ed -->';
    const indentedCode = `    ${marker}\n    Literal code marker.\n`;
    expect(inspectBlockBackgroundMarkers(indentedCode)).toHaveLength(0);
    expect(findUnrepresentablePageContent(indentedCode)).toBeNull();
    const codeBlock = markdownToDoc(indentedCode).content?.[0];
    expect(codeBlock?.type).toBe('codeBlock');
    expect(codeBlock?.content?.[0]?.text).toContain(marker);
    expect(codeBlock?.content?.[0]?.text).toContain('Literal code marker.');
  });

  it('protects an ambiguous marker on the first task paragraph without writing', async () => {
    const marker = '<!-- morrow:block-background:#2f80ed -->';
    const source = `- \n  ${marker}\n\n  [ ] Task first paragraph\n`;
    expect(inspectBlockBackgroundMarkers(source)[0]?.approved).toBe(false);
    expect(findUnrepresentablePageContent(source)).toMatch(/morrow block marker/i);
    const vault = new ObservedMemoryVault({
      'Notes.md': source,
      '.morrow/workspace.json': registryFor({ 'Notes.md': 'note-page' }),
    });
    let session: WorkspaceSession | undefined;
    try {
      session = await open(vault);
      expect(session.protectedReasons.get('note-page')).toMatch(/morrow block marker/i);
      expect(await session.flush()).toBe(true);
      expect(vault.text('Notes.md')).toBe(source);
      expect(vault.applyCalls).toHaveLength(0);
    } finally {
      if (session && !session.isClosed) await session.close();
    }
  });

  it('protects marker owners promoted to media or callouts and keeps their bytes', async () => {
    const marker = '<!-- morrow:block-background:#2f80ed -->';
    const attachment = ['Attachments.md', `${marker}\n\n[file](assets/a.pdf)\n`];
    const image = ['Image.md', `${marker}\n\n![image](assets/photo.png)\n`];
    const split = ['Split.md', `${marker}\n\nBefore ![image](assets/photo.png) after\n`];
    const callout = ['Callout.md', `${marker}\n\n> [!note] Notice\n> Body\n`];
    const files = {
      [attachment[0]!]: attachment[1]!,
      [image[0]!]: image[1]!,
      [split[0]!]: split[1]!,
      [callout[0]!]: callout[1]!,
      'assets/a.pdf': 'stored attachment bytes',
      'assets/photo.png': 'stored image bytes',
      '.morrow/workspace.json': registryFor({
        [attachment[0]!]: 'attachment-page',
        [image[0]!]: 'image-page',
        [split[0]!]: 'split-page',
        [callout[0]!]: 'callout-page',
      }),
    };
    expect(findUnrepresentablePageContent(attachment[1]!)).toMatch(/morrow block marker/i);
    expect(findUnrepresentablePageContent(callout[1]!)).toMatch(/morrow block marker/i);
    expect(inspectBlockBackgroundMarkers(`${marker}\n\n![image](assets/a.png)\n`)[0]?.approved).toBe(false);
    expect(
      inspectBlockBackgroundMarkers(`${marker}\n\nBefore ![image](assets/a.png) after\n`)[0]?.approved,
    ).toBe(false);

    const vault = new ObservedMemoryVault(files);
    let session: WorkspaceSession | undefined;
    try {
      session = await open(vault);
      for (const [id, source] of [
        ['attachment-page', attachment[1]!],
        ['image-page', image[1]!],
        ['split-page', split[1]!],
        ['callout-page', callout[1]!],
      ] as const) {
        expect(session.protectedReasons.get(id)).toMatch(/morrow block marker/i);
        expect(session.getState().docs[id]).toEqual({
          type: 'doc',
          content: [{ type: 'rawBlock', attrs: { text: source } }],
        });
      }
      expect(vault.applyCalls).toHaveLength(0);
      expect(await session.flush()).toBe(true);
      expect(vault.text(attachment[0]!)).toBe(attachment[1]);
      expect(vault.text(image[0]!)).toBe(image[1]);
      expect(vault.text(split[0]!)).toBe(split[1]);
      expect(vault.text(callout[0]!)).toBe(callout[1]);
      expect(vault.text('assets/a.pdf')).toBe('stored attachment bytes');
      expect(vault.text('assets/photo.png')).toBe('stored image bytes');
      expect(vault.applyCalls).toHaveLength(0);
    } finally {
      if (session && !session.isClosed) await session.close();
    }
  });

  it('protects marker owners after real embed lifting and callout normalization', async () => {
    const marker = '<!-- morrow:block-background:#2f80ed -->';
    const sources = {
      'Wiki image.md': `${marker}\n\n![[assets/photo.png]]\n`,
      'Wiki PDF.md': `${marker}\n\n![[assets/a.pdf]]\n`,
      'Inline wiki image.md': `${marker}\n\nLeft ![[assets/photo.png]] right\n`,
      'Callout body.md': `> [!note] Header\n>\n> ${marker}\n> Body\n`,
    };
    const files = {
      ...sources,
      'assets/a.pdf': 'pdf bytes',
      'assets/photo.png': 'image bytes',
      '.morrow/workspace.json': registryFor(
        Object.fromEntries(Object.keys(sources).map((path, index) => [path, `post-normalize-${index}`])),
      ),
    };
    const vault = new ObservedMemoryVault(files);
    let session: WorkspaceSession | undefined;
    try {
      session = await open(vault);
      for (const [index, [path, source]] of Object.entries(sources).entries()) {
        const id = `post-normalize-${index}`;
        expect(session.protectedReasons.get(id), path).toMatch(/morrow block marker/i);
        expect(session.getState().docs[id], path).toEqual({
          type: 'doc',
          content: [{ type: 'rawBlock', attrs: { text: source } }],
        });
      }
      expect(vault.applyCalls).toHaveLength(0);
      expect(await session.flush()).toBe(true);
      for (const [path, source] of Object.entries(sources)) expect(vault.text(path)).toBe(source);
      expect(vault.text('assets/a.pdf')).toBe('pdf bytes');
      expect(vault.text('assets/photo.png')).toBe('image bytes');
      expect(vault.applyCalls).toHaveLength(0);
    } finally {
      if (session && !session.isClosed) await session.close();
    }
  });

  it('persists an explicit title for a custom-colored first body H1 and reopens it safely', async () => {
    const noteFile = 'Notes.md';
    const original = 'Original text.\n';
    const vault = new ObservedMemoryVault({
      [noteFile]: original,
      '.morrow/workspace.json': registryFor({ [noteFile]: 'heading-page' }),
    });
    let session: WorkspaceSession | undefined;
    let reopened: WorkspaceSession | undefined;
    try {
      session = await open(vault);
      const headingDoc: DocNode = {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 1, backgroundColor: '#2f80ed' },
            content: [{ type: 'text', text: 'Body heading' }],
          },
        ],
      };
      expect(session.execute({ type: 'page.setDoc', id: 'heading-page', doc: headingDoc, now: 42 }).ok).toBe(
        true,
      );
      expect(await session.flush()).toBe(true);
      const saved = vault.text(noteFile)!;
      expect(saved).toMatch(/^---\ntitle: Notes\n---\n/);
      expect(saved).toMatch(/<!-- morrow:block-background:#2f80ed -->\s+# Body heading/);
      expect(findUnrepresentablePageContent(saved)).toBeNull();
      await session.close();
      session = undefined;

      reopened = await open(vault);
      expect(reopened.protectedReasons.has('heading-page')).toBe(false);
      expect(reopened.getState().docs['heading-page']!.content?.[0]).toMatchObject({
        type: 'heading',
        attrs: { level: 1, backgroundColor: '#2f80ed' },
      });
    } finally {
      if (session && !session.isClosed) await session.close();
      if (reopened && !reopened.isClosed) await reopened.close();
    }
  });

  it('preserves a concurrent external marker and attachment during the write retry check', async () => {
    const marker = '<!-- morrow:block-background:#2f80ed -->';
    const external = `${marker}\n\n[file](assets/a.pdf)\n`;
    const noteFile = 'Notes.md';
    const vault = new ObservedMemoryVault({
      [noteFile]: 'Original text.\n',
      'assets/a.pdf': 'attachment bytes',
      '.morrow/workspace.json': registryFor({ [noteFile]: 'note-page' }),
    });
    let session: WorkspaceSession | undefined;
    try {
      session = await open(vault);
      const callsBeforeEdit = vault.applyCalls.length;
      const current = session.getState().docs['note-page']!;
      const edited: DocNode = {
        ...current,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Staged edit.' }] }],
      };
      expect(session.execute({ type: 'page.setDoc', id: 'note-page', doc: edited, now: 41 }).ok).toBe(true);
      // Simulate a disk change after the staged edit but before the vault watcher reports it.
      vault.files.set(noteFile, external);
      expect(await session.flush()).toBe(false);
      expect(session.saveStatus).toMatchObject({ state: 'error' });
      expect(session.saveStatus.error).toMatch(/changed on disk.*cannot safely represent/i);
      expect(vault.text(noteFile)).toBe(external);
      expect(vault.text('assets/a.pdf')).toBe('attachment bytes');
      const noteWriteAttempts = vault.applyCalls
        .slice(callsBeforeEdit)
        .flatMap((batch) =>
          batch.filter((operation) => operation.op === 'write' && operation.path === noteFile),
        );
      expect(noteWriteAttempts).toHaveLength(1);
    } finally {
      if (session && !session.isClosed) await session.close();
    }
    expect(vault.text(noteFile)).toBe(external);
  });

  it('round-trips an empty colored paragraph through a synthetic br, including at document end', async () => {
    const marker = '<!-- morrow:block-background:#2f80ed -->';
    const empty: DocNode = { type: 'paragraph', attrs: { backgroundColor: '#2f80ed' }, content: [] };
    const sources = [
      docToMarkdown({ type: 'doc', content: [empty] }),
      docToMarkdown({
        type: 'doc',
        content: [empty, { type: 'paragraph', content: [{ type: 'text', text: 'After' }] }],
      }),
    ];
    for (const source of sources) {
      expect(source).toContain(`${marker}\n<br>`);
      expect(inspectBlockBackgroundMarkers(source)[0]?.approved).toBe(true);
      expect(findUnrepresentablePageContent(source)).toBeNull();
      const parsed = markdownToDoc(source);
      expect(parsed.content?.[0]).toMatchObject({
        type: 'paragraph',
        attrs: { backgroundColor: '#2f80ed' },
        content: [],
      });
      expect(docToMarkdown(parsed)).toBe(source);
    }

    const noteFile = 'Empty color.md';
    const original = `${marker}\n\nOriginal text.\n`;
    const vault = new ObservedMemoryVault({
      [noteFile]: original,
      '.morrow/workspace.json': registryFor({ [noteFile]: 'empty-page' }),
    });
    let session: WorkspaceSession | undefined;
    let reopened: WorkspaceSession | undefined;
    try {
      session = await open(vault);
      const emptyDoc: DocNode = { type: 'doc', content: [empty] };
      expect(session.execute({ type: 'page.setDoc', id: 'empty-page', doc: emptyDoc, now: 40 }).ok).toBe(
        true,
      );
      expect(await session.flush()).toBe(true);
      const saved = vault.text(noteFile)!;
      expect(saved).toContain(`${marker}\n<br>`);
      expect(findUnrepresentablePageContent(saved)).toBeNull();
      await session.close();
      session = undefined;

      reopened = await open(vault);
      expect(reopened.protectedReasons.has('empty-page')).toBe(false);
      expect(reopened.getState().docs['empty-page']!.content?.[0]).toMatchObject({
        type: 'paragraph',
        attrs: { backgroundColor: '#2f80ed' },
        content: [],
      });
    } finally {
      if (session && !session.isClosed) await session.close();
      if (reopened && !reopened.isClosed) await reopened.close();
    }
  });

  it('reopens an empty colored paragraph inside a list after a neighboring edit', async () => {
    const marker = '<!-- morrow:block-background:#2f80ed -->';
    const empty: DocNode = { type: 'paragraph', attrs: { backgroundColor: '#2f80ed' }, content: [] };
    const source = docToMarkdown({
      type: 'doc',
      content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [empty] }] }],
    });
    expect(source).toContain(`${marker}`);
    expect(inspectBlockBackgroundMarkers(source)[0]?.approved).toBe(true);
    expect(findUnrepresentablePageContent(source)).toBeNull();
    const vault = new ObservedMemoryVault({
      'List empty.md': source,
      '.morrow/workspace.json': registryFor({ 'List empty.md': 'list-empty' }),
    });
    let session: WorkspaceSession | undefined;
    let reopened: WorkspaceSession | undefined;
    try {
      session = await open(vault);
      expect(session.protectedReasons.has('list-empty')).toBe(false);
      const current = session.getState().docs['list-empty']!;
      const edited: DocNode = {
        ...current,
        content: [
          ...(current.content ?? []),
          { type: 'paragraph', content: [{ type: 'text', text: 'Neighbor edit.' }] },
        ],
      };
      expect(session.execute({ type: 'page.setDoc', id: 'list-empty', doc: edited, now: 43 }).ok).toBe(true);
      expect(await session.flush()).toBe(true);
      const saved = vault.text('List empty.md')!;
      expect(findUnrepresentablePageContent(saved)).toBeNull();
      expect(saved).toContain(marker);
      expect(saved).toContain('Neighbor edit.');
      await session.close();
      session = undefined;

      reopened = await open(vault);
      expect(reopened.protectedReasons.has('list-empty')).toBe(false);
      expect(docToMarkdown(reopened.getState().docs['list-empty']!)).toContain(marker);
      expect(docToMarkdown(reopened.getState().docs['list-empty']!)).toContain('Neighbor edit.');
    } finally {
      if (session && !session.isClosed) await session.close();
      if (reopened && !reopened.isClosed) await reopened.close();
    }
  });

  it('allows only exact markers bound to supported standalone blocks', () => {
    const marker = '<!-- morrow:block-background:#2f80ed -->';
    const invalid = [
      marker,
      `${marker}\n\n${marker}\n\nDuplicate target.`,
      `Inline ${marker} text.`,
      `<details>\n<summary>Hidden</summary>\n\n${marker}\n\nInside.\n\n</details>`,
      `<div>\n${marker}\n\nInside raw wrapper.\n\n</div>`,
      `- \n  ${marker}\n\n  [ ] Ambiguous task paragraph.`,
      `| ${marker} |\n| --- |\n| Cell |`,
      `${marker}\n\n# Consumed title`,
      `${marker.replace('#2f80ed', '#2f80e')}\n\nParagraph.`,
      '<!-- morrow:future-layout:v1:opaque -->',
      '<p data-block-background="#2f80ed">Unsupported HTML</p>',
    ];
    for (const source of invalid) {
      expect(findUnrepresentablePageContent(source), source).toMatch(
        /morrow block marker|layout or block identifier/i,
      );
    }

    const explicitTitle = `---\ntitle: Explicit\n---\n${marker}\n\n# Body heading\n`;
    expect(findUnrepresentablePageContent(explicitTitle)).toBeNull();
    const literal = `\`\`\`markdown\n${marker}\n\`\`\`\n`;
    expect(findUnrepresentablePageContent(literal)).toBeNull();
  });

  it('keeps exact inline colors through a core save and reopen without the Documento plugin', async () => {
    const source = [
      '# <span style="color: #12AB34">Title</span>',
      '',
      '<mark style="background: #ABCDEF"><span style="color: #FEDCBA">Overlapping marks</span></mark> and <span style="color: red">preset</span>',
    ].join('\n');
    const vault = new MemoryVault({
      'Notes.md': source,
      '.morrow/workspace.json': registryFor({ 'Notes.md': 'note-page' }),
    });
    let first: WorkspaceSession | undefined;
    let reopened: WorkspaceSession | undefined;
    try {
      // The core session parses and persists this page without mounting the Documento plugin.
      first = await open(vault);
      expect(first.protectedReasons.has('note-page')).toBe(false);
      const current = first.getState().docs['note-page']!;
      expect(docToMarkdown(current)).toBe(
        '# <span style="color: #12ab34">Title</span>\n\n<mark style="background: #abcdef"><span style="color: #fedcba">Overlapping marks</span></mark> and <span style="color: #d44c47">preset</span>\n',
      );

      const edited: DocNode = {
        ...current,
        content: [
          ...(current.content ?? []),
          { type: 'paragraph', content: [{ type: 'text', text: 'Safe unrelated edit.' }] },
        ],
      };
      expect(first.execute({ type: 'page.setDoc', id: 'note-page', doc: edited, now: 30 }).ok).toBe(true);
      expect(await first.flush()).toBe(true);
      await first.close();
      first = undefined;

      const savedText = vault.text('Notes.md')!;
      expect(savedText).toContain('<span style="color: #12ab34">Title</span>');
      expect(savedText).toContain(
        '<mark style="background: #abcdef"><span style="color: #fedcba">Overlapping marks</span></mark>',
      );
      expect(savedText).toContain('Safe unrelated edit.');

      reopened = await open(vault);
      expect(reopened.protectedReasons.has('note-page')).toBe(false);
      const reopenedDoc = reopened.getState().docs['note-page']!;
      expect(docToMarkdown(reopenedDoc)).toBe(savedText);
      expect(reopenedDoc.content![0]!.content![0]!.marks).toEqual([
        { type: 'textColor', attrs: { color: '#12ab34' } },
      ]);
      expect(reopenedDoc.content![1]!.content![0]!.marks).toEqual([
        { type: 'highlight', attrs: { color: '#abcdef' } },
        { type: 'textColor', attrs: { color: '#fedcba' } },
      ]);
    } finally {
      if (first && !first.isClosed) await first.close();
      if (reopened && !reopened.isClosed) await reopened.close();
    }
  });

  it('protects 2.1 background metadata attached to the v1 atom', () => {
    expect(findUnrepresentablePageContent(`<!-- background: blue -->\n${viewMarker()}\n`)).toMatch(
      /polaris dados view/i,
    );
  });

  it.each([
    ['malformed v1 marker', '<!-- morrow:polaris-dados-view:v1:%%% -->'],
    ['future version marker', '<!-- morrow:polaris-dados-view:v2:opaque -->'],
    ['unknown future marker', '<!-- morrow:future-layout:v1:opaque -->'],
    ['duplicate view marker', `${viewMarker()}\n\n${viewMarker()}`],
  ])('preserves a %s as raw and read only content', async (_name, markerBody) => {
    const source = `# Note\n\n${markerBody}\n`;
    const vault = new MemoryVault({
      'Note.md': source,
      '.morrow/workspace.json': registryFor({ 'Note.md': 'note-page' }),
    });
    let session: WorkspaceSession | undefined;
    try {
      session = await open(vault);
      expect(session.protectedReasons.has('note-page')).toBe(true);
      expect(session.unreadable.has('note-page')).toBe(true);
      expect(session.getState().docs['note-page']).toEqual({
        type: 'doc',
        content: [{ type: 'rawBlock', attrs: { text: source } }],
      });
      expect(
        session.execute({
          type: 'page.setDoc',
          id: 'note-page',
          doc: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'replace' }] }],
          },
          now: 40,
        }).ok,
      ).toBe(false);
      expect(await session.flush()).toBe(true);
      expect(vault.text('Note.md')).toBe(source);
    } finally {
      if (session && !session.isClosed) await session.close();
    }
  });

  it('keeps unknown view fields protected', () => {
    expect(
      findUnrepresentablePageContent(databaseFile(['title', 'quantity'], '      futureMode: keep-me\n')),
    ).toMatch(/database view has fields/i);
  });
});

describe('E003 #233 published and future Markdown compatibility', () => {
  it('protects historical displayPropertyId YAML from the schema-12 source', async () => {
    await expectProtectedStorageSample({
      files: {
        [E003_FORMAT12_DATABASE_PATH]: E003_FORMAT12_DATABASE,
        [E003_FORMAT12_ROW_PATH]: E003_FORMAT12_ROW,
      },
      protectedPath: E003_FORMAT12_DATABASE_PATH,
      rowPath: E003_FORMAT12_ROW_PATH,
      reason: /database schema has unsupported fields/i,
      validYaml: true,
    });
  });

  it('protects published schema-13 titleAlias and displayPropertyId YAML', async () => {
    await expectProtectedStorageSample({
      files: {
        [E003_FORMAT13_DATABASE_PATH]: E003_FORMAT13_DATABASE,
        [E003_FORMAT13_ROW_PATH]: E003_FORMAT13_ROW,
      },
      protectedPath: E003_FORMAT13_DATABASE_PATH,
      rowPath: E003_FORMAT13_ROW_PATH,
      reason: /database schema has unsupported fields/i,
      validYaml: true,
    });
  });

  it('protects a published named-control writer output in isolation', async () => {
    await expectProtectedStorageSample({
      files: { [E003_PUBLISHED_NAMED_CONTROL_PATH]: E003_PUBLISHED_NAMED_CONTROL },
      protectedPath: E003_PUBLISHED_NAMED_CONTROL_PATH,
      reason: /Polaris data extension/i,
    });
  });

  it('protects a synthetic future database field and its child rows', async () => {
    await expectProtectedStorageSample({
      files: {
        [E003_FUTURE_DATABASE_PATH]: E003_FUTURE_DATABASE,
        [E003_FUTURE_ROW_PATH]: E003_FUTURE_ROW,
      },
      protectedPath: E003_FUTURE_DATABASE_PATH,
      rowPath: E003_FUTURE_ROW_PATH,
      reason: /database schema has unsupported fields/i,
      validYaml: true,
    });
  });

  it('keeps the current schema-3 Markdown database editable', async () => {
    const { vault, session } = await openObservedVault({
      [E003_CURRENT_SCHEMA3_DATABASE_PATH]: E003_CURRENT_SCHEMA3_DATABASE,
    });
    let reopened: WorkspaceSession | undefined;
    try {
      expect(session.firstRun).toBe(false);
      expect(findUnrepresentablePageContent(E003_CURRENT_SCHEMA3_DATABASE)).toBeNull();
      const id = pageIdAt(session, E003_CURRENT_SCHEMA3_DATABASE_PATH);
      expect(session.protectedReasons.has(id)).toBe(false);
      expect(session.unreadable.has(id)).toBe(false);

      const database = session.getState().pages[id]!.database!;
      const edited = session.execute({
        type: 'database.set',
        id,
        database: {
          ...database,
          views: database.views.map((view) => ({ ...view, name: 'Edited current view' })),
        },
        now: 50,
      });
      expect(edited.ok).toBe(true);
      expect(await session.flush()).toBe(true);
      expect(vault.applyCalls.length).toBeGreaterThan(0);
      expect(vault.text(E003_CURRENT_SCHEMA3_DATABASE_PATH)).toContain('Edited current view');
      await session.close();

      const reopenedResult = await WorkspaceSession.open(new VaultRepository(vault, newId), {
        delayMs: 0,
      });
      if (!reopenedResult.ok) throw new Error(reopenedResult.error);
      reopened = reopenedResult.value;
      const reopenedId = pageIdAt(reopened, E003_CURRENT_SCHEMA3_DATABASE_PATH);
      expect(reopened.getState().pages[reopenedId]!.database!.views[0]!.name).toBe('Edited current view');
    } finally {
      if (!session.isClosed) await session.close();
      if (reopened && !reopened.isClosed) await reopened.close();
    }
  });
});

describe('#300 reversible toggle compatibility boundaries', () => {
  const unsupportedToggles: Array<[string, string, RegExp]> = [
    [
      'a summary heading with unrepresented attributes',
      `<details>\n<summary data-block-background="#1a2b3c" data-morrow-summary-format="markdown"><h3 id="keep-anchor" class="keep">Title</h3></summary>\n\nBody.\n\n</details>\n`,
      /toggle summary/i,
    ],
    [
      'a summary-like tag inside an HTML comment',
      `<details>\n<!-- <summary class="presentation">Hidden</summary> -->\n\nBody.\n\n</details>`,
      /toggle summary/i,
    ],
    [
      'a source comment before a summary heading with an ID',
      `<details>\n<!-- preserve this comment -->\n<summary><h2 id="important">Title</h2></summary>\n\nBody.\n\n</details>`,
      /toggle summary/i,
    ],
    [
      'a colored summary nested in a list item',
      `- Item\n  <details>\n  <summary data-block-background="#2f80ed">Nested</summary>\n\n  Body.\n\n  </details>\n`,
      /toggle summary background/i,
    ],
    [
      'HTML appended after its details close tag',
      `<details>\n<summary>Title</summary>\n\nBody.\n\n</details><span data-keep="yes">Tail</span>\n`,
      /toggle close tag/i,
    ],
    [
      'an unterminated raw-text element inside a toggle',
      `<details>\n<summary data-block-background="#1a2b3c"><h2>Title</h2></summary>\n\n<textarea>Missing close: </details>\n\nOutside\n`,
      /unterminated opaque HTML/i,
    ],
    [
      'an EOF comment that hides a toggle close',
      `<details>\n<summary data-block-background="#1a2b3c"><h2>Title</h2></summary>\n\nInside.\n\n<!-- comment without an end\n</details>\n\nOutside\n`,
      /unterminated opaque HTML/i,
    ],
    [
      'an EOF comment after a quote-owned close literal',
      `<details>\n<summary data-block-background="#1a2b3c"><h2>Title</h2></summary>\n\nInside.\n\n> </details>\n\n<!-- comment without an end\n`,
      /unterminated opaque HTML/i,
    ],
  ];

  it.each(unsupportedToggles)('keeps %s read-only without a vault write', async (_name, source, reason) => {
    const notePath = 'Toggle.md';
    const { vault, session } = await openObservedVault({ [notePath]: source });
    const before = snapshotAllFiles(vault);
    try {
      const id = pageIdAt(session, notePath);
      expect(session.protectedReasons.get(id)).toMatch(reason);
      expect(session.unreadable.has(id)).toBe(true);
      expectRawSource(session, id, source);
      expect(vault.applyCalls).toHaveLength(0);
      expect(await session.flush()).toBe(true);
      expect(vault.applyCalls).toHaveLength(0);
      expect(snapshotAllFiles(vault)).toEqual(before);
    } finally {
      if (!session.isClosed) await session.close();
    }
  });

  it('accepts escaped closing-tag literals only when the title round-trips them as text', () => {
    const source = `<details open>\n<summary data-block-background="#1a2b3c"><h2>Before \\</summary> after and \\</details> after</h2></summary>\n\nBody.\n\n</details>\n`;
    expect(findUnrepresentablePageContent(source)).toBeNull();

    const parsed = markdownToDoc(source);
    const summary = parsed.content?.[0]?.content?.[0];
    expect(JSON.stringify(summary?.content)).toContain('Before </summary> after and </details> after');

    const saved = docToMarkdown(parsed);
    expect(saved).toContain('Before \\</summary> after and \\</details> after');
    expect(markdownToDoc(saved)).toEqual(parsed);
  });

  it('keeps a quote-owned raw closing-tag literal inside a toggle until the real owner close', () => {
    const source = `<details open>\n<summary>Toggle</summary>\n\nBefore.\n\n> </details>\n\nStill inside.\n\n</details>\n\nOutside\n`;
    expect(findUnrepresentablePageContent(source)).toBeNull();

    const parsed = markdownToDoc(source);
    expect(parsed.content?.[0]?.type).toBe('details');
    expect(JSON.stringify(parsed.content?.[0]?.content?.[1])).toContain('</details>');
    expect(JSON.stringify(parsed.content?.[0]?.content?.[1])).toContain('Still inside.');
    expect(parsed.content?.[1]?.content?.[0]?.text).toBe('Outside');
    expect(markdownToDoc(docToMarkdown(parsed))).toEqual(parsed);
  });

  it('keeps an attributed summary inside an opaque wrapper editable', async () => {
    const source = `<details>\n<summary data-block-background="#123456">A</summary>\n\n<div>\n<summary class="presentation">Opaque</summary>\n</div>\n\n</details>`;
    expect(findUnrepresentablePageContent(source)).toBeNull();

    const parsed = markdownToDoc(source);
    expect(parsed.content?.[0]?.content?.[1]?.content?.[0]).toEqual({
      type: 'rawBlock',
      attrs: { text: '<div>\n<summary class="presentation">Opaque</summary>\n</div>' },
    });
    expect(markdownToDoc(docToMarkdown(parsed))).toEqual(parsed);

    const { vault, session } = await openObservedVault({ 'Toggle.md': source });
    try {
      const id = pageIdAt(session, 'Toggle.md');
      expect(session.protectedReasons.get(id) ?? null).toBeNull();
      const doc = session.getState().docs[id]!;
      const edited: DocNode = {
        ...doc,
        content: [
          ...doc.content!,
          { type: 'paragraph', content: [{ type: 'text', text: 'Editable sibling.' }] },
        ],
      };
      expect(session.execute({ type: 'page.setDoc', id, doc: edited, now: 51 }).ok).toBe(true);
      expect(await session.flush()).toBe(true);
      expect(vault.text('Toggle.md')).toContain('<summary class="presentation">Opaque</summary>');
      expect(vault.text('Toggle.md')).toContain('Editable sibling.');
    } finally {
      if (!session.isClosed) await session.close();
    }
  });

  it.each([
    ['without summary metadata', '<summary>Title</summary>'],
    ['with a styled summary', '<summary data-block-background="#1a2b3c"><h2>Title</h2></summary>'],
  ])('keeps the raw HTML body close and following paragraph representable %s', (_name, summary) => {
    const source = `<details open>\n${summary}\n\n<p>Path</p>\\</details>\n\nOutside\n`;
    expect(findUnrepresentablePageContent(source)).toBeNull();

    const parsed = markdownToDoc(source);
    expect(parsed.content?.[0]?.type).toBe('details');
    expect(JSON.stringify(parsed.content?.[0]?.content?.[1])).toContain('<p>Path</p>');
    expect(JSON.stringify(parsed.content?.[0]?.content?.[1])).not.toContain('Outside');
    expect(parsed.content?.[1]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'Outside' }] });
  });

  it('allows a raw-text textarea in the body without absorbing the later paragraph', () => {
    const source = `<details open>\n<summary data-block-background="#1a2b3c"><h2>Title</h2></summary>\n\n<textarea>literal </details></textarea>\n\nInside toggle.\n\n</details>\n\nOutside\n`;
    expect(findUnrepresentablePageContent(source)).toBeNull();

    const parsed = markdownToDoc(source);
    expect(parsed.content?.[0]?.content?.[1]?.content?.[0]).toEqual({
      type: 'rawBlock',
      attrs: { text: '<textarea>literal </details></textarea>' },
    });
    expect(parsed.content?.[0]?.content?.[1]?.content?.[1]?.content?.[0]?.text).toBe('Inside toggle.');
    expect(parsed.content?.[1]?.content?.[0]?.text).toBe('Outside');
  });

  it('keeps sibling plaintext after a completed toggle editable', async () => {
    const source = `<details open>\n<summary>Title</summary>\n\nInside.\n\n</details>\n\n<plaintext>Sibling raw content\n`;
    expect(findUnrepresentablePageContent(source)).toBeNull();

    const { vault, session } = await openObservedVault({ 'Toggle.md': source });
    try {
      const id = pageIdAt(session, 'Toggle.md');
      expect(session.protectedReasons.get(id) ?? null).toBeNull();
      const doc = session.getState().docs[id]!;
      expect(doc.content?.[0]?.type).toBe('details');
      expect(doc.content?.[1]).toEqual({
        type: 'paragraph',
        content: [{ type: 'text', text: '<plaintext>Sibling raw content' }],
      });
      const edited: DocNode = {
        ...doc,
        content: [
          doc.content![0]!,
          { type: 'paragraph', content: [{ type: 'text', text: 'Editable before raw sibling.' }] },
          ...doc.content!.slice(1),
        ],
      };
      expect(session.execute({ type: 'page.setDoc', id, doc: edited, now: 50 }).ok).toBe(true);
      expect(await session.flush()).toBe(true);
      expect(vault.text('Toggle.md')).toContain('<plaintext>Sibling raw content');
      expect(vault.text('Toggle.md')).toContain('Editable before raw sibling.');
    } finally {
      if (!session.isClosed) await session.close();
    }
  });

  it.each([
    ['a details tag inside a raw wrapper', `<div>\n<details>\n</div>\n\n<!-- unfinished sibling comment`],
    ['a self-closing details tag', `<details/>\n\n<!-- unfinished sibling comment`],
  ])('does not treat %s as an open parser-owned toggle', (_name, source) => {
    expect(findUnrepresentablePageContent(source)).toBeNull();
  });
});
