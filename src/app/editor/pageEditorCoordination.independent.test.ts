// @vitest-environment happy-dom
import type { Editor } from '@tiptap/core';
import { Plugin, TextSelection } from '@tiptap/pm/state';
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocNode, PageId } from '../../core/model';
import { docToPlainText } from '../../core/doc';
import { docToMarkdown } from '../../core/markdown/serialize';
import type { PolarisDadosViewData } from '../../core/polarisDadosView';
import { fail } from '../../core/result';
import { MemoryVault } from '../../storage/memoryVault';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';
import { setSession } from '../workspace';
import { PageEditor } from './PageEditor';
import { commitEditors } from './commits';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const NOTE_ID = 'note-one' as PageId;
const OTHER_NOTE_ID = 'note-two' as PageId;
const NOTE_PATH = 'Note.md';
const OTHER_NOTE_PATH = 'Other.md';

const viewData: PolarisDadosViewData = {
  version: 1,
  viewId: 'view-one',
  sourceDatabaseId: 'missing-source',
  title: 'Linked view fallback',
  columnOrder: ['quantity'],
  filter: null,
};

const paragraph = (text: string): DocNode => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

function plainDoc(text = 'seed'): DocNode {
  return { type: 'doc', content: [paragraph(text)] };
}

function docWithView(text = 'seed'): DocNode {
  return {
    type: 'doc',
    content: [paragraph(text), { type: 'polarisDadosView', attrs: viewData }],
  };
}

interface NoteFixture {
  id: PageId;
  path: string;
  doc: DocNode;
}

async function openWorkspace(notes: NoteFixture[]) {
  const pages = Object.fromEntries(
    notes.map(({ id, path }) => [path, { id, created: 1, order: 0 }]),
  );
  const files: Record<string, string> = {
    '.morrow/workspace.json': JSON.stringify({ version: 1, pages }),
    '.morrow/recent.json': JSON.stringify({ version: 1, opened: {}, activity: {} }),
  };
  for (const note of notes) files[note.path] = docToMarkdown(note.doc);

  const vault = new MemoryVault(files);
  const opened = await WorkspaceSession.open(
    new VaultRepository(vault, () => 'unused-generated-page-id'),
    { delayMs: 60_000 },
  );
  if (!opened.ok) throw new Error(opened.error);
  const session = opened.value;
  setSession(session);
  return { session, vault };
}

interface PeerSpec {
  pageId: PageId;
  doc?: DocNode;
}

interface PageEditorHarness {
  container: HTMLElement;
  editors: Map<number, Editor>;
  dirtyEvents: boolean[][];
  render(
    active?: number[],
    docs?: Array<DocNode | undefined>,
    editables?: Array<boolean | undefined>,
  ): Promise<void>;
  unmount(): Promise<void>;
}

function mountPageEditors(session: WorkspaceSession, peers: PeerSpec[]): PageEditorHarness {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const editors = new Map<number, Editor>();
  const dirtyEvents = peers.map(() => [] as boolean[]);
  const initialDocs = peers.map(({ pageId, doc }) => doc ?? session.getState().docs[pageId]!);
  let disposed = false;

  const render = async (
    active = peers.map((_, index) => index),
    docs = initialDocs,
    editables: Array<boolean | undefined> = [],
  ): Promise<void> => {
    await act(async () => {
      root.render(
        createElement(
          Fragment,
          null,
          ...active.map((index) =>
            createElement(PageEditor, {
              key: `peer-${index}`,
              pageId: peers[index]!.pageId,
              doc: docs[index]!,
              editable: editables[index] ?? true,
              find: null,
              onExitTop: () => {},
              onDirty: (dirty: boolean) => dirtyEvents[index]!.push(dirty),
              onReady: (editor: Editor) => editors.set(index, editor),
            }),
          ),
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

  const harness: PageEditorHarness = { container, editors, dirtyEvents, render, unmount };
  harnesses.add(harness);
  return harness;
}

const harnesses = new Set<PageEditorHarness>();
const sessions = new Set<WorkspaceSession>();

function keepSession<T extends { session: WorkspaceSession }>(opened: T): T {
  sessions.add(opened.session);
  return opened;
}

function editorOf(harness: PageEditorHarness, index: number): Editor {
  const editor = harness.editors.get(index);
  if (!editor || editor.isDestroyed) throw new Error(`PageEditor peer ${index} did not mount.`);
  return editor;
}

function textEnd(editor: Editor, exactText: string): number {
  let end: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === exactText) {
      end = pos + node.nodeSize;
      return false;
    }
    return true;
  });
  if (end === null) throw new Error(`Could not find text node ${JSON.stringify(exactText)}.`);
  return end;
}

async function fakeTime(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function selectPageLine(editor: Editor, expectedText: string): Promise<void> {
  await act(async () => {
    const before = editor.state.doc.toJSON();
    const paragraph = editor.state.doc.firstChild;
    if (!paragraph?.isTextblock) throw new Error('The draft paragraph did not load.');
    const selection = TextSelection.create(editor.state.doc, 1, paragraph.nodeSize - 1);
    editor.view.dispatch(editor.state.tr.setSelection(selection));
    expect(editor.state.doc.toJSON()).toEqual(before);
  });
  const { from, to } = editor.state.selection;
  expect(editor.state.doc.textBetween(from, to)).toBe(expectedText);
}

afterEach(async () => {
  for (const harness of [...harnesses]) {
    await harness.unmount();
    harnesses.delete(harness);
  }
  for (const session of [...sessions]) {
    if (!session.isClosed) await session.close();
    sessions.delete(session);
  }
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('independent PageEditor coordination gates', () => {
  it('loads the non-empty source into both late-filled editors without a write or dirty transition', async () => {
    const initial = docWithView();
    const { session, vault } = keepSession(
      await openWorkspace([{ id: NOTE_ID, path: NOTE_PATH, doc: initial }]),
    );
    const sourceBefore = vault.text(NOTE_PATH);
    const modifiedBefore = vault.modifiedTime(NOTE_PATH);
    const execute = vi.spyOn(session, 'execute');
    const apply = vi.spyOn(vault, 'apply');
    const mounted = mountPageEditors(session, [
      { pageId: NOTE_ID },
      { pageId: NOTE_ID },
    ]);

    await mounted.render();

    const rawExpected = session.getState().docs[NOTE_ID]!;
    const expected = editorOf(mounted, 0).schema.nodeFromJSON(rawExpected).toJSON();
    expect(mounted.editors.size).toBe(2);
    expect(mounted.editors.get(0)!.getJSON()).toEqual(expected);
    expect(mounted.editors.get(1)!.getJSON()).toEqual(expected);
    expect((rawExpected.content ?? []).some((node) => node.type === 'polarisDadosView')).toBe(true);
    expect(session.getState().pages[viewData.sourceDatabaseId]).toBeUndefined();
    expect(mounted.dirtyEvents.flat()).not.toContain(true);
    expect(execute).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(await session.flush()).toBe(true);
    expect(vault.text(NOTE_PATH)).toBe(sourceBefore);
    expect(vault.modifiedTime(NOTE_PATH)).toBe(modifiedBefore);

    await mounted.unmount();
    expect(execute).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(vault.text(NOTE_PATH)).toBe(sourceBefore);
  });

  it('shares both editors’ drafts before their 250 ms timers and commits one canonical page for reopen', async () => {
    const { session, vault } = keepSession(
      await openWorkspace([{ id: NOTE_ID, path: NOTE_PATH, doc: plainDoc() }]),
    );
    const initial = session.getState().docs[NOTE_ID]!;
    const execute = vi.spyOn(session, 'execute');
    const apply = vi.spyOn(vault, 'apply');
    const mounted = mountPageEditors(session, [
      { pageId: NOTE_ID },
      { pageId: NOTE_ID },
    ]);
    await mounted.render();
    const first = editorOf(mounted, 0);
    const second = editorOf(mounted, 1);
    vi.useFakeTimers();

    await act(async () => {
      second.commands.setTextSelection(5);
      first.commands.setTextSelection(5);
      first.view.dispatch(first.state.tr.insertText(' A'));
    });
    expect(first.getText()).toBe('seed A');
    expect(second.getText()).toBe('seed A');
    expect(second.state.selection.from).toBe(7);

    await act(async () => {
      second.view.dispatch(second.state.tr.insertText(' B'));
    });
    expect(first.getText()).toBe('seed A B');
    expect(second.getText()).toBe('seed A B');

    const staleProps = structuredClone(initial);
    await mounted.render([0, 1], [staleProps, staleProps]);
    expect(first.getText()).toBe('seed A B');
    expect(second.getText()).toBe('seed A B');

    await fakeTime(249);
    expect(execute).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();

    commitEditors();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toMatchObject({ type: 'page.setDoc', id: NOTE_ID });
    expect(docToPlainText(session.getState().docs[NOTE_ID]!)).toContain('seed A B');
    expect(await session.flush()).toBe(true);
    expect(vault.text(NOTE_PATH)).toContain('seed A B');
    expect(apply).toHaveBeenCalledTimes(1);

    await mounted.unmount();
    await session.close();
    const reopened = keepSession(
      await WorkspaceSession.open(
        new VaultRepository(vault, () => 'unused-generated-page-id'),
        { delayMs: 60_000 },
      ).then((result) => {
        if (!result.ok) throw new Error(result.error);
        return { session: result.value };
      }),
    ).session;
    expect(docToPlainText(reopened.getState().docs[NOTE_ID]!)).toContain('seed A B');
  });

  it('maps each peer’s undo and redo through remote steps without undoing the other peer', async () => {
    const { session } = keepSession(
      await openWorkspace([{ id: NOTE_ID, path: NOTE_PATH, doc: plainDoc() }]),
    );
    const mounted = mountPageEditors(session, [
      { pageId: NOTE_ID },
      { pageId: NOTE_ID },
    ]);
    await mounted.render();
    const first = editorOf(mounted, 0);
    const second = editorOf(mounted, 1);
    vi.useFakeTimers();

    await act(async () => {
      first.commands.setTextSelection(5);
      second.commands.setTextSelection(5);
      first.view.dispatch(first.state.tr.insertText(' A'));
    });
    await act(async () => {
      second.view.dispatch(second.state.tr.insertText(' B'));
    });
    expect(first.getText()).toBe('seed A B');
    expect(second.getText()).toBe('seed A B');

    await act(async () => {
      expect(first.commands.undo()).toBe(true);
    });
    expect(first.getText()).toBe('seed B');
    expect(second.getText()).toBe('seed B');

    await act(async () => {
      expect(second.commands.undo()).toBe(true);
    });
    expect(first.getText()).toBe('seed');
    expect(second.getText()).toBe('seed');

    await act(async () => {
      expect(second.commands.redo()).toBe(true);
    });
    expect(first.getText()).toBe('seed B');
    expect(second.getText()).toBe('seed B');
    await act(async () => {
      expect(first.commands.redo()).toBe(true);
    });
    expect(first.getText()).toBe('seed B A');
    expect(second.getText()).toBe('seed B A');

    commitEditors();
    expect(docToPlainText(session.getState().docs[NOTE_ID]!)).toContain('seed B A');
  });

  it('fans out an appended transaction without a peer-generated duplicate', async () => {
    const { session } = keepSession(
      await openWorkspace([{ id: NOTE_ID, path: NOTE_PATH, doc: plainDoc() }]),
    );
    const mounted = mountPageEditors(session, [
      { pageId: NOTE_ID },
      { pageId: NOTE_ID },
    ]);
    await mounted.render();
    const first = editorOf(mounted, 0);
    const second = editorOf(mounted, 1);
    const appendInvariant = () =>
      new Plugin({
        appendTransaction: (_transactions, _oldState, newState) => {
          const text = newState.doc.textContent;
          if (!text.includes('trigger') || text.includes('!')) return null;
          return newState.tr.insertText('!', Math.max(1, newState.doc.content.size - 1));
        },
      });
    first.registerPlugin(appendInvariant());
    second.registerPlugin(appendInvariant());
    vi.useFakeTimers();
    let appendedCount = 0;
    first.on('update', ({ transaction, appendedTransactions }) => {
      if (transaction.docChanged) appendedCount = Math.max(appendedCount, appendedTransactions.length);
    });

    await act(async () => {
      first.commands.setTextSelection(5);
      first.view.dispatch(first.state.tr.insertText(' trigger'));
    });

    expect(appendedCount).toBe(1);
    expect(first.getText()).toBe('seed trigger!');
    expect(second.getText()).toBe('seed trigger!');
    expect(second.getText().match(/!/g)).toHaveLength(1);
  });

  it('rejects a later peer append divergence before partially broadcasting to an earlier peer', async () => {
    const { session } = keepSession(
      await openWorkspace([{ id: NOTE_ID, path: NOTE_PATH, doc: plainDoc() }]),
    );
    const mounted = mountPageEditors(session, [
      { pageId: NOTE_ID },
      { pageId: NOTE_ID },
      { pageId: NOTE_ID },
    ]);
    await mounted.render();
    const first = editorOf(mounted, 0);
    const second = editorOf(mounted, 1);
    const third = editorOf(mounted, 2);
    const appendSuffix = (suffix: '!' | '?') =>
      new Plugin({
        appendTransaction: (_transactions, _oldState, newState) => {
          const text = newState.doc.textContent;
          if (!text.includes('trigger') || text.includes(suffix)) return null;
          return newState.tr.insertText(suffix, Math.max(1, newState.doc.content.size - 1));
        },
      });
    first.registerPlugin(appendSuffix('!'));
    second.registerPlugin(appendSuffix('!'));
    third.registerPlugin(appendSuffix('?'));
    const execute = vi.spyOn(session, 'execute');
    vi.useFakeTimers();

    await act(async () => {
      first.commands.setTextSelection(5);
      first.view.dispatch(first.state.tr.insertText(' trigger'));
    });

    expect(first.getText()).toBe('seed trigger!');
    expect(second.getText()).toBe('seed');
    expect(third.getText()).toBe('seed');
    expect(docToPlainText(session.getState().docs[NOTE_ID]!)).toBe('seed');
    expect(commitEditors()).toBe(false);
    expect(execute).not.toHaveBeenCalled();

    await act(async () => {
      first.view.dispatch(first.state.tr.insertText(' extra', first.state.doc.content.size - 1));
    });
    expect(first.getText()).toBe('seed trigger!');
    expect(second.getText()).toBe('seed');
    expect(third.getText()).toBe('seed');
  });

  it('keeps the remaining peers synchronized after one of three editors unmounts', async () => {
    const { session } = keepSession(
      await openWorkspace([{ id: NOTE_ID, path: NOTE_PATH, doc: plainDoc() }]),
    );
    const mounted = mountPageEditors(session, [
      { pageId: NOTE_ID },
      { pageId: NOTE_ID },
      { pageId: NOTE_ID },
    ]);
    await mounted.render();
    const first = editorOf(mounted, 0);
    const second = editorOf(mounted, 1);
    const third = editorOf(mounted, 2);
    vi.useFakeTimers();

    await act(async () => {
      first.commands.setTextSelection(5);
      first.view.dispatch(first.state.tr.insertText(' A'));
    });
    expect(second.getText()).toBe('seed A');
    expect(third.getText()).toBe('seed A');

    await mounted.render([1, 2]);
    expect(second.getText()).toBe('seed A');
    expect(third.getText()).toBe('seed A');
    await act(async () => {
      third.commands.setTextSelection(third.state.doc.content.size - 1);
      third.view.dispatch(third.state.tr.insertText(' C'));
    });
    expect(second.getText()).toBe('seed A C');
    expect(third.getText()).toBe('seed A C');

    commitEditors();
    expect(docToPlainText(session.getState().docs[NOTE_ID]!)).toContain('seed A C');
  });

  it('keeps separate page drafts isolated inside one session', async () => {
    const { session } = keepSession(
      await openWorkspace([
        { id: NOTE_ID, path: NOTE_PATH, doc: plainDoc('first') },
        { id: OTHER_NOTE_ID, path: OTHER_NOTE_PATH, doc: plainDoc('second') },
      ]),
    );
    const mounted = mountPageEditors(session, [
      { pageId: NOTE_ID },
      { pageId: OTHER_NOTE_ID },
    ]);
    await mounted.render();
    const first = editorOf(mounted, 0);
    const second = editorOf(mounted, 1);
    vi.useFakeTimers();

    await act(async () => {
      first.commands.setTextSelection(first.state.doc.content.size - 1);
      first.view.dispatch(first.state.tr.insertText(' changed'));
    });

    expect(first.getText()).toBe('first changed');
    expect(second.getText()).toBe('second');
    expect(docToPlainText(session.getState().docs[NOTE_ID]!)).toBe('first');
    expect(docToPlainText(session.getState().docs[OTHER_NOTE_ID]!)).toBe('second');
    commitEditors();
    expect(docToPlainText(session.getState().docs[NOTE_ID]!)).toBe('first changed');
    expect(docToPlainText(session.getState().docs[OTHER_NOTE_ID]!)).toBe('second');
  });

  it('keeps an existing editor commit and Mod-S flush bound to its mounted session', async () => {
    const firstWorkspace = keepSession(
      await openWorkspace([{ id: NOTE_ID, path: NOTE_PATH, doc: plainDoc('original') }]),
    );
    const mounted = mountPageEditors(firstWorkspace.session, [{ pageId: NOTE_ID }]);
    await mounted.render();
    const editor = editorOf(mounted, 0);
    const firstExecute = vi.spyOn(firstWorkspace.session, 'execute');
    const firstFlush = vi.spyOn(firstWorkspace.session, 'flush').mockResolvedValue(true);
    vi.useFakeTimers();

    const secondWorkspace = keepSession(
      await openWorkspace([{ id: NOTE_ID, path: NOTE_PATH, doc: plainDoc('new vault') }]),
    );
    const secondExecute = vi.spyOn(secondWorkspace.session, 'execute');
    const secondFlush = vi.spyOn(secondWorkspace.session, 'flush').mockResolvedValue(true);

    await act(async () => {
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
      editor.view.dispatch(editor.state.tr.insertText(' old-session'));
    });
    expect(commitEditors()).toBe(true);
    expect(firstExecute).toHaveBeenCalledTimes(1);
    expect(secondExecute).not.toHaveBeenCalled();
    expect(docToPlainText(firstWorkspace.session.getState().docs[NOTE_ID]!)).toContain('old-session');
    expect(docToPlainText(secondWorkspace.session.getState().docs[NOTE_ID]!)).toBe('new vault');

    await act(async () => {
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
      editor.view.dispatch(editor.state.tr.insertText(' flushed'));
      expect(editor.commands.keyboardShortcut('Mod-s')).toBe(true);
    });
    expect(firstFlush).toHaveBeenCalledTimes(1);
    expect(secondFlush).not.toHaveBeenCalled();
    expect(firstExecute).toHaveBeenCalledTimes(2);
    expect(secondExecute).not.toHaveBeenCalled();
    expect(docToPlainText(firstWorkspace.session.getState().docs[NOTE_ID]!)).toContain('old-session flushed');
    expect(docToPlainText(secondWorkspace.session.getState().docs[NOTE_ID]!)).toBe('new vault');
  });

  it('does not send an old closed-session draft into a newly selected session', async () => {
    const firstWorkspace = keepSession(
      await openWorkspace([{ id: NOTE_ID, path: NOTE_PATH, doc: plainDoc('old source') }]),
    );
    const oldEditorMount = mountPageEditors(firstWorkspace.session, [{ pageId: NOTE_ID }]);
    await oldEditorMount.render();
    const oldEditor = editorOf(oldEditorMount, 0);
    vi.useFakeTimers();
    await act(async () => {
      oldEditor.commands.setTextSelection(oldEditor.state.doc.content.size - 1);
      oldEditor.view.dispatch(oldEditor.state.tr.insertText(' draft'));
    });
    await firstWorkspace.session.close();
    const oldExecute = vi.spyOn(firstWorkspace.session, 'execute');
    const oldFlush = vi.spyOn(firstWorkspace.session, 'flush').mockResolvedValue(false);

    const secondWorkspace = keepSession(
      await openWorkspace([{ id: NOTE_ID, path: NOTE_PATH, doc: plainDoc('new vault') }]),
    );
    const secondExecute = vi.spyOn(secondWorkspace.session, 'execute');
    const secondFlush = vi.spyOn(secondWorkspace.session, 'flush').mockResolvedValue(true);

    await act(async () => {
      expect(oldEditor.commands.keyboardShortcut('Mod-s')).toBe(true);
    });
    expect(oldFlush).not.toHaveBeenCalled();
    expect(oldExecute).not.toHaveBeenCalled();
    expect(secondExecute).not.toHaveBeenCalled();
    expect(secondFlush).not.toHaveBeenCalled();
    expect(oldEditor.getText()).toBe('old source draft');
    expect(docToPlainText(secondWorkspace.session.getState().docs[NOTE_ID]!)).toBe('new vault');
    await act(async () => {
      oldEditor.view.dispatch(oldEditor.state.tr.insertText(' rejected', oldEditor.state.doc.content.size - 1));
    });
    expect(oldEditor.getText()).toBe('old source draft');
    await selectPageLine(oldEditor, 'old source draft');
    expect(docToPlainText(secondWorkspace.session.getState().docs[NOTE_ID]!)).toBe('new vault');

    const newEditorMount = mountPageEditors(secondWorkspace.session, [{ pageId: NOTE_ID }]);
    await newEditorMount.render();
    const newEditor = editorOf(newEditorMount, 0);
    expect(newEditor.getText()).toBe('new vault');
    await act(async () => {
      newEditor.commands.setTextSelection(newEditor.state.doc.content.size - 1);
      newEditor.view.dispatch(newEditor.state.tr.insertText(' saved'));
    });
    expect(commitEditors()).toBe(true);
    expect(secondExecute).toHaveBeenCalledTimes(1);
    expect(docToPlainText(secondWorkspace.session.getState().docs[NOTE_ID]!)).toBe('new vault saved');
  });

  it('keeps a dirty draft when its PageEditor becomes read-only until it can retry', async () => {
    const { session } = keepSession(
      await openWorkspace([{ id: NOTE_ID, path: NOTE_PATH, doc: plainDoc() }]),
    );
    const initial = session.getState().docs[NOTE_ID]!;
    const mounted = mountPageEditors(session, [{ pageId: NOTE_ID }]);
    await mounted.render();
    const editor = editorOf(mounted, 0);
    const execute = vi.spyOn(session, 'execute');
    vi.useFakeTimers();

    await act(async () => {
      editor.commands.setTextSelection(5);
      editor.view.dispatch(editor.state.tr.insertText(' read-only draft'));
    });
    await mounted.render([0], [initial], [false]);
    expect(editor.isEditable).toBe(false);
    expect(commitEditors()).toBe(false);
    expect(docToPlainText(session.getState().docs[NOTE_ID]!)).toBe('seed');
    expect(editor.getText()).toBe('seed read-only draft');
    await act(async () => {
      editor.view.dispatch(editor.state.tr.insertText(' rejected', editor.state.doc.content.size - 1));
    });
    expect(editor.getText()).toBe('seed read-only draft');
    await selectPageLine(editor, 'seed read-only draft');

    await fakeTime(1000);
    expect(execute).not.toHaveBeenCalled();
    expect(editor.getText()).toBe('seed read-only draft');
    await mounted.render([0], [initial], [true]);
    expect(editor.isEditable).toBe(true);
    expect(commitEditors()).toBe(true);
    expect(docToPlainText(session.getState().docs[NOTE_ID]!)).toBe('seed read-only draft');
  });

  it('preserves a failed dirty draft across timer expiry and last-peer unmount for retry', async () => {
    const { session } = keepSession(
      await openWorkspace([{ id: NOTE_ID, path: NOTE_PATH, doc: plainDoc() }]),
    );
    const mounted = mountPageEditors(session, [
      { pageId: NOTE_ID },
      { pageId: NOTE_ID },
    ]);
    await mounted.render();
    const first = editorOf(mounted, 0);
    const second = editorOf(mounted, 1);
    vi.useFakeTimers();

    await act(async () => {
      first.commands.setTextSelection(5);
      first.view.dispatch(first.state.tr.insertText(' A'));
    });
    await act(async () => {
      second.commands.setTextSelection(second.state.doc.content.size - 1);
      second.view.dispatch(second.state.tr.insertText(' B'));
    });

    const execute = vi.spyOn(session, 'execute').mockImplementation(() => fail('temporary refusal'));
    expect(commitEditors()).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(docToPlainText(session.getState().docs[NOTE_ID]!)).toBe('seed');
    expect(first.getText()).toBe('seed A B');
    expect(second.getText()).toBe('seed A B');

    await fakeTime(1000);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(docToPlainText(session.getState().docs[NOTE_ID]!)).toBe('seed');
    await mounted.unmount();
    execute.mockRestore();

    const remounted = mountPageEditors(session, [{ pageId: NOTE_ID }]);
    await remounted.render();
    const recovered = editorOf(remounted, 0);
    expect(recovered.getText()).toBe('seed A B');
    expect(commitEditors()).toBe(true);
    expect(docToPlainText(session.getState().docs[NOTE_ID]!)).toBe('seed A B');
  });

  it('preserves dirty drafts and any reentrant peer edit while an external document diverges', async () => {
    const { session } = keepSession(
      await openWorkspace([{ id: NOTE_ID, path: NOTE_PATH, doc: plainDoc() }]),
    );
    const mounted = mountPageEditors(session, [
      { pageId: NOTE_ID },
      { pageId: NOTE_ID },
    ]);
    await mounted.render();
    const first = editorOf(mounted, 0);
    const second = editorOf(mounted, 1);
    const execute = vi.spyOn(session, 'execute');
    vi.useFakeTimers();

    await act(async () => {
      first.commands.setTextSelection(5);
      first.view.dispatch(first.state.tr.insertText(' local'));
    });
    const external = plainDoc('external version');
    let injected = false;
    const unsubscribe = session.subscribe(() => {
      if (injected || docToPlainText(session.getState().docs[NOTE_ID]!) !== 'external version') return;
      injected = true;
      first.commands.setTextSelection(first.state.doc.content.size - 1);
      first.view.dispatch(first.state.tr.insertText(' during external update'));
    });
    let accepted: PageId[] = [];
    await act(async () => {
      accepted = session.applyExternal({
        pages: [session.getState().pages[NOTE_ID]!],
        docs: { [NOTE_ID]: external },
        removed: [],
        unreadable: [],
        readable: [],
      });
    });
    unsubscribe();

    expect(accepted).toContain(NOTE_ID);
    expect(injected).toBe(true);
    expect(docToPlainText(session.getState().docs[NOTE_ID]!)).toBe('external version');
    const retainedDraft = 'seed local';
    expect(first.getText()).toBe(retainedDraft);
    expect(second.getText()).toBe(retainedDraft);
    await selectPageLine(first, retainedDraft);

    await mounted.render([0, 1], [external, external]);
    expect(first.getText()).toBe(retainedDraft);
    expect(second.getText()).toBe(retainedDraft);
    await fakeTime(1000);
    expect(commitEditors()).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(docToPlainText(session.getState().docs[NOTE_ID]!)).toBe('external version');
    expect(first.getText()).toBe(retainedDraft);
    expect(second.getText()).toBe(retainedDraft);
  });

  it('retains a new edit made synchronously during the session acknowledgement', async () => {
    const { session, vault } = keepSession(
      await openWorkspace([{ id: NOTE_ID, path: NOTE_PATH, doc: plainDoc() }]),
    );
    const mounted = mountPageEditors(session, [
      { pageId: NOTE_ID },
      { pageId: NOTE_ID },
    ]);
    await mounted.render();
    const first = editorOf(mounted, 0);
    const second = editorOf(mounted, 1);
    vi.useFakeTimers();
    let injected = false;
    const unsubscribe = session.subscribe(() => {
      if (injected || !docToPlainText(session.getState().docs[NOTE_ID]!).includes('first draft')) return;
      injected = true;
      first.commands.setTextSelection(first.state.doc.content.size - 1);
      first.view.dispatch(first.state.tr.insertText(' second draft'));
    });

    await act(async () => {
      first.commands.setTextSelection(5);
      first.view.dispatch(first.state.tr.insertText(' first draft'));
    });
    expect(commitEditors()).toBe(false);
    expect(injected).toBe(true);
    expect(docToPlainText(session.getState().docs[NOTE_ID]!)).toBe('seed first draft');
    expect(first.getText()).toBe('seed first draft second draft');
    expect(second.getText()).toBe('seed first draft second draft');

    unsubscribe();
    expect(commitEditors()).toBe(true);
    expect(docToPlainText(session.getState().docs[NOTE_ID]!)).toBe('seed first draft second draft');
    expect(await session.flush()).toBe(true);
    await mounted.unmount();
    await session.close();
    const reopenedResult = await WorkspaceSession.open(
      new VaultRepository(vault, () => 'unused-generated-page-id'),
      { delayMs: 60_000 },
    );
    if (!reopenedResult.ok) throw new Error(reopenedResult.error);
    const reopened = keepSession({ session: reopenedResult.value }).session;
    expect(docToPlainText(reopened.getState().docs[NOTE_ID]!)).toBe('seed first draft second draft');
  });

  it('preserves a conflicting document change raised synchronously during the save acknowledgement', async () => {
    const { session } = keepSession(
      await openWorkspace([{ id: NOTE_ID, path: NOTE_PATH, doc: plainDoc() }]),
    );
    const mounted = mountPageEditors(session, [
      { pageId: NOTE_ID },
      { pageId: NOTE_ID },
    ]);
    await mounted.render();
    const first = editorOf(mounted, 0);
    const second = editorOf(mounted, 1);
    const execute = vi.spyOn(session, 'execute');
    const conflictingDoc = plainDoc('concurrent session version');
    let injected = false;
    let conflictAccepted = false;
    const unsubscribe = session.subscribe(() => {
      if (injected || !docToPlainText(session.getState().docs[NOTE_ID]!).includes('local draft')) return;
      injected = true;
      const result = session.execute({
        type: 'page.setDoc',
        id: NOTE_ID,
        doc: conflictingDoc,
        now: Date.now() + 1,
      });
      conflictAccepted = result.ok;
    });
    vi.useFakeTimers();

    await act(async () => {
      first.commands.setTextSelection(first.state.doc.content.size - 1);
      first.view.dispatch(first.state.tr.insertText(' local draft'));
    });
    expect(commitEditors()).toBe(false);
    expect(injected).toBe(true);
    expect(conflictAccepted).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(docToPlainText(session.getState().docs[NOTE_ID]!)).toBe('concurrent session version');
    expect(first.getText()).toBe('seed local draft');
    expect(second.getText()).toBe('seed local draft');

    await selectPageLine(first, 'seed local draft');
    await fakeTime(1000);
    expect(commitEditors()).toBe(false);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(docToPlainText(session.getState().docs[NOTE_ID]!)).toBe('concurrent session version');
    expect(first.getText()).toBe('seed local draft');
    expect(second.getText()).toBe('seed local draft');
    unsubscribe();
  });

  it('applies accepted session document changes synchronously to both peers outside text history', async () => {
    const { session } = keepSession(
      await openWorkspace([{ id: NOTE_ID, path: NOTE_PATH, doc: docWithView() }]),
    );
    const initial = session.getState().docs[NOTE_ID]!;
    const updated: DocNode = structuredClone(initial);
    const paragraphNode = updated.content?.[0];
    if (paragraphNode?.type !== 'paragraph') throw new Error('The fixture paragraph did not load.');
    paragraphNode.content = [
      { type: 'text', text: 'se' },
      { type: 'text', text: 'X' },
      { type: 'text', text: 'ed' },
    ];
    const view = updated.content?.find((node) => node.type === 'polarisDadosView');
    if (!view?.attrs) throw new Error('The fixture linked view did not load.');
    view.attrs = { ...view.attrs, title: 'Session updated title', columnOrder: ['new-order'] };
    updated.content?.push({
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { checked: true }, content: [paragraph('completed task')] },
      ],
    });
    const mounted = mountPageEditors(session, [
      { pageId: NOTE_ID },
      { pageId: NOTE_ID },
    ]);
    await mounted.render();
    const first = editorOf(mounted, 0);
    const second = editorOf(mounted, 1);
    const expectedEditorDoc = first.schema.nodeFromJSON(updated).toJSON() as DocNode;

    await act(async () => {
      const result = session.execute({ type: 'page.setDoc', id: NOTE_ID, doc: updated, now: 2 });
      expect(result.ok).toBe(true);
      expect(first.getJSON()).toEqual(expectedEditorDoc);
      expect(second.getJSON()).toEqual(expectedEditorDoc);
    });

    await act(async () => {
      first.commands.setTextSelection(6);
      first.view.dispatch(first.state.tr.insertText('!'));
    });
    expect(first.state.doc.firstChild?.textContent).toBe('seXed!');
    expect(second.state.doc.firstChild?.textContent).toBe('seXed!');
    expect(first.getJSON()).toMatchObject({
      content: expect.arrayContaining([
        expect.objectContaining({
          type: 'polarisDadosView',
          attrs: expect.objectContaining({ title: 'Session updated title' }),
        }),
        expect.objectContaining({
          type: 'taskList',
          content: [expect.objectContaining({ type: 'taskItem', attrs: { checked: true } })],
        }),
      ]),
    });

    await act(async () => {
      expect(first.commands.undo()).toBe(true);
    });
    expect(first.state.doc.firstChild?.textContent).toBe('seXed');
    expect(second.state.doc.firstChild?.textContent).toBe('seXed');
    expect(first.getJSON()).toMatchObject({
      content: expect.arrayContaining([
        expect.objectContaining({
          type: 'polarisDadosView',
          attrs: expect.objectContaining({ title: 'Session updated title' }),
        }),
        expect.objectContaining({
          type: 'taskList',
          content: [expect.objectContaining({ type: 'taskItem', attrs: { checked: true } })],
        }),
      ]),
    });
  });

  it('maps a clean checkbox-only update over committed text history and peer text', async () => {
    const initial: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'taskList',
          content: [
            { type: 'taskItem', attrs: { checked: false }, content: [paragraph('seed')] },
          ],
        },
        paragraph('peer seed'),
      ],
    };
    const { session } = keepSession(
      await openWorkspace([{ id: NOTE_ID, path: NOTE_PATH, doc: initial }]),
    );
    const mounted = mountPageEditors(session, [
      { pageId: NOTE_ID },
      { pageId: NOTE_ID },
    ]);
    await mounted.render();
    const first = editorOf(mounted, 0);
    const second = editorOf(mounted, 1);
    vi.useFakeTimers();

    await act(async () => {
      first.commands.setTextSelection(textEnd(first, 'seed'));
      first.view.dispatch(first.state.tr.insertText(' local'));
    });
    expect(first.getText()).toContain('seed local');
    expect(second.getText()).toContain('seed local');
    expect(commitEditors()).toBe(true);
    expect(docToPlainText(session.getState().docs[NOTE_ID]!)).toContain('seed local');
    expect(await session.flush()).toBe(true);

    const checkboxOnly = structuredClone(session.getState().docs[NOTE_ID]!);
    const taskList = checkboxOnly.content?.[0];
    const taskItem = taskList?.type === 'taskList' ? taskList.content?.[0] : undefined;
    if (taskItem?.type !== 'taskItem' || !taskItem.attrs)
      throw new Error('The committed task item did not load.');
    taskItem.attrs = { ...taskItem.attrs, checked: true };
    const expectedChecked = first.schema.nodeFromJSON(checkboxOnly).toJSON();

    await act(async () => {
      const result = session.execute({ type: 'page.setDoc', id: NOTE_ID, doc: checkboxOnly, now: Date.now() + 1 });
      expect(result.ok).toBe(true);
      expect(first.getJSON()).toEqual(expectedChecked);
      expect(second.getJSON()).toEqual(expectedChecked);
    });
    expect(first.state.doc.child(0).firstChild?.attrs.checked).toBe(true);
    expect(second.state.doc.child(0).firstChild?.attrs.checked).toBe(true);

    await act(async () => {
      second.commands.setTextSelection(textEnd(second, 'peer seed'));
      second.view.dispatch(second.state.tr.insertText(' peer'));
    });
    expect(first.state.doc.child(1).textContent).toBe('peer seed peer');
    expect(second.state.doc.child(1).textContent).toBe('peer seed peer');

    await act(async () => {
      expect(first.commands.undo()).toBe(true);
    });
    expect(first.state.doc.child(0).firstChild?.attrs.checked).toBe(true);
    expect(second.state.doc.child(0).firstChild?.attrs.checked).toBe(true);
    expect(first.state.doc.child(0).firstChild?.firstChild?.textContent).toBe('seed');
    expect(second.state.doc.child(0).firstChild?.firstChild?.textContent).toBe('seed');
    expect(first.state.doc.child(1).textContent).toBe('peer seed peer');
    expect(second.state.doc.child(1).textContent).toBe('peer seed peer');
    expect(first.getJSON()).toEqual(second.getJSON());

    expect(commitEditors()).toBe(true);
    const savedDoc = session.getState().docs[NOTE_ID]!;
    expect(savedDoc.content?.[0]?.content?.[0]?.attrs?.checked).toBe(true);
    expect(savedDoc.content?.[0]?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe('seed');
    expect(docToPlainText(savedDoc)).toContain('peer seed peer');
  });
});
