import { describe, expect, it } from 'vitest';
import { createDataApi } from '../app/plugins/dataApi';
import type { DataApi, DataApiSnapshot } from '../app/plugins/dataApi';
import { encryptPage, newPageKey } from '../core/crypto';
import type { PageId, WorkspaceState } from '../core/model';
import { MAX_PAGE_BYTES } from '../core/vault/load';
import type { VaultOp } from '../core/vault/plan';
import { computeRuntimeFormula } from '../../plugins/polaris-dados/src/engine/formula';
import { E003_POLARIS_DADOS_FIXTURE } from './fixtures/e003-polaris-dados';
import { MemoryVault } from './memoryVault';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';

const SOURCE_PATH = 'Inventory.md';
const ROW_PATH = 'Inventory/Widget.md';
const SOURCE_ID = 'independent-recovery-source';
const ROW_ID = 'independent-recovery-row';
const SOURCE_TEXT = E003_POLARIS_DADOS_FIXTURE[SOURCE_PATH]!;
const ROW_TEXT = E003_POLARIS_DADOS_FIXTURE[ROW_PATH]!;
const LEGACY_SOURCE_TEXT = SOURCE_TEXT.replace(
  'polarisDados:\n  version: 1\n  provider: polaris-dados\n',
  '',
);
const UNSUPPORTED_SOURCE_TEXT = SOURCE_TEXT.replace(
  'name: Quantity\n      type: number',
  'name: Quantity\n      type: future-v153',
);

let generatedId = 0;

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
    '.morrow/workspace.json': JSON.stringify({
      version: 1,
      pages: {
        [SOURCE_PATH]: { id: SOURCE_ID },
        [ROW_PATH]: { id: ROW_ID },
      },
    }),
  };
}

function fixtureWithoutProvider(): Record<string, string> {
  return { ...fixture(), [SOURCE_PATH]: LEGACY_SOURCE_TEXT };
}

async function open(vault: MemoryVault): Promise<WorkspaceSession> {
  const result = await WorkspaceSession.open(
    new VaultRepository(vault, () => `independent-recovery-${++generatedId}`),
    { delayMs: 60_000 },
  );
  if (!result.ok) throw new Error(result.error);
  return result.value;
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

type ReadySnapshot = Extract<DataApiSnapshot, { status: 'ready' }>;

function ready(snapshot: DataApiSnapshot): ReadySnapshot {
  if (snapshot.status !== 'ready') throw new Error(`Expected ready snapshot, got ${snapshot.status}.`);
  return snapshot;
}

function childrenSnapshot(
  vault: MemoryVault,
): Record<string, { text: string | undefined; mtime: number | undefined }> {
  return Object.fromEntries(
    vault
      .paths()
      .filter((path) => path.startsWith('Inventory/'))
      .map((path) => [path, { text: vault.text(path), mtime: vault.modifiedTime(path) }]),
  );
}

function checkFormula(state: WorkspaceState, expected: number): void {
  const source = state.pages[SOURCE_ID]!;
  const row = state.pages[ROW_ID]!;
  const definition = source.database!;
  const total = definition.properties.find((property) => property.id === 'total')!;
  expect(total.formula).toBe('Quantity * Price');
  const result = computeRuntimeFormula(total.formula ?? '', {
    resolveIdentifier(name) {
      const property = definition.properties.find((candidate) => candidate.name === name);
      const value = property ? row.properties[property.id] : null;
      if (typeof value !== 'number') throw new Error(`No numeric synthetic value exists for ${name}.`);
      return value;
    },
  });
  expect(result).toEqual({ value: expected, error: null });
}

describe('independent external parent-schema recovery', () => {
  it('re-reads clean rows when only their previously unsupported database schema is restored', async () => {
    const vault = new CountingMemoryVault(fixture());
    const session = await open(vault);
    const { api, cleanup } = apiFor(session);
    const childrenBefore = childrenSnapshot(vault);
    const originalRowDoc = session.getState().docs[ROW_ID];
    const applyCountBefore = vault.applyCount;

    try {
      const before = ready(api.snapshot(SOURCE_ID));
      const beforeRow = before.rows.find((row) => row.id === ROW_ID)!;
      expect(beforeRow.properties).toMatchObject({ quantity: 2, price: 10 });
      checkFormula(session.getState(), 20);

      vault.external({ [SOURCE_PATH]: UNSUPPORTED_SOURCE_TEXT });
      expect(session.unreadable.has(SOURCE_ID)).toBe(true);
      expect(session.unreadable.has(ROW_ID)).toBe(true);
      expect(api.snapshot(SOURCE_ID)).toMatchObject({
        status: 'unsupported',
        diagnostic: { code: 'database-unreadable' },
      });
      expect(session.getState().docs[ROW_ID]?.content?.[0]).toMatchObject({ type: 'rawBlock' });

      vault.external({ [SOURCE_PATH]: SOURCE_TEXT });

      expect(session.unreadable.has(SOURCE_ID)).toBe(false);
      expect(session.unreadable.has(ROW_ID)).toBe(false);
      expect(session.protectedReasons.has(SOURCE_ID)).toBe(false);
      expect(session.protectedReasons.has(ROW_ID)).toBe(false);
      expect(session.getState().docs[SOURCE_ID]?.content?.[0]?.type).not.toBe('rawBlock');
      expect(session.getState().docs[ROW_ID]).toEqual(originalRowDoc);
      expect(session.getState().pages[ROW_ID]!.extra.vendorRecord).toEqual({
        id: 'opaque-widget-7f21',
        audit: { source: 'synthetic', tags: ['retain', 'nested'] },
      });

      const recovered = ready(api.snapshot(SOURCE_ID));
      const recoveredRow = recovered.rows.find((row) => row.id === ROW_ID)!;
      expect(recoveredRow.properties).toMatchObject({ quantity: 2, price: 10 });
      expect(recovered.schema.properties.find((property) => property.id === 'total')?.formula).toBe(
        'Quantity * Price',
      );
      checkFormula(session.getState(), 20);
      expect(childrenSnapshot(vault)).toEqual(childrenBefore);
      expect(vault.applyCount).toBe(applyCountBefore);
      expect(vault.text(SOURCE_PATH)).toBe(SOURCE_TEXT);
    } finally {
      cleanup();
      await session.close();
    }
  });

  it.each(['own-marker', 'encrypted', 'oversized'] as const)(
    'keeps a row protected for its own %s cause after the parent schema is restored',
    async (cause) => {
      const vault = new CountingMemoryVault(fixture());
      const session = await open(vault);
      const { api, cleanup } = apiFor(session);
      let ownRowText: string;
      if (cause === 'own-marker') {
        ownRowText = `${ROW_TEXT}\n<!-- morrow:image align="right" width="35%" -->\n`;
      } else if (cause === 'encrypted') {
        ownRowText = await encryptPage(ROW_TEXT, await newPageKey('synthetic-independent-password'));
      } else {
        ownRowText = `${ROW_TEXT}\n${'x'.repeat(MAX_PAGE_BYTES + 1)}`;
      }
      const applyCountBefore = vault.applyCount;

      try {
        vault.external({ [ROW_PATH]: ownRowText });
        expect(session.unreadable.has(ROW_ID)).toBe(true);
        const rowMtime = vault.modifiedTime(ROW_PATH);

        vault.external({ [SOURCE_PATH]: UNSUPPORTED_SOURCE_TEXT });
        expect(session.unreadable.has(SOURCE_ID)).toBe(true);
        expect(session.unreadable.has(ROW_ID)).toBe(true);

        vault.external({ [SOURCE_PATH]: SOURCE_TEXT });

        expect(session.unreadable.has(SOURCE_ID)).toBe(false);
        expect(session.unreadable.has(ROW_ID)).toBe(true);
        expect(session.getState().pages[ROW_ID]!.encrypted).toBe(cause === 'encrypted');
        expect(vault.text(ROW_PATH)).toBe(ownRowText);
        expect(vault.modifiedTime(ROW_PATH)).toBe(rowMtime);
        expect(vault.applyCount).toBe(applyCountBefore);
        expect(api.snapshot(SOURCE_ID)).toMatchObject({
          status: 'unsupported',
          diagnostic: { code: 'row-unreadable' },
        });

        if (cause === 'own-marker') {
          expect(session.protectedReasons.get(ROW_ID)).toMatch(/Morrow block marker/i);
          expect(session.protectedReasons.get(ROW_ID)).not.toMatch(/parent database is protected/i);
          expect(session.getState().docs[ROW_ID]?.content?.[0]).toMatchObject({
            type: 'rawBlock',
            attrs: { text: ownRowText },
          });
        }
      } finally {
        cleanup();
        await session.close();
      }
    },
  );

  it('keeps a staged P1 cell draft when an external parent update conflicts with its source check', async () => {
    const vault = new CountingMemoryVault(fixture());
    const session = await open(vault);
    const { api, cleanup } = apiFor(session);
    const acceptedEvents: PageId[][] = [];
    const stopObserving = session.onExternal((_patch, accepted) => acceptedEvents.push([...accepted]));
    const originalRowText = vault.text(ROW_PATH);
    const originalRowMtime = vault.modifiedTime(ROW_PATH);
    const originalRowDoc = session.getState().docs[ROW_ID];
    const applyCountBefore = vault.applyCount;

    try {
      const before = ready(api.snapshot(SOURCE_ID));
      expect(
        api.patchCell({
          databaseId: SOURCE_ID,
          rowId: ROW_ID,
          propertyId: 'quantity',
          value: 7,
          expectedRevision: before.revision,
        }),
      ).toMatchObject({ status: 'staged' });
      expect(session.queue.isDirty(ROW_ID)).toBe(true);
      expect(session.queue.isDirty(SOURCE_ID)).toBe(true);

      vault.external({ [SOURCE_PATH]: UNSUPPORTED_SOURCE_TEXT });
      expect(acceptedEvents.at(-1)).not.toContain(SOURCE_ID);
      expect(acceptedEvents.at(-1)).not.toContain(ROW_ID);
      expect(session.unreadable.has(SOURCE_ID)).toBe(false);
      expect(session.unreadable.has(ROW_ID)).toBe(false);
      expect(session.getState().pages[ROW_ID]!.properties.quantity).toBe(7);
      expect(session.getState().docs[ROW_ID]).toEqual(originalRowDoc);
      expect(ready(api.snapshot(SOURCE_ID)).rows.find((row) => row.id === ROW_ID)?.properties.quantity).toBe(7);

      vault.external({ [SOURCE_PATH]: SOURCE_TEXT });

      expect(session.unreadable.has(SOURCE_ID)).toBe(false);
      expect(session.unreadable.has(ROW_ID)).toBe(false);
      expect(session.getState().pages[ROW_ID]!.properties.quantity).toBe(7);
      expect(session.getState().pages[ROW_ID]!.extra.vendorRecord).toEqual({
        id: 'opaque-widget-7f21',
        audit: { source: 'synthetic', tags: ['retain', 'nested'] },
      });
      expect(
        ready(api.snapshot(SOURCE_ID)).rows.find((row) => row.id === ROW_ID)?.properties.quantity,
      ).toBe(7);
      checkFormula(session.getState(), 70);
      expect(vault.text(ROW_PATH)).toBe(originalRowText);
      expect(vault.modifiedTime(ROW_PATH)).toBe(originalRowMtime);
      expect(vault.applyCount).toBe(applyCountBefore);
    } finally {
      stopObserving();
      cleanup();
      await session.close();
    }
  });

  it('keeps a dirty legacy row rejected when the parent becomes opted in and is restored', async () => {
    const vault = new CountingMemoryVault(fixtureWithoutProvider());
    const session = await open(vault);
    const { api, cleanup } = apiFor(session);
    const acceptedEvents: PageId[][] = [];
    const stopObserving = session.onExternal((_patch, accepted) => acceptedEvents.push([...accepted]));
    const originalRowText = vault.text(ROW_PATH);
    const originalRowMtime = vault.modifiedTime(ROW_PATH);
    const originalRowDoc = session.getState().docs[ROW_ID];
    const applyCountBefore = vault.applyCount;

    try {
      expect(
        session.execute({
          type: 'page.setProperties',
          id: ROW_ID,
          values: { quantity: 7 },
          now: 184,
        }).ok,
      ).toBe(true);
      expect(session.queue.isDirty(ROW_ID)).toBe(true);

      vault.external({ [SOURCE_PATH]: UNSUPPORTED_SOURCE_TEXT });
      expect(session.unreadable.has(SOURCE_ID)).toBe(true);
      expect(acceptedEvents.at(-1)).toContain(SOURCE_ID);
      expect(acceptedEvents.at(-1)).not.toContain(ROW_ID);
      expect(session.getState().pages[ROW_ID]!.properties.quantity).toBe(7);
      expect(session.getState().docs[ROW_ID]).toEqual(originalRowDoc);

      vault.external({ [SOURCE_PATH]: SOURCE_TEXT });

      expect(session.unreadable.has(SOURCE_ID)).toBe(false);
      expect(session.unreadable.has(ROW_ID)).toBe(false);
      expect(acceptedEvents.at(-1)).toContain(SOURCE_ID);
      expect(acceptedEvents.at(-1)).not.toContain(ROW_ID);
      expect(session.getState().pages[SOURCE_ID]!.extra.polarisDados).toEqual({
        version: 1,
        provider: 'polaris-dados',
      });
      expect(session.getState().pages[ROW_ID]!.properties.quantity).toBe(7);
      expect(session.getState().pages[ROW_ID]!.extra.vendorRecord).toEqual({
        id: 'opaque-widget-7f21',
        audit: { source: 'synthetic', tags: ['retain', 'nested'] },
      });
      expect(ready(api.snapshot(SOURCE_ID)).rows.find((row) => row.id === ROW_ID)?.properties.quantity).toBe(7);
      checkFormula(session.getState(), 70);
      expect(vault.text(ROW_PATH)).toBe(originalRowText);
      expect(vault.modifiedTime(ROW_PATH)).toBe(originalRowMtime);
      expect(vault.applyCount).toBe(applyCountBefore);
    } finally {
      stopObserving();
      cleanup();
      await session.close();
    }
  });

  it('does not propagate child protection from an unsupported parent rejected as dirty', async () => {
    const vault = new CountingMemoryVault(fixture());
    const session = await open(vault);
    const { api, cleanup } = apiFor(session);
    const acceptedEvents: PageId[][] = [];
    const stopObserving = session.onExternal((_patch, accepted) => acceptedEvents.push([...accepted]));
    const childrenBefore = childrenSnapshot(vault);
    const applyCountBefore = vault.applyCount;

    try {
      expect(
        session.execute({ type: 'page.setIcon', id: SOURCE_ID, icon: '📦', now: 183 }).ok,
      ).toBe(true);
      expect(session.queue.isDirty(SOURCE_ID)).toBe(true);

      vault.external({ [SOURCE_PATH]: UNSUPPORTED_SOURCE_TEXT });
      expect(acceptedEvents.at(-1)).not.toContain(SOURCE_ID);
      expect(acceptedEvents.at(-1)).not.toContain(ROW_ID);
      expect(session.getState().pages[SOURCE_ID]!.icon).toBe('📦');
      expect(session.unreadable.has(SOURCE_ID)).toBe(false);
      expect(session.unreadable.has(ROW_ID)).toBe(false);
      expect(
        ready(api.snapshot(SOURCE_ID)).rows.find((row) => row.id === ROW_ID)?.properties.quantity,
      ).toBe(2);

      vault.external({ [SOURCE_PATH]: SOURCE_TEXT });

      expect(session.getState().pages[SOURCE_ID]!.icon).toBe('📦');
      expect(session.unreadable.has(SOURCE_ID)).toBe(false);
      expect(session.unreadable.has(ROW_ID)).toBe(false);
      expect(
        ready(api.snapshot(SOURCE_ID)).rows.find((row) => row.id === ROW_ID)?.properties.quantity,
      ).toBe(2);
      expect(childrenSnapshot(vault)).toEqual(childrenBefore);
      expect(vault.applyCount).toBe(applyCountBefore);
    } finally {
      stopObserving();
      cleanup();
      await session.close();
    }
  });
});
