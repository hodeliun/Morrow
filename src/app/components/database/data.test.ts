import { describe, expect, it, vi } from 'vitest';
import { MemoryVault } from '../../../storage/memoryVault';
import { WorkspaceSession } from '../../../storage/session';
import { VaultRepository } from '../../../storage/vaultRepository';
import { setSession } from '../../workspace';
import { deleteProperty, titleAliasConflicts, updateView } from './data';

describe('database property deletion', () => {
  it('rejects a title alias that collides with another column by case or accent', () => {
    const database = {
      properties: [{ id: 'resume', name: 'Résumé', type: 'text' as const, options: [] }],
      views: [],
    };
    expect(titleAliasConflicts(database, '  RESUME  ')).toBe(true);
    expect(titleAliasConflicts(database, 'Summary')).toBe(false);
  });

  it('removes only the selected column and preserves row titles, unrelated view rules, unknown values, and comments', async () => {
    let nextId = 0;
    const newId = () => `title-display-${++nextId}`;
    const vault = new MemoryVault({
      'Records.md': `---
kind: database
database:
  titleAlias: Record
  displayPropertyId: rating
  properties:
    - id: rating
      name: Rating
      type: text
    - id: status
      name: Status
      type: text
  views:
    - id: primary
      name: Primary
      type: table
      filters:
        - id: rating-filter
          prop: rating
          op: contains
          value: four
        - id: status-filter
          prop: status
          op: contains
          value: open
      sorts: []
      groupBy: null
      dateProp: null
      hidden: []
    - id: secondary
      name: Secondary
      type: table
      filters:
        - id: secondary-status
          prop: status
          op: contains
          value: open
      sorts: []
      groupBy: null
      dateProp: null
      hidden: []
---
`,
      'Records/Original row title.md': `---
Rating: four # preserve the moved value comment
Status: open # keep the other column comment
Unrelated: preserved # keep unknown metadata comment
---
`,
    });
    const open = async () => {
      const opened = await WorkspaceSession.open(new VaultRepository(vault, newId), { delayMs: 0 });
      if (!opened.ok) throw new Error(opened.error);
      return opened.value;
    };

    const session = await open();
    setSession(session);
    const database = Object.values(session.getState().pages).find((page) => page.kind === 'database')!;
    const row = Object.values(session.getState().pages).find(
      (page) => page.parentId === database.id && page.title === 'Original row title',
    )!;
    expect(row.properties).toEqual({ rating: 'four', status: 'open' });
    expect(row.extra).toEqual({ Unrelated: 'preserved' });

    expect(deleteProperty(database.id, 'rating')).toBe(true);
    const updated = session.getState();
    const updatedDatabase = updated.pages[database.id]!;
    const updatedRow = updated.pages[row.id]!;
    expect(updatedDatabase.database?.properties.map((property) => property.id)).toEqual(['status']);
    expect(updatedDatabase.database?.titleAlias).toBe('Record');
    expect(updatedDatabase.database?.displayPropertyId).toBeUndefined();
    expect(updatedDatabase.database?.views[0]?.filters).toEqual([
      { id: 'status-filter', prop: 'status', op: 'contains', value: 'open' },
    ]);
    expect(updatedDatabase.database?.views[1]?.filters).toEqual([
      { id: 'secondary-status', prop: 'status', op: 'contains', value: 'open' },
    ]);
    expect(updatedRow.id).toBe(row.id);
    expect(updatedRow.title).toBe('Original row title');
    expect(updatedRow.properties).toEqual({ status: 'open' });
    expect(updatedRow.extra).toEqual({ Unrelated: 'preserved', Rating: 'four' });

    expect(await session.flush()).toBe(true);
    expect(vault.text('Records.md')).toContain('titleAlias: Record');
    expect(vault.text('Records.md')).not.toContain('displayPropertyId: rating');
    const savedRow = vault.text('Records/Original row title.md')!;
    expect(savedRow).toContain('Rating: four # preserve the moved value comment');
    expect(savedRow).toContain('Status: open # keep the other column comment');
    expect(savedRow).toContain('Unrelated: preserved # keep unknown metadata comment');
    await session.close();

    const reopened = await open();
    setSession(reopened);
    const reopenedDatabase = Object.values(reopened.getState().pages).find(
      (page) => page.kind === 'database',
    )!;
    const reopenedRow = Object.values(reopened.getState().pages).find(
      (page) => page.parentId === reopenedDatabase.id && page.title === 'Original row title',
    )!;
    expect(reopenedDatabase.database?.titleAlias).toBe('Record');
    expect(reopenedDatabase.database?.displayPropertyId).toBeUndefined();
    expect(reopenedDatabase.database?.views[1]?.filters).toEqual([
      { id: 'secondary-status', prop: 'status', op: 'contains', value: 'open' },
    ]);
    expect(reopenedRow.id).toBe(row.id);
    expect(reopenedRow.title).toBe('Original row title');
    expect(reopenedRow.properties).toEqual({ status: 'open' });
    expect(reopenedRow.extra).toEqual({ Unrelated: 'preserved', Rating: 'four' });
    await reopened.close();
  });

  it('blocks deletion while a relation still overrides its display with that column', async () => {
    const opened = await WorkspaceSession.open(new VaultRepository(new MemoryVault(), () => 'generated'), {
      delayMs: 0,
    });
    if (!opened.ok) throw new Error(opened.error);
    const session = opened.value;
    setSession(session);

    const target = session.execute({
      type: 'page.create',
      id: 'target-db',
      parentId: null,
      title: 'Target',
      kind: 'database',
      database: {
        properties: [{ id: 'status', name: 'Status', type: 'text', options: [] }],
        views: [],
      },
      now: 1,
    });
    if (!target.ok) throw new Error(target.error);
    const source = session.execute({
      type: 'page.create',
      id: 'source-db',
      parentId: null,
      title: 'Source',
      kind: 'database',
      database: {
        properties: [
          {
            id: 'target-link',
            name: 'Target',
            type: 'relation',
            options: [],
            relation: {
              targetDatabaseId: 'target-db',
              multiple: false,
              isInverse: false,
              displayPropertyId: 'status',
              inversePropertyId: null,
              filters: [],
            },
          },
        ],
        views: [],
      },
      now: 2,
    });
    if (!source.ok) throw new Error(source.error);

    expect(deleteProperty('target-db', 'status')).toBe(false);
    expect(
      session.getState().pages['target-db']?.database?.properties.map((property) => property.id),
    ).toEqual(['status']);
    expect(session.getState().pages['source-db']?.database?.properties[0]?.relation?.displayPropertyId).toBe(
      'status',
    );
    await session.close();
  });
});

describe('database view updates', () => {
  it('reorders one view without changing row metadata or rewriting row Markdown', async () => {
    let nextId = 0;
    const newId = () => `view-order-${++nextId}`;
    const vault = new MemoryVault({
      'Records.md': `---
kind: database
database:
  properties:
    - id: status
      name: Status
      type: text
    - id: notes
      name: Notes
      type: text
    - id: owner
      name: Owner
      type: text
  views:
    - id: primary
      name: Primary
      type: table
      sorts: []
      filters: []
      groupBy: null
      dateProp: null
      hidden: []
      order: [status, title, notes, future-column, owner]
    - id: secondary
      name: Secondary
      type: table
      sorts: []
      filters: []
      groupBy: null
      dateProp: null
      hidden: []
      order: [owner, notes, title, status]
---
`,
      'Records/Row.md': `---
Status: Open # keep the row's property comment
Notes: Preserve this value
Unrelated: Keep this unknown key
---
# Original row body
`,
    });
    const open = async () => {
      const opened = await WorkspaceSession.open(new VaultRepository(vault, newId), { delayMs: 0 });
      if (!opened.ok) throw new Error(opened.error);
      return opened.value;
    };
    const session = await open();
    setSession(session);
    const database = Object.values(session.getState().pages).find((page) => page.kind === 'database')!;
    const row = Object.values(session.getState().pages).find((page) => page.parentId === database.id)!;
    const rowUpdatedAt = row.updatedAt;
    const originalRowText = vault.text('Records/Row.md');
    const originalDatabaseText = vault.text('Records.md');
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 10_000);

    updateView(database.id, 'primary', (view) => ({
      ...view,
      order: ['status', 'notes', 'title', 'future-column', 'owner'],
    }));

    const updated = session.getState();
    expect(updated.pages[row.id]?.updatedAt).toBe(rowUpdatedAt);
    expect(updated.pages[row.id]?.properties).toEqual(row.properties);
    expect(updated.pages[row.id]?.extra).toEqual(row.extra);
    expect(updated.pages[database.id]?.database?.views[0]?.order).toEqual([
      'status',
      'notes',
      'title',
      'future-column',
      'owner',
    ]);
    expect(updated.pages[database.id]?.database?.views[1]?.order).toEqual([
      'owner',
      'notes',
      'title',
      'status',
    ]);

    expect(await session.flush()).toBe(true);
    expect(vault.text('Records/Row.md')).toBe(originalRowText);
    expect(vault.text('Records.md')).not.toBe(originalDatabaseText);
    await session.close();
    vi.restoreAllMocks();

    const reopened = await open();
    setSession(reopened);
    const reopenedDatabase = Object.values(reopened.getState().pages).find(
      (page) => page.kind === 'database',
    )!;
    const reopenedRow = Object.values(reopened.getState().pages).find(
      (page) => page.parentId === reopenedDatabase.id,
    )!;
    expect(reopenedDatabase.database?.views[0]?.order).toEqual([
      'status',
      'notes',
      'title',
      'future-column',
      'owner',
    ]);
    expect(reopenedDatabase.database?.views[1]?.order).toEqual(['owner', 'notes', 'title', 'status']);
    expect(reopenedRow.id).toBe(row.id);
    expect(reopenedRow.updatedAt).toBe(rowUpdatedAt);
    expect(reopenedRow.properties).toEqual(row.properties);
    expect(reopenedRow.extra).toEqual(row.extra);
    expect(vault.text('Records/Row.md')).toBe(originalRowText);
    await reopened.close();
  });
});
