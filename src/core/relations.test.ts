import { describe, expect, it } from 'vitest';
import { applyCommand } from './commands';
import type { Command } from './commands';
import { valueOf } from './database';
import { emptyWorkspace } from './model';
import type { DatabaseDef, FilterRule, PageMeta, PropDef, WorkspaceState } from './model';
import { relationDiagnostics, relationDisplayLabel, relationOptions, resolveRelationRows } from './relations';

const text = (id: string, name: string): PropDef => ({ id, name, type: 'text', options: [] });
const relation = (id: string, name: string, multiple = false): PropDef => ({
  id,
  name,
  type: 'relation',
  options: [],
  relation: {
    targetDatabaseId: null,
    multiple,
    isInverse: false,
    displayPropertyId: null,
    inversePropertyId: null,
    filters: [],
  },
});

function run(state: WorkspaceState, ...commands: Command[]): WorkspaceState {
  return commands.reduce((current, command) => {
    const result = applyCommand(current, command);
    if (!result.ok) throw new Error(result.error);
    return result.value.state;
  }, state);
}

function tryRun(state: WorkspaceState, command: Command) {
  return applyCommand(state, command);
}

function database(id: string, title: string, properties: PropDef[]): Command[] {
  const definition: DatabaseDef = { properties, views: [] };
  return [
    { type: 'page.create', id, parentId: null, title, kind: 'database', now: 1 },
    { type: 'database.set', id, database: definition, now: 1 },
  ];
}

function row(id: string, parentId: string, title: string): Command {
  return { type: 'page.create', id, parentId, title, now: 1 };
}

function configureBooksAuthor(state: WorkspaceState, filters: FilterRule[] = []): WorkspaceState {
  return run(state, {
    type: 'relation.configure',
    databaseId: 'books',
    propertyId: 'author',
    relation: {
      targetDatabaseId: 'authors',
      multiple: false,
      isInverse: false,
      displayPropertyId: null,
      inversePropertyId: 'books',
      filters,
    },
    now: 2,
  });
}

function unconfiguredState(inverseMultiple = true): WorkspaceState {
  let state = emptyWorkspace();
  state = run(
    state,
    ...database('authors', 'Authors', [
      text('author-name', 'Name'),
      relation('books', 'Books', inverseMultiple),
    ]),
    ...database('books', 'Books', [text('book-name', 'Name'), relation('author', 'Author')]),
    ...database('other-db', 'Other table', [text('other-name', 'Name')]),
    row('author-1', 'authors', 'Asha'),
    row('author-2', 'authors', 'Bea'),
    row('book-1', 'books', 'Dune'),
    row('book-2', 'books', 'Kindred'),
    row('other-row', 'other-db', 'Asha'),
    { type: 'page.setProperties', id: 'author-1', values: { 'author-name': 'Asha' }, now: 1 },
    { type: 'page.setProperties', id: 'author-2', values: { 'author-name': 'Bea' }, now: 1 },
    { type: 'page.setProperties', id: 'book-1', values: { 'book-name': 'Dune' }, now: 1 },
    { type: 'page.setProperties', id: 'book-2', values: { 'book-name': 'Kindred' }, now: 1 },
  );
  return state;
}

function baseState(inverseMultiple = true): WorkspaceState {
  return configureBooksAuthor(unconfiguredState(inverseMultiple));
}

describe('scoped relations', () => {
  it('stores stable row ids, updates the inverse projection from either side, and follows renames', () => {
    let state = baseState();
    state = run(state, {
      type: 'relation.set',
      id: 'book-1',
      propertyId: 'author',
      value: 'author-1',
      now: 3,
    });

    expect(state.pages['book-1']!.properties.author).toBe('author-1');
    expect(state.pages['author-1']!.properties.books).toBeUndefined();
    expect(valueOf(state.pages['author-1']!, 'books', state.pages.authors!.database!, state)).toEqual([
      'book-1',
    ]);

    state = run(state, {
      type: 'relation.set',
      id: 'author-1',
      propertyId: 'books',
      value: ['book-1', 'book-2'],
      now: 4,
    });
    expect(state.pages['book-2']!.properties.author).toBe('author-1');
    expect(valueOf(state.pages['author-1']!, 'books', state.pages.authors!.database!, state)).toEqual([
      'book-1',
      'book-2',
    ]);

    state = run(state, { type: 'page.rename', id: 'author-1', title: 'Asha Rao', now: 5 });
    expect(state.pages['book-1']!.properties.author).toBe('author-1');
    expect(
      relationDisplayLabel(state, state.pages.books!.database!.properties[1]!, state.pages['author-1']!),
    ).toBe('Asha Rao');
    expect(
      resolveRelationRows(state, state.pages.books!.database!.properties[1]!, 'author-1').map(
        (page) => page.id,
      ),
    ).toEqual(['author-1']);
  });

  it('scopes picker choices to the selected table and applies saved option filters and search', () => {
    let state = run(
      emptyWorkspace(),
      ...database('authors', 'Authors', [
        text('author-name', 'Name'),
        {
          id: 'status',
          name: 'Status',
          type: 'select',
          options: [{ id: 'active', name: 'Active', color: 'green' }],
        },
        relation('books', 'Books'),
      ]),
      ...database('books', 'Books', [text('book-name', 'Name'), relation('author', 'Author')]),
      ...database('other-db', 'Other table', [text('other-name', 'Name')]),
      row('author-1', 'authors', 'Asha'),
      row('author-2', 'authors', 'Bea'),
      row('other-row', 'other-db', 'Asha'),
      {
        type: 'page.setProperties',
        id: 'author-1',
        values: { status: 'active', 'author-name': 'Asha' },
        now: 1,
      },
      { type: 'page.setProperties', id: 'author-2', values: { status: null, 'author-name': 'Bea' }, now: 1 },
    );
    state = run(state, {
      type: 'relation.configure',
      databaseId: 'books',
      propertyId: 'author',
      relation: {
        targetDatabaseId: 'authors',
        multiple: false,
        isInverse: false,
        displayPropertyId: 'author-name',
        inversePropertyId: null,
        filters: [{ id: 'active-only', prop: 'status', op: 'is', value: 'active' }],
      },
      now: 2,
    });

    expect(
      relationOptions(state, state.pages.books!.database!.properties[1]!).map((page) => page.id),
    ).toEqual(['author-1']);
    expect(
      relationOptions(state, state.pages.books!.database!.properties[1]!, 'asha').map((page) => page.id),
    ).toEqual(['author-1']);
    expect(relationOptions(state, state.pages.books!.database!.properties[1]!, 'other-row')).toEqual([]);
  });

  it('migrates a unique legacy title and reports an ambiguous title without changing it', () => {
    let state = unconfiguredState();
    state = run(state, {
      type: 'page.setProperties',
      id: 'book-1',
      values: { author: 'Asha' },
      now: 3,
    });
    expect(
      relationDiagnostics(state, state.pages['book-1']!, state.pages.books!.database!.properties[1]!).map(
        (item) => item.code,
      ),
    ).toContain('unconfigured');
    state = configureBooksAuthor(state);
    expect(state.pages['book-1']!.properties.author).toBe('author-1');

    let ambiguous = unconfiguredState();
    ambiguous = run(ambiguous, row('author-3', 'authors', 'Asha'), {
      type: 'page.setProperties',
      id: 'book-1',
      values: { author: 'Asha' },
      now: 3,
    });
    ambiguous = configureBooksAuthor(ambiguous);
    const diagnostics = relationDiagnostics(
      ambiguous,
      ambiguous.pages['book-1']!,
      ambiguous.pages.books!.database!.properties[1]!,
    );
    expect(ambiguous.pages['book-1']!.properties.author).toBe('Asha');
    expect(diagnostics.map((item) => item.code)).toContain('legacy-ambiguous');
    expect(diagnostics.find((item) => item.code === 'legacy-ambiguous')?.count).toBe(2);
  });

  it('enforces a single-row inverse, permits self links, and diagnoses a deleted row', () => {
    let single = baseState(false);
    single = run(single, {
      type: 'relation.set',
      id: 'book-1',
      propertyId: 'author',
      value: 'author-1',
      now: 3,
    });
    const rejected = tryRun(single, {
      type: 'relation.set',
      id: 'book-2',
      propertyId: 'author',
      value: 'author-1',
      now: 4,
    });
    expect(rejected.ok).toBe(false);

    single = run(
      single,
      { type: 'page.trash', id: 'author-1', now: 5 },
      { type: 'page.deleteForever', id: 'author-1' },
    );
    expect(
      relationDiagnostics(single, single.pages['book-1']!, single.pages.books!.database!.properties[1]!).map(
        (item) => item.code,
      ),
    ).toContain('target-missing');

    let self = run(
      emptyWorkspace(),
      ...database('items', 'Items', [text('name', 'Name'), relation('related', 'Related', true)]),
      row('item-1', 'items', 'One'),
    );
    self = run(self, {
      type: 'relation.configure',
      databaseId: 'items',
      propertyId: 'related',
      relation: {
        targetDatabaseId: 'items',
        multiple: true,
        isInverse: false,
        displayPropertyId: 'name',
        inversePropertyId: null,
        filters: [],
      },
      now: 2,
    });
    self = run(self, {
      type: 'relation.set',
      id: 'item-1',
      propertyId: 'related',
      value: ['item-1'],
      now: 3,
    });
    expect(
      resolveRelationRows(self, self.pages.items!.database!.properties[1]!, ['item-1']).map(
        (page) => page.id,
      ),
    ).toEqual(['item-1']);
  });

  it('ignores stale inverse snapshots and reports them as diagnostics', () => {
    let state = baseState();
    state = run(state, {
      type: 'relation.set',
      id: 'book-1',
      propertyId: 'author',
      value: 'author-1',
      now: 3,
    });
    const staleAuthor: PageMeta = {
      ...state.pages['author-1']!,
      properties: { ...state.pages['author-1']!.properties, books: ['book-2'] },
    };
    state = { ...state, pages: { ...state.pages, 'author-1': staleAuthor } };
    expect(valueOf(staleAuthor, 'books', state.pages.authors!.database!, state)).toEqual(['book-1']);
    expect(
      relationDiagnostics(state, staleAuthor, state.pages.authors!.database!.properties[1]!).map(
        (item) => item.code,
      ),
    ).toContain('inverse-mismatch');
  });

  it('refuses to convert a populated relation field into a projection and safely unlinks an inverse', () => {
    const configure: Command = {
      type: 'relation.configure',
      databaseId: 'books',
      propertyId: 'author',
      relation: {
        targetDatabaseId: 'authors',
        multiple: false,
        isInverse: false,
        displayPropertyId: null,
        inversePropertyId: 'books',
        filters: [],
      },
      now: 3,
    };
    let populated = unconfiguredState();
    populated = run(populated, {
      type: 'page.setProperties',
      id: 'author-1',
      values: { books: 'book-1' },
      now: 2,
    });
    const refused = tryRun(populated, configure);
    expect(refused.ok).toBe(false);
    expect(populated.pages['author-1']!.properties.books).toBe('book-1');
    const base = unconfiguredState();
    const withLegacyExtra: WorkspaceState = {
      ...base,
      pages: {
        ...base.pages,
        'author-1': {
          ...base.pages['author-1']!,
          extra: { Books: '[[Dune]]' },
        },
      },
    };
    expect(tryRun(withLegacyExtra, configure).ok).toBe(false);

    const configured = baseState();
    const book = configured.pages['book-1']!;
    const protectedState: WorkspaceState = {
      ...configured,
      pages: {
        ...configured.pages,
        'book-1': { ...book, extra: { Author: [{ id: 'author-1' }, { unexpected: 'keep' }] } },
      },
    };
    const owner = protectedState.pages.books!.database!.properties[1]!;
    expect(
      relationDiagnostics(protectedState, protectedState.pages['book-1']!, owner).map((item) => item.code),
    ).toContain('unsupported-value');
    expect(
      tryRun(protectedState, {
        type: 'relation.set',
        id: 'book-1',
        propertyId: 'author',
        value: 'author-1',
        now: 4,
      }).ok,
    ).toBe(false);

    let linked = baseState();
    linked = run(linked, {
      type: 'relation.set',
      id: 'book-1',
      propertyId: 'author',
      value: 'author-1',
      now: 3,
    });
    linked = run(linked, {
      type: 'relation.configure',
      databaseId: 'books',
      propertyId: 'author',
      relation: {
        targetDatabaseId: 'authors',
        multiple: false,
        isInverse: false,
        displayPropertyId: null,
        inversePropertyId: null,
        filters: [],
      },
      now: 4,
    });
    expect(linked.pages['book-1']!.properties.author).toBe('author-1');
    expect(linked.pages.authors!.database!.properties[1]!.relation).toMatchObject({
      targetDatabaseId: null,
      isInverse: false,
    });
    expect(valueOf(linked.pages['author-1']!, 'books', linked.pages.authors!.database!, linked)).toBeNull();
  });
});
