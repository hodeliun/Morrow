import { Window } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DataApi, DataApiSnapshot } from '../../../../src/app/plugins/dataApi';
import type { PluginEditorInsertionTargetV1 } from '../../../../src/app/plugins/editorApi';
import { decodePolarisDadosViewMarker, encodePolarisDadosViewMarker } from '../../../../src/core/polarisDadosView';
import {
  createLinkedViewInsertPicker,
  defaultLinkedViewTitle,
  createPolarisDadosViewMarker,
  type LinkedViewInsertPickerApi,
} from './insertView';
import { providerMessages } from './locale';

const windows: Window[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.abort()));
});

function insertionTarget(
  result: ReturnType<PluginEditorInsertionTargetV1['insert']>,
  inserted: string[],
  disposed: { count: number },
): PluginEditorInsertionTargetV1 {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    disposed.count += 1;
  };
  return {
    version: 1,
    insert(markdown) {
      inserted.push(markdown);
      release();
      return result;
    },
    dispose: release,
  };
}

function pickerHarness(targets: Array<PluginEditorInsertionTargetV1 | null>) {
  const window = new Window({ url: 'http://morrow.test/' });
  windows.push(window);
  vi.stubGlobal('document', window.document);
  let nextUuid = 0;
  const randomUUID = vi.fn(() => `00000000-0000-4000-8000-${String(nextUuid++).padStart(12, '0')}`);
  vi.stubGlobal('crypto', { randomUUID });

  let snapshot: DataApiSnapshot = {
    version: 1,
    status: 'ready',
    databaseId: 'inventory-source',
    revision: 'source-revision-1',
    schema: { properties: [], views: [] },
    rows: [],
    history: { canUndo: false, canRedo: false },
    readonly: false,
    diagnostic: null,
  } as DataApiSnapshot;
  const api: LinkedViewInsertPickerApi = {
    locale: 'pt',
    pages: {
      list: () => [{ id: 'inventory-source', title: 'Inventário ✨', kind: 'database' }],
    },
    data: { version: 1, snapshot: () => snapshot } as unknown as DataApi,
    editor: {
      insertion: {
        version: 1,
        capture: () => targets.shift() ?? null,
      },
    },
  };

  return {
    window,
    api,
    randomUUID,
    setReadonly() {
      snapshot = {
        ...snapshot,
        readonly: true,
        diagnostic: { code: 'host-readonly', message: 'Morrow is in read-only mode.' },
      } as DataApiSnapshot;
    },
  };
}

function chooseSource(window: Window): void {
  const select = query<HTMLSelectElement>(window, 'select[data-polaris-action="source"]');
  if (!select) throw new Error('The picker source selector was not mounted.');
  select.value = 'inventory-source';
  select.dispatchEvent(new window.Event('change', { bubbles: true }) as unknown as Event);
}

function query<T>(window: Window, selector: string): T | null {
  return window.document.querySelector(selector) as unknown as T | null;
}

describe('Polaris Dados insertion payload', () => {
  it('matches the host v1 marker codec for localized accents and emoji', () => {
    const view = {
      version: 1 as const,
      viewId: 'view-synthetic-1',
      sourceDatabaseId: 'inventory-source',
      title: 'Inventário ✨ — visualização',
      columnOrder: [] as string[],
      filter: null,
    };

    expect(createPolarisDadosViewMarker(view)).toBe(encodePolarisDadosViewMarker(view));
  });

  it('keeps the generated title readable and within the host title limit without cutting emoji', () => {
    const messages = providerMessages('pt');
    const title = defaultLinkedViewTitle(`${'A'.repeat(280)}✨${'B'.repeat(40)}`, messages);

    expect(title.length).toBeLessThanOrEqual(300);
    expect(title).toContain('✨');
    expect(title).toMatch(/ — visualização$/);
    const sourcePart = title.slice(0, title.indexOf(' — '));
    expect(sourcePart).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it('captures before opening, cancels without creating an ID or inserting, and cannot reopen after unload', () => {
    const inserted: string[] = [];
    const targetDisposed = { count: 0 };
    const unloadDisposed = { count: 0 };
    const target = insertionTarget({ ok: true }, inserted, targetDisposed);
    const unloadTarget = insertionTarget({ ok: true }, inserted, unloadDisposed);
    const targets = [target, unloadTarget];
    const harness = pickerHarness(targets);
    const capture = vi.spyOn(harness.api.editor.insertion, 'capture');
    capture.mockImplementation(() => {
      expect(harness.window.document.querySelector('[data-polaris-dados-picker]')).toBeNull();
      return targets.shift() ?? null;
    });
    const picker = createLinkedViewInsertPicker(harness.api);

    picker.open();
    chooseSource(harness.window);
    expect(harness.randomUUID).not.toHaveBeenCalled();
    query<HTMLButtonElement>(harness.window, 'button[data-polaris-action="cancel"]')?.click();

    expect(inserted).toEqual([]);
    expect(targetDisposed.count).toBe(1);
    picker.open();
    const staleInsert = query<HTMLButtonElement>(harness.window, 'button[data-polaris-action="insert"]');
    expect(staleInsert).not.toBeNull();
    picker.dispose();
    staleInsert?.click();
    expect(unloadDisposed.count).toBe(1);
    expect(inserted).toEqual([]);
    picker.open();
    expect(capture).toHaveBeenCalledTimes(2);
    expect(harness.window.document.querySelector('[data-polaris-dados-picker]')).toBeNull();
  });

  it('closes on Escape and releases the target without creating an ID or inserting', () => {
    const inserted: string[] = [];
    const disposed = { count: 0 };
    const target = insertionTarget({ ok: true }, inserted, disposed);
    const harness = pickerHarness([target]);
    const picker = createLinkedViewInsertPicker(harness.api);
    picker.open();
    chooseSource(harness.window);

    const panel = query<HTMLElement>(harness.window, '[data-polaris-dados-picker]');
    const source = query<HTMLSelectElement>(harness.window, 'select[data-polaris-action="source"]');
    if (!panel || !source) throw new Error('The picker focus target was not mounted.');
    expect(harness.window.document.activeElement).toBe(source);
    const escape = new harness.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    source.dispatchEvent(escape as unknown as Event);

    expect(escape.defaultPrevented).toBe(true);
    expect(panel.isConnected).toBe(false);
    expect(disposed.count).toBe(1);
    expect(harness.randomUUID).not.toHaveBeenCalled();
    expect(inserted).toEqual([]);
    picker.dispose();
  });

  it('revalidates an ineligible source before creating an ID or using the captured target', () => {
    const inserted: string[] = [];
    const disposed = { count: 0 };
    const target = insertionTarget({ ok: true }, inserted, disposed);
    const harness = pickerHarness([target]);
    const picker = createLinkedViewInsertPicker(harness.api);
    picker.open();
    chooseSource(harness.window);
    harness.setReadonly();
    query<HTMLButtonElement>(harness.window, 'button[data-polaris-action="insert"]')?.click();

    expect(harness.randomUUID).not.toHaveBeenCalled();
    expect(inserted).toEqual([]);
    expect(query<HTMLSelectElement>(harness.window, 'select[data-polaris-action="source"]')?.value).toBe('inventory-source');
    expect(harness.window.document.querySelector('[data-polaris-action="status"]')?.textContent).toContain('somente leitura');
    picker.dispose();
    expect(disposed.count).toBe(1);

    const readonlyPicker = createLinkedViewInsertPicker(harness.api);
    readonlyPicker.open();
    expect(harness.window.document.querySelector('[data-polaris-action="status"]')?.textContent).toContain('modo somente leitura');
    readonlyPicker.dispose();
  });

  it('preserves the selected source after a stale refusal and inserts only after explicit recapture', () => {
    const inserted: string[] = [];
    const firstDisposed = { count: 0 };
    const nextDisposed = { count: 0 };
    const first = insertionTarget({ ok: false, reason: 'selection-changed' }, inserted, firstDisposed);
    const next = insertionTarget({ ok: true }, inserted, nextDisposed);
    const harness = pickerHarness([first, null, next]);
    const picker = createLinkedViewInsertPicker(harness.api);
    picker.open();
    chooseSource(harness.window);
    query<HTMLButtonElement>(harness.window, 'button[data-polaris-action="insert"]')?.click();

    expect(query<HTMLSelectElement>(harness.window, 'select[data-polaris-action="source"]')?.value).toBe('inventory-source');
    expect(harness.window.document.querySelector('[data-polaris-action="status"]')?.textContent).toContain('seleção mudou');
    expect(query<HTMLButtonElement>(harness.window, 'button[data-polaris-action="insert"]')?.disabled).toBe(true);
    const recapture = query<HTMLButtonElement>(harness.window, 'button[data-polaris-action="recapture"]');
    recapture?.click();
    expect(query<HTMLSelectElement>(harness.window, 'select[data-polaris-action="source"]')?.value).toBe('inventory-source');
    expect(query<HTMLButtonElement>(harness.window, 'button[data-polaris-action="insert"]')?.disabled).toBe(true);
    recapture?.click();
    expect(query<HTMLSelectElement>(harness.window, 'select[data-polaris-action="source"]')?.value).toBe('inventory-source');
    expect(query<HTMLButtonElement>(harness.window, 'button[data-polaris-action="insert"]')?.disabled).toBe(false);
    query<HTMLButtonElement>(harness.window, 'button[data-polaris-action="insert"]')?.click();

    expect(inserted).toHaveLength(2);
    expect(decodePolarisDadosViewMarker(inserted[1]!)).toMatchObject({
      sourceDatabaseId: 'inventory-source',
      title: 'Inventário ✨ — visualização',
      columnOrder: [],
      filter: null,
    });
    expect(firstDisposed.count).toBe(1);
    expect(nextDisposed.count).toBe(1);
    expect(harness.window.document.querySelector('[data-polaris-dados-picker]')).toBeNull();
    picker.dispose();
  });
});
