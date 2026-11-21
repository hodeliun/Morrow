// @vitest-environment happy-dom
import type { Editor } from '@tiptap/core';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageId } from '../../core/model';
import { MemoryVault } from '../../storage/memoryVault';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';
import { createDataApi } from '../plugins/dataApi';
import { registerDatabaseProvider } from '../plugins/providerRegistry';
import { getPreferences, setPreferences } from '../platform/preferences';
import { setSession } from '../workspace';
import { EmbeddedDatabase } from '../components/database/EmbeddedDatabase';
import { PageEditor } from './PageEditor';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const DATABASE_ID = 'native-library' as PageId;
const ROW_ID = 'native-library-row' as PageId;
const NOTE_ID = 'native-embeds-note' as PageId;
const DATABASE_PATH = 'Library.md';
const ROW_PATH = 'Library/Alpha.md';
const NOTE_PATH = 'Embeds.md';
const originalPreferences = getPreferences();
let nextId = 0;
const newId = () => `native-embed-test-${++nextId}`;
const providerCleanups = new Set<() => void>();

async function drainDeferredUnmounts() {
  await act(async () => {
    // PageEditor defers Tiptap destruction, which then defers each live embed root's unmount.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function files(optedIn = false): Record<string, string> {
  const database = [
    '---',
    'kind: database',
    ...(optedIn ? ['polarisDados:', '  version: 1', '  provider: polaris-dados'] : []),
    'database:',
    '  properties:',
    '    - id: name',
    '      name: Name',
    '      type: text',
    '    - id: status',
    '      name: Status',
    '      type: select',
    '      options:',
    '        - id: active',
    '          name: Active',
    '          color: green',
    '    - id: date',
    '      name: Date',
    '      type: date',
    '  views:',
    '    - id: board-view',
    '      name: Board',
    '      type: board',
    '      groupBy: status',
    '    - id: table-view',
    '      name: Table',
    '      type: table',
    '      columns: [name, status]',
    '    - id: calendar-view',
    '      name: Calendar',
    '      type: calendar',
    '      dateProp: date',
    '---',
    '# Library',
    ...(optedIn ? ['', '# Table', 'Static section for the Table view.'] : []),
    '',
  ].join('\n');
  return {
    [DATABASE_PATH]: database,
    [ROW_PATH]: '---\nName: Alpha\nStatus: Active\nDate: 2026-11-21\n---\n',
    [NOTE_PATH]: optedIn
      ? '![[Library#Table]]\n\n![[Library]]\n'
      : '![[Library#Board]]\n\n![[Library#Calendar]]\n',
    '.morrow/workspace.json': JSON.stringify({
      version: 1,
      pages: {
        [DATABASE_PATH]: { id: DATABASE_ID, created: 1, order: 0 },
        [ROW_PATH]: { id: ROW_ID, created: 2, order: 0 },
        [NOTE_PATH]: { id: NOTE_ID, created: 3, order: 1 },
      },
    }),
    '.morrow/recent.json': JSON.stringify({ version: 1, opened: {}, activity: {} }),
  };
}

const sessions = new Set<WorkspaceSession>();
const roots = new Set<ReturnType<typeof createRoot>>();
const containers = new Set<HTMLElement>();

async function openWorkspace(optedIn = false) {
  const vault = new MemoryVault(files(optedIn));
  const opened = await WorkspaceSession.open(new VaultRepository(vault, newId), { delayMs: 60_000 });
  if (!opened.ok) throw new Error(opened.error);
  const session = opened.value;
  sessions.add(session);
  setSession(session);
  return { session, vault };
}

function mountPageEditor(session: WorkspaceSession) {
  const container = document.createElement('div');
  document.body.append(container);
  containers.add(container);
  const root = createRoot(container);
  roots.add(root);
  let editor: Editor | null = null;

  const render = async (editable = true) => {
    const doc = session.getState().docs[NOTE_ID];
    if (!doc) throw new Error('The synthetic embed note is missing.');
    await act(async () => {
      root.render(
        createElement(PageEditor, {
          pageId: NOTE_ID,
          doc,
          editable,
          find: null,
          onExitTop: () => {},
          onDirty: () => {},
          onReady: (instance) => {
            editor = instance;
          },
        }),
      );
    });
  };

  return {
    container,
    render,
    get editor() {
      return editor;
    },
  };
}

afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots.clear();
  await drainDeferredUnmounts();
  for (const cleanup of providerCleanups) cleanup();
  providerCleanups.clear();
  for (const session of sessions) if (!session.isClosed) await session.close();
  sessions.clear();
  setPreferences({ locale: originalPreferences.locale, readingMode: originalPreferences.readingMode });
  for (const container of containers) container.remove();
  containers.clear();
  document.body.replaceChildren();
});

function embedTabs(element: Element): string[] {
  return [...element.querySelectorAll('.db-tab')].map((tab) => tab.textContent?.trim() ?? '');
}

function linkAnchors(editor: Editor): Array<string | null> {
  const anchors: Array<string | null> = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'pageLink' && node.attrs.embed === true)
      anchors.push(typeof node.attrs.anchor === 'string' ? node.attrs.anchor : null);
  });
  return anchors;
}

function registerSyntheticProvider(session: WorkspaceSession, onMount: (editable: boolean) => void) {
  let ownerActive = true;
  let disposeDataApi = () => {};
  const data = createDataApi({
    session,
    ownerIsActive: () => ownerActive,
    isProviderActive: () => ownerActive,
    isHostReadonly: () => false,
    registerCleanup: (cleanup) => {
      disposeDataApi = cleanup;
    },
  });
  const unregister = registerDatabaseProvider('native-database-embed-test', () => ownerActive, data, {
    id: 'polaris-dados',
    apiVersion: 1,
    mount: ({ element, editable }) => {
      onMount(editable);
      const marker = document.createElement('span');
      marker.className = 'synthetic-provider-mount';
      marker.textContent = 'Synthetic live provider';
      element.append(marker);
      return () => marker.remove();
    },
  });
  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    ownerActive = false;
    unregister();
    disposeDataApi();
  };
  providerCleanups.add(cleanup);
  return cleanup;
}

describe('native database embeds in PageEditor', () => {
  it('shows the named native view and scopes picker changes to that PageLink without writing on mount', async () => {
    const { session, vault } = await openWorkspace();
    const writes = vi.spyOn(vault, 'apply');
    const harness = mountPageEditor(session);
    await harness.render();

    const embeds = [...harness.container.querySelectorAll('.page-embed')];
    expect(embeds).toHaveLength(2);
    expect(embedTabs(embeds[0]!)).toEqual(['Board']);
    expect(embedTabs(embeds[1]!)).toEqual(['Calendar']);
    const pickers = [...harness.container.querySelectorAll<HTMLSelectElement>('.inline-database-view')];
    expect(pickers.map((picker) => picker.value)).toEqual(['board-view', 'calendar-view']);
    expect(writes).not.toHaveBeenCalled();

    await act(async () => {
      pickers[0]!.value = 'table-view';
      pickers[0]!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(linkAnchors(harness.editor!)).toEqual(['Table', 'Calendar']);
    expect(embedTabs(embeds[0]!)).toEqual(['Table']);
    expect(embedTabs(embeds[1]!)).toEqual(['Calendar']);
  });

  it.each(['unreadable', 'trashed'] as const)(
    'keeps the native embed read only when its source is %s',
    async (sourceState) => {
      const { session, vault } = await openWorkspace();
      if (sourceState === 'unreadable') {
        session.unreadable.add(DATABASE_ID);
      } else {
        const page = session.getState().pages[DATABASE_ID]!;
        const accepted = session.applyExternal({
          pages: [{ ...page, trashedAt: 10 }],
          docs: {},
          removed: [],
          unreadable: [],
          readable: [],
        });
        expect(accepted).toContain(DATABASE_ID);
      }
      const writes = vi.spyOn(vault, 'apply');
      const onPickView = vi.fn();
      const container = document.createElement('div');
      document.body.append(container);
      containers.add(container);
      const root = createRoot(container);
      roots.add(root);

      await act(async () => {
        root.render(
          createElement(EmbeddedDatabase, {
            pageId: DATABASE_ID,
            editable: true,
            viewId: 'board-view',
            onPickView,
          }),
        );
      });

      expect(container.querySelector('.inline-database-view')).toBeNull();
      expect(embedTabs(container)).toEqual(['Board']);
      expect(container.querySelector('.db-tab[draggable="true"]')).toBeNull();
      expect(container.querySelector('.db-new-row')).toBeNull();
      expect(onPickView).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
    },
  );

  it('does not mount an opted-in provider through a native view anchor, while keeping its unanchored embed live', async () => {
    const { session, vault } = await openWorkspace(true);
    const writes = vi.spyOn(vault, 'apply');
    const providerEditability: boolean[] = [];
    registerSyntheticProvider(session, (editable) => providerEditability.push(editable));
    const harness = mountPageEditor(session);
    await harness.render();

    const embeds = [...harness.container.querySelectorAll('.page-embed')];
    expect(embeds).toHaveLength(2);
    expect(embeds[0]!.classList.contains('is-live')).toBe(false);
    expect(embeds[0]!.querySelector('.synthetic-provider-mount')).toBeNull();
    expect(
      embeds[0]!.querySelector('.database-provider-root, .provider-fallback, .db-bar, .inline-database-view'),
    ).toBeNull();
    expect(embeds[0]!.textContent).toContain('Static section for the Table view.');

    expect(embeds[1]!.classList.contains('is-live')).toBe(true);
    expect(embeds[1]!.querySelector('.synthetic-provider-mount')?.textContent).toBe(
      'Synthetic live provider',
    );
    expect(embeds[1]!.querySelector('.inline-database-view, .db-bar')).toBeNull();
    expect(providerEditability).toEqual([true]);
    expect(writes).not.toHaveBeenCalled();
  });
});
