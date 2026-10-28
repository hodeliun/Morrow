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
import { LinkedDatabaseViewNode } from './LinkedDatabaseView';

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
    const sessionResult = await WorkspaceSession.open(
      new VaultRepository(new MemoryVault(), newId),
      { delayMs: 0 },
    );
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
    } finally {
      setPreferences({ locale: originalLocale });
      await session.close();
    }
  });
});
