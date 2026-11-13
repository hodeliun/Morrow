// @vitest-environment happy-dom
import type { Editor } from '@tiptap/core';
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { PageId } from '../../core/model';
import { encodePolarisDadosViewMarker } from '../../core/polarisDadosView';
import type { PolarisDadosViewData } from '../../core/polarisDadosView';
import { E003_POLARIS_DADOS_FIXTURE } from '../../storage/fixtures/e003-polaris-dados';
import { MemoryVault } from '../../storage/memoryVault';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';
import { ProviderDatabaseView } from '../components/database/ProviderDatabaseView';
import { getPreferences, setPreferences } from '../platform/preferences';
import type { DatabaseProviderContext } from '../plugins/providerApi';
import { createDataApi } from '../plugins/dataApi';
import type { DataApi, DataApiSnapshot } from '../plugins/dataApi';
import type { LinkedViewApi } from '../plugins/linkedViewApi';
import { registerDatabaseProvider } from '../plugins/providerRegistry';
import { setSession } from '../workspace';
import { undoRedo } from './commits';
import { PageEditor } from './PageEditor';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const NOTE_ID = 'linked-views-note' as PageId;
const SOURCE_ID = 'inventory-source' as PageId;
const ROW_ID = 'inventory-widget' as PageId;
const NOTE_PATH = 'Views.md';
const SOURCE_PATH = 'Inventory.md';
const ROW_PATH = 'Inventory/Widget.md';

const firstView: PolarisDadosViewData = {
  version: 1,
  viewId: 'view-one',
  sourceDatabaseId: SOURCE_ID,
  title: 'Primary view',
  columnOrder: ['name', 'quantity'],
  filter: { propertyId: 'quantity', op: 'gte', value: 1 },
};

const secondView: PolarisDadosViewData = {
  version: 1,
  viewId: 'view-two',
  sourceDatabaseId: SOURCE_ID,
  title: 'Secondary view',
  columnOrder: ['price'],
  filter: null,
};

function viewNote(views: readonly PolarisDadosViewData[] = [firstView, secondView]): string {
  return [
    '# Linked views',
    '',
    'Text before the first view.',
    '',
    ...views.flatMap((view, index) => [
      encodePolarisDadosViewMarker(view),
      ...(index < views.length - 1 ? ['', 'Text between the views.', ''] : []),
    ]),
    '',
    'Text after the last view.',
    '',
  ].join('\n');
}

interface FixtureOptions {
  readonly note?: string;
  readonly views?: readonly PolarisDadosViewData[];
  readonly source?: 'ready' | 'unsupported' | 'missing';
}

function makeFiles(options: FixtureOptions = {}): Record<string, string> {
  const source =
    options.source === 'unsupported'
      ? E003_POLARIS_DADOS_FIXTURE[SOURCE_PATH]!.replace(
          /polarisDados:\n\x20{2}version: 1\n\x20{2}provider: polaris-dados\n/,
          '',
        )
      : E003_POLARIS_DADOS_FIXTURE[SOURCE_PATH]!;
  const files: Record<string, string> = {
    [NOTE_PATH]: options.note ?? viewNote(options.views),
    '.morrow/workspace.json': JSON.stringify({
      version: 1,
      pages: {
        ...(options.source !== 'missing'
          ? {
              [SOURCE_PATH]: { id: SOURCE_ID, created: 1, order: 0 },
              [ROW_PATH]: { id: ROW_ID, created: 2, order: 0 },
            }
          : {}),
        [NOTE_PATH]: { id: NOTE_ID, created: 3, order: 1 },
      },
    }),
    '.morrow/recent.json': JSON.stringify({ version: 1, opened: {}, activity: {} }),
  };
  if (options.source !== 'missing') {
    files[SOURCE_PATH] = source;
    files[ROW_PATH] = E003_POLARIS_DADOS_FIXTURE[ROW_PATH]!;
  }
  return files;
}

async function openWorkspace(options: FixtureOptions = {}) {
  const vault = new MemoryVault(makeFiles(options));
  let generatedId = 0;
  const opened = await WorkspaceSession.open(
    new VaultRepository(vault, () => `unexpected-generated-page-id-${++generatedId}`),
    { delayMs: 60_000 },
  );
  if (!opened.ok) throw new Error(opened.error);
  const session = opened.value;
  setSession(session);
  sessions.add(session);
  return { session, vault };
}

interface PageEditorHarness {
  readonly container: HTMLElement;
  readonly editors: Map<number, Editor>;
  render(options?: { editable?: boolean; sourceRoot?: boolean }): Promise<void>;
  unmount(): Promise<void>;
}

function mountPageEditor(session: WorkspaceSession): PageEditorHarness {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const editors = new Map<number, Editor>();
  let current = { editable: true, sourceRoot: false };
  let disposed = false;

  const render = async (options: { editable?: boolean; sourceRoot?: boolean } = {}): Promise<void> => {
    current = { ...current, ...options };
    await act(async () => {
      const children = [];
      const source = session.getState().pages[SOURCE_ID];
      if (current.sourceRoot && source) {
        children.push(
          createElement(ProviderDatabaseView, {
            key: 'source-provider-root',
            page: source,
            editable: current.editable,
          }),
        );
      }
      children.push(
        createElement(PageEditor, {
          key: 'linked-view-page-editor',
          pageId: NOTE_ID,
          doc: session.getState().docs[NOTE_ID]!,
          editable: current.editable,
          find: null,
          onExitTop: () => {},
          onDirty: () => {},
          onReady: (editor: Editor) => editors.set(0, editor),
        }),
      );
      root.render(createElement(Fragment, null, ...children));
    });
  };

  const unmount = async (): Promise<void> => {
    if (disposed) return;
    await act(async () => root.unmount());
    container.remove();
    disposed = true;
  };

  const harness: PageEditorHarness = { container, editors, render, unmount };
  harnesses.add(harness);
  return harness;
}

function editorOf(harness: PageEditorHarness): Editor {
  const editor = harness.editors.get(0);
  if (!editor || editor.isDestroyed) throw new Error('The real PageEditor did not mount.');
  return editor;
}

interface MountRecord {
  readonly context: DatabaseProviderContext;
  readonly button: HTMLButtonElement;
  readonly cleanup: Mock<() => void>;
}

interface ProviderHarness {
  readonly records: MountRecord[];
  readonly routedKeys: Array<{
    readonly viewId: string;
    readonly status: string;
    readonly defaultPrevented: boolean;
  }>;
  unregister(): void;
}

function registerTestProvider(
  session: WorkspaceSession,
  options: {
    readonly onMount?: (context: DatabaseProviderContext, record: MountRecord) => void | (() => void);
    readonly routeUndo?: boolean;
  } = {},
): ProviderHarness {
  let ownerActive = true;
  let removeProvider = () => {};
  let removeDataScope = () => {};
  let unregistered = false;
  const records: MountRecord[] = [];
  const routedKeys: ProviderHarness['routedKeys'] = [];
  const data = createDataApi({
    session,
    ownerIsActive: () => ownerActive,
    isProviderActive: () => ownerActive,
    isHostReadonly: () => false,
    registerCleanup: (cleanup) => {
      removeDataScope = cleanup;
    },
  });

  removeProvider = registerDatabaseProvider('independent-linked-view-provider', () => ownerActive, data, {
    id: 'polaris-dados',
    apiVersion: 1,
    mount: (context) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.testViewId = context.view?.snapshot().viewId ?? 'source-root';
      button.textContent = button.dataset.testViewId;
      context.element.append(button);
      const cleanup = vi.fn(() => {
        context.element.removeEventListener('keydown', onKeyDown);
        button.remove();
      });
      const record: MountRecord = { context, button, cleanup };
      records.push(record);
      const onKeyDown = (event: KeyboardEvent) => {
        if (
          !options.routeUndo ||
          !context.view ||
          event.key.toLowerCase() !== 'z' ||
          !(event.ctrlKey || event.metaKey)
        )
          return;
        const snapshot = context.view.snapshot();
        const result =
          snapshot.status === 'ready'
            ? context.view.history({
                direction: event.shiftKey ? 'redo' : 'undo',
                expectedRevision: snapshot.revision,
              })
            : { status: 'error' as const };
        event.preventDefault();
        routedKeys.push({
          viewId: context.view.snapshot().viewId,
          status: result.status,
          defaultPrevented: event.defaultPrevented,
        });
      };
      context.element.addEventListener('keydown', onKeyDown);
      const customCleanup = options.onMount?.(context, record);
      return customCleanup ?? cleanup;
    },
  });

  return {
    records,
    routedKeys,
    unregister() {
      if (unregistered) return;
      unregistered = true;
      ownerActive = false;
      removeProvider();
      removeDataScope();
    },
  };
}

function linkedRecords(provider: ProviderHarness): MountRecord[] {
  return provider.records.filter((record) => record.context.view !== undefined);
}

function viewApi(record: MountRecord): LinkedViewApi {
  const view = record.context.view;
  if (!view) throw new Error('Expected the linked-view API on a linked NodeView mount.');
  return view;
}

function readyData(snapshot: DataApiSnapshot) {
  if (snapshot.status !== 'ready') throw new Error(`Expected ready database data, got ${snapshot.status}.`);
  return snapshot;
}

function renameSourcePathExternally(vault: MemoryVault): void {
  const source = vault.text(SOURCE_PATH);
  const row = vault.text(ROW_PATH);
  if (!source || !row) throw new Error('The synthetic source database fixture is incomplete.');
  vault.external({
    [SOURCE_PATH]: null,
    [ROW_PATH]: null,
    'Renamed Inventory.md': source,
    'Renamed Inventory/Widget.md': row,
  });
}

function viewPosition(editor: Editor, viewId: string): { from: number; to: number } {
  let result: { from: number; to: number } | null = null;
  editor.state.doc.descendants((node, from) => {
    if (node.type.name === 'polarisDadosView' && node.attrs.viewId === viewId) {
      result = { from, to: from + node.nodeSize };
      return false;
    }
    return true;
  });
  if (!result) throw new Error(`No linked view with id ${viewId} was found in PageEditor.`);
  return result;
}

const sessions = new Set<WorkspaceSession>();
const harnesses = new Set<PageEditorHarness>();
const providers = new Set<ProviderHarness>();
let preferencesBeforeTest = getPreferences();

beforeEach(() => {
  preferencesBeforeTest = getPreferences();
  setPreferences({ locale: 'en', readingMode: false });
});

afterEach(async () => {
  for (const harness of [...harnesses]) {
    await harness.unmount();
    harnesses.delete(harness);
  }
  // PageEditor tears its Tiptap instance down on the next task after React removes its menus.
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const provider of [...providers]) {
    provider.unregister();
    providers.delete(provider);
  }
  for (const session of [...sessions]) {
    if (!session.isClosed) await session.close();
    sessions.delete(session);
  }
  setPreferences({ locale: preferencesBeforeTest.locale, readingMode: preferencesBeforeTest.readingMode });
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('independent linked-view provider host lifecycle', () => {
  it('mounts source plus two real linked NodeViews with shared data/history and local config', async () => {
    const { session, vault } = await openWorkspace();
    const writes = vi.spyOn(vault, 'apply');
    const harness = mountPageEditor(session);
    const provider = registerTestProvider(session, { routeUndo: true });
    providers.add(provider);

    await harness.render({ sourceRoot: true });

    const sourceRoots = provider.records.filter((record) => !record.context.view);
    const linked = linkedRecords(provider);
    expect(sourceRoots).toHaveLength(1);
    expect(linked).toHaveLength(2);
    expect(linked.map((record) => viewApi(record).snapshot())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'ready', viewId: 'view-one', sourceDatabaseId: SOURCE_ID }),
        expect.objectContaining({ status: 'ready', viewId: 'view-two', sourceDatabaseId: SOURCE_ID }),
      ]),
    );
    expect(
      linked.map((record) => readyData(record.context.data.snapshot(SOURCE_ID)).rows.map((row) => row.id)),
    ).toEqual([[ROW_ID], [ROW_ID]]);
    expect(readyData(sourceRoots[0]!.context.data.snapshot(SOURCE_ID)).rows.map((row) => row.id)).toEqual([
      ROW_ID,
    ]);
    expect(writes).not.toHaveBeenCalled();

    const sourceSnapshot = readyData(sourceRoots[0]!.context.data.snapshot(SOURCE_ID));
    const subscribed: DataApiSnapshot[] = [];
    const unsubscribe = linked[1]!.context.data.subscribe(SOURCE_ID, (snapshot) => subscribed.push(snapshot));
    subscribed.length = 0;
    const stagedCell = linked[0]!.context.data.patchCell({
      databaseId: SOURCE_ID,
      rowId: ROW_ID,
      propertyId: 'quantity',
      value: 7,
      expectedRevision: sourceSnapshot.revision,
    });
    expect(stagedCell.status).toBe('staged');
    expect(readyData(sourceRoots[0]!.context.data.snapshot(SOURCE_ID)).rows[0]?.properties.quantity).toBe(7);
    expect(readyData(linked[1]!.context.data.snapshot(SOURCE_ID)).rows[0]?.properties.quantity).toBe(7);
    expect(subscribed.length).toBeGreaterThan(0);

    const afterCell = readyData(linked[1]!.context.data.snapshot(SOURCE_ID));
    expect(
      linked[1]!.context.data.history({
        databaseId: SOURCE_ID,
        direction: 'undo',
        expectedRevision: afterCell.revision,
      }).status,
    ).toBe('staged');
    const afterUndo = readyData(sourceRoots[0]!.context.data.snapshot(SOURCE_ID));
    expect(afterUndo.rows[0]?.properties.quantity).toBe(2);
    expect(
      sourceRoots[0]!.context.data.history({
        databaseId: SOURCE_ID,
        direction: 'redo',
        expectedRevision: afterUndo.revision,
      }).status,
    ).toBe('staged');
    expect(readyData(linked[0]!.context.data.snapshot(SOURCE_ID)).rows[0]?.properties.quantity).toBe(7);

    const firstApi = viewApi(linked.find((record) => viewApi(record).snapshot().viewId === 'view-one')!);
    const secondApi = viewApi(linked.find((record) => viewApi(record).snapshot().viewId === 'view-two')!);
    const firstBefore = firstApi.snapshot();
    const secondBefore = secondApi.snapshot();
    if (firstBefore.status !== 'ready' || secondBefore.status !== 'ready')
      throw new Error('Linked roots should be ready.');
    const firstButton = linked.find((record) => viewApi(record).snapshot().viewId === 'view-one')!.button;
    const stableContexts = [...provider.records];
    firstButton.focus();
    expect(document.activeElement).toBe(firstButton);

    expect(
      firstApi.patchConfig({
        patch: { title: 'Renamed only in the first view' },
        expectedRevision: firstBefore.revision,
      }).status,
    ).toBe('staged');
    const firstAfter = firstApi.snapshot();
    const secondAfter = secondApi.snapshot();
    expect(firstAfter).toMatchObject({
      status: 'ready',
      config: { title: 'Renamed only in the first view' },
    });
    expect(secondAfter).toMatchObject({
      status: 'ready',
      config: { title: 'Secondary view', columnOrder: ['price'] },
    });
    expect(provider.records).toEqual(stableContexts);
    expect(document.activeElement).toBe(firstButton);

    let dataFlush: Awaited<ReturnType<DataApi['flush']>> | undefined;
    let viewFlush: Awaited<ReturnType<LinkedViewApi['flush']>> | undefined;
    await act(async () => {
      dataFlush = await linked[0]!.context.data.flush(SOURCE_ID);
      viewFlush = await firstApi.flush();
    });
    expect(dataFlush).toMatchObject({ status: 'persisted', databaseId: SOURCE_ID });
    expect(viewFlush).toMatchObject({ status: 'persisted', pageId: NOTE_ID, viewId: 'view-one' });
    expect(vault.text(ROW_PATH)).toContain('Quantity: 7');
    expect(vault.text(NOTE_PATH)).not.toBe(makeFiles()[NOTE_PATH]);
    expect(writes).toHaveBeenCalled();

    const secondButton = linked.find((record) => viewApi(record).snapshot().viewId === 'view-two')!.button;
    secondButton.focus();
    expect(document.activeElement).toBe(secondButton);
    undoRedo('undo');
    expect(provider.routedKeys).toEqual([{ viewId: 'view-two', status: 'no-op', defaultPrevented: true }]);
    unsubscribe();
  });

  it('keeps unmount, rename, host/source loss, and restored generations isolated by root', async () => {
    const { session, vault } = await openWorkspace();
    const harness = mountPageEditor(session);
    const provider = registerTestProvider(session);
    providers.add(provider);
    await harness.render();
    const initial = linkedRecords(provider);
    expect(initial).toHaveLength(2);
    const first = initial.find((record) => viewApi(record).snapshot().viewId === 'view-one')!;
    const second = initial.find((record) => viewApi(record).snapshot().viewId === 'view-two')!;

    await act(async () => {
      const position = viewPosition(editorOf(harness), 'view-one');
      editorOf(harness).commands.deleteRange(position);
    });
    expect(first.context.signal.aborted).toBe(true);
    expect(first.cleanup).toHaveBeenCalledOnce();
    expect(second.context.signal.aborted).toBe(false);
    expect(second.context.data.snapshot(SOURCE_ID).status).toBe('ready');

    await act(async () => {
      renameSourcePathExternally(vault);
    });
    expect(session.pathOf(SOURCE_ID)).toBe('Renamed Inventory.md');
    expect(session.pathOf(ROW_ID)).toBe('Renamed Inventory/Widget.md');
    expect(session.getState().pages[SOURCE_ID]?.id).toBe(SOURCE_ID);
    expect(session.getState().pages[ROW_ID]?.parentId).toBe(SOURCE_ID);
    expect(provider.records).toHaveLength(2);
    expect(second.context.signal.aborted).toBe(false);
    expect(viewApi(second).snapshot()).toMatchObject({ status: 'ready', sourceDatabaseId: SOURCE_ID });

    await act(async () => {
      expect(session.execute({ type: 'page.trash', id: NOTE_ID, now: 11 }).ok).toBe(true);
    });
    expect(second.context.signal.aborted).toBe(true);
    expectInertFallbacks(harness, 1);

    await act(async () => {
      expect(session.execute({ type: 'page.restore', id: NOTE_ID }).ok).toBe(true);
    });
    const restoredHost = linkedRecords(provider).find((record) => !record.context.signal.aborted);
    expect(restoredHost).toBeDefined();
    expect(restoredHost).not.toBe(second);
    expect(provider.records).toHaveLength(3);

    await act(async () => {
      const source = session.getState().pages[SOURCE_ID]!;
      expect(
        session.applyExternal({
          pages: [{ ...source, trashedAt: 12 }],
          docs: {},
          removed: [],
          unreadable: [],
          readable: [],
        }),
      ).toContain(SOURCE_ID);
    });
    expect(restoredHost!.context.signal.aborted).toBe(true);
    expectInertFallbacks(harness, 1);

    await act(async () => {
      const source = session.getState().pages[SOURCE_ID]!;
      expect(
        session.applyExternal({
          pages: [{ ...source, trashedAt: null }],
          docs: {},
          removed: [],
          unreadable: [],
          readable: [],
        }),
      ).toContain(SOURCE_ID);
    });
    const restoredSource = linkedRecords(provider).find((record) => !record.context.signal.aborted);
    expect(restoredSource).toBeDefined();
    expect(restoredSource).not.toBe(restoredHost);
    expect(provider.records).toHaveLength(4);
  });

  it('keeps compatible roots mounted but read only for PageEditor and reading-mode restrictions', async () => {
    const { session, vault } = await openWorkspace();
    const writes = vi.spyOn(vault, 'apply');
    const harness = mountPageEditor(session);
    const provider = registerTestProvider(session);
    providers.add(provider);
    await harness.render();
    const initial = linkedRecords(provider);
    expect(initial).toHaveLength(2);
    const originalRevision = readyData(initial[0]!.context.data.snapshot(SOURCE_ID)).revision;

    await act(async () => setPreferences({ readingMode: true }));
    const readingRoots = linkedRecords(provider).filter((record) => !record.context.signal.aborted);
    expect(readingRoots).toHaveLength(2);
    expect(initial.every((record) => record.context.signal.aborted)).toBe(true);
    expect(readingRoots.every((record) => record.context.editable === false)).toBe(true);
    expect(readingRoots.map((record) => viewApi(record).snapshot())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'ready', readonly: true }),
        expect.objectContaining({ status: 'ready', readonly: true }),
      ]),
    );
    const readonlyData = readyData(readingRoots[0]!.context.data.snapshot(SOURCE_ID));
    expect(readonlyData.readonly).toBe(true);
    expect(
      readingRoots[0]!.context.data.patchCell({
        databaseId: SOURCE_ID,
        rowId: ROW_ID,
        propertyId: 'quantity',
        value: 99,
        expectedRevision: originalRevision,
      }),
    ).toMatchObject({ status: 'error', code: 'host-readonly' });
    const readonlyView = viewApi(readingRoots[0]!);
    const readonlySnapshot = readonlyView.snapshot();
    if (readonlySnapshot.status !== 'ready') throw new Error('The compatible linked view must remain ready.');
    expect(
      readonlyView.patchConfig({
        patch: { title: 'must not be staged' },
        expectedRevision: readonlySnapshot.revision,
      }),
    ).toMatchObject({ status: 'error', code: 'read-only' });
    expect(writes).not.toHaveBeenCalled();

    await act(async () => setPreferences({ readingMode: false, locale: 'pt' }));
    const localeRoots = linkedRecords(provider).filter((record) => !record.context.signal.aborted);
    expect(localeRoots).toHaveLength(2);
    expect(localeRoots.every((record) => record.context.locale === 'pt' && record.context.editable)).toBe(
      true,
    );
    expect(localeRoots.every((record) => viewApi(record).snapshot().status === 'ready')).toBe(true);

    await harness.render({ editable: false });
    const propReadonlyRoots = linkedRecords(provider).filter((record) => !record.context.signal.aborted);
    expect(propReadonlyRoots).toHaveLength(2);
    expect(propReadonlyRoots.every((record) => record.context.editable === false)).toBe(true);
    expect(readyData(propReadonlyRoots[0]!.context.data.snapshot(SOURCE_ID)).readonly).toBe(true);
    expect(writes).not.toHaveBeenCalled();
    expect(
      readyData(propReadonlyRoots[0]!.context.data.snapshot(SOURCE_ID)).rows[0]?.properties.quantity,
    ).toBe(2);
  });

  it('uses inert fallback for missing, unsupported, absent, or throwing providers and recovers on registration', async () => {
    const missing = await openWorkspace({ source: 'missing' });
    const missingHarness = mountPageEditor(missing.session);
    const missingProvider = registerTestProvider(missing.session);
    providers.add(missingProvider);
    await missingHarness.render();
    expect(linkedRecords(missingProvider)).toHaveLength(0);
    expect(missingHarness.container.querySelectorAll('.polaris-dados-view-fallback')).toHaveLength(2);

    await missingHarness.unmount();
    await missing.session.close();
    sessions.delete(missing.session);
    providers.delete(missingProvider);
    missingProvider.unregister();

    const unsupported = await openWorkspace({ source: 'unsupported' });
    const unsupportedHarness = mountPageEditor(unsupported.session);
    const unsupportedProvider = registerTestProvider(unsupported.session);
    providers.add(unsupportedProvider);
    await unsupportedHarness.render();
    expect(linkedRecords(unsupportedProvider)).toHaveLength(0);
    expect(unsupportedHarness.container.querySelectorAll('.polaris-dados-view-fallback')).toHaveLength(2);
    await unsupportedHarness.unmount();
    await unsupported.session.close();
    sessions.delete(unsupported.session);
    providers.delete(unsupportedProvider);
    unsupportedProvider.unregister();

    const { session } = await openWorkspace();
    const harness = mountPageEditor(session);
    await harness.render();
    expect(harness.container.querySelectorAll('.polaris-dados-view-fallback')).toHaveLength(2);
    let throwingProvider!: ProviderHarness;
    await act(async () => {
      throwingProvider = registerTestProvider(session, {
        onMount: () => {
          throw new Error('synthetic provider startup failure');
        },
      });
      providers.add(throwingProvider);
    });
    expect(linkedRecords(throwingProvider)).toHaveLength(2);
    expect(linkedRecords(throwingProvider).every((record) => record.context.signal.aborted)).toBe(true);
    expect(harness.container.querySelectorAll('.polaris-dados-view-fallback')).toHaveLength(2);
    await act(async () => throwingProvider.unregister());

    let restoredProvider!: ProviderHarness;
    await act(async () => {
      restoredProvider = registerTestProvider(session);
      providers.add(restoredProvider);
    });
    expect(linkedRecords(restoredProvider)).toHaveLength(2);
    expect(linkedRecords(restoredProvider).every((record) => !record.context.signal.aborted)).toBe(true);
    expect(throwingProvider.records.every((record) => record.context.signal.aborted)).toBe(true);

    const beforeDisable = linkedRecords(restoredProvider);
    await act(async () => restoredProvider.unregister());
    expect(beforeDisable.every((record) => record.context.signal.aborted)).toBe(true);
    expectInertFallbacks(harness, 2);

    let reloadedProvider!: ProviderHarness;
    await act(async () => {
      reloadedProvider = registerTestProvider(session);
      providers.add(reloadedProvider);
    });
    const afterReload = linkedRecords(reloadedProvider);
    expect(afterReload).toHaveLength(2);
    expect(afterReload.every((record) => !record.context.signal.aborted)).toBe(true);
    expect(
      afterReload.every((record) => !beforeDisable.some((old) => old.context.view === record.context.view)),
    ).toBe(true);
  });

  it('runs the returned cleanup when provider ownership unregisters reentrantly during mount', async () => {
    const { session } = await openWorkspace();
    const harness = mountPageEditor(session);
    const holder: { provider?: ProviderHarness } = {};
    const provider = registerTestProvider(session, {
      onMount: (_context, record) => {
        holder.provider?.unregister();
        return () => record.cleanup();
      },
    });
    holder.provider = provider;
    providers.add(provider);
    await harness.render();

    const linked = linkedRecords(provider);
    expect(linked.length).toBeGreaterThan(0);
    expect(linked.every((record) => record.context.signal.aborted)).toBe(true);
    expect(linked.every((record) => record.cleanup.mock.calls.length === 1)).toBe(true);
    expect(harness.container.querySelectorAll('.polaris-dados-view-fallback')).toHaveLength(2);
  });
});

function expectInertFallbacks(harness: PageEditorHarness, count: number): void {
  const fallbacks = [...harness.container.querySelectorAll<HTMLElement>('.polaris-dados-view-fallback')];
  expect(fallbacks).toHaveLength(count);
  for (const fallback of fallbacks) {
    expect(fallback.textContent?.trim().length).toBeGreaterThan(0);
    expect(fallback.querySelector('button, input, select, table')).toBeNull();
  }
}
