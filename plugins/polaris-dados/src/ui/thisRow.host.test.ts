import { Window } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  DataApi,
  DataApiFlushResult,
  DataApiHistoryResult,
  DataApiPatchResult,
  DataApiSnapshot,
} from '../../../../src/app/plugins/dataApi';
import type {
  LinkedViewApi,
  LinkedViewConfig,
  LinkedViewFlushResult,
  LinkedViewHistoryResult,
  LinkedViewMutationResult,
  LinkedViewSnapshot,
} from '../../../../src/app/plugins/linkedViewApi';
import { mountPolarisDados } from './mount';
import type { ReadySnapshot } from './formulas';

const DATABASE_ID = 'inventory';
const properties: ReadySnapshot['schema']['properties'] = [
  { id: 'name', name: 'Name', type: 'text', options: [] },
  { id: 'quantity', name: 'Quantity', type: 'number', options: [] },
  { id: 'price', name: 'Price', type: 'number', options: [] },
  { id: 'total', name: 'Total', type: 'formula', options: [], formula: 'Quantity * Price' },
  {
    id: 'row-total',
    name: 'Row total',
    type: 'formula',
    options: [],
    formula: 'thisRow.Quantity * thisRow.Price',
  },
  {
    id: 'list-sum',
    name: 'List sum',
    type: 'formula',
    options: [],
    formula: 'List(thisRow.Quantity, thisRow.Price).Sum()',
  },
  { id: 'row-list', name: 'Row list', type: 'formula', options: [], formula: '[thisRow]' },
  { id: 'nested-row-list', name: 'Nested row list', type: 'formula', options: [], formula: '[[thisRow]]' },
];

type ReadyViewSnapshot = Extract<LinkedViewSnapshot, { status: 'ready' }>;

function makeDataApi() {
  let revision = 1;
  let current: ReadySnapshot = {
    version: 1,
    status: 'ready',
    databaseId: DATABASE_ID,
    revision: `revision-${revision}`,
    schema: { properties, views: [] },
    rows: [{ id: 'widget', title: 'Widget', properties: { name: 'Widget', quantity: 2, price: 10 } }],
    history: { canUndo: false, canRedo: false },
    readonly: false,
    diagnostic: null,
  };
  const listeners = new Set<(snapshot: DataApiSnapshot) => void>();
  const patchCalls: Array<Parameters<DataApi['patchCell']>[0]> = [];

  const publish = (patch: Record<string, string | number | null>) => {
    const row = current.rows[0]!;
    current = {
      ...current,
      revision: `revision-${++revision}`,
      rows: [{ ...row, properties: { ...row.properties, ...patch } }],
      history: { canUndo: true, canRedo: false },
    };
    for (const listener of [...listeners]) listener(current);
  };

  const api: DataApi = {
    version: 1,
    snapshot(databaseId) {
      if (databaseId !== DATABASE_ID) throw new Error('The test API is scoped to Inventory.');
      return current;
    },
    patchCell(input): DataApiPatchResult {
      patchCalls.push(input);
      if (input.databaseId !== DATABASE_ID)
        return { status: 'error', code: 'out-of-scope', message: 'Database is out of scope.' };
      if (input.expectedRevision !== current.revision)
        return { status: 'error', code: 'stale-revision', message: 'Expected a different revision.' };
      if (input.propertyId !== 'quantity' || typeof input.value !== 'number' || !Number.isFinite(input.value))
        return { status: 'error', code: 'invalid-value', message: 'Quantity must be a finite number.' };
      if (!current.rows.some((row) => row.id === input.rowId))
        return { status: 'error', code: 'row-not-found', message: 'The row is unavailable.' };
      publish({ [input.propertyId]: input.value });
      return {
        status: 'staged',
        databaseId: DATABASE_ID,
        rowId: input.rowId,
        propertyId: input.propertyId,
        revision: current.revision,
      };
    },
    history(input): DataApiHistoryResult {
      return {
        status: 'no-op',
        databaseId: DATABASE_ID,
        revision: current.revision,
        direction: input.direction,
      };
    },
    subscribe(databaseId, listener) {
      if (databaseId !== DATABASE_ID) throw new Error('The test API is scoped to Inventory.');
      listeners.add(listener);
      listener(current);
      return () => listeners.delete(listener);
    },
    async flush(): Promise<DataApiFlushResult> {
      return { status: 'persisted', databaseId: DATABASE_ID, revision: current.revision };
    },
  };

  return { api, patchCalls, current: () => current };
}

function makeLinkedViewApi(config: LinkedViewConfig): LinkedViewApi {
  const current: ReadyViewSnapshot = {
    version: 1,
    status: 'ready',
    pageId: 'linked-note',
    viewId: 'linked-view',
    sourceDatabaseId: DATABASE_ID,
    revision: 'view-1',
    config,
    sourceStatus: { status: 'available', diagnostic: null },
    readonly: false,
    diagnostic: null,
    history: { canUndo: false, canRedo: false },
  };
  const api: LinkedViewApi = {
    version: 1,
    snapshot: () => current,
    patchConfig(): LinkedViewMutationResult {
      return { status: 'staged', pageId: current.pageId, viewId: current.viewId, revision: current.revision };
    },
    history(input): LinkedViewHistoryResult {
      return {
        status: 'no-op',
        pageId: current.pageId,
        viewId: current.viewId,
        revision: current.revision,
        direction: input.direction,
      };
    },
    subscribe(listener) {
      listener(current);
      return () => {};
    },
    async flush(): Promise<LinkedViewFlushResult> {
      return {
        status: 'persisted',
        pageId: current.pageId,
        viewId: current.viewId,
        revision: current.revision,
      };
    },
  };
  return api;
}

const windows: Window[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.abort()));
});

function mountRoots() {
  const window = new Window({ url: 'http://morrow.test/' });
  windows.push(window);
  const source = window.document.createElement('div');
  const linked = window.document.createElement('div');
  const sourceElement = source as unknown as HTMLElement;
  const linkedElement = linked as unknown as HTMLElement;
  window.document.body.append(source, linked);
  const data = makeDataApi();
  const signal = new AbortController().signal;
  cleanups.push(
    mountPolarisDados({
      element: sourceElement,
      databaseId: DATABASE_ID,
      data: data.api,
      locale: 'en',
      editable: true,
      signal,
    }),
    mountPolarisDados({
      element: linkedElement,
      databaseId: DATABASE_ID,
      data: data.api,
      locale: 'en',
      editable: true,
      signal,
      view: makeLinkedViewApi({ title: 'Inventory view', columnOrder: [], filter: null }),
    }),
  );
  return { window, source: sourceElement, linked: linkedElement, data };
}

function value(root: HTMLElement, propertyId: string): string | null {
  return root.querySelector(`[data-field="${propertyId}"] [data-value-kind="number"]`)?.textContent ?? null;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('Polaris Dados thisRow host rendering', () => {
  it('recomputes the existing quantity × price contract in source and linked views after a numeric edit', async () => {
    const { window, source, linked, data } = mountRoots();
    expect(value(source, 'total')).toBe('20');
    expect(value(source, 'row-total')).toBe('20');
    expect(value(source, 'list-sum')).toBe('12');
    expect(value(linked, 'total')).toBe('20');
    expect(value(linked, 'row-total')).toBe('20');
    expect(value(linked, 'list-sum')).toBe('12');
    for (const root of [source, linked]) {
      expect(root.querySelector('[data-field="row-list"] [data-value-kind="error"]')?.textContent).toBe(
        'Formula error',
      );
      expect(
        root.querySelector('[data-field="nested-row-list"] [data-value-kind="error"]')?.textContent,
      ).toBe('Formula error');
    }

    const editButton = source.querySelector<HTMLButtonElement>(
      'button[data-action="edit"][data-field="quantity"]',
    );
    if (!editButton) throw new Error('The source Quantity edit control did not render.');
    editButton.click();
    const input = source.querySelector<HTMLInputElement>('input[data-field="quantity"]');
    if (!input) throw new Error('The source Quantity editor did not open.');
    input.value = '3';
    input.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
    input.dispatchEvent(
      new window.KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }) as unknown as Event,
    );
    await settle();

    expect(data.patchCalls).toHaveLength(1);
    expect(data.patchCalls[0]).toMatchObject({ propertyId: 'quantity', value: 3 });
    expect(value(source, 'total')).toBe('30');
    expect(value(source, 'row-total')).toBe('30');
    expect(value(source, 'list-sum')).toBe('13');
    expect(value(linked, 'total')).toBe('30');
    expect(value(linked, 'row-total')).toBe('30');
    expect(value(linked, 'list-sum')).toBe('13');
    expect(data.current().rows[0]?.properties).toEqual({ name: 'Widget', quantity: 3, price: 10 });
  });
});
