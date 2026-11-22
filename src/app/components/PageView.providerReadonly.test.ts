// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageId } from '../../core/model';
import { E003_POLARIS_DADOS_FIXTURE } from '../../storage/fixtures/e003-polaris-dados';
import { MemoryVault } from '../../storage/memoryVault';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';
import { setPreferences } from '../platform/preferences';
import { flushPlaces, readingPlace } from '../readingPlace';
import { PaneContext } from '../tabs';
import { setSession } from '../workspace';
import { PageView } from './PageView';

vi.mock('../editor/PageEditor', async () => {
  const React = await import('react');
  const { Schema } = await import('@tiptap/pm/model');
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { group: 'block', content: 'text*' },
      text: {},
    },
  });

  function makeEditor() {
    const doc = schema.node('doc', null, [schema.node('paragraph')]);
    const tr = {
      setSelection() {
        return this;
      },
    };
    return {
      isDestroyed: false,
      state: { doc, tr },
      view: { dispatch() {}, dom: { focus() {} } },
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
      const editor = React.useMemo(makeEditor, []);
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
const newId = () => `page-view-provider-${++nextId}`;

async function openFixture(files: Record<string, string> = E003_POLARIS_DADOS_FIXTURE) {
  const opened = await WorkspaceSession.open(new VaultRepository(new MemoryVault(files), newId));
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

function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  return { container, root, render: (value: ReactNode) => root.render(value) };
}

function pageInPane(id: PageId, pane: 'main' | 'side') {
  return createElement(PaneContext.Provider, { value: pane }, createElement(PageView, { id, find: null }));
}

afterEach(() => {
  document.body.replaceChildren();
  flushPlaces();
  window.localStorage.clear();
  setPreferences({
    expanded: [],
    readingMode: false,
    outlines: false,
    hiddenOutlines: [],
    shownOutlines: [],
    subpagesSection: 'hidden',
    backlinksSection: 'hidden',
    mentionsButton: false,
  });
  vi.unstubAllGlobals();
});

describe('provider-managed PageView boundaries', () => {
  it('restores the same page independently in each split and stops restoring after user input', async () => {
    const session = await openFixture();
    const id = pathId(session, 'Archive.md');
    window.localStorage.setItem(
      'morrow.readingPlaces',
      JSON.stringify({
        [id]: { scroll: 111, from: 1, to: 1 },
        [`${id}@side`]: { scroll: 222, from: 1, to: 1 },
      }),
    );

    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });

    const { container, root } = mount();
    try {
      await act(async () =>
        root.render(createElement(Fragment, null, pageInPane(id, 'main'), pageInPane(id, 'side'))),
      );
      const scrollers = container.querySelectorAll<HTMLElement>('.page-scroll');
      expect(scrollers).toHaveLength(2);

      // Advance the ready callbacks and restore frames until each side has its own saved position.
      await act(async () => {
        let steps = 0;
        while (
          (scrollers[0]?.scrollTop !== 111 || scrollers[1]?.scrollTop !== 222) &&
          frames.length > 0 &&
          steps++ < 20
        )
          frames.shift()?.(0);
      });
      expect(scrollers[0]?.scrollTop).toBe(111);
      expect(scrollers[1]?.scrollTop).toBe(222);

      scrollers[0]!.dispatchEvent(new Event('wheel', { bubbles: true }));
      scrollers[0]!.scrollTop = 333;
      scrollers[0]!.dispatchEvent(new Event('scroll', { bubbles: true }));

      await act(async () => {
        let steps = 0;
        while (frames.length > 0 && steps++ < 100) frames.shift()?.(0);
      });

      scrollers[1]!.scrollTop = 444;
      scrollers[1]!.dispatchEvent(new Event('scroll', { bubbles: true }));
      expect(scrollers[0]?.scrollTop).toBe(333);
      expect(scrollers[1]?.scrollTop).toBe(444);
      expect(readingPlace(id)?.scroll).toBe(333);
      expect(readingPlace(`${id}@side` as PageId)?.scroll).toBe(444);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      await session.close();
    }
  });

  it('keeps provider-owned page editing native-read-only while preserving database editability gates', async () => {
    const session = await openFixture();
    const rowId = pathId(session, 'Inventory/Widget.md');
    const databaseId = pathId(session, 'Inventory.md');
    setPreferences({
      readingMode: false,
      outlines: false,
      subpagesSection: 'hidden',
      backlinksSection: 'hidden',
      mentionsButton: false,
    });

    const { container, root, render } = mount();
    try {
      await act(async () => root.render(pageInPane(rowId, 'main')));
      expect(container.querySelector<HTMLTextAreaElement>('.page-title')?.readOnly).toBe(true);
      expect(container.querySelector('[data-testid="page-editor"]')?.getAttribute('data-editable')).toBe(
        'false',
      );
      expect(container.querySelector('[data-testid="cover-banner"]')?.getAttribute('data-editable')).toBe(
        'false',
      );

      await act(async () => render(pageInPane(databaseId, 'main')));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      expect(container.querySelector<HTMLTextAreaElement>('.page-title')?.readOnly).toBe(true);
      expect(container.querySelector('[data-testid="database-view"]')?.getAttribute('data-editable')).toBe(
        'true',
      );

      setPreferences({ readingMode: true });
      await act(async () => Promise.resolve());
      expect(container.querySelector('[data-testid="database-view"]')?.getAttribute('data-editable')).toBe(
        'false',
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
      await session.close();
    }
  });

  it('projects each note style onto its own split article and leaves unstyled notes on native preferences', async () => {
    const session = await openFixture({
      ...E003_POLARIS_DADOS_FIXTURE,
      'Styles/Serif.md': `---\nmorrowNoteStyle:\n  font: serif\n  fontSize: 19\n  lineHeight: 1.8\n  blockSpacing: 12\n  width: comfortable\n---\nSerif body\n`,
      'Styles/Mono.md': `---\nmorrowNoteStyle:\n  font: mono\n  fontSize: 14.5\n  lineHeight: 1.75\n  blockSpacing: 8\n  width: full\n---\nMono body\n`,
      'Styles/Native.md': '---\ntitle: Native\n---\nNative body\n',
    });
    const serifId = pathId(session, 'Styles/Serif.md');
    const monoId = pathId(session, 'Styles/Mono.md');
    const nativeId = pathId(session, 'Styles/Native.md');
    setPreferences({ font: 'sans', width: 'wide' });

    const { container, root, render } = mount();
    try {
      await act(async () =>
        root.render(createElement(Fragment, null, pageInPane(serifId, 'main'), pageInPane(monoId, 'side'))),
      );
      const serif = container.querySelector<HTMLElement>(`.page[data-polaris-note-page-id="${serifId}"]`)!;
      const mono = container.querySelector<HTMLElement>(`.page[data-polaris-note-page-id="${monoId}"]`)!;
      expect(serif.getAttribute('data-polaris-note-style')).toBe('saved');
      expect(serif.matches('[data-page-id]')).toBe(false);
      expect(serif.closest('[data-page-id]')).toBeNull();
      expect(serif.getAttribute('data-polaris-note-font')).toBe('serif');
      expect(serif.getAttribute('data-polaris-note-width')).toBe('comfortable');
      expect(serif.style.getPropertyValue('--polaris-note-font-size')).toBe('19px');
      expect(serif.style.getPropertyValue('--polaris-note-line-height')).toBe('1.8');
      expect(serif.style.getPropertyValue('--polaris-note-block-spacing')).toBe('12px');
      expect(mono.getAttribute('data-polaris-note-page-id')).toBe(monoId);
      expect(mono.getAttribute('data-polaris-note-font')).toBe('mono');
      expect(mono.getAttribute('data-polaris-note-width')).toBe('full');
      expect(mono.style.getPropertyValue('--polaris-note-font-size')).toBe('14.5px');

      await act(async () => render(pageInPane(nativeId, 'main')));
      const nativePage = container.querySelector<HTMLElement>(
        `.page[data-polaris-note-page-id="${nativeId}"]`,
      )!;
      expect(nativePage.matches('[data-page-id]')).toBe(false);
      expect(nativePage.closest('[data-page-id]')).toBeNull();
      expect(nativePage.classList).toContain('font-sans');
      expect(nativePage.classList).toContain('width-wide');
      expect(nativePage.hasAttribute('data-polaris-note-style')).toBe(false);
      expect(nativePage.style.getPropertyValue('--polaris-note-font-size')).toBe('');
    } finally {
      await act(async () => root.unmount());
      container.remove();
      await session.close();
    }
  });
});
