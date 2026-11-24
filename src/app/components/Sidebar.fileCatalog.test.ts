// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { E003_POLARIS_DADOS_FIXTURE } from '../../storage/fixtures/e003-polaris-dados';
import { MemoryVault } from '../../storage/memoryVault';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';
import { setPreferences } from '../platform/preferences';
import {
  addPluginSidebarFileCatalog,
  polarisArquivosSidebarFileCatalog,
} from '../plugins/registry';
import { setSession } from '../workspace';
import { Sidebar } from './Sidebar';

vi.mock('../review', () => ({ useReviewLog: () => ({}) }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let sequence = 0;
let activeSession: WorkspaceSession | undefined;
const registeredCleanups: Array<() => void> = [];

async function openFixture(): Promise<WorkspaceSession> {
  const opened = await WorkspaceSession.open(
    new VaultRepository(new MemoryVault(E003_POLARIS_DADOS_FIXTURE), () => `sidebar-files-${++sequence}`),
  );
  if (!opened.ok) throw new Error(opened.error);
  activeSession = opened.value;
  setSession(activeSession);
  return activeSession;
}

afterEach(async () => {
  for (const cleanup of registeredCleanups.splice(0)) cleanup();
  document.body.replaceChildren();
  setPreferences({ expanded: [] });
  if (activeSession && !activeSession.isClosed) await activeSession.close();
  activeSession = undefined;
});

describe('Polaris Arquivos sidebar slot', () => {
  it('survives plugin mount and cleanup errors, and clears the old alert on remount', async () => {
    await openFixture();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const host = { isActive: () => true };
    registeredCleanups.push(
      addPluginSidebarFileCatalog('polaris-arquivos', 1, () => {
        throw new Error('synthetic mount failure');
      }, host, () => true),
    );

    try {
      await act(async () => root.render(createElement(Sidebar)));
      const slot = container.querySelector<HTMLElement>('[data-sidebar-plugin-slot="polaris-arquivos"]');
      expect(slot?.getAttribute('role')).toBe('alert');
      expect(slot?.textContent).toContain('could not be mounted');

      registeredCleanups.push(
        addPluginSidebarFileCatalog(
          'polaris-arquivos',
          2,
          (target) => {
            target.textContent = 'Reopened catalog';
            return () => {
              throw new Error('synthetic cleanup failure');
            };
          },
          host,
          () => true,
        ),
      );
      await act(async () => {});
      const remounted = container.querySelector<HTMLElement>('[data-sidebar-plugin-slot="polaris-arquivos"]');
      expect(polarisArquivosSidebarFileCatalog()?.generation).toBeGreaterThan(1);
      expect(remounted?.getAttribute('role')).toBeNull();
      expect(remounted?.textContent).toBe('Reopened catalog');

      registeredCleanups.at(-1)?.();
      await act(async () => {});
      expect(container.querySelector('aside.sidebar')).not.toBeNull();
      expect(container.querySelector('[data-sidebar-plugin-slot="polaris-arquivos"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
