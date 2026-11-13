// @vitest-environment happy-dom
import type { Editor } from '@tiptap/core';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PageId } from '../../core/model';
import { MemoryVault } from '../../storage/memoryVault';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';
import { PageEditor } from './PageEditor';
import { commitEditors, focusedEditor } from './commits';
import { captureEditorInsertionTarget } from './editorInsertion';
import type { EditorInsertionOwner } from './editorInsertion';
import { getPreferences, setPreferences } from '../platform/preferences';
import { navigate } from '../router';
import { PaneContext, closeSide, setActivePane, startTabs } from '../tabs';
import { setSession } from '../workspace';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const NOTE_ID = 'mutation-fence-note' as PageId;
const NOTE_PATH = 'Mutation fence note.md';

function syntheticVault(): MemoryVault {
  return new MemoryVault({
    [NOTE_PATH]: '# Before fence\n\nA short synthetic page.\n',
    '.morrow/workspace.json': JSON.stringify({
      version: 1,
      pages: { [NOTE_PATH]: { id: NOTE_ID, created: 1, order: 0 } },
    }),
    '.morrow/recent.json': JSON.stringify({ version: 1, opened: {}, activity: {} }),
  });
}

async function openSession(vault: MemoryVault): Promise<WorkspaceSession> {
  const opened = await WorkspaceSession.open(new VaultRepository(vault, () => 'unexpected-fence-page'), {
    delayMs: 60_000,
  });
  if (!opened.ok) throw new Error(opened.error);
  const session = opened.value;
  setSession(session);
  sessions.add(session);
  return session;
}

interface PageEditorHarness {
  readonly container: HTMLElement;
  readonly editor: Editor | null;
  render(): Promise<void>;
  unmount(): Promise<void>;
}

function mountPageEditor(session: WorkspaceSession): PageEditorHarness {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let editor: Editor | null = null;
  let disposed = false;
  const render = async (): Promise<void> => {
    await act(async () => {
      root.render(
        createElement(
          PaneContext.Provider,
          { value: 'main' },
          createElement(PageEditor, {
            pageId: NOTE_ID,
            doc: session.getState().docs[NOTE_ID]!,
            editable: true,
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

function activeOwner(): EditorInsertionOwner {
  return { generation: 1, isActive: () => true };
}

function setMainRoute(): void {
  closeSide();
  setActivePane('main');
  navigate({ name: 'page', id: NOTE_ID, find: null }, { replace: true, pane: 'main' });
}

const sessions = new Set<WorkspaceSession>();
const harnesses = new Set<PageEditorHarness>();
const targets = new Set<NonNullable<ReturnType<typeof captureEditorInsertionTarget>>>();
const stopTabListeners = new Set<() => void>();
let preferencesBeforeTest = getPreferences();

beforeEach(() => {
  preferencesBeforeTest = getPreferences();
  setPreferences({ locale: 'en', readingMode: false });
  stopTabListeners.add(startTabs());
});

afterEach(async () => {
  for (const target of [...targets]) {
    target.dispose();
    targets.delete(target);
  }
  for (const harness of [...harnesses]) {
    await harness.unmount();
    harnesses.delete(harness);
  }
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
});

describe('independent editor capture checks during the mutation fence', () => {
  it('permanently invalidates an old capture, preserves its accepted draft, and allows a fresh capture after release', async () => {
    const vault = syntheticVault();
    const session = await openSession(vault);
    setMainRoute();
    const harness = mountPageEditor(session);
    await harness.render();
    const editor = harness.editor;
    if (!editor) throw new Error('PageEditor did not mount.');
    await act(async () => editor.commands.focus());
    expect(focusedEditor()).toBe(editor);

    const owner = activeOwner();
    const acceptedDraftTarget = captureEditorInsertionTarget(owner);
    if (!acceptedDraftTarget) throw new Error('Expected an initial insertion capture.');
    targets.add(acceptedDraftTarget);
    expect(acceptedDraftTarget.insert('Accepted before fence')).toEqual({ ok: true });
    await act(async () => {
      expect(commitEditors()).toBe(true);
    });
    expect(session.getState().docs[NOTE_ID]).toBeDefined();
    expect(session.queue.isDirty(NOTE_ID)).toBe(true);

    const oldTarget = captureEditorInsertionTarget(owner);
    if (!oldTarget) throw new Error('Expected a second capture before the fence.');
    targets.add(oldTarget);
    const acceptedState = structuredClone(session.getState());
    const acceptedEditorDoc = editor.state.doc.toJSON();

    const release = session.beginMutationFence();
    try {
      expect(session.isMutationFenced).toBe(true);
      expect(captureEditorInsertionTarget(owner)).toBeNull();
      expect(oldTarget.insert('Rejected during fence')).toMatchObject({ ok: false });
      expect(session.getState()).toEqual(acceptedState);
      expect(editor.state.doc.toJSON()).toEqual(acceptedEditorDoc);
    } finally {
      release();
    }

    expect(session.isMutationFenced).toBe(false);
    expect(oldTarget.insert('Rejected after release')).toMatchObject({ ok: false });
    const freshTarget = captureEditorInsertionTarget(owner);
    if (!freshTarget) throw new Error('A fresh capture should be available after release.');
    targets.add(freshTarget);
    expect(freshTarget.insert('Accepted after release')).toEqual({ ok: true });

    await act(async () => {
      expect(commitEditors()).toBe(true);
      expect(await session.flush()).toBe(true);
    });
    expect(vault.text(NOTE_PATH)).toContain('Accepted before fence');
    expect(vault.text(NOTE_PATH)).toContain('Accepted after release');
    expect(vault.text(NOTE_PATH)).not.toContain('Rejected during fence');
    expect(vault.text(NOTE_PATH)).not.toContain('Rejected after release');
  });
});
