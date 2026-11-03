import { describe, expect, it } from 'vitest';
import { applyCommand } from './commands';
import type { Command } from './commands';
import { bindPageFormulaReferences, documentFormulaResult, formatValue, matchesFilter, rowsOf, visibleRows } from './database';
import {
  boundedNumericControlFormatError,
  controlValueError,
  controlValueErrorInState,
  defaultBoundedNumericControlFormat,
  normalizeNamedControls,
} from './controls';
import { emptyWorkspace } from './model';
import { SCHEMA_VERSION } from './model';
import type { DocNode, NamedControlDef, PropDef, ViewDef, WorkspaceState } from './model';
import { normalizePage, readWorkspace } from './migrations';
import { markdownToDoc } from './markdown/parse';
import { docToMarkdown } from './markdown/serialize';
import { managedFrontmatter, readPageText, renderPageText } from './vault/pageFile';

function run(state: WorkspaceState, ...commands: Command[]): WorkspaceState {
  return commands.reduce((current, command) => {
    const result = applyCommand(current, command);
    if (!result.ok) throw new Error(result.error);
    return result.value.state;
  }, state);
}

const create = (id: string, parentId: string | null = null, extra: Partial<Command> = {}): Command =>
  ({ type: 'page.create', id, parentId, now: 1, title: id, ...extra }) as Command;

const control = (fields: Partial<NamedControlDef> & Pick<NamedControlDef, 'id' | 'name' | 'type'>): NamedControlDef => ({
  id: fields.id,
  name: fields.name,
  type: fields.type,
  value: fields.value ?? null,
  defaultValue: fields.defaultValue ?? null,
  options: fields.options ?? [],
  ...(fields.format ? { format: fields.format } : {}),
  ...(fields.textFormat ? { textFormat: fields.textFormat } : {}),
  ...(fields.relation ? { relation: fields.relation } : {}),
});

describe('named controls', () => {
  it('keeps false, zero, and empty values distinct from blank and preserves current value when renamed', () => {
    let state = run(emptyWorkspace(), create('page'));
    state = run(
      state,
      { type: 'page.control.configure', id: 'page', now: 2, control: control({ id: 'checked', name: 'Checked', type: 'checkbox', value: false, defaultValue: true }) },
      { type: 'page.control.configure', id: 'page', now: 3, control: control({ id: 'zero', name: 'Zero', type: 'number', value: 0, defaultValue: 1 }) },
      { type: 'page.control.configure', id: 'page', now: 4, control: control({ id: 'empty', name: 'Empty', type: 'text', value: '', defaultValue: 'default' }) },
    );
    expect(state.pages.page!.controls.map((item) => item.value)).toEqual([false, 0, '']);
    state = run(state, {
      type: 'page.control.configure', id: 'page', now: 5,
      control: control({ id: 'zero', name: 'Amount', type: 'number', value: 99, defaultValue: 2 }),
    });
    expect(state.pages.page!.controls.find((item) => item.id === 'zero')).toMatchObject({ name: 'Amount', value: 0, defaultValue: 2 });
    state = run(state, { type: 'page.control.reset', id: 'page', controlId: 'zero', now: 6 });
    expect(state.pages.page!.controls.find((item) => item.id === 'zero')?.value).toBe(2);
  });

  it('validates bounded scale and progress configuration without clamping typed values', () => {
    expect(defaultBoundedNumericControlFormat('scale')).toMatchObject({ min: 1, max: 5, step: 1, scaleIcon: 'star', showValue: true });
    expect(defaultBoundedNumericControlFormat('progress')).toMatchObject({ min: 0, max: 100, step: 1, showValue: true });
    expect(boundedNumericControlFormatError('scale', { min: 1, max: 5, step: 1 })).toBeNull();
    expect(boundedNumericControlFormatError('progress', { min: 0, max: 0.3, step: 0.1 })).toBeNull();
    expect(boundedNumericControlFormatError('scale', { min: 1.5, max: 5, step: 1 })).toContain('whole numbers');
    expect(boundedNumericControlFormatError('progress', { min: 0, max: 1, step: 0 })).toContain('positive step');
    expect(boundedNumericControlFormatError('progress', { min: 0, max: 1, step: 0.3 })).toContain('divide');
    expect(boundedNumericControlFormatError('progress', { min: 2, max: 2, step: 1 })).toContain('greater');
    expect(boundedNumericControlFormatError('progress', {})).toContain('explicit finite');

    const progress = control({
      id: 'progress', name: 'Progress', type: 'progress', value: 0.3, defaultValue: 0,
      format: { min: 0, max: 0.3, step: 0.1 },
    });
    expect(controlValueError(progress, 0.3)).toBeNull();
    expect(controlValueError(progress, 0.31)).toContain('at most');
    expect(controlValueError(progress, '0.3')).toContain('finite number');
    expect(controlValueError({ ...progress, format: undefined }, 0.3)).toContain('explicit finite');
    expect(normalizeNamedControls([{ ...progress, value: 0.3, defaultValue: 0 }])?.[0]).toMatchObject({
      type: 'progress', value: 0.3, defaultValue: 0,
    });
    expect(normalizeNamedControls([{ ...progress, format: { min: 0, max: 1, step: 0.3 } }])).toBeNull();

    const initial = run(emptyWorkspace(), create('page'), {
      type: 'page.control.configure', id: 'page', now: 2, control: progress,
    });
    const incompatible = applyCommand(initial, {
      type: 'page.control.configure', id: 'page', now: 3,
      control: { ...progress, format: { min: 0, max: 0.2, step: 0.1 } },
    });
    expect(incompatible.ok).toBe(false);
    expect(initial.pages.page!.controls[0]).toMatchObject({ value: 0.3, defaultValue: 0 });
  });

  it('preserves zero and blank and passes numeric values unchanged to formulas and filters', () => {
    const format = { min: 0, max: 1, step: 0.1 };
    let state = run(
      emptyWorkspace(),
      create('items', null, {
        kind: 'database',
        database: { properties: [{ id: 'completion', name: 'Completion', type: 'progress', options: [], format }], views: [] },
      } as Partial<Command>),
      create('row', 'items', { properties: { completion: 0.3 } } as Partial<Command>),
      create('summary'),
      { type: 'page.control.configure', id: 'summary', now: 2,
        control: control({ id: 'completion-control', name: 'CompletionValue', type: 'progress', value: 0.3, defaultValue: 0, format }) },
      { type: 'page.control.configure', id: 'summary', now: 2,
        control: control({ id: 'blank-control', name: 'Blankable', type: 'progress', value: null, defaultValue: null, format }) },
    );
    const binding = bindPageFormulaReferences('CompletionValue', 'summary', state, 'items');
    expect(documentFormulaResult('summary', 'completion-result', 'CompletionValue', binding, state)).toEqual({ value: 0.3, error: null });
    const rule = {
      id: 'completion-filter', prop: 'completion', op: 'is' as const, value: null,
      controlRef: { pageId: 'summary', controlId: 'completion-control' },
    };
    expect(matchesFilter(state.pages.row!, rule, state.pages.items!.database!, state)).toBe(true);

    state = run(state,
      { type: 'page.control.setValue', id: 'summary', controlId: 'completion-control', value: 0, now: 3 },
      { type: 'page.control.setValue', id: 'summary', controlId: 'blank-control', value: 0, now: 3 },
    );
    expect(documentFormulaResult('summary', 'completion-result', 'CompletionValue', binding, state)).toEqual({ value: 0, error: null });
    expect(matchesFilter(state.pages.row!, rule, state.pages.items!.database!, state)).toBe(false);
    expect(state.pages.summary!.controls.find((item) => item.id === 'blank-control')?.value).toBe(0);

    state = run(state,
      { type: 'page.control.setValue', id: 'summary', controlId: 'completion-control', value: null, now: 4 },
      { type: 'page.control.reset', id: 'summary', controlId: 'completion-control', now: 5 },
      { type: 'page.control.reset', id: 'summary', controlId: 'blank-control', now: 5 },
    );
    expect(state.pages.summary!.controls.find((item) => item.id === 'completion-control')?.value).toBe(0);
    expect(state.pages.summary!.controls.find((item) => item.id === 'blank-control')?.value).toBeNull();
    expect(documentFormulaResult('summary', 'completion-result', 'CompletionValue', binding, state)).toEqual({ value: 0, error: null });
  });

  it('stores unique multi-select option IDs, keeps blank distinct from an empty list, and resets to the configured default', () => {
    const options = [
      { id: 'topic-a', name: 'Alpha', color: 'green' as const },
      { id: 'topic-b', name: 'Beta', color: 'blue' as const },
    ];
    const topics = control({
      id: 'topics', name: 'Topics', type: 'multiSelect', value: ['topic-b', 'topic-a'], defaultValue: ['topic-a'], options,
    });
    expect(controlValueError(topics, null)).toBeNull();
    expect(controlValueError(topics, [])).toBeNull();
    expect(controlValueError(topics, ['topic-a', 'topic-a'])).toContain('unique list');
    expect(controlValueError(topics, ['missing'])).toContain('configured options');
    expect(controlValueError(topics, 'topic-a')).toContain('unique list');
    expect(normalizeNamedControls([{ ...topics, value: [], defaultValue: null }])?.[0]).toMatchObject({
      type: 'multiSelect', value: [], defaultValue: null,
    });
    expect(normalizeNamedControls([{ ...topics, value: ['topic-a', 'topic-a'] }])).toBeNull();

    let state = run(emptyWorkspace(), create('page'), { type: 'page.control.configure', id: 'page', now: 2, control: topics });
    const renamed = control({
      ...topics,
      options: [{ ...options[0]!, name: 'Alpha renamed' }, options[1]!],
      value: null,
    });
    state = run(state, { type: 'page.control.configure', id: 'page', now: 3, control: renamed });
    expect(state.pages.page!.controls[0]).toMatchObject({ value: ['topic-b', 'topic-a'], defaultValue: ['topic-a'] });
    state = run(state, { type: 'page.control.setValue', id: 'page', controlId: 'topics', value: null, now: 4 });
    expect(state.pages.page!.controls[0]?.value).toBeNull();
    state = run(state, { type: 'page.control.setValue', id: 'page', controlId: 'topics', value: [], now: 5 });
    expect(state.pages.page!.controls[0]?.value).toEqual([]);
    state = run(state, { type: 'page.control.reset', id: 'page', controlId: 'topics', now: 6 });
    expect(state.pages.page!.controls[0]).toMatchObject({ value: ['topic-a'], defaultValue: ['topic-a'] });
  });

  it('requires explicit resolution of current and default lists before removing a multi-select option', () => {
    const options = [
      { id: 'topic-a', name: 'Alpha', color: 'green' as const },
      { id: 'topic-b', name: 'Beta', color: 'blue' as const },
    ];
    let state = run(emptyWorkspace(), create('page'), {
      type: 'page.control.configure', id: 'page', now: 2,
      control: control({ id: 'topics', name: 'Topics', type: 'multiSelect', value: ['topic-a', 'topic-b'], defaultValue: ['topic-a', 'topic-b'], options }),
    });
    const withoutBeta = control({
      id: 'topics', name: 'Topics', type: 'multiSelect', value: null, defaultValue: ['topic-a'],
      options: [{ ...options[0]!, name: 'Alpha renamed' }],
    });
    const rejected = applyCommand(state, { type: 'page.control.configure', id: 'page', now: 3, control: withoutBeta });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toContain('current value is incompatible');
    expect(state.pages.page!.controls[0]).toMatchObject({
      value: ['topic-a', 'topic-b'], defaultValue: ['topic-a', 'topic-b'], options,
    });

    const unresolvedDefault = applyCommand(run(state, {
      type: 'page.control.setValue', id: 'page', controlId: 'topics', value: ['topic-a'], now: 3,
    }), {
      type: 'page.control.configure', id: 'page', now: 3,
      control: { ...withoutBeta, defaultValue: ['topic-a', 'topic-b'] },
    });
    expect(unresolvedDefault.ok).toBe(false);
    if (!unresolvedDefault.ok) expect(unresolvedDefault.error).toContain('Invalid default value');
    expect(state.pages.page!.controls[0]).toMatchObject({
      value: ['topic-a', 'topic-b'], defaultValue: ['topic-a', 'topic-b'], options,
    });

    state = run(state,
      { type: 'page.control.setValue', id: 'page', controlId: 'topics', value: ['topic-a'], now: 3 },
      { type: 'page.control.configure', id: 'page', now: 4, control: withoutBeta },
    );
    expect(state.pages.page!.controls[0]).toMatchObject({
      type: 'multiSelect', options: [{ id: 'topic-a', name: 'Alpha renamed', color: 'green' }],
      value: ['topic-a'], defaultValue: ['topic-a'],
    });
    expect(state.pages.page!.controls[0]?.options.map(({ id, color }) => [id, color])).toEqual([['topic-a', 'green']]);
  });

  it('keeps single-select option IDs when renaming and rejects removal until the live choice is resolved', () => {
    const options = [
      { id: 'choice-a', name: 'Alpha', color: 'green' as const },
      { id: 'choice-b', name: 'Beta', color: 'blue' as const },
    ];
    let state = run(emptyWorkspace(), create('page'), {
      type: 'page.control.configure', id: 'page', now: 2,
      control: control({ id: 'choice', name: 'Choice', type: 'select', value: 'choice-a', defaultValue: 'choice-a', options }),
    });
    const renamed = control({
      id: 'choice', name: 'Choice', type: 'select', value: null, defaultValue: 'choice-a',
      options: [{ ...options[0]!, name: 'Alpha renamed' }, options[1]!],
    });
    state = run(state, { type: 'page.control.configure', id: 'page', now: 3, control: renamed });
    expect(state.pages.page!.controls[0]).toMatchObject({ value: 'choice-a', defaultValue: 'choice-a' });

    const removed = control({
      id: 'choice', name: 'Choice', type: 'select', value: null, defaultValue: 'choice-b', options: [options[1]!],
    });
    const rejected = applyCommand(state, { type: 'page.control.configure', id: 'page', now: 4, control: removed });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toContain('current value is incompatible');
    state = run(state,
      { type: 'page.control.setValue', id: 'page', controlId: 'choice', value: null, now: 4 },
      { type: 'page.control.configure', id: 'page', now: 5, control: removed },
    );
    expect(state.pages.page!.controls[0]).toMatchObject({
      options: [{ id: 'choice-b', name: 'Beta', color: 'blue' }], value: null, defaultValue: 'choice-b',
    });
  });

  it('passes multi-select lists to formulas and control filters as typed option IDs', () => {
    const options = [
      { id: 'topic-a', name: 'Alpha', color: 'green' as const },
      { id: 'topic-b', name: 'Beta', color: 'blue' as const },
    ];
    let state = run(
      emptyWorkspace(),
      create('items', null, {
        kind: 'database',
        database: { properties: [{ id: 'topics', name: 'Topics', type: 'multiSelect', options }], views: [] },
      } as Partial<Command>),
      create('row', 'items', { properties: { topics: ['topic-a', 'topic-b'] } } as Partial<Command>),
      create('summary'),
      { type: 'page.control.configure', id: 'summary', now: 2,
        control: control({ id: 'topic-set', name: 'TopicSet', type: 'multiSelect', value: ['topic-a', 'topic-b'], defaultValue: [], options }) },
    );
    const source = 'Length(TopicSet)';
    const bindings = bindPageFormulaReferences(source, 'summary', state, 'items');
    expect(documentFormulaResult('summary', 'topic-count', source, bindings, state)).toEqual({ value: 2, error: null });
    expect(documentFormulaResult('summary', 'contains-beta', 'Contains(TopicSet, "topic-b")',
      bindPageFormulaReferences('Contains(TopicSet, "topic-b")', 'summary', state, 'items'), state))
      .toEqual({ value: true, error: null });
    const rule = {
      id: 'topic-filter', prop: 'topics', op: 'is' as const, value: null,
      controlRef: { pageId: 'summary', controlId: 'topic-set' },
    };
    expect(matchesFilter(state.pages.row!, rule, state.pages.items!.database!, state)).toBe(true);

    state = run(state, { type: 'page.control.setValue', id: 'summary', controlId: 'topic-set', value: ['topic-b'], now: 3 });
    expect(documentFormulaResult('summary', 'topic-count', source, bindings, state)).toEqual({ value: 1, error: null });
    expect(matchesFilter(state.pages.row!, rule, state.pages.items!.database!, state)).toBe(false);
    const directTopicBindings = bindPageFormulaReferences('TopicSet', 'summary', state, 'items');
    state = run(state, { type: 'page.control.setValue', id: 'summary', controlId: 'topic-set', value: [], now: 4 });
    expect(documentFormulaResult('summary', 'empty-topic-set', 'TopicSet', directTopicBindings, state)).toEqual({ value: [], error: null });
    state = run(state, { type: 'page.control.setValue', id: 'summary', controlId: 'topic-set', value: null, now: 5 });
    expect(documentFormulaResult('summary', 'blank-topic-set', 'TopicSet', directTopicBindings, state)).toEqual({ value: null, error: null });
  });

  it('validates optional email text format while preserving legacy plain-text controls', () => {
    const legacy = control({ id: 'legacy', name: 'Legacy', type: 'text', value: 'anything', defaultValue: '' });
    const email = control({ id: 'email', name: 'Email', type: 'text', textFormat: 'email', value: 'person@example.com', defaultValue: '' });
    expect(controlValueError(legacy, 'not an email')).toBeNull();
    expect(controlValueError(email, 'not an email')).toContain('valid email address');
    expect(controlValueError(email, '')).toBeNull();
    expect(normalizeNamedControls([{ ...legacy, name: 'Email', value: 'person@example.com', textFormat: 'email' }])?.[0]?.textFormat).toBe('email');
    expect(normalizeNamedControls([{ ...legacy, textFormat: 'invalid' }])).toBeNull();
    expect(normalizeNamedControls([{ ...email, type: 'number' }])).toBeNull();
    expect(normalizeNamedControls([{ ...legacy, futureSetting: true }])).toBeNull();
    expect(normalizeNamedControls([{ id: 'absent', name: 'Absent', type: 'text', defaultValue: '', options: [] }])).toBeNull();
    const invalidDefault = applyCommand(run(emptyWorkspace(), create('page')), {
      type: 'page.control.configure', id: 'page', now: 2,
      control: control({ id: 'email', name: 'Email', type: 'text', textFormat: 'email', value: 'person@example.com', defaultValue: 'not-an-email' }),
    });
    expect(invalidDefault.ok).toBe(false);
    if (!invalidDefault.ok) expect(invalidDefault.error).toContain('Invalid default value');
  });

  it('rejects incompatible configuration atomically, while explicit clear and reset remain separate', () => {
    let state = run(
      emptyWorkspace(),
      create('page'),
      { type: 'page.control.configure', id: 'page', now: 2, control: control({ id: 'filter', name: 'Filter', type: 'text', value: 'keep me', defaultValue: 'fallback' }) },
    );
    const incompatible = control({ id: 'filter', name: 'Filter', type: 'checkbox', value: null, defaultValue: false });
    const rejected = applyCommand(state, { type: 'page.control.configure', id: 'page', now: 3, control: incompatible });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toContain('current value is incompatible');
    expect(state.pages.page!.controls[0]).toMatchObject({ type: 'text', value: 'keep me', defaultValue: 'fallback' });
    const malformed = applyCommand(state, { type: 'page.control.configure', id: 'page', now: 3, control: null as never });
    expect(malformed.ok).toBe(false);
    expect(state.pages.page!.controls[0]).toMatchObject({ type: 'text', value: 'keep me', defaultValue: 'fallback' });

    state = run(
      state,
      { type: 'page.control.setValue', id: 'page', controlId: 'filter', value: null, now: 4 },
      { type: 'page.control.configure', id: 'page', now: 5, control: incompatible },
    );
    expect(state.pages.page!.controls[0]).toMatchObject({ type: 'checkbox', value: null, defaultValue: false });
    const reference = bindPageFormulaReferences('Filter', 'page', state);
    expect(documentFormulaResult('page', 'current-filter', 'Filter', reference, state)).toEqual({ value: null, error: null });
    state = run(state, { type: 'page.control.reset', id: 'page', controlId: 'filter', now: 6 });
    expect(state.pages.page!.controls[0]).toMatchObject({ value: false, defaultValue: false });
    expect(documentFormulaResult('page', 'current-filter', 'Filter', reference, state)).toEqual({ value: false, error: null });
  });

  it('validates relation targets and rows against the selected database', () => {
    let state = run(emptyWorkspace(), create('authors', null, { kind: 'database' } as Partial<Command>), create('author', 'authors'), create('other'));
    const relation = control({
      id: 'authorControl', name: 'Author', type: 'relation', value: 'author', defaultValue: null,
      relation: { targetDatabaseId: 'authors', multiple: false },
    });
    state = run(state, { type: 'page.control.configure', id: 'other', control: relation, now: 2 });
    expect(state.pages.other!.controls[0]?.value).toBe('author');
    const multiple = control({
      id: 'authorsControl', name: 'Authors', type: 'relation', value: ['author'], defaultValue: [],
      relation: { targetDatabaseId: 'authors', multiple: true },
    });
    state = run(state, { type: 'page.control.configure', id: 'other', control: multiple, now: 3 });
    expect(state.pages.other!.controls.find((item) => item.id === 'authorsControl')?.value).toEqual(['author']);
    const invalid = applyCommand(state, {
      type: 'page.control.setValue', id: 'other', controlId: 'authorControl', value: 'other', now: 4,
    });
    expect(invalid.ok).toBe(false);
    const noTarget = applyCommand(state, {
      type: 'page.control.configure', id: 'other', now: 4,
      control: control({ id: 'broken', name: 'Broken', type: 'relation', value: null, defaultValue: null, relation: { targetDatabaseId: null, multiple: false } }),
    });
    expect(noTarget.ok).toBe(false);
    const unavailableTarget = {
      ...state,
      pages: { ...state.pages, authors: { ...state.pages.authors!, trashedAt: 5 } },
    };
    expect(controlValueErrorInState(relation, 'author', unavailableTarget)).toContain('available database');
    const unavailableRow = {
      ...state,
      pages: { ...state.pages, author: { ...state.pages.author!, trashedAt: 5 } },
    };
    expect(controlValueErrorInState(relation, 'author', unavailableRow)).toContain('rows in their selected database');
  });

  it('compares control filters without collapsing false, zero, or empty text', () => {
    const database = {
      properties: [
        { id: 'enabled', name: 'Enabled', type: 'checkbox' as const, options: [] },
        { id: 'amount', name: 'Amount', type: 'number' as const, options: [] },
        { id: 'note', name: 'Note', type: 'text' as const, options: [] },
      ],
      views: [],
    };
    let state = run(
      emptyWorkspace(),
      create('items', null, { kind: 'database', database } as Partial<Command>),
      create('row', 'items', { properties: { enabled: false, amount: 0, note: '' } } as Partial<Command>),
      create('summary'),
      { type: 'page.control.configure', id: 'summary', now: 2, control: control({ id: 'false', name: 'False', type: 'checkbox', value: false, defaultValue: true }) },
      { type: 'page.control.configure', id: 'summary', now: 2, control: control({ id: 'zero', name: 'Zero', type: 'number', value: 0, defaultValue: 1 }) },
      { type: 'page.control.configure', id: 'summary', now: 2, control: control({ id: 'empty', name: 'Empty', type: 'text', value: '', defaultValue: 'x' }) },
    );
    const row = state.pages.row!;
    const table = state.pages.items!.database!;
    const filter = (prop: string, controlId: string) => ({
      id: controlId, prop, op: 'is' as const, value: null,
      controlRef: { pageId: 'summary', controlId },
    });
    expect(matchesFilter(row, filter('enabled', 'false'), table, state)).toBe(true);
    expect(matchesFilter(row, filter('amount', 'zero'), table, state)).toBe(true);
    expect(matchesFilter(row, filter('note', 'empty'), table, state)).toBe(true);
    state = run(state, { type: 'page.control.setValue', id: 'summary', controlId: 'false', value: true, now: 3 });
    expect(matchesFilter(row, filter('enabled', 'false'), table, state)).toBe(false);
  });

  it('recalculates independent annual/monthly linked views and BRL totals, reopens them, and diagnoses deleted bindings', () => {
    const properties: PropDef[] = [
      { id: 'date', name: 'Date', type: 'date', options: [] },
      { id: 'amount', name: 'Amount', type: 'number', options: [] },
    ];
    let state = run(
      emptyWorkspace(),
      create('expenses', null, { kind: 'database', database: { properties, views: [] } } as Partial<Command>),
      create('summary'),
      create('one', 'expenses', { properties: { date: '2025-03-04', amount: 80 } } as Partial<Command>),
      create('two', 'expenses', { properties: { date: '2025-12-29', amount: 20 } } as Partial<Command>),
      create('three', 'expenses', { properties: { date: '2026-01-02', amount: 50 } } as Partial<Command>),
      {
        type: 'page.control.configure', id: 'summary', now: 2,
        control: control({ id: 'year', name: 'SelectedYear', type: 'number', value: 2025, defaultValue: 2025 }),
      },
      {
        type: 'page.control.configure', id: 'summary', now: 3,
        control: control({ id: 'month', name: 'SelectedMonth', type: 'number', value: 3, defaultValue: 1 }),
      },
    );
    const annualFilterFormula = 'Year(thisRow.Date) = SelectedYear';
    const monthlyFilterFormula = 'Year(thisRow.Date) = SelectedYear and Month(thisRow.Date) = SelectedMonth';
    const annualFilter = {
      id: 'annual-filter', prop: '$formula', op: 'is' as const, value: null,
      formula: annualFilterFormula,
      formulaBindings: bindPageFormulaReferences(annualFilterFormula, 'summary', state, 'expenses'),
    };
    const monthlyFilter = {
      id: 'monthly-filter', prop: '$formula', op: 'is' as const, value: null,
      formula: monthlyFilterFormula,
      formulaBindings: bindPageFormulaReferences(monthlyFilterFormula, 'summary', state, 'expenses'),
    };
    const annualView: ViewDef = { id: 'annual-view', name: 'Annual', type: 'table', filters: [annualFilter], sorts: [], groupBy: null, dateProp: null, hidden: [] };
    const monthlyView: ViewDef = { id: 'monthly-view', name: 'Monthly', type: 'table', filters: [monthlyFilter], sorts: [], groupBy: null, dateProp: null, hidden: [] };
    const annualSource = 'Expenses.filter(Year(CurrentValue.Date) = SelectedYear).Amount.sum()';
    const monthlySource = 'Expenses.filter(Year(CurrentValue.Date) = SelectedYear and Month(CurrentValue.Date) = SelectedMonth).Amount.sum()';
    const annualBindings = bindPageFormulaReferences(annualSource, 'summary', state, 'expenses');
    const monthlyBindings = bindPageFormulaReferences(monthlySource, 'summary', state, 'expenses');
    const currencyFormat = { locale: 'pt-BR', currency: 'BRL', precision: 2 };
    const doc: DocNode = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [
          { type: 'namedControl', attrs: { controlId: 'year', pageId: 'summary', label: 'SelectedYear' } },
          { type: 'namedControl', attrs: { controlId: 'month', pageId: 'summary', label: 'SelectedMonth' } },
          { type: 'calculatedResult', attrs: { resultId: 'annual-total', pageId: 'summary', name: 'Annual total', formula: annualSource, bindings: annualBindings, outputType: 'currency', format: currencyFormat } },
          { type: 'calculatedResult', attrs: { resultId: 'monthly-total', pageId: 'summary', name: 'Monthly total', formula: monthlySource, bindings: monthlyBindings, outputType: 'currency', format: currencyFormat } },
        ] },
        { type: 'linkedDatabaseView', attrs: { hostPageId: 'summary', sourceDatabaseId: 'expenses', blockId: 'annual-block', view: annualView } },
        { type: 'linkedDatabaseView', attrs: { hostPageId: 'summary', sourceDatabaseId: 'expenses', blockId: 'monthly-block', view: monthlyView } },
      ],
    };
    state = run(state, { type: 'page.setDoc', id: 'summary', doc, now: 4 });
    const database = state.pages.expenses!.database!;
    const rows = rowsOf(state, 'expenses');
    expect(visibleRows(rows, annualView, database, state).map((row) => row.id)).toEqual(['one', 'two']);
    expect(visibleRows(rows, monthlyView, database, state).map((row) => row.id)).toEqual(['one']);
    expect(documentFormulaResult('summary', 'annual-total', annualSource, annualBindings, state)).toEqual({ value: 100, error: null });
    expect(documentFormulaResult('summary', 'monthly-total', monthlySource, monthlyBindings, state)).toEqual({ value: 80, error: null });
    const currency = { id: 'currency', name: 'Currency', type: 'currency' as const, options: [], format: currencyFormat };
    expect(formatValue(currency, 80)).toContain('80,00');
    expect(state.pages.one!.properties.amount).toBe(80);
    state = run(state,
      { type: 'page.control.setValue', id: 'summary', controlId: 'year', value: 2026, now: 5 },
      { type: 'page.control.setValue', id: 'summary', controlId: 'month', value: 1, now: 6 },
    );
    expect(visibleRows(rowsOf(state, 'expenses'), annualView, database, state).map((row) => row.id)).toEqual(['three']);
    expect(visibleRows(rowsOf(state, 'expenses'), monthlyView, database, state).map((row) => row.id)).toEqual(['three']);
    expect(documentFormulaResult('summary', 'annual-total', annualSource, annualBindings, state)).toEqual({ value: 50, error: null });
    expect(documentFormulaResult('summary', 'monthly-total', monthlySource, monthlyBindings, state)).toEqual({ value: 50, error: null });
    expect(state.pages.one!.properties.amount).toBe(80);
    expect(state.pages.two!.properties.amount).toBe(20);
    expect(state.pages.three!.properties.amount).toBe(50);

    const page = state.pages.summary!;
    const frontmatter = managedFrontmatter(page, 'summary', null, state);
    const file = renderPageText(Object.fromEntries(frontmatter), null, docToMarkdown(doc));
    const reopenedPage = readPageText(file);
    const reopenedDoc = markdownToDoc(reopenedPage.body);
    expect(reopenedDoc.content?.map((node) => node.type)).toContain('linkedDatabaseView');
    const loaded = readWorkspace(SCHEMA_VERSION, {
      pages: Object.values(state.pages).map((item) => item.id === 'summary' ? { ...item, controls: reopenedPage.controls } : item),
      docs: { summary: reopenedDoc },
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.value.docs.summary?.content?.map((node) => node.type)).toContain('linkedDatabaseView');
    state = {
      ...emptyWorkspace(),
      pages: Object.fromEntries(loaded.value.pages.map((item) => [item.id, item])),
      docs: loaded.value.docs,
    };
    const reopenedViews = state.docs.summary!.content!.filter((node) => node.type === 'linkedDatabaseView');
    expect(reopenedViews).toHaveLength(2);
    expect(reopenedViews[0]!.attrs?.view).toMatchObject({ id: 'annual-view', filters: [{ formula: annualFilterFormula }] });
    expect(reopenedViews[1]!.attrs?.view).toMatchObject({ id: 'monthly-view', filters: [{ formula: monthlyFilterFormula }] });
    const reopenedResults = state.docs.summary!.content![0]!.content!;
    expect(reopenedResults[2]!.attrs).toMatchObject({ outputType: 'currency', format: currencyFormat });
    expect(reopenedResults[3]!.attrs).toMatchObject({ outputType: 'currency', format: currencyFormat });
    expect(state.pages.summary!.controls.map((item) => item.value)).toEqual([2026, 1]);
    expect(visibleRows(rowsOf(state, 'expenses'), reopenedViews[0]!.attrs!.view as ViewDef, state.pages.expenses!.database!, state).map((row) => row.id)).toEqual(['three']);
    expect(visibleRows(rowsOf(state, 'expenses'), reopenedViews[1]!.attrs!.view as ViewDef, state.pages.expenses!.database!, state).map((row) => row.id)).toEqual(['three']);
    expect(documentFormulaResult('summary', 'annual-total', annualSource, annualBindings, state)).toEqual({ value: 50, error: null });
    expect(documentFormulaResult('summary', 'monthly-total', monthlySource, monthlyBindings, state)).toEqual({ value: 50, error: null });

    state = run(state, {
      type: 'page.control.configure', id: 'summary', now: 7,
      control: control({ id: 'year', name: 'FiscalYear', type: 'number', value: 0, defaultValue: 2025 }),
    });
    expect(documentFormulaResult('summary', 'annual-total', annualSource, annualBindings, state)).toEqual({ value: 50, error: null });
    state = run(state, { type: 'page.control.delete', id: 'summary', controlId: 'year', now: 8 });
    expect(documentFormulaResult('summary', 'annual-total', annualSource, annualBindings, state).error).toContain('Bound control');
  });

  it('diagnoses scope collisions and duplicate names while preserving explicit bindings', () => {
    let state = run(
      emptyWorkspace(),
      create('items', null, {
        kind: 'database',
        database: { properties: [{ id: 'year', name: 'SelectedYear', type: 'number', options: [] }], views: [] },
      } as Partial<Command>),
      create('summary'),
      { type: 'page.control.configure', id: 'summary', now: 2, control: control({ id: 'year-control', name: 'SelectedYear', type: 'number', value: 2026, defaultValue: 2025 }) },
    );
    const source = 'SelectedYear';
    expect(bindPageFormulaReferences(source, 'summary', state, 'items')[0]?.kind).toBe('ambiguous');
    const explicit = [{
      kind: 'control' as const, pageId: 'summary', controlId: 'year-control',
      start: 0, end: source.length, source,
    }];
    expect(bindPageFormulaReferences(source, 'summary', state, 'items', explicit)).toMatchObject(explicit);
    state = run(state, {
      type: 'page.control.configure', id: 'summary', now: 3,
      control: control({ id: 'another-year', name: 'SelectedYear', type: 'number', value: 2027, defaultValue: 2025 }),
    });
    expect(bindPageFormulaReferences(source, 'summary', state, 'items')[0]?.kind).toBe('ambiguous');
  });

  it('reports a cycle between calculated document results', () => {
    let state = run(emptyWorkspace(), create('summary'));
    const resultA = { kind: 'result' as const, pageId: 'summary', resultId: 'result-a', start: 0, end: 1, source: 'B' };
    const resultB = { kind: 'result' as const, pageId: 'summary', resultId: 'result-b', start: 0, end: 1, source: 'A' };
    const doc: DocNode = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [
        { type: 'calculatedResult', attrs: { resultId: 'result-a', pageId: 'summary', name: 'A', formula: 'B', bindings: [resultA] } },
        { type: 'calculatedResult', attrs: { resultId: 'result-b', pageId: 'summary', name: 'B', formula: 'A', bindings: [resultB] } },
      ] }],
    };
    state = run(state, { type: 'page.setDoc', id: 'summary', doc, now: 2 });
    expect(documentFormulaResult('summary', 'result-a', 'B', [resultA], state).error).toContain('cycle detected');
  });

  it('gives a copied page independent control and result identities with internal bindings remapped', () => {
    let state = run(emptyWorkspace(), create('source'));
    const doc: DocNode = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [
        { type: 'namedControl', attrs: { controlId: 'year', pageId: 'source', label: 'YearValue' } },
        { type: 'calculatedResult', attrs: { resultId: 'total', pageId: 'source', name: 'Total', formula: 'YearValue + Total + SharedValue', bindings: [], outputType: 'currency', format: { currency: 'BRL' } } },
      ] }],
    };
    state = run(state,
      { type: 'page.control.configure', id: 'source', now: 2, control: control({ id: 'year', name: 'YearValue', type: 'number', value: 2025, defaultValue: 2025 }) },
      { type: 'page.setDoc', id: 'source', doc, now: 3 },
    );
    const binding = { kind: 'control' as const, pageId: 'source', controlId: 'year', start: 0, end: 9, source: 'YearValue' };
    const externalBinding = { kind: 'control' as const, pageId: 'external-page', controlId: 'shared', start: 20, end: 31, source: 'SharedValue' };
    const sourceDoc = state.docs.source!;
    const resultNode = sourceDoc.content![0]!.content![1]!;
    resultNode.attrs!.bindings = [binding, { kind: 'result', pageId: 'source', resultId: 'total', start: 12, end: 17, source: 'Total' }, externalBinding];
    state = { ...state, docs: { ...state.docs, source: sourceDoc } };
    state = run(state, { type: 'page.duplicate', id: 'source', newId: 'copy', now: 4 });
    const copied = state.docs.copy!.content![0]!.content!;
    const copiedControlId = String(copied[0]!.attrs?.controlId);
    const copiedResultId = String(copied[1]!.attrs?.resultId);
    expect(copiedControlId).not.toBe('year');
    expect(copiedResultId).not.toBe('total');
    expect(state.pages.copy!.controls[0]!.id).toBe(copiedControlId);
    expect(copied[1]!.attrs?.bindings).toMatchObject([
      { kind: 'control', pageId: 'copy', controlId: copiedControlId },
      { kind: 'result', pageId: 'copy', resultId: copiedResultId },
      { kind: 'control', pageId: 'external-page', controlId: 'shared' },
    ]);
  });

  it('migrates older page records with no controls and rejects malformed control metadata', () => {
    expect(normalizePage({ id: 'old', createdAt: 1 })?.controls).toEqual([]);
    expect(normalizePage({ id: 'bad', controls: [{ id: 'bad id' }] })).toBeNull();
  });

  it('keeps unknown fields inside unsupported control metadata byte-for-byte and read only', () => {
    const raw = [
      '---',
      'morrowControls:',
      '  - id: future',
      '    name: Future',
      '    type: text',
      '    textFormat: future-format',
      '    value: draft',
      '    defaultValue: ""',
      '    options: []',
      '    futureSetting: { keep: true }',
      '---',
      '# untouched',
      '',
    ].join('\n');
    const page = readPageText(raw);
    expect(page.error).toContain('left read only');
    expect(page.controls).toEqual([]);
    expect(renderPageText(page.data, page.source, page.body)).toBe(raw);
  });

  it('keeps legacy control metadata unchanged when the optional text format is absent', () => {
    const raw = [
      '---',
      'morrowControls:',
      '  - id: query',
      '    name: Query',
      '    type: text',
      '    value: draft',
      '    defaultValue: ""',
      '    options: []',
      '---',
      '# Existing page',
      '',
    ].join('\n');
    const page = readPageText(raw);
    expect(page.error).toBeNull();
    expect(page.controls[0]?.textFormat).toBeUndefined();
    expect(renderPageText(page.data, page.source, page.body)).toBe(raw);
  });

  it('accepts a blank or exactly two real ordered ISO dates for a date-range control', () => {
    const period = control({
      id: 'period', name: 'Period', type: 'dateRange',
      value: ['2024-02-28', '2024-03-01'], defaultValue: null,
    });

    expect(controlValueError(period, null)).toBeNull();
    expect(controlValueError(period, ['2024-02-29', '2024-03-01'])).toBeNull();
    expect(controlValueError(period, [])).toContain('two');
    expect(controlValueError(period, ['2024-02-29'])).toContain('two');
    expect(controlValueError(period, ['2024-02-29', '2024-03-01', '2024-03-02'])).toContain('two');
    expect(controlValueError(period, ['2024-02-30', '2024-03-01'])).toContain('real dates');
    expect(controlValueError(period, ['2024-03-02', '2024-03-01'])).toContain('ordered');
    expect(controlValueError(period, '2024-02-29')).toContain('two');

    expect(normalizeNamedControls([period])).toEqual([period]);
    expect(normalizeNamedControls([{ ...period, value: [] }])).toBeNull();
    expect(normalizeNamedControls([{ ...period, defaultValue: ['2024-03-02', '2024-03-01'] }])).toBeNull();
  });

  it('opens a multi-select control beside unknown YAML and Markdown without rewriting the file', () => {
    const raw = [
      '---',
      'futureField: { keep: true }',
      'morrowControls:',
      '  - id: topics',
      '    name: Topics',
      '    type: multiSelect',
      '    value: [topic-a]',
      '    defaultValue: []',
      '    options:',
      '      - id: topic-a',
      '        name: Alpha',
      '        color: green',
      '---',
      '# Keep this Markdown',
      '',
    ].join('\n');
    const page = readPageText(raw);
    expect(page.error).toBeNull();
    expect(page.controls[0]).toMatchObject({
      id: 'topics', type: 'multiSelect', value: ['topic-a'], defaultValue: [],
      options: [{ id: 'topic-a', name: 'Alpha', color: 'green' }],
    });
    expect(renderPageText(page.data, page.source, page.body)).toBe(raw);
  });
});
