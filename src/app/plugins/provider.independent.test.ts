// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageId } from '../../core/model';
import type { DataApi, DataApiFlushResult, DataApiSnapshot } from './dataApi';
import { clonePluginPageProperties } from './pageInfo';
import { createProviderDataScope } from './providerDataScope';
import {
  focusedDatabaseProviderRoot,
  getDatabaseProvider,
  registerDatabaseProvider,
  registerMountedDatabaseProvider,
} from './providerRegistry';
import { undoRedo } from '../editor/commits';
import * as workspace from '../workspace';

const databaseId: PageId = 'provider-independent-database';
const otherDatabaseId: PageId = 'provider-independent-other-database';

function readySnapshot(
  id: PageId,
  revision = 'revision-1',
  history = { canUndo: false, canRedo: false },
): DataApiSnapshot {
  return {
    version: 1,
    status: 'ready',
    databaseId: id,
    revision,
    schema: { properties: [], views: [] },
    rows: [],
    history,
    readonly: false,
    diagnostic: null,
  };
}

function makeDataApi(overrides: Partial<DataApi> = {}): DataApi {
  return {
    version: 1,
    snapshot: (id) => readySnapshot(id),
    patchCell: (input) => ({
      status: 'staged',
      databaseId: input.databaseId,
      rowId: input.rowId,
      propertyId: input.propertyId,
      revision: 'revision-2',
    }),
    history: (input) => ({
      status: 'no-op',
      databaseId: input.databaseId,
      revision: input.expectedRevision,
      direction: input.direction,
    }),
    subscribe: () => () => {},
    flush: async (id): Promise<DataApiFlushResult> => ({
      status: 'persisted',
      databaseId: id,
      revision: 'revision-1',
    }),
    ...overrides,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('independent provider lifecycle checks', () => {
  it('rejects a stale owner instance after reload, even when the plugin and provider ids are reused', () => {
    let oldOwnerActive = true;
    const data = makeDataApi();
    const oldUnregister = registerDatabaseProvider('same-plugin', () => oldOwnerActive, data, {
      id: 'polaris-dados',
      apiVersion: 1,
      mount: () => () => {},
    });
    let newUnregister: (() => void) | undefined;
    try {
      const oldProvider = getDatabaseProvider('polaris-dados');
      if (!oldProvider) throw new Error('Expected the first provider instance to register.');

      oldOwnerActive = false;
      oldUnregister();

      newUnregister = registerDatabaseProvider('same-plugin', () => true, data, {
        id: 'polaris-dados',
        apiVersion: 1,
        mount: () => () => {},
      });
      const newProvider = getDatabaseProvider('polaris-dados');
      if (!newProvider) throw new Error('Expected the reloaded provider instance to register.');

      const oldRoot = document.createElement('div');
      const liveRoot = document.createElement('div');
      const liveChild = document.createElement('button');
      liveRoot.append(liveChild);
      document.body.append(oldRoot, liveRoot);
      const deactivate = vi.fn();

      expect(newProvider).not.toBe(oldProvider);
      expect(registerMountedDatabaseProvider(oldProvider, databaseId, oldRoot, () => {})).toBeNull();
      const releaseLiveRoot = registerMountedDatabaseProvider(newProvider, databaseId, liveRoot, deactivate);
      if (!releaseLiveRoot) throw new Error('Expected the current provider instance to own its root.');

      // An obsolete cleanup callback must never unregister or detach the newer generation.
      oldUnregister();
      liveChild.focus();
      expect(getDatabaseProvider('polaris-dados')).toBe(newProvider);
      expect(focusedDatabaseProviderRoot(liveChild)).toBe(liveRoot);

      newUnregister();
      expect(deactivate).toHaveBeenCalledOnce();
      expect(getDatabaseProvider('polaris-dados')).toBeNull();
      expect(focusedDatabaseProviderRoot(liveChild)).toBeNull();
    } finally {
      oldUnregister();
      newUnregister?.();
    }
  });

  it('keeps same-database roots separate and continues cleanup after one root throws', () => {
    const data = makeDataApi();
    const unregister = registerDatabaseProvider('multiple-root-plugin', () => true, data, {
      id: 'multiple-root-provider',
      apiVersion: 1,
      mount: () => () => {},
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstDeactivated = vi.fn(() => {
      firstController.abort();
      throw new Error('synthetic cleanup failure');
    });
    const secondDeactivated = vi.fn(() => secondController.abort());
    let releaseFirst: (() => void) | null = null;
    let releaseSecond: (() => void) | null = null;

    try {
      const provider = getDatabaseProvider('multiple-root-provider');
      if (!provider) throw new Error('Expected the provider to be registered.');
      const firstRoot = document.createElement('div');
      const firstChild = document.createElement('button');
      firstRoot.append(firstChild);
      const secondRoot = document.createElement('div');
      const secondChild = document.createElement('button');
      secondRoot.append(secondChild);
      document.body.append(firstRoot, secondRoot);
      releaseFirst = registerMountedDatabaseProvider(provider, databaseId, firstRoot, firstDeactivated);
      releaseSecond = registerMountedDatabaseProvider(provider, databaseId, secondRoot, secondDeactivated);
      if (!releaseFirst || !releaseSecond) {
        throw new Error('Expected both roots to mount for the same database.');
      }

      secondChild.focus();
      expect(focusedDatabaseProviderRoot(firstChild)).toBe(firstRoot);
      expect(focusedDatabaseProviderRoot(secondChild)).toBe(secondRoot);
      unregister();

      expect(firstDeactivated).toHaveBeenCalledOnce();
      expect(secondDeactivated).toHaveBeenCalledOnce();
      expect(firstController.signal.aborted).toBe(true);
      expect(secondController.signal.aborted).toBe(true);
      expect(focusedDatabaseProviderRoot(firstChild)).toBeNull();
      expect(focusedDatabaseProviderRoot(secondChild)).toBeNull();
    } finally {
      releaseFirst?.();
      releaseSecond?.();
      unregister();
    }
  });

  it('keeps same-database mount scopes independent and applies readonly per mount', () => {
    let current = readySnapshot(databaseId, 'revision-1');
    const patchCell = vi.fn<DataApi['patchCell']>((input) => ({
      status: 'staged',
      databaseId: input.databaseId,
      rowId: input.rowId,
      propertyId: input.propertyId,
      revision: 'revision-2',
    }));
    const source = makeDataApi({
      snapshot: (id) => (id === databaseId ? current : readySnapshot(id)),
      patchCell,
    });
    const readOnlyMount = createProviderDataScope(source, databaseId, {
      isActive: () => true,
      editable: false,
    });
    const editableMount = createProviderDataScope(source, databaseId, {
      isActive: () => true,
      editable: true,
    });

    expect(readOnlyMount.api.snapshot(databaseId)).toMatchObject({
      revision: 'revision-1',
      readonly: true,
      history: { canUndo: false, canRedo: false },
    });
    expect(editableMount.api.snapshot(databaseId)).toMatchObject({ revision: 'revision-1', readonly: false });

    current = readySnapshot(databaseId, 'revision-2');
    expect(readOnlyMount.api.snapshot(databaseId).revision).toBe('revision-2');
    expect(editableMount.api.snapshot(databaseId).revision).toBe('revision-2');

    const input = {
      databaseId,
      rowId: 'row-1',
      propertyId: 'quantity',
      value: 3,
      expectedRevision: 'revision-2',
    };
    expect(readOnlyMount.api.patchCell(input)).toMatchObject({ status: 'error', code: 'host-readonly' });
    expect(editableMount.api.patchCell(input)).toMatchObject({ status: 'staged', revision: 'revision-2' });
    expect(patchCell).toHaveBeenCalledOnce();

    readOnlyMount.dispose();
    expect(editableMount.api.patchCell(input)).toMatchObject({ status: 'staged' });
    expect(patchCell).toHaveBeenCalledTimes(2);
    editableMount.dispose();
  });

  it('keeps mutation, history, and flush authority bound to the mounted database', async () => {
    const flush = vi.fn<DataApi['flush']>(async (id) => ({
      status: 'persisted',
      databaseId: id,
      revision: 'revision-1',
    }));
    const source = makeDataApi({ flush });
    const scope = createProviderDataScope(source, databaseId, { isActive: () => true, editable: true });

    expect(scope.api.patchCell({
      databaseId: otherDatabaseId,
      rowId: 'row-1',
      propertyId: 'quantity',
      value: 3,
      expectedRevision: 'revision-1',
    })).toMatchObject({ status: 'error', code: 'out-of-scope' });
    expect(scope.api.history({
      databaseId: otherDatabaseId,
      direction: 'undo',
      expectedRevision: 'revision-1',
    })).toMatchObject({ status: 'error', code: 'out-of-scope' });
    await expect(scope.api.flush(otherDatabaseId)).resolves.toMatchObject({
      status: 'error',
      code: 'out-of-scope',
    });
    expect(flush).not.toHaveBeenCalled();
    scope.dispose();
  });

  it('cleans a subscription when its callback disposes the scope reentrantly', () => {
    const stopSourceSubscription = vi.fn();
    const sourceSubscribe = vi.fn((_id: PageId, listener: (snapshot: DataApiSnapshot) => void) => {
      listener(readySnapshot(databaseId));
      return stopSourceSubscription;
    });
    const source = makeDataApi({ subscribe: sourceSubscribe });
    const scope = createProviderDataScope(source, databaseId, { isActive: () => true, editable: true });
    const listener = vi.fn(() => scope.dispose());

    const unsubscribe = scope.api.subscribe(databaseId, listener);
    unsubscribe();

    expect(listener).toHaveBeenCalledOnce();
    expect(sourceSubscribe).toHaveBeenCalledOnce();
    expect(stopSourceSubscription).toHaveBeenCalledOnce();
    expect(() => scope.api.snapshot(databaseId)).toThrow(/no longer active/i);
  });
});

describe('independent provider integration seams', () => {
  it('deep-copies nested page metadata for each plugin page result', () => {
    const canonical = {
      polarisDados: { version: 1, provider: 'polaris-dados' },
      vendor: { settings: { columns: ['quantity', 'price'] } },
    };

    const result = clonePluginPageProperties(canonical);
    const vendor = result.vendor;
    const marker = result.polarisDados;
    if (!isRecord(vendor) || !isRecord(vendor.settings) || !Array.isArray(vendor.settings.columns)) {
      throw new Error('Expected nested vendor settings in the cloned page metadata.');
    }
    if (!vendor.settings.columns.every((item) => typeof item === 'string')) {
      throw new Error('Expected cloned vendor columns to remain strings.');
    }
    if (!isRecord(marker) || typeof marker.version !== 'number') {
      throw new Error('Expected the cloned provider marker to retain its version.');
    }
    vendor.settings.columns.push('total');
    marker.version = 2;
    const nextResult = clonePluginPageProperties(canonical);

    expect(result).not.toBe(canonical);
    expect(nextResult.vendor).not.toBe(result.vendor);
    expect(canonical.vendor.settings.columns).toEqual(['quantity', 'price']);
    expect(canonical.polarisDados.version).toBe(1);
  });

  it('routes native undo to a focused provider root even when provider history is empty', () => {
    const data = makeDataApi({
      snapshot: (id) => readySnapshot(id, 'revision-1', { canUndo: false, canRedo: false }),
    });
    const unregister = registerDatabaseProvider('undo-plugin', () => true, data, {
      id: 'undo-provider',
      apiVersion: 1,
      mount: () => () => {},
    });
    const nativePropertyUndo = vi.spyOn(workspace, 'stepProperties');
    let releaseRoot: (() => void) | null = null;

    try {
      const provider = getDatabaseProvider('undo-provider');
      if (!provider) throw new Error('Expected the provider to be registered.');

      const root = document.createElement('div');
      const button = document.createElement('button');
      root.append(button);
      document.body.append(root);
      releaseRoot = registerMountedDatabaseProvider(provider, databaseId, root, () => {});
      if (!releaseRoot) throw new Error('Expected the provider to own its focused root.');
      const localUndoCommand = vi.fn<(event: Event) => void>();
      root.addEventListener('keydown', localUndoCommand);

      expect(data.snapshot(databaseId)).toMatchObject({ history: { canUndo: false, canRedo: false } });
      button.focus();
      undoRedo('undo');

      const event = localUndoCommand.mock.calls[0]?.[0];
      expect(event).toBeInstanceOf(KeyboardEvent);
      if (!(event instanceof KeyboardEvent)) throw new Error('Expected a keyboard event for provider undo.');
      expect(event).toMatchObject({ key: 'z', bubbles: false, cancelable: true, shiftKey: false });
      expect(event.ctrlKey || event.metaKey).toBe(true);
      expect(nativePropertyUndo).not.toHaveBeenCalled();

      const input = document.createElement('input');
      document.body.append(input);
      const previousExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand');
      const execCommand = vi.fn();
      Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
      try {
        input.focus();
        undoRedo('undo');
        expect(execCommand).toHaveBeenCalledOnce();
        expect(execCommand).toHaveBeenCalledWith('undo');
        expect(localUndoCommand).toHaveBeenCalledOnce();
        expect(nativePropertyUndo).not.toHaveBeenCalled();
      } finally {
        if (previousExecCommand) Object.defineProperty(document, 'execCommand', previousExecCommand);
        else Reflect.deleteProperty(document, 'execCommand');
      }
    } finally {
      releaseRoot?.();
      unregister();
      nativePropertyUndo.mockRestore();
    }
  });
});
