import { describe, expect, it, vi } from 'vitest';
import type { VaultOp } from '../core/vault/plan';
import { createDataApi } from '../app/plugins/dataApi';
import type { DataApi, DataApiSnapshot } from '../app/plugins/dataApi';
import { E003_POLARIS_DADOS_FIXTURE } from './fixtures/e003-polaris-dados';
import { MemoryVault } from './memoryVault';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';

type HistoryDirection = Parameters<DataApi['history']>[0]['direction'];
type ReadySnapshot = Extract<DataApiSnapshot, { status: 'ready' }>;

let nextId = 0;
const newId = () => `pilot-history-${++nextId}`;

class CountingMemoryVault extends MemoryVault {
  applyCount = 0;

  override async apply(ops: VaultOp[]) {
    this.applyCount += 1;
    return super.apply(ops);
  }
}

function fixture(): Record<string, string> {
  return {
    ...E003_POLARIS_DADOS_FIXTURE,
    'Inventory/Widget.md': E003_POLARIS_DADOS_FIXTURE['Inventory/Widget.md']!.replace(
      'Price: 10',
      'Price: null',
    ),
    'Inventory/Missing price.md': `---
Name: Missing price
Quantity: 1
---
Missing is distinct from an explicit null.
`,
    'Budget.md': E003_POLARIS_DADOS_FIXTURE['Inventory.md']!.replace('# Inventory', '# Budget'),
    'Budget/Office.md': E003_POLARIS_DADOS_FIXTURE['Inventory/Widget.md']!.replace(
      'Name: Widget',
      'Name: Office stock',
    )
      .replace('Quantity: 2', 'Quantity: 7')
      .replace('Price: 10', 'Price: 11'),
  };
}

async function open(vault: MemoryVault, delayMs = 60_000): Promise<WorkspaceSession> {
  const result = await WorkspaceSession.open(new VaultRepository(vault, newId), { delayMs });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function idAt(session: WorkspaceSession, path: string): string {
  const id = Object.keys(session.getState().pages).find((candidate) => session.pathOf(candidate) === path);
  if (!id) throw new Error(`No page at ${path}`);
  return id;
}

function apiFor(
  session: WorkspaceSession,
  options: {
    ownerIsActive?: () => boolean;
    isProviderActive?: (databaseId: string) => boolean;
    isHostReadonly?: () => boolean;
  } = {},
): { api: DataApi; cleanup: () => void } {
  let cleanup = () => {};
  const api = createDataApi({
    session,
    ownerIsActive: options.ownerIsActive ?? (() => true),
    isProviderActive: options.isProviderActive ?? (() => true),
    isHostReadonly: options.isHostReadonly ?? (() => false),
    registerCleanup: (onCleanup) => {
      cleanup = onCleanup;
    },
  });
  return { api, cleanup: () => cleanup() };
}

function read(api: DataApi, databaseId: string): ReadySnapshot {
  const snapshot = api.snapshot(databaseId);
  if (snapshot.status !== 'ready') throw new Error(`Expected ready snapshot, got ${snapshot.status}.`);
  return snapshot;
}

function history(api: DataApi, databaseId: string, direction: HistoryDirection, expectedRevision?: string) {
  const current = read(api, databaseId);
  return api.history({
    databaseId,
    direction,
    expectedRevision: expectedRevision ?? current.revision,
  });
}

function quantity(api: DataApi, databaseId: string, rowId: string): number | null | undefined {
  return read(api, databaseId).rows.find((row) => row.id === rowId)?.properties.quantity as
    number | null | undefined;
}

function patchNumber(api: DataApi, databaseId: string, rowId: string, propertyId: string, value: number) {
  return api.patchCell({
    databaseId,
    rowId,
    propertyId,
    value,
    expectedRevision: read(api, databaseId).revision,
  });
}

describe('independent Polaris Dados history contract', () => {
  it('supports the 2-to-3-to-2-to-3 undo/redo branch and clears redo after a new edit', async () => {
    const vault = new MemoryVault(fixture());
    const session = await open(vault);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const rowId = idAt(session, 'Inventory/Widget.md');
    try {
      const initial = read(api, databaseId);
      expect(initial.history).toEqual({ canUndo: false, canRedo: false });
      expect(history(api, databaseId, 'undo')).toMatchObject({ status: 'no-op', direction: 'undo' });
      const afterNoop = read(api, databaseId);
      expect(afterNoop.revision).toBe(initial.revision);
      expect(history(api, databaseId, 'redo')).toMatchObject({ status: 'no-op', direction: 'redo' });

      expect(patchNumber(api, databaseId, rowId, 'quantity', 3).status).toBe('staged');
      expect(quantity(api, databaseId, rowId)).toBe(3);
      expect(read(api, databaseId).history).toEqual({ canUndo: true, canRedo: false });
      expect(patchNumber(api, databaseId, rowId, 'quantity', 2).status).toBe('staged');
      expect(patchNumber(api, databaseId, rowId, 'quantity', 3).status).toBe('staged');

      expect(history(api, databaseId, 'undo')).toMatchObject({ status: 'staged', direction: 'undo' });
      expect(quantity(api, databaseId, rowId)).toBe(2);
      expect(read(api, databaseId).history).toEqual({ canUndo: true, canRedo: true });
      expect(history(api, databaseId, 'redo')).toMatchObject({ status: 'staged', direction: 'redo' });
      expect(quantity(api, databaseId, rowId)).toBe(3);

      expect(history(api, databaseId, 'undo')).toMatchObject({ status: 'staged', direction: 'undo' });
      expect(quantity(api, databaseId, rowId)).toBe(2);
      expect(read(api, databaseId).history.canRedo).toBe(true);
      expect(patchNumber(api, databaseId, rowId, 'quantity', 3).status).toBe('staged');
      expect(read(api, databaseId).history).toEqual({ canUndo: true, canRedo: false });
      expect(history(api, databaseId, 'redo')).toMatchObject({ status: 'no-op', direction: 'redo' });
      expect(quantity(api, databaseId, rowId)).toBe(3);
    } finally {
      cleanup();
      await session.close();
    }
  });

  it('restores explicit null, absent properties, and numbers without collapsing slot presence', async () => {
    const vault = new MemoryVault(fixture());
    const session = await open(vault);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const widgetId = idAt(session, 'Inventory/Widget.md');
    const missingId = idAt(session, 'Inventory/Missing price.md');
    try {
      expect(read(api, databaseId).rows.find((row) => row.id === widgetId)?.properties.price).toBeNull();
      expect(
        Object.hasOwn(read(api, databaseId).rows.find((row) => row.id === missingId)!.properties, 'price'),
      ).toBe(false);

      expect(patchNumber(api, databaseId, widgetId, 'price', 9).status).toBe('staged');
      expect(read(api, databaseId).rows.find((row) => row.id === widgetId)?.properties.price).toBe(9);
      expect(history(api, databaseId, 'undo').status).toBe('staged');
      expect(read(api, databaseId).rows.find((row) => row.id === widgetId)?.properties.price).toBeNull();
      expect(await api.flush(databaseId)).toMatchObject({ status: 'persisted' });
      expect(vault.text('Inventory/Widget.md')).toContain('Price: null');
      expect(history(api, databaseId, 'redo').status).toBe('staged');
      expect(read(api, databaseId).rows.find((row) => row.id === widgetId)?.properties.price).toBe(9);

      expect(patchNumber(api, databaseId, missingId, 'price', 5).status).toBe('staged');
      expect(
        Object.hasOwn(read(api, databaseId).rows.find((row) => row.id === missingId)!.properties, 'price'),
      ).toBe(true);
      expect(history(api, databaseId, 'undo').status).toBe('staged');
      expect(
        Object.hasOwn(read(api, databaseId).rows.find((row) => row.id === missingId)!.properties, 'price'),
      ).toBe(false);
      expect(await api.flush(databaseId)).toMatchObject({ status: 'persisted' });
      expect(vault.text('Inventory/Missing price.md')).not.toContain('Price:');
      expect(history(api, databaseId, 'redo').status).toBe('staged');
      expect(read(api, databaseId).rows.find((row) => row.id === missingId)?.properties.price).toBe(5);

      expect(await api.flush(databaseId)).toMatchObject({ status: 'persisted' });
      const savedWidget = vault.text('Inventory/Widget.md')!;
      const savedMissing = vault.text('Inventory/Missing price.md')!;
      expect(savedWidget).toContain('Price: 9');
      expect(savedMissing).toContain('Price: 5');
      await session.close();

      const reopened = await open(vault);
      const reopenedHandle = apiFor(reopened);
      const afterRestart = read(reopenedHandle.api, idAt(reopened, 'Inventory.md'));
      expect(afterRestart.rows.find((row) => row.id === widgetId)?.properties.price).toBe(9);
      expect(afterRestart.rows.find((row) => row.id === missingId)?.properties.price).toBe(5);
      expect(afterRestart.history).toEqual({ canUndo: false, canRedo: false });
      reopenedHandle.cleanup();
      await reopened.close();
    } finally {
      cleanup();
      if (!session.isClosed) await session.close();
    }
  });

  it('limits undo history to the latest ten edits', async () => {
    const vault = new MemoryVault(fixture());
    const session = await open(vault);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const rowId = idAt(session, 'Inventory/Widget.md');
    try {
      for (let value = 3; value <= 13; value += 1) {
        expect(patchNumber(api, databaseId, rowId, 'quantity', value).status).toBe('staged');
      }
      expect(quantity(api, databaseId, rowId)).toBe(13);
      for (let step = 0; step < 10; step += 1) {
        expect(history(api, databaseId, 'undo').status).toBe('staged');
      }
      expect(quantity(api, databaseId, rowId)).toBe(3);
      expect(read(api, databaseId).history).toEqual({ canUndo: false, canRedo: true });
      const revisionAtOldest = read(api, databaseId).revision;
      expect(history(api, databaseId, 'undo')).toMatchObject({ status: 'no-op', direction: 'undo' });
      expect(read(api, databaseId).revision).toBe(revisionAtOldest);
      expect(quantity(api, databaseId, rowId)).toBe(3);
    } finally {
      cleanup();
      await session.close();
    }
  });

  it('shares history between handles but isolates stacks by database', async () => {
    const vault = new MemoryVault(fixture());
    const session = await open(vault);
    const firstHandle = apiFor(session);
    const secondHandle = apiFor(session);
    const inventoryId = idAt(session, 'Inventory.md');
    const widgetId = idAt(session, 'Inventory/Widget.md');
    const budgetId = idAt(session, 'Budget.md');
    const officeId = idAt(session, 'Budget/Office.md');
    try {
      expect(patchNumber(firstHandle.api, inventoryId, widgetId, 'quantity', 3).status).toBe('staged');
      expect(read(secondHandle.api, inventoryId).history.canUndo).toBe(true);
      expect(read(secondHandle.api, budgetId).history).toEqual({ canUndo: false, canRedo: false });

      expect(patchNumber(secondHandle.api, budgetId, officeId, 'quantity', 8).status).toBe('staged');
      expect(read(firstHandle.api, budgetId).history).toEqual({ canUndo: true, canRedo: false });
      expect(history(secondHandle.api, budgetId, 'undo').status).toBe('staged');
      expect(quantity(firstHandle.api, budgetId, officeId)).toBe(7);
      expect(read(firstHandle.api, inventoryId).history.canUndo).toBe(true);

      expect(history(secondHandle.api, inventoryId, 'undo').status).toBe('staged');
      expect(quantity(firstHandle.api, inventoryId, widgetId)).toBe(2);
      expect(read(firstHandle.api, inventoryId).history).toEqual({ canUndo: false, canRedo: true });
    } finally {
      firstHandle.cleanup();
      secondHandle.cleanup();
      await session.close();
    }
  });

  it('keeps undo/redo through navigation metadata and exposes it before reentrant subscribers run', async () => {
    const vault = new MemoryVault(fixture());
    const session = await open(vault);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const rowId = idAt(session, 'Inventory/Widget.md');
    const events: Array<{ quantity: number | null | undefined; canUndo: boolean; canRedo: boolean }> = [];
    let patchedFromInitialNotification = false;
    let unsubscribe = () => {};
    try {
      unsubscribe = api.subscribe(databaseId, (snapshot) => {
        if (snapshot.status !== 'ready') return;
        const current = snapshot;
        const value = current.rows.find((row) => row.id === rowId)?.properties.quantity as
          number | null | undefined;
        events.push({
          quantity: value,
          canUndo: current.history.canUndo,
          canRedo: current.history.canRedo,
        });
        if (patchedFromInitialNotification || value !== 2) return;
        patchedFromInitialNotification = true;
        expect(
          api.patchCell({
            databaseId,
            rowId,
            propertyId: 'quantity',
            value: 3,
            expectedRevision: current.revision,
          }),
        ).toMatchObject({ status: 'staged' });
      });

      expect(events).toEqual([
        { quantity: 2, canUndo: false, canRedo: false },
        { quantity: 3, canUndo: true, canRedo: false },
      ]);
      const beforeUndo = read(api, databaseId);
      expect(history(api, databaseId, 'undo').status).toBe('staged');
      const beforeNavigation = read(api, databaseId);
      expect(beforeNavigation.revision).not.toBe(beforeUndo.revision);
      expect(beforeNavigation.history).toEqual({ canUndo: false, canRedo: true });
      expect(session.execute({ type: 'page.markOpened', id: databaseId, now: 123 }).ok).toBe(true);
      expect(read(api, databaseId).history).toEqual(beforeNavigation.history);
      expect(read(api, databaseId).revision).toBe(beforeNavigation.revision);
      expect(history(api, databaseId, 'redo').status).toBe('staged');
      expect(quantity(api, databaseId, rowId)).toBe(3);
    } finally {
      unsubscribe();
      cleanup();
      await session.close();
    }
  });

  it('does not consume history on stale revision, readonly checks, or a recoverable row conflict', async () => {
    vi.useFakeTimers();
    const vault = new CountingMemoryVault(fixture());
    const session = await open(vault, 60_000);
    let providerActive = true;
    let hostReadonly = false;
    const handle = apiFor(session, {
      isProviderActive: () => providerActive,
      isHostReadonly: () => hostReadonly,
    });
    const databaseId = idAt(session, 'Inventory.md');
    const rowId = idAt(session, 'Inventory/Widget.md');
    try {
      const initial = read(handle.api, databaseId);
      expect(patchNumber(handle.api, databaseId, rowId, 'quantity', 3).status).toBe('staged');
      const staged = read(handle.api, databaseId);
      expect(history(handle.api, databaseId, 'undo', initial.revision)).toMatchObject({
        status: 'error',
        code: 'stale-revision',
      });
      expect(quantity(handle.api, databaseId, rowId)).toBe(3);
      expect(read(handle.api, databaseId).history).toEqual(staged.history);
      const invalidDirection = handle.api.history({
        databaseId,
        direction: 'rewind',
        expectedRevision: staged.revision,
      } as unknown as Parameters<DataApi['history']>[0]);
      expect(invalidDirection).toMatchObject({ status: 'error', code: 'invalid-value' });
      expect(read(handle.api, databaseId).history).toEqual(staged.history);

      providerActive = false;
      expect(read(handle.api, databaseId)).toMatchObject({
        readonly: true,
        history: { canUndo: false, canRedo: false },
      });
      expect(history(handle.api, databaseId, 'undo')).toMatchObject({
        status: 'error',
        code: 'provider-inactive',
      });
      providerActive = true;
      hostReadonly = true;
      expect(history(handle.api, databaseId, 'undo')).toMatchObject({
        status: 'error',
        code: 'host-readonly',
      });
      expect(quantity(handle.api, databaseId, rowId)).toBe(3);
      hostReadonly = false;
      expect(read(handle.api, databaseId).history).toEqual(staged.history);

      const originalRow = vault.text('Inventory/Widget.md')!;
      const externalRow = originalRow.replace('Quantity: 2', 'Quantity: 4');
      vault.external({ 'Inventory/Widget.md': externalRow });
      expect(await handle.api.flush(databaseId)).toMatchObject({ status: 'error', code: 'save-conflict' });
      expect(vault.text('Inventory/Widget.md')).toBe(externalRow);
      expect(quantity(handle.api, databaseId, rowId)).toBe(3);
      expect(read(handle.api, databaseId)).toMatchObject({
        readonly: true,
        history: { canUndo: false, canRedo: false },
      });
      expect(history(handle.api, databaseId, 'undo')).toMatchObject({
        status: 'error',
        code: 'save-conflict',
      });
      expect(quantity(handle.api, databaseId, rowId)).toBe(3);

      vault.external({ 'Inventory/Widget.md': originalRow });
      expect(await handle.api.flush(databaseId)).toMatchObject({ status: 'persisted' });
      expect(read(handle.api, databaseId)).toMatchObject({
        readonly: false,
        history: { canUndo: true, canRedo: false },
      });
      expect(history(handle.api, databaseId, 'undo').status).toBe('staged');
      expect(quantity(handle.api, databaseId, rowId)).toBe(2);
      expect(vault.applyCount).toBeGreaterThan(0);
    } finally {
      handle.cleanup();
      if (!session.isClosed) await session.close();
      vi.useRealTimers();
    }
  });

  it('invalidates accepted external history and rejects stale directions without restoring old data', async () => {
    const vault = new CountingMemoryVault(fixture());
    const session = await open(vault);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const rowId = idAt(session, 'Inventory/Widget.md');
    try {
      expect(patchNumber(api, databaseId, rowId, 'quantity', 3).status).toBe('staged');
      expect(await api.flush(databaseId)).toMatchObject({ status: 'persisted' });
      const beforeExternal = read(api, databaseId);
      expect(beforeExternal.history.canUndo).toBe(true);

      const externalRow = vault.text('Inventory/Widget.md')!.replace('Quantity: 3', 'Quantity: 4');
      vault.external({ 'Inventory/Widget.md': externalRow });
      const afterExternal = read(api, databaseId);
      expect(afterExternal.revision).not.toBe(beforeExternal.revision);
      expect(quantity(api, databaseId, rowId)).toBe(4);
      expect(afterExternal.history).toEqual({ canUndo: false, canRedo: false });
      expect(history(api, databaseId, 'undo', beforeExternal.revision)).toMatchObject({
        status: 'error',
        code: 'stale-revision',
      });
      const currentUndo = history(api, databaseId, 'undo', afterExternal.revision);
      expect(currentUndo.status).not.toBe('staged');
      expect(quantity(api, databaseId, rowId)).toBe(4);
    } finally {
      cleanup();
      await session.close();
    }
  });

  it('persists the final value but starts a new history session after reopening the same database id', async () => {
    const vault = new MemoryVault(fixture());
    let first: WorkspaceSession | undefined;
    let second: WorkspaceSession | undefined;
    let oldCleanup = () => {};
    let newCleanup = () => {};
    try {
      first = await open(vault);
      await first.markInitialized();
      const databaseId = idAt(first, 'Inventory.md');
      const rowId = idAt(first, 'Inventory/Widget.md');
      const oldHandle = apiFor(first);
      oldCleanup = oldHandle.cleanup;
      expect(patchNumber(oldHandle.api, databaseId, rowId, 'quantity', 3).status).toBe('staged');
      expect(history(oldHandle.api, databaseId, 'undo').status).toBe('staged');
      expect(quantity(oldHandle.api, databaseId, rowId)).toBe(2);
      expect(history(oldHandle.api, databaseId, 'redo').status).toBe('staged');
      expect(quantity(oldHandle.api, databaseId, rowId)).toBe(3);
      expect(await oldHandle.api.flush(databaseId)).toMatchObject({ status: 'persisted' });
      expect(read(oldHandle.api, databaseId).history).toEqual({ canUndo: true, canRedo: false });

      oldCleanup();
      oldCleanup = () => {};
      await first.close();
      second = await open(vault);
      const reopenedId = idAt(second, 'Inventory.md');
      expect(reopenedId).toBe(databaseId);
      const newHandle = apiFor(second);
      newCleanup = newHandle.cleanup;
      expect(quantity(newHandle.api, reopenedId, rowId)).toBe(3);
      expect(read(newHandle.api, reopenedId).history).toEqual({ canUndo: false, canRedo: false });
      expect(() => oldHandle.api.snapshot(databaseId)).toThrow(/no longer active/i);
      expect(
        oldHandle.api.history({ databaseId, direction: 'undo', expectedRevision: 'stale' }),
      ).toMatchObject({
        status: 'error',
        code: 'owner-inactive',
      });
    } finally {
      oldCleanup();
      newCleanup();
      if (second && !second.isClosed) await second.close();
      if (first && !first.isClosed) await first.close();
    }
  });
});
