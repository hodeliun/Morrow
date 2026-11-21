// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageId, PageMeta } from '../../core/model';
import { encodePolarisDadosViewMarker } from '../../core/polarisDadosView';
import type { PolarisDadosViewData } from '../../core/polarisDadosView';
import { DatabaseView } from '../components/database/DatabaseView';
import { PolarisDadosView } from '../editor/PolarisDadosView';
import { getPreferences, setPreferences } from '../platform/preferences';
import { E003_POLARIS_DADOS_FIXTURE } from '../../storage/fixtures/e003-polaris-dados';
import { MemoryVault } from '../../storage/memoryVault';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';
import { getSession, setSession } from '../workspace';
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
const LINKED_NOTE_ID = 'independent-linked-note' as PageId;
const LINKED_VIEW_ID = 'independent-shared-view';

function linkedViewData(sourceDatabaseId: PageId): PolarisDadosViewData {
  return {
    version: 1,
    viewId: LINKED_VIEW_ID,
    sourceDatabaseId,
    title: 'Shared linked view',
    columnOrder: ['name', 'quantity'],
    filter: null,
  };
}

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

interface LinkedFixture extends TestFixture {
  readonly note: PageMeta;
}

function makeLinkedWorkspaceFiles(widgetName: string): Record<string, string> {
  const files = makeWorkspaceFiles();
  const widget = files['Inventory/Widget.md'];
  const workspaceText = files['.morrow/workspace.json'];
  if (!widget || !workspaceText) throw new Error('The synthetic workspace is incomplete.');
  files['Inventory/Widget.md'] = widget.replace('Name: Widget', `Name: ${widgetName}`);
  files['Linked views.md'] = `# Linked views\n\n${encodePolarisDadosViewMarker(linkedViewData(SOURCE_ID))}\n`;
  const workspace = JSON.parse(workspaceText) as {
    pages: Record<string, { id: string; created: number; order: number }>;
  };
  workspace.pages['Linked views.md'] = { id: LINKED_NOTE_ID, created: 5, order: 2 };
  files['.morrow/workspace.json'] = JSON.stringify(workspace);
  return files;
}

async function openLinkedFixture(widgetName = 'Widget', installGlobally = true): Promise<LinkedFixture> {
  const vault = new MemoryVault(makeLinkedWorkspaceFiles(widgetName));
  const opened = await WorkspaceSession.open(
    new VaultRepository(vault, () => 'unexpected-generated-page'),
    { delayMs: 60_000 },
  );
  if (!opened.ok) throw new Error(opened.error);
  const session = opened.value;
  const state = session.getState();
  const source = state.pages[SOURCE_ID];
  const otherSource = state.pages[OTHER_SOURCE_ID];
  const note = state.pages[LINKED_NOTE_ID];
  if (!source || !otherSource || !note || !state.docs[LINKED_NOTE_ID])
    throw new Error('The synthetic linked-view pages did not load.');
  if (installGlobally) setSession(session);
  return { session, vault, source, otherSource, note };
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

interface LinkedEditorHarness {
  readonly container: HTMLDivElement;
  readonly editor: Editor;
  destroy(): void;
}

function mountLinkedEditor(session: WorkspaceSession): LinkedEditorHarness {
  const container = document.createElement('div');
  document.body.append(container);
  const doc = session.getState().docs[LINKED_NOTE_ID];
  if (!doc) throw new Error('The synthetic linked-view note did not load.');
  const editor = new Editor({
    element: container,
    extensions: [
      StarterKit,
      PolarisDadosView.configure({ mountContext: { session, pageId: LINKED_NOTE_ID } }),
    ],
    content: doc,
    editable: true,
  });
  let destroyed = false;
  return {
    container,
    editor,
    destroy() {
      if (destroyed) return;
      editor.destroy();
      container.remove();
      destroyed = true;
    },
  };
}

function activeLinkedMount(
  mounted: readonly DatabaseProviderContext[],
  harness: LinkedEditorHarness,
): DatabaseProviderContext {
  const matches = linkedMountsForEditor(mounted, harness);
  if (matches.length !== 1)
    throw new Error(
      `Expected one current Linked NodeView mount, received ${matches.length}; mount calls=${mounted.length}; html=${harness.container.innerHTML}`,
    );
  return matches[0]!;
}

function linkedMountsForEditor(
  mounted: readonly DatabaseProviderContext[],
  harness: LinkedEditorHarness,
): DatabaseProviderContext[] {
  return mounted.filter(
    (context) =>
      context.view !== undefined &&
      harness.editor.view.dom.contains(context.element) &&
      !context.signal.aborted,
  );
}

function linkedView(context: DatabaseProviderContext) {
  if (!context.view) throw new Error('The real Linked NodeView mount omitted its LinkedViewApi.');
  return context.view;
}

function updateLinkedView(editor: Editor, data: PolarisDadosViewData): void {
  let position: number | null = null;
  editor.state.doc.descendants((node, from) => {
    if (node.type.name === 'polarisDadosView' && node.attrs.viewId === LINKED_VIEW_ID) {
      position = from;
      return false;
    }
    return true;
  });
  if (position === null) throw new Error('The real TipTap editor has no linked-view node.');
  const node = editor.state.doc.nodeAt(position);
  if (!node) throw new Error('The linked-view node position is no longer valid.');
  editor.view.dispatch(
    editor.state.tr.setNodeMarkup(position, undefined, { ...node.attrs, ...data }),
  );
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

describe('independent provider transient host lifecycle', () => {
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

  it('keeps equal-ID Linked NodeViews isolated through preferences, provider absence, and marker A→B→A', async () => {
    const fixture = await openLinkedFixture();
    const previousPreferences = getPreferences();
    const unrelatedStorage = nonPreferenceStorageSnapshot();
    const initialFiles = new Map(fixture.vault.files);
    const vaultApply = vi.spyOn(fixture.vault, 'apply');
    const mounted: DatabaseProviderContext[] = [];
    const editorA = mountLinkedEditor(fixture.session);
    const editorB = mountLinkedEditor(fixture.session);
    const owners: ProviderOwner[] = [];
    try {
      await runAct(() => setPreferences({ locale: 'pt', readingMode: false }));
      owners.push(registerTestProvider(fixture, OWNER_A, mounted));

      const firstA = activeLinkedMount(mounted, editorA);
      const firstB = activeLinkedMount(mounted, editorB);
      expect(linkedView(firstA).snapshot()).toMatchObject({
        status: 'ready',
        pageId: LINKED_NOTE_ID,
        viewId: LINKED_VIEW_ID,
        sourceDatabaseId: SOURCE_ID,
      });
      expect(linkedView(firstB).snapshot()).toMatchObject({
        status: 'ready',
        pageId: LINKED_NOTE_ID,
        viewId: LINKED_VIEW_ID,
        sourceDatabaseId: SOURCE_ID,
      });
      expect(firstA.databaseId).toBe(firstB.databaseId);
      expect(transient(firstA).write('editor A draft')).toBe(true);
      expect(transient(firstB).write('editor B draft')).toBe(true);
      expect(transient(firstA).read()).toBe('editor A draft');
      expect(transient(firstB).read()).toBe('editor B draft');

      await runAct(() => setPreferences({ locale: 'es' }));
      const spanishA = activeLinkedMount(mounted, editorA);
      const spanishB = activeLinkedMount(mounted, editorB);
      expect(spanishA.locale).toBe('es');
      expect(spanishB.locale).toBe('es');
      expect(firstA.signal.aborted).toBe(true);
      expect(firstB.signal.aborted).toBe(true);
      expect(transient(firstA).read()).toBeUndefined();
      expect(transient(firstA).write('stale editor A')).toBe(false);
      expect(() => linkedView(firstA).snapshot()).toThrow(/no longer active/i);
      expect(transient(spanishA).read()).toBe('editor A draft');
      expect(transient(spanishB).read()).toBe('editor B draft');

      await runAct(() => setPreferences({ readingMode: true }));
      const readonlyA = activeLinkedMount(mounted, editorA);
      const readonlyB = activeLinkedMount(mounted, editorB);
      expect(readonlyA.editable).toBe(false);
      expect(readonlyB.editable).toBe(false);
      expect(linkedView(readonlyA).snapshot()).toMatchObject({ status: 'ready', readonly: true });
      expect(transient(readonlyA).read()).toBe('editor A draft');
      expect(transient(readonlyB).read()).toBe('editor B draft');

      await runAct(() => setPreferences({ readingMode: false }));
      const editableA = activeLinkedMount(mounted, editorA);
      const editableB = activeLinkedMount(mounted, editorB);
      expect(editableA.editable).toBe(true);
      expect(editableB.editable).toBe(true);

      await runAct(() => owners[0]!.unregister());
      for (const oldContext of [firstA, firstB, spanishA, spanishB, readonlyA, readonlyB, editableA, editableB]) {
        expect(oldContext.signal.aborted).toBe(true);
        expect(transient(oldContext).read()).toBeUndefined();
        expect(transient(oldContext).write('stale after unload')).toBe(false);
        expect(() => linkedView(oldContext).snapshot()).toThrow(/no longer active/i);
      }

      // This editor's uncommitted node binding changes while the provider is absent;
      // the other equal-ID editor must keep its own slot.
      updateLinkedView(editorA.editor, linkedViewData(OTHER_SOURCE_ID));
      expect(editorA.container.querySelector('.polaris-dados-view-fallback')?.textContent).toContain(
        'no longer available',
      );
      updateLinkedView(editorA.editor, linkedViewData(SOURCE_ID));

      owners.push(registerTestProvider(fixture, OWNER_A, mounted));
      const restoredA = activeLinkedMount(mounted, editorA);
      const restoredB = activeLinkedMount(mounted, editorB);
      expect(transient(restoredA).read()).toBeUndefined();
      expect(transient(restoredB).read()).toBe('editor B draft');
      expect(transient(restoredA).write('restored A draft')).toBe(true);
      expect(transient(restoredB).read()).toBe('editor B draft');

      await runAct(() => owners[1]!.unregister());
      owners.push(registerTestProvider(fixture, OWNER_B, mounted));
      const newOwnerA = activeLinkedMount(mounted, editorA);
      const newOwnerB = activeLinkedMount(mounted, editorB);
      expect(restoredA.signal.aborted).toBe(true);
      expect(restoredB.signal.aborted).toBe(true);
      expect(() => linkedView(restoredA).snapshot()).toThrow(/no longer active/i);
      expect(transient(newOwnerA).read()).toBeUndefined();
      expect(transient(newOwnerB).read()).toBeUndefined();

      expect(vaultApply).not.toHaveBeenCalled();
      expect(fixture.vault.files).toEqual(initialFiles);
    } finally {
      editorA.destroy();
      editorB.destroy();
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

  it('reinstalls an empty Linked slot after a reentrant host session A→B→A switch', async () => {
    const fixture = await openLinkedFixture();
    const otherFixture = await openLinkedFixture('Other host session', false);
    const previousPreferences = getPreferences();
    const unrelatedStorage = nonPreferenceStorageSnapshot();
    const initialFiles = new Map(fixture.vault.files);
    const otherFiles = new Map(otherFixture.vault.files);
    const vaultApply = vi.spyOn(fixture.vault, 'apply');
    const otherApply = vi.spyOn(otherFixture.vault, 'apply');
    const mounted: DatabaseProviderContext[] = [];
    const editor = mountLinkedEditor(fixture.session);
    const owners: ProviderOwner[] = [];
    let reenterOnCleanup = false;
    let didReenter = false;
    try {
      await runAct(() => setPreferences({ locale: 'en', readingMode: false }));
      owners.push(
        registerTestProvider(fixture, OWNER_A, mounted, (context) => {
          if (!context.view) return;
          return () => {
            if (reenterOnCleanup && !didReenter) {
              didReenter = true;
              setSession(fixture.session);
            }
          };
        }),
      );
      const oldMount = activeLinkedMount(mounted, editor);
      const oldView = linkedView(oldMount);
      expect(transient(oldMount).write('must not cross host generation')).toBe(true);

      reenterOnCleanup = true;
      await runAct(() => setSession(otherFixture.session));

      expect(didReenter).toBe(true);
      expect(getSession()).toBe(fixture.session);
      expect(oldMount.signal.aborted).toBe(true);
      expect(transient(oldMount).read()).toBeUndefined();
      expect(transient(oldMount).write('stale prior generation')).toBe(false);
      expect(() => oldView.snapshot()).toThrow(/no longer active/i);

      const currentMount = activeLinkedMount(mounted, editor);
      expect(currentMount).not.toBe(oldMount);
      expect(currentMount.signal.aborted).toBe(false);
      expect(linkedView(currentMount).snapshot()).toMatchObject({ status: 'ready', pageId: LINKED_NOTE_ID });
      expect(transient(currentMount).read()).toBeUndefined();
      expect(transient(currentMount).write('new host generation')).toBe(true);
      expect(transient(currentMount).read()).toBe('new host generation');

      expect(vaultApply).not.toHaveBeenCalled();
      expect(otherApply).not.toHaveBeenCalled();
      expect(fixture.vault.files).toEqual(initialFiles);
      expect(otherFixture.vault.files).toEqual(otherFiles);
    } finally {
      editor.destroy();
      for (const owner of owners) owner.unregister();
      if (!fixture.session.isClosed) await fixture.session.close();
      if (!otherFixture.session.isClosed) await otherFixture.session.close();
      await runAct(() =>
        setPreferences({ locale: previousPreferences.locale, readingMode: previousPreferences.readingMode }),
      );
      expect(vaultApply).not.toHaveBeenCalled();
      expect(otherApply).not.toHaveBeenCalled();
      expect(fixture.vault.files).toEqual(initialFiles);
      expect(otherFixture.vault.files).toEqual(otherFiles);
      expect(nonPreferenceStorageSnapshot()).toEqual(unrelatedStorage);
    }
  });

  it('does not mount an explicit session A Linked NodeView against the active session B provider API', async () => {
    const fixtureA = await openLinkedFixture('Session A widget');
    const fixtureB = await openLinkedFixture('Session B widget', false);
    const previousPreferences = getPreferences();
    const unrelatedStorage = nonPreferenceStorageSnapshot();
    const filesA = new Map(fixtureA.vault.files);
    const filesB = new Map(fixtureB.vault.files);
    const applyA = vi.spyOn(fixtureA.vault, 'apply');
    const applyB = vi.spyOn(fixtureB.vault, 'apply');
    const mounted: DatabaseProviderContext[] = [];
    const owners: ProviderOwner[] = [];
    let editorA: LinkedEditorHarness | undefined;
    try {
      await runAct(() => {
        setPreferences({ locale: 'en', readingMode: false });
        setSession(fixtureB.session);
      });
      owners.push(registerTestProvider(fixtureB, 'host-session-b-provider', mounted));
      const bData = owners[0]!.data.snapshot(SOURCE_ID);
      expect(bData.status).toBe('ready');
      expect(JSON.stringify(bData)).toContain('Session B widget');

      editorA = mountLinkedEditor(fixtureA.session);
      expect(getSession()).toBe(fixtureB.session);
      const escapedMounts = linkedMountsForEditor(mounted, editorA);
      if (escapedMounts.length > 0)
        expect(JSON.stringify(escapedMounts[0]!.data.snapshot(SOURCE_ID))).toContain('Session B widget');
      expect(escapedMounts).toHaveLength(0);
      expect(editorA.container.querySelector('.polaris-dados-view-fallback')).not.toBeNull();

      expect(applyA).not.toHaveBeenCalled();
      expect(applyB).not.toHaveBeenCalled();
      expect(fixtureA.vault.files).toEqual(filesA);
      expect(fixtureB.vault.files).toEqual(filesB);
    } finally {
      editorA?.destroy();
      for (const owner of owners) owner.unregister();
      if (!fixtureA.session.isClosed) await fixtureA.session.close();
      if (!fixtureB.session.isClosed) await fixtureB.session.close();
      await runAct(() =>
        setPreferences({ locale: previousPreferences.locale, readingMode: previousPreferences.readingMode }),
      );
      expect(applyA).not.toHaveBeenCalled();
      expect(applyB).not.toHaveBeenCalled();
      expect(fixtureA.vault.files).toEqual(filesA);
      expect(fixtureB.vault.files).toEqual(filesB);
      expect(nonPreferenceStorageSnapshot()).toEqual(unrelatedStorage);
    }
  });

  it('clears Linked drafts on NodeView destroy and session close without vault writes', async () => {
    const fixture = await openLinkedFixture();
    const previousPreferences = getPreferences();
    const unrelatedStorage = nonPreferenceStorageSnapshot();
    const initialFiles = new Map(fixture.vault.files);
    const vaultApply = vi.spyOn(fixture.vault, 'apply');
    const mounted: DatabaseProviderContext[] = [];
    const editorA = mountLinkedEditor(fixture.session);
    const editorB = mountLinkedEditor(fixture.session);
    let owner: ProviderOwner | undefined;
    try {
      await runAct(() => setPreferences({ locale: 'pt', readingMode: false }));
      owner = registerTestProvider(fixture, OWNER_A, mounted);
      const originalA = activeLinkedMount(mounted, editorA);
      const originalB = activeLinkedMount(mounted, editorB);
      const oldApiA = linkedView(originalA);
      const oldApiB = linkedView(originalB);
      expect(transient(originalA).write('destroy this draft')).toBe(true);
      expect(transient(originalB).write('keep the other editor draft')).toBe(true);

      editorA.editor.commands.setContent({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Linked view removed.' }] }],
      });
      expect(originalA.signal.aborted).toBe(true);
      expect(transient(originalA).read()).toBeUndefined();
      expect(transient(originalA).write('cannot restore destroyed state')).toBe(false);
      expect(() => oldApiA.snapshot()).toThrow(/no longer active/i);
      expect(transient(activeLinkedMount(mounted, editorB)).read()).toBe('keep the other editor draft');

      const originalDoc = fixture.session.getState().docs[LINKED_NOTE_ID];
      if (!originalDoc) throw new Error('The canonical linked-view note disappeared.');
      editorA.editor.commands.setContent(originalDoc);
      const restoredA = activeLinkedMount(mounted, editorA);
      expect(restoredA).not.toBe(originalA);
      expect(transient(restoredA).read()).toBeUndefined();
      expect(transient(activeLinkedMount(mounted, editorB)).read()).toBe('keep the other editor draft');

      await runAct(() => fixture.session.close());
      expect(restoredA.signal.aborted).toBe(true);
      expect(originalB.signal.aborted).toBe(true);
      expect(transient(restoredA).read()).toBeUndefined();
      expect(transient(restoredA).write('after session close')).toBe(false);
      expect(transient(originalB).read()).toBeUndefined();
      expect(transient(originalB).write('after close')).toBe(false);
      expect(() => linkedView(restoredA).snapshot()).toThrow(/session is closed/i);
      expect(() => oldApiB.snapshot()).toThrow(/session is closed/i);

      expect(vaultApply).not.toHaveBeenCalled();
      expect(fixture.vault.files).toEqual(initialFiles);
    } finally {
      editorA.destroy();
      editorB.destroy();
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
