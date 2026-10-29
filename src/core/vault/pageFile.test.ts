import { parse, stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { bindFormulaReferences } from '../database';
import { applyCommand } from '../commands';
import { DEFAULT_NOTE_STYLE, newPageMeta } from '../model';
import type { DatabaseDef, FilterGroup, PropDef, WorkspaceState } from '../model';
import { normalizeDatabase } from '../migrations';
import { loadVault } from './load';
import { composeFrontmatter, managedFrontmatter, readPageText } from './pageFile';

describe('formula reference persistence', () => {
  it('round-trips stable formula bindings through database YAML', () => {
    const amount: PropDef = { id: 'amount', name: 'Valor', type: 'number', options: [] };
    const formula: PropDef = { id: 'sum', name: 'Soma', type: 'formula', options: [], formula: 'thisRow.Valor' };
    const database: DatabaseDef = { properties: [amount, formula], views: [] };
    const page = newPageMeta({ id: 'db', parentId: null, title: 'Resumo', kind: 'database', database });
    const state: WorkspaceState = { pages: { db: page }, docs: {} };
    formula.formulaBindings = bindFormulaReferences(formula.formula!, 'db', state);

    const managed = managedFrontmatter(page, 'Resumo', null);
    const data = composeFrontmatter(managed, {}, null);
    const yaml = stringify(data);
    const text = `---\n${yaml}${yaml.endsWith('\n') ? '' : '\n'}---\n`;
    const loaded = readPageText(text);
    expect(loaded.error).toBeNull();
    expect(loaded.database?.properties[1]?.formulaBindings).toEqual(formula.formulaBindings);
  });

  it('round trips the full-width note style through Markdown frontmatter', () => {
    const style = { ...DEFAULT_NOTE_STYLE, width: 'full' } as const;
    const page = {
      ...newPageMeta({ id: 'layout', parentId: null, title: 'Layout', kind: 'page' }),
      noteStyle: style,
    };
    const managed = managedFrontmatter(page, 'Layout', null);
    const yaml = stringify(composeFrontmatter(managed, {}, null));
    const loaded = readPageText(`---\n${yaml}${yaml.endsWith('\n') ? '' : '\n'}---\n`);
    expect(loaded.error).toBeNull();
    expect(loaded.noteStyle).toEqual(style);
  });

  it('binds legacy formulas during a vault reopen while all table schemas are available', () => {
    const databaseText = [
      '---',
      'kind: database',
      'database:',
      '  properties:',
      '    - id: amount',
      '      name: Amount',
      '      type: number',
      '    - id: total',
      '      name: Total',
      '      type: formula',
      '      formula: prop("Amount") * 2',
      '  views: []',
      '---',
    ].join('\n');
    const rowText = ['---', 'Amount: 6', '---', ''].join('\n');
    const loaded = loadVault({
      files: [
        { path: 'Ledger.md', text: databaseText, mtime: 1, birthtime: 1 },
        { path: 'Ledger/One.md', text: rowText, mtime: 2, birthtime: 2 },
      ],
      folders: [],
      others: [],
      registry: null,
      recent: null,
    }, (() => { let next = 0; return () => `generated-${next++}`; })());
    const loadedDatabase = loaded.pages.find((page) => page.kind === 'database')!;
    const total = loadedDatabase.database!.properties.find((prop) => prop.id === 'total')!;
    expect(total.formulaBindings).toEqual([
      { start: 5, end: 13, source: '"Amount"', kind: 'property', databaseId: loadedDatabase.id, propertyId: 'amount' },
    ]);
  });
});

describe('saved filter persistence', () => {
  it('round-trips grouped saved rules and their combination logic through Markdown', () => {
    const filterGroups: FilterGroup[] = [
      {
        id: 'group-a',
        logic: 'or',
        filters: [
          { id: 'filter-a', prop: 'status', op: 'is', value: 'done' },
          { id: 'filter-b', prop: 'status', op: 'is', value: 'in-progress' },
        ],
      },
      {
        id: 'group-b',
        logic: 'and',
        filters: [{ id: 'filter-c', prop: 'score', op: 'gt', value: 4 }],
      },
    ];
    const database: DatabaseDef = {
      properties: [],
      views: [
        {
          id: 'view',
          name: 'Saved rules',
          type: 'table',
          filters: [],
          filterGroups,
          filterGroupLogic: 'or',
          sorts: [],
          groupBy: null,
          dateProp: null,
          hidden: [],
        },
      ],
    };
    const page = newPageMeta({ id: 'db', parentId: null, title: 'Records', kind: 'database', database });
    const data = composeFrontmatter(managedFrontmatter(page, 'Records', null), {}, null);
    const yaml = stringify(data);
    const loaded = readPageText(`---\n${yaml}${yaml.endsWith('\n') ? '' : '\n'}---\n`);

    expect(loaded.error).toBeNull();
    expect(loaded.database?.views[0]?.filterGroups).toEqual(filterGroups);
    expect(loaded.database?.views[0]?.filterGroupLogic).toBe('or');
  });

  it('keeps each view’s table presentation after Markdown reopen', () => {
    const database: DatabaseDef = {
      properties: [{ id: 'amount', name: 'Amount', type: 'number', options: [] }],
      displayPropertyId: 'amount',
      views: [
        { id: 'wide', name: 'Wide', type: 'table', filters: [], sorts: [], groupBy: null,
          dateProp: null, hidden: [], widths: { amount: 280 }, frozenThrough: 'amount', rowHeight: 68,
          order: ['amount'], wrap: ['amount'], align: { amount: 'right' },
          summaries: { amount: 'sum' }, search: 'open',
          conditionalFormats: [{ id: 'rule', prop: 'amount', op: 'gt', value: 10, scope: 'cell', color: 'red' }],
        },
        { id: 'plain', name: 'Plain', type: 'table', filters: [], sorts: [], groupBy: null,
          dateProp: null, hidden: [], rowHeight: 34 },
      ],
    };
    const page = newPageMeta({ id: 'db', parentId: null, title: 'Records', kind: 'database', database });
    const yaml = stringify(composeFrontmatter(managedFrontmatter(page, 'Records', null), {}, null));
    const loaded = readPageText(`---\n${yaml}${yaml.endsWith('\n') ? '' : '\n'}---\n`);
    expect(loaded.error).toBeNull();
    expect(loaded.database?.displayPropertyId).toBe('amount');
    expect(loaded.database?.views[0]).toMatchObject({
      widths: { amount: 280 }, frozenThrough: 'amount', rowHeight: 68, order: ['amount'],
      wrap: ['amount'], align: { amount: 'right' }, summaries: { amount: 'sum' }, search: 'open',
      conditionalFormats: [{ id: 'rule', prop: 'amount', op: 'gt', value: 10, scope: 'cell', color: 'red' }],
    });
    expect(loaded.database?.views[1]?.rowHeight).toBe(34);
    expect(loaded.database?.views[1]?.frozenThrough).toBeUndefined();
  });
});

describe('conditional formatting persistence', () => {
  const sourcePage = (database: DatabaseDef) => newPageMeta({
    id: 'db', parentId: null, title: 'Rules', kind: 'database', database,
  });

  const yamlFor = (database: DatabaseDef) => {
    const page = sourcePage(database);
    return stringify(composeFrontmatter(managedFrontmatter(page, page.title, null), {}, null));
  };

  const pageText = (yaml: string) => `---\n${yaml}${yaml.endsWith('\n') ? '' : '\n'}---\n`;

  it('round-trips invalid and future rules opaquely and idempotently through an unrelated edit', () => {
    const amount: PropDef = { id: 'amount', name: 'Amount', type: 'number', options: [] };
    const first = { id: 'first', prop: 'amount', op: 'gt', value: 0, scope: 'row', color: 'green' };
    const future = {
      id: 'future', prop: 'amount', op: 'gt', value: 10, scope: 'cell', color: 'red', futureStyle: 'glow',
    };
    const invalid = { id: 'invalid', prop: 'amount', op: 'gt', value: 5, scope: 'cell', color: 'ultraviolet' };
    const nonObject = 'future-rule-token';
    const last = {
      id: 'last', prop: 'amount', op: 'gt', value: 2, scope: 'cell', textColor: 'blue', bold: false, italic: true,
    };
    const expectedSource = [first, future, invalid, nonObject, last];
    const expectedSerializedSource = [
      { ...first, mode: 'simple', formula: '' }, future, invalid, nonObject,
      { ...last, mode: 'simple', formula: '' },
    ];

    const normalized = normalizeDatabase({
      properties: [amount],
      views: [{ id: 'view', name: 'Original', type: 'table', conditionalFormats: expectedSource }],
    })!;
    const view = normalized.views[0]!;
    expect(view.conditionalFormats?.map((rule) => rule.id)).toEqual(['first', 'last']);
    expect(view.unsupportedConditionalFormats?.map((entry) => entry.raw)).toEqual([future, invalid, nonObject]);
    expect(view.unsupportedConditionalFormats?.every((entry) => entry.reason.length > 0)).toBe(true);

    const state: WorkspaceState = { pages: { db: sourcePage(normalized) }, docs: {} };
    const command = applyCommand(state, {
      type: 'database.set',
      id: 'db',
      database: {
        ...normalized,
        views: normalized.views.map((candidate) => ({ ...candidate, name: 'Renamed' })),
      },
      now: 2,
    });
    expect(command.ok).toBe(true);
    if (!command.ok) throw new Error(command.error);
    const edited = command.value.state.pages.db!.database!;
    const firstYaml = yamlFor(edited);
    const firstRaw = (parse(firstYaml) as { database: { views: Array<{ conditionalFormats: unknown[] }> } })
      .database.views[0]!.conditionalFormats;
    expect(firstRaw).toEqual(expectedSerializedSource);

    const reopened = readPageText(pageText(firstYaml));
    expect(reopened.error).toBeNull();
    expect(reopened.database?.views[0]?.unsupportedConditionalFormats?.map((entry) => entry.raw))
      .toEqual([future, invalid, nonObject]);
    const reopenedDatabase = reopened.database!;
    const secondYaml = yamlFor(reopenedDatabase);
    const secondRaw = (parse(secondYaml) as { database: { views: Array<{ conditionalFormats: unknown[] }> } })
      .database.views[0]!.conditionalFormats;
    expect(secondRaw).toEqual(firstRaw);
    expect(reopenedDatabase.views[0]?.unsupportedConditionalFormats?.map((entry) => entry.raw))
      .toEqual([future, invalid, nonObject]);
  });

  it('keeps opaque entries anchored through valid-rule reordering and deletion', () => {
    const amount: PropDef = { id: 'amount', name: 'Amount', type: 'number', options: [] };
    const first = { id: 'first', prop: 'amount', op: 'gt', value: 0, scope: 'row', color: 'green' };
    const opaqueA = { id: 'opaque-a', future: 'a' };
    const opaqueB = { id: 'opaque-b', future: 'b' };
    const last = { id: 'last', prop: 'amount', op: 'gt', value: 2, scope: 'cell', color: 'blue' };
    const database = normalizeDatabase({
      properties: [amount],
      views: [{ id: 'view', name: 'View', type: 'table', conditionalFormats: [first, opaqueA, opaqueB, last] }],
    })!;
    const view = database.views[0]!;

    const reordered: DatabaseDef = {
      ...database,
      views: [{ ...view, conditionalFormats: [view.conditionalFormats![1]!, view.conditionalFormats![0]!] }],
    };
    const reorderedRaw = (parse(yamlFor(reordered)) as { database: { views: Array<{ conditionalFormats: unknown[] }> } })
      .database.views[0]!.conditionalFormats;
    expect(reorderedRaw).toEqual([
      opaqueA, opaqueB, { ...last, mode: 'simple', formula: '' }, { ...first, mode: 'simple', formula: '' },
    ]);

    const withoutLast: DatabaseDef = {
      ...database,
      views: [{ ...view, conditionalFormats: [view.conditionalFormats![0]!] }],
    };
    const deletedRaw = (parse(yamlFor(withoutLast)) as { database: { views: Array<{ conditionalFormats: unknown[] }> } })
      .database.views[0]!.conditionalFormats;
    expect(deletedRaw).toEqual([{ ...first, mode: 'simple', formula: '' }, opaqueA, opaqueB]);

    const withoutNeighbors: DatabaseDef = {
      ...database,
      views: [{ ...view, conditionalFormats: [] }],
    };
    const fallbackRaw = (parse(yamlFor(withoutNeighbors)) as { database: { views: Array<{ conditionalFormats: unknown[] }> } })
      .database.views[0]!.conditionalFormats;
    expect(fallbackRaw).toEqual([opaqueA, opaqueB]);
  });

  it('retains a large overflow list without parsing entries past the supported rule limit', () => {
    const supported = Array.from({ length: 100 }, (_, index) => ({
      id: `supported-${index}`,
      prop: 'title',
      op: 'contains',
      value: 'row',
      scope: 'row',
      color: 'red',
    }));
    const overflow = Array.from({ length: 3000 }, (_, index) => ({
      id: `overflow-${index}`,
      prop: 'title',
      op: 'is',
      value: null,
      scope: 'row',
      mode: 'formula',
      formula: '(',
      color: 'blue',
    }));
    const entries = [...supported, ...overflow];
    const database = normalizeDatabase({
      properties: [],
      views: [{ id: 'view', name: 'View', type: 'table', conditionalFormats: entries }],
    })!;
    expect(database.views[0]?.conditionalFormats).toHaveLength(100);
    expect(database.views[0]?.unsupportedConditionalFormats).toHaveLength(overflow.length);
    expect(database.views[0]?.unsupportedConditionalFormats?.map((entry) => entry.reason))
      .toEqual(Array(overflow.length).fill("Rule is beyond this version's 100-rule limit."));
    expect(database.views[0]?.unsupportedConditionalFormats?.map((entry) => entry.raw)).toEqual(overflow);
    const raw = (parse(yamlFor(database)) as { database: { views: Array<{ conditionalFormats: unknown[] }> } })
      .database.views[0]!.conditionalFormats;
    expect(raw).toEqual([
      ...supported.map((rule) => ({ ...rule, mode: 'simple', formula: '' })),
      ...overflow,
    ]);
  });

  it('preserves a malformed whole rules value without treating it as an empty list', () => {
    const unsupportedValue = { version: 2, rules: ['future-format'] };
    const database = normalizeDatabase({
      properties: [],
      views: [{ id: 'view', name: 'View', type: 'table', conditionalFormats: unsupportedValue }],
    })!;
    expect(database.views[0]?.unsupportedConditionalFormats).toMatchObject([
      { index: 0, raw: unsupportedValue, wholeList: true },
    ]);
    const raw = (parse(yamlFor(database)) as { database: { views: Array<{ conditionalFormats: unknown }> } })
      .database.views[0]!.conditionalFormats;
    expect(raw).toEqual(unsupportedValue);
  });
});
