import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../commands';
import {
  hasUnrepresentableDatabaseSchema,
  findUnrepresentablePageContent,
  findUnrepresentableVaultMetadata,
} from './compatibility';
import { markdownToDoc } from '../markdown/parse';
import { docToMarkdown } from '../markdown/serialize';
import { SCHEMA_VERSION, emptyWorkspace, newPageMeta } from '../model';
import type { DatabaseDef, PropValue } from '../model';
import { encodePolarisDadosViewMarker } from '../polarisDadosView';
import { loadVault } from './load';
import {
  composeFrontmatter,
  managedFrontmatter,
  readPageText,
  renderPageText,
  takeProperties,
  writeProperty,
} from './pageFile';

const basicDatabase = `---
kind: database
polarisDados:
  version: 1
  provider: polaris-dados
database:
  properties:
    - id: name
      name: Name
      type: text
    - id: total
      name: Total
      type: formula
      formula: Quantity * Price
  views:
    - id: table
      name: Table
      type: table
      filters:
        - id: filter-1
          prop: name
          op: contains
          value: Widget
      sorts:
        - prop: name
          dir: asc
      widths:
        name: 220
---
`;

function databaseNote(database: unknown, options: { marker?: unknown; omitMarker?: boolean } = {}): string {
  const yaml = stringify({
    kind: 'database',
    ...(!options.omitMarker
      ? {
          polarisDados: Object.hasOwn(options, 'marker')
            ? options.marker
            : { version: 1, provider: 'polaris-dados' },
        }
      : {}),
    database,
  });
  return `---\n${yaml}---\nInventory body\n`;
}

function columnLayout(count: number, emptyColumn = -1): string {
  const columns = Array.from({ length: count }, (_, index) => {
    const body = index === emptyColumn ? '' : `Column ${index + 1} ^column-${index + 1}`;
    return `<div data-column>\n\n${body}\n\n</div>`;
  });
  return `<div data-columns>\n${columns.join('\n')}\n</div>`;
}

function metadataDatabase(groupKeys: string[], widgetCount: number) {
  const kinds = ['count', 'sum', 'average', 'min', 'max', 'bar', 'hbar', 'donut', 'line'];
  const widgets = Array.from({ length: widgetCount }, (_, index) => {
    const kind = kinds[index % kinds.length]!;
    const prop =
      kind === 'count' || kind === 'line'
        ? null
        : ['bar', 'hbar', 'donut'].includes(kind)
          ? 'reviewed'
          : 'amount';
    return {
      id: `widget-${index}`,
      kind,
      prop,
      ...(index === 0 ? { title: 'W'.repeat(80) } : {}),
      wide: index % 2 === 0,
    };
  });
  return {
    properties: [
      { id: 'name', name: 'Name', type: 'text', wrap: true },
      { id: 'amount', name: 'Amount', type: 'number' },
      { id: 'reviewed', name: 'Reviewed', type: 'checkbox' },
    ],
    views: [
      {
        id: 'table',
        name: 'Table',
        type: 'table',
        groupBy: 'reviewed',
        groupOrder: groupKeys,
        hiddenGroups: groupKeys,
        collapsedGroups: groupKeys,
        hideEmptyGroups: true,
        limit: 0,
      },
      { id: 'dashboard', name: 'Dashboard', type: 'dashboard', widgets },
      { id: 'default', name: 'Default', type: 'table' },
    ],
  };
}

describe('vault representability guard', () => {
  it('accepts only bare, representable column groups with two to seven columns', () => {
    for (let count = 2; count <= 7; count++) {
      const source = `Before ^before\n\n${columnLayout(count, count - 1)}\n\nAfter ^after`;
      expect(findUnrepresentablePageContent(source), `column count ${count}`).toBeNull();
      const parsed = markdownToDoc(source);
      const columns = parsed.content?.find((node) => node.type === 'columns');
      expect(columns?.content).toHaveLength(count);
      expect(columns?.content?.at(-1)?.content).toEqual([{ type: 'paragraph', content: [] }]);
      expect(parsed.content?.[0]?.attrs?.blockId).toBe('before');
      expect(parsed.content?.at(-1)?.attrs?.blockId).toBe('after');
    }

    for (const count of [0, 1, 8]) {
      expect(findUnrepresentablePageContent(columnLayout(count)), `column count ${count}`).toMatch(
        /column/i,
      );
    }
  });

  it('protects malformed or attributed column wrappers while keeping the bytes available', () => {
    const unsupported = [
      '<div data-columns class="future">\n<div data-column>\n\nOne\n\n</div>\n<div data-column>\n\nTwo\n\n</div>\n</div>',
      '<div class="future" data-columns>\n<div data-column>\n\nOne\n\n</div>\n<div data-column>\n\nTwo\n\n</div>\n</div>',
      '<div data-columns class="future">\n</div>',
      '<div class="future" data-columns>\n</div>',
      '<div data-columns>\n<div data-column data-block-id="opaque">\n\nOne\n\n</div>\n<div data-column>\n\nTwo\n\n</div>\n</div>',
      '<div data-columns>\n<div data-column>\n\nOne\n\n</div>\n<div data-column>\n\n<div class="nested">\n\nUnknown\n\n</div>\n\n</div>\n</div>',
      `${columnLayout(2)}\n</div>\n\nAfter ^after`,
      '<div data-columns>\nLoose wrapper content\n<div data-column>\n\nOne\n\n</div>\n<div data-column>\n\nTwo\n\n</div>\n</div>',
      '<div data-columns>\n<div data-column>\n\nOne\n\n</div>\n',
      '<div data-column>\n\nOrphan\n\n</div>',
      '<div class="future">\n<div data-columns>\n<div data-column>\n\nOne\n\n</div>\n<div data-column>\n\nTwo\n\n</div>\n</div>\n</div>',
      '<div data-columns data-widths="50,50">\n<div data-column>\n\nOne\n\n</div>\n<div data-column>\n\nTwo\n\n</div>\n</div>',
      '<div data-columns>\n<div data-column>\n\nOne ^recognized-id\n\n</div>\n<div data-column data-block-id="opaque">\n\nTwo\n\n</div>\n</div>',
    ];

    for (const [index, body] of unsupported.entries()) {
      const source = `---\ntitle: Protected ${index}\ncustom: keep\n---\n${body}\n`;
      expect(findUnrepresentablePageContent(source), source).not.toBeNull();
      const loaded = loadVault(
        {
          files: [{ path: `Protected ${index}.md`, text: source, mtime: 1, birthtime: 1 }],
          folders: [],
          others: [],
          registry: null,
          recent: null,
        },
        () => `protected-${index}`,
        1,
      );
      expect(loaded.protectedPages.has(`protected-${index}`)).toBe(true);
      expect(loaded.texts.get(`protected-${index}`)).toBe(source);
      expect(loaded.docs[`protected-${index}`]).toEqual({
        type: 'doc',
        content: [{ type: 'rawBlock', attrs: { text: source } }],
      });
    }

    expect(findUnrepresentablePageContent('<div data-columns data-widths="50,50">')).not.toBeNull();
    expect(findUnrepresentablePageContent('<div title="data-columns">A future attribute value</div>')).toBeNull();
    expect(findUnrepresentablePageContent('<p data-block-id="opaque">Block</p>')).not.toBeNull();
  });

  it('preserves a standalone closing div after a valid column token', () => {
    const source = `${columnLayout(2)}\n\n</div>\n\nAfter ^after`;
    expect(findUnrepresentablePageContent(source)).toBeNull();
    const roundTrip = docToMarkdown(markdownToDoc(source));
    expect(roundTrip.match(/<\/div>/g)).toHaveLength(4);
    expect(roundTrip).toContain('After ^after');
  });

  it('keeps a self-contained opaque div as a raw block inside an editable column', () => {
    const opaque = '<div class="ordinary">\nOpaque raw content\n</div>';
    const source = `<div data-columns>\n<div data-column>\n\nBefore\n\n${opaque}\n\nAfter\n\n</div>\n<div data-column>\n\nSecond column\n\n</div>\n</div>`;
    expect(findUnrepresentablePageContent(source)).toBeNull();

    const parsed = markdownToDoc(source);
    const columns = parsed.content?.[0];
    expect(columns?.type).toBe('columns');
    expect(columns?.content?.[0]?.content?.some((node) => node.type === 'rawBlock' && node.attrs?.text === opaque)).toBe(
      true,
    );

    const fragmented = source.replace(opaque, '<div class="ordinary">\n\nOpaque raw content\n\n</div>');
    expect(findUnrepresentablePageContent(fragmented)).not.toBeNull();

    const fragmentedSingleColumn = '<div data-columns>\n<div data-column>\n\n<div class="ordinary">\n\nInner\n\n</div>\n\n</div>\n</div>';
    expect(findUnrepresentablePageContent(fragmentedSingleColumn)).not.toBeNull();

    const nestedOpaqueForms = [
      '<div class="outer">\n<div class="inner">Opaque raw content</div>\n</div>',
      '<div class="outer"><div class="inner">Opaque raw content</div></div>',
      '<div class="one">One</div>\n<div class="two">Two</div>',
      '<div id="notice" aria-label="Info">Raw note</div>',
      '<div id="notice" aria-label="Info">Raw <strong>note</strong></div>',
      '<div class="outer">\n<!-- keep this -->\n<div class="inner">Opaque raw content</div>\n</div>',
    ];
    for (const nestedOpaque of nestedOpaqueForms) {
      const nestedSource = source.replace(opaque, nestedOpaque);
      expect(findUnrepresentablePageContent(nestedSource)).toBeNull();
      const nestedDoc = markdownToDoc(nestedSource);
      const nestedRawBlock = nestedDoc.content?.[0]?.content?.[0]?.content?.find((node) => node.type === 'rawBlock');
      expect(nestedRawBlock?.attrs?.text).toBe(nestedOpaque);
      expect(docToMarkdown(nestedDoc)).toContain(nestedOpaque);
    }

    const withNestedLayoutMarker = source.replace(
      opaque,
      '<div class="ordinary" data-column>\nOpaque raw content\n</div>',
    );
    expect(findUnrepresentablePageContent(withNestedLayoutMarker)).not.toBeNull();
  });

  it('keeps rich Markdown blocks representable in two to five bare columns', () => {
    const content = [
      '**Bold** with [a link](https://example.org) ^rich-one',
      '- First item\n- Second item',
      '> A quoted block',
      '# A heading',
      'A paragraph with *emphasis* ^rich-five',
    ];
    for (let count = 2; count <= 5; count++) {
      const wrappers = content
        .slice(0, count)
        .map((body) => `<div data-column>\n\n${body}\n\n</div>`)
        .join('\n');
      const source = `<div data-columns>\n${wrappers}\n</div>\n`;
      expect(findUnrepresentablePageContent(source), `column count ${count}`).toBeNull();
      const parsed = markdownToDoc(source);
      expect(parsed.content?.[0]?.content).toHaveLength(count);
      expect(parsed.content?.[0]?.content?.map((column) => column.content?.[0]?.type)).toEqual(
        ['paragraph', 'bulletList', 'blockquote', 'heading', 'paragraph'].slice(0, count),
      );
    }
  });

  it('allows upstream database fields and the reserved Polaris Dados v1 envelope', () => {
    expect(findUnrepresentablePageContent(basicDatabase)).toBeNull();
    expect(
      findUnrepresentablePageContent(
        basicDatabase.replace(
          '---\n# Inventory',
          'vendorRecord:\n  id: opaque\n  nested:\n    preserve: true\n---\n# Inventory',
        ),
      ),
    ).toBeNull();
  });

  it('accepts and rewrites the narrow number display format while protecting unknown shapes', () => {
    const format = { locale: 'de-DE', precision: 1.5, negativeFormat: 'parentheses' } as const;
    const source = databaseNote({
      properties: [{ id: 'amount', name: 'Amount', type: 'number', format }],
      views: [],
    });

    expect(findUnrepresentablePageContent(source)).toBeNull();
    expect(hasUnrepresentableDatabaseSchema(source)).toBe(false);
    const read = readPageText(source);
    expect(read.database?.properties[0]?.format).toEqual(format);

    const page = newPageMeta({
      id: 'inventory',
      parentId: null,
      title: 'Inventory',
      kind: 'database',
      database: read.database,
      extra: read.extra,
    });
    const saved = renderPageText(
      composeFrontmatter(managedFrontmatter(page, 'Inventory', null), read.extra, null),
      null,
      read.body,
    );
    expect(readPageText(saved).database?.properties[0]?.format).toEqual(format);

    const unsupported = [
      { precision: -0.1 },
      { precision: 8.1 },
      { precision: Number.POSITIVE_INFINITY },
      { negativeFormat: 'brackets' },
      { locale: 'not a locale' },
      { locale: 'en-US', currency: 'BRL' },
    ];
    for (const candidate of unsupported) {
      const note = databaseNote({
        properties: [{ id: 'amount', name: 'Amount', type: 'number', format: candidate }],
        views: [],
      });
      expect(findUnrepresentablePageContent(note)).toMatch(/number property format/i);
      expect(hasUnrepresentableDatabaseSchema(note)).toBe(true);
    }

    const nonNumber = databaseNote({
      properties: [{ id: 'label', name: 'Label', type: 'text', format: { precision: 2 } }],
      views: [],
    });
    expect(findUnrepresentablePageContent(nonNumber)).toMatch(/number property format/i);
  });

  it('preserves explicit decimal formats on implicit formula properties without persisting results', () => {
    const format = { locale: 'de-DE', precision: 1.5, negativeFormat: 'parentheses' } as const;
    const source = databaseNote({
      properties: [
        { id: 'quantity', name: 'Quantity', type: 'number' },
        { id: 'total', name: 'Total', type: 'formula', formula: 'Quantity * 2', format },
      ],
      views: [],
    });

    expect(findUnrepresentablePageContent(source)).toBeNull();
    expect(hasUnrepresentableDatabaseSchema(source)).toBe(false);
    const read = readPageText(source);
    expect(read.database?.properties[1]?.format).toEqual(format);

    const database = newPageMeta({
      id: 'inventory',
      parentId: null,
      title: 'Inventory',
      kind: 'database',
      database: read.database,
      extra: read.extra,
    });
    const saved = renderPageText(
      composeFrontmatter(managedFrontmatter(database, 'Inventory', null), read.extra, null),
      null,
      read.body,
    );
    expect(findUnrepresentablePageContent(saved)).toBeNull();
    expect(readPageText(saved).database?.properties[1]?.format).toEqual(format);

    const row = newPageMeta({
      id: 'row-1',
      parentId: 'inventory',
      title: 'Widget',
      kind: 'page',
      properties: { quantity: 4, total: 8 },
    });
    const rowText = renderPageText(
      composeFrontmatter(managedFrontmatter(row, 'Widget', read.database), {}, null),
      null,
      'Row data\n',
    );
    expect(readPageText(rowText).data.Quantity).toBe(4);
    expect(readPageText(rowText).data.Total).toBeUndefined();
    expect(rowText).not.toMatch(/^Total:/m);
  });

  it('roundtrips explicit currency formats on implicit formula properties without persisting results', () => {
    const defaultCurrencyFormat = { currency: 'ZZZ' } as const;
    const configuredCurrencyFormat = {
      locale: 'de-DE',
      currency: 'JPY',
      precision: 3,
      negativeFormat: 'parentheses',
    } as const;
    const fractionalCurrencyFormat = {
      locale: 'en-US',
      currency: 'USD',
      precision: 1.5,
      negativeFormat: 'parentheses',
    } as const;
    const source = databaseNote({
      properties: [
        { id: 'quantity', name: 'Quantity', type: 'number' },
        { id: 'default-total', name: 'Default total', type: 'formula', formula: 'Quantity * 2', format: defaultCurrencyFormat },
        { id: 'configured-total', name: 'Configured total', type: 'formula', formula: 'Quantity * -2', format: configuredCurrencyFormat },
        { id: 'fractional-total', name: 'Fractional total', type: 'formula', formula: 'Quantity * -2', format: fractionalCurrencyFormat },
      ],
      views: [],
    });

    expect(findUnrepresentablePageContent(source)).toBeNull();
    expect(hasUnrepresentableDatabaseSchema(source)).toBe(false);
    const read = readPageText(source);
    expect(read.database?.properties[1]?.format).toEqual(defaultCurrencyFormat);
    expect(read.database?.properties[2]?.format).toEqual(configuredCurrencyFormat);
    expect(read.database?.properties[3]?.format).toEqual(fractionalCurrencyFormat);

    const database = newPageMeta({
      id: 'inventory',
      parentId: null,
      title: 'Inventory',
      kind: 'database',
      database: read.database,
      extra: read.extra,
    });
    const saved = renderPageText(
      composeFrontmatter(managedFrontmatter(database, 'Inventory', null), read.extra, null),
      null,
      read.body,
    );
    expect(findUnrepresentablePageContent(saved)).toBeNull();
    expect(readPageText(saved).database?.properties[1]?.format).toEqual(defaultCurrencyFormat);
    expect(readPageText(saved).database?.properties[2]?.format).toEqual(configuredCurrencyFormat);
    expect(readPageText(saved).database?.properties[3]?.format).toEqual(fractionalCurrencyFormat);

    const row = newPageMeta({
      id: 'row-1',
      parentId: 'inventory',
      title: 'Widget',
      kind: 'page',
      properties: { quantity: 4, 'default-total': 8, 'configured-total': -8, 'fractional-total': -8 },
    });
    const rowText = renderPageText(
      composeFrontmatter(managedFrontmatter(row, 'Widget', read.database), {}, null),
      null,
      'Row data\n',
    );
    expect(readPageText(rowText).data.Quantity).toBe(4);
    expect(readPageText(rowText).data['Default total']).toBeUndefined();
    expect(readPageText(rowText).data['Configured total']).toBeUndefined();
    expect(readPageText(rowText).data['Fractional total']).toBeUndefined();
    expect(rowText).not.toMatch(/^Default total:/m);
    expect(rowText).not.toMatch(/^Configured total:/m);
    expect(rowText).not.toMatch(/^Fractional total:/m);
  });

  it('roundtrips explicit percentage declarations and their optional formats on opted-in databases', () => {
    const databaseSchema = {
      properties: [
        { id: 'quantity', name: 'Quantity', type: 'number' },
        {
          id: 'ratio',
          name: 'Ratio',
          type: 'formula',
          formula: 'Quantity / 8',
          formulaResultType: 'percent',
          format: { locale: 'de-DE', precision: 1.5, negativeFormat: 'parentheses' },
        },
        {
          id: 'ratio-without-precision',
          name: 'Ratio without precision',
          type: 'formula',
          formula: 'Quantity / 8',
          formulaResultType: 'percent',
          format: { locale: 'en-US', negativeFormat: 'minus' },
        },
        {
          id: 'ratio-zero-precision',
          name: 'Ratio zero precision',
          type: 'formula',
          formula: 'Quantity / 8',
          formulaResultType: 'percent',
          format: { precision: 0 },
        },
        {
          id: 'ratio-eight-precision',
          name: 'Ratio eight precision',
          type: 'formula',
          formula: 'Quantity / 8',
          formulaResultType: 'percent',
          format: { precision: 8 },
        },
        {
          id: 'ratio-empty-format',
          name: 'Ratio empty format',
          type: 'formula',
          formula: 'Quantity / 8',
          formulaResultType: 'percent',
          format: {},
        },
        {
          id: 'ratio-default-format',
          name: 'Ratio default format',
          type: 'formula',
          formula: 'Quantity / 8',
          formulaResultType: 'percent',
        },
        {
          id: 'ratio-raw-check',
          name: 'Ratio raw check',
          type: 'formula',
          formula: 'If(Ratio > 0.374, 42, 17)',
        },
      ],
      views: [],
    };
    const source = databaseNote(databaseSchema);

    expect(findUnrepresentablePageContent(source)).toBeNull();
    expect(hasUnrepresentableDatabaseSchema(source)).toBe(false);
    const loaded = readPageText(source);
    expect(loaded.error).toBeNull();
    expect(loaded.database?.properties[1]).toMatchObject({
      type: 'formula',
      formulaResultType: 'percent',
      format: { locale: 'de-DE', precision: 1.5, negativeFormat: 'parentheses' },
    });
    expect(loaded.database?.properties[2]).toMatchObject({
      formulaResultType: 'percent',
      format: { locale: 'en-US', negativeFormat: 'minus' },
    });
    expect(loaded.database?.properties.find((property) => property.id === 'ratio-empty-format')).toMatchObject({
      formulaResultType: 'percent',
      format: {},
    });
    expect(loaded.database?.properties.find((property) => property.id === 'ratio-default-format')).toMatchObject({
      formulaResultType: 'percent',
    });
    expect(loaded.database?.properties.find((property) => property.id === 'ratio-default-format')).not.toHaveProperty(
      'format',
    );

    const editedDatabase = structuredClone(loaded.database!);
    editedDatabase.properties[1]!.format = {
      locale: 'pt-BR',
      precision: 0.25,
      negativeFormat: 'minus',
    };
    const page = newPageMeta({
      id: 'inventory',
      parentId: null,
      title: 'Inventory',
      kind: 'database',
      database: editedDatabase,
      extra: loaded.extra,
    });
    const edited = renderPageText(
      composeFrontmatter(managedFrontmatter(page, 'Inventory', null), loaded.extra, loaded.source, page),
      loaded.source,
      'Edited database schema\n',
    );

    expect(edited).toContain('formulaResultType: percent');
    expect(edited).toContain('precision: 0.25');
    expect(edited).toContain('provider: polaris-dados');
    expect(findUnrepresentablePageContent(edited)).toBeNull();
    expect(hasUnrepresentableDatabaseSchema(edited)).toBe(false);
    expect(readPageText(edited).database).toEqual(editedDatabase);
  });

  it('requires the valid Polaris Dados marker and protects percent schemas the host cannot preserve', () => {
    const formula = {
      id: 'ratio',
      name: 'Ratio',
      type: 'formula',
      formula: 'Quantity / 8',
      formulaResultType: 'percent',
      format: { locale: 'en-US' },
    };
    const schema = { properties: [formula], views: [] };
    const protectedSources = [
      databaseNote(schema, { omitMarker: true }),
      databaseNote(schema, { marker: { version: 2, provider: 'polaris-dados' } }),
      databaseNote(schema, { marker: { version: 1, provider: 'polaris-dados', future: true } }),
      ...[
        { ...formula, type: 'number' },
        { ...formula, formulaResultType: 'number' },
        { ...formula, display: 'bar' },
        { ...formula, max: 50 },
        { ...formula, format: { locale: 'en-US', currency: 'USD' } },
        { ...formula, format: { locale: 'en-US', precision: -0.1 } },
        { ...formula, format: { locale: 'en-US', precision: 8.1 } },
        { ...formula, format: { locale: 'en-US', precision: Number.POSITIVE_INFINITY } },
        { ...formula, format: { locale: 'not a locale' } },
        { ...formula, format: { locale: 'en-US', display: 'percent' } },
        { ...formula, type: 'percent', formulaResultType: undefined },
      ].map((property) => databaseNote({ properties: [property], views: [] })),
    ];

    for (const protectedSource of protectedSources) {
      expect(findUnrepresentablePageContent(protectedSource), protectedSource).not.toBeNull();
      expect(hasUnrepresentableDatabaseSchema(protectedSource), protectedSource).toBe(true);
    }

    const unmarkedNativeDatabase = databaseNote(
      { properties: [{ id: 'amount', name: 'Amount', type: 'number' }], views: [] },
      { omitMarker: true },
    );
    expect(findUnrepresentablePageContent(unmarkedNativeDatabase)).toBeNull();
    expect(hasUnrepresentableDatabaseSchema(unmarkedNativeDatabase)).toBe(false);

    for (const protectedSource of [protectedSources[0]!, protectedSources[1]!]) {
      const loaded = loadVault(
        {
          files: [{ path: 'Inventory.md', text: protectedSource, mtime: 1, birthtime: 1 }],
          folders: [],
          others: [],
          registry: null,
          recent: null,
        },
        () => 'inventory',
        1,
      );
      expect(loaded.protectedPages.get('inventory')).toMatch(/formula result type|polaris dados/i);
      expect(loaded.texts.get('inventory')).toBe(protectedSource);
      expect(loaded.docs.inventory).toEqual({
        type: 'doc',
        content: [{ type: 'rawBlock', attrs: { text: protectedSource } }],
      });
    }
  });

  it('rejects ambiguous frontmatter only when a database declares a typed percentage formula', () => {
    const validYaml = [
      'kind: database',
      'polarisDados:',
      '  version: 1',
      '  provider: polaris-dados',
      'database:',
      '  properties:',
      '    - id: ratio',
      '      name: Ratio',
      '      type: formula',
      '      formula: Quantity / 8',
      '      formulaResultType: percent',
      '      format:',
      '        locale: en-US',
      '        precision: 1.5',
      '  views: []',
      '',
    ].join('\n');
    const ambiguousYaml = [
      validYaml.replace('  version: 1\n', '  version: 1\n  version: 1\n'),
      validYaml.replace('  provider: polaris-dados\n', '  provider: polaris-dados\n  provider: polaris-dados\n'),
      validYaml.replace(
        'polarisDados:\n  version: 1\n  provider: polaris-dados\n',
        'polarisDados:\n  version: 1\n  provider: polaris-dados\npolarisDados:\n  version: 1\n  provider: polaris-dados\n',
      ),
      validYaml.replace(
        '      formulaResultType: percent\n',
        '      formulaResultType: currency\n      formulaResultType: percent\n',
      ),
      validYaml.replace(
        '      format:\n        locale: en-US\n        precision: 1.5\n',
        '      format:\n        locale: en-US\n        precision: 1.5\n      format:\n        locale: en-US\n        precision: 1.5\n',
      ),
    ];

    for (const yaml of ambiguousYaml) {
      const source = `---\n${yaml}---\nOriginal database body\n`;
      expect(findUnrepresentablePageContent(source), source).toMatch(/ambiguous yaml frontmatter/i);
      expect(hasUnrepresentableDatabaseSchema(source), source).toBe(true);

      const loaded = loadVault(
        {
          files: [{ path: 'Inventory.md', text: source, mtime: 1, birthtime: 1 }],
          folders: [],
          others: [],
          registry: null,
          recent: null,
        },
        () => 'inventory',
        1,
      );
      expect(loaded.protectedPages.get('inventory')).toMatch(/ambiguous yaml frontmatter/i);
      expect(loaded.texts.get('inventory')).toBe(source);
      expect(loaded.docs.inventory).toEqual({
        type: 'doc',
        content: [{ type: 'rawBlock', attrs: { text: source } }],
      });
    }

    const legacyYaml = validYaml
      .replace('  provider: polaris-dados\n', '  provider: polaris-dados\n  provider: polaris-dados\n')
      .replace(
        '      type: formula\n      formula: Quantity / 8\n      formulaResultType: percent\n',
        '      type: number\n',
      );
    const legacySource = `---\n${legacyYaml}---\nLegacy database body\n`;
    expect(findUnrepresentablePageContent(legacySource)).toBeNull();
    expect(hasUnrepresentableDatabaseSchema(legacySource)).toBe(false);
  });

  it('protects formula formats with incompatible result settings and retains the exact source bytes', () => {
    const formulaProperty = (extra: Record<string, unknown>) => ({
      id: 'total',
      name: 'Total',
      type: 'formula',
      formula: 'Quantity * 2',
      ...extra,
    });
    const protectedProperties = [
      formulaProperty({ format: { locale: 'de-DE' } }),
      formulaProperty({ format: { currency: 'US1' } }),
      formulaProperty({ format: { currency: 'usd' } }),
      formulaProperty({ format: { currency: 'USD', precision: -0.1 } }),
      formulaProperty({ format: { currency: 'USD', precision: 8.1 } }),
      formulaProperty({ format: { locale: 'not a locale', currency: 'USD' } }),
      formulaProperty({ format: { currency: 'USD', unexpected: 'keep me' } }),
      formulaProperty({ format: { precision: 2, percent: true } }),
      formulaProperty({ format: { precision: 2, unexpected: 'keep me' } }),
      formulaProperty({ format: { precision: 2 }, display: 'bar' }),
      formulaProperty({ format: { precision: 2 }, max: 50 }),
      formulaProperty({ format: { precision: 2 }, formulaResultType: 'number' }),
      formulaProperty({ format: { locale: 'not a locale', precision: 2 } }),
    ];

    for (const property of protectedProperties) {
      const source = databaseNote({ properties: [property], views: [] });
      expect(findUnrepresentablePageContent(source), source).not.toBeNull();
      expect(hasUnrepresentableDatabaseSchema(source), source).toBe(true);
    }

    const protectedSource = databaseNote({
      properties: [formulaProperty({ format: { currency: 'US1' } })],
      views: [],
    });
    const loaded = loadVault(
      {
        files: [{ path: 'Inventory.md', text: protectedSource, mtime: 1, birthtime: 1 }],
        folders: [],
        others: [],
        registry: null,
        recent: null,
      },
      () => 'inventory',
      1,
    );

    expect(loaded.protectedPages.get('inventory')).toMatch(/number property format/i);
    expect(loaded.texts.get('inventory')).toBe(protectedSource);
    expect(loaded.docs.inventory).toEqual({
      type: 'doc',
      content: [{ type: 'rawBlock', attrs: { text: protectedSource } }],
    });
  });

  it('rejects fork-only and nested database fields before normalization', () => {
    const unsupported = `---
kind: database
database:
  properties:
    - id: amount
      name: Amount
      type: currency
      format:
        currency: BRL
        precision: 2
---
`;
    expect(findUnrepresentablePageContent(unsupported)).toMatch(/database property/i);
  });

  it('preserves representable Morrow 2.2 fields through an explicit frontmatter edit', () => {
    expect(SCHEMA_VERSION).toBe(3);
    const groupKeys = Array.from({ length: 200 }, (_, index) =>
      index === 0 ? 'g'.repeat(64) : `group-${index}`,
    );
    const source = databaseNote(metadataDatabase(groupKeys, 40));

    expect(findUnrepresentablePageContent(source)).toBeNull();
    expect(hasUnrepresentableDatabaseSchema(source)).toBe(false);

    const loaded = readPageText(source);
    expect(loaded.error).toBeNull();
    expect(loaded.database?.properties[0]?.wrap).toBe(true);
    expect(loaded.database?.views[0]?.limit).toBe(0);
    expect(loaded.database?.views[2]?.limit).toBeUndefined();
    expect(loaded.database?.views[0]?.groupOrder).toEqual(groupKeys);
    expect(loaded.database?.views[0]?.hiddenGroups).toEqual(groupKeys);
    expect(loaded.database?.views[0]?.collapsedGroups).toEqual(groupKeys);
    expect(loaded.database?.views[1]?.widgets).toHaveLength(40);
    expect(loaded.database?.views[1]?.widgets?.[0]?.title).toBe('W'.repeat(80));

    const page = newPageMeta({
      id: 'inventory',
      parentId: null,
      title: 'Inventory',
      kind: 'database',
      database: loaded.database,
      extra: loaded.extra,
    });
    const frontmatter = composeFrontmatter(
      managedFrontmatter(page, 'Inventory', null),
      loaded.extra,
      loaded.source,
    );
    const saved = renderPageText(frontmatter, loaded.source, 'Edited explicitly\n');
    expect(findUnrepresentablePageContent(saved)).toBeNull();

    const reopened = readPageText(saved);
    expect(reopened.error).toBeNull();
    expect(reopened.database).toEqual(loaded.database);
    expect(reopened.database?.views[0]?.limit).toBe(0);
    expect(reopened.database?.views[2]?.limit).toBeUndefined();
  });

  it('keeps a sum widget writable when its property changes from number to checkbox', () => {
    const source = databaseNote({
      properties: [{ id: 'amount', name: 'Amount', type: 'number' }],
      views: [
        {
          id: 'dashboard',
          name: 'Dashboard',
          type: 'dashboard',
          widgets: [{ id: 'sum-amount', kind: 'sum', prop: 'amount' }],
        },
      ],
    });
    expect(findUnrepresentablePageContent(source)).toBeNull();

    const loaded = readPageText(source);
    expect(loaded.error).toBeNull();
    expect(loaded.database?.views[0]?.widgets?.[0]).toEqual({
      id: 'sum-amount',
      kind: 'sum',
      prop: 'amount',
    });
    const created = applyCommand(emptyWorkspace(), {
      type: 'page.create',
      id: 'inventory',
      parentId: null,
      title: 'Inventory',
      kind: 'database',
      database: loaded.database!,
      now: 1,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error);

    const database = created.value.state.pages.inventory!.database!;
    const changed = applyCommand(created.value.state, {
      type: 'database.set',
      id: 'inventory',
      now: 2,
      database: {
        ...database,
        properties: database.properties.map((property) =>
          property.id === 'amount' ? { ...property, type: 'checkbox', options: [] } : property,
        ),
      },
    });
    expect(changed.ok).toBe(true);
    if (!changed.ok) throw new Error(changed.error);

    const page = changed.value.state.pages.inventory!;
    const frontmatter = composeFrontmatter(
      managedFrontmatter(page, 'Inventory', null),
      loaded.extra,
      loaded.source,
    );
    const saved = renderPageText(frontmatter, loaded.source, loaded.body);
    expect(findUnrepresentablePageContent(saved)).toBeNull();

    const reopened = readPageText(saved);
    expect(reopened.error).toBeNull();
    expect(reopened.database?.properties[0]?.type).toBe('checkbox');
    expect(reopened.database?.views[0]?.widgets?.[0]).toEqual({
      id: 'sum-amount',
      kind: 'sum',
      prop: 'amount',
    });
    expect(findUnrepresentablePageContent(saved)).toBeNull();
  });

  it('accepts widget prop values the 2.2 codec preserves or defaults', () => {
    const source = databaseNote({
      properties: [{ id: 'amount', name: 'Amount', type: 'number' }],
      views: [
        {
          id: 'dashboard',
          name: 'Dashboard',
          type: 'dashboard',
          widgets: [
            { id: 'count-linked', kind: 'count', prop: 'amount' },
            { id: 'sum-empty', kind: 'sum', prop: '' },
            { id: 'line-default', kind: 'line' },
          ],
        },
      ],
    });
    expect(findUnrepresentablePageContent(source)).toBeNull();

    const loaded = readPageText(source);
    expect(loaded.error).toBeNull();
    expect(loaded.database?.views[0]?.widgets?.map((widget) => widget.prop)).toEqual(['amount', '', null]);
    const page = newPageMeta({
      id: 'inventory',
      parentId: null,
      title: 'Inventory',
      kind: 'database',
      database: loaded.database,
      extra: loaded.extra,
    });
    const frontmatter = composeFrontmatter(
      managedFrontmatter(page, 'Inventory', null),
      loaded.extra,
      loaded.source,
    );
    const saved = renderPageText(frontmatter, loaded.source, loaded.body);
    expect(findUnrepresentablePageContent(saved)).toBeNull();
    expect(readPageText(saved).database?.views[0]?.widgets?.map((widget) => widget.prop)).toEqual([
      'amount',
      '',
      null,
    ]);
  });

  it('accepts false only for 2.2 options whose actual default is false', () => {
    const source = databaseNote({
      properties: [{ id: 'name', name: 'Name', type: 'text', wrap: false }],
      views: [
        { id: 'table', name: 'Table', type: 'table', hideEmptyGroups: false },
        {
          id: 'dashboard',
          name: 'Dashboard',
          type: 'dashboard',
          widgets: [{ id: 'count', kind: 'count', prop: null, wide: false }],
        },
      ],
    });

    expect(findUnrepresentablePageContent(source)).toBeNull();
    const database = readPageText(source).database!;
    expect(database.properties[0]?.wrap).toBeUndefined();
    expect(database.views[0]?.hideEmptyGroups).toBeUndefined();
    expect(database.views[1]?.widgets?.[0]?.wide).toBeUndefined();
    expect(database.views[0]?.limit).toBeUndefined();
  });

  it('rejects one-over limits and unsupported nested 2.2 shapes before normalization', () => {
    const view = (fields: Record<string, unknown>) => ({
      properties: [],
      views: [{ id: 'table', name: 'Table', type: 'table', ...fields }],
    });
    const widget = { id: 'count', kind: 'count', prop: null };
    const cases = [
      { database: { properties: [{ id: 'n', name: 'Number', type: 'number', wrap: false }], views: [] } },
      { database: view({ groupOrder: Array.from({ length: 201 }, (_, index) => `g-${index}`) }) },
      { database: view({ hiddenGroups: ['g'.repeat(65)] }) },
      { database: view({ collapsedGroups: [''] }) },
      { database: view({ hideEmptyGroups: 'false' }) },
      { database: view({ limit: 10_001 }) },
      { database: view({ limit: 1.5 }) },
      { database: view({ limit: false }) },
      {
        database: {
          properties: [],
          views: [
            {
              id: 'dashboard',
              name: 'Dashboard',
              type: 'dashboard',
              widgets: Array.from({ length: 41 }, (_, index) => ({ ...widget, id: `w-${index}` })),
            },
          ],
        },
      },
      {
        database: {
          properties: [],
          views: [
            { id: 'dashboard', name: 'Dashboard', type: 'dashboard', widgets: [{ ...widget, future: true }] },
          ],
        },
      },
      {
        database: {
          properties: [],
          views: [
            {
              id: 'dashboard',
              name: 'Dashboard',
              type: 'dashboard',
              widgets: [{ ...widget, title: 'x'.repeat(81) }],
            },
          ],
        },
      },
      {
        database: {
          properties: [],
          views: [
            {
              id: 'dashboard',
              name: 'Dashboard',
              type: 'dashboard',
              widgets: [{ ...widget, kind: 'future' }],
            },
          ],
        },
      },
      {
        database: {
          properties: [],
          views: [
            {
              id: 'dashboard',
              name: 'Dashboard',
              type: 'dashboard',
              widgets: [{ ...widget, prop: 17 }],
            },
          ],
        },
      },
      {
        database: {
          properties: [],
          views: [
            {
              id: 'dashboard',
              name: 'Dashboard',
              type: 'dashboard',
              widgets: [{ ...widget, prop: 'p'.repeat(65) }],
            },
          ],
        },
      },
    ];

    for (const { database } of cases) {
      const source = databaseNote(database);
      expect(findUnrepresentablePageContent(source)).not.toBeNull();
      expect(hasUnrepresentableDatabaseSchema(source)).toBe(true);
    }
  });

  it('keeps published format 13 database metadata protected rather than treating it as schema 3', () => {
    const publishedFormat13 = `---
kind: database
database:
  titleAlias: Record
  displayPropertyId: title
  properties:
    - id: title
      name: Name
      type: text
      textFormat: plain
  views: []
---
`;

    expect(findUnrepresentablePageContent(publishedFormat13)).toMatch(
      /database schema has unsupported fields/i,
    );
    expect(hasUnrepresentableDatabaseSchema(publishedFormat13)).toBe(true);
  });

  it('rejects fork Markdown markers, custom data attributes, and unrepresentable extras', () => {
    for (const body of [
      '<!-- morrow:image align="right" width="35%" -->',
      '<!-- morrow:linked-view:v1:opaque-id -->',
      '<span data-morrow-control="control-1">Control</span>',
      '<span data-morrow-result="opaque-payload">Result</span>',
      '<div data-columns data-widths="35,65">layout</div>',
      '<p data-block-id="opaque-id" data-block-background="blue">Block</p>',
      '<details data-morrow-table-toggle="Older">Contents</details>',
    ]) {
      expect(findUnrepresentablePageContent(body)).not.toBeNull();
    }
    expect(findUnrepresentablePageContent('<!-- morrow:header-column -->\n| Name | Value |')).toBeNull();
    const oversizedExtras = Array.from({ length: 201 }, (_, index) => `extra${index}: value${index}`).join(
      '\n',
    );
    expect(findUnrepresentablePageContent(`---\n${oversizedExtras}\n---\nBody\n`)).toMatch(
      /frontmatter values/,
    );
  });

  it('allows only the direct, representable legacy toggle summary attributes', () => {
    const valid = `<details open>
<summary data-block-background="#1A2B3C" data-morrow-summary-format="markdown"><h2>**Plan** [[Other|internal]] and [web](https://example.org)</h2></summary>

Body.

</details>
`;
    expect(findUnrepresentablePageContent(valid)).toBeNull();
    const parsed = markdownToDoc(valid);
    expect(parsed.content?.[0]?.content?.[0]?.attrs).toEqual({
      level: 2,
      backgroundColor: '#1a2b3c',
    });
    expect(findUnrepresentablePageContent(docToMarkdown(parsed))).toBeNull();

    for (const invalid of [
      valid.replace(' data-morrow-summary-format="markdown"', ' data-morrow-summary-format="markdown" data-morrow-summary-format="markdown"'),
      valid.replace('data-block-background="#1A2B3C"', 'data-block-background="#1A2B3C" class="future"'),
      valid.replace('<summary data-block-background', '<summary data-future="opaque" data-block-background'),
      `<details open><summary data-block-background="#123456">Before <img src="missing.png"></summary>Body</details>`,
      `<details open>prefix<summary data-morrow-summary-format="markdown">Title</summary>Body</details>`,
      `<details open>\n<summary data-block-background="#123456">Incomplete`,
      `<summary data-block-background="#123456">Orphan</summary>`,
      `<p data-block-background="#123456">Outside the summary</p>`,
      `\`data-morrow-summary-format\``,
    ]) {
      expect(findUnrepresentablePageContent(invalid), invalid).not.toBeNull();
    }
  });

  it('round-trips linked views beside official 2.2 markers and protects mixed future raw notes', () => {
    const viewMarker = encodePolarisDadosViewMarker({
      version: 1,
      viewId: 'linked-view',
      sourceDatabaseId: 'source-db',
      title: 'Linked view',
      columnOrder: ['name'],
      filter: null,
    });
    const future = '<!-- morrow:future-layout:v1:opaque -->';
    const source = [
      '<!-- embed: no title -->',
      '![[Notes]]',
      '',
      '<!-- align: right -->',
      '![Sketch](https://example.org/sketch.png)',
      '',
      '<!-- preview -->',
      '```html',
      '<p>Preview</p>',
      '```',
      '',
      '- One <!-- background: blue -->',
      '- [ ] Two <!-- background: green -->',
      '',
      viewMarker,
      '',
      '```markdown',
      future,
      '```',
      '',
      `Literal \`${future}\` marker.`,
      '',
    ].join('\n');

    expect(findUnrepresentablePageContent(source)).toBeNull();
    const parsed = markdownToDoc(source);
    const roundTrip = docToMarkdown(parsed);
    expect(findUnrepresentablePageContent(roundTrip)).toBeNull();
    expect(markdownToDoc(roundTrip)).toEqual(parsed);
    expect(roundTrip).toContain('<!-- embed: no title -->');
    expect(roundTrip).toContain('<!-- align: right -->');
    expect(roundTrip).toContain('<!-- preview -->');
    expect(roundTrip).toContain('<!-- background: blue -->');
    expect(roundTrip).toContain('<!-- background: green -->');
    expect(roundTrip).toContain(viewMarker);

    expect(findUnrepresentablePageContent(source + `\n${future}\n`)).not.toBeNull();
  });

  it('keeps checkbox false, null, and absence distinct while carrying 2.2 text metadata', () => {
    const database: DatabaseDef = {
      properties: [
        { id: 'reviewed', name: 'Reviewed', type: 'checkbox', options: [] },
        { id: 'cleared', name: 'Cleared', type: 'checkbox', options: [] },
        { id: 'missing', name: 'Missing', type: 'checkbox', options: [] },
      ],
      views: [],
    };
    const extra: Record<string, unknown> = { Reviewed: false, Cleared: null };
    const values: Record<string, PropValue> = {};
    takeProperties(database, extra, values, () => 'option', true);

    expect(values).toEqual({ reviewed: false, cleared: null });
    expect(writeProperty(database.properties[0]!, values.reviewed, true)).toBe(false);
    expect(writeProperty(database.properties[1]!, values.cleared, true)).toBeNull();
    expect(writeProperty(database.properties[2]!, values.missing, true)).toBeUndefined();
  });

  it('allows known Morrow workspace and recent metadata, rejects fields their readers discard', () => {
    expect(
      findUnrepresentableVaultMetadata(
        { version: 1, pages: { 'Inventory.md': { id: 'page-1', icon: 'archive', favorite: true } } },
        'workspace',
      ),
    ).toBeNull();
    expect(
      findUnrepresentableVaultMetadata(
        { version: 1, opened: { 'page-1': 20 }, activity: { '2026-11-11': 4 } },
        'recent',
      ),
    ).toBeNull();
    expect(
      findUnrepresentableVaultMetadata(
        { pages: { 'Inventory.md': { id: 'page-1', futureRegistryId: 'opaque' } } },
        'workspace',
      ),
    ).toMatch(/registry/);
    expect(
      findUnrepresentableVaultMetadata({ opened: {}, futureRecent: { id: 'opaque' } }, 'recent'),
    ).toMatch(/recent-items/);
    expect(findUnrepresentableVaultMetadata(null, 'workspace')).toBeNull();
  });
});
