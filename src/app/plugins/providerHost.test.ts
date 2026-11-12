// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageId } from '../../core/model';
import type { DataApi, DataApiFlushResult, DataApiHistoryResult, DataApiPatchResult, DataApiSnapshot } from './dataApi';
import { createProviderDataScope } from './providerDataScope';
import {
  databaseProvidersVersion,
  focusedDatabaseProviderRoot,
  getDatabaseProvider,
  registerDatabaseProvider,
  registerMountedDatabaseProvider,
  subscribeDatabaseProviders,
} from './providerRegistry';
import { clonePluginPageProperties } from './pageInfo';
import { undoRedo } from '../editor/commits';
import * as workspace from '../workspace';

const dbId = 'db' as PageId;
const otherDbId = 'other-db' as PageId;
const readySnapshot: DataApiSnapshot = {
  version: 1,
  status: 'ready',
  databaseId: dbId,
  revision: 'r1',
  schema: { properties: [], views: [] },
  rows: [],
  history: { canUndo: true, canRedo: true },
  readonly: false,
  diagnostic: null,
};

function fakeDataApi(overrides: Partial<DataApi> = {}): DataApi {
  return {
    version: 1,
    snapshot: vi.fn(() => readySnapshot),
    patchCell: vi.fn((): DataApiPatchResult => ({ status: 'staged', databaseId: dbId, rowId: 'row' as PageId, propertyId: 'count', revision: 'r2' })),
    history: vi.fn((): DataApiHistoryResult => ({ status: 'no-op', databaseId: dbId, revision: 'r1', direction: 'undo' })),
    subscribe: vi.fn(() => () => {}),
    flush: vi.fn(async (): Promise<DataApiFlushResult> => ({ status: 'persisted', databaseId: dbId, revision: 'r1' })),
    ...overrides,
  };
}

function register(ownerIsActive: () => boolean = () => true, data = fakeDataApi()) {
  return registerDatabaseProvider('polaris-dados', ownerIsActive, data, {
    id: 'polaris-dados',
    apiVersion: 1,
    mount: () => () => {},
  });
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('database provider registry', () => {
  it('requires a live owner, API version 1, and a unique provider id', () => {
    const data = fakeDataApi();
    expect(() => register(() => false, data)).toThrow(/no longer active/i);
    expect(() => registerDatabaseProvider('wrong-version', () => true, data, {
      id: 'polaris-dados',
      apiVersion: 2 as 1,
      mount: () => {},
    })).toThrow(/version 1/i);

    const unregister = register(() => true, data);
    const registered = getDatabaseProvider('polaris-dados');
    expect(registered?.data).toBe(data);
    expect(() => register(() => true)).toThrow(/already registered/i);
    unregister();
    expect(getDatabaseProvider('polaris-dados')).toBeNull();
  });

  it('makes old unregister handles generation-safe after reload', () => {
    let firstOwnerActive = true;
    const unregisterFirst = register(() => firstOwnerActive);
    const first = getDatabaseProvider('polaris-dados');
    unregisterFirst();

    const unregisterSecond = register();
    const second = getDatabaseProvider('polaris-dados');
    firstOwnerActive = false;
    unregisterFirst();

    expect(second).not.toBe(first);
    expect(getDatabaseProvider('polaris-dados')).toBe(second);
    unregisterSecond();
  });

  it('tracks each root independently and deactivates every root on provider unload', () => {
    const changed = vi.fn();
    const unsubscribe = subscribeDatabaseProviders(changed);
    const unregister = register();
    const provider = getDatabaseProvider('polaris-dados')!;
    const first = document.createElement('div');
    const second = document.createElement('div');
    const child = document.createElement('button');
    second.append(child);
    const firstDeactivated = vi.fn();
    const secondDeactivated = vi.fn();
    const releaseFirst = registerMountedDatabaseProvider(provider, dbId, first, firstDeactivated)!;
    registerMountedDatabaseProvider(provider, dbId, second, secondDeactivated)!;

    expect(focusedDatabaseProviderRoot(child)).toBe(second);
    releaseFirst();
    expect(firstDeactivated).not.toHaveBeenCalled();
    expect(focusedDatabaseProviderRoot(child)).toBe(second);
    unregister();
    expect(secondDeactivated).toHaveBeenCalledOnce();
    expect(focusedDatabaseProviderRoot(child)).toBeNull();
    expect(changed).toHaveBeenCalled();
    unsubscribe();
  });

  it('publishes a monotonic namespace version for React subscribers', () => {
    const before = databaseProvidersVersion();
    const unregister = register();
    expect(databaseProvidersVersion()).toBeGreaterThan(before);
    unregister();
  });
});

describe('provider mount data scope', () => {
  it('limits access to one database, enforces local readonly, and invalidates listeners on dispose', async () => {
    const stopSubscription = vi.fn();
    const source = fakeDataApi({ subscribe: vi.fn(() => stopSubscription) });
    const scope = createProviderDataScope(source, dbId, { isActive: () => true, editable: false });

    const snapshot = scope.api.snapshot(dbId);
    expect(snapshot).toMatchObject({ readonly: true, history: { canUndo: false, canRedo: false } });
    expect(Object.isFrozen(snapshot)).toBe(true);
    if (snapshot.status !== 'ready') throw new Error('Expected a ready snapshot.');
    expect(Object.isFrozen(snapshot.history)).toBe(true);
    expect(scope.api.patchCell({
      databaseId: dbId,
      rowId: 'row' as PageId,
      propertyId: 'count',
      value: 2,
      expectedRevision: 'r1',
    })).toMatchObject({ status: 'error', code: 'host-readonly' });
    expect(scope.api.history({ databaseId: dbId, direction: 'undo', expectedRevision: 'r1' })).toMatchObject({
      status: 'error',
      code: 'host-readonly',
    });
    expect(scope.api.patchCell({
      databaseId: otherDbId,
      rowId: 'row' as PageId,
      propertyId: 'count',
      value: 2,
      expectedRevision: 'r1',
    })).toMatchObject({ status: 'error', code: 'out-of-scope' });

    const unsubscribe = scope.api.subscribe(dbId, () => {});
    unsubscribe();
    const secondUnsubscribe = scope.api.subscribe(dbId, () => {});
    scope.dispose();
    secondUnsubscribe();
    expect(stopSubscription).toHaveBeenCalledTimes(2);
    expect(scope.api.patchCell({
      databaseId: dbId,
      rowId: 'row' as PageId,
      propertyId: 'count',
      value: 2,
      expectedRevision: 'r1',
    })).toMatchObject({ status: 'error', code: 'owner-inactive' });
    expect(() => scope.api.snapshot(dbId)).toThrow(/no longer active/i);
  });

  it('allows a pending flush in readonly mode, then rechecks disposal after it settles', async () => {
    let finishFlush: ((result: DataApiFlushResult) => void) | undefined;
    const source = fakeDataApi({
      flush: vi.fn(() => new Promise<DataApiFlushResult>((resolve) => { finishFlush = resolve; })),
    });
    const scope = createProviderDataScope(source, dbId, { isActive: () => true, editable: false });
    const pending = scope.api.flush(dbId);
    expect(source.flush).toHaveBeenCalledWith(dbId);
    scope.dispose();
    finishFlush!({ status: 'persisted', databaseId: dbId, revision: 'r2' });
    await expect(pending).resolves.toMatchObject({ status: 'error', code: 'owner-inactive' });
  });
});

describe('plugin page metadata isolation', () => {
  it('deep-copies nested frontmatter values before returning them to a plugin', () => {
    const canonical = { polarisDados: { version: 1, provider: 'polaris-dados' }, vendor: { keep: ['a', 'b'] } };
    const returned = clonePluginPageProperties(canonical);
    (returned.vendor as { keep: string[] }).keep.push('mutated');
    (returned.polarisDados as { version: number }).version = 999;

    expect(returned).not.toBe(canonical);
    expect(returned.vendor).not.toBe(canonical.vendor);
    expect(canonical.vendor).toEqual({ keep: ['a', 'b'] });
    expect(canonical.polarisDados).toEqual({ version: 1, provider: 'polaris-dados' });
  });
});

describe('provider undo routing', () => {
  it('routes focused roots a local command and keeps input draft undo first', () => {
    const unregister = register();
    const provider = getDatabaseProvider('polaris-dados')!;
    const root = document.createElement('div');
    const button = document.createElement('button');
    root.append(button);
    document.body.append(root);
    const releaseRoot = registerMountedDatabaseProvider(provider, dbId, root, () => {})!;
    const rootKeydown = vi.fn();
    const nativeUndo = vi.spyOn(workspace, 'stepProperties');
    root.addEventListener('keydown', rootKeydown);
    button.focus();

    undoRedo('undo');
    expect(rootKeydown).toHaveBeenCalledOnce();
    expect(rootKeydown.mock.calls[0]?.[0]).toMatchObject({ key: 'z', bubbles: false, ctrlKey: true });
    expect(nativeUndo).not.toHaveBeenCalled();

    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    const oldExecCommand = document.execCommand;
    const execCommand = vi.fn();
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
    try {
      undoRedo('undo');
      expect(execCommand).toHaveBeenCalledTimes(1);
      expect(execCommand).toHaveBeenCalledWith('undo');
      expect(rootKeydown).toHaveBeenCalledOnce();
    } finally {
      if (oldExecCommand) Object.defineProperty(document, 'execCommand', { configurable: true, value: oldExecCommand });
      else Reflect.deleteProperty(document, 'execCommand');
      nativeUndo.mockRestore();
      releaseRoot();
      unregister();
    }
  });
});
