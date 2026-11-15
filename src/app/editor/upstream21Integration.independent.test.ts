// @vitest-environment happy-dom
import type { Editor } from '@tiptap/core';
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocNode, PageId } from '../../core/model';
import { docToMarkdown } from '../../core/markdown/serialize';
import { MemoryVault } from '../../storage/memoryVault';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';
import { setSession } from '../workspace';
import { PageEditor } from './PageEditor';
import { commitPageEditorDraft } from './pageEditorCoordination';
import { t } from '../i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TARGET_ID = 'upstream21-block-target' as PageId;
const REFERENCE_ID = 'upstream21-block-reference' as PageId;
const TARGET_PATH = 'Target.md';
const REFERENCE_PATH = 'Reference.md';

interface NoteFixture {
  id: PageId;
  path: string;
  doc: DocNode;
}

interface PageEditorHarness {
  readonly container: HTMLElement;
  readonly editors: Map<number, Editor>;
  render(): Promise<void>;
  unmount(): Promise<void>;
}

const harnesses = new Set<PageEditorHarness>();
const sessions = new Set<WorkspaceSession>();
let clipboardDescriptor: PropertyDescriptor | undefined;
let rangeRectsDescriptor: PropertyDescriptor | undefined;
let rangeRectsWasAdded = false;
let clipboardWrites: string[] = [];

function paragraph(text: string, blockId?: string): DocNode {
  return {
    type: 'paragraph',
    ...(blockId ? { attrs: { blockId } } : {}),
    content: [{ type: 'text', text }],
  };
}

function note(text: string, blockId?: string): DocNode {
  return { type: 'doc', content: [paragraph(text, blockId)] };
}

async function openWorkspace(notes: NoteFixture[]) {
  const pages = Object.fromEntries(
    notes.map(({ id, path }, index) => [path, { id, created: index + 1, order: index }]),
  );
  const files: Record<string, string> = {
    '.morrow/workspace.json': JSON.stringify({ version: 1, pages }),
    '.morrow/recent.json': JSON.stringify({ version: 1, opened: {}, activity: {} }),
  };
  for (const fixture of notes) files[fixture.path] = docToMarkdown(fixture.doc);

  const vault = new MemoryVault(files);
  let generatedPageId = 0;
  const opened = await WorkspaceSession.open(
    new VaultRepository(vault, () => `unexpected-generated-page-${++generatedPageId}`),
    { delayMs: 60_000 },
  );
  if (!opened.ok) throw new Error(opened.error);
  const session = opened.value;
  setSession(session);
  sessions.add(session);
  return { session, vault };
}

function mountPageEditors(session: WorkspaceSession, pageIds: PageId[]): PageEditorHarness {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const editors = new Map<number, Editor>();
  let disposed = false;

  const render = async (): Promise<void> => {
    await act(async () => {
      root.render(
        createElement(
          Fragment,
          null,
          ...pageIds.map((pageId, index) =>
            createElement(PageEditor, {
              key: `page-editor-peer-${index}`,
              pageId,
              doc: session.getState().docs[pageId]!,
              editable: true,
              find: null,
              onExitTop: () => {},
              onDirty: () => {},
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

  const harness: PageEditorHarness = { container, editors, render, unmount };
  harnesses.add(harness);
  return harness;
}

function editorOf(harness: PageEditorHarness, index: number): Editor {
  const editor = harness.editors.get(index);
  if (!editor || editor.isDestroyed) throw new Error(`PageEditor peer ${index} did not mount.`);
  return editor;
}

function editorBlockId(editor: Editor): string | null {
  const id = editor.state.doc.firstChild?.attrs.blockId;
  return typeof id === 'string' ? id : null;
}

function documentBlockId(doc: DocNode): string | null {
  const paragraphNode = doc.content?.find((node) => node.type === 'paragraph');
  const id = paragraphNode?.attrs?.blockId;
  return typeof id === 'string' ? id : null;
}

function containsPageAnchor(doc: DocNode, pageId: PageId, anchor: string): boolean {
  let found = false;
  const visit = (node: DocNode): void => {
    if (node.type === 'pageLink' && node.attrs?.id === pageId && node.attrs?.anchor === `^${anchor}`) {
      found = true;
    }
    for (const child of node.content ?? []) visit(child);
  };
  visit(doc);
  return found;
}

async function appendText(editor: Editor, text: string): Promise<void> {
  await act(async () => {
    editor.view.dispatch(editor.state.tr.insertText(text, editor.state.doc.content.size - 1));
  });
}

async function appendPageAnchor(editor: Editor, targetId: PageId, blockId: string): Promise<void> {
  await act(async () => {
    const position = editor.state.doc.content.size - 1;
    editor.commands.setTextSelection(position);
    const inserted = editor.commands.insertContent({
      type: 'pageLink',
      attrs: { id: targetId, label: 'Target', anchor: `^${blockId}` },
    });
    expect(inserted).toBe(true);
  });
}

async function openBlockMenu(editor: Editor): Promise<HTMLButtonElement> {
  const host = editor.view.dom.parentElement;
  const block = editor.view.dom.firstElementChild;
  if (!(host instanceof HTMLElement) || !(block instanceof HTMLElement)) {
    throw new Error('The page block handle did not mount.');
  }

  vi.spyOn(editor.view.dom, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 320, 160));
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 320, 160));
  vi.spyOn(block, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 240, 24));
  const rangeDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
  if (typeof Range.prototype.getClientRects === 'function') {
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([] as unknown as DOMRectList);
  } else {
    rangeRectsDescriptor = rangeDescriptor;
    rangeRectsWasAdded = true;
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [],
    });
  }

  await act(async () => {
    host.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 4, clientY: 12 }));
  });
  const handle = host.querySelector<HTMLButtonElement>('.block-handle');
  if (!handle) throw new Error('The page block handle did not mount.');
  vi.spyOn(handle, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 14, 14));
  await act(async () => handle.click());

  const action = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.trim() === t('editor.copyLinkToBlock'),
  );
  if (!action) throw new Error('The copy-link-to-block action did not open.');
  return action;
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
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
  else Reflect.deleteProperty(navigator, 'clipboard');
  clipboardDescriptor = undefined;
  if (rangeRectsWasAdded) {
    if (rangeRectsDescriptor) Object.defineProperty(Range.prototype, 'getClientRects', rangeRectsDescriptor);
    else Reflect.deleteProperty(Range.prototype, 'getClientRects');
  }
  rangeRectsDescriptor = undefined;
  rangeRectsWasAdded = false;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Morrow 2.1 block anchor integration', () => {
  it('keeps an anchor linked from another page draft that has not been saved', async () => {
    const { session } = await openWorkspace([
      { id: TARGET_ID, path: TARGET_PATH, doc: note('Target block', 'pending-reference') },
      { id: REFERENCE_ID, path: REFERENCE_PATH, doc: note('Reference draft') },
    ]);
    vi.useFakeTimers();
    const mounted = mountPageEditors(session, [TARGET_ID, REFERENCE_ID]);
    await mounted.render();
    const target = editorOf(mounted, 0);
    const reference = editorOf(mounted, 1);

    await appendPageAnchor(reference, TARGET_ID, 'pending-reference');
    expect(containsPageAnchor(reference.getJSON() as DocNode, TARGET_ID, 'pending-reference')).toBe(true);
    expect(containsPageAnchor(session.getState().docs[REFERENCE_ID]!, TARGET_ID, 'pending-reference')).toBe(false);

    await appendText(target, ' updated');
    await act(async () => {
      expect(commitPageEditorDraft(session, TARGET_ID)).toBe(true);
    });

    expect(editorBlockId(target)).toBe('pending-reference');
    expect(documentBlockId(session.getState().docs[TARGET_ID]!)).toBe('pending-reference');
    expect(containsPageAnchor(session.getState().docs[REFERENCE_ID]!, TARGET_ID, 'pending-reference')).toBe(false);
    await act(async () => {
      expect(commitPageEditorDraft(session, REFERENCE_ID)).toBe(true);
    });
    expect(await session.flush()).toBe(true);
  });

  it('keeps a newly copied block anchor while its link is in the clipboard', async () => {
    clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    clipboardWrites = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          clipboardWrites.push(text);
        },
      },
    });
    const { session } = await openWorkspace([{ id: TARGET_ID, path: TARGET_PATH, doc: note('Copy this block') }]);
    vi.useFakeTimers();
    const mounted = mountPageEditors(session, [TARGET_ID]);
    await mounted.render();
    const editor = editorOf(mounted, 0);
    const action = await openBlockMenu(editor);

    await act(async () => {
      action.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const copiedId = editorBlockId(editor);
    expect(copiedId).toMatch(/^[a-z0-9]{1,6}$/);
    expect(clipboardWrites).toHaveLength(1);
    expect(clipboardWrites[0]).toContain(`#^${copiedId}`);

    await act(async () => {
      expect(commitPageEditorDraft(session, TARGET_ID)).toBe(true);
    });
    expect(documentBlockId(session.getState().docs[TARGET_ID]!)).toBe(copiedId);
    expect(await session.flush()).toBe(true);
  });

  it('cleans orphan anchors in both open peers without adding an undo step', async () => {
    const { session } = await openWorkspace([
      { id: TARGET_ID, path: TARGET_PATH, doc: note('Original block', 'orphan-anchor') },
    ]);
    vi.useFakeTimers();
    const mounted = mountPageEditors(session, [TARGET_ID, TARGET_ID]);
    await mounted.render();
    const first = editorOf(mounted, 0);
    const second = editorOf(mounted, 1);

    await appendText(first, ' edited');
    expect(second.getText()).toBe('Original block edited');
    await act(async () => {
      expect(commitPageEditorDraft(session, TARGET_ID)).toBe(true);
    });
    expect(editorBlockId(first)).toBeNull();
    expect(editorBlockId(second)).toBeNull();
    expect(documentBlockId(session.getState().docs[TARGET_ID]!)).toBeNull();

    await act(async () => {
      expect(first.commands.undo()).toBe(true);
    });
    expect(first.getText()).toBe('Original block');
    expect(second.getText()).toBe('Original block');
    expect(editorBlockId(first)).toBeNull();
    expect(editorBlockId(second)).toBeNull();
    await act(async () => {
      expect(first.commands.undo()).toBe(false);
    });
    await act(async () => {
      expect(commitPageEditorDraft(session, TARGET_ID)).toBe(true);
    });
    expect(await session.flush()).toBe(true);
  });
});
