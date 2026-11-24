// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageId } from '../../core/model';
import { E003_POLARIS_DADOS_FIXTURE } from '../../storage/fixtures/e003-polaris-dados';
import { MemoryVault } from '../../storage/memoryVault';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';
import { flushPlaces, readingPlace, rememberPlace } from '../readingPlace';
import { PaneContext, PaneTabContext, startTabs } from '../tabs';
import { setSession } from '../workspace';
import { PageView } from './PageView';

const focusTestState = vi.hoisted(() => ({
  focusedTabIds: [] as Array<string | null>,
  restoredTabIds: [] as Array<string | null>,
}));

vi.mock('../editor/PageEditor', async () => {
  const React = await import('react');
  const { PaneTabContext } = await import('../tabs');
  const { Schema } = await import('@tiptap/pm/model');
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { group: 'block', content: 'text*' },
      text: {},
    },
  });

  function makeEditor(tabId: string | null) {
    const doc = schema.node('doc', null, [schema.node('paragraph')]);
    const tr = {
      setSelection() {
        return this;
      },
    };
    return {
      isDestroyed: false,
      state: { doc, tr },
      view: {
        dispatch() {
          focusTestState.restoredTabIds.push(tabId);
        },
        dom: {
          isConnected: true,
          focus() {
            focusTestState.focusedTabIds.push(tabId);
          },
        },
      },
      on() {},
    };
  }

  return {
    PageEditor: function PageEditorMock({
      editable,
      onReady,
    }: {
      editable: boolean;
      onReady: (editor: unknown) => void;
    }) {
      const tabId = React.useContext(PaneTabContext);
      const editor = React.useMemo(() => makeEditor(tabId), [tabId]);
      // The callback is intentionally delivered once, like the editor's ready event.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      React.useEffect(() => onReady(editor), [editor]);
      return React.createElement('div', {
        'data-testid': 'page-editor',
        'data-editable': String(editable),
      });
    },
  };
});

vi.mock('./Cover', async () => {
  const React = await import('react');
  return {
    CoverBanner: ({ editable }: { editable: boolean }) =>
      React.createElement('div', { 'data-testid': 'cover-banner', 'data-editable': String(editable) }),
    CoverPicker: () => null,
  };
});

vi.mock('./database/DatabaseView', async () => {
  const React = await import('react');
  return {
    DatabaseView: ({ editable }: { editable: boolean }) =>
      React.createElement('div', { 'data-testid': 'database-view', 'data-editable': String(editable) }),
  };
});

vi.mock('./TopBar', () => ({ TopBar: () => null }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let nextId = 0;
const newId = () => `page-view-reading-focus-${++nextId}`;

async function openFixture() {
  const opened = await WorkspaceSession.open(
    new VaultRepository(new MemoryVault(E003_POLARIS_DADOS_FIXTURE), newId),
  );
  if (!opened.ok) throw new Error(opened.error);
  setSession(opened.value);
  return opened.value;
}

function pathId(session: WorkspaceSession, path: string): PageId {
  const id = Object.keys(session.getState().pages).find(
    (candidate) => session.pathOf(candidate as PageId) === path,
  );
  if (!id) throw new Error(`No page at ${path}`);
  return id as PageId;
}

function pageInPane(id: PageId, pane: string, tabId: string) {
  return createElement(
    PaneContext.Provider,
    { value: pane },
    createElement(
      PaneTabContext.Provider,
      { value: tabId },
      createElement(
        'section',
        { className: 'pane', 'data-pane-id': pane },
        createElement(PageView, { id, find: null }),
      ),
    ),
  );
}

afterEach(() => {
  document.body.replaceChildren();
  flushPlaces();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  focusTestState.focusedTabIds.length = 0;
  focusTestState.restoredTabIds.length = 0;
});

describe('startup reading focus interaction guard', () => {
  it('keeps wheel input in pane A and restores pane B without taking DOM focus', async () => {
    const session = await openFixture();
    const id = pathId(session, 'Archive.md');
    rememberPlace(id, { scroll: 111, from: 1, to: 1 });
    rememberPlace(`${id}@side` as PageId, { scroll: 222, from: 1, to: 1 });

    const tabs = await import('../tabs');
    vi.spyOn(tabs, 'targetPane').mockReturnValue('pane-b');
    vi.spyOn(tabs, 'paneAssignments').mockReturnValue([
      { role: 'main', paneId: 'pane-a', tabId: 'instance-a' },
      { role: 'side', paneId: 'pane-b', tabId: 'instance-b' },
    ]);
    vi.spyOn(tabs, 'isSideTabInstance').mockImplementation((tabId) => tabId === 'instance-b');
    vi.spyOn(tabs, 'routeHashForTabId').mockReturnValue(`#/page/${encodeURIComponent(id)}`);
    const stopTabs = startTabs();

    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const activeBefore = document.activeElement;
    try {
      await act(async () =>
        root.render(
          createElement(
            Fragment,
            null,
            pageInPane(id, 'pane-a', 'instance-a'),
            pageInPane(id, 'pane-b', 'instance-b'),
          ),
        ),
      );
      const panes = container.querySelectorAll<HTMLElement>('.pane');
      const scrollers = container.querySelectorAll<HTMLElement>('.page-scroll');
      expect(panes).toHaveLength(2);
      expect(scrollers).toHaveLength(2);

      panes[0]!.dispatchEvent(new Event('wheel', { bubbles: true }));
      scrollers[0]!.scrollTop = 333;
      scrollers[0]!.dispatchEvent(new Event('scroll', { bubbles: true }));
      await act(async () => {
        let steps = 0;
        while (frames.length > 0 && steps++ < 30) frames.shift()?.(0);
      });

      expect(scrollers[0]?.scrollTop).toBe(333);
      expect(scrollers[1]?.scrollTop).toBe(222);
      expect(readingPlace(id)?.scroll).toBe(333);
      expect(focusTestState.restoredTabIds).toEqual(['instance-b']);
      expect(focusTestState.focusedTabIds).toEqual([]);
      expect(document.activeElement).toBe(activeBefore);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      stopTabs();
      await session.close();
    }
  });
});
