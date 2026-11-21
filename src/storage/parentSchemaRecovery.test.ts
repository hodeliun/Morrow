import { describe, expect, it } from 'vitest';
import type { VaultOp } from '../core/vault/plan';
import { createDataApi } from '../app/plugins/dataApi';
import type { DataApiSnapshot } from '../app/plugins/dataApi';
import { encryptPage, newPageKey } from '../core/crypto';
import { MAX_PAGE_BYTES } from '../core/vault/load';
import { E003_POLARIS_DADOS_FIXTURE } from './fixtures/e003-polaris-dados';
import { MemoryVault } from './memoryVault';
import type { ExternalPatch } from './repository';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';

const DATABASE_PATH = 'Inventory.md';
const ROW_PATH = 'Inventory/Widget.md';
let nextId = 0;
const newId = () => `parent-recovery-${++nextId}`;

class CountingMemoryVault extends MemoryVault {
  applyCount = 0;

  override async apply(ops: VaultOp[]) {
    this.applyCount += 1;
    return super.apply(ops);
  }
}

function fixture(): Record<string, string> {
  const database = E003_POLARIS_DADOS_FIXTURE[DATABASE_PATH]!.replace(
    'database:\n  properties:',
    'futureDatabase:\n  opaque:\n    id: unknown-parent-id\n    nested:\n      keep: true\ndatabase:\n  properties:',
  );
  return { ...E003_POLARIS_DADOS_FIXTURE, [DATABASE_PATH]: database };
}

function unsupportedSchema(database: string): string {
  return database.replace('type: number', 'type: future-v153');
}

function addCategoryProperty(database: string): string {
  return database.replace(
    '    - id: total\n',
    '    - id: category\n      name: Category\n      type: text\n    - id: total\n',
  );
}

function addCategoryRow(row: string): string {
  return row
    .replace('Price: 10\n', 'Price: 10\nCategory: Tools\n')
    .replace('opaque-widget-7f21', 'opaque-widget-restored-42')
    .replace('source: synthetic', 'source: external-restore');
}

async function open(vault: MemoryVault, delayMs = 0): Promise<WorkspaceSession> {
  const result = await WorkspaceSession.open(new VaultRepository(vault, newId), { delayMs });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function idAt(session: WorkspaceSession, path: string): string {
  const id = Object.keys(session.getState().pages).find((candidate) => session.pathOf(candidate) === path);
  if (!id) throw new Error(`No page at ${path}`);
  return id;
}

function apiFor(session: WorkspaceSession) {
  let cleanup = () => {};
  const api = createDataApi({
    session,
    ownerIsActive: () => true,
    isProviderActive: () => true,
    isHostReadonly: () => false,
    registerCleanup: (onCleanup) => {
      cleanup = onCleanup;
    },
  });
  return { api, cleanup: () => cleanup() };
}

function ready(snapshot: DataApiSnapshot) {
  if (snapshot.status !== 'ready') throw new Error(`Expected ready snapshot, received ${snapshot.status}.`);
  return snapshot;
}

function hasRawBlock(session: WorkspaceSession, id: string): boolean {
  return JSON.stringify(session.getState().docs[id]).includes('"type":"rawBlock"');
}

describe('recovering rows after a database schema becomes representable', () => {
  it('restores only the parent, reparses its unchanged rows, and preserves the pilot projection without writes', async () => {
    const initial = fixture();
    const vault = new CountingMemoryVault(initial);
    const session = await open(vault);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, DATABASE_PATH);
    const rowId = idAt(session, ROW_PATH);
    const rowBytes = vault.text(ROW_PATH);
    const rowMtime = vault.modifiedTime(ROW_PATH);
    const formula = ready(api.snapshot(databaseId)).schema.properties.find((property) => property.id === 'total');
    expect(formula).toMatchObject({ type: 'formula', formula: 'Quantity * Price' });

    try {
      vault.external({ [DATABASE_PATH]: unsupportedSchema(initial[DATABASE_PATH]!) });
      expect(session.unreadable.has(databaseId)).toBe(true);
      expect(session.unreadable.has(rowId)).toBe(true);
      expect(session.protectedReasons.get(rowId)).toMatch(/parent database is protected/i);
      expect(hasRawBlock(session, rowId)).toBe(true);
      expect(api.snapshot(databaseId).status).toBe('unsupported');

      vault.external({ [DATABASE_PATH]: initial[DATABASE_PATH]! });

      expect(session.unreadable.has(databaseId)).toBe(false);
      expect(session.unreadable.has(rowId)).toBe(false);
      expect(session.protectedReasons.has(rowId)).toBe(false);
      expect(hasRawBlock(session, rowId)).toBe(false);
      expect(idAt(session, DATABASE_PATH)).toBe(databaseId);
      expect(idAt(session, ROW_PATH)).toBe(rowId);
      expect(vault.text(ROW_PATH)).toBe(rowBytes);
      expect(vault.modifiedTime(ROW_PATH)).toBe(rowMtime);
      expect(vault.applyCount).toBe(0);

      const snapshot = ready(api.snapshot(databaseId));
      const row = snapshot.rows.find((candidate) => candidate.id === rowId)!;
      expect(row.properties).toMatchObject({ quantity: 2, price: 10 });
      expect(snapshot.schema.properties.find((property) => property.id === 'total'))
        .toMatchObject({ type: 'formula', formula: 'Quantity * Price' });
      expect(session.getState().pages[rowId]!.extra.vendorRecord).toMatchObject({
        id: 'opaque-widget-7f21',
        audit: { source: 'synthetic', tags: ['retain', 'nested'] },
      });

      const staged = api.patchCell({
        databaseId,
        rowId,
        propertyId: 'quantity',
        value: 3,
        expectedRevision: snapshot.revision,
      });
      expect(staged.status).toBe('staged');
      expect(await api.flush(databaseId)).toMatchObject({ status: 'persisted' });
      expect(vault.text(ROW_PATH)).toContain('vendorRecord:');
      expect(vault.text(ROW_PATH)).toContain('id: opaque-widget-7f21');
      expect(vault.text(DATABASE_PATH)).toContain('id: unknown-parent-id');
    } finally {
      cleanup();
      await session.close();
    }
  });

  it('uses the corrected parent schema and the newest row text when both change in one event', async () => {
    const initial = fixture();
    const vault = new CountingMemoryVault(initial);
    const session = await open(vault);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, DATABASE_PATH);
    const rowId = idAt(session, ROW_PATH);
    const restoredSchema = addCategoryProperty(initial[DATABASE_PATH]!);
    const restoredRow = addCategoryRow(initial[ROW_PATH]!);

    try {
      vault.external({ [DATABASE_PATH]: unsupportedSchema(initial[DATABASE_PATH]!) });
      expect(session.protectedReasons.has(rowId)).toBe(true);

      vault.external({ [DATABASE_PATH]: restoredSchema, [ROW_PATH]: restoredRow });

      const snapshot = ready(api.snapshot(databaseId));
      expect(snapshot.schema.properties.find((property) => property.id === 'category'))
        .toMatchObject({ name: 'Category', type: 'text' });
      expect(snapshot.rows.find((candidate) => candidate.id === rowId)?.properties.category).toBe('Tools');
      expect(session.getState().pages[rowId]!.extra.vendorRecord).toMatchObject({
        id: 'opaque-widget-restored-42',
        audit: { source: 'external-restore', tags: ['retain', 'nested'] },
      });
      expect(session.unreadable.has(rowId)).toBe(false);
      expect(session.protectedReasons.has(rowId)).toBe(false);
      expect(hasRawBlock(session, rowId)).toBe(false);
      expect(idAt(session, DATABASE_PATH)).toBe(databaseId);
      expect(idAt(session, ROW_PATH)).toBe(rowId);
      expect(vault.text(ROW_PATH)).toBe(restoredRow);
      expect(vault.applyCount).toBe(0);

      const current = ready(api.snapshot(databaseId));
      const staged = api.patchCell({
        databaseId,
        rowId,
        propertyId: 'quantity',
        value: 4,
        expectedRevision: current.revision,
      });
      expect(staged.status).toBe('staged');
      expect(await api.flush(databaseId)).toMatchObject({ status: 'persisted' });
      expect(vault.text(ROW_PATH)).toContain('id: opaque-widget-restored-42');
      expect(vault.text(ROW_PATH)).toContain('source: external-restore');
      expect(vault.text(ROW_PATH)).toContain('Category: Tools');
    } finally {
      cleanup();
      await session.close();
    }
  });

  it('reparses the newest row text when the child is reported before its restored parent', async () => {
    const initial = fixture();
    const vault = new CountingMemoryVault(initial);
    const session = await open(vault);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, DATABASE_PATH);
    const rowId = idAt(session, ROW_PATH);
    const restoredSchema = addCategoryProperty(initial[DATABASE_PATH]!);
    const restoredRow = addCategoryRow(initial[ROW_PATH]!);

    try {
      vault.external({ [DATABASE_PATH]: unsupportedSchema(initial[DATABASE_PATH]!) });
      expect(session.protectedReasons.has(rowId)).toBe(true);

      vault.external({ [ROW_PATH]: restoredRow, [DATABASE_PATH]: restoredSchema });

      const snapshot = ready(api.snapshot(databaseId));
      expect(snapshot.rows.find((candidate) => candidate.id === rowId)?.properties.category).toBe('Tools');
      expect(session.getState().pages[rowId]!.extra.vendorRecord).toMatchObject({
        id: 'opaque-widget-restored-42',
        audit: { source: 'external-restore', tags: ['retain', 'nested'] },
      });
      expect(vault.text(ROW_PATH)).toBe(restoredRow);
      expect(vault.applyCount).toBe(0);
    } finally {
      cleanup();
      await session.close();
    }
  });

  it('recovers children when the unsupported parent was already present at open', async () => {
    const initial = fixture();
    const vault = new CountingMemoryVault({
      ...initial,
      [DATABASE_PATH]: unsupportedSchema(initial[DATABASE_PATH]!),
    });
    const session = await open(vault);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, DATABASE_PATH);
    const rowId = idAt(session, ROW_PATH);

    try {
      expect(session.unreadable.has(databaseId)).toBe(true);
      expect(session.unreadable.has(rowId)).toBe(true);
      vault.external({ [DATABASE_PATH]: initial[DATABASE_PATH]! });
      expect(session.unreadable.has(databaseId)).toBe(false);
      expect(session.unreadable.has(rowId)).toBe(false);
      expect(api.snapshot(databaseId).status).toBe('ready');
    } finally {
      cleanup();
      await session.close();
    }
  });

  it('keeps malformed, nonrepresentable, encrypted, and oversized rows protected after parent recovery', async () => {
    const initial = fixture();
    const encrypted = await encryptPage('Private row.\n', await newPageKey('synthetic-password'));
    const vault = new CountingMemoryVault({
      ...initial,
      'Inventory/Malformed.md': '---\nName: [broken\n---\n',
      'Inventory/Unsupported.md': '---\nName: Unsupported\n---\n<!-- morrow:image align="right" width="35%" -->\n',
      'Inventory/Encrypted.md': encrypted,
      'Inventory/Oversized.md': 'x'.repeat(MAX_PAGE_BYTES + 1),
    });
    const session = await open(vault);
    const databaseId = idAt(session, DATABASE_PATH);
    const protectedPaths = [
      'Inventory/Malformed.md',
      'Inventory/Unsupported.md',
      'Inventory/Encrypted.md',
      'Inventory/Oversized.md',
    ];
    const protectedIds = protectedPaths.map((path) => idAt(session, path));
    const before = new Map(protectedPaths.map((path) => [path, [vault.text(path), vault.modifiedTime(path)]]));

    try {
      vault.external({ [DATABASE_PATH]: unsupportedSchema(initial[DATABASE_PATH]!) });
      vault.external({ [DATABASE_PATH]: initial[DATABASE_PATH]! });

      for (const id of protectedIds) expect(session.unreadable.has(id)).toBe(true);
      expect(session.unreadable.has(databaseId)).toBe(false);
      expect(session.protectedReasons.get(idAt(session, 'Inventory/Unsupported.md')))
        .toMatch(/Morrow block marker/i);
      for (const path of [
        'Inventory/Malformed.md',
        'Inventory/Encrypted.md',
        'Inventory/Oversized.md',
      ]) {
        expect(session.protectedReasons.get(idAt(session, path)) ?? '')
          .not.toMatch(/parent database is protected/i);
      }
      for (const path of protectedPaths) {
        expect([vault.text(path), vault.modifiedTime(path)]).toEqual(before.get(path));
      }
      expect(vault.applyCount).toBe(0);
    } finally {
      await session.close();
    }
  });

  it('does not propagate or accept derived child protection when the dirty parent rejects the external schema', async () => {
    const initial = fixture();
    const vault = new CountingMemoryVault(initial);
    const session = await open(vault, 60_000);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, DATABASE_PATH);
    const rowId = idAt(session, ROW_PATH);
    const acceptances: string[][] = [];
    session.onExternal((_patch, accepted) => acceptances.push([...accepted]));

    try {
      expect(session.execute({ type: 'page.setIcon', id: databaseId, icon: '📊', now: 123 }).ok).toBe(true);
      expect(session.queue.isDirty(databaseId)).toBe(true);
      expect(session.getState().pages[databaseId]?.icon).toBe('📊');

      vault.external({ [DATABASE_PATH]: unsupportedSchema(initial[DATABASE_PATH]!) });

      expect(acceptances.at(-1)).not.toContain(databaseId);
      expect(acceptances.at(-1)).not.toContain(rowId);
      expect(session.unreadable.has(databaseId)).toBe(false);
      expect(session.unreadable.has(rowId)).toBe(false);
      expect(session.protectedReasons.has(rowId)).toBe(false);
      expect(api.snapshot(databaseId).status).toBe('ready');
      expect(session.getState().pages[databaseId]?.icon).toBe('📊');

      vault.external({ [DATABASE_PATH]: initial[DATABASE_PATH]! });

      expect(acceptances.at(-1)).not.toContain(databaseId);
      expect(acceptances.at(-1)).not.toContain(rowId);
      expect(session.unreadable.has(rowId)).toBe(false);
      expect(api.snapshot(databaseId).status).toBe('ready');
      expect(session.getState().pages[databaseId]?.icon).toBe('📊');
    } finally {
      cleanup();
      session.queue.dispose();
      await session.close();
    }
  });

  it('preserves a staged row draft and does not count it as externally accepted', async () => {
    const initial = fixture();
    const vault = new CountingMemoryVault(initial);
    const session = await open(vault, 60_000);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, DATABASE_PATH);
    const rowId = idAt(session, ROW_PATH);
    const diskRow = vault.text(ROW_PATH);
    const acceptances: string[][] = [];
    session.onExternal((_patch, accepted) => acceptances.push([...accepted]));

    try {
      const original = ready(api.snapshot(databaseId));
      expect(api.patchCell({
        databaseId,
        rowId,
        propertyId: 'quantity',
        value: 7,
        expectedRevision: original.revision,
      }).status).toBe('staged');
      expect(session.queue.isDirty(rowId)).toBe(true);

      vault.external({ [DATABASE_PATH]: unsupportedSchema(initial[DATABASE_PATH]!) });
      expect(acceptances.at(-1)).not.toContain(rowId);
      expect(session.getState().pages[rowId]!.properties.quantity).toBe(7);

      vault.external({ [DATABASE_PATH]: initial[DATABASE_PATH]! });

      expect(acceptances.at(-1)).not.toContain(rowId);
      expect(session.queue.isDirty(rowId)).toBe(true);
      expect(session.getState().pages[rowId]!.properties.quantity).toBe(7);
      expect(vault.text(ROW_PATH)).toBe(diskRow);
      expect(api.snapshot(databaseId).status).toBe('ready');
    } finally {
      cleanup();
      session.queue.dispose();
      await session.close();
    }
  });

  it('fails closed for missing, removed, and cyclic accepted-page dependencies', async () => {
    const vault = new CountingMemoryVault(fixture());
    const session = await open(vault);
    const databaseId = idAt(session, DATABASE_PATH);
    const rowId = idAt(session, ROW_PATH);
    const originalDatabase = session.getState().pages[databaseId]!;
    const originalRow = session.getState().pages[rowId]!;
    const changedDatabase = { ...originalDatabase, title: 'External database title' };
    const changedRow = { ...originalRow, title: 'External row title' };
    const basePatch: ExternalPatch = {
      pages: [],
      docs: {},
      removed: [],
      unreadable: [],
      readable: [],
    };

    try {
      const missingDependency = session.applyExternal({
        ...basePatch,
        pages: [changedRow],
        requiresAccepted: { [rowId]: ['missing-parent'] },
      });
      expect(missingDependency).not.toContain(rowId);
      expect(session.getState().pages[rowId]!.title).toBe(originalRow.title);

      const cyclic = session.applyExternal({
        ...basePatch,
        pages: [changedRow, changedDatabase],
        requiresAccepted: {
          [rowId]: [databaseId],
          [databaseId]: [rowId],
        },
      });
      expect(cyclic).toEqual([]);
      expect(session.getState().pages[rowId]!.title).toBe(originalRow.title);
      expect(session.getState().pages[databaseId]!.title).toBe(originalDatabase.title);

      const removedDependency = session.applyExternal({
        ...basePatch,
        pages: [changedRow],
        removed: [databaseId],
        requiresAccepted: { [rowId]: [databaseId] },
      });
      expect(removedDependency).toEqual([databaseId]);
      expect(session.getState().pages[databaseId]).toBeUndefined();
      expect(session.getState().pages[rowId]!.title).toBe(originalRow.title);
    } finally {
      await session.close();
    }
  });
});
