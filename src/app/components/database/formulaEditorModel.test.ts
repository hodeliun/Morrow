import { describe, expect, it } from 'vitest';
import { bindFormulaReferences, formulaResult } from '../../../core/database';
import { newPageMeta } from '../../../core/model';
import type { DatabaseDef, PageMeta, PropDef, WorkspaceState } from '../../../core/model';
import {
  formulaDecorations,
  formulaIdentifier,
  formulaSuggestions,
  presentFormulaDiagnostic,
} from './formulaEditorModel';

function property(id: string, name: string, type: PropDef['type'], extra: Partial<PropDef> = {}): PropDef {
  return { id, name, type, options: [], ...extra };
}

function database(id: string, title: string, properties: PropDef[]): PageMeta {
  const schema: DatabaseDef = { properties, views: [] };
  return newPageMeta({ id, parentId: null, title, kind: 'database', database: schema });
}

function workspace(...pages: PageMeta[]): WorkspaceState {
  return { pages: Object.fromEntries(pages.map((page) => [page.id, page])), docs: {} };
}

describe('formula editor suggestions and highlighting', () => {
  const target = database('people', 'People', [
    property('full-name', 'Full Name', 'text', { description: 'The person’s display name.' }),
    property('email', 'Email address', 'email'),
  ]);
  const owner = database('tasks', 'Tasks', [
    property('assignee', 'Assignee', 'relation', {
      relation: {
        targetDatabaseId: 'people',
        multiple: false,
        isInverse: false,
        displayPropertyId: null,
        inversePropertyId: null,
        filters: [],
      },
    }),
    property('local', 'Local value', 'number'),
    property('amount', 'Amount', 'number'),
  ]);
  const state = workspace(target, owner);

  it('completes relation target fields after a dot, including a quoted partial name', () => {
    const source = 'thisRow.Assignee.`Full N';
    const bindings = bindFormulaReferences('thisRow.Assignee', owner.id, state);
    const suggestions = formulaSuggestions(source, source.length, owner.id, owner.database!, state, bindings);
    expect(suggestions.map((item) => item.label)).toContain('Full Name');
    expect(suggestions.map((item) => item.label)).not.toContain('Local value');
    expect(suggestions.find((item) => item.label === 'Full Name')).toMatchObject({
      insertText: '`Full Name`',
      binding: { kind: 'property', databaseId: 'people', propertyId: 'full-name' },
    });
  });

  it('completes compatible functions after dots on tables and projected values', () => {
    const tableSuggestions = formulaSuggestions('People.', 7, owner.id, owner.database!, state, []);
    expect(tableSuggestions.map((item) => item.label)).toContain('Filter()');
    expect(tableSuggestions.map((item) => item.label)).not.toContain('Count()');

    const rowsSource = 'People.Filter(thisRow.Amount > 0).';
    const rowSuggestions = formulaSuggestions(
      rowsSource,
      rowsSource.length,
      owner.id,
      owner.database!,
      state,
      bindFormulaReferences(rowsSource.slice(0, -1), owner.id, state),
    );
    expect(rowSuggestions.map((item) => item.label)).toContain('Count()');
    expect(rowSuggestions.map((item) => item.label)).toContain('Contains()');

    const computed = database('computed', 'Computed', [
      property('total', 'Total amount', 'formula', { formulaResultType: 'number' }),
    ]);
    const computedOwner = database('computed-owner', 'Computed owner', []);
    const computedState = workspace(computed, computedOwner);
    const source = 'Computed.`Total amount`.';
    const projected = formulaSuggestions(
      source,
      source.length,
      computedOwner.id,
      computedOwner.database!,
      computedState,
      bindFormulaReferences('Computed.`Total amount`', computedOwner.id, computedState),
    );
    expect(projected.map((item) => item.label)).toContain('Sum()');
    expect(projected.map((item) => item.label)).toContain('Average()');
    expect(projected.map((item) => item.label)).not.toContain('Filter()');
  });

  it('uses shifted ID bindings after an operator instead of choosing an ambiguous table by name', () => {
    const first = database('journal-a', 'Journal', [property('wrong-field', 'Wrong field', 'text')]);
    const second = database('journal-b', 'Journal', [property('right-field', 'Right field', 'text')]);
    const ambiguousState = workspace(first, second, owner);
    const source = '1 + Journal.';
    const bindings = [
      {
        kind: 'database' as const,
        databaseId: second.id,
        start: 4,
        end: 11,
        source: 'Journal',
      },
    ];

    const suggestions = formulaSuggestions(
      source,
      source.length,
      owner.id,
      owner.database!,
      ambiguousState,
      bindings,
    );

    expect(suggestions.map((item) => item.label)).toContain('Right field');
    expect(suggestions.map((item) => item.label)).not.toContain('Wrong field');
  });

  it('matches accented names with spaces without inventing an unquoted identifier', () => {
    const accented = database('accented', 'Operações', [property('city', 'São Paulo', 'text')]);
    const accentedOwner = database('accented-owner', 'Owner', []);
    const accentedState = workspace(accented, accentedOwner);
    const partial = 'Operações.`Sã';
    const suggestions = formulaSuggestions(
      partial,
      partial.length,
      accentedOwner.id,
      accentedOwner.database!,
      accentedState,
      bindFormulaReferences('Operações', accentedOwner.id, accentedState),
    );

    expect(formulaIdentifier('São Paulo')).toBe('`São Paulo`');
    expect(suggestions.find((item) => item.label === 'São Paulo')?.insertText).toBe('`São Paulo`');
  });

  it('offers current-row fields, table names, supported functions, and IfError', () => {
    const functionSuggestions = formulaSuggestions('IfE', 3, owner.id, owner.database!, state, []);
    const tableSuggestions = formulaSuggestions('Peo', 3, owner.id, owner.database!, state, []);
    const propertySuggestions = formulaSuggestions('Loc', 3, owner.id, owner.database!, state, []);
    expect(functionSuggestions.map((item) => item.label)).toContain('IfError()');
    expect(tableSuggestions.find((item) => item.label === 'People')).toMatchObject({
      kind: 'database',
      binding: { databaseId: 'people' },
    });
    expect(propertySuggestions.find((item) => item.label === 'Local value')).toMatchObject({
      kind: 'property',
      binding: { databaseId: 'tasks', propertyId: 'local' },
    });
  });

  it('marks bound fields, tables, functions, and row context as distinct references', () => {
    const source = 'IfError(thisRow.Amount / People.`Full Name`, 0)';
    const bindings = bindFormulaReferences(source, owner.id, state);
    const decorations = formulaDecorations(source, bindings, state);
    const read = (kind: string) =>
      decorations.filter((item) => item.kind === kind).map((item) => source.slice(item.start, item.end));
    expect(read('function')).toEqual(['IfError']);
    expect(read('context')).toEqual(['thisRow']);
    expect(read('database')).toEqual(['People']);
    expect(read('property')).toEqual(['Amount', '`Full Name`']);
  });

  it('marks relation, control, and calculated result bindings with distinct semantic kinds', () => {
    const relationSource = 'thisRow.Assignee';
    const relationDecorations = formulaDecorations(
      relationSource,
      bindFormulaReferences(relationSource, owner.id, state),
      state,
    );
    expect(
      relationDecorations
        .filter((item) => item.kind === 'relation')
        .map((item) => relationSource.slice(item.start, item.end)),
    ).toEqual(['Assignee']);

    const source = 'FilterValue + ResultValue';
    const decorations = formulaDecorations(source, [
      { kind: 'control', pageId: 'tasks', controlId: 'filter', start: 0, end: 11, source: 'FilterValue' },
      { kind: 'result', pageId: 'tasks', resultId: 'computed', start: 14, end: 25, source: 'ResultValue' },
    ]);
    expect(decorations.map((item) => item.kind)).toEqual(['control', 'result']);
  });

  it('completes and previews thisRow.Relacao.Valor safely when the single relation is empty', () => {
    const targetTable = database('target-table', 'Destinos', [property('valor', 'Valor', 'number')]);
    const sourceTable = database('source-table', 'Origem', [
      property('relacao', 'Relacao', 'relation', {
        relation: {
          targetDatabaseId: targetTable.id,
          multiple: false,
          isInverse: false,
          displayPropertyId: null,
          inversePropertyId: null,
          filters: [],
        },
      }),
    ]);
    const emptyRow = newPageMeta({
      id: 'source-row',
      parentId: sourceTable.id,
      properties: { relacao: null },
    });
    const relationState = workspace(targetTable, sourceTable, emptyRow);
    const source = 'thisRow.Relacao.Valor';
    const bindings = bindFormulaReferences(source, sourceTable.id, relationState);
    const partial = 'thisRow.Relacao.Va';
    const suggestions = formulaSuggestions(
      partial,
      partial.length,
      sourceTable.id,
      sourceTable.database!,
      relationState,
      bindFormulaReferences('thisRow.Relacao', sourceTable.id, relationState),
    );
    const formula = property('result', 'Resultado', 'formula', {
      formula: source,
      formulaBindings: bindings,
    });
    expect(suggestions.map((item) => item.label)).toContain('Valor');
    expect(formulaResult(emptyRow, formula, sourceTable.database!, 0, relationState)).toEqual({
      value: null,
      error: null,
    });
  });
});

describe('formula diagnostic presentation', () => {
  const messages = {
    memberAfterDot: (token: string) => `Campo ou função após “${token}”.`,
    unexpectedToken: (token: string) => `Token inesperado “${token}”.`,
    invalidSummary: 'Não foi possível verificar a fórmula.',
  };

  it('localizes a missing member after a dot and preserves the punctuation token', () => {
    expect(presentFormulaDiagnostic('Expected a field or function name after “.”', messages)).toEqual({
      primary: 'Campo ou função após “.”.',
      technicalDetail: null,
    });
  });

  it('localizes an unexpected token without translating user-provided names', () => {
    expect(presentFormulaDiagnostic('Unexpected “Amount”', messages)).toEqual({
      primary: 'Token inesperado “Amount”.',
      technicalDetail: null,
    });
  });

  it('shows a localized summary and retains an unmapped diagnostic as technical detail', () => {
    const rawError = 'This formula is nested too deeply';

    expect(presentFormulaDiagnostic(rawError, messages)).toEqual({
      primary: messages.invalidSummary,
      technicalDetail: rawError,
    });
  });
});
