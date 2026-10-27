import { describe, expect, it } from 'vitest';
import { planDatabaseCopy } from '../core/databaseCopy';
import { emptyDoc, newPageMeta } from '../core/model';
import type { DatabaseDef, NamedControlDef, PageMeta } from '../core/model';
import { MemoryVault } from './memoryVault';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';

let idCounter = 0;
const newId = () => `generated-${++idCounter}`;

const control = (
  id: string,
  targetDatabaseId: string,
  multiple: boolean,
  value: string | string[] | null,
  defaultValue: string | string[] | null,
): NamedControlDef => ({
  id,
  name: id,
  type: 'relation',
  value,
  defaultValue,
  options: [],
  relation: { targetDatabaseId, multiple },
});

const relation = (
  id: string,
  targetDatabaseId: string,
  multiple: boolean,
  defaultValue: string | string[] | null,
) => ({
  id,
  name: id,
  type: 'relation' as const,
  options: [],
  defaultValue,
  relation: {
    targetDatabaseId,
    multiple,
    isInverse: false,
    displayPropertyId: null,
    inversePropertyId: null,
    filters: [],
  },
});

function copyFixture(): PageMeta[] {
  const database: DatabaseDef = {
    properties: [
      relation('single', 'db', false, 'row-a'),
      relation('multiple', 'db', true, ['row-a', 'row-b']),
      relation('external', 'external-db', false, 'external-row'),
    ],
    views: [{ id: 'view', name: 'Table', type: 'table', filters: [], sorts: [], groupBy: null, dateProp: null, hidden: [] }],
  };
  return [
    newPageMeta({ id: 'host', parentId: null, title: 'Host' }),
    newPageMeta({
      id: 'db', parentId: null, title: 'Items', kind: 'database', database,
      controls: [
        control('single', 'db', false, 'row-a', 'row-b'),
        control('multiple', 'db', true, ['row-a', 'row-b'], ['row-b']),
        control('external-control', 'external-db', false, 'external-row', 'external-row'),
      ],
    }),
    newPageMeta({
      id: 'row-a', parentId: 'db', title: 'A',
      properties: { single: 'row-b', multiple: ['row-a', 'row-b'], external: 'external-row' },
    }),
    newPageMeta({
      id: 'row-b', parentId: 'db', title: 'B',
      properties: { single: 'row-a', multiple: ['row-a'], external: 'external-row' },
    }),
    newPageMeta({ id: 'external-db', parentId: null, title: 'External', kind: 'database', database: { properties: [], views: [] } }),
    newPageMeta({ id: 'external-row', parentId: 'external-db', title: 'External row' }),
  ];
}

async function open(vault: MemoryVault): Promise<WorkspaceSession> {
  const opened = await WorkspaceSession.open(new VaultRepository(vault, newId), { delayMs: 0 });
  if (!opened.ok) throw new Error(opened.error);
  return opened.value;
}

describe('database copy persistence', () => {
  it('saves and reopens copied relation controls and row values with stable targets', async () => {
    const vault = new MemoryVault();
    const session = await open(vault);
    const pages = copyFixture();
    const sourceDocs = Object.fromEntries(pages.map((page) => [page.id, emptyDoc()]));
    const sourceInserted = session.execute({ type: 'pages.insert', pages, docs: sourceDocs });
    if (!sourceInserted.ok) throw new Error(sourceInserted.error);
    expect(await session.flush()).toBe(true);

    let copyCounter = 0;
    const plan = planDatabaseCopy(session.getState(), 'db', 'host', true, () => `copy-${++copyCounter}`, 10, '(copy)')!;
    const copyInserted = session.execute({ type: 'pages.insert', pages: plan.pages, docs: plan.docs });
    if (!copyInserted.ok) throw new Error(copyInserted.error);
    expect(await session.flush()).toBe(true);

    const copiedRows = plan.pages.filter((page) => page.parentId === plan.databaseId);
    const copiedA = copiedRows.find((page) => page.title === 'A')!;
    const copiedB = copiedRows.find((page) => page.title === 'B')!;
    const sourceBeforeClose = session.getState().pages.db!;
    expect(sourceBeforeClose.controls.find((item) => item.id === 'single')!.value).toBe('row-a');
    await session.close();

    const reopened = await open(vault);
    const copiedDatabase = reopened.getState().pages[plan.databaseId]!;
    expect(copiedDatabase.controls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'single', value: copiedA.id, defaultValue: copiedB.id }),
        expect.objectContaining({ id: 'multiple', value: [copiedA.id, copiedB.id], defaultValue: [copiedB.id] }),
        expect.objectContaining({ id: 'external-control', value: 'external-row', defaultValue: 'external-row' }),
      ]),
    );
    expect(reopened.getState().pages[copiedA.id]!.properties).toMatchObject({
      single: copiedB.id,
      multiple: [copiedA.id, copiedB.id],
      external: 'external-row',
    });
    expect(reopened.getState().pages.db!.controls.find((item) => item.id === 'single')!.value).toBe('row-a');
    await reopened.close();
  });
});
