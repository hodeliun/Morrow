// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DataApi, DataApiSnapshot } from '../../../app/plugins/dataApi';
import * as databaseCore from '../../../core/database';
import type { PageId } from '../../../core/model';
import { E003_POLARIS_DADOS_FIXTURE } from '../../../storage/fixtures/e003-polaris-dados';
import { MemoryVault } from '../../../storage/memoryVault';
import * as pilotData from '../../../storage/pilotData';
import type { PilotDataBackend } from '../../../storage/pilotData';
import { WorkspaceSession } from '../../../storage/session';
import { VaultRepository } from '../../../storage/vaultRepository';
import { registerDatabaseProvider } from '../../plugins/providerRegistry';
import { getPreferences, setPreferences } from '../../platform/preferences';
import { setSession } from '../../workspace';
import { DatabaseView } from './DatabaseView';
import { PageProperties } from '../PageProperties';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let nextId = 0;
const newId = () => `provider-view-${++nextId}`;

async function openFixture(files: Record<string, string> = E003_POLARIS_DADOS_FIXTURE) {
  const opened = await WorkspaceSession.open(new VaultRepository(new MemoryVault(files), newId));
  if (!opened.ok) throw new Error(opened.error);
  const session = opened.value;
  setSession(session);
  const databaseId = Object.keys(session.getState().pages).find(
    (id) => session.pathOf(id) === 'Inventory.md',
  ) as PageId | undefined;
  if (!databaseId) throw new Error('Synthetic database fixture is missing.');
  return { session, page: session.getState().pages[databaseId]! };
}

function dataApi(snapshot: DataApiSnapshot): DataApi {
  return {
    version: 1,
    snapshot: () => snapshot,
    patchCell: () => ({ status: 'error', code: 'read-only', message: 'read only' }),
    history: () => ({ status: 'no-op', databaseId: snapshot.databaseId, revision: snapshot.revision, direction: 'undo' }),
    subscribe: () => () => {},
    flush: async () => ({ status: 'persisted', databaseId: snapshot.databaseId, revision: snapshot.revision }),
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('provider database view host', () => {
  it('uses literal readonly fallback without mounting the native formula evaluator', async () => {
    const { session, page } = await openFixture();
    const evaluateValue = vi.spyOn(databaseCore, 'valueOf');
    const evaluateFormula = vi.spyOn(databaseCore, 'formulaResult');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(DatabaseView, { page, editable: true }));
      });
      expect(container.textContent).toContain('Activate the Polaris Dados plugin');
      expect(container.querySelector('details')?.open).toBe(false);
      expect(container.textContent).toContain('required host API: 1');
      expect(container.textContent).toContain('Quantity * Price');
      expect(container.textContent).toContain('2');
      expect(container.textContent).toContain('10');
      expect(evaluateValue).not.toHaveBeenCalled();
      expect(evaluateFormula).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      evaluateValue.mockRestore();
      evaluateFormula.mockRestore();
      await session.close();
    }
  });

  it('cleans a throwing mount, invalidates its data scope, and shows the literal fallback', async () => {
    const { session, page } = await openFixture();
    const snapshot: DataApiSnapshot = {
      version: 1,
      status: 'ready',
      databaseId: page.id,
      revision: 'r1',
      schema: page.database!,
      rows: [],
      history: { canUndo: false, canRedo: false },
      readonly: false,
      diagnostic: null,
    };
    const evaluateValue = vi.spyOn(databaseCore, 'valueOf');
    const evaluateFormula = vi.spyOn(databaseCore, 'formulaResult');
    let failedMount: { signal: AbortSignal; data: DataApi } | undefined;
    const unregister = registerDatabaseProvider('polaris-dados', () => true, dataApi(snapshot), {
      id: 'polaris-dados',
      apiVersion: 1,
      mount: (context) => {
        failedMount = context;
        context.element.textContent = 'partial mount';
        throw new Error('provider startup failed');
      },
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(DatabaseView, { page, editable: true }));
      });
      expect(failedMount?.signal.aborted).toBe(true);
      expect(() => failedMount!.data.snapshot(page.id)).toThrow(/no longer active/i);
      expect(container.querySelector('.database-provider-root')).toBeNull();
      expect(container.textContent).toContain('The Polaris Dados provider could not start');
      expect(container.querySelector('details')?.open).toBe(false);
      expect(container.textContent).toContain('provider startup failed');
      expect(container.textContent).toContain('Quantity * Price');
      expect(evaluateValue).not.toHaveBeenCalled();
      expect(evaluateFormula).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      unregister();
      evaluateValue.mockRestore();
      evaluateFormula.mockRestore();
      await session.close();
    }
  });

  it('refuses a table when the host snapshot says opted-in data is unsupported', async () => {
    const { session, page } = await openFixture();
    const backend = {
      snapshot: vi.fn(() => ({
        version: 1 as const,
        status: 'unsupported' as const,
        databaseId: page.id,
        revision: 'r1',
        diagnostic: { code: 'unrepresentable-cell' as const, message: 'An orphaned cell cannot round trip.' },
      })),
    } as unknown as PilotDataBackend;
    const snapshot = vi.spyOn(pilotData, 'createPilotDataBackend').mockReturnValue(backend);
    const evaluate = vi.spyOn(databaseCore, 'formulaResult');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(DatabaseView, { page, editable: true }));
      });
      expect(backend.snapshot).toHaveBeenCalledWith(page.id);
      expect(container.querySelector('table')).toBeNull();
      expect(container.querySelector('details')?.open).toBe(false);
      expect(container.textContent).toContain('An orphaned cell cannot round trip.');
      expect(evaluate).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      snapshot.mockRestore();
      evaluate.mockRestore();
      await session.close();
    }
  });

  it('leaves a database without the opt-in marker on the native renderer', async () => {
    const basicFixture = {
      ...E003_POLARIS_DADOS_FIXTURE,
      'Inventory.md': E003_POLARIS_DADOS_FIXTURE['Inventory.md']!.replace(
        /polarisDados:\n {2}version: 1\n {2}provider: polaris-dados\n/,
        '',
      ),
    };
    const { session, page } = await openFixture(basicFixture);
    const evaluate = vi.spyOn(databaseCore, 'formulaResult');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(DatabaseView, { page, editable: true }));
      });
      expect(evaluate).toHaveBeenCalled();
      expect(container.querySelector('.db-bar')).not.toBeNull();
      expect(container.textContent).not.toContain('Activate the Polaris Dados plugin');
    } finally {
      await act(async () => root.unmount());
      evaluate.mockRestore();
      await session.close();
    }
  });

  it('shows provider row formulas literally with a bank link, without native row inputs', async () => {
    const { session, page } = await openFixture();
    const row = Object.values(session.getState().pages).find((candidate) => candidate.parentId === page.id)!;
    const evaluate = vi.spyOn(databaseCore, 'formulaResult');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(PageProperties, {
          page: row,
          database: { id: page.id, database: page.database! },
          editable: true,
          adding: false,
          onAdded: () => {},
        }));
      });
      expect(container.textContent).toContain('Quantity * Price');
      expect(container.textContent).toContain('Open database: Inventory');
      expect(container.querySelector('input')).toBeNull();
      expect(container.querySelector('.row-prop-button')).toBeNull();
      expect(evaluate).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      evaluate.mockRestore();
      await session.close();
    }
  });

  it('passes host locale and editability, remounts on changes, and invalidates old scopes', async () => {
    const { session, page } = await openFixture();
    const originalPreferences = getPreferences();
    setPreferences({ locale: 'pt', readingMode: false });
    const snapshot: DataApiSnapshot = {
      version: 1,
      status: 'ready',
      databaseId: page.id,
      revision: 'r1',
      schema: page.database!,
      rows: [],
      history: { canUndo: true, canRedo: false },
      readonly: false,
      diagnostic: null,
    };
    const mounts: Array<{
      locale: string;
      editable: boolean;
      signal: AbortSignal;
      data: DataApi;
    }> = [];
    const cleanups: Array<ReturnType<typeof vi.fn>> = [];
    const unregister = registerDatabaseProvider('polaris-dados', () => true, dataApi(snapshot), {
      id: 'polaris-dados',
      apiVersion: 1,
      mount: (context) => {
        mounts.push(context);
        const cleanup = vi.fn();
        cleanups.push(cleanup);
        context.element.textContent = `${context.locale}:${context.editable}`;
        return cleanup;
      },
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(DatabaseView, { page, editable: true }));
      });
      expect(mounts).toHaveLength(1);
      expect(mounts[0]).toMatchObject({ locale: 'pt', editable: true });
      const oldMount = mounts[0]!;

      await act(async () => {
        setPreferences({ locale: 'es', readingMode: true });
        root.render(createElement(DatabaseView, { page, editable: true }));
      });
      expect(mounts).toHaveLength(2);
      expect(mounts[1]).toMatchObject({ locale: 'es', editable: false });
      expect(oldMount.signal.aborted).toBe(true);
      expect(cleanups[0]).toHaveBeenCalledOnce();
      expect(() => oldMount.data.snapshot(page.id)).toThrow(/no longer active/i);
      expect(mounts[1]!.data.snapshot(page.id)).toMatchObject({ readonly: true });
      expect(mounts[1]!.data.patchCell({
        databaseId: page.id,
        rowId: 'row' as PageId,
        propertyId: 'quantity',
        value: 3,
        expectedRevision: 'r1',
      })).toMatchObject({ status: 'error', code: 'host-readonly' });
      const secondMount = mounts[1]!;

      await act(async () => {
        setPreferences({ locale: 'pt', readingMode: false });
        root.render(createElement(DatabaseView, { page, editable: true }));
      });
      expect(mounts).toHaveLength(3);
      expect(mounts[2]).toMatchObject({ locale: 'pt', editable: true });
      expect(container.textContent).toBe('pt:true');
      expect(secondMount.signal.aborted).toBe(true);
      expect(cleanups[1]).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      expect(mounts.every((mount) => mount.signal.aborted)).toBe(true);
      expect(cleanups.every((cleanup) => cleanup.mock.calls.length === 1)).toBe(true);
      unregister();
      setPreferences({ locale: originalPreferences.locale, readingMode: originalPreferences.readingMode });
      await session.close();
    }
  });
});
