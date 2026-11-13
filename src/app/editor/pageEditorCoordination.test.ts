// @vitest-environment happy-dom
import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EditorState, Plugin } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';
import type { Command } from '../../core/commands';
import type { DocNode, PageId, WorkspaceState } from '../../core/model';
import type { Result } from '../../core/result';
import type { WorkspaceSession } from '../../storage/session';
import { commitEditors } from './commits';
import { commitPageEditorDraft, registerPageEditorCoordinator } from './pageEditorCoordination';

const pageId = 'coordinator-test-page' as PageId;
const livePeers: Array<{ editor: Editor; dispose: () => void }> = [];
const testSessions: TestSession[] = [];

function paragraph(text: string): DocNode {
  return { type: 'paragraph', content: text ? [{ type: 'text', text }] : [] };
}

function page(text: string): DocNode {
  return { type: 'doc', content: [paragraph(text)] };
}

class TestSession {
  private state: WorkspaceState;
  private closed = false;
  private readonly listeners = new Set<() => void>();
  private readonly closeListeners = new Set<() => void>();
  readonly executed: Command[] = [];

  constructor(initial: DocNode) {
    this.state = { pages: {}, docs: { [pageId]: initial } } as WorkspaceState;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  getState = (): WorkspaceState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  onClose(listener: () => void): () => void {
    if (this.closed) {
      listener();
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  execute(command: Command): Result<WorkspaceState> {
    if (this.closed) return { ok: false, error: 'The workspace session is closed.' };
    this.executed.push(command);
    if (command.type === 'page.setDoc') {
      this.state = { ...this.state, docs: { ...this.state.docs, [command.id]: command.doc } };
      const acceptedState = this.state;
      for (const listener of this.listeners) listener();
      return { ok: true, value: acceptedState };
    }
    return { ok: true, value: this.state };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener();
    this.closeListeners.clear();
  }
}

function appendIfTextContains(trigger: string, marker: string): Extension {
  return Extension.create({
    name: `append_${marker}`,
    addProseMirrorPlugins() {
      return [
        new Plugin({
          appendTransaction: (_transactions, _oldState, newState) => {
            const text = newState.doc.textContent;
            if (text.includes(trigger) && !text.includes(marker)) {
              return newState.tr.insertText(marker);
            }
            return null;
          },
        }),
      ];
    },
  });
}

function openSession(initial: DocNode): TestSession {
  const session = new TestSession(initial);
  testSessions.push(session);
  return session;
}

function openPeer(session: TestSession, extra: Extension[] = [], onDirty: (dirty: boolean) => void = () => {}): Editor {
  const coordinator = registerPageEditorCoordinator(
    session as unknown as WorkspaceSession,
    pageId,
    session.getState().docs[pageId]!,
    true,
    onDirty,
  );
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit, ...extra, coordinator.extension],
    content: page('initial'),
    onUpdate: coordinator.handleUpdate,
  });
  coordinator.attach(editor);
  editor.view.updateState(
    EditorState.create({
      doc: editor.schema.nodeFromJSON(coordinator.content()),
      plugins: editor.state.plugins,
    }),
  );
  coordinator.ready();
  livePeers.push({ editor, dispose: coordinator.dispose });
  return editor;
}

afterEach(() => {
  for (const peer of livePeers.splice(0)) {
    peer.dispose();
    peer.editor.destroy();
  }
  for (const session of testSessions.splice(0)) session.close();
});

describe('page editor coordination', () => {
  it('shares real editor steps and maps each peer’s undo and redo through remote edits', () => {
    const session = openSession(page('seed'));
    const first = openPeer(session);
    const second = openPeer(session);

    first.commands.setTextSelection(5);
    first.view.dispatch(first.state.tr.insertText(' A'));
    second.commands.setTextSelection(second.state.doc.content.size - 1);
    second.view.dispatch(second.state.tr.insertText(' B'));
    expect(first.getText()).toBe('seed A B');
    expect(second.getText()).toBe('seed A B');

    expect(first.commands.undo()).toBe(true);
    expect(first.getText()).toBe('seed B');
    expect(second.getText()).toBe('seed B');
    expect(second.commands.undo()).toBe(true);
    expect(first.getText()).toBe('seed');
    expect(second.getText()).toBe('seed');

    expect(second.commands.redo()).toBe(true);
    expect(first.getText()).toBe('seed B');
    expect(first.commands.redo()).toBe(true);
    expect(first.getText()).toBe('seed B A');
    expect(second.getText()).toBe('seed B A');
  });

  it('lets a host operation drain the shared page draft without manufacturing a peer', () => {
    const session = openSession(page('seed'));
    expect(commitPageEditorDraft(session as unknown as WorkspaceSession, pageId)).toBe(true);
    expect(session.executed).toHaveLength(0);

    const closedSession = openSession(page('closed'));
    closedSession.close();
    expect(commitPageEditorDraft(closedSession as unknown as WorkspaceSession, pageId)).toBe(false);

    const editor = openPeer(session);
    editor.commands.setTextSelection(5);
    editor.view.dispatch(editor.state.tr.insertText(' host draft'));

    expect(commitPageEditorDraft(session as unknown as WorkspaceSession, pageId)).toBe(true);
    expect(session.getState().docs[pageId]).toEqual(page('seed host draft'));
    expect(session.executed).toHaveLength(1);
  });

  it('keeps a newer conflict reported synchronously during the save acknowledgement', () => {
    const session = openSession(page('seed'));
    const first = openPeer(session);
    const second = openPeer(session);
    first.commands.setTextSelection(5);
    first.view.dispatch(first.state.tr.insertText(' local'));
    let injected = false;
    const unsubscribe = session.subscribe(() => {
      if (injected || session.getState().docs[pageId]?.content?.[0]?.content?.[0]?.text !== 'seed local') return;
      injected = true;
      session.execute({ type: 'page.setDoc', id: pageId, doc: page('external'), now: 2 });
    });

    expect(commitEditors()).toBe(false);
    unsubscribe();
    expect(injected).toBe(true);
    expect(session.getState().docs[pageId]).toEqual(page('external'));
    expect(first.getText()).toBe('seed local');
    expect(second.getText()).toBe('seed local');
    expect(commitEditors()).toBe(false);
    expect(session.executed).toHaveLength(2);
  });

  it('returns false when a dirty callback creates a new draft during clean notification', () => {
    const session = openSession(page('seed'));
    let editor: Editor | null = null;
    let injected = false;
    const onDirty = (dirty: boolean) => {
      if (dirty || injected || !editor) return;
      injected = true;
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
      editor.view.dispatch(editor.state.tr.insertText(' reentrant'));
    };
    editor = openPeer(session, [], onDirty);
    editor.commands.setTextSelection(5);
    editor.view.dispatch(editor.state.tr.insertText(' local'));

    expect(commitEditors()).toBe(false);
    expect(injected).toBe(true);
    expect(session.getState().docs[pageId]).toEqual(page('seed local'));
    expect(editor.getText()).toBe('seed local reentrant');
    expect(session.executed).toHaveLength(1);

    expect(commitEditors()).toBe(true);
    expect(session.getState().docs[pageId]).toEqual(page('seed local reentrant'));
    expect(session.executed).toHaveLength(2);
  });

  it('shares an appended transaction chain from identical idempotent plugins without peer history', () => {
    const session = openSession(page('seed'));
    const first = openPeer(session, [appendIfTextContains(' trigger', '!'), appendIfTextContains('!', '?')]);
    const second = openPeer(session, [appendIfTextContains(' trigger', '!'), appendIfTextContains('!', '?')]);
    let appendedCount = 0;
    first.on('update', ({ transaction, appendedTransactions }) => {
      if (!transaction.getMeta('morrowPageEditorHostSync')) appendedCount = appendedTransactions.length;
    });

    first.commands.setTextSelection(5);
    first.view.dispatch(first.state.tr.insertText(' trigger'));

    expect(appendedCount).toBe(2);
    expect(first.getText()).toBe('seed trigger!?');
    expect(second.getText()).toBe('seed trigger!?');
    expect(second.commands.undo()).toBe(false);
    expect(second.getText()).toBe('seed trigger!?');
  });

  it('preflights every peer before fanout and keeps the drafts when append behavior diverges', () => {
    const session = openSession(page('seed'));
    const source = openPeer(session, [appendIfTextContains(' trigger', '!')]);
    const compatiblePeer = openPeer(session, [appendIfTextContains(' trigger', '!')]);
    const divergentPeer = openPeer(session, [appendIfTextContains(' trigger', '?')]);

    source.commands.setTextSelection(5);
    source.view.dispatch(source.state.tr.insertText(' trigger'));

    expect(source.getText()).toBe('seed trigger!');
    expect(compatiblePeer.getText()).toBe('seed');
    expect(divergentPeer.getText()).toBe('seed');
    expect(commitEditors()).toBe(false);
    expect(session.executed).toHaveLength(0);

    source.commands.setTextSelection(1);
    expect(source.state.selection.empty).toBe(true);
    expect(source.state.selection.from).toBe(1);

    source.view.dispatch(source.state.tr.insertText(' blocked', source.state.doc.content.size - 1));
    expect(source.getText()).toBe('seed trigger!');
  });

  it('applies clean session document changes through minimal ProseMirror steps without resetting history', () => {
    const session = openSession(page('a paragraph with target in the middle'));
    const first = openPeer(session);
    const second = openPeer(session);
    first.commands.setTextSelection(12);
    first.view.dispatch(first.state.tr.insertText(' local'));
    expect(first.getText()).toBe('a paragraph local with target in the middle');
    expect(second.getText()).toBe('a paragraph local with target in the middle');
    expect(commitEditors()).toBe(true);

    session.execute({
      type: 'page.setDoc',
      id: pageId,
      doc: page('a paragraph local with changed target in the middle'),
      now: Date.now(),
    });
    expect(first.getText()).toBe('a paragraph local with changed target in the middle');
    expect(second.getText()).toBe('a paragraph local with changed target in the middle');
    expect(first.commands.undo()).toBe(true);
    expect(first.getText()).toBe('a paragraph with changed target in the middle');
    expect(second.getText()).toBe('a paragraph with changed target in the middle');
  });

  it('maps repeated-character insertions whose old and new diff ranges overlap', () => {
    const session = openSession(page('aaaa'));
    const first = openPeer(session);
    const second = openPeer(session);

    session.execute({
      type: 'page.setDoc',
      id: pageId,
      doc: page('aaaaa'),
      now: Date.now(),
    });

    expect(first.getText()).toBe('aaaaa');
    expect(second.getText()).toBe('aaaaa');
  });

  it('notifies observers only after clean external changes reach every peer', () => {
    const session = openSession(page('seed'));
    let first: Editor | null = null;
    let second: Editor | null = null;
    const observed: boolean[] = [];
    let observe = false;
    const onDirty = () => {
      if (observe && first && second) observed.push(first.getText() === 'updated' && second.getText() === 'updated');
    };
    first = openPeer(session, [], onDirty);
    second = openPeer(session, [], onDirty);
    observe = true;

    session.execute({ type: 'page.setDoc', id: pageId, doc: page('updated'), now: Date.now() });

    expect(first?.getText()).toBe('updated');
    expect(second?.getText()).toBe('updated');
    expect(observed).toEqual([true, true]);
  });
});
