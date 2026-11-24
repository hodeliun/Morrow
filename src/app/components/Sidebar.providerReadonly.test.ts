// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageId } from '../../core/model';
import { E003_POLARIS_DADOS_FIXTURE } from '../../storage/fixtures/e003-polaris-dados';
import { MemoryVault } from '../../storage/memoryVault';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';
import { getPreferences, setPreferences } from '../platform/preferences';
import { setUi } from '../ui';
import { setSession } from '../workspace';
import { t } from '../i18n';
import { canMoveTreePage } from './pageEditability';
import { Sidebar } from './Sidebar';

vi.mock('../review', () => ({ useReviewLog: () => ({}) }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let nextId = 0;
const newId = () => `sidebar-provider-${++nextId}`;

async function openFixture() {
  const opened = await WorkspaceSession.open(
    new VaultRepository(new MemoryVault(E003_POLARIS_DADOS_FIXTURE), newId),
  );
  if (!opened.ok) throw new Error(opened.error);
  setSession(opened.value);
  return opened.value;
}

function pathId(session: WorkspaceSession, path: string): PageId {
  const id = Object.keys(session.getState().pages).find((candidate) => session.pathOf(candidate as PageId) === path);
  if (!id) throw new Error(`No page at ${path}`);
  return id as PageId;
}

afterEach(() => {
  document.body.replaceChildren();
  setUi({ renaming: null });
  setPreferences({ expanded: [] });
});

describe('provider-managed sidebar pages', () => {
  it('blocks row rename, deletion, add-subpage, and tree moves while preserving the same actions for basic pages', async () => {
    const session = await openFixture();
    const databaseId = pathId(session, 'Inventory.md');
    const rowId = pathId(session, 'Inventory/Widget.md');
    const basicId = pathId(session, 'Archive.md');
    const state = session.getState();
    const database = state.pages[databaseId]!;
    const managedPage = state.pages[rowId]!;
    const basicPage = state.pages[basicId]!;
    expect(canMoveTreePage(state, managedPage, basicPage, 'before')).toBe(false);
    expect(canMoveTreePage(state, basicPage, managedPage, 'after')).toBe(false);
    expect(canMoveTreePage(state, basicPage, database, 'inside')).toBe(false);
    expect(canMoveTreePage(state, basicPage, database, 'before')).toBe(true);
    const originalPreferences = getPreferences();
    setPreferences({ expanded: [databaseId] });

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(Sidebar)));
      const managedRow = container.querySelector<HTMLElement>(`[data-page-id="${rowId}"]`);
      const basicRow = container.querySelector<HTMLElement>(`[data-page-id="${basicId}"]`);
      expect(managedRow).not.toBeNull();
      expect(basicRow).not.toBeNull();
      expect(managedRow?.getAttribute('draggable')).toBe('false');
      expect(basicRow?.getAttribute('draggable')).toBe('true');

      managedRow!.focus();
      await act(async () => {
        managedRow!.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
      });
      expect(container.querySelector(`[data-page-id="${rowId}"] .tree-rename`)).toBeNull();

      await act(async () => {
        managedRow!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      });
      expect(container.querySelector(`[data-page-id="${rowId}"] .tree-rename`)).toBeNull();

      const managedButtons = managedRow!.querySelectorAll<HTMLButtonElement>('.tree-actions button');
      expect(managedButtons).toHaveLength(1);
      await act(async () => managedButtons[0]!.click());
      const menu = document.body.querySelector<HTMLElement>('[role="menu"]');
      expect(menu).not.toBeNull();
      for (const unavailable of [
        t('pageMenu.rename'),
        t('pageMenu.duplicate'),
        t('pageMenu.moveTo'),
        t('pageMenu.moveToTrash'),
        t('pageMenu.addSubpage'),
      ])
        expect(menu!.textContent).not.toContain(unavailable);
      expect(menu!.textContent).toContain(t('pageMenu.pageHistory'));
      expect(menu!.textContent).toContain(t('pageMenu.openLocalGraph'));

      await act(async () => {
        menu!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      managedRow!.focus();
      await act(async () => {
        managedRow!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
      });
      expect(session.getState().pages[rowId]?.trashedAt).toBeNull();

      basicRow!.focus();
      await act(async () => {
        basicRow!.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
      });
      expect(container.querySelector(`[data-page-id="${basicId}"] .tree-rename`)).not.toBeNull();
      await act(async () => setUi({ renaming: null }));
    } finally {
      await act(async () => root.unmount());
      container.remove();
      setPreferences({
        expanded: originalPreferences.expanded,
        readingMode: originalPreferences.readingMode,
      });
      await session.close();
    }
  });
});
