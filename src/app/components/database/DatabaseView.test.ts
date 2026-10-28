import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { newView } from '../../../core/database';
import type { DatabaseDef, PageMeta } from '../../../core/model';
import { MemoryVault } from '../../../storage/memoryVault';
import { WorkspaceSession } from '../../../storage/session';
import { VaultRepository } from '../../../storage/vaultRepository';
import { t } from '../../i18n';
import { getPreferences, setPreferences } from '../../platform/preferences';
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
        { id: 'score', name: 'Score', type: 'number', options: [] },
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
    for (const [id, title, index] of [
      ['synthetic-row-one', 'Synthetic row one', 0],
      ['synthetic-row-two', 'Synthetic row two', 1],
    ] as const) {
      const row = session.execute({
        type: 'page.create',
        id,
        parentId: 'synthetic-database',
        title,
        now: 2,
        index,
      });
      if (!row.ok) throw new Error(row.error);
    }
    const emptyDatabase: DatabaseDef = structuredClone(database);
    emptyDatabase.views = [newView('table', emptyDatabase, () => 'synthetic-empty-table')];
    const emptyCreated = session.execute({
      type: 'page.create',
      id: 'synthetic-empty-database',
      parentId: null,
      title: 'Synthetic empty database',
      kind: 'database',
      database: emptyDatabase,
      now: 3,
    });
    if (!emptyCreated.ok) throw new Error(emptyCreated.error);

    const render = (page: PageMeta, embeddedView?: typeof view, editable = true) =>
      renderToStaticMarkup(
        createElement(DatabaseView, {
          page,
          editable,
          ...(embeddedView ? { embeddedView, onEmbeddedViewChange: () => {} } : {}),
        }),
      );
    const initialPage = session.getState().pages['synthetic-database']!;
    const mainMarkup = render(initialPage);
    const linkedMarkup = render(initialPage, view);
    const emptyMarkup = render(session.getState().pages['synthetic-empty-database']!);
    const configuredView = {
      ...view,
      filters: [{ id: 'active-filter', prop: 'summary', op: 'contains' as const, value: 'Synthetic' }],
      sorts: [{ prop: 'score', dir: 'asc' as const }],
      search: 'row',
    };
    const configuredPage = {
      ...initialPage,
      database: { ...initialPage.database!, views: [configuredView] },
    };
    const configuredMarkup = render(configuredPage);
    const readOnlyMarkup = render(initialPage, undefined, false);

    const originalLocale = getPreferences().locale;
    try {
      for (const locale of ['en', 'pt'] as const) {
        setPreferences({ locale });
        const localizedMainMarkup = render(initialPage);
        const localizedEmptyMarkup = render(session.getState().pages['synthetic-empty-database']!);
        expect(localizedMainMarkup).toContain(
          `aria-label="${t('database.rowSelectAll', { count: 2 }, locale)}"`,
        );
        expect(localizedMainMarkup).toContain(
          `aria-label="${t('database.rowSelect', { name: 'Synthetic row one' }, locale)}"`,
        );
        expect(localizedMainMarkup).toContain(
          `aria-label="${t('database.rowMenu', { name: 'Synthetic row one' }, locale)}"`,
        );
        expect(localizedEmptyMarkup).toContain(
          `aria-label="${t('database.rowPasteTarget', undefined, locale)}"`,
        );
      }
    } finally {
      setPreferences({ locale: originalLocale });
    }

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
    expect(mainMarkup).toContain('class="db-row-drag"');
    expect(mainMarkup).toContain(
      `aria-label="${t('database.rowGrip', { name: 'Synthetic row one' })}"`,
    );
    expect(mainMarkup).toContain('aria-haspopup="menu"');
    expect(mainMarkup).toContain('aria-pressed="false"');
    expect(emptyMarkup).toContain('class="db-table-view"');
    expect(emptyMarkup).toContain('tabindex="0"');
    expect(emptyMarkup).toContain('role="group"');

    const scoreCellTags = [...mainMarkup.matchAll(/<(?:td|th)\b[^>]*data-col-id="score"[^>]*>/g)].map(
      ([tag]) => tag!,
    );
    expect(scoreCellTags).toHaveLength(3);
    expect(scoreCellTags.every((tag) => tag.includes('text-align:left'))).toBe(true);
    const alignedPage = {
      ...initialPage,
      database: { ...initialPage.database!, views: [{ ...view, align: { score: 'right' as const } }] },
    };
    const configuredScoreCellTags = [
      ...render(alignedPage).matchAll(/<(?:td|th)\b[^>]*data-col-id="score"[^>]*>/g),
    ].map(([tag]) => tag!);
    expect(configuredScoreCellTags).toHaveLength(3);
    expect(configuredScoreCellTags.every((tag) => tag.includes('text-align:right'))).toBe(true);
    expect(configuredMarkup.match(/class="text-tool/g)).toHaveLength(1);
    expect(configuredMarkup).toContain(
      `aria-label="${t('database.tableOptionsState', {
        filters: 1,
        sorts: 1,
        search: t('database.searchActive'),
      })}"`,
    );
    expect(configuredMarkup.match(/class="db-options-count"/g)).toHaveLength(2);
    const readOnlyOptionsControl = readOnlyMarkup.match(
      /<button(?=[^>]*class="text-tool db-options-button[^"]*")[^>]*>/,
    )?.[0];
    expect(readOnlyOptionsControl).toBeTruthy();
    expect(readOnlyOptionsControl).not.toContain('disabled');

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
