// @vitest-environment happy-dom
import { Window } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseProviderRegistration } from '../../../../src/app/plugins/providerApi';
import { createDataApi } from '../../../../src/app/plugins/dataApi';
import { createLinkedViewApi } from '../../../../src/app/plugins/linkedViewApi';
import type { DataApi } from '../../../../src/app/plugins/dataApi';
import type { LinkedViewApi } from '../../../../src/app/plugins/linkedViewApi';
import { createProviderDataScope } from '../../../../src/app/plugins/providerDataScope';
import type { PageId } from '../../../../src/core/model';
import { encodePolarisDadosViewMarker } from '../../../../src/core/polarisDadosView';
import type { PolarisDadosViewData } from '../../../../src/core/polarisDadosView';
import { setSession } from '../../../../src/app/workspace';
import { MemoryVault } from '../../../../src/storage/memoryVault';
import { WorkspaceSession } from '../../../../src/storage/session';
import { VaultRepository } from '../../../../src/storage/vaultRepository';
import { activate, type PolarisDadosPluginApi } from '../main';

const DATABASE_ID = 'formula-source';
const HIDDEN_ROW_ID = 'formula-hidden-row';
const VISIBLE_ROW_ID = 'formula-visible-row';
const VIEW_NOTE_ID = 'formula-view-note';
const VIEW_ID = 'formula-filtered-view';
const DATABASE_PATH = 'Inventory.md';
const HIDDEN_ROW_PATH = 'Inventory/Hidden.md';
const VISIBLE_ROW_PATH = 'Inventory/Visible.md';
const VIEW_NOTE_PATH = 'Views.md';

const DATABASE = [
  '---',
  'kind: database',
  'polarisDados:',
  '  version: 1',
  '  provider: polaris-dados',
  'database:',
  '  properties:',
  '    - id: quantity',
  '      name: Quantity',
  '      type: number',
  '    - id: listed',
  '      name: Listed',
  '      type: number',
  '    - id: total',
  '      name: Total',
  '      type: formula',
  '      formula: Inventory.Quantity.Sum()',
  '  views:',
  '    - id: table',
  '      name: Table',
  '      type: table',
  '---',
  '# Inventory',
  '',
].join('\n');

const HIDDEN_ROW = ['---', 'Name: Hidden', 'Quantity: 2', 'Listed: 0', '---', 'Filtered row.', ''].join('\n');
const VISIBLE_ROW = ['---', 'Name: Visible', 'Quantity: 3', 'Listed: 1', '---', 'Visible row.', ''].join(
  '\n',
);
const VIEW_DATA: PolarisDadosViewData = {
  version: 1,
  viewId: VIEW_ID,
  sourceDatabaseId: DATABASE_ID,
  title: 'Visible inventory',
  columnOrder: ['total'],
  filter: { propertyId: 'listed', op: 'gte', value: 1 },
};
const VIEW_NOTE = ['# Shared view', '', encodePolarisDadosViewMarker(VIEW_DATA), ''].join('\n');

interface Fixture {
  readonly vault: MemoryVault;
  readonly session: WorkspaceSession;
  readonly data: DataApi;
  readonly registration: DatabaseProviderRegistration;
  readonly pageListCalls: () => number;
  close(): Promise<void>;
}

interface MountedRoot {
  readonly window: Window;
  readonly element: HTMLElement;
  unmount(): void;
}

interface ViewHandle {
  readonly api: LinkedViewApi;
  release(): void;
}

const fixtures = new Set<Fixture>();
const roots = new Set<MountedRoot>();
const windows: Window[] = [];
let sessionSequence = 0;

function fixtureFiles(): Record<string, string> {
  return {
    [DATABASE_PATH]: DATABASE,
    [HIDDEN_ROW_PATH]: HIDDEN_ROW,
    [VISIBLE_ROW_PATH]: VISIBLE_ROW,
    [VIEW_NOTE_PATH]: VIEW_NOTE,
    '.morrow/workspace.json': JSON.stringify({
      version: 1,
      pages: {
        [DATABASE_PATH]: { id: DATABASE_ID, created: 1, order: 0 },
        [HIDDEN_ROW_PATH]: { id: HIDDEN_ROW_ID, created: 2, order: 0 },
        [VISIBLE_ROW_PATH]: { id: VISIBLE_ROW_ID, created: 3, order: 1 },
        [VIEW_NOTE_PATH]: { id: VIEW_NOTE_ID, created: 4, order: 2 },
      },
    }),
    '.morrow/recent.json': JSON.stringify({ version: 1, opened: {}, activity: {} }),
  };
}

async function openFixture(vault = new MemoryVault(fixtureFiles())): Promise<Fixture> {
  const opened = await WorkspaceSession.open(
    new VaultRepository(vault, () => `unexpected-formula-page-${++sessionSequence}`),
    { delayMs: 60_000 },
  );
  if (!opened.ok) throw new Error(opened.error);
  const session = opened.value;
  setSession(session);
  let ownerActive = true;
  let pageListCalls = 0;
  const cleanups = new Set<() => void>();
  const data = createDataApi({
    session,
    ownerIsActive: () => ownerActive,
    isProviderActive: (databaseId) => ownerActive && databaseId === DATABASE_ID,
    isHostReadonly: () => session.isMutationFenced,
    registerCleanup: (cleanup) => cleanups.add(cleanup),
  });
  let registration: DatabaseProviderRegistration | null = null;
  const api: PolarisDadosPluginApi = {
    data,
    locale: 'en',
    pages: {
      list: () => {
        if (!ownerActive || session.isClosed) throw new Error('The fixture session is inactive.');
        pageListCalls += 1;
        return [
          { id: DATABASE_ID, title: 'Inventory', kind: 'database' },
          { id: HIDDEN_ROW_ID, title: 'Hidden', kind: 'page' },
          { id: VISIBLE_ROW_ID, title: 'Visible', kind: 'page' },
          { id: VIEW_NOTE_ID, title: 'Views', kind: 'page' },
        ];
      },
    },
    providers: {
      version: 1,
      register(candidate) {
        registration = candidate;
        return () => {
          if (registration === candidate) registration = null;
        };
      },
    },
    editor: { insertion: { version: 1, capture: () => null } },
    commands: { add: () => () => {} },
    slash: { add: () => () => {} },
  };
  const deactivate = activate(api);
  if (!registration) throw new Error('Polaris Dados did not register a database provider.');

  const fixture: Fixture = {
    vault,
    session,
    data,
    registration,
    pageListCalls: () => pageListCalls,
    async close() {
      ownerActive = false;
      deactivate();
      for (const cleanup of [...cleanups]) cleanup();
      cleanups.clear();
      if (!session.isClosed) await session.close();
    },
  };
  fixtures.add(fixture);
  return fixture;
}

function makeViewHandle(fixture: Fixture): ViewHandle {
  const generation = Symbol(VIEW_ID);
  let cleanup = () => {};
  const api = createLinkedViewApi({
    session: fixture.session,
    pageId: VIEW_NOTE_ID as PageId,
    viewId: VIEW_ID,
    sourceDatabaseId: DATABASE_ID as PageId,
    mountGeneration: generation,
    ownerIsActive: () => !fixture.session.isClosed,
    isMountGenerationActive: (candidate) => candidate === generation && !fixture.session.isClosed,
    isHostReadonly: () => fixture.session.isMutationFenced,
    registerCleanup: (release) => {
      cleanup = release;
    },
  });
  return { api, release: () => cleanup() };
}

function mountRoot(fixture: Fixture, linked = false): MountedRoot {
  const window = new Window({ url: 'http://morrow.test/' });
  windows.push(window);
  const element = window.document.createElement('div');
  window.document.body.append(element);
  const controller = new AbortController();
  const scope = createProviderDataScope(fixture.data, DATABASE_ID as PageId, {
    isActive: () => !controller.signal.aborted,
    editable: true,
  });
  const view = linked ? makeViewHandle(fixture) : undefined;
  const cleanup = fixture.registration.mount({
    element: element as unknown as HTMLElement,
    databaseId: DATABASE_ID as PageId,
    data: scope.api,
    locale: 'en',
    editable: true,
    signal: controller.signal,
    ...(view ? { view: view.api } : {}),
  });
  const root: MountedRoot = {
    window,
    element: element as unknown as HTMLElement,
    unmount() {
      if (!controller.signal.aborted) controller.abort();
      if (typeof cleanup === 'function') cleanup();
      view?.release();
      element.remove();
      roots.delete(root);
    },
  };
  roots.add(root);
  return root;
}

function cellValue(root: HTMLElement, rowId: string, propertyId: string) {
  const row = root.querySelector<HTMLTableRowElement>(`tr[data-row-id="${rowId}"]`);
  const output = row?.querySelector<HTMLElement>(`td[data-field="${propertyId}"] [data-value-kind]`);
  if (!output) throw new Error(`Missing rendered ${propertyId} value for row ${rowId}.`);
  return { kind: output.dataset.valueKind, text: output.textContent };
}

function openNumberEditor(root: HTMLElement, rowId: string, propertyId: string): HTMLInputElement {
  const edit = root.querySelector<HTMLButtonElement>(
    `button[data-action="edit"][data-row-id="${rowId}"][data-field="${propertyId}"]`,
  );
  if (!edit) throw new Error(`Missing Edit control for ${rowId}.${propertyId}.`);
  edit.click();
  const input = root.querySelector<HTMLInputElement>(
    `input[data-row-id="${rowId}"][data-field="${propertyId}"]`,
  );
  if (!input) throw new Error(`Missing editor for ${rowId}.${propertyId}.`);
  return input;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function until(description: string, predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

afterEach(async () => {
  for (const root of [...roots]) root.unmount();
  for (const fixture of [...fixtures]) {
    await fixture.close();
    fixtures.delete(fixture);
  }
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.abort()));
});

describe('table formula projections through the real provider session', () => {
  it('updates an omitted row in source and filtered view, undoes it, and reopens the original bytes', async () => {
    const fixture = await openFixture();
    const initialDatabaseBytes = fixture.vault.text(DATABASE_PATH);
    const initialHiddenRowBytes = fixture.vault.text(HIDDEN_ROW_PATH);
    if (initialDatabaseBytes === undefined || initialHiddenRowBytes === undefined) {
      throw new Error('The synthetic database fixture is incomplete.');
    }
    const source = mountRoot(fixture);
    const linked = mountRoot(fixture, true);

    expect(cellValue(source.element, HIDDEN_ROW_ID, 'total')).toEqual({ kind: 'number', text: '5' });
    expect(cellValue(source.element, VISIBLE_ROW_ID, 'total')).toEqual({ kind: 'number', text: '5' });
    expect(cellValue(linked.element, VISIBLE_ROW_ID, 'total')).toEqual({ kind: 'number', text: '5' });
    expect(linked.element.querySelector(`tr[data-row-id="${HIDDEN_ROW_ID}"]`)).toBeNull();
    expect(fixture.pageListCalls()).toBeGreaterThan(0);

    const input = openNumberEditor(source.element, HIDDEN_ROW_ID, 'quantity');
    input.value = '4';
    input.dispatchEvent(new source.window.Event('input', { bubbles: true }) as unknown as Event);
    source.element.querySelector<HTMLButtonElement>('button[data-action="save"]')?.click();

    await until('the full database formula to update in both surfaces', () => {
      try {
        return (
          cellValue(source.element, HIDDEN_ROW_ID, 'total').text === '7' &&
          cellValue(source.element, VISIBLE_ROW_ID, 'total').text === '7' &&
          cellValue(linked.element, VISIBLE_ROW_ID, 'total').text === '7' &&
          fixture.vault.text(HIDDEN_ROW_PATH)?.includes('Quantity: 4') === true
        );
      } catch {
        return false;
      }
    });
    expect(linked.element.querySelector(`tr[data-row-id="${HIDDEN_ROW_ID}"]`)).toBeNull();
    expect(fixture.vault.text(DATABASE_PATH)).toBe(initialDatabaseBytes);
    expect(fixture.vault.text(HIDDEN_ROW_PATH)).not.toMatch(/^Total:/m);

    const undo = new source.window.KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    source.element.dispatchEvent(undo as unknown as Event);
    expect(undo.defaultPrevented).toBe(true);
    await until('undo to restore the source and filtered formula values', () => {
      try {
        return (
          cellValue(source.element, HIDDEN_ROW_ID, 'total').text === '5' &&
          cellValue(source.element, VISIBLE_ROW_ID, 'total').text === '5' &&
          cellValue(linked.element, VISIBLE_ROW_ID, 'total').text === '5' &&
          fixture.vault.text(HIDDEN_ROW_PATH) === initialHiddenRowBytes
        );
      } catch {
        return false;
      }
    });
    expect(linked.element.querySelector(`tr[data-row-id="${HIDDEN_ROW_ID}"]`)).toBeNull();

    source.unmount();
    linked.unmount();
    await fixture.close();
    fixtures.delete(fixture);
    const reopened = await openFixture(fixture.vault);
    const reopenedSnapshot = reopened.data.snapshot(DATABASE_ID as PageId);
    expect(reopened.vault.text(DATABASE_PATH)).toBe(initialDatabaseBytes);
    expect(reopened.vault.text(HIDDEN_ROW_PATH)).toBe(initialHiddenRowBytes);
    expect(reopenedSnapshot.status).toBe('ready');
    if (reopenedSnapshot.status !== 'ready') throw new Error('The database did not reopen as ready.');
    const reopenedFormula = reopenedSnapshot.schema.properties.find((property) => property.id === 'total');
    expect(reopenedFormula?.formula).toBe('Inventory.Quantity.Sum()');
    expect(reopenedSnapshot.rows.find((row) => row.id === HIDDEN_ROW_ID)?.properties.quantity).toBe(2);
    expect(
      Object.hasOwn(reopenedSnapshot.rows.find((row) => row.id === HIDDEN_ROW_ID)!.properties, 'total'),
    ).toBe(false);
  });
});
