// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageId } from '../../../../src/core/model';
import type {
  DataApi,
  DataApiSnapshot,
} from '../../../../src/app/plugins/dataApi';
import type { DatabaseProviderContext } from '../../../../src/app/plugins/providerApi';
import type { LinkedViewApi, LinkedViewSnapshot } from '../../../../src/app/plugins/linkedViewApi';
import { mountPolarisDados } from './mount';

const databaseId = 'shared-stock' as PageId;
const rowId = 'widget-row' as PageId;
const viewPageId = 'views-note' as PageId;
const cleanups = new Set<() => void>();

interface SharedData {
  readonly api: DataApi;
  readonly history: ReturnType<typeof vi.fn<DataApi['history']>>;
  quantity(): number;
}

interface ViewHandle {
  readonly api: LinkedViewApi;
  readonly history: ReturnType<typeof vi.fn<LinkedViewApi['history']>>;
  title(): string;
}

interface EditorBoundary {
  readonly editor: HTMLElement;
  readonly nodeView: HTMLElement;
  readonly root: HTMLElement;
}

function sharedData(): SharedData {
  const listeners = new Set<(snapshot: DataApiSnapshot) => void>();
  let quantity = 4;
  let revision = 0;
  let canUndo = true;
  let canRedo = false;
  const undoValues = [3];
  const redoValues: number[] = [];

  const snapshot = (): DataApiSnapshot => ({
    version: 1,
    status: 'ready',
    databaseId,
    revision: `data-${revision}`,
    schema: {
      properties: [
        { id: 'name', name: 'Name', type: 'text', options: [] },
        { id: 'quantity', name: 'Quantity', type: 'number', options: [] },
        { id: 'price', name: 'Price', type: 'number', options: [] },
        { id: 'total', name: 'Total', type: 'formula', options: [], formula: 'Quantity * Price' },
      ],
      views: [],
    },
    rows: [{ id: rowId, title: 'Widget', properties: { name: 'Widget', quantity, price: 10 } }],
    history: { canUndo, canRedo },
    readonly: false,
    diagnostic: null,
  });

  const publish = () => {
    revision += 1;
    const next = snapshot();
    for (const listener of [...listeners]) listener(next);
  };

  const history = vi.fn<DataApi['history']>((input) => {
    if (input.databaseId !== databaseId || input.expectedRevision !== `data-${revision}`) {
      return { status: 'error', code: 'stale-revision', message: 'Unexpected data history revision.' };
    }
    if (input.direction === 'undo') {
      const previous = undoValues.pop();
      if (previous === undefined) {
        return { status: 'no-op', databaseId, revision: `data-${revision}`, direction: input.direction };
      }
      redoValues.push(quantity);
      quantity = previous;
      canUndo = undoValues.length > 0;
      canRedo = true;
    } else {
      const next = redoValues.pop();
      if (next === undefined) {
        return { status: 'no-op', databaseId, revision: `data-${revision}`, direction: input.direction };
      }
      undoValues.push(quantity);
      quantity = next;
      canUndo = true;
      canRedo = redoValues.length > 0;
    }
    publish();
    return { status: 'staged', databaseId, revision: `data-${revision}`, direction: input.direction };
  });

  const api: DataApi = {
    version: 1,
    snapshot(id) {
      if (id !== databaseId) throw new Error('Data handle used outside its database.');
      return snapshot();
    },
    patchCell(input) {
      if (input.databaseId !== databaseId) {
        return { status: 'error', code: 'out-of-scope', message: 'Unexpected database.' };
      }
      throw new Error(`Unexpected cell patch for ${input.propertyId}.`);
    },
    history,
    subscribe(id, listener) {
      if (id !== databaseId) throw new Error('Data handle used outside its database.');
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
    async flush(id) {
      if (id !== databaseId) return { status: 'error', code: 'out-of-scope', message: 'Unexpected database.' };
      return { status: 'persisted', databaseId, revision: `data-${revision}` };
    },
  };

  return { api, history, quantity: () => quantity };
}

function linkedView(viewId: string, title: string, previousTitle: string): ViewHandle {
  const listeners = new Set<(snapshot: LinkedViewSnapshot) => void>();
  let currentTitle = title;
  let revision = 0;
  let canUndo = true;
  let canRedo = false;

  const snapshot = (): LinkedViewSnapshot => ({
    version: 1,
    status: 'ready',
    pageId: viewPageId,
    viewId,
    sourceDatabaseId: databaseId,
    revision: `view-${viewId}-${revision}`,
    config: { title: currentTitle, columnOrder: ['name', 'quantity', 'price', 'total'], filter: null },
    sourceStatus: { status: 'available', diagnostic: null },
    readonly: false,
    diagnostic: null,
    history: { canUndo, canRedo },
  });

  const publish = () => {
    revision += 1;
    const next = snapshot();
    for (const listener of [...listeners]) listener(next);
  };

  const history = vi.fn<LinkedViewApi['history']>((input) => {
    if (input.expectedRevision !== `view-${viewId}-${revision}`) {
      return { status: 'error', code: 'stale-revision', message: 'Unexpected view history revision.' };
    }
    if (input.direction === 'undo' && canUndo) {
      currentTitle = previousTitle;
      canUndo = false;
      canRedo = true;
    } else if (input.direction === 'redo' && canRedo) {
      currentTitle = title;
      canUndo = true;
      canRedo = false;
    } else {
      return {
        status: 'no-op',
        pageId: viewPageId,
        viewId,
        revision: `view-${viewId}-${revision}`,
        direction: input.direction,
      };
    }
    publish();
    return {
      status: 'staged',
      pageId: viewPageId,
      viewId,
      revision: `view-${viewId}-${revision}`,
      direction: input.direction,
    };
  });

  const api: LinkedViewApi = {
    version: 1,
    snapshot,
    patchConfig() {
      return { status: 'no-op', pageId: viewPageId, viewId, revision: `view-${viewId}-${revision}` };
    },
    history,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
    async flush() {
      return { status: 'persisted', pageId: viewPageId, viewId, revision: `view-${viewId}-${revision}` };
    },
  };

  return { api, history, title: () => currentTitle };
}

function editorBoundary(): EditorBoundary {
  const editor = document.createElement('div');
  editor.className = 'ProseMirror';
  editor.setAttribute('contenteditable', 'true');
  const nodeView = document.createElement('div');
  nodeView.className = 'polaris-dados-view-node';
  const root = document.createElement('div');
  root.className = 'database database-provider-root polaris-dados-linked-provider-root';
  root.dataset.morrowDatabaseProvider = 'polaris-dados';
  root.setAttribute('contenteditable', 'false');
  nodeView.append(root);
  editor.append(nodeView);
  document.body.append(editor);
  return { editor, nodeView, root };
}

function mount(boundary: EditorBoundary, data: DataApi, view: LinkedViewApi): void {
  const controller = new AbortController();
  const cleanup = mountPolarisDados({
    element: boundary.root,
    databaseId,
    data,
    locale: 'en',
    editable: true,
    signal: controller.signal,
    view,
  } satisfies DatabaseProviderContext);
  cleanups.add(() => {
    cleanup();
    boundary.editor.remove();
  });
}

function keydown(
  target: HTMLElement,
  options: { readonly key: string; readonly ctrlKey?: boolean; readonly metaKey?: boolean; readonly shiftKey?: boolean },
): KeyboardEvent {
  const KeyboardEventConstructor = target.ownerDocument.defaultView!.KeyboardEvent;
  const event = new KeyboardEventConstructor('keydown', { ...options, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function total(root: ParentNode): string {
  return root.querySelector('[data-field="total"]')?.textContent?.trim() ?? '';
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups.clear();
  document.body.replaceChildren();
});

describe('Polaris Dados editor-boundary independent checks', () => {
  it('routes Ctrl+Z from the second linked provider root into the shared data history', async () => {
    const data = sharedData();
    const firstBoundary = editorBoundary();
    const secondBoundary = editorBoundary();
    const firstView = linkedView('first-view', 'First stock', 'Earlier first stock');
    const secondView = linkedView('second-view', 'Second stock', 'Earlier second stock');
    mount(firstBoundary, data.api, firstView.api);
    mount(secondBoundary, data.api, secondView.api);

    expect(total(firstBoundary.root), firstBoundary.root.innerHTML).toBe('40');
    expect(total(secondBoundary.root), secondBoundary.root.innerHTML).toBe('40');
    secondBoundary.root.focus();
    expect(document.activeElement).toBe(secondBoundary.root);
    const event = keydown(secondBoundary.root, { key: 'z', ctrlKey: true });
    expect(event.target).toBe(secondBoundary.root);
    expect(data.history).toHaveBeenCalledTimes(1);
    expect(data.history).toHaveBeenCalledWith({ databaseId, direction: 'undo', expectedRevision: 'data-0' });
    expect(event.defaultPrevented).toBe(true);
    expect(event.cancelBubble).toBe(true);

    await settle();
    expect(data.quantity()).toBe(3);
    expect(total(firstBoundary.root)).toBe('30');
    expect(total(secondBoundary.root)).toBe('30');
  });

  it('keeps each view history local while provider and bank-control shortcuts share data history', async () => {
    const data = sharedData();
    const firstBoundary = editorBoundary();
    const secondBoundary = editorBoundary();
    const firstView = linkedView('first-view', 'First stock', 'Earlier first stock');
    const secondView = linkedView('second-view', 'Second stock', 'Earlier second stock');
    mount(firstBoundary, data.api, firstView.api);
    mount(secondBoundary, data.api, secondView.api);

    secondBoundary.root.focus();
    keydown(secondBoundary.root, { key: 'z', ctrlKey: true });
    await settle();
    expect(total(firstBoundary.root)).toBe('30');
    expect(total(secondBoundary.root)).toBe('30');
    expect(firstView.history).not.toHaveBeenCalled();
    expect(secondView.history).not.toHaveBeenCalled();

    const settings = secondBoundary.root.querySelector<HTMLButtonElement>('[data-action="view-settings-toggle"]');
    expect(settings).not.toBeNull();
    settings!.focus();
    keydown(settings!, { key: 'Z', metaKey: true });
    await settle();
    expect(secondView.history).toHaveBeenCalledTimes(1);
    expect(secondView.history).toHaveBeenCalledWith({ direction: 'undo', expectedRevision: 'view-second-view-0' });
    expect(firstView.history).not.toHaveBeenCalled();
    expect(secondBoundary.root.querySelector('[data-view-title]')?.textContent).toBe('Earlier second stock');
    expect(firstBoundary.root.querySelector('[data-view-title]')?.textContent).toBe('First stock');
    expect(data.history).toHaveBeenCalledTimes(1);
    expect(data.quantity()).toBe(3);

    const edit = secondBoundary.root.querySelector<HTMLButtonElement>('button[data-action="edit"][data-field="quantity"]');
    expect(edit).not.toBeNull();
    edit!.focus();
    const redoFromControl = keydown(edit!, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(redoFromControl.defaultPrevented).toBe(true);
    await settle();
    expect(data.history).toHaveBeenCalledTimes(2);
    expect(data.history).toHaveBeenLastCalledWith({ databaseId, direction: 'redo', expectedRevision: 'data-1' });
    expect(total(firstBoundary.root)).toBe('40');
    expect(total(secondBoundary.root)).toBe('40');
    expect(secondView.history).toHaveBeenCalledTimes(1);

    const undoFromControl = secondBoundary.root.querySelector<HTMLButtonElement>('button[data-action="edit"][data-field="quantity"]');
    expect(undoFromControl).not.toBeNull();
    undoFromControl!.focus();
    keydown(undoFromControl!, { key: 'z', metaKey: true });
    await settle();
    expect(data.history).toHaveBeenCalledTimes(3);
    expect(data.history).toHaveBeenLastCalledWith({ databaseId, direction: 'undo', expectedRevision: 'data-2' });
    expect(total(firstBoundary.root)).toBe('30');
    expect(total(secondBoundary.root)).toBe('30');

    secondBoundary.root.focus();
    const redoFromRoot = keydown(secondBoundary.root, { key: 'Z', ctrlKey: true, shiftKey: true });
    expect(redoFromRoot.defaultPrevented).toBe(true);
    await settle();
    expect(data.history).toHaveBeenCalledTimes(4);
    expect(data.history).toHaveBeenLastCalledWith({ databaseId, direction: 'redo', expectedRevision: 'data-3' });
    expect(total(firstBoundary.root)).toBe('40');
    expect(total(secondBoundary.root)).toBe('40');
    expect(firstView.history).not.toHaveBeenCalled();
    expect(secondView.history).toHaveBeenCalledTimes(1);
  });

  it('leaves native text targets and shortcuts outside the provider unconsumed', () => {
    const data = sharedData();
    const boundary = editorBoundary();
    const view = linkedView('only-view', 'Stock', 'Earlier stock');
    mount(boundary, data.api, view.api);

    const input = document.createElement('input');
    input.type = 'text';
    const textarea = document.createElement('textarea');
    const nestedEditable = document.createElement('div');
    nestedEditable.setAttribute('contenteditable', 'true');
    boundary.root.append(input, textarea, nestedEditable);
    const editorKeydown = vi.fn();
    boundary.editor.addEventListener('keydown', editorKeydown);

    for (const target of [input, textarea, nestedEditable]) {
      target.focus();
      expect(document.activeElement).toBe(target);
      const event = keydown(target, { key: 'z', ctrlKey: true });
      expect(event.defaultPrevented).toBe(false);
      expect(editorKeydown).not.toHaveBeenCalled();
      expect(data.history).not.toHaveBeenCalled();
      expect(view.history).not.toHaveBeenCalled();
    }

    const outside = document.createElement('button');
    boundary.editor.append(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);
    const outsideShortcut = keydown(outside, { key: 'z', metaKey: true });
    expect(outsideShortcut.defaultPrevented).toBe(false);
    expect(editorKeydown).toHaveBeenCalledTimes(1);
    expect(editorKeydown).toHaveBeenCalledWith(outsideShortcut);
    expect(data.history).not.toHaveBeenCalled();
    expect(view.history).not.toHaveBeenCalled();
  });
});
