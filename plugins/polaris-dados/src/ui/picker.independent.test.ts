// @vitest-environment happy-dom
import type { Editor } from '@tiptap/core';
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocNode, PageId } from '../../../../src/core/model';
import { decodePolarisDadosViewMarker, encodePolarisDadosViewMarker } from '../../../../src/core/polarisDadosView';
import type { PolarisDadosViewData } from '../../../../src/core/polarisDadosView';
import { displayTitle } from '../../../../src/core/model';
import { docToMarkdown } from '../../../../src/core/markdown/serialize';
import { E003_POLARIS_DADOS_FIXTURE } from '../../../../src/storage/fixtures/e003-polaris-dados';
import { MemoryVault } from '../../../../src/storage/memoryVault';
import { WorkspaceSession } from '../../../../src/storage/session';
import { VaultRepository } from '../../../../src/storage/vaultRepository';
import type { DataApi } from '../../../../src/app/plugins/dataApi';
import { createDataApi } from '../../../../src/app/plugins/dataApi';
import type { DatabaseProviderContext, DatabaseProviderRegistration } from '../../../../src/app/plugins/providerApi';
import type { PluginEditorInsertionTargetV1 } from '../../../../src/app/plugins/editorApi';
import { getDatabaseProvider, registerDatabaseProvider } from '../../../../src/app/plugins/providerRegistry';
import { captureEditorInsertionTarget } from '../../../../src/app/editor/editorInsertion';
import type { EditorInsertionOwner } from '../../../../src/app/editor/editorInsertion';
import { commitEditors, focusedEditor } from '../../../../src/app/editor/commits';
import { PageEditor } from '../../../../src/app/editor/PageEditor';
import { ProviderDatabaseView } from '../../../../src/app/components/database/ProviderDatabaseView';
import { navigate } from '../../../../src/app/router';
import { PaneContext, closeSide, setActivePane, startTabs } from '../../../../src/app/tabs';
import { getPreferences, setPreferences } from '../../../../src/app/platform/preferences';
import { setSession } from '../../../../src/app/workspace';
import { activate, POLARIS_DADOS_PROVIDER_ID } from '../main';
import type { PolarisDadosPluginApi } from '../main';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SOURCE_PATH = 'Inventário ✨.md';
const ROW_PATH = 'Inventário ✨/Widget.md';
const ALTERNATE_SOURCE_PATH = 'Budget.md';
const NOTE_PATH = 'Views.md';

interface SessionFixture {
  readonly sourceId: PageId;
  readonly rowId: PageId;
  readonly alternateSourceId: PageId;
  readonly noteId: PageId;
  readonly vault: MemoryVault;
  readonly session: WorkspaceSession;
  readonly close: () => Promise<void>;
}

interface PageEditorHarness {
  readonly container: HTMLElement;
  readonly editor: Editor | null;
  render(options?: {
    readonly editable?: boolean;
    readonly pane?: 'main' | 'side';
    readonly sourceRoot?: boolean;
  }): Promise<void>;
  unmount(): Promise<void>;
}

interface EditorOwnerState extends EditorInsertionOwner {
  readonly active: boolean;
  deactivate(): void;
}

let fixtureSequence = 0;
let pluginSequence = 0;
const sessions = new Set<WorkspaceSession>();
const harnesses = new Set<PageEditorHarness>();
const pluginHarnesses = new Set<PluginTestHarness>();
const stopTabListeners = new Set<() => void>();
let preferencesBeforeTest = getPreferences();

async function openSession(vault: MemoryVault): Promise<WorkspaceSession> {
  let generatedId = 0;
  const opened = await WorkspaceSession.open(
    new VaultRepository(vault, () => `unexpected-picker-page-${++fixtureSequence}-${++generatedId}`),
    { delayMs: 60_000 },
  );
  if (!opened.ok) throw new Error(opened.error);
  const session = opened.value;
  setSession(session);
  sessions.add(session);
  return session;
}

async function openFixture(noteMarkdown = 'North middle South'): Promise<SessionFixture> {
  const sequence = ++fixtureSequence;
  const sourceId = `picker-source-${sequence}` as PageId;
  const rowId = `picker-row-${sequence}` as PageId;
  const alternateSourceId = `picker-budget-${sequence}` as PageId;
  const noteId = `picker-note-${sequence}` as PageId;
  const sourceText = E003_POLARIS_DADOS_FIXTURE['Inventory.md']!.replace('# Inventory', '# Inventário ✨');
  const rowText = E003_POLARIS_DADOS_FIXTURE['Inventory/Widget.md']!.replace(
    'Name: Widget',
    'Name: Catalog label',
  );
  const files: Record<string, string> = {
    [SOURCE_PATH]: sourceText,
    [ROW_PATH]: rowText,
    [ALTERNATE_SOURCE_PATH]: sourceText.replace('# Inventário ✨', '# Budget'),
    [NOTE_PATH]: noteMarkdown,
  };
  const pages: Record<string, { id: string; created: number; order: number }> = {
    [SOURCE_PATH]: { id: sourceId, created: 1, order: 0 },
    [ROW_PATH]: { id: rowId, created: 2, order: 0 },
    [ALTERNATE_SOURCE_PATH]: { id: alternateSourceId, created: 3, order: 1 },
    [NOTE_PATH]: { id: noteId, created: 4, order: 2 },
  };
  files['.morrow/workspace.json'] = JSON.stringify({ version: 1, pages });
  files['.morrow/recent.json'] = JSON.stringify({ version: 1, opened: {}, activity: {} });
  const vault = new MemoryVault(files);
  const session = await openSession(vault);
  return {
    sourceId,
    rowId,
    alternateSourceId,
    noteId,
    vault,
    session,
    async close() {
      if (!session.isClosed) await session.close();
      sessions.delete(session);
    },
  };
}

function mountPageEditor(
  session: WorkspaceSession,
  pageId: PageId,
  sourceDatabaseId?: PageId,
): PageEditorHarness {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let current: { editable: boolean; pane: 'main' | 'side'; sourceRoot: boolean } = {
    editable: true,
    pane: 'main',
    sourceRoot: false,
  };
  let editor: Editor | null = null;
  let disposed = false;

  const render = async (
    options: { readonly editable?: boolean; readonly pane?: 'main' | 'side'; readonly sourceRoot?: boolean } = {},
  ): Promise<void> => {
    current = { ...current, ...options };
    await act(async () => {
      root.render(
        createElement(
          PaneContext.Provider,
          { value: current.pane },
          createElement(
            Fragment,
            null,
            current.sourceRoot && sourceDatabaseId
              ? createElement(ProviderDatabaseView, {
                  key: 'picker-source-provider',
                  page: session.getState().pages[sourceDatabaseId]!,
                  editable: current.editable,
                })
              : null,
            createElement(PageEditor, {
              key: 'picker-note-editor',
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

function editorOwner(): EditorOwnerState {
  let active = true;
  let generation = 1;
  return {
    get generation() {
      return generation;
    },
    get active() {
      return active;
    },
    isActive: () => active,
    deactivate() {
      active = false;
      generation++;
    },
  };
}

async function focusEditor(editor: Editor): Promise<void> {
  await act(async () => editor.commands.focus());
  expect(focusedEditor()).toBe(editor);
}

function cursorInside(editor: Editor, needle: string, offset = 1): number {
  let position: number | null = null;
  editor.state.doc.descendants((node, nodePos) => {
    if (!node.isText || !node.text) return true;
    const index = node.text.indexOf(needle);
    if (index < 0) return true;
    position = nodePos + index + Math.min(offset, needle.length);
    return false;
  });
  if (position === null) throw new Error(`Could not find ${JSON.stringify(needle)} in the PageEditor document.`);
  return position;
}

async function selectCursor(editor: Editor, needle: string, offset = 1): Promise<number> {
  const position = cursorInside(editor, needle, offset);
  await act(async () => {
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, position)));
  });
  return position;
}

function viewData(editor: Editor): PolarisDadosViewData[] {
  const views: PolarisDadosViewData[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'polarisDadosView') views.push(node.attrs as PolarisDadosViewData);
  });
  return views;
}

function topLevelContent(editor: Editor): Array<{ readonly type: string; readonly text?: string; readonly viewId?: string }> {
  const content: Array<{ readonly type: string; readonly text?: string; readonly viewId?: string }> = [];
  editor.state.doc.forEach((node) => {
    if (node.type.name === 'paragraph' && node.textContent.length === 0) return;
    if (node.type.name === 'polarisDadosView') {
      content.push({ type: node.type.name, viewId: String(node.attrs.viewId) });
      return;
    }
    content.push({ type: node.type.name, text: node.textContent });
  });
  return content;
}

function textAroundFirstView(editor: Editor): { readonly before: string; readonly after: string } {
  let position: number | null = null;
  let nodeSize = 0;
  editor.state.doc.descendants((node, nodePos) => {
    if (node.type.name !== 'polarisDadosView') return true;
    position = nodePos;
    nodeSize = node.nodeSize;
    return false;
  });
  if (position === null) throw new Error('The PageEditor document has no linked-view atom.');
  return {
    before: editor.state.doc.textBetween(0, position, '\n', '\n'),
    after: editor.state.doc.textBetween(position + nodeSize, editor.state.doc.content.size, '\n', '\n'),
  };
}

function editorText(editor: Editor): string {
  return editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n', '\n');
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function until(description: string, predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function setMainRoute(pageId: PageId): void {
  closeSide();
  setActivePane('main');
  navigate({ name: 'page', id: pageId, find: null }, { replace: true, pane: 'main' });
}

function markerFrom(markdown: string): string {
  const marker = markdown.match(/<!-- morrow:polaris-dados-view:v1:[A-Za-z0-9_-]+ -->/);
  if (!marker) throw new Error('The captured insertion did not receive a linked-view marker.');
  return marker[0];
}

type PluginCommand = Parameters<PolarisDadosPluginApi['commands']['add']>[0];
type PluginSlashItem = Parameters<PolarisDadosPluginApi['slash']['add']>[0];

interface CapturedTargetRecord {
  readonly target: PluginEditorInsertionTargetV1;
  readonly activeElement: Element | null;
  readonly disposed: boolean;
}

interface PluginTestHarness {
  readonly api: PolarisDadosPluginApi;
  readonly data: DataApi;
  readonly owner: EditorOwnerState;
  readonly commands: Map<string, PluginCommand>;
  readonly slashItems: Map<string, PluginSlashItem>;
  readonly providerContexts: DatabaseProviderContext[];
  readonly captures: CapturedTargetRecord[];
  readonly insertionMarkdown: string[];
  start(): void;
  releaseProvider(): void;
  unload(): void;
}

function createPluginHarness(session: WorkspaceSession): PluginTestHarness {
  const owner = editorOwner();
  const pluginId = `independent-picker-${++pluginSequence}`;
  const commands = new Map<string, PluginCommand>();
  const slashItems = new Map<string, PluginSlashItem>();
  const providerContexts: DatabaseProviderContext[] = [];
  const captures: CapturedTargetRecord[] = [];
  const insertionMarkdown: string[] = [];
  const dataCleanups = new Set<() => void>();
  const data: DataApi = createDataApi({
    session,
    ownerIsActive: () => owner.isActive() && !session.isClosed,
    isProviderActive: (databaseId) => {
      const page = session.getState().pages[databaseId];
      const provider = getDatabaseProvider(POLARIS_DADOS_PROVIDER_ID);
      return Boolean(page?.kind === 'database' && provider?.data === data);
    },
    isHostReadonly: () => getPreferences().readingMode,
    registerCleanup: (cleanup) => dataCleanups.add(cleanup),
  });

  let providerCleanup: (() => void) | null = null;
  const api = {
    data,
    providers: {
      version: 1 as const,
      register(registration: DatabaseProviderRegistration) {
        const wrapped: DatabaseProviderRegistration = {
          ...registration,
          mount(context) {
            providerContexts.push(context);
            return registration.mount(context);
          },
        };
        const unregister = registerDatabaseProvider(pluginId, () => owner.isActive(), data, wrapped);
        const cleanup = () => {
          unregister();
          if (providerCleanup === cleanup) providerCleanup = null;
        };
        providerCleanup = cleanup;
        return cleanup;
      },
    },
    pages: {
      list: () =>
        Object.values(session.getState().pages).map((page) => ({
          id: page.id,
          title: displayTitle(page),
          kind: page.kind,
        })),
    },
    commands: {
      add(command: PluginCommand) {
        commands.set(command.id, command);
        return () => {
          if (commands.get(command.id) === command) commands.delete(command.id);
        };
      },
    },
    slash: {
      add(item: PluginSlashItem) {
        slashItems.set(item.id, item);
        return () => {
          if (slashItems.get(item.id) === item) slashItems.delete(item.id);
        };
      },
    },
    editor: {
      insertion: {
        version: 1 as const,
        capture() {
          const activeElement = document.activeElement;
          const target = captureEditorInsertionTarget(owner);
          if (!target) return null;
          let disposed = false;
          const release = () => {
            if (disposed) return;
            disposed = true;
            target.dispose();
          };
          const wrapper: PluginEditorInsertionTargetV1 = Object.freeze({
            version: target.version,
            insert(markdown: string) {
              insertionMarkdown.push(markdown);
              return target.insert(markdown);
            },
            dispose: release,
          });
          const record: CapturedTargetRecord = {
            target: wrapper,
            activeElement,
            get disposed() {
              return disposed;
            },
          };
          captures.push(record);
          return wrapper;
        },
      },
    },
    get locale() {
      return getPreferences().locale;
    },
  } satisfies PolarisDadosPluginApi;

  let pluginCleanup: (() => void) | null = null;
  let unloaded = false;
  const harness: PluginTestHarness = {
    api,
    data,
    owner,
    commands,
    slashItems,
    providerContexts,
    captures,
    insertionMarkdown,
    start() {
      if (pluginCleanup) throw new Error('The test plugin is already active.');
      pluginCleanup = activate(api);
    },
    releaseProvider() {
      providerCleanup?.();
    },
    unload() {
      if (unloaded) return;
      unloaded = true;
      owner.deactivate();
      pluginCleanup?.();
      pluginCleanup = null;
      for (const record of captures) record.target.dispose();
      for (const cleanup of [...dataCleanups]) {
        cleanup();
        dataCleanups.delete(cleanup);
      }
      pluginHarnesses.delete(harness);
    },
  };
  pluginHarnesses.add(harness);
  return harness;
}

function picker(): HTMLElement {
  const panel = document.querySelector<HTMLElement>('section[data-polaris-dados-picker]');
  if (!panel) throw new Error('The real Polaris Dados picker did not open.');
  return panel;
}

async function runCommand(plugin: PluginTestHarness): Promise<void> {
  const command = plugin.commands.get('insert-view');
  if (!command) throw new Error('The public insert-view command was not registered.');
  await act(async () => command.run());
  picker();
}

async function runSlashItem(plugin: PluginTestHarness): Promise<void> {
  const item = plugin.slashItems.get('insert-view');
  if (!item?.run) throw new Error('The public insert-view slash item was not registered.');
  await act(async () => item.run?.());
  picker();
}

async function runSlashAtText(
  plugin: PluginTestHarness,
  editor: Editor,
  nearbyText: string,
): Promise<void> {
  const token = '/insert-view';
  await selectCursor(editor, nearbyText, 0);
  const from = editor.state.selection.from;
  await act(async () => {
    expect(editor.commands.insertContent(token)).toBe(true);
  });
  await act(async () => {
    expect(editor.chain().focus().deleteRange({ from, to: from + token.length }).run()).toBe(true);
  });
  expect(editorText(editor)).toContain(nearbyText);
  await runSlashItem(plugin);
}

async function chooseSource(sourceId: PageId): Promise<void> {
  const select = picker().querySelector<HTMLSelectElement>('select[data-polaris-action="source"]');
  if (!select) throw new Error('The picker source selector is missing.');
  await act(async () => {
    select.value = sourceId;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function clickPickerAction(action: 'insert' | 'recapture' | 'cancel'): Promise<void> {
  const button = picker().querySelector<HTMLButtonElement>(`button[data-polaris-action="${action}"]`);
  if (!button) throw new Error(`The picker ${action} button is missing.`);
  await act(async () => button.click());
  await settle();
}

function readyData(snapshot: ReturnType<DataApi['snapshot']>) {
  if (snapshot.status !== 'ready') throw new Error(`Expected ready database data, got ${snapshot.status}.`);
  return snapshot;
}

function readyView(context: DatabaseProviderContext) {
  if (!context.view) throw new Error('Expected the linked-view provider to receive a view API.');
  const snapshot = context.view.snapshot();
  if (snapshot.status !== 'ready') throw new Error(`Expected a ready linked view, got ${snapshot.status}.`);
  return { api: context.view, snapshot };
}

function providerRoots(harness: PageEditorHarness): HTMLElement[] {
  return [...harness.container.querySelectorAll<HTMLElement>('.polaris-dados-linked-provider-root')];
}

function gridTotal(root: ParentNode): string | null {
  return root.querySelector<HTMLElement>('tbody td[data-field="total"]')?.textContent?.trim() ?? null;
}

function rowIds(root: ParentNode): string[] {
  return [...root.querySelectorAll<HTMLTableRowElement>('tbody tr')].map((row) => row.dataset.rowId ?? '');
}

beforeEach(() => {
  preferencesBeforeTest = getPreferences();
  setPreferences({ locale: 'en', readingMode: false });
  stopTabListeners.add(startTabs());
});

afterEach(async () => {
  for (const plugin of [...pluginHarnesses]) {
    plugin.unload();
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
  vi.restoreAllMocks();
});

describe('Polaris Dados insertion picker with a real PageEditor', () => {
  it('opens through command and slash APIs, captures before picker focus, preserves source through recapture, and inserts canonical UTF-8', async () => {
    const fixture = await openFixture();
    setMainRoute(fixture.noteId);
    const originalVaultText = fixture.vault.text(NOTE_PATH);
    const writes = vi.spyOn(fixture.vault, 'apply');
    const harness = mountPageEditor(fixture.session, fixture.noteId);
    await harness.render();
    const editor = harness.editor;
    if (!editor) throw new Error('The real PageEditor did not mount.');
    await focusEditor(editor);
    await selectCursor(editor, 'middle', 2);

    const plugin = createPluginHarness(fixture.session);
    plugin.start();
    expect(plugin.commands.get('insert-view')?.name).toContain('Polaris');
    expect(plugin.slashItems.get('insert-view')?.title).toContain('Polaris');

    const localizedPicker = [
      { locale: 'en' as const, heading: 'Insert linked view', source: 'Source database' },
      { locale: 'pt' as const, heading: 'Inserir visualização vinculada', source: 'Banco de origem' },
      { locale: 'es' as const, heading: 'Insertar vista vinculada', source: 'Base de origen' },
    ];
    for (const labels of localizedPicker) {
      setPreferences({ locale: labels.locale });
      await focusEditor(editor);
      await runCommand(plugin);
      const panel = picker();
      expect(panel.getAttribute('aria-label')).toBe(labels.heading);
      expect(panel.querySelector('label')?.textContent).toBe(labels.source);
      expect(panel.querySelector<HTMLButtonElement>('[data-polaris-action="cancel"]')?.textContent).toBe(
        labels.locale === 'en' ? 'Cancel' : 'Cancelar',
      );
      await clickPickerAction('cancel');
      expect(panel.isConnected).toBe(false);
      expect(plugin.captures.at(-1)?.disposed).toBe(true);
    }

    setPreferences({ locale: 'en' });
    await focusEditor(editor);
    await runCommand(plugin);
    const sourceSelect = picker().querySelector<HTMLSelectElement>('select[data-polaris-action="source"]');
    if (!sourceSelect) throw new Error('The source selector is missing.');
    expect(new Set([...sourceSelect.options].map((option) => option.value))).toEqual(
      new Set(['', fixture.sourceId, fixture.alternateSourceId]),
    );
    const firstCapture = plugin.captures.at(-1);
    expect(firstCapture?.activeElement).toBe(editor.view.dom);
    expect(harness.container.contains(firstCapture?.activeElement ?? null)).toBe(true);
    await chooseSource(fixture.sourceId);
    expect(picker().querySelector<HTMLButtonElement>('[data-polaris-action="insert"]')?.disabled).toBe(false);
    expect(writes).not.toHaveBeenCalled();

    // A changed selection permanently invalidates the first opaque target. The picker keeps its source choice.
    await selectCursor(editor, 'South', 2);
    await clickPickerAction('insert');
    expect(viewData(editor)).toEqual([]);
    expect(picker().querySelector<HTMLOutputElement>('[data-polaris-action="status"]')?.textContent).toMatch(
      /selection/i,
    );
    await focusEditor(editor);
    await clickPickerAction('recapture');
    expect(picker().querySelector<HTMLSelectElement>('[data-polaris-action="source"]')?.value).toBe(
      fixture.sourceId,
    );
    expect(plugin.captures.at(-1)?.activeElement).toBe(editor.view.dom);

    await clickPickerAction('insert');
    expect(document.querySelector('section[data-polaris-dados-picker]')).toBeNull();
    const insertedViews = viewData(editor);
    expect(insertedViews).toHaveLength(1);
    const inserted = insertedViews[0]!;
    const sourceTitle = displayTitle(fixture.session.getState().pages[fixture.sourceId]);
    expect(inserted).toMatchObject({
      version: 1,
      sourceDatabaseId: fixture.sourceId,
      title: `${sourceTitle} — view`,
      columnOrder: [],
      filter: null,
    });
    expect(inserted.title).toContain('✨');
    expect(inserted.title.length).toBeLessThanOrEqual(300);
    expect(editorText(editor)).toContain('North');
    expect(editorText(editor)).toContain('middle');
    const textAroundView = textAroundFirstView(editor);
    expect(textAroundView.before.endsWith('So')).toBe(true);
    expect(textAroundView.after.startsWith('uth')).toBe(true);
    expect(`${textAroundView.before}${textAroundView.after}`.replace(/\s/g, '')).toBe('NorthmiddleSouth');
    expect(writes).not.toHaveBeenCalled();
    expect(fixture.vault.text(NOTE_PATH)).toBe(originalVaultText);

    const attemptedMarkdown = plugin.insertionMarkdown.at(-1);
    if (!attemptedMarkdown) throw new Error('The opaque target did not receive insertion markdown.');
    const marker = markerFrom(attemptedMarkdown);
    const decoded = decodePolarisDadosViewMarker(marker);
    expect(decoded).toEqual(inserted);
    expect(encodePolarisDadosViewMarker(decoded)).toBe(marker);
    expect(marker).toMatch(/^<!-- morrow:polaris-dados-view:v1:[A-Za-z0-9_-]+ -->$/);
    expect(docToMarkdown(editor.state.doc.toJSON() as DocNode)).toContain(marker);

    // Model the host's slash flow: it removes the selected slash token, then calls the registered plugin item.
    await focusEditor(editor);
    await runSlashAtText(plugin, editor, 'North');
    expect(picker().getAttribute('aria-label')).toBe('Insert linked view');
    await clickPickerAction('cancel');
    expect(viewData(editor)).toHaveLength(1);
    expect(writes).not.toHaveBeenCalled();
  });

  it('cancels or unloads with no write and releases the captured insertion handle', async () => {
    const fixture = await openFixture();
    setMainRoute(fixture.noteId);
    const original = fixture.vault.text(NOTE_PATH);
    const writes = vi.spyOn(fixture.vault, 'apply');
    const harness = mountPageEditor(fixture.session, fixture.noteId);
    await harness.render();
    const editor = harness.editor;
    if (!editor) throw new Error('The real PageEditor did not mount.');
    await focusEditor(editor);
    await selectCursor(editor, 'middle', 2);

    const plugin = createPluginHarness(fixture.session);
    plugin.start();
    await runCommand(plugin);
    await chooseSource(fixture.sourceId);
    const cancelledPanel = picker();
    const cancelledTarget = plugin.captures.at(-1);
    if (!cancelledTarget) throw new Error('The picker did not capture the PageEditor target.');
    await clickPickerAction('cancel');
    expect(cancelledPanel.isConnected).toBe(false);
    expect(cancelledTarget.disposed).toBe(true);
    expect(viewData(editor)).toEqual([]);
    expect(writes).not.toHaveBeenCalled();
    expect(fixture.vault.text(NOTE_PATH)).toBe(original);

    await focusEditor(editor);
    await runCommand(plugin);
    await chooseSource(fixture.sourceId);
    const unloadedPanel = picker();
    const unloadedTarget = plugin.captures.at(-1);
    if (!unloadedTarget) throw new Error('The second picker did not capture a target.');
    plugin.unload();
    expect(unloadedPanel.isConnected).toBe(false);
    expect(unloadedTarget.disposed).toBe(true);
    expect(plugin.commands.size).toBe(0);
    expect(plugin.slashItems.size).toBe(0);
    expect(getDatabaseProvider(POLARIS_DADOS_PROVIDER_ID)).toBeNull();
    expect(viewData(editor)).toEqual([]);
    expect(writes).not.toHaveBeenCalled();
    expect(fixture.vault.text(NOTE_PATH)).toBe(original);
  });

  it('requires API v1 and revalidates readonly or inactive sources immediately before insert', async () => {
    const fixture = await openFixture();
    const incompatible = createPluginHarness(fixture.session);
    const invalidApis = [
      { ...incompatible.api, data: { ...incompatible.api.data, version: 2 } },
      { ...incompatible.api, providers: { ...incompatible.api.providers, version: 2 } },
      {
        ...incompatible.api,
        editor: { insertion: { ...incompatible.api.editor.insertion, version: 2 } },
      },
    ];
    for (const api of invalidApis) {
      expect(() => activate(api as unknown as PolarisDadosPluginApi)).toThrow(/requires data API v1/i);
      expect(incompatible.commands.size).toBe(0);
      expect(incompatible.slashItems.size).toBe(0);
      expect(getDatabaseProvider(POLARIS_DADOS_PROVIDER_ID)).toBeNull();
    }
    incompatible.unload();

    setMainRoute(fixture.noteId);
    const writes = vi.spyOn(fixture.vault, 'apply');
    const harness = mountPageEditor(fixture.session, fixture.noteId);
    await harness.render();
    const editor = harness.editor;
    if (!editor) throw new Error('The real PageEditor did not mount.');
    await focusEditor(editor);
    await selectCursor(editor, 'middle', 2);
    const plugin = createPluginHarness(fixture.session);
    plugin.start();

    await runCommand(plugin);
    await chooseSource(fixture.sourceId);
    setPreferences({ readingMode: true });
    await clickPickerAction('insert');
    expect(viewData(editor)).toEqual([]);
    expect(picker().querySelector<HTMLOutputElement>('[data-polaris-action="status"]')?.textContent).toMatch(
      /read only/i,
    );

    setPreferences({ readingMode: false });
    await focusEditor(editor);
    await clickPickerAction('recapture');
    expect(picker().querySelector<HTMLSelectElement>('[data-polaris-action="source"]')?.value).toBe(
      fixture.sourceId,
    );
    await clickPickerAction('insert');
    expect(viewData(editor)).toHaveLength(1);

    await focusEditor(editor);
    await selectCursor(editor, 'South', 2);
    await runCommand(plugin);
    await chooseSource(fixture.sourceId);
    plugin.releaseProvider();
    await clickPickerAction('insert');
    expect(viewData(editor)).toHaveLength(1);
    expect(picker().querySelector<HTMLOutputElement>('[data-polaris-action="status"]')?.textContent).toMatch(
      /support/i,
    );
    expect(writes).not.toHaveBeenCalled();
  });

  it('reports a selected source that disappears before the explicit insert without changing the note', async () => {
    const fixture = await openFixture();
    setMainRoute(fixture.noteId);
    const writes = vi.spyOn(fixture.vault, 'apply');
    const harness = mountPageEditor(fixture.session, fixture.noteId);
    await harness.render();
    const editor = harness.editor;
    if (!editor) throw new Error('The real PageEditor did not mount.');
    await focusEditor(editor);
    await selectCursor(editor, 'middle', 2);
    const plugin = createPluginHarness(fixture.session);
    plugin.start();
    await runCommand(plugin);
    await chooseSource(fixture.sourceId);

    const removedPage = fixture.session.getState().pages[fixture.sourceId];
    if (!removedPage) throw new Error('The synthetic opted-in source is missing before the test change.');
    const accepted = fixture.session.applyExternal({
      pages: [],
      docs: {},
      removed: [fixture.sourceId],
      unreadable: [],
      readable: [],
    });
    expect(accepted).toContain(fixture.sourceId);
    await clickPickerAction('insert');
    expect(viewData(editor)).toEqual([]);
    expect(picker().querySelector<HTMLOutputElement>('[data-polaris-action="status"]')?.textContent).toMatch(
      /no longer available/i,
    );
    expect(writes).not.toHaveBeenCalled();
  });

  it('mounts a source and two linked roots over shared data while keeping view config local across save, disable, and reopen', async () => {
    const fixture = await openFixture();
    setMainRoute(fixture.noteId);
    const writes = vi.spyOn(fixture.vault, 'apply');
    const harness = mountPageEditor(fixture.session, fixture.noteId, fixture.sourceId);
    const plugin = createPluginHarness(fixture.session);
    plugin.start();
    await harness.render({ sourceRoot: true });
    const editor = harness.editor;
    if (!editor) throw new Error('The real PageEditor did not mount.');
    await until('the actual source provider root to mount', () =>
      Boolean(harness.container.querySelector('.database-provider-root:not(.polaris-dados-linked-provider-root) table')),
    );
    await focusEditor(editor);

    // An uncommitted note edit is already in the real editor when the picker captures its insertion point.
    await selectCursor(editor, 'South', 5);
    await act(async () => {
      expect(editor.commands.insertContent(' pending note text')).toBe(true);
    });
    expect(editorText(editor)).toContain('pending note text');
    expect(writes).not.toHaveBeenCalled();

    await selectCursor(editor, 'middle', 2);
    await runCommand(plugin);
    await chooseSource(fixture.sourceId);
    await clickPickerAction('insert');
    await focusEditor(editor);
    await runSlashAtText(plugin, editor, 'South');
    await chooseSource(fixture.sourceId);
    await clickPickerAction('insert');

    expect(viewData(editor)).toHaveLength(2);
    expect(new Set(viewData(editor).map((view) => view.viewId)).size).toBe(2);
    expect(editorText(editor)).toContain('pending note text');
    expect(writes).not.toHaveBeenCalled();
    // Sync the still-unsaved PageEditor draft into the synthetic session; no storage write occurs here.
    expect(commitEditors()).toBe(true);
    expect(writes).not.toHaveBeenCalled();
    await until('both linked provider roots to mount', () => providerRoots(harness).length === 2);
    const sourceRoot = harness.container.querySelector<HTMLElement>(
      '.database-provider-root:not(.polaris-dados-linked-provider-root)',
    );
    if (!sourceRoot) throw new Error('The source database provider root is missing.');
    const roots = providerRoots(harness);
    const records = plugin.providerContexts.filter((context) => context.view);
    expect(records).toHaveLength(2);
    expect(rowIds(sourceRoot)).toEqual([fixture.rowId]);
    expect(roots.map(rowIds)).toEqual([[fixture.rowId], [fixture.rowId]]);
    expect([sourceRoot, ...roots].map(gridTotal)).toEqual(['20', '20', '20']);
    expect(sourceRoot.querySelector('th[data-column-id="name"]')?.textContent).toBe('Name');
    for (const root of roots) {
      const virtualTitle = root.querySelector<HTMLElement>('td[data-row-title] span');
      const realName = root.querySelector<HTMLElement>('td[data-field="name"]');
      const sourceRow = readyData(plugin.data.snapshot(fixture.sourceId)).rows.find((row) => row.id === fixture.rowId);
      expect(root.querySelector('th[data-column-key="row-title"]')?.textContent).toBe('Row title');
      expect(virtualTitle?.textContent).toBe(sourceRow?.title);
      expect(realName?.textContent?.trim()).toBe('Catalog label');
      expect(virtualTitle?.textContent).not.toBe(realName?.textContent?.trim());
    }
    const views = viewData(editor);
    expect(views).toHaveLength(2);
    expect(new Set(views.map((view) => view.viewId)).size).toBe(2);
    for (const view of views) {
      expect(view.sourceDatabaseId).toBe(fixture.sourceId);
      expect(view.columnOrder).toEqual([]);
      expect(view.filter).toBeNull();
    }
    expect(topLevelContent(editor)).toEqual([
      { type: 'paragraph', text: 'North mi' },
      { type: 'polarisDadosView', viewId: views[0]!.viewId },
      { type: 'paragraph', text: 'ddle ' },
      { type: 'polarisDadosView', viewId: views[1]!.viewId },
      { type: 'paragraph', text: 'South pending note text' },
    ]);
    expect(writes).not.toHaveBeenCalled();

    const initialData = readyData(plugin.data.snapshot(fixture.sourceId));
    const row = initialData.rows.find((item) => item.id === fixture.rowId);
    expect(row?.properties.quantity).toBe(2);
    const changed = plugin.data.patchCell({
      databaseId: fixture.sourceId,
      rowId: fixture.rowId,
      propertyId: 'quantity',
      value: 3,
      expectedRevision: initialData.revision,
    });
    expect(changed.status).toBe('staged');
    await expect(plugin.data.flush(fixture.sourceId)).resolves.toMatchObject({ status: 'persisted' });
    await until('all three roots to recalculate 30', () => [sourceRoot, ...roots].every((root) => gridTotal(root) === '30'));
    expect(readyData(plugin.data.snapshot(fixture.sourceId)).rows[0]?.properties.quantity).toBe(3);

    const currentData = readyData(plugin.data.snapshot(fixture.sourceId));
    expect(plugin.data.history({
      databaseId: fixture.sourceId,
      direction: 'undo',
      expectedRevision: currentData.revision,
    }).status).toBe('staged');
    await expect(plugin.data.flush(fixture.sourceId)).resolves.toMatchObject({ status: 'persisted' });
    await until('all three roots to recalculate 20 after data undo', () =>
      [sourceRoot, ...roots].every((root) => gridTotal(root) === '20'),
    );

    const contextsByViewId = new Map(
      records.map((context) => {
        const ready = readyView(context);
        return [ready.snapshot.viewId, ready] as const;
      }),
    );
    const firstViewData = views[0]!;
    const secondViewData = views[1]!;
    const first = contextsByViewId.get(firstViewData.viewId);
    const second = contextsByViewId.get(secondViewData.viewId);
    if (!first || !second) throw new Error('The plugin did not mount both independent linked-view APIs.');
    const originalSecondConfig = second.snapshot.config;
    const configChange = first.api.patchConfig({
      patch: {
        title: 'First local heading',
        columnOrder: ['price'],
        filter: { propertyId: 'quantity', op: 'gte', value: 1 },
      },
      expectedRevision: first.snapshot.revision,
    });
    expect(configChange.status).toBe('staged');
    await expect(first.api.flush()).resolves.toMatchObject({ status: 'persisted' });
    expect(first.api.snapshot()).toMatchObject({
      status: 'ready',
      config: {
        title: 'First local heading',
        columnOrder: ['price'],
        filter: { propertyId: 'quantity', op: 'gte', value: 1 },
      },
    });
    expect(second.api.snapshot()).toMatchObject({ status: 'ready', config: originalSecondConfig });
    expect(readyData(plugin.data.snapshot(fixture.sourceId)).rows[0]?.properties.quantity).toBe(2);
    expect(readyData(plugin.data.snapshot(fixture.sourceId)).history.canUndo).toBe(false);

    const changedView = first.api.snapshot();
    if (changedView.status !== 'ready') throw new Error('The first view became unavailable after its config patch.');
    expect(first.api.history({ direction: 'undo', expectedRevision: changedView.revision }).status).toBe('staged');
    await expect(first.api.flush()).resolves.toMatchObject({ status: 'persisted' });
    expect(first.api.snapshot()).toMatchObject({
      status: 'ready',
      config: { title: firstViewData.title, columnOrder: [], filter: null },
    });
    expect(second.api.snapshot()).toMatchObject({ status: 'ready', config: originalSecondConfig });
    expect(readyData(plugin.data.snapshot(fixture.sourceId)).rows[0]?.properties.quantity).toBe(2);

    const undoneView = first.api.snapshot();
    if (undoneView.status !== 'ready') throw new Error('The first view became unavailable after config undo.');
    expect(first.api.history({ direction: 'redo', expectedRevision: undoneView.revision }).status).toBe('staged');
    await expect(first.api.flush()).resolves.toMatchObject({ status: 'persisted' });
    expect(first.api.snapshot()).toMatchObject({ status: 'ready', config: { title: 'First local heading' } });
    expect(second.api.snapshot()).toMatchObject({ status: 'ready', config: originalSecondConfig });
    expect(readyData(plugin.data.snapshot(fixture.sourceId)).rows[0]?.properties.quantity).toBe(2);

    expect(commitEditors()).toBe(true);
    await expect(fixture.session.flush()).resolves.toBe(true);
    const savedNote = fixture.vault.text(NOTE_PATH);
    expect(savedNote).toBeDefined();
    expect(savedNote).toContain('pending note text');
    for (const view of viewData(editor)) expect(savedNote).toContain(encodePolarisDadosViewMarker(view));
    const savedMarkers = savedNote?.match(/<!-- morrow:polaris-dados-view:v1:[A-Za-z0-9_-]+ -->/g) ?? [];
    expect(savedMarkers).toHaveLength(2);
    const savedViewData = savedMarkers.map(decodePolarisDadosViewMarker);
    expect(savedViewData).toEqual(viewData(editor));
    expect(savedViewData.find((view) => view?.viewId === firstViewData.viewId)).toEqual({
      version: 1,
      viewId: firstViewData.viewId,
      sourceDatabaseId: fixture.sourceId,
      title: 'First local heading',
      columnOrder: ['price'],
      filter: { propertyId: 'quantity', op: 'gte', value: 1 },
    });
    const writesBeforeDisable = writes.mock.calls.length;
    expect(writesBeforeDisable).toBeGreaterThan(0);

    plugin.unload();
    expect(viewData(editor)).toHaveLength(2);
    expect(harness.container.querySelectorAll('.polaris-dados-view-fallback')).toHaveLength(2);
    expect(fixture.vault.text(NOTE_PATH)).toBe(savedNote);
    expect(writes.mock.calls.length).toBe(writesBeforeDisable);

    await harness.unmount();
    await fixture.session.close();
    const reopenedSession = await openSession(fixture.vault);
    setMainRoute(fixture.noteId);
    const reopenedHarness = mountPageEditor(reopenedSession, fixture.noteId, fixture.sourceId);
    await reopenedHarness.render({ sourceRoot: true });
    const reopenedEditor = reopenedHarness.editor;
    if (!reopenedEditor) throw new Error('The reopened PageEditor did not mount.');
    await until('disabled fallback roots to render after reopen', () =>
      reopenedHarness.container.querySelectorAll('.polaris-dados-view-fallback').length === 2,
    );
    expect(viewData(reopenedEditor)).toHaveLength(2);
    expect(editorText(reopenedEditor)).toContain('pending note text');
    expect(writes.mock.calls.length).toBe(writesBeforeDisable);

    const reloadedPlugin = createPluginHarness(reopenedSession);
    reloadedPlugin.start();
    await until('source and linked roots to remount after plugin reload', () =>
      reopenedHarness.container.querySelectorAll('.database-provider-root').length === 3 &&
      reopenedHarness.container.querySelectorAll('.polaris-dados-linked-provider-root').length === 2,
    );
    const reloadedViews = reloadedPlugin.providerContexts.filter((context) => context.view);
    expect(reloadedViews).toHaveLength(2);
    const reloadedFirst = reloadedViews.map(readyView).find(({ snapshot }) => snapshot.viewId === firstViewData.viewId);
    if (!reloadedFirst) throw new Error('The first linked view did not survive disable and reload.');
    expect(reloadedFirst.snapshot.config).toMatchObject({
      title: 'First local heading',
      columnOrder: ['price'],
      filter: { propertyId: 'quantity', op: 'gte', value: 1 },
    });
    expect(reloadedViews.map(readyView).find(({ snapshot }) => snapshot.viewId === secondViewData.viewId)?.snapshot.config)
      .toEqual(originalSecondConfig);
    const reopenedSourceRoot = reopenedHarness.container.querySelector<HTMLElement>(
      '.database-provider-root:not(.polaris-dados-linked-provider-root)',
    );
    if (!reopenedSourceRoot) throw new Error('The source root did not mount after plugin reload.');
    expect([reopenedSourceRoot, ...providerRoots(reopenedHarness)].map(gridTotal))
      .toEqual(['20', '20', '20']);
    expect(writes.mock.calls.length).toBe(writesBeforeDisable);
    const reloadedFirstData = viewData(reopenedEditor).find((view) => view.viewId === firstViewData.viewId);
    if (!reloadedFirstData) throw new Error('The serialized first view is missing after reload.');
    expect(reloadedFirstData).toEqual(savedViewData.find((view) => view?.viewId === firstViewData.viewId));
    expect(docToMarkdown(reopenedEditor.state.doc.toJSON() as DocNode)).toContain(
      encodePolarisDadosViewMarker(reloadedFirstData),
    );
    expect(fixture.vault.text(NOTE_PATH)).toBe(savedNote);
  });
});
