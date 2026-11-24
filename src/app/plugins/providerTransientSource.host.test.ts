// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDataApi } from './dataApi';
import type { DatabaseProviderContext } from './providerApi';
import type { PageId } from '../../core/model';
import { E003_POLARIS_DADOS_FIXTURE } from '../../storage/fixtures/e003-polaris-dados';
import { MemoryVault } from '../../storage/memoryVault';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';
import { getPreferences, setPreferences } from '../platform/preferences';
import { DatabaseView } from '../components/database/DatabaseView';
import { getDatabaseProvider, registerDatabaseProvider } from './providerRegistry';
import { setSession } from '../workspace';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type MountContext = DatabaseProviderContext;

interface FixtureSession {
  readonly session: WorkspaceSession;
  readonly vault: MemoryVault;
  readonly page: ReturnType<WorkspaceSession['getState']>['pages'][PageId];
}

function deterministicIds() {
  let index = 0;
  return () => `transient-source-${index++}`;
}

async function openFixture(): Promise<FixtureSession> {
  const files = {
    ...E003_POLARIS_DADOS_FIXTURE,
    'OtherInventory.md': E003_POLARIS_DADOS_FIXTURE['Inventory.md']!,
  };
  const vault = new MemoryVault(files);
  const opened = await WorkspaceSession.open(new VaultRepository(vault, deterministicIds()));
  if (!opened.ok) throw new Error(opened.error);
  const session = opened.value;
  const page = Object.values(session.getState().pages).find(
    (candidate) => session.pathOf(candidate.id) === 'Inventory.md',
  );
  if (!page) throw new Error('Synthetic database fixture is missing.');
  return { session, vault, page };
}

function registerProvider(
  owner: string,
  contexts: MountContext[],
  session: WorkspaceSession,
  mount: (context: MountContext) => void | (() => void) = () => () => {},
) {
  let ownerActive = true;
  const cleanups = new Set<() => void>();
  const api = createDataApi({
    session,
    ownerIsActive: () => ownerActive,
    isProviderActive: () => getDatabaseProvider('polaris-dados')?.data === api,
    isHostReadonly: () => getPreferences().readingMode,
    registerCleanup: (cleanup) => cleanups.add(cleanup),
  });
  const unregisterProvider = registerDatabaseProvider(owner, () => ownerActive, api, {
    id: 'polaris-dados',
    apiVersion: 1,
    mount(context) {
      contexts.push(context);
      return mount(context);
    },
  });
  let disposed = false;
  let unsubscribeClose = () => {};
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubscribeClose();
    ownerActive = false;
    unregisterProvider();
    for (const cleanup of cleanups) cleanup();
    cleanups.clear();
  };
  unsubscribeClose = session.onClose(dispose);
  return { api, unregister: dispose };
}

function contextFor(contexts: MountContext[], container: HTMLElement): MountContext {
  const matches = contexts.filter(
    (context) => container.contains(context.element) && !context.signal.aborted,
  );
  if (matches.length !== 1) throw new Error('Expected one active provider mount for a rendered source root.');
  const context = matches[0]!;
  return context;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('provider transient Source state', () => {
  it('keeps drafts per root through locale, readonly, fallback, and same-owner reload', async () => {
    const fixture = await openFixture();
    const initialFiles = new Map(fixture.vault.files);
    const apply = vi.spyOn(fixture.vault, 'apply');
    const originalPreferences = getPreferences();
    const mounts: MountContext[] = [];
    const containerA = document.createElement('div');
    const containerB = document.createElement('div');
    document.body.append(containerA, containerB);
    const rootA = createRoot(containerA);
    const rootB = createRoot(containerB);
    let unregister = () => {};
    let latestOwnerMount: MountContext | undefined;
    try {
      setSession(fixture.session);
      setPreferences({ locale: 'pt', readingMode: false });
      const first = registerProvider('polaris-dados', mounts, fixture.session);
      unregister = first.unregister;

      await act(async () => {
        rootA.render(createElement(DatabaseView, { page: fixture.page!, editable: true }));
        rootB.render(createElement(DatabaseView, { page: fixture.page!, editable: true }));
      });

      const firstA = contextFor(mounts, containerA);
      const firstB = contextFor(mounts, containerB);
      expect(firstA.databaseId).toBe(firstB.databaseId);
      expect(firstA.transientState).toBeDefined();
      expect(firstB.transientState).toBeDefined();
      expect(firstA.transientState!.write('draft A')).toBe(true);
      expect(firstB.transientState!.write('draft B')).toBe(true);
      expect(firstA.transientState!.read()).toBe('draft A');
      expect(firstB.transientState!.read()).toBe('draft B');

      await act(async () => setPreferences({ locale: 'es' }));
      const localeA = contextFor(mounts, containerA);
      const localeB = contextFor(mounts, containerB);
      expect(localeA.locale).toBe('es');
      expect(localeB.locale).toBe('es');
      expect(firstA.signal.aborted).toBe(true);
      expect(firstB.signal.aborted).toBe(true);
      expect(firstA.transientState!.read()).toBeUndefined();
      expect(firstA.transientState!.write('stale')).toBe(false);
      expect(() => firstA.data.snapshot(firstA.databaseId)).toThrow(/no longer active/i);
      expect(localeA.transientState!.read()).toBe('draft A');
      expect(localeB.transientState!.read()).toBe('draft B');

      await act(async () => setPreferences({ readingMode: true }));
      const readonlyA = contextFor(mounts, containerA);
      const readonlyB = contextFor(mounts, containerB);
      expect(readonlyA.editable).toBe(false);
      expect(readonlyB.editable).toBe(false);
      expect(localeA.signal.aborted).toBe(true);
      expect(localeB.signal.aborted).toBe(true);
      expect(localeA.transientState!.read()).toBeUndefined();
      expect(localeA.transientState!.write('stale locale')).toBe(false);
      expect(readonlyA.transientState!.write('draft A')).toBe(true);
      expect(readonlyB.transientState!.write('draft B')).toBe(true);
      expect(readonlyA.transientState!.read()).toBe('draft A');
      expect(readonlyB.transientState!.read()).toBe('draft B');
      expect(
        readonlyA.data.patchCell({
          databaseId: readonlyA.databaseId,
          rowId: 'row' as PageId,
          propertyId: 'quantity',
          value: 2,
          expectedRevision: 'r1',
        }),
      ).toMatchObject({ status: 'error', code: 'host-readonly' });

      await act(async () => unregister());
      expect(containerA.textContent).toContain('Polaris Dados');
      expect(containerB.textContent).toContain('Polaris Dados');
      expect(readonlyA.signal.aborted).toBe(true);
      expect(readonlyB.signal.aborted).toBe(true);
      expect(readonlyA.transientState!.read()).toBeUndefined();
      expect(readonlyA.transientState!.write('stale after unregister')).toBe(false);

      let reloaded: ReturnType<typeof registerProvider> | undefined;
      await act(async () => {
        reloaded = registerProvider('polaris-dados', mounts, fixture.session);
      });
      unregister = reloaded!.unregister;
      const reloadedA = contextFor(mounts, containerA);
      const reloadedB = contextFor(mounts, containerB);
      expect(reloadedA.transientState!.read()).toBe('draft A');
      expect(reloadedB.transientState!.read()).toBe('draft B');

      await act(async () => unregister());
      let otherOwner: ReturnType<typeof registerProvider> | undefined;
      await act(async () => {
        otherOwner = registerProvider('other-plugin', mounts, fixture.session);
      });
      unregister = otherOwner!.unregister;
      const otherOwnerA = contextFor(mounts, containerA);
      const otherOwnerB = contextFor(mounts, containerB);
      expect(otherOwnerA.transientState!.read()).toBeUndefined();
      expect(otherOwnerB.transientState!.read()).toBeUndefined();
      expect(otherOwnerA.transientState!.write('new owner draft')).toBe(true);
      latestOwnerMount = otherOwnerA;
      expect(getDatabaseProvider('polaris-dados')?.owner).toBe('other-plugin');
    } finally {
      await act(async () => {
        rootA.unmount();
        rootB.unmount();
      });
      if (latestOwnerMount) {
        expect(latestOwnerMount.transientState!.read()).toBeUndefined();
        expect(latestOwnerMount.transientState!.write('after unmount')).toBe(false);
      }
      unregister();
      setPreferences({ locale: originalPreferences.locale, readingMode: originalPreferences.readingMode });
      await fixture.session.close();
      expect(apply).not.toHaveBeenCalled();
      expect(fixture.vault.files).toEqual(initialFiles);
    }
  });

  it('clears on a changed binding, a replacement session with the same ids, and close without vault writes', async () => {
    const firstFixture = await openFixture();
    const secondFixture = await openFixture();
    const originalPreferences = getPreferences();
    const mounts: MountContext[] = [];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let unregister = () => {};
    const firstFiles = new Map(firstFixture.vault.files);
    const secondFiles = new Map(secondFixture.vault.files);
    const firstApply = vi.spyOn(firstFixture.vault, 'apply');
    const secondApply = vi.spyOn(secondFixture.vault, 'apply');
    try {
      setSession(firstFixture.session);
      setPreferences({ locale: 'pt', readingMode: false });
      const registered = registerProvider('polaris-dados', mounts, firstFixture.session);
      unregister = registered.unregister;
      await act(async () => {
        root.render(createElement(DatabaseView, { page: firstFixture.page!, editable: true }));
      });
      const first = contextFor(mounts, container);
      expect(first.transientState!.write('first binding')).toBe(true);

      const otherPage = Object.values(firstFixture.session.getState().pages).find(
        (candidate) => firstFixture.session.pathOf(candidate.id) === 'OtherInventory.md',
      );
      if (!otherPage) throw new Error('Second synthetic database fixture is missing.');
      await act(async () => {
        root.render(createElement(DatabaseView, { page: otherPage, editable: true }));
      });
      const changedBinding = contextFor(mounts, container);
      expect(changedBinding.databaseId).not.toBe(first.databaseId);
      expect(first.transientState!.read()).toBeUndefined();
      expect(first.transientState!.write('stale binding')).toBe(false);
      expect(changedBinding.transientState!.read()).toBeUndefined();
      expect(changedBinding.transientState!.write('session one')).toBe(true);

      const secondOtherPage = Object.values(secondFixture.session.getState().pages).find(
        (candidate) => secondFixture.session.pathOf(candidate.id) === 'OtherInventory.md',
      );
      if (!secondOtherPage) throw new Error('Second session database fixture is missing.');
      expect(secondFixture.page!.id).toBe(firstFixture.page!.id);
      expect(secondOtherPage.id).toBe(otherPage.id);

      await act(async () => unregister());
      expect(changedBinding.signal.aborted).toBe(true);
      expect(changedBinding.transientState!.read()).toBeUndefined();
      expect(changedBinding.transientState!.write('stale before session switch')).toBe(false);
      expect(() => changedBinding.data.snapshot(changedBinding.databaseId)).toThrow(/no longer active/i);

      let replacement: ReturnType<typeof registerProvider> | undefined;
      await act(async () => {
        setSession(secondFixture.session);
        replacement = registerProvider('polaris-dados', mounts, secondFixture.session);
        unregister = replacement.unregister;
        root.render(createElement(DatabaseView, { page: secondOtherPage, editable: true }));
      });
      const changedSession = contextFor(mounts, container);
      expect(changedSession.databaseId).toBe(changedBinding.databaseId);
      expect(changedBinding.transientState!.read()).toBeUndefined();
      expect(changedBinding.transientState!.write('stale session')).toBe(false);
      expect(changedSession.transientState!.read()).toBeUndefined();
      expect(changedSession.transientState!.write('closing session')).toBe(true);

      await act(async () => secondFixture.session.close());
      expect(changedSession.signal.aborted).toBe(true);
      expect(changedSession.transientState!.read()).toBeUndefined();
      expect(changedSession.transientState!.write('after close')).toBe(false);
      expect(() => changedSession.data.snapshot(changedSession.databaseId)).toThrow(/no longer active/i);
      expect(firstApply).not.toHaveBeenCalled();
      expect(secondApply).not.toHaveBeenCalled();
      expect(firstFixture.vault.files).toEqual(firstFiles);
      expect(secondFixture.vault.files).toEqual(secondFiles);
    } finally {
      await act(async () => root.unmount());
      unregister();
      setPreferences({ locale: originalPreferences.locale, readingMode: originalPreferences.readingMode });
      await firstFixture.session.close();
      if (!secondFixture.session.isClosed) await secondFixture.session.close();
    }
  });

  it('clears a draft when the Source binding changes while the provider is absent', async () => {
    const fixture = await openFixture();
    const originalPreferences = getPreferences();
    const mounts: MountContext[] = [];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const initialFiles = new Map(fixture.vault.files);
    const apply = vi.spyOn(fixture.vault, 'apply');
    let unregister = () => {};
    try {
      const otherPage = Object.values(fixture.session.getState().pages).find(
        (candidate) => fixture.session.pathOf(candidate.id) === 'OtherInventory.md',
      );
      if (!otherPage) throw new Error('Second synthetic database fixture is missing.');

      setSession(fixture.session);
      setPreferences({ locale: 'pt', readingMode: false });
      const registered = registerProvider('polaris-dados', mounts, fixture.session);
      unregister = registered.unregister;
      await act(async () => {
        root.render(createElement(DatabaseView, { page: fixture.page!, editable: true }));
      });

      const sourceA = contextFor(mounts, container);
      expect(sourceA.transientState!.write('draft A')).toBe(true);
      await act(async () => unregister());
      expect(sourceA.signal.aborted).toBe(true);
      expect(sourceA.transientState!.read()).toBeUndefined();
      expect(sourceA.transientState!.write('stale A')).toBe(false);

      await act(async () => {
        root.render(createElement(DatabaseView, { page: otherPage, editable: true }));
      });
      expect(container.querySelector('.database-provider-root')).toBeNull();
      await act(async () => {
        root.render(createElement(DatabaseView, { page: fixture.page!, editable: true }));
      });
      expect(container.querySelector('.database-provider-root')).toBeNull();

      let reloaded: ReturnType<typeof registerProvider> | undefined;
      await act(async () => {
        reloaded = registerProvider('polaris-dados', mounts, fixture.session);
      });
      unregister = reloaded!.unregister;
      const remountedA = contextFor(mounts, container);
      expect(remountedA.databaseId).toBe(sourceA.databaseId);
      expect(remountedA.transientState!.read()).toBeUndefined();
      expect(sourceA.transientState!.read()).toBeUndefined();
      expect(sourceA.transientState!.write('cannot revive old A')).toBe(false);
      expect(apply).not.toHaveBeenCalled();
      expect(fixture.vault.files).toEqual(initialFiles);
    } finally {
      await act(async () => root.unmount());
      unregister();
      setPreferences({ locale: originalPreferences.locale, readingMode: originalPreferences.readingMode });
      await fixture.session.close();
    }
  });

  it('mounts a provider that does not use the optional capability', async () => {
    const fixture = await openFixture();
    const originalPreferences = getPreferences();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let didMount = false;
    let unregister = () => {};
    try {
      setSession(fixture.session);
      setPreferences({ locale: 'pt', readingMode: false });
      const registered = registerProvider('legacy-provider', [], fixture.session, (context) => {
        didMount = true;
        context.element.textContent = context.locale;
      });
      unregister = registered.unregister;
      await act(async () => {
        root.render(createElement(DatabaseView, { page: fixture.page!, editable: true }));
      });
      expect(didMount).toBe(true);
      expect(container.textContent).toContain('pt');
    } finally {
      await act(async () => root.unmount());
      unregister();
      setPreferences({ locale: originalPreferences.locale, readingMode: originalPreferences.readingMode });
      await fixture.session.close();
    }
  });
});
