import { describe, expect, it, vi } from 'vitest';
import type { Command } from '../core/commands';
import type { ActionRecordChange } from '../core/tableActions';
import type { DatabaseDef, PageId, PageMeta, PropDef } from '../core/model';
import type { VaultOp, VaultOpResult } from '../core/vault/plan';
import { asTableActionPlan, planMoveRows, suggestRowPropertyMappings } from '../core/rowOperations';
import { undoRedo } from '../app/editor/commits';
import { registerDataHistoryEditGuard, runAll, setSession } from '../app/workspace';
import { MemoryVault } from './memoryVault';
import type { VaultRepository } from './vaultRepository';
import { VaultRepository as FileVaultRepository } from './vaultRepository';
import { WorkspaceSession } from './session';
import {
  executeTableAction,
  readTableActionJournal,
  TABLE_ACTION_JOURNAL_META,
} from './tableActions';
import type { TableActionJournal } from './tableActions';

let repositoryId = 0;
let entryId = 0;

class GatedMemoryVault extends MemoryVault {
  private journalReadGate: {
    started: () => void;
    startedPromise: Promise<void>;
    releasedPromise: Promise<void>;
    release: () => void;
  } | null = null;
  private journalWriteGate: {
    started: () => void;
    startedPromise: Promise<void>;
    releasedPromise: Promise<void>;
    release: () => void;
  } | null = null;

  pauseNextJournalRead(): { started: Promise<void>; release: () => void } {
    let signalStarted!: () => void;
    let signalRelease!: () => void;
    const startedPromise = new Promise<void>((resolve) => (signalStarted = resolve));
    const releasedPromise = new Promise<void>((resolve) => (signalRelease = resolve));
    this.journalReadGate = {
      started: signalStarted,
      startedPromise,
      releasedPromise,
      release: signalRelease,
    };
    return { started: startedPromise, release: signalRelease };
  }

  pauseNextJournalWriteAfterCommit(): { started: Promise<void>; release: () => void } {
    let signalStarted!: () => void;
    let signalRelease!: () => void;
    const startedPromise = new Promise<void>((resolve) => (signalStarted = resolve));
    const releasedPromise = new Promise<void>((resolve) => (signalRelease = resolve));
    this.journalWriteGate = {
      started: signalStarted,
      startedPromise,
      releasedPromise,
      release: signalRelease,
    };
    return { started: startedPromise, release: signalRelease };
  }

  override async readText(path: string): Promise<string | null> {
    const gate = this.journalReadGate;
    if (gate && path === `.morrow/${TABLE_ACTION_JOURNAL_META}`) {
      this.journalReadGate = null;
      gate.started();
      await gate.releasedPromise;
    }
    return super.readText(path);
  }

  override async apply(ops: VaultOp[]): Promise<VaultOpResult[]> {
    const gate = this.journalWriteGate;
    const writesJournal = ops.some(
      (op) => op.op === 'write' && op.path === `.morrow/${TABLE_ACTION_JOURNAL_META}`,
    );
    if (!gate || !writesJournal) return super.apply(ops);
    this.journalWriteGate = null;
    const results = await super.apply(ops);
    if (results.every((result) => result.ok)) {
      gate.started();
      await gate.releasedPromise;
    }
    return results;
  }
}

interface OpenedTestSession {
  session: WorkspaceSession;
  repository: VaultRepository;
  vault: GatedMemoryVault;
}

function databaseDefinition(databaseId: PageId, relations = false): DatabaseDef {
  const properties: PropDef[] = [
    { id: 'value', name: 'Value', type: 'number', options: [] },
    { id: 'note', name: 'Note', type: 'text', options: [] },
  ];
  if (relations && databaseId === 'database-a')
    properties.push({
      id: 'link',
      name: 'Link',
      type: 'relation',
      options: [],
      relation: {
        targetDatabaseId: 'database-b',
        multiple: true,
        isInverse: false,
        displayPropertyId: null,
        inversePropertyId: 'back',
        filters: [],
      },
    });
  if (relations && databaseId === 'database-b')
    properties.push({
      id: 'back',
      name: 'Back',
      type: 'relation',
      options: [],
      relation: {
        targetDatabaseId: 'database-a',
        multiple: true,
        isInverse: true,
        displayPropertyId: null,
        inversePropertyId: 'link',
        filters: [],
      },
    });
  return { properties, views: [] };
}

async function openSession(
  databaseIds: PageId[] = ['database-a', 'database-b'],
  options: { relations?: boolean; vault?: GatedMemoryVault } = {},
): Promise<OpenedTestSession> {
  const vault = options.vault ?? new GatedMemoryVault();
  const repository = new FileVaultRepository(vault, () => `data-history-${++repositoryId}`);
  const opened = await WorkspaceSession.open(repository, { delayMs: 60_000 });
  if (!opened.ok) throw new Error(opened.error);
  const session = opened.value;
  const commands: Command[] = [];
  for (const databaseId of databaseIds) {
    commands.push({
      type: 'page.create',
      id: databaseId,
      parentId: null,
      title: databaseId,
      kind: 'database',
      database: databaseDefinition(databaseId, options.relations),
      now: 1,
    });
    commands.push({
      type: 'page.create',
      id: `row-${databaseId}`,
      parentId: databaseId,
      title: `Row ${databaseId}`,
      properties: { value: 0 },
      ...(databaseId === 'database-a'
        ? {
            controls: [
              {
                id: 'control-note',
                name: 'Note control',
                type: 'text' as const,
                value: 'before',
                defaultValue: 'before',
                options: [],
              },
            ],
          }
        : {}),
      now: 1,
    });
  }
  const seeded = session.executeHistoryReplay(commands);
  if (!seeded.ok) throw new Error(seeded.error);
  if (!(await session.flush())) throw new Error('Could not save the synthetic test workspace.');
  return { session, repository, vault };
}

async function reopenSession(vault: GatedMemoryVault): Promise<OpenedTestSession> {
  const repository = new FileVaultRepository(vault, () => `data-history-${++repositoryId}`);
  const opened = await WorkspaceSession.open(repository, { delayMs: 60_000 });
  if (!opened.ok) throw new Error(opened.error);
  return { session: opened.value, repository, vault };
}

async function closeTestSession(session: WorkspaceSession, repository: VaultRepository): Promise<void> {
  await session.close();
  repository.close();
}

function rowValue(session: WorkspaceSession, rowId: PageId): unknown {
  return session.getState().pages[rowId]?.properties.value;
}

function setValue(session: WorkspaceSession, rowId: PageId, value: number, now: number) {
  return session.execute({ type: 'page.setProperties', id: rowId, values: { value }, now });
}

function historyEntry(
  databaseId: PageId,
  rowId: PageId,
  before: PageMeta,
  after: PageMeta,
  command: Command,
): TableActionJournal {
  const record: ActionRecordChange = { id: rowId, before, after };
  return {
    format: 'morrow-table-action-journal',
    version: 1,
    id: `history-${++entryId}`,
    status: 'complete',
    databaseId,
    rowId,
    propertyId: 'value',
    label: 'Change row value',
    createdAt: 10,
    records: [record],
    commands: [command],
    conflicts: [],
  };
}

describe('session data history', () => {
  it('keeps row histories scoped to their own database', async () => {
    const { session, repository } = await openSession();
    expect(setValue(session, 'row-database-a', 1, 2).ok).toBe(true);
    const firstId = session.getDataHistory('database-a').undo?.id;
    expect(firstId).toBeTruthy();
    expect(session.getDataHistory('database-b').undo).toBeNull();

    expect(setValue(session, 'row-database-b', 1, 3).ok).toBe(true);
    expect(session.getDataHistory('database-b').undo?.id).not.toBe(firstId);
    const undone = await session.stepDataHistory('database-a', 'undo');
    expect(undone.status).toBe('applied');
    expect(rowValue(session, 'row-database-a')).toBe(0);
    expect(rowValue(session, 'row-database-b')).toBe(1);
    await closeTestSession(session, repository);
  });

  it('shares a cross-database row move as one atomic undo and redo entry', async () => {
    const { session, repository } = await openSession();
    const state = session.getState();
    const source = state.pages['database-a']!.database!;
    const destination = state.pages['database-b']!.database!;
    const mappings = suggestRowPropertyMappings(source.properties, destination, [
      { page: state.pages['row-database-a']! },
    ]);
    const planned = planMoveRows(state, 'database-a', 'database-b', ['row-database-a'], mappings, 4);
    if (!planned.ok) throw new Error(planned.error);
    const saved = await executeTableAction(session, asTableActionPlan(planned.value, 'Move row'), 4);
    expect(saved.status).toBe('saved');

    const fromA = session.getDataHistory('database-a').undo;
    const fromB = session.getDataHistory('database-b').undo;
    expect(fromA?.id).toBe(saved.status === 'saved' ? saved.journal.id : '');
    expect(fromB?.id).toBe(fromA?.id);
    const undone = await session.stepDataHistory('database-a', 'undo');
    expect(undone.status).toBe('applied');
    expect(session.getState().pages['row-database-a']?.parentId).toBe('database-a');
    expect(session.getDataHistory('database-b').redo?.id).toBe(fromA?.id);
    const redone = await session.stepDataHistory('database-b', 'redo');
    expect(redone.status).toBe('applied');
    expect(session.getState().pages['row-database-a']?.parentId).toBe('database-b');
    await closeTestSession(session, repository);
  });

  it('does not duplicate row history when schema and adopted row values share a batch', async () => {
    const { session, repository } = await openSession();
    const current = session.getState().pages['database-a']!.database!;
    const updated: DatabaseDef = {
      ...current,
      properties: [...current.properties, { id: 'added', name: 'Added', type: 'text', options: [] }],
    };
    const result = session.executeAll([
      { type: 'database.set', id: 'database-a', database: updated, now: 2 },
      { type: 'page.setProperties', id: 'row-database-a', values: { added: 'adopted' }, now: 2 },
    ]);
    expect(result.ok).toBe(true);
    expect(rowValue(session, 'row-database-a')).toBe(0);
    expect(session.getState().pages['row-database-a']?.properties.added).toBe('adopted');
    expect(session.getDataHistory('database-a').undo).toBeNull();
    await closeTestSession(session, repository);
  });

  it('captures and replays an explicit controls-only table action in the same history', async () => {
    const { session, repository } = await openSession();
    const before = structuredClone(session.getState().pages['row-database-a']!);
    const change = session.executeAllWithDataHistory(
      [{ type: 'page.control.setValue', id: 'row-database-a', controlId: 'control-note', value: 'after', now: 2 }],
      {
        id: `control-action-${++entryId}`,
        databaseId: 'database-a',
        rowId: 'row-database-a',
        propertyId: 'button-action',
        label: 'Change control',
        pendingRecovery: true,
        records: [
          {
            id: 'row-database-a',
            before,
            after: {
              ...before,
              controls: before.controls.map((control) =>
                control.id === 'control-note' ? { ...control, value: 'after' } : control,
              ),
              updatedAt: 2,
            },
          },
        ],
      },
    );
    expect(change.result.ok).toBe(true);
    expect(change.historyEntryId).toBeTruthy();
    session.finishDataHistoryEntry(change.historyEntryId!, 'ready');
    expect(session.getDataHistory('database-a').undo?.label).toBe('Change control');

    const undone = await session.stepDataHistory('database-a', 'undo');
    expect(undone.status).toBe('applied');
    expect(session.getState().pages['row-database-a']?.controls[0]?.value).toBe('before');
    await closeTestSession(session, repository);
  });

  it('bounds each database to ten completed steps and keeps unavailable barriers compact', async () => {
    const { session, repository } = await openSession();
    for (let value = 1; value <= 12; value++) expect(setValue(session, 'row-database-a', value, value + 1).ok).toBe(true);
    for (let index = 0; index < 10; index++)
      expect((await session.stepDataHistory('database-a', 'undo')).status).toBe('applied');
    expect(rowValue(session, 'row-database-a')).toBe(2);
    expect((await session.stepDataHistory('database-a', 'undo')).status).toBe('empty');

    expect(setValue(session, 'row-database-a', 3, 20).ok).toBe(true);
    const oversized = session.execute({
      type: 'page.setFields',
      id: 'row-database-a',
      extra: { Preserved: 'x'.repeat(2_100_000) },
      now: 21,
    });
    expect(oversized.ok).toBe(true);
    const barrier = session.getDataHistory('database-a').undo;
    expect(barrier?.status).toBe('unavailable');
    expect(barrier?.enabled).toBe(false);
    expect((await session.stepDataHistory('database-a', 'undo')).status).toBe('unavailable');
    expect(rowValue(session, 'row-database-a')).toBe(3);
    await closeTestSession(session, repository);
  });

  it('keeps permanent row deletion as an unavailable history boundary', async () => {
    const { session, repository } = await openSession(['database-a']);
    expect(session.execute({ type: 'page.trash', id: 'row-database-a', now: 2 }).ok).toBe(true);
    expect(session.execute({ type: 'page.deleteForever', id: 'row-database-a' }).ok).toBe(true);
    expect(session.getState().pages['row-database-a']).toBeUndefined();
    expect(session.getDataHistory('database-a').undo).toMatchObject({
      status: 'unavailable',
      enabled: false,
    });
    expect((await session.stepDataHistory('database-a', 'undo')).status).toBe('unavailable');
    expect(session.getState().pages['row-database-a']).toBeUndefined();
    await closeTestSession(session, repository);
  });

  it('enforces the 32 MiB session cap without evicting a pending recovery entry', async () => {
    const largeDatabaseIds = Array.from({ length: 22 }, (_, index) => `large-${index}`);
    const { session, repository } = await openSession(['database-a', ...largeDatabaseIds]);
    expect(setValue(session, 'row-database-a', 1, 2).ok).toBe(true);
    const pendingId = session.getDataHistory('database-a').undo?.id;
    expect(pendingId).toBeTruthy();
    session.finishDataHistoryEntry(pendingId!, 'pending');

    for (let index = 0; index < largeDatabaseIds.length; index++) {
      const databaseId = largeDatabaseIds[index]!;
      const rowId = `row-${databaseId}`;
      const oldExtra = { Payload: 'a'.repeat(520_000) };
      const newExtra = { Payload: 'b'.repeat(520_000) };
      const seeded = session.executeHistoryReplay([
        { type: 'page.setFields', id: rowId, extra: oldExtra, now: 10 },
      ]);
      expect(seeded.ok).toBe(true);
      const before = structuredClone(session.getState().pages[rowId]!);
      const applied = session.executeHistoryReplay([
        { type: 'page.setFields', id: rowId, extra: newExtra, now: 11 },
      ]);
      expect(applied.ok).toBe(true);
      const after = structuredClone(session.getState().pages[rowId]!);
      const command: Command = { type: 'page.setFields', id: rowId, extra: newExtra, now: 11 };
      session.restoreDataHistoryEntry(
        {
          id: `large-entry-${index}`,
          databaseId,
          rowId,
          propertyId: 'note',
          label: 'Large completed row change',
          createdAt: index + 20,
          records: [{ id: rowId, before, after }],
          commands: [command],
        },
      );
    }

    expect(session.getDataHistory('database-a').undo).toMatchObject({ id: pendingId, status: 'pending' });
    const retainedLargeEntries = largeDatabaseIds.filter((databaseId) =>
      Boolean(session.getDataHistory(databaseId).undo),
    );
    // Each entry contains at least three independently stored 520,000-byte values
    // (before, after and command). Twenty-two exceed 32 MiB; the oldest prefix is pruned.
    expect(22 * 3 * 520_000).toBeGreaterThan(32 * 1024 * 1024);
    expect(retainedLargeEntries).toEqual(largeDatabaseIds.slice(-21));
    session.queue.dispose();
    repository.close();
  });

  it('reconciles complete and undone recovery records by ID and reopens them for redo', async () => {
    const vault = new GatedMemoryVault();
    const first = await openSession(['database-a'], { vault });
    const before = structuredClone(first.session.getState().pages['row-database-a']!);
    expect(
      first.session.executeHistoryReplay([
        { type: 'page.setProperties', id: 'row-database-a', values: { value: 1 }, now: 2 },
      ]).ok,
    ).toBe(true);
    const after = structuredClone(first.session.getState().pages['row-database-a']!);
    const command: Command = {
      type: 'page.setProperties',
      id: 'row-database-a',
      values: { value: 1 },
      now: 2,
    };
    const journal = historyEntry('database-a', 'row-database-a', before, after, command);
    await first.session.flush();
    await first.session.writeMeta(TABLE_ACTION_JOURNAL_META, JSON.stringify(journal));
    first.session.restoreDataHistoryEntry(journal);
    first.session.restoreDataHistoryEntry(journal);
    expect(first.session.getDataHistory('database-a').undo?.id).toBe(journal.id);
    expect((await first.session.stepDataHistory('database-a', 'undo')).status).toBe('applied');
    expect((await first.session.stepDataHistory('database-a', 'undo')).status).toBe('empty');
    expect((await readTableActionJournal(first.session))?.status).toBe('undone');
    await closeTestSession(first.session, first.repository);

    const reopened = await reopenSession(vault);
    const redo = reopened.session.getDataHistory('database-a').redo;
    expect(redo?.id).toBe(journal.id);
    const undoneJournal = await readTableActionJournal(reopened.session);
    expect(undoneJournal?.status).toBe('undone');
    if (undoneJournal) reopened.session.restoreDataHistoryEntry(undoneJournal, 'redo');
    expect(reopened.session.getDataHistory('database-a').redo?.id).toBe(journal.id);
    expect((await reopened.session.stepDataHistory('database-a', 'redo')).status).toBe('applied');
    expect(rowValue(reopened.session, 'row-database-a')).toBe(1);
    expect((await reopened.session.stepDataHistory('database-a', 'redo')).status).toBe('empty');
    await closeTestSession(reopened.session, reopened.repository);
  });

  it('rechecks permission after journal I/O and preserves same-row drafts during undo', async () => {
    const vault = new GatedMemoryVault();
    const { session, repository } = await openSession(['database-a', 'database-b'], {
      vault,
      relations: true,
    });
    expect(setValue(session, 'row-database-a', 1, 2).ok).toBe(true);
    const gate = vault.pauseNextJournalRead();
    const step = session.stepDataHistory('database-a', 'undo', () => true);
    await gate.started;
    expect(session.getDataHistory('database-a').undo?.status).toBe('busy');

    const unrelated = setValue(session, 'row-database-b', 1, 3);
    expect(unrelated.ok).toBe(true);
    const mixed = session.executeAll([
      { type: 'page.setProperties', id: 'row-database-a', values: { value: 2 }, now: 4 },
      { type: 'page.setProperties', id: 'row-database-b', values: { value: 2 }, now: 4 },
    ]);
    expect(mixed.ok).toBe(false);
    expect(rowValue(session, 'row-database-b')).toBe(1);
    const sameDatabase = setValue(session, 'row-database-a', 2, 5);
    expect(sameDatabase.ok).toBe(false);

    const relation = session.execute({
      type: 'relation.set',
      id: 'row-database-b',
      propertyId: 'back',
      value: 'row-database-a',
      now: 6,
    });
    expect(relation.ok).toBe(false);
    expect(session.getState().pages['row-database-a']?.properties.link ?? null).toBeNull();

    const body = session.execute({
      type: 'page.setDoc',
      id: 'row-database-a',
      doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'new draft' }] }] },
      now: 7,
    });
    expect(body.ok).toBe(true);
    gate.release();
    expect((await step).status).toBe('applied');
    expect(rowValue(session, 'row-database-a')).toBe(0);
    expect(session.getState().docs['row-database-a']?.content?.[0]?.content?.[0]?.text).toBe('new draft');
    expect(session.getState().pages['row-database-a']?.updatedAt).toBeGreaterThan(7);
    await closeTestSession(session, repository);
  });

  it('does not begin an inverse after permission changes while journal reads are pending', async () => {
    const vault = new GatedMemoryVault();
    const { session, repository } = await openSession(['database-a'], { vault });
    expect(setValue(session, 'row-database-a', 1, 2).ok).toBe(true);
    let editable = true;
    const gate = vault.pauseNextJournalRead();
    const step = session.stepDataHistory('database-a', 'undo', () => editable);
    await gate.started;
    editable = false;
    gate.release();
    expect(await step).toMatchObject({ status: 'blocked', reason: 'permission' });
    expect(rowValue(session, 'row-database-a')).toBe(1);
    expect(session.getDataHistory('database-a').undo?.status).toBe('ready');
    expect(await readTableActionJournal(session)).toBeNull();
    await closeTestSession(session, repository);
  });

  it('aborts its own undo journal when permission changes after the undoing write commits', async () => {
    const vault = new GatedMemoryVault();
    const { session, repository } = await openSession(['database-a'], { vault });
    expect(setValue(session, 'row-database-a', 1, 2).ok).toBe(true);
    const historyId = session.getDataHistory('database-a').undo?.id;
    let editable = true;
    const gate = vault.pauseNextJournalWriteAfterCommit();
    const step = session.stepDataHistory('database-a', 'undo', () => editable);
    await gate.started;
    expect((await readTableActionJournal(session))?.status).toBe('undoing');
    editable = false;
    gate.release();

    expect(await step).toMatchObject({ status: 'blocked', reason: 'permission' });
    expect(rowValue(session, 'row-database-a')).toBe(1);
    expect(await readTableActionJournal(session)).toMatchObject({ id: historyId, status: 'aborted' });
    await closeTestSession(session, repository);
  });

  it('preserves a foreign pending journal written while its undo journal is paused', async () => {
    const vault = new GatedMemoryVault();
    const { session, repository } = await openSession(['database-a'], { vault });
    expect(setValue(session, 'row-database-a', 1, 2).ok).toBe(true);
    const gate = vault.pauseNextJournalWriteAfterCommit();
    const step = session.stepDataHistory('database-a', 'undo');
    await gate.started;
    const pausedJournal = await readTableActionJournal(session);
    expect(pausedJournal?.status).toBe('undoing');
    const foreignJournal = {
      ...pausedJournal!,
      id: 'foreign-pending-action',
      status: 'prepared' as const,
    };
    const foreignText = JSON.stringify(foreignJournal);
    const [written] = await vault.apply([
      { op: 'write', path: `.morrow/${TABLE_ACTION_JOURNAL_META}`, text: foreignText },
    ]);
    expect(written?.ok).toBe(true);
    gate.release();

    expect((await step).status).toBe('pending');
    expect(rowValue(session, 'row-database-a')).toBe(1);
    expect(vault.text(`.morrow/${TABLE_ACTION_JOURNAL_META}`)).toBe(foreignText);
    expect(await readTableActionJournal(session)).toMatchObject({
      id: 'foreign-pending-action',
      status: 'prepared',
    });
    await closeTestSession(session, repository);
  });

  it('routes Ctrl+Z by focus: draft input stays native and grid focus does not undo schema history', async () => {
    const { session, repository } = await openSession(['database-a']);
    setSession(session);
    const current = session.getState().pages['database-a']!.database!;
    const addedProperty: PropDef = { id: 'schema-only', name: 'Schema only', type: 'text', options: [] };
    const schemaEdit = runAll([
      {
        type: 'database.set',
        id: 'database-a',
        database: { ...current, properties: [...current.properties, addedProperty] },
        now: 2,
      },
    ]);
    expect(schemaEdit.ok).toBe(true);
    expect(setValue(session, 'row-database-a', 1, 3).ok).toBe(true);
    const dataHistoryId = session.getDataHistory('database-a').undo?.id;
    expect(dataHistoryId).toBeTruthy();

    class HtmlElement {
      closest(_selector: string): unknown {
        return null;
      }
    }
    class InputElement extends HtmlElement {
      type = 'text';
    }
    class TextAreaElement extends HtmlElement {}
    const documentState = {
      activeElement: new InputElement(),
      execCommand: vi.fn(),
    };
    vi.stubGlobal('HTMLElement', HtmlElement);
    vi.stubGlobal('HTMLInputElement', InputElement);
    vi.stubGlobal('HTMLTextAreaElement', TextAreaElement);
    vi.stubGlobal('document', documentState);
    const root = {
      dataset: { dataHistoryDatabase: 'database-a', dataHistoryEditable: 'true' },
    } as unknown as HTMLElement;
    const unregister = registerDataHistoryEditGuard(root, () => true);
    try {
      undoRedo('undo');
      expect(documentState.execCommand).toHaveBeenCalledWith('undo');
      expect(session.getDataHistory('database-a').undo?.id).toBe(dataHistoryId);
      expect(rowValue(session, 'row-database-a')).toBe(1);

      const step = vi.spyOn(session, 'stepDataHistory').mockResolvedValue({ status: 'empty' });
      documentState.activeElement = Object.assign(new HtmlElement(), {
        closest: (selector: string) =>
          selector === '[data-data-history-database]' ? root : null,
      }) as InputElement;
      undoRedo('undo');
      expect(step).toHaveBeenCalledWith('database-a', 'undo', expect.any(Function));
      expect(session.getState().pages['database-a']?.database?.properties).toContainEqual(addedProperty);
      expect(rowValue(session, 'row-database-a')).toBe(1);
      step.mockRestore();

      documentState.activeElement = new HtmlElement() as InputElement;
      undoRedo('undo');
      expect(session.getState().pages['database-a']?.database?.properties).not.toContainEqual(addedProperty);
      expect(rowValue(session, 'row-database-a')).toBe(1);
    } finally {
      unregister();
      vi.unstubAllGlobals();
      await closeTestSession(session, repository);
    }
  });
});
