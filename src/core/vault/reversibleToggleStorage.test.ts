import { describe, expect, it } from 'vitest';
import type { DocNode } from '../model';
import { docToMarkdown } from '../markdown/serialize';
import { markdownToDoc } from '../markdown/parse';
import { newPageMeta } from '../model';
import { composeFrontmatter, managedFrontmatter, readPageText, renderPageText } from './pageFile';

describe('reversible toggle storage reopen', () => {
  it.each([true, false])('round trips details and linked-view state through a page file (%s)', (open) => {
    const doc: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'details',
          attrs: { open, blockId: 'synthetic-details-block' },
          content: [
            {
              type: 'detailsSummary',
              attrs: { blockBackground: '#345678' },
              content: [
                { type: 'text', text: 'Synthetic ' },
                { type: 'text', text: 'section', marks: [{ type: 'bold' }] },
              ],
            },
            {
              type: 'detailsContent',
              content: [
                {
                  type: 'linkedDatabaseView',
                  attrs: {
                    sourceDatabaseId: 'synthetic-database',
                    blockId: 'synthetic-linked-view-block',
                    view: {
                      id: 'synthetic-linked-view',
                      name: 'Synthetic view',
                      type: 'table',
                      filters: [],
                      sorts: [],
                      groupBy: null,
                      dateProp: null,
                      hidden: [],
                      collapsed: !open,
                      collapseEnabled: false,
                    },
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const page = newPageMeta({ id: 'synthetic-page', parentId: null, title: 'Toggle', kind: 'page' });
    const frontmatter = composeFrontmatter(managedFrontmatter(page, 'Toggle', null), {}, null);
    const saved = renderPageText(frontmatter, null, docToMarkdown(doc));

    const reopenedPage = readPageText(saved);
    const reopened = markdownToDoc(reopenedPage.body);
    const details = reopened.content?.[0];
    const linkedView = details?.content?.[1]?.content?.[0];
    const view = linkedView?.attrs?.view as Record<string, unknown> | null | undefined;

    expect(reopenedPage.error).toBeNull();
    expect(details?.attrs).toMatchObject({ open, blockId: 'synthetic-details-block' });
    expect(details?.content?.[0]?.attrs?.blockBackground).toBe('#345678');
    expect(details?.content?.[0]?.content?.[1]?.marks).toEqual([{ type: 'bold' }]);
    expect(details?.attrs?.open).toBe(open);
    expect(linkedView).toMatchObject({
      type: 'linkedDatabaseView',
      attrs: {
        sourceDatabaseId: 'synthetic-database',
        blockId: 'synthetic-linked-view-block',
        view: { id: 'synthetic-linked-view', collapseEnabled: false },
      },
    });
    expect(view?.collapsed ?? false).toBe(!open);
  });
});
