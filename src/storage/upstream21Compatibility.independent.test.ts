import { describe, expect, it } from 'vitest';
import { walk } from '../core/doc';
import type { DocNode } from '../core/model';
import { docToMarkdown } from '../core/markdown/serialize';
import { encodePolarisDadosViewMarker } from '../core/polarisDadosView';
import { MemoryVault } from './memoryVault';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';

let generatedId = 0;
const newId = () => `independent-164-${++generatedId}`;

function databaseFile(columns: unknown, extraViewFields = ''): string {
  const serializedColumns = JSON.stringify(columns);
  if (serializedColumns === undefined) throw new Error('Columns must be JSON serializable.');
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
      columns: ${serializedColumns}
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

function snapshot(vault: MemoryVault, paths: readonly string[]) {
  return Object.fromEntries(
    paths.map((path) => [path, { text: vault.text(path), modifiedAt: vault.modifiedTime(path) }]),
  );
}

function linkedViewMarker(): string {
  return encodePolarisDadosViewMarker({
    version: 1,
    viewId: 'independent-linked-view',
    sourceDatabaseId: 'source-database-not-present',
    title: 'Cross-version view',
    columnOrder: ['name', 'retired property / opaque id'],
    filter: null,
  });
}

function markerWithExtraAttribute(): string {
  const payload = JSON.stringify({
    version: 1,
    viewId: 'unknown-attribute-view',
    sourceDatabaseId: 'opaque-source',
    title: 'Unknown attribute',
    columnOrder: ['name'],
    filter: null,
    futureAttribute: { id: 'must-not-be-dropped' },
  });
  const base64url = btoa(payload).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `<!-- morrow:polaris-dados-view:v1:${base64url} -->`;
}

const VALID_COLUMNS = (() => {
  const columns = Array.from({ length: 200 }, (_, index) => `opaque-column-${index}`);
  columns[0] = 'name';
  columns[198] = 'x'.repeat(64);
  columns[199] = 'retired property / opaque id';
  return columns;
})();

const MIXED_MARKDOWN = [
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
  linkedViewMarker(),
  '',
].join('\n');

describe('independent Morrow 2.1 compatibility checks', () => {
  it('keeps the 200-column order, stable page IDs, row values, and mixed markers through a real save cycle', async () => {
    const databasePath = 'Inventory.md';
    const rowPath = 'Inventory/Widget.md';
    const notePath = 'Notes.md';
    const initialDatabase = databaseFile(VALID_COLUMNS);
    const initialRow = `---
Name: Widget
Quantity: 2
Price: 10
auditRecord:
  opaqueId: row-from-another-version-71
---
Synthetic row.
`;
    const vault = new MemoryVault({
      [databasePath]: initialDatabase,
      [rowPath]: initialRow,
      [notePath]: MIXED_MARKDOWN,
      '.morrow/workspace.json': registryFor({
        [databasePath]: 'inventory-stable-id',
        [rowPath]: 'widget-stable-id',
        [notePath]: 'notes-stable-id',
      }),
    });
    const pagePaths = [databasePath, rowPath, notePath];
    const beforeOpen = snapshot(vault, pagePaths);
    let first: WorkspaceSession | undefined;
    let reopened: WorkspaceSession | undefined;
    try {
      first = await open(vault);
      expect(await first.flush()).toBe(true);
      expect(snapshot(vault, pagePaths)).toEqual(beforeOpen);

      const databaseId = pageIdAt(first, databasePath);
      const rowId = pageIdAt(first, rowPath);
      const noteId = pageIdAt(first, notePath);
      expect(databaseId).toBe('inventory-stable-id');
      expect(rowId).toBe('widget-stable-id');
      expect(noteId).toBe('notes-stable-id');
      expect(first.protectedReasons.has(databaseId)).toBe(false);
      expect(first.protectedReasons.has(noteId)).toBe(false);
      expect(first.getState().pages[databaseId]!.database!.views[0]!.columns).toEqual(VALID_COLUMNS);
      expect(first.getState().pages[rowId]!.properties).toMatchObject({ quantity: 2, price: 10 });
      expect(first.getState().pages[rowId]!.extra.auditRecord).toEqual({
        opaqueId: 'row-from-another-version-71',
      });

      const linkedIds: string[] = [];
      walk(first.getState().docs[noteId]!, (node) => {
        if (node.type === 'polarisDadosView' && typeof node.attrs?.viewId === 'string') {
          linkedIds.push(node.attrs.viewId);
        }
      });
      expect(linkedIds).toEqual(['independent-linked-view']);

      const database = first.getState().pages[databaseId]!.database!;
      expect(
        first.execute({
          type: 'database.set',
          id: databaseId,
          database: {
            ...database,
            views: database.views.map((view) => ({ ...view, name: 'Table saved by validator' })),
          },
          now: 100,
        }).ok,
      ).toBe(true);
      expect(first.execute({ type: 'page.setProperties', id: rowId, values: { quantity: 9 }, now: 101 }).ok).toBe(
        true,
      );
      const currentDoc = first.getState().docs[noteId]!;
      const editedDoc: DocNode = {
        ...currentDoc,
        content: [
          ...(currentDoc.content ?? []),
          { type: 'paragraph', content: [{ type: 'text', text: 'Saved after opening the 2.1 vault.' }] },
        ],
      };
      expect(first.execute({ type: 'page.setDoc', id: noteId, doc: editedDoc, now: 102 }).ok).toBe(true);
      expect(await first.flush()).toBe(true);
      await first.close();
      first = undefined;

      const savedDatabase = vault.text(databasePath)!;
      expect(savedDatabase).toContain('columns:');
      expect(vault.text(rowPath)).toContain('row-from-another-version-71');
      expect(vault.text(notePath)).toContain('<!-- background: blue -->');
      expect(vault.text(notePath)).toContain('<!-- letters -->');
      expect(vault.text(notePath)).toContain('<!-- column-widths: 240 0 -->');
      expect(vault.text(notePath)).toContain(linkedViewMarker());

      reopened = await open(vault);
      expect(pageIdAt(reopened, databasePath)).toBe(databaseId);
      expect(pageIdAt(reopened, rowPath)).toBe(rowId);
      expect(pageIdAt(reopened, notePath)).toBe(noteId);
      expect(reopened.getState().pages[databaseId]!.database!.views[0]!.columns).toEqual(VALID_COLUMNS);
      expect(reopened.getState().pages[databaseId]!.database!.views[0]!.name).toBe('Table saved by validator');
      expect(reopened.getState().pages[rowId]!.properties).toMatchObject({ quantity: 9, price: 10 });
      expect(reopened.getState().pages[rowId]!.extra.auditRecord).toEqual({
        opaqueId: 'row-from-another-version-71',
      });
      const reopenedMarkdown = docToMarkdown(reopened.getState().docs[noteId]!);
      expect(reopenedMarkdown).toContain('<!-- background: blue -->');
      expect(reopenedMarkdown).toContain('<!-- letters -->');
      expect(reopenedMarkdown).toContain('<!-- column-widths: 240 0 -->');
      expect(reopenedMarkdown).toContain(linkedViewMarker());
      expect(reopenedMarkdown).toContain('Saved after opening the 2.1 vault.');
    } finally {
      if (first && !first.isClosed) await first.close();
      if (reopened && !reopened.isClosed) await reopened.close();
    }
  });

  const invalidSchemas: ReadonlyArray<{ label: string; columns: unknown; extraViewFields?: string }> = [
    { label: 'empty array', columns: [] },
    { label: 'empty ID', columns: ['name', ''] },
    { label: '65-character ID', columns: ['x'.repeat(65)] },
    { label: 'duplicate ID', columns: ['name', 'name'] },
    { label: '201 entries', columns: Array.from({ length: 201 }, (_, index) => `column-${index}`) },
    { label: 'unknown view field', columns: ['name'], extraViewFields: '      futureSelector: keep-raw\n' },
  ];

  it.each(invalidSchemas)('keeps a protected $label database byte-for-byte untouched', async ({ columns, extraViewFields }) => {
    const databasePath = 'Inventory.md';
    const rowPath = 'Inventory/Widget.md';
    const rawDatabase = databaseFile(columns, extraViewFields);
    const rawRow = '---\nName: Widget\nQuantity: 2\n---\nSynthetic row.\n';
    const vault = new MemoryVault({
      [databasePath]: rawDatabase,
      [rowPath]: rawRow,
      '.morrow/workspace.json': registryFor({
        [databasePath]: 'protected-database-id',
        [rowPath]: 'protected-row-id',
      }),
    });
    const beforeOpen = snapshot(vault, [databasePath, rowPath]);
    let session: WorkspaceSession | undefined;
    try {
      session = await open(vault);
      expect(session.protectedReasons.get('protected-database-id')).toMatch(/database/i);
      expect(session.unreadable.has('protected-database-id')).toBe(true);
      expect(session.protectedReasons.get('protected-row-id')).toMatch(/parent database is protected/i);
      expect(session.unreadable.has('protected-row-id')).toBe(true);
      expect(session.getState().docs['protected-database-id']?.content?.[0]).toMatchObject({
        type: 'rawBlock',
        attrs: { text: rawDatabase },
      });
      expect(
        session.execute({ type: 'page.rename', id: 'protected-database-id', title: 'Unsafe rewrite', now: 200 }).ok,
      ).toBe(false);
      expect(await session.flush()).toBe(true);
    } finally {
      if (session && !session.isClosed) await session.close();
    }
    expect(snapshot(vault, [databasePath, rowPath])).toEqual(beforeOpen);
  });

  it('keeps a v1 linked-view marker with an unknown atom attribute raw and read only', async () => {
    const notePath = 'Note.md';
    const rawNote = `Before the linked view.\n\n${markerWithExtraAttribute()}\n\nAfter it.\n`;
    const vault = new MemoryVault({
      [notePath]: rawNote,
      '.morrow/workspace.json': registryFor({ [notePath]: 'extra-attribute-note-id' }),
    });
    const beforeOpen = snapshot(vault, [notePath]);
    let session: WorkspaceSession | undefined;
    try {
      session = await open(vault);
      expect(session.protectedReasons.has('extra-attribute-note-id')).toBe(true);
      expect(session.unreadable.has('extra-attribute-note-id')).toBe(true);
      expect(session.getState().docs['extra-attribute-note-id']?.content?.[0]).toMatchObject({
        type: 'rawBlock',
        attrs: { text: rawNote },
      });
      expect(
        session.execute({
          type: 'page.setDoc',
          id: 'extra-attribute-note-id',
          doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'replace' }] }] },
          now: 300,
        }).ok,
      ).toBe(false);
      expect(await session.flush()).toBe(true);
    } finally {
      if (session && !session.isClosed) await session.close();
    }
    expect(snapshot(vault, [notePath])).toEqual(beforeOpen);
  });
});
