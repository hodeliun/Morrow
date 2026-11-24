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

function columnLayout(count: number, emptyColumn = -1, widths?: string): string {
  const columns = Array.from({ length: count }, (_, index) => {
    const body = index === emptyColumn ? '' : `Column ${index + 1} ^column-${index + 1}`;
    return `<div data-column>\n\n${body}\n\n</div>`;
  });
  const widthAttribute = widths === undefined ? '' : ` data-widths="${widths}"`;
  return `<div data-columns${widthAttribute}>\n${columns.join('\n')}\n</div>`;
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

  it('accepts the published lexical proportions on groups with a matching column count', () => {
    const examples = [
      ['14.1,14.1,14.1,14.1,14.1,14.7,14.8', 7],
      ['020.00, 080.00', 2],
      ['50.05,49.95', 2],
    ] as const;
    for (const [widths, count] of examples) {
      const source = columnLayout(count, -1, widths);
      expect(findUnrepresentablePageContent(source), widths).toBeNull();
      expect(markdownToDoc(source).content?.[0]?.attrs?.widths).toBe(widths);
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
      columnLayout(2, -1, '50,50,10'),
      columnLayout(2, -1, '50,0'),
      columnLayout(2, -1, '50,1000.01'),
      columnLayout(2, -1, '50,49.999'),
      columnLayout(2, -1, `${'0'.repeat(95)}1,1`),
      '<div data-columns data-widths="020.00,\r\n080.00">\n<div data-column>\n\nOne\n\n</div>\n<div data-column>\n\nTwo\n\n</div>\n</div>',
      '<div data-columns data-widths="50,50" data-widths="50,50">\n<div data-column>\n\nOne\n\n</div>\n<div data-column>\n\nTwo\n\n</div>\n</div>',
      '<div data-columns data-widths="50,50" class="future">\n<div data-column>\n\nOne\n\n</div>\n<div data-column>\n\nTwo\n\n</div>\n</div>',
      '<div data-columns data-widths="50,50" data-block-id="opaque">\n<div data-column>\n\nOne\n\n</div>\n<div data-column>\n\nTwo\n\n</div>\n</div>',
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

  it('roundtrips explicit numeric and percentage declarations with optional formats', () => {
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
          id: 'decimal-locale-only',
          name: 'Decimal locale only',
          type: 'formula',
          formula: '7 / 3',
          formulaResultType: 'number',
          format: { locale: 'de-DE' },
        },
        {
          id: 'decimal-zero-precision',
          name: 'Decimal zero precision',
          type: 'formula',
          formula: '7 / 3',
          formulaResultType: 'number',
          format: { precision: 0 },
        },
        {
          id: 'decimal-bounds',
          name: 'Decimal bounds',
          type: 'formula',
          formula: '7 / 3',
          formulaResultType: 'number',
          format: {
            locale: 'fr-FR',
            precision: 2,
            negativeFormat: 'parentheses',
            min: -1e12,
            max: 1e12,
            step: 0.25,
          },
        },
        {
          id: 'decimal-min-step-boundary',
          name: 'Decimal minimum step boundary',
          type: 'formula',
          formula: '7 / 3',
          formulaResultType: 'number',
          format: { step: 1e-9 },
        },
        {
          id: 'decimal-max-step-boundary',
          name: 'Decimal maximum step boundary',
          type: 'formula',
          formula: '7 / 3',
          formulaResultType: 'number',
          format: { step: 1e12 },
        },
        {
          id: 'decimal-conflicting-bounds',
          name: 'Decimal conflicting bounds',
          type: 'formula',
          formula: '7 / 3',
          formulaResultType: 'number',
          format: { min: 3, max: 2 },
        },
        {
          id: 'decimal-default-format',
          name: 'Decimal default format',
          type: 'formula',
          formula: '7 / 3',
          formulaResultType: 'number',
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
    expect(loaded.database?.properties.find((property) => property.id === 'decimal-locale-only')).toMatchObject({
      formulaResultType: 'number',
      format: { locale: 'de-DE' },
    });
    expect(loaded.database?.properties.find((property) => property.id === 'decimal-locale-only')?.format).not.toHaveProperty(
      'precision',
    );
    expect(loaded.database?.properties.find((property) => property.id === 'decimal-zero-precision')).toMatchObject({
      formulaResultType: 'number',
      format: { precision: 0 },
    });
    expect(loaded.database?.properties.find((property) => property.id === 'decimal-bounds')).toMatchObject({
      formulaResultType: 'number',
      format: {
        locale: 'fr-FR',
        precision: 2,
        negativeFormat: 'parentheses',
        min: -1e12,
        max: 1e12,
        step: 0.25,
      },
    });
    expect(
      loaded.database?.properties.find((property) => property.id === 'decimal-min-step-boundary'),
    ).toMatchObject({
      formulaResultType: 'number',
      format: { step: 1e-9 },
    });
    expect(
      loaded.database?.properties.find((property) => property.id === 'decimal-max-step-boundary'),
    ).toMatchObject({
      formulaResultType: 'number',
      format: { step: 1e12 },
    });
    expect(
      loaded.database?.properties.find((property) => property.id === 'decimal-conflicting-bounds'),
    ).toMatchObject({
      formulaResultType: 'number',
      format: { min: 3, max: 2 },
    });

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

  it('roundtrips explicit currency formula results and protects unsupported shapes', () => {
    const databaseSchema = {
      properties: [
        { id: 'default-currency', name: 'Default currency', type: 'formula', formula: '7 / 3', formulaResultType: 'currency' },
        { id: 'empty-format', name: 'Empty format', type: 'formula', formula: '7 / 3', formulaResultType: 'currency', format: {} },
        {
          id: 'locale-only',
          name: 'Locale only',
          type: 'formula',
          formula: '7 / 3',
          formulaResultType: 'currency',
          format: { locale: 'fr-FR' },
        },
        {
          id: 'jpy',
          name: 'JPY',
          type: 'formula',
          formula: '12.5',
          formulaResultType: 'currency',
          format: { currency: 'JPY' },
        },
        {
          id: 'zero-precision',
          name: 'Zero precision',
          type: 'formula',
          formula: '-7 / 3',
          formulaResultType: 'currency',
          format: { currency: 'USD', precision: 0 },
        },
        {
          id: 'configured',
          name: 'Configured',
          type: 'formula',
          formula: '-7 / 3',
          formulaResultType: 'currency',
          format: { currency: 'EUR', locale: 'de-DE', precision: 3, negativeFormat: 'parentheses' },
        },
      ],
      views: [],
    };
    const source = databaseNote(databaseSchema);

    expect(findUnrepresentablePageContent(source)).toBeNull();
    expect(hasUnrepresentableDatabaseSchema(source)).toBe(false);
    const loaded = readPageText(source);
    expect(loaded.error).toBeNull();
    expect(loaded.database?.properties.find((property) => property.id === 'default-currency')).toMatchObject({
      formulaResultType: 'currency',
    });
    expect(loaded.database?.properties.find((property) => property.id === 'default-currency')).not.toHaveProperty(
      'format',
    );
    expect(loaded.database?.properties.find((property) => property.id === 'empty-format')).toMatchObject({
      formulaResultType: 'currency',
      format: {},
    });
    expect(loaded.database?.properties.find((property) => property.id === 'locale-only')).toMatchObject({
      formulaResultType: 'currency',
      format: { locale: 'fr-FR' },
    });
    expect(loaded.database?.properties.find((property) => property.id === 'jpy')).toMatchObject({
      formulaResultType: 'currency',
      format: { currency: 'JPY' },
    });
    expect(loaded.database?.properties.find((property) => property.id === 'zero-precision')).toMatchObject({
      formulaResultType: 'currency',
      format: { currency: 'USD', precision: 0 },
    });

    const databasePage = newPageMeta({
      id: 'inventory',
      parentId: null,
      title: 'Inventory',
      kind: 'database',
      database: loaded.database!,
      extra: loaded.extra,
    });
    const saved = renderPageText(
      composeFrontmatter(managedFrontmatter(databasePage, 'Inventory', null), loaded.extra, loaded.source, databasePage),
      loaded.source,
      loaded.body,
    );
    expect(findUnrepresentablePageContent(saved)).toBeNull();
    expect(readPageText(saved).database).toEqual(loaded.database);

    const currency = databaseSchema.properties.find((property) => property.id === 'default-currency')!;
    const invalidCurrencyProperties = [
      { ...currency, type: 'number' },
      { ...currency, format: { currency: 'US1' } },
      { ...currency, format: { locale: 'not a locale' } },
      { ...currency, format: { precision: 9 } },
      { ...currency, format: { currency: 'USD', unexpected: true } },
      { ...currency, display: 'bar' },
      { ...currency, max: 50 },
      { ...currency, min: 0 },
      { ...currency, step: 1 },
    ];
    for (const property of invalidCurrencyProperties) {
      const invalid = databaseNote({ properties: [property], views: [] });
      expect(findUnrepresentablePageContent(invalid), invalid).not.toBeNull();
      expect(hasUnrepresentableDatabaseSchema(invalid), invalid).toBe(true);
    }
    const invalidCurrencySource = databaseNote({
      properties: [{ ...currency, format: { currency: 'US1' } }],
      views: [],
    });
    const protectedCurrency = loadVault(
      {
        files: [{ path: 'Inventory.md', text: invalidCurrencySource, mtime: 1, birthtime: 1 }],
        folders: [],
        others: [],
        registry: null,
        recent: null,
      },
      () => 'inventory',
      1,
    );
    expect(protectedCurrency.protectedPages.get('inventory')).toMatch(/number property format/i);
    expect(protectedCurrency.texts.get('inventory')).toBe(invalidCurrencySource);
    expect(protectedCurrency.docs.inventory).toEqual({
      type: 'doc',
      content: [{ type: 'rawBlock', attrs: { text: invalidCurrencySource } }],
    });
    const unmarked = databaseNote({ properties: [currency], views: [] }, { omitMarker: true });
    expect(findUnrepresentablePageContent(unmarked)).not.toBeNull();
    expect(hasUnrepresentableDatabaseSchema(unmarked)).toBe(true);
  });

  it('roundtrips explicit text formula results and protects unsupported metadata', () => {
    const textFormula = {
      id: 'label-result',
      name: 'Label result',
      type: 'formula',
      formula: 'Concat(thisRow.Label, " ", "ready")',
      formulaResultType: 'text',
    };
    const source = databaseNote({
      properties: [
        { id: 'label', name: 'Label', type: 'text' },
        textFormula,
        {
          id: 'label-copy',
          name: 'Label copy',
          type: 'formula',
          formula: 'Concat(prop("Label result"), "!")',
        },
      ],
      views: [],
    });

    expect(findUnrepresentablePageContent(source)).toBeNull();
    expect(hasUnrepresentableDatabaseSchema(source)).toBe(false);
    const loaded = readPageText(source);
    expect(loaded.error).toBeNull();
    expect(loaded.database?.properties[1]).toMatchObject({
      type: 'formula',
      formulaResultType: 'text',
      formula: 'Concat(thisRow.Label, " ", "ready")',
    });
    expect(loaded.database?.properties[1]).not.toHaveProperty('format');

    const databasePage = newPageMeta({
      id: 'inventory',
      parentId: null,
      title: 'Inventory',
      kind: 'database',
      database: loaded.database!,
      extra: loaded.extra,
    });
    const saved = renderPageText(
      composeFrontmatter(managedFrontmatter(databasePage, 'Inventory', null), loaded.extra, loaded.source, databasePage),
      loaded.source,
      loaded.body,
    );
    expect(saved).toContain('formulaResultType: text');
    expect(findUnrepresentablePageContent(saved)).toBeNull();
    expect(readPageText(saved).database).toEqual(loaded.database);

    const unsupportedProperties = [
      { ...textFormula, type: 'number' },
      { ...textFormula, format: {} },
      { ...textFormula, format: { precision: 2 } },
      { ...textFormula, format: { currency: 'USD' } },
      { ...textFormula, display: 'bar' },
      { ...textFormula, max: 10 },
      { ...textFormula, wrap: true },
      { ...textFormula, min: 0 },
      { ...textFormula, step: 1 },
    ];
    for (const property of unsupportedProperties) {
      const invalid = databaseNote({ properties: [property], views: [] });
      expect(findUnrepresentablePageContent(invalid), invalid).not.toBeNull();
      expect(hasUnrepresentableDatabaseSchema(invalid), invalid).toBe(true);
    }
    const unmarked = databaseNote({ properties: [textFormula], views: [] }, { omitMarker: true });
    expect(findUnrepresentablePageContent(unmarked)).not.toBeNull();
    expect(hasUnrepresentableDatabaseSchema(unmarked)).toBe(true);

    const protectedSource = databaseNote({
      properties: [{ ...textFormula, format: { precision: 2 } }],
      views: [],
    });
    const protectedPage = loadVault(
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
    expect(protectedPage.protectedPages.get('inventory')).toMatch(/number property format/i);
    expect(protectedPage.texts.get('inventory')).toBe(protectedSource);
    expect(protectedPage.docs.inventory).toEqual({
      type: 'doc',
      content: [{ type: 'rawBlock', attrs: { text: protectedSource } }],
    });
  });

  it('roundtrips explicit checkbox formula results and protects incompatible metadata', () => {
    const checkboxFormula = {
      id: 'available',
      name: 'Available',
      type: 'formula',
      formula: 'Quantity > 2',
      formulaResultType: 'checkbox',
    };
    const source = databaseNote({
      properties: [
        { id: 'quantity', name: 'Quantity', type: 'number' },
        checkboxFormula,
        {
          id: 'availability-label',
          name: 'Availability label',
          type: 'formula',
          formula: 'If(prop("Available"), "Available", "Unavailable")',
        },
      ],
      views: [],
    });

    expect(findUnrepresentablePageContent(source)).toBeNull();
    expect(hasUnrepresentableDatabaseSchema(source)).toBe(false);
    const loaded = readPageText(source);
    expect(loaded.error).toBeNull();
    expect(loaded.database?.properties[1]).toMatchObject({
      type: 'formula',
      formulaResultType: 'checkbox',
      formula: 'Quantity > 2',
    });
    expect(loaded.database?.properties[1]).not.toHaveProperty('format');

    const databasePage = newPageMeta({
      id: 'inventory',
      parentId: null,
      title: 'Inventory',
      kind: 'database',
      database: loaded.database!,
      extra: loaded.extra,
    });
    const saved = renderPageText(
      composeFrontmatter(managedFrontmatter(databasePage, 'Inventory', null), loaded.extra, loaded.source, databasePage),
      loaded.source,
      loaded.body,
    );
    expect(saved).toContain('formulaResultType: checkbox');
    expect(findUnrepresentablePageContent(saved)).toBeNull();
    expect(readPageText(saved).database).toEqual(loaded.database);

    const unsupportedProperties = [
      { ...checkboxFormula, type: 'number' },
      { ...checkboxFormula, format: {} },
      { ...checkboxFormula, format: { locale: 'en-US' } },
      { ...checkboxFormula, format: { currency: 'USD' } },
      { ...checkboxFormula, display: 'bar' },
      { ...checkboxFormula, max: 10 },
      { ...checkboxFormula, wrap: true },
      { ...checkboxFormula, min: 0 },
      { ...checkboxFormula, step: 1 },
    ];
    for (const property of unsupportedProperties) {
      const invalid = databaseNote({ properties: [property], views: [] });
      expect(findUnrepresentablePageContent(invalid), invalid).not.toBeNull();
      expect(hasUnrepresentableDatabaseSchema(invalid), invalid).toBe(true);
    }
    const unmarked = databaseNote({ properties: [checkboxFormula], views: [] }, { omitMarker: true });
    expect(findUnrepresentablePageContent(unmarked)).not.toBeNull();
    expect(hasUnrepresentableDatabaseSchema(unmarked)).toBe(true);

    const protectedSource = databaseNote({
      properties: [{ ...checkboxFormula, format: { locale: 'en-US' } }],
      views: [],
    });
    const protectedPage = loadVault(
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
    expect(protectedPage.protectedPages.get('inventory')).toMatch(/number property format/i);
    expect(protectedPage.texts.get('inventory')).toBe(protectedSource);
    expect(protectedPage.docs.inventory).toEqual({
      type: 'doc',
      content: [{ type: 'rawBlock', attrs: { text: protectedSource } }],
    });
  });

  it('requires the valid Polaris Dados marker and protects typed schemas the host cannot preserve', () => {
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
        { ...formula, formulaResultType: 'date' },
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
    const numberFormula = {
      id: 'decimal',
      name: 'Decimal',
      type: 'formula',
      formula: 'Quantity / 8',
      formulaResultType: 'number',
      format: { locale: 'en-US', step: 1 },
    };
    const numberProtectedSources = [
      databaseNote({ properties: [numberFormula], views: [] }, { omitMarker: true }),
      databaseNote(
        { properties: [numberFormula], views: [] },
        { marker: { version: 2, provider: 'polaris-dados' } },
      ),
      databaseNote({
        properties: [{ ...numberFormula, format: { locale: 'en-US', currency: 'USD' } }],
        views: [],
      }),
      databaseNote({ properties: [{ ...numberFormula, display: 'bar' }], views: [] }),
      databaseNote({ properties: [{ ...numberFormula, min: 0 }], views: [] }),
    ];

    for (const protectedSource of [...protectedSources, ...numberProtectedSources]) {
      expect(findUnrepresentablePageContent(protectedSource), protectedSource).not.toBeNull();
      expect(hasUnrepresentableDatabaseSchema(protectedSource), protectedSource).toBe(true);
    }

    const unmarkedNativeDatabase = databaseNote(
      { properties: [{ id: 'amount', name: 'Amount', type: 'number' }], views: [] },
      { omitMarker: true },
    );
    expect(findUnrepresentablePageContent(unmarkedNativeDatabase)).toBeNull();
    expect(hasUnrepresentableDatabaseSchema(unmarkedNativeDatabase)).toBe(false);

    for (const protectedSource of [
      protectedSources[0]!,
      protectedSources[1]!,
      numberProtectedSources[0]!,
      numberProtectedSources[1]!,
    ]) {
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

  it('rejects ambiguous frontmatter only when a database declares a typed formula result', () => {
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
      validYaml
        .replace('formulaResultType: percent', 'formulaResultType: number')
        .replace(
          '        precision: 1.5\n',
          '        precision: 1.5\n        min: 0\n        min: 1\n',
        ),
      validYaml
        .replace('formulaResultType: percent', 'formulaResultType: number')
        .replace('        precision: 1.5\n', '        precision: 1.5\n        step: 0.1\n        step: 0.2\n'),
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

  it('finds typed declarations hidden by repeated database or properties mappings in either order', () => {
    const prefix = [
      'kind: database',
      'polarisDados:',
      '  version: 1',
      '  provider: polaris-dados',
    ].join('\n');
    const property = (
      resultType: 'text' | 'number' | 'percent' | 'currency' | 'checkbox',
      includeMarker = true,
    ) =>
      [
        '    - id: ratio',
        '      name: Ratio',
        '      type: formula',
        '      formula: Quantity / 8',
        ...(includeMarker ? [`      formulaResultType: ${resultType}`] : []),
      ].join('\n');
    const database = (properties: string) => `database:\n  properties:\n${properties}\n  views: []\n`;
    const legacyProperties = property('number', false);
    const typedOrders = (resultType: 'text' | 'number' | 'percent' | 'currency' | 'checkbox') => [
      `${database(property(resultType))}${database(legacyProperties)}`,
      `${database(legacyProperties)}${database(property(resultType))}`,
      `database:\n  properties:\n${property(resultType)}\n  properties:\n${legacyProperties}\n  views: []\n`,
      `database:\n  properties:\n${legacyProperties}\n  properties:\n${property(resultType)}\n  views: []\n`,
    ];

    for (const resultType of ['text', 'number', 'percent', 'currency', 'checkbox'] as const) {
      for (const yaml of typedOrders(resultType)) {
        const source = `---\n${prefix}\n${yaml}---\nOriginal database body\n`;
        expect(findUnrepresentablePageContent(source), source).toMatch(/ambiguous yaml frontmatter/i);
        expect(hasUnrepresentableDatabaseSchema(source), source).toBe(true);
      }
    }
  });

  it('protects hidden text and checkbox result declarations supplied by YAML merges or aliased keys', () => {
    const prefix = [
      '---',
      'kind: database',
      'polarisDados: { version: 1, provider: polaris-dados }',
    ].join('\n') + '\n';
    const legacyDatabase = [
      'database:',
      '  properties:',
      '    - id: legacy',
      '      name: Legacy',
      '      type: formula',
      '      formula: Concat("old")',
      '  views: []',
    ].join('\n') + '\n';
    const footer = '---\nOriginal database body\n';
    const sourcesFor = (resultType: 'text' | 'checkbox') => [
      prefix +
        `defaults: &result {type: formula, formulaResultType: ${resultType}}\n` +
        'database:\n' +
        '  properties:\n' +
        '    - {!!merge <<: *result, id: typed, name: Typed, formula: \'Concat("new")\'}\n' +
        '  views: []\n' +
        legacyDatabase +
        footer,
      prefix +
        'resultKey: &resultKey formulaResultType\n' +
        'database:\n' +
        '  properties:\n' +
        '    - id: typed\n' +
        '      name: Typed\n' +
        '      type: formula\n' +
        '      formula: Concat("new")\n' +
        '      ? *resultKey\n' +
        `      : ${resultType}\n` +
        '  views: []\n' +
        legacyDatabase +
        footer,
    ];

    for (const resultType of ['text', 'checkbox'] as const) {
      for (const source of sourcesFor(resultType)) {
        expect(findUnrepresentablePageContent(source), source).toMatch(/ambiguous yaml frontmatter/i);
        expect(hasUnrepresentableDatabaseSchema(source), source).toBe(true);
        let nextId = 0;
        const loaded = loadVault(
          {
            files: [{ path: 'Inventory.md', text: source, mtime: 1, birthtime: 1 }],
            folders: [],
            others: [],
            registry: null,
            recent: null,
          },
          () => `text-hidden-${++nextId}`,
          1,
        );
        const databaseId = loaded.pages.find((page) => page.kind === 'database')!.id;
        expect(loaded.protectedPages.get(databaseId)).toMatch(/ambiguous yaml frontmatter/i);
        expect(loaded.texts.get(databaseId)).toBe(source);
        expect(loaded.docs[databaseId]).toEqual({
          type: 'doc',
          content: [{ type: 'rawBlock', attrs: { text: source } }],
        });
      }
    }
  });

  it('resolves YAML aliases in hidden database, properties, and typed scalar declarations', () => {
    const source = [
      '---',
      'kind: database',
      'polarisDados:',
      '  version: 1',
      '  provider: polaris-dados',
      'bounds: &bounds {min: -1000000000000, max: 1000000000000, step: 0.1}',
      'hiddenDatabase: &typedDatabase',
      '  properties: &typedProperties',
      '    - id: formula-source',
      '      name: Formula source',
      '      type: &formulaType formula',
      '      formula: Quantity / 8',
      '    - id: ratio',
      '      name: Ratio',
      '      type: *formulaType',
      '      formula: Quantity / 8',
      '      formulaResultType: &numberType number',
      '      format: *bounds',
      '    - id: currency-source',
      '      name: Currency source',
      '      type: *formulaType',
      '      formula: Quantity / 8',
      '      formulaResultType: &currencyType currency',
      '    - id: currency-alias',
      '      name: Currency alias',
      '      type: *formulaType',
      '      formula: Quantity / 8',
      '      formulaResultType: *currencyType',
      '    - id: ratio-alias',
      '      name: Ratio alias',
      '      type: *formulaType',
      '      formula: Quantity / 8',
      '      formulaResultType: *numberType',
      '    - id: text-source',
      '      name: Text source',
      '      type: *formulaType',
      '      formula: Concat("text")',
      '      formulaResultType: &textType text',
      '    - id: text-alias',
      '      name: Text alias',
      '      type: *formulaType',
      '      formula: Concat("alias")',
      '      formulaResultType: *textType',
      '    - id: checkbox-source',
      '      name: Checkbox source',
      '      type: *formulaType',
      '      formula: Quantity > 2',
      '      formulaResultType: &checkboxType checkbox',
      '    - id: checkbox-alias',
      '      name: Checkbox alias',
      '      type: *formulaType',
      '      formula: Quantity > 2',
      '      formulaResultType: *checkboxType',
      '  views: []',
      'database: *typedDatabase',
      'database:',
      '  properties: *typedProperties',
      '  views: []',
      'database:',
      '  properties:',
      '    - id: legacy',
      '      name: Legacy',
      '      type: formula',
      '      formula: Quantity / 8',
      '  views: []',
      '---',
      'Original database body',
      '',
    ].join('\n');

    expect(findUnrepresentablePageContent(source)).toMatch(/ambiguous yaml frontmatter/i);
    expect(hasUnrepresentableDatabaseSchema(source)).toBe(true);
  });

  it('follows YAML merge keys and rejects resolved key collisions only for typed formulas', () => {
    const prefix = [
      '---',
      'kind: database',
      'polarisDados: { version: 1, provider: polaris-dados }',
      'defaults: &result {type: formula, formulaResultType: number, format: {min: 0, max: 5, step: 0.25}}',
    ].join('\n') + '\n';
    const footer = '---\nOriginal database body\n';
    const typed = '{!!merge <<: *result, id: ratio, name: Ratio, formula: "7 / 3"}';
    const legacy = '{id: ratio, name: Ratio, type: formula, formula: "7 / 3"}';
    const database = (property: string) => `database: {properties: [${property}]}\n`;
    const assertLocked = (source: string) => {
      expect(findUnrepresentablePageContent(source), source).toMatch(/ambiguous yaml frontmatter/i);
      expect(hasUnrepresentableDatabaseSchema(source), source).toBe(true);
      let nextId = 0;
      const loaded = loadVault(
        {
          files: [
            { path: 'Inventory.md', text: source, mtime: 1, birthtime: 1 },
            { path: 'Inventory/Child.md', text: 'Child', mtime: 1, birthtime: 1 },
          ],
          folders: [],
          others: [],
          registry: null,
          recent: null,
        },
        () => `guard-fixture-${++nextId}`,
        1,
      );
      const inventoryId = loaded.pages.find((page) => page.kind === 'database')!.id;
      expect(loaded.protectedPages.get(inventoryId)).toMatch(/ambiguous yaml frontmatter/i);
      expect(loaded.texts.get(inventoryId)).toBe(source);
      expect(loaded.docs[inventoryId]).toEqual({
        type: 'doc',
        content: [{ type: 'rawBlock', attrs: { text: source } }],
      });
    };
    const assertAllowed = (source: string) => {
      expect(findUnrepresentablePageContent(source), source).toBeNull();
      expect(hasUnrepresentableDatabaseSchema(source), source).toBe(false);
    };

    const validMerge = prefix + database(typed) + footer;
    assertAllowed(validMerge);
    expect(readPageText(validMerge).database?.properties[0]).toMatchObject({
      type: 'formula',
      formulaResultType: 'number',
      format: { min: 0, max: 5, step: 0.25 },
    });
    assertLocked(prefix + database(typed) + database(legacy) + footer);

    const untaggedMerge = '{<<: *result, id: ratio, name: Ratio, type: formula, formula: "7 / 3"}';
    assertAllowed(prefix + database(untaggedMerge) + database(legacy) + footer);

    const databaseKey = ['rootKey: &databaseKey database', '? *databaseKey'].join('\n');
    const aliasedDatabase = `${databaseKey}\n: {properties: [${typed}]}\n`;
    assertAllowed(prefix + aliasedDatabase + footer);
    assertLocked(prefix + aliasedDatabase + database(legacy) + footer);
    const literalThenAliasLegacy = `${database(typed)}${databaseKey}\n: {properties: [${legacy}]}\n`;
    assertLocked(prefix + literalThenAliasLegacy + footer);

    const markerAlias = [
      'markerKey: &markerKey polarisDados',
      '? *markerKey',
      ': {version: 2, provider: unsupported}',
      'polarisDados: {version: 1, provider: polaris-dados}',
    ].join('\n');
    assertLocked(
      `---\nkind: database\n${markerAlias}\ndefaults: &result {type: formula, formulaResultType: number}\n${database(typed)}${footer}`,
    );
    assertAllowed(`---\nkind: database\n${markerAlias}\n${database(legacy)}${footer}`);

    const aliasedResultKey = [
      'resultKey: &resultKey formulaResultType',
      'database:',
      '  properties:',
      '    - id: ratio',
      '      name: Ratio',
      '      type: formula',
      '      formula: 7 / 3',
      '      ? *resultKey',
      '      : currency',
      '      formulaResultType: number',
    ].join('\n');
    assertLocked(`---\nkind: database\npolarisDados: { version: 1, provider: polaris-dados }\n${aliasedResultKey}\n${footer}`);
  });

  it('matches scalar key projections for direct maps and real merge sources', () => {
    const prefix = [
      '---',
      'kind: database',
      'polarisDados: { version: 1, provider: polaris-dados }',
      'defaults: &result {type: formula, formulaResultType: number}',
    ].join('\n') + '\n';
    const footer = '---\nOriginal database body\n';
    const typed = '{!!merge <<: *result, id: ratio, name: Ratio, formula: "7 / 3"}';
    const legacy = '{id: ratio, name: Ratio, type: formula, formula: "7 / 3"}';
    const database = (property: string) => `database: {properties: [${property}]}\n`;
    const assertAllowed = (source: string) => {
      expect(findUnrepresentablePageContent(source), source).toBeNull();
      expect(hasUnrepresentableDatabaseSchema(source), source).toBe(false);
    };
    const assertLocked = (source: string) => {
      expect(findUnrepresentablePageContent(source), source).toMatch(/ambiguous yaml frontmatter/i);
      expect(hasUnrepresentableDatabaseSchema(source), source).toBe(true);
    };

    for (const extra of [
      'info: {1: old, "1": new}\n',
      'info: {true: old, "true": new}\n',
      'info: {null: old, "": new}\n',
    ]) {
      assertLocked(prefix + extra + database(typed) + footer);
    }
    assertAllowed(prefix + 'info: {1: old, "1": new}\n' + database(legacy) + footer);

    const keyAlias = [
      'stash:',
      '  ? &key !!merge <<',
      '  : {junk: unrelated}',
      'result: &res {type: formula, formulaResultType: number}',
      'database:',
      '  properties:',
      '    - ? *key',
      '      : *res',
      '      id: ratio',
      '      name: Ratio',
      '      type: formula',
      '      formula: "7 / 3"',
    ].join('\n') + '\n';
    assertAllowed(`---\nkind: database\npolarisDados: { version: 1, provider: polaris-dados }\n${keyAlias}${database(legacy)}${footer}`);
    const typedFromRes = '{!!merge <<: *res, id: ratio, name: Ratio, formula: "7 / 3"}';
    const directSymbolCollision = `---\nkind: database\npolarisDados: { version: 1, provider: polaris-dados }\n${keyAlias}info:\n  ? *key\n  : old\n  "Symbol(<<)": new\n${database(typedFromRes)}${footer}`;
    assertLocked(directSymbolCollision);

    assertAllowed(prefix + 'info: {!!merge <<: {null: old, "": new}}\n' + database(typed) + footer);
    assertLocked(prefix + 'info: {!!merge <<: {null: old, "null": new}}\n' + database(typed) + footer);
    const mergeSourceSymbolKey = [
      '---',
      'kind: database',
      'polarisDados: { version: 1, provider: polaris-dados }',
      'defaults: &result {type: formula, formulaResultType: number}',
      'stash:',
      '  ? &key !!merge <<',
      '  : {junk: unrelated}',
      'info:',
      '  !!merge <<:',
      '    ? *key',
      '    : old',
      '    "Symbol(<<)": new',
      database(typed).trimEnd(),
      footer.trimEnd(),
    ].join('\n');
    assertAllowed(mergeSourceSymbolKey);

    const secondResult = 'alternate: &alternate {type: formula, formulaResultType: percent}\n';
    const sequenceMerge = (override: boolean) =>
      `{!!merge <<: [*result, *alternate], id: ratio, name: Ratio, formula: "7 / 3"${
        override ? ', type: formula, formulaResultType: percent' : ''
      }}`;
    const earlierMergeWins = prefix + secondResult + database(sequenceMerge(false)) + footer;
    assertAllowed(earlierMergeWins);
    expect(readPageText(earlierMergeWins).database?.properties[0]?.formulaResultType).toBe('number');

    const directOverrideWins = prefix + secondResult + database(sequenceMerge(true)) + footer;
    assertAllowed(directOverrideWins);
    expect(readPageText(directOverrideWins).database?.properties[0]?.formulaResultType).toBe('percent');
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
      formulaProperty({ format: { precision: 2 }, formulaResultType: 'text' }),
      formulaProperty({ format: { locale: 'not a locale', precision: 2 } }),
      formulaProperty({ formulaResultType: 'number', format: { currency: 'USD' } }),
      formulaProperty({ formulaResultType: 'number', format: { min: -1e12 - 1 } }),
      formulaProperty({ formulaResultType: 'number', format: { max: 1e12 + 1 } }),
      formulaProperty({ formulaResultType: 'number', format: { min: Number.POSITIVE_INFINITY } }),
      formulaProperty({ formulaResultType: 'number', format: { min: '0' } }),
      formulaProperty({ formulaResultType: 'number', format: { min: 0, step: 0 } }),
      formulaProperty({ formulaResultType: 'number', format: { step: 1e-10 } }),
      formulaProperty({ formulaResultType: 'number', format: { step: 1e12 + 1 } }),
      formulaProperty({ formulaResultType: 'number', format: { step: Number.POSITIVE_INFINITY } }),
      formulaProperty({ formulaResultType: 'number', format: { step: '1' } }),
      formulaProperty({ formulaResultType: 'percent', format: { min: 0 } }),
      formulaProperty({ formulaResultType: 'percent', format: { step: 1 } }),
      formulaProperty({ formulaResultType: 'currency', format: { max: 5 } }),
      formulaProperty({ formulaResultType: 'currency', format: { step: 1 } }),
      formulaProperty({ formulaResultType: 'text', format: { min: 0 } }),
      formulaProperty({ formulaResultType: 'text', format: { step: 1 } }),
      formulaProperty({ formulaResultType: 'checkbox', format: { min: 0 } }),
      formulaProperty({ formulaResultType: 'checkbox', format: { step: 1 } }),
      { id: 'manual-number', name: 'Manual number', type: 'number', format: { min: 0 } },
      { id: 'manual-number-step', name: 'Manual number step', type: 'number', format: { step: 1 } },
      formulaProperty({ format: { max: 5 } }),
      formulaProperty({ format: { step: 1 } }),
      formulaProperty({ formulaResultType: 'number', display: 'bar' }),
      formulaProperty({ formulaResultType: 'number', max: 50 }),
      formulaProperty({ formulaResultType: 'number', step: 1 }),
    ];

    for (const property of protectedProperties) {
      const source = databaseNote({ properties: [property], views: [] });
      expect(findUnrepresentablePageContent(source), source).not.toBeNull();
      expect(hasUnrepresentableDatabaseSchema(source), source).toBe(true);
    }

    const protectedSource = databaseNote({
      properties: [formulaProperty({ formulaResultType: 'number', format: { step: 0 } })],
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
