// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageId } from '../../../../src/core/model';
import { encodePolarisDadosViewMarker } from '../../../../src/core/polarisDadosView';
import type { PolarisDadosViewData } from '../../../../src/core/polarisDadosView';
import { E003_POLARIS_DADOS_FIXTURE } from '../../../../src/storage/fixtures/e003-polaris-dados';
import { MemoryVault } from '../../../../src/storage/memoryVault';
import { WorkspaceSession } from '../../../../src/storage/session';
import { VaultRepository } from '../../../../src/storage/vaultRepository';
import { createDataApi } from '../../../../src/app/plugins/dataApi';
import { createProviderDataScope } from '../../../../src/app/plugins/providerDataScope';
import {
  getDatabaseProvider,
  registerDatabaseProvider,
  registerMountedDatabaseProvider,
} from '../../../../src/app/plugins/providerRegistry';
import type { DatabaseProviderContext } from '../../../../src/app/plugins/providerApi';
import { createLinkedViewApi } from '../../../../src/app/plugins/linkedViewApi';
import type { LinkedViewApi } from '../../../../src/app/plugins/linkedViewApi';
import { undoRedo } from '../../../../src/app/editor/commits';
import { setSession } from '../../../../src/app/workspace';
import { mountPolarisDados } from './mount';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SOURCE_PATH = 'Inventory.md';
const ROW_PATH = 'Inventory/Widget.md';
const NOTE_PATH = 'Views.md';

interface FixtureOptions {
  readonly views?: readonly [PolarisDadosViewData, PolarisDadosViewData];
  readonly viewsForSource?: (
    sourceId: PageId,
    sequence: number,
  ) => readonly [PolarisDadosViewData, PolarisDadosViewData];
  readonly withRealRowTitleProperty?: boolean;
  readonly extraRows?: readonly {
    readonly slug: string;
    readonly name: string;
    readonly quantity?: number | null;
    readonly price: number;
  }[];
}

interface Fixture {
  readonly sourceId: PageId;
  readonly rowId: PageId;
  readonly noteId: PageId;
  readonly views: readonly [PolarisDadosViewData, PolarisDadosViewData];
  readonly vault: MemoryVault;
  readonly session: WorkspaceSession;
  readonly data: ReturnType<typeof createDataApi>;
  hostReadonly(): boolean;
  setHostReadonly(value: boolean): void;
  close(): Promise<void>;
}

interface ViewHandle {
  readonly api: LinkedViewApi;
  release(): void;
}

interface MountedRoot {
  readonly element: HTMLElement;
  readonly context: DatabaseProviderContext;
  readonly view?: ViewHandle;
  unmount(): void;
}

let fixtureCounter = 0;
const fixtures = new Set<Fixture>();
const mountedRoots = new Set<MountedRoot>();

function viewNote(views: readonly PolarisDadosViewData[]): string {
  return [
    '# Linked views',
    '',
    'Shared synthetic note.',
    '',
    ...views.flatMap((view, index) => [
      encodePolarisDadosViewMarker(view),
      ...(index < views.length - 1 ? ['', 'Between linked views.', ''] : []),
    ]),
    '',
  ].join('\n');
}

function defaultViews(
  sourceId: PageId,
  sequence: number,
): readonly [PolarisDadosViewData, PolarisDadosViewData] {
  return [
    {
      version: 1,
      viewId: `view-one-${sequence}`,
      sourceDatabaseId: sourceId,
      title: 'Primary stock',
      columnOrder: ['price', 'quantity'],
      filter: { propertyId: 'quantity', op: 'gte', value: 1 },
    },
    {
      version: 1,
      viewId: `view-two-${sequence}`,
      sourceDatabaseId: sourceId,
      title: 'Low stock',
      columnOrder: ['name'],
      filter: { propertyId: 'quantity', op: 'gte', value: 3 },
    },
  ];
}

async function openFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const sequence = ++fixtureCounter;
  const sourceId = `linked-source-${sequence}` as PageId;
  const rowId = `linked-row-${sequence}` as PageId;
  const noteId = `linked-note-${sequence}` as PageId;
  const views =
    options.views ?? options.viewsForSource?.(sourceId, sequence) ?? defaultViews(sourceId, sequence);
  let sourceText = E003_POLARIS_DADOS_FIXTURE[SOURCE_PATH]!;
  let rowText = E003_POLARIS_DADOS_FIXTURE[ROW_PATH]!.replace('Name: Widget', 'Name: Catalog label');
  if (options.withRealRowTitleProperty) {
    sourceText = sourceText.replace(
      '  views:\n',
      '    - id: row-title\n      name: Native title\n      type: number\n  views:\n',
    );
    rowText = rowText.replace('Price: 10', 'Price: 10\nNative title: 7');
  }
  const files: Record<string, string> = {
    [SOURCE_PATH]: sourceText,
    [ROW_PATH]: rowText,
    [NOTE_PATH]: viewNote(views),
  };
  const pages: Record<string, { id: string; created: number; order: number }> = {
    [SOURCE_PATH]: { id: sourceId, created: 1, order: 0 },
    [ROW_PATH]: { id: rowId, created: 2, order: 0 },
    [NOTE_PATH]: { id: noteId, created: 3, order: 1 },
  };
  options.extraRows?.forEach((row, index) => {
    const path = `Inventory/${row.slug}.md`;
    const quantity =
      row.quantity === undefined ? '' : `Quantity: ${row.quantity === null ? 'null' : row.quantity}\n`;
    pages[path] = { id: `linked-row-${sequence}-${row.slug}`, created: 4 + index, order: index + 1 };
    files[path] = `---\nName: ${row.name}\n${quantity}Price: ${row.price}\n---\nSynthetic ${row.slug} row.\n`;
  });
  files['.morrow/workspace.json'] = JSON.stringify({ version: 1, pages });
  files['.morrow/recent.json'] = JSON.stringify({ version: 1, opened: {}, activity: {} });
  const vault = new MemoryVault(files);
  let generatedId = 0;
  const opened = await WorkspaceSession.open(
    new VaultRepository(vault, () => `unexpected-linked-page-${++generatedId}`),
    { delayMs: 60_000 },
  );
  if (!opened.ok) throw new Error(opened.error);
  const session = opened.value;
  setSession(session);

  let ownerActive = true;
  let hostReadonly = false;
  const cleanups = new Set<() => void>();
  const data = createDataApi({
    session,
    ownerIsActive: () => ownerActive,
    isProviderActive: (databaseId) => ownerActive && databaseId === sourceId,
    isHostReadonly: () => hostReadonly,
    registerCleanup: (cleanup) => cleanups.add(cleanup),
  });
  const fixture: Fixture = {
    sourceId,
    rowId,
    noteId,
    views,
    vault,
    session,
    data,
    hostReadonly: () => hostReadonly,
    setHostReadonly: (value) => {
      hostReadonly = value;
    },
    async close() {
      ownerActive = false;
      for (const cleanup of [...cleanups]) cleanup();
      cleanups.clear();
      if (!session.isClosed) await session.close();
    },
  };
  fixtures.add(fixture);
  return fixture;
}

function makeViewHandle(fixture: Fixture, viewId: string, active: () => boolean): ViewHandle {
  const generation = Symbol(viewId);
  let cleanup = () => {};
  const api = createLinkedViewApi({
    session: fixture.session,
    pageId: fixture.noteId,
    viewId,
    sourceDatabaseId: fixture.sourceId,
    mountGeneration: generation,
    ownerIsActive: active,
    isMountGenerationActive: (candidate) => candidate === generation && active(),
    isHostReadonly: fixture.hostReadonly,
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
  } = {},
): MountedRoot {
  const element = document.createElement('div');
  document.body.append(element);
  const controller = new AbortController();
  const editable = options.editable ?? true;
  const scope = createProviderDataScope(fixture.data, fixture.sourceId, {
    isActive: () => !controller.signal.aborted,
    editable,
  });
  const view = options.viewId
    ? makeViewHandle(fixture, options.viewId, () => !controller.signal.aborted)
    : undefined;
  const context: DatabaseProviderContext = {
    element,
    databaseId: fixture.sourceId,
    data: scope.api,
    locale: options.locale ?? 'en',
    editable,
    signal: controller.signal,
    ...(view ? { view: view.api } : {}),
  };
  const cleanup = mountPolarisDados(context);
  const mounted: MountedRoot = {
    element,
    context,
    ...(view ? { view } : {}),
    unmount() {
      if (!controller.signal.aborted) controller.abort();
      cleanup();
      scope.dispose();
      view?.release();
      element.remove();
      mountedRoots.delete(mounted);
    },
  };
  mountedRoots.add(mounted);
  return mounted;
}

function tableHeaders(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLTableCellElement>('thead th')].map(
    (cell) => cell.textContent?.trim() ?? '',
  );
}

function rowElements(root: HTMLElement): HTMLTableRowElement[] {
  return [...root.querySelectorAll<HTMLTableRowElement>('tbody tr')];
}

function rowText(root: HTMLElement): string {
  return rowElements(root)
    .map((row) => row.textContent ?? '')
    .join('\n');
}

function cellText(root: HTMLElement, field: string): string | null {
  return (
    root.querySelector<HTMLTableCellElement>(`tbody td[data-field="${field}"]`)?.textContent?.trim() ?? null
  );
}

function setInputValue(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function dispatchKey(
  target: HTMLElement,
  key: string,
  options: { ctrlKey?: boolean; shiftKey?: boolean } = {},
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    ctrlKey: options.ctrlKey ?? false,
    shiftKey: options.shiftKey ?? false,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function until(description: string, predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function editButton(root: HTMLElement, field: string): HTMLButtonElement {
  const button = root.querySelector<HTMLButtonElement>(`button[data-action="edit"][data-field="${field}"]`);
  if (!button) throw new Error(`No editable cell exists for ${field}.`);
  return button;
}

function editCell(root: HTMLElement, field: string): HTMLInputElement {
  editButton(root, field).click();
  const input = root.querySelector<HTMLInputElement>(`input[data-field="${field}"]`);
  if (!input) throw new Error(`The ${field} input did not open.`);
  return input;
}

function action<T extends HTMLElement>(root: HTMLElement, name: string): T {
  const target = root.querySelector<T>(`[data-action="${name}"]`);
  if (!target) throw new Error(`No control matched data-action=${name}.`);
  return target;
}

function clickAction(root: HTMLElement, name: string): void {
  action<HTMLButtonElement>(root, name).click();
}

function settingsPanel(root: HTMLElement): HTMLElement {
  const panel = root.querySelector<HTMLElement>('[data-view-settings]');
  if (!panel) throw new Error('The linked-view settings panel is not open.');
  return panel;
}

function controlByLabel<T extends HTMLInputElement | HTMLSelectElement>(root: HTMLElement, text: string): T {
  const wanted = text.trim().toLocaleLowerCase();
  const label = [...root.querySelectorAll<HTMLLabelElement>('label')].find(
    (candidate) => candidate.textContent?.trim().toLocaleLowerCase() === wanted,
  );
  if (!label?.htmlFor) throw new Error(`No labeled control was found for ${text}.`);
  const control = root.querySelector<T>(`[id="${label.htmlFor}"]`);
  if (!control) throw new Error(`The label ${text} has no associated control.`);
  return control;
}

function priorityItem(root: HTMLElement, propertyName: string): HTMLElement {
  const list = root.querySelector<HTMLElement>('[data-view-priority-items]');
  const row = [...(list?.children ?? [])].find(
    (candidate) =>
      candidate.querySelector('[data-action="view-priority"]')?.textContent?.trim() === propertyName,
  );
  if (!(row instanceof HTMLElement)) throw new Error(`No column priority row exists for ${propertyName}.`);
  return row;
}

function priorityButton(root: HTMLElement, propertyName: string): HTMLButtonElement {
  const button = priorityItem(root, propertyName).querySelector<HTMLButtonElement>(
    'button[data-action="view-priority"]',
  );
  if (!button) throw new Error(`No priority toggle exists for ${propertyName}.`);
  return button;
}

function registerUndoMenuRoot(fixture: Fixture, root: MountedRoot): () => void {
  const suffix = String(fixtureCounter);
  const providerId = `polaris-dados-test-${suffix}`;
  const unregisterProvider = registerDatabaseProvider(
    `polaris-dados-independent-${suffix}`,
    () => true,
    fixture.data,
    { id: providerId, apiVersion: 1, mount: mountPolarisDados },
  );
  const provider = getDatabaseProvider(providerId);
  if (!provider) {
    unregisterProvider();
    throw new Error('The synthetic linked-view provider did not register.');
  }
  const unregisterRoot = registerMountedDatabaseProvider(provider, fixture.sourceId, root.element, () => {});
  if (!unregisterRoot) {
    unregisterProvider();
    throw new Error('The provider did not claim the linked-view root.');
  }
  return () => {
    unregisterRoot();
    unregisterProvider();
  };
}

function selectOptionByText(select: HTMLSelectElement, text: string): void {
  const option = [...select.options].find((candidate) => candidate.textContent?.trim() === text);
  if (!option) throw new Error(`No option was found with the visible label ${text}.`);
  select.value = option.value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function viewApi(root: MountedRoot): LinkedViewApi {
  if (!root.view) throw new Error('Expected a linked-view mount with a context.view API.');
  return root.view.api;
}

function readyView(api: LinkedViewApi): Extract<ReturnType<LinkedViewApi['snapshot']>, { status: 'ready' }> {
  const snapshot = api.snapshot();
  if (snapshot.status !== 'ready') throw new Error(`Expected a ready linked view, got ${snapshot.status}.`);
  return snapshot;
}

async function waitForStatus(root: HTMLElement, phrase: string, description = phrase): Promise<void> {
  await until(
    description,
    () => root.querySelector('[data-current-notice]')?.textContent?.includes(phrase) === true,
  );
}

afterEach(async () => {
  for (const root of [...mountedRoots]) root.unmount();
  for (const fixture of [...fixtures]) {
    await fixture.close();
    fixtures.delete(fixture);
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('Polaris Dados linked view UI with real host APIs', () => {
  it('keeps the source grid in G01 order while two linked roots share rows, formulas, and data history', async () => {
    const fixture = await openFixture();
    const source = mountRoot(fixture);
    const first = mountRoot(fixture, { viewId: fixture.views[0].viewId });
    const second = mountRoot(fixture, { viewId: fixture.views[1].viewId });

    expect(source.context.view).toBeUndefined();
    expect(readyView(viewApi(first)).config.title).toBe('Primary stock');
    expect(readyView(viewApi(second)).config.title).toBe('Low stock');
    expect(source.element.querySelector('[data-action="view-settings-toggle"]')).toBeNull();
    expect(first.element.querySelector('[data-view-title]')?.textContent).toBe('Primary stock');
    expect(second.element.querySelector('[data-view-title]')?.textContent).toBe('Low stock');
    expect(tableHeaders(source.element)).toEqual(['Name', 'Quantity', 'Price', 'Total']);
    expect(tableHeaders(first.element)).toEqual(['Row title', 'Price', 'Quantity', 'Name', 'Total']);
    expect(tableHeaders(second.element)).toEqual(['Row title', 'Name', 'Quantity', 'Price', 'Total']);
    expect(rowText(source.element)).toContain('Catalog label');
    expect(rowText(source.element)).not.toContain('Row title');
    expect(rowText(first.element)).toContain('Widget');
    expect(rowText(first.element)).toContain('Catalog label');
    expect(tableHeaders(source.element)).not.toContain('Row title');
    expect(cellText(source.element, 'total')).toBe('20');
    expect(cellText(first.element, 'total')).toBe('20');
    expect(rowElements(second.element)).toHaveLength(0);

    const quantity = editCell(source.element, 'quantity');
    setInputValue(quantity, '3');
    dispatchKey(quantity, 'Enter');
    await until(
      'the shared quantity edit to flush',
      () => source.element.querySelector('[role="status"]')?.textContent?.includes('Changes saved') === true,
    );
    expect(cellText(source.element, 'total')).toBe('30');
    expect(cellText(first.element, 'total')).toBe('30');
    expect(cellText(second.element, 'total')).toBe('30');
    expect(rowElements(second.element)).toHaveLength(1);
    expect(fixture.data.snapshot(fixture.sourceId)).toMatchObject({
      status: 'ready',
      rows: [{ id: fixture.rowId, title: 'Widget', properties: { name: 'Catalog label', quantity: 3 } }],
    });

    const undo = dispatchKey(source.element, 'z', { ctrlKey: true });
    expect(undo.defaultPrevented).toBe(true);
    await until(
      'the shared data undo to flush',
      () => source.element.querySelector('[role="status"]')?.textContent?.includes('Changes saved') === true,
    );
    expect(cellText(source.element, 'total')).toBe('20');
    expect(cellText(first.element, 'total')).toBe('20');
    expect(rowElements(second.element)).toHaveLength(0);
    expect(fixture.data.snapshot(fixture.sourceId)).toMatchObject({
      status: 'ready',
      rows: [{ properties: { quantity: 2 } }],
    });
  });

  it('configures one linked view locally and routes config and data undo to the focused control', async () => {
    const fixture = await openFixture();
    const source = mountRoot(fixture);
    const first = mountRoot(fixture, { viewId: fixture.views[0].viewId });
    const second = mountRoot(fixture, { viewId: fixture.views[1].viewId });
    const firstApi = viewApi(first);
    const firstConfigBefore = readyView(firstApi).config;
    const secondConfigBefore = readyView(viewApi(second)).config;
    const apply = vi.spyOn(fixture.vault, 'apply');

    const quantity = editCell(source.element, 'quantity');
    setInputValue(quantity, '3');
    dispatchKey(quantity, 'Enter');
    await waitForStatus(
      source.element,
      'Changes saved',
      'the data edit to flush before config history checks',
    );
    expect(fixture.data.snapshot(fixture.sourceId)).toMatchObject({
      status: 'ready',
      rows: [{ properties: { quantity: 3 } }],
    });

    clickAction(first.element, 'view-settings-toggle');
    const panel = settingsPanel(first.element);
    const title = controlByLabel<HTMLInputElement>(panel, 'View title');
    setInputValue(title, 'Priority view');
    const namePriority = priorityButton(panel, 'Name');
    expect(namePriority.getAttribute('aria-pressed')).toBe('false');
    namePriority.focus();
    namePriority.click();
    let focusedNamePriority = priorityButton(panel, 'Name');
    expect(focusedNamePriority.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(focusedNamePriority);
    const moveNameUp = priorityItem(panel, 'Name').querySelector<HTMLButtonElement>(
      '[data-action="view-move-up"]',
    );
    if (!moveNameUp) throw new Error('The prioritized Name column has no Move up action.');
    moveNameUp.focus();
    moveNameUp.click();
    focusedNamePriority = priorityButton(panel, 'Name');
    const focusedMoveNameUp = priorityItem(panel, 'Name').querySelector<HTMLButtonElement>(
      '[data-action="view-move-up"]',
    );
    expect(focusedMoveNameUp).not.toBeNull();
    expect(document.activeElement).toBe(focusedMoveNameUp);
    expect(focusedNamePriority.getAttribute('aria-pressed')).toBe('true');
    const filter = action<HTMLSelectElement>(panel, 'view-filter-property');
    selectOptionByText(filter, 'Quantity');
    setInputValue(action<HTMLInputElement>(panel, 'view-filter-value'), '2');
    clickAction(first.element, 'view-save');
    await waitForStatus(first.element, 'Changes saved', 'the linked-view configuration to persist');

    expect(readyView(firstApi).config).toEqual({
      title: 'Priority view',
      columnOrder: ['price', 'name', 'quantity'],
      filter: { propertyId: 'quantity', op: 'gte', value: 2 },
    });
    expect(readyView(second.view!.api).config).toEqual(secondConfigBefore);
    expect(tableHeaders(first.element)).toEqual(['Row title', 'Price', 'Name', 'Quantity', 'Total']);
    expect(tableHeaders(source.element)).toEqual(['Name', 'Quantity', 'Price', 'Total']);
    expect(readyView(firstApi).history.canUndo).toBe(true);

    const writesBeforeNoop = apply.mock.calls.length;
    clickAction(first.element, 'view-save');
    expect(apply).toHaveBeenCalledTimes(writesBeforeNoop);
    expect(readyView(firstApi).config.title).toBe('Priority view');
    expect(readyView(firstApi).history.canUndo).toBe(true);

    const unregisterUndoRoot = registerUndoMenuRoot(fixture, first);
    try {
      // Exercise the app's actual undo command routing. HappyDOM verifies the registered root path, not native UI.
      priorityButton(first.element, 'Name').focus();
      undoRedo('undo');
      await waitForStatus(first.element, 'Changes saved', 'the host-command linked-view undo to persist');
      expect(readyView(firstApi).config).toEqual(firstConfigBefore);
      expect(fixture.data.snapshot(fixture.sourceId)).toMatchObject({
        status: 'ready',
        rows: [{ properties: { quantity: 3 } }],
      });
      expect(readyView(firstApi).history).toMatchObject({ canUndo: false, canRedo: true });

      const writesBeforeEmptyUndo = apply.mock.calls.length;
      priorityButton(first.element, 'Name').focus();
      undoRedo('undo');
      await settle();
      expect(apply).toHaveBeenCalledTimes(writesBeforeEmptyUndo);
      expect(readyView(firstApi).config).toEqual(firstConfigBefore);
      expect(first.element.querySelector('[data-current-notice]')?.textContent).toContain(
        'There is no view configuration to undo.',
      );
      expect(fixture.data.snapshot(fixture.sourceId)).toMatchObject({
        status: 'ready',
        rows: [{ properties: { quantity: 3 } }],
      });

      priorityButton(first.element, 'Name').focus();
      undoRedo('redo');
      await waitForStatus(first.element, 'Changes saved', 'the host-command linked-view redo to persist');
      expect(readyView(firstApi).config.title).toBe('Priority view');
      expect(readyView(firstApi).history.canRedo).toBe(false);
      expect(fixture.data.snapshot(fixture.sourceId)).toMatchObject({
        status: 'ready',
        rows: [{ properties: { quantity: 3 } }],
      });
    } finally {
      unregisterUndoRoot();
    }

    const settingsButton = action<HTMLButtonElement>(first.element, 'view-settings-toggle');
    settingsButton.click();
    expect(first.element.querySelector('[data-view-settings]')).toBeNull();
    const gridCell = editButton(first.element, 'quantity');
    gridCell.focus();
    dispatchKey(gridCell, 'z', { ctrlKey: true });
    await waitForStatus(first.element, 'Changes saved', 'the linked-root data undo to persist');
    expect(fixture.data.snapshot(fixture.sourceId)).toMatchObject({
      status: 'ready',
      rows: [{ properties: { quantity: 2 } }],
    });
    expect(readyView(firstApi).config.title).toBe('Priority view');
    expect(readyView(second.view!.api).config).toEqual(secondConfigBefore);
  });

  it('supports config Save, Cancel, Enter, Escape, and a fixed expected revision', async () => {
    const fixture = await openFixture();
    const linked = mountRoot(fixture, { viewId: fixture.views[0].viewId });
    const api = viewApi(linked);
    const original = readyView(api).config;
    const apply = vi.spyOn(fixture.vault, 'apply');

    clickAction(linked.element, 'view-settings-toggle');
    let panel = settingsPanel(linked.element);
    let title = controlByLabel<HTMLInputElement>(panel, 'View title');
    setInputValue(title, 'Button cancel draft');
    clickAction(panel, 'view-cancel');
    expect(linked.element.querySelector('[data-view-settings]')).toBeNull();
    expect(readyView(api).config).toEqual(original);
    expect(readyView(api).history.canUndo).toBe(false);
    expect(apply).not.toHaveBeenCalled();

    clickAction(linked.element, 'view-settings-toggle');
    panel = settingsPanel(linked.element);
    title = controlByLabel<HTMLInputElement>(panel, 'View title');
    setInputValue(title, 'Escape cancel draft');
    dispatchKey(title, 'Escape');
    expect(linked.element.querySelector('[data-view-settings]')).toBeNull();
    expect(readyView(api).config).toEqual(original);
    expect(readyView(api).history.canUndo).toBe(false);
    expect(apply).not.toHaveBeenCalled();

    clickAction(linked.element, 'view-settings-toggle');
    panel = settingsPanel(linked.element);
    title = controlByLabel<HTMLInputElement>(panel, 'View title');
    setInputValue(title, 'Enter saved title');
    const form = title.closest('form');
    if (!form) throw new Error('The linked-view settings controls are not in a form.');
    dispatchKey(title, 'Enter');
    if (readyView(api).config.title !== 'Enter saved title') {
      form.requestSubmit(action<HTMLButtonElement>(form, 'view-save'));
    }
    await waitForStatus(linked.element, 'Changes saved', 'the Enter config save to persist');
    expect(readyView(api).config.title).toBe('Enter saved title');
    expect(readyView(api).history.canUndo).toBe(true);

    const newCleanDraftTitle = controlByLabel<HTMLInputElement>(settingsPanel(linked.element), 'View title');
    expect(newCleanDraftTitle.value).toBe('Enter saved title');
    dispatchKey(newCleanDraftTitle, 'Escape');
    expect(linked.element.querySelector('[data-view-settings]')).toBeNull();
    expect(readyView(api).config.title).toBe('Enter saved title');

    clickAction(linked.element, 'view-settings-toggle');
    panel = settingsPanel(linked.element);
    title = controlByLabel<HTMLInputElement>(panel, 'View title');
    setInputValue(title, 'Local draft survives external config');
    const draftInput = title;
    const external = makeViewHandle(fixture, fixture.views[0].viewId, () => true);
    try {
      const expectedRevision = readyView(external.api).revision;
      const result = external.api.patchConfig({
        patch: { title: 'External winner' },
        expectedRevision,
      });
      expect(result).toMatchObject({ status: 'staged' });
      expect((await external.api.flush()).status).toBe('persisted');
      await until('the external config revision to make the draft readonly', () => {
        const current = controlByLabel<HTMLInputElement>(settingsPanel(linked.element), 'View title');
        return current.readOnly;
      });
      const staleInput = controlByLabel<HTMLInputElement>(settingsPanel(linked.element), 'View title');
      expect(staleInput).toBe(draftInput);
      expect(staleInput.value).toBe('Local draft survives external config');
      expect(staleInput.readOnly).toBe(true);
      expect(staleInput.disabled).toBe(false);
      expect(action<HTMLButtonElement>(settingsPanel(linked.element), 'view-save').disabled).toBe(true);
      expect(readyView(api).config.title).toBe('External winner');
      clickAction(settingsPanel(linked.element), 'view-cancel');
      expect(linked.element.querySelector('[data-view-settings]')).toBeNull();
    } finally {
      external.release();
    }
  });

  it('preserves partial and missing references until explicit repair and keeps an empty order visible', async () => {
    const fixture = await openFixture({
      viewsForSource: (sourceId, sequence) => [
        {
          version: 1,
          viewId: `broken-view-${sequence}`,
          sourceDatabaseId: sourceId,
          title: 'Broken references',
          columnOrder: ['retired-column', 'price'],
          filter: { propertyId: 'retired-number', op: 'gte', value: 2 },
        },
        {
          version: 1,
          viewId: `default-order-view-${sequence}`,
          sourceDatabaseId: sourceId,
          title: 'Default order',
          columnOrder: [],
          filter: null,
        },
      ],
    });
    const linked = mountRoot(fixture, { viewId: fixture.views[0].viewId });
    const defaults = mountRoot(fixture, { viewId: fixture.views[1].viewId });
    const api = viewApi(linked);
    const apply = vi.spyOn(fixture.vault, 'apply');
    expect(rowElements(linked.element)).toHaveLength(1);
    expect(tableHeaders(defaults.element)).toEqual(['Row title', 'Name', 'Quantity', 'Price', 'Total']);
    expect(rowElements(defaults.element)).toHaveLength(1);

    clickAction(linked.element, 'view-settings-toggle');
    let panel = settingsPanel(linked.element);
    expect(panel.textContent).not.toContain('retired-column');
    expect(panel.textContent).not.toContain('retired-number');
    expect(readyView(api).config).toEqual({
      title: 'Broken references',
      columnOrder: ['retired-column', 'price'],
      filter: { propertyId: 'retired-number', op: 'gte', value: 2 },
    });

    const title = controlByLabel<HTMLInputElement>(panel, 'View title');
    setInputValue(title, 'Renamed but still broken');
    clickAction(panel, 'view-save');
    await waitForStatus(linked.element, 'Changes saved', 'the title-only config save to persist');
    expect(readyView(api).config).toEqual({
      title: 'Renamed but still broken',
      columnOrder: ['retired-column', 'price'],
      filter: { propertyId: 'retired-number', op: 'gte', value: 2 },
    });

    const callsBeforeNoop = apply.mock.calls.length;
    clickAction(linked.element, 'view-save');
    expect(apply).toHaveBeenCalledTimes(callsBeforeNoop);
    expect(readyView(api).history.canUndo).toBe(true);

    panel = settingsPanel(linked.element);
    clickAction(panel, 'view-remove-unavailable-columns');
    selectOptionByText(action<HTMLSelectElement>(panel, 'view-filter-property'), 'Quantity');
    clickAction(panel, 'view-save');
    await waitForStatus(linked.element, 'Changes saved', 'the explicit reference repair to persist');
    expect(readyView(api).config).toEqual({
      title: 'Renamed but still broken',
      columnOrder: ['price'],
      filter: { propertyId: 'quantity', op: 'gte', value: 2 },
    });
    expect(tableHeaders(linked.element)).toEqual(['Row title', 'Price', 'Name', 'Quantity', 'Total']);
    expect(readyView(viewApi(defaults)).config.columnOrder).toEqual([]);
  });

  it('filters numeric zero without treating null or missing values as zero', async () => {
    const fixture = await openFixture({
      extraRows: [
        { slug: 'Zero', name: 'Zero label', quantity: 0, price: 5 },
        { slug: 'Null', name: 'Null label', quantity: null, price: 5 },
        { slug: 'Missing', name: 'Missing label', price: 5 },
      ],
      viewsForSource: (sourceId, sequence) => [
        {
          version: 1,
          viewId: `zero-filter-${sequence}`,
          sourceDatabaseId: sourceId,
          title: 'Zero and above',
          columnOrder: [],
          filter: { propertyId: 'quantity', op: 'gte', value: 0 },
        },
        {
          version: 1,
          viewId: `unfiltered-${sequence}`,
          sourceDatabaseId: sourceId,
          title: 'Unfiltered',
          columnOrder: [],
          filter: null,
        },
      ],
    });
    const linked = mountRoot(fixture, { viewId: fixture.views[0].viewId });
    const visibleTitles = rowElements(linked.element).map((row) =>
      row.querySelector<HTMLTableCellElement>('td[data-row-title]')?.textContent?.trim(),
    );
    expect(visibleTitles).toContain('Widget');
    expect(visibleTitles).toContain('Zero');
    expect(visibleTitles).not.toContain('Null');
    expect(visibleTitles).not.toContain('Missing');
    expect(readyView(viewApi(linked)).config.filter).toEqual({
      propertyId: 'quantity',
      op: 'gte',
      value: 0,
    });
  });

  it('keeps a linked cell input and raw draft through filter/order and external data changes', async () => {
    const fixture = await openFixture();
    const linked = mountRoot(fixture, { viewId: fixture.views[0].viewId });
    const source = mountRoot(fixture);
    const initial = fixture.data.snapshot(fixture.sourceId);
    if (initial.status !== 'ready') throw new Error('The synthetic source database did not load.');
    expect(
      fixture.data.patchCell({
        databaseId: fixture.sourceId,
        rowId: fixture.rowId,
        propertyId: 'quantity',
        value: 3,
        expectedRevision: initial.revision,
      }),
    ).toMatchObject({ status: 'staged' });
    expect((await fixture.data.flush(fixture.sourceId)).status).toBe('persisted');
    await until(
      'the shared source update to reach the linked grid',
      () => cellText(linked.element, 'total') === '30',
    );

    const originalHeaders = tableHeaders(linked.element);
    const input = editCell(linked.element, 'quantity');
    setInputValue(input, '7');
    expect(input.value).toBe('7');
    const api = viewApi(linked);
    const beforeConfig = readyView(api);
    expect(
      api.patchConfig({
        patch: {
          columnOrder: ['quantity', 'price'],
          filter: { propertyId: 'quantity', op: 'gte', value: 4 },
        },
        expectedRevision: beforeConfig.revision,
      }),
    ).toMatchObject({ status: 'staged' });
    expect((await api.flush()).status).toBe('persisted');
    expect(readyView(api).config.filter).toEqual({ propertyId: 'quantity', op: 'gte', value: 4 });
    expect(tableHeaders(linked.element)).toEqual(originalHeaders);
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe('7');

    const externalRow = fixture.vault.text(ROW_PATH);
    if (!externalRow || !/Quantity:\s*3\b/.test(externalRow)) {
      throw new Error('The synthetic row was not persisted before the external edit.');
    }
    fixture.vault.external({ [ROW_PATH]: externalRow.replace(/Quantity:\s*3\b/, 'Quantity: 0') });
    await until('the external quantity revision to reach the provider', () => {
      const snapshot = fixture.data.snapshot(fixture.sourceId);
      return snapshot.status === 'ready' && snapshot.rows[0]?.properties.quantity === 0;
    });
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe('7');
    expect(tableHeaders(linked.element)).toEqual(originalHeaders);
    const editor = input.closest<HTMLElement>('[data-editor="quantity"]');
    const save = editor?.querySelector<HTMLButtonElement>('button[data-action="save"]');
    expect(save?.disabled).toBe(true);

    dispatchKey(input, 'Enter');
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe('7');
    expect(fixture.data.snapshot(fixture.sourceId)).toMatchObject({
      status: 'ready',
      rows: [{ properties: { quantity: 0 } }],
    });

    // HappyDOM verifies input identity and key routing. Native number-input undo stays in gates #127/#128.
    const bubbledKey = vi.fn();
    document.body.addEventListener('keydown', bubbledKey);
    dispatchKey(input, 'z', { ctrlKey: true });
    document.body.removeEventListener('keydown', bubbledKey);
    expect(bubbledKey).not.toHaveBeenCalled();
    expect(fixture.data.snapshot(fixture.sourceId)).toMatchObject({
      status: 'ready',
      rows: [{ properties: { quantity: 0 } }],
    });

    const cancel = editor?.querySelector<HTMLButtonElement>('button[data-action="cancel"]');
    if (!cancel) throw new Error('The stale cell draft has no cancel action.');
    cancel.click();
    await until(
      'the current filter to hide the edited row after cancel',
      () => rowElements(linked.element).length === 0,
    );
    expect(rowText(source.element)).toContain('Catalog label');
    expect(cellText(source.element, 'total')).toBe('0');
  });

  it('keeps an accepted config staged after a failed flush, retries without stealing focus, then allows Escape', async () => {
    const fixture = await openFixture();
    const linked = mountRoot(fixture, { viewId: fixture.views[0].viewId });
    const other = mountRoot(fixture, { viewId: fixture.views[1].viewId });
    const api = viewApi(linked);
    const persistedNote = fixture.vault.text(NOTE_PATH);
    const originalApply = fixture.vault.apply.bind(fixture.vault);
    const apply = vi.spyOn(fixture.vault, 'apply');
    let releaseRetry!: () => void;
    let retryStarted = false;
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    apply
      .mockImplementationOnce(async () => [{ ok: false, code: 'error', message: 'temporary disk failure' }])
      .mockImplementationOnce(async (operations) => {
        retryStarted = true;
        await retryGate;
        return originalApply(operations);
      });

    clickAction(linked.element, 'view-settings-toggle');
    const title = controlByLabel<HTMLInputElement>(settingsPanel(linked.element), 'View title');
    setInputValue(title, 'Accepted while disk is unavailable');
    clickAction(linked.element, 'view-save');
    await until(
      'the staged configuration retry control to appear',
      () => linked.element.querySelector('[data-action="view-retry"]') !== null,
    );

    expect(readyView(api).config.title).toBe('Accepted while disk is unavailable');
    expect(fixture.vault.text(NOTE_PATH)).toBe(persistedNote);
    expect(action<HTMLButtonElement>(settingsPanel(linked.element), 'view-cancel').disabled).toBe(true);
    expect(action<HTMLButtonElement>(linked.element, 'view-settings-toggle').disabled).toBe(true);
    dispatchKey(settingsPanel(linked.element).querySelector('form')!, 'Escape');
    clickAction(linked.element, 'view-settings-toggle');
    expect(settingsPanel(linked.element)).toBeTruthy();

    clickAction(linked.element, 'view-retry');
    await until('the retry write to begin', () => retryStarted);
    const otherRootSettings = action<HTMLButtonElement>(other.element, 'view-settings-toggle');
    otherRootSettings.focus();
    releaseRetry();
    await waitForStatus(linked.element, 'Changes saved', 'the retry flush to persist');
    expect(fixture.vault.text(NOTE_PATH)).not.toBe(persistedNote);
    expect(readyView(api).config.title).toBe('Accepted while disk is unavailable');
    expect(document.activeElement).toBe(otherRootSettings);

    const cleanDraftTitle = controlByLabel<HTMLInputElement>(settingsPanel(linked.element), 'View title');
    dispatchKey(cleanDraftTitle, 'Escape');
    expect(linked.element.querySelector('[data-view-settings]')).toBeNull();
    expect(readyView(api).config.title).toBe('Accepted while disk is unavailable');
  });

  it('keeps a compatible linked view visible in readonly mode without writing', async () => {
    const fixture = await openFixture();
    fixture.setHostReadonly(true);
    const linked = mountRoot(fixture, { viewId: fixture.views[0].viewId });
    const api = viewApi(linked);
    const configBefore = readyView(api).config;
    const noteBefore = fixture.vault.text(NOTE_PATH);
    const apply = vi.spyOn(fixture.vault, 'apply');

    expect(readyView(api).readonly).toBe(true);
    expect(linked.element.querySelector('table')).not.toBeNull();
    expect(tableHeaders(linked.element)[0]).toBe('Row title');
    clickAction(linked.element, 'view-settings-toggle');
    const panel = settingsPanel(linked.element);
    expect(controlByLabel<HTMLInputElement>(panel, 'View title').disabled).toBe(true);
    expect(action<HTMLSelectElement>(panel, 'view-filter-property').disabled).toBe(true);
    expect(action<HTMLButtonElement>(panel, 'view-save').disabled).toBe(true);
    expect(action<HTMLButtonElement>(panel, 'view-undo').disabled).toBe(true);
    clickAction(panel, 'view-save');
    expect(fixture.vault.text(NOTE_PATH)).toBe(noteBefore);
    expect(apply).not.toHaveBeenCalled();
    expect(readyView(api).config).toEqual(configBefore);
    expect(readyView(api).history).toMatchObject({ canUndo: false, canRedo: false });
  });

  it('localizes linked-view controls in Portuguese, English, and Spanish', async () => {
    const fixture = await openFixture();
    const cases: readonly {
      readonly locale: NonNullable<DatabaseProviderContext['locale']>;
      readonly settings: string;
      readonly title: string;
      readonly rowTitle: string;
      readonly save: string;
      readonly cancel: string;
      readonly filterProperty: string;
      readonly filterValue: string;
    }[] = [
      {
        locale: 'pt',
        settings: 'Configurar visualização',
        title: 'Título da visualização',
        rowTitle: 'Título da linha',
        save: 'Salvar',
        cancel: 'Cancelar',
        filterProperty: 'Propriedade numérica',
        filterValue: 'Limite mínimo',
      },
      {
        locale: 'en',
        settings: 'View settings',
        title: 'View title',
        rowTitle: 'Row title',
        save: 'Save',
        cancel: 'Cancel',
        filterProperty: 'Numeric property',
        filterValue: 'Minimum value',
      },
      {
        locale: 'es',
        settings: 'Configurar vista',
        title: 'Título de la vista',
        rowTitle: 'Título de fila',
        save: 'Guardar',
        cancel: 'Cancelar',
        filterProperty: 'Propiedad numérica',
        filterValue: 'Valor mínimo',
      },
    ];

    for (const entry of cases) {
      const linked = mountRoot(fixture, { viewId: fixture.views[0].viewId, locale: entry.locale });
      expect(action<HTMLButtonElement>(linked.element, 'view-settings-toggle').textContent).toBe(
        entry.settings,
      );
      expect(tableHeaders(linked.element)[0]).toBe(entry.rowTitle);
      clickAction(linked.element, 'view-settings-toggle');
      const panel = settingsPanel(linked.element);
      expect(controlByLabel<HTMLInputElement>(panel, entry.title)).toBeTruthy();
      expect(controlByLabel<HTMLSelectElement>(panel, entry.filterProperty)).toBeTruthy();
      expect(controlByLabel<HTMLInputElement>(panel, entry.filterValue)).toBeTruthy();
      expect(action<HTMLButtonElement>(panel, 'view-save').textContent).toBe(entry.save);
      expect(action<HTMLButtonElement>(panel, 'view-cancel').textContent).toBe(entry.cancel);
      linked.unmount();
    }
  });

  it('does not write on open and does not let a disabled generation edit after reload', async () => {
    const fixture = await openFixture();
    const noteBefore = fixture.vault.text(NOTE_PATH);
    const apply = vi.spyOn(fixture.vault, 'apply');
    const first = mountRoot(fixture, { viewId: fixture.views[0].viewId });
    const oldApi = viewApi(first);
    const original = readyView(oldApi);
    await settle();
    expect(apply).not.toHaveBeenCalled();
    expect(fixture.vault.text(NOTE_PATH)).toBe(noteBefore);

    first.unmount();
    const staleAttempt = oldApi.patchConfig({
      patch: { title: 'Disabled generation must not write' },
      expectedRevision: original.revision,
    });
    expect(staleAttempt).toMatchObject({ status: 'error', code: 'owner-inactive' });
    expect(fixture.vault.text(NOTE_PATH)).toBe(noteBefore);

    const reloaded = mountRoot(fixture, { viewId: fixture.views[0].viewId });
    await settle();
    expect(readyView(viewApi(reloaded)).config).toEqual(original.config);
    expect(fixture.vault.text(NOTE_PATH)).toBe(noteBefore);
    expect(apply).not.toHaveBeenCalled();
  });

  it('renders the virtual row title separately from a real property whose ID is row-title', async () => {
    const fixture = await openFixture({
      withRealRowTitleProperty: true,
      viewsForSource: (sourceId, sequence) => [
        {
          version: 1,
          viewId: `collision-view-${sequence}`,
          sourceDatabaseId: sourceId,
          title: 'Title collision',
          columnOrder: ['row-title', 'quantity'],
          filter: null,
        },
        {
          version: 1,
          viewId: `unused-collision-view-${sequence}`,
          sourceDatabaseId: sourceId,
          title: 'Unused view',
          columnOrder: [],
          filter: null,
        },
      ],
    });
    const linked = mountRoot(fixture, { viewId: fixture.views[0].viewId });
    const headers = tableHeaders(linked.element);
    expect(headers.slice(0, 3)).toEqual(['Row title', 'Native title', 'Quantity']);
    expect(rowText(linked.element)).toContain('Widget');
    expect(editButton(linked.element, 'row-title').getAttribute('aria-label')).toBe(
      'Edit Native title for Widget',
    );
    const titleColumn = rowElements(linked.element)[0]?.querySelectorAll<HTMLTableCellElement>('td')[0];
    expect(titleColumn?.querySelector('button[data-action="edit"]')).toBeNull();

    const nativeTitle = editCell(linked.element, 'row-title');
    setInputValue(nativeTitle, '8');
    dispatchKey(nativeTitle, 'Enter');
    await until('the real row-title property edit to flush', () => {
      const snapshot = fixture.data.snapshot(fixture.sourceId);
      return snapshot.status === 'ready' && snapshot.rows[0]?.properties['row-title'] === 8;
    });
    expect(fixture.data.snapshot(fixture.sourceId)).toMatchObject({
      status: 'ready',
      rows: [{ title: 'Widget', properties: { 'row-title': 8 } }],
    });
  });
});
