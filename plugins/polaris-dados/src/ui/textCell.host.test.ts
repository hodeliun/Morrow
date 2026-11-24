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
import type { LinkedViewApi, LinkedViewSnapshot } from '../../../../src/app/plugins/linkedViewApi';
import { registerDatabaseProvider } from '../../../../src/app/plugins/providerRegistry';
import { PageEditor } from '../../../../src/app/editor/PageEditor';
import { ProviderDatabaseView } from '../../../../src/app/components/database/ProviderDatabaseView';
import { PaneContext, startTabs } from '../../../../src/app/tabs';
import { getPreferences, setPreferences } from '../../../../src/app/platform/preferences';
import { mountPolarisDados } from './mount';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const DATABASE_ID = 'text-source';
const ROW_ID = 'text-widget';
const SECOND_ROW_ID = 'text-gadget';
const NOTE_ID = 'text-views';
const VIEW_ONE = 'text-view-one';
const VIEW_TWO = 'text-view-two';
const DATABASE_PATH = 'Inventory.md';
const ROW_PATH = 'Inventory/Widget.md';
const SECOND_ROW_PATH = 'Inventory/Gadget.md';
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

type CheckboxFixtureValue = boolean | null | 'missing';

function markdownForViews(includeCheckbox = false): string {
  const [first, second] = views;
  const firstView = includeCheckbox ? { ...first, columnOrder: ['message', 'flag'] } : first;
  const secondView = includeCheckbox ? { ...second, columnOrder: ['quantity', 'flag'] } : second;
  return [
    '# Text linked views',
    '',
    encodePolarisDadosViewMarker(firstView),
    '',
    'Between linked views.',
    '',
    encodePolarisDadosViewMarker(secondView),
    '',
  ].join('\n');
}

function markdownForGridNavigationViews(
  firstColumnOrder: string[] = ['total', 'message'],
  firstFilterValue = 3,
): string {
  const [first, second] = views;
  return [
    '# Grid navigation views',
    '',
    encodePolarisDadosViewMarker({
      ...first,
      columnOrder: firstColumnOrder,
      filter: { propertyId: 'quantity', op: 'gte', value: firstFilterValue },
    }),
    '',
    encodePolarisDadosViewMarker({ ...second, columnOrder: ['price', 'message'], filter: null }),
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
  checkboxPatchCalls: number;
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

function fixtureFiles(
  includeCheckbox = false,
  checkboxValue: CheckboxFixtureValue = false,
  includeGridNavigation = false,
): Record<string, string> {
  const database = includeCheckbox
    ? DATABASE.replace(
        '  views:',
        ['    - id: flag', '      name: Flag', '      type: checkbox', '  views:'].join('\n'),
      )
    : DATABASE;
  const row =
    includeCheckbox && checkboxValue !== 'missing'
      ? ROW.replace('Quantity: 2', `Flag: ${checkboxValue === null ? 'null' : checkboxValue}\nQuantity: 2`)
      : ROW;
  return {
    [DATABASE_PATH]: database,
    [ROW_PATH]: row,
    ...(includeGridNavigation
      ? {
          [SECOND_ROW_PATH]: [
            '---',
            'Message: second row',
            "Empty: ''",
            'Nullable: null',
            'Optional: present',
            'Quantity: 5',
            'Price: 4',
            '---',
            'Second synthetic row.',
            '',
          ].join('\n'),
        }
      : {}),
    [NOTE_PATH]: includeGridNavigation ? markdownForGridNavigationViews() : markdownForViews(includeCheckbox),
    '.morrow/workspace.json': JSON.stringify({
      version: 1,
      pages: {
        [DATABASE_PATH]: { id: DATABASE_ID, created: 1, order: 0 },
        [ROW_PATH]: { id: ROW_ID, created: 2, order: 0 },
        [NOTE_PATH]: { id: NOTE_ID, created: 3, order: 1 },
        ...(includeGridNavigation ? { [SECOND_ROW_PATH]: { id: SECOND_ROW_ID, created: 4, order: 1 } } : {}),
      },
    }),
    '.morrow/recent.json': JSON.stringify({ version: 1, opened: {}, activity: {} }),
  };
}

async function openFixture(vault?: CountingMemoryVault): Promise<Fixture> {
  const fixtureVault = vault ?? new CountingMemoryVault(fixtureFiles());
  const id = ++fixtureSequence;
  const opened = await WorkspaceSession.open(
    new VaultRepository(fixtureVault, () => 'unexpected-text-page-' + id + '-' + ++generatedPageSequence),
    { delayMs: 60_000 },
  );
  if (!opened.ok) throw new Error(opened.error);
  const session = opened.value;
  setSession(session);
  const fixture: Fixture = {
    vault: fixtureVault,
    session,
    data: null as unknown as DataApi,
    cleanups: new Set(),
    textPatchCalls: 0,
    checkboxPatchCalls: 0,
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

async function openCheckboxFixture(initial: CheckboxFixtureValue): Promise<Fixture> {
  return openFixture(new CountingMemoryVault(fixtureFiles(true, initial)));
}

async function openGridNavigationFixture(): Promise<Fixture> {
  return openFixture(new CountingMemoryVault(fixtureFiles(false, false, true)));
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
    readonly window?: Window;
    readonly viewId?: string;
    readonly locale?: DatabaseProviderContext['locale'];
    readonly editable?: boolean;
    readonly mountState?: ProviderMountState;
    readonly snapshotTransform?: (snapshot: DataApiSnapshot) => DataApiSnapshot;
    readonly viewSnapshotTransform?: (snapshot: LinkedViewSnapshot) => LinkedViewSnapshot;
    readonly openPage?: (pageId: string) => void;
  } = {},
): MountedRoot {
  const window = options.window ?? new Window({ url: 'http://morrow.test/' });
  if (!options.window) windows.push(window);
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
    ...(scope.api.patchCheckboxCell
      ? {
          patchCheckboxCell(input) {
            fixture.checkboxPatchCalls += 1;
            return scope.api.patchCheckboxCell!(input);
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
  const providerView: LinkedViewApi | undefined = view
    ? {
        ...view.api,
        snapshot() {
          const snapshot = view.api.snapshot();
          return options.viewSnapshotTransform?.(snapshot) ?? snapshot;
        },
      }
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
    ...(providerView ? { view: providerView } : {}),
  };
  const cleanup = mountPolarisDados(context, undefined, options.openPage);
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

type CellKeydownOptions = Omit<KeyboardEventInit, 'view'> & {
  readonly altGraph?: boolean;
  readonly keyCode?: number;
};

function dispatchCellKeydown(
  root: MountedRoot,
  target: HTMLElement,
  options: CellKeydownOptions,
): KeyboardEvent {
  const { altGraph, keyCode, ...keyboardOptions } = options;
  const event = new root.window.KeyboardEvent('keydown', {
    ...keyboardOptions,
    bubbles: true,
    cancelable: true,
  });
  if (altGraph !== undefined) {
    Object.defineProperty(event, 'getModifierState', {
      value: (key: string) => key === 'AltGraph' && altGraph,
    });
  }
  if (keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: keyCode });
  target.dispatchEvent(event as unknown as Event);
  return event as unknown as KeyboardEvent;
}

function dispatchFocusedCellKeydown(root: MountedRoot, options: CellKeydownOptions): KeyboardEvent {
  const target = root.window.document.activeElement;
  if (!(target instanceof root.window.HTMLElement)) throw new Error('Expected a focused grid target.');
  return dispatchCellKeydown(root, target as unknown as HTMLElement, options);
}

function focusedElement(window: Window): HTMLElement | null {
  return window.document.activeElement as unknown as HTMLElement | null;
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
  it('requires the connected cell button to be the focused, unconsumed key target', async () => {
    const fixture = await openFixture();
    const root = mountRoot(fixture);
    const button = editButton(root.element, 'message');
    const otherButton = editButton(root.element, 'empty');

    otherButton.focus();
    const unfocused = dispatchCellKeydown(root, button, { key: 'u' });
    expect(unfocused.defaultPrevented).toBe(false);
    expect(root.element.querySelector('textarea[data-field="message"]')).toBeNull();

    button.focus();
    const child = button.querySelector<HTMLElement>('[data-value-kind]');
    if (!child) throw new Error('The text button did not render its cell value.');
    const redirected = dispatchCellKeydown(root, child, { key: 'c' });
    expect(redirected.defaultPrevented).toBe(false);
    expect(root.element.querySelector('textarea[data-field="message"]')).toBeNull();

    const consumeInCapture = (event: KeyboardEvent) => event.preventDefault();
    root.element.addEventListener('keydown', consumeInCapture, true);
    const consumed = dispatchCellKeydown(root, button, { key: 'p' });
    root.element.removeEventListener('keydown', consumeInCapture, true);
    expect(consumed.defaultPrevented).toBe(true);
    expect(root.element.querySelector('textarea[data-field="message"]')).toBeNull();

    button.remove();
    const removed = dispatchCellKeydown(root, button, { key: 'r' });
    expect(removed.defaultPrevented).toBe(false);
    expect(root.element.querySelector('textarea[data-field="message"]')).toBeNull();
  });

  it('starts the existing source and linked text drafts from one printable key and preserves CAS history', async () => {
    const fixture = await openFixture();
    const source = mountRoot(fixture);
    const linked = mountRoot(fixture, { viewId: VIEW_ONE });
    const roots = [source, linked];
    const originalRowBytes = fixture.vault.text(ROW_PATH);
    const originalLinkedHostBytes = fixture.vault.text(NOTE_PATH);
    const initialWrites = fixture.vault.applyCount;

    const sourceButton = editButton(source.element, 'message');
    sourceButton.focus();
    const sourceKey = dispatchCellKeydown(source, sourceButton, { key: 'A' });
    const sourceEditor = source.element.querySelector<HTMLTextAreaElement>('textarea[data-field="message"]');
    expect(sourceKey.defaultPrevented).toBe(true);
    expect(sourceEditor?.value).toBe('A');
    expect(sourceEditor?.selectionStart).toBe(1);
    expect(source.window.document.activeElement).toBe(sourceEditor);
    cancelButton(source.element).click();

    const clickButton = editButton(source.element, 'message');
    clickButton.focus();
    const enter = dispatchCellKeydown(source, clickButton, { key: 'Enter' });
    expect(enter.defaultPrevented).toBe(false);
    expect(source.element.querySelector('textarea[data-field="message"]')).toBeNull();
    clickButton.click();
    expect(source.element.querySelector<HTMLTextAreaElement>('textarea[data-field="message"]')?.value).toBe(
      '  opening 🌿\nsecond line\nlast  ',
    );
    cancelButton(source.element).click();

    const spaceButton = editButton(source.element, 'empty');
    spaceButton.focus();
    const space = dispatchCellKeydown(source, spaceButton, { key: ' ' });
    const spaceEditor = source.element.querySelector<HTMLTextAreaElement>('textarea[data-field="empty"]');
    expect(space.defaultPrevented).toBe(true);
    expect(spaceEditor?.value).toBe(' ');
    expect(spaceEditor?.selectionStart).toBe(1);
    cancelButton(source.element).click();

    const unicodeButton = editButton(source.element, 'empty');
    unicodeButton.focus();
    const unicode = dispatchCellKeydown(source, unicodeButton, { key: '🌱' });
    const unicodeEditor = source.element.querySelector<HTMLTextAreaElement>('textarea[data-field="empty"]');
    expect(unicode.defaultPrevented).toBe(true);
    expect(unicodeEditor?.value).toBe('🌱');
    expect(unicodeEditor?.selectionStart).toBe(2);
    cancelButton(source.element).click();

    const linkedButton = editButton(linked.element, 'message');
    linkedButton.focus();
    const ctrlAlt = dispatchCellKeydown(linked, linkedButton, {
      key: '@',
      ctrlKey: true,
      altKey: true,
      altGraph: false,
    });
    expect(ctrlAlt.defaultPrevented).toBe(false);
    expect(linked.element.querySelector('textarea[data-field="message"]')).toBeNull();

    for (const options of [
      { key: 'Dead' },
      { key: 'Process' },
      { key: 'a', keyCode: 229 },
      { key: 'a', isComposing: true },
    ]) {
      const composing = dispatchCellKeydown(linked, linkedButton, options);
      expect(composing.defaultPrevented).toBe(false);
      expect(linked.element.querySelector('textarea[data-field="message"]')).toBeNull();
    }

    const altGraph = dispatchCellKeydown(linked, linkedButton, {
      key: '@',
      ctrlKey: true,
      altKey: true,
      altGraph: true,
    });
    const linkedEditor = linked.element.querySelector<HTMLTextAreaElement>('textarea[data-field="message"]');
    expect(altGraph.defaultPrevented).toBe(true);
    expect(linkedEditor?.value).toBe('@');
    expect(linkedEditor?.selectionStart).toBe(1);
    expect(linked.window.document.activeElement).toBe(linkedEditor);
    expect(rowProperties(fixture).message).toBe(INITIAL_MESSAGE);
    expect(fixture.textPatchCalls).toBe(0);
    expect(fixture.vault.applyCount).toBe(initialWrites);
    expect(fixture.vault.text(ROW_PATH)).toBe(originalRowBytes);
    expect(fixture.vault.text(NOTE_PATH)).toBe(originalLinkedHostBytes);

    saveButton(linked.element).click();
    await until('the seeded linked-view text to update both surfaces', () =>
      roots.every((root) => fieldValue(root.element, 'message').text === '@'),
    );
    await waitForSaved(linked.element);
    expect(rowProperties(fixture).message).toBe('@');
    expect(fixture.textPatchCalls).toBe(1);
    expect(fixture.vault.applyCount).toBe(initialWrites + 1);
    expect(fixture.vault.text(NOTE_PATH)).toBe(originalLinkedHostBytes);
    expect(fixture.data.snapshot(DATABASE_ID as PageId)).toMatchObject({
      status: 'ready',
      history: { canUndo: true, canRedo: false },
    });

    const undo = new linked.window.KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    linked.element.dispatchEvent(undo as unknown as Event);
    expect(undo.defaultPrevented).toBe(true);
    await until('one undo to restore the exact original text', () =>
      roots.every((root) => fieldValue(root.element, 'message').text === INITIAL_MESSAGE),
    );
    await waitForSaved(linked.element);
    expect(rowProperties(fixture).message).toBe(INITIAL_MESSAGE);
    expect(fixture.vault.text(NOTE_PATH)).toBe(originalLinkedHostBytes);
    expect(fixture.data.snapshot(DATABASE_ID as PageId)).toMatchObject({
      status: 'ready',
      history: { canUndo: false, canRedo: true },
    });

    const redo = new linked.window.KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    linked.element.dispatchEvent(redo as unknown as Event);
    expect(redo.defaultPrevented).toBe(true);
    await until('redo to restore the seeded text in both surfaces', () =>
      roots.every((root) => fieldValue(root.element, 'message').text === '@'),
    );
    await waitForSaved(linked.element);
    const persistedBytes = fixture.vault.text(ROW_PATH);
    expect(fixture.vault.text(NOTE_PATH)).toBe(originalLinkedHostBytes);
    for (const root of roots) root.unmount();
    await fixture.close();
    fixtures.delete(fixture);

    const reopened = await openFixture(fixture.vault);
    expect(reopened.vault.text(ROW_PATH)).toBe(persistedBytes);
    expect(reopened.vault.text(NOTE_PATH)).toBe(originalLinkedHostBytes);
    expect(rowProperties(reopened).message).toBe('@');
  });

  it('does not consume a first key for a stale cell, a read-only cell, or another control', async () => {
    const fixture = await openFixture();
    const staleRoot = mountRoot(fixture);
    const staleButton = editButton(staleRoot.element, 'message');
    const beforeExternalPatch = fixture.data.snapshot(DATABASE_ID as PageId);
    if (beforeExternalPatch.status !== 'ready') throw new Error('The test database was not ready.');
    const externalPatch = fixture.data.patchTextCell?.({
      databaseId: DATABASE_ID as PageId,
      rowId: ROW_ID as PageId,
      propertyId: 'message',
      value: 'External update',
      expectedRevision: beforeExternalPatch.revision,
    });
    expect(externalPatch?.status).toBe('staged');
    await fixture.data.flush(DATABASE_ID as PageId);
    const externalRowBytes = fixture.vault.text(ROW_PATH);
    const writesAfterExternalPatch = fixture.vault.applyCount;

    staleButton.focus();
    const staleKey = dispatchCellKeydown(staleRoot, staleButton, { key: 's' });
    expect(staleKey.defaultPrevented).toBe(false);
    expect(staleRoot.element.querySelector('textarea[data-field="message"]')).toBeNull();
    expect(fixture.textPatchCalls).toBe(0);
    expect(fixture.vault.applyCount).toBe(writesAfterExternalPatch);
    expect(fixture.vault.text(ROW_PATH)).toBe(externalRowBytes);

    let readonly = false;
    const readonlyRoot = mountRoot(fixture, {
      snapshotTransform(snapshot) {
        return snapshot.status === 'ready' && readonly ? { ...snapshot, readonly: true } : snapshot;
      },
    });
    const readonlyButton = editButton(readonlyRoot.element, 'message');
    readonly = true;
    readonlyButton.focus();
    const readonlyKey = dispatchCellKeydown(readonlyRoot, readonlyButton, { key: 'r' });
    expect(readonlyKey.defaultPrevented).toBe(false);
    expect(readonlyRoot.element.querySelector('textarea[data-field="message"]')).toBeNull();
    expect(fixture.textPatchCalls).toBe(0);
    expect(fixture.vault.applyCount).toBe(writesAfterExternalPatch);
    expect(fixture.vault.text(ROW_PATH)).toBe(externalRowBytes);

    const numberButton = editButton(staleRoot.element, 'quantity');
    numberButton.focus();
    const wrongTarget = dispatchCellKeydown(staleRoot, numberButton, { key: 'n' });
    expect(wrongTarget.defaultPrevented).toBe(false);
    expect(staleRoot.element.querySelector('textarea[data-field="message"]')).toBeNull();
    expect(staleRoot.element.querySelector('input[data-field="quantity"]')).toBeNull();
    const outsideKey = dispatchCellKeydown(staleRoot, staleRoot.element, { key: 'o' });
    expect(outsideKey.defaultPrevented).toBe(false);
    expect(staleRoot.element.querySelector('textarea[data-field="message"]')).toBeNull();

    staleRoot.unmount();
    readonlyRoot.unmount();
  });

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

  it('confirms source and linked text drafts with Ctrl/Meta+Enter and returns shortcut focus to the cell', async () => {
    const fixture = await openFixture();
    const source = mountRoot(fixture);
    const firstView = mountRoot(fixture, { viewId: VIEW_ONE });
    const secondView = mountRoot(fixture, { viewId: VIEW_TWO });
    const roots = [source, firstView, secondView];
    const ctrlValue = 'committed by Ctrl+Enter';
    const ctrlEditor = openEditor(source.element, 'message') as HTMLTextAreaElement;
    ctrlEditor.value = ctrlValue;
    dispatchInput(source, ctrlEditor);
    const ctrlEnter = new source.window.KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    ctrlEditor.dispatchEvent(ctrlEnter as unknown as Event);
    expect(ctrlEnter.defaultPrevented).toBe(true);
    await waitForSaved(source.element);
    await until('the Ctrl+Enter text to reach each source and linked view', () =>
      roots.every((root) => fieldValue(root.element, 'message').text === ctrlValue),
    );
    expect(rowProperties(fixture).message).toBe(ctrlValue);
    expect(fixture.textPatchCalls).toBe(1);
    expect(source.window.document.activeElement).toBe(editButton(source.element, 'message'));

    const undo = new source.window.KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    source.element.dispatchEvent(undo as unknown as Event);
    expect(undo.defaultPrevented).toBe(true);
    await until('undo to restore the value before Ctrl+Enter', () =>
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
    await until('redo to restore the Ctrl+Enter text', () =>
      roots.every((root) => fieldValue(root.element, 'message').text === ctrlValue),
    );
    await waitForSaved(source.element);

    const metaValue = 'committed by Meta+Enter';
    const metaEditor = openEditor(firstView.element, 'message') as HTMLTextAreaElement;
    metaEditor.value = metaValue;
    dispatchInput(firstView, metaEditor);
    const metaEnter = new firstView.window.KeyboardEvent('keydown', {
      key: 'Enter',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    metaEditor.dispatchEvent(metaEnter as unknown as Event);
    expect(metaEnter.defaultPrevented).toBe(true);
    await waitForSaved(firstView.element);
    await until('the Meta+Enter text to reach each source and linked view', () =>
      roots.every((root) => fieldValue(root.element, 'message').text === metaValue),
    );
    expect(rowProperties(fixture).message).toBe(metaValue);
    expect(fixture.textPatchCalls).toBe(2);
    expect(firstView.window.document.activeElement).toBe(editButton(firstView.element, 'message'));

    const persistedBytes = fixture.vault.text(ROW_PATH);
    if (persistedBytes === undefined) throw new Error('The shortcut edit was not persisted.');
    for (const root of roots) root.unmount();
    await fixture.close();
    fixtures.delete(fixture);

    const reopened = await openFixture(fixture.vault);
    expect(reopened.vault.text(ROW_PATH)).toBe(persistedBytes);
    expect(rowProperties(reopened).message).toBe(metaValue);
  });

  it('revokes shortcut focus return after a later pointer or keyboard interaction during flush', async () => {
    const runHeldShortcut = async (interaction: 'pointer' | 'keyboard') => {
      const fixture = await openFixture();
      let releaseFlush!: () => void;
      const flushGate = new Promise<void>((resolve) => {
        releaseFlush = resolve;
      });
      const realFlush = fixture.data.flush.bind(fixture.data);
      fixture.data = {
        ...fixture.data,
        async flush(databaseId) {
          await flushGate;
          return realFlush(databaseId);
        },
      };
      const root = mountRoot(fixture);
      const editor = openEditor(root.element, 'message') as HTMLTextAreaElement;
      editor.value = 'saved without delayed focus theft';
      dispatchInput(root, editor);
      const confirm = new root.window.KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(confirm as unknown as Event);
      expect(confirm.defaultPrevented).toBe(true);
      await until('the Ctrl+Enter flush to wait on its gate', () =>
        /saving/i.test(root.element.querySelector('[data-current-notice]')?.textContent ?? ''),
      );

      if (interaction === 'pointer') {
        const panel = root.window.document.createElement('div');
        root.window.document.body.append(panel);
        panel.dispatchEvent(new root.window.Event('pointerdown', { bubbles: true }));
      } else {
        root.window.document.body.dispatchEvent(
          new root.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
        );
      }
      root.element.querySelector<HTMLTextAreaElement>('textarea[data-field="message"]')?.blur();
      expect(root.window.document.activeElement).toBe(root.window.document.body);
      releaseFlush();
      await waitForSaved(root.element);
      expect(rowProperties(fixture).message).toBe('saved without delayed focus theft');
      expect(root.window.document.activeElement).toBe(root.window.document.body);
      if (interaction === 'pointer') {
        root.window.document.dispatchEvent(new root.window.Event('pointerup', { bubbles: true }));
        root.window.document.dispatchEvent(new root.window.Event('click', { bubbles: true }));
      }
    };

    await runHeldShortcut('pointer');
    await runHeldShortcut('keyboard');
  });

  it('commits only a valid external blur and preserves Cancel, tab, composition, and unmount boundaries', async () => {
    const fixture = await openFixture();
    const root = mountRoot(fixture);
    const originalBytes = fixture.vault.text(ROW_PATH);
    const initialWrites = fixture.vault.applyCount;

    const canceledEditor = openEditor(root.element, 'message') as HTMLTextAreaElement;
    canceledEditor.value = 'cancelled by button';
    dispatchInput(root, canceledEditor);
    const cancel = cancelButton(root.element);
    cancel.focus();
    expect(fixture.textPatchCalls).toBe(0);
    cancel.click();
    expect(root.element.querySelector('textarea[data-field="message"]')).toBeNull();
    expect(fixture.vault.text(ROW_PATH)).toBe(originalBytes);

    const outside = root.window.document.createElement('button');
    outside.textContent = 'Outside editor';
    root.window.document.body.append(outside);
    const beforeCancelEditor = openEditor(root.element, 'message') as HTMLTextAreaElement;
    beforeCancelEditor.value = 'cancel wins before deferred blur';
    dispatchInput(root, beforeCancelEditor);
    outside.focus();
    cancelButton(root.element).click();
    await settle();
    expect(fixture.textPatchCalls).toBe(0);
    expect(fixture.vault.text(ROW_PATH)).toBe(originalBytes);

    const tab = root.window.document.createElement('div');
    tab.setAttribute('role', 'tab');
    tab.tabIndex = 0;
    root.window.document.body.append(tab);
    const tabDraft = openEditor(root.element, 'message') as HTMLTextAreaElement;
    tabDraft.value = 'not saved while changing tabs';
    dispatchInput(root, tabDraft);
    tab.focus();
    await settle();
    expect(root.window.document.activeElement).toBe(tab);
    expect(root.element.querySelector('textarea[data-field="message"]')).toBe(tabDraft);
    expect(fixture.textPatchCalls).toBe(0);
    expect(fixture.vault.text(ROW_PATH)).toBe(originalBytes);
    cancelButton(root.element).click();

    const composingEditor = openEditor(root.element, 'message') as HTMLTextAreaElement;
    composingEditor.value = 'draft during composition';
    dispatchInput(root, composingEditor);
    composingEditor.dispatchEvent(
      new root.window.CompositionEvent('compositionstart', { bubbles: true }) as unknown as Event,
    );
    const composingEnter = new root.window.KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    composingEditor.dispatchEvent(composingEnter as unknown as Event);
    expect(composingEnter.defaultPrevented).toBe(false);
    expect(fixture.textPatchCalls).toBe(0);
    expect(root.element.querySelector('textarea[data-field="message"]')).toBe(composingEditor);
    composingEditor.dispatchEvent(
      new root.window.CompositionEvent('compositionend', { bubbles: true }) as unknown as Event,
    );
    cancelButton(root.element).click();

    const teardownEditor = openEditor(root.element, 'message') as HTMLTextAreaElement;
    teardownEditor.value = 'draft during teardown';
    dispatchInput(root, teardownEditor);
    root.unmount();
    await settle();
    expect(fixture.textPatchCalls).toBe(0);
    expect(fixture.vault.applyCount).toBe(initialWrites);
    expect(fixture.vault.text(ROW_PATH)).toBe(originalBytes);

    const blurFixture = await openFixture();
    const blurRoot = mountRoot(blurFixture);
    const externalControl = blurRoot.window.document.createElement('button');
    externalControl.textContent = 'Outside editor';
    blurRoot.window.document.body.append(externalControl);
    const blurEditor = openEditor(blurRoot.element, 'message') as HTMLTextAreaElement;
    const blurValue = 'committed after real blur';
    blurEditor.value = blurValue;
    dispatchInput(blurRoot, blurEditor);
    externalControl.focus();
    expect(blurRoot.window.document.activeElement).toBe(externalControl);
    await waitForSaved(blurRoot.element);
    await until('the blurred text to persist', () => rowProperties(blurFixture).message === blurValue);
    expect(blurFixture.textPatchCalls).toBe(1);
    expect(blurRoot.window.document.activeElement).toBe(externalControl);
  });

  it('waits for pointer activation before blur commit and preserves a focusable favorite toggle', async () => {
    const favoriteFixture = await openFixture();
    const favoriteRoot = mountRoot(favoriteFixture);
    const favorite = favoriteRoot.window.document.createElement('button');
    favorite.setAttribute('aria-pressed', 'false');
    favorite.textContent = 'Favorite';
    favoriteRoot.window.document.body.append(favorite);
    favorite.addEventListener('click', () => favorite.setAttribute('aria-pressed', 'true'));
    const favoriteEditor = openEditor(favoriteRoot.element, 'message') as HTMLTextAreaElement;
    favoriteEditor.value = 'saved after favorite activation';
    dispatchInput(favoriteRoot, favoriteEditor);
    favorite.dispatchEvent(new favoriteRoot.window.Event('pointerdown', { bubbles: true }));
    favorite.focus();
    await settle();
    expect(favoriteFixture.textPatchCalls).toBe(0);
    favorite.dispatchEvent(new favoriteRoot.window.Event('pointerup', { bubbles: true }));
    favorite.click();
    await waitForSaved(favoriteRoot.element);
    expect(favoriteFixture.textPatchCalls).toBe(1);
    expect(favorite.getAttribute('aria-pressed')).toBe('true');
    expect(favoriteRoot.window.document.activeElement).toBe(favorite);

    const navigationFixture = await openFixture();
    const navigationRoot = mountRoot(navigationFixture);
    const originalBytes = navigationFixture.vault.text(ROW_PATH);
    const historyControls = navigationRoot.window.document.createElement('span');
    historyControls.className = 'history-buttons';
    const navigationButton = navigationRoot.window.document.createElement('button');
    navigationButton.textContent = 'Navigate';
    historyControls.append(navigationButton);
    navigationRoot.window.document.body.append(historyControls);
    const navigationEditor = openEditor(navigationRoot.element, 'message') as HTMLTextAreaElement;
    navigationEditor.value = 'must not save before navigation';
    dispatchInput(navigationRoot, navigationEditor);
    navigationButton.focus();
    await settle();
    expect(navigationFixture.textPatchCalls).toBe(0);
    navigationRoot.element.querySelector<HTMLTextAreaElement>('textarea[data-field="message"]')?.focus();
    navigationButton.dispatchEvent(new navigationRoot.window.Event('pointerdown', { bubbles: true }));
    navigationButton.focus();
    await settle();
    expect(navigationFixture.textPatchCalls).toBe(0);
    expect(navigationFixture.vault.text(ROW_PATH)).toBe(originalBytes);
    navigationButton.dispatchEvent(new navigationRoot.window.Event('pointerup', { bubbles: true }));
    navigationButton.addEventListener('click', navigationRoot.unmount);
    navigationButton.click();
    await settle();
    expect(navigationFixture.textPatchCalls).toBe(0);
    expect(navigationFixture.vault.text(ROW_PATH)).toBe(originalBytes);
  });

  it('retains the draft when a treeitem opens another tab and the connected host becomes cached', async () => {
    const fixture = await openFixture();
    const root = mountRoot(fixture);
    const document = root.window.document;
    const originalBytes = fixture.vault.text(ROW_PATH);
    if (!root.element.parentElement) throw new Error('The provider host needs its fixture container.');

    const pane = document.createElement('section');
    pane.className = 'pane is-active';
    pane.dataset.pane = 'main';
    pane.dataset.paneId = 'tab-a';
    pane.dataset.tabInstance = 'tab-a';
    root.element.remove();
    pane.append(root.element as unknown as typeof pane);
    document.body.append(pane);

    const tree = document.createElement('div');
    tree.setAttribute('role', 'tree');
    const treeItem = document.createElement('div');
    treeItem.className = 'tree-row';
    treeItem.setAttribute('role', 'treeitem');
    treeItem.setAttribute('aria-selected', 'false');
    treeItem.setAttribute('data-page-id', 'other-note');
    treeItem.tabIndex = 0;
    tree.append(treeItem);
    document.body.append(tree);

    const nextPane = document.createElement('section');
    nextPane.className = 'pane is-active';
    nextPane.dataset.pane = 'main';
    nextPane.dataset.paneId = 'tab-b';
    nextPane.dataset.tabInstance = 'tab-b';
    treeItem.addEventListener('click', () => {
      pane.classList.remove('is-active');
      pane.classList.add('is-cached');
      pane.style.display = 'none';
      pane.setAttribute('aria-hidden', 'true');
      pane.inert = true;
      pane.removeAttribute('data-pane');
      pane.removeAttribute('data-pane-id');
      document.body.append(nextPane);
    });

    const editor = openEditor(root.element, 'message') as HTMLTextAreaElement;
    editor.value = 'retain this draft in the cached tab';
    dispatchInput(root, editor);
    treeItem.dispatchEvent(new root.window.Event('pointerdown', { bubbles: true }));
    treeItem.focus();
    await settle();
    expect(fixture.textPatchCalls).toBe(0);
    treeItem.dispatchEvent(new root.window.Event('pointerup', { bubbles: true }));
    treeItem.click();
    await settle();

    expect(pane.isConnected).toBe(true);
    expect(root.element.isConnected).toBe(true);
    expect(pane.classList.contains('is-cached')).toBe(true);
    expect(pane.inert).toBe(true);
    expect(document.activeElement).toBe(treeItem);
    expect(root.element.querySelector<HTMLTextAreaElement>('textarea[data-field="message"]')?.value).toBe(
      'retain this draft in the cached tab',
    );
    expect(fixture.textPatchCalls).toBe(0);
    expect(fixture.vault.text(ROW_PATH)).toBe(originalBytes);

    nextPane.remove();
    pane.classList.remove('is-cached');
    pane.classList.add('is-active');
    pane.style.display = '';
    pane.removeAttribute('aria-hidden');
    pane.inert = false;
    pane.dataset.pane = 'main';
    pane.dataset.paneId = 'tab-a';
    const resumedEditor = root.element.querySelector<HTMLTextAreaElement>('textarea[data-field="message"]');
    expect(resumedEditor?.value).toBe('retain this draft in the cached tab');
    expect(fixture.textPatchCalls).toBe(0);
    resumedEditor?.focus();
    saveButton(root.element).click();
    await waitForSaved(root.element);
    expect(fixture.textPatchCalls).toBe(1);
    expect(rowProperties(fixture).message).toBe('retain this draft in the cached tab');
  });

  it('commits when focus leaves the whole text editor after tabbing through Save and Cancel', async () => {
    const fixture = await openFixture();
    const root = mountRoot(fixture);
    const outside = root.window.document.createElement('button');
    root.window.document.body.append(outside);
    const editor = openEditor(root.element, 'message') as HTMLTextAreaElement;
    editor.value = 'saved after leaving the editor group';
    dispatchInput(root, editor);

    saveButton(root.element).focus();
    cancelButton(root.element).focus();
    outside.focus();
    await waitForSaved(root.element);
    expect(fixture.textPatchCalls).toBe(1);
    expect(rowProperties(fixture).message).toBe('saved after leaving the editor group');
    expect(root.window.document.activeElement).toBe(outside);
  });

  it('does not confirm during IME composition and saves after composition ends on an external focus target', async () => {
    const fixture = await openFixture();
    const root = mountRoot(fixture);
    const outside = root.window.document.createElement('button');
    root.window.document.body.append(outside);
    const editor = openEditor(root.element, 'message') as HTMLTextAreaElement;
    editor.value = 'saved after composition ended';
    dispatchInput(root, editor);
    editor.dispatchEvent(
      new root.window.CompositionEvent('compositionstart', { bubbles: true }) as unknown as Event,
    );
    const composingEnter = new root.window.KeyboardEvent('keydown', {
      key: 'Enter',
      metaKey: true,
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    editor.dispatchEvent(composingEnter as unknown as Event);
    expect(composingEnter.defaultPrevented).toBe(false);
    expect(fixture.textPatchCalls).toBe(0);
    editor.dispatchEvent(
      new root.window.CompositionEvent('compositionend', { bubbles: true }) as unknown as Event,
    );
    outside.focus();
    await waitForSaved(root.element);
    expect(fixture.textPatchCalls).toBe(1);
    expect(rowProperties(fixture).message).toBe('saved after composition ended');
    expect(root.window.document.activeElement).toBe(outside);
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

  it('edits a mixed checkbox through the registered React source and two TipTap views, with history and reopen', async () => {
    let fixture = await openCheckboxFixture('missing');
    let contexts: DatabaseProviderContext[] = [];
    const unregister = registerLiveProvider(fixture, contexts);
    let live = mountLiveReactPage(fixture);
    await live.render();
    let roots = await waitForLiveProviderRoots(contexts);
    const patchSpy = vi.spyOn(fixture.session, 'patchPilotDataCell');
    const originalBytes = fixture.vault.text(ROW_PATH);
    const originalWrites = fixture.vault.applyCount;

    expect(fieldValue(roots.source, 'flag')).toEqual({ kind: 'missing', text: 'Missing' });
    expect(fieldValue(roots.firstView, 'flag')).toEqual({ kind: 'missing', text: 'Missing' });
    expect(fieldValue(roots.secondView, 'flag')).toEqual({ kind: 'missing', text: 'Missing' });

    editButton(roots.source, 'flag').click();
    const checkbox = roots.source.querySelector<HTMLInputElement>(
      'input[type="checkbox"][data-field="flag"]',
    );
    expect(checkbox).not.toBeNull();
    if (!checkbox) throw new Error('The native checkbox editor was not mounted.');
    expect(checkbox.type).toBe('checkbox');
    expect(checkbox.indeterminate).toBe(true);
    expect(checkbox.checked).toBe(false);
    expect(checkbox.getAttribute('aria-label')).toContain('Flag');
    expect(
      roots.source.ownerDocument.getElementById(checkbox.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toContain('choose a value before saving');
    const untouchedSave = saveButton(roots.source);
    expect(untouchedSave.disabled).toBe(true);
    // Simulate a click already queued before the disabled state reached the control.
    untouchedSave.disabled = false;
    untouchedSave.click();
    expect(patchSpy).not.toHaveBeenCalled();
    expect(fixture.vault.applyCount).toBe(originalWrites);
    expect(fixture.vault.text(ROW_PATH)).toBe(originalBytes);
    untouchedSave.disabled = true;
    checkbox.focus();
    expect(roots.source.ownerDocument.activeElement).toBe(checkbox);
    const space = new roots.source.ownerDocument.defaultView!.KeyboardEvent('keydown', {
      key: ' ',
      bubbles: true,
      cancelable: true,
    });
    checkbox.dispatchEvent(space as unknown as Event);
    expect(space.defaultPrevented).toBe(false);
    checkbox.click();
    expect(checkbox.checked).toBe(true);
    expect(saveButton(roots.source).disabled).toBe(false);
    const checkboxStatus = roots.source.ownerDocument.getElementById(
      checkbox.getAttribute('aria-describedby') ?? '',
    );
    expect(checkboxStatus?.textContent).toContain('True');
    expect(patchSpy).not.toHaveBeenCalled();
    checkbox.click();
    expect(checkbox.checked).toBe(false);
    expect(checkbox.indeterminate).toBe(false);
    expect(patchSpy).not.toHaveBeenCalled();
    expect(fixture.vault.applyCount).toBe(originalWrites);
    expect(fixture.vault.text(ROW_PATH)).toBe(originalBytes);

    saveButton(roots.source).click();
    await waitForSaved(roots.source);
    await until('the explicit false checkbox value to reach all provider mounts', () => {
      const activeRoots = activeLiveProviderRoots(contexts);
      return (
        activeRoots !== null &&
        [activeRoots.source, activeRoots.firstView, activeRoots.secondView].every(
          (root) => fieldValue(root, 'flag').text === 'False',
        )
      );
    });
    expect(rowProperties(fixture).flag).toBe(false);
    expect(patchSpy).toHaveBeenCalledOnce();
    expect(fixture.vault.applyCount).toBe(originalWrites + 1);
    expect(fixture.vault.text(ROW_PATH)).toContain('Flag: false');

    const undo = new roots.source.ownerDocument.defaultView!.KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    roots.source.dispatchEvent(undo as unknown as Event);
    expect(undo.defaultPrevented).toBe(true);
    await until('checkbox undo to restore absence in all provider mounts', () => {
      const activeRoots = activeLiveProviderRoots(contexts);
      return (
        activeRoots !== null &&
        [activeRoots.source, activeRoots.firstView, activeRoots.secondView].every(
          (root) => fieldValue(root, 'flag').kind === 'missing',
        )
      );
    });
    await waitForSaved(roots.source);

    const redo = new roots.source.ownerDocument.defaultView!.KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    roots.source.dispatchEvent(redo as unknown as Event);
    expect(redo.defaultPrevented).toBe(true);
    await until('checkbox redo to restore false in all provider mounts', () => {
      const activeRoots = activeLiveProviderRoots(contexts);
      return (
        activeRoots !== null &&
        [activeRoots.source, activeRoots.firstView, activeRoots.secondView].every(
          (root) => fieldValue(root, 'flag').text === 'False',
        )
      );
    });
    await waitForSaved(roots.source);
    expect(rowProperties(fixture).flag).toBe(false);
    expect(patchSpy).toHaveBeenCalledOnce();
    expect(fixture.vault.text(ROW_PATH)).toContain('Flag: false');

    const vault = fixture.vault;
    patchSpy.mockRestore();
    await live.unmount();
    unregister();
    await fixture.close();
    fixtures.delete(fixture);

    fixture = await openFixture(vault);
    contexts = [];
    registerLiveProvider(fixture, contexts);
    live = mountLiveReactPage(fixture);
    await live.render();
    roots = await waitForLiveProviderRoots(contexts);
    expect(rowProperties(fixture).flag).toBe(false);
    expect(fieldValue(roots.source, 'flag')).toEqual({ kind: 'boolean', text: 'False' });
    expect(fieldValue(roots.firstView, 'flag')).toEqual({ kind: 'boolean', text: 'False' });
    expect(fieldValue(roots.secondView, 'flag')).toEqual({ kind: 'boolean', text: 'False' });
  });

  it('keeps missing and null checkbox values unchanged on Cancel or Escape, including after owner reload', async () => {
    for (const initial of ['missing', null] as const) {
      const fixture = await openCheckboxFixture(initial);
      const mountState = createProviderMountState();
      transientMountStates.add(mountState);
      const locale = initial === 'missing' ? 'pt' : 'es';
      let root = mountRoot(fixture, { locale, mountState });
      const originalBytes = fixture.vault.text(ROW_PATH);
      const originalWrites = fixture.vault.applyCount;
      const checkbox = openEditor(root.element, 'flag') as HTMLInputElement;
      expect(checkbox.type).toBe('checkbox');
      expect(checkbox.indeterminate).toBe(true);
      expect(checkbox.getAttribute('aria-describedby')).not.toBeNull();
      const statusId = checkbox.getAttribute('aria-describedby');
      const status = statusId ? root.window.document.getElementById(statusId)?.textContent : '';
      expect(status).toContain(initial === 'missing' ? 'ausente' : 'nulo');
      const serialized = JSON.parse(root.transientState?.read() ?? 'null') as {
        version?: number;
        kind?: string;
        initialValue?: { kind?: string };
      } | null;
      expect(serialized).toMatchObject({
        version: 2,
        kind: 'checkbox',
        initialValue: { kind: initial === 'missing' ? 'missing' : 'null' },
      });

      if (initial === 'missing') {
        const escape = new root.window.KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        });
        checkbox.dispatchEvent(escape as unknown as Event);
        expect(escape.defaultPrevented).toBe(true);
      } else {
        cancelButton(root.element).click();
      }
      expect(root.element.querySelector('input[type="checkbox"][data-field="flag"]')).toBeNull();
      expect(root.transientState?.read()).toBeUndefined();
      expect(fixture.checkboxPatchCalls).toBe(0);
      expect(fixture.vault.text(ROW_PATH)).toBe(originalBytes);
      expect(fixture.vault.applyCount).toBe(originalWrites);
      const value = rowProperties(fixture);
      expect(Object.hasOwn(value, 'flag')).toBe(initial !== 'missing');
      expect(value.flag).toBe(initial === 'missing' ? undefined : null);

      root.unmount();
      root = mountRoot(fixture, { locale, mountState });
      expect(root.element.querySelector('input[type="checkbox"][data-field="flag"]')).toBeNull();
      expect(root.element.querySelector('button[data-action="edit"][data-field="flag"]')).not.toBeNull();
      expect(root.transientState?.read()).toBeUndefined();
      expect(fixture.checkboxPatchCalls).toBe(0);
      root.unmount();
      await fixture.close();
      fixtures.delete(fixture);
    }
  });

  it('restores distinct checkbox drafts per source/view slot and keeps stale choices readable and cancelable', async () => {
    const fixture = await openCheckboxFixture(false);
    const states = [createProviderMountState(), createProviderMountState(), createProviderMountState()];
    for (const state of states) transientMountStates.add(state);
    const [sourceState, firstState, secondState] = states;
    if (!sourceState || !firstState || !secondState) throw new Error('The mount states were not created.');
    const createRoots = (): MountedRoot[] => [
      mountRoot(fixture, { mountState: sourceState }),
      mountRoot(fixture, { viewId: VIEW_ONE, mountState: firstState }),
      mountRoot(fixture, { viewId: VIEW_TWO, mountState: secondState }),
    ];
    let roots = createRoots();
    const originalBytes = fixture.vault.text(ROW_PATH);
    const targetChoices = [true, false, true];
    roots.forEach((root, index) => {
      const checkbox = openEditor(root.element, 'flag') as HTMLInputElement;
      checkbox.focus();
      if (targetChoices[index]) checkbox.click();
    });
    const stored = roots.map(
      (root) =>
        JSON.parse(root.transientState?.read() ?? 'null') as {
          version?: number;
          kind?: string;
          checked?: boolean;
          phase?: string;
        } | null,
    );
    expect(stored).toEqual([
      expect.objectContaining({ version: 2, kind: 'checkbox', checked: true, phase: 'editing' }),
      expect.objectContaining({ version: 2, kind: 'checkbox', checked: false, phase: 'editing' }),
      expect.objectContaining({ version: 2, kind: 'checkbox', checked: true, phase: 'editing' }),
    ]);
    expect(fixture.checkboxPatchCalls).toBe(0);
    expect(fixture.vault.text(ROW_PATH)).toBe(originalBytes);
    roots.forEach((root) => root.unmount());

    roots = createRoots();
    roots.forEach((root, index) => {
      const checkbox = root.element.querySelector<HTMLInputElement>(
        'input[type="checkbox"][data-field="flag"]',
      );
      expect(checkbox?.checked).toBe(targetChoices[index]);
      expect(checkbox?.disabled).toBe(false);
      expect(root.window.document.activeElement).toBe(checkbox);
      expect(saveButton(root.element).disabled).toBe(false);
      expect(cancelButton(root.element).disabled).toBe(false);
    });

    const beforeExternalPatch = fixture.data.snapshot(DATABASE_ID as PageId);
    if (beforeExternalPatch.status !== 'ready') throw new Error('The checkbox database was not ready.');
    expect(
      fixture.data.patchCheckboxCell?.({
        databaseId: DATABASE_ID as PageId,
        rowId: ROW_ID as PageId,
        propertyId: 'flag',
        value: true,
        expectedRevision: beforeExternalPatch.revision,
      }),
    ).toMatchObject({ status: 'staged' });
    await fixture.data.flush(DATABASE_ID as PageId);
    for (const root of roots) {
      const checkbox = root.element.querySelector<HTMLInputElement>(
        'input[type="checkbox"][data-field="flag"]',
      );
      expect(checkbox?.disabled).toBe(true);
      expect(checkbox?.checked).toBe(targetChoices[roots.indexOf(root)]);
      const statusId = checkbox?.getAttribute('aria-describedby');
      expect(statusId ? root.window.document.getElementById(statusId)?.textContent : '').toContain('Draft:');
      expect(saveButton(root.element).disabled).toBe(true);
      expect(cancelButton(root.element).disabled).toBe(false);
    }
    expect(rowProperties(fixture).flag).toBe(true);
    expect(fixture.checkboxPatchCalls).toBe(0);
    for (const root of roots) {
      cancelButton(root.element).click();
      expect(root.element.querySelector('input[type="checkbox"][data-field="flag"]')).toBeNull();
      expect(root.transientState?.read()).toBeUndefined();
    }
    expect(rowProperties(fixture).flag).toBe(true);
    expect(fixture.checkboxPatchCalls).toBe(0);
  });

  it('retries only the flush when a real session observer aborts after accepting the checkbox patch', async () => {
    const fixture = await openCheckboxFixture(false);
    const mountState = createProviderMountState();
    transientMountStates.add(mountState);
    let root = mountRoot(fixture, { mountState });
    const initialBytes = fixture.vault.text(ROW_PATH);
    const initialApplyCount = fixture.vault.applyCount;
    const patchSpy = vi.spyOn(fixture.session, 'patchPilotDataCell');
    const flushSpy = vi.spyOn(fixture.session, 'flush');
    let didUnmount = false;
    const unsubscribe = fixture.session.subscribe(() => {
      if (didUnmount || rowProperties(fixture).flag !== true) return;
      didUnmount = true;
      root.unmount();
    });

    try {
      const checkbox = openEditor(root.element, 'flag') as HTMLInputElement;
      checkbox.click();
      expect(fixture.checkboxPatchCalls).toBe(0);
      expect(fixture.vault.text(ROW_PATH)).toBe(initialBytes);
      saveButton(root.element).click();
      expect(didUnmount).toBe(true);
      expect(patchSpy).toHaveBeenCalledOnce();
      expect(flushSpy).not.toHaveBeenCalled();
      expect(fixture.checkboxPatchCalls).toBe(1);
      expect(rowProperties(fixture).flag).toBe(true);
      expect(fixture.vault.text(ROW_PATH)).toBe(initialBytes);
      const staged = fixture.data.snapshot(DATABASE_ID as PageId);
      expect(staged.status).toBe('ready');
      if (staged.status !== 'ready') throw new Error('The staged checkbox snapshot was not ready.');
      expect(staged.history.canUndo).toBe(true);

      root = mountRoot(fixture, { mountState, locale: 'es' });
      const restored = JSON.parse(root.transientState?.read() ?? 'null') as {
        version?: number;
        kind?: string;
        phase?: string;
        checked?: boolean;
      } | null;
      expect(restored).toMatchObject({
        version: 2,
        kind: 'checkbox',
        phase: 'pending-flush',
        checked: true,
      });
      expect(root.element.querySelector('input[type="checkbox"][data-field="flag"]')).toBeNull();
      const retry = root.element.querySelector<HTMLButtonElement>('button[data-action="retry"]');
      expect(retry).not.toBeNull();
      expect(retry?.disabled).toBe(false);
      retry?.click();
      await waitForSaved(root.element);
      expect(patchSpy).toHaveBeenCalledOnce();
      expect(flushSpy).toHaveBeenCalledOnce();
      expect(fixture.checkboxPatchCalls).toBe(1);
      const afterRetry = fixture.data.snapshot(DATABASE_ID as PageId);
      expect(afterRetry.status).toBe('ready');
      if (afterRetry.status !== 'ready') throw new Error('The retried checkbox snapshot was not ready.');
      expect(afterRetry.history.canUndo).toBe(true);
      expect(fixture.vault.applyCount).toBe(initialApplyCount + 1);
      expect(fixture.vault.text(ROW_PATH)).not.toBe(initialBytes);
      expect(root.transientState?.read()).toBeUndefined();

      const vault = fixture.vault;
      root.unmount();
      await fixture.close();
      fixtures.delete(fixture);
      const reopened = await openFixture(vault);
      expect(rowProperties(reopened).flag).toBe(true);
      expect(reopened.vault.text(ROW_PATH)).toContain('Flag: true');
    } finally {
      unsubscribe();
      patchSpy.mockRestore();
      flushSpy.mockRestore();
    }
  });

  it('leaves text and checkbox cells readonly on an older host while preserving number editing', () => {
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
          { id: 'flag', name: 'Flag', type: 'checkbox', options: [] },
        ],
        views: [],
      },
      rows: [
        {
          id: ROW_ID as PageId,
          title: 'Widget',
          properties: { message: 'keep me', quantity: 1, flag: true },
        },
      ],
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
    expect(root.querySelector('button[data-action="edit"][data-field="flag"]')).toBeNull();
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

describe('Polaris Dados four-arrow grid navigation', () => {
  it('keeps linked navigation moving inside a noneditable embed under an editor', async () => {
    const fixture = await openGridNavigationFixture();
    const window = new Window({ url: 'http://morrow.test/' });
    windows.push(window);
    const linkedView = mountRoot(fixture, { viewId: VIEW_ONE, window });
    const editor = window.document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const embed = window.document.createElement('div');
    embed.setAttribute('contenteditable', 'false');
    window.document.body.append(editor);
    editor.append(embed);
    embed.append(linkedView.element as never);

    linkedView.element.focus();
    const enter = dispatchFocusedCellKeydown(linkedView, { key: 'ArrowLeft' });
    const titleCell = linkedView.element.querySelector<HTMLTableCellElement>(
      `tr[data-row-id="${SECOND_ROW_ID}"] td[data-row-title]`,
    );
    expect(enter.defaultPrevented).toBe(true);
    expect(focusedElement(window)).toBe(titleCell);

    const move = dispatchFocusedCellKeydown(linkedView, { key: 'ArrowRight' });
    expect(move.defaultPrevented).toBe(true);
    expect(focusedElement(window)).toBe(
      linkedView.element.querySelector(`tr[data-row-id="${SECOND_ROW_ID}"] td[data-field="total"]`),
    );
  });

  it('restores source and linked formula or title focus after external Markdown updates', async () => {
    const fixture = await openGridNavigationFixture();
    const window = new Window({ url: 'http://morrow.test/' });
    windows.push(window);
    const source = mountRoot(fixture, { window });
    const filteredView = mountRoot(fixture, { viewId: VIEW_ONE, window });
    const orderedView = mountRoot(fixture, { viewId: VIEW_TWO, window });

    const firstRow = fixture.vault.text(ROW_PATH);
    if (!firstRow) throw new Error('The source row is missing from the navigation fixture.');
    const sourceTotal = source.element.querySelector<HTMLTableCellElement>(
      `tr[data-row-id="${ROW_ID}"] td[data-field="total"]`,
    );
    if (!sourceTotal) throw new Error('The source formula cell did not render.');
    sourceTotal.focus();
    fixture.vault.external({ [ROW_PATH]: firstRow.replace('Price: 10', 'Price: 19') });
    await until('the externally changed source formula to keep focus', () => {
      const snapshot = fixture.data.snapshot(DATABASE_ID as PageId);
      return (
        snapshot.status === 'ready' &&
        snapshot.rows.find((row) => row.id === ROW_ID)?.properties.price === 19 &&
        focusedElement(window) ===
          source.element.querySelector(`tr[data-row-id="${ROW_ID}"] td[data-field="total"]`)
      );
    });

    const secondRow = fixture.vault.text(SECOND_ROW_PATH);
    if (!secondRow) throw new Error('The filtered row is missing from the navigation fixture.');
    const linkedTotal = filteredView.element.querySelector<HTMLTableCellElement>(
      `tr[data-row-id="${SECOND_ROW_ID}"] td[data-field="total"]`,
    );
    if (!linkedTotal) throw new Error('The linked formula cell did not render.');
    linkedTotal.focus();
    fixture.vault.external({ [SECOND_ROW_PATH]: secondRow.replace('Price: 4', 'Price: 7') });
    await until('the externally changed linked formula to keep focus', () => {
      const snapshot = fixture.data.snapshot(DATABASE_ID as PageId);
      return (
        snapshot.status === 'ready' &&
        snapshot.rows.find((row) => row.id === SECOND_ROW_ID)?.properties.price === 7 &&
        focusedElement(window) ===
          filteredView.element.querySelector(`tr[data-row-id="${SECOND_ROW_ID}"] td[data-field="total"]`)
      );
    });
    const next = dispatchFocusedCellKeydown(filteredView, { key: 'ArrowRight' });
    expect(next.defaultPrevented).toBe(true);
    expect(focusedElement(window)).toBe(
      filteredView.element.querySelector(
        `button[data-action="edit"][data-row-id="${SECOND_ROW_ID}"][data-field="message"]`,
      ),
    );

    const updatedSecondRow = fixture.vault.text(SECOND_ROW_PATH);
    if (!updatedSecondRow) throw new Error('The updated row is missing from the navigation fixture.');
    const linkedTitle = filteredView.element.querySelector<HTMLTableCellElement>(
      `tr[data-row-id="${SECOND_ROW_ID}"] td[data-row-title]`,
    );
    if (!linkedTitle) throw new Error('The linked title cell did not render.');
    linkedTitle.focus();
    fixture.vault.external({ [SECOND_ROW_PATH]: updatedSecondRow.replace('Price: 7', 'Price: 8') });
    await until('the externally changed linked title to keep focus', () => {
      const snapshot = fixture.data.snapshot(DATABASE_ID as PageId);
      return (
        snapshot.status === 'ready' &&
        snapshot.rows.find((row) => row.id === SECOND_ROW_ID)?.properties.price === 8 &&
        focusedElement(window) ===
          filteredView.element.querySelector(`tr[data-row-id="${SECOND_ROW_ID}"] td[data-row-title]`)
      );
    });
    expect(orderedView.element.querySelector('table')).not.toBeNull();
  });

  it('restores formula and title focus across a full linked refilter, then returns to the region when rows vanish', async () => {
    const fixture = await openGridNavigationFixture();
    const window = new Window({ url: 'http://morrow.test/' });
    windows.push(window);
    const linkedView = mountRoot(fixture, { viewId: VIEW_ONE, window });
    const otherView = mountRoot(fixture, { viewId: VIEW_TWO, window });

    const otherFormula = otherView.element.querySelector<HTMLTableCellElement>(
      `tr[data-row-id="${SECOND_ROW_ID}"] td[data-field="total"]`,
    );
    if (!otherFormula) throw new Error('The other linked formula cell did not render.');
    otherFormula.focus();
    const initialTable = linkedView.element.querySelector('table');
    const originalNote = fixture.vault.text(NOTE_PATH);
    if (!originalNote) throw new Error('The linked view note is missing from the navigation fixture.');
    fixture.vault.external({ [NOTE_PATH]: markdownForGridNavigationViews(['message', 'total']) });
    await until('a full refilter to leave focus in the other linked view', () => {
      const snapshot = linkedView.viewApi?.snapshot();
      return (
        snapshot?.status === 'ready' &&
        snapshot.config.columnOrder.join(',') === 'message,total' &&
        linkedView.element.querySelector('table') !== initialTable &&
        focusedElement(window) ===
          otherView.element.querySelector(`tr[data-row-id="${SECOND_ROW_ID}"] td[data-field="total"]`)
      );
    });

    const titleCell = linkedView.element.querySelector<HTMLTableCellElement>(
      `tr[data-row-id="${SECOND_ROW_ID}"] td[data-row-title]`,
    );
    if (!titleCell) throw new Error('The linked title cell did not render.');
    titleCell.focus();
    const reorderedTable = linkedView.element.querySelector('table');
    fixture.vault.external({ [NOTE_PATH]: originalNote });
    await until('the externally reordered view to restore title focus', () => {
      const snapshot = linkedView.viewApi?.snapshot();
      return (
        snapshot?.status === 'ready' &&
        snapshot.config.columnOrder.join(',') === 'total,message' &&
        linkedView.element.querySelector('table') !== reorderedTable &&
        focusedElement(window) ===
          linkedView.element.querySelector(`tr[data-row-id="${SECOND_ROW_ID}"] td[data-row-title]`)
      );
    });

    const formulaCell = linkedView.element.querySelector<HTMLTableCellElement>(
      `tr[data-row-id="${SECOND_ROW_ID}"] td[data-field="total"]`,
    );
    if (!formulaCell) throw new Error('The reordered linked formula cell did not render.');
    formulaCell.focus();
    const formulaTable = linkedView.element.querySelector('table');
    fixture.vault.external({ [NOTE_PATH]: markdownForGridNavigationViews(['message', 'total']) });
    await until('the externally restored view order to restore formula focus', () => {
      const snapshot = linkedView.viewApi?.snapshot();
      return (
        snapshot?.status === 'ready' &&
        snapshot.config.columnOrder.join(',') === 'message,total' &&
        linkedView.element.querySelector('table') !== formulaTable &&
        focusedElement(window) ===
          linkedView.element.querySelector(`tr[data-row-id="${SECOND_ROW_ID}"] td[data-field="total"]`)
      );
    });

    const focusedFormula = linkedView.element.querySelector<HTMLTableCellElement>(
      `tr[data-row-id="${SECOND_ROW_ID}"] td[data-field="total"]`,
    );
    if (!focusedFormula) throw new Error('The linked formula cell did not render before refiltering.');
    focusedFormula.focus();
    fixture.vault.external({ [NOTE_PATH]: markdownForGridNavigationViews(['total', 'message'], 6) });
    await until('the full refilter to send missing formula focus to its region', () => {
      const snapshot = linkedView.viewApi?.snapshot();
      return (
        snapshot?.status === 'ready' &&
        snapshot.config.filter?.value === 6 &&
        linkedView.element.querySelectorAll('tbody tr').length === 0 &&
        focusedElement(window) === linkedView.element
      );
    });

    fixture.vault.external({ [NOTE_PATH]: markdownForGridNavigationViews(['total', 'message'], 3) });
    await until(
      'the row to return after restoring the filter',
      () => linkedView.element.querySelector(`tr[data-row-id="${SECOND_ROW_ID}"]`) !== null,
    );
    const restoredTitle = linkedView.element.querySelector<HTMLTableCellElement>(
      `tr[data-row-id="${SECOND_ROW_ID}"] td[data-row-title]`,
    );
    if (!restoredTitle) throw new Error('The restored linked title cell did not render.');
    restoredTitle.focus();
    fixture.vault.external({ [NOTE_PATH]: markdownForGridNavigationViews(['total', 'message'], 6) });
    await until('the full refilter to send missing title focus to its region', () => {
      const snapshot = linkedView.viewApi?.snapshot();
      return (
        snapshot?.status === 'ready' &&
        snapshot.config.filter?.value === 6 &&
        linkedView.element.querySelectorAll('tbody tr').length === 0 &&
        focusedElement(window) === linkedView.element
      );
    });
  });

  it('uses the source and each linked view order, reaches readonly cells, and preserves seeded text confirmation', async () => {
    const fixture = await openGridNavigationFixture();
    const window = new Window({ url: 'http://morrow.test/' });
    windows.push(window);
    const source = mountRoot(fixture, { window });
    const filteredView = mountRoot(fixture, { viewId: VIEW_ONE, window });
    const orderedView = mountRoot(fixture, { viewId: VIEW_TWO, window });
    const rowBytes = fixture.vault.text(SECOND_ROW_PATH);
    const viewBytes = fixture.vault.text(NOTE_PATH);
    if (rowBytes === undefined || viewBytes === undefined)
      throw new Error('The navigation fixture is incomplete.');
    const initialApplyCount = fixture.vault.applyCount;

    const rowIds = (root: MountedRoot) =>
      [...root.element.querySelectorAll<HTMLTableRowElement>('tbody tr')].map((row) => row.dataset.rowId);
    expect(rowIds(source)).toEqual([ROW_ID, SECOND_ROW_ID]);
    expect(rowIds(filteredView)).toEqual([SECOND_ROW_ID]);
    expect(rowIds(orderedView)).toEqual([ROW_ID, SECOND_ROW_ID]);
    expect(filteredView.element.querySelector('thead th[data-column-id="total"]')).not.toBeNull();
    expect(orderedView.element.querySelector('thead th[data-column-id="price"]')).not.toBeNull();
    expect(source.element.tabIndex).toBe(0);
    expect(
      [...source.element.querySelectorAll('td')].every((cell) => (cell as HTMLElement).tabIndex === -1),
    ).toBe(true);

    const sourceMessage = source.element.querySelector<HTMLButtonElement>(
      `button[data-action="edit"][data-row-id="${ROW_ID}"][data-field="message"]`,
    );
    const sourceEmpty = source.element.querySelector<HTMLButtonElement>(
      `button[data-action="edit"][data-row-id="${ROW_ID}"][data-field="empty"]`,
    );
    if (!sourceMessage || !sourceEmpty) throw new Error('The source text cells did not render edit buttons.');

    source.element.focus();
    const unfocusedTarget = dispatchCellKeydown(source, sourceMessage, { key: 'ArrowRight' });
    expect(unfocusedTarget.defaultPrevented).toBe(false);
    expect(window.document.activeElement).toBe(source.element);
    const legacyComposition = dispatchFocusedCellKeydown(source, { key: 'ArrowRight', keyCode: 229 });
    expect(legacyComposition.defaultPrevented).toBe(false);
    expect(window.document.activeElement).toBe(source.element);
    const firstSourceArrow = dispatchFocusedCellKeydown(source, { key: 'ArrowLeft' });
    expect(firstSourceArrow.defaultPrevented).toBe(true);
    expect(window.document.activeElement).toBe(sourceMessage);

    const modifiedArrow = dispatchFocusedCellKeydown(source, { key: 'ArrowRight', shiftKey: true });
    expect(modifiedArrow.defaultPrevented).toBe(false);
    expect(window.document.activeElement).toBe(sourceMessage);
    const nextSourceCell = dispatchFocusedCellKeydown(source, { key: 'ArrowRight' });
    expect(nextSourceCell.defaultPrevented).toBe(true);
    expect(window.document.activeElement).toBe(sourceEmpty);
    dispatchFocusedCellKeydown(source, { key: 'ArrowLeft' });
    expect(window.document.activeElement).toBe(sourceMessage);
    dispatchFocusedCellKeydown(source, { key: 'ArrowUp' });
    expect(window.document.activeElement).toBe(sourceMessage);
    dispatchFocusedCellKeydown(source, { key: 'ArrowDown' });
    expect(window.document.activeElement).toBe(
      source.element.querySelector(
        `button[data-action="edit"][data-row-id="${SECOND_ROW_ID}"][data-field="message"]`,
      ),
    );
    dispatchFocusedCellKeydown(source, { key: 'ArrowUp' });
    expect(window.document.activeElement).toBe(sourceMessage);
    for (let column = 0; column < 6; column += 1) {
      dispatchFocusedCellKeydown(source, { key: 'ArrowRight' });
    }
    const sourceFormulaCell = source.element.querySelector<HTMLTableCellElement>(
      `tr[data-row-id="${ROW_ID}"] td[data-field="total"]`,
    );
    expect(sourceFormulaCell).not.toBeNull();
    expect(sourceFormulaCell?.tabIndex).toBe(-1);
    expect(window.document.activeElement).toBe(sourceFormulaCell);
    dispatchFocusedCellKeydown(source, { key: 'ArrowDown' });
    expect(window.document.activeElement).toBe(
      source.element.querySelector(`tr[data-row-id="${SECOND_ROW_ID}"] td[data-field="total"]`),
    );
    const bottomBoundary = dispatchFocusedCellKeydown(source, { key: 'ArrowDown' });
    expect(bottomBoundary.defaultPrevented).toBe(true);
    expect(window.document.activeElement).toBe(
      source.element.querySelector(`tr[data-row-id="${SECOND_ROW_ID}"] td[data-field="total"]`),
    );

    filteredView.element.focus();
    dispatchFocusedCellKeydown(filteredView, { key: 'ArrowDown' });
    const filteredTitleCell = filteredView.element.querySelector<HTMLTableCellElement>(
      `tr[data-row-id="${SECOND_ROW_ID}"] td[data-row-title]`,
    );
    expect(window.document.activeElement).toBe(filteredTitleCell);
    dispatchFocusedCellKeydown(filteredView, { key: 'ArrowRight' });
    const filteredTotalCell = filteredView.element.querySelector<HTMLTableCellElement>(
      `tr[data-row-id="${SECOND_ROW_ID}"] td[data-field="total"]`,
    );
    expect(window.document.activeElement).toBe(filteredTotalCell);
    dispatchFocusedCellKeydown(filteredView, { key: 'ArrowRight' });
    expect(window.document.activeElement).toBe(
      filteredView.element.querySelector(
        `button[data-action="edit"][data-row-id="${SECOND_ROW_ID}"][data-field="message"]`,
      ),
    );
    expect(source.element.querySelector('table')).not.toBeNull();
    expect(orderedView.element.querySelector('table')).not.toBeNull();

    orderedView.element.focus();
    dispatchFocusedCellKeydown(orderedView, { key: 'ArrowUp' });
    expect(window.document.activeElement).toBe(
      orderedView.element.querySelector(`tr[data-row-id="${ROW_ID}"] td[data-row-title]`),
    );
    dispatchFocusedCellKeydown(orderedView, { key: 'ArrowRight' });
    expect(window.document.activeElement).toBe(
      orderedView.element.querySelector(
        `button[data-action="edit"][data-row-id="${ROW_ID}"][data-field="price"]`,
      ),
    );
    dispatchFocusedCellKeydown(orderedView, { key: 'ArrowRight' });
    dispatchFocusedCellKeydown(orderedView, { key: 'ArrowDown' });
    const secondRowMessage = orderedView.element.querySelector<HTMLButtonElement>(
      `button[data-action="edit"][data-row-id="${SECOND_ROW_ID}"][data-field="message"]`,
    );
    expect(window.document.activeElement).toBe(secondRowMessage);

    expect(fixture.textPatchCalls).toBe(0);
    expect(fixture.vault.applyCount).toBe(initialApplyCount);
    expect(fixture.vault.text(SECOND_ROW_PATH)).toBe(rowBytes);
    expect(fixture.vault.text(NOTE_PATH)).toBe(viewBytes);
    const seeded = dispatchFocusedCellKeydown(orderedView, { key: 'X' });
    const editor = orderedView.element.querySelector<HTMLTextAreaElement>(
      `textarea[data-row-id="${SECOND_ROW_ID}"][data-field="message"]`,
    );
    expect(seeded.defaultPrevented).toBe(true);
    expect(editor?.value).toBe('X');
    expect(editor?.selectionStart).toBe(1);
    expect(window.document.activeElement).toBe(editor);
    expect(fixture.textPatchCalls).toBe(0);
    expect(fixture.vault.applyCount).toBe(initialApplyCount);

    const caretArrow = dispatchFocusedCellKeydown(orderedView, { key: 'ArrowLeft' });
    expect(caretArrow.defaultPrevented).toBe(false);
    expect(window.document.activeElement).toBe(editor);
    expect(fixture.textPatchCalls).toBe(0);
    expect(fixture.vault.applyCount).toBe(initialApplyCount);

    const confirm = dispatchFocusedCellKeydown(orderedView, { key: 'Enter', ctrlKey: true });
    expect(confirm.defaultPrevented).toBe(true);
    await until('the arrow-reached text cell to save through Ctrl+Enter', () => {
      const snapshot = fixture.data.snapshot(DATABASE_ID as PageId);
      return (
        snapshot.status === 'ready' &&
        snapshot.rows.find((row) => row.id === SECOND_ROW_ID)?.properties.message === 'X'
      );
    });
    await waitForSaved(orderedView.element);
    expect(fixture.textPatchCalls).toBe(1);
    expect(fixture.vault.applyCount).toBe(initialApplyCount + 1);
    expect(fixture.vault.text(NOTE_PATH)).toBe(viewBytes);
  });

  it('enters a fully readonly or empty grid from its existing region tab stop', async () => {
    const fixture = await openFixture();
    const window = new Window({ url: 'http://morrow.test/' });
    windows.push(window);
    const readonly = mountRoot(fixture, { editable: false, window });
    const cell = readonly.element.querySelector<HTMLTableCellElement>(
      `tr[data-row-id="${ROW_ID}"] td[data-field="message"]`,
    );
    if (!cell) throw new Error('The readonly message cell did not render.');
    const disabledEdit = window.document.createElement('button');
    disabledEdit.type = 'button';
    disabledEdit.dataset.action = 'edit';
    disabledEdit.disabled = true;
    cell.append(disabledEdit as unknown as Node);
    readonly.element.focus();
    const readonlyEntry = dispatchFocusedCellKeydown(readonly, { key: 'ArrowDown' });
    expect(readonlyEntry.defaultPrevented).toBe(true);
    expect(window.document.activeElement).toBe(cell);
    expect(cell.tabIndex).toBe(-1);
    expect(readonly.element.tabIndex).toBe(0);

    const empty = mountRoot(fixture, {
      window,
      snapshotTransform: (snapshot) => (snapshot.status === 'ready' ? { ...snapshot, rows: [] } : snapshot),
    });
    empty.element.focus();
    const emptyGridArrow = dispatchFocusedCellKeydown(empty, { key: 'ArrowRight' });
    expect(emptyGridArrow.defaultPrevented).toBe(true);
    expect(empty.element.querySelectorAll('tbody tr')).toHaveLength(0);
    expect(window.document.activeElement).toBe(empty.element);
  });
});

describe('Polaris Dados linked-row open shortcut', () => {
  it('opens the focused visible row by stable ID across duplicate titles and readonly views without writing Markdown', async () => {
    const fixture = await openGridNavigationFixture();
    const window = new Window({ url: 'http://morrow.test/' });
    windows.push(window);
    const opened: string[] = [];
    const duplicateTitles = (snapshot: DataApiSnapshot): DataApiSnapshot =>
      snapshot.status === 'ready'
        ? { ...snapshot, rows: snapshot.rows.map((row) => ({ ...row, title: 'Same title' })) }
        : snapshot;
    const source = mountRoot(fixture, {
      window,
      snapshotTransform: duplicateTitles,
      openPage: (pageId) => opened.push(`source:${pageId}`),
    });
    const filteredView = mountRoot(fixture, {
      window,
      viewId: VIEW_ONE,
      snapshotTransform: duplicateTitles,
      openPage: (pageId) => opened.push(`filtered:${pageId}`),
    });
    const orderedView = mountRoot(fixture, {
      window,
      viewId: VIEW_TWO,
      snapshotTransform: duplicateTitles,
      openPage: (pageId) => opened.push(`ordered:${pageId}`),
    });
    const readonlyView = mountRoot(fixture, {
      window,
      viewId: VIEW_ONE,
      editable: false,
      snapshotTransform: duplicateTitles,
      openPage: (pageId) => opened.push(`readonly:${pageId}`),
    });
    const withoutApi = mountRoot(fixture, {
      window,
      viewId: VIEW_ONE,
      snapshotTransform: duplicateTitles,
    });
    const originalFiles = [ROW_PATH, SECOND_ROW_PATH, NOTE_PATH].map((path) => fixture.vault.text(path));
    const applyCount = fixture.vault.applyCount;

    expect(
      [...filteredView.element.querySelectorAll<HTMLTableRowElement>('tbody tr')].map(
        (row) => row.dataset.rowId,
      ),
    ).toEqual([SECOND_ROW_ID]);
    const filteredTitle = filteredView.element.querySelector<HTMLTableCellElement>(
      `tr[data-row-id="${SECOND_ROW_ID}"] td[data-row-title]`,
    );
    const orderedFirstTitle = orderedView.element.querySelector<HTMLTableCellElement>(
      `tr[data-row-id="${ROW_ID}"] td[data-row-title]`,
    );
    if (!filteredTitle || !orderedFirstTitle) throw new Error('The linked row titles did not render.');
    expect(filteredTitle.textContent).toBe(orderedFirstTitle.textContent);

    filteredTitle.focus();
    const filteredOpen = dispatchFocusedCellKeydown(filteredView, {
      key: 'Enter',
      altKey: true,
      altGraph: false,
    });
    expect(filteredOpen.defaultPrevented).toBe(true);
    expect(opened).toEqual([`filtered:${SECOND_ROW_ID}`]);

    orderedFirstTitle.focus();
    const orderedOpen = dispatchFocusedCellKeydown(orderedView, {
      key: 'Enter',
      altKey: true,
      altGraph: false,
    });
    expect(orderedOpen.defaultPrevented).toBe(true);
    expect(opened).toEqual([`filtered:${SECOND_ROW_ID}`, `ordered:${ROW_ID}`]);

    const readonlyTitle = readonlyView.element.querySelector<HTMLTableCellElement>(
      `tr[data-row-id="${SECOND_ROW_ID}"] td[data-row-title]`,
    );
    if (!readonlyTitle) throw new Error('The readonly linked title did not render.');
    readonlyTitle.focus();
    const readonlyOpen = dispatchFocusedCellKeydown(readonlyView, {
      key: 'Enter',
      altKey: true,
      altGraph: false,
    });
    expect(readonlyOpen.defaultPrevented).toBe(true);
    expect(opened).toEqual([`filtered:${SECOND_ROW_ID}`, `ordered:${ROW_ID}`, `readonly:${SECOND_ROW_ID}`]);

    const missingApiTitle = withoutApi.element.querySelector<HTMLTableCellElement>(
      `tr[data-row-id="${SECOND_ROW_ID}"] td[data-row-title]`,
    );
    if (!missingApiTitle) throw new Error('The fallback linked title did not render.');
    missingApiTitle.focus();
    const missingApiOpen = dispatchFocusedCellKeydown(withoutApi, {
      key: 'Enter',
      altKey: true,
      altGraph: false,
    });
    expect(missingApiOpen.defaultPrevented).toBe(false);
    expect(opened).toHaveLength(3);

    const sourceFormula = source.element.querySelector<HTMLTableCellElement>(
      `tr[data-row-id="${ROW_ID}"] td[data-field="total"]`,
    );
    if (!sourceFormula) throw new Error('The source formula cell did not render.');
    sourceFormula.focus();
    const sourceOpen = dispatchFocusedCellKeydown(source, { key: 'Enter', altKey: true, altGraph: false });
    expect(sourceOpen.defaultPrevented).toBe(false);
    expect(opened).toHaveLength(3);
    expect([ROW_PATH, SECOND_ROW_PATH, NOTE_PATH].map((path) => fixture.vault.text(path))).toEqual(
      originalFiles,
    );
    expect(fixture.vault.applyCount).toBe(applyCount);
    expect(fixture.textPatchCalls).toBe(0);
  });

  it('leaves extra modifiers, stale projections, drafts, composition, repeats, and consumed events alone', async () => {
    const fixture = await openGridNavigationFixture();
    const window = new Window({ url: 'http://morrow.test/' });
    windows.push(window);
    const opened: string[] = [];
    let filterExcludesSecond = false;
    let removeSecond = false;
    const root = mountRoot(fixture, {
      window,
      viewId: VIEW_ONE,
      openPage: (pageId) => opened.push(pageId),
      snapshotTransform(snapshot) {
        return snapshot.status === 'ready' && removeSecond
          ? { ...snapshot, rows: snapshot.rows.filter((row) => row.id !== SECOND_ROW_ID) }
          : snapshot;
      },
      viewSnapshotTransform(snapshot) {
        return snapshot.status === 'ready' && filterExcludesSecond
          ? {
              ...snapshot,
              config: { ...snapshot.config, filter: { propertyId: 'quantity', op: 'gte', value: 6 } },
            }
          : snapshot;
      },
    });
    const title = root.element.querySelector<HTMLTableCellElement>(
      `tr[data-row-id="${SECOND_ROW_ID}"] td[data-row-title]`,
    );
    if (!title) throw new Error('The linked title did not render.');

    root.element.focus();
    const unfocused = dispatchCellKeydown(root, title, { key: 'Enter', altKey: true, altGraph: false });
    expect(unfocused.defaultPrevented).toBe(false);
    expect(opened).toHaveLength(0);

    const formula = root.element.querySelector<HTMLTableCellElement>(
      `tr[data-row-id="${SECOND_ROW_ID}"] td[data-field="total"]`,
    );
    if (!formula) throw new Error('The linked formula did not render.');
    formula.focus();
    const otherCell = dispatchFocusedCellKeydown(root, { key: 'Enter', altKey: true, altGraph: false });
    expect(otherCell.defaultPrevented).toBe(false);
    expect(opened).toHaveLength(0);

    title.focus();
    for (const options of [
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { repeat: true },
      { isComposing: true },
      { keyCode: 229 },
      { altGraph: true },
    ]) {
      const ignored = dispatchCellKeydown(root, title, { key: 'Enter', altKey: true, ...options });
      expect(ignored.defaultPrevented).toBe(false);
      expect(opened).toHaveLength(0);
    }

    title.addEventListener('keydown', (event) => event.preventDefault(), { capture: true, once: true });
    const consumed = dispatchCellKeydown(root, title, { key: 'Enter', altKey: true, altGraph: false });
    expect(consumed.defaultPrevented).toBe(true);
    expect(opened).toHaveLength(0);

    filterExcludesSecond = true;
    title.focus();
    const filteredOut = dispatchCellKeydown(root, title, { key: 'Enter', altKey: true, altGraph: false });
    expect(filteredOut.defaultPrevented).toBe(false);
    expect(opened).toHaveLength(0);

    filterExcludesSecond = false;
    removeSecond = true;
    const removed = dispatchCellKeydown(root, title, { key: 'Enter', altKey: true, altGraph: false });
    expect(removed.defaultPrevented).toBe(false);
    expect(opened).toHaveLength(0);

    removeSecond = false;
    const editMessage = root.element.querySelector<HTMLButtonElement>(
      `button[data-action="edit"][data-row-id="${SECOND_ROW_ID}"][data-field="message"]`,
    );
    if (!editMessage) throw new Error('The linked text edit button did not render.');
    editMessage.click();
    const draftTitle = root.element.querySelector<HTMLTableCellElement>(
      `tr[data-row-id="${SECOND_ROW_ID}"] td[data-row-title]`,
    );
    if (!draftTitle) throw new Error('The linked title did not render during the draft.');
    draftTitle.focus();
    const duringDraft = dispatchCellKeydown(root, draftTitle, {
      key: 'Enter',
      altKey: true,
      altGraph: false,
    });
    expect(duringDraft.defaultPrevented).toBe(false);
    expect(opened).toHaveLength(0);
    root.element.querySelector<HTMLButtonElement>('button[data-action="cancel"]')?.click();
  });
});
