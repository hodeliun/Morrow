import { describe, expect, it } from 'vitest';
import type { Command } from '../core/commands';
import type { DatabaseDef, PropDef, WorkspaceState } from '../core/model';
import type { VaultOp, VaultOpResult } from '../core/vault/plan';
import { planTableAction } from '../core/tableActions';
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
  failOnPageWrite = 0;
  pageWriteCount = 0;
  journalAtFirstPageWrite: string | null = null;

  override async apply(ops: VaultOp[]): Promise<VaultOpResult[]> {
    const results: VaultOpResult[] = [];
    for (const op of ops) {
      if (this.inspectActionWrites && op.op === 'write' && op.path.toLowerCase().endsWith('.md')) {
        if (this.pageWriteCount === 0)
          this.journalAtFirstPageWrite = this.text(`.morrow/${TABLE_ACTION_JOURNAL_META}`) ?? null;
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
