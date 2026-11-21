// @vitest-environment happy-dom
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import type { Editor } from '@tiptap/core';
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDataApi } from '../../../../src/app/plugins/dataApi';
import type { DataApi } from '../../../../src/app/plugins/dataApi';
import type { DatabaseProviderContext } from '../../../../src/app/plugins/providerApi';
import { registerDatabaseProvider } from '../../../../src/app/plugins/providerRegistry';
import { PageEditor } from '../../../../src/app/editor/PageEditor';
import { ProviderDatabaseView } from '../../../../src/app/components/database/ProviderDatabaseView';
import { PaneContext, startTabs } from '../../../../src/app/tabs';
import { getPreferences, setPreferences } from '../../../../src/app/platform/preferences';
import { setSession } from '../../../../src/app/workspace';
import type { DocNode, PageId, PageMeta } from '../../../../src/core/model';
import { encodePolarisDadosViewMarker } from '../../../../src/core/polarisDadosView';
import type { PolarisDadosViewData } from '../../../../src/core/polarisDadosView';
import type { VaultScan } from '../../../../src/core/vault/load';
import type { VaultOp, VaultOpResult } from '../../../../src/core/vault/plan';
import type { VaultBridge, VaultChange, VaultFileInfo } from '../../../../src/storage/vaultBridge';
import { WorkspaceSession } from '../../../../src/storage/session';
import { VaultRepository } from '../../../../src/storage/vaultRepository';
import { mountPolarisDados } from './mount';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const DATABASE_ID = 'independent-text-source' as PageId;
const ROW_ID = 'independent-text-row' as PageId;
const NOTE_ID = 'independent-text-views' as PageId;
const VIEW_ONE = 'independent-text-view-one';
const VIEW_TWO = 'independent-text-view-two';
const DATABASE_PATH = 'Inventory.md';
const ROW_PATH = 'Inventory/Widget.md';
const NOTE_PATH = 'Views.md';
const INITIAL_TEXT = '  original 🌿\r\nsecond line\nlast  ';
const PROVIDER_ID = 'polaris-dados';
const OWNER_ID = 'independent-text-cell-owner';

const DATABASE = `---
kind: database
polarisDados:
  version: 1
  provider: polaris-dados
database:
  properties:
    - id: message
      name: Message
      type: text
    - id: quantity
      name: Quantity
      type: number
    - id: price
      name: Price
      type: number
    - id: total
      name: Total
      type: formula
      formula: Quantity * Price
  views:
    - id: table
      name: Table
      type: table
---
# Inventory
`;

const ROW = `---
Message: "  original 🌿\\r\\nsecond line\\nlast  "
Quantity: 2
Price: 10
vendorRecord:
  id: opaque-independent-row
  audit:
    source: synthetic
    tags: [keep, nested]
---
Synthetic widget row.
`;

const VIEW_DATA: readonly [PolarisDadosViewData, PolarisDadosViewData] = [
  {
    version: 1,
    viewId: VIEW_ONE,
    sourceDatabaseId: DATABASE_ID,
    title: 'First linked view',
    columnOrder: ['message'],
    filter: null,
  },
  {
    version: 1,
    viewId: VIEW_TWO,
    sourceDatabaseId: DATABASE_ID,
    title: 'Second linked view',
    columnOrder: ['quantity'],
    filter: null,
  },
];

class IndependentDiskVault implements VaultBridge {
  private readonly listeners = new Set<(changes: VaultChange[]) => void>();
  applyCount = 0;

  constructor(readonly root: string) {}

  private absolute(path: string): string {
    return join(this.root, ...path.split('/'));
  }

  async scan(): Promise<VaultScan> {
    const files: VaultScan['files'] = [];
    const folders: VaultScan['folders'] = [];
    const others: string[] = [];
    const visit = async (relative: string): Promise<void> => {
      const absolute = relative ? this.absolute(relative) : this.root;
      const entries = await readdir(absolute, { withFileTypes: true });
      if (relative) {
        const info = await stat(absolute);
        folders.push({ path: relative, mtime: info.mtimeMs, empty: entries.length === 0 });
      }
      for (const entry of entries) {
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await visit(path);
          continue;
        }
        const info = await stat(this.absolute(path));
        if (['.md', '.canvas'].includes(extname(path).toLowerCase())) {
          files.push({
            path,
            text: await readFile(this.absolute(path), 'utf8'),
            mtime: info.mtimeMs,
            birthtime: info.birthtimeMs,
          });
        } else others.push(path);
      }
    };
    await visit('');
    const readJson = async (path: string): Promise<unknown> => {
      const text = await this.readText(path);
      if (text === null) return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return null;
      }
    };
    return {
      files,
      folders,
      others,
      registry: await readJson('.morrow/workspace.json'),
      recent: await readJson('.morrow/recent.json'),
    };
  }

  async apply(ops: VaultOp[]): Promise<VaultOpResult[]> {
    this.applyCount += 1;
    const results: VaultOpResult[] = [];
    for (const op of ops) {
      try {
        if (op.op === 'check') {
          const current = await this.readText(op.path);
          if (current !== op.expect) {
            results.push({ ok: false, code: 'conflict', message: 'changed on disk', current });
            break;
          }
        } else if (op.op === 'write') {
          const current = await this.readText(op.path);
          if (op.expect !== undefined && current !== op.expect) {
            results.push({ ok: false, code: 'conflict', message: 'changed on disk', current });
            break;
          }
          await mkdir(dirname(this.absolute(op.path)), { recursive: true });
          await writeFile(this.absolute(op.path), op.text, 'utf8');
        } else if (op.op === 'rename') {
          if (!(await this.exists(op.from))) {
            if (op.optional) {
              results.push({ ok: true });
              continue;
            }
            results.push({ ok: false, code: 'error', message: `missing: ${op.from}` });
            break;
          }
          if (await this.exists(op.to)) {
            results.push({ ok: false, code: 'exists', message: `${op.to} exists` });
            break;
          }
          await mkdir(dirname(this.absolute(op.to)), { recursive: true });
          await rename(this.absolute(op.from), this.absolute(op.to));
        } else if (op.op === 'remove' || op.op === 'delete') {
          await unlink(this.absolute(op.path)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
        } else if (op.op === 'rmdir') {
          await rmdir(this.absolute(op.path)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
          });
        }
        results.push({ ok: true });
      } catch (error) {
        results.push({ ok: false, code: 'error', message: String(error) });
        break;
      }
    }
    return results;
  }

  async readText(path: string): Promise<string | null> {
    try {
      return await readFile(this.absolute(path), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async readBytes(path: string): Promise<ArrayBuffer | null> {
    try {
      const bytes = await readFile(this.absolute(path));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async createFile(path: string, data: ArrayBuffer): Promise<void> {
    await mkdir(dirname(this.absolute(path)), { recursive: true });
    await writeFile(this.absolute(path), new Uint8Array(data), { flag: 'wx' });
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(this.absolute(path));
      return true;
    } catch {
      return false;
    }
  }

  async listFiles(directory: string): Promise<VaultFileInfo[]> {
    const entries = await readdir(this.absolute(directory), { withFileTypes: true });
    const files: VaultFileInfo[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      const info = await stat(this.absolute(path));
      files.push({ path, size: info.size, mtime: info.mtimeMs });
    }
    return files;
  }

  onChange(listener: (changes: VaultChange[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  fileUrl(): null {
    return null;
  }
}

interface Fixture {
  readonly vault: IndependentDiskVault;
  readonly session: WorkspaceSession;
  readonly sourcePage: PageMeta;
  readonly linkedPage: PageMeta;
  readonly cleanups: Set<() => void>;
  close(): Promise<void>;
}

interface MountedSurfaces {
  readonly source: HTMLElement;
  readonly firstView: HTMLElement;
  readonly secondView: HTMLElement;
}

interface LiveHarness {
  readonly container: HTMLElement;
  readonly editor: Editor | null;
  render(): Promise<void>;
  unmount(): Promise<void>;
}

interface ProviderOwner {
  readonly data: DataApi;
  unregister(): void;
}

const fixtures = new Set<Fixture>();
const harnesses = new Set<LiveHarness>();
const owners = new Set<ProviderOwner>();
const tabListeners = new Set<() => void>();
let preferencesBeforeTest = getPreferences();
let fixtureSequence = 0;

function viewMarkdown(): string {
  return [
    '# Text linked views',
    '',
    encodePolarisDadosViewMarker(VIEW_DATA[0]),
    '',
    'Between linked views.',
    '',
    encodePolarisDadosViewMarker(VIEW_DATA[1]),
    '',
  ].join('\n');
}

async function makeDiskVault(): Promise<IndependentDiskVault> {
  const root = await mkdtemp(join(tmpdir(), 'morrow-e003-text-cell-independent-'));
  const pages = {
    [DATABASE_PATH]: { id: DATABASE_ID, created: 1, order: 0 },
    [ROW_PATH]: { id: ROW_ID, created: 2, order: 0 },
    [NOTE_PATH]: { id: NOTE_ID, created: 3, order: 1 },
  };
  const files: Record<string, string> = {
    [DATABASE_PATH]: DATABASE,
    [ROW_PATH]: ROW,
    [NOTE_PATH]: viewMarkdown(),
    '.morrow/workspace.json': JSON.stringify({ version: 1, pages }),
    '.morrow/recent.json': JSON.stringify({ version: 1, opened: {}, activity: {} }),
  };
  for (const [path, text] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, text, 'utf8');
  }
  return new IndependentDiskVault(root);
}

async function openSession(vault: IndependentDiskVault): Promise<WorkspaceSession> {
  const opened = await WorkspaceSession.open(
    new VaultRepository(vault, () => `independent-generated-${++fixtureSequence}`),
    { delayMs: 60_000 },
  );
  if (!opened.ok) throw new Error(opened.error);
  return opened.value;
}

async function openFixture(): Promise<Fixture> {
  const vault = await makeDiskVault();
  const session = await openSession(vault);
  const sourcePage = session.getState().pages[DATABASE_ID];
  const linkedPage = session.getState().pages[NOTE_ID];
  if (!sourcePage || !linkedPage) throw new Error('The synthetic source and linked page did not open.');
  setSession(session);
  const fixture: Fixture = {
    vault,
    session,
    sourcePage,
    linkedPage,
    cleanups: new Set(),
    async close() {
      for (const owner of [...owners]) owner.unregister();
      for (const cleanup of [...fixture.cleanups]) cleanup();
      fixture.cleanups.clear();
      if (!session.isClosed) await session.close();
      await rm(vault.root, { recursive: true, force: true });
      fixtures.delete(fixture);
    },
  };
  fixtures.add(fixture);
  return fixture;
}

function registerLiveProvider(fixture: Fixture, contexts: DatabaseProviderContext[]): ProviderOwner {
  let active = true;
  const data = createDataApi({
    session: fixture.session,
    ownerIsActive: () => active,
    isProviderActive: (databaseId) => active && databaseId === DATABASE_ID,
    isHostReadonly: () => fixture.session.isMutationFenced,
    registerCleanup: (cleanup) => fixture.cleanups.add(cleanup),
  });
  const unregisterRegistration = registerDatabaseProvider(OWNER_ID, () => active, data, {
    id: PROVIDER_ID,
    apiVersion: 1,
    mount(context) {
      contexts.push(context);
      return mountPolarisDados(context);
    },
  });
  let disposed = false;
  const owner: ProviderOwner = {
    data,
    unregister() {
      if (disposed) return;
      disposed = true;
      active = false;
      unregisterRegistration();
      owners.delete(owner);
    },
  };
  owners.add(owner);
  return owner;
}

function mountLivePage(fixture: Fixture): LiveHarness {
  const container = document.createElement('div');
  container.dataset.independentPage = String(harnesses.size + 1);
  document.body.append(container);
  const root = createRoot(container);
  let editor: Editor | null = null;
  let disposed = false;
  const render = async () => {
    await act(async () => {
      root.render(
        createElement(
          PaneContext.Provider,
          { value: 'main' },
          createElement(
            Fragment,
            null,
            createElement(ProviderDatabaseView, {
              key: 'independent-text-source',
              page: fixture.sourcePage,
              editable: true,
            }),
            createElement(PageEditor, {
              key: 'independent-text-linked-page',
              pageId: NOTE_ID,
              doc: fixture.session.getState().docs[NOTE_ID] as DocNode,
              editable: true,
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
  const unmount = async () => {
    if (disposed) return;
    await act(async () => root.unmount());
    container.remove();
    disposed = true;
    harnesses.delete(harness);
  };
  const harness: LiveHarness = {
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

function surfacesIn(
  harness: LiveHarness,
  contexts: readonly DatabaseProviderContext[],
): MountedSurfaces | null {
  const active = contexts.filter(
    (context) => !context.signal.aborted && harness.container.contains(context.element),
  );
  const source = active.find((context) => !context.view)?.element;
  const views = new Map<string, HTMLElement>();
  for (const context of active) {
    if (!context.view) continue;
    const snapshot = context.view.snapshot();
    if (snapshot.status === 'ready') views.set(snapshot.viewId, context.element);
  }
  const firstView = views.get(VIEW_ONE);
  const secondView = views.get(VIEW_TWO);
  return source && firstView && secondView ? { source, firstView, secondView } : null;
}

async function until(description: string, predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function waitForSurfaces(
  harness: LiveHarness,
  contexts: readonly DatabaseProviderContext[],
): Promise<MountedSurfaces> {
  let found: MountedSurfaces | null = null;
  await until('the real Source React root and two linked TipTap providers to mount', () => {
    found = surfacesIn(harness, contexts);
    return Boolean(
      found && [found.source, found.firstView, found.secondView].every((root) => root.querySelector('table')),
    );
  });
  if (!found) throw new Error('The real provider surfaces did not mount.');
  return found;
}

function editButton(root: HTMLElement): HTMLButtonElement {
  const button = root.querySelector<HTMLButtonElement>(
    'button[data-action="edit"][data-row-id="' + ROW_ID + '"][data-field="message"]',
  );
  if (!button) throw new Error('The text cell has no Edit button.');
  return button;
}

function openEditor(root: HTMLElement): HTMLTextAreaElement {
  editButton(root).click();
  const editor = root.querySelector<HTMLTextAreaElement>('textarea[data-field="message"]');
  if (!editor) throw new Error('The text cell did not open an editor.');
  return editor;
}

function saveButton(root: HTMLElement): HTMLButtonElement {
  const button = root.querySelector<HTMLButtonElement>('button[data-action="save"]');
  if (!button) throw new Error('The text editor has no Save button.');
  return button;
}

function cancelButton(root: HTMLElement): HTMLButtonElement {
  const button = root.querySelector<HTMLButtonElement>('button[data-action="cancel"]');
  if (!button) throw new Error('The text editor has no Cancel button.');
  return button;
}

function dispatchInput(control: HTMLTextAreaElement): void {
  control.dispatchEvent(new Event('input', { bubbles: true }));
}

function rowProperties(data: DataApi): Readonly<Record<string, unknown>> {
  const snapshot = data.snapshot(DATABASE_ID);
  if (snapshot.status !== 'ready') throw new Error('The source database is not ready.');
  const row = snapshot.rows.find((candidate) => candidate.id === ROW_ID);
  if (!row) throw new Error('The source row is missing.');
  return row.properties;
}

function sessionReader(fixture: Fixture): DataApi {
  return createDataApi({
    session: fixture.session,
    ownerIsActive: () => true,
    isProviderActive: (databaseId) => databaseId === DATABASE_ID,
    isHostReadonly: () => fixture.session.isMutationFenced,
    registerCleanup: (cleanup) => fixture.cleanups.add(cleanup),
  });
}

async function waitForSaved(root: HTMLElement): Promise<void> {
  await until('the text edit to be flushed', () =>
    /saved|salv|guardad/i.test(root.querySelector('[data-current-notice]')?.textContent ?? ''),
  );
}

async function runAct(callback: () => void | Promise<void>): Promise<void> {
  await act(async () => callback());
}

beforeEach(() => {
  preferencesBeforeTest = getPreferences();
  setPreferences({ locale: 'en', readingMode: false });
});

afterEach(async () => {
  for (const harness of [...harnesses]) await harness.unmount();
  for (const owner of [...owners]) owner.unregister();
  for (const stop of [...tabListeners]) {
    stop();
    tabListeners.delete(stop);
  }
  for (const fixture of [...fixtures]) await fixture.close();
  setPreferences({ locale: preferencesBeforeTest.locale, readingMode: preferencesBeforeTest.readingMode });
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('independent text-cell validation through real host providers', () => {
  it('isolates same-ID Source and Linked drafts across locale, reading mode, and provider reload', async () => {
    const fixture = await openFixture();
    const contexts: DatabaseProviderContext[] = [];
    const stopTabs = startTabs();
    tabListeners.add(stopTabs);
    const originalBytes = await fixture.vault.readText(ROW_PATH);
    const patchSpy = vi.spyOn(fixture.session, 'patchPilotDataCell');
    let owner = registerLiveProvider(fixture, contexts);
    const firstPage = mountLivePage(fixture);
    const secondPage = mountLivePage(fixture);
    await firstPage.render();
    await secondPage.render();
    const editor = firstPage.editor;
    if (!editor) throw new Error('The real TipTap linked editor did not mount.');
    let first = await waitForSurfaces(firstPage, contexts);
    let second = await waitForSurfaces(secondPage, contexts);
    const roots = [
      first.source,
      first.firstView,
      first.secondView,
      second.source,
      second.firstView,
      second.secondView,
    ];
    const drafts = [
      'Source A draft 組合',
      'View one A draft 🌱',
      'View two A draft 🌳',
      'Source B draft 🪴',
      'View one B draft 🌵',
      'View two B draft\nsecond line 🌾',
    ];
    const selections = [3, 5, 7, 4, 6, 8];
    const textareas = roots.map((root, index) => {
      const textarea = openEditor(root);
      textarea.value = drafts[index]!;
      textarea.setSelectionRange(selections[index]!, selections[index]!);
      dispatchInput(textarea);
      expect(textarea.getAttribute('aria-label')).toMatch(/message/i);
      expect(saveButton(root).type).toBe('button');
      expect(cancelButton(root).type).toBe('button');
      return textarea;
    });
    expect(rowProperties(owner.data).message).toBe(INITIAL_TEXT);
    expect(fixture.session.pilotDataHistorySnapshot(DATABASE_ID)).toEqual({ canUndo: false, canRedo: false });
    expect(patchSpy).not.toHaveBeenCalled();
    expect(await fixture.vault.readText(ROW_PATH)).toBe(originalBytes);

    const keydownCount = { value: 0 };
    secondPage.container.addEventListener('keydown', () => keydownCount.value++);
    textareas[5]!.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const compositionEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(compositionEnter, 'isComposing', { value: true });
    textareas[5]!.dispatchEvent(compositionEnter);
    expect(compositionEnter.defaultPrevented).toBe(false);
    expect(keydownCount.value).toBe(0);
    textareas[5]!.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    const newlineEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    textareas[5]!.dispatchEvent(newlineEnter);
    expect(newlineEnter.defaultPrevented).toBe(false);
    expect(keydownCount.value).toBe(0);
    const localUndo = new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    textareas[5]!.dispatchEvent(localUndo);
    expect(localUndo.defaultPrevented).toBe(false);
    expect(keydownCount.value).toBe(0);
    expect(fixture.session.pilotDataHistorySnapshot(DATABASE_ID)).toEqual({ canUndo: false, canRedo: false });

    await runAct(() => setPreferences({ locale: 'es' }));
    first = await waitForSurfaces(firstPage, contexts);
    second = await waitForSurfaces(secondPage, contexts);
    const spanishRoots = [
      first.source,
      first.firstView,
      first.secondView,
      second.source,
      second.firstView,
      second.secondView,
    ];
    spanishRoots.forEach((root, index) => {
      const textarea = root.querySelector<HTMLTextAreaElement>('textarea[data-field="message"]');
      expect(textarea?.value).toBe(drafts[index]);
      expect(saveButton(root).textContent).toBe('Guardar');
    });
    const focusedAfterLocale = second.secondView.querySelector<HTMLTextAreaElement>(
      'textarea[data-field="message"]',
    );
    await until(
      'the linked editor caret to reattach after locale remount',
      () =>
        document.activeElement === focusedAfterLocale && focusedAfterLocale?.selectionStart === selections[5],
    );
    expect(document.activeElement).toBe(focusedAfterLocale);

    await runAct(() => setPreferences({ readingMode: true }));
    first = await waitForSurfaces(firstPage, contexts);
    second = await waitForSurfaces(secondPage, contexts);
    const readonlyRoots = [
      first.source,
      first.firstView,
      first.secondView,
      second.source,
      second.firstView,
      second.secondView,
    ];
    readonlyRoots.forEach((root, index) => {
      const textarea = root.querySelector<HTMLTextAreaElement>('textarea[data-field="message"]');
      expect(textarea?.value).toBe(drafts[index]);
      expect(textarea?.readOnly).toBe(true);
      expect(cancelButton(root).disabled).toBe(false);
    });
    expect(patchSpy).not.toHaveBeenCalled();
    expect(await fixture.vault.readText(ROW_PATH)).toBe(originalBytes);

    await runAct(() => setPreferences({ locale: 'pt', readingMode: false }));
    first = await waitForSurfaces(firstPage, contexts);
    second = await waitForSurfaces(secondPage, contexts);
    const editableRoots = [
      first.source,
      first.firstView,
      first.secondView,
      second.source,
      second.firstView,
      second.secondView,
    ];
    editableRoots.forEach((root, index) => {
      const textarea = root.querySelector<HTMLTextAreaElement>('textarea[data-field="message"]');
      expect(textarea?.value).toBe(drafts[index]);
      expect(textarea?.readOnly).toBe(false);
    });

    const previousContexts = contexts.filter((context) => !context.signal.aborted);
    await runAct(() => owner.unregister());
    expect(previousContexts.every((context) => context.signal.aborted)).toBe(true);
    await until(
      'both actual editors to show provider fallbacks',
      () =>
        firstPage.container.querySelectorAll('.polaris-dados-view-fallback').length === 2 &&
        secondPage.container.querySelectorAll('.polaris-dados-view-fallback').length === 2,
    );
    owner = registerLiveProvider(fixture, contexts);
    first = await waitForSurfaces(firstPage, contexts);
    second = await waitForSurfaces(secondPage, contexts);
    const reloadedRoots = [
      first.source,
      first.firstView,
      first.secondView,
      second.source,
      second.firstView,
      second.secondView,
    ];
    reloadedRoots.forEach((root, index) => {
      const textarea = root.querySelector<HTMLTextAreaElement>('textarea[data-field="message"]');
      expect(textarea?.value).toBe(drafts[index]);
      expect(textarea?.readOnly).toBe(false);
    });
    expect(patchSpy).not.toHaveBeenCalled();
    expect(await fixture.vault.readText(ROW_PATH)).toBe(originalBytes);

    const staleRootPropagation = { value: 0 };
    firstPage.container.addEventListener('keydown', () => staleRootPropagation.value++);
    await runAct(() => saveButton(first.source).click());
    await waitForSaved(first.source);
    expect(rowProperties(owner.data).message).toBe(drafts[0]);
    expect(patchSpy).toHaveBeenCalledOnce();
    await until('other same-ID mounts to fence and retain their stale drafts', () =>
      reloadedRoots.slice(1).every((root) => {
        const textarea = root.querySelector<HTMLTextAreaElement>('textarea[data-field="message"]');
        return Boolean(textarea?.readOnly && textarea.value);
      }),
    );
    reloadedRoots.slice(1).forEach((root, index) => {
      const textarea = root.querySelector<HTMLTextAreaElement>('textarea[data-field="message"]');
      expect(textarea?.value).toBe(drafts[index + 1]);
      expect(textarea?.readOnly).toBe(true);
      textarea?.select();
      expect(textarea?.selectionStart).toBe(0);
      expect(cancelButton(root).disabled).toBe(false);
      if (index === 1) {
        const escape = new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        });
        textarea?.dispatchEvent(escape);
        expect(escape.defaultPrevented).toBe(true);
      } else cancelButton(root).click();
      expect(root.querySelector('textarea[data-field="message"]')).toBeNull();
    });
    expect(staleRootPropagation.value).toBe(0);
    expect(patchSpy).toHaveBeenCalledOnce();
  });

  it('keeps a backend-fenced draft through abort, retries an accepted sync-unmounted patch by flush only, and reopens disk', async () => {
    const fixture = await openFixture();
    const contexts: DatabaseProviderContext[] = [];
    const stopTabs = startTabs();
    tabListeners.add(stopTabs);
    let owner = registerLiveProvider(fixture, contexts);
    const harness = mountLivePage(fixture);
    await harness.render();
    if (!harness.editor) throw new Error('The real TipTap linked editor did not mount.');
    let roots = await waitForSurfaces(harness, contexts);
    const sourceTextarea = openEditor(roots.source);
    const expectedText = 'the same draft crosses a backend fence and provider reload';
    sourceTextarea.value = expectedText;
    sourceTextarea.setSelectionRange(12, 20);
    dispatchInput(sourceTextarea);
    const originalBytes = await fixture.vault.readText(ROW_PATH);
    const writesBefore = fixture.vault.applyCount;
    const originalPatch = fixture.session.patchPilotDataCell.bind(fixture.session);
    const patchSpy = vi.spyOn(fixture.session, 'patchPilotDataCell');
    const flushSpy = vi.spyOn(fixture.session, 'flush');
    const results: ReturnType<typeof fixture.session.patchPilotDataCell>[] = [];
    let injectFence = true;
    const fenceLease: { release: (() => void) | null } = { release: null };
    patchSpy.mockImplementation((input) => {
      if (injectFence) {
        injectFence = false;
        fenceLease.release = fixture.session.beginMutationFence();
      }
      const result = originalPatch(input);
      results.push(result);
      return result;
    });

    try {
      expect(saveButton(roots.source).disabled).toBe(false);
      expect(roots.source.querySelector<HTMLTextAreaElement>('textarea[data-field="message"]')?.value).toBe(
        expectedText,
      );
      await runAct(() => saveButton(roots.source).click());
      expect(results[0]).toMatchObject({ ok: false, code: 'read-only' });
      expect(patchSpy).toHaveBeenCalledOnce();
      expect(flushSpy).not.toHaveBeenCalled();
      expect(fixture.session.isMutationFenced).toBe(true);
      expect(rowProperties(owner.data).message).toBe(INITIAL_TEXT);
      expect(fixture.session.pilotDataHistorySnapshot(DATABASE_ID)).toEqual({
        canUndo: false,
        canRedo: false,
      });
      expect(fixture.vault.applyCount).toBe(writesBefore);
      expect(await fixture.vault.readText(ROW_PATH)).toBe(originalBytes);
      const refused = roots.source.querySelector<HTMLTextAreaElement>('textarea[data-field="message"]');
      expect(refused?.value).toBe(expectedText);
      expect(refused?.readOnly).toBe(true);
      expect(saveButton(roots.source).disabled).toBe(false);

      const refusedContexts = contexts.filter((context) => !context.signal.aborted);
      await runAct(() => owner.unregister());
      expect(refusedContexts.every((context) => context.signal.aborted)).toBe(true);
      expect(fixture.vault.applyCount).toBe(writesBefore);
      owner = registerLiveProvider(fixture, contexts);
      roots = await waitForSurfaces(harness, contexts);
      const restoredFenceDraft = roots.source.querySelector<HTMLTextAreaElement>(
        'textarea[data-field="message"]',
      );
      expect(restoredFenceDraft?.value).toBe(expectedText);
      expect(restoredFenceDraft?.readOnly).toBe(true);
      expect(roots.source.querySelector('button[data-action="retry"]')).toBeNull();
      expect(patchSpy).toHaveBeenCalledOnce();

      fenceLease.release?.();
      fenceLease.release = null;
      expect(fixture.session.isMutationFenced).toBe(false);
      expect(restoredFenceDraft?.value).toBe(expectedText);

      let didUnloadAfterAcceptance = false;
      const unsubscribe = fixture.session.subscribe(() => {
        if (didUnloadAfterAcceptance || rowProperties(owner.data).message !== expectedText) return;
        didUnloadAfterAcceptance = true;
        owner.unregister();
      });
      try {
        await runAct(() => saveButton(roots.source).click());
      } finally {
        unsubscribe();
      }
      expect(didUnloadAfterAcceptance).toBe(true);
      expect(results).toHaveLength(2);
      expect(results[1]).toMatchObject({ ok: true });
      expect(patchSpy).toHaveBeenCalledTimes(2);
      expect(flushSpy).not.toHaveBeenCalled();
      expect(rowProperties(sessionReader(fixture)).message).toBe(expectedText);
      const stagedSnapshot = fixture.session.pilotDataHistorySnapshot(DATABASE_ID);
      expect(stagedSnapshot).toEqual({ canUndo: true, canRedo: false });
      expect(fixture.vault.applyCount).toBe(writesBefore);
      expect(await fixture.vault.readText(ROW_PATH)).toBe(originalBytes);

      owner = registerLiveProvider(fixture, contexts);
      roots = await waitForSurfaces(harness, contexts);
      expect(roots.source.querySelector('textarea[data-field="message"]')).toBeNull();
      expect(roots.source.querySelector<HTMLButtonElement>('button[data-action="retry"]')?.disabled).toBe(
        false,
      );
      expect(patchSpy).toHaveBeenCalledTimes(2);
      await runAct(() =>
        roots.source.querySelector<HTMLButtonElement>('button[data-action="retry"]')?.click(),
      );
      await waitForSaved(roots.source);
      expect(patchSpy).toHaveBeenCalledTimes(2);
      expect(flushSpy).toHaveBeenCalledOnce();
      expect(rowProperties(owner.data).message).toBe(expectedText);
      expect(fixture.session.pilotDataHistorySnapshot(DATABASE_ID)).toEqual({
        canUndo: true,
        canRedo: false,
      });
      expect(await fixture.vault.readText(ROW_PATH)).not.toBe(originalBytes);

      const undoSnapshot = owner.data.snapshot(DATABASE_ID);
      if (undoSnapshot.status !== 'ready') throw new Error('The saved source snapshot was not ready.');
      expect(
        owner.data.history({
          databaseId: DATABASE_ID,
          direction: 'undo',
          expectedRevision: undoSnapshot.revision,
        }),
      ).toMatchObject({ status: 'staged', direction: 'undo' });
      const afterUndo = owner.data.snapshot(DATABASE_ID);
      expect(afterUndo.status).toBe('ready');
      if (afterUndo.status !== 'ready') throw new Error('The undo snapshot was not ready.');
      expect(afterUndo.rows.find((row) => row.id === ROW_ID)?.properties.message).toBe(INITIAL_TEXT);
      expect(afterUndo.history).toEqual({ canUndo: false, canRedo: true });
      expect(
        owner.data.history({
          databaseId: DATABASE_ID,
          direction: 'undo',
          expectedRevision: afterUndo.revision,
        }),
      ).toMatchObject({ status: 'no-op', direction: 'undo' });

      const redoSnapshot = owner.data.snapshot(DATABASE_ID);
      if (redoSnapshot.status !== 'ready') throw new Error('The redo source snapshot was not ready.');
      expect(
        owner.data.history({
          databaseId: DATABASE_ID,
          direction: 'redo',
          expectedRevision: redoSnapshot.revision,
        }),
      ).toMatchObject({ status: 'staged', direction: 'redo' });
      expect(await owner.data.flush(DATABASE_ID)).toMatchObject({ status: 'persisted' });
      expect(rowProperties(owner.data).message).toBe(expectedText);
      expect(fixture.session.pilotDataHistorySnapshot(DATABASE_ID)).toEqual({
        canUndo: true,
        canRedo: false,
      });
      expect(patchSpy).toHaveBeenCalledTimes(2);

      await harness.unmount();
      owner.unregister();
      await fixture.session.close();
      const reopened = await openSession(fixture.vault);
      setSession(reopened);
      const reopenedData = createDataApi({
        session: reopened,
        ownerIsActive: () => true,
        isProviderActive: (databaseId) => databaseId === DATABASE_ID,
        isHostReadonly: () => reopened.isMutationFenced,
        registerCleanup: () => {},
      });
      expect(rowProperties(reopenedData).message).toBe(expectedText);
      expect(reopenedData.snapshot(DATABASE_ID)).toMatchObject({
        status: 'ready',
        history: { canUndo: false, canRedo: false },
      });
      await reopened.close();
    } finally {
      fenceLease.release?.();
      patchSpy.mockRestore();
      flushSpy.mockRestore();
    }
  });
});
