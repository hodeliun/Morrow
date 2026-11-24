// @vitest-environment happy-dom
import { Window } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  DataApi,
  DataApiErrorCode,
  DataApiFlushResult,
  DataApiHistoryResult,
  DataApiPatchResult,
  DataApiSnapshot,
} from '../../../../src/app/plugins/dataApi';
import type { DatabaseProviderRegistration } from '../../../../src/app/plugins/providerApi';
import type { PluginInlineFormulaPresentationMount } from '../../../../src/app/plugins/registry';
import type { PluginInlineFormulaEditAction, PluginInlineFormulaSlashCommand } from '../../../../src/app/plugins/inlineFormulaApi';
import { activate, POLARIS_DADOS_PROVIDER_ID, type PolarisDadosPluginApi } from '../main';
import { parseFiniteNumber } from './mount';

type ReadySnapshot = Extract<DataApiSnapshot, { status: 'ready' }>;
type TestProperty = ReadySnapshot['schema']['properties'][number];
type TestValue = string | number | boolean | string[] | null;

const DATABASE_ID = 'inventory';
const ROW_ID = 'widget';

const DEFAULT_PROPERTIES: readonly TestProperty[] = [
  { id: 'name', name: 'Name', type: 'text', options: [] },
  { id: 'quantity', name: 'Quantity', type: 'number', options: [] },
  { id: 'price', name: 'Price', type: 'number', options: [] },
  { id: 'total', name: 'Total', type: 'formula', options: [], formula: 'Quantity * Price' },
];

const DEFAULT_ROW: Record<string, TestValue> = {
  name: 'Widget',
  quantity: 2,
  price: 10,
};

interface DataDouble {
  readonly api: DataApi;
  readonly patchCalls: Array<Parameters<DataApi['patchCell']>[0]>;
  readonly historyCalls: Array<Parameters<DataApi['history']>[0]>;
  readonly flushCalls: number[];
  readonly subscriberCount: () => number;
  readonly persisted: () => Readonly<Record<string, TestValue>>;
  readonly current: () => ReadySnapshot;
  readonly editExternally: (values: Record<string, TestValue>) => void;
  readonly failNextFlush: (message: string) => void;
  readonly deferNextFlush: () => (result?: DataApiFlushResult) => void;
}

function makeDataDouble(options: {
  readonly properties?: readonly TestProperty[];
  readonly rowProperties?: Record<string, TestValue>;
  readonly readonly?: boolean;
} = {}): DataDouble {
  const properties = options.properties ?? DEFAULT_PROPERTIES;
  let revisionNumber = 1;
  let snapshot: ReadySnapshot = {
    version: 1,
    status: 'ready',
    databaseId: DATABASE_ID,
    revision: `revision-${revisionNumber}`,
    schema: { properties, views: [] },
    rows: [{ id: ROW_ID, title: 'Widget', properties: { ...(options.rowProperties ?? DEFAULT_ROW) } }],
    history: { canUndo: false, canRedo: false },
    readonly: options.readonly ?? false,
    diagnostic: options.readonly ? { code: 'host-readonly', message: 'Morrow is in read-only mode.' } : null,
  };
  let persistedValues: Record<string, TestValue> = { ...(options.rowProperties ?? DEFAULT_ROW) };
  const listeners = new Set<(value: DataApiSnapshot) => void>();
  const undo: Array<{ readonly propertyId: string; readonly value: TestValue | undefined }> = [];
  const redo: Array<{ readonly propertyId: string; readonly value: TestValue | undefined }> = [];
  const patchCalls: Array<Parameters<DataApi['patchCell']>[0]> = [];
  const historyCalls: Array<Parameters<DataApi['history']>[0]> = [];
  const flushCalls: number[] = [];
  let flushBehavior: (() => Promise<DataApiFlushResult>) | null = null;

  const readValues = () => snapshot.rows[0]?.properties as Record<string, TestValue>;
  const publish = (updates?: Record<string, TestValue>) => {
    revisionNumber += 1;
    const row = snapshot.rows[0]!;
    const values = { ...(row.properties as Record<string, TestValue>), ...updates };
    if (updates) {
      for (const [key, value] of Object.entries(updates)) {
        if (value === undefined) delete values[key];
      }
    }
    snapshot = {
      ...snapshot,
      revision: `revision-${revisionNumber}`,
      rows: [{ ...row, properties: values }],
      history: { canUndo: undo.length > 0, canRedo: redo.length > 0 },
    };
    for (const listener of [...listeners]) listener(snapshot);
  };
  const error = (code: DataApiErrorCode, message: string) => ({
    status: 'error' as const,
    code,
    message,
  });

  const api: DataApi = {
    version: 1,
    snapshot(databaseId) {
      if (databaseId !== DATABASE_ID) throw new Error('The test double is scoped to Inventory.');
      return snapshot;
    },
    patchCell(input): DataApiPatchResult {
      patchCalls.push(input);
      if (input.databaseId !== DATABASE_ID) return error('out-of-scope', 'Database is out of scope.');
      if (snapshot.readonly) return error('host-readonly', 'Morrow is in read-only mode.');
      if (input.expectedRevision !== snapshot.revision) return error('stale-revision', 'Expected a different data revision.');
      if (!Number.isFinite(input.value)) return error('invalid-value', 'A finite number is required.');
      if (!snapshot.schema.properties.some((property) => property.id === input.propertyId && property.type === 'number'))
        return error('property-not-found', 'That numeric property is not available.');
      const row = snapshot.rows.find((candidate) => candidate.id === input.rowId);
      if (!row) return error('row-not-found', 'The row is not available.');
      undo.push({ propertyId: input.propertyId, value: row.properties[input.propertyId] as TestValue | undefined });
      redo.splice(0);
      publish({ [input.propertyId]: input.value });
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
      if (input.databaseId !== DATABASE_ID) return error('out-of-scope', 'Database is out of scope.');
      if (snapshot.readonly) return error('host-readonly', 'Morrow is in read-only mode.');
      if (input.expectedRevision !== snapshot.revision) return error('stale-revision', 'Expected a different data revision.');
      const source = input.direction === 'undo' ? undo : redo;
      const destination = input.direction === 'undo' ? redo : undo;
      const entry = source.pop();
      if (!entry) {
        return { status: 'no-op', databaseId: DATABASE_ID, revision: snapshot.revision, direction: input.direction };
      }
      const current = snapshot.rows[0]!.properties[entry.propertyId] as TestValue | undefined;
      destination.push({ propertyId: entry.propertyId, value: current });
      if (entry.value === undefined) publish({ [entry.propertyId]: undefined as unknown as TestValue });
      else publish({ [entry.propertyId]: entry.value });
      return { status: 'staged', databaseId: DATABASE_ID, revision: snapshot.revision, direction: input.direction };
    },
    subscribe(databaseId, listener) {
      if (databaseId !== DATABASE_ID) throw new Error('The test double is scoped to Inventory.');
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    async flush(databaseId): Promise<DataApiFlushResult> {
      if (databaseId !== DATABASE_ID) return error('out-of-scope', 'Database is out of scope.');
      flushCalls.push(Date.now());
      const behavior = flushBehavior;
      flushBehavior = null;
      const result = behavior
        ? await behavior()
        : { status: 'persisted' as const, databaseId: DATABASE_ID, revision: snapshot.revision };
      if (result.status === 'persisted') persistedValues = { ...readValues() };
      return result;
    },
  };

  return {
    api,
    patchCalls,
    historyCalls,
    flushCalls,
    subscriberCount: () => listeners.size,
    persisted: () => ({ ...persistedValues }),
    current: () => snapshot,
    editExternally(values) {
      publish(values);
    },
    failNextFlush(message) {
      flushBehavior = async () => ({ status: 'error', code: 'save-failed', message });
    },
    deferNextFlush() {
      let resolve!: (result: DataApiFlushResult) => void;
      const promise = new Promise<DataApiFlushResult>((done) => { resolve = done; });
      flushBehavior = () => promise;
      return (result = { status: 'persisted', databaseId: DATABASE_ID, revision: snapshot.revision }) => resolve(result);
    },
  };
}

const windows: Window[] = [];

afterEach(async () => {
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.abort()));
});

function mountPlugin(
  data: DataApi,
  locale: 'pt' | 'en' | 'es' = 'en',
  editable = true,
  sharedWindow?: Window,
  formulaSlashApi = true,
) {
  const window = sharedWindow ?? new Window({ url: 'http://morrow.test/' });
  if (!sharedWindow) windows.push(window);
  const hostElement = window.document.createElement('div');
  window.document.body.append(hostElement);
  const element = hostElement as unknown as HTMLElement;
  const controller = new AbortController();
  const holder: { registration?: DatabaseProviderRegistration } = {};
  const formulaHolder: { mount?: PluginInlineFormulaPresentationMount } = {};
  const formulaEditHolder: { action?: PluginInlineFormulaEditAction } = {};
  const formulaSlashHolder: { command?: PluginInlineFormulaSlashCommand } = {};
  let registered = 0;
  const pluginApi: PolarisDadosPluginApi = {
    data,
    locale,
    pages: {
      list: () => [{ id: DATABASE_ID, title: 'Inventory', kind: 'database' }],
    },
    editor: {
      insertion: {
        version: 1,
        capture: () => null,
      },
    },
    inlineFormulas: {
      version: 1,
      registerPresentation(mount, onEdit) {
        formulaHolder.mount = mount;
        formulaEditHolder.action = onEdit;
        return () => {
          if (formulaHolder.mount === mount) formulaHolder.mount = undefined;
          if (formulaEditHolder.action === onEdit) formulaEditHolder.action = undefined;
        };
      },
      ...(formulaSlashApi ? {
        addSlashCommand(command: PluginInlineFormulaSlashCommand) {
          formulaSlashHolder.command = command;
          return () => {
            if (formulaSlashHolder.command === command) formulaSlashHolder.command = undefined;
          };
        },
      } : {}),
    },
    commands: {
      add: () => () => {},
    },
    slash: {
      add: () => () => {},
    },
    providers: {
      version: 1,
      register(candidate) {
        registered += 1;
        holder.registration = candidate;
        return () => {
          if (holder.registration === candidate) holder.registration = undefined;
        };
      },
    },
  };
  const unregister = activate(pluginApi);
  const registration = holder.registration;
  if (!registration) throw new Error('The provider did not register.');
  const mountResult = registration.mount({ element, databaseId: DATABASE_ID, data, locale, editable, signal: controller.signal });
  const unmount = typeof mountResult === 'function' ? mountResult : () => {};
  return {
    window,
    element,
    controller,
    registration,
    unmount,
    unregister,
    registered,
    inlineFormulaMount: () => formulaHolder.mount,
    inlineFormulaEditAction: () => formulaEditHolder.action,
    inlineFormulaSlashCommand: () => formulaSlashHolder.command,
  };
}

function click(root: HTMLElement, selector: string): void {
  const target = root.querySelector<HTMLButtonElement>(selector);
  if (!target) throw new Error(`No button matched ${selector}.`);
  target.click();
}

function editQuantity(root: HTMLElement): HTMLInputElement {
  click(root, 'button[data-action="edit"][data-field="quantity"]');
  const input = root.querySelector<HTMLInputElement>('input[data-field="quantity"]');
  if (!input) throw new Error('The quantity editor did not open.');
  return input;
}

function setInput(window: Window, input: HTMLInputElement, value: string): void {
  input.value = value;
  dispatch(input, new window.Event('input', { bubbles: true }));
}

function dispatch(target: HTMLElement, event: object): void {
  (target as unknown as { dispatchEvent: (event: object) => boolean }).dispatchEvent(event);
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('Polaris Dados provider module', () => {
  it('requires both version 1 namespaces before registration', () => {
    for (const [dataVersion, providerVersion] of [[2, 1], [1, 2]]) {
      let registrations = 0;
      const incompatible = {
        data: { version: dataVersion },
        providers: {
          version: providerVersion,
          register() {
            registrations += 1;
            return () => {};
          },
        },
      } as unknown as PolarisDadosPluginApi;
      expect(() => activate(incompatible)).toThrow('data API v1 and database-provider API v1');
      expect(registrations).toBe(0);
    }
  });

  it('rejects an unsupported insertion API before registering the provider', () => {
    let registrations = 0;
    const incompatible = {
      data: { version: 1, snapshot: () => null },
      providers: {
        version: 1,
        register() {
          registrations += 1;
          return () => {};
        },
      },
      editor: { insertion: { version: 2, capture: () => null } },
      pages: { list: () => [] },
      locale: 'en',
      commands: { add: () => () => {} },
      slash: { add: () => () => {} },
    } as unknown as PolarisDadosPluginApi;

    expect(() => activate(incompatible)).toThrow('editor insertion API v1');
    expect(registrations).toBe(0);
  });

  it('registers the calculated-result view through the plugin entry point and unregisters it on deactivate', () => {
    const mounted = mountPlugin(makeDataDouble().api);
    const mount = mounted.inlineFormulaMount();
    expect(mount).toBeTypeOf('function');
    const element = mounted.window.document.createElement('span');
    const cleanup = mount!(element as unknown as HTMLElement, {
      formula: '2 + 3',
      outputType: 'number',
      format: {},
      fallback: 'Original',
      locale: 'en',
    });
    expect(element.textContent).toBe('5,00');
    expect(element.dataset.inlineFormulaState).toBe('calculated');

    mounted.unregister();
    expect(mounted.inlineFormulaMount()).toBeUndefined();
    cleanup?.();
    mounted.unmount();
  });

  it('registers a prefilled formula edit handler and cancels its form on plugin disable', () => {
    const mounted = mountPlugin(makeDataDouble().api);
    const onEdit = mounted.inlineFormulaEditAction();
    expect(onEdit).toBeTypeOf('function');
    const host = {
      initial: { formula: '2 + 3', name: 'Old total', outputType: 'auto', format: {} },
      canRestoreFocus: () => true,
      confirm: () => ({ ok: true as const }),
      cancel: () => {},
    };
    onEdit?.(host);
    expect(document.querySelector('form[role="dialog"] h2')?.textContent).toBe('Edit inline formula');
    expect(document.querySelector<HTMLInputElement>('form[role="dialog"] label[for$="-name"] input')?.value)
      .toBe('Old total');
    expect(document.querySelector<HTMLTextAreaElement>('form[role="dialog"] label[for$="-formula"] textarea')?.value)
      .toBe('2 + 3');

    mounted.unregister();
    expect(document.querySelector('form[role="dialog"]')).toBeNull();
    expect(mounted.inlineFormulaEditAction()).toBeUndefined();
    mounted.unmount();
  });

  it('registers the localized formula form only when the host offers the optional slash capability', () => {
    const currentHost = mountPlugin(makeDataDouble().api, 'es');
    expect(currentHost.inlineFormulaSlashCommand()).toMatchObject({
      title: 'Fórmula en línea',
      description: 'Inserta un resultado calculado en la nota.',
    });
    currentHost.unregister();
    expect(currentHost.inlineFormulaSlashCommand()).toBeUndefined();
    currentHost.unmount();

    const olderHost = mountPlugin(makeDataDouble().api, 'en', true, undefined, false);
    expect(olderHost.registered).toBe(1);
    expect(olderHost.inlineFormulaSlashCommand()).toBeUndefined();
    olderHost.unregister();
    olderHost.unmount();
  });

  it('registers the provider and uses the extracted formula engine while editing with keyboard', async () => {
    const data = makeDataDouble();
    const releaseFlush = data.deferNextFlush();
    const mounted = mountPlugin(data.api);
    expect(mounted.registered).toBe(1);
    expect(mounted.registration).toMatchObject({ id: POLARIS_DADOS_PROVIDER_ID, apiVersion: 1 });
    expect(mounted.element.querySelector('table')?.getAttribute('aria-label')).toBe('Polaris Data');
    expect([...mounted.element.querySelectorAll('th')].map((heading) => heading.textContent)).toEqual([
      'Name', 'Quantity', 'Price', 'Total',
    ]);
    expect(mounted.element.querySelector('[data-field="total"] [data-value-kind="number"]')?.textContent).toBe('20');

    let input = editQuantity(mounted.element);
    expect(mounted.window.document.activeElement).toBe(input);
    setInput(mounted.window, input, '9');
    dispatch(input, new mounted.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(data.historyCalls).toHaveLength(0);
    expect(data.current().rows[0]?.properties.quantity).toBe(2);
    dispatch(input, new mounted.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(data.patchCalls).toHaveLength(0);
    expect(mounted.window.document.activeElement).toBe(mounted.element);

    input = editQuantity(mounted.element);
    setInput(mounted.window, input, '3');
    dispatch(input, new mounted.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(data.patchCalls).toHaveLength(1);
    expect(data.patchCalls[0]).toMatchObject({ databaseId: DATABASE_ID, rowId: ROW_ID, propertyId: 'quantity', value: 3, expectedRevision: 'revision-1' });
    expect(data.current().rows[0]?.properties.quantity).toBe(3);
    expect(data.persisted().quantity).toBe(2);
    expect(mounted.element.querySelector('[data-field="total"] [data-value-kind="number"]')?.textContent).toBe('30');
    expect(mounted.element.querySelector('[role="status"]')?.textContent).toContain('Saving changes');
    releaseFlush();
    await settle();
    expect(data.flushCalls).toHaveLength(1);
    expect(data.persisted().quantity).toBe(3);
    expect(mounted.element.querySelector('[data-field="total"] [data-value-kind="number"]')?.textContent).toBe('30');
    expect(mounted.window.document.activeElement).toBe(mounted.element);
    expect(mounted.element.querySelector('[role="status"]')?.textContent).toContain('Changes saved');
    mounted.unmount();
  });

  it('rejects blank, NaN, and infinite drafts while saving explicit zero', async () => {
    expect(parseFiniteNumber('')).toEqual({ ok: false });
    expect(parseFiniteNumber('   ')).toEqual({ ok: false });
    expect(parseFiniteNumber('NaN')).toEqual({ ok: false });
    expect(parseFiniteNumber('Infinity')).toEqual({ ok: false });
    expect(parseFiniteNumber('0')).toEqual({ ok: true, value: 0 });

    const data = makeDataDouble();
    const mounted = mountPlugin(data.api);
    const input = editQuantity(mounted.element);
    setInput(mounted.window, input, '');
    click(mounted.element, 'button[data-action="save"]');
    expect(data.patchCalls).toHaveLength(0);
    expect(mounted.element.querySelector('[role="alert"]')?.textContent).toContain('finite number');

    const activeInput = mounted.element.querySelector<HTMLInputElement>('input[data-field="quantity"]')!;
    setInput(mounted.window, activeInput, '0');
    click(mounted.element, 'button[data-action="save"]');
    await settle();
    expect(data.patchCalls.at(-1)?.value).toBe(0);
    expect(data.persisted().quantity).toBe(0);
    expect(mounted.element.querySelector('[data-field="total"] [data-value-kind="number"]')?.textContent).toBe('0');
    mounted.unmount();
  });

  it('keeps a draft revision fixed when an external edit arrives', () => {
    const data = makeDataDouble();
    const mounted = mountPlugin(data.api);
    const input = editQuantity(mounted.element);
    setInput(mounted.window, input, '3');
    data.editExternally({ quantity: 4 });
    const updatedInput = mounted.element.querySelector<HTMLInputElement>('input[data-field="quantity"]')!;
    expect(updatedInput).toBe(input);
    expect(mounted.window.document.activeElement).toBe(updatedInput);
    expect(updatedInput.value).toBe('3');
    expect(mounted.element.querySelector<HTMLButtonElement>('button[data-action="save"]')?.disabled).toBe(true);
    dispatch(updatedInput, new mounted.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(data.patchCalls).toHaveLength(0);
    expect(data.current().rows[0]?.properties.quantity).toBe(4);
    expect(mounted.element.querySelector('[role="alert"]')?.textContent).toContain('data changed');
    expect(mounted.element.querySelector('input[data-field="quantity"]')).not.toBeNull();
    click(mounted.element, 'button[data-action="cancel"]');
    expect(mounted.window.document.activeElement).toBe(mounted.element);
    mounted.unmount();
  });

  it('keeps staged changes visible after flush failure and retries without a fake cancel', async () => {
    const data = makeDataDouble();
    data.failNextFlush('disk write failed');
    const mounted = mountPlugin(data.api);
    const input = editQuantity(mounted.element);
    setInput(mounted.window, input, '3');
    click(mounted.element, 'button[data-action="save"]');
    await settle();

    expect(data.current().rows[0]?.properties.quantity).toBe(3);
    expect(data.persisted().quantity).toBe(2);
    expect(mounted.element.querySelector('[data-field="total"] [data-value-kind="number"]')?.textContent).toBe('30');
    expect(mounted.element.querySelector('[role="alert"]')?.textContent).toContain('Could not save changes');
    expect(mounted.element.querySelector('[data-action="retry"]')).not.toBeNull();
    expect(mounted.element.querySelector('[data-action="cancel"]')).toBeNull();

    click(mounted.element, 'button[data-action="retry"]');
    await settle();
    expect(data.flushCalls).toHaveLength(2);
    expect(data.persisted().quantity).toBe(3);
    expect(mounted.element.querySelector('[data-action="retry"]')).toBeNull();
    mounted.unmount();
  });

  it('routes empty and saved-cell history through the data API while input undo stays local', async () => {
    const data = makeDataDouble();
    const mounted = mountPlugin(data.api);
    const emptyUndo = new mounted.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: false, cancelable: true });
    dispatch(mounted.element, emptyUndo);
    expect(emptyUndo.defaultPrevented).toBe(true);
    expect(data.historyCalls[0]?.direction).toBe('undo');
    expect(mounted.element.querySelector('[role="status"]')?.textContent).toContain('no change to undo');

    const input = editQuantity(mounted.element);
    const textUndo = new mounted.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
    dispatch(input, textUndo);
    expect(textUndo.defaultPrevented).toBe(false);
    expect(textUndo.cancelBubble).toBe(true);
    expect(data.historyCalls).toHaveLength(1);
    dispatch(input, new mounted.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    const editor = editQuantity(mounted.element);
    setInput(mounted.window, editor, '3');
    click(mounted.element, 'button[data-action="save"]');
    await settle();
    const undo = new mounted.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: false, cancelable: true });
    dispatch(mounted.element, undo);
    expect(undo.defaultPrevented).toBe(true);
    await settle();
    expect(data.historyCalls.at(-1)?.direction).toBe('undo');
    expect(data.persisted().quantity).toBe(2);

    const redo = new mounted.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: false, cancelable: true });
    dispatch(mounted.element, redo);
    await settle();
    expect(data.historyCalls.at(-1)?.direction).toBe('redo');
    expect(data.persisted().quantity).toBe(3);
    mounted.unmount();
  });

  it('routes history through an opt-in provider boundary inside an editable document', async () => {
    const data = makeDataDouble();
    const first = mountPlugin(data.api);
    const second = mountPlugin(data.api, 'en', true, first.window);
    const document = second.element.ownerDocument;
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    second.element.parentElement?.replaceChild(editor, second.element);
    editor.append(second.element);
    second.element.setAttribute('contenteditable', 'false');
    second.element.tabIndex = -1;

    const quantity = editQuantity(first.element);
    setInput(first.window, quantity, '4');
    click(first.element, 'button[data-action="save"]');
    await settle();
    expect(data.persisted().quantity).toBe(4);
    expect(first.element.querySelector('[data-field="total"] [data-value-kind="number"]')?.textContent).toBe('40');
    expect(second.element.querySelector('[data-field="total"] [data-value-kind="number"]')?.textContent).toBe('40');

    second.element.focus();
    expect(document.activeElement).toBe(second.element);
    const undo = new second.window.KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, bubbles: true, cancelable: true,
    });
    dispatch(second.element, undo);
    expect(undo.target).toBe(second.element);
    expect(document.activeElement).toBe(second.element);
    await settle();
    expect(data.historyCalls.map(({ direction }) => direction)).toEqual(['undo']);
    expect(undo.defaultPrevented).toBe(true);
    expect(data.persisted().quantity).toBe(2);
    expect(first.element.querySelector('[data-field="total"] [data-value-kind="number"]')?.textContent).toBe('20');
    expect(second.element.querySelector('[data-field="total"] [data-value-kind="number"]')?.textContent).toBe('20');

    const editButton = second.element.querySelector<HTMLButtonElement>('button[data-action="edit"][data-field="quantity"]');
    if (!editButton) throw new Error('The second provider did not render its quantity control.');
    editButton.focus();
    expect(document.activeElement).toBe(editButton);
    const redo = new second.window.KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
    });
    dispatch(editButton, redo);
    expect(redo.target).toBe(editButton);
    await settle();
    expect(data.historyCalls.map(({ direction }) => direction)).toEqual(['undo', 'redo']);
    expect(redo.defaultPrevented).toBe(true);
    expect(data.persisted().quantity).toBe(4);
    expect(second.element.querySelector('[data-field="total"] [data-value-kind="number"]')?.textContent).toBe('40');

    second.element.focus();
    const commandUndo = new second.window.KeyboardEvent('keydown', {
      key: 'z', metaKey: true, bubbles: true, cancelable: true,
    });
    dispatch(second.element, commandUndo);
    await settle();
    expect(commandUndo.defaultPrevented).toBe(true);
    expect(data.historyCalls.map(({ direction }) => direction)).toEqual(['undo', 'redo', 'undo']);
    expect(data.persisted().quantity).toBe(2);

    const commandRedoButton = second.element.querySelector<HTMLButtonElement>(
      'button[data-action="edit"][data-field="quantity"]',
    );
    if (!commandRedoButton) throw new Error('The second provider did not render its quantity control.');
    commandRedoButton.focus();
    const commandRedo = new second.window.KeyboardEvent('keydown', {
      key: 'z', metaKey: true, shiftKey: true, bubbles: true, cancelable: true,
    });
    dispatch(commandRedoButton, commandRedo);
    await settle();
    expect(commandRedo.defaultPrevented).toBe(true);
    expect(data.historyCalls.map(({ direction }) => direction)).toEqual(['undo', 'redo', 'undo', 'redo']);
    expect(data.persisted().quantity).toBe(4);

    const textInput = document.createElement('input');
    textInput.type = 'text';
    const numberInput = document.createElement('input');
    numberInput.type = 'number';
    const textarea = document.createElement('textarea');
    const nestedEditable = document.createElement('div');
    nestedEditable.setAttribute('contenteditable', 'true');
    nestedEditable.tabIndex = -1;
    const emptyEditable = document.createElement('div');
    emptyEditable.setAttribute('contenteditable', '');
    emptyEditable.tabIndex = -1;
    const plaintextEditable = document.createElement('div');
    plaintextEditable.setAttribute('contenteditable', 'plaintext-only');
    plaintextEditable.tabIndex = -1;
    second.element.append(textInput, numberInput, textarea, nestedEditable, emptyEditable, plaintextEditable);

    for (const target of [textInput, numberInput, textarea, nestedEditable, emptyEditable, plaintextEditable]) {
      target.focus();
      expect(document.activeElement).toBe(target);
      const nativeUndo = new second.window.KeyboardEvent('keydown', {
        key: 'z', ctrlKey: true, bubbles: true, cancelable: true,
      });
      dispatch(target, nativeUndo);
      expect(nativeUndo.defaultPrevented).toBe(false);
      expect(nativeUndo.cancelBubble).toBe(true);
      expect(data.historyCalls.map(({ direction }) => direction)).toEqual(['undo', 'redo', 'undo', 'redo']);
    }

    first.unmount();
    second.unmount();
  });

  it('uses native input undo and redo, syncs the restored draft, and saves it without database history', async () => {
    const data = makeDataDouble();
    const mounted = mountPlugin(data.api);
    const input = editQuantity(mounted.element);
    const commands: string[] = [];
    Object.defineProperty(mounted.window.document, 'execCommand', {
      configurable: true,
      value(command: string) {
        commands.push(command);
        input.value = command === 'undo' ? '3' : '4';
        const inputEvent = new mounted.window.InputEvent('input', {
          bubbles: true,
          inputType: command === 'undo' ? 'historyUndo' : 'historyRedo',
        });
        dispatch(input, inputEvent);
        return true;
      },
    });

    setInput(mounted.window, input, '3');
    setInput(mounted.window, input, '4');
    const undo = new mounted.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
    dispatch(input, undo);
    expect(commands).toEqual(['undo']);
    expect(undo.defaultPrevented).toBe(true);
    expect(undo.cancelBubble).toBe(true);
    expect(input.value).toBe('3');
    expect(data.historyCalls).toHaveLength(0);

    const redo = new mounted.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    dispatch(input, redo);
    expect(commands).toEqual(['undo', 'redo']);
    expect(redo.defaultPrevented).toBe(true);
    expect(input.value).toBe('4');

    const finalUndo = new mounted.window.KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true });
    dispatch(input, finalUndo);
    expect(commands).toEqual(['undo', 'redo', 'undo']);
    expect(input.value).toBe('3');
    expect(data.historyCalls).toHaveLength(0);
    click(mounted.element, 'button[data-action="save"]');
    await settle();
    expect(data.patchCalls).toHaveLength(1);
    expect(data.patchCalls[0]?.value).toBe(3);
    expect(data.persisted().quantity).toBe(3);
    expect(data.historyCalls).toHaveLength(0);
    mounted.unmount();
  });

  it('keeps browser fallback when native input undo is unavailable or throws', () => {
    const data = makeDataDouble();
    const mounted = mountPlugin(data.api);
    const input = editQuantity(mounted.element);
    const attempts: string[] = [];
    Object.defineProperty(mounted.window.document, 'execCommand', {
      configurable: true,
      value(command: string) {
        attempts.push(command);
        if (command === 'undo') return false;
        throw new Error('Native redo is unavailable.');
      },
    });

    const undo = new mounted.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
    dispatch(input, undo);
    expect(undo.defaultPrevented).toBe(false);
    expect(undo.cancelBubble).toBe(true);

    const redo = new mounted.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    dispatch(input, redo);
    expect(redo.defaultPrevented).toBe(false);
    expect(redo.cancelBubble).toBe(true);
    expect(attempts).toEqual(['undo', 'redo']);
    expect(data.historyCalls).toHaveLength(0);
    expect(input.value).toBe('2');
    mounted.unmount();
  });

  it('distinguishes zero, false, null, missing cells, and unresolved formula errors', () => {
    const properties: readonly TestProperty[] = [
      { id: 'zero', name: 'Zero', type: 'number', options: [] },
      { id: 'flag', name: 'Flag', type: 'checkbox', options: [] },
      { id: 'nullable', name: 'Nullable', type: 'number', options: [] },
      { id: 'missing', name: 'Missing cell', type: 'number', options: [] },
      { id: 'nullResult', name: 'Null result', type: 'formula', options: [], formula: 'prop("Nullable")' },
      { id: 'unknown', name: 'Unknown reference', type: 'formula', options: [], formula: 'prop("No such property")' },
    ];
    const data = makeDataDouble({ properties, rowProperties: { zero: 0, flag: false, nullable: null } });
    const mounted = mountPlugin(data.api);
    const row = mounted.element.querySelector('tbody tr')!;
    expect(row.querySelector('[data-field="zero"] [data-value-kind="number"]')?.textContent).toBe('0');
    expect(row.querySelector('[data-field="flag"] [data-value-kind="boolean"]')?.textContent).toBe('False');
    expect(row.querySelector('[data-field="nullable"] [data-value-kind="null"]')?.textContent).toBe('Blank');
    expect(row.querySelector('[data-field="missing"] [data-value-kind="missing"]')?.textContent).toBe('Missing');
    expect(row.querySelector('[data-field="nullResult"] [data-value-kind="null"]')?.textContent).toBe('Blank');
    expect(row.querySelector('[data-field="unknown"] [data-value-kind="error"]')?.textContent).toBe('Formula error');
    expect(row.querySelector('[data-field="unknown"] [data-value-kind="error"]')?.getAttribute('aria-label')).toContain('Formula error');
    mounted.unmount();
  });

  it('formats declared number properties while leaving unformatted and calculated cells unchanged', () => {
    const properties: TestProperty[] = [
      DEFAULT_PROPERTIES[0]!,
      {
        ...DEFAULT_PROPERTIES[1]!,
        format: { locale: 'de-DE', precision: 1.5, negativeFormat: 'parentheses' },
      },
      DEFAULT_PROPERTIES[2]!,
      { id: 'zero', name: 'Zero', type: 'number', options: [], format: { precision: 0 } },
      { id: 'default-locale', name: 'Default locale', type: 'number', options: [], format: { precision: 1.5 } },
      DEFAULT_PROPERTIES[3]!,
    ];
    const values = { name: 'Widget', quantity: -1234.56, price: 2.5, zero: 0, 'default-locale': 1234.56 };
    const mounted = mountPlugin(makeDataDouble({ properties, rowProperties: values }).api, 'pt');
    const cellText = (propertyId: string) =>
      mounted.element.querySelector(`[data-field="${propertyId}"] [data-value-kind="number"]`)?.textContent;
    const fractional = new Intl.NumberFormat('de-DE', {
      maximumFractionDigits: 1.5,
      minimumFractionDigits: 1.5,
    }).format(Math.abs(values.quantity));
    const fallbackLocale = typeof navigator !== 'undefined' ? navigator.language : 'en-US';

    expect(cellText('quantity')).toBe(`(${fractional})`);
    expect(cellText('price')).toBe(new Intl.NumberFormat('pt', { maximumFractionDigits: 10 }).format(values.price));
    expect(cellText('zero')).toBe('0');
    expect(cellText('default-locale')).toBe(
      new Intl.NumberFormat(fallbackLocale, {
        maximumFractionDigits: 1.5,
        minimumFractionDigits: 1.5,
      }).format(values['default-locale']),
    );
    expect(cellText('total')).toBe(
      new Intl.NumberFormat('pt', { maximumFractionDigits: 10 }).format(values.quantity * values.price),
    );
    mounted.unmount();
  });

  it('formats implicit formula decimals while dependent formulas keep raw values', () => {
    const total = {
      ...DEFAULT_PROPERTIES[3]!,
      formula: 'Quantity * Price * -6.1728',
      format: { locale: 'de-DE', precision: 1.5, negativeFormat: 'parentheses' as const },
    };
    const zero = {
      id: 'zero-result',
      name: 'Zero result',
      type: 'formula' as const,
      options: [],
      formula: '0',
      format: { locale: 'en-US', precision: 0 },
    };
    const defaultLocale = {
      id: 'default-locale',
      name: 'Default locale',
      type: 'formula' as const,
      options: [],
      formula: '12.5',
      format: { precision: 2 },
    };
    const dependent: TestProperty = {
      id: 'dependent',
      name: 'Dependent',
      type: 'formula',
      options: [],
      formula: 'Total + 5',
    };
    const properties: readonly TestProperty[] = [
      ...DEFAULT_PROPERTIES.slice(0, 3),
      total,
      zero,
      defaultLocale,
      dependent,
    ];
    const values = { name: 'Widget', quantity: 2, price: 10 };
    const data = makeDataDouble({ properties, rowProperties: values });
    const mounted = mountPlugin(data.api, 'pt');
    const cellText = (propertyId: string) =>
      mounted.element.querySelector(`[data-field="${propertyId}"] [data-value-kind="number"]`)?.textContent;
    const browserLocale = typeof navigator !== 'undefined' ? navigator.language : 'en-US';
    const decimal = new Intl.NumberFormat('de-DE', {
      maximumFractionDigits: 1.5,
      minimumFractionDigits: 1.5,
    }).format(123.456);

    expect(cellText('total')).toBe(`(${decimal})`);
    expect(cellText('zero-result')).toBe('0');
    expect(cellText('default-locale')).toBe(
      new Intl.NumberFormat(browserLocale, { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(12.5),
    );
    expect(cellText('dependent')).toBe(
      new Intl.NumberFormat('pt', { maximumFractionDigits: 10 }).format(-118.456),
    );
    expect(data.current().rows[0]?.properties).toEqual(values);
    expect(data.persisted()).toEqual(values);
    mounted.unmount();
  });

  it('formats implicit formula currencies in the source grid without rounding dependent values', () => {
    const properties: readonly TestProperty[] = [
      ...DEFAULT_PROPERTIES.slice(0, 3),
      {
        id: 'usd',
        name: 'USD',
        type: 'formula',
        options: [],
        formula: 'Quantity * Price * -6.1728',
        format: { locale: 'en-US', currency: 'USD', precision: 0, negativeFormat: 'parentheses' },
      },
      {
        id: 'jpy',
        name: 'JPY total',
        type: 'formula',
        options: [],
        formula: '12.5',
        format: { currency: 'JPY' },
      },
      {
        id: 'bhd',
        name: 'BHD total',
        type: 'formula',
        options: [],
        formula: '-12.5',
        format: { currency: 'BHD', negativeFormat: 'parentheses' },
      },
      {
        id: 'unknown-currency',
        name: 'Unknown currency',
        type: 'formula',
        options: [],
        formula: '12.5',
        format: { currency: 'ZZZ' },
      },
      {
        id: 'fractional-currency',
        name: 'Fractional currency',
        type: 'formula',
        options: [],
        formula: 'Quantity * Price * -6.1728',
        format: { locale: 'de-DE', currency: 'EUR', precision: 1.5, negativeFormat: 'parentheses' },
      },
      { id: 'dependent', name: 'Dependent', type: 'formula', options: [], formula: 'USD + 5' },
    ];
    const values = { name: 'Widget', quantity: 2, price: 10 };
    const data = makeDataDouble({ properties, rowProperties: values });
    const mounted = mountPlugin(data.api, 'pt');
    const cellText = (propertyId: string) =>
      mounted.element.querySelector(`[data-field="${propertyId}"] [data-value-kind="number"]`)?.textContent;
    const browserLocale = typeof navigator !== 'undefined' ? navigator.language : 'en-US';
    const currencyText = (
      value: number,
      currency: string,
      locale = browserLocale,
      precision = 2,
    ) => new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      maximumFractionDigits: precision,
      minimumFractionDigits: precision,
    }).format(value);

    expect(cellText('usd')).toBe(`(${currencyText(123.456, 'USD', 'en-US', 0)})`);
    expect(cellText('jpy')).toBe(currencyText(12.5, 'JPY'));
    expect(cellText('bhd')).toBe(`(${currencyText(12.5, 'BHD')})`);
    expect(cellText('unknown-currency')).toBe(currencyText(12.5, 'ZZZ'));
    expect(cellText('fractional-currency')).toBe(`(${currencyText(123.456, 'EUR', 'de-DE', 1.5)})`);
    expect(cellText('dependent')).toBe(
      new Intl.NumberFormat('pt', { maximumFractionDigits: 10 }).format(-118.456),
    );
    expect(data.current().rows[0]?.properties).toEqual(values);
    expect(data.persisted()).toEqual(values);
    expect(data.patchCalls).toHaveLength(0);
    mounted.unmount();
  });

  it('formats explicit number and percent results while dependencies keep raw formula values', async () => {
    const properties: readonly TestProperty[] = [
      ...DEFAULT_PROPERTIES.slice(0, 3),
      { id: 'optional', name: 'Optional', type: 'number', options: [] },
      { id: 'optional-text', name: 'Optional text', type: 'text', options: [] },
      {
        id: 'typed-checkbox',
        name: 'Typed checkbox',
        type: 'formula',
        options: [],
        formula: 'Quantity > 3',
        formulaResultType: 'checkbox',
      },
      {
        id: 'typed-checkbox-copy',
        name: 'Typed checkbox copy',
        type: 'formula',
        options: [],
        formula: 'If(prop("Typed checkbox"), "Yes", "No")',
      },
      {
        id: 'typed-checkbox-false-check',
        name: 'Typed checkbox false check',
        type: 'formula',
        options: [],
        formula: 'If(prop("Typed checkbox") == false, "false", "not false")',
      },
      {
        id: 'typed-checkbox-null',
        name: 'Typed checkbox null',
        type: 'formula',
        options: [],
        formula: 'thisRow.Optional',
        formulaResultType: 'checkbox',
      },
      {
        id: 'typed-null-false-check',
        name: 'Typed null false check',
        type: 'formula',
        options: [],
        formula: 'If(prop("Typed checkbox null") == false, "false", "not false")',
      },
      {
        id: 'typed-checkbox-invalid',
        name: 'Typed checkbox invalid',
        type: 'formula',
        options: [],
        formula: '1',
        formulaResultType: 'checkbox',
      },
      {
        id: 'typed-checkbox-invalid-dependent',
        name: 'Typed checkbox invalid dependent',
        type: 'formula',
        options: [],
        formula: 'If(prop("Typed checkbox invalid"), "Yes", "No")',
      },
      {
        id: 'typed-text',
        name: 'Typed text',
        type: 'formula',
        options: [],
        formula: 'Concat(" Qty ", If(Quantity > 3, "three", "two"), " ")',
        formulaResultType: 'text',
      },
      {
        id: 'typed-text-copy',
        name: 'Typed text copy',
        type: 'formula',
        options: [],
        formula: 'Concat(prop("Typed text"), "!")',
      },
      {
        id: 'typed-text-length',
        name: 'Typed text length',
        type: 'formula',
        options: [],
        formula: 'Length(prop("Typed text"))',
      },
      {
        id: 'typed-text-empty',
        name: 'Typed text empty',
        type: 'formula',
        options: [],
        formula: '""',
        formulaResultType: 'text',
      },
      {
        id: 'typed-text-null',
        name: 'Typed text null',
        type: 'formula',
        options: [],
        formula: 'thisRow["Optional text"]',
        formulaResultType: 'text',
      },
      {
        id: 'percent',
        name: 'Percent',
        type: 'formula',
        options: [],
        formula: 'Quantity / 8',
        formulaResultType: 'percent',
      },
      {
        id: 'percent-bounded-display',
        name: 'Percent bounded display',
        type: 'formula',
        options: [],
        formula: '0.496',
        formulaResultType: 'percent',
        format: { locale: 'en-US', precision: 0, max: 0.5 },
      },
      {
        id: 'percent-bounded-raw-check',
        name: 'Percent bounded raw check',
        type: 'formula',
        options: [],
        formula: 'prop("Percent bounded display") * 100',
      },
      {
        id: 'percent-raw-max-failure',
        name: 'Percent raw max failure',
        type: 'formula',
        options: [],
        formula: '0.504',
        formulaResultType: 'percent',
        format: { locale: 'en-US', precision: 0, max: 0.5 },
      },
      {
        id: 'percent-raw-max-dependent',
        name: 'Percent raw max dependent',
        type: 'formula',
        options: [],
        formula: 'prop("Percent raw max failure") + 1',
      },
      {
        id: 'decimal',
        name: 'Decimal result',
        type: 'formula',
        options: [],
        formula: '7 / 3',
        formulaResultType: 'number',
      },
      {
        id: 'decimal-locale',
        name: 'Decimal locale',
        type: 'formula',
        options: [],
        formula: '7 / 3',
        formulaResultType: 'number',
        format: { locale: 'de-DE' },
      },
      {
        id: 'decimal-zero',
        name: 'Decimal zero precision',
        type: 'formula',
        options: [],
        formula: '7 / 3',
        formulaResultType: 'number',
        format: { precision: 0 },
      },
      {
        id: 'decimal-negative',
        name: 'Decimal negative',
        type: 'formula',
        options: [],
        formula: '-7 / 3',
        formulaResultType: 'number',
        format: { locale: 'de-DE', precision: 2, negativeFormat: 'parentheses' },
      },
      {
        id: 'decimal-bounded',
        name: 'Decimal bounded',
        type: 'formula',
        options: [],
        formula: '7 / 3',
        formulaResultType: 'number',
        format: { locale: 'de-DE', precision: 2, negativeFormat: 'parentheses', min: 2, max: 3 },
      },
      {
        id: 'decimal-bounded-raw-check',
        name: 'Decimal bounded raw check',
        type: 'formula',
        options: [],
        formula: 'prop("Decimal bounded") * 3',
      },
      {
        id: 'step-valid',
        name: 'Step valid',
        type: 'formula',
        options: [],
        formula: '0.3',
        formulaResultType: 'number',
        format: { locale: 'de-DE', precision: 1, step: 0.1 },
      },
      {
        id: 'step-valid-raw-check',
        name: 'Step valid raw check',
        type: 'formula',
        options: [],
        formula: 'prop("Step valid") * 10',
      },
      {
        id: 'step-invalid',
        name: 'Step invalid',
        type: 'formula',
        options: [],
        formula: '0.31',
        formulaResultType: 'number',
        format: { locale: 'de-DE', precision: 1, step: 0.1 },
      },
      {
        id: 'step-bound-priority',
        name: 'Step bound priority',
        type: 'formula',
        options: [],
        formula: '0.31',
        formulaResultType: 'number',
        format: { min: 0.2, max: 0.3, step: 0.2 },
      },
      {
        id: 'step-null',
        name: 'Step null',
        type: 'formula',
        options: [],
        formula: 'thisRow.Optional',
        formulaResultType: 'number',
        format: { step: 0.1 },
      },
      {
        id: 'step-max-not-anchor',
        name: 'Step max not anchor',
        type: 'formula',
        options: [],
        formula: '0.1',
        formulaResultType: 'number',
        format: { max: 0.3, step: 0.2 },
      },
      {
        id: 'raw-max-failure',
        name: 'Raw max failure',
        type: 'formula',
        options: [],
        formula: '1.004',
        formulaResultType: 'number',
        format: { precision: 2, max: 1 },
      },
      {
        id: 'raw-max-dependent',
        name: 'Raw max dependent',
        type: 'formula',
        options: [],
        formula: 'prop("Raw max failure") + 1',
      },
      {
        id: 'min-first',
        name: 'Minimum first',
        type: 'formula',
        options: [],
        formula: '1',
        formulaResultType: 'number',
        format: { min: 2, max: 0 },
      },
      {
        id: 'null-impossible-bounds',
        name: 'Null impossible bounds',
        type: 'formula',
        options: [],
        formula: 'thisRow.Optional',
        formulaResultType: 'number',
        format: { min: 2, max: 0 },
      },
      {
        id: 'decimal-null',
        name: 'Decimal null',
        type: 'formula',
        options: [],
        formula: 'thisRow.Optional',
        formulaResultType: 'number',
      },
      {
        id: 'currency-default',
        name: 'Default currency',
        type: 'formula',
        options: [],
        formula: '7 / 3',
        formulaResultType: 'currency',
      },
      {
        id: 'currency-raw-check',
        name: 'Currency raw check',
        type: 'formula',
        options: [],
        formula: 'prop("Default currency") * 3',
      },
      {
        id: 'currency-jpy',
        name: 'JPY result',
        type: 'formula',
        options: [],
        formula: 'Quantity - 1',
        formulaResultType: 'currency',
        format: { currency: 'JPY' },
      },
      {
        id: 'currency-locale',
        name: 'Currency locale',
        type: 'formula',
        options: [],
        formula: '-7 / 3',
        formulaResultType: 'currency',
        format: { currency: 'EUR', locale: 'de-DE', negativeFormat: 'parentheses' },
      },
      {
        id: 'currency-zero-precision',
        name: 'Currency zero precision',
        type: 'formula',
        options: [],
        formula: '0',
        formulaResultType: 'currency',
        format: { currency: 'BRL', precision: 0 },
      },
      {
        id: 'currency-null',
        name: 'Currency null',
        type: 'formula',
        options: [],
        formula: 'thisRow.Optional',
        formulaResultType: 'currency',
      },
      {
        id: 'invalid-currency',
        name: 'Invalid currency',
        type: 'formula',
        options: [],
        formula: 'false',
        formulaResultType: 'currency',
      },
      {
        id: 'invalid-currency-dependent',
        name: 'Invalid currency dependent',
        type: 'formula',
        options: [],
        formula: 'prop("Invalid currency") + 1',
      },
      {
        id: 'decimal-times-three',
        name: 'Decimal times three',
        type: 'formula',
        options: [],
        formula: 'prop("Decimal result") * 3',
      },
      {
        id: 'invalid-number',
        name: 'Invalid number',
        type: 'formula',
        options: [],
        formula: 'false',
        formulaResultType: 'number',
      },
      { id: 'dependent', name: 'Dependent', type: 'formula', options: [], formula: 'Percent + 1' },
      {
        id: 'zero-percent',
        name: 'Zero percent',
        type: 'formula',
        options: [],
        formula: '0',
        formulaResultType: 'percent',
      },
      {
        id: 'negative-percent',
        name: 'Negative percent',
        type: 'formula',
        options: [],
        formula: '-Quantity / 8',
        formulaResultType: 'percent',
        format: { locale: 'en-US', precision: 1, negativeFormat: 'parentheses' },
      },
      {
        id: 'above-100',
        name: 'Above 100%',
        type: 'formula',
        options: [],
        formula: 'Quantity * 2',
        formulaResultType: 'percent',
      },
      {
        id: 'null-percent',
        name: 'Null percent',
        type: 'formula',
        options: [],
        formula: 'thisRow["Optional"]',
        formulaResultType: 'percent',
      },
      {
        id: 'invalid-percent',
        name: 'Invalid percent',
        type: 'formula',
        options: [],
        formula: '"done"',
        formulaResultType: 'percent',
      },
      {
        id: 'invalid-dependent',
        name: 'Invalid dependent',
        type: 'formula',
        options: [],
        formula: 'prop("Invalid percent") + 1',
      },
      { id: 'plain-text', name: 'Plain text', type: 'formula', options: [], formula: '"done"' },
    ];
    const initialValues = { name: 'Widget', quantity: 3, price: 10, optional: null, 'optional-text': null };
    const data = makeDataDouble({ properties, rowProperties: initialValues });
    const mounted = mountPlugin(data.api);
    const cell = (id: string) => mounted.element.querySelector<HTMLElement>(`[data-field="${id}"]`)!;
    const defaultLocale = typeof navigator !== 'undefined' ? navigator.language : 'en-US';

    expect(cell('percent').querySelector('[data-value-kind="number"]')?.textContent).toBe(
      new Intl.NumberFormat(defaultLocale, { style: 'percent', maximumFractionDigits: 2 }).format(0.375),
    );
    expect(cell('percent').textContent).toBe('37.5%');
    expect(cell('dependent').querySelector('[data-value-kind="number"]')?.textContent).toBe('1.375');
    expect(cell('percent-bounded-display').textContent).toBe('50%');
    expect(cell('percent-bounded-raw-check').textContent).toBe('49.6');
    expect(cell('percent-raw-max-failure').querySelector('code')?.textContent).toBe(
      'Percent raw max failure must be at most 0.5.',
    );
    expect(cell('percent-raw-max-dependent').querySelector('code')?.textContent).toBe(
      'Percent raw max failure must be at most 0.5.',
    );
    expect(cell('typed-checkbox').querySelector('[data-value-kind="boolean"]')?.textContent).toBe('False');
    expect(cell('typed-checkbox-copy').querySelector('[data-value-kind="text"]')?.textContent).toBe('No');
    expect(cell('typed-checkbox-false-check').textContent).toBe('false');
    expect(cell('typed-checkbox-null').querySelector('[data-value-kind="null"]')?.textContent).toBe('Blank');
    expect(cell('typed-null-false-check').textContent).toBe('not false');
    expect(cell('typed-checkbox').querySelector('input[type="checkbox"], button[data-action="edit"]')).toBeNull();
    expect(cell('typed-checkbox-invalid').querySelector('code')?.textContent).toBe(
      'Formula “Typed checkbox invalid” declared as checkbox must return true, false, or null.',
    );
    expect(cell('typed-checkbox-invalid-dependent').querySelector('code')?.textContent).toBe(
      'Formula “Typed checkbox invalid” declared as checkbox must return true, false, or null.',
    );
    expect(cell('typed-text').querySelector('[data-value-kind="text"]')?.textContent).toBe(' Qty two ');
    expect(cell('typed-text-copy').querySelector('[data-value-kind="text"]')?.textContent).toBe(' Qty two !');
    expect(cell('typed-text-length').querySelector('[data-value-kind="number"]')?.textContent).toBe('9');
    expect(cell('typed-text-empty').querySelector('[data-value-kind="text"]')).not.toBeNull();
    expect(cell('typed-text-empty').textContent).toBe('');
    expect(cell('typed-text-null').querySelector('[data-value-kind="null"]')).not.toBeNull();
    expect(cell('typed-text-null').textContent).toBe('Blank');
    expect(cell('decimal').textContent).toBe(
      new Intl.NumberFormat(defaultLocale, { maximumFractionDigits: 2 }).format(7 / 3),
    );
    expect(cell('decimal-locale').textContent).toBe('2,33');
    expect(cell('decimal-zero').textContent).toBe('2');
    expect(cell('decimal-negative').textContent).toBe('(2,33)');
    expect(cell('decimal-bounded').textContent).toBe('2,33');
    expect(cell('decimal-bounded-raw-check').textContent).toBe('7');
    expect(cell('step-valid').textContent).toBe('0,3');
    expect(cell('step-valid-raw-check').textContent).toBe('3');
    expect(cell('step-invalid').querySelector('code')?.textContent).toBe('Step invalid must use steps of 0.1.');
    expect(cell('step-bound-priority').querySelector('code')?.textContent).toBe(
      'Step bound priority must be at most 0.3.',
    );
    expect(cell('step-null').querySelector('[data-value-kind="null"]')?.textContent).toBe('Blank');
    expect(cell('step-max-not-anchor').querySelector('code')?.textContent).toBe(
      'Step max not anchor must use steps of 0.2.',
    );
    expect(cell('raw-max-failure').querySelector('code')?.textContent).toBe(
      'Raw max failure must be at most 1.',
    );
    expect(cell('raw-max-dependent').querySelector('code')?.textContent).toBe(
      'Raw max failure must be at most 1.',
    );
    expect(cell('min-first').querySelector('code')?.textContent).toBe('Minimum first must be at least 2.');
    expect(cell('null-impossible-bounds').querySelector('[data-value-kind="null"]')?.textContent).toBe('Blank');
    expect(cell('decimal-null').querySelector('[data-value-kind="null"]')?.textContent).toBe('Blank');
    expect(cell('decimal-times-three').textContent).toBe('7');
    expect(cell('currency-default').textContent).toBe(
      new Intl.NumberFormat(defaultLocale, { style: 'currency', currency: 'BRL' }).format(7 / 3),
    );
    expect(cell('currency-raw-check').textContent).toBe('7');
    expect(cell('currency-jpy').textContent).toBe(
      new Intl.NumberFormat(defaultLocale, {
        style: 'currency',
        currency: 'JPY',
        maximumFractionDigits: 2,
        minimumFractionDigits: 2,
      }).format(2),
    );
    expect(cell('currency-locale').textContent).toBe(
      `(${new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(7 / 3)})`,
    );
    expect(cell('currency-zero-precision').textContent).toBe(
      new Intl.NumberFormat(defaultLocale, {
        style: 'currency',
        currency: 'BRL',
        maximumFractionDigits: 0,
        minimumFractionDigits: 0,
      }).format(0),
    );
    expect(cell('currency-null').querySelector('[data-value-kind="null"]')?.textContent).toBe('Blank');
    expect(cell('invalid-currency').querySelector('code')?.textContent).toBe(
      'Formula “Invalid currency” declared as currency must return a finite number or null.',
    );
    expect(cell('invalid-currency-dependent').querySelector('code')?.textContent).toBe(
      'Formula “Invalid currency” declared as currency must return a finite number or null.',
    );
    expect(cell('invalid-number').querySelector('code')?.textContent).toBe(
      'Formula “Invalid number” declared as number must return a finite number or null.',
    );
    expect(cell('zero-percent').textContent).toBe('0%');
    expect(cell('negative-percent').textContent).toBe('(37.5%)');
    expect(cell('above-100').textContent).toBe('600%');
    expect(cell('null-percent').querySelector('[data-value-kind="null"]')?.textContent).toBe(
      'Blank',
    );
    expect(cell('invalid-percent').querySelector('[data-value-kind="error"]')?.textContent).toBe(
      'Formula error',
    );
    expect(cell('invalid-percent').querySelector('code')?.textContent).toBe(
      'Formula “Invalid percent” declared as percent must return a finite number or null.',
    );
    expect(cell('invalid-dependent').querySelector('code')?.textContent).toBe(
      'Formula “Invalid percent” declared as percent must return a finite number or null.',
    );
    expect(cell('plain-text').querySelector('[data-value-kind="text"]')?.textContent).toBe('done');
    expect(data.current().rows[0]?.properties).toEqual(initialValues);

    const input = editQuantity(mounted.element);
    setInput(mounted.window, input, '4');
    dispatch(
      input,
      new mounted.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await settle();

    expect(cell('percent').textContent).toBe('50%');
    expect(cell('typed-checkbox').querySelector('[data-value-kind="boolean"]')?.textContent).toBe('True');
    expect(cell('typed-checkbox-copy').querySelector('[data-value-kind="text"]')?.textContent).toBe('Yes');
    expect(cell('typed-checkbox-false-check').textContent).toBe('not false');
    expect(cell('typed-text').querySelector('[data-value-kind="text"]')?.textContent).toBe(' Qty three ');
    expect(cell('typed-text-copy').querySelector('[data-value-kind="text"]')?.textContent).toBe(' Qty three !');
    expect(cell('typed-text-length').querySelector('[data-value-kind="number"]')?.textContent).toBe('11');
    expect(cell('currency-jpy').textContent).toBe(
      new Intl.NumberFormat(defaultLocale, {
        style: 'currency',
        currency: 'JPY',
        maximumFractionDigits: 2,
        minimumFractionDigits: 2,
      }).format(3),
    );
    expect(cell('dependent').textContent).toBe('1.5');
    expect(cell('negative-percent').textContent).toBe('(50.0%)');
    expect(cell('above-100').textContent).toBe('800%');
    expect(data.current().rows[0]?.properties).toEqual({ ...initialValues, quantity: 4 });
    expect(data.persisted()).toEqual({ ...initialValues, quantity: 4 });
    expect(data.patchCalls).toHaveLength(1);
    mounted.unmount();
  });

  it('renders numeric formula progress bars without changing raw formula values or grid focus', async () => {
    const properties: readonly TestProperty[] = [
      ...DEFAULT_PROPERTIES.slice(0, 3),
      { id: 'default-bar', name: 'Default bar', type: 'formula', options: [], formula: 'Quantity * 10', display: 'bar' },
      { id: 'fractional-max', name: 'Fractional max', type: 'formula', options: [], formula: 'Quantity / 16', display: 'bar', max: 0.5 },
      { id: 'fractional-ratio', name: 'Fractional ratio', type: 'formula', options: [], formula: 'Quantity / 3', display: 'bar', max: 1.5 },
      { id: 'zero-bar', name: 'Zero bar', type: 'formula', options: [], formula: '0', display: 'bar' },
      { id: 'negative-bar', name: 'Negative bar', type: 'formula', options: [], formula: '-Quantity * 2', display: 'bar', max: 8 },
      { id: 'overflow', name: 'Overflow', type: 'formula', options: [], formula: 'Quantity * 20', display: 'bar', max: 30 },
      { id: 'zero-maximum', name: 'Zero maximum', type: 'formula', options: [], formula: 'Quantity * 10', display: 'bar', max: 0 },
      { id: 'dependent', name: 'Dependent', type: 'formula', options: [], formula: 'Overflow + 5' },
      { id: 'manual-bar', name: 'Manual bar', type: 'number', options: [], display: 'bar', max: 5 },
      { id: 'text-bar', name: 'Text bar', type: 'formula', options: [], formula: '"Done"', display: 'bar' },
    ];
    const data = makeDataDouble({
      properties,
      rowProperties: { name: 'Widget', quantity: 1, price: 10, 'manual-bar': 2 },
    });
    const mounted = mountPlugin(data.api, 'pt');
    const progressFor = (id: string) => mounted.element.querySelector<HTMLElement>(`[data-field="${id}"] .prop-progress`);
    const localize = (value: number) => {
      const notation = /e/i.test(value.toString()) ? 'scientific' : 'standard';
      return new Intl.NumberFormat('pt', { maximumSignificantDigits: 21, notation }).format(value);
    };
    const labelFor = (id: string) => progressFor(id)?.querySelector('.prop-progress-label')?.textContent;
    const percentFor = (id: string) => progressFor(id)?.querySelector<HTMLElement>('.prop-progress-fill')?.style.width;

    expect(labelFor('default-bar')).toBe('10%');
    expect(progressFor('default-bar')?.title).toBe(`${localize(10)} / ${localize(100)}`);
    expect(progressFor('fractional-max')?.title).toBe(`${localize(0.0625)} / ${localize(0.5)}`);
    expect(labelFor('fractional-max')).toBe('13%');
    expect(labelFor('fractional-ratio')).toBe('22%');
    expect(percentFor('fractional-ratio')).toBe(`${(1 / 3 / 1.5) * 100}%`);
    expect(labelFor('zero-bar')).toBe('0%');
    expect(labelFor('negative-bar')).toBe('0%');
    expect(progressFor('negative-bar')?.getAttribute('aria-valuetext')).toBe(`0% (${localize(-2)} / ${localize(8)})`);
    expect(labelFor('overflow')).toBe('67%');
    expect(percentFor('overflow')).toBe(`${(2 / 3) * 100}%`);
    expect(progressFor('overflow')?.getAttribute('aria-label')).toBe('Overflow');
    expect(progressFor('overflow')?.getAttribute('aria-valuetext')).toBe(`67% (${localize(20)} / ${localize(30)})`);
    expect(progressFor('zero-maximum')?.title).toBe(`${localize(10)} / ${localize(100)}`);
    expect(labelFor('zero-maximum')).toBe('10%');
    expect(mounted.element.querySelector('[data-field="dependent"] [data-value-kind="number"]')?.textContent).toBe('25');
    expect(mounted.element.querySelector('[data-field="manual-bar"] .prop-progress')).toBeNull();
    expect(mounted.element.querySelector('[data-field="manual-bar"]')?.textContent).toContain('2');
    expect(mounted.element.querySelector('[data-field="text-bar"] [data-value-kind="text"]')?.textContent).toBe('Done');
    expect(progressFor('text-bar')).toBeNull();

    const overflowCell = mounted.element.querySelector<HTMLTableCellElement>('[data-field="overflow"]')!;
    const overflowBar = progressFor('overflow')!;
    expect(overflowCell.tabIndex).toBe(-1);
    expect(overflowBar.hasAttribute('tabindex')).toBe(false);
    mounted.element.querySelector<HTMLTableCellElement>('[data-field="negative-bar"]')!.focus();
    const moveRight = new mounted.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    dispatch(mounted.element.querySelector('[data-field="negative-bar"]')!, moveRight);
    expect(moveRight.defaultPrevented).toBe(true);
    expect(mounted.window.document.activeElement).toBe(overflowCell);

    const quantity = editQuantity(mounted.element);
    setInput(mounted.window, quantity, '2.5');
    dispatch(quantity, new mounted.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await settle();
    expect(labelFor('default-bar')).toBe('25%');
    expect(progressFor('overflow')?.title).toBe(`${localize(50)} / ${localize(30)}`);
    expect(labelFor('overflow')).toBe('100%');
    expect(mounted.element.querySelector('[data-field="dependent"] [data-value-kind="number"]')?.textContent).toBe('55');
    expect(data.current().rows[0]?.properties).toEqual({ name: 'Widget', quantity: 2.5, price: 10, 'manual-bar': 2 });
    expect(data.persisted()).toEqual({ name: 'Widget', quantity: 2.5, price: 10, 'manual-bar': 2 });
    expect(data.patchCalls).toHaveLength(1);
    mounted.unmount();
  });

  it('preserves tiny finite formula ranges in localized progress labels and accessibility text', () => {
    const tiny = 1e-110;
    const properties: readonly TestProperty[] = [
      ...DEFAULT_PROPERTIES.slice(0, 3),
      { id: 'tiny', name: 'Tiny', type: 'formula', options: [], formula: 'Quantity', display: 'bar', max: tiny },
      { id: 'tiny-dependent', name: 'Tiny dependent', type: 'formula', options: [], formula: 'Tiny * 2', display: 'bar', max: tiny * 2 },
    ];
    const data = makeDataDouble({
      properties,
      rowProperties: { name: 'Widget', quantity: tiny, price: 10 },
    });
    const mounted = mountPlugin(data.api, 'pt');
    const progressFor = (id: string) => mounted.element.querySelector<HTMLElement>(`[data-field="${id}"] .prop-progress`);
    const localize = (value: number) =>
      new Intl.NumberFormat('pt', { maximumSignificantDigits: 21, notation: 'scientific' }).format(value);
    const tinyRange = `${localize(tiny)} / ${localize(tiny)}`;
    const dependentRange = `${localize(tiny * 2)} / ${localize(tiny * 2)}`;

    expect(progressFor('tiny')?.title).toBe(tinyRange);
    expect(progressFor('tiny')?.title).not.toBe('0 / 0');
    expect(progressFor('tiny')?.getAttribute('aria-label')).toBe('Tiny');
    expect(progressFor('tiny')?.getAttribute('aria-valuetext')).toBe(`100% (${tinyRange})`);
    expect(progressFor('tiny')?.querySelector<HTMLElement>('.prop-progress-fill')?.style.width).toBe('100%');
    expect(progressFor('tiny-dependent')?.title).toBe(dependentRange);
    expect(progressFor('tiny-dependent')?.getAttribute('aria-valuetext')).toBe(`100% (${dependentRange})`);
    expect(data.current().rows[0]?.properties.quantity).toBe(tiny);
    expect(data.persisted()?.quantity).toBe(tiny);
    mounted.unmount();
  });

  it('limits formula dependency depth and work without changing the extracted engine', () => {
    const properties: TestProperty[] = [];
    for (let index = 0; index < 28; index += 1) {
      properties.push({
        id: `formula-${index}`,
        name: `Formula ${index}`,
        type: 'formula',
        options: [],
        formula: index === 0 ? '1' : `prop("Formula ${index - 1}") + 1`,
      });
    }
    const data = makeDataDouble({ properties, rowProperties: {} });
    const mounted = mountPlugin(data.api);
    const deepest = mounted.element.querySelector('[data-field="formula-27"] [data-value-kind="error"]');
    expect(deepest).not.toBeNull();
    expect(deepest?.parentElement?.querySelector('details code')?.textContent).toContain('nested too deeply');
    mounted.unmount();

    const leaves: TestProperty[] = Array.from({ length: 65 }, (_, index) => ({
      id: `leaf-${index}`,
      name: `Leaf ${index}`,
      type: 'formula',
      options: [],
      formula: '1',
    }));
    const aggregate: TestProperty = {
      id: 'aggregate',
      name: 'Aggregate',
      type: 'formula',
      options: [],
      formula: leaves.map((property) => `prop("${property.name}")`).join(' + '),
    };
    const bounded = mountPlugin(makeDataDouble({ properties: [...leaves, aggregate], rowProperties: {} }).api);
    const aggregateCell = bounded.element.querySelector('[data-field="aggregate"] [data-value-kind="error"]');
    expect(aggregateCell?.parentElement?.querySelector('details code')?.textContent).toContain('too many calculated properties');
    bounded.unmount();
  });

  it('shares data and history across roots, respects locale and readonly, and removes listeners on abort/reload', async () => {
    const data = makeDataDouble();
    const first = mountPlugin(data.api, 'pt');
    const second = mountPlugin(data.api, 'es', true, first.window);
    expect(data.subscriberCount()).toBe(2);
    expect(first.element.querySelector('button[data-action="edit"]')?.getAttribute('aria-label')).toBe('Editar Quantity de Widget');
    expect(second.element.querySelector('button[data-action="edit"]')?.getAttribute('aria-label')).toBe('Editar Quantity para Widget');
    expect(first.element.querySelector('button[data-action="edit"]')?.textContent).toBe('2');

    const portugueseInput = editQuantity(first.element);
    expect(portugueseInput.getAttribute('aria-label')).toBe('Quantity de Widget');
    expect(first.element.querySelector('button[data-action="save"]')?.textContent).toBe('Salvar');
    click(first.element, 'button[data-action="cancel"]');
    const spanishInput = editQuantity(second.element);
    expect(spanishInput.getAttribute('aria-label')).toBe('Quantity para Widget');
    expect(second.element.querySelector('button[data-action="save"]')?.textContent).toBe('Guardar');
    click(second.element, 'button[data-action="cancel"]');
    expect(portugueseInput.value).toBe('2');
    expect(spanishInput.value).toBe('2');

    const input = editQuantity(first.element);
    setInput(first.window, input, '3');
    first.element.focus();
    click(first.element, 'button[data-action="save"]');
    expect(second.element.querySelector('[data-field="total"] [data-value-kind="number"]')?.textContent).toBe('30');
    expect(first.window.document.activeElement).toBe(first.element);
    await settle();
    const undoFromSecondRoot = new second.window.KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, bubbles: false, cancelable: true,
    });
    dispatch(second.element, undoFromSecondRoot);
    expect(undoFromSecondRoot.defaultPrevented).toBe(true);
    await settle();
    expect(data.persisted().quantity).toBe(2);
    expect(first.element.querySelector('[data-field="total"] [data-value-kind="number"]')?.textContent).toBe('20');

    first.controller.abort();
    expect(data.subscriberCount()).toBe(1);
    expect(first.element.childElementCount).toBe(0);
    expect(first.element.hasAttribute('data-provider')).toBe(false);
    second.unmount();
    expect(data.subscriberCount()).toBe(0);

    const readonly = mountPlugin(data.api, 'en', false);
    expect(readonly.element.querySelector('button[data-action="edit"]')).toBeNull();
    expect(readonly.element.querySelector('[role="status"]')?.textContent).toContain('Read only');
    readonly.unmount();
    first.unregister();
    second.unregister();
  });

  it('does not rerender a removed root when a staged flush settles after abort, then reloads from the API', async () => {
    const data = makeDataDouble();
    const releaseFlush = data.deferNextFlush();
    const mounted = mountPlugin(data.api);
    const input = editQuantity(mounted.element);
    setInput(mounted.window, input, '3');
    click(mounted.element, 'button[data-action="save"]');
    expect(data.subscriberCount()).toBe(1);
    mounted.controller.abort();
    expect(data.subscriberCount()).toBe(0);
    expect(mounted.element.childElementCount).toBe(0);
    releaseFlush();
    await settle();
    expect(mounted.element.childElementCount).toBe(0);
    expect(data.persisted().quantity).toBe(3);

    const reloaded = mountPlugin(data.api);
    expect(reloaded.element.querySelector('[data-field="total"] [data-value-kind="number"]')?.textContent).toBe('30');
    reloaded.unmount();
  });

  it('does not steal focus from another database root when a deferred flush settles', async () => {
    const data = makeDataDouble();
    const releaseFlush = data.deferNextFlush();
    const first = mountPlugin(data.api);
    const second = mountPlugin(data.api, 'en', true, first.window);
    const input = editQuantity(first.element);
    setInput(first.window, input, '3');
    click(first.element, 'button[data-action="save"]');
    expect(first.window.document.activeElement).toBe(first.element);
    second.element.focus();
    releaseFlush();
    await settle();
    expect(first.window.document.activeElement).toBe(second.element);
    first.unmount();
    second.unmount();
  });
});
