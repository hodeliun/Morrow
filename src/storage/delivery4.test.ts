import { describe, expect, it } from 'vitest';
import type { Command } from '../core/commands';
import { valueOf } from '../core/database';
import type { DatabaseDef, PageId } from '../core/model';
import { parseGridClipboard, planGridClear, planGridPaste } from '../core/gridOperations';
import { MemoryVault } from './memoryVault';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';
import type { VaultOp, VaultOpResult } from '../core/vault/plan';

let generatedId = 0;

async function openSession(vault: MemoryVault): Promise<WorkspaceSession> {
  const result = await WorkspaceSession.open(
    new VaultRepository(vault, () => `synthetic-generated-${++generatedId}`),
    { delayMs: 0 },
  );
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function runAll(session: WorkspaceSession, commands: Command[]): void {
  const result = session.executeAll(commands);
  if (!result.ok) throw new Error(result.error);
}

function parseClipboard(text: string) {
  const result = parseGridClipboard(text);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function table(_title: string, properties: DatabaseDef['properties']): DatabaseDef {
  return {
    properties,
    views: [
      {
        id: 'grid',
        name: 'Grid',
        type: 'table',
        filters: [],
        sorts: [],
        hidden: [],
        groupBy: null,
        dateProp: null,
      },
    ],
  };
}

class FailOnceMemoryVault extends MemoryVault {
  failNextWrite = false;

  override async apply(ops: VaultOp[]): Promise<VaultOpResult[]> {
    const results: VaultOpResult[] = [];
    for (const op of ops) {
      if (this.failNextWrite && op.op === 'write') {
        this.failNextWrite = false;
        results.push({ ok: false, code: 'error', message: 'simulated grid save failure' });
        return results;
      }
      const [result] = await super.apply([op]);
      if (!result) return results;
      results.push(result);
      if (!result.ok) return results;
    }
    return results;
  }
}

describe('delivery 4 database grid operations through WorkspaceSession', () => {
  it('confirms overflow, undoes without deleting rows permanently, redoes, and reopens persisted rows', async () => {
    const vault = new MemoryVault();
    const session = await openSession(vault);
    runAll(session, [
      { type: 'page.create', id: 'items-db', parentId: null, title: 'Items', kind: 'database', now: 1 },
      {
        type: 'database.set',
        id: 'items-db',
        database: table('Items', [{ id: 'amount', name: 'Amount', type: 'number', options: [] }]),
        now: 1,
      },
      { type: 'page.create', id: 'item-1', parentId: 'items-db', title: 'Item 1', now: 1 },
      { type: 'page.create', id: 'item-2', parentId: 'items-db', title: 'Item 2', now: 1 },
      { type: 'page.setProperties', id: 'item-1', values: { amount: 10 }, now: 1 },
    ]);

    const before = session.getState();
    const failedBatch = session.executeAll([
      { type: 'page.rename', id: 'item-1', title: 'Must roll back', now: 2 },
      { type: 'page.rename', id: 'missing-row', title: 'Missing', now: 2 },
    ]);
    expect(failedBatch.ok).toBe(false);
    expect(session.getState()).toBe(before);

    const range = {
      anchor: { rowId: 'item-2' as PageId, colId: 'title' },
      focus: { rowId: 'item-2' as PageId, colId: 'title' },
    };
    const pending = planGridPaste(
      session.getState(),
      'items-db',
      range,
      parseClipboard('New 1\nNew 2\nNew 3'),
      ['item-1', 'item-2'],
      ['title'],
      3,
      { allowCreateRows: false },
    );
    expect(pending.ok).toBe(false);
    if (!pending.ok) expect(pending.extraRowsNeeded).toBe(2);
    expect(Object.keys(session.getState().pages).sort()).toEqual(Object.keys(before.pages).sort());

    const authorized = planGridPaste(
      session.getState(),
      'items-db',
      range,
      parseClipboard('New 1\nNew 2\nNew 3'),
      ['item-1', 'item-2'],
      ['title'],
      3,
      {
        allowCreateRows: true,
        newRowIdFactory: (() => {
          let n = 0;
          return () => `overflow-row-${++n}`;
        })(),
      },
    );
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) throw new Error(authorized.error);

    runAll(session, authorized.value.commands);
    expect(session.getState().pages['overflow-row-1']?.title).toBe('New 2');
    expect(session.getState().pages['overflow-row-2']?.title).toBe('New 3');

    runAll(session, authorized.value.undoCommands);
    expect(session.getState().pages['overflow-row-1']?.trashedAt).not.toBeNull();
    expect(session.getState().pages['overflow-row-2']?.trashedAt).not.toBeNull();
    expect(session.getState().pages['overflow-row-1']).toBeDefined();

    runAll(session, authorized.value.redoCommands);
    expect(session.getState().pages['overflow-row-1']?.trashedAt).toBeNull();
    expect(session.getState().pages['overflow-row-1']?.title).toBe('New 2');
    await session.flush();
    await session.close();

    const reopened = await openSession(vault);
    expect(reopened.getState().pages['overflow-row-1']?.title).toBe('New 2');
    expect(reopened.getState().pages['overflow-row-2']?.title).toBe('New 3');
    await reopened.close();
  });

  it('keeps a failed grid save pending and recovers it on retry', async () => {
    const vault = new FailOnceMemoryVault();
    const session = await openSession(vault);
    runAll(session, [
      { type: 'page.create', id: 'save-db', parentId: null, title: 'Save test', kind: 'database', now: 1 },
      { type: 'database.set', id: 'save-db', database: table('Save test', [{ id: 'note', name: 'Note', type: 'text', options: [] }]), now: 1 },
      { type: 'page.create', id: 'save-row', parentId: 'save-db', title: 'Before', now: 1 },
    ]);
    expect(await session.flush()).toBe(true);

    const plan = planGridPaste(
      session.getState(),
      'save-db',
      { anchor: { rowId: 'save-row', colId: 'title' }, focus: { rowId: 'save-row', colId: 'title' } },
      parseClipboard('After'),
      ['save-row'],
      ['title'],
      2,
    );
    if (!plan.ok) throw new Error(plan.error);
    vault.failNextWrite = true;
    runAll(session, plan.value.commands);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(session.saveStatus.state).toBe('error');
    expect(session.saveStatus.error).toContain('simulated grid save failure');

    expect(await session.flush()).toBe(true);
    expect(session.saveStatus.state).toBe('saved');
    await session.close();

    const reopened = await openSession(vault);
    expect(reopened.getState().pages['save-row']?.title).toBe('After');
    await reopened.close();
  });

  it('undoes inverse relation clears and restores owner rows displaced by paste, then survives reopening', async () => {
    const vault = new MemoryVault();
    const session = await openSession(vault);
    runAll(session, [
      { type: 'page.create', id: 'authors-db', parentId: null, title: 'Authors', kind: 'database', now: 1 },
      {
        type: 'database.set',
        id: 'authors-db',
        database: table('Authors', [
          { id: 'author-name', name: 'Name', type: 'text', options: [] },
          { id: 'books', name: 'Books', type: 'relation', options: [] },
        ]),
        now: 1,
      },
      { type: 'page.create', id: 'books-db', parentId: null, title: 'Books', kind: 'database', now: 1 },
      {
        type: 'database.set',
        id: 'books-db',
        database: table('Books', [
          { id: 'book-name', name: 'Name', type: 'text', options: [] },
          { id: 'author', name: 'Author', type: 'relation', options: [] },
        ]),
        now: 1,
      },
      { type: 'page.create', id: 'author-1', parentId: 'authors-db', title: 'Asha', now: 1 },
      { type: 'page.create', id: 'author-2', parentId: 'authors-db', title: 'Bela', now: 1 },
      { type: 'page.create', id: 'book-1', parentId: 'books-db', title: 'Dune', now: 1 },
      { type: 'page.create', id: 'book-2', parentId: 'books-db', title: 'Neuromancer', now: 1 },
      {
        type: 'relation.configure',
        databaseId: 'books-db',
        propertyId: 'author',
        relation: {
          targetDatabaseId: 'authors-db',
          multiple: false,
          isInverse: false,
          displayPropertyId: 'author-name',
          inversePropertyId: 'books',
          filters: [],
        },
        now: 2,
      },
      { type: 'relation.set', id: 'book-1', propertyId: 'author', value: 'author-1', now: 3 },
      { type: 'relation.set', id: 'book-2', propertyId: 'author', value: 'author-2', now: 3 },
    ]);

    const authorsDatabase = session.getState().pages['authors-db']!.database!;
    expect(valueOf(session.getState().pages['author-1']!, 'books', authorsDatabase, session.getState())).toEqual([
      'book-1',
    ]);

    const plan = planGridClear(
      session.getState(),
      'authors-db',
      {
        anchor: { rowId: 'author-1', colId: 'books' },
        focus: { rowId: 'author-1', colId: 'books' },
      },
      ['author-1'],
      ['books'],
      4,
    );
    if (!plan.ok) throw new Error(plan.error);
    runAll(session, plan.value.commands);
    expect(valueOf(session.getState().pages['author-1']!, 'books', authorsDatabase, session.getState())).toEqual([]);

    runAll(session, plan.value.undoCommands);
    expect(valueOf(session.getState().pages['author-1']!, 'books', authorsDatabase, session.getState())).toEqual([
      'book-1',
    ]);

    const paste = planGridPaste(
      session.getState(),
      'authors-db',
      {
        anchor: { rowId: 'author-1', colId: 'books' },
        focus: { rowId: 'author-2', colId: 'books' },
      },
      parseClipboard('book-2\nbook-1'),
      ['author-1', 'author-2'],
      ['books'],
      5,
    );
    expect(paste.ok).toBe(true);
    if (!paste.ok) throw new Error(paste.error);
    runAll(session, paste.value.commands);
    expect(valueOf(session.getState().pages['book-1']!, 'author', session.getState().pages['books-db']!.database!, session.getState())).toBe('author-2');
    expect(valueOf(session.getState().pages['book-2']!, 'author', session.getState().pages['books-db']!.database!, session.getState())).toBe('author-1');
    runAll(session, paste.value.undoCommands);
    expect(valueOf(session.getState().pages['book-1']!, 'author', session.getState().pages['books-db']!.database!, session.getState())).toBe('author-1');
    expect(valueOf(session.getState().pages['book-2']!, 'author', session.getState().pages['books-db']!.database!, session.getState())).toBe('author-2');
    expect(valueOf(session.getState().pages['author-1']!, 'books', authorsDatabase, session.getState())).toEqual(['book-1']);
    expect(valueOf(session.getState().pages['author-2']!, 'books', authorsDatabase, session.getState())).toEqual(['book-2']);
    runAll(session, paste.value.redoCommands);
    expect(valueOf(session.getState().pages['book-1']!, 'author', session.getState().pages['books-db']!.database!, session.getState())).toBe('author-2');
    expect(valueOf(session.getState().pages['book-2']!, 'author', session.getState().pages['books-db']!.database!, session.getState())).toBe('author-1');

    await session.flush();
    await session.close();

    const reopened = await openSession(vault);
    const reopenedAuthors = reopened.getState().pages['authors-db']!.database!;
    expect(valueOf(reopened.getState().pages['author-1']!, 'books', reopenedAuthors, reopened.getState())).toEqual(['book-2']);
    expect(valueOf(reopened.getState().pages['author-2']!, 'books', reopenedAuthors, reopened.getState())).toEqual(['book-1']);
    await reopened.close();
  });

  it('creates a new inverse relation from staged schemas and persists the projected links after reopening', async () => {
    const vault = new MemoryVault();
    const session = await openSession(vault);
    runAll(session, [
      { type: 'page.create', id: 'authors-db', parentId: null, title: 'Authors', kind: 'database', now: 1 },
      {
        type: 'database.set',
        id: 'authors-db',
        database: table('Authors', [{ id: 'author-name', name: 'Name', type: 'text', options: [] }]),
        now: 1,
      },
      { type: 'page.create', id: 'books-db', parentId: null, title: 'Books', kind: 'database', now: 1 },
      {
        type: 'database.set',
        id: 'books-db',
        database: table('Books', [{ id: 'author', name: 'Author', type: 'relation', options: [] }]),
        now: 1,
      },
      { type: 'page.create', id: 'author-1', parentId: 'authors-db', title: 'Ursula Le Guin', now: 1 },
      {
        type: 'page.create',
        id: 'book-1',
        parentId: 'books-db',
        title: 'A Wizard of Earthsea',
        properties: { author: 'author-1' },
        now: 1,
      },
      {
        type: 'relation.configure',
        databaseId: 'books-db',
        propertyId: 'author',
        relation: {
          targetDatabaseId: 'authors-db',
          multiple: false,
          isInverse: false,
          displayPropertyId: 'author-name',
          inversePropertyId: null,
          filters: [],
        },
        createInverseProperty: { id: 'author-books', name: 'Books', multiple: true },
        now: 2,
      },
    ]);

    const linkedState = session.getState();
    const authors = linkedState.pages['authors-db']!.database!;
    expect(
      authors.properties.find((property) => property.id === 'author-books')?.relation,
    ).toMatchObject({
      targetDatabaseId: 'books-db',
      isInverse: true,
      inversePropertyId: 'author',
    });
    expect(
      valueOf(linkedState.pages['author-1']!, 'author-books', authors, linkedState),
    ).toEqual(['book-1']);

    expect(await session.flush()).toBe(true);
    await session.close();

    const reopened = await openSession(vault);
    const reopenedState = reopened.getState();
    const reopenedAuthors = reopenedState.pages['authors-db']!.database!;
    expect(
      reopenedAuthors.properties.find((property) => property.id === 'author-books')?.relation,
    ).toMatchObject({
      targetDatabaseId: 'books-db',
      isInverse: true,
      inversePropertyId: 'author',
    });
    expect(
      valueOf(reopenedState.pages['author-1']!, 'author-books', reopenedAuthors, reopenedState),
    ).toEqual(['book-1']);
    await reopened.close();
  });
});
