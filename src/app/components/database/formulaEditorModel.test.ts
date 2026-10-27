import { describe, expect, it } from 'vitest';
import { bindFormulaReferences, formulaResult } from '../../../core/database';
import { newPageMeta } from '../../../core/model';
import type { DatabaseDef, PageMeta, PropDef, WorkspaceState } from '../../../core/model';
import { formulaDecorations, formulaSuggestions } from './formulaEditorModel';

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
    const decorations = formulaDecorations(source, bindings);
    const read = (kind: string) =>
      decorations
        .filter((item) => item.kind === kind)
        .map((item) => source.slice(item.start, item.end));
    expect(read('function')).toEqual(['IfError']);
    expect(read('context')).toEqual(['thisRow']);
    expect(read('database')).toEqual(['People']);
    expect(read('property')).toEqual(['Amount', '`Full Name`']);
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
    const formula = property('result', 'Resultado', 'formula', { formula: source, formulaBindings: bindings });
    expect(suggestions.map((item) => item.label)).toContain('Valor');
    expect(formulaResult(emptyRow, formula, sourceTable.database!, 0, relationState)).toEqual({
      value: null,
      error: null,
    });
  });
});
