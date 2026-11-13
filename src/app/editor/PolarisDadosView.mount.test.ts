// @vitest-environment happy-dom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageId } from '../../core/model';
import { encodePolarisDadosViewMarker } from '../../core/polarisDadosView';
import { E003_POLARIS_DADOS_FIXTURE } from '../../storage/fixtures/e003-polaris-dados';
import { MemoryVault } from '../../storage/memoryVault';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';
import type { DataApi, DataApiSnapshot } from '../plugins/dataApi';
import type { DatabaseProviderContext } from '../plugins/providerApi';
import { registerDatabaseProvider } from '../plugins/providerRegistry';
import { getPreferences, setPreferences } from '../platform/preferences';
import { createExtensions } from './extensions';

const NOTE_ID = 'linked-views-note' as PageId;
const SOURCE_ID = 'inventory-source' as PageId;
const ROW_ID = 'inventory-widget' as PageId;
const views = [
  {
    version: 1 as const,
    viewId: 'view-one',
    sourceDatabaseId: SOURCE_ID,
    title: 'First view',
    columnOrder: ['name'],
    filter: null,
  },
  {
    version: 1 as const,
    viewId: 'view-two',
    sourceDatabaseId: SOURCE_ID,
    title: 'Second view',
    columnOrder: ['quantity'],
    filter: null,
  },
];

let editor: Editor | null = null;
const sessions = new Set<WorkspaceSession>();
const providerReleases = new Set<() => void>();
const editorContainers = new Set<HTMLElement>();
const originalPreferences = getPreferences();
let generatedPageId = 0;

async function openSession(): Promise<WorkspaceSession> {
  const files = {
    'Inventory.md': E003_POLARIS_DADOS_FIXTURE['Inventory.md']!,
    'Inventory/Widget.md': E003_POLARIS_DADOS_FIXTURE['Inventory/Widget.md']!,
    'Views.md': [
      '# Linked views',
      '',
      ...views.flatMap((view, index) => [
        encodePolarisDadosViewMarker(view),
        ...(index < views.length - 1 ? ['', 'Between views.', ''] : []),
      ]),
      '',
    ].join('\n'),
    '.morrow/workspace.json': JSON.stringify({
      version: 1,
      pages: {
        'Inventory.md': { id: SOURCE_ID, created: 1, order: 0 },
        'Inventory/Widget.md': { id: ROW_ID, created: 2, order: 0 },
        'Views.md': { id: NOTE_ID, created: 3, order: 1 },
      },
    }),
    '.morrow/recent.json': JSON.stringify({ version: 1, opened: {}, activity: {} }),
  };
  const opened = await WorkspaceSession.open(
    new VaultRepository(new MemoryVault(files), () => `unexpected-generated-id-${++generatedPageId}`),
    { delayMs: 0 },
  );
  if (!opened.ok) throw new Error(opened.error);
  sessions.add(opened.value);
  return opened.value;
}

function sharedData(): DataApi {
  const listeners = new Set<(snapshot: DataApiSnapshot) => void>();
  let quantity = 2;
  let revision = 0;
  let canUndo = false;
  const snapshot = (): DataApiSnapshot => ({
    version: 1,
    status: 'ready',
    databaseId: SOURCE_ID,
    revision: `r${revision}`,
    schema: { properties: [{ id: 'quantity', name: 'Quantity', type: 'number', options: [] }], views: [] },
    rows: [{ id: ROW_ID, title: 'Widget', properties: { quantity } }],
    history: { canUndo, canRedo: false },
    readonly: false,
    diagnostic: null,
  });
  return {
    version: 1,
    snapshot(databaseId) {
      if (databaseId !== SOURCE_ID) throw new Error('out of scope');
      return snapshot();
    },
    patchCell(input) {
      if (input.databaseId !== SOURCE_ID)
        return { status: 'error', code: 'out-of-scope', message: 'out of scope' };
      if (input.expectedRevision !== `r${revision}`)
        return { status: 'error', code: 'stale-revision', message: 'stale' };
      quantity = input.value;
      revision++;
      canUndo = true;
      const next = snapshot();
      for (const listener of listeners) listener(next);
      return {
        status: 'staged',
        databaseId: SOURCE_ID,
        rowId: ROW_ID,
        propertyId: input.propertyId,
        revision: next.revision,
      };
    },
    history(input) {
      return { status: 'no-op', databaseId: SOURCE_ID, revision: `r${revision}`, direction: input.direction };
    },
    subscribe(databaseId, listener) {
      if (databaseId !== SOURCE_ID) throw new Error('out of scope');
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
    async flush() {
      return { status: 'persisted', databaseId: SOURCE_ID, revision: `r${revision}` };
    },
  };
}

function mountEditor(session: WorkspaceSession): Editor {
  const container = document.createElement('div');
  document.body.append(container);
  editorContainers.add(container);
  editor = new Editor({
    element: container,
    extensions: createExtensions({
      onBlockMenu: () => {},
      resolvePage: () => null,
      openTag: () => {},
      createChild: () => null,
      openDate: () => {},
      pages: () => [],
      createPage: () => null,
      renderEmbed: () => {},
      linkedViewContext: { session, pageId: NOTE_ID },
    } as never),
    content: session.getState().docs[NOTE_ID] as never,
  });
  return editor;
}

function nodePositions(target: Editor): number[] {
  const result: number[] = [];
  target.state.doc.descendants((node, position) => {
    if (node.type.name === 'polarisDadosView') result.push(position);
  });
  return result;
}

function registerTestProvider(mount: (context: DatabaseProviderContext) => void | (() => void)): () => void {
  const release = registerDatabaseProvider('linked-view-test', () => true, sharedData(), {
    id: 'polaris-dados',
    apiVersion: 1,
    mount,
  });
  providerReleases.add(release);
  return release;
}

afterEach(async () => {
  editor?.destroy();
  editor = null;
  for (const container of editorContainers) container.remove();
  editorContainers.clear();
  for (const release of providerReleases) release();
  providerReleases.clear();
  setPreferences({ locale: originalPreferences.locale, readingMode: originalPreferences.readingMode });
  for (const session of sessions) await session.close();
  sessions.clear();
});

describe('linked-view provider mounts', () => {
  it('shares source data and preserves each provider root for config-only updates', async () => {
    const session = await openSession();
    const contexts: DatabaseProviderContext[] = [];
    registerTestProvider((context) => {
      contexts.push(context);
      context.element.append(document.createElement('input'));
      return () => {};
    });
    const target = mountEditor(session);
    const positions = nodePositions(target);
    expect(positions).toHaveLength(2);
    expect(contexts).toHaveLength(2);
    expect(contexts.map((context) => context.view?.snapshot())).toMatchObject([
      { status: 'ready', viewId: 'view-one', config: { title: 'First view' } },
      { status: 'ready', viewId: 'view-two', config: { title: 'Second view' } },
    ]);

    const firstSnapshot = contexts[0]!.data.snapshot(SOURCE_ID);
    if (firstSnapshot.status !== 'ready') throw new Error('Expected source data.');
    expect(
      contexts[0]!.data.patchCell({
        databaseId: SOURCE_ID,
        rowId: ROW_ID,
        propertyId: 'quantity',
        value: 3,
        expectedRevision: firstSnapshot.revision,
      }),
    ).toMatchObject({ status: 'staged' });
    expect(contexts[1]!.data.snapshot(SOURCE_ID)).toMatchObject({
      rows: [{ id: ROW_ID, properties: { quantity: 3 } }],
      history: { canUndo: true },
    });

    const firstRoot = contexts[0]!.element;
    const input = firstRoot.querySelector('input')!;
    input.focus();
    const node = target.state.doc.nodeAt(positions[0]!)!;
    target.view.dispatch(
      target.state.tr.setNodeMarkup(positions[0]!, undefined, {
        ...node.attrs,
        title: 'Updated title',
      }),
    );
    expect(contexts).toHaveLength(2);
    expect(contexts[0]!.element).toBe(firstRoot);
    expect(target.view.dom.ownerDocument.activeElement).toBe(input);
  });

  it('aborts and restores a trashed owner note with a new handle generation', async () => {
    const session = await openSession();
    const contexts: DatabaseProviderContext[] = [];
    registerTestProvider((context) => {
      contexts.push(context);
      context.element.append(document.createElement('button'));
      return () => {};
    });
    const target = mountEditor(session);
    const originalHandles = contexts.map((context) => context.view);
    expect(session.execute({ type: 'page.trash', id: NOTE_ID, now: 10 }).ok).toBe(true);
    expect(contexts.every((context) => context.signal.aborted)).toBe(true);
    expect(target.view.dom.textContent).toContain('no longer available in this note');
    const restored = session.execute({ type: 'page.restore', id: NOTE_ID });
    if (!restored.ok) throw new Error(restored.error);
    expect(contexts).toHaveLength(4);
    expect(contexts[2]!.view).not.toBe(originalHandles[0]);
    expect(contexts[3]!.view).not.toBe(originalHandles[1]);
  });

  it('remounts with current locale/readonly context and rejects writes in reading mode', async () => {
    const session = await openSession();
    const contexts: DatabaseProviderContext[] = [];
    registerTestProvider((context) => {
      contexts.push(context);
      context.element.append(document.createElement('button'));
      return () => {};
    });
    const target = mountEditor(session);
    expect(contexts).toHaveLength(2);
    setPreferences({ locale: 'es', readingMode: true });
    expect(contexts).toHaveLength(4);
    expect(contexts.slice(2).map(({ locale, editable }) => ({ locale, editable }))).toEqual([
      { locale: 'es', editable: false },
      { locale: 'es', editable: false },
    ]);
    expect(target.view.dom.querySelector('[data-morrow-database-provider]')).not.toBeNull();
    const snapshot = contexts[2]!.data.snapshot(SOURCE_ID);
    expect(snapshot).toMatchObject({ readonly: true, history: { canUndo: false, canRedo: false } });
    if (snapshot.status !== 'ready') throw new Error('Expected a readonly source snapshot.');
    expect(
      contexts[2]!.data.patchCell({
        databaseId: SOURCE_ID,
        rowId: ROW_ID,
        propertyId: 'quantity',
        value: 4,
        expectedRevision: snapshot.revision,
      }),
    ).toMatchObject({ status: 'error', code: 'host-readonly' });
    expect(getPreferences().locale).toBe('es');
  });

  it('runs cleanup returned by a provider that unloads reentrantly from mount', async () => {
    const session = await openSession();
    const cleanup = vi.fn();
    let mountCount = 0;
    let unregister = () => {};
    unregister = registerTestProvider((context) => {
      mountCount++;
      context.element.append(document.createElement('button'));
      unregister();
      return cleanup;
    });
    const target = mountEditor(session);
    expect(mountCount).toBeGreaterThan(0);
    expect(cleanup).toHaveBeenCalledTimes(mountCount);
    expect(target.view.dom.textContent).toContain('provider is unavailable');
    expect(target.view.dom.querySelector('[data-morrow-database-provider]')).toBeNull();
  });
});
