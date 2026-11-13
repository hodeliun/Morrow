// @vitest-environment happy-dom
import type { Editor } from '@tiptap/core';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocNode, PageId } from '../../core/model';
import { encodePolarisDadosViewMarker } from '../../core/polarisDadosView';
import type { PolarisDadosViewData } from '../../core/polarisDadosView';
import { docToMarkdown } from '../../core/markdown/serialize';
import { MemoryVault } from '../../storage/memoryVault';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';
import { getPreferences, setPreferences } from '../platform/preferences';
import { captureEditorInsertionTarget } from './editorInsertion';
import type { EditorInsertionOwner } from './editorInsertion';
import { commitEditors, focusedEditor } from './commits';
import { PageEditor } from './PageEditor';
import { navigate } from '../router';
import { PaneContext, closeSide, openSide, setActivePane, startTabs } from '../tabs';
import { setSession } from '../workspace';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const NOTE_PATH = 'Note.md';
const SOURCE_ID = 'synthetic-source';
const existingView: PolarisDadosViewData = {
  version: 1,
  viewId: 'existing-view',
  sourceDatabaseId: SOURCE_ID,
  title: 'Existing synthetic view',
  columnOrder: ['quantity'],
  filter: null,
};
const insertView: PolarisDadosViewData = {
  version: 1,
  viewId: 'explicitly-inserted-view',
  sourceDatabaseId: SOURCE_ID,
  title: 'Explicitly inserted view',
  columnOrder: ['quantity'],
  filter: null,
};

const paragraph = (text: string): DocNode => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

function noteDoc(text: string, withExistingView = false): DocNode {
  return {
    type: 'doc',
    content: [
      paragraph(text),
      ...(withExistingView ? [{ type: 'polarisDadosView' as const, attrs: existingView }] : []),
    ],
  };
}

let idCounter = 0;

async function openWorkspace(
  options: {
    readonly pageId?: PageId;
    readonly text?: string;
    readonly withExistingView?: boolean;
    readonly makeCurrent?: boolean;
  } = {},
) {
  const pageId = options.pageId ?? `insertion-note-${++idCounter}`;
  const initial = noteDoc(options.text ?? 'north middle south', options.withExistingView);
  const vault = new MemoryVault({
    [NOTE_PATH]: docToMarkdown(initial),
    '.morrow/workspace.json': JSON.stringify({
      version: 1,
      pages: { [NOTE_PATH]: { id: pageId, created: 1, order: 0 } },
    }),
    '.morrow/recent.json': JSON.stringify({ version: 1, opened: {}, activity: {} }),
  });
  let generatedId = 0;
  const opened = await WorkspaceSession.open(
    new VaultRepository(vault, () => `unexpected-generated-page-${++generatedId}`),
    { delayMs: 60_000 },
  );
  if (!opened.ok) throw new Error(opened.error);
  const session = opened.value;
  if (options.makeCurrent !== false) setSession(session);
  sessions.add(session);
  return { pageId, session, vault, initialDoc: session.getState().docs[pageId]! };
}

interface PageEditorHarness {
  readonly container: HTMLElement;
  readonly editor: Editor | null;
  render(options?: { readonly editable?: boolean; readonly pane?: 'main' | 'side' }): Promise<void>;
  unmount(): Promise<void>;
}

function mountPageEditor(session: WorkspaceSession, pageId: PageId): PageEditorHarness {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let current: { editable: boolean; pane: 'main' | 'side' } = { editable: true, pane: 'main' };
  let editor: Editor | null = null;
  let disposed = false;

  const render = async (
    options: { readonly editable?: boolean; readonly pane?: 'main' | 'side' } = {},
  ): Promise<void> => {
    current = { ...current, ...options };
    await act(async () => {
      root.render(
        createElement(
          PaneContext.Provider,
          { value: current.pane },
          createElement(PageEditor, {
            pageId,
            doc: session.getState().docs[pageId]!,
            editable: current.editable,
            find: null,
            onExitTop: () => {},
            onDirty: () => {},
            onReady: (readyEditor: Editor) => {
              editor = readyEditor;
            },
          }),
        ),
      );
    });
  };

  const unmount = async (): Promise<void> => {
    if (disposed) return;
    await act(async () => root.unmount());
    container.remove();
    disposed = true;
  };

  const harness: PageEditorHarness = {
    container,
    get editor() {
      return editor;
    },
    render,
    unmount,
  };
  harnesses.add(harness);
  return harness;
}

interface TestOwner extends EditorInsertionOwner {
  setActive(active: boolean): void;
  reload(): void;
}

function testOwner(): TestOwner {
  let active = true;
  let generation = 1;
  return {
    get generation() {
      return generation;
    },
    isActive: () => active,
    setActive(next) {
      active = next;
    },
    reload() {
      active = true;
      generation++;
    },
  };
}

type InsertionHandle = NonNullable<ReturnType<typeof captureEditorInsertionTarget>>;

function capture(owner: EditorInsertionOwner, editor: Editor): InsertionHandle {
  if (focusedEditor() !== editor) throw new Error('The expected PageEditor peer is not focused.');
  const handle = captureEditorInsertionTarget(owner);
  if (!handle) throw new Error('The active PageEditor peer did not produce an insertion target.');
  handles.add(handle);
  return handle;
}

async function focusEditor(editor: Editor): Promise<void> {
  await act(async () => {
    editor.commands.focus();
  });
  expect(focusedEditor()).toBe(editor);
}

function cursorInside(editor: Editor, text: string, needle: string, offset = 1): number {
  let position: number | null = null;
  editor.state.doc.descendants((node, nodePos) => {
    if (!node.isText || !node.text) return true;
    const index = node.text.indexOf(needle);
    if (index < 0) return true;
    position = nodePos + index + Math.min(offset, needle.length - 1);
    return false;
  });
  if (position === null)
    throw new Error(`Could not locate ${JSON.stringify(needle)} in ${JSON.stringify(text)}.`);
  return position;
}

async function selectCursor(editor: Editor, text: string, needle: string, offset = 1): Promise<number> {
  const position = cursorInside(editor, text, needle, offset);
  await act(async () => {
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, position)));
  });
  return position;
}

function setMainRoute(pageId: PageId): void {
  closeSide();
  setActivePane('main');
  navigate({ name: 'page', id: pageId, find: null }, { replace: true, pane: 'main' });
}

function docText(editor: Editor): string {
  return editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n');
}

function viewIds(editor: Editor): string[] {
  const ids: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'polarisDadosView' && typeof node.attrs.viewId === 'string')
      ids.push(node.attrs.viewId);
  });
  return ids;
}

function waitForHashChanges(count: number): Promise<HashChangeEvent[]> {
  return new Promise((resolve) => {
    const events: HashChangeEvent[] = [];
    const onHashChange = (event: HashChangeEvent): void => {
      events.push(event);
      if (events.length < count) return;
      window.removeEventListener('hashchange', onHashChange);
      resolve(events);
    };
    window.addEventListener('hashchange', onHashChange);
  });
}

const sessions = new Set<WorkspaceSession>();
const harnesses = new Set<PageEditorHarness>();
const handles = new Set<InsertionHandle>();
const stopTabListeners = new Set<() => void>();
let preferencesBeforeTest = getPreferences();

beforeEach(() => {
  preferencesBeforeTest = getPreferences();
  setPreferences({ locale: 'en', readingMode: false });
  stopTabListeners.add(startTabs());
});

afterEach(async () => {
  for (const handle of [...handles]) {
    handle.dispose();
    handles.delete(handle);
  }
  for (const harness of [...harnesses]) {
    await harness.unmount();
    harnesses.delete(harness);
  }
  // PageEditor destroys Tiptap on the next task after React removes its menus.
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const session of [...sessions]) {
    if (!session.isClosed) await session.close();
    sessions.delete(session);
  }
  closeSide();
  setActivePane('main');
  for (const stop of [...stopTabListeners]) {
    stop();
    stopTabListeners.delete(stop);
  }
  setPreferences({ locale: preferencesBeforeTest.locale, readingMode: preferencesBeforeTest.readingMode });
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('independent editor insertion capture', () => {
  it('keeps the captured selection across picker blur and inserts only when explicitly requested', async () => {
    const { pageId, session, vault, initialDoc } = await openWorkspace();
    setMainRoute(pageId);
    const writes = vi.spyOn(vault, 'apply');
    const harness = mountPageEditor(session, pageId);
    await harness.render();
    const editor = harness.editor;
    if (!editor) throw new Error('PageEditor did not mount.');
    await focusEditor(editor);
    const capturedCursor = await selectCursor(editor, 'north middle south', 'middle', 2);

    const owner = testOwner();
    const target = capture(owner, editor);
    expect(target.version).toBe(1);
    expect(viewIds(editor)).toEqual([]);
    expect(session.getState().docs[pageId]).toEqual(initialDoc);
    expect(writes).not.toHaveBeenCalled();

    const picker = document.createElement('button');
    picker.type = 'button';
    picker.textContent = 'Synthetic picker';
    harness.container.append(picker);
    picker.focus();
    expect(document.activeElement).toBe(picker);

    let inserted: ReturnType<InsertionHandle['insert']> | undefined;
    await act(async () => {
      inserted = target.insert(`\n${encodePolarisDadosViewMarker(insertView)}\n`);
    });
    expect(inserted).toEqual({ ok: true });
    expect(viewIds(editor)).toEqual([insertView.viewId]);
    const markerPosition = (() => {
      let position: number | null = null;
      editor.state.doc.descendants((node, nodePos) => {
        if (node.type.name === 'polarisDadosView') {
          position = nodePos;
          return false;
        }
        return true;
      });
      return position;
    })();
    expect(markerPosition).not.toBeNull();
    const beforeMarker = editor.state.doc.textBetween(0, markerPosition!, '\n');
    const marker = editor.state.doc.nodeAt(markerPosition!)!;
    const afterMarker = editor.state.doc.textBetween(
      markerPosition! + marker.nodeSize,
      editor.state.doc.content.size,
      '\n',
    );
    expect(beforeMarker.replace(/\s/g, '')).toContain('northmi');
    expect(afterMarker.replace(/\s/g, '')).toContain('ddlesouth');
    expect(capturedCursor).toBeGreaterThan(0);
    expect(docText(editor).replace(/\s/g, '')).toContain('northmiddlesouth');
    const afterInsert = editor.state.doc.toJSON();
    expect(target.insert('must not insert twice')).toMatchObject({ ok: false });
    expect(editor.state.doc.toJSON()).toEqual(afterInsert);

    await act(async () => {
      expect(commitEditors()).toBe(true);
      expect(await session.flush()).toBe(true);
    });
    expect(writes).toHaveBeenCalled();
    expect(vault.text(NOTE_PATH)).toContain(encodePolarisDadosViewMarker(insertView));

    await act(async () => {
      expect(editor.commands.undo()).toBe(true);
    });
    expect(docToMarkdown(editor.state.doc.toJSON() as DocNode)).toBe(docToMarkdown(initialDoc));
    await act(async () => {
      expect(commitEditors()).toBe(true);
      expect(await session.flush()).toBe(true);
    });
    expect(docToMarkdown(session.getState().docs[pageId]!)).toBe(docToMarkdown(initialDoc));
    expect(viewIds(editor)).toEqual([]);
  });

  it('permanently invalidates after selection drift or a document edit that is undone', async () => {
    const { pageId, session, vault } = await openWorkspace();
    setMainRoute(pageId);
    const writes = vi.spyOn(vault, 'apply');
    const harness = mountPageEditor(session, pageId);
    await harness.render();
    const editor = harness.editor;
    if (!editor) throw new Error('PageEditor did not mount.');
    await focusEditor(editor);
    const originalDoc = editor.state.doc.toJSON();
    const originalSelection = await selectCursor(editor, 'north middle south', 'middle', 2);
    const owner = testOwner();

    const selectionTarget = capture(owner, editor);
    await act(async () => {
      editor.view.dispatch(
        editor.state.tr.setSelection(TextSelection.create(editor.state.doc, originalSelection + 2)),
      );
      editor.view.dispatch(
        editor.state.tr.setSelection(TextSelection.create(editor.state.doc, originalSelection)),
      );
    });
    expect(editor.state.selection.from).toBe(originalSelection);
    expect(selectionTarget.insert('stale selection')).toMatchObject({ ok: false });
    expect(editor.state.doc.toJSON()).toEqual(originalDoc);

    const documentTarget = capture(owner, editor);
    await act(async () => {
      expect(editor.commands.insertContent('temporary edit')).toBe(true);
      expect(editor.commands.undo()).toBe(true);
    });
    expect(editor.state.doc.toJSON()).toEqual(originalDoc);
    expect(documentTarget.insert('stale document')).toMatchObject({ ok: false });
    expect(editor.state.doc.toJSON()).toEqual(originalDoc);
    expect(docToMarkdown(session.getState().docs[pageId]!)).toBe(docToMarkdown(originalDoc as DocNode));
    expect(writes).not.toHaveBeenCalled();
  });

  it('invalidates on panel and navigation changes even after returning without focusing another editor', async () => {
    const { pageId, session, vault } = await openWorkspace();
    setMainRoute(pageId);
    const writes = vi.spyOn(vault, 'apply');
    const harness = mountPageEditor(session, pageId);
    await harness.render({ pane: 'main' });
    const editor = harness.editor;
    if (!editor) throw new Error('PageEditor did not mount.');
    await focusEditor(editor);
    const owner = testOwner();

    const panelTarget = capture(owner, editor);
    await act(async () => {
      openSide('#/page/synthetic-side-target');
      closeSide();
    });
    expect(focusedEditor()).toBe(editor);
    expect(panelTarget.insert('stale panel target')).toMatchObject({ ok: false });
    expect(docText(editor)).toBe('north middle south');

    const mainPaneTarget = capture(owner, editor);
    await act(async () => openSide(`#/page/${encodeURIComponent(pageId)}`));
    await harness.render({ pane: 'side' });
    const sideEditor = harness.editor;
    if (!sideEditor) throw new Error('PageEditor did not remain available in the side pane.');
    await focusEditor(sideEditor);
    expect(mainPaneTarget.insert('stale main pane target')).toMatchObject({ ok: false });
    const sidePaneTarget = capture(owner, sideEditor);

    await act(async () => closeSide());
    await harness.render({ pane: 'main' });
    const returnedEditor = harness.editor;
    if (!returnedEditor) throw new Error('PageEditor did not remain available in the main pane.');
    await focusEditor(returnedEditor);
    expect(sidePaneTarget.insert('stale side pane target')).toMatchObject({ ok: false });
    sidePaneTarget.dispose();

    const navigationTarget = capture(owner, returnedEditor);
    const capturedRoute = window.location.hash;
    await act(async () => {
      const hashChanges = waitForHashChanges(2);
      window.location.hash = '#/tasks';
      window.location.hash = capturedRoute;
      const [leaveEvent, returnEvent] = await hashChanges;
      if (!leaveEvent || !returnEvent) throw new Error('Expected both hash navigation events.');
      expect(new URL(leaveEvent.oldURL).hash).toBe(capturedRoute);
      expect(new URL(leaveEvent.newURL).hash).toBe('#/tasks');
      expect(new URL(returnEvent.oldURL).hash).toBe('#/tasks');
      expect(new URL(returnEvent.newURL).hash).toBe(capturedRoute);
    });
    expect(focusedEditor()).toBe(returnedEditor);
    expect(navigationTarget.insert('stale navigation target')).toMatchObject({ ok: false });
    expect(docText(returnedEditor)).toBe('north middle south');
    expect(docToMarkdown(session.getState().docs[pageId]!)).toBe(
      docToMarkdown(returnedEditor.state.doc.toJSON() as DocNode),
    );
    expect(writes).not.toHaveBeenCalled();
  });

  it('rejects readonly and unmounted targets, then requires a fresh capture after editability returns', async () => {
    const { pageId, session, vault } = await openWorkspace();
    setMainRoute(pageId);
    const writes = vi.spyOn(vault, 'apply');
    const harness = mountPageEditor(session, pageId);
    await harness.render();
    const editor = harness.editor;
    if (!editor) throw new Error('PageEditor did not mount.');
    await focusEditor(editor);
    const owner = testOwner();
    const beforeReadonly = capture(owner, editor);

    await harness.render({ editable: false });
    expect(beforeReadonly.insert('readonly insertion')).toMatchObject({ ok: false });
    expect(editor.state.doc.textContent).toBe('north middle south');

    await harness.render({ editable: true });
    await focusEditor(editor);
    expect(beforeReadonly.insert('old capture after readonly')).toMatchObject({ ok: false });

    const beforeReadingMode = capture(owner, editor);
    await act(async () => setPreferences({ readingMode: true }));
    expect(beforeReadingMode.insert('reading-mode insertion')).toMatchObject({ ok: false });
    await act(async () => setPreferences({ readingMode: false }));
    await focusEditor(editor);

    const beforeUnmount = capture(owner, editor);
    expect(beforeUnmount.version).toBe(1);

    await harness.unmount();
    expect(beforeUnmount.insert('after unmount')).toMatchObject({ ok: false });
    expect(docToMarkdown(session.getState().docs[pageId]!)).toBe(
      docToMarkdown(editor.state.doc.toJSON() as DocNode),
    );
    expect(writes).not.toHaveBeenCalled();
  });

  it('does not revive a captured handle across owner reload or session A-to-B-to-A with the same page ID', async () => {
    const pageId = `insertion-same-id-${++idCounter}` as PageId;
    const first = await openWorkspace({ pageId, text: 'first session', makeCurrent: true });
    setMainRoute(pageId);
    const firstWrites = vi.spyOn(first.vault, 'apply');
    const harness = mountPageEditor(first.session, pageId);
    await harness.render();
    const editor = harness.editor;
    if (!editor) throw new Error('PageEditor did not mount.');
    await focusEditor(editor);
    const owner = testOwner();

    const beforeOwnerReload = capture(owner, editor);
    owner.setActive(false);
    owner.reload();
    expect(beforeOwnerReload.insert('old owner')).toMatchObject({ ok: false });
    const afterOwnerReload = capture(owner, editor);
    expect(afterOwnerReload.version).toBe(1);
    afterOwnerReload.dispose();

    const second = await openWorkspace({ pageId, text: 'second session', makeCurrent: false });
    const secondWrites = vi.spyOn(second.vault, 'apply');
    const beforeSwitch = editor.state.doc.toJSON();
    const beforeSessionSwap = capture(owner, editor);
    await act(async () => {
      setSession(second.session);
      setSession(first.session);
    });
    expect(focusedEditor()).toBe(editor);
    expect(beforeSessionSwap.insert('must not target returned session')).toMatchObject({ ok: false });
    expect(editor.state.doc.toJSON()).toEqual(beforeSwitch);
    expect(docToMarkdown(first.session.getState().docs[pageId]!)).toBe(
      docToMarkdown(beforeSwitch as DocNode),
    );
    expect(docToMarkdown(second.session.getState().docs[pageId]!)).toBe(docToMarkdown(second.initialDoc));
    expect(firstWrites).not.toHaveBeenCalled();
    expect(secondWrites).not.toHaveBeenCalled();
  });

  it('reports blocked duplicate and unknown marker insertions instead of chain-run success', async () => {
    const { pageId, session, vault } = await openWorkspace({ withExistingView: true });
    setMainRoute(pageId);
    const writes = vi.spyOn(vault, 'apply');
    const harness = mountPageEditor(session, pageId);
    await harness.render();
    const editor = harness.editor;
    if (!editor) throw new Error('PageEditor did not mount.');
    await focusEditor(editor);
    const owner = testOwner();
    const target = capture(owner, editor);
    const before = editor.state.doc.toJSON();
    const sessionDoc = session.getState().docs[pageId];

    const result = target.insert(`\n${encodePolarisDadosViewMarker(existingView)}\n`);
    expect(result).toMatchObject({ ok: false });
    expect(editor.state.doc.toJSON()).toEqual(before);
    expect(session.getState().docs[pageId]).toEqual(sessionDoc);
    expect(viewIds(editor)).toEqual([existingView.viewId]);
    expect(writes).not.toHaveBeenCalled();

    const unknownMarkerTarget = capture(owner, editor);
    const unknownMarker = '<!-- morrow:polaris-dados-view:v2:synthetic-unknown -->';
    expect(unknownMarkerTarget.insert(`\n${unknownMarker}\n`)).toMatchObject({ ok: false });
    expect(editor.state.doc.toJSON()).toEqual(before);
    expect(session.getState().docs[pageId]).toEqual(sessionDoc);
    expect(viewIds(editor)).toEqual([existingView.viewId]);
    expect(writes).not.toHaveBeenCalled();
  });
});
