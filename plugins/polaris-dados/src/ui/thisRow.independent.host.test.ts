import { Window } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { DataApi } from '../../../../src/app/plugins/dataApi';
import { createDataApi } from '../../../../src/app/plugins/dataApi';
import { createLinkedViewApi } from '../../../../src/app/plugins/linkedViewApi';
import type { LinkedViewApi } from '../../../../src/app/plugins/linkedViewApi';
import { encodePolarisDadosViewMarker } from '../../../../src/core/polarisDadosView';
import type { PolarisDadosViewData } from '../../../../src/core/polarisDadosView';
import type { PageId } from '../../../../src/core/model';
import { MemoryVault } from '../../../../src/storage/memoryVault';
import { WorkspaceSession } from '../../../../src/storage/session';
import { VaultRepository } from '../../../../src/storage/vaultRepository';
import { createProviderDataScope } from '../../../../src/app/plugins/providerDataScope';
import type { DatabaseProviderContext } from '../../../../src/app/plugins/providerApi';
import { setSession } from '../../../../src/app/workspace';
import { mountPolarisDados } from './mount';

const DATABASE_ID = 'thisrow-source';
const WIDGET_ID = 'thisrow-widget';
const GADGET_ID = 'thisrow-gadget';
const NOTE_ID = 'thisrow-views';
const VIEW_ONE = 'shared-one';
const VIEW_TWO = 'shared-two';
const DATABASE_PATH = 'Inventory.md';
const WIDGET_PATH = 'Inventory/Widget.md';

const DATABASE = `---
kind: database
polarisDados:
  version: 1
  provider: polaris-dados
database:
  properties:
    - id: name
      name: Name
      type: text
    - id: quantity
      name: Quantity
      type: number
    - id: price
      name: Price
      type: number
    - id: enabled
      name: Enabled
      type: checkbox
    - id: zero
      name: Zero
      type: number
    - id: empty-text
      name: Empty Text
      type: text
    - id: nullable
      name: Nullable
      type: text
    - id: optional
      name: Optional
      type: text
    - id: this-row
      name: thisRow
      type: text
    - id: row-total
      name: Row total
      type: formula
      formula: thisRow.Quantity * thisRow.Price
    - id: literal-this-row
      name: Literal thisRow
      type: formula
      formula: 'WithName("thisRow", thisRow, prop(thisRow))'
    - id: zero-result
      name: Zero result
      type: formula
      formula: thisRow.Zero
    - id: false-result
      name: False result
      type: formula
      formula: thisRow.Quantity == 0
    - id: empty-result
      name: Empty result
      type: formula
      formula: thisRow["Empty Text"]
    - id: null-result
      name: Null result
      type: formula
      formula: thisRow.Nullable
    - id: absent-result
      name: Absent result
      type: formula
      formula: thisRow.Optional
    - id: row-list
      name: Nested row list
      type: formula
      formula: '[[thisRow]]'
    - id: prototype-member
      name: Prototype member
      type: formula
      formula: thisRow.constructor
  views:
    - id: table
      name: Table
      type: table
---
# Inventory
`;

const WIDGET = `---
Name: Widget
Quantity: 2
Price: 10
Enabled: true
Zero: 0
Empty Text: ''
Nullable: null
thisRow: literal widget column
---
Synthetic widget row.
`;

const GADGET = `---
Name: Gadget
Quantity: 3
Price: 4
Enabled: true
Zero: 0
Empty Text: gadget text
Nullable: gadget value
thisRow: literal gadget column
---
Synthetic gadget row.
`;

const views: readonly [PolarisDadosViewData, PolarisDadosViewData] = [
  {
    version: 1,
    viewId: VIEW_ONE,
    sourceDatabaseId: DATABASE_ID,
    title: 'Shared inventory one',
    columnOrder: ['quantity'],
    filter: null,
  },
  {
    version: 1,
    viewId: VIEW_TWO,
    sourceDatabaseId: DATABASE_ID,
    title: 'Shared inventory two',
    columnOrder: ['price'],
    filter: null,
  },
];

interface Fixture {
  readonly vault: MemoryVault;
  readonly session: WorkspaceSession;
  readonly data: DataApi;
  readonly databaseId: string;
  readonly widgetId: string;
  readonly gadgetId: string;
  readonly noteId: string;
  close(): Promise<void>;
}

interface ViewHandle {
  readonly api: LinkedViewApi;
  release(): void;
}

interface MountedRoot {
  readonly window: Window;
  readonly element: HTMLElement;
  unmount(): void;
}

let sequence = 0;
const fixtures = new Set<Fixture>();
const windows: Window[] = [];
const mountedRoots = new Set<MountedRoot>();

function markdownForViews(): string {
  return [
    '# Linked views',
    '',
    encodePolarisDadosViewMarker(views[0]),
    '',
    'Between linked views.',
    '',
    encodePolarisDadosViewMarker(views[1]),
    '',
  ].join('\n');
}

async function openFixture(): Promise<Fixture> {
  const id = ++sequence;
  const files: Record<string, string> = {
    [DATABASE_PATH]: DATABASE,
    [WIDGET_PATH]: WIDGET,
    'Inventory/Gadget.md': GADGET,
    'Views.md': markdownForViews(),
    '.morrow/workspace.json': JSON.stringify({
      version: 1,
      pages: {
        [DATABASE_PATH]: { id: DATABASE_ID, created: 1, order: 0 },
        [WIDGET_PATH]: { id: WIDGET_ID, created: 2, order: 0 },
        'Inventory/Gadget.md': { id: GADGET_ID, created: 3, order: 1 },
        'Views.md': { id: NOTE_ID, created: 4, order: 1 },
      },
    }),
    '.morrow/recent.json': JSON.stringify({ version: 1, opened: {}, activity: {} }),
  };
  const vault = new MemoryVault(files);
  let generated = 0;
  const opened = await WorkspaceSession.open(
    new VaultRepository(vault, () => `unexpected-thisrow-page-${id}-${++generated}`),
    { delayMs: 60_000 },
  );
  if (!opened.ok) throw new Error(opened.error);
  const session = opened.value;
  setSession(session);

  let ownerActive = true;
  const cleanups = new Set<() => void>();
  const data = createDataApi({
    session,
    ownerIsActive: () => ownerActive,
    isProviderActive: (databaseId) => ownerActive && databaseId === DATABASE_ID,
    isHostReadonly: () => false,
    registerCleanup: (cleanup) => cleanups.add(cleanup),
  });
  const fixture: Fixture = {
    vault,
    session,
    data,
    databaseId: DATABASE_ID,
    widgetId: WIDGET_ID,
    gadgetId: GADGET_ID,
    noteId: NOTE_ID,
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
    pageId: fixture.noteId as PageId,
    viewId,
    sourceDatabaseId: fixture.databaseId as PageId,
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

function mountRoot(fixture: Fixture, viewId?: string): MountedRoot {
  const window = new Window({ url: 'http://morrow.test/' });
  windows.push(window);
  const element = window.document.createElement('div');
  window.document.body.append(element);
  const controller = new AbortController();
  const scope = createProviderDataScope(fixture.data, fixture.databaseId as PageId, {
    isActive: () => !controller.signal.aborted,
    editable: true,
  });
  const view = viewId ? makeViewHandle(fixture, viewId, () => !controller.signal.aborted) : undefined;
  const context: DatabaseProviderContext = {
    element: element as unknown as HTMLElement,
    databaseId: fixture.databaseId as PageId,
    data: scope.api,
    locale: 'en',
    editable: true,
    signal: controller.signal,
    ...(view ? { view: view.api } : {}),
  };
  const cleanup = mountPolarisDados(context);
  const root: MountedRoot = {
    window,
    element: element as unknown as HTMLElement,
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

function cell(root: HTMLElement, rowId: string, propertyId: string): HTMLTableCellElement {
  const result = root.querySelector<HTMLTableCellElement>(
    `tr[data-row-id="${rowId}"] td[data-field="${propertyId}"]`,
  );
  if (!result) throw new Error(`Missing ${propertyId} cell for ${rowId}.`);
  return result;
}

function value(root: HTMLElement, rowId: string, propertyId: string) {
  const output = cell(root, rowId, propertyId).querySelector<HTMLElement>('[data-value-kind]');
  if (!output) throw new Error(`Missing rendered value for ${propertyId} on ${rowId}.`);
  return { kind: output.dataset.valueKind, text: output.textContent };
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
  throw new Error(`Timed out waiting for ${description}.`);
}

afterEach(async () => {
  for (const root of [...mountedRoots]) root.unmount();
  for (const fixture of [...fixtures]) {
    await fixture.close();
    fixtures.delete(fixture);
  }
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.abort()));
});

describe('independent thisRow UI/API integration with real host session', () => {
  it('recomputes row-local formulas in the source and two linked views after real DataApi edits and undo', async () => {
    const fixture = await openFixture();
    const source = mountRoot(fixture);
    const firstView = mountRoot(fixture, VIEW_ONE);
    const secondView = mountRoot(fixture, VIEW_TWO);
    const roots = [source.element, firstView.element, secondView.element];

    for (const root of roots) {
      expect(value(root, WIDGET_ID, 'row-total')).toEqual({ kind: 'number', text: '20' });
      expect(value(root, GADGET_ID, 'row-total')).toEqual({ kind: 'number', text: '12' });
      expect(value(root, WIDGET_ID, 'literal-this-row')).toEqual({
        kind: 'text',
        text: 'literal widget column',
      });
      expect(value(root, GADGET_ID, 'literal-this-row')).toEqual({
        kind: 'text',
        text: 'literal gadget column',
      });
      expect(value(root, WIDGET_ID, 'zero-result')).toMatchObject({ kind: 'number', text: '0' });
      expect(value(root, WIDGET_ID, 'false-result').kind).toBe('boolean');
      expect(value(root, WIDGET_ID, 'empty-result')).toEqual({ kind: 'text', text: '' });
      expect(value(root, WIDGET_ID, 'null-result').kind).toBe('null');
      expect(value(root, WIDGET_ID, 'absent-result').kind).toBe('null');
      expect(value(root, WIDGET_ID, 'row-list').kind).toBe('error');
      expect(value(root, WIDGET_ID, 'prototype-member').kind).toBe('error');
      expect(cell(root, WIDGET_ID, 'row-list').textContent).not.toContain('[object Object]');
    }

    const edit = source.element.querySelector<HTMLButtonElement>(
      `button[data-action="edit"][data-row-id="${WIDGET_ID}"][data-field="quantity"]`,
    );
    if (!edit) throw new Error('The source Quantity control did not render.');
    edit.click();
    const input = source.element.querySelector<HTMLInputElement>(
      `input[data-field="quantity"][data-row-id="${WIDGET_ID}"]`,
    );
    if (!input) throw new Error('The source Quantity editor did not open.');
    input.value = '0';
    input.dispatchEvent(new source.window.Event('input', { bubbles: true }) as unknown as Event);
    const save = source.element.querySelector<HTMLButtonElement>('button[data-action="save"]');
    if (!save) throw new Error('The source Save control did not render.');
    save.click();

    await until('the real API edit to update every view', () =>
      roots.every((root) => value(root, WIDGET_ID, 'row-total').text === '0'),
    );
    await until(
      'the real API edit to flush',
      () => source.element.querySelector('[role="status"]')?.textContent?.includes('Changes saved') === true,
    );
    expect(value(source.element, GADGET_ID, 'row-total').text).toBe('12');
    expect(value(firstView.element, GADGET_ID, 'row-total').text).toBe('12');
    expect(value(secondView.element, GADGET_ID, 'row-total').text).toBe('12');

    const changed = fixture.data.snapshot(fixture.databaseId as PageId);
    expect(changed).toMatchObject({
      status: 'ready',
      rows: [
        { id: WIDGET_ID, properties: { quantity: 0 } },
        { id: GADGET_ID, properties: { quantity: 3 } },
      ],
    });
    if (changed.status !== 'ready') throw new Error('The provider API stopped being ready.');
    expect(Object.hasOwn(changed.rows[0]!.properties, 'row-total')).toBe(false);
    expect(fixture.vault.text(WIDGET_PATH)).toContain('Quantity: 0');
    expect(fixture.vault.text(WIDGET_PATH)).not.toMatch(/^Row total:/m);

    const undo = new source.window.KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    source.element.dispatchEvent(undo as unknown as Event);
    expect(undo.defaultPrevented).toBe(true);
    await until('the real DataApi history undo to update every view', () =>
      roots.every((root) => value(root, WIDGET_ID, 'row-total').text === '20'),
    );
    await until(
      'the real DataApi history undo to flush',
      () => source.element.querySelector('[role="status"]')?.textContent?.includes('Changes saved') === true,
    );
    expect(value(source.element, GADGET_ID, 'row-total').text).toBe('12');
    expect(value(firstView.element, GADGET_ID, 'row-total').text).toBe('12');
    expect(value(secondView.element, GADGET_ID, 'row-total').text).toBe('12');
    const undone = fixture.data.snapshot(fixture.databaseId as PageId);
    expect(undone.status).toBe('ready');
    if (undone.status !== 'ready') throw new Error('The provider API stopped being ready after undo.');
    expect(undone.rows.find((row) => row.id === WIDGET_ID)?.properties.quantity).toBe(2);
    expect(fixture.vault.text(WIDGET_PATH)).toContain('Quantity: 2');
    expect(fixture.vault.text(WIDGET_PATH)).not.toMatch(/^Row total:/m);
  });
});
