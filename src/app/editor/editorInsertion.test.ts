// @vitest-environment happy-dom
import { Editor } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Command } from '../../core/commands';
import type { DocNode, PageId, PageMeta, WorkspaceState } from '../../core/model';
import type { Result } from '../../core/result';
import type { WorkspaceSession } from '../../storage/session';
import { encodePolarisDadosViewMarker } from '../../core/polarisDadosView';
import type { PolarisDadosViewData } from '../../core/polarisDadosView';
import { getPreferences, setPreferences } from '../platform/preferences';
import { setActivePane } from '../tabs';
import { setSession } from '../workspace';
import { captureEditorInsertionTarget } from './editorInsertion';
import type { EditorInsertionOwner } from './editorInsertion';
import { focusedEditor, setFocusedEditor } from './commits';
import { registerPageEditorCoordinator } from './pageEditorCoordination';
import { createExtensions } from './extensions';

const live: Array<{ editor: Editor; dispose: () => void; host: HTMLElement; session: TestSession }> = [];
const targets: Array<NonNullable<ReturnType<typeof captureEditorInsertionTarget>>> = [];
let fixtureId = 0;
let previousReadingMode = false;

class TestSession {
  private state: WorkspaceState;
  private closed = false;
  private readonly listeners = new Set<() => void>();
  private readonly closeListeners = new Set<() => void>();
  readonly unreadable = new Set<PageId>();
  readonly protectedReasons = new Map<PageId, string>();

  constructor(
    readonly pageId: PageId,
    initial: DocNode,
  ) {
    const page: PageMeta = {
      id: pageId,
      parentId: null,
      title: 'Insertion fixture',
      icon: null,
      kind: 'page',
      order: 0,
      createdAt: 1,
      updatedAt: 1,
      trashedAt: null,
      archivedAt: null,
      hideTasks: false,
      favorite: false,
      dailyDate: null,
      lastOpenedAt: null,
      tags: [],
      properties: {},
      extra: {},
      database: null,
      cover: null,
      encrypted: false,
    };
    this.state = { pages: { [pageId]: page }, docs: { [pageId]: initial } } as WorkspaceState;
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
    if (command.type === 'page.setDoc') {
      this.state = { ...this.state, docs: { ...this.state.docs, [command.id]: command.doc } };
      for (const listener of this.listeners) listener();
    }
    return { ok: true, value: this.state };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of [...this.closeListeners]) listener();
    this.closeListeners.clear();
  }
}

function paragraph(text: string): DocNode {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function fixture(data?: PolarisDadosViewData) {
  const id = ++fixtureId;
  const pageId = `editor-insertion-${id}` as PageId;
  const initial: DocNode = {
    type: 'doc',
    content: [paragraph('north middle south'), ...(data ? [{ type: 'polarisDadosView', attrs: data }] : [])],
  };
  const session = new TestSession(pageId, initial);
  setSession(session as unknown as WorkspaceSession);
  setActivePane('main');
  window.history.replaceState(null, '', `#/page/${encodeURIComponent(pageId)}`);
  const host = document.createElement('div');
  document.body.append(host);
  const coordinator = registerPageEditorCoordinator(
    session as unknown as WorkspaceSession,
    pageId,
    initial,
    true,
    () => {},
    'main',
  );
  const editor = new Editor({
    element: host,
    extensions: [
      ...createExtensions({
        onBlockMenu: () => {},
        resolvePage: () => null,
        openTag: () => {},
        createChild: () => null,
        openDate: () => {},
        pages: () => [],
        createPage: () => null,
        renderEmbed: () => {},
      } as never),
      coordinator.extension,
    ],
    content: initial as never,
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
  editor.commands.focus();
  setFocusedEditor(editor);
  live.push({ editor, dispose: coordinator.dispose, host, session });
  return { editor, coordinator, session, pageId, initial, editorDoc: editor.getJSON() as DocNode };
}

function owner(): EditorInsertionOwner {
  return { generation: fixtureId, isActive: () => true };
}

function capture(editor: Editor) {
  expect(focusedEditor()).toBe(editor);
  const target = captureEditorInsertionTarget(owner());
  expect(target).not.toBeNull();
  targets.push(target!);
  return target!;
}

beforeEach(() => {
  previousReadingMode = getPreferences().readingMode;
  setPreferences({ readingMode: false });
});

afterEach(() => {
  for (const target of targets.splice(0)) target.dispose();
  for (const item of live.splice(0)) {
    item.dispose();
    if (focusedEditor() === item.editor) setFocusedEditor(null);
    item.editor.destroy();
    item.host.remove();
    item.session.close();
  }
  setPreferences({ readingMode: previousReadingMode });
  document.body.replaceChildren();
});

describe('asynchronous plugin editor insertion captures', () => {
  it('inserts into the captured selection after picker blur and preserves normal page undo', () => {
    const { editor, editorDoc } = fixture();
    editor.commands.setTextSelection(8);
    const target = capture(editor);
    const picker = document.createElement('button');
    document.body.append(picker);
    picker.focus();

    expect(target.insert('picked')).toEqual({ ok: true });
    expect(editor.state.doc.textContent).toContain('picked');
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(editorDoc);
    picker.remove();
  });

  it('permanently invalidates a document edit even when the user undoes it', () => {
    const { editor, editorDoc } = fixture();
    const target = capture(editor);
    expect(editor.commands.insertContent('temporary')).toBe(true);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(editorDoc);

    expect(target.insert('stale')).toMatchObject({ ok: false, reason: 'document-changed' });
    expect(editor.getJSON()).toEqual(editorDoc);
  });

  it('permanently invalidates when the same editor moves panes and returns', () => {
    const { editor, coordinator } = fixture();
    const target = capture(editor);

    coordinator.setPane('side');
    coordinator.setPane('main');

    expect(target.insert('stale pane')).toMatchObject({ ok: false, reason: 'target-changed' });
  });

  it('reports a duplicate guarded atom as refused without changing the document', () => {
    const view: PolarisDadosViewData = {
      version: 1,
      viewId: `existing-${fixtureId + 1}`,
      sourceDatabaseId: 'synthetic-source',
      title: 'Synthetic view',
      columnOrder: [],
      filter: null,
    };
    const { editor, initial } = fixture(view);
    const target = capture(editor);

    expect(target.insert(`\n${encodePolarisDadosViewMarker(view)}\n`)).toEqual({
      ok: false,
      reason: 'insert-rejected',
    });
    expect(editor.getJSON()).toEqual(editor.schema.nodeFromJSON(initial).toJSON());
  });
});
