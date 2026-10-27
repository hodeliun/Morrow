import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { newView } from '../../../core/database';
import type { DatabaseDef, PageMeta } from '../../../core/model';
import { MemoryVault } from '../../../storage/memoryVault';
import { WorkspaceSession } from '../../../storage/session';
import { VaultRepository } from '../../../storage/vaultRepository';
import { setSession } from '../../workspace';
import { updateProp } from './data';
import { DatabaseView } from './DatabaseView';

describe('database column descriptions', () => {
  it('shows descriptions in database and linked view headers and keeps them current across reopen', async () => {
    let nextId = 0;
    const newId = () => `description${++nextId}`;
    const vault = new MemoryVault();
    const open = async () => {
      const opened = await WorkspaceSession.open(new VaultRepository(vault, newId), { delayMs: 0 });
      if (!opened.ok) throw new Error(opened.error);
      return opened.value;
    };
    const session = await open();
    setSession(session);

    const database: DatabaseDef = {
      properties: [
        {
          id: 'summary',
          name: 'Summary',
          type: 'text',
          options: [],
          description: 'A synthetic description for this column.',
        },
        { id: 'unlabeled', name: 'No description', type: 'text', options: [] },
      ],
      views: [],
    };
    const view = newView('table', database, () => 'synthetic-table');
    database.views = [view];
    const created = session.execute({
      type: 'page.create',
      id: 'synthetic-database',
      parentId: null,
      title: 'Synthetic database',
      kind: 'database',
      database,
      now: 1,
    });
    if (!created.ok) throw new Error(created.error);

    const render = (page: PageMeta, embeddedView?: typeof view) =>
      renderToStaticMarkup(
        createElement(DatabaseView, {
          page,
          editable: true,
          ...(embeddedView ? { embeddedView, onEmbeddedViewChange: () => {} } : {}),
        }),
      );
    const initialPage = session.getState().pages['synthetic-database']!;
    const mainMarkup = render(initialPage);
    const linkedMarkup = render(initialPage, view);

    for (const markup of [mainMarkup, linkedMarkup]) {
      expect(markup.match(/class="db-header-info"/g)).toHaveLength(1);
      expect(markup).toContain('A synthetic description for this column.');
      expect(markup).toContain('role="tooltip"');
      expect(markup).toContain('class="db-header"');
      expect(markup).toContain('class="db-resize"');
      expect(markup).toContain('No description');
      const descriptionId = markup.match(/id="([^"]+)" class="db-header-description-text"/)?.[1];
      expect(descriptionId).toBeTruthy();
      expect(markup).toContain(`aria-describedby="${descriptionId}"`);
    }
    expect(linkedMarkup).toContain('is-linked-view');

    expect(
      updateProp('synthetic-database', 'summary', (property) => ({
        ...property,
        description: 'An updated synthetic description.',
      })),
    ).toBe(true);
    const updatedMarkup = render(session.getState().pages['synthetic-database']!);
    expect(updatedMarkup).toContain('An updated synthetic description.');
    expect(updatedMarkup).not.toContain('A synthetic description for this column.');
    expect(await session.flush()).toBe(true);
    await session.close();

    const reopened = await open();
    setSession(reopened);
    const reopenedPage = Object.values(reopened.getState().pages).find(
      (page) => page.title === 'Synthetic database',
    )!;
    expect(render(reopenedPage)).toContain('An updated synthetic description.');

    expect(
      updateProp(reopenedPage.id, 'summary', (property) => ({ ...property, description: undefined })),
    ).toBe(true);
    const removedMarkup = render(reopened.getState().pages[reopenedPage.id]!);
    expect(removedMarkup).not.toContain('class="db-header-info"');
    expect(removedMarkup).not.toContain('An updated synthetic description.');
    expect(await reopened.flush()).toBe(true);
    await reopened.close();

    const reopenedAfterRemoval = await open();
    setSession(reopenedAfterRemoval);
    const removedPage = Object.values(reopenedAfterRemoval.getState().pages).find(
      (page) => page.title === 'Synthetic database',
    )!;
    const afterRemovalMarkup = render(removedPage);
    expect(afterRemovalMarkup).not.toContain('class="db-header-info"');
    expect(afterRemovalMarkup).not.toContain('An updated synthetic description.');
    await reopenedAfterRemoval.close();
  });
});
