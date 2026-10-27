import type { Editor } from '@tiptap/core';
import { closeHistory, history } from '@tiptap/pm/history';
import { Schema } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { EditorState } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';
import { planDatabaseCopy } from '../../core/databaseCopy';
import { emptyDoc, newPageMeta } from '../../core/model';
import type { DatabaseDef, DocNode } from '../../core/model';
import { MemoryVault } from '../../storage/memoryVault';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';
import { setSession } from '../workspace';
import { commitEditors, registerCommit, undoRedoEditor } from './commits';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
    pageLink: {
      inline: true,
      group: 'inline',
      atom: true,
      attrs: { id: { default: null }, label: { default: '' }, embed: { default: false } },
    },
    linkedDatabaseView: {
      group: 'block',
      atom: true,
      attrs: { hostPageId: { default: null }, sourceDatabaseId: { default: null } },
    },
  },
});

const database: DatabaseDef = {
  properties: [{ id: 'name', name: 'Name', type: 'text', options: [] }],
  views: [
    {
      id: 'view',
      name: 'All',
      type: 'table',
      filters: [],
      sorts: [],
      groupBy: null,
      dateProp: null,
      hidden: [],
    },
  ],
};

let idCounter = 0;
let repositoryCounter = 0;
const nextId = () => `copy-${++idCounter}`;

async function open(vault: MemoryVault): Promise<WorkspaceSession> {
  const opened = await WorkspaceSession.open(
    new VaultRepository(vault, () => `storage-${++repositoryCounter}`),
    {
      delayMs: 0,
    },
  );
  if (!opened.ok) throw new Error(opened.error);
  return opened.value;
}

function editorHarness() {
  let state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [schema.node('paragraph')]),
    plugins: [history()],
  });
  const editor = {
    get state() {
      return state;
    },
    view: {
      dom: {} as HTMLElement,
      dispatch(transaction: Transaction) {
        state = state.apply(transaction);
      },
    },
  } as unknown as Editor;
  return {
    editor,
    state: () => state,
    insertPageLink(id: string) {
      state = state.apply(
        state.tr.insert(1, schema.node('pageLink', { id, label: 'Items (copy)', embed: true })),
      );
    },
    deletePageLink() {
      state = state.apply(closeHistory(state.tr.delete(1, 2)));
    },
    insertLinkedView(sourceDatabaseId: string) {
      state = state.apply(
        state.tr.insert(0, schema.node('linkedDatabaseView', { hostPageId: 'host', sourceDatabaseId })),
      );
    },
  };
}

function countNode(doc: DocNode, type: string, id?: string): number {
  let count = 0;
  const visit = (node: DocNode) => {
    if (node.type === type && (id === undefined || node.attrs?.id === id)) count++;
    for (const child of node.content ?? []) visit(child);
  };
  visit(doc);
  return count;
}

async function seed(session: WorkspaceSession): Promise<void> {
  const host = newPageMeta({ id: 'host', parentId: null, title: 'Notes' });
  const source = newPageMeta({
    id: 'source',
    parentId: null,
    title: 'Items',
    kind: 'database',
    database,
  });
  const row = newPageMeta({
    id: 'source-row',
    parentId: 'source',
    title: 'Original row',
    properties: { name: 'Original value' },
  });
  const kept = newPageMeta({ id: 'kept', parentId: null, title: 'Unrelated work' });
  const result = session.execute({
    type: 'pages.insert',
    pages: [host, source, row, kept],
    docs: { host: emptyDoc(), source: emptyDoc(), 'source-row': emptyDoc(), kept: emptyDoc() },
  });
  if (!result.ok) throw new Error(result.error);
}

afterEach(() => {
  commitEditors();
});

describe('database paste history', () => {
  it.each([
    { includeRows: true, label: 'with records' },
    { includeRows: false, label: 'structure only' },
  ])('undoes and redoes a copied database $label without touching the source', async ({ includeRows }) => {
    const vault = new MemoryVault();
    const session = await open(vault);
    setSession(session);
    await seed(session);
    const plan = planDatabaseCopy(session.getState(), 'source', 'host', includeRows, nextId, 10, '(copy)');
    expect(plan).not.toBeNull();
    if (!plan) throw new Error('expected a database copy plan');

    const inserted = session.insertDatabasePaste(plan.databaseId, 'host', plan.pages, plan.docs);
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) throw new Error(inserted.error);

    const harness = editorHarness();
    harness.insertPageLink(plan.databaseId);
    const unregister = registerCommit(() => {
      const result = session.execute({
        type: 'page.setDoc',
        id: 'host',
        doc: harness.state().doc.toJSON() as DocNode,
        now: 20,
      });
      if (!result.ok) throw new Error(result.error);
    });
    let closed = false;
    try {
      commitEditors();
      await session.flush();
      const later = session.execute({
        type: 'page.create',
        id: 'later',
        parentId: null,
        title: 'Edited between paste and undo',
        now: 21,
      });
      expect(later.ok).toBe(true);
      const copiedRows = plan.pages.filter((page) => page.parentId === plan.databaseId);
      expect(session.getState().pages[plan.databaseId]).toBeDefined();
      expect(copiedRows.length).toBe(includeRows ? 1 : 0);
      expect(copiedRows.every((page) => session.getState().pages[page.id])).toBe(true);

      expect(undoRedoEditor(harness.editor, 'host', 'undo')).toBe(true);
      expect(countNode(harness.state().doc.toJSON() as DocNode, 'pageLink', plan.databaseId)).toBe(0);
      expect(session.getState().pages[plan.databaseId]).toBeUndefined();
      expect(session.getState().pages.source).toBeDefined();
      expect(session.getState().pages['source-row']?.properties.name).toBe('Original value');
      expect(session.getState().pages.kept).toBeDefined();
      expect(session.getState().pages.later).toBeDefined();

      expect(undoRedoEditor(harness.editor, 'host', 'redo')).toBe(true);
      expect(countNode(harness.state().doc.toJSON() as DocNode, 'pageLink', plan.databaseId)).toBe(1);
      expect(session.getState().pages[plan.databaseId]).toBeDefined();
      expect(copiedRows.every((page) => session.getState().pages[page.id])).toBe(true);

      expect(undoRedoEditor(harness.editor, 'host', 'undo')).toBe(true);
      await session.flush();
      await session.close();
      closed = true;

      const reopened = await open(vault);
      expect(reopened.getState().pages[plan.databaseId]).toBeUndefined();
      expect(copiedRows.every((page) => reopened.getState().pages[page.id] === undefined)).toBe(true);
      expect(reopened.getState().pages.source).toBeDefined();
      expect(reopened.getState().pages['source-row']?.properties.name).toBe('Original value');
      expect(reopened.getState().pages.kept).toBeDefined();
      expect(reopened.getState().pages.later).toBeDefined();
      expect(countNode(reopened.getState().docs.host!, 'pageLink', plan.databaseId)).toBe(0);
      await reopened.close();
    } finally {
      unregister();
      if (!closed) await session.close();
    }
  });

  it('keeps an edited copy and its link when undo would discard later work', async () => {
    const session = await open(new MemoryVault());
    setSession(session);
    await seed(session);
    const plan = planDatabaseCopy(session.getState(), 'source', 'host', true, nextId, 10, '(copy)')!;
    const inserted = session.insertDatabasePaste(plan.databaseId, 'host', plan.pages, plan.docs);
    expect(inserted.ok).toBe(true);
    const harness = editorHarness();
    harness.insertPageLink(plan.databaseId);
    const unregister = registerCommit(() => {
      const result = session.execute({
        type: 'page.setDoc',
        id: 'host',
        doc: harness.state().doc.toJSON() as DocNode,
        now: 20,
      });
      if (!result.ok) throw new Error(result.error);
    });
    try {
      const copyRow = plan.pages.find((page) => page.parentId === plan.databaseId)!;
      const changed = session.execute({
        type: 'page.setProperties',
        id: copyRow.id,
        values: { name: 'Edited after paste' },
        now: 30,
      });
      expect(changed.ok).toBe(true);

      expect(undoRedoEditor(harness.editor, 'host', 'undo')).toBe(true);
      expect(countNode(harness.state().doc.toJSON() as DocNode, 'pageLink', plan.databaseId)).toBe(1);
      expect(session.getState().pages[plan.databaseId]).toBeDefined();
      expect(session.getState().pages[copyRow.id]?.properties.name).toBe('Edited after paste');
    } finally {
      unregister();
      await session.close();
    }
  });

  it('keeps a copy when redo removes a link that the user deleted manually', async () => {
    const session = await open(new MemoryVault());
    setSession(session);
    await seed(session);
    const plan = planDatabaseCopy(session.getState(), 'source', 'host', true, nextId, 10, '(copy)')!;
    const inserted = session.insertDatabasePaste(plan.databaseId, 'host', plan.pages, plan.docs);
    expect(inserted.ok).toBe(true);
    const harness = editorHarness();
    harness.insertPageLink(plan.databaseId);
    const unregister = registerCommit(() => {
      const result = session.execute({
        type: 'page.setDoc',
        id: 'host',
        doc: harness.state().doc.toJSON() as DocNode,
        now: 20,
      });
      if (!result.ok) throw new Error(result.error);
    });
    try {
      harness.deletePageLink();
      commitEditors();
      expect(undoRedoEditor(harness.editor, 'host', 'undo')).toBe(true);
      expect(countNode(harness.state().doc.toJSON() as DocNode, 'pageLink', plan.databaseId)).toBe(1);
      expect(session.getState().pages[plan.databaseId]).toBeDefined();

      expect(undoRedoEditor(harness.editor, 'host', 'redo')).toBe(true);
      expect(countNode(harness.state().doc.toJSON() as DocNode, 'pageLink', plan.databaseId)).toBe(0);
      expect(session.getState().pages[plan.databaseId]).toBeDefined();
    } finally {
      unregister();
      await session.close();
    }
  });

  it('undoes a linked view by removing only its block', async () => {
    const session = await open(new MemoryVault());
    setSession(session);
    await seed(session);
    const harness = editorHarness();
    harness.insertLinkedView('source');
    const beforePages = session.getState().pages;
    expect(undoRedoEditor(harness.editor, 'host', 'undo')).toBe(true);
    expect(countNode(harness.state().doc.toJSON() as DocNode, 'linkedDatabaseView')).toBe(0);
    expect(session.getState().pages).toBe(beforePages);
    expect(session.getState().pages.source).toBeDefined();
    await session.close();
  });

  it('does not create pages if the paste destination disappears before the session command', async () => {
    const session = await open(new MemoryVault());
    setSession(session);
    await seed(session);
    const before = session.getState();
    const plan = planDatabaseCopy(session.getState(), 'source', 'host', true, nextId, 10, '(copy)')!;
    const inserted = session.insertDatabasePaste(plan.databaseId, 'missing-host', plan.pages, plan.docs);
    expect(inserted.ok).toBe(false);
    expect(session.getState()).toBe(before);
    expect(session.getState().pages[plan.databaseId]).toBeUndefined();
    await session.close();
  });
});
