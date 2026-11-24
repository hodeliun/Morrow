// @vitest-environment happy-dom
import { Editor } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocNode, PageId } from '../../core/model';
import { encodePolarisDadosViewMarker } from '../../core/polarisDadosView';
import type { PolarisDadosViewData } from '../../core/polarisDadosView';
import { E003_POLARIS_DADOS_FIXTURE } from '../../storage/fixtures/e003-polaris-dados';
import { MemoryVault } from '../../storage/memoryVault';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';
import { createDataApi } from '../plugins/dataApi';
import type { DatabaseProviderContext } from '../plugins/providerApi';
import { getDatabaseProvider, registerDatabaseProvider } from '../plugins/providerRegistry';
import { getPreferences, setPreferences } from '../platform/preferences';
import { setSession } from '../workspace';
import { createExtensions } from './extensions';

const NOTE_ID = 'transient-linked-note' as PageId;
const SOURCE_A_ID = 'transient-source-a' as PageId;
const ROW_A_ID = 'transient-row-a' as PageId;
const SOURCE_B_ID = 'transient-source-b' as PageId;
const ROW_B_ID = 'transient-row-b' as PageId;
const VIEW_A: PolarisDadosViewData = {
  version: 1,
  viewId: 'transient-view-a',
  sourceDatabaseId: SOURCE_A_ID,
  title: 'View A',
  columnOrder: ['quantity'],
  filter: null,
};
const VIEW_B: PolarisDadosViewData = {
  ...VIEW_A,
  viewId: 'transient-view-b',
  sourceDatabaseId: SOURCE_B_ID,
  title: 'View B',
};
const originalPreferences = getPreferences();
const editors = new Set<Editor>();
const sessions = new Set<WorkspaceSession>();
const providerReleases = new Set<() => void>();

interface Fixture {
  readonly session: WorkspaceSession;
  readonly vault: MemoryVault;
}

interface ProviderRecord {
  readonly context: DatabaseProviderContext;
  readonly cleanup: ReturnType<typeof vi.fn>;
}

async function openSession(): Promise<Fixture> {
  const files = {
    'Inventory.md': E003_POLARIS_DADOS_FIXTURE['Inventory.md']!,
    'Inventory/Widget.md': E003_POLARIS_DADOS_FIXTURE['Inventory/Widget.md']!,
    'OtherInventory.md': E003_POLARIS_DADOS_FIXTURE['Inventory.md']!,
    'OtherInventory/OtherWidget.md': E003_POLARIS_DADOS_FIXTURE['Inventory/Widget.md']!,
    'Views.md': `# Linked views\n\n${encodePolarisDadosViewMarker(VIEW_A)}\n`,
    '.morrow/workspace.json': JSON.stringify({
      version: 1,
      pages: {
        'Inventory.md': { id: SOURCE_A_ID, created: 1, order: 0 },
        'Inventory/Widget.md': { id: ROW_A_ID, created: 2, order: 0 },
        'OtherInventory.md': { id: SOURCE_B_ID, created: 3, order: 1 },
        'OtherInventory/OtherWidget.md': { id: ROW_B_ID, created: 4, order: 0 },
        'Views.md': { id: NOTE_ID, created: 5, order: 2 },
      },
    }),
    '.morrow/recent.json': JSON.stringify({ version: 1, opened: {}, activity: {} }),
  };
  const vault = new MemoryVault(files);
  const opened = await WorkspaceSession.open(
    new VaultRepository(vault, () => 'unexpected-generated-page-id'),
    { delayMs: 60_000 },
  );
  if (!opened.ok) throw new Error(opened.error);
  sessions.add(opened.value);
  return { session: opened.value, vault };
}

function createEditor(session: WorkspaceSession): Editor {
  const container = document.createElement('div');
  document.body.append(container);
  const editor = new Editor({
    element: container,
    extensions: createExtensions({
      onBlockMenu: () => {},
      resolvePage: () => null,
      openTag: () => {},
      createChild: () => null,
      openDate: () => {},
      pages: () => [],
      createPage: () => null,
      renderEmbed: () => {},
      linkedViewContext: { session, pageId: NOTE_ID },
    } as never),
  });
  editor.view.updateState(
    EditorState.create({
      doc: editor.schema.nodeFromJSON(session.getState().docs[NOTE_ID]),
      plugins: editor.state.plugins,
    }),
  );
  editor.setEditable(true, false);
  editor.view.dom.dispatchEvent(new Event('morrow:linked-view-context'));
  editors.add(editor);
  return editor;
}

function viewNodePosition(editor: Editor): number {
  const positions: number[] = [];
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === 'polarisDadosView') positions.push(position);
  });
  if (positions.length !== 1) throw new Error(`Expected one linked view, found ${positions.length}.`);
  return positions[0]!;
}

function updateEditorView(editor: Editor, data: PolarisDadosViewData): void {
  const position = viewNodePosition(editor);
  const node = editor.state.doc.nodeAt(position);
  if (!node) throw new Error('The linked view node is missing.');
  editor.view.dispatch(editor.state.tr.setNodeMarkup(position, undefined, { ...node.attrs, ...data }));
}

function replaceLinkedView(doc: DocNode, data: PolarisDadosViewData): DocNode {
  const copy = structuredClone(doc);
  let replacements = 0;
  const visit = (node: DocNode) => {
    if (node.type === 'polarisDadosView') {
      node.attrs = { ...node.attrs, ...data };
      replacements++;
      return;
    }
    node.content?.forEach(visit);
  };
  visit(copy);
  if (replacements !== 1) throw new Error(`Expected one persisted linked view, found ${replacements}.`);
  return copy;
}

function applyExternalPage(
  session: WorkspaceSession,
  pageId: PageId,
  page: ReturnType<WorkspaceSession['getState']>['pages'][PageId],
  doc?: DocNode,
): void {
  if (!page) throw new Error(`Page ${pageId} is missing.`);
  const accepted = session.applyExternal({
    pages: [page],
    docs: doc ? { [pageId]: doc } : {},
    removed: [],
    unreadable: [],
    readable: [],
  });
  if (!accepted.includes(pageId)) throw new Error(`External fixture update for ${pageId} was rejected.`);
}

function changeLinkedView(session: WorkspaceSession, data: PolarisDadosViewData): void {
  const state = session.getState();
  const owner = state.pages[NOTE_ID];
  const doc = state.docs[NOTE_ID];
  if (!owner || !doc) throw new Error('The linked view owner is missing.');
  applyExternalPage(session, NOTE_ID, owner, replaceLinkedView(doc, data));
}

function changeProviderMarker(session: WorkspaceSession, providerId: string): void {
  const source = session.getState().pages[SOURCE_A_ID];
  if (!source) throw new Error('The source database is missing.');
  applyExternalPage(session, SOURCE_A_ID, {
    ...source,
    extra: { ...source.extra, polarisDados: { version: 1, provider: providerId } },
  });
}

function registerTestProvider(
  owner: string,
  session: WorkspaceSession,
  records: ProviderRecord[],
  onMountCleanup?: () => void,
): () => void {
  let ownerActive = true;
  let disposed = false;
  const apiCleanups = new Set<() => void>();
  const data = createDataApi({
    session,
    ownerIsActive: () => ownerActive,
    isProviderActive: () => getDatabaseProvider('polaris-dados')?.data === data,
    isHostReadonly: () => getPreferences().readingMode,
    registerCleanup: (cleanup) => apiCleanups.add(cleanup),
  });
  const removeRegistration = registerDatabaseProvider(owner, () => ownerActive, data, {
    id: 'polaris-dados',
    apiVersion: 1,
    mount(context) {
      const cleanup = vi.fn();
      records.push({ context, cleanup });
      return () => {
        cleanup();
        onMountCleanup?.();
      };
    },
  });
  const release = () => {
    if (disposed) return;
    disposed = true;
    ownerActive = false;
    removeRegistration();
    for (const cleanup of [...apiCleanups]) cleanup();
    apiCleanups.clear();
  };
  providerReleases.add(release);
  return release;
}

function activeRecord(editor: Editor, records: ProviderRecord[], viewId = VIEW_A.viewId): ProviderRecord {
  const matches = records.filter((record) => {
    if (record.context.signal.aborted || !editor.view.dom.contains(record.context.element)) return false;
    const snapshot = record.context.view?.snapshot();
    return snapshot?.status === 'ready' && snapshot.viewId === viewId;
  });
  if (matches.length !== 1) throw new Error(`Expected one active ${viewId} root, found ${matches.length}.`);
  return matches[0]!;
}

afterEach(async () => {
  for (const editor of editors) editor.destroy();
  editors.clear();
  for (const release of providerReleases) release();
  providerReleases.clear();
  for (const session of sessions) if (!session.isClosed) await session.close();
  sessions.clear();
  setPreferences({ locale: originalPreferences.locale, readingMode: originalPreferences.readingMode });
  document.body.replaceChildren();
});

describe('linked-view transient provider state', () => {
  it('keeps one slot per real NodeView across reloads and clears changed bindings without writes', async () => {
    const fixture = await openSession();
    const replacementFixture = await openSession();
    const vaultWrites = vi.spyOn(fixture.vault, 'apply');
    const preferenceWrites = vi.spyOn(window.localStorage, 'setItem');
    const records: ProviderRecord[] = [];
    const containers = [document.createElement('div'), document.createElement('div')];
    document.body.append(...containers);
    setPreferences({ locale: 'pt', readingMode: false });
    setSession(fixture.session);
    const releaseFirst = registerTestProvider('transient-owner', fixture.session, records);
    const editorA = createEditor(fixture.session);
    const editorB = createEditor(fixture.session);
    const nodeA = editorA.view.dom.querySelector('.polaris-dados-view-node');
    const nodeB = editorB.view.dom.querySelector('.polaris-dados-view-node');
    const firstA = activeRecord(editorA, records);
    const firstB = activeRecord(editorB, records);
    expect(firstA.context.view?.snapshot()).toMatchObject({
      status: 'ready',
      pageId: NOTE_ID,
      viewId: VIEW_A.viewId,
      sourceDatabaseId: SOURCE_A_ID,
    });
    expect(firstB.context.view?.snapshot()).toMatchObject({
      status: 'ready',
      pageId: NOTE_ID,
      viewId: VIEW_A.viewId,
      sourceDatabaseId: SOURCE_A_ID,
    });
    expect(firstA.context.transientState).toBeDefined();
    expect(firstB.context.transientState).toBeDefined();
    expect(firstA.context.transientState).not.toBe(firstB.context.transientState);
    expect(firstA.context.transientState!.write('draft A')).toBe(true);
    expect(firstB.context.transientState!.write('draft B')).toBe(true);

    setPreferences({ locale: 'es' });
    const localeA = activeRecord(editorA, records);
    const localeB = activeRecord(editorB, records);
    expect(firstA.context.signal.aborted).toBe(true);
    expect(firstA.context.transientState!.read()).toBeUndefined();
    expect(firstA.context.transientState!.write('stale locale handle')).toBe(false);
    expect(() => firstA.context.data.snapshot(SOURCE_A_ID)).toThrow(/no longer active/i);
    expect(localeA.context.locale).toBe('es');
    expect(localeA.context.transientState!.read()).toBe('draft A');
    expect(localeB.context.transientState!.read()).toBe('draft B');

    setPreferences({ readingMode: true });
    const readOnlyA = activeRecord(editorA, records);
    const readOnlyB = activeRecord(editorB, records);
    expect(readOnlyA.context.editable).toBe(false);
    expect(readOnlyB.context.editable).toBe(false);
    expect(localeA.context.signal.aborted).toBe(true);
    expect(readOnlyA.context.transientState!.read()).toBe('draft A');
    expect(readOnlyB.context.transientState!.read()).toBe('draft B');
    expect(
      readOnlyA.context.data.patchCell({
        databaseId: SOURCE_A_ID,
        rowId: ROW_A_ID,
        propertyId: 'quantity',
        value: 9,
        expectedRevision: 'unused-readonly-revision',
      }),
    ).toMatchObject({ status: 'error', code: 'host-readonly' });

    setPreferences({ readingMode: false });
    const editableA = activeRecord(editorA, records);
    expect(editableA.context.transientState!.read()).toBe('draft A');
    expect(readOnlyA.context.signal.aborted).toBe(true);

    preferenceWrites.mockClear();
    releaseFirst();
    expect(editableA.context.signal.aborted).toBe(true);
    expect(editableA.context.transientState!.read()).toBeUndefined();
    expect(editableA.context.transientState!.write('stale after disable')).toBe(false);
    expect(() => editableA.context.data.snapshot(SOURCE_A_ID)).toThrow(/no longer active/i);
    const sameOwnerReload = registerTestProvider('transient-owner', fixture.session, records);
    const reloadedA = activeRecord(editorA, records);
    const reloadedB = activeRecord(editorB, records);
    expect(reloadedA.context.transientState!.read()).toBe('draft A');
    expect(reloadedB.context.transientState!.read()).toBe('draft B');

    expect(reloadedA.context.transientState!.write('discard on binding change')).toBe(true);
    sameOwnerReload();
    changeLinkedView(fixture.session, VIEW_B);
    updateEditorView(editorA, VIEW_B);
    updateEditorView(editorB, VIEW_B);
    expect(editorA.view.dom.querySelector('.polaris-dados-view-node')).toBe(nodeA);
    expect(editorB.view.dom.querySelector('.polaris-dados-view-node')).toBe(nodeB);
    changeLinkedView(fixture.session, VIEW_A);
    updateEditorView(editorA, VIEW_A);
    updateEditorView(editorB, VIEW_A);
    expect(editorA.view.dom.querySelector('.polaris-dados-view-node')).toBe(nodeA);
    expect(editorB.view.dom.querySelector('.polaris-dados-view-node')).toBe(nodeB);

    const markerProbeRelease = registerTestProvider('transient-owner', fixture.session, records);
    const markerProbeA = activeRecord(editorA, records);
    const markerProbeB = activeRecord(editorB, records);
    expect(markerProbeA.context.transientState!.write('marker-only draft A')).toBe(true);
    expect(markerProbeB.context.transientState!.write('marker-only draft B')).toBe(true);
    markerProbeRelease();
    changeProviderMarker(fixture.session, 'temporarily-unavailable');
    changeProviderMarker(fixture.session, 'polaris-dados');
    const finalSameOwnerReload = registerTestProvider('transient-owner', fixture.session, records);
    const clearedA = activeRecord(editorA, records);
    const clearedB = activeRecord(editorB, records);
    expect(clearedA.context.transientState!.read()).toBeUndefined();
    expect(clearedB.context.transientState!.read()).toBeUndefined();
    expect(markerProbeA.context.transientState!.read()).toBeUndefined();
    expect(markerProbeB.context.transientState!.read()).toBeUndefined();
    expect(markerProbeA.context.transientState!.write('stale marker draft')).toBe(false);
    expect(reloadedA.context.transientState!.read()).toBeUndefined();
    expect(reloadedA.context.transientState!.write('stale after binding change')).toBe(false);

    expect(firstA.context.transientState!.write('old editor A')).toBe(false);
    expect(firstB.context.transientState!.write('old editor B')).toBe(false);
    expect(preferenceWrites).not.toHaveBeenCalled();
    expect(vaultWrites).not.toHaveBeenCalled();

    const ownerDraft = clearedA.context.transientState!;
    expect(ownerDraft.write('owner-bound draft')).toBe(true);
    finalSameOwnerReload();
    const otherOwner = registerTestProvider('another-transient-owner', fixture.session, records);
    const newOwnerA = activeRecord(editorA, records);
    expect(newOwnerA.context.transientState!.read()).toBeUndefined();
    expect(ownerDraft.read()).toBeUndefined();
    expect(ownerDraft.write('old owner handle')).toBe(false);

    const ownerContextB = activeRecord(editorB, records);
    expect(ownerContextB.context.transientState!.write('session-bound draft')).toBe(true);
    setSession(replacementFixture.session);
    expect(ownerContextB.context.signal.aborted).toBe(true);
    expect(ownerContextB.context.transientState!.write('stale after session change')).toBe(false);
    expect(() => ownerContextB.context.data.snapshot(SOURCE_A_ID)).toThrow(/no longer active/i);
    setSession(fixture.session);
    const restoredA = activeRecord(editorA, records);
    const restoredB = activeRecord(editorB, records);
    expect(restoredA.context.transientState!.read()).toBeUndefined();
    expect(restoredB.context.transientState!.read()).toBeUndefined();

    editorA.destroy();
    editors.delete(editorA);
    expect(restoredA.context.signal.aborted).toBe(true);
    expect(restoredA.context.transientState!.write('after NodeView destroy')).toBe(false);
    expect(restoredB.context.signal.aborted).toBe(false);
    await fixture.session.close();
    expect(restoredB.context.signal.aborted).toBe(true);
    expect(restoredB.context.transientState!.read()).toBeUndefined();
    expect(restoredB.context.transientState!.write('after close')).toBe(false);
    expect(() => restoredB.context.data.snapshot(SOURCE_A_ID)).toThrow(/no longer active/i);
    expect(vaultWrites).not.toHaveBeenCalled();
    expect(preferenceWrites).not.toHaveBeenCalled();

    otherOwner();
    releaseFirst();
    preferenceWrites.mockRestore();
  });

  it('keeps a nested workspace generation mounted when provider cleanup replaces the session again', async () => {
    const fixture = await openSession();
    const replacementFixture = await openSession();
    const records: ProviderRecord[] = [];
    setPreferences({ locale: 'pt', readingMode: false });
    setSession(fixture.session);
    let reentered = false;
    const release = registerTestProvider('transient-owner-reentrant', fixture.session, records, () => {
      if (reentered) return;
      reentered = true;
      setSession(fixture.session);
    });
    const editor = createEditor(fixture.session);
    const original = activeRecord(editor, records);
    expect(original.context.transientState!.write('before replacement')).toBe(true);

    setSession(replacementFixture.session);

    expect(reentered).toBe(true);
    expect(original.context.signal.aborted).toBe(true);
    expect(original.context.transientState!.write('stale after nested replacement')).toBe(false);
    const restored = activeRecord(editor, records);
    expect(restored).not.toBe(original);
    expect(restored.context.signal.aborted).toBe(false);
    expect(restored.context.transientState!.read()).toBeUndefined();
    expect(restored.context.transientState!.write('fresh after nested replacement')).toBe(true);

    release();
    editor.destroy();
    editors.delete(editor);
  });

  it('does not mount an explicit session against another installed session with equal page IDs', async () => {
    const fixtureA = await openSession();
    const fixtureB = await openSession();
    const records: ProviderRecord[] = [];
    setPreferences({ locale: 'pt', readingMode: false });
    setSession(fixtureB.session);
    const releaseB = registerTestProvider('transient-owner-session-mismatch', fixtureB.session, records);
    const editor = createEditor(fixtureA.session);
    const linkedNode = editor.view.dom.querySelector('.polaris-dados-view-node');

    expect(linkedNode).not.toBeNull();
    expect(linkedNode?.querySelector('.polaris-dados-view-fallback')).not.toBeNull();
    expect(records).toHaveLength(0);

    releaseB();
    setSession(fixtureA.session);
    const releaseA = registerTestProvider('transient-owner-session-mismatch', fixtureA.session, records);
    const mounted = activeRecord(editor, records);
    expect(mounted.context.view?.snapshot()).toMatchObject({
      status: 'ready',
      pageId: NOTE_ID,
      viewId: VIEW_A.viewId,
      sourceDatabaseId: SOURCE_A_ID,
    });
    expect(mounted.context.transientState!.read()).toBeUndefined();

    releaseA();
    editor.destroy();
    editors.delete(editor);
  });
});
