import { describe, expect, it } from 'vitest';
import { applyCommand } from './commands';
import type { Command } from './commands';
import { bindFormulaReferences } from './database';
import { emptyWorkspace } from './model';
import type { DatabaseDef, DocNode, PropDef, WorkspaceState } from './model';
import { childrenOf, isEffectivelyTrashed, livePages } from './tree';

function run(state: WorkspaceState, ...commands: Command[]): WorkspaceState {
  return commands.reduce((current, command) => {
    const result = applyCommand(current, command);
    if (!result.ok) throw new Error(result.error);
    return result.value.state;
  }, state);
}

const create = (id: string, parentId: string | null = null, extra: Partial<Command> = {}): Command =>
  ({ type: 'page.create', id, parentId, now: 1, title: id, ...extra }) as Command;

const paragraph = (text: string): DocNode => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('page creation and hierarchy', () => {
  it('creates nested pages in order', () => {
    const state = run(
      emptyWorkspace(),
      create('a'),
      create('b'),
      create('a1', 'a'),
      create('a0', 'a', { index: 0 } as Partial<Command>),
    );
    expect(childrenOf(state.pages, null).map((p) => p.id)).toEqual(['a', 'b']);
    expect(childrenOf(state.pages, 'a').map((p) => p.id)).toEqual(['a0', 'a1']);
    expect(state.docs.a1).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
  });

  it('rejects duplicate ids and missing parents', () => {
    const state = run(emptyWorkspace(), create('a'));
    expect(applyCommand(state, create('a')).ok).toBe(false);
    expect(applyCommand(state, create('b', 'missing')).ok).toBe(false);
  });

  it('refuses to move a page inside itself or its descendants', () => {
    const state = run(emptyWorkspace(), create('a'), create('b', 'a'), create('c', 'b'));
    expect(applyCommand(state, { type: 'page.move', id: 'a', parentId: 'a' }).ok).toBe(false);
    expect(applyCommand(state, { type: 'page.move', id: 'a', parentId: 'c' }).ok).toBe(false);
    const moved = run(state, { type: 'page.move', id: 'c', parentId: null, index: 0 });
    expect(childrenOf(moved.pages, null).map((p) => p.id)).toEqual(['c', 'a']);
  });

  it('reorders siblings without touching unrelated pages', () => {
    const state = run(emptyWorkspace(), create('a'), create('b'), create('c'));
    const result = applyCommand(state, { type: 'page.move', id: 'c', parentId: null, index: 0 });
    expect(result.ok && childrenOf(result.value.state.pages, null).map((p) => p.id)).toEqual(['c', 'a', 'b']);
    expect(result.ok && [...result.value.changes.pages].sort()).toEqual(['a', 'b', 'c']);
  });

  it('normalises titles', () => {
    const state = run(emptyWorkspace(), create('a'), {
      type: 'page.rename',
      id: 'a',
      title: 'Line\none',
      now: 2,
    });
    expect(state.pages.a!.title).toBe('Line one');
    expect(state.pages.a!.updatedAt).toBe(2);
  });
});

describe('formula defaults', () => {
  const createDatabase = (properties: PropDef[]): Command => ({
    type: 'page.create',
    id: 'db',
    parentId: null,
    now: 1,
    title: 'Defaults',
    kind: 'database',
    database: { properties, views: [] } satisfies DatabaseDef,
  });

  it('resolves formula defaults by dependency and keeps explicit values, false and zero', () => {
    const properties: PropDef[] = [
      {
        id: 'final',
        name: 'Final',
        type: 'number',
        options: [],
        fillMode: 'default',
        defaultFormula: 'prop("Middle") + 1',
      },
      {
        id: 'middle',
        name: 'Middle',
        type: 'number',
        options: [],
        fillMode: 'default',
        defaultFormula: 'prop("Base") + 1',
      },
      { id: 'base', name: 'Base', type: 'number', options: [], fillMode: 'default', defaultValue: 2 },
      {
        id: 'zero',
        name: 'Zero',
        type: 'number',
        options: [],
        fillMode: 'default',
        defaultFormula: 'If(false, 2, 0)',
      },
      {
        id: 'checked',
        name: 'Checked',
        type: 'checkbox',
        options: [],
        fillMode: 'default',
        defaultValue: false,
      },
    ];
    const state = run(emptyWorkspace(), createDatabase(properties));
    const created = applyCommand(
      state,
      create('row', 'db', { properties: { middle: 9 } } as Partial<Command>),
    );
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.value.state.pages.row!.properties).toMatchObject({
        final: 10,
        middle: 9,
        base: 2,
        zero: 0,
        checked: false,
      });
    }
  });

  it('rejects dependency cycles and unknown multi-select options', () => {
    const cycleState = run(
      emptyWorkspace(),
      createDatabase([
        {
          id: 'a',
          name: 'A',
          type: 'number',
          options: [],
          fillMode: 'default',
          defaultFormula: 'prop("B") + 1',
        },
        {
          id: 'b',
          name: 'B',
          type: 'number',
          options: [],
          fillMode: 'default',
          defaultFormula: 'prop("A") + 1',
        },
      ]),
    );
    expect(applyCommand(cycleState, create('cycle-row', 'db')).ok).toBe(false);

    const option = { id: 'red', name: 'Red', color: 'red' as const };
    const multiState = run(
      emptyWorkspace(),
      createDatabase([
        {
          id: 'colors',
          name: 'Colors',
          type: 'multiSelect',
          options: [option],
          fillMode: 'default',
          defaultFormula: 'List("Red", "Unknown")',
        },
      ]),
    );
    const failed = applyCommand(multiState, create('multi-row', 'db'));
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error).toContain('unknown option');
  });
});

describe('trash', () => {
  const base = () => run(emptyWorkspace(), create('a'), create('b', 'a'), create('c', 'b'));

  it('hides a trashed page and its subpages', () => {
    const state = run(base(), { type: 'page.trash', id: 'a', now: 5 });
    expect(livePages(state.pages)).toHaveLength(0);
    expect(isEffectivelyTrashed(state.pages, 'c')).toBe(true);
  });

  it('restores a page to its original parent', () => {
    const state = run(base(), { type: 'page.trash', id: 'b', now: 5 }, { type: 'page.restore', id: 'b' });
    expect(state.pages.b!.parentId).toBe('a');
    expect(livePages(state.pages)).toHaveLength(3);
  });

  it('restores to the top level when the parent is still trashed', () => {
    const state = run(
      base(),
      { type: 'page.trash', id: 'b', now: 5 },
      { type: 'page.trash', id: 'a', now: 6 },
      { type: 'page.restore', id: 'b' },
    );
    expect(state.pages.b!.parentId).toBeNull();
    expect(isEffectivelyTrashed(state.pages, 'c')).toBe(false);
  });

  it('only deletes permanently from the trash, including subpages', () => {
    const state = base();
    expect(applyCommand(state, { type: 'page.deleteForever', id: 'a' }).ok).toBe(false);
    const deleted = run(
      state,
      { type: 'page.trash', id: 'a', now: 1 },
      { type: 'page.deleteForever', id: 'a' },
    );
    expect(Object.keys(deleted.pages)).toEqual([]);
    expect(Object.keys(deleted.docs)).toEqual([]);
  });

  it('empties the trash and keeps live pages', () => {
    const state = run(base(), create('d'), { type: 'page.trash', id: 'b', now: 1 }, { type: 'trash.empty' });
    expect(Object.keys(state.pages).sort()).toEqual(['a', 'd']);
  });

  it('cannot create pages inside a trashed page', () => {
    const state = run(base(), { type: 'page.trash', id: 'a', now: 1 });
    expect(applyCommand(state, create('x', 'b')).ok).toBe(false);
  });
});

describe('content', () => {
  it('stores valid documents and rejects invalid ones without changing state', () => {
    const state = run(emptyWorkspace(), create('a'));
    const next = run(state, { type: 'page.setDoc', id: 'a', doc: paragraph('hello'), now: 9 });
    expect(next.docs.a).toEqual(paragraph('hello'));
    const bad = applyCommand(next, {
      type: 'page.setDoc',
      id: 'a',
      doc: { type: 'paragraph' } as DocNode,
      now: 10,
    });
    expect(bad.ok).toBe(false);
    expect(next.docs.a).toEqual(paragraph('hello'));
  });

  it('toggles a checklist item by index', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: false },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }],
            },
            {
              type: 'taskItem',
              attrs: { checked: false },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }],
            },
          ],
        },
      ],
    };
    const state = run(emptyWorkspace(), create('a', null, { doc } as Partial<Command>), {
      type: 'task.setChecked',
      pageId: 'a',
      index: 1,
      checked: true,
      now: 3,
    });
    const items = state.docs.a!.content![0]!.content!;
    expect(items.map((item) => item.attrs?.checked)).toEqual([false, true]);
    expect(
      applyCommand(state, { type: 'task.setChecked', pageId: 'a', index: 7, checked: true, now: 3 }).ok,
    ).toBe(false);
  });

  it('duplicates a page next to the original with copied content', () => {
    const state = run(
      emptyWorkspace(),
      create('a'),
      create('b'),
      { type: 'page.setDoc', id: 'a', doc: paragraph('x'), now: 2 },
      { type: 'page.duplicate', id: 'a', newId: 'a2', now: 3 },
    );
    expect(childrenOf(state.pages, null).map((p) => p.id)).toEqual(['a', 'a2', 'b']);
    expect(state.pages.a2!.title).toBe('a (copy)');
    expect(state.docs.a2).toEqual(paragraph('x'));
    expect(state.docs.a2).not.toBe(state.docs.a);
  });

  it('keeps linked view settings independent when a host page is duplicated', () => {
    const source = create('db', null, {
      kind: 'database',
      database: { properties: [], views: [] },
    } as Partial<Command>);
    const linked: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'linkedDatabaseView',
          attrs: {
            hostPageId: 'host',
            sourceDatabaseId: 'db',
            blockId: 'block-one',
            view: {
              id: 'view-one',
              name: 'One',
              type: 'table',
              filters: [],
              sorts: [],
              groupBy: null,
              dateProp: null,
              hidden: [],
              search: 'one',
            },
          },
        },
      ],
    };
    let state = run(emptyWorkspace(), source, create('host'));
    state = run(state, { type: 'page.setDoc', id: 'host', doc: linked, now: 2 });
    state = run(state, { type: 'page.duplicate', id: 'host', newId: 'copy', now: 3 });
    const original = state.docs.host!.content![0]!;
    const copy = state.docs.copy!.content![0]!;
    expect(copy.attrs?.hostPageId).toBe('copy');
    expect(copy.attrs?.blockId).not.toBe(original.attrs?.blockId);
    expect((copy.attrs?.view as { id: string }).id).not.toBe((original.attrs?.view as { id: string }).id);
    expect(copy.attrs?.view).not.toBe(original.attrs?.view);

    const changedCopy: DocNode = {
      ...state.docs.copy!,
      content: [
        {
          ...copy,
          attrs: { ...copy.attrs, view: { ...(copy.attrs?.view as object), search: 'copy only' } },
        },
      ],
    };
    state = run(state, { type: 'page.setDoc', id: 'copy', doc: changedCopy, now: 4 });
    expect((state.docs.host!.content![0]!.attrs?.view as { search: string }).search).toBe('one');
    expect((state.docs.copy!.content![0]!.attrs?.view as { search: string }).search).toBe('copy only');
  });

  it('blocks recursive or unavailable linked sources and preserves unchanged broken refs during edits', () => {
    const database = (id: string) =>
      create(id, null, {
        kind: 'database',
        database: { properties: [], views: [] },
      } as Partial<Command>);
    const linkedDoc = (sourceDatabaseId: string, blockId: string): DocNode => ({
      type: 'doc',
      content: [
        {
          type: 'linkedDatabaseView',
          attrs: {
            sourceDatabaseId,
            blockId,
            view: {
              id: `${blockId}-view`,
              name: 'Linked',
              type: 'table',
              filters: [],
              sorts: [],
              groupBy: null,
              dateProp: null,
              hidden: [],
            },
          },
        },
      ],
    });
    let state = run(emptyWorkspace(), database('a'), database('b'), create('host'));
    state = run(state, { type: 'page.setDoc', id: 'a', doc: linkedDoc('b', 'a-link'), now: 2 });
    const recursive = applyCommand(state, {
      type: 'page.setDoc',
      id: 'b',
      doc: linkedDoc('a', 'b-link'),
      now: 3,
    });
    expect(recursive.ok).toBe(false);

    state = run(state, { type: 'page.setDoc', id: 'host', doc: linkedDoc('a', 'host-link'), now: 4 });
    const sourceAsPage = applyCommand(state, { type: 'page.setKind', id: 'a', kind: 'page', now: 5 });
    expect(sourceAsPage.ok).toBe(true);
    if (!sourceAsPage.ok) return;
    const brokenState = sourceAsPage.value.state;
    const editedBrokenDoc: DocNode = {
      ...brokenState.docs.host!,
      content: [
        brokenState.docs.host!.content![0]!,
        { type: 'paragraph', content: [{ type: 'text', text: 'edited text' }] },
      ],
    };
    expect(
      applyCommand(brokenState, { type: 'page.setDoc', id: 'host', doc: editedBrokenDoc, now: 6 }).ok,
    ).toBe(true);
    expect(
      applyCommand(brokenState, {
        type: 'page.setDoc',
        id: 'host',
        doc: linkedDoc('missing', 'new-block'),
        now: 6,
      }).ok,
    ).toBe(false);
    expect(
      applyCommand(brokenState, {
        type: 'page.setDoc',
        id: 'host',
        doc: linkedDoc('missing', 'host-link'),
        now: 6,
      }).ok,
    ).toBe(false);
    expect(
      applyCommand(brokenState, { type: 'page.setDoc', id: 'host', doc: paragraph('removed'), now: 6 }).ok,
    ).toBe(true);
    const restoredSource = applyCommand(brokenState, {
      type: 'page.setKind',
      id: 'a',
      kind: 'database',
      now: 7,
    });
    expect(restoredSource.ok).toBe(true);
    if (restoredSource.ok)
      expect(
        applyCommand(restoredSource.value.state, {
          type: 'page.setDoc',
          id: 'host',
          doc: editedBrokenDoc,
          now: 8,
        }).ok,
      ).toBe(true);
  });

  it('blocks source deletion while linked, then removes a view without changing its shared rows', () => {
    const source = create('db', null, {
      kind: 'database',
      database: { properties: [{ id: 'value', name: 'Value', type: 'text', options: [] }], views: [] },
    } as Partial<Command>);
    const linked: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'linkedDatabaseView',
          attrs: {
            sourceDatabaseId: 'db',
            blockId: 'block',
            view: {
              id: 'view',
              name: 'Linked',
              type: 'table',
              filters: [{ id: 'filter', prop: 'value', op: 'notEmpty', value: null }],
              sorts: [],
              groupBy: null,
              dateProp: null,
              hidden: [],
            },
          },
        },
      ],
    };
    let state = run(
      emptyWorkspace(),
      source,
      create('host'),
      create('row', 'db', { properties: { value: 'kept' } } as Partial<Command>),
    );
    state = run(state, { type: 'page.setDoc', id: 'host', doc: linked, now: 2 });
    expect(applyCommand(state, { type: 'page.trash', id: 'db', now: 3 }).ok).toBe(false);
    expect(
      applyCommand(state, {
        type: 'database.set',
        id: 'db',
        database: { ...state.pages.db!.database!, properties: [], views: [] },
        now: 3,
      }).ok,
    ).toBe(false);

    state = run(state, { type: 'page.setDoc', id: 'host', doc: paragraph('view removed'), now: 4 });
    expect(state.pages.row!.properties.value).toBe('kept');
    const current = state.pages.db!.database!;
    state = run(state, {
      type: 'database.set',
      id: 'db',
      database: { ...current, properties: [], views: [] },
      now: 5,
    });
    expect(state.pages.row!.properties).not.toHaveProperty('value');
    expect(state.pages.row!.extra).toHaveProperty('Value', 'kept');
  });

  it('blocks trashing a parent page that contains a source used elsewhere', () => {
    const container = create('container');
    const source = create('db', 'container', {
      kind: 'database',
      database: { properties: [], views: [] },
    } as Partial<Command>);
    const linked: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'linkedDatabaseView',
          attrs: {
            sourceDatabaseId: 'db',
            blockId: 'external-link',
            view: {
              id: 'view',
              name: 'External',
              type: 'table',
              filters: [],
              sorts: [],
              groupBy: null,
              dateProp: null,
              hidden: [],
            },
          },
        },
      ],
    };
    let state = run(emptyWorkspace(), container, source, create('host'));
    state = run(state, { type: 'page.setDoc', id: 'host', doc: linked, now: 2 });
    expect(applyCommand(state, { type: 'page.trash', id: 'container', now: 3 }).ok).toBe(false);
  });

  it('protects formula and default formula bindings from another database when a column is removed', () => {
    const source = create('source', null, {
      title: 'Source',
      kind: 'database',
      database: { properties: [{ id: 'score', name: 'Score', type: 'number', options: [] }], views: [] },
    } as Partial<Command>);
    const other = create('other', null, {
      title: 'Other',
      kind: 'database',
      database: {
        properties: [
          { id: 'formula', name: 'Formula', type: 'number', options: [], formula: 'Source.Score' },
          {
            id: 'default',
            name: 'Default',
            type: 'number',
            options: [],
            fillMode: 'default',
            defaultFormula: 'Source.Score',
          },
        ],
        views: [],
      },
    } as Partial<Command>);
    let state = run(emptyWorkspace(), source, other);
    const otherDatabase = state.pages.other!.database!;
    state = run(state, {
      type: 'database.set',
      id: 'other',
      now: 2,
      database: {
        ...otherDatabase,
        properties: otherDatabase.properties.map((property) =>
          property.id === 'formula'
            ? { ...property, formulaBindings: bindFormulaReferences(property.formula!, 'other', state) }
            : property.id === 'default'
              ? {
                  ...property,
                  defaultFormulaBindings: bindFormulaReferences(property.defaultFormula!, 'other', state),
                }
              : property,
        ),
      },
    });
    const current = state.pages.source!.database!;
    const rejected = applyCommand(state, {
      type: 'database.set',
      id: 'source',
      database: { ...current, properties: [], views: [] },
      now: 3,
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toContain('Formula');
    const otherAfterFormulaRemoval = state.pages.other!.database!;
    state = run(state, {
      type: 'database.set',
      id: 'other',
      database: {
        ...otherAfterFormulaRemoval,
        properties: otherAfterFormulaRemoval.properties.filter((property) => property.id !== 'formula'),
      },
      now: 4,
    });
    const defaultRejected = applyCommand(state, {
      type: 'database.set',
      id: 'source',
      database: { ...state.pages.source!.database!, properties: [], views: [] },
      now: 5,
    });
    expect(defaultRejected.ok).toBe(false);
    if (!defaultRejected.ok) expect(defaultRejected.error).toContain('Default');
  });

  it('ignores backlinks from trashed host pages when a source column is removed', () => {
    const source = create('db', null, {
      kind: 'database',
      database: { properties: [{ id: 'status', name: 'Status', type: 'text', options: [] }], views: [] },
    } as Partial<Command>);
    const linked: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'linkedDatabaseView',
          attrs: {
            sourceDatabaseId: 'db',
            blockId: 'trashed-host-link',
            view: {
              id: 'view',
              name: 'Linked',
              type: 'table',
              filters: [{ id: 'rule', prop: 'status', op: 'is', value: 'done' }],
              sorts: [],
              groupBy: null,
              dateProp: null,
              hidden: [],
            },
          },
        },
      ],
    };
    let state = run(emptyWorkspace(), source, create('host'));
    state = run(state, { type: 'page.setDoc', id: 'host', doc: linked, now: 2 });
    state = run(state, { type: 'page.trash', id: 'host', now: 3 });
    const current = state.pages.db!.database!;
    const removed = applyCommand(state, {
      type: 'database.set',
      id: 'db',
      database: { ...current, properties: [], views: [] },
      now: 4,
    });
    expect(removed.ok).toBe(true);
  });
});

describe('page presentation', () => {
  it('stores a cover focal point and validates per-note style overrides', () => {
    const state = run(emptyWorkspace(), create('a'));
    const covered = run(state, {
      type: 'page.setCover',
      id: 'a',
      cover: 'Images/portrait.jpg',
      coverPosition: 72,
      now: 2,
    });
    expect(covered.pages.a!.coverPosition).toBe(72);
    expect(covered.pages.a!.cover).toBe('Images/portrait.jpg');
    expect(
      applyCommand(covered, {
        type: 'page.setCover',
        id: 'a',
        cover: 'Images/portrait.jpg',
        coverPosition: 101,
        now: 3,
      }).ok,
    ).toBe(false);

    const style = { font: 'serif', fontSize: 20, lineHeight: 1.8, blockSpacing: 14, width: 'wide' } as const;
    const styled = run(covered, { type: 'page.setNoteStyle', id: 'a', style, now: 3 });
    expect(styled.pages.a!.noteStyle).toEqual(style);
    expect(
      applyCommand(styled, { type: 'page.setNoteStyle', id: 'a', style: { ...style, fontSize: 80 }, now: 4 })
        .ok,
    ).toBe(false);
    const reset = run(styled, { type: 'page.setNoteStyle', id: 'a', style: null, now: 5 });
    expect(reset.pages.a!.noteStyle).toBeNull();
  });
});

describe('robustness', () => {
  const junk: unknown[] = [
    null,
    undefined,
    0,
    -1,
    NaN,
    Infinity,
    '',
    '../../x',
    {},
    [],
    'a'.repeat(5000),
    { type: 'doc' },
  ];

  it('never throws on hostile command parameters', () => {
    const state = run(emptyWorkspace(), create('a'), create('b', 'a'));
    const types: Command['type'][] = [
      'page.create',
      'page.rename',
      'page.setIcon',
      'page.move',
      'page.duplicate',
      'page.setDoc',
      'page.setFavorite',
      'page.markOpened',
      'page.trash',
      'page.restore',
      'page.deleteForever',
      'trash.empty',
      'task.setChecked',
      'pages.insert',
    ];
    for (const type of types) {
      for (const value of junk) {
        const command = {
          type,
          id: value,
          newId: value,
          parentId: value,
          pageId: value,
          title: value,
          icon: value,
          doc: value,
          index: value,
          now: value,
          pages: value,
          docs: value,
          checked: value,
        } as unknown as Command;
        expect(() => applyCommand(state, command)).not.toThrow();
      }
    }
    expect(applyCommand(state, { type: 'nope' } as unknown as Command).ok).toBe(false);
  });

  it('survives a corrupted parent cycle in stored data', () => {
    const state = run(emptyWorkspace(), create('a'), create('b'));
    const corrupted: WorkspaceState = {
      ...state,
      pages: { a: { ...state.pages.a!, parentId: 'b' }, b: { ...state.pages.b!, parentId: 'a' } },
    };
    expect(() => livePages(corrupted.pages)).not.toThrow();
    expect(applyCommand(corrupted, { type: 'page.move', id: 'a', parentId: null }).ok).toBe(true);
  });
});
