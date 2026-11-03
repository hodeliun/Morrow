import { describe, expect, it } from 'vitest';
import {
  bindPageFormulaReferences,
  documentFormulaResult,
  formulaResult,
  matchesFilter,
  namedFormulaReferences,
} from './database';
import { applyCommand } from './commands';
import { emptyDoc, newPageMeta } from './model';
import type { DatabaseDef, DocNode, FormulaReferenceBinding, NamedControlDef, PropDef, WorkspaceState } from './model';

function control(id: string, name: string, value = 7): NamedControlDef {
  return { id, name, type: 'number', value, defaultValue: 0, options: [] };
}

function networkFixture(): WorkspaceState {
  const local = newPageMeta({
    id: 'summary-page',
    parentId: null,
    title: 'Summary',
    controls: [control('local-control', 'Shared')],
  });
  const remote = newPageMeta({
    id: 'inputs-page',
    parentId: null,
    title: 'Inputs',
    controls: [control('remote-control', 'Shared', 11), control('remote-only', 'RemoteOnly', 13)],
  });
  const resultDoc: DocNode = {
    type: 'doc',
    content: [
      {
        type: 'calculatedResult',
        attrs: { pageId: 'inputs-page', resultId: 'remote-result', name: 'Forecast', formula: '42', bindings: [] },
      },
    ],
  };
  return {
    pages: { 'summary-page': local, 'inputs-page': remote },
    docs: { 'summary-page': emptyDoc(), 'inputs-page': resultDoc },
  };
}

function resultNode(
  pageId: string,
  resultId: string,
  name: string,
  formula: string,
  bindings: FormulaReferenceBinding[] = [],
): DocNode {
  return {
    type: 'calculatedResult',
    attrs: { pageId, resultId, name, formula, bindings, outputType: 'number', format: { precision: 0 } },
  };
}

describe('named formula reference discovery', () => {
  it('lists page and cross-page controls and results by their page-scoped identities', () => {
    const state = networkFixture();

    expect(namedFormulaReferences(state)).toEqual(
      expect.arrayContaining([
        { pageId: 'summary-page', kind: 'control', id: 'local-control', name: 'Shared' },
        { pageId: 'inputs-page', kind: 'control', id: 'remote-control', name: 'Shared' },
        { pageId: 'inputs-page', kind: 'result', id: 'remote-result', name: 'Forecast' },
      ]),
    );
    expect(namedFormulaReferences(state)).toHaveLength(4);

    const unsavedResult: DocNode = {
      type: 'doc',
      content: [resultNode('summary-page', 'draft-result', 'Draft forecast', '1')],
    };
    expect(namedFormulaReferences(state, { 'summary-page': unsavedResult })).toContainEqual({
      pageId: 'summary-page', kind: 'result', id: 'draft-result', name: 'Draft forecast',
    });
  });

  it('keeps typed names page-local and resolves another page only from an explicit ID binding', () => {
    const state = networkFixture();
    const localBinding = bindPageFormulaReferences('Shared', 'summary-page', state);
    expect(localBinding).toEqual([
      { start: 0, end: 6, source: 'Shared', kind: 'control', pageId: 'summary-page', controlId: 'local-control' },
    ]);
    expect(documentFormulaResult('summary-page', 'local-result', 'Shared', localBinding, state)).toEqual({
      value: 7,
      error: null,
    });

    expect(bindPageFormulaReferences('RemoteOnly', 'summary-page', state)).toEqual([]);
    expect(bindPageFormulaReferences('Forecast', 'summary-page', state)).toEqual([]);

    const selectedRemoteControl = {
      start: 0,
      end: 6,
      source: 'Shared',
      kind: 'control' as const,
      pageId: 'inputs-page',
      controlId: 'remote-control',
    };
    const explicitControl = bindPageFormulaReferences('Shared', 'summary-page', state, null, [selectedRemoteControl]);
    expect(explicitControl).toEqual([selectedRemoteControl]);
    expect(documentFormulaResult('summary-page', 'explicit-control', 'Shared', explicitControl, state)).toEqual({
      value: 11,
      error: null,
    });

    const selectedRemoteResult = {
      start: 0,
      end: 8,
      source: 'Forecast',
      kind: 'result' as const,
      pageId: 'inputs-page',
      resultId: 'remote-result',
    };
    const explicitResult = bindPageFormulaReferences('Forecast', 'summary-page', state, null, [selectedRemoteResult]);
    expect(explicitResult).toEqual([selectedRemoteResult]);
    expect(documentFormulaResult('summary-page', 'explicit-result', 'Forecast', explicitResult, state)).toEqual({
      value: 42,
      error: null,
    });
  });

  it('requires disambiguation when a local control and result share a name', () => {
    const fixture = networkFixture();
    const state: WorkspaceState = {
      ...fixture,
      docs: {
        ...fixture.docs,
        'summary-page': { type: 'doc', content: [resultNode('summary-page', 'local-result', 'Shared', '19')] },
      },
    };

    const ambiguous = bindPageFormulaReferences('Shared', 'summary-page', state);
    expect(ambiguous[0]).toMatchObject({ kind: 'ambiguous', source: 'Shared' });
    expect(documentFormulaResult('summary-page', 'consumer', 'Shared', ambiguous, state).error).toContain(
      'choose a control or calculated result',
    );

    const selectedResult: FormulaReferenceBinding = {
      start: 0,
      end: 6,
      source: 'Shared',
      kind: 'result',
      pageId: 'summary-page',
      resultId: 'local-result',
    };
    expect(bindPageFormulaReferences('Shared', 'summary-page', state, null, [selectedResult])).toEqual([
      selectedResult,
    ]);
    expect(documentFormulaResult('summary-page', 'consumer', 'Shared', [selectedResult], state)).toEqual({
      value: 19,
      error: null,
    });
  });

  it('keeps control bindings on their ID after rename and does not retarget after deletion', () => {
    let state = networkFixture();
    const binding: FormulaReferenceBinding = {
      start: 0,
      end: 6,
      source: 'Shared',
      kind: 'control',
      pageId: 'inputs-page',
      controlId: 'remote-control',
    };

    expect(documentFormulaResult('summary-page', 'consumer', 'Shared', [binding], state).value).toBe(11);
    const renamed = applyCommand(state, {
      type: 'page.control.configure',
      id: 'inputs-page',
      control: { ...state.pages['inputs-page']!.controls[0]!, name: 'Renamed Shared' },
      now: 2,
    });
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    state = renamed.value.state;
    expect(namedFormulaReferences(state)).toContainEqual({
      pageId: 'inputs-page', kind: 'control', id: 'remote-control', name: 'Renamed Shared',
    });
    expect(documentFormulaResult('summary-page', 'consumer', 'Shared', [binding], state).value).toBe(11);

    const deleted = applyCommand(state, {
      type: 'page.control.delete', id: 'inputs-page', controlId: 'remote-control', now: 3,
    });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    const replacement = applyCommand(deleted.value.state, {
      type: 'page.control.configure',
      id: 'inputs-page',
      control: control('replacement-control', 'Shared', 99),
      now: 4,
    });
    expect(replacement.ok).toBe(true);
    if (!replacement.ok) return;
    expect(documentFormulaResult('summary-page', 'consumer', 'Shared', [binding], replacement.value.state)).toEqual({
      value: null,
      error: 'Bound control “Shared” is unavailable.',
    });
  });

  it('keeps result bindings on their ID after rename and does not retarget after deletion', () => {
    let state = networkFixture();
    const binding: FormulaReferenceBinding = {
      start: 0,
      end: 8,
      source: 'Forecast',
      kind: 'result',
      pageId: 'inputs-page',
      resultId: 'remote-result',
    };

    expect(documentFormulaResult('summary-page', 'consumer', 'Forecast', [binding], state).value).toBe(42);
    const originalDoc = state.docs['inputs-page']!;
    const renamedDoc: DocNode = {
      ...originalDoc,
      content: originalDoc.content!.map((node) => node.attrs?.resultId === 'remote-result'
        ? { ...node, attrs: { ...node.attrs, name: 'Updated Forecast' } }
        : node),
    };
    state = { ...state, docs: { ...state.docs, 'inputs-page': renamedDoc } };
    expect(namedFormulaReferences(state)).toContainEqual({
      pageId: 'inputs-page', kind: 'result', id: 'remote-result', name: 'Updated Forecast',
    });
    expect(documentFormulaResult('summary-page', 'consumer', 'Forecast', [binding], state).value).toBe(42);

    const deletedDoc: DocNode = {
      ...renamedDoc,
      content: [resultNode('inputs-page', 'replacement-result', 'Forecast', '99')],
    };
    state = { ...state, docs: { ...state.docs, 'inputs-page': deletedDoc } };
    expect(documentFormulaResult('summary-page', 'consumer', 'Forecast', [binding], state)).toEqual({
      value: null,
      error: 'Bound calculated result “Forecast” is unavailable.',
    });
  });

  it('reports references on trashed pages as unavailable instead of reading their retained data', () => {
    const state = networkFixture();
    const trashedState: WorkspaceState = {
      ...state,
      pages: { ...state.pages, 'inputs-page': { ...state.pages['inputs-page']!, trashedAt: 3 } },
    };
    const controlBinding: FormulaReferenceBinding = {
      start: 0,
      end: 6,
      source: 'Shared',
      kind: 'control',
      pageId: 'inputs-page',
      controlId: 'remote-control',
    };
    const resultBinding: FormulaReferenceBinding = {
      start: 0,
      end: 8,
      source: 'Forecast',
      kind: 'result',
      pageId: 'inputs-page',
      resultId: 'remote-result',
    };

    expect(documentFormulaResult('summary-page', 'broken-control', 'Shared', [controlBinding], trashedState).error).toBe(
      'Bound control “Shared” is unavailable.',
    );
    expect(documentFormulaResult('summary-page', 'broken-result', 'Forecast', [resultBinding], trashedState).error).toBe(
      'Bound calculated result “Forecast” is unavailable.',
    );
    expect(namedFormulaReferences(trashedState).every((reference) => reference.pageId !== 'inputs-page')).toBe(true);
  });

  it('updates result chains, table formulas, and filters from a referenced control value', () => {
    const database: DatabaseDef = {
      properties: [{ id: 'amount', name: 'Amount', type: 'number', options: [] }],
      views: [],
    };
    const pages = {
      'summary-page': newPageMeta({ id: 'summary-page', parentId: null, title: 'Summary' }),
      'inputs-page': newPageMeta({
        id: 'inputs-page',
        parentId: null,
        title: 'Inputs',
        controls: [control('remote-control', 'Shared', 11)],
      }),
      tasks: newPageMeta({ id: 'tasks', parentId: null, title: 'Tasks', kind: 'database', database }),
      'task-row': newPageMeta({
        id: 'task-row',
        parentId: 'tasks',
        title: 'Synthetic task',
        properties: { amount: 35 },
      }),
    };
    const docs = {
      'summary-page': { type: 'doc', content: [resultNode('summary-page', 'summary-result', 'Summary', 'Forecast + 1')] },
      'inputs-page': { type: 'doc', content: [resultNode('inputs-page', 'remote-result', 'Forecast', 'Shared * 2')] },
      tasks: emptyDoc(),
      'task-row': emptyDoc(),
    } satisfies Record<string, DocNode>;
    let state: WorkspaceState = { pages, docs };

    const controlSource = 'Shared * 2';
    const controlBindings = bindPageFormulaReferences(controlSource, 'inputs-page', state);
    const remoteResultBinding: FormulaReferenceBinding = {
      start: 0,
      end: 'Forecast'.length,
      source: 'Forecast',
      kind: 'result',
      pageId: 'inputs-page',
      resultId: 'remote-result',
    };
    const summarySource = 'Forecast + 1';
    const summaryBindings = bindPageFormulaReferences(
      summarySource,
      'summary-page',
      state,
      null,
      [remoteResultBinding],
    );
    const tableBindings = bindPageFormulaReferences('Forecast', 'tasks', state, 'tasks', [remoteResultBinding]);
    const filterSource = 'Forecast > thisRow.Amount';
    const filterBindings = bindPageFormulaReferences(
      filterSource,
      'tasks',
      state,
      'tasks',
      [remoteResultBinding],
    );

    state = {
      ...state,
      docs: {
        ...state.docs,
        'inputs-page': { type: 'doc', content: [resultNode('inputs-page', 'remote-result', 'Forecast', controlSource, controlBindings)] },
        'summary-page': { type: 'doc', content: [resultNode('summary-page', 'summary-result', 'Summary', summarySource, summaryBindings)] },
      },
    };
    const tableProp: PropDef = {
      id: 'calculated-forecast',
      name: 'Calculated forecast',
      type: 'formula',
      options: [],
      formula: 'Forecast',
      formulaBindings: tableBindings,
    };
    const filter = {
      id: 'forecast-filter',
      prop: 'amount',
      op: 'is' as const,
      value: null,
      formula: filterSource,
      formulaBindings: filterBindings,
    };
    const row = state.pages['task-row']!;

    expect(documentFormulaResult('summary-page', 'summary-result', summarySource, summaryBindings, state).value).toBe(23);
    expect(formulaResult(row, tableProp, database, 0, state).value).toBe(22);
    expect(matchesFilter(row, filter, database, state)).toBe(false);

    const changed = applyCommand(state, {
      type: 'page.control.setValue',
      id: 'inputs-page',
      controlId: 'remote-control',
      value: 20,
      now: 2,
    });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    state = changed.value.state;

    expect(documentFormulaResult('summary-page', 'summary-result', summarySource, summaryBindings, state).value).toBe(41);
    expect(formulaResult(state.pages['task-row']!, tableProp, database, 0, state).value).toBe(40);
    expect(matchesFilter(state.pages['task-row']!, filter, database, state)).toBe(true);
  });

  it('reports local, cross-page, and result-to-table formula cycles with the bounded evaluator diagnostic', () => {
    const binding = (pageId: string, resultId: string, source: string): FormulaReferenceBinding => ({
      start: 0,
      end: source.length,
      source,
      kind: 'result',
      pageId,
      resultId,
    });
    const localPage = newPageMeta({ id: 'local', parentId: null, title: 'Local' });
    const localDocs: DocNode = {
      type: 'doc',
      content: [
        resultNode('local', 'local-a', 'A', 'B + 1', [binding('local', 'local-b', 'B')]),
        resultNode('local', 'local-b', 'B', 'A + 1', [binding('local', 'local-a', 'A')]),
      ],
    };
    const localState: WorkspaceState = { pages: { local: localPage }, docs: { local: localDocs } };
    const localCycle = documentFormulaResult('local', 'local-a', 'B + 1', [binding('local', 'local-b', 'B')], localState);
    expect(localCycle.error).toContain('Formula cycle detected');

    const pageA = newPageMeta({ id: 'page-a', parentId: null, title: 'Page A' });
    const pageB = newPageMeta({ id: 'page-b', parentId: null, title: 'Page B' });
    const crossPageState: WorkspaceState = {
      pages: { 'page-a': pageA, 'page-b': pageB },
      docs: {
        'page-a': {
          type: 'doc',
          content: [resultNode('page-a', 'result-a', 'Result A', 'ResultB + 1', [binding('page-b', 'result-b', 'ResultB')])],
        },
        'page-b': {
          type: 'doc',
          content: [resultNode('page-b', 'result-b', 'Result B', 'ResultA + 1', [binding('page-a', 'result-a', 'ResultA')])],
        },
      },
    };
    const crossPageCycle = documentFormulaResult(
      'page-a',
      'result-a',
      'ResultB + 1',
      [binding('page-b', 'result-b', 'ResultB')],
      crossPageState,
    );
    expect(crossPageCycle.error).toContain('Formula cycle detected');

    const tableBinding = binding('summary', 'table-result', 'LoopResult');
    const tableProp: PropDef = {
      id: 'loop-property',
      name: 'Loop',
      type: 'formula',
      options: [],
      formula: 'LoopResult',
      formulaBindings: [tableBinding],
    };
    const database: DatabaseDef = { properties: [tableProp], views: [] };
    const table = newPageMeta({ id: 'table', parentId: null, title: 'Tasks', kind: 'database', database });
    const row = newPageMeta({ id: 'row', parentId: 'table', title: 'Task' });
    const summary = newPageMeta({ id: 'summary', parentId: null, title: 'Summary' });
    const resultToTableSource = 'Tasks.Loop';
    const resultToTableBindings = bindPageFormulaReferences(resultToTableSource, 'summary', {
      pages: { table, row, summary },
      docs: { table: emptyDoc(), row: emptyDoc(), summary: emptyDoc() },
    }, 'table');
    const tableCycleState: WorkspaceState = {
      pages: { table, row, summary },
      docs: {
        table: emptyDoc(),
        row: emptyDoc(),
        summary: {
          type: 'doc',
          content: [resultNode('summary', 'table-result', 'LoopResult', resultToTableSource, resultToTableBindings)],
        },
      },
    };
    const resultTableCycle = formulaResult(row, tableProp, database, 0, tableCycleState);
    expect(resultTableCycle.error).toContain('Formula cycle detected');
  });

  it('bounds long result-reference chains instead of evaluating without a limit', () => {
    const page = newPageMeta({ id: 'chain-page', parentId: null, title: 'Chain' });
    const results = Array.from({ length: 66 }, (_, index) => {
      const source = index === 65 ? '1' : `Node${index + 1}`;
      const bindings: FormulaReferenceBinding[] = index === 65
        ? []
        : [{
            start: 0,
            end: source.length,
            source,
            kind: 'result',
            pageId: 'chain-page',
            resultId: `result-${index + 1}`,
          }];
      return resultNode('chain-page', `result-${index}`, `Node${index}`, source, bindings);
    });
    const state: WorkspaceState = {
      pages: { 'chain-page': page },
      docs: { 'chain-page': { type: 'doc', content: results } },
    };
    const source = 'Node1';
    const result = documentFormulaResult('chain-page', 'result-0', source, [{
      start: 0,
      end: source.length,
      source,
      kind: 'result',
      pageId: 'chain-page',
      resultId: 'result-1',
    }], state);

    expect(result).toEqual({ value: null, error: 'Formula nesting is limited to 64 levels' });
  });

  it('remaps only copied-page control and result IDs while preserving cross-page bindings', () => {
    const sourcePage = newPageMeta({
      id: 'source-page',
      parentId: null,
      title: 'Source',
      controls: [control('source-control', 'Local')],
    });
    const externalPage = newPageMeta({
      id: 'external-page',
      parentId: null,
      title: 'External',
      controls: [control('external-control', 'Remote')],
    });
    const internalResultBinding: FormulaReferenceBinding = {
      start: 0,
      end: 5,
      source: 'Inner',
      kind: 'result',
      pageId: 'source-page',
      resultId: 'internal-result',
    };
    const sourceDoc: DocNode = {
      type: 'doc',
      content: [
        resultNode('source-page', 'internal-result', 'Inner', 'Local + Remote', [
          {
            start: 0,
            end: 5,
            source: 'Local',
            kind: 'control',
            pageId: 'source-page',
            controlId: 'source-control',
          },
          {
            start: 8,
            end: 14,
            source: 'Remote',
            kind: 'control',
            pageId: 'external-page',
            controlId: 'external-control',
          },
        ]),
        resultNode('source-page', 'outer-result', 'Outer', 'Inner + External', [
          internalResultBinding,
          {
            start: 8,
            end: 16,
            source: 'External',
            kind: 'result',
            pageId: 'external-page',
            resultId: 'external-result',
          },
        ]),
      ],
    };
    const state: WorkspaceState = {
      pages: { 'source-page': sourcePage, 'external-page': externalPage },
      docs: {
        'source-page': sourceDoc,
        'external-page': { type: 'doc', content: [resultNode('external-page', 'external-result', 'External', '5')] },
      },
    };

    const duplicated = applyCommand(state, { type: 'page.duplicate', id: 'source-page', newId: 'copied-page', now: 2 });
    expect(duplicated.ok).toBe(true);
    if (!duplicated.ok) return;
    const copiedState = duplicated.value.state;
    const copiedDoc = copiedState.docs['copied-page']!;
    const copiedInner = copiedDoc.content![0]!;
    const copiedOuter = copiedDoc.content![1]!;
    const copiedControlId = copiedState.pages['copied-page']!.controls[0]!.id;
    const copiedInnerId = copiedInner.attrs!.resultId;

    expect(copiedControlId).not.toBe('source-control');
    expect(copiedInnerId).not.toBe('internal-result');
    expect(copiedOuter.attrs!.resultId).not.toBe('outer-result');
    expect(copiedInner.attrs!.pageId).toBe('copied-page');
    expect(copiedInner.attrs!.bindings).toContainEqual(
      expect.objectContaining({ kind: 'control', pageId: 'copied-page', controlId: copiedControlId }),
    );
    expect(copiedInner.attrs!.bindings).toContainEqual(
      expect.objectContaining({ kind: 'control', pageId: 'external-page', controlId: 'external-control' }),
    );
    expect(copiedOuter.attrs!.bindings).toContainEqual(
      expect.objectContaining({ kind: 'result', pageId: 'copied-page', resultId: copiedInnerId }),
    );
    expect(copiedOuter.attrs!.bindings).toContainEqual(
      expect.objectContaining({ kind: 'result', pageId: 'external-page', resultId: 'external-result' }),
    );
  });
});
