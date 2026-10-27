import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { bindFormulaReferences } from '../database';
import { DEFAULT_NOTE_STYLE, newPageMeta } from '../model';
import type { DatabaseDef, FilterGroup, PropDef, WorkspaceState } from '../model';
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
    expect(loaded.database?.views[0]).toMatchObject({
      widths: { amount: 280 }, frozenThrough: 'amount', rowHeight: 68, order: ['amount'],
      wrap: ['amount'], align: { amount: 'right' }, summaries: { amount: 'sum' }, search: 'open',
      conditionalFormats: [{ id: 'rule', prop: 'amount', op: 'gt', value: 10, scope: 'cell', color: 'red' }],
    });
    expect(loaded.database?.views[1]?.rowHeight).toBe(34);
    expect(loaded.database?.views[1]?.frozenThrough).toBeUndefined();
  });
});
