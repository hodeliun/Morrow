import { describe, expect, it } from 'vitest';
import type { DocNode } from '../core/model';
import { docToMarkdown } from '../core/markdown/serialize';
import { markdownToDoc } from '../core/markdown/parse';
import { encodePolarisDadosViewMarker } from '../core/polarisDadosView';
import { findUnrepresentablePageContent } from '../core/vault/compatibility';
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
