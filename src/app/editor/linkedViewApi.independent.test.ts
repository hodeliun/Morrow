// @vitest-environment happy-dom
import type { Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocNode, PageId } from '../../core/model';
import { docToPlainText } from '../../core/doc';
import { encodePolarisDadosViewMarker } from '../../core/polarisDadosView';
import { E003_POLARIS_DADOS_FIXTURE } from '../../storage/fixtures/e003-polaris-dados';
import { MemoryVault } from '../../storage/memoryVault';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';
import { createDataApi } from '../plugins/dataApi';
import type { DataApi, DataApiSnapshot } from '../plugins/dataApi';
import { createLinkedViewApi } from '../plugins/linkedViewApi';
import type { LinkedViewApi, LinkedViewSnapshot } from '../plugins/linkedViewApi';
import { setSession } from '../workspace';
import { PageEditor } from './PageEditor';
import { commitEditors } from './commits';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const NOTE_ID = 'linked-views-note' as PageId;
const SOURCE_ID = 'inventory-source' as PageId;
const ROW_ID = 'inventory-widget' as PageId;
const NOTE_PATH = 'Views.md';
const SOURCE_PATH = 'Inventory.md';
const ROW_PATH = 'Inventory/Widget.md';

const firstView = {
  version: 1 as const,
  viewId: 'view-one',
  sourceDatabaseId: SOURCE_ID,
  title: 'Primary view',
  columnOrder: ['name', 'quantity'],
  filter: { propertyId: 'quantity', op: 'gte' as const, value: 1 },
};

const secondView = {
  version: 1 as const,
  viewId: 'view-two',
  sourceDatabaseId: SOURCE_ID,
  title: 'Secondary view',
  columnOrder: ['price'],
  filter: null,
};

interface WorkspaceFixtureOptions {
  noteText?: string;
  minimal?: boolean;
}

function makeFiles(views = [firstView, secondView], options: WorkspaceFixtureOptions = {}): Record<string, string> {
  const viewNote = [
    '# Linked views',
    '',
    'Text before the first view.',
    '',
    ...views.flatMap((view, index) => [
      encodePolarisDadosViewMarker(view),
      ...(index < views.length - 1 ? ['', 'Text between the views.', ''] : []),
    ]),
    '',
    'Text after the last view.',
    '',
  ].join('\n');
  const fixtureFiles = options.minimal
    ? {
        [SOURCE_PATH]: E003_POLARIS_DADOS_FIXTURE[SOURCE_PATH]!,
        [ROW_PATH]: E003_POLARIS_DADOS_FIXTURE[ROW_PATH]!,
      }
    : E003_POLARIS_DADOS_FIXTURE;
  return {
    ...fixtureFiles,
    [NOTE_PATH]: options.noteText ?? viewNote,
    '.morrow/workspace.json': JSON.stringify({
      version: 1,
      pages: {
        [SOURCE_PATH]: { id: SOURCE_ID, created: 1, order: 0 },
        [ROW_PATH]: { id: ROW_ID, created: 2, order: 0 },
        [NOTE_PATH]: { id: NOTE_ID, created: 3, order: 1 },
      },
    }),
    '.morrow/recent.json': JSON.stringify({ version: 1, opened: {}, activity: {} }),
  };
}

async function openWorkspace(options: WorkspaceFixtureOptions = {}) {
  const vault = new MemoryVault(makeFiles(undefined, options));
  let generatedId = 0;
  const result = await WorkspaceSession.open(
    new VaultRepository(vault, () => `unexpected-generated-page-id-${++generatedId}`),
    { delayMs: 60_000 },
  );
  if (!result.ok) throw new Error(result.error);
  const session = result.value;
  setSession(session);
  sessions.add(session);
  return { session, vault };
}

function pageIdAt(session: WorkspaceSession, path: string): PageId {
  const id = Object.keys(session.getState().pages).find((candidate) => session.pathOf(candidate) === path);
  if (!id) throw new Error(`No page at ${path}.`);
  return id;
}

interface LinkedHandle {
  api: LinkedViewApi;
  release(): void;
}

function linkedHandle(
  session: WorkspaceSession,
  viewId: string,
  options: {
    ownerIsActive?: () => boolean;
    mountGeneration?: string;
    isMountGenerationActive?: (generation: string | number | symbol | object) => boolean;
    isHostReadonly?: () => boolean;
  } = {},
): LinkedHandle {
  let cleanup = () => {};
  const mountGeneration = options.mountGeneration ?? `generation-${++generationCounter}`;
  const api = createLinkedViewApi({
    session,
    pageId: NOTE_ID,
    viewId,
    sourceDatabaseId: SOURCE_ID,
    mountGeneration,
    ownerIsActive: options.ownerIsActive ?? (() => true),
    isMountGenerationActive: options.isMountGenerationActive ?? (() => true),
    isHostReadonly: options.isHostReadonly ?? (() => false),
    registerCleanup: (onCleanup) => {
      cleanup = onCleanup;
    },
  });
  const handle = { api, release: () => cleanup() };
  linkedHandles.add(handle);
  return handle;
}

interface DataHandle {
  api: DataApi;
  release(): void;
}

function dataHandle(session: WorkspaceSession): DataHandle {
  let cleanup = () => {};
  const api = createDataApi({
    session,
    ownerIsActive: () => true,
    isProviderActive: () => true,
    isHostReadonly: () => false,
    registerCleanup: (onCleanup) => {
      cleanup = onCleanup;
    },
  });
  const handle = { api, release: () => cleanup() };
  dataHandles.add(handle);
  return handle;
}

function readyLinked(snapshot: LinkedViewSnapshot) {
  if (snapshot.status !== 'ready') throw new Error(`Expected a ready linked view, got ${snapshot.status}.`);
  return snapshot;
}

function readyData(snapshot: DataApiSnapshot) {
  if (snapshot.status !== 'ready') throw new Error(`Expected a ready source database, got ${snapshot.status}.`);
  return snapshot;
}

interface PageEditorHarness {
  editors: Map<number, Editor>;
  render(): Promise<void>;
  unmount(): Promise<void>;
}

function mountPageEditors(session: WorkspaceSession, count: number): PageEditorHarness {
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
          ...Array.from({ length: count }, (_, index) =>
            createElement(PageEditor, {
              key: `peer-${index}`,
              pageId: NOTE_ID,
              doc: session.getState().docs[NOTE_ID]!,
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
  const harness = { editors, render, unmount };
  editorHarnesses.add(harness);
  return harness;
}

function editorOf(harness: PageEditorHarness, index: number): Editor {
  const editor = harness.editors.get(index);
  if (!editor || editor.isDestroyed) throw new Error(`PageEditor peer ${index} did not mount.`);
  return editor;
}

function textEnd(editor: Editor, value: string): number {
  let end: number | null = null;
  editor.state.doc.descendants((node, position) => {
    if (node.isText && node.text === value) {
      end = position + node.nodeSize;
      return false;
    }
    return true;
  });
  if (end === null) throw new Error(`Could not find text node ${JSON.stringify(value)}.`);
  return end;
}

function replaceViewTitle(doc: DocNode, viewId: string, title: string): DocNode {
  let replaced = false;
  const visit = (node: DocNode): DocNode => {
    if (node.type === 'polarisDadosView' && node.attrs?.viewId === viewId) {
      replaced = true;
      return { type: node.type, attrs: { ...node.attrs, title } };
    }
    if (!node.content) return node;
    let changed = false;
    const content = node.content.map((child) => {
      const next = visit(child);
      if (next !== child) changed = true;
      return next;
    });
    return changed ? { ...node, content } : node;
  };
  const next = visit(doc);
  if (!replaced) throw new Error(`Could not find linked view ${viewId}.`);
  return next;
}

function replaceViewSourceId(doc: DocNode, viewId: string, sourceDatabaseId: PageId): DocNode {
  let replaced = false;
  const visit = (node: DocNode): DocNode => {
    if (node.type === 'polarisDadosView' && node.attrs?.viewId === viewId) {
      replaced = true;
      return { type: node.type, attrs: { ...node.attrs, sourceDatabaseId } };
    }
    if (!node.content) return node;
    let changed = false;
    const content = node.content.map((child) => {
      const next = visit(child);
      if (next !== child) changed = true;
      return next;
    });
    return changed ? { ...node, content } : node;
  };
  const next = visit(doc);
  if (!replaced) throw new Error(`Could not find linked view ${viewId}.`);
  return next;
}

function appendText(doc: DocNode, exactText: string, suffix: string): DocNode {
  let changed = false;
  const visit = (node: DocNode): DocNode => {
    if (node.type === 'text' && node.text === exactText) {
      changed = true;
      return { ...node, text: exactText + suffix };
    }
    if (!node.content) return node;
    let childChanged = false;
    const content = node.content.map((child) => {
      const next = visit(child);
      if (next !== child) childChanged = true;
      return next;
    });
    return childChanged ? { ...node, content } : node;
  };
  const next = visit(doc);
  if (!changed) throw new Error(`Could not find text ${JSON.stringify(exactText)}.`);
  return next;
}

const editorHarnesses = new Set<PageEditorHarness>();
const sessions = new Set<WorkspaceSession>();
const linkedHandles = new Set<LinkedHandle>();
const dataHandles = new Set<DataHandle>();
let generationCounter = 0;

afterEach(async () => {
  for (const handle of linkedHandles) handle.release();
  linkedHandles.clear();
  for (const handle of dataHandles) handle.release();
  dataHandles.clear();
  for (const harness of [...editorHarnesses]) {
    await harness.unmount();
    editorHarnesses.delete(harness);
  }
  for (const session of [...sessions]) {
    if (!session.isClosed) await session.close();
    sessions.delete(session);
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('independent revisioned linked-view API checks with real PageEditor peers', () => {
  it('rejects malformed runtime columnOrder values without throwing or staging a config', async () => {
    const { session } = await openWorkspace();
    const linked = linkedHandle(session, 'view-one').api;
    const execute = vi.spyOn(session, 'execute');

    for (const columnOrder of [null, 7, 'name']) {
      const before = readyLinked(linked.snapshot());
      let result: ReturnType<LinkedViewApi['patchConfig']> | undefined;
      expect(() => {
        result = linked.patchConfig({
          patch: { columnOrder } as unknown as Parameters<LinkedViewApi['patchConfig']>[0]['patch'],
          expectedRevision: before.revision,
        });
      }).not.toThrow();
      expect(result).toMatchObject({ status: 'error', code: 'invalid-config' });
      expect(readyLinked(linked.snapshot())).toMatchObject({
        revision: before.revision,
        config: before.config,
        history: { canUndo: false, canRedo: false },
      });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not report persisted when the source identity changes during the awaited flush', async () => {
    const { session } = await openWorkspace();
    const linked = linkedHandle(session, 'view-one').api;
    let finishFlush!: (persisted: boolean) => void;
    const pendingFlush = new Promise<boolean>((resolve) => {
      finishFlush = resolve;
    });
    const flush = vi.spyOn(session, 'flush').mockReturnValue(pendingFlush);

    const resultPromise = linked.flush();
    await Promise.resolve();
    expect(flush).toHaveBeenCalledTimes(1);

    const changedDoc = replaceViewSourceId(
      session.getState().docs[NOTE_ID]!,
      'view-one',
      'replacement-source' as PageId,
    );
    expect(session.execute({
      type: 'page.setDoc',
      id: NOTE_ID,
      doc: changedDoc,
      now: Date.now() + 1,
    }).ok).toBe(true);
    finishFlush(true);

    expect(await resultPromise).toMatchObject({ status: 'error', code: 'unsupported' });
    expect(linked.snapshot()).toMatchObject({
      status: 'unsupported',
      diagnostic: { code: 'source-mismatch' },
    });
  });

  it('reports a pending conflict when a subscriber replaces a patch target reentrantly', async () => {
    const { session } = await openWorkspace();
    const linked = linkedHandle(session, 'view-one').api;
    let reentered = false;
    let nested: ReturnType<LinkedViewApi['patchConfig']> | undefined;
    linked.subscribe((snapshot) => {
      if (reentered || snapshot.status !== 'ready' || snapshot.config.title !== 'Outer target') return;
      reentered = true;
      nested = linked.patchConfig({
        patch: { title: 'Subscriber target' },
        expectedRevision: snapshot.revision,
      });
    });

    const initial = readyLinked(linked.snapshot());
    const outer = linked.patchConfig({
      patch: { title: 'Outer target' },
      expectedRevision: initial.revision,
    });
    const final = readyLinked(linked.snapshot());

    expect(nested).toMatchObject({ status: 'staged' });
    expect(final.config.title).toBe('Subscriber target');
    expect(outer).toMatchObject({
      status: 'error',
      code: 'stale-revision',
    });
  });

  it('does not report the old history target as staged after reentrant subscriber mutation', async () => {
    const { session } = await openWorkspace();
    const linked = linkedHandle(session, 'view-one').api;
    const first = readyLinked(linked.snapshot());
    expect(linked.patchConfig({ patch: { title: 'History first' }, expectedRevision: first.revision }).status).toBe('staged');
    const second = readyLinked(linked.snapshot());
    expect(linked.patchConfig({ patch: { title: 'History second' }, expectedRevision: second.revision }).status).toBe('staged');

    let reentered = false;
    let nested: ReturnType<LinkedViewApi['patchConfig']> | undefined;
    linked.subscribe((snapshot) => {
      if (reentered || snapshot.status !== 'ready' || snapshot.config.title !== 'History first') return;
      reentered = true;
      nested = linked.patchConfig({
        patch: { title: 'Subscriber history target' },
        expectedRevision: snapshot.revision,
      });
    });
    const beforeUndo = readyLinked(linked.snapshot());
    const undo = linked.history({ direction: 'undo', expectedRevision: beforeUndo.revision });
    const final = readyLinked(linked.snapshot());

    expect(nested).toMatchObject({ status: 'staged' });
    expect(final.config.title).toBe('Subscriber history target');
    expect(final.history).toEqual({ canUndo: true, canRedo: false });
    expect(undo).toMatchObject({
      status: 'error',
      code: 'stale-revision',
    });
  });

  it('rechecks owner generation after real PageEditor preflight simulation', async () => {
    const { session } = await openWorkspace();
    const mounted = mountPageEditors(session, 1);
    await mounted.render();
    const editor = editorOf(mounted, 0);
    let activeGeneration = 'generation-one';
    const linked = linkedHandle(session, 'view-one', {
      mountGeneration: 'generation-one',
      isMountGenerationActive: (generation) => generation === activeGeneration,
    }).api;
    const execute = vi.spyOn(session, 'execute');
    const canonicalBefore = structuredClone(session.getState().docs[NOTE_ID]!);
    editor.registerPlugin(new Plugin({
      appendTransaction: (_transactions, _oldState, nextState) => {
        let requested = false;
        nextState.doc.descendants((node) => {
          if (node.type.name === 'polarisDadosView' && node.attrs.title === 'Invalidate owner') requested = true;
        });
        if (requested) activeGeneration = 'generation-two';
        return null;
      },
    }));

    const before = readyLinked(linked.snapshot());
    expect(linked.patchConfig({
      patch: { title: 'Invalidate owner' },
      expectedRevision: before.revision,
    })).toMatchObject({ status: 'error', code: 'owner-inactive' });
    expect(execute).not.toHaveBeenCalled();
    expect(session.getState().docs[NOTE_ID]).toEqual(canonicalBefore);
  });

  it('rechecks host readonly after real PageEditor preflight simulation', async () => {
    const { session } = await openWorkspace();
    const mounted = mountPageEditors(session, 1);
    await mounted.render();
    const editor = editorOf(mounted, 0);
    let hostReadonly = false;
    const linked = linkedHandle(session, 'view-one', {
      isHostReadonly: () => hostReadonly,
    }).api;
    const execute = vi.spyOn(session, 'execute');
    const canonicalBefore = structuredClone(session.getState().docs[NOTE_ID]!);
    editor.registerPlugin(new Plugin({
      appendTransaction: (_transactions, _oldState, nextState) => {
        let requested = false;
        nextState.doc.descendants((node) => {
          if (node.type.name === 'polarisDadosView' && node.attrs.title === 'Enable readonly') requested = true;
        });
        if (requested) hostReadonly = true;
        return null;
      },
    }));

    const before = readyLinked(linked.snapshot());
    expect(linked.patchConfig({
      patch: { title: 'Enable readonly' },
      expectedRevision: before.revision,
    })).toMatchObject({ status: 'error', code: 'read-only' });
    expect(execute).not.toHaveBeenCalled();
    expect(session.getState().docs[NOTE_ID]).toEqual(canonicalBefore);
    expect(linked.snapshot()).toMatchObject({ status: 'ready', readonly: true });
  });

  it('patches attrs when ClickBelow added only a transient final paragraph to a view at page end', async () => {
    const noteText = [
      '# View at page end',
      '',
      'Text that must remain before the view.',
      '',
      encodePolarisDadosViewMarker(firstView),
      '',
    ].join('\n');
    const { session, vault } = await openWorkspace({ noteText });
    const mounted = mountPageEditors(session, 1);
    await mounted.render();
    const editor = editorOf(mounted, 0);
    const linked = linkedHandle(session, 'view-one').api;
    const before = readyLinked(linked.snapshot());
    const canonicalBefore = structuredClone(session.getState().docs[NOTE_ID]!);

    const click = new MouseEvent('mousedown', { button: 0, clientY: 100, bubbles: true, cancelable: true });
    await act(async () => {
      editor.view.dom.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(true);
    expect(editor.state.doc.lastChild?.type.name).toBe('paragraph');
    expect(editor.state.doc.lastChild?.content.size).toBe(0);
    expect(session.getState().docs[NOTE_ID]).toEqual(canonicalBefore);
    expect(editor.getText()).toContain('Text that must remain before the view.');
    const caretBeforePatch = editor.state.selection.from;

    await act(async () => {
      expect(linked.patchConfig({
        patch: { title: 'Updated at page end' },
        expectedRevision: before.revision,
      })).toMatchObject({ status: 'staged' });
    });
    expect(editor.state.doc.lastChild?.type.name).toBe('paragraph');
    expect(editor.state.doc.lastChild?.content.size).toBe(0);
    expect(editor.state.selection.from).toBe(caretBeforePatch);
    expect(editor.getText()).toContain('Text that must remain before the view.');
    expect(readyLinked(linked.snapshot()).config.title).toBe('Updated at page end');
    expect(session.getState().docs[NOTE_ID]?.content?.at(-1)?.type).toBe('polarisDadosView');
    expect(await linked.flush()).toMatchObject({ status: 'persisted' });
    expect(vault.text(NOTE_PATH)).toContain('Text that must remain before the view.');
    expect(vault.text(NOTE_PATH)).not.toMatch(/morrow:polaris-dados-view:v1:[^\n]+\n\s*\n$/);
  });

  it('rejects a config patch before staging when a real peer append would diverge', async () => {
    const { session } = await openWorkspace();
    const mounted = mountPageEditors(session, 2);
    await mounted.render();
    const source = editorOf(mounted, 0);
    const divergentPeer = editorOf(mounted, 1);
    const linked = linkedHandle(session, 'view-one').api;
    const before = readyLinked(linked.snapshot());
    const canonicalBefore = structuredClone(session.getState().docs[NOTE_ID]!);
    const execute = vi.spyOn(session, 'execute');

    divergentPeer.registerPlugin(new Plugin({
      appendTransaction: (_transactions, _oldState, nextState) => {
        let requested = false;
        nextState.doc.descendants((node) => {
          if (node.type.name === 'polarisDadosView' && node.attrs.title === 'Append on one peer') requested = true;
        });
        if (!requested || nextState.doc.textContent.includes('peer-append')) return null;
        return nextState.tr.insertText(' peer-append', nextState.doc.content.size - 1);
      },
    }));

    const result = linked.patchConfig({ patch: { title: 'Append on one peer' }, expectedRevision: before.revision });
    expect(result).toMatchObject({ status: 'error', code: 'page-editor-conflict' });
    expect(execute).not.toHaveBeenCalled();
    expect(session.getState().docs[NOTE_ID]).toEqual(canonicalBefore);
    expect(readyLinked(linked.snapshot())).toMatchObject({
      status: 'ready',
      config: { title: 'Primary view' },
      history: { canUndo: false, canRedo: false },
    });
    expect(source.getJSON()).toEqual(divergentPeer.getJSON());
    expect(source.getJSON()).not.toMatchObject({
      content: expect.arrayContaining([
        expect.objectContaining({ attrs: expect.objectContaining({ title: 'Append on one peer' }) }),
      ]),
    });
  });

  it('reports a staged patch if an append diverges only during real fanout, then retries without duplicating history', async () => {
    const { session } = await openWorkspace();
    const mounted = mountPageEditors(session, 2);
    await mounted.render();
    const divergentPeer = editorOf(mounted, 1);
    const linked = linkedHandle(session, 'view-one').api;
    const before = readyLinked(linked.snapshot());
    const execute = vi.spyOn(session, 'execute');
    const appendKey = new PluginKey('independent-staged-linked-view-append');
    let appendChecks = 0;

    divergentPeer.registerPlugin(new Plugin({
      key: appendKey,
      appendTransaction: (_transactions, _oldState, nextState) => {
        let requested = false;
        nextState.doc.descendants((node) => {
          if (node.type.name === 'polarisDadosView' && node.attrs.title === 'After-stage trigger') requested = true;
        });
        if (!requested || nextState.doc.textContent.includes('post-stage-peer-append')) return null;
        appendChecks += 1;
        // Two host simulations must accept the target; the actual peer dispatch then diverges once.
        if (appendChecks !== 3) return null;
        return nextState.tr.insertText(' post-stage-peer-append', nextState.doc.content.size - 1);
      },
    }));

    const result = linked.patchConfig({
      patch: { title: 'After-stage trigger' },
      expectedRevision: before.revision,
    });
    expect(appendChecks).toBe(3);
    expect(result).toMatchObject({
      status: 'error',
      code: 'page-editor-conflict',
      staged: true,
      pageId: NOTE_ID,
      viewId: 'view-one',
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(session.getState().docs[NOTE_ID]?.content?.some(
      (node) => node.type === 'polarisDadosView' && node.attrs?.title === 'After-stage trigger',
    )).toBe(true);
    expect(readyLinked(linked.snapshot())).toMatchObject({
      status: 'ready',
      config: { title: 'After-stage trigger' },
      history: { canUndo: true, canRedo: false },
    });

    const blockedFlush = await linked.flush();
    expect(blockedFlush).toMatchObject({
      status: 'error',
      code: 'page-editor-conflict',
      staged: true,
      pageId: NOTE_ID,
      viewId: 'view-one',
    });
    expect(readyLinked(linked.snapshot()).history).toEqual({ canUndo: true, canRedo: false });

    await mounted.unmount();
    editorHarnesses.delete(mounted);
    const recovered = mountPageEditors(session, 2);
    await recovered.render();
    expect(editorOf(recovered, 0).getJSON()).toEqual(editorOf(recovered, 1).getJSON());
    expect(editorOf(recovered, 0).getText()).not.toContain('post-stage-peer-append');
    expect(await linked.flush()).toMatchObject({ status: 'persisted' });
    const persisted = readyLinked(linked.snapshot());
    expect(persisted.config.title).toBe('After-stage trigger');
    expect(persisted.history).toEqual({ canUndo: true, canRedo: false });

    expect(linked.history({ direction: 'undo', expectedRevision: persisted.revision })).toMatchObject({
      status: 'staged',
      direction: 'undo',
    });
    const undone = readyLinked(linked.snapshot());
    expect(undone.config.title).toBe('Primary view');
    expect(undone.history).toEqual({ canUndo: false, canRedo: true });
    expect(linked.history({ direction: 'undo', expectedRevision: undone.revision })).toMatchObject({ status: 'no-op' });
  });

  it('drains a pending text draft before patching only one view and keeps PM/data histories separate', async () => {
    const { session } = await openWorkspace();
    expect(pageIdAt(session, SOURCE_PATH)).toBe(SOURCE_ID);
    expect(pageIdAt(session, ROW_PATH)).toBe(ROW_ID);
    expect(pageIdAt(session, NOTE_PATH)).toBe(NOTE_ID);
    const mounted = mountPageEditors(session, 2);
    await mounted.render();
    const firstEditor = editorOf(mounted, 0);
    const secondEditor = editorOf(mounted, 1);
    const first = linkedHandle(session, 'view-one').api;
    const second = linkedHandle(session, 'view-two').api;
    const firstBefore = readyLinked(first.snapshot());
    const secondBefore = readyLinked(second.snapshot());

    expect(firstBefore.config).toMatchObject({ title: 'Primary view', columnOrder: ['name', 'quantity'] });
    expect(firstBefore.revision).not.toBe(secondBefore.revision);
    expect(secondBefore.config.title).toBe('Secondary view');
    expect(second.patchConfig({ patch: { title: 'Wrong token' }, expectedRevision: firstBefore.revision })).toMatchObject({
      status: 'error',
      code: 'stale-revision',
    });
    expect(readyLinked(second.snapshot()).config.title).toBe('Secondary view');

    const source = dataHandle(session).api;
    const dataBefore = readyData(source.snapshot(SOURCE_ID));
    vi.useFakeTimers();
    await act(async () => {
      firstEditor.commands.setTextSelection(textEnd(firstEditor, 'Text before the first view.'));
      firstEditor.view.dispatch(firstEditor.state.tr.insertText(' pending'));
    });
    expect(firstEditor.getText()).toContain('Text before the first view. pending');
    expect(secondEditor.getText()).toContain('Text before the first view. pending');
    expect(docToPlainText(session.getState().docs[NOTE_ID]!)).not.toContain(' pending');
    expect(readyLinked(first.snapshot()).revision).toBe(firstBefore.revision);

    await act(async () => {
      const result = source.patchCell({
        databaseId: SOURCE_ID,
        rowId: ROW_ID,
        propertyId: 'quantity',
        value: 3,
        expectedRevision: dataBefore.revision,
      });
      expect(result.status).toBe('staged');
    });
    expect(readyLinked(first.snapshot()).revision).toBe(firstBefore.revision);

    let patchedTitle = '';
    await act(async () => {
      const result = first.patchConfig({
        patch: { title: 'Primary renamed' },
        expectedRevision: firstBefore.revision,
      });
      expect(result).toMatchObject({ status: 'staged', pageId: NOTE_ID, viewId: 'view-one' });
      patchedTitle = readyLinked(first.snapshot()).config.title;
      expect(patchedTitle).toBe('Primary renamed');
      expect(firstEditor.getText()).toContain('Text before the first view. pending');
      expect(secondEditor.getText()).toContain('Text before the first view. pending');
      expect(firstEditor.getJSON()).toMatchObject({
        content: expect.arrayContaining([
          expect.objectContaining({ type: 'polarisDadosView', attrs: expect.objectContaining({ title: patchedTitle }) }),
        ]),
      });
      expect(secondEditor.getJSON()).toEqual(firstEditor.getJSON());
    });

    const afterConfig = readyLinked(first.snapshot());
    expect(afterConfig.history.canUndo).toBe(true);
    expect(readyLinked(second.snapshot()).config.title).toBe('Secondary view');
    expect(readyLinked(second.snapshot()).history.canUndo).toBe(false);
    expect(readyData(source.snapshot(SOURCE_ID)).rows.find((row) => row.id === ROW_ID)?.properties.quantity).toBe(3);
    expect(readyLinked(first.snapshot()).revision).toBe(afterConfig.revision);

    await act(async () => {
      expect(first.history({ direction: 'undo', expectedRevision: afterConfig.revision })).toMatchObject({
        status: 'staged', direction: 'undo',
      });
      expect(firstEditor.getText()).toContain('Text before the first view. pending');
    });
    expect(readyLinked(first.snapshot()).config.title).toBe('Primary view');
    expect(readyData(source.snapshot(SOURCE_ID)).rows.find((row) => row.id === ROW_ID)?.properties.quantity).toBe(3);

    const afterViewUndo = readyLinked(first.snapshot());
    await act(async () => {
      const currentData = readyData(source.snapshot(SOURCE_ID));
      expect(source.history({
        databaseId: SOURCE_ID,
        direction: 'undo',
        expectedRevision: currentData.revision,
      })).toMatchObject({ status: 'staged', direction: 'undo' });
    });
    expect(readyData(source.snapshot(SOURCE_ID)).rows.find((row) => row.id === ROW_ID)?.properties.quantity).toBe(2);
    expect(readyLinked(first.snapshot()).config.title).toBe('Primary view');
    expect(readyLinked(first.snapshot()).revision).toBe(afterViewUndo.revision);

    await act(async () => {
      expect(firstEditor.commands.undo()).toBe(true);
    });
    expect(firstEditor.getText()).not.toContain(' pending');
    expect(secondEditor.getText()).not.toContain(' pending');
    expect(readyLinked(first.snapshot()).config.title).toBe('Primary view');
    expect(commitEditors()).toBe(true);
  });

  it('keeps the config revision across external text and row changes, then clears only that view history on external config', async () => {
    const { session } = await openWorkspace();
    const mounted = mountPageEditors(session, 1);
    await mounted.render();
    const editor = editorOf(mounted, 0);
    const linked = linkedHandle(session, 'view-one').api;
    const source = dataHandle(session).api;
    const initial = readyLinked(linked.snapshot());
    expect(linked.patchConfig({ patch: { title: 'Local title' }, expectedRevision: initial.revision })).toMatchObject({ status: 'staged' });
    expect(readyLinked(linked.snapshot()).history.canUndo).toBe(true);
    expect(await linked.flush()).toMatchObject({ status: 'persisted' });

    const beforeExternalText = readyLinked(linked.snapshot());
    const externalTextDoc = appendText(session.getState().docs[NOTE_ID]!, 'Text before the first view.', ' external');
    expect(session.applyExternal({
      pages: [session.getState().pages[NOTE_ID]!],
      docs: { [NOTE_ID]: externalTextDoc },
      removed: [],
      unreadable: [],
      readable: [],
    })).toContain(NOTE_ID);
    expect(editor.getText()).toContain('Text before the first view. external');
    expect(readyLinked(linked.snapshot()).revision).toBe(beforeExternalText.revision);
    expect(readyLinked(linked.snapshot()).history.canUndo).toBe(true);

    const sourceApi = readyData(source.snapshot(SOURCE_ID));
    expect(source.patchCell({
      databaseId: SOURCE_ID,
      rowId: ROW_ID,
      propertyId: 'quantity',
      value: 4,
      expectedRevision: sourceApi.revision,
    }).status).toBe('staged');
    expect(readyLinked(linked.snapshot()).revision).toBe(beforeExternalText.revision);
    expect(readyLinked(linked.snapshot()).history.canUndo).toBe(true);

    const externalConfigDoc = replaceViewTitle(session.getState().docs[NOTE_ID]!, 'view-one', 'External title');
    expect(session.applyExternal({
      pages: [session.getState().pages[NOTE_ID]!],
      docs: { [NOTE_ID]: externalConfigDoc },
      removed: [],
      unreadable: [],
      readable: [],
    })).toContain(NOTE_ID);
    const external = readyLinked(linked.snapshot());
    expect(external.config.title).toBe('External title');
    expect(external.revision).not.toBe(beforeExternalText.revision);
    expect(external.history).toEqual({ canUndo: false, canRedo: false });
    expect(linked.history({ direction: 'undo', expectedRevision: external.revision })).toMatchObject({ status: 'no-op' });
    expect(readyData(source.snapshot(SOURCE_ID)).rows.find((row) => row.id === ROW_ID)?.properties.quantity).toBe(4);
  });

  it('invalidates another view history when its config changes reentrantly during a sibling patch', async () => {
    const { session } = await openWorkspace();
    const first = linkedHandle(session, 'view-one').api;
    const second = linkedHandle(session, 'view-two').api;
    const secondBefore = readyLinked(second.snapshot());
    expect(second.patchConfig({ patch: { title: 'Second local edit' }, expectedRevision: secondBefore.revision })).toMatchObject({
      status: 'staged',
    });
    expect(readyLinked(second.snapshot()).history.canUndo).toBe(true);
    expect(await second.flush()).toMatchObject({ status: 'persisted' });

    let injected = false;
    const execute = session.execute.bind(session);
    vi.spyOn(session, 'execute').mockImplementation((command) => {
      if (injected || command.type !== 'page.setDoc' || command.id !== NOTE_ID) return execute(command);
      injected = true;
      const external = replaceViewTitle(session.getState().docs[NOTE_ID]!, 'view-two', 'Second external edit');
      expect(session.applyExternal({
        pages: [session.getState().pages[NOTE_ID]!],
        docs: { [NOTE_ID]: external },
        removed: [],
        unreadable: [],
        readable: [],
      })).toContain(NOTE_ID);
      return execute({ ...command, doc: replaceViewTitle(command.doc, 'view-two', 'Second external edit') });
    });
    const firstBefore = readyLinked(first.snapshot());
    expect(first.patchConfig({ patch: { title: 'First local edit' }, expectedRevision: firstBefore.revision })).toMatchObject({
      status: 'staged',
    });

    const secondAfter = readyLinked(second.snapshot());
    expect(injected).toBe(true);
    expect(secondAfter.config.title).toBe('Second external edit');
    expect(secondAfter.history).toEqual({ canUndo: false, canRedo: false });
    expect(second.history({ direction: 'undo', expectedRevision: secondAfter.revision })).toMatchObject({ status: 'no-op' });
  });

  it('keeps the staged config and reports a failed flush until the same workspace retry persists it', async () => {
    const { session, vault } = await openWorkspace();
    const linked = linkedHandle(session, 'view-one').api;
    const before = readyLinked(linked.snapshot());
    const diskBefore = vault.text(NOTE_PATH);
    vi.useFakeTimers();

    expect(linked.patchConfig({ patch: { title: 'Waiting for retry' }, expectedRevision: before.revision })).toMatchObject({
      status: 'staged',
    });
    vi.spyOn(vault, 'apply').mockImplementationOnce(async () => [
      { ok: false as const, code: 'error' as const, message: 'synthetic temporary storage failure' },
    ]);
    expect(await linked.flush()).toMatchObject({ status: 'error', code: 'save-failed' });
    expect(vault.text(NOTE_PATH)).toBe(diskBefore);
    expect(readyLinked(linked.snapshot())).toMatchObject({ status: 'ready', config: { title: 'Waiting for retry' } });

    expect(await linked.flush()).toMatchObject({ status: 'persisted' });
    expect(vault.text(NOTE_PATH)).not.toBe(diskBefore);
    expect(readyLinked(linked.snapshot()).config.title).toBe('Waiting for retry');
  });

  it('does not revive old owner generations or view handles after delete and restore of the same page ID', async () => {
    const { session } = await openWorkspace({ minimal: true });
    let activeGeneration = 'generation-one';
    const ownerActive = () => true;
    const old = linkedHandle(session, 'view-one', {
      mountGeneration: 'generation-one',
      isMountGenerationActive: (generation) => generation === activeGeneration,
      ownerIsActive: ownerActive,
    });
    let oldNotifications = 0;
    old.api.subscribe(() => oldNotifications++);
    expect(oldNotifications).toBe(1);

    activeGeneration = 'generation-two';
    const current = linkedHandle(session, 'view-one', {
      mountGeneration: 'generation-two',
      isMountGenerationActive: (generation) => generation === activeGeneration,
      ownerIsActive: ownerActive,
    });
    expect(() => old.api.snapshot()).toThrow(/no longer active/i);
    expect(old.api.patchConfig({ patch: { title: 'old generation' }, expectedRevision: readyLinked(current.api.snapshot()).revision })).toMatchObject({
      status: 'error', code: 'owner-inactive',
    });
    expect(current.api.patchConfig({ patch: { title: 'current generation' }, expectedRevision: readyLinked(current.api.snapshot()).revision })).toMatchObject({ status: 'staged' });
    expect(oldNotifications).toBe(1);

    const oldOwner = linkedHandle(session, 'view-two', { ownerIsActive: () => false });
    expect(() => oldOwner.api.snapshot()).toThrow(/no longer active/i);
    expect(oldOwner.api.patchConfig({ patch: { title: 'unloaded' }, expectedRevision: readyLinked(current.api.snapshot()).revision })).toMatchObject({
      status: 'error', code: 'owner-inactive',
    });

    const tombstone = linkedHandle(session, 'view-two');
    const removed = session.execute({ type: 'page.trash', id: NOTE_ID, now: Date.now() + 1 });
    expect(removed.ok).toBe(true);
    expect(tombstone.api.snapshot()).toMatchObject({ status: 'missing', pageId: NOTE_ID, viewId: 'view-two' });
    const restoredPage = session.execute({ type: 'page.restore', id: NOTE_ID });
    expect(restoredPage.ok, restoredPage.ok ? '' : restoredPage.error).toBe(true);
    expect(tombstone.api.snapshot()).toMatchObject({ status: 'missing', pageId: NOTE_ID, viewId: 'view-two' });

    const restored = linkedHandle(session, 'view-two');
    expect(readyLinked(restored.api.snapshot()).config.title).toBe('Secondary view');
    expect(tombstone.api.patchConfig({
      patch: { title: 'must stay tombstoned' },
      expectedRevision: readyLinked(restored.api.snapshot()).revision,
    })).toMatchObject({ status: 'error', code: 'missing' });
    expect(readyLinked(restored.api.snapshot()).config.title).toBe('Secondary view');
  });
});
