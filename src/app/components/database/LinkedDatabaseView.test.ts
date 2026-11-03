import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { newView } from '../../../core/database';
import type { DatabaseDef, ViewDef } from '../../../core/model';
import { MemoryVault } from '../../../storage/memoryVault';
import { WorkspaceSession } from '../../../storage/session';
import { VaultRepository } from '../../../storage/vaultRepository';
import { getPreferences, setPreferences } from '../../platform/preferences';
import { setSession } from '../../workspace';
import {
  LinkedDatabaseViewNode,
  linkedViewNodeIdentityMatches,
  linkedViewSourceCompatibility,
  runIfEditorEditable,
  runLinkedViewLayoutAction,
  subscribeToEditorEditable,
} from './LinkedDatabaseView';

vi.mock('@tiptap/react', () => ({
  NodeViewWrapper: ({
    children,
    className,
    contentEditable,
  }: {
    children?: ReactNode;
    className?: string;
    contentEditable?: boolean;
  }) => createElement('div', { className, contentEditable }, children),
}));

describe('linked database hidden title', () => {
  it('keeps the linked title block-local and removes persistent title and source controls', async () => {
    let nextId = 0;
    const newId = () => `linked-title-${++nextId}`;
    const sessionResult = await WorkspaceSession.open(new VaultRepository(new MemoryVault(), newId), {
      delayMs: 0,
    });
    if (!sessionResult.ok) throw new Error(sessionResult.error);
    const session = sessionResult.value;
    const database: DatabaseDef = {
      properties: [{ id: 'amount', name: 'Amount', type: 'number', options: [] }],
      views: [],
    };
    const view = newView('table', database, newId);
    view.name = 'Independent linked view name';
    view.hideTitle = true;
    database.views = [view];
    const source = session.execute({
      type: 'page.create',
      id: 'source-db',
      parentId: null,
      title: 'Financeiro synthetic source',
      kind: 'database',
      database,
      now: 1,
    });
    if (!source.ok) throw new Error(source.error);
    const host = session.execute({
      type: 'page.create',
      id: 'host-page',
      parentId: null,
      title: 'Linked view host',
      now: 2,
    });
    if (!host.ok) throw new Error(host.error);
    setSession(session);

    const originalLocale = getPreferences().locale;
    try {
      setPreferences({ locale: 'en' });
      const updateAttributes = vi.fn();
      const readonlyUpdateAttributes = vi.fn();
      const render = (nextView: typeof view, editable: boolean, update: ReturnType<typeof vi.fn>) =>
        renderToStaticMarkup(
          createElement(LinkedDatabaseViewNode, {
            node: {
              type: { name: 'linkedDatabaseView' },
              attrs: {
                hostPageId: 'host-page',
                sourceDatabaseId: 'source-db',
                blockId: 'linked-block',
                view: nextView,
              },
            },
            editor: { isEditable: editable },
            extension: { options: { hostPageId: 'host-page' } },
            updateAttributes: update,
            deleteNode: vi.fn(),
          } as never),
        );
      const markup = render(view, true, updateAttributes);
      const visibleMarkup = render({ ...view, hideTitle: false }, true, vi.fn());
      const readonlyMarkup = render(view, false, readonlyUpdateAttributes);

      expect(markup).not.toContain('Financeiro synthetic source');
      expect(markup).not.toContain('Independent linked view name');
      expect(markup).not.toContain('Show title');
      expect(markup).not.toContain('aria-label="Open source database"');
      expect(markup).toContain('class="text-tool db-options-button');
      expect(markup).not.toMatch(/class="[^"]*linked-database-picker/);
      expect(markup).not.toMatch(/class="[^"]*linked-database-name/);
      expect(visibleMarkup).toContain('Independent linked view name');
      expect(visibleMarkup).not.toContain('Financeiro synthetic source');
      expect(visibleMarkup).not.toContain('Show title');
      expect(visibleMarkup).toContain('class="text-tool db-options-button');
      expect(visibleMarkup).not.toMatch(/class="[^"]*linked-database-picker/);
      expect(readonlyMarkup).not.toContain('Show title');
      expect(readonlyMarkup).not.toContain('Financeiro synthetic source');
      expect(readonlyMarkup).not.toContain('aria-label="Open source database"');
      expect(readonlyMarkup).toContain('class="text-tool db-options-button');
      expect(updateAttributes).not.toHaveBeenCalled();
      expect(view.name).toBe('Independent linked view name');
      expect(readonlyMarkup).not.toMatch(/class="[^"]*linked-database-picker/);
      expect(readonlyMarkup).not.toMatch(/class="[^"]*linked-database-name/);
      expect(readonlyMarkup).not.toContain('aria-label="Remove linked view"');
      expect(readonlyUpdateAttributes).not.toHaveBeenCalled();
    } finally {
      setPreferences({ locale: originalLocale });
      await session.close();
    }
  });

  it('observes editability changes that do not emit an editor update', () => {
    const changeHandlers = new Set<() => void>();
    const observers: Array<{ trigger: () => void; disconnect: ReturnType<typeof vi.fn> }> = [];
    let editable = false;

    class TestMutationObserver {
      disconnect = vi.fn();

      constructor(private readonly callback: MutationCallback) {
        observers.push({
          trigger: () => this.callback([], this as unknown as MutationObserver),
          disconnect: this.disconnect,
        });
      }

      observe = vi.fn();
    }

    vi.stubGlobal('MutationObserver', TestMutationObserver);
    try {
      const editor = {
        get isEditable() {
          return editable;
        },
        isDestroyed: false,
        view: { dom: {} },
        on: (_event: string, handler: () => void) => changeHandlers.add(handler),
        off: (_event: string, handler: () => void) => changeHandlers.delete(handler),
      } as unknown as Parameters<typeof subscribeToEditorEditable>[0];
      const changes: boolean[] = [];
      const unsubscribe = subscribeToEditorEditable(editor, (next) => changes.push(next));
      const observer = observers[0];
      if (!observer) throw new Error('MutationObserver was not created');

      editable = true;
      observer.trigger();
      expect(changes).toEqual([false, true]);
      expect(changeHandlers.size).toBe(1);

      unsubscribe();
      expect(changeHandlers.size).toBe(0);
      expect(observer.disconnect).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps layout actions local in read-only mode and guards persistent writes', () => {
    const editor = { isEditable: false };
    const persist = vi.fn();
    const keepLocal = vi.fn();
    const write = vi.fn();

    runLinkedViewLayoutAction(editor, persist, keepLocal);
    expect(persist).not.toHaveBeenCalled();
    expect(keepLocal).toHaveBeenCalledOnce();
    expect(runIfEditorEditable(editor, write)).toBe(false);
    expect(write).not.toHaveBeenCalled();

    editor.isEditable = true;
    runLinkedViewLayoutAction(editor, persist, keepLocal);
    expect(runIfEditorEditable(editor, write)).toBe(true);
    expect(persist).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
  });

  it('rechecks live editability immediately before a delayed commit', () => {
    const editor = { isEditable: true };
    let liveEditable = true;
    const canEditNow = () => liveEditable;
    const commit = vi.fn();

    expect(canEditNow()).toBe(true);
    liveEditable = false;

    expect(runIfEditorEditable(editor, commit, canEditNow)).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });

  it('checks destruction before reading editability in delayed persistent actions', () => {
    const destroyed = true;
    let editableReads = 0;
    const editor = {
      get isDestroyed() {
        return destroyed;
      },
      get isEditable() {
        editableReads += 1;
        return true;
      },
    };
    const canEditNow = () => !editor.isDestroyed && editor.isEditable;
    const commit = vi.fn();
    const persistLayout = vi.fn();
    const keepLayoutLocal = vi.fn();

    expect(runIfEditorEditable(editor, commit, canEditNow)).toBe(false);
    runLinkedViewLayoutAction(editor, persistLayout, keepLayoutLocal, canEditNow);

    expect(editableReads).toBe(0);
    expect(commit).not.toHaveBeenCalled();
    expect(persistLayout).not.toHaveBeenCalled();
    expect(keepLayoutLocal).not.toHaveBeenCalled();
  });
});

describe('linked view source compatibility', () => {
  const view = (changes: Partial<ViewDef> = {}): ViewDef => ({
    id: 'linked-view',
    name: 'Synthetic linked title',
    type: 'table',
    filters: [],
    sorts: [],
    groupBy: null,
    dateProp: null,
    hidden: [],
    ...changes,
  });

  it('reports stable IDs that are absent instead of mapping a same-named property', () => {
    const configured = view({
      filters: [{ id: 'filter', prop: 'old-status', op: 'is', value: 'Ready' }],
    });
    const target: DatabaseDef = {
      properties: [{ id: 'new-status', name: 'Status', type: 'text', options: [] }],
      views: [],
    };

    expect(linkedViewSourceCompatibility(configured, 'old-source', target)).toMatchObject({
      missingPropertyIds: ['old-status'],
      unverifiedPropertyIds: [],
    });
    expect(target.properties[0]?.id).toBe('new-status');
  });

  it('does not compare formula property bindings that belong to a third database', () => {
    const configured = view({
      filters: [
        {
          id: 'filter',
          prop: 'local-status',
          op: 'is',
          value: 'Ready',
          formulaBindings: [
            {
              kind: 'property',
              databaseId: 'third-source',
              propertyId: 'remote-status',
              start: 0,
              end: 8,
              source: '[Status]',
            },
          ],
        },
      ],
    });
    const target: DatabaseDef = {
      properties: [{ id: 'local-status', name: 'Status', type: 'text', options: [] }],
      views: [],
    };

    expect(linkedViewSourceCompatibility(configured, 'old-source', target)).toMatchObject({
      missingPropertyIds: [],
      unverifiedPropertyIds: [],
      previousSourcePropertyIds: [],
      validationIncomplete: false,
    });
  });

  it('warns for formulas still bound to the previous source and leaves those bindings intact', () => {
    const configured = view({
      filters: [
        {
          id: 'filter',
          prop: 'status',
          op: 'is',
          value: 'Ready',
          formulaBindings: [
            {
              kind: 'property',
              databaseId: 'old-source',
              propertyId: 'status',
              start: 0,
              end: 8,
              source: '[Status]',
            },
          ],
        },
      ],
    });
    const target: DatabaseDef = {
      properties: [{ id: 'status', name: 'Status', type: 'text', options: [] }],
      views: [],
    };
    const originalBinding = structuredClone(configured.filters[0]?.formulaBindings);

    expect(linkedViewSourceCompatibility(configured, 'old-source', target)).toMatchObject({
      missingPropertyIds: [],
      previousSourcePropertyIds: ['status'],
    });
    expect(configured.filters[0]?.formulaBindings).toEqual(originalBinding);
  });

  it.each(['title', 'created', 'updated'])('warns when built-in %s bindings remain attached to the previous source', (propertyId) => {
    const configured = view({filters: [{id:'built-in-filter', prop:'title', op:'is', value:'x', formula:'Native', formulaBindings:[{kind:'property',databaseId:'old-source',propertyId,start:0,end:6,source:'Native'}]}]});
    const original = structuredClone(configured);
    expect(linkedViewSourceCompatibility(configured,'old-source',{properties:[],views:[]})).toMatchObject({missingPropertyIds:[],unverifiedPropertyIds:[],previousSourcePropertyIds:[propertyId]});
    expect(configured).toEqual(original);
  });

  it('distinguishes verified missing IDs from IDs hidden by an unsupported target schema', () => {
    const configured = view({
      filters: [{ id: 'filter', prop: 'missing-status', op: 'is', value: 'Ready' }],
    });
    const target: DatabaseDef = {
      properties: [],
      views: [],
      unsupportedProperties: [{ futureSchema: true }],
    };

    expect(linkedViewSourceCompatibility(configured, 'old-source', target)).toMatchObject({
      missingPropertyIds: [],
      unverifiedPropertyIds: ['missing-status'],
      validationIncomplete: true,
    });
  });

  it('reports known missing IDs while preserving an opaque future view field', () => {
    const configured = view({
      filters: [{ id: 'filter', prop: 'missing-status', op: 'is', value: 'Ready' }],
    });
    const rawState = {
      raw: {
        sourceDatabaseId: 'old-source',
        blockId: 'linked-block',
        view: { ...configured, futureFilterState: { property: 'future-status' } },
      },
      baseline: {},
    };

    expect(
      linkedViewSourceCompatibility(configured, 'old-source', { properties: [], views: [] }, rawState),
    ).toMatchObject({
      missingPropertyIds: ['missing-status'],
      unverifiedPropertyIds: [],
      validationIncomplete: true,
    });
    expect(rawState.raw.view.futureFilterState).toEqual({ property: 'future-status' });
  });

  it('does not run a delayed source change against a replacement linked block', () => {
    const expected = {
      typeName: 'linkedDatabaseView',
      hostPageId: 'host-page',
      blockId: 'original-block',
      sourceDatabaseId: 'old-source',
      viewId: 'linked-view',
    };
    const replacementAttrs = {
      hostPageId: 'host-page',
      blockId: 'replacement-block',
      sourceDatabaseId: 'old-source',
      view: { id: 'linked-view' },
    };
    const write = vi.fn();

    expect(
      runIfEditorEditable(
        { isEditable: true },
        write,
        () => linkedViewNodeIdentityMatches('linkedDatabaseView', replacementAttrs, expected),
      ),
    ).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});
