import { describe, expect, it, vi } from 'vitest';
import type { VaultOp } from '../core/vault/plan';
import { createDataApi } from '../app/plugins/dataApi';
import type { DataApi, DataApiSnapshot } from '../app/plugins/dataApi';
import { E003_POLARIS_DADOS_FIXTURE } from './fixtures/e003-polaris-dados';
import { MemoryVault } from './memoryVault';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';

let nextId = 0;
const newId = () => `pilot-${++nextId}`;

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
Missing price is different from an explicit null.
`,
  };
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

function apiFor(
  session: WorkspaceSession,
  options: {
    ownerIsActive?: () => boolean;
    isProviderActive?: () => boolean;
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

function ready(snapshot: DataApiSnapshot) {
  if (snapshot.status !== 'ready') throw new Error(`Expected ready snapshot, received ${snapshot.status}.`);
  return snapshot;
}

describe('Polaris Dados snapshot and cell API', () => {
  it('keeps snapshots immutable, distinguishes null from missing, and persists a staged 2-to-3 edit', async () => {
    const vault = new MemoryVault(fixture());
    const session = await open(vault);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const widgetId = idAt(session, 'Inventory/Widget.md');
    const missingPriceId = idAt(session, 'Inventory/Missing price.md');
    const first = ready(api.snapshot(databaseId));
    const widget = first.rows.find((row) => row.id === widgetId)!;
    const missingPrice = first.rows.find((row) => row.id === missingPriceId)!;

    expect(api.version).toBe(1);
    expect(first.readonly).toBe(false);
    expect(widget.properties.price).toBeNull();
    expect(Object.hasOwn(missingPrice.properties, 'price')).toBe(false);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.schema.properties)).toBe(true);
    expect(Object.isFrozen(first.schema.properties[0])).toBe(true);
    expect(Object.isFrozen(widget.properties)).toBe(true);

    const result = api.patchCell({
      databaseId,
      rowId: widgetId,
      propertyId: 'quantity',
      value: 3,
      expectedRevision: first.revision,
    });
    expect(result).toMatchObject({ status: 'staged', revision: expect.not.stringMatching(first.revision) });
    expect(session.queue.isDirty(databaseId)).toBe(true);
    expect(ready(api.snapshot(databaseId)).rows.find((row) => row.id === widgetId)?.properties.quantity).toBe(3);
    expect(await api.flush(databaseId)).toMatchObject({ status: 'persisted' });
    expect(vault.text('Inventory/Widget.md')).toContain('Quantity: 3');
    expect(vault.text('Inventory/Widget.md')).toContain('Price: null');
    expect(vault.text('Inventory/Widget.md')).toContain('vendorRecord:');

    cleanup();
    await session.close();
    const reopened = await open(vault);
    const reopenedApi = apiFor(reopened);
    const afterRestart = ready(reopenedApi.api.snapshot(idAt(reopened, 'Inventory.md')));
    const reopenedWidget = afterRestart.rows.find((row) => row.id === widgetId)!;
    const reopenedMissing = afterRestart.rows.find((row) => row.id === missingPriceId)!;
    expect(reopenedWidget.properties.quantity).toBe(3);
    expect(reopenedWidget.properties.price).toBeNull();
    expect(Object.hasOwn(reopenedMissing.properties, 'price')).toBe(false);
    expect(afterRestart.revision).not.toBe(first.revision);
    reopenedApi.cleanup();
    await reopened.close();
  });

  it('accepts zero but rejects stale, wrong-row, non-number, formula, and non-finite patches', async () => {
    const vault = new MemoryVault(fixture());
    const session = await open(vault);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const widgetId = idAt(session, 'Inventory/Widget.md');
    const initial = ready(api.snapshot(databaseId));
    let currentRevision = initial.revision;
    const patch = (input: Partial<Parameters<DataApi['patchCell']>[0]>) =>
      api.patchCell({
        databaseId,
        rowId: widgetId,
        propertyId: 'quantity',
        value: 0,
        expectedRevision: currentRevision,
        ...input,
      });

    expect(patch({}).status).toBe('staged');
    const afterZero = ready(api.snapshot(databaseId));
    currentRevision = afterZero.revision;
    expect(afterZero.rows.find((row) => row.id === widgetId)?.properties.quantity).toBe(0);
    expect(patch({ value: 4, expectedRevision: initial.revision })).toMatchObject({
      status: 'error',
      code: 'stale-revision',
    });
    expect(patch({ rowId: 'not-a-row' })).toMatchObject({ status: 'error', code: 'row-not-found' });
    expect(patch({ propertyId: 'name' })).toMatchObject({ status: 'error', code: 'read-only' });
    expect(patch({ propertyId: 'total' })).toMatchObject({ status: 'error', code: 'read-only' });
    expect(patch({ value: Number.NaN })).toMatchObject({ status: 'error', code: 'invalid-value' });
    expect(patch({ value: Number.POSITIVE_INFINITY })).toMatchObject({ status: 'error', code: 'invalid-value' });
    expect(patch({ value: null as unknown as number })).toMatchObject({ status: 'error', code: 'invalid-value' });

    cleanup();
    await session.close();
  });

  it('marks missing, malformed, ambiguous, trashed, and unreadable databases without exposing normalized payloads', async () => {
    const malformed = {
      ...fixture(),
      'Inventory/Widget.md': E003_POLARIS_DADOS_FIXTURE['Inventory/Widget.md']!.replace(
        'Quantity: 2',
        'Quantity: many',
      ),
    };
    const vault = new MemoryVault(malformed);
    const session = await open(vault);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const unsupported = api.snapshot(databaseId);
    expect(unsupported.status).toBe('unsupported');
    expect(unsupported).toHaveProperty('diagnostic.code', 'unrepresentable-cell');
    expect(Object.keys(unsupported).sort()).toEqual(['databaseId', 'diagnostic', 'revision', 'status', 'version']);
    expect(api.snapshot('not-opted-in').status).toBe('missing');
    expect(api.patchCell({
      databaseId,
      rowId: idAt(session, 'Inventory/Widget.md'),
      propertyId: 'quantity',
      value: 3,
      expectedRevision: unsupported.revision,
    })).toMatchObject({ status: 'error', code: 'unsupported' });
    expect(await api.flush(databaseId)).toMatchObject({ status: 'error', code: 'unsupported' });
    expect(vault.text('Inventory/Widget.md')).toBe(malformed['Inventory/Widget.md']);
    cleanup();
    await session.close();

    const unreadableFixture = fixture();
    unreadableFixture['Inventory/Widget.md'] += '<span data-morrow-control="opaque-control">Unsupported row.</span>\n';
    const unreadableVault = new MemoryVault(unreadableFixture);
    const unreadableSession = await open(unreadableVault);
    const unreadableApi = apiFor(unreadableSession);
    const unreadableSnapshot = unreadableApi.api.snapshot(idAt(unreadableSession, 'Inventory.md'));
    expect(unreadableSnapshot.status).toBe('unsupported');
    expect(unreadableSnapshot).toHaveProperty('diagnostic.code', 'row-unreadable');
    expect(Object.keys(unreadableSnapshot).sort()).toEqual([
      'databaseId',
      'diagnostic',
      'revision',
      'status',
      'version',
    ]);
    unreadableApi.cleanup();
    await unreadableSession.close();

    const allFiles = fixture();
    const trashedFiles: Record<string, string> = {};
    for (const [path, text] of Object.entries(allFiles)) {
      if (path === 'Inventory.md') trashedFiles['.trash/Inventory.md'] = text;
      else if (path.startsWith('Inventory/')) trashedFiles[`.trash/${path}`] = text;
    }
    const trashedVault = new MemoryVault(trashedFiles);
    const trashedSession = await open(trashedVault);
    const trashedApi = apiFor(trashedSession);
    const trashedSnapshot = trashedApi.api.snapshot(idAt(trashedSession, '.trash/Inventory.md'));
    expect(trashedSnapshot.status).toBe('unsupported');
    expect(trashedSnapshot).toHaveProperty('diagnostic.code', 'database-trashed');
    trashedApi.cleanup();
    await trashedSession.close();

    const ambiguous = fixture();
    ambiguous['Inventory.md'] = ambiguous['Inventory.md']!.replace(
      '    - id: price\n      name: Price',
      '    - id: quantity\n      name: Price',
    );
    const ambiguousVault = new MemoryVault(ambiguous);
    const ambiguousSession = await open(ambiguousVault);
    const ambiguousApi = apiFor(ambiguousSession);
    const ambiguousSnapshot = ambiguousApi.api.snapshot(idAt(ambiguousSession, 'Inventory.md'));
    expect(ambiguousSnapshot.status).toBe('unsupported');
    expect(ambiguousSnapshot).toHaveProperty('diagnostic.code', 'ambiguous-schema');
    ambiguousApi.cleanup();
    await ambiguousSession.close();
  });

  it('rejects generic commands that change opted-in data/schema/identity while allowing navigation metadata', async () => {
    const vault = new MemoryVault(fixture());
    const session = await open(vault);
    const databaseId = idAt(session, 'Inventory.md');
    const widgetId = idAt(session, 'Inventory/Widget.md');
    const { api, cleanup } = apiFor(session);
    const database = session.getState().pages[databaseId]!.database!;
    const originalQuantity = session.getState().pages[widgetId]!.properties.quantity;
    const revisionBeforeNavigation = ready(api.snapshot(databaseId)).revision;

    expect(
      session.execute({ type: 'page.setProperties', id: widgetId, values: { quantity: 9 }, now: 5 }).ok,
    ).toBe(false);
    expect(session.execute({ type: 'page.rename', id: widgetId, title: 'Renamed', now: 5 }).ok).toBe(false);
    expect(session.execute({ type: 'page.move', id: widgetId, parentId: null }).ok).toBe(false);
    expect(
      session.execute({
        type: 'database.set',
        id: databaseId,
        database: { ...database, properties: database.properties.slice(1) },
        now: 5,
      }).ok,
    ).toBe(false);
    const ordinaryId = idAt(session, 'Archive.md');
    const all = session.executeAll([
      { type: 'page.setFavorite', id: ordinaryId, favorite: true },
      { type: 'page.setProperties', id: widgetId, values: { quantity: 9 }, now: 6 },
    ]);
    expect(all.ok).toBe(false);
    expect(session.getState().pages[ordinaryId]!.favorite).toBe(false);
    expect(session.getState().pages[widgetId]!.properties.quantity).toBe(originalQuantity);

    expect(session.execute({ type: 'page.markOpened', id: databaseId, now: 123 }).ok).toBe(true);
    expect(ready(api.snapshot(databaseId)).revision).toBe(revisionBeforeNavigation);
    await session.flush();
    cleanup();
    await session.close();
  });

  it('revisions follow external row changes and subscriber cleanup survives owner reload', async () => {
    const vault = new MemoryVault(fixture());
    const session = await open(vault);
    const databaseId = idAt(session, 'Inventory.md');
    const rowId = idAt(session, 'Inventory/Widget.md');
    let generation = 1;
    const oldHandle = apiFor(session, {
      ownerIsActive: () => generation === 1,
    });
    const oldEvents: DataApiSnapshot[] = [];
    oldHandle.api.subscribe(databaseId, (snapshot) => oldEvents.push(snapshot));
    expect(oldEvents).toHaveLength(1);
    const oldRevision = ready(oldEvents[0]!).revision;

    vault.external({
      'Inventory/Widget.md': E003_POLARIS_DADOS_FIXTURE['Inventory/Widget.md']!.replace('Quantity: 2', 'Quantity: 4'),
    });
    expect(oldEvents).toHaveLength(2);
    expect(ready(oldEvents[1]!).revision).not.toBe(oldRevision);
    expect(ready(oldEvents[1]!).rows.find((row) => row.id === rowId)?.properties.quantity).toBe(4);

    generation = 2;
    oldHandle.cleanup();
    expect(oldHandle.api.patchCell({
      databaseId,
      rowId,
      propertyId: 'quantity',
      value: 5,
      expectedRevision: oldRevision,
    })).toMatchObject({ status: 'error', code: 'owner-inactive' });
    expect(() => oldHandle.api.snapshot(databaseId)).toThrow(/no longer active/i);

    const newHandle = apiFor(session, { ownerIsActive: () => generation === 2 });
    expect(newHandle.api.snapshot(databaseId).status).toBe('ready');
    const countBefore = oldEvents.length;
    vault.external({
      'Inventory/Widget.md': E003_POLARIS_DADOS_FIXTURE['Inventory/Widget.md']!.replace('Quantity: 2', 'Quantity: 6'),
    });
    expect(oldEvents).toHaveLength(countBefore);
    expect(ready(newHandle.api.snapshot(databaseId)).rows.find((row) => row.id === rowId)?.properties.quantity).toBe(6);

    newHandle.cleanup();
    await session.close();
  });

  it('rechecks provider and host read-only state for every cell patch', async () => {
    const vault = new MemoryVault(fixture());
    const session = await open(vault);
    const databaseId = idAt(session, 'Inventory.md');
    const rowId = idAt(session, 'Inventory/Widget.md');
    let providerActive = false;
    let hostReadonly = false;
    const { api, cleanup } = apiFor(session, {
      isProviderActive: () => providerActive,
      isHostReadonly: () => hostReadonly,
    });
    const snapshot = ready(api.snapshot(databaseId));
    expect(snapshot).toMatchObject({ readonly: true, diagnostic: { code: 'provider-inactive' } });
    const patch = {
      databaseId,
      rowId,
      propertyId: 'quantity',
      value: 3,
      expectedRevision: snapshot.revision,
    };
    expect(api.patchCell(patch)).toMatchObject({ status: 'error', code: 'provider-inactive' });
    providerActive = true;
    hostReadonly = true;
    expect(api.snapshot(databaseId)).toMatchObject({ readonly: true, diagnostic: { code: 'host-readonly' } });
    expect(api.patchCell(patch)).toMatchObject({ status: 'error', code: 'host-readonly' });
    hostReadonly = false;
    expect(api.patchCell(patch)).toMatchObject({ status: 'staged' });
    cleanup();
    await session.close();
  });

  it('removes both subscription listeners when the initial callback unloads the owner', async () => {
    const session = await open(new MemoryVault(fixture()));
    const databaseId = idAt(session, 'Inventory.md');
    const { api, cleanup } = apiFor(session);
    const ordinaryId = idAt(session, 'Archive.md');
    let notifications = 0;

    api.subscribe(databaseId, () => {
      notifications += 1;
      cleanup();
    });
    expect(notifications).toBe(1);

    expect(session.execute({ type: 'page.setIcon', id: ordinaryId, icon: '📌', now: 99 }).ok).toBe(true);
    await session.flush();
    expect(notifications).toBe(1);
    await session.close();
  });
});

describe('Polaris Dados source and row conflicts', () => {
  it.each([
    {
      change: 'property removal',
      mutate: (schema: string) =>
        schema.replace('    - id: quantity\n      name: Quantity\n      type: number\n', ''),
      diagnostic: 'unrepresentable-cell',
    },
    {
      change: 'property type change',
      mutate: (schema: string) =>
        schema.replace(
          '    - id: quantity\n      name: Quantity\n      type: number\n',
          '    - id: quantity\n      name: Quantity\n      type: text\n',
        ),
      diagnostic: 'unrepresentable-cell',
    },
    {
      change: 'reserved property name',
      mutate: (schema: string) => schema.replace('name: Quantity', 'name: TITLE'),
      diagnostic: 'ambiguous-schema',
    },
  ])('refuses to write rows after external $change would lose or reinterpret a cell', async ({ mutate, diagnostic }) => {
    const vault = new CountingMemoryVault(fixture());
    const session = await open(vault, 60_000);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const rowId = idAt(session, 'Inventory/Widget.md');
    const originalRow = vault.text('Inventory/Widget.md');
    const externalSchema = mutate(E003_POLARIS_DADOS_FIXTURE['Inventory.md']!);
    vault.external({ 'Inventory.md': externalSchema });

    const snapshot = api.snapshot(databaseId);
    expect(snapshot).toMatchObject({ status: 'unsupported', diagnostic: { code: diagnostic } });
    expect('rows' in snapshot).toBe(false);
    expect(api.patchCell({
      databaseId,
      rowId,
      propertyId: 'price',
      value: 33,
      expectedRevision: snapshot.revision,
    })).toMatchObject({ status: 'error', code: 'unsupported' });
    expect(session.queue.isDirty(rowId)).toBe(false);
    expect(vault.text('Inventory.md')).toBe(externalSchema);
    expect(vault.text('Inventory/Widget.md')).toBe(originalRow);
    expect(vault.applyCount).toBe(0);

    cleanup();
    await session.close();
  });

  it('marks a database read only on save conflict and emits queue changes until a flush succeeds', async () => {
    const vault = new CountingMemoryVault(fixture());
    const session = await open(vault, 60_000);
    vi.useFakeTimers();
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const rowId = idAt(session, 'Inventory/Widget.md');
    const originalRow = vault.text('Inventory/Widget.md');
    const events: DataApiSnapshot[] = [];
    const unsubscribe = api.subscribe(databaseId, (snapshot) => events.push(snapshot));
    const initial = ready(api.snapshot(databaseId));
    const patch = api.patchCell({
      databaseId,
      rowId,
      propertyId: 'quantity',
      value: 3,
      expectedRevision: initial.revision,
    });
    expect(patch.status).toBe('staged');

    const externalRow = originalRow!.replace('Quantity: 2', 'Quantity: 4');
    vault.external({ 'Inventory/Widget.md': externalRow });
    expect(await api.flush(databaseId)).toMatchObject({ status: 'error', code: 'save-conflict' });
    expect(ready(api.snapshot(databaseId))).toMatchObject({
      readonly: true,
      diagnostic: { code: 'save-conflict' },
    });
    expect(events.filter((snapshot) => snapshot.status === 'ready' && snapshot.readonly)).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ readonly: true, diagnostic: { code: 'save-conflict' } });
    expect(api.patchCell({
      databaseId,
      rowId,
      propertyId: 'quantity',
      value: 4,
      expectedRevision: ready(api.snapshot(databaseId)).revision,
    })).toMatchObject({ status: 'error', code: 'save-conflict' });

    vault.external({ 'Inventory/Widget.md': originalRow! });
    expect(await api.flush(databaseId)).toMatchObject({ status: 'persisted' });
    expect(ready(api.snapshot(databaseId))).toMatchObject({ readonly: false, diagnostic: null });
    expect(events.filter((snapshot) => snapshot.status === 'ready' && snapshot.readonly)).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ readonly: false, diagnostic: null });
    expect(vault.text('Inventory/Widget.md')).toContain('Quantity: 3');

    unsubscribe();
    cleanup();
    await session.close();
    vi.useRealTimers();
  });

  it('keeps the row draft and external schema bytes when its opted-in source schema changes', async () => {
    const vault = new CountingMemoryVault(fixture());
    const session = await open(vault, 60_000);
    vi.useFakeTimers();
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const rowId = idAt(session, 'Inventory/Widget.md');
    const initial = ready(api.snapshot(databaseId));
    const result = api.patchCell({
      databaseId,
      rowId,
      propertyId: 'quantity',
      value: 3,
      expectedRevision: initial.revision,
    });
    expect(result.status).toBe('staged');
    const rowText = vault.text('Inventory/Widget.md');
    const rowMtime = vault.modifiedTime('Inventory/Widget.md');
    const externalSchema = E003_POLARIS_DADOS_FIXTURE['Inventory.md']!.replace(
      '    - id: quantity\n      name: Quantity\n      type: number\n',
      '',
    );
    vault.external({ 'Inventory.md': externalSchema });

    const flush = await api.flush(databaseId);
    expect(flush).toMatchObject({ status: 'error', code: 'save-conflict' });
    expect(vault.text('Inventory.md')).toBe(externalSchema);
    expect(vault.text('Inventory/Widget.md')).toBe(rowText);
    expect(vault.modifiedTime('Inventory/Widget.md')).toBe(rowMtime);
    expect(session.getState().pages[rowId]!.properties.quantity).toBe(3);
    expect(session.saveStatus.errorCode).toBe('save-conflict');
    const appliesAfterConflict = vault.applyCount;
    expect(api.patchCell({
      databaseId,
      rowId,
      propertyId: 'quantity',
      value: 4,
      expectedRevision: ready(api.snapshot(databaseId)).revision,
    })).toMatchObject({ status: 'error', code: 'save-conflict' });
    const ordinaryId = idAt(session, 'Archive.md');
    expect(session.execute({ type: 'page.setIcon', id: ordinaryId, icon: '📌', now: 99 }).ok).toBe(true);
    expect(session.queue.isDirty(ordinaryId)).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(vault.applyCount).toBe(appliesAfterConflict);

    cleanup();
    await session.close();
    vi.useRealTimers();
  });

  it('refuses to write a staged row after its opted-in database file is deleted', async () => {
    const vault = new CountingMemoryVault(fixture());
    const session = await open(vault, 60_000);
    vi.useFakeTimers();
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const rowId = idAt(session, 'Inventory/Widget.md');
    const initial = ready(api.snapshot(databaseId));
    api.patchCell({
      databaseId,
      rowId,
      propertyId: 'quantity',
      value: 3,
      expectedRevision: initial.revision,
    });
    const rowText = vault.text('Inventory/Widget.md');
    const rowMtime = vault.modifiedTime('Inventory/Widget.md');
    vault.external({ 'Inventory.md': null });

    expect(await api.flush(databaseId)).toMatchObject({ status: 'error', code: 'save-conflict' });
    expect(vault.text('Inventory.md')).toBeUndefined();
    expect(vault.text('Inventory/Widget.md')).toBe(rowText);
    expect(vault.modifiedTime('Inventory/Widget.md')).toBe(rowMtime);
    expect(session.getState().pages[rowId]!.properties.quantity).toBe(3);
    cleanup();
    await session.close();
    vi.useRealTimers();
  });

  it('preserves an external row version and stops automatic retry after a row-file conflict', async () => {
    const vault = new CountingMemoryVault(fixture());
    const session = await open(vault, 60_000);
    vi.useFakeTimers();
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const rowId = idAt(session, 'Inventory/Widget.md');
    const initial = ready(api.snapshot(databaseId));
    api.patchCell({
      databaseId,
      rowId,
      propertyId: 'quantity',
      value: 3,
      expectedRevision: initial.revision,
    });
    const externalRow = E003_POLARIS_DADOS_FIXTURE['Inventory/Widget.md']!.replace('Quantity: 2', 'Quantity: 4');
    vault.external({ 'Inventory/Widget.md': externalRow });

    expect(await api.flush(databaseId)).toMatchObject({ status: 'error', code: 'save-conflict' });
    expect(vault.text('Inventory/Widget.md')).toBe(externalRow);
    expect(session.getState().pages[rowId]!.properties.quantity).toBe(3);
    expect(session.saveStatus.errorCode).toBe('save-conflict');
    const appliesAfterConflict = vault.applyCount;
    expect(api.patchCell({
      databaseId,
      rowId,
      propertyId: 'quantity',
      value: 4,
      expectedRevision: ready(api.snapshot(databaseId)).revision,
    })).toMatchObject({ status: 'error', code: 'save-conflict' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(vault.applyCount).toBe(appliesAfterConflict);

    cleanup();
    await session.close();
    vi.useRealTimers();
  });
});

describe('Polaris Dados canvas row boundary', () => {
  it('rejects canvas rows before exposing payload or staging edits and preserves the canvas file', async () => {
    const canvasText = JSON.stringify({ nodes: [], edges: [] });
    const vault = new CountingMemoryVault({
      ...fixture(),
      'Inventory/Board.canvas': canvasText,
    });
    const session = await open(vault, 60_000);
    const databaseId = idAt(session, 'Inventory.md');
    const canvasId = idAt(session, 'Inventory/Board.canvas');
    const canvasMtime = vault.modifiedTime('Inventory/Board.canvas');
    const writesBefore = vault.applyCount;
    const { api, cleanup } = apiFor(session);

    expect(session.getState().pages[canvasId]?.kind).toBe('canvas');
    expect(session.getState().pages[canvasId]?.parentId).toBe(databaseId);

    const snapshot = api.snapshot(databaseId);
    expect(snapshot).toMatchObject({ status: 'unsupported', diagnostic: { code: 'unrepresentable-cell' } });
    expect('schema' in snapshot).toBe(false);
    expect('rows' in snapshot).toBe(false);
    expect('history' in snapshot).toBe(false);
    expect(api.patchCell({
      databaseId,
      rowId: canvasId,
      propertyId: 'quantity',
      value: 3,
      expectedRevision: snapshot.revision,
    })).toMatchObject({ status: 'error', code: 'unsupported' });
    expect(session.patchPilotDataCell({
      databaseId,
      rowId: canvasId,
      propertyId: 'quantity',
      value: 3,
      expectedRevision: snapshot.revision,
    })).toMatchObject({ ok: false, code: 'unsupported' });
    expect(session.pilotDataHistoryChange({
      databaseId,
      direction: 'undo',
      expectedRevision: snapshot.revision,
    })).toMatchObject({ ok: false, code: 'unsupported' });
    expect(session.queue.hasPending()).toBe(false);
    expect(session.queue.isDirty(databaseId)).toBe(false);
    expect(session.queue.isDirty(canvasId)).toBe(false);
    expect(await api.flush(databaseId)).toMatchObject({ status: 'error', code: 'unsupported' });
    expect(vault.text('Inventory/Board.canvas')).toBe(canvasText);
    expect(vault.modifiedTime('Inventory/Board.canvas')).toBe(canvasMtime);
    expect(vault.applyCount).toBe(writesBefore);

    cleanup();
    await session.close();
    const reopened = await open(vault, 60_000);
    const reopenedApi = apiFor(reopened);
    expect(reopenedApi.api.snapshot(idAt(reopened, 'Inventory.md'))).toMatchObject({
      status: 'unsupported',
      diagnostic: { code: 'unrepresentable-cell' },
    });
    expect(vault.text('Inventory/Board.canvas')).toBe(canvasText);
    expect(vault.modifiedTime('Inventory/Board.canvas')).toBe(canvasMtime);
    expect(vault.applyCount).toBe(writesBefore);
    reopenedApi.cleanup();
    await reopened.close();
  });
});
