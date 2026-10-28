import { describe, expect, it } from 'vitest';
import type { Command } from '../core/commands';
import type { DatabaseDef, PropDef, WorkspaceState } from '../core/model';
import { childrenOf } from '../core/tree';
import type { VaultOp, VaultOpResult } from '../core/vault/plan';
import { planTableAction } from '../core/tableActions';
import {
  asTableActionPlan,
  planDuplicateRows,
  planInsertRow,
  planMoveRows,
  planPasteRows,
  suggestRowPropertyMappings,
} from '../core/rowOperations';
import { createRowClipboardPayload } from '../core/rowClipboard';
import { MemoryVault } from './memoryVault';
import { WorkspaceSession } from './session';
import type { VaultRepository } from './vaultRepository';
import { VaultRepository as FileVaultRepository } from './vaultRepository';
import {
  executeTableAction,
  readTableActionJournal,
  recoverTableAction,
  TABLE_ACTION_JOURNAL_META,
  undoTableAction,
} from './tableActions';

let idCounter = 0;
const nextId = () => `action-test-${++idCounter}`;

const formulas = (source: string) => ({ source, bindings: [] });

function definitions(): DatabaseDef {
  const actionA: NonNullable<PropDef['action']> = {
    label: 'Update open rows',
    icon: 'play',
    color: 'blue',
    steps: [
      {
        id: 'update-open',
        type: 'modifyRows',
        target: 'matchingRows',
        where: formulas('true'),
        values: { value: formulas('prop("Value") + 1') },
      },
    ],
  };
  const actionB: NonNullable<PropDef['action']> = {
    label: 'Update this row',
    icon: 'check',
    color: 'green',
    steps: [
      {
        id: 'update-current',
        type: 'modifyRows',
        target: 'currentRow',
        values: { value: formulas('prop("Value") + 10') },
      },
    ],
  };
  const addRows: NonNullable<PropDef['action']> = {
    label: 'Add two rows',
    icon: 'plus',
    color: 'purple',
    steps: [
      {
        id: 'add-two',
        type: 'addRows',
        count: formulas('2'),
        title: formulas('concat("Added ", CurrentValue)'),
        values: { value: formulas('CurrentValue') },
      },
    ],
  };
  const properties: PropDef[] = [
    { id: 'status', name: 'Status', type: 'text', options: [] },
    { id: 'value', name: 'Value', type: 'number', options: [] },
    { id: 'action-a', name: 'Update open rows', type: 'button', options: [], action: actionA },
    { id: 'action-b', name: 'Update this row', type: 'button', options: [], action: actionB },
    { id: 'add-rows', name: 'Add two rows', type: 'button', options: [], action: addRows },
  ];
  return { properties, views: [] };
}

class FailingWriteVault extends MemoryVault {
  inspectActionWrites = false;
  databaseFirstPageWriteOrder = false;
  failOnPageWrite = 0;
  pageWriteCount = 0;
  journalAtFirstPageWrite: string | null = null;
  registryAtFirstPageWrite: string | null = null;

  override async apply(ops: VaultOp[]): Promise<VaultOpResult[]> {
    const results: VaultOpResult[] = [];
    const orderedOps = this.databaseFirstPageWriteOrder ? databasePageWritesFirst(ops) : ops;
    for (const op of orderedOps) {
      if (this.inspectActionWrites && op.op === 'write' && op.path.toLowerCase().endsWith('.md')) {
        if (this.pageWriteCount === 0) {
          this.journalAtFirstPageWrite = this.text(`.morrow/${TABLE_ACTION_JOURNAL_META}`) ?? null;
          this.registryAtFirstPageWrite = this.text('.morrow/workspace.json') ?? null;
        }
        this.pageWriteCount++;
        if (this.failOnPageWrite > 0 && this.pageWriteCount === this.failOnPageWrite) {
          results.push({ ok: false, code: 'error', message: 'simulated page write failure' });
          return results;
        }
      }
      const [result] = await super.apply([op]);
      if (!result) return results;
      results.push(result);
      if (!result.ok) return results;
    }
    return results;
  }
}

function databasePageWritesFirst(ops: VaultOp[]): VaultOp[] {
  const ordered = [...ops];
  const indexes = ops.flatMap((op, index) =>
    op.op === 'write' && op.path.toLowerCase().endsWith('.md') ? [index] : [],
  );
  const pageWrites = indexes
    .map((index) => ops[index]!)
    .filter((op): op is Extract<VaultOp, { op: 'write' }> => op.op === 'write')
    .sort((left, right) => {
      const depth = (path: string) => path.split('/').length;
      return depth(left.path) - depth(right.path);
    });
  indexes.forEach((index, position) => {
    ordered[index] = pageWrites[position]!;
  });
  return ordered;
}

async function open(vault: MemoryVault): Promise<{ session: WorkspaceSession; repository: VaultRepository }> {
  const repository = new FileVaultRepository(vault, nextId);
  const opened = await WorkspaceSession.open(repository, { delayMs: 0 });
  if (!opened.ok) throw new Error(opened.error);
  return { session: opened.value, repository };
}

async function seed(session: WorkspaceSession): Promise<void> {
  const commands: Command[] = [
    {
      type: 'page.create',
      id: 'table',
      parentId: null,
      title: 'Items',
      kind: 'database',
      database: definitions(),
      now: 1,
    },
    {
      type: 'page.create',
      id: 'row-one',
      parentId: 'table',
      title: 'One',
      properties: { status: 'Open', value: 0 },
      now: 1,
    },
    {
      type: 'page.create',
      id: 'row-two',
      parentId: 'table',
      title: 'Two',
      properties: { status: 'Open', value: 0 },
      now: 1,
    },
  ];
  const result = session.executeAll(commands);
  if (!result.ok) throw new Error(result.error);
  if (!(await session.flush())) throw new Error('Could not save the test workspace.');
}

function plan(session: WorkspaceSession, propId: string, rowId = 'row-one') {
  const result = planTableAction(session.getState(), 'table', rowId, propId, nextId, 100);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function crash(session: WorkspaceSession, repository: VaultRepository): void {
  session.queue.dispose();
  repository.close();
}

function valueOf(state: WorkspaceState, rowId: string): unknown {
  return state.pages[rowId]?.properties.value;
}

describe('table action persistence', () => {
  it('journals before page writes and recovers a second-file failure after reopening', async () => {
    const vault = new FailingWriteVault();
    const first = await open(vault);
    await seed(first.session);
    const actionPlan = plan(first.session, 'action-a');

    vault.inspectActionWrites = true;
    vault.failOnPageWrite = 2;
    const result = await executeTableAction(first.session, actionPlan, 100);
    expect(result.status).toBe('pending');
    expect(vault.journalAtFirstPageWrite).not.toBeNull();
    expect(JSON.parse(vault.journalAtFirstPageWrite!).status).toBe('prepared');
    crash(first.session, first.repository);

    vault.inspectActionWrites = false;
    const reopened = await open(vault);
    const recovered = await recoverTableAction(reopened.session);
    expect(recovered.status).toBe('complete');
    expect(valueOf(reopened.session.getState(), 'row-one')).toBe(1);
    expect(valueOf(reopened.session.getState(), 'row-two')).toBe(1);
    expect((await readTableActionJournal(reopened.session))?.status).toBe('complete');
    await reopened.session.close();
  });

  it('does not replace an unresolved journal when a different button is run', async () => {
    const vault = new FailingWriteVault();
    const first = await open(vault);
    await seed(first.session);
    vault.inspectActionWrites = true;
    vault.failOnPageWrite = 2;
    const pending = await executeTableAction(first.session, plan(first.session, 'action-a'), 100);
    expect(pending.status).toBe('pending');
    const journalId = pending.journal?.id;
    crash(first.session, first.repository);

    vault.inspectActionWrites = false;
    const reopened = await open(vault);
    const changedRow = ['row-one', 'row-two'].find((id) => valueOf(reopened.session.getState(), id) === 1);
    expect(changedRow).toBeTruthy();
    const edit = reopened.session.execute({
      type: 'page.setProperties',
      id: changedRow!,
      values: { value: 77 },
      now: 200,
    });
    expect(edit.ok).toBe(true);
    expect(await reopened.session.flush()).toBe(true);

    const otherButton = plan(reopened.session, 'action-b', changedRow!);
    const blocked = await executeTableAction(reopened.session, otherButton, 300);
    expect(blocked.status).toBe('failed');
    expect(blocked.message).toContain('previous action recovery');
    const journal = await readTableActionJournal(reopened.session);
    expect(journal?.id).toBe(journalId);
    expect(journal?.status).toBe('conflict');
    await reopened.session.close();
  });

  it('undoes untouched records while preserving a row edited after the action', async () => {
    const vault = new MemoryVault();
    const { session, repository } = await open(vault);
    await seed(session);
    const result = await executeTableAction(session, plan(session, 'action-a'), 100);
    expect(result.status).toBe('saved');

    const edit = session.execute({
      type: 'page.setProperties',
      id: 'row-one',
      values: { value: 77 },
      now: 200,
    });
    expect(edit.ok).toBe(true);
    expect(await session.flush()).toBe(true);
    const undone = await undoTableAction(session);
    expect(undone.status).toBe('undone');
    expect(valueOf(session.getState(), 'row-one')).toBe(77);
    expect(valueOf(session.getState(), 'row-two')).toBe(0);
    expect(undone.status === 'undone' && undone.journal.conflicts).toContain('row-one');
    await session.close();
    repository.close();
  });

  it('permanently removes action-created rows on undo', async () => {
    const vault = new MemoryVault();
    const { session } = await open(vault);
    await seed(session);
    const added = await executeTableAction(session, plan(session, 'add-rows'), 100);
    expect(added.status).toBe('saved');
    expect(Object.values(session.getState().pages).filter((page) => page.parentId === 'table')).toHaveLength(
      4,
    );

    const undone = await undoTableAction(session);
    expect(undone.status).toBe('undone');
    expect(Object.values(session.getState().pages).filter((page) => page.parentId === 'table')).toHaveLength(
      2,
    );
    expect((await readTableActionJournal(session))?.status).toBe('undone');
    await session.close();
  });

  it('runs insert-before, undo, then insert-after with a fresh journal and survives reopening', async () => {
    const vault = new MemoryVault();
    const { session, repository } = await open(vault);
    await seed(session);

    const beforePlan = planInsertRow(session.getState(), 'table', 'row-one', 'before', nextId(), 200);
    if (!beforePlan.ok) throw new Error(beforePlan.error);
    const beforeId = beforePlan.value.rowIds[0]!;
    const before = await executeTableAction(
      session,
      asTableActionPlan(beforePlan.value, 'Insert row before'),
      200,
    );
    expect(before.status).toBe('saved');
    expect(childrenOf(session.getState().pages, 'table').map((row) => row.id)).toEqual([
      beforeId,
      'row-one',
      'row-two',
    ]);
    const beforeJournal = await readTableActionJournal(session);
    expect(beforeJournal?.status).toBe('complete');

    const undoneBefore = await undoTableAction(session);
    expect(undoneBefore.status).toBe('undone');
    expect(childrenOf(session.getState().pages, 'table').map((row) => row.id)).toEqual(['row-one', 'row-two']);
    expect((await readTableActionJournal(session))?.status).toBe('undone');

    const afterPlan = planInsertRow(session.getState(), 'table', 'row-one', 'after', nextId(), 300);
    if (!afterPlan.ok) throw new Error(afterPlan.error);
    const afterId = afterPlan.value.rowIds[0]!;
    const after = await executeTableAction(
      session,
      asTableActionPlan(afterPlan.value, 'Insert row after'),
      300,
    );
    expect(after.status).toBe('saved');
    expect(childrenOf(session.getState().pages, 'table').map((row) => row.id)).toEqual([
      'row-one',
      afterId,
      'row-two',
    ]);
    const afterJournal = await readTableActionJournal(session);
    expect(afterJournal?.status).toBe('complete');
    expect(afterJournal?.label).toBe('Insert row after');
    expect(afterJournal?.id).not.toBe(beforeJournal?.id);

    crash(session, repository);
    const reopened = await open(vault);
    expect(childrenOf(reopened.session.getState().pages, 'table').map((row) => row.id)).toEqual([
      'row-one',
      afterId,
      'row-two',
    ]);
    expect((await readTableActionJournal(reopened.session))?.label).toBe('Insert row after');
    const undoneAfter = await undoTableAction(reopened.session);
    expect(undoneAfter.status).toBe('undone');
    expect(undoneAfter.status === 'undone' ? undoneAfter.journal.conflicts : []).toEqual([]);
    expect(childrenOf(reopened.session.getState().pages, 'table').map((row) => row.id)).toEqual([
      'row-one',
      'row-two',
    ]);
    await reopened.session.close();
  });

  it('preserves a newly inserted row edited after reopening when its action is undone', async () => {
    const vault = new MemoryVault();
    const first = await open(vault);
    await seed(first.session);

    const planned = planInsertRow(first.session.getState(), 'table', 'row-one', 'after', nextId(), 200);
    if (!planned.ok) throw new Error(planned.error);
    const insertedId = planned.value.rowIds[0]!;
    const inserted = await executeTableAction(
      first.session,
      asTableActionPlan(planned.value, 'Insert row after'),
      200,
    );
    expect(inserted.status).toBe('saved');
    crash(first.session, first.repository);

    const reopened = await open(vault);
    const edit = reopened.session.execute({
      type: 'page.rename',
      id: insertedId,
      title: 'Kept after conflict',
      now: 300,
    });
    expect(edit.ok).toBe(true);
    expect(await reopened.session.flush()).toBe(true);

    const undone = await undoTableAction(reopened.session);
    expect(undone.status).toBe('undone');
    expect(undone.status === 'undone' ? undone.journal.conflicts : []).toContain(insertedId);
    expect(reopened.session.getState().pages[insertedId]?.title).toBe('Kept after conflict');
    await reopened.session.close();
  });

  it('journals, reopens, and undoes a row copy together with its complete document', async () => {
    const vault = new MemoryVault();
    const { session, repository } = await open(vault);
    await seed(session);
    const changed = session.execute({
      type: 'page.setDoc',
      id: 'row-one',
      doc: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First copied body' }] }],
      },
      now: 110,
    });
    expect(changed.ok).toBe(true);
    expect(await session.flush()).toBe(true);

    const planned = planDuplicateRows(session.getState(), 'table', ['row-one'], nextId, 120, '(copy)');
    if (!planned.ok) throw new Error(planned.error);
    const copyId = planned.value.rowIds[0]!;
    const saved = await executeTableAction(session, asTableActionPlan(planned.value, 'Copy rows'), 120);
    expect(saved.status).toBe('saved');
    expect(session.getState().docs[copyId]?.content?.[0]?.content?.[0]?.text).toBe('First copied body');

    crash(session, repository);
    const reopened = await open(vault);
    expect(reopened.session.getState().docs[copyId]?.content?.[0]?.content?.[0]?.text).toBe(
      'First copied body',
    );
    const undone = await undoTableAction(reopened.session);
    expect(undone.status).toBe('undone');
    expect(reopened.session.getState().pages).not.toHaveProperty(copyId);
    expect(reopened.session.getState().docs).not.toHaveProperty(copyId);
    expect((await readTableActionJournal(reopened.session))?.status).toBe('undone');
    await reopened.session.close();
  });

  it('recovers a partially saved multi-row copy after reopening', async () => {
    const vault = new FailingWriteVault();
    const first = await open(vault);
    await seed(first.session);
    const planned = planDuplicateRows(
      first.session.getState(),
      'table',
      ['row-one', 'row-two'],
      nextId,
      120,
      '(copy)',
    );
    if (!planned.ok) throw new Error(planned.error);
    const copyIds = [...planned.value.rowIds];
    vault.inspectActionWrites = true;
    vault.failOnPageWrite = 2;
    vault.pageWriteCount = 0;

    const saved = await executeTableAction(first.session, asTableActionPlan(planned.value, 'Copy rows'), 120);
    expect(saved.status).toBe('pending');
    expect(vault.journalAtFirstPageWrite).not.toBeNull();
    const registered = JSON.parse(vault.registryAtFirstPageWrite ?? '{}') as {
      pages?: Record<string, { id?: string }>;
    };
    expect(
      copyIds.every((id) => Object.values(registered.pages ?? {}).some((entry) => entry.id === id)),
    ).toBe(true);
    crash(first.session, first.repository);

    vault.inspectActionWrites = false;
    vault.failOnPageWrite = 0;
    const reopened = await open(vault);
    const recovered = await recoverTableAction(reopened.session);
    expect(recovered.status, 'message' in recovered ? recovered.message : '').toBe('complete');
    expect(copyIds.every((id) => Boolean(reopened.session.getState().pages[id]))).toBe(true);
    expect((await readTableActionJournal(reopened.session))?.status).toBe('complete');
    await reopened.session.close();
  });

  it('does not create ghost rows when the registry lands before the first copied page', async () => {
    const vault = new FailingWriteVault();
    const first = await open(vault);
    await seed(first.session);
    const planned = planDuplicateRows(
      first.session.getState(),
      'table',
      ['row-one', 'row-two'],
      nextId,
      120,
      '(copy)',
    );
    if (!planned.ok) throw new Error(planned.error);
    const copyIds = [...planned.value.rowIds];
    vault.inspectActionWrites = true;
    vault.failOnPageWrite = 1;
    vault.pageWriteCount = 0;

    const saved = await executeTableAction(first.session, asTableActionPlan(planned.value, 'Copy rows'), 120);
    expect(saved.status).toBe('pending');
    expect(vault.journalAtFirstPageWrite).not.toBeNull();
    crash(first.session, first.repository);

    vault.inspectActionWrites = false;
    vault.failOnPageWrite = 0;
    const reopened = await open(vault);
    expect(copyIds.every((id) => Boolean(reopened.session.getState().pages[id]))).toBe(false);
    expect(
      Object.values(reopened.session.getState().pages).filter((page) => page.parentId === 'table'),
    ).toHaveLength(2);
    const recovered = await recoverTableAction(reopened.session);
    expect(recovered.status).toBe('aborted');
    expect((await readTableActionJournal(reopened.session))?.status).toBe('aborted');
    expect(
      Object.values(reopened.session.getState().pages).filter((page) => page.parentId === 'table'),
    ).toHaveLength(2);
    await reopened.session.close();
  });

  it('recovers a row-sequence default when the row saves before its table counter', async () => {
    const vault = new FailingWriteVault();
    const first = await open(vault);
    await seed(first.session);
    const destination = first.session.execute({
      type: 'page.create',
      id: 'sequence-table',
      parentId: null,
      title: 'Sequence table',
      kind: 'database',
      database: {
        properties: [
          {
            id: 'sequence',
            name: 'Sequence',
            type: 'number',
            options: [],
            fillMode: 'default',
            defaultSequence: { start: 0, increment: 1 },
          },
        ],
        views: [],
      },
      now: 110,
    });
    expect(destination.ok).toBe(true);
    expect(await first.session.flush()).toBe(true);
    const payload = createRowClipboardPayload(first.session.getState(), 'table', ['row-one']);
    if (!payload.ok) throw new Error(payload.error);
    const destinationDatabase = first.session.getState().pages['sequence-table']!.database!;
    const mappings = suggestRowPropertyMappings(
      payload.value.sourceProperties,
      destinationDatabase,
      payload.value.rows,
    );
    const planned = planPasteRows(
      first.session.getState(),
      'sequence-table',
      payload.value,
      mappings,
      nextId,
      120,
      '(copy)',
    );
    if (!planned.ok) throw new Error(planned.error);
    const copiedId = planned.value.rowIds[0]!;
    vault.inspectActionWrites = true;
    vault.failOnPageWrite = 2;
    vault.pageWriteCount = 0;

    const saved = await executeTableAction(first.session, asTableActionPlan(planned.value, 'Paste row'), 120);
    expect(saved.status).toBe('pending');
    crash(first.session, first.repository);

    vault.inspectActionWrites = false;
    vault.failOnPageWrite = 0;
    const reopened = await open(vault);
    const recovered = await recoverTableAction(reopened.session);
    expect(recovered.status).toBe('complete');
    expect(reopened.session.getState().pages[copiedId]?.properties.sequence).toBe(0);
    expect(
      reopened.session
        .getState()
        .pages['sequence-table']!.database!.properties.find((property) => property.id === 'sequence')
        ?.sequenceNext,
    ).toBe(1);
    expect((await readTableActionJournal(reopened.session))?.status).toBe('complete');

    const undone = await undoTableAction(reopened.session);
    expect(undone.status).toBe('undone');
    expect(reopened.session.getState().pages).not.toHaveProperty(copiedId);
    expect(
      reopened.session
        .getState()
        .pages['sequence-table']!.database!.properties.find((property) => property.id === 'sequence')
        ?.sequenceNext,
    ).toBe(1);
    const next = reopened.session.execute({
      type: 'page.create',
      id: 'sequence-next-row',
      parentId: 'sequence-table',
      title: 'Next',
      now: 130,
    });
    expect(next.ok).toBe(true);
    expect(reopened.session.getState().pages['sequence-next-row']?.properties.sequence).toBe(1);
    await reopened.session.close();
  });

  it('preserves planned sequence values when the table counter saves before the row', async () => {
    const vault = new FailingWriteVault();
    const first = await open(vault);
    await seed(first.session);
    const destination = first.session.execute({
      type: 'page.create',
      id: 'sequence-table',
      parentId: null,
      title: 'Sequence table',
      kind: 'database',
      database: {
        properties: [
          {
            id: 'sequence',
            name: 'Sequence',
            type: 'number',
            options: [],
            fillMode: 'default',
            defaultSequence: { start: 0, increment: 1 },
          },
        ],
        views: [],
      },
      now: 110,
    });
    expect(destination.ok).toBe(true);
    expect(await first.session.flush()).toBe(true);
    const payload = createRowClipboardPayload(first.session.getState(), 'table', ['row-one']);
    if (!payload.ok) throw new Error(payload.error);
    const destinationDatabase = first.session.getState().pages['sequence-table']!.database!;
    const mappings = suggestRowPropertyMappings(
      payload.value.sourceProperties,
      destinationDatabase,
      payload.value.rows,
    );
    const planned = planPasteRows(
      first.session.getState(),
      'sequence-table',
      payload.value,
      mappings,
      nextId,
      120,
      '(copy)',
    );
    if (!planned.ok) throw new Error(planned.error);
    const copiedId = planned.value.rowIds[0]!;
    vault.inspectActionWrites = true;
    vault.databaseFirstPageWriteOrder = true;
    vault.failOnPageWrite = 2;
    vault.pageWriteCount = 0;

    const saved = await executeTableAction(first.session, asTableActionPlan(planned.value, 'Paste row'), 120);
    expect(saved.status).toBe('pending');
    crash(first.session, first.repository);

    vault.inspectActionWrites = false;
    vault.databaseFirstPageWriteOrder = false;
    vault.failOnPageWrite = 0;
    const reopened = await open(vault);
    const recovered = await recoverTableAction(reopened.session);
    expect(recovered.status).toBe('complete');
    expect(reopened.session.getState().pages[copiedId]?.properties.sequence).toBe(0);
    expect(
      reopened.session
        .getState()
        .pages['sequence-table']!.database!.properties.find((property) => property.id === 'sequence')
        ?.sequenceNext,
    ).toBe(1);
    await reopened.session.close();
  });

  it('undoes a cross-table move in one journal and restores the source fields and order', async () => {
    const vault = new MemoryVault();
    const { session } = await open(vault);
    await seed(session);
    const metadata = session.execute({
      type: 'page.setFields',
      id: 'row-one',
      properties: { status: 'Open', value: 0 },
      extra: { Source: 'kept' },
      now: 105,
    });
    expect(metadata.ok).toBe(true);
    const added = session.execute({
      type: 'page.create',
      id: 'destination',
      parentId: null,
      title: 'Destination',
      kind: 'database',
      database: {
        properties: definitions().properties.filter((prop) => prop.id === 'status' || prop.id === 'value'),
        views: [],
      },
      now: 106,
    });
    expect(added.ok).toBe(true);
    expect(await session.flush()).toBe(true);

    const state = session.getState();
    const sourceRow = state.pages['row-one']!;
    const mappings = suggestRowPropertyMappings(
      state.pages.table!.database!.properties,
      state.pages.destination!.database!,
      [{ page: sourceRow }],
    );
    const planned = planMoveRows(state, 'table', 'destination', ['row-one'], mappings, 130);
    if (!planned.ok) throw new Error(planned.error);
    const saved = await executeTableAction(session, asTableActionPlan(planned.value, 'Move rows'), 130);
    expect(saved.status).toBe('saved');
    expect(session.getState().pages['row-one']?.parentId).toBe('destination');

    const undone = await undoTableAction(session);
    expect(undone.status).toBe('undone');
    expect(session.getState().pages['row-one']?.parentId).toBe('table');
    expect(session.getState().pages['row-one']?.properties).toEqual({ status: 'Open', value: 0 });
    expect(session.getState().pages['row-one']?.extra).toEqual({ Source: 'kept' });
    expect(session.getState().pages['row-two']?.order).toBe(1);
    await session.close();
  });

  it('blocks a duplicate execution while the first click holds the journal', async () => {
    const vault = new MemoryVault();
    const { session } = await open(vault);
    await seed(session);
    const actionPlan = plan(session, 'action-a');
    const [first, second] = await Promise.all([
      executeTableAction(session, actionPlan, 100),
      executeTableAction(session, actionPlan, 100),
    ]);
    expect([first.status, second.status].sort()).toEqual(['busy', 'saved']);
    expect(valueOf(session.getState(), 'row-one')).toBe(1);
    expect(valueOf(session.getState(), 'row-two')).toBe(1);
    await session.close();
  });
});
