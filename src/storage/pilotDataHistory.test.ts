import { describe, expect, it } from 'vitest';
import { createDataApi } from '../app/plugins/dataApi';
import type { DataApi, DataApiSnapshot } from '../app/plugins/dataApi';
import { E003_POLARIS_DADOS_FIXTURE } from './fixtures/e003-polaris-dados';
import { MemoryVault } from './memoryVault';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';

let nextId = 0;
const newId = () => `pilot-history-${++nextId}`;

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
Missing price is distinct from an explicit null.
`,
  };
}

async function open(vault: MemoryVault): Promise<WorkspaceSession> {
  const result = await WorkspaceSession.open(new VaultRepository(vault, newId), { delayMs: 60_000 });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function idAt(session: WorkspaceSession, path: string): string {
  const id = Object.keys(session.getState().pages).find((candidate) => session.pathOf(candidate) === path);
  if (!id) throw new Error(`No page at ${path}`);
  return id;
}

function apiFor(session: WorkspaceSession): { api: DataApi; cleanup: () => void } {
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
  if (snapshot.status !== 'ready') throw new Error(`Expected ready snapshot, got ${snapshot.status}.`);
  return snapshot;
}

function patch(api: DataApi, databaseId: string, rowId: string, propertyId: string, value: number) {
  return api.patchCell({
    databaseId,
    rowId,
    propertyId,
    value,
    expectedRevision: ready(api.snapshot(databaseId)).revision,
  });
}

function history(api: DataApi, databaseId: string, direction: 'undo' | 'redo', expectedRevision?: string) {
  return api.history({
    databaseId,
    direction,
    expectedRevision: expectedRevision ?? ready(api.snapshot(databaseId)).revision,
  });
}

describe('Polaris Dados session history', () => {
  it('undoes and redoes absent, null, zero, and numeric cells without evaluating formulas', async () => {
    const vault = new MemoryVault(fixture());
    const session = await open(vault);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const widgetId = idAt(session, 'Inventory/Widget.md');
    const missingId = idAt(session, 'Inventory/Missing price.md');
    try {
      const initial = ready(api.snapshot(databaseId));
      expect(initial.rows.find((row) => row.id === widgetId)?.properties.price).toBeNull();
      expect(Object.hasOwn(initial.rows.find((row) => row.id === missingId)!.properties, 'price')).toBe(
        false,
      );
      expect(initial.rows.find((row) => row.id === widgetId)?.properties.quantity).toBe(2);
      expect(patch(api, databaseId, widgetId, 'quantity', 2).status).toBe('staged');
      expect(ready(api.snapshot(databaseId)).history).toEqual({ canUndo: false, canRedo: false });

      expect(patch(api, databaseId, widgetId, 'quantity', 3).status).toBe('staged');
      expect(history(api, databaseId, 'undo').status).toBe('staged');
      expect(
        ready(api.snapshot(databaseId)).rows.find((row) => row.id === widgetId)?.properties.quantity,
      ).toBe(2);
      expect(history(api, databaseId, 'redo').status).toBe('staged');
      expect(
        ready(api.snapshot(databaseId)).rows.find((row) => row.id === widgetId)?.properties.quantity,
      ).toBe(3);
      // The backend snapshot never calculates Total; it remains the formula engine's responsibility.
      expect(
        Object.hasOwn(
          ready(api.snapshot(databaseId)).rows.find((row) => row.id === widgetId)!.properties,
          'total',
        ),
      ).toBe(false);

      expect(patch(api, databaseId, widgetId, 'price', 9).status).toBe('staged');
      expect(history(api, databaseId, 'undo').status).toBe('staged');
      expect(
        ready(api.snapshot(databaseId)).rows.find((row) => row.id === widgetId)?.properties.price,
      ).toBeNull();
      expect(history(api, databaseId, 'redo').status).toBe('staged');
      expect(ready(api.snapshot(databaseId)).rows.find((row) => row.id === widgetId)?.properties.price).toBe(
        9,
      );

      expect(patch(api, databaseId, missingId, 'price', 5).status).toBe('staged');
      expect(history(api, databaseId, 'undo').status).toBe('staged');
      expect(
        Object.hasOwn(
          ready(api.snapshot(databaseId)).rows.find((row) => row.id === missingId)!.properties,
          'price',
        ),
      ).toBe(false);
      expect(history(api, databaseId, 'redo').status).toBe('staged');
      expect(ready(api.snapshot(databaseId)).rows.find((row) => row.id === missingId)?.properties.price).toBe(
        5,
      );

      expect(patch(api, databaseId, widgetId, 'quantity', 0).status).toBe('staged');
      expect(history(api, databaseId, 'undo').status).toBe('staged');
      expect(
        ready(api.snapshot(databaseId)).rows.find((row) => row.id === widgetId)?.properties.quantity,
      ).toBe(3);
      expect(history(api, databaseId, 'redo').status).toBe('staged');
      expect(
        ready(api.snapshot(databaseId)).rows.find((row) => row.id === widgetId)?.properties.quantity,
      ).toBe(0);
    } finally {
      cleanup();
      await session.close();
    }
  });

  it('keeps history across an external vendor metadata edit and invalidates it on cell changes', async () => {
    const vault = new MemoryVault(fixture());
    const session = await open(vault);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const widgetPath = 'Inventory/Widget.md';
    const widgetId = idAt(session, widgetPath);
    try {
      expect(patch(api, databaseId, widgetId, 'quantity', 3).status).toBe('staged');
      await api.flush(databaseId);
      const beforeMetadata = ready(api.snapshot(databaseId));
      const metadataOnly = vault.text(widgetPath)!.replace('opaque-widget-7f21', 'opaque-widget-external');
      vault.external({ [widgetPath]: metadataOnly });
      const afterMetadata = ready(api.snapshot(databaseId));
      expect(afterMetadata.history).toEqual({ canUndo: true, canRedo: false });
      expect(history(api, databaseId, 'undo').status).toBe('staged');
      expect(
        ready(api.snapshot(databaseId)).rows.find((row) => row.id === widgetId)?.properties.quantity,
      ).toBe(2);

      expect(patch(api, databaseId, widgetId, 'quantity', 4).status).toBe('staged');
      await api.flush(databaseId);
      const beforeExternalCell = ready(api.snapshot(databaseId));
      const externalCell = vault.text(widgetPath)!.replace('Quantity: 4', 'Quantity: 8');
      vault.external({ [widgetPath]: externalCell });
      const afterExternalCell = ready(api.snapshot(databaseId));
      expect(afterExternalCell.revision).not.toBe(beforeExternalCell.revision);
      expect(afterExternalCell.history).toEqual({ canUndo: false, canRedo: false });
      expect(history(api, databaseId, 'undo', beforeExternalCell.revision)).toMatchObject({
        status: 'error',
        code: 'stale-revision',
      });
      expect(
        ready(api.snapshot(databaseId)).rows.find((row) => row.id === widgetId)?.properties.quantity,
      ).toBe(8);
      expect(beforeMetadata.history).toEqual({ canUndo: true, canRedo: false });
    } finally {
      cleanup();
      await session.close();
    }
  });

  it('returns the revision for its own edit before reentrant subscribers can stage another edit', async () => {
    const session = await open(new MemoryVault(fixture()));
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const rowId = idAt(session, 'Inventory/Widget.md');
    let didReenter = false;
    let reentrantResult: ReturnType<DataApi['patchCell']> | undefined;
    let unsubscribe = () => {};
    try {
      unsubscribe = api.subscribe(databaseId, (snapshot) => {
        if (didReenter || snapshot.status !== 'ready') return;
        const quantity = snapshot.rows.find((row) => row.id === rowId)?.properties.quantity;
        if (quantity !== 3) return;
        didReenter = true;
        reentrantResult = api.patchCell({
          databaseId,
          rowId,
          propertyId: 'quantity',
          value: 4,
          expectedRevision: snapshot.revision,
        });
      });

      const outer = api.patchCell({
        databaseId,
        rowId,
        propertyId: 'quantity',
        value: 3,
        expectedRevision: ready(api.snapshot(databaseId)).revision,
      });
      expect(outer.status).toBe('staged');
      expect(reentrantResult?.status).toBe('staged');
      if (outer.status !== 'staged') throw new Error('Expected the outer patch to stage.');
      expect(outer.revision).not.toBe(ready(api.snapshot(databaseId)).revision);
      expect(api.history({ databaseId, direction: 'undo', expectedRevision: outer.revision })).toMatchObject({
        status: 'error',
        code: 'stale-revision',
      });
    } finally {
      unsubscribe();
      cleanup();
      await session.close();
    }
  });
});
