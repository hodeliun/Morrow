// @vitest-environment happy-dom
import { Window } from 'happy-dom';
import type { Editor } from '@tiptap/core';
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DataApi,
  DataApiFlushResult,
  DataApiHistoryResult,
  DataApiPatchResult,
  DataApiSnapshot,
} from '../../../../src/app/plugins/dataApi';
import { createDataApi } from '../../../../src/app/plugins/dataApi';
import type { DatabaseProviderContext } from '../../../../src/app/plugins/providerApi';
import type { ProviderTransientState } from '../../../../src/app/plugins/providerApi';
import { createProviderMountState } from '../../../../src/app/plugins/providerMountState';
import type { ProviderMountState } from '../../../../src/app/plugins/providerMountState';
import { createProviderDataScope } from '../../../../src/app/plugins/providerDataScope';
import { setSession } from '../../../../src/app/workspace';
import type { DocNode, PageId } from '../../../../src/core/model';
import { encodePolarisDadosViewMarker } from '../../../../src/core/polarisDadosView';
import type { PolarisDadosViewData } from '../../../../src/core/polarisDadosView';
import type { VaultOp, VaultOpResult } from '../../../../src/core/vault/plan';
import { MemoryVault } from '../../../../src/storage/memoryVault';
import { WorkspaceSession } from '../../../../src/storage/session';
import { VaultRepository } from '../../../../src/storage/vaultRepository';
import { createLinkedViewApi } from '../../../../src/app/plugins/linkedViewApi';
import type { LinkedViewApi } from '../../../../src/app/plugins/linkedViewApi';
import { registerDatabaseProvider } from '../../../../src/app/plugins/providerRegistry';
import { PageEditor } from '../../../../src/app/editor/PageEditor';
import { ProviderDatabaseView } from '../../../../src/app/components/database/ProviderDatabaseView';
import { PaneContext, startTabs } from '../../../../src/app/tabs';
import { getPreferences, setPreferences } from '../../../../src/app/platform/preferences';
import { mountPolarisDados } from './mount';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const DATABASE_ID = 'text-source';
const ROW_ID = 'text-widget';
const NOTE_ID = 'text-views';
const VIEW_ONE = 'text-view-one';
const VIEW_TWO = 'text-view-two';
const DATABASE_PATH = 'Inventory.md';
const ROW_PATH = 'Inventory/Widget.md';
const NOTE_PATH = 'Views.md';
const INITIAL_MESSAGE = '  opening 🌿\r\nsecond line\nlast  ';

const DATABASE = [
  '---',
  'kind: database',
  'polarisDados:',
  '  version: 1',
  '  provider: polaris-dados',
  'database:',
  '  properties:',
  '    - id: message',
  '      name: Message',
  '      type: text',
  '    - id: empty',
  '      name: Empty',
  '      type: text',
  '    - id: nullable',
  '      name: Nullable',
  '      type: text',
  '    - id: optional',
  '      name: Optional',
  '      type: text',
  '    - id: quantity',
  '      name: Quantity',
  '      type: number',
  '    - id: price',
  '      name: Price',
  '      type: number',
  '    - id: total',
  '      name: Total',
  '      type: formula',
  '      formula: Quantity * Price',
  '  views:',
  '    - id: table',
  '      name: Table',
  '      type: table',
  '---',
  '# Inventory',
  '',
].join('\n');

const ROW = [
  '---',
  'Message: "  opening 🌿\\r\\nsecond line\\nlast  "',
  "Empty: ''",
  'Nullable: null',
  'Quantity: 2',
  'Price: 10',
  '---',
  'Synthetic widget row.',
  '',
].join('\n');

const views: readonly [PolarisDadosViewData, PolarisDadosViewData] = [
  {
    version: 1,
    viewId: VIEW_ONE,
    sourceDatabaseId: DATABASE_ID,
    title: 'First linked view',
    columnOrder: ['message'],
    filter: null,
  },
  {
    version: 1,
    viewId: VIEW_TWO,
    sourceDatabaseId: DATABASE_ID,
    title: 'Second linked view',
    columnOrder: ['quantity'],
    filter: null,
  },
];

function markdownForViews(): string {
  return [
    '# Text linked views',
    '',
    encodePolarisDadosViewMarker(views[0]),
    '',
    'Between linked views.',
    '',
    encodePolarisDadosViewMarker(views[1]),
    '',
  ].join('\n');
}

class CountingMemoryVault extends MemoryVault {
  applyCount = 0;
  failNextApply: string | null = null;

  override async apply(ops: VaultOp[]): Promise<VaultOpResult[]> {
    this.applyCount += 1;
    if (this.failNextApply !== null) {
      const message = this.failNextApply;
      this.failNextApply = null;
      return [{ ok: false, code: 'error', message }];
    }
    return super.apply(ops);
  }
}

interface Fixture {
  readonly vault: CountingMemoryVault;
  readonly session: WorkspaceSession;
  data: DataApi;
  readonly cleanups: Set<() => void>;
  textPatchCalls: number;
  editable: boolean;
  databaseMissing: boolean;
  ownerActive: boolean;
  close(): Promise<void>;
}

interface MountedRoot {
  readonly window: Window;
  readonly element: HTMLElement;
  readonly transientState?: ProviderTransientState;
  readonly viewApi?: LinkedViewApi;
  refreshDataSnapshot(): void;
  unmount(): void;
}

interface LiveReactHarness {
  readonly container: HTMLElement;
  readonly editor: Editor | null;
  render(): Promise<void>;
  unmount(): Promise<void>;
}

interface ViewHandle {
  readonly api: LinkedViewApi;
  release(): void;
}

const fixtures = new Set<Fixture>();
const windows: Window[] = [];
const mountedRoots = new Set<MountedRoot>();
const liveReactHarnesses = new Set<LiveReactHarness>();
const providerUnregisters = new Set<() => void>();
const stopTabListeners = new Set<() => void>();
const transientMountStates = new Set<ProviderMountState>();
let fixtureSequence = 0;
let generatedPageSequence = 0;
let preferencesBeforeTest = getPreferences();

function fixtureFiles(): Record<string, string> {
  return {
    [DATABASE_PATH]: DATABASE,
    [ROW_PATH]: ROW,
    [NOTE_PATH]: markdownForViews(),
    '.morrow/workspace.json': JSON.stringify({
      version: 1,
      pages: {
        [DATABASE_PATH]: { id: DATABASE_ID, created: 1, order: 0 },
        [ROW_PATH]: { id: ROW_ID, created: 2, order: 0 },
        [NOTE_PATH]: { id: NOTE_ID, created: 3, order: 1 },
      },
    }),
    '.morrow/recent.json': JSON.stringify({ version: 1, opened: {}, activity: {} }),
  };
}

async function openFixture(vault = new CountingMemoryVault(fixtureFiles())): Promise<Fixture> {
  const id = ++fixtureSequence;
  const opened = await WorkspaceSession.open(
    new VaultRepository(vault, () => 'unexpected-text-page-' + id + '-' + ++generatedPageSequence),
    { delayMs: 60_000 },
  );
  if (!opened.ok) throw new Error(opened.error);
  const session = opened.value;
  setSession(session);
  const fixture: Fixture = {
    vault,
    session,
    data: null as unknown as DataApi,
    cleanups: new Set(),
    textPatchCalls: 0,
    editable: true,
    databaseMissing: false,
    ownerActive: true,
    async close() {
      fixture.ownerActive = false;
      for (const cleanup of [...fixture.cleanups]) cleanup();
      fixture.cleanups.clear();
      if (!session.isClosed) await session.close();
    },
  };
  fixture.data = createDataApi({
    session,
    ownerIsActive: () => fixture.ownerActive,
    isProviderActive: (databaseId) => fixture.ownerActive && databaseId === DATABASE_ID,
    isHostReadonly: () => session.isMutationFenced,
    registerCleanup: (cleanup) => fixture.cleanups.add(cleanup),
  });
  fixtures.add(fixture);
  return fixture;
}

function makeViewHandle(fixture: Fixture, viewId: string, active: () => boolean): ViewHandle {
  const generation = Symbol(viewId);
  let cleanup = () => {};
  const api = createLinkedViewApi({
    session: fixture.session,
    pageId: NOTE_ID as PageId,
    viewId,
    sourceDatabaseId: DATABASE_ID as PageId,
    mountGeneration: generation,
    ownerIsActive: active,
    isMountGenerationActive: (candidate) => candidate === generation && active(),
    isHostReadonly: () => false,
    registerCleanup: (release) => {
      cleanup = release;
    },
  });
  return { api, release: () => cleanup() };
}

function mountRoot(
  fixture: Fixture,
  options: {
    readonly viewId?: string;
    readonly locale?: DatabaseProviderContext['locale'];
    readonly editable?: boolean;
    readonly mountState?: ProviderMountState;
    readonly snapshotTransform?: (snapshot: DataApiSnapshot) => DataApiSnapshot;
  } = {},
): MountedRoot {
  const window = new Window({ url: 'http://morrow.test/' });
  windows.push(window);
  const node = window.document.createElement('div');
  window.document.body.append(node);
  const element = node as unknown as HTMLElement;
  const controller = new AbortController();
  const scope = createProviderDataScope(fixture.data, DATABASE_ID as PageId, {
    isActive: () => !controller.signal.aborted,
    editable: () => fixture.editable,
  });
  const listeners = new Set<(snapshot: DataApiSnapshot) => void>();
  const formatSnapshot = (snapshot: DataApiSnapshot): DataApiSnapshot => {
    const available = !fixture.databaseMissing
      ? snapshot
      : {
          version: 1 as const,
          status: 'missing' as const,
          databaseId: DATABASE_ID,
          revision: snapshot.revision,
        };
    return options.snapshotTransform?.(available) ?? available;
  };
  const scopedData: DataApi = {
    ...scope.api,
    snapshot(databaseId) {
      return formatSnapshot(scope.api.snapshot(databaseId));
    },
    ...(scope.api.patchTextCell
      ? {
          patchTextCell(input) {
            fixture.textPatchCalls += 1;
            return scope.api.patchTextCell!(input);
          },
        }
      : {}),
    subscribe(databaseId, listener) {
      listeners.add(listener);
      let stopped = false;
      const unsubscribe = scope.api.subscribe(databaseId, (snapshot) => listener(formatSnapshot(snapshot)));
      return () => {
        if (stopped) return;
        stopped = true;
        listeners.delete(listener);
        unsubscribe();
      };
    },
    async flush(databaseId) {
      return scope.api.flush(databaseId);
    },
  };
  const view = options.viewId
    ? makeViewHandle(fixture, options.viewId, () => !controller.signal.aborted)
    : undefined;
  const transientState = options.mountState?.bind(
    {
      session: fixture.session,
      sessionGeneration: 1,
      owner: 'text-cell-test-owner',
      providerId: 'polaris-dados',
      surface: options.viewId ? [NOTE_ID, options.viewId, DATABASE_ID] : [DATABASE_ID],
    },
    controller.signal,
    () => !controller.signal.aborted && !fixture.session.isClosed && fixture.ownerActive,
  );
  const context: DatabaseProviderContext = {
    element,
    databaseId: DATABASE_ID as PageId,
    data: scopedData,
    locale: options.locale ?? 'en',
    editable: options.editable ?? true,
    signal: controller.signal,
    ...(transientState ? { transientState } : {}),
    ...(view ? { view: view.api } : {}),
  };
  const cleanup = mountPolarisDados(context);
  const root: MountedRoot = {
    window,
    element,
    ...(transientState ? { transientState } : {}),
    ...(view ? { viewApi: view.api } : {}),
    refreshDataSnapshot() {
      const snapshot = formatSnapshot(scope.api.snapshot(DATABASE_ID as PageId));
      for (const listener of [...listeners]) listener(snapshot);
    },
    unmount() {
      if (!controller.signal.aborted) controller.abort();
      cleanup();
      scope.dispose();
      view?.release();
      element.remove();
      mountedRoots.delete(root);
    },
  };
  mountedRoots.add(root);
  return root;
}

function mountLiveReactPage(fixture: Fixture): LiveReactHarness {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let editor: Editor | null = null;
  let disposed = false;
  const render = async () => {
    await act(async () => {
      root.render(
        createElement(
          PaneContext.Provider,
          { value: 'main' },
          createElement(
            Fragment,
            null,
            createElement(ProviderDatabaseView, {
              key: 'text-source-provider',
              page: fixture.session.getState().pages[DATABASE_ID as PageId]!,
              editable: true,
            }),
            createElement(PageEditor, {
              key: 'text-linked-view-editor',
              pageId: NOTE_ID as PageId,
              doc: fixture.session.getState().docs[NOTE_ID as PageId] as DocNode,
              editable: true,
              find: null,
              onExitTop: () => {},
              onDirty: () => {},
              onReady: (readyEditor: Editor) => {
                editor = readyEditor;
              },
            }),
          ),
        ),
      );
    });
  };
  const unmount = async () => {
    if (disposed) return;
    await act(async () => root.unmount());
    container.remove();
    disposed = true;
    liveReactHarnesses.delete(harness);
  };
  const harness: LiveReactHarness = {
    container,
    get editor() {
      return editor;
    },
    render,
    unmount,
  };
  liveReactHarnesses.add(harness);
  return harness;
}

function registerLiveProvider(fixture: Fixture, contexts: DatabaseProviderContext[]): () => void {
  const unregister = registerDatabaseProvider(
    'polaris-dados-text-cell-host-test',
    () => fixture.ownerActive,
    fixture.data,
    {
      id: 'polaris-dados',
      apiVersion: 1,
      mount(context) {
        contexts.push(context);
        return mountPolarisDados(context);
      },
    },
  );
  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    unregister();
    providerUnregisters.delete(cleanup);
  };
  providerUnregisters.add(cleanup);
  return cleanup;
}

function cell(root: HTMLElement, propertyId: string): HTMLTableCellElement {
  const result = root.querySelector<HTMLTableCellElement>(
    'tr[data-row-id="' + ROW_ID + '"] td[data-field="' + propertyId + '"]',
  );
  if (!result) throw new Error('Missing ' + propertyId + ' cell.');
  return result;
}

function fieldValue(
  root: HTMLElement,
  propertyId: string,
): { kind: string | undefined; text: string | null } {
  const output = cell(root, propertyId).querySelector<HTMLElement>('[data-value-kind]');
  if (!output) throw new Error('Missing rendered value for ' + propertyId + '.');
  return { kind: output.dataset.valueKind, text: output.textContent };
}

function rowProperties(fixture: Fixture) {
  const snapshot = fixture.data.snapshot(DATABASE_ID as PageId);
  if (snapshot.status !== 'ready') throw new Error('Text database was not ready.');
  const row = snapshot.rows.find((candidate) => candidate.id === ROW_ID);
  if (!row) throw new Error('Text row was not present.');
  return row.properties;
}

function editButton(root: HTMLElement, propertyId: string): HTMLButtonElement {
  const button = root.querySelector<HTMLButtonElement>(
    'button[data-action="edit"][data-row-id="' + ROW_ID + '"][data-field="' + propertyId + '"]',
  );
  if (!button) throw new Error('Missing Edit button for ' + propertyId + '.');
  return button;
}

function openEditor(root: HTMLElement, propertyId: string): HTMLTextAreaElement | HTMLInputElement {
  editButton(root, propertyId).click();
  const editor = root.querySelector<HTMLTextAreaElement | HTMLInputElement>(
    'textarea[data-field="' + propertyId + '"], input[data-field="' + propertyId + '"]',
  );
  if (!editor) throw new Error('Missing editor for ' + propertyId + '.');
  return editor;
}

function dispatchInput(root: MountedRoot, control: HTMLTextAreaElement | HTMLInputElement): void {
  control.dispatchEvent(new root.window.Event('input', { bubbles: true }) as unknown as Event);
}

function saveButton(root: HTMLElement): HTMLButtonElement {
  const button = root.querySelector<HTMLButtonElement>('button[data-action="save"]');
  if (!button) throw new Error('Missing Save button.');
  return button;
}

function cancelButton(root: HTMLElement): HTMLButtonElement {
  const button = root.querySelector<HTMLButtonElement>('button[data-action="cancel"]');
  if (!button) throw new Error('Missing Cancel button.');
  return button;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function until(description: string, predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error('Timed out waiting for ' + description + '.');
}

function activeLiveProviderRoots(contexts: readonly DatabaseProviderContext[]): {
  readonly source: HTMLElement;
  readonly firstView: HTMLElement;
  readonly secondView: HTMLElement;
} | null {
  const active = contexts.filter((context) => !context.signal.aborted);
  const source = active.find((context) => !context.view)?.element;
  const views = new Map<string, HTMLElement>();
  for (const context of active) {
    if (!context.view) continue;
    const snapshot = context.view.snapshot();
    if (snapshot.status === 'ready') views.set(snapshot.viewId, context.element);
  }
  const firstView = views.get(VIEW_ONE);
  const secondView = views.get(VIEW_TWO);
  return source && firstView && secondView ? { source, firstView, secondView } : null;
}

async function waitForLiveProviderRoots(contexts: readonly DatabaseProviderContext[]): Promise<{
  readonly source: HTMLElement;
  readonly firstView: HTMLElement;
  readonly secondView: HTMLElement;
}> {
  let roots: ReturnType<typeof activeLiveProviderRoots> = null;
  await until('the real React source and two TipTap linked providers to mount', () => {
    roots = activeLiveProviderRoots(contexts);
    return (
      roots !== null &&
      [roots.source, roots.firstView, roots.secondView].every((root) => Boolean(root.querySelector('table')))
    );
  });
  if (!roots) throw new Error('The real provider roots did not mount.');
  return roots;
}

async function waitForSaved(root: HTMLElement): Promise<void> {
  await until('the text edit to flush', () =>
    /saved|salvas|guardados/i.test(root.querySelector('[data-current-notice]')?.textContent ?? ''),
  );
}

beforeEach(() => {
  preferencesBeforeTest = getPreferences();
  setPreferences({ locale: 'en', readingMode: false });
});

afterEach(async () => {
  for (const root of [...mountedRoots]) root.unmount();
  for (const harness of [...liveReactHarnesses]) await harness.unmount();
  for (const unregister of [...providerUnregisters]) unregister();
  for (const stop of [...stopTabListeners]) {
    stop();
    stopTabListeners.delete(stop);
  }
  for (const fixture of [...fixtures]) {
    await fixture.close();
    fixtures.delete(fixture);
  }
  for (const state of transientMountStates) state.dispose();
  transientMountStates.clear();
  setPreferences({ locale: preferencesBeforeTest.locale, readingMode: preferencesBeforeTest.readingMode });
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.abort()));
  vi.restoreAllMocks();
});

describe('Polaris Dados text-cell editor with real host APIs', () => {
  it('restores isolated Source and Linked text drafts through their host mount slots', async () => {
    const fixture = await openFixture();
    const states = [createProviderMountState(), createProviderMountState(), createProviderMountState()];
    for (const state of states) transientMountStates.add(state);
    const [sourceState, firstState, secondState] = states;
    if (!sourceState || !firstState || !secondState) throw new Error('The mount states were not created.');
    const createRoots = (locale: DatabaseProviderContext['locale']): MountedRoot[] => [
      mountRoot(fixture, { locale, mountState: sourceState }),
      mountRoot(fixture, { locale, viewId: VIEW_ONE, mountState: firstState }),
      mountRoot(fixture, { locale, viewId: VIEW_TWO, mountState: secondState }),
    ];
    let roots = createRoots('pt');
    const drafts = ['Source draft 🌿', 'First view draft 🌱', 'Second view draft 🌳'];
    const selections = [3, 5, 7];
    const originalBytes = fixture.vault.text(ROW_PATH);
    const originalWrites = fixture.vault.applyCount;

    roots.forEach((root, index) => {
      const textarea = openEditor(root.element, 'message') as HTMLTextAreaElement;
      textarea.value = drafts[index]!;
      textarea.setSelectionRange(selections[index]!, selections[index]!);
      dispatchInput(root, textarea);
      const stored = JSON.parse(root.transientState?.read() ?? 'null') as {
        phase?: string;
        rawValue?: string;
        version?: number;
      } | null;
      expect(stored).toMatchObject({ version: 1, phase: 'editing', rawValue: drafts[index] });
    });
    for (const root of roots) root.unmount();

    roots = createRoots('es');
    roots.forEach((root, index) => {
      const textarea = root.element.querySelector<HTMLTextAreaElement>('textarea[data-field="message"]');
      expect(textarea).not.toBeNull();
      expect(textarea?.value).toBe(drafts[index]);
      expect(textarea?.selectionStart).toBe(selections[index]);
      expect(root.window.document.activeElement).toBe(textarea);
    });
    expect(rowProperties(fixture).message).toBe(INITIAL_MESSAGE);
    expect(fixture.textPatchCalls).toBe(0);
    expect(fixture.vault.applyCount).toBe(originalWrites);
    expect(fixture.vault.text(ROW_PATH)).toBe(originalBytes);
  });

  it('restores Source and TipTap linked drafts through real preference, registry, and React remounts', async () => {
    const fixture = await openFixture();
    const contexts: DatabaseProviderContext[] = [];
    const stopTabs = startTabs();
    stopTabListeners.add(stopTabs);
    const writesBefore = fixture.vault.applyCount;
    const patchSpy = vi.spyOn(fixture.session, 'patchPilotDataCell');
    let unregister = registerLiveProvider(fixture, contexts);
    const harness = mountLiveReactPage(fixture);
    await harness.render();
    const pageEditor = harness.editor;
    if (!pageEditor) throw new Error('The real TipTap PageEditor did not mount.');
    let roots = await waitForLiveProviderRoots(contexts);
    const surfaces = [roots.source, roots.firstView, roots.secondView];
    const drafts = ['source after reload 🌿', 'first view after reload 🌱', 'second view after reload 🌳'];
    const selections = [3, 5, 7];

    surfaces.forEach((root, index) => {
      const textarea = openEditor(root, 'message') as HTMLTextAreaElement;
      textarea.value = drafts[index]!;
      textarea.setSelectionRange(selections[index]!, selections[index]!);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(rowProperties(fixture).message).toBe(INITIAL_MESSAGE);
    expect(patchSpy).not.toHaveBeenCalled();
    expect(fixture.vault.applyCount).toBe(writesBefore);

    await act(async () => setPreferences({ locale: 'es' }));
    roots = await waitForLiveProviderRoots(contexts);
    const localized = [roots.source, roots.firstView, roots.secondView];
    localized.forEach((root, index) => {
      const textarea = root.querySelector<HTMLTextAreaElement>('textarea[data-field="message"]');
      expect(textarea?.value).toBe(drafts[index]);
    });
    const focusedAfterLocale = roots.secondView.querySelector<HTMLTextAreaElement>(
      'textarea[data-field="message"]',
    );
    expect(document.activeElement).toBe(focusedAfterLocale);
    expect(focusedAfterLocale?.selectionStart).toBe(7);
    expect(
      contexts.filter((context) => !context.signal.aborted).every((context) => context.locale === 'es'),
    ).toBe(true);

    await act(async () => setPreferences({ readingMode: true }));
    roots = await waitForLiveProviderRoots(contexts);
    [roots.source, roots.firstView, roots.secondView].forEach((root, index) => {
      const textarea = root.querySelector<HTMLTextAreaElement>('textarea[data-field="message"]');
      expect(textarea?.value).toBe(drafts[index]);
      expect(textarea?.readOnly).toBe(true);
    });
    expect(patchSpy).not.toHaveBeenCalled();
    expect(fixture.vault.applyCount).toBe(writesBefore);

    await act(async () => unregister());
    await until(
      'the registered provider to release all three mounts',
      () => contexts.filter((context) => !context.signal.aborted).length === 0,
    );
    expect(harness.container.querySelectorAll('.polaris-dados-view-fallback')).toHaveLength(2);

    await act(async () => {
      unregister = registerLiveProvider(fixture, contexts);
    });
    roots = await waitForLiveProviderRoots(contexts);
    [roots.source, roots.firstView, roots.secondView].forEach((root, index) => {
      const textarea = root.querySelector<HTMLTextAreaElement>('textarea[data-field="message"]');
      expect(textarea?.value).toBe(drafts[index]);
      expect(textarea?.readOnly).toBe(true);
    });

    await act(async () => setPreferences({ locale: 'pt', readingMode: false }));
    roots = await waitForLiveProviderRoots(contexts);
    [roots.source, roots.firstView, roots.secondView].forEach((root, index) => {
      const textarea = root.querySelector<HTMLTextAreaElement>('textarea[data-field="message"]');
      expect(textarea?.value).toBe(drafts[index]);
      expect(textarea?.readOnly).toBe(false);
    });
    expect(patchSpy).not.toHaveBeenCalled();
    expect(fixture.vault.applyCount).toBe(writesBefore);

    cancelButton(roots.firstView).click();
    cancelButton(roots.secondView).click();

    await act(async () => saveButton(roots.source).click());
    await waitForSaved(roots.source);
    await until('the saved text to reach all real provider roots', () =>
      [roots.source, roots.firstView, roots.secondView].every(
        (root) => fieldValue(root, 'message').text === drafts[0],
      ),
    );
    expect(rowProperties(fixture).message).toBe(drafts[0]);
    expect(patchSpy).toHaveBeenCalledOnce();
    expect(fixture.vault.applyCount).toBe(writesBefore + 1);
  });

  it('preserves captured CRLF on no-input Save, updates two linked views, supports history, and reopens persisted bytes', async () => {
    const fixture = await openFixture();
    const source = mountRoot(fixture);
    const firstView = mountRoot(fixture, { viewId: VIEW_ONE });
    const secondView = mountRoot(fixture, { viewId: VIEW_TWO });
    const roots = [source, firstView, secondView];
    const initialRowBytes = fixture.vault.text(ROW_PATH);
    const initialApplyCount = fixture.vault.applyCount;

    expect(rowProperties(fixture).message).toBe(INITIAL_MESSAGE);
    expect(fieldValue(source.element, 'message')).toEqual({ kind: 'text', text: INITIAL_MESSAGE });
    expect(firstView.viewApi?.snapshot()).toMatchObject({ status: 'ready', viewId: VIEW_ONE });
    expect(secondView.viewApi?.snapshot()).toMatchObject({ status: 'ready', viewId: VIEW_TWO });
    for (const root of roots) {
      expect(fieldValue(root.element, 'total')).toEqual({ kind: 'number', text: '20' });
      expect(cell(root.element, 'message').closest('tr')?.dataset.rowId).toBe(ROW_ID);
      expect(root.element.querySelector('[data-row-title] button')).toBeNull();
    }

    const textarea = openEditor(source.element, 'message') as HTMLTextAreaElement;
    expect(textarea.value).toBe('  opening 🌿\nsecond line\nlast  ');
    expect(fixture.vault.applyCount).toBe(initialApplyCount);
    cancelButton(source.element).click();
    expect(fixture.vault.applyCount).toBe(initialApplyCount);
    expect(fixture.textPatchCalls).toBe(0);
    expect(fixture.vault.text(ROW_PATH)).toBe(initialRowBytes);
    expect(rowProperties(fixture).message).toBe(INITIAL_MESSAGE);

    openEditor(source.element, 'message');
    saveButton(source.element).click();
    await waitForSaved(source.element);
    expect(rowProperties(fixture).message).toBe(INITIAL_MESSAGE);
    expect(fixture.vault.text(ROW_PATH)).toBe(initialRowBytes);

    const escapeDraft = openEditor(source.element, 'message') as HTMLTextAreaElement;
    escapeDraft.value = 'cancel this draft';
    dispatchInput(source, escapeDraft);
    escapeDraft.dispatchEvent(
      new source.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }) as unknown as Event,
    );
    expect(source.element.querySelector('textarea[data-field="message"]')).toBeNull();
    expect(fixture.vault.text(ROW_PATH)).toBe(initialRowBytes);

    const quantity = openEditor(source.element, 'quantity') as HTMLInputElement;
    quantity.value = '0';
    dispatchInput(source, quantity);
    quantity.dispatchEvent(
      new source.window.KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }) as unknown as Event,
    );
    await until('Total to update to zero in every view', () =>
      roots.every((root) => fieldValue(root.element, 'total').text === '0'),
    );
    await waitForSaved(source.element);
    expect(rowProperties(fixture).quantity).toBe(0);

    const textEditor = openEditor(source.element, 'message') as HTMLTextAreaElement;
    const rootBubbles: string[] = [];
    const bubbleListener = (event: Event) => rootBubbles.push((event as KeyboardEvent).key);
    source.element.parentElement?.addEventListener('keydown', bubbleListener);
    const editedMessage = '  Grüß 🌿  \nline one\nline two  ';
    textEditor.value = editedMessage;
    textEditor.setSelectionRange(3, 3);
    dispatchInput(source, textEditor);
    expect(source.element.querySelector('textarea[data-field="message"]')).toBe(textEditor);
    expect(source.window.document.activeElement).toBe(textEditor);
    expect(textEditor.selectionStart).toBe(3);

    for (const key of ['Enter', 'Escape']) {
      const composing = new source.window.KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        isComposing: true,
      });
      textEditor.dispatchEvent(composing as unknown as Event);
      expect(composing.defaultPrevented).toBe(false);
      expect(source.element.querySelector('textarea[data-field="message"]')).toBe(textEditor);
      expect(rootBubbles).toEqual([]);
    }
    const enter = new source.window.KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    const shiftEnter = new source.window.KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    textEditor.dispatchEvent(enter as unknown as Event);
    textEditor.dispatchEvent(shiftEnter as unknown as Event);
    expect(enter.defaultPrevented).toBe(false);
    expect(shiftEnter.defaultPrevented).toBe(false);
    expect(source.element.querySelector('textarea[data-field="message"]')).toBe(textEditor);
    expect(rowProperties(fixture).message).toBe(INITIAL_MESSAGE);

    const localUndo = new source.window.KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    textEditor.dispatchEvent(localUndo as unknown as Event);
    await settle();
    expect(localUndo.defaultPrevented).toBe(false);
    expect(rowProperties(fixture).quantity).toBe(0);
    expect(source.element.querySelector('textarea[data-field="message"]')).toBe(textEditor);
    expect(rootBubbles).toEqual([]);
    source.element.parentElement?.removeEventListener('keydown', bubbleListener);

    saveButton(source.element).click();
    await until('the text to update in all three roots', () =>
      roots.every((root) => fieldValue(root.element, 'message').text === editedMessage),
    );
    await waitForSaved(source.element);
    expect(rowProperties(fixture).message).toBe(editedMessage);
    for (const root of roots) expect(fieldValue(root.element, 'total').text).toBe('0');
    expect(firstView.viewApi?.snapshot()).toMatchObject({ status: 'ready', viewId: VIEW_ONE });
    expect(secondView.viewApi?.snapshot()).toMatchObject({ status: 'ready', viewId: VIEW_TWO });

    const undo = new source.window.KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    source.element.dispatchEvent(undo as unknown as Event);
    expect(undo.defaultPrevented).toBe(true);
    await until('text undo in all three roots', () =>
      roots.every((root) => fieldValue(root.element, 'message').text === INITIAL_MESSAGE),
    );
    await waitForSaved(source.element);

    const redo = new source.window.KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    source.element.dispatchEvent(redo as unknown as Event);
    expect(redo.defaultPrevented).toBe(true);
    await until('text redo in all three roots', () =>
      roots.every((root) => fieldValue(root.element, 'message').text === editedMessage),
    );
    await waitForSaved(source.element);

    const persistedBytes = fixture.vault.text(ROW_PATH);
    if (persistedBytes === undefined) throw new Error('The edited row was not persisted in MemoryVault.');
    for (const root of roots) root.unmount();
    await fixture.close();
    fixtures.delete(fixture);

    const reopened = await openFixture(fixture.vault);
    expect(reopened.vault.text(ROW_PATH)).toBe(persistedBytes);
    expect(rowProperties(reopened).message).toBe(editedMessage);
    expect(rowProperties(reopened).quantity).toBe(0);
  });

  it('does not switch to another cell while a draft is open', async () => {
    const fixture = await openFixture();
    const root = mountRoot(fixture);
    const oldQuantityButton = editButton(root.element, 'quantity');
    const textEditor = openEditor(root.element, 'message') as HTMLTextAreaElement;
    textEditor.value = 'keep this draft';
    dispatchInput(root, textEditor);

    expect(root.element.querySelector('button[data-action="edit"][data-field="quantity"]')).toBeNull();
    oldQuantityButton.click();
    expect(root.element.querySelector('textarea[data-field="message"]')).toBe(textEditor);
    expect(textEditor.value).toBe('keep this draft');
    expect(rowProperties(fixture).quantity).toBe(2);
    expect(rowProperties(fixture).message).toBe(INITIAL_MESSAGE);
    expect(fixture.textPatchCalls).toBe(0);
    cancelButton(root.element).click();
  });

  it('materializes absent and null text only on explicit Save and rejects oversized drafts without truncation', async () => {
    const fixture = await openFixture();
    const root = mountRoot(fixture);
    const initial = rowProperties(fixture);
    expect(initial.empty).toBe('');
    expect(Object.hasOwn(initial, 'nullable')).toBe(true);
    expect(initial.nullable).toBeNull();
    expect(Object.hasOwn(initial, 'optional')).toBe(false);
    const initialApplyCount = fixture.vault.applyCount;

    openEditor(root.element, 'nullable');
    cancelButton(root.element).click();
    openEditor(root.element, 'optional');
    cancelButton(root.element).click();
    expect(fixture.vault.applyCount).toBe(initialApplyCount);
    expect(fixture.vault.text(ROW_PATH)).toBe(ROW);
    expect(fixture.textPatchCalls).toBe(0);
    expect(Object.hasOwn(rowProperties(fixture), 'nullable')).toBe(true);
    expect(Object.hasOwn(rowProperties(fixture), 'optional')).toBe(false);

    openEditor(root.element, 'nullable');
    saveButton(root.element).click();
    await waitForSaved(root.element);
    expect(Object.hasOwn(rowProperties(fixture), 'nullable')).toBe(true);
    expect(rowProperties(fixture).nullable).toBe('');

    openEditor(root.element, 'optional');
    saveButton(root.element).click();
    await waitForSaved(root.element);
    expect(Object.hasOwn(rowProperties(fixture), 'optional')).toBe(true);
    expect(rowProperties(fixture).optional).toBe('');

    const exactLimit = 'a'.repeat(9_998) + '🌿';
    const longEditor = openEditor(root.element, 'message') as HTMLTextAreaElement;
    longEditor.value = exactLimit;
    dispatchInput(root, longEditor);
    expect(longEditor.value).toBe(exactLimit);
    saveButton(root.element).click();
    await waitForSaved(root.element);
    expect(rowProperties(fixture).message).toBe(exactLimit);
    expect(fixture.textPatchCalls).toBe(3);

    const writesBeforeRejectedDraft = fixture.vault.applyCount;
    const overLimit = 'b'.repeat(10_000) + 'x';
    const oversizedEditor = openEditor(root.element, 'message') as HTMLTextAreaElement;
    oversizedEditor.value = overLimit;
    dispatchInput(root, oversizedEditor);
    expect(oversizedEditor.value).toBe(overLimit);
    saveButton(root.element).click();
    expect(oversizedEditor.value).toBe(overLimit);
    expect(fixture.vault.applyCount).toBe(writesBeforeRejectedDraft);
    expect(fixture.textPatchCalls).toBe(3);
    expect(rowProperties(fixture).message).toBe(exactLimit);
    expect(root.element.querySelector('[role="alert"]')?.textContent).toContain('10,000');
    cancelButton(root.element).click();
    expect(fixture.vault.applyCount).toBe(writesBeforeRejectedDraft);
    expect(fixture.textPatchCalls).toBe(3);
  });

  it('retains drafts behind readonly, stale, and inactive-provider fences', async () => {
    const fixture = await openFixture();
    const root = mountRoot(fixture);
    const original = fixture.vault.text(ROW_PATH);

    const readonlyDraft = openEditor(root.element, 'message') as HTMLTextAreaElement;
    readonlyDraft.value = 'unsaved while read only';
    dispatchInput(root, readonlyDraft);
    fixture.editable = false;
    saveButton(root.element).click();
    expect(root.element.querySelector('textarea[data-field="message"]')).toBe(readonlyDraft);
    expect(readonlyDraft.value).toBe('unsaved while read only');
    expect(readonlyDraft.readOnly).toBe(true);
    expect(saveButton(root.element).disabled).toBe(false);
    expect(fixture.vault.text(ROW_PATH)).toBe(original);

    fixture.editable = true;
    root.refreshDataSnapshot();
    expect(root.element.querySelector('textarea[data-field="message"]')).toBe(readonlyDraft);
    expect(readonlyDraft.readOnly).toBe(false);
    expect(saveButton(root.element).disabled).toBe(false);
    saveButton(root.element).click();
    await waitForSaved(root.element);
    expect(rowProperties(fixture).message).toBe('unsaved while read only');

    const staleDraft = openEditor(root.element, 'message') as HTMLTextAreaElement;
    staleDraft.value = 'my preserved stale draft';
    dispatchInput(root, staleDraft);
    const latest = fixture.data.snapshot(DATABASE_ID as PageId);
    if (latest.status !== 'ready') throw new Error('The provider API stopped being ready.');
    const externalPatch = fixture.data.patchTextCell?.({
      databaseId: DATABASE_ID as PageId,
      rowId: ROW_ID as PageId,
      propertyId: 'message',
      value: 'external edit',
      expectedRevision: latest.revision,
    });
    expect(externalPatch?.status).toBe('staged');
    await fixture.data.flush(DATABASE_ID as PageId);
    expect(root.element.querySelector('textarea[data-field="message"]')).toBe(staleDraft);
    expect(staleDraft.value).toBe('my preserved stale draft');
    expect(staleDraft.readOnly).toBe(true);
    expect(saveButton(root.element).disabled).toBe(true);
    saveButton(root.element).click();
    expect(rowProperties(fixture).message).toBe('external edit');
    cancelButton(root.element).click();

    const inactiveDraft = openEditor(root.element, 'message') as HTMLTextAreaElement;
    inactiveDraft.value = 'retain while provider is inactive';
    dispatchInput(root, inactiveDraft);
    fixture.ownerActive = false;
    saveButton(root.element).click();
    expect(root.element.querySelector('textarea[data-field="message"]')).toBe(inactiveDraft);
    expect(inactiveDraft.value).toBe('retain while provider is inactive');
    expect(inactiveDraft.readOnly).toBe(true);
    expect(saveButton(root.element).disabled).toBe(false);
    expect(fixture.vault.text(ROW_PATH)).not.toContain('retain while provider is inactive');
  });

  it('keeps stale drafts read-only, selectable, and cancelable on source and both linked roots', async () => {
    const fixture = await openFixture();
    const states = [createProviderMountState(), createProviderMountState(), createProviderMountState()];
    for (const state of states) transientMountStates.add(state);
    const roots = [
      mountRoot(fixture, { mountState: states[0] }),
      mountRoot(fixture, { viewId: VIEW_ONE, mountState: states[1] }),
      mountRoot(fixture, { viewId: VIEW_TWO, mountState: states[2] }),
    ];
    const drafts = ['source stale text', 'first view stale text', 'second view stale text'];
    const editors = roots.map((root, index) => {
      const textarea = openEditor(root.element, 'message') as HTMLTextAreaElement;
      textarea.value = drafts[index]!;
      dispatchInput(root, textarea);
      return textarea;
    });

    const beforeExternalEdit = fixture.data.snapshot(DATABASE_ID as PageId);
    if (beforeExternalEdit.status !== 'ready') throw new Error('The provider API was not ready.');
    const externalPatch = fixture.data.patchTextCell?.({
      databaseId: DATABASE_ID as PageId,
      rowId: ROW_ID as PageId,
      propertyId: 'message',
      value: 'saved elsewhere',
      expectedRevision: beforeExternalEdit.revision,
    });
    expect(externalPatch?.status).toBe('staged');
    await fixture.data.flush(DATABASE_ID as PageId);
    const writesAfterExternalEdit = fixture.vault.applyCount;

    roots.forEach((root, index) => {
      const editor = editors[index]!;
      const textarea = root.element.querySelector<HTMLTextAreaElement>('textarea[data-field="message"]');
      expect(textarea).toBe(editor);
      expect(textarea?.value).toBe(drafts[index]);
      expect(textarea?.readOnly).toBe(true);
      expect(saveButton(root.element).disabled).toBe(true);
      if (textarea) {
        textarea.value = 'blocked browser input';
        dispatchInput(root, textarea);
        expect(textarea.value).toBe(drafts[index]);
        textarea.setSelectionRange(1, Math.min(4, textarea.value.length));
        expect(textarea.selectionStart).toBe(1);
      }
      const stored = JSON.parse(root.transientState?.read() ?? 'null') as { rawValue?: string } | null;
      expect(stored?.rawValue).toBe(drafts[index]);
      cancelButton(root.element).click();
      expect(root.element.querySelector('textarea[data-field="message"]')).toBeNull();
    });
    expect(rowProperties(fixture).message).toBe('saved elsewhere');
    expect(fixture.vault.applyCount).toBe(writesAfterExternalEdit);
    expect(fixture.textPatchCalls).toBe(0);
  });

  it('retries the same draft after a real WorkspaceSession mutation fence releases, without a synthetic snapshot', async () => {
    const fixture = await openFixture();
    const mountState = createProviderMountState();
    transientMountStates.add(mountState);
    let root = mountRoot(fixture, { mountState });
    const textEditor = openEditor(root.element, 'message') as HTMLTextAreaElement;
    textEditor.value = 'same draft across the fence';
    dispatchInput(root, textEditor);
    const initialBytes = fixture.vault.text(ROW_PATH);
    const initialWrites = fixture.vault.applyCount;
    const before = fixture.data.snapshot(DATABASE_ID as PageId);
    expect(before.status).toBe('ready');
    if (before.status !== 'ready') throw new Error('The provider API stopped being ready.');
    expect(before.readonly).toBe(false);
    const backendResults: ReturnType<typeof fixture.session.patchPilotDataCell>[] = [];
    const originalPatch = fixture.session.patchPilotDataCell.bind(fixture.session);
    let firstBackendCall = true;
    const fenceLease: { release?: () => void } = {};
    const patchSpy = vi.spyOn(fixture.session, 'patchPilotDataCell').mockImplementation((input) => {
      if (firstBackendCall) {
        firstBackendCall = false;
        fenceLease.release = fixture.session.beginMutationFence();
      }
      const result = originalPatch(input);
      backendResults.push(result);
      return result;
    });

    try {
      saveButton(root.element).click();
      expect(root.element.querySelector('textarea[data-field="message"]')).toBe(textEditor);
      expect(textEditor.value).toBe('same draft across the fence');
      expect(textEditor.readOnly).toBe(true);
      expect(saveButton(root.element).disabled).toBe(false);
      expect(fixture.session.isMutationFenced).toBe(true);
      expect(fixture.textPatchCalls).toBe(1);
      expect(patchSpy).toHaveBeenCalledOnce();
      expect(backendResults[0]).toMatchObject({ ok: false, code: 'read-only' });
      const refusedDraft = JSON.parse(root.transientState?.read() ?? 'null') as {
        phase?: string;
        blocked?: string | null;
      } | null;
      expect(refusedDraft).toMatchObject({ phase: 'editing', blocked: 'readonly' });
      const rejectedSnapshot = fixture.data.snapshot(DATABASE_ID as PageId);
      expect(rejectedSnapshot).toMatchObject({ status: 'ready', readonly: true });
      expect(fixture.vault.applyCount).toBe(initialWrites);
      expect(fixture.vault.text(ROW_PATH)).toBe(initialBytes);

      root.unmount();
      root = mountRoot(fixture, { mountState, locale: 'es' });
      const restoredRefusal = root.element.querySelector<HTMLTextAreaElement>(
        'textarea[data-field="message"]',
      );
      expect(restoredRefusal?.value).toBe('same draft across the fence');
      expect(restoredRefusal?.readOnly).toBe(true);
      expect(saveButton(root.element).disabled).toBe(false);
      expect(root.element.querySelector('button[data-action="retry"]')).toBeNull();
      expect(fixture.textPatchCalls).toBe(1);
      fenceLease.release?.();
      fenceLease.release = undefined;
      expect(fixture.session.isMutationFenced).toBe(false);
      expect(root.element.querySelector<HTMLTextAreaElement>('textarea[data-field="message"]')?.value).toBe(
        'same draft across the fence',
      );

      // The release emits no DataApi snapshot; the next explicit Save reads a fresh session snapshot.
      saveButton(root.element).click();
      await waitForSaved(root.element);
      expect(fixture.textPatchCalls).toBe(2);
      expect(patchSpy).toHaveBeenCalledTimes(2);
      expect(backendResults[1]).toMatchObject({ ok: true });
      expect(rowProperties(fixture).message).toBe('same draft across the fence');
      expect(fixture.vault.text(ROW_PATH)).not.toBe(initialBytes);
      const nextEditor = openEditor(root.element, 'message') as HTMLTextAreaElement;
      expect(nextEditor.readOnly).toBe(false);
      nextEditor.value = 'editing works after the fence releases';
      dispatchInput(root, nextEditor);
      saveButton(root.element).click();
      await waitForSaved(root.element);
      expect(rowProperties(fixture).message).toBe('editing works after the fence releases');
    } finally {
      fenceLease.release?.();
      patchSpy.mockRestore();
    }
  });

  it('keeps a draft when the database is no longer ready and disables editing when the host is noneditable', async () => {
    const fixture = await openFixture();
    const root = mountRoot(fixture);
    const originalBytes = fixture.vault.text(ROW_PATH);
    const draft = openEditor(root.element, 'message') as HTMLTextAreaElement;
    draft.value = 'retained until the database returns';
    dispatchInput(root, draft);
    fixture.databaseMissing = true;
    saveButton(root.element).click();
    expect(root.element.querySelector('textarea[data-field="message"]')).toBeNull();
    expect(
      root.element.querySelector<HTMLTextAreaElement>('textarea[data-draft-value="message"]')?.value,
    ).toBe('retained until the database returns');
    expect(root.element.querySelector('button[data-action="save"]')).toBeNull();
    expect(cancelButton(root.element).disabled).toBe(false);
    expect(fixture.textPatchCalls).toBe(0);
    expect(fixture.vault.text(ROW_PATH)).toBe(originalBytes);
    cancelButton(root.element).click();

    fixture.databaseMissing = false;
    const readonlyRoot = mountRoot(fixture, { editable: false });
    expect(readonlyRoot.element.querySelector('button[data-action="edit"][data-field="message"]')).toBeNull();
    expect(
      readonlyRoot.element.querySelector('button[data-action="edit"][data-field="quantity"]'),
    ).toBeNull();
  });

  it('keeps a stale text draft copyable and cancelable when its property becomes numeric', async () => {
    const fixture = await openFixture();
    const mountState = createProviderMountState();
    transientMountStates.add(mountState);
    let root = mountRoot(fixture, { mountState });
    const originalWrites = fixture.vault.applyCount;
    const editor = openEditor(root.element, 'message') as HTMLTextAreaElement;
    editor.value = 'keep this text after a schema change';
    dispatchInput(root, editor);
    root.unmount();

    const numericMessageSchema = (snapshot: DataApiSnapshot): DataApiSnapshot =>
      snapshot.status === 'ready'
        ? {
            ...snapshot,
            schema: {
              ...snapshot.schema,
              properties: snapshot.schema.properties.map((property) =>
                property.id === 'message' ? { ...property, type: 'number' as const } : property,
              ),
            },
          }
        : snapshot;
    root = mountRoot(fixture, { mountState, locale: 'es', snapshotTransform: numericMessageSchema });
    const staleText = root.element.querySelector<HTMLTextAreaElement>('textarea[data-field="message"]');
    expect(staleText?.value).toBe('keep this text after a schema change');
    expect(root.element.querySelector('input[data-field="message"]')).toBeNull();
    expect(saveButton(root.element).disabled).toBe(true);
    expect(cancelButton(root.element).disabled).toBe(false);
    expect(fixture.textPatchCalls).toBe(0);
    expect(fixture.vault.applyCount).toBe(originalWrites);

    cancelButton(root.element).click();
    expect(root.element.querySelector('textarea[data-field="message"]')).toBeNull();
    expect(root.transientState?.read()).toBeUndefined();
    expect(fixture.textPatchCalls).toBe(0);
    expect(fixture.vault.applyCount).toBe(originalWrites);
  });

  it('retries a failed flush without staging the text patch a second time', async () => {
    const fixture = await openFixture();
    const root = mountRoot(fixture);
    const before = fixture.data.snapshot(DATABASE_ID as PageId);
    if (before.status !== 'ready') throw new Error('The provider API was not ready.');
    const editor = openEditor(root.element, 'message') as HTMLTextAreaElement;
    editor.value = 'one staged text patch';
    dispatchInput(root, editor);
    fixture.vault.failNextApply = 'temporary storage failure';
    saveButton(root.element).click();

    await until(
      'the staged flush failure to expose Retry',
      () => root.element.querySelector('button[data-action="retry"]') !== null,
    );
    const afterFailure = fixture.data.snapshot(DATABASE_ID as PageId);
    expect(afterFailure.status).toBe('ready');
    if (afterFailure.status !== 'ready') throw new Error('The provider API stopped being ready.');
    expect(afterFailure.revision).not.toBe(before.revision);
    expect(rowProperties(fixture).message).toBe('one staged text patch');
    expect(fixture.textPatchCalls).toBe(1);

    root.element.querySelector<HTMLButtonElement>('button[data-action="retry"]')?.click();
    await waitForSaved(root.element);
    const afterRetry = fixture.data.snapshot(DATABASE_ID as PageId);
    expect(afterRetry.status).toBe('ready');
    if (afterRetry.status !== 'ready') throw new Error('The provider API stopped being ready after retry.');
    expect(afterRetry.revision).toBe(afterFailure.revision);
    expect(rowProperties(fixture).message).toBe('one staged text patch');
    expect(fixture.textPatchCalls).toBe(1);
    expect(fixture.vault.text(ROW_PATH)).not.toBe(ROW);
  });

  it('recovers an accepted patch as retry-only when a real session observer unmounts mid-call', async () => {
    const fixture = await openFixture();
    const mountState = createProviderMountState();
    transientMountStates.add(mountState);
    let root = mountRoot(fixture, { mountState });
    const expectedValue = 'accepted before the host unloads';
    const initialBytes = fixture.vault.text(ROW_PATH);
    const initialApplyCount = fixture.vault.applyCount;
    const patchSpy = vi.spyOn(fixture.session, 'patchPilotDataCell');
    const flushSpy = vi.spyOn(fixture.session, 'flush');
    let didUnmount = false;
    const unsubscribe = fixture.session.subscribe(() => {
      if (didUnmount || rowProperties(fixture).message !== expectedValue) return;
      didUnmount = true;
      root.unmount();
    });

    try {
      const textarea = openEditor(root.element, 'message') as HTMLTextAreaElement;
      textarea.value = expectedValue;
      dispatchInput(root, textarea);
      saveButton(root.element).click();
      expect(didUnmount).toBe(true);
      expect(fixture.textPatchCalls).toBe(1);
      expect(patchSpy).toHaveBeenCalledOnce();
      expect(flushSpy).not.toHaveBeenCalled();
      expect(rowProperties(fixture).message).toBe(expectedValue);
      expect(fixture.vault.text(ROW_PATH)).toBe(initialBytes);
      expect(fixture.vault.applyCount).toBe(initialApplyCount);

      const staged = fixture.data.snapshot(DATABASE_ID as PageId);
      expect(staged.status).toBe('ready');
      if (staged.status !== 'ready')
        throw new Error('The accepted text patch was not visible in the session.');
      expect(staged.history.canUndo).toBe(true);
      const stagedRevision = staged.revision;

      root = mountRoot(fixture, { mountState, locale: 'es' });
      const restoredState = JSON.parse(root.transientState?.read() ?? 'null') as {
        phase?: string;
        rawValue?: string;
      } | null;
      expect(restoredState).toMatchObject({ phase: 'pending-flush', rawValue: expectedValue });
      expect(root.element.querySelector('textarea[data-field="message"]')).toBeNull();
      expect(root.element.querySelector<HTMLButtonElement>('button[data-action="retry"]')?.disabled).toBe(
        false,
      );
      expect(fixture.textPatchCalls).toBe(1);

      root.element.querySelector<HTMLButtonElement>('button[data-action="retry"]')?.click();
      await waitForSaved(root.element);
      const afterRetry = fixture.data.snapshot(DATABASE_ID as PageId);
      expect(afterRetry.status).toBe('ready');
      if (afterRetry.status !== 'ready') throw new Error('The retry did not leave a ready snapshot.');
      expect(afterRetry.revision).toBe(stagedRevision);
      expect(afterRetry.history.canUndo).toBe(true);
      expect(rowProperties(fixture).message).toBe(expectedValue);
      expect(fixture.vault.text(ROW_PATH)).not.toBe(initialBytes);
      expect(fixture.textPatchCalls).toBe(1);
      expect(patchSpy).toHaveBeenCalledOnce();
      expect(flushSpy).toHaveBeenCalledOnce();
      expect(root.transientState?.read()).toBeUndefined();
    } finally {
      unsubscribe();
      patchSpy.mockRestore();
      flushSpy.mockRestore();
    }
  });

  it('restores a staged text draft after disappearance during flush and retries flush only', async () => {
    const fixture = await openFixture();
    const mountState = createProviderMountState();
    transientMountStates.add(mountState);
    let releaseFlush!: () => void;
    let notifyApplyStarted!: () => void;
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const applyStarted = new Promise<void>((resolve) => {
      notifyApplyStarted = resolve;
    });
    const originalApply = fixture.vault.apply.bind(fixture.vault);
    let firstApply = true;
    const applySpy = vi.spyOn(fixture.vault, 'apply').mockImplementation(async (operations) => {
      if (firstApply) {
        firstApply = false;
        notifyApplyStarted();
        await flushGate;
      }
      return originalApply(operations);
    });
    const flushSpy = vi.spyOn(fixture.session, 'flush');
    let root = mountRoot(fixture, { mountState });
    const originalPatch = fixture.session.patchPilotDataCell.bind(fixture.session);
    const patchSpy = vi.spyOn(fixture.session, 'patchPilotDataCell').mockImplementation(originalPatch);
    const editor = openEditor(root.element, 'message') as HTMLTextAreaElement;
    editor.value = 'one staged patch across remount';
    dispatchInput(root, editor);

    saveButton(root.element).click();
    await until('the staged pending-flush draft to be checkpointed', () => {
      const serialized = root.transientState?.read();
      return typeof serialized === 'string' && JSON.parse(serialized).phase === 'pending-flush';
    });
    const stagedSnapshot = fixture.data.snapshot(DATABASE_ID as PageId);
    expect(stagedSnapshot.status).toBe('ready');
    if (stagedSnapshot.status !== 'ready') throw new Error('The staged data stopped being ready.');
    const stagedRevision = stagedSnapshot.revision;
    expect(stagedSnapshot.history.canUndo).toBe(true);
    expect(patchSpy).toHaveBeenCalledOnce();
    expect(root.element.querySelector('textarea[data-field="message"]')).toBeNull();
    try {
      await applyStarted;
      root.unmount();
      root = mountRoot(fixture, { mountState, locale: 'es' });
      expect(root.transientState?.read()).toContain('pending-flush');
      expect(root.element.querySelector('textarea[data-field="message"]')).toBeNull();
      const retry = root.element.querySelector<HTMLButtonElement>('button[data-action="retry"]');
      expect(retry).not.toBeNull();
      expect(retry?.disabled).toBe(false);
      expect(fixture.textPatchCalls).toBe(1);

      releaseFlush();
      await until('the original in-flight flush to finish', () => fixture.vault.text(ROW_PATH) !== ROW);
      retry?.click();
      await waitForSaved(root.element);

      const afterRetry = fixture.data.snapshot(DATABASE_ID as PageId);
      expect(afterRetry.status).toBe('ready');
      if (afterRetry.status !== 'ready') throw new Error('The provider API stopped being ready.');
      expect(afterRetry.revision).toBe(stagedRevision);
      expect(afterRetry.history.canUndo).toBe(true);
      expect(fixture.textPatchCalls).toBe(1);
      expect(patchSpy).toHaveBeenCalledOnce();
      expect(flushSpy).toHaveBeenCalledTimes(2);
      expect(rowProperties(fixture).message).toBe('one staged patch across remount');
      expect(root.transientState?.read()).toBeUndefined();
    } finally {
      releaseFlush();
      applySpy.mockRestore();
      flushSpy.mockRestore();
      patchSpy.mockRestore();
    }
  });

  it('localizes text controls and length errors in Portuguese, English, and Spanish', async () => {
    const fixture = await openFixture();
    const locales = [
      { locale: 'pt' as const, save: 'Salvar', cancel: 'Cancelar', limit: '10.000' },
      { locale: 'en' as const, save: 'Save', cancel: 'Cancel', limit: '10,000' },
      { locale: 'es' as const, save: 'Guardar', cancel: 'Cancelar', limit: '10.000' },
    ];
    for (const expected of locales) {
      const root = mountRoot(fixture, { locale: expected.locale });
      const textarea = openEditor(root.element, 'message') as HTMLTextAreaElement;
      expect(saveButton(root.element).textContent).toBe(expected.save);
      expect(cancelButton(root.element).textContent).toBe(expected.cancel);
      textarea.value = 'x'.repeat(10_001);
      dispatchInput(root, textarea);
      saveButton(root.element).click();
      expect(root.element.querySelector('[role="alert"]')?.textContent).toContain(expected.limit);
      expect(root.element.querySelector('textarea[data-field="message"]')).toBe(textarea);
      cancelButton(root.element).click();
      root.unmount();
    }
    expect(fixture.vault.text(ROW_PATH)).toBe(ROW);
  });

  it('leaves text cells readonly on an older host without patchTextCell while preserving number editing', () => {
    const window = new Window({ url: 'http://morrow.test/' });
    windows.push(window);
    const element = window.document.createElement('div');
    window.document.body.append(element);
    const snapshot: DataApiSnapshot = {
      version: 1,
      status: 'ready',
      databaseId: DATABASE_ID as PageId,
      revision: 'legacy-revision',
      schema: {
        properties: [
          { id: 'message', name: 'Message', type: 'text', options: [] },
          { id: 'quantity', name: 'Quantity', type: 'number', options: [] },
        ],
        views: [],
      },
      rows: [{ id: ROW_ID as PageId, title: 'Widget', properties: { message: 'keep me', quantity: 1 } }],
      history: { canUndo: false, canRedo: false },
      readonly: false,
      diagnostic: null,
    };
    const legacyApi: DataApi = {
      version: 1,
      snapshot: () => snapshot,
      patchCell: (): DataApiPatchResult => ({
        status: 'staged',
        databaseId: DATABASE_ID as PageId,
        rowId: ROW_ID as PageId,
        propertyId: 'quantity',
        revision: 'next-revision',
      }),
      history: ({ direction }): DataApiHistoryResult => ({
        status: 'no-op',
        databaseId: DATABASE_ID as PageId,
        revision: 'legacy-revision',
        direction,
      }),
      subscribe(_databaseId, listener) {
        listener(snapshot);
        return () => {};
      },
      async flush(): Promise<DataApiFlushResult> {
        return { status: 'persisted', databaseId: DATABASE_ID as PageId, revision: 'legacy-revision' };
      },
    };
    const controller = new AbortController();
    const cleanup = mountPolarisDados({
      element: element as unknown as HTMLElement,
      databaseId: DATABASE_ID as PageId,
      data: legacyApi,
      locale: 'en',
      editable: true,
      signal: controller.signal,
    });
    const root = element as unknown as HTMLElement;
    expect(root.querySelector('button[data-action="edit"][data-field="message"]')).toBeNull();
    const numberEdit = root.querySelector<HTMLButtonElement>(
      'button[data-action="edit"][data-field="quantity"]',
    );
    expect(numberEdit).not.toBeNull();
    numberEdit?.click();
    expect(root.querySelector('input[data-field="quantity"]')).not.toBeNull();
    controller.abort();
    cleanup();
  });
});
