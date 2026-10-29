import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { newView } from '../../../core/database';
import type { DatabaseDef } from '../../../core/model';
import { MemoryVault } from '../../../storage/memoryVault';
import { WorkspaceSession } from '../../../storage/session';
import { VaultRepository } from '../../../storage/vaultRepository';
import { getPreferences, setPreferences } from '../../platform/preferences';
import { setSession } from '../../workspace';
import {
  LinkedDatabaseViewNode,
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
  it('hides the source name while keeping restore, source-open, and table options controls', async () => {
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
      const markup = renderToStaticMarkup(
        createElement(LinkedDatabaseViewNode, {
          node: {
            attrs: {
              hostPageId: 'host-page',
              sourceDatabaseId: 'source-db',
              blockId: 'linked-block',
              view,
            },
          },
          editor: { isEditable: true },
          extension: { options: { hostPageId: 'host-page' } },
          updateAttributes,
          deleteNode: vi.fn(),
        } as never),
      );
      const readonlyMarkup = renderToStaticMarkup(
        createElement(LinkedDatabaseViewNode, {
          node: {
            attrs: {
              hostPageId: 'host-page',
              sourceDatabaseId: 'source-db',
              blockId: 'linked-block',
              view,
            },
          },
          editor: { isEditable: false },
          extension: { options: { hostPageId: 'host-page' } },
          updateAttributes: readonlyUpdateAttributes,
          deleteNode: vi.fn(),
        } as never),
      );

      expect(markup).not.toContain('Financeiro synthetic source');
      expect(markup).not.toContain('Independent linked view name');
      expect(markup).toContain('class="inline-database-hidden-title-trigger"');
      expect(markup).toContain('<span>Show title</span>');
      expect(markup).toContain('aria-label="Open source database"');
      expect(markup).toContain('class="text-tool db-options-button');
      expect(markup).not.toMatch(/class="[^"]*linked-database-picker/);
      expect(markup).not.toMatch(/class="[^"]*linked-database-name/);
      expect(updateAttributes).not.toHaveBeenCalled();
      expect(view.name).toBe('Independent linked view name');
      expect(readonlyMarkup).toContain('class="inline-database-hidden-title-trigger"');
      expect(readonlyMarkup).toContain('aria-label="Open source database"');
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
