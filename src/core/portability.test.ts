import { describe, expect, it } from 'vitest';
import { applyCommand } from './commands';
import type { Command } from './commands';
import { encodeFileIcon, parsePageIcon } from './icons';
import { emptyWorkspace } from './model';
import type { DatabaseDef, DocNode, FileMeta, WorkspaceState } from './model';
import { pageMarkdown, workspaceMarkdownFiles } from './portability';
import { readPageText } from './vault/pageFile';

const run = (state: WorkspaceState, command: Command): WorkspaceState => {
  const result = applyCommand(state, command);
  if (!result.ok) throw new Error(result.error);
  return result.value.state;
};

const database: DatabaseDef = {
  properties: [
    { id: 'complete', name: 'Complete', type: 'checkbox', options: [] },
    { id: 'score', name: 'Score', type: 'number', options: [] },
  ],
  views: [
    {
      id: 'all',
      name: 'All quests',
      type: 'table',
      filters: [],
      sorts: [],
      groupBy: null,
      dateProp: null,
      hidden: [],
    },
  ],
};

describe('Markdown export', () => {
  it('retargets stable page links to the actual nested export path and collision name', () => {
    let state = run(emptyWorkspace(), {
      type: 'page.create',
      id: 'export-folder',
      parentId: null,
      now: 1,
      title: 'Folder',
    });
    state = run(state, {
      type: 'page.create',
      id: 'export-target-first',
      parentId: 'export-folder',
      now: 2,
      title: 'Target',
    });
    state = run(state, {
      type: 'page.create',
      id: 'export-target-linked',
      parentId: 'export-folder',
      now: 3,
      title: 'Target',
    });
    state = run(state, {
      type: 'page.create',
      id: 'export-host',
      parentId: null,
      now: 4,
      title: 'Host',
    });
    state = run(state, {
      type: 'page.setDoc',
      id: 'export-host',
      now: 5,
      doc: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'pageLink',
                attrs: {
                  id: 'export-target-linked',
                  alias: 'Section',
                  markdownHref: './Target.md?view=old#part%20two',
                },
              },
            ],
          },
        ],
      },
    });

    const exported = workspaceMarkdownFiles(state).files;
    const host = exported.find((file) => file.path === 'Host.md');
    const linkedTarget = exported.find((file) => file.path === 'Folder/Target (2).md');

    expect(host?.content).toContain('[Section](./Folder/Target%20%282%29.md?view=old#part%20two)');
    expect(linkedTarget?.path).toBe('Folder/Target (2).md');
  });

  it('includes page metadata, media references, database rows, views and dynamic snapshots', () => {
    let state = run(emptyWorkspace(), {
      type: 'page.create',
      id: 'quests',
      parentId: null,
      now: 1,
      title: 'Quest Board',
      kind: 'database',
      database,
    });
    state = run(state, {
      type: 'page.create',
      id: 'quest-ash',
      parentId: 'quests',
      now: 2,
      title: 'Ashen Bridge',
      properties: { complete: true, score: 8 },
    });
    state = run(state, {
      type: 'page.create',
      id: 'dashboard',
      parentId: null,
      now: 3,
      title: 'Campaign Dashboard',
    });
    const cover = {
      id: 'demo-cover',
      name: 'Bridge cover.png',
      type: 'image/png',
      size: 4,
      createdAt: 1,
    } satisfies FileMeta;
    const icon = {
      id: 'demo-icon',
      name: 'Compass.png',
      type: 'image/png',
      size: 4,
      createdAt: 1,
    } satisfies FileMeta;
    state = {
      ...state,
      pages: {
        ...state.pages,
        quests: { ...state.pages.quests!, cover: cover.id, icon: encodeFileIcon(icon.id) },
        dashboard: {
          ...state.pages.dashboard!,
          controls: [
            { id: 'season', name: 'Season', type: 'number', value: 3, defaultValue: 1, options: [] },
          ],
        },
      },
    };
    const dashboardDoc: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'namedControl', attrs: { controlId: 'season', label: 'Season' } },
            { type: 'text', text: ' · total complete: ' },
            {
              type: 'calculatedResult',
              attrs: { resultId: 'complete-count', name: 'Completion check', formula: '1 > 0', bindings: [] },
            },
            { type: 'text', text: ' · split amount: ' },
            {
              type: 'calculatedResult',
              attrs: {
                resultId: 'split-total',
                name: 'Split amount',
                formula: '33.34 + 33.33',
                bindings: [],
                outputType: 'currency',
                format: { locale: 'pt-BR', currency: 'BRL', precision: 2 },
              },
            },
          ],
        },
        {
          type: 'linkedDatabaseView',
          attrs: {
            hostPageId: 'dashboard',
            sourceDatabaseId: 'quests',
            blockId: 'linked-quests',
            view: database.views[0],
          },
        },
      ],
    };
    state = { ...state, docs: { ...state.docs, dashboard: dashboardDoc } };

    const files = new Map<FileMeta['id'], FileMeta>([
      [cover.id, cover],
      [icon.id, icon],
    ]);
    const exported = workspaceMarkdownFiles(state, Object.fromEntries(files));
    const questFile = exported.files.find((file) => file.path === 'Quest Board.md')!;
    const dashboardFile = exported.files.find((file) => file.path === 'Campaign Dashboard.md')!;
    const questFrontmatter = readPageText(questFile.content);

    expect(exported.attachments.get(cover.id)).toBe('attachments/Bridge cover.png');
    expect(exported.attachments.get(icon.id)).toBe('attachments/Compass.png');
    expect(questFile.content).toContain('kind: database');
    expect(questFile.content).toContain('## Database snapshot');
    expect(questFile.content).toContain('| Ashen Bridge | Yes | 8 |');
    expect(questFile.content).toContain('**All quests** (table)');
    expect(questFrontmatter.error).toBeNull();
    expect(questFrontmatter.cover).toBe('attachments/Bridge cover.png');
    expect(parsePageIcon(questFrontmatter.icon)?.kind).toBe('file');
    expect(questFrontmatter.database?.properties.map((prop) => prop.name)).toEqual(['Complete', 'Score']);

    expect(dashboardFile.content).toContain('data-morrow-control="season"');
    expect(dashboardFile.content).toContain('## Controls snapshot');
    expect(dashboardFile.content).toContain('| Season | number | 3 | 1 |');
    expect(dashboardFile.content).toContain('morrow:linked-view:v1:');
    expect(dashboardFile.content).toContain('## Linked view snapshot: All quests');
    expect(dashboardFile.content).toContain('| Ashen Bridge | Yes | 8 |');
    expect(dashboardFile.content).toContain('## Calculated results snapshot');
    expect(dashboardFile.content).toContain('| Completion check | 1 > 0 | Yes |');
    expect(dashboardFile.content).toContain('| Split amount | 33.34 + 33.33 | R$');
    expect(dashboardFile.content).toContain('66,67 |');
  });

  it('keeps a page with no attachments as one readable Markdown file with frontmatter', () => {
    const state = run(emptyWorkspace(), {
      type: 'page.create',
      id: 'note',
      parentId: null,
      now: 1,
      title: 'Field Notes',
      tags: ['field'],
    });
    const markdown = pageMarkdown(state, 'note');
    expect(markdown).toContain('tags:');
    expect(markdown).toContain('# Field Notes');
  });
});
