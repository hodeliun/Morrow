// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageId } from '../../../../src/core/model';
import type {
  DataApi,
  DataApiFlushResult,
  DataApiHistoryResult,
  DataApiPatchResult,
  DataApiSnapshot,
} from '../../../../src/app/plugins/dataApi';
import type { DatabaseProviderContext } from '../../../../src/app/plugins/providerApi';
import { mountPolarisDados } from './mount';

const databaseId = 'inventory-db' as PageId;
const rowId = 'widget-row' as PageId;

interface FakeApiOptions {
  readonly flush?: (attempt: number, revision: string) => Promise<DataApiFlushResult>;
  readonly subscribe?: (
    snapshot: DataApiSnapshot,
    listener: (snapshot: DataApiSnapshot) => void,
  ) => () => void;
}

function fakeDataApi(options: FakeApiOptions = {}) {
  let quantity = 2;
  let price = 10;
  let revisionNumber = 1;
  let flushAttempt = 0;
  let snapshot = makeSnapshot();
  const listeners = new Set<(value: DataApiSnapshot) => void>();

  function makeSnapshot(): DataApiSnapshot {
    return {
      version: 1,
      status: 'ready',
      databaseId,
      revision: `r${revisionNumber}`,
      schema: {
        properties: [
          { id: 'name', name: 'Name', type: 'text', options: [] },
          { id: 'quantity', name: 'Quantity', type: 'number', options: [] },
          { id: 'price', name: 'Price', type: 'number', options: [] },
          { id: 'total', name: 'Total', type: 'formula', options: [], formula: 'Quantity * Price' },
        ],
        views: [],
      },
      rows: [{ id: rowId, title: 'Widget', properties: { name: 'Widget', quantity, price } }],
      history: { canUndo: true, canRedo: false },
      readonly: false,
      diagnostic: null,
    };
  }

  const publish = () => {
    revisionNumber += 1;
    snapshot = makeSnapshot();
    for (const listener of [...listeners]) listener(snapshot);
  };

  const patchCell = vi.fn((input: Parameters<DataApi['patchCell']>[0]): DataApiPatchResult => {
    if (input.expectedRevision !== snapshot.revision) {
      return { status: 'error', code: 'stale-revision', message: 'Snapshot changed.' };
    }
    if (input.databaseId !== databaseId || input.rowId !== rowId || input.propertyId !== 'quantity') {
      return { status: 'error', code: 'property-not-found', message: 'Unexpected cell.' };
    }
    quantity = input.value;
    publish();
    return { status: 'staged', databaseId, rowId, propertyId: 'quantity', revision: snapshot.revision };
  });

  const history = vi.fn((_input: Parameters<DataApi['history']>[0]): DataApiHistoryResult => ({
    status: 'no-op',
    databaseId,
    revision: snapshot.revision,
    direction: 'undo',
  }));

  const subscribe = vi.fn((id: PageId, listener: (value: DataApiSnapshot) => void) => {
    if (id !== databaseId) throw new Error('Out of scope database.');
    if (options.subscribe) return options.subscribe(snapshot, listener);
    listeners.add(listener);
    listener(snapshot);
    return () => listeners.delete(listener);
  });

  const flush = vi.fn(async (id: PageId): Promise<DataApiFlushResult> => {
    if (id !== databaseId) return { status: 'error', code: 'out-of-scope', message: 'Out of scope.' };
    flushAttempt += 1;
    if (options.flush) return options.flush(flushAttempt, snapshot.revision);
    return { status: 'persisted', databaseId, revision: snapshot.revision };
  });

  const data: DataApi = {
    version: 1,
    snapshot: vi.fn((id: PageId) => {
      if (id !== databaseId) throw new Error('Out of scope database.');
      return snapshot;
    }),
    patchCell,
    history,
    subscribe,
    flush,
  };

  return {
    data,
    patchCell,
    history,
    flush,
    publishPrice(next: number) {
      price = next;
      publish();
    },
    current() {
      return { quantity, price, revision: snapshot.revision };
    },
  };
}

function mount(root: HTMLElement, data: DataApi, options: { locale?: 'en' | 'pt' | 'es'; editable?: boolean; signal?: AbortSignal } = {}) {
  const controller = options.signal ? null : new AbortController();
  const context: DatabaseProviderContext = {
    element: root,
    databaseId,
    data,
    locale: options.locale ?? 'en',
    editable: options.editable ?? true,
    signal: options.signal ?? controller!.signal,
  };
  const cleanup = mountPolarisDados(context);
  return { cleanup, controller };
}

function rootInDocument() {
  const root = document.createElement('section');
  document.body.append(root);
  return root;
}

function click(root: ParentNode, selector: string) {
  const element = root.querySelector<HTMLButtonElement>(selector);
  if (!element) throw new Error(`Missing button ${selector}`);
  element.click();
  return element;
}

function input(root: ParentNode) {
  const element = root.querySelector<HTMLInputElement>('input[type="number"][data-field="quantity"]');
  if (!element) throw new Error('Missing quantity editor.');
  return element;
}

function setDraft(element: HTMLInputElement, value: string) {
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function keydown(
  element: HTMLElement,
  options: { key: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean },
) {
  const event = new KeyboardEvent('keydown', {
    ...options,
    bubbles: true,
    cancelable: true,
  });
  element.dispatchEvent(event);
  return event;
}

function replaceExecCommand(target: Document, implementation: (command: string) => boolean) {
  const original = Object.getOwnPropertyDescriptor(target, 'execCommand');
  const execCommand = vi.fn(implementation);
  Object.defineProperty(target, 'execCommand', {
    configurable: true,
    value: execCommand,
  });
  return {
    execCommand,
    restore() {
      if (original) Object.defineProperty(target, 'execCommand', original);
      else Reflect.deleteProperty(target, 'execCommand');
    },
  };
}

function totalText(root: ParentNode) {
  return root.querySelector('[data-property-id="total"]')?.textContent ?? '';
}

async function settle() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('Polaris Dados host grid, independent checks', () => {
  it('computes Quantity 2 × Price 10, cancels without patching, and stages 3 and 0 through the public API', async () => {
    const root = rootInDocument();
    const fake = fakeDataApi();
    const { cleanup } = mount(root, fake.data);

    expect(totalText(root)).toBe('20');
    click(root, 'button[data-action="edit"][data-field="quantity"]');
    const cancelled = input(root);
    setDraft(cancelled, '8');
    click(root, 'button[data-action="cancel"]');
    expect(fake.patchCell).not.toHaveBeenCalled();
    expect(fake.current().quantity).toBe(2);
    expect(totalText(root)).toBe('20');

    click(root, 'button[data-action="edit"][data-field="quantity"]');
    setDraft(input(root), '3');
    click(root, 'button[data-action="save"]');
    await settle();
    expect(fake.patchCell).toHaveBeenCalledTimes(1);
    expect(fake.patchCell).toHaveBeenCalledWith({
      databaseId,
      rowId,
      propertyId: 'quantity',
      value: 3,
      expectedRevision: 'r1',
    });
    expect(fake.flush).toHaveBeenCalledTimes(1);
    expect(fake.flush).toHaveBeenCalledWith(databaseId);
    expect(fake.current().quantity).toBe(3);
    expect(totalText(root)).toBe('30');
    expect(root.querySelector('[role="status"]')?.textContent).toContain('Changes saved.');

    click(root, 'button[data-action="edit"][data-field="quantity"]');
    setDraft(input(root), '0');
    click(root, 'button[data-action="save"]');
    await settle();
    expect(fake.current().quantity).toBe(0);
    expect(totalText(root)).toBe('0');
    expect(fake.patchCell).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it('routes editor undo and redo through execCommand and saves the restored draft', async () => {
    const root = rootInDocument();
    const fake = fakeDataApi();
    const { cleanup } = mount(root, fake.data);
    click(root, 'button[data-action="edit"][data-field="quantity"]');
    const editor = input(root);
    const bubbled = vi.fn();
    document.body.addEventListener('keydown', bubbled);

    const commandMock = replaceExecCommand(editor.ownerDocument, (command) => {
      if (command === 'undo') setDraft(editor, '3');
      else if (command === 'redo') setDraft(editor, '4');
      else return false;
      return true;
    });
    try {
      setDraft(editor, '4');
      const undo = keydown(editor, { key: 'z', ctrlKey: true });
      expect(commandMock.execCommand).toHaveBeenLastCalledWith('undo');
      expect(undo.defaultPrevented).toBe(true);
      expect(undo.cancelBubble).toBe(true);
      expect(editor.value).toBe('3');

      const redo = keydown(editor, { key: 'Z', ctrlKey: true, shiftKey: true });
      expect(commandMock.execCommand).toHaveBeenLastCalledWith('redo');
      expect(redo.defaultPrevented).toBe(true);
      expect(redo.cancelBubble).toBe(true);
      expect(editor.value).toBe('4');
      const finalUndo = keydown(editor, { key: 'z', metaKey: true });
      expect(commandMock.execCommand).toHaveBeenLastCalledWith('undo');
      expect(finalUndo.defaultPrevented).toBe(true);
      expect(finalUndo.cancelBubble).toBe(true);
      expect(editor.value).toBe('3');
      expect(bubbled).not.toHaveBeenCalled();
      expect(fake.history).not.toHaveBeenCalled();

      click(root, 'button[data-action="save"]');
      await settle();
      expect(fake.patchCell).toHaveBeenCalledWith({
        databaseId,
        rowId,
        propertyId: 'quantity',
        value: 3,
        expectedRevision: 'r1',
      });
      expect(fake.current().quantity).toBe(3);
      expect(totalText(root)).toBe('30');
    } finally {
      commandMock.restore();
      document.body.removeEventListener('keydown', bubbled);
      cleanup();
    }
  });

  it.each([
    ['false', (): boolean => false],
    ['throw', (): boolean => { throw new Error('native undo unavailable'); }],
  ] as const)('keeps the browser default when execCommand returns or throws %s, while stopping app-level propagation', (result, implementation) => {
    const root = rootInDocument();
    const fake = fakeDataApi();
    const { cleanup } = mount(root, fake.data);
    click(root, 'button[data-action="edit"][data-field="quantity"]');
    const editor = input(root);
    setDraft(editor, '4');
    const bubbled = vi.fn();
    document.body.addEventListener('keydown', bubbled);
    const commandMock = replaceExecCommand(editor.ownerDocument, implementation);

    try {
      expect(result).toMatch(/^(false|throw)$/);
      const event = keydown(editor, { key: 'z', ctrlKey: true });
      expect(commandMock.execCommand).toHaveBeenCalledWith('undo');
      expect(event.defaultPrevented).toBe(false);
      expect(event.cancelBubble).toBe(true);
      expect(editor.value).toBe('4');
      expect(bubbled).not.toHaveBeenCalled();
      expect(fake.history).not.toHaveBeenCalled();
      expect(fake.current().quantity).toBe(2);
    } finally {
      commandMock.restore();
      document.body.removeEventListener('keydown', bubbled);
      cleanup();
    }
  });

  it.each([
    ['en', 'Polaris Data', 'Edit Quantity for Widget', 'Save', 'Cancel'],
    ['pt', 'Polaris Dados', 'Editar Quantity de Widget', 'Salvar', 'Cancelar'],
    ['es', 'Polaris Datos', 'Editar Quantity para Widget', 'Guardar', 'Cancelar'],
  ] as const)('keeps schema names and localizes grid controls in %s', (locale, region, editLabel, saveText, cancelText) => {
    const root = rootInDocument();
    const fake = fakeDataApi();
    const { cleanup } = mount(root, fake.data, { locale });
    expect(root.getAttribute('role')).toBe('region');
    expect(root.getAttribute('aria-label')).toBe(region);
    expect(root.querySelector('table')?.getAttribute('aria-label')).toBe(region);
    expect([...root.querySelectorAll('th')].map((cell) => cell.textContent)).toEqual(['Name', 'Quantity', 'Price', 'Total']);
    expect(root.querySelector('[data-action="edit"]')?.getAttribute('aria-label')).toBe(editLabel);

    click(root, 'button[data-action="edit"][data-field="quantity"]');
    expect(root.querySelector('[data-action="save"]')?.textContent).toBe(saveText);
    expect(root.querySelector('[data-action="cancel"]')?.textContent).toBe(cancelText);
    click(root, 'button[data-action="cancel"]');
    cleanup();
  });

  it('preserves the actual editor node, draft, and focus when a subscribed snapshot changes', () => {
    const root = rootInDocument();
    const fake = fakeDataApi();
    const { cleanup } = mount(root, fake.data);
    click(root, 'button[data-action="edit"][data-field="quantity"]');
    const editorBefore = input(root);
    editorBefore.focus();
    setDraft(editorBefore, '3');

    fake.publishPrice(11);

    const editorAfter = input(root);
    expect(editorAfter).toBe(editorBefore);
    expect(editorAfter.value).toBe('3');
    expect(document.activeElement).toBe(editorBefore);
    expect(totalText(root)).toBe('22');
    cleanup();
  });

  it('keeps focus in a second mounted database root when a deferred flush resolves in the first', async () => {
    let resolveFlush: ((result: DataApiFlushResult) => void) | undefined;
    let signalFlushStarted: (() => void) | undefined;
    const flushStarted = new Promise<void>((resolve) => { signalFlushStarted = resolve; });
    const fake = fakeDataApi({
      flush: () => new Promise<DataApiFlushResult>((resolve) => {
        resolveFlush = resolve;
        signalFlushStarted?.();
      }),
    });
    const first = rootInDocument();
    const second = rootInDocument();
    const firstMount = mount(first, fake.data);
    const secondMount = mount(second, fake.data);

    click(first, 'button[data-action="edit"][data-field="quantity"]');
    setDraft(input(first), '3');
    click(first, 'button[data-action="save"]');
    await flushStarted;

    click(second, 'button[data-action="edit"][data-field="quantity"]');
    const otherRootInput = input(second);
    otherRootInput.focus();
    expect(document.activeElement).toBe(otherRootInput);

    resolveFlush?.({ status: 'persisted', databaseId, revision: 'r2' });
    await settle();
    expect(document.activeElement).toBe(otherRootInput);
    expect(second.contains(document.activeElement)).toBe(true);
    firstMount.cleanup();
    secondMount.cleanup();
  });

  it('retains staged data after a flush error and retries without showing a false cancel action', async () => {
    const fake = fakeDataApi({
      flush: async (attempt) => attempt === 1
        ? { status: 'error', code: 'save-failed', message: 'synthetic write failure' }
        : { status: 'persisted', databaseId, revision: 'r2' },
    });
    const root = rootInDocument();
    const { cleanup } = mount(root, fake.data);
    click(root, 'button[data-action="edit"][data-field="quantity"]');
    setDraft(input(root), '3');
    click(root, 'button[data-action="save"]');
    await settle();

    const alert = root.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Could not save changes.');
    expect(alert?.querySelector('details')?.open).toBe(false);
    expect(alert?.textContent).toContain('synthetic write failure');
    expect(root.querySelector('[data-action="retry"]')?.textContent).toBe('Retry');
    expect(root.querySelector('[data-action="cancel"]')).toBeNull();
    expect(fake.current().quantity).toBe(3);
    expect(fake.patchCell).toHaveBeenCalledTimes(1);

    click(root, 'button[data-action="retry"]');
    await settle();
    expect(fake.flush).toHaveBeenCalledTimes(2);
    expect(fake.patchCell).toHaveBeenCalledTimes(1);
    expect(root.querySelector('[role="status"]')?.textContent).toContain('Changes saved.');
    cleanup();
  });

  it('unsubscribes when abort happens reentrantly during the immediate subscription callback', () => {
    const controller = new AbortController();
    const unsubscribe = vi.fn();
    const source = fakeDataApi({
      subscribe: (snapshot, listener) => {
        listener(snapshot);
        controller.abort();
        return unsubscribe;
      },
    });
    const root = rootInDocument();
    const { cleanup } = mount(root, source.data, { signal: controller.signal });

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(root.childElementCount).toBe(0);
    cleanup();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
