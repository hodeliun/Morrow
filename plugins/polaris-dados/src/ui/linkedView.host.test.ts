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

type ReadyViewSnapshot = Extract<LinkedViewSnapshot, { status: 'ready' }>;
type Property = ReadySnapshot['schema']['properties'][number];

const DATABASE_ID = 'inventory';
const properties: readonly Property[] = [
  { id: 'name', name: 'Name', type: 'text', options: [] },
  { id: 'quantity', name: 'Quantity', type: 'number', options: [] },
  { id: 'price', name: 'Price', type: 'number', options: [] },
];

function initialDataSnapshot(): ReadySnapshot {
  return {
    version: 1,
    status: 'ready',
    databaseId: DATABASE_ID,
    revision: 'data-1',
    schema: { properties, views: [] },
    rows: [
      { id: 'widget', title: 'Widget', properties: { name: 'Catalog label', quantity: 4, price: 10 } },
      { id: 'gadget', title: 'Gadget', properties: { name: 'Shelf name', quantity: 1, price: 5 } },
    ],
    history: { canUndo: false, canRedo: false },
    readonly: false,
    diagnostic: null,
  };
}

function makeDataApi(snapshot = initialDataSnapshot()) {
  const patchCalls: Parameters<DataApi['patchCell']>[0][] = [];
  const historyCalls: Parameters<DataApi['history']>[0][] = [];
  const listeners = new Set<(snapshot: DataApiSnapshot) => void>();
  const api: DataApi = {
    version: 1,
    snapshot: () => snapshot,
    patchCell(input): DataApiPatchResult {
      patchCalls.push(input);
      return {
        status: 'staged',
        databaseId: DATABASE_ID,
        rowId: input.rowId,
        propertyId: input.propertyId,
        revision: snapshot.revision,
      };
    },
    history(input): DataApiHistoryResult {
      historyCalls.push(input);
      return {
        status: 'no-op',
        databaseId: DATABASE_ID,
        revision: snapshot.revision,
        direction: input.direction,
      };
    },
    subscribe(_databaseId, listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    async flush(): Promise<DataApiFlushResult> {
      return { status: 'persisted', databaseId: DATABASE_ID, revision: snapshot.revision };
    },
  };
  return { api, patchCalls, historyCalls, subscriberCount: () => listeners.size };
}

function makeViewApi(config: LinkedViewConfig) {
  let revision = 1;
  let current: ReadyViewSnapshot = {
    version: 1,
    status: 'ready',
    pageId: 'linked-note',
    viewId: 'view-1',
    sourceDatabaseId: DATABASE_ID,
    revision: `view-${revision}`,
    config,
    sourceStatus: { status: 'available', diagnostic: null },
    readonly: false,
    diagnostic: null,
    history: { canUndo: false, canRedo: false },
  };
  const listeners = new Set<(snapshot: LinkedViewSnapshot) => void>();
  const patchCalls: Parameters<LinkedViewApi['patchConfig']>[0][] = [];
  const historyCalls: Parameters<LinkedViewApi['history']>[0][] = [];
  const flushCalls: number[] = [];
  const undo: LinkedViewConfig[] = [];
  const redo: LinkedViewConfig[] = [];
  let nextFlush: (() => Promise<LinkedViewFlushResult>) | null = null;
  let stageErrorOnce = false;

  const publish = (nextConfig: LinkedViewConfig, direction: 'undo' | 'redo' | null) => {
    current = {
      ...current,
      revision: `view-${++revision}`,
      config: nextConfig,
      history: { canUndo: undo.length > 0, canRedo: redo.length > 0 },
    };
    for (const listener of [...listeners]) listener(current);
    return direction;
  };
  const api: LinkedViewApi = {
    version: 1,
    snapshot: () => current,
    patchConfig(input): LinkedViewMutationResult {
      patchCalls.push(input);
      if (input.expectedRevision !== current.revision)
        return { status: 'error', code: 'stale-revision', message: 'stale' };
      undo.push(current.config);
      redo.splice(0);
      const nextConfig = { ...current.config, ...input.patch };
      publish(nextConfig, null);
      if (stageErrorOnce) {
        stageErrorOnce = false;
        return {
          status: 'error',
          code: 'page-editor-conflict',
          message: 'The config was staged while page synchronization reported an error.',
          staged: true,
          pageId: current.pageId,
          viewId: current.viewId,
          revision: current.revision,
        };
      }
      return { status: 'staged', pageId: current.pageId, viewId: current.viewId, revision: current.revision };
    },
    history(input): LinkedViewHistoryResult {
      historyCalls.push(input);
      if (input.expectedRevision !== current.revision)
        return { status: 'error', code: 'stale-revision', message: 'stale' };
      const source = input.direction === 'undo' ? undo : redo;
      const destination = input.direction === 'undo' ? redo : undo;
      const previous = source.pop();
      if (!previous)
        return {
          status: 'no-op',
          pageId: current.pageId,
          viewId: current.viewId,
          revision: current.revision,
          direction: input.direction,
        };
      destination.push(current.config);
      publish(previous, input.direction);
      return {
        status: 'staged',
        pageId: current.pageId,
        viewId: current.viewId,
        revision: current.revision,
        direction: input.direction,
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(current);
      return () => listeners.delete(listener);
    },
    async flush(): Promise<LinkedViewFlushResult> {
      flushCalls.push(Date.now());
      const behavior = nextFlush;
      nextFlush = null;
      return behavior
        ? behavior()
        : { status: 'persisted', pageId: current.pageId, viewId: current.viewId, revision: current.revision };
    },
  };

  return {
    api,
    patchCalls,
    historyCalls,
    flushCalls,
    failNextFlush(message: string) {
      nextFlush = async () => ({
        status: 'error',
        code: 'save-failed',
        message,
        staged: true,
        pageId: current.pageId,
        viewId: current.viewId,
        revision: current.revision,
      });
    },
    failPatchAfterStagingOnce() {
      stageErrorOnce = true;
    },
  };
}

const windows: Window[] = [];

afterEach(async () => {
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.abort()));
});

function mountLinked(config: LinkedViewConfig) {
  const window = new Window({ url: 'http://morrow.test/' });
  windows.push(window);
  const domElement = window.document.createElement('div');
  window.document.body.append(domElement);
  const element = domElement as unknown as HTMLElement;
  const controller = new AbortController();
  const data = makeDataApi();
  const view = makeViewApi(config);
  const cleanup = mountPolarisDados({
    element: element as unknown as HTMLElement,
    databaseId: DATABASE_ID,
    data: data.api,
    locale: 'en',
    editable: true,
    signal: controller.signal,
    view: view.api,
  });
  return { window, element, controller, cleanup, data, view };
}

function click(window: Window, element: Element | null): void {
  if (!element) throw new Error('Expected a UI control.');
  element.dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true }) as unknown as Event,
  );
}

function input(window: Window, element: HTMLInputElement | HTMLSelectElement, value: string): void {
  element.value = value;
  element.dispatchEvent(
    new window.Event(element instanceof window.HTMLSelectElement ? 'change' : 'input', {
      bubbles: true,
    }) as unknown as Event,
  );
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Polaris Dados linked view UI', () => {
  it('saves local title, partial column priority, and numeric filter through the linked API', async () => {
    const mounted = mountLinked({ title: 'Inventory view', columnOrder: [], filter: null });
    const { element, window, view, data } = mounted;
    click(window, element.querySelector('[data-action="view-settings-toggle"]'));

    const title = element.querySelector<HTMLInputElement>('[data-action="view-title"]')!;
    input(window, title, 'Quantity at least two');
    input(
      window,
      element.querySelector<HTMLSelectElement>('[data-action="view-filter-property"]')!,
      'quantity',
    );
    input(window, element.querySelector<HTMLInputElement>('[data-action="view-filter-value"]')!, '2');
    const quantityPriority = element.querySelector<HTMLButtonElement>(
      '[data-action="view-priority"][data-column-id="quantity"]',
    );
    if (!quantityPriority) throw new Error('Expected the Quantity priority control.');
    expect(quantityPriority.textContent).toBe('Quantity');
    expect(quantityPriority.getAttribute('aria-pressed')).toBe('false');
    click(window, quantityPriority);
    expect(
      element
        .querySelector<HTMLButtonElement>('[data-action="view-priority"][data-column-id="quantity"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    element
      .querySelector<HTMLFormElement>('[data-view-settings-form]')!
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event);
    await flushMicrotasks();

    expect(view.patchCalls).toEqual([
      {
        patch: {
          title: 'Quantity at least two',
          columnOrder: ['quantity'],
          filter: { propertyId: 'quantity', op: 'gte', value: 2 },
        },
        expectedRevision: 'view-1',
      },
    ]);
    expect(view.api.snapshot()).toMatchObject({
      status: 'ready',
      config: {
        title: 'Quantity at least two',
        columnOrder: ['quantity'],
        filter: { propertyId: 'quantity', op: 'gte', value: 2 },
      },
    });
    expect([...element.querySelectorAll('thead th')].map((heading) => heading.textContent)).toEqual([
      'Row title',
      'Quantity',
      'Name',
      'Price',
    ]);
    expect(element.querySelector('caption')?.textContent).toBe('Quantity at least two');
    expect(
      [...element.querySelectorAll<HTMLTableRowElement>('tbody tr')].map((row) => row.dataset.rowId),
    ).toEqual(['widget']);
    expect(element.querySelector('tbody')?.textContent).toContain('Catalog label');
    expect(view.flushCalls).toHaveLength(1);
    expect(data.patchCalls).toHaveLength(0);
    expect(data.historyCalls).toHaveLength(0);
    mounted.cleanup();
  });

  it('preserves priority-control focus through toggle and reorder without stealing another root focus', () => {
    const mounted = mountLinked({
      title: 'Inventory view',
      columnOrder: ['quantity', 'price'],
      filter: null,
    });
    const { element, window } = mounted;
    click(window, element.querySelector('[data-action="view-settings-toggle"]'));

    const namePriority = element.querySelector<HTMLButtonElement>(
      '[data-action="view-priority"][data-column-id="name"]',
    )!;
    namePriority.focus();
    click(window, namePriority);
    const toggledName = element.querySelector<HTMLButtonElement>(
      '[data-action="view-priority"][data-column-id="name"]',
    )!;
    expect(toggledName.getAttribute('aria-pressed')).toBe('true');
    expect(window.document.activeElement).toBe(toggledName);

    const priceMoveDown = element.querySelector<HTMLButtonElement>(
      '[data-action="view-move-down"][data-column-id="price"]',
    )!;
    priceMoveDown.focus();
    click(window, priceMoveDown);
    const priceMoveUp = element.querySelector<HTMLButtonElement>(
      '[data-action="view-move-up"][data-column-id="price"]',
    );
    expect(priceMoveUp).not.toBeNull();
    expect(window.document.activeElement).toBe(priceMoveUp);

    const secondRoot = window.document.createElement('button');
    window.document.body.append(secondRoot);
    secondRoot.focus();
    click(window, element.querySelector('[data-action="view-priority"][data-column-id="name"]'));
    expect(window.document.activeElement).toBe(secondRoot);
    mounted.cleanup();
  });

  it('keeps linked-view keyboard history independent inside an editable document', async () => {
    const mounted = mountLinked({ title: 'Inventory view', columnOrder: [], filter: null });
    const { element, window, view, data } = mounted;
    const document = element.ownerDocument;
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    element.parentElement?.replaceChild(editor, element);
    editor.append(element);
    element.setAttribute('contenteditable', 'false');
    element.tabIndex = -1;

    click(window, element.querySelector('[data-action="view-settings-toggle"]'));
    const title = element.querySelector<HTMLInputElement>('[data-action="view-title"]');
    if (!title) throw new Error('The linked view title input did not render.');
    input(window, title, 'Renamed view');
    element
      .querySelector<HTMLFormElement>('[data-view-settings-form]')!
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event);
    await flushMicrotasks();
    expect(view.api.snapshot()).toMatchObject({
      status: 'ready',
      config: { title: 'Renamed view' },
      history: { canUndo: true },
    });

    const settingsToggle = element.querySelector<HTMLButtonElement>('[data-action="view-settings-toggle"]');
    if (!settingsToggle) throw new Error('The linked view settings control did not render.');
    settingsToggle.focus();
    expect(document.activeElement).toBe(settingsToggle);
    const undo = new window.KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, bubbles: true, cancelable: true,
    });
    settingsToggle.dispatchEvent(undo as unknown as Event);
    expect(undo.target).toBe(settingsToggle);
    await flushMicrotasks();
    expect(undo.defaultPrevented).toBe(true);
    expect(view.historyCalls.map(({ direction }) => direction)).toEqual(['undo']);
    expect(data.historyCalls).toHaveLength(0);
    expect(view.api.snapshot()).toMatchObject({ config: { title: 'Inventory view' } });
    mounted.cleanup();
  });

  it('returns focus to settings when explicit missing-reference repair removes its own button', () => {
    const mounted = mountLinked({
      title: 'Inventory view',
      columnOrder: ['deleted-column'],
      filter: null,
    });
    const { element, window, view } = mounted;
    click(window, element.querySelector('[data-action="view-settings-toggle"]'));
    const repair = element.querySelector<HTMLButtonElement>(
      '[data-action="view-remove-unavailable-columns"]',
    );
    if (!repair) throw new Error('Expected the explicit missing-reference repair button.');
    repair.focus();
    click(window, repair);

    const settingsToggle = element.querySelector('[data-action="view-settings-toggle"]');
    expect(element.querySelector('[data-action="view-remove-unavailable-columns"]')).toBeNull();
    expect(window.document.activeElement).toBe(settingsToggle);
    expect(view.patchCalls).toHaveLength(0);
    expect(view.historyCalls).toHaveLength(0);
    mounted.cleanup();
  });

  it('preserves unavailable references on title-only Save and offers Retry without Cancel after staged failure', async () => {
    const original = {
      title: 'Inventory view',
      columnOrder: ['deleted-column', 'quantity'],
      filter: { propertyId: 'deleted-filter', op: 'gte' as const, value: 2 },
    };
    const mounted = mountLinked(original);
    const { element, window, view } = mounted;
    expect(element.querySelectorAll('tbody tr')).toHaveLength(2);
    click(window, element.querySelector('[data-action="view-settings-toggle"]'));
    expect(element.querySelector('[data-action="view-remove-unavailable-columns"]')?.textContent).toBe(
      'Remove unavailable references',
    );
    const title = element.querySelector<HTMLInputElement>('[data-action="view-title"]')!;
    const originalInputNode = title;
    input(window, title, 'Renamed locally');
    view.failPatchAfterStagingOnce();
    view.failNextFlush('Temporary persistence failure.');
    element
      .querySelector<HTMLFormElement>('[data-view-settings-form]')!
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event);
    await flushMicrotasks();

    expect(view.patchCalls).toEqual([{ patch: { title: 'Renamed locally' }, expectedRevision: 'view-1' }]);
    expect(view.api.snapshot()).toMatchObject({
      status: 'ready',
      config: {
        title: 'Renamed locally',
        columnOrder: ['deleted-column', 'quantity'],
        filter: { propertyId: 'deleted-filter', op: 'gte', value: 2 },
      },
    });
    expect(element.querySelector('[data-action="view-retry"]')).not.toBeNull();
    expect(element.querySelector<HTMLButtonElement>('[data-action="view-cancel"]')?.disabled).toBe(true);
    expect(element.querySelector('[data-action="view-title"]')).toBe(originalInputNode);

    click(window, element.querySelector('[data-action="view-retry"]'));
    await flushMicrotasks();
    expect(view.flushCalls).toHaveLength(2);
    expect(view.patchCalls).toHaveLength(1);
    expect(view.historyCalls).toHaveLength(0);
    expect(element.querySelector('[data-action="view-retry"]')).toBeNull();
    expect(element.querySelector('[data-action="view-title"]')).toBe(originalInputNode);
    mounted.cleanup();
  });

  it('shows an inert localized diagnostic for an unsupported linked-view API version', async () => {
    const window = new Window({ url: 'http://morrow.test/' });
    windows.push(window);
    const domElement = window.document.createElement('div');
    window.document.body.append(domElement);
    const element = domElement as unknown as HTMLElement;
    const controller = new AbortController();
    const data = makeDataApi();
    const cleanup = mountPolarisDados({
      element,
      databaseId: DATABASE_ID,
      data: data.api,
      locale: 'en',
      editable: true,
      signal: controller.signal,
      view: { version: 2 } as unknown as LinkedViewApi,
    });

    expect(element.querySelector('[role="alert"]')?.textContent).toContain('does not support');
    expect(data.subscriberCount()).toBe(0);
    expect(data.patchCalls).toHaveLength(0);
    expect(data.historyCalls).toHaveLength(0);
    cleanup();
  });
});
