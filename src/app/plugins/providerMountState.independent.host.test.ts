// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageId, PageMeta } from '../../core/model';
import { DatabaseView } from '../components/database/DatabaseView';
import { getPreferences, setPreferences } from '../platform/preferences';
import { E003_POLARIS_DADOS_FIXTURE } from '../../storage/fixtures/e003-polaris-dados';
import { MemoryVault } from '../../storage/memoryVault';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';
import { setSession } from '../workspace';
import { createDataApi } from './dataApi';
import type { DataApi } from './dataApi';
import type { DatabaseProviderContext } from './providerApi';
import { getDatabaseProvider, registerDatabaseProvider } from './providerRegistry';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const PROVIDER_ID = 'polaris-dados';
const OWNER_A = 'independent-source-owner';
const OWNER_B = 'independent-replacement-owner';
const SOURCE_ID = 'independent-inventory' as PageId;
const SOURCE_ROW_ID = 'independent-widget' as PageId;
const OTHER_SOURCE_ID = 'independent-other-inventory' as PageId;
const OTHER_ROW_ID = 'independent-other-widget' as PageId;

type MountObserver = (context: DatabaseProviderContext) => void | (() => void);

interface TestFixture {
  readonly session: WorkspaceSession;
  readonly vault: MemoryVault;
  readonly source: PageMeta;
  readonly otherSource: PageMeta;
}

interface ProviderOwner {
  readonly data: DataApi;
  unregister(): void;
}

interface RootHarness {
  readonly container: HTMLDivElement;
  readonly render: (page: PageMeta) => void;
  unmount(): Promise<void>;
}

function makeWorkspaceFiles(): Record<string, string> {
  const inventory = E003_POLARIS_DADOS_FIXTURE['Inventory.md'];
  const widget = E003_POLARIS_DADOS_FIXTURE['Inventory/Widget.md'];
  if (!inventory || !widget) throw new Error('The synthetic inventory fixture is incomplete.');
  return {
    'Inventory.md': inventory,
    'Inventory/Widget.md': widget,
    'OtherInventory.md': inventory.replace('# Inventory', '# Other inventory'),
    'OtherInventory/Widget.md': widget.replace('Name: Widget', 'Name: Other widget'),
    '.morrow/workspace.json': JSON.stringify({
      version: 1,
      pages: {
        'Inventory.md': { id: SOURCE_ID, created: 1, order: 0 },
        'Inventory/Widget.md': { id: SOURCE_ROW_ID, created: 2, order: 0 },
        'OtherInventory.md': { id: OTHER_SOURCE_ID, created: 3, order: 1 },
        'OtherInventory/Widget.md': { id: OTHER_ROW_ID, created: 4, order: 0 },
      },
    }),
    '.morrow/recent.json': JSON.stringify({ version: 1, opened: {}, activity: {} }),
  };
}

async function openFixture(): Promise<TestFixture> {
  const vault = new MemoryVault(makeWorkspaceFiles());
  const opened = await WorkspaceSession.open(new VaultRepository(vault, () => 'unexpected-generated-page'));
  if (!opened.ok) throw new Error(opened.error);
  const session = opened.value;
  const source = session.getState().pages[SOURCE_ID];
  const otherSource = session.getState().pages[OTHER_SOURCE_ID];
  if (!source || !otherSource) throw new Error('The two opted-in Source pages did not load.');
  setSession(session);
  return { session, vault, source, otherSource };
}

function registerTestProvider(
  fixture: TestFixture,
  owner: string,
  mounted: DatabaseProviderContext[],
  observeMount?: MountObserver,
): ProviderOwner {
  let ownerActive = true;
  let disposed = false;
  const apiCleanups = new Set<() => void>();
  const data: DataApi = createDataApi({
    session: fixture.session,
    ownerIsActive: () => ownerActive,
    isProviderActive: () => getDatabaseProvider(PROVIDER_ID)?.data === data,
    isHostReadonly: () => getPreferences().readingMode,
    registerCleanup: (cleanup) => apiCleanups.add(cleanup),
  });
  const unregisterRegistration = registerDatabaseProvider(owner, () => ownerActive, data, {
    id: PROVIDER_ID,
    apiVersion: 1,
    mount(context) {
      mounted.push(context);
      return observeMount?.(context);
    },
  });
  let removeCloseListener = () => {};
  const unregister = () => {
    if (disposed) return;
    disposed = true;
    ownerActive = false;
    removeCloseListener();
    unregisterRegistration();
    for (const cleanup of [...apiCleanups]) cleanup();
    apiCleanups.clear();
  };
  removeCloseListener = fixture.session.onClose(unregister);
  return { data, unregister };
}

function mountSourceRoot(): RootHarness {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let ended = false;
  return {
    container,
    render(page) {
      root.render(createElement(DatabaseView, { page, editable: true }));
    },
    async unmount() {
      if (ended) return;
      await act(async () => root.unmount());
      container.remove();
      ended = true;
    },
  };
}

function activeMount(
  mounted: readonly DatabaseProviderContext[],
  root: RootHarness,
): DatabaseProviderContext {
  const matches = mounted.filter(
    (context) => root.container.contains(context.element) && !context.signal.aborted,
  );
  if (matches.length !== 1)
    throw new Error(
      `Expected one current mount in a Source root, received ${matches.length}; mount calls=${mounted.length}; html=${root.container.innerHTML}`,
    );
  return matches[0]!;
}

function transient(context: DatabaseProviderContext) {
  if (!context.transientState)
    throw new Error('The real Source mount omitted its transient-state capability.');
  return context.transientState;
}

function nonPreferenceStorageSnapshot(): Array<[string, string]> {
  return Array.from({ length: localStorage.length }, (_, index) => {
    const key = localStorage.key(index)!;
    return [key, localStorage.getItem(key)!] as [string, string];
  })
    .filter(([key]) => key !== 'morrow.preferences')
    .sort(([left], [right]) => left.localeCompare(right));
}

function currentSnapshot(context: DatabaseProviderContext) {
  const snapshot = context.data.snapshot(context.databaseId);
  if (snapshot.status !== 'ready') throw new Error('The real Source API did not return a ready database.');
  return snapshot;
}

function mutation(context: DatabaseProviderContext, value: string) {
  const snapshot = currentSnapshot(context);
  const row = snapshot.rows.find((candidate) => candidate.id === SOURCE_ROW_ID);
  if (!row) throw new Error('The real Source API did not return the synthetic row.');
  return context.data.patchTextCell?.({
    databaseId: context.databaseId,
    rowId: row.id,
    propertyId: 'name',
    value,
    expectedRevision: snapshot.revision,
  });
}

async function runAct(callback: () => void | Promise<void>): Promise<void> {
  await act(async () => callback());
}

afterEach(() => document.body.replaceChildren());

describe('independent provider transient Source lifecycle', () => {
  it('isolates two same-ID roots through preferences and owner reload while real data guards remain active', async () => {
    const fixture = await openFixture();
    const previousPreferences = getPreferences();
    const unrelatedStorage = nonPreferenceStorageSnapshot();
    const initialFiles = new Map(fixture.vault.files);
    const vaultApply = vi.spyOn(fixture.vault, 'apply');
    const mounted: DatabaseProviderContext[] = [];
    const rootA = mountSourceRoot();
    const rootB = mountSourceRoot();
    const owners: ProviderOwner[] = [];
    try {
      await runAct(() => setPreferences({ locale: 'pt', readingMode: false }));
      owners.push(registerTestProvider(fixture, OWNER_A, mounted));
      await runAct(() => {
        rootA.render(fixture.source);
        rootB.render(fixture.source);
      });

      const firstA = activeMount(mounted, rootA);
      const firstB = activeMount(mounted, rootB);
      expect(firstA.databaseId).toBe(firstB.databaseId);
      expect(transient(firstA).write('root A draft')).toBe(true);
      expect(transient(firstB).write('root B draft')).toBe(true);
      expect(transient(firstA).read()).toBe('root A draft');
      expect(transient(firstB).read()).toBe('root B draft');

      await runAct(() => setPreferences({ locale: 'es' }));
      const spanishA = activeMount(mounted, rootA);
      const spanishB = activeMount(mounted, rootB);
      expect(spanishA.locale).toBe('es');
      expect(spanishB.locale).toBe('es');
      expect(firstA.signal.aborted).toBe(true);
      expect(firstB.signal.aborted).toBe(true);
      expect(transient(firstA).read()).toBeUndefined();
      expect(transient(firstA).write('stale locale write')).toBe(false);
      expect(() => firstA.data.snapshot(firstA.databaseId)).toThrow(/no longer active/i);
      expect(transient(spanishA).read()).toBe('root A draft');
      expect(transient(spanishB).read()).toBe('root B draft');

      await runAct(() => setPreferences({ readingMode: true }));
      const readonlyA = activeMount(mounted, rootA);
      const readonlyB = activeMount(mounted, rootB);
      expect(readonlyA.editable).toBe(false);
      expect(spanishA.signal.aborted).toBe(true);
      expect(spanishB.signal.aborted).toBe(true);
      expect(transient(readonlyA).read()).toBe('root A draft');
      expect(transient(readonlyA).write('readonly draft A')).toBe(true);
      expect(transient(readonlyB).write('readonly draft B')).toBe(true);
      const readonlySnapshot = currentSnapshot(readonlyA);
      const readonlyRow = readonlySnapshot.rows.find((candidate) => candidate.id === SOURCE_ROW_ID)!;
      expect(
        readonlyA.data.patchCell({
          databaseId: readonlyA.databaseId,
          rowId: readonlyRow.id,
          propertyId: 'quantity',
          value: 99,
          expectedRevision: readonlySnapshot.revision,
        }),
      ).toMatchObject({ status: 'error', code: 'host-readonly' });

      await runAct(() => setPreferences({ readingMode: false }));
      const editableA = activeMount(mounted, rootA);
      const editableB = activeMount(mounted, rootB);
      expect(transient(editableA).read()).toBe('readonly draft A');
      expect(transient(editableB).read()).toBe('readonly draft B');
      const releaseFence = fixture.session.beginMutationFence();
      try {
        expect(mutation(editableA, 'blocked during fence')).toMatchObject({ status: 'error' });
        expect(transient(editableA).write('draft A through fence')).toBe(true);
        expect(transient(editableA).read()).toBe('draft A through fence');
      } finally {
        releaseFence();
      }

      const oldContexts = [firstA, firstB, spanishA, spanishB, readonlyA, readonlyB, editableA, editableB];
      await runAct(() => owners[0]!.unregister());
      for (const oldContext of oldContexts) {
        expect(oldContext.signal.aborted).toBe(true);
        expect(transient(oldContext).read()).toBeUndefined();
        expect(transient(oldContext).write('cannot revive generation')).toBe(false);
        expect(
          oldContext.data.patchCell({
            databaseId: oldContext.databaseId,
            rowId: SOURCE_ROW_ID,
            propertyId: 'quantity',
            value: 7,
            expectedRevision: 'r0',
          }),
        ).toMatchObject({ status: 'error', code: 'owner-inactive' });
      }

      let reloadedOwner: ProviderOwner | undefined;
      await runAct(() => {
        reloadedOwner = registerTestProvider(fixture, OWNER_A, mounted);
      });
      owners.push(reloadedOwner!);
      const sameOwnerA = activeMount(mounted, rootA);
      const sameOwnerB = activeMount(mounted, rootB);
      expect(transient(sameOwnerA).read()).toBe('draft A through fence');
      expect(transient(sameOwnerB).read()).toBe('readonly draft B');
      expect(transient(sameOwnerA).write(undefined)).toBe(true);
      expect(transient(sameOwnerA).read()).toBeUndefined();
      expect(transient(sameOwnerB).read()).toBe('readonly draft B');

      expect(vaultApply).not.toHaveBeenCalled();
      expect(fixture.vault.files).toEqual(initialFiles);
    } finally {
      await rootA.unmount();
      await rootB.unmount();
      for (const owner of owners) owner.unregister();
      if (!fixture.session.isClosed) await fixture.session.close();
      await runAct(() =>
        setPreferences({ locale: previousPreferences.locale, readingMode: previousPreferences.readingMode }),
      );
      expect(vaultApply).not.toHaveBeenCalled();
      expect(fixture.vault.files).toEqual(initialFiles);
      expect(nonPreferenceStorageSnapshot()).toEqual(unrelatedStorage);
    }
  });

  it('clears a changed Source binding while the provider is absent before returning to the original page', async () => {
    const fixture = await openFixture();
    const previousPreferences = getPreferences();
    const unrelatedStorage = nonPreferenceStorageSnapshot();
    const initialFiles = new Map(fixture.vault.files);
    const vaultApply = vi.spyOn(fixture.vault, 'apply');
    const mounted: DatabaseProviderContext[] = [];
    const root = mountSourceRoot();
    const owners: ProviderOwner[] = [];
    try {
      await runAct(() => setPreferences({ locale: 'pt', readingMode: false }));
      owners.push(registerTestProvider(fixture, OWNER_A, mounted));
      await runAct(() => root.render(fixture.source));
      const pageA = activeMount(mounted, root);
      expect(transient(pageA).write('must be cleared on binding change')).toBe(true);

      await runAct(() => owners[0]!.unregister());
      expect(pageA.signal.aborted).toBe(true);
      expect(transient(pageA).read()).toBeUndefined();
      expect(transient(pageA).write('stale A')).toBe(false);
      const mountCountWhileMissing = mounted.length;

      await runAct(() => root.render(fixture.otherSource));
      expect(root.container.querySelector('.database-provider-root')).toBeNull();
      await runAct(() => root.render(fixture.source));
      expect(root.container.querySelector('.database-provider-root')).toBeNull();
      expect(mounted).toHaveLength(mountCountWhileMissing);

      let reloadedOwner: ProviderOwner | undefined;
      await runAct(() => {
        reloadedOwner = registerTestProvider(fixture, OWNER_A, mounted);
      });
      owners.push(reloadedOwner!);
      const restoredPageA = activeMount(mounted, root);
      expect(restoredPageA.databaseId).toBe(pageA.databaseId);
      expect(transient(restoredPageA).read()).toBeUndefined();
      expect(transient(pageA).read()).toBeUndefined();
      expect(transient(pageA).write('old slot cannot return')).toBe(false);
      expect(vaultApply).not.toHaveBeenCalled();
      expect(fixture.vault.files).toEqual(initialFiles);
    } finally {
      await root.unmount();
      for (const owner of owners) owner.unregister();
      if (!fixture.session.isClosed) await fixture.session.close();
      await runAct(() =>
        setPreferences({ locale: previousPreferences.locale, readingMode: previousPreferences.readingMode }),
      );
      expect(vaultApply).not.toHaveBeenCalled();
      expect(fixture.vault.files).toEqual(initialFiles);
      expect(nonPreferenceStorageSnapshot()).toEqual(unrelatedStorage);
    }
  });

  it('clears state on owner/session replacement and logical Source removal, and revokes every old handle', async () => {
    const firstFixture = await openFixture();
    const secondFixture = await openFixture();
    const previousPreferences = getPreferences();
    const unrelatedStorage = nonPreferenceStorageSnapshot();
    const firstFiles = new Map(firstFixture.vault.files);
    const secondFiles = new Map(secondFixture.vault.files);
    const firstApply = vi.spyOn(firstFixture.vault, 'apply');
    const secondApply = vi.spyOn(secondFixture.vault, 'apply');
    const mounted: DatabaseProviderContext[] = [];
    const root = mountSourceRoot();
    let replacementRoot: RootHarness | undefined;
    const owners: ProviderOwner[] = [];
    try {
      await runAct(() => {
        setSession(firstFixture.session);
        setPreferences({ locale: 'en', readingMode: false });
      });
      owners.push(registerTestProvider(firstFixture, OWNER_A, mounted));
      await runAct(() => root.render(firstFixture.source));
      const firstMount = activeMount(mounted, root);
      expect(transient(firstMount).write('owner A session 1')).toBe(true);

      await runAct(() => owners[0]!.unregister());
      let replacementOwner: ProviderOwner | undefined;
      await runAct(() => {
        replacementOwner = registerTestProvider(firstFixture, OWNER_B, mounted);
      });
      owners.push(replacementOwner!);
      const ownerReplacement = activeMount(mounted, root);
      expect(transient(ownerReplacement).read()).toBeUndefined();
      expect(firstMount.signal.aborted).toBe(true);
      expect(transient(firstMount).write('stale owner A')).toBe(false);
      expect(transient(ownerReplacement).write('owner B session 1')).toBe(true);

      const firstSessionId = firstFixture.source.id;
      expect(secondFixture.source.id).toBe(firstSessionId);
      await runAct(async () => {
        owners[1]!.unregister();
        setSession(secondFixture.session);
        owners.push(registerTestProvider(secondFixture, OWNER_B, mounted));
        root.render(secondFixture.source);
      });
      const newSessionMount = activeMount(mounted, root);
      expect(newSessionMount.databaseId).toBe(ownerReplacement.databaseId);
      expect(ownerReplacement.signal.aborted).toBe(true);
      expect(transient(ownerReplacement).read()).toBeUndefined();
      expect(transient(ownerReplacement).write('stale prior session')).toBe(false);
      expect(transient(newSessionMount).read()).toBeUndefined();
      expect(transient(newSessionMount).write('session 2 draft')).toBe(true);

      await root.unmount();
      expect(newSessionMount.signal.aborted).toBe(true);
      expect(transient(newSessionMount).read()).toBeUndefined();
      expect(transient(newSessionMount).write('after surface removal')).toBe(false);

      const rootAfterRemoval = mountSourceRoot();
      replacementRoot = rootAfterRemoval;
      await runAct(() => rootAfterRemoval.render(secondFixture.source));
      const afterRemoval = activeMount(mounted, rootAfterRemoval);
      expect(transient(afterRemoval).read()).toBeUndefined();

      await runAct(() => secondFixture.session.close());
      expect(afterRemoval.signal.aborted).toBe(true);
      expect(transient(afterRemoval).read()).toBeUndefined();
      expect(transient(afterRemoval).write('after session close')).toBe(false);
      expect(
        afterRemoval.data.patchCell({
          databaseId: afterRemoval.databaseId,
          rowId: SOURCE_ROW_ID,
          propertyId: 'quantity',
          value: 8,
          expectedRevision: 'r0',
        }),
      ).toMatchObject({ status: 'error', code: 'owner-inactive' });

      await rootAfterRemoval.unmount();
      expect(firstApply).not.toHaveBeenCalled();
      expect(secondApply).not.toHaveBeenCalled();
      expect(firstFixture.vault.files).toEqual(firstFiles);
      expect(secondFixture.vault.files).toEqual(secondFiles);
    } finally {
      await root.unmount();
      await replacementRoot?.unmount();
      for (const owner of owners) owner.unregister();
      if (!firstFixture.session.isClosed) await firstFixture.session.close();
      if (!secondFixture.session.isClosed) await secondFixture.session.close();
      await runAct(() =>
        setPreferences({ locale: previousPreferences.locale, readingMode: previousPreferences.readingMode }),
      );
      expect(firstApply).not.toHaveBeenCalled();
      expect(secondApply).not.toHaveBeenCalled();
      expect(firstFixture.vault.files).toEqual(firstFiles);
      expect(secondFixture.vault.files).toEqual(secondFiles);
      expect(nonPreferenceStorageSnapshot()).toEqual(unrelatedStorage);
    }
  });

  it('keeps a provider mount compatible when its plugin ignores the optional transient capability', async () => {
    const fixture = await openFixture();
    const previousPreferences = getPreferences();
    const unrelatedStorage = nonPreferenceStorageSnapshot();
    const initialFiles = new Map(fixture.vault.files);
    const vaultApply = vi.spyOn(fixture.vault, 'apply');
    const mounted: DatabaseProviderContext[] = [];
    let legacyMountCount = 0;
    const root = mountSourceRoot();
    let owner: ProviderOwner | undefined;
    try {
      await runAct(() => setPreferences({ locale: 'pt', readingMode: false }));
      owner = registerTestProvider(fixture, 'legacy-independent-provider', mounted, (context) => {
        legacyMountCount += 1;
        context.element.textContent = context.locale;
      });
      await runAct(() => root.render(fixture.source));
      const context = activeMount(mounted, root);
      expect(legacyMountCount).toBe(1);
      expect(root.container.textContent).toContain('pt');
      expect(context.transientState).toBeDefined();
      expect(vaultApply).not.toHaveBeenCalled();
      expect(fixture.vault.files).toEqual(initialFiles);
    } finally {
      await root.unmount();
      owner?.unregister();
      if (!fixture.session.isClosed) await fixture.session.close();
      await runAct(() =>
        setPreferences({ locale: previousPreferences.locale, readingMode: previousPreferences.readingMode }),
      );
      expect(vaultApply).not.toHaveBeenCalled();
      expect(fixture.vault.files).toEqual(initialFiles);
      expect(nonPreferenceStorageSnapshot()).toEqual(unrelatedStorage);
    }
  });
});
