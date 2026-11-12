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
) {
  const window = sharedWindow ?? new Window({ url: 'http://morrow.test/' });
  if (!sharedWindow) windows.push(window);
  const hostElement = window.document.createElement('div');
  window.document.body.append(hostElement);
  const element = hostElement as unknown as HTMLElement;
  const controller = new AbortController();
  const holder: { registration?: DatabaseProviderRegistration } = {};
  let registered = 0;
  const pluginApi: PolarisDadosPluginApi = {
    data,
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
