// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { E003_POLARIS_DADOS_FIXTURE } from '../../storage/fixtures/e003-polaris-dados';
import { MemoryVault } from '../../storage/memoryVault';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';
import type { PageId } from '../../core/model';
import { setPreferences, getPreferences } from '../platform/preferences';
import { setUi } from '../ui';
import { setSession } from '../workspace';
import { t } from '../i18n';
import { pageMenuEntries } from './pageMenu';
import { isProviderManagedPage } from './pageEditability';
import { PageView } from './PageView';

vi.mock('../editor/PageEditor', async () => {
  const React = await import('react');
  return {
    PageEditor: ({ editable }: { editable: boolean }) =>
      React.createElement('div', { className: 'test-page-editor', 'data-editable': String(editable) }),
  };
});

vi.mock('./SourceEditor', async () => {
  const React = await import('react');
  return {
    SourceEditor: ({ editable }: { editable: boolean }) =>
      React.createElement('div', { className: 'test-source-editor', 'data-editable': String(editable) }),
  };
});

vi.mock('./TopBar', () => ({ TopBar: () => null }));

vi.mock('./database/DatabaseView', async () => {
  const React = await import('react');
  return {
    DatabaseView: ({ editable }: { editable: boolean }) =>
      React.createElement('div', { className: 'test-database-grid', 'data-editable': String(editable) }),
  };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let nextId = 0;
const newId = () => `managed-page-${++nextId}`;

async function openFixture(files: Record<string, string> = E003_POLARIS_DADOS_FIXTURE) {
  const opened = await WorkspaceSession.open(new VaultRepository(new MemoryVault(files), newId));
  if (!opened.ok) throw new Error(opened.error);
  const session = opened.value;
  setSession(session);
  return session;
}

function renderPage(id: string) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  return {
    container,
    root,
    render: async () => {
      await act(async () => root.render(createElement(PageView, { id, find: null })));
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
  setUi({ sourceMode: null });
});

beforeEach(() => setPreferences({ readingMode: false }));

describe('provider-managed page editing', () => {
  it('recognizes a marked database and its rows, while leaving basic databases and rows native-editable', async () => {
    const managed = await openFixture();
    const managedState = managed.getState();
    const databaseId = Object.keys(managedState.pages).find(
      (id) => managed.pathOf(id as PageId) === 'Inventory.md',
    )! as PageId;
    const database = managedState.pages[databaseId]!;
    const row = Object.values(managedState.pages).find((page) => page.parentId === database.id)!;
    expect(isProviderManagedPage(managedState, database)).toBe(true);
    expect(isProviderManagedPage(managedState, row)).toBe(true);
    const databaseWithoutSchema = { ...database, database: null };
    const missingSchemaState = {
      ...managedState,
      pages: { ...managedState.pages, [database.id]: databaseWithoutSchema },
    };
    expect(isProviderManagedPage(missingSchemaState, row)).toBe(true);
    await managed.close();

    const basicFiles = {
      ...E003_POLARIS_DADOS_FIXTURE,
      'Inventory.md': E003_POLARIS_DADOS_FIXTURE['Inventory.md']!.replace(
        /polarisDados:\n {2}version: 1\n {2}provider: polaris-dados\n/,
        '',
      ),
    };
    const basic = await openFixture(basicFiles);
    const basicState = basic.getState();
    const basicDatabaseId = Object.keys(basicState.pages).find(
      (id) => basic.pathOf(id as PageId) === 'Inventory.md',
    )! as PageId;
    const basicDatabase = basicState.pages[basicDatabaseId]!;
    const basicRow = Object.values(basicState.pages).find((page) => page.parentId === basicDatabase.id)!;
    const basicPageId = Object.keys(basicState.pages).find(
      (id) => basic.pathOf(id as PageId) === 'Archive.md',
    )! as PageId;
    const basicPage = basicState.pages[basicPageId]!;
    expect(isProviderManagedPage(basicState, basicDatabase)).toBe(false);
    expect(isProviderManagedPage(basicState, basicRow)).toBe(false);
    expect(isProviderManagedPage(basicState, { ...basicPage, extra: { polarisDados: { version: 99 } } })).toBe(true);
    expect(basic.unreadable.has(basicPage.id)).toBe(false);
    expect(basic.getState().pages[basicPage.id]?.trashedAt).toBe(null);

    const page = renderPage(basicPage.id);
    try {
      await page.render();
      expect(page.container.querySelector<HTMLTextAreaElement>('.page-title')?.readOnly).toBe(false);
      expect(page.container.querySelector('.test-page-editor')?.getAttribute('data-editable')).toBe('true');
      expect(page.container.querySelector('.add-icon')).not.toBeNull();
    const basicMenuLabels = pageMenuEntries(basicPage.id, () => {}).flatMap((entry) =>
      'label' in entry ? [entry.label] : [],
    );
    expect(basicMenuLabels).toContain(t('pageMenu.rename'));
    expect(basicMenuLabels).toContain(t('pageMenu.addSubpage'));
    expect(basicMenuLabels).toContain(t('pageMenu.duplicate'));
    expect(basicMenuLabels).toContain(t('pageMenu.moveTo'));
    expect(basicMenuLabels).toContain(t('pageMenu.moveToTrash'));
    } finally {
      await page.unmount();
      await basic.close();
    }
  });

  it('keeps a provider database grid editable while its native title and text are readonly', async () => {
    const originalPreferences = getPreferences();
    setPreferences({ readingMode: false });
    const session = await openFixture();
    const databaseId = Object.keys(session.getState().pages).find(
      (id) => session.pathOf(id as PageId) === 'Inventory.md',
    )! as PageId;
    const database = session.getState().pages[databaseId]!;
    const page = renderPage(database.id);
    try {
      await page.render();
      expect(page.container.querySelector<HTMLTextAreaElement>('.page-title')?.readOnly).toBe(true);
      expect(page.container.querySelector('.test-page-editor')?.getAttribute('data-editable')).toBe('false');
      expect(page.container.querySelector('.test-database-grid')?.getAttribute('data-editable')).toBe('true');
    } finally {
      await page.unmount();
      setPreferences({ readingMode: originalPreferences.readingMode });
      await session.close();
    }
  });

  it('renders provider rows readonly across native title, source, body, cover, icon, tags, and page actions', async () => {
    const rowFile = E003_POLARIS_DADOS_FIXTURE['Inventory/Widget.md']!;
    const files = {
      ...E003_POLARIS_DADOS_FIXTURE,
      'Inventory/Widget.md': rowFile.replace(
        'Name: Widget\n',
        'Name: Widget\nicon: 🧪\ncover: gradient-1\ntags: [provider, readonly]\n',
      ),
    };
    const session = await openFixture(files);
    const state = session.getState();
    const row = Object.values(state.pages).find((page) => page.parentId !== null && page.parentId !== undefined && page.title === 'Widget')!;
    setUi({ sourceMode: row.id });
    const page = renderPage(row.id);
    try {
      await page.render();
      expect(page.container.querySelector<HTMLTextAreaElement>('.page-title')?.readOnly).toBe(true);
      expect(page.container.querySelector('.test-page-editor')?.getAttribute('data-editable')).toBe('false');
      expect(page.container.querySelector('.test-source-editor')).toBeNull();
      expect(page.container.querySelector('.page-cover-actions')).toBeNull();
      expect(page.container.querySelector('.add-icon')).toBeNull();
      expect(page.container.querySelector('.page-icon-row button')).toBeNull();
      expect(page.container.querySelector('.page-icon-row [role="img"]')).not.toBeNull();
      expect(page.container.querySelector('.add-tag')).toBeNull();
      expect(page.container.querySelector('.tag-remove')).toBeNull();
      expect(page.container.textContent).toContain('#provider');

      const labels = pageMenuEntries(row.id, () => {})
        .flatMap((entry) => ('label' in entry ? [entry.label] : []));
      expect(labels).not.toContain(t('pageMenu.rename'));
      expect(labels).not.toContain(t('pageMenu.changeIcon'));
      expect(labels).not.toContain(t('pageMenu.editAsMarkdown'));
      expect(labels).not.toContain(t('pageMenu.importMarkdownHere'));
      expect(labels).not.toContain(t('pageMenu.addSubpage'));
      expect(labels).not.toContain(t('pageMenu.duplicate'));
      expect(labels).not.toContain(t('pageMenu.moveTo'));
      expect(labels).not.toContain(t('pageMenu.moveToTrash'));
      expect(labels).toContain(t('pageMenu.pageHistory'));
      expect(labels).toContain(t('pageMenu.openLocalGraph'));
      expect(
        pageMenuEntries(row.id, () => {}, { nativeEditable: true }).flatMap((entry) =>
          'label' in entry ? [entry.label] : [],
        ),
      ).not.toContain(t('pageMenu.rename'));
    } finally {
      await page.unmount();
      await session.close();
    }
  });
});
