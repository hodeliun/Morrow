// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageId } from '../../core/model';
import { MemoryVault } from '../../storage/memoryVault';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';
import { addPluginNoteStylePanel } from '../plugins/registry';
import { setPreferences } from '../platform/preferences';
import { setSession } from '../workspace';
import { PageView } from './PageView';

vi.mock('../editor/PageEditor', () => ({
  PageEditor: ({ editable }: { editable: boolean }) =>
    createElement('div', { 'data-testid': 'page-editor', 'data-editable': String(editable) }),
}));

vi.mock('./Cover', () => ({
  CoverBanner: ({ editable }: { editable: boolean }) =>
    createElement('div', { 'data-testid': 'cover-banner', 'data-editable': String(editable) }),
  CoverPicker: () => null,
}));

vi.mock('./TopBar', () => ({ TopBar: () => null }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let nextId = 0;
let activeSession: WorkspaceSession | null = null;
let cleanupPanel: (() => void) | null = null;

async function open(files: Record<string, string>): Promise<WorkspaceSession> {
  const opened = await WorkspaceSession.open(
    new VaultRepository(new MemoryVault(files), () => `page-view-style-${++nextId}`),
    { delayMs: 0 },
  );
  if (!opened.ok) throw new Error(opened.error);
  activeSession = opened.value;
  setSession(opened.value);
  return opened.value;
}

function pageIdAt(session: WorkspaceSession, path: string): PageId {
  const id = Object.keys(session.getState().pages).find((candidate) => session.pathOf(candidate) === path);
  if (!id) throw new Error(`No page at ${path}`);
  return id;
}

function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  return {
    container,
    render: (value: ReactNode) => act(async () => root.render(value)),
    unmount: () => act(async () => root.unmount()),
  };
}

afterEach(async () => {
  cleanupPanel?.();
  cleanupPanel = null;
  if (activeSession && !activeSession.isClosed) await activeSession.close();
  activeSession = null;
  document.body.replaceChildren();
  window.localStorage.clear();
  setPreferences({ locale: 'en', readingMode: false, defaultNoteStyle: undefined, pageWidths: {} });
  vi.restoreAllMocks();
});

describe('PageView per-page styles on containers', () => {
  it('offers the panel for readable Markdown journal and template containers, but not folder-only pages', async () => {
    const session = await open({
      'Journal.md': '---\nkind: journal\n---\nJournal body.\n',
      'Templates.md': '---\nkind: templates\n---\nTemplates body.\n',
      'Folder only/Child.md': 'Child note.\n',
    });
    const journalId = pageIdAt(session, 'Journal.md');
    const templatesId = pageIdAt(session, 'Templates.md');
    const folderId = pageIdAt(session, 'Folder only');
    setPreferences({ readingMode: false });
    cleanupPanel = addPluginNoteStylePanel('polaris-documento', () => () => {});
    const app = mount();

    try {
      await app.render(
        createElement(
          Fragment,
          null,
          createElement(PageView, { id: journalId, find: null }),
          createElement(PageView, { id: templatesId, find: null }),
          createElement(PageView, { id: folderId, find: null }),
        ),
      );

      expect(app.container.querySelectorAll('[aria-label="Page style"]')).toHaveLength(2);
      expect(session.hasWritableNoteStyleSource(journalId)).toBe(true);
      expect(session.hasWritableNoteStyleSource(templatesId)).toBe(true);
      expect(session.hasWritableNoteStyleSource(folderId)).toBe(false);
    } finally {
      await app.unmount();
      app.container.remove();
    }
  });
});
