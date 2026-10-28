import { describe, expect, it } from 'vitest';
import { emptyDoc, emptyWorkspace, newPageMeta } from '../../../core/model';
import type { DatabaseDef, PageMeta, PropDef, WorkspaceState } from '../../../core/model';
import { formulaSuggestions } from './formulaEditorModel';
import { searchPropertyTypes } from './PropertyTypeSelect';

function createDatabase(
  state: WorkspaceState,
  id: string,
  title: string,
  properties: PropDef[],
  now = 1,
): WorkspaceState {
  const dbDef: DatabaseDef = {
    properties,
    views: [
      {
        id: `view-${id}`,
        name: 'Table',
        type: 'table',
        filters: [],
        sorts: [],
        hidden: [],
        widths: {},
        groupBy: null,
        dateProp: null,
      },
    ],
  };
  const page: PageMeta = newPageMeta({
    id,
    parentId: null,
    title,
    kind: 'database',
    database: dbDef,
    createdAt: now,
    updatedAt: now,
  });
  return {
    ...state,
    pages: { ...state.pages, [id]: page },
    docs: { ...state.docs, [id]: emptyDoc() },
  };
}

describe('Searchable Property Type Select (#37)', () => {
  it('searchPropertyTypes ignores case and accents, matching PT and EN aliases bidirectionally', () => {
    // English query matches translated types and aliases
    expect(searchPropertyTypes('number')).toContain('number');
    expect(searchPropertyTypes('decimal')).toContain('number');
    expect(searchPropertyTypes('currency')).toContain('currency');
    expect(searchPropertyTypes('money')).toContain('currency');
    expect(searchPropertyTypes('formula')).toContain('formula');

    // Portuguese query matches
    expect(searchPropertyTypes('número')).toContain('number');
    expect(searchPropertyTypes('numero')).toContain('number');
    expect(searchPropertyTypes('moeda')).toContain('currency');
    expect(searchPropertyTypes('fórmula')).toContain('formula');
    expect(searchPropertyTypes('calculo')).toContain('formula');
    expect(searchPropertyTypes('cálculo')).toContain('formula');
    expect(searchPropertyTypes('seleção')).toContain('select');
    expect(searchPropertyTypes('selecao')).toContain('select');
    expect(searchPropertyTypes('relação')).toContain('relation');
    expect(searchPropertyTypes('vinculo')).toContain('relation');

    // Covers all 25 supported types when query is empty
    expect(searchPropertyTypes('').length).toBe(25);
  });
});

describe('Formula Editor Autocomplete for Relation Fields (#41)', () => {
  it('suggests target database properties after relation dot, including column names with spaces', () => {
    let state = emptyWorkspace();
    const authorsDb: PropDef[] = [
      { id: 'auth-name', name: 'Author Name', type: 'text', options: [] },
      { id: 'auth-bio', name: 'Biography', type: 'text', options: [] },
    ];
    state = createDatabase(state, 'authors-db', 'Authors', authorsDb);

    const booksDb: PropDef[] = [
      { id: 'book-title', name: 'Title', type: 'text', options: [] },
      {
        id: 'book-author',
        name: 'Writer',
        type: 'relation',
        options: [],
        relation: {
          targetDatabaseId: 'authors-db',
          multiple: false,
          isInverse: false,
          displayPropertyId: null,
          inversePropertyId: null,
          filters: [],
        },
      },
    ];
    state = createDatabase(state, 'books-db', 'Books', booksDb);
    const booksDef = state.pages['books-db']!.database!;

    // Case 1: `Writer.` suggests Authors database columns, escaping names with spaces
    const suggestions1 = formulaSuggestions(
      'Writer.',
      'Writer.'.length,
      'books-db',
      booksDef,
      state,
      [],
    );
    expect(suggestions1.some((s) => s.label === 'Author Name' && s.insertText === '`Author Name`')).toBe(true);
    expect(suggestions1.some((s) => s.label === 'Biography' && s.insertText === 'Biography')).toBe(true);

    // Case 2: `thisRow.Writer.` also suggests target database columns
    const suggestions2 = formulaSuggestions(
      'thisRow.Writer.',
      'thisRow.Writer.'.length,
      'books-db',
      booksDef,
      state,
      [],
    );
    expect(suggestions2.some((s) => s.label === 'Author Name')).toBe(true);
  });

  it('suggests properties even when relation is empty or multiple', () => {
    let state = emptyWorkspace();
    const tagsDb: PropDef[] = [{ id: 'tag-name', name: 'Tag Title', type: 'text', options: [] }];
    state = createDatabase(state, 'tags-db', 'Tags', tagsDb);

    const itemsDb: PropDef[] = [
      {
        id: 'item-tags',
        name: 'Tags',
        type: 'relation',
        options: [],
        relation: {
          targetDatabaseId: 'tags-db',
          multiple: true,
          isInverse: false,
          displayPropertyId: null,
          inversePropertyId: null,
          filters: [],
        },
      },
    ];
    state = createDatabase(state, 'items-db', 'Items', itemsDb);
    const itemsDef = state.pages['items-db']!.database!;

    const suggestions = formulaSuggestions(
      'thisRow.Tags.',
      'thisRow.Tags.'.length,
      'items-db',
      itemsDef,
      state,
      [],
    );
    expect(suggestions.some((s) => s.label === 'Tag Title')).toBe(true);
  });
});
